/**
 * Dump first ~200 chars of each chapter to JSON for manual punctuation.
 *
 * Output JSON: array of { slug, chapter, chapter_order, paras: [{ id, content }] }
 *
 * Usage:
 *   node backend/scripts/dump-chapter-openings.mjs --slugs <a,b,c> --out <file> [--min-chars 200] [--limit-per-book N]
 */
import fs from "node:fs";
import { getDb, initializeLibrary } from "../src/services/library-db.js";

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? "" : (process.argv[i + 1] || "");
}

const SLUGS = (readArg("--slugs") || "shu-yuan-zaji,donglin-liezhuan,siku-mingshi").split(",").map(s => s.trim()).filter(Boolean);
const OUT = readArg("--out") || "/tmp/openings.json";
const MIN_CHARS = Number(readArg("--min-chars") || "200");
const LIMIT_PER_BOOK = Number(readArg("--limit-per-book") || "0");

await initializeLibrary();
const db = getDb();

const all = [];
for (const slug of SLUGS) {
  const book = db.prepare("SELECT id FROM books WHERE slug = ?").get(slug);
  if (!book) continue;
  const rows = db.prepare(`
    SELECT id, chapter, chapter_order, content
    FROM paragraphs WHERE book_id = ?
    ORDER BY chapter_order, id
  `).all(book.id);
  const byCh = new Map();
  for (const r of rows) {
    if (!byCh.has(r.chapter_order)) byCh.set(r.chapter_order, { chapter: r.chapter, chapter_order: r.chapter_order, paras: [] });
    byCh.get(r.chapter_order).paras.push({ id: r.id, content: r.content });
  }
  let count = 0;
  for (const [, info] of [...byCh].sort((a, b) => a[0] - b[0])) {
    // Skip 全覽 aggregate chapters (siku-mingshi has 全覽1-12 which duplicate 卷XXX content)
    if (info.chapter.includes("全覽")) continue;
    // Only first paragraph; skip if even that exceeds 400 chars (too big to manually re-punctuate)
    const first = info.paras[0];
    if (!first || first.content.length > 1500) continue;
    const picked = [first];
    // Add more paragraphs only if first is short
    if (first.content.length < MIN_CHARS) {
      let total = first.content.length;
      for (let i = 1; i < info.paras.length; i++) {
        const p = info.paras[i];
        if (p.content.length > 1500) break;
        picked.push(p);
        total += p.content.length;
        if (total >= MIN_CHARS) break;
      }
    }
    all.push({ slug, chapter: info.chapter, chapter_order: info.chapter_order, paras: picked });
    count++;
    if (LIMIT_PER_BOOK && count >= LIMIT_PER_BOOK) break;
  }
}

fs.writeFileSync(OUT, JSON.stringify(all, null, 2), "utf8");
console.log(`dumped ${all.length} chapters to ${OUT}`);
console.log(`size: ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
