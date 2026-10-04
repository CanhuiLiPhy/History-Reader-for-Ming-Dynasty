/**
 * Hybrid retrieval module: query → BGE embedding via Python sidecar →
 * sqlite-vec KNN against paragraphs-vec-int8.sqlite → RRF-fuse with FTS5
 * keyword candidates → top-K paragraph IDs.
 *
 * Loaded lazily: if the int8 vec DB or sqlite-vec extension is missing,
 * isAvailable() returns false and callers fall back to FTS5-only.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { CACHE_ROOT } from "../config/defaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VEC_DB_PATH = path.join(CACHE_ROOT, "paragraphs-vec-int8.sqlite");
const EXT_DIR = path.join(CACHE_ROOT, "sqlite-vec-extensions");

// Sidecar script path：
//  - dev: `backend/scripts/embed_query.py`
//  - packaged Electron: `process.resourcesPath/backend-data/scripts/embed_query.py`
// CACHE_ROOT 已用相同策略（dev=backend/.cache, packaged=backend-data/.cache），
// 所以 scripts 跟它平级的 ../scripts 取即可。
const SIDE_SCRIPT = (() => {
  const devPath = path.resolve(__dirname, "..", "..", "scripts", "embed_query.py");
  if (fs.existsSync(devPath)) return devPath;
  // packaged: scripts/ 跟 .cache/ 同在 backend-data/ 下
  const pkgPath = path.resolve(CACHE_ROOT, "..", "scripts", "embed_query.py");
  if (fs.existsSync(pkgPath)) return pkgPath;
  return devPath;
})();

function platformExtension() {
  const platform = process.platform;
  const arch = process.arch;
  // Map: darwin-arm64 / darwin-x64 / win32-x64 / linux-x64
  const folder = `${platform === "win32" ? "win" : platform}-${arch}`;
  const filename = platform === "win32" ? "vec0.dll" : platform === "darwin" ? "vec0.dylib" : "vec0.so";
  return path.join(EXT_DIR, folder, filename);
}

let vecDb = null;
let sidecar = null;
let sidecarReady = null;
let nextRequestId = 0;
const pendingRequests = new Map();
let lastSidecarStartAt = 0;

function tryOpenVecDb() {
  if (vecDb) return vecDb;
  if (!fs.existsSync(VEC_DB_PATH)) return null;
  const extPath = platformExtension();
  if (!fs.existsSync(extPath)) {
    console.warn(`[embedding-service] sqlite-vec extension not found at ${extPath} — hybrid retrieval disabled.`);
    return null;
  }
  let db;
  try {
    db = new Database(VEC_DB_PATH, { readonly: true });
    db.loadExtension(extPath.replace(/\.(dylib|so|dll)$/, ""));
    db.pragma("temp_store=MEMORY");
    // Sanity: confirm table exists
    db.prepare("SELECT 1 FROM paragraph_vec LIMIT 1").get();
    vecDb = db;
    console.log(`[embedding-service] loaded vec DB ${VEC_DB_PATH} + extension ${extPath}`);
    return db;
  } catch (err) {
    try { db?.close(); } catch { /* initialization already failed */ }
    console.warn(`[embedding-service] failed to open vec DB: ${err.message}`);
    return null;
  }
}

// Promise resolvers attached to the spawned proc so the JSON-line parser
// can signal "ready" / "startup error" without racing the startSidecar()
// caller that attaches its own listener later.
// Prefer bundled python (python-runtime) over system python3. Returns the
// absolute path to the python binary, or "python3" to inherit PATH lookup.
function resolveBundledPython() {
  // CACHE_ROOT 在 dev=backend/.cache, packaged=Resources/backend-data/.cache —
  // python-runtime 跟它平级（同在 dataRoot 下）。
  // Mac/Linux 走 bin/python3，Windows 嵌入版直接是根目录下 python.exe。
  const isWin = process.platform === "win32";
  const pyName = isWin ? "python.exe" : "python3";
  const subPath = isWin ? [pyName] : ["bin", pyName];
  const roots = [
    path.resolve(CACHE_ROOT, "..", "python-runtime"),
    path.resolve(__dirname, "..", "..", "python-runtime"),
  ];
  for (const root of roots) {
    const p = path.join(root, ...subPath);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveBundledFastembedCache() {
  const candidates = [
    path.resolve(CACHE_ROOT, "..", "fastembed-cache"),
    path.resolve(__dirname, "..", "..", "fastembed-cache"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function spawnSidecar() {
  const bundledPy = resolveBundledPython();
  const python = bundledPy || process.env.PYTHON || "python3";
  const bundledCache = resolveBundledFastembedCache();

  const env = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
  };
  // 有自带 cache → 强制使用 + 离线模式（绕开 HF SHA 校验，断网也能跑）
  if (bundledCache) {
    env.FASTEMBED_CACHE_DIR = bundledCache;
    env.HF_HUB_OFFLINE = "1";
  }

  console.log(`[embedding-sidecar] python=${python} cache=${bundledCache || "(default ~/.cache/fastembed)"} offline=${bundledCache ? "yes" : "no"}`);

  const proc = spawn(python, [SIDE_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  // attached by startSidecar() so the JSON-line loop below can fire them
  proc._readyResolvers = null;

  let stdoutBuf = "";
  proc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.event === "ready") {
        if (proc._readyResolvers) {
          console.log("[embedding-sidecar] ready");
          proc._readyResolvers.resolve();
          proc._readyResolvers = null;
        }
        continue;
      }
      if (obj.event === "error") {
        console.warn(`[embedding-sidecar] startup error stage=${obj.stage} err=${obj.error}`);
        if (proc._readyResolvers) {
          proc._readyResolvers.reject(new Error(`sidecar startup error: ${obj.error}`));
          proc._readyResolvers = null;
        }
        continue;
      }
      const handler = pendingRequests.get(obj.id);
      if (handler?.proc === proc) {
        if (obj.error) handler.reject(new Error(obj.error));
        else handler.resolve(obj.embedding);
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    const s = chunk.toString("utf8");
    if (s.trim()) console.warn(`[embedding-sidecar stderr] ${s.trim()}`);
  });

  proc.on("error", (err) => {
    failSidecar(proc, err);
    stopProcess(proc);
  });
  // Broken stdin can otherwise emit an unhandled EPIPE error and crash Node.
  proc.stdin.on("error", (err) => {
    failSidecar(proc, err);
    stopProcess(proc);
  });
  proc.on("exit", (code) => {
    console.warn(`[embedding-sidecar] exited code=${code}`);
    failSidecar(proc, new Error(`sidecar exited before response (code ${code})`));
  });

  return proc;
}

function failSidecar(proc, error) {
  if (proc._readyResolvers) {
    proc._readyResolvers.reject(error);
    proc._readyResolvers = null;
  }
  // A deliberately stopped process may exit after its replacement has started.
  // Only clear this process's state and requests, never the replacement's.
  if (sidecar === proc) {
    sidecar = null;
    sidecarReady = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
  for (const handler of pendingRequests.values()) {
    if (handler.proc === proc) handler.reject(error);
  }
}

function stopProcess(proc) {
  if (proc._stopPromise) return proc._stopPromise;
  if (proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
  let didStop;
  proc._stopPromise = new Promise((resolve) => { didStop = resolve; });
  proc.once("close", () => { clearTimeout(killTimer); didStop(); });
  const killTimer = setTimeout(() => {
    if (proc.exitCode == null && proc.signalCode == null) {
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    }
    didStop();
  }, 3000);
  killTimer.unref?.();
  try { proc.stdin.end(); } catch { /* already closed */ }
  try { proc.kill("SIGTERM"); } catch { /* already exited */ }
  return proc._stopPromise;
}

function startSidecar() {
  if (sidecar && sidecarReady) return sidecarReady;
  const now = Date.now();
  if (now - lastSidecarStartAt < 30_000 && lastSidecarStartAt > 0 && !sidecar) {
    return Promise.reject(new Error("sidecar in cooldown after recent failure"));
  }
  lastSidecarStartAt = now;

  if (!fs.existsSync(SIDE_SCRIPT)) {
    return Promise.reject(new Error(`sidecar script missing: ${SIDE_SCRIPT}`));
  }

  const proc = spawnSidecar();
  sidecar = proc;

  sidecarReady = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      failSidecar(proc, new Error("sidecar ready timeout (60s)"));
      stopProcess(proc);
    }, 60_000);
    proc._readyResolvers = {
      resolve: () => { clearTimeout(timeoutId); resolve(proc); },
      reject: (err) => {
        clearTimeout(timeoutId);
        reject(err);
        // Includes explicit startup errors reported on stdout.
        if (sidecar === proc) { sidecar = null; sidecarReady = null; }
        stopProcess(proc);
      },
    };
  });

  return sidecarReady;
}

export function isAvailable() {
  return !!tryOpenVecDb();
}

/**
 * 中文：空闲多久后关掉 sidecar 释放内存。0 = 常驻不退出。
 *
 * How long the sidecar may sit idle before it is shut down to reclaim memory.
 *
 * 这个进程常驻要 279 MB（实测，BGE-small 的 90 MB fp32 权重 + onnxruntime），
 * 而网站版那台机器总共只有 414 MB。语义检索是低频操作，让它为了偶尔一次查询
 * 长期占住三分之二的内存并不划算 —— 用完就退，下次再拉起来。
 *
 * The process holds 279 MB resident once loaded (measured: 90 MB of fp32
 * BGE-small weights plus the onnxruntime session), on a host with 414 MB in
 * total. Semantic search is infrequent, so keeping two thirds of the machine's
 * memory tied up between queries is a bad trade: shut down and pay the reload
 * on the next one instead.
 *
 * 代价是冷启动延迟（加载模型约数秒）。设 0 可关闭该行为，恢复常驻。
 * The cost is a cold start of a few seconds. Set 0 to keep it resident.
 */
const SIDECAR_IDLE_MS = Number.parseInt(process.env.EMBED_SIDECAR_IDLE_MS ?? "90000", 10);

let idleTimer = null;

/**
 * 中文：重置空闲计时器。有在途请求时不计时。
 *
 * Restart the idle countdown. Does nothing while requests are still in flight,
 * so a slow query can never have the process pulled out from under it.
 */
function armIdleShutdown() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!SIDECAR_IDLE_MS || SIDECAR_IDLE_MS <= 0) return;
  if (!sidecar || pendingRequests.size > 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!sidecar || pendingRequests.size > 0) return;
    console.log(`[embedding-sidecar] idle ${SIDECAR_IDLE_MS}ms — shutting down to free memory`);
    shutdownSidecar();
  }, SIDECAR_IDLE_MS);
  // 这个定时器不该拖住进程退出。/ Never keep the process alive just for this.
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}


export async function embedQuery(text, timeoutMs = 16000) {
  // 有请求进来就先取消待关闭计时，避免正要用时被关掉。
  // Cancel any pending shutdown first: the process must not be torn down
  // between this call and the write below.
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const proc = await startSidecar();
  if (proc !== sidecar || proc.stdin.destroyed) throw new Error("sidecar stopped before request");
  const id = `r${++nextRequestId}`;
  return new Promise((resolve, reject) => {
    let timeoutId;
    const settle = (fn) => (value) => {
      if (!pendingRequests.delete(id)) return;
      clearTimeout(timeoutId);
      fn(value);
      armIdleShutdown();
    };
    const handler = { proc, resolve: settle(resolve), reject: settle(reject) };
    pendingRequests.set(id, handler);
    timeoutId = setTimeout(() => handler.reject(new Error(`embed query timeout (${timeoutMs}ms)`)), timeoutMs);
    try {
      proc.stdin.write(JSON.stringify({ id, text }) + "\n", (error) => {
        if (error) handler.reject(error);
      });
    } catch (error) {
      handler.reject(error);
    }
  });
}

/**
 * Quantize a float32 embedding (already L2-normalized for BGE) to int8.
 * Mirror of backend/scripts/quantize-vec.py: int8 = clip(round(f * 127), -127, 127).
 */
function quantizeFloat32ToInt8(floats) {
  const buf = Buffer.alloc(floats.length);
  for (let i = 0; i < floats.length; i += 1) {
    let q = Math.round(floats[i] * 127);
    if (q > 127) q = 127;
    if (q < -127) q = -127;
    buf.writeInt8(q, i);
  }
  return buf;
}

/**
 * Run a KNN query against the int8 vec DB. Returns
 *  [{ paragraph_id: number, distance: number }, ...]
 */
export async function vectorSearch(queryText, k = 50) {
  const db = tryOpenVecDb();
  if (!db) return [];
  let floats;
  try {
    floats = await embedQuery(queryText);
  } catch (err) {
    console.warn(`[embedding-service] embedQuery failed: ${err.message}`);
    return [];
  }
  const blob = quantizeFloat32ToInt8(floats);
  try {
    const stmt = db.prepare(
      "SELECT rowid, distance FROM paragraph_vec WHERE embedding MATCH vec_int8(?) AND k = ? ORDER BY distance"
    );
    const rows = stmt.all(blob, k);
    return rows.map((r) => ({ paragraph_id: r.rowid, distance: r.distance }));
  } catch (err) {
    console.warn(`[embedding-service] vec query failed: ${err.message}`);
    return [];
  }
}

/**
 * Run a semantic search: embed query → vec KNN → fetch full paragraph rows.
 * Used by the new "semantic" search mode in /api/book/search.
 *
 * Returns rows in the shape from fetchParagraphsByIds: { paragraphId,
 * bookSlug, bookTitle, chapter, anchor, content, snippet }.
 */
export async function searchByEmbedding(query, options = {}) {
  const { limit = 50, slugs = [], excludeSlug = "" } = options;
  if (!isAvailable() || !query || !query.trim()) return [];
  // 多召回一些再切，给后续 AI 过滤 / scope 过滤留空间
  const k = Math.min(Math.max(limit * 3, 50), 150);
  const vecResults = await vectorSearch(query.trim(), k);
  if (!vecResults.length) return [];
  // Lazy import to avoid circular (library-db could in theory load us first)
  const { fetchParagraphsByIds } = await import("./library-db.js");
  const ids = vecResults.map((v) => v.paragraph_id);
  const rows = fetchParagraphsByIds(ids, excludeSlug);
  const byId = new Map(rows.map((r) => [r.paragraphId, r]));
  const scopeSet = slugs.length > 0 ? new Set(slugs) : null;
  return vecResults
    .map((v) => {
      const row = byId.get(v.paragraph_id);
      if (!row) return null;
      if (scopeSet && !scopeSet.has(row.bookSlug)) return null;
      return { ...row, _distance: v.distance };
    })
    .filter(Boolean);
}

/**
 * Reciprocal Rank Fusion of two ranked lists. Each list is an array of
 * paragraph_id (already sorted best-first). Returns merged list of
 * { paragraph_id, score } sorted by combined RRF score.
 */
export function reciprocalRankFusion(listA, listB, k = 60) {
  const scores = new Map();
  listA.forEach((pid, rank) => {
    scores.set(pid, (scores.get(pid) || 0) + 1 / (k + rank + 1));
  });
  listB.forEach((pid, rank) => {
    scores.set(pid, (scores.get(pid) || 0) + 1 / (k + rank + 1));
  });
  return Array.from(scores.entries())
    .map(([pid, score]) => ({ paragraph_id: pid, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Stop the sidecar gracefully. Call on backend shutdown.
 */
export function shutdownSidecar() {
  if (!sidecar) return;
  const proc = sidecar;
  failSidecar(proc, new Error("sidecar stopped"));
  // 主动关闭不算「刚失败过」。startSidecar 的 30 秒冷却是防止启动失败后疯狂
  // 重试；空闲退出属正常生命周期，不清掉这个时间戳的话，退出后 30 秒内的下一次
  // 查询会被冷却逻辑直接拒绝。
  // A deliberate stop is not a failure. The 30 s cooldown in startSidecar keeps
  // a crash-looping sidecar from being respawned on every request; leaving the
  // timestamp set would make idle shutdown reject the next query arriving
  // inside that window.
  lastSidecarStartAt = 0;
  return stopProcess(proc);
}
