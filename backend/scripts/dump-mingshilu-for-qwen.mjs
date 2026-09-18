/**
 * Dump mingshilu paragraphs (stripped of punctuation) as JSONL for Kaggle Qwen inference.
 *
 * Output: one paragraph per line, JSON object {id, raw}
 *   id  — DB paragraph id (for round-trip)
 *   raw — paragraph content with ALL Chinese punctuation stripped
 *
 * Usage:
 *   node backend/scripts/dump-mingshilu-for-qwen.mjs --out /tmp/mingshi-kaggle/mingshilu.jsonl
 */
import fs from "node:fs";
import { getDb, initializeLibrary } from "../src/services/library-db.js";

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? "" : (process.argv[i + 1] || "");
}

const OUT = readArg("--out") || "/tmp/mingshilu.jsonl";
const SLUG = readArg("--slug") || "ming-shi-lu";

const PUNCT = new Set("，。：；？！「」、,.:;?!\"'《》〈〉（）()—…—-");
const stripPunct = s => [...s].filter(c => !PUNCT.has(c)).join("");

await initializeLibrary();
const db = getDb();
const book = db.prepare("SELECT id FROM books WHERE slug=?").get(SLUG);
if (!book) { console.error(`slug not found: ${SLUG}`); process.exit(1); }
const rows = db.prepare(`SELECT id, content FROM paragraphs WHERE book_id=? ORDER BY id`).all(book.id);

const fd = fs.openSync(OUT, "w");
let chars = 0;
for (const r of rows) {
  const raw = stripPunct(r.content);
  fs.writeSync(fd, JSON.stringify({ id: r.id, raw }) + "\n");
  chars += raw.length;
}
fs.closeSync(fd);

console.log(`wrote ${rows.length} paragraphs, ${chars.toLocaleString()} content chars to ${OUT}`);
console.log(`size: ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB`);
