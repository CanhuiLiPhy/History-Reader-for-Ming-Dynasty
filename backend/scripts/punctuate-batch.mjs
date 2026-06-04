#!/usr/bin/env node
/**
 * 古籍酷 (gj.cool) 自动标点批处理。
 *
 * 用法：
 *   GJCOOL_TOKEN=xxx node backend/scripts/punctuate-batch.mjs \
 *       --input <file_or_dir> \
 *       --output <out_dir> \
 *       [--encoding gb18030|utf-8]    # default: auto-detect
 *       [--chunk 80000]               # 每次 API 调用最大字符（≤100k 硬上限）
 *       [--qps 4]                     # 节流（API 上限 10 QPS）
 *       [--budget 500000]             # 累计字符上限（防爆账单）
 *       [--dry-run]                   # 只切片不调 API
 *
 * 输出：
 *   <out_dir>/<basename>.txt              ← 标点结果（UTF-8）
 *   <out_dir>/.state.json                 ← 进度，支持 Ctrl+C 续跑
 *   <out_dir>/.cost.log                   ← 每次调用累计字符数
 *
 * Token 通过环境变量 GJCOOL_TOKEN 传入；不存任何文件。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import iconv from "iconv-lite";

const ENDPOINT = process.env.GJCOOL_ENDPOINT || "https://ap2.jzd.cool:9043/punct_pro";
const TOKEN = process.env.GJCOOL_TOKEN || "";

function readArg(flag, fallback = "") {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}
function hasFlag(flag) { return process.argv.includes(flag); }

const INPUT       = readArg("--input");
const OUTPUT      = readArg("--output");
const ENC_FORCED  = readArg("--encoding");
const CHUNK_SIZE  = Number(readArg("--chunk", "80000"));
const QPS         = Number(readArg("--qps", "4"));
const BUDGET      = Number(readArg("--budget", "0")); // 0 = 不设上限
const DRY_RUN     = hasFlag("--dry-run");

if (!INPUT || !OUTPUT) {
  console.error("Usage: --input <file_or_dir> --output <out_dir> [--encoding gb18030] [--chunk 80000] [--qps 4] [--budget 500000] [--dry-run]");
  process.exit(2);
}
if (!DRY_RUN && !TOKEN) {
  console.error("GJCOOL_TOKEN env var not set. Either set it or run with --dry-run.");
  process.exit(2);
}

const REQUEST_GAP_MS = Math.max(50, Math.ceil(1000 / QPS));

// --- helpers ---

function detectEncoding(buf) {
  if (ENC_FORCED) return ENC_FORCED;
  // 启发式：前 2KB 用 utf-8 解码出现替换字符 → GB18030
  const head = buf.subarray(0, 2048);
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(head);
    if (s.includes("�")) throw new Error("replacement");
    return "utf-8";
  } catch {
    return "gb18030";
  }
}

function listInputFiles(p) {
  const stat = fs.statSync(p);
  if (stat.isFile()) return [p];
  return fs.readdirSync(p)
    .filter(f => f.endsWith(".txt"))
    .sort()
    .map(f => path.join(p, f));
}

/**
 * 切片：尽量在标点 / 换行 / 段落 边界切，避免切断句子。
 * 古文常无标点 → 优先按换行，其次按指定段落分隔，最后硬切。
 */
function chunkText(text, maxLen) {
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + maxLen, text.length);
    if (end < text.length) {
      // 往回找最近的换行
      const lastBreak = text.lastIndexOf("\n", end);
      if (lastBreak > pos + maxLen * 0.5) end = lastBreak + 1;
    }
    chunks.push(text.slice(pos, end));
    pos = end;
  }
  return chunks;
}

async function callPunct(src, attempt = 0) {
  const form = new FormData();
  form.append("src", src);
  form.append("keep_wrap", "0");

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `gjcool ${TOKEN}` },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = JSON.parse(body);
    if (!json.text) throw new Error(`bad response: ${body.slice(0, 200)}`);
    return Array.isArray(json.text) ? json.text.join("\n") : String(json.text);
  } catch (e) {
    if (attempt < 2 && /timeout|ECONN|ETIMEDOUT|frequent/i.test(String(e))) {
      const wait = 2000 * (attempt + 1);
      console.warn(`[retry] attempt ${attempt + 1}, sleep ${wait}ms — ${e.message}`);
      await new Promise(r => setTimeout(r, wait));
      return callPunct(src, attempt + 1);
    }
    throw e;
  }
}

async function main() {
  const files = listInputFiles(INPUT);
  await fsp.mkdir(OUTPUT, { recursive: true });

  const statePath = path.join(OUTPUT, ".state.json");
  const costPath = path.join(OUTPUT, ".cost.log");
  let state = { completed: {}, totalChars: 0 };
  try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* fresh */ }

  console.log(`endpoint:  ${ENDPOINT}`);
  console.log(`files:     ${files.length} (${files.map(f => path.basename(f)).join(", ")})`);
  console.log(`chunk:     ${CHUNK_SIZE} chars/call`);
  console.log(`qps:       ${QPS} (${REQUEST_GAP_MS}ms gap)`);
  console.log(`budget:    ${BUDGET || "(none)"}`);
  console.log(`dry-run:   ${DRY_RUN}`);
  console.log(`resumed:   ${Object.keys(state.completed).length} files done, ${state.totalChars} chars used so far`);
  console.log("");

  for (const filePath of files) {
    const base = path.basename(filePath, path.extname(filePath));
    const outPath = path.join(OUTPUT, `${base}.txt`);
    if (state.completed[filePath]) {
      console.log(`[skip]  ${base}.txt — already done`);
      continue;
    }

    const buf = fs.readFileSync(filePath);
    const enc = detectEncoding(buf);
    const text = iconv.decode(buf, enc).replace(/\r\n?/g, "\n");
    const chunks = chunkText(text, CHUNK_SIZE);
    const charCount = text.length;

    console.log(`[file]  ${base}: ${charCount.toLocaleString()} chars (${enc}) → ${chunks.length} chunks`);

    if (BUDGET && state.totalChars + charCount > BUDGET) {
      console.warn(`[budget] adding ${charCount} would exceed budget ${BUDGET}; stopping.`);
      break;
    }

    if (DRY_RUN) {
      console.log(`  (dry-run, skipped API)`);
      continue;
    }

    const outputParts = [];
    for (let i = 0; i < chunks.length; i++) {
      const t0 = Date.now();
      process.stdout.write(`  chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)... `);
      const result = await callPunct(chunks[i]);
      const ms = Date.now() - t0;
      outputParts.push(result);
      state.totalChars += chunks[i].length;
      console.log(`done in ${ms}ms`);
      fs.appendFileSync(costPath, `${new Date().toISOString()} ${path.basename(filePath)} chunk${i+1} ${chunks[i].length} chars\n`);
      if (i + 1 < chunks.length) {
        await new Promise(r => setTimeout(r, REQUEST_GAP_MS));
      }
    }

    fs.writeFileSync(outPath, outputParts.join("\n\n"), "utf8");
    state.completed[filePath] = { outPath, chars: charCount, chunks: chunks.length, ts: new Date().toISOString() };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(`[ok]    ${base}.txt written (${outputParts.reduce((s, p) => s + p.length, 0)} chars). Cumulative: ${state.totalChars} chars`);
  }

  console.log("");
  console.log(`=== DONE === total chars sent: ${state.totalChars}`);
}

main().catch((e) => {
  console.error(`[fatal] ${e.stack || e}`);
  process.exit(1);
});
