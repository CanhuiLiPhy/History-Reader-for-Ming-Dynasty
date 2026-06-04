/**
 * 把 jiayan 标点+对齐过的明实录灌回 library.sqlite。
 *
 * 关键约束（用户指定）：
 *   - 严格按 paragraph_id UPDATE，不重新切割
 *   - chapter / chapter_order / anchor / paragraph_hash 全部保持不变
 *   - 标点版必须与原始版按行 1:1 对齐（已由 realign-punct.py 保证）
 *
 * 算法：
 *   1. 完全复用 import-mingshilu.mjs 的 splitVolumes 逻辑切原始 GB18030 txt
 *   2. 对每行 orig，取对应位置的 realigned 行作为「新 content」
 *   3. 按 ORDER BY id 顺序遍历 DB 该 chapter 的现有段落，逐条 UPDATE
 *   4. 跑前先验证：DB 行数 == 我切出的段落数；DB 现有 content == orig 切出的 content
 *
 * 用法：
 *   node backend/scripts/import-punctuated-mingshilu.mjs --orig-dir <…/明实录> --punct-dir <…/明实录-realigned> [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDb, initializeLibrary } from "../src/services/library-db.js";

function hashText(t) { return crypto.createHash("sha1").update(t).digest("hex"); }

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? "" : (process.argv[i + 1] || "");
}
function hasFlag(flag) { return process.argv.includes(flag); }

const ORIG_DIR  = readArg("--orig-dir");
const PUNCT_DIR = readArg("--punct-dir");
const DRY       = hasFlag("--dry-run");

if (!ORIG_DIR || !PUNCT_DIR) {
  console.error("Usage: node import-punctuated-mingshilu.mjs --orig-dir <path> --punct-dir <path> [--dry-run]");
  process.exit(1);
}

const PUNCT_CHARS = "，。：；？！「」";
// `、` 是 jiayan 也加 + 原文也有的「共享标点」—— 验证时要按字符位置判断
const SHARED_PUNCT = "、";

function readWithEncoding(filePath, encodingHint = null) {
  const buf = fs.readFileSync(filePath);
  if (encodingHint) return new TextDecoder(encodingHint).decode(buf);
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const reps = (utf8.match(/�/g) || []).length;
  if (reps > 30 || reps / Math.max(1, utf8.length) > 0.005) {
    return new TextDecoder("gb18030", { fatal: false }).decode(buf);
  }
  return utf8;
}

function normalizeText(t) {
  return String(t || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function deriveVolumeName(filename) {
  const base = path.basename(filename, ".txt");
  let name = base;
  if (name.startsWith("明实录")) name = name.slice(3);
  else if (name.startsWith("明")) name = name.slice(1);
  return name;
}

const HEADER_RE = /[實实][錄录](卷之[一二三四五六七八九十百千零〇\d廿卅]+)(?:[終终])?\s*$/;

// 完全镜像 import-mingshilu.mjs::splitVolumes，但同时挂载 punctuated 版的对应行
// 关键：volume.order 必须用全局递增的 globalOrder（包括过滤后 .paragraphs 空的卷）
function splitVolumesPaired(origText, punctText, parentName, globalOrderStart) {
  const origLines  = normalizeText(origText).split(/\n+/).map(l => l.trim()).filter(Boolean);
  const punctLines = normalizeText(punctText).split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (origLines.length !== punctLines.length) {
    throw new Error(`line count mismatch: orig=${origLines.length}, punct=${punctLines.length}`);
  }
  const volumes = [];
  let current = { title: `${parentName}/序`, orig: [], punct: [] };
  for (let i = 0; i < origLines.length; i++) {
    const oline = origLines[i];
    const pline = punctLines[i];
    if (oline.length <= 80) {
      const m = oline.match(HEADER_RE);
      if (m) {
        const isClose = oline.includes("終") || oline.includes("终");
        if (current.orig.length > 0) volumes.push(current);
        if (isClose) {
          current = { title: `${parentName}/${m[1]}（後）`, orig: [], punct: [] };
        } else {
          current = { title: `${parentName}/${m[1]}`, orig: [], punct: [] };
        }
        continue;
      }
    }
    current.orig.push(oline);
    current.punct.push(pline);
  }
  if (current.orig.length > 0) volumes.push(current);

  // 分配 chapter_order：每个 volume 占一个，与 import-mingshilu.mjs 中的 globalOrder++ 完全对应
  for (let i = 0; i < volumes.length; i++) {
    volumes[i].chapterOrder = globalOrderStart + i;
  }

  // 重现 paragraphs = orig.length>=8 的过滤
  for (const v of volumes) {
    v.paragraphs = [];
    for (let i = 0; i < v.orig.length; i++) {
      if (v.orig[i].length >= 8) {
        v.paragraphs.push({ orig: v.orig[i], punct: v.punct[i] });
      }
    }
  }
  return volumes;
}

const EMPEROR_ORDER = [
  "太祖","太宗","仁宗","宣宗","英宗","宪宗","孝宗","武宗",
  "世宗","穆宗","神宗","光宗","熹宗","崇祯",
];
function emperorIndex(name) {
  for (let i = 0; i < EMPEROR_ORDER.length; i++) {
    if (name.includes(EMPEROR_ORDER[i])) return i;
  }
  return 999;
}

function stripPunct(s) {
  let out = "";
  for (const c of s) if (!PUNCT_CHARS.includes(c)) out += c;
  return out;
}

// 并行扫描：punct 字符按字符与 orig 对齐；punct 中的 PUNCT_CHARS 一律可跳过；
// `、` 是共享字符 —— 仅当 orig 当前位置也是 `、` 时双方一起前进，否则视为 jiayan 加的可跳过。
function contentMatches(orig, punct) {
  let i = 0, j = 0;
  while (i < orig.length && j < punct.length) {
    const oc = orig[i], pc = punct[j];
    if (oc === pc) { i++; j++; continue; }
    if (PUNCT_CHARS.includes(pc)) { j++; continue; }
    if (pc === SHARED_PUNCT && oc !== SHARED_PUNCT) { j++; continue; }
    return false;
  }
  // punct 剩余必须全是可跳过的标点
  while (j < punct.length) {
    const pc = punct[j];
    if (PUNCT_CHARS.includes(pc) || pc === SHARED_PUNCT) { j++; continue; }
    return false;
  }
  return i === orig.length;
}

await initializeLibrary();
const db = getDb();
const book = db.prepare("SELECT id, title FROM books WHERE slug = 'ming-shi-lu'").get();
if (!book) { console.error("ming-shi-lu not in books"); process.exit(1); }

const files = fs.readdirSync(ORIG_DIR).filter(f => f.endsWith(".txt"));
files.sort((a, b) => emperorIndex(deriveVolumeName(a)) - emperorIndex(deriveVolumeName(b)));

console.log(`Files: ${files.length}`);
console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "LIVE UPDATE"}`);
console.log();

const selectByHash = db.prepare(`
  SELECT id, content FROM paragraphs WHERE paragraph_hash = ?
`);
const updateStmt = db.prepare(`UPDATE paragraphs SET content = ? WHERE id = ?`);

const tx = db.transaction(updates => {
  for (const { id, content } of updates) updateStmt.run(content, id);
});

let totalChaptersChecked = 0;
let totalParasUpdated = 0;
let totalParasSkipped = 0;
let problems = [];

let globalOrder = 0;

for (const fname of files) {
  const volumeName = deriveVolumeName(fname);
  const origPath  = path.join(ORIG_DIR, fname);
  const punctPath = path.join(PUNCT_DIR, fname);
  if (!fs.existsSync(punctPath)) {
    console.warn(`[skip-file] ${fname}: no punctuated counterpart`);
    continue;
  }
  const origText = readWithEncoding(origPath);
  const punctText = fs.readFileSync(punctPath, "utf8");
  let volumes;
  try {
    volumes = splitVolumesPaired(origText, punctText, volumeName, globalOrder);
  } catch (e) {
    console.error(`[fail-file] ${fname}: ${e.message}`);
    problems.push({ file: fname, error: e.message });
    continue;
  }
  globalOrder += volumes.length;
  console.log(`${volumeName}  (${fname}):  ${volumes.length} chapters`);

  // 用 paragraph_hash 精确匹配（hash 公式与 import-mingshilu.mjs 完全相同）
  // 用 Map 按 id 去重；重名 chapter 共享 hash 命中同一行不会重复算
  const updatesById = new Map();
  let fileNotFound = 0;
  let fileStripMis = 0;
  for (const v of volumes) {
    for (const p of v.paragraphs) {
      const expectedHash = hashText(`ming-shi-lu\n${v.title}\n${p.orig}`);
      const dbRow = selectByHash.get(expectedHash);
      if (!dbRow) {
        fileNotFound++;
        continue;
      }
      if (dbRow.content !== p.orig) {
        problems.push({ file: fname, chapter: v.title, dbId: dbRow.id, note: "hash-hit-but-content-differs" });
        continue;
      }
      if (!contentMatches(p.orig, p.punct)) {
        fileStripMis++;
        problems.push({ file: fname, chapter: v.title, dbId: dbRow.id, note: "content mismatch", orig: p.orig.slice(0, 40), punct: p.punct.slice(0, 50) });
        continue;
      }
      updatesById.set(dbRow.id, p.punct);
    }
    totalChaptersChecked++;
  }
  const updates = [...updatesById.entries()].map(([id, content]) => ({ id, content }));
  if (!DRY && updates.length > 0) tx(updates);
  totalParasUpdated += updates.length;
  totalParasSkipped += (fileNotFound + fileStripMis);
  console.log(`  ${updates.length} unique-rows queued | ${fileNotFound} not in DB | ${fileStripMis} strip-mismatch`);
}

console.log();
console.log("=".repeat(80));
console.log(`Chapters checked:  ${totalChaptersChecked}`);
console.log(`Paragraphs updated: ${totalParasUpdated}  ${DRY ? "(dry-run, no writes)" : ""}`);
console.log(`Paragraphs SKIPPED:  ${totalParasSkipped}`);
console.log(`Problems:           ${problems.length}`);
if (problems.length > 0 && problems.length < 20) {
  for (const p of problems) console.log("  ", p);
} else if (problems.length > 0) {
  console.log("  (first 5:)");
  for (const p of problems.slice(0, 5)) console.log("  ", p);
}
