/**
 * Import 明实录 from a directory of 14 sub-volumes (一帝一录).
 * Each 实录 TXT contains many "卷之X" markers; we split each file into volumes
 * and store them with chapter labels formatted "{帝名}/卷X" so the reader can
 * group them as a 2-level TOC.
 *
 * Usage:
 *   node backend/scripts/import-mingshilu.mjs --dir <path-to-明实录-folder>
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDb, initializeLibrary } from "../src/services/library-db.js";

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? "" : (process.argv[i + 1] || "");
}

const dir = readArg("--dir");
if (!dir) {
  console.error("Usage: node scripts/import-mingshilu.mjs --dir <path>");
  process.exit(1);
}

function hashText(t) { return crypto.createHash("sha1").update(t).digest("hex"); }

function readWithEncoding(filePath) {
  const buf = fs.readFileSync(filePath);
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

// 12 sub-volumes (some files exist for compound names)
// We derive the 帝 name from filename: 明{帝}实录.txt or 明实录{帝}实录.txt
function deriveVolumeName(filename) {
  const base = path.basename(filename, ".txt");
  // strip leading "明实录" or "明"
  let name = base;
  if (name.startsWith("明实录")) name = name.slice(3);
  else if (name.startsWith("明")) name = name.slice(1);
  return name; // e.g., "太祖实录"
}

// Match volume markers like "卷之X" anywhere in a short line.
// Headers are short (typically <60 chars), body content is much longer.
const VOLUME_RE = /[實实][錄录]卷之[一二三四五六七八九十百千零〇零\d廿卅]+/;

// Split a single 实录 file into volumes (juan)
function splitVolumes(text, parentName) {
  const lines = normalizeText(text).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const volumes = [];
  let current = { title: `${parentName}/序`, lines: [] };
  let order = 0;

  // Match "卷之X" header; capture the "卷之X" part for the title
  const headerRe = /[實实][錄录](卷之[一二三四五六七八九十百千零〇\d廿卅]+)(?:[終终])?\s*$/;

  for (const line of lines) {
    if (line.length <= 80) {
      const m = line.match(headerRe);
      if (m) {
        // Skip "卷之X終" closing markers — they end a chapter rather than start one
        if (line.includes("終") || line.includes("终")) {
          // End-of-chapter marker — still flush current and continue
          if (current.lines.length > 0) {
            volumes.push({ title: current.title, content: current.lines.join("\n"), order: order++ });
          }
          current = { title: `${parentName}/${m[1]}（後）`, lines: [] };
          continue;
        }
        // Start a new chapter
        if (current.lines.length > 0) {
          volumes.push({ title: current.title, content: current.lines.join("\n"), order: order++ });
        }
        current = { title: `${parentName}/${m[1]}`, lines: [] };
        continue;
      }
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) {
    volumes.push({ title: current.title, content: current.lines.join("\n"), order: order++ });
  }
  return volumes;
}

// Sort sub-volume files by canonical 帝 order
const EMPEROR_ORDER = [
  "太祖", "太宗", "仁宗", "宣宗", "英宗", "宪宗", "孝宗", "武宗",
  "世宗", "穆宗", "神宗", "光宗", "熹宗", "崇祯",
];

function emperorIndex(volumeName) {
  for (let i = 0; i < EMPEROR_ORDER.length; i++) {
    if (volumeName.includes(EMPEROR_ORDER[i])) return i;
  }
  return 999;
}

await initializeLibrary();
const db = getDb();
const book = db.prepare("SELECT id FROM books WHERE slug = 'ming-shi-lu'").get();
if (!book) {
  console.error("'ming-shi-lu' not in books table");
  process.exit(1);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).map((f) => path.join(dir, f));
files.sort((a, b) => emperorIndex(deriveVolumeName(a)) - emperorIndex(deriveVolumeName(b)));
console.log(`Found ${files.length} files in ${dir}`);

const allRows = [];
let globalOrder = 0;

for (const file of files) {
  const volumeName = deriveVolumeName(file);
  console.log(`Importing ${volumeName} from ${path.basename(file)} ...`);
  const text = readWithEncoding(file);
  const volumes = splitVolumes(text, volumeName);
  console.log(`  → ${volumes.length} sub-chapters`);
  for (const v of volumes) {
    // Chunk into paragraphs
    const paragraphs = v.content.split(/\n+/).map((s) => s.trim()).filter((s) => s.length >= 8);
    for (const para of paragraphs) {
      allRows.push({
        bookId: book.id,
        chapter: v.title,
        chapterOrder: globalOrder,
        anchor: `local://${path.basename(file)}`,
        paragraphHash: hashText(`ming-shi-lu\n${v.title}\n${para}`),
        content: para,
      });
    }
    globalOrder++;
  }
}

console.log(`Total: ${globalOrder} chapters / ${allRows.length} paragraphs. Inserting...`);

const remove = db.prepare("DELETE FROM paragraphs WHERE book_id = ?");
const insert = db.prepare(`
  INSERT OR IGNORE INTO paragraphs (book_id, chapter, chapter_order, anchor, paragraph_hash, content)
  VALUES (@bookId, @chapter, @chapterOrder, @anchor, @paragraphHash, @content)
`);
const refresh = db.prepare(`
  UPDATE books SET paragraph_count = (SELECT COUNT(*) FROM paragraphs WHERE book_id = ?),
                   chapter_count = (SELECT COUNT(DISTINCT chapter) FROM paragraphs WHERE book_id = ?),
                   imported_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const tx = db.transaction((rows) => {
  remove.run(book.id);
  for (const r of rows) insert.run(r);
  refresh.run(book.id, book.id, book.id);
});
tx(allRows);

const stats = db.prepare("SELECT chapter_count, paragraph_count FROM books WHERE id = ?").get(book.id);
console.log(`Done. ${stats.chapter_count} chapters, ${stats.paragraph_count} paragraphs.`);
