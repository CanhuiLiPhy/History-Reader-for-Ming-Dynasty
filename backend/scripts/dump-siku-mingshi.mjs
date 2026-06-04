/**
 * Dump siku-mingshi paragraphs from DB into per-chapter .txt files for jiayan punctuation.
 *
 * Output layout:
 *   <out>/orig/<NNN>-<chapter-short>.txt   (one paragraph per line, no chapter header)
 *   <out>/manifest.json                    {files: [{file, anchor, chapter, ids: [...]}, ...]}
 *
 * Usage:
 *   node backend/scripts/dump-siku-mingshi.mjs --out donotpack/database/siku-mingshi-dump
 */
import fs from "node:fs";
import path from "node:path";
import { getDb, initializeLibrary } from "../src/services/library-db.js";

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? "" : (process.argv[i + 1] || "");
}

const OUT = readArg("--out");
if (!OUT) { console.error("Usage: --out <dir>"); process.exit(1); }

await initializeLibrary();
const db = getDb();
const book = db.prepare("SELECT id, title FROM books WHERE slug = 'siku-mingshi'").get();
if (!book) { console.error("siku-mingshi not in books"); process.exit(1); }

const rows = db.prepare(`
  SELECT id, chapter, chapter_order, anchor, content
  FROM paragraphs WHERE book_id = ?
  ORDER BY chapter_order, id
`).all(book.id);

const byChapter = new Map();
for (const r of rows) {
  const key = r.chapter_order;
  if (!byChapter.has(key)) byChapter.set(key, { chapter: r.chapter, anchor: r.anchor, ids: [], contents: [] });
  byChapter.get(key).ids.push(r.id);
  byChapter.get(key).contents.push(r.content);
}

fs.mkdirSync(path.join(OUT, "orig"), { recursive: true });

function shortName(chapter) {
  // 明史 (四庫全書本)/卷001 -> 卷001
  const tail = chapter.split("/").pop() || chapter;
  return tail.replace(/[^一二三四五六七八九十百千零〇\d卷全覽]/g, "").slice(0, 12) || "X";
}

const manifest = { slug: "siku-mingshi", files: [] };
const seqs = [...byChapter.keys()].sort((a, b) => a - b);
let totalChars = 0;
for (let i = 0; i < seqs.length; i++) {
  const key = seqs[i];
  const info = byChapter.get(key);
  const numStr = String(i + 1).padStart(3, "0");
  const fname = `${numStr}-${shortName(info.chapter)}.txt`;
  const text = info.contents.join("\n");
  fs.writeFileSync(path.join(OUT, "orig", fname), text + "\n", "utf8");
  manifest.files.push({
    file: fname,
    chapter: info.chapter,
    anchor: info.anchor,
    chapter_order: key,
    ids: info.ids,
    lines: info.contents.length,
    chars: text.length,
  });
  totalChars += text.length;
}

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log(`dumped ${seqs.length} chapters, ${rows.length} paragraphs, ${totalChars.toLocaleString()} chars`);
console.log(`out:  ${OUT}/orig/`);
console.log(`manifest: ${OUT}/manifest.json`);
