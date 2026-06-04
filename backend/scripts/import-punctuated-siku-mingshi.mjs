/**
 * Import jiayan-punctuated + realigned siku-mingshi into library.sqlite.
 *
 * 用 manifest 提供的 anchor（每章对应的 wikisource URL）做 paragraph_hash 查询：
 *   hash = sha1("siku-mingshi\n${anchor}\n${orig_content}")
 *
 * orig 是 dump 时一段一行写出的；realigned 与 orig 行对齐。
 *
 * Usage:
 *   node backend/scripts/import-punctuated-siku-mingshi.mjs --dump <dir> [--dry-run]
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

const DUMP = readArg("--dump");
const DRY = hasFlag("--dry-run");
if (!DUMP) { console.error("Usage: --dump <dir> [--dry-run]"); process.exit(1); }

const SLUG = "siku-mingshi";
const PUNCT_CHARS = "，。：；？！「」";
const SHARED_PUNCT = "、";

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
const book = db.prepare("SELECT id FROM books WHERE slug = ?").get(SLUG);
if (!book) { console.error(`slug not found: ${SLUG}`); process.exit(1); }

const manifest = JSON.parse(fs.readFileSync(path.join(DUMP, "manifest.json"), "utf8"));

const selectByHash = db.prepare(`SELECT id, content FROM paragraphs WHERE paragraph_hash = ?`);
const updateStmt = db.prepare(`UPDATE paragraphs SET content = ? WHERE id = ?`);
const tx = db.transaction(updates => {
  for (const { id, content } of updates) updateStmt.run(content, id);
});

const updatesById = new Map();
let totalParas = 0, notFound = 0, contentDiff = 0, stripMis = 0;
const problems = [];

for (const entry of manifest.files) {
  const origPath  = path.join(DUMP, "orig",      entry.file);
  const punctPath = path.join(DUMP, "realigned", entry.file);
  if (!fs.existsSync(punctPath)) { console.warn(`[skip] no realigned: ${entry.file}`); continue; }

  const origLines  = fs.readFileSync(origPath,  "utf8").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const punctLines = fs.readFileSync(punctPath, "utf8").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (origLines.length !== punctLines.length) {
    console.error(`[mismatch] ${entry.file}: orig=${origLines.length} punct=${punctLines.length}`);
    continue;
  }
  if (origLines.length !== entry.ids.length) {
    console.error(`[mismatch-manifest] ${entry.file}: lines=${origLines.length} manifest_ids=${entry.ids.length}`);
    continue;
  }

  for (let i = 0; i < origLines.length; i++) {
    totalParas++;
    const orig = origLines[i];
    const punct = punctLines[i];
    const expectedHash = hashText(`${SLUG}\n${entry.anchor}\n${orig}`);
    const dbRow = selectByHash.get(expectedHash);
    if (!dbRow) { notFound++; continue; }
    if (dbRow.content !== orig) {
      contentDiff++;
      problems.push({ file: entry.file, line: i, dbId: dbRow.id, note: "hash-hit-content-differs", orig: orig.slice(0, 40), db: dbRow.content.slice(0, 40) });
      continue;
    }
    if (!contentMatches(orig, punct)) {
      stripMis++;
      problems.push({ file: entry.file, line: i, dbId: dbRow.id, note: "content mismatch", orig: orig.slice(0, 40), punct: punct.slice(0, 50) });
      continue;
    }
    updatesById.set(dbRow.id, punct);
  }
}

const updates = [...updatesById.entries()].map(([id, content]) => ({ id, content }));
if (!DRY && updates.length) tx(updates);

console.log("");
console.log("=".repeat(70));
console.log(`Total paragraphs: ${totalParas}`);
console.log(`Queued updates:   ${updates.length}`);
console.log(`Not in DB:        ${notFound}`);
console.log(`Hash hit/diff:    ${contentDiff}`);
console.log(`Strip mismatch:   ${stripMis}`);
console.log(`Mode: ${DRY ? "DRY-RUN" : "LIVE UPDATE"}`);
if (problems.length && problems.length <= 8) {
  for (const p of problems) console.log("  ", p);
} else if (problems.length) {
  console.log(`  ${problems.length} problems (first 5):`);
  for (const p of problems.slice(0, 5)) console.log("  ", p);
}
