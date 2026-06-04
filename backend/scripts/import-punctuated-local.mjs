/**
 * 通用：把 jiayan 标点+对齐过的本地文本灌回 library.sqlite。
 *
 * 镜像 library-db.js::splitLocalTextIntoParagraphRows 的切片逻辑（章节正则 + length>=8 过滤），
 * 但在 orig 和 realigned 两个文件上并行走，按 paragraph_hash 命中 DB 段落，UPDATE content。
 *
 * 用法：
 *   node backend/scripts/import-punctuated-local.mjs \
 *     --slug <book-slug> --orig <orig.txt> --punct <realigned.txt> \
 *     --chapter-regex '^东林列传卷' [--dry-run]
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { getDb, initializeLibrary } from "../src/services/library-db.js";

function hashText(t) { return crypto.createHash("sha1").update(t).digest("hex"); }
function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? "" : (process.argv[i + 1] || "");
}
function hasFlag(flag) { return process.argv.includes(flag); }

const SLUG     = readArg("--slug");
const ORIG     = readArg("--orig");
const PUNCT    = readArg("--punct");
const CH_RE    = readArg("--chapter-regex");
const DRY      = hasFlag("--dry-run");

if (!SLUG || !ORIG || !PUNCT || !CH_RE) {
  console.error("Usage: --slug <slug> --orig <orig.txt> --punct <realigned.txt> --chapter-regex '<regex>' [--dry-run]");
  process.exit(1);
}

const PUNCT_CHARS = "，。：；？！「」";
const SHARED_PUNCT = "、";

function normalizeText(t) {
  return String(t || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function contentMatches(orig, punct) {
  let i = 0, j = 0;
  while (i < orig.length && j < punct.length) {
    const oc = orig[i], pc = punct[j];
    if (oc === pc) { i++; j++; continue; }
    if (PUNCT_CHARS.includes(pc)) { j++; continue; }
    if (pc === SHARED_PUNCT && oc !== SHARED_PUNCT) { j++; continue; }
    return false;
  }
  while (j < punct.length) {
    const pc = punct[j];
    if (PUNCT_CHARS.includes(pc) || pc === SHARED_PUNCT) { j++; continue; }
    return false;
  }
  return i === orig.length;
}

await initializeLibrary();
const db = getDb();
const book = db.prepare("SELECT id, title FROM books WHERE slug = ?").get(SLUG);
if (!book) { console.error(`slug not found: ${SLUG}`); process.exit(1); }

const origRaw = fs.readFileSync(ORIG, "utf8");
const punctRaw = fs.readFileSync(PUNCT, "utf8");
const origLines  = normalizeText(origRaw).split(/\n+/).map(l => l.trim()).filter(Boolean);
const punctLines = normalizeText(punctRaw).split(/\n+/).map(l => l.trim()).filter(Boolean);
if (origLines.length !== punctLines.length) {
  console.error(`line count mismatch: orig=${origLines.length}, punct=${punctLines.length}`);
  process.exit(1);
}

const chapterRe = new RegExp(CH_RE);
const chapters = [];
let currentTitle = book.title;
let currentOrig = [], currentPunct = [];
const flush = () => {
  if (currentOrig.length) chapters.push({ title: currentTitle, orig: currentOrig, punct: currentPunct });
  currentOrig = []; currentPunct = [];
};
for (let i = 0; i < origLines.length; i++) {
  const oline = origLines[i];
  if (oline.length <= 80 && chapterRe.test(oline)) {
    flush();
    currentTitle = oline;
    continue;
  }
  currentOrig.push(oline);
  currentPunct.push(punctLines[i]);
}
flush();

// 过滤 length >= 8（与 chunkParagraphs 一致）
for (const c of chapters) {
  const paras = [];
  for (let i = 0; i < c.orig.length; i++) {
    if (c.orig[i].length >= 8) paras.push({ orig: c.orig[i], punct: c.punct[i] });
  }
  c.paragraphs = paras;
}

const selectByHash = db.prepare(`SELECT id, content FROM paragraphs WHERE paragraph_hash = ?`);
const updateStmt = db.prepare(`UPDATE paragraphs SET content = ? WHERE id = ?`);
const tx = db.transaction(updates => {
  for (const { id, content } of updates) updateStmt.run(content, id);
});

console.log(`book: ${book.title} (${SLUG})`);
console.log(`chapters: ${chapters.length}, paragraphs (length>=8): ${chapters.reduce((s, c) => s + c.paragraphs.length, 0)}`);
console.log(`mode: ${DRY ? "DRY-RUN" : "LIVE UPDATE"}`);

const updatesById = new Map();
let notFound = 0, stripMis = 0, contentDiff = 0;
const problems = [];

for (const c of chapters) {
  for (const p of c.paragraphs) {
    const expectedHash = hashText(`${SLUG}\n${c.title}\n${p.orig}`);
    const dbRow = selectByHash.get(expectedHash);
    if (!dbRow) { notFound++; continue; }
    if (dbRow.content !== p.orig) {
      contentDiff++;
      problems.push({ chapter: c.title, dbId: dbRow.id, note: "hash-hit-content-differs", orig: p.orig.slice(0, 40), db: dbRow.content.slice(0, 40) });
      continue;
    }
    if (!contentMatches(p.orig, p.punct)) {
      stripMis++;
      problems.push({ chapter: c.title, dbId: dbRow.id, note: "content mismatch", orig: p.orig.slice(0, 40), punct: p.punct.slice(0, 50) });
      continue;
    }
    updatesById.set(dbRow.id, p.punct);
  }
}

const updates = [...updatesById.entries()].map(([id, content]) => ({ id, content }));
if (!DRY && updates.length) tx(updates);

console.log("");
console.log("=".repeat(70));
console.log(`Queued updates:    ${updates.length}`);
console.log(`Not in DB:         ${notFound}`);
console.log(`Hash hit/diff:     ${contentDiff}`);
console.log(`Strip mismatch:    ${stripMis}`);
if (problems.length && problems.length <= 10) {
  for (const p of problems) console.log("  ", p);
} else if (problems.length) {
  console.log(`  ${problems.length} problems (first 5):`);
  for (const p of problems.slice(0, 5)) console.log("  ", p);
}
