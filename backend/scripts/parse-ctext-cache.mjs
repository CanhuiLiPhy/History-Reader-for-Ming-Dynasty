/**
 * Parse cached ctext.org HTML files into SQLite paragraphs.
 *
 * Runs fully offline against the cache produced by scrape-ctext.mjs. Re-runs
 * are idempotent thanks to the paragraph_hash UNIQUE constraint — only new
 * or changed paragraphs get inserted.
 *
 * Usage:
 *   node backend/scripts/parse-ctext-cache.mjs --slug shiku-shu
 *
 * What it does:
 *   1. Reads progress.json to know which chapter files exist
 *   2. For each chapter HTML, splits content by <a name="..."></a> anchors
 *      that mark "卷" boundaries (e.g. "石匮书·卷第一")
 *   3. Within each volume, extracts text content paragraph-by-paragraph
 *   4. Writes to library.sqlite under the given slug
 *      (deletes existing paragraphs for this slug first to avoid duplicates
 *      from earlier wikisource imports under the same slug)
 *
 * The HTML structure for ctext content pages (verified from a real page):
 *   - <a name="石匮书·卷第N"> marks volume start
 *   - Subsequent <p> / table rows of class "ctext" hold paragraph text
 *   - Footnotes/notes appear as nested <span class="note">; we strip them
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { parse as parseHtml } from "node-html-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function arg(flag, fallback = "") {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

const slug = arg("--slug");
const dryRun = process.argv.includes("--dry-run");
if (!slug) {
  console.error("missing --slug");
  process.exit(1);
}

const cacheDir = path.join(REPO_ROOT, "donotpack", "database", `${slug}-ctext-cache`);
const htmlDir = path.join(cacheDir, "html");
const progressPath = path.join(cacheDir, "progress.json");

if (!fs.existsSync(progressPath)) {
  console.error(`no progress.json at ${progressPath} — run scrape-ctext.mjs first`);
  process.exit(1);
}
const state = JSON.parse(fs.readFileSync(progressPath, "utf8"));

function normalizeText(t) {
  return String(t || "")
    .replace(/\r/g, "")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(t) {
  return crypto.createHash("sha1").update(t).digest("hex");
}

/**
 * Extract per-volume content from a chapter HTML.
 * Returns array of { volumeTitle, paragraphs: [text, text, ...] }.
 *
 * Strategy: find every <a name="石匮书·卷第..."> anchor, then walk forward
 * collecting text from sibling/descendant paragraph-bearing nodes until the
 * next anchor of the same shape.
 */
function extractVolumes(html, slug) {
  const root = parseHtml(html);

  // Find anchors that look like volume markers. ctext usually uses both
  // <a name="..."> and <span id="..."> styles depending on era of the page;
  // grab all and filter to those whose value mentions "卷".
  const anchorEls = [
    ...root.querySelectorAll("a[name]"),
    ...root.querySelectorAll("span[id]"),
    ...root.querySelectorAll("h2[id]"),
  ];
  const volumeAnchors = anchorEls
    .map((el) => ({
      name: el.getAttribute("name") || el.getAttribute("id") || "",
      el,
    }))
    .filter((a) => a.name && /卷/.test(a.name));

  if (volumeAnchors.length === 0) {
    // Fallback: treat whole page as one volume named after chapter title.
    const title = root.querySelector("title")?.textContent?.trim() || "未知卷";
    return [{ volumeTitle: title, paragraphs: extractAllText(root) }];
  }

  // For each anchor, slice text from this anchor up to the next anchor.
  // We do this by walking the document order linearisation of all text nodes.
  const allTextSpans = []; // [{ text, beforeAnchorName: string|null }]
  // Simpler: get raw HTML, split by anchor markers, parse fragments.
  const rawHtml = root.toString();
  const anchorPattern = /<(?:a|span|h2)\s+(?:name|id)="([^"]*卷[^"]*)"[^>]*>/g;
  const splits = [];
  let m;
  while ((m = anchorPattern.exec(rawHtml))) {
    splits.push({ name: m[1], offset: m.index });
  }
  splits.push({ name: null, offset: rawHtml.length });

  const volumes = [];
  for (let i = 0; i < splits.length - 1; i++) {
    const a = splits[i];
    const b = splits[i + 1];
    if (!a.name) continue;
    const fragmentHtml = rawHtml.slice(a.offset, b.offset);
    const frag = parseHtml(fragmentHtml);
    const paragraphs = extractAllText(frag);
    if (paragraphs.length) {
      volumes.push({ volumeTitle: a.name, paragraphs });
    }
  }
  return volumes;
}

/**
 * Extract paragraph-level text from a parsed node, dropping menu/scaffolding
 * and ctext UI clutter. Returns deduplicated array of clean paragraph strings.
 */
function extractAllText(node) {
  // Remove obvious chrome
  node.querySelectorAll("script, style, #menubar, #menu, .menuitem, #search, " +
    ".noprint, .urnlabel, #footer, .wikibox, .restable").forEach((el) => el.remove());
  // Remove inline notes (双行小注 / 注释)
  node.querySelectorAll(".note, .footnote").forEach((el) => el.remove());

  const out = [];
  const seen = new Set();
  // ctext renders one paragraph per table row td.ctext; also <p> and <div class="ctext">
  const cells = [
    ...node.querySelectorAll("td.ctext"),
    ...node.querySelectorAll("p"),
    ...node.querySelectorAll("div.ctext"),
  ];
  for (const c of cells) {
    const t = normalizeText(c.textContent);
    if (!t || t.length < 4) continue; // skip ultra-short menu items
    if (/^[\d\s\.\-、]+$/.test(t)) continue; // pure numerics / bullets
    if (/(下一卷|上一卷|目录|查看正文|修改|查看历史)/.test(t) && t.length < 30) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// --- Main ----------------------------------------------------------------
async function main() {
  const chapterIds = Object.entries(state.chapters)
    .filter(([, info]) => info.status === "ok" && info.htmlFile)
    .map(([id, info]) => ({ id, ...info }));

  console.log(`=== ${chapterIds.length} cached chapter HTMLs to parse ===\n`);

  let totalVolumes = 0;
  let totalParagraphs = 0;
  const sample = [];

  // Collect ALL volumes first, then sort by 卷第N numerically before
  // assigning chapter_order. ctext chapter IDs are arbitrary and don't
  // reflect volume sequence — without this sort, the catalog ends up in
  // hash-ID order (e.g. 卷211 first, 卷196 fifth).
  const numerals = { 一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9 };
  function chineseNum(s) {
    let total = 0, section = 0;
    for (const ch of s) {
      if (ch === "百") { section = (section || 1) * 100; total += section; section = 0; continue; }
      if (ch === "十") { section = (section || 1) * 10; total += section; section = 0; continue; }
      const d = numerals[ch];
      if (d != null) section = section * 10 + d;
    }
    return total + section;
  }
  function volumeOrderKey(title) {
    const m = title.match(/卷第([一二三四五六七八九十百]+)/);
    return m ? chineseNum(m[1]) : 99999;
  }

  const collected = []; // { chapterId, volumeTitle, paragraphs }
  for (const ch of chapterIds) {
    const file = path.join(cacheDir, ch.htmlFile);
    const html = fs.readFileSync(file, "utf8");
    const volumes = extractVolumes(html, slug);
    for (const v of volumes) {
      collected.push({ chapterId: ch.id, volumeTitle: v.volumeTitle, paragraphs: v.paragraphs });
    }
  }
  collected.sort((a, b) => volumeOrderKey(a.volumeTitle) - volumeOrderKey(b.volumeTitle));

  const allRecords = []; // { chapter, chapter_order, content }
  let chapterOrder = 0;
  for (const v of collected) {
    totalVolumes++;
    chapterOrder++;
    for (const p of v.paragraphs) {
      totalParagraphs++;
      allRecords.push({
        chapter: v.volumeTitle,
        chapter_order: chapterOrder,
        content: p,
      });
    }
    if (sample.length < 3) sample.push({ chapterId: v.chapterId, volume: v.volumeTitle, firstPara: v.paragraphs[0]?.slice(0, 80) });
  }

  console.log(`Parsed: ${totalVolumes} volumes, ${totalParagraphs} paragraphs\n`);
  console.log("Sample:");
  for (const s of sample) console.log(`  [chapter=${s.chapterId}] ${s.volume}\n    ${s.firstPara || "(empty)"}…`);

  if (dryRun) {
    console.log(`\n--dry-run: not writing to db`);
    return;
  }

  // Write to library.sqlite. Use the project's library-db helpers so we keep
  // the same schema / triggers / FTS-rebuild conventions.
  const { initializeLibrary, getDb, getLibraryDbPath } = await import("../src/services/library-db.js");
  await initializeLibrary();
  const db = getDb();

  console.log(`\nDB: ${getLibraryDbPath()}`);

  const bookRow = db.prepare("SELECT id FROM books WHERE slug = ?").get(slug);
  if (!bookRow) {
    console.error(`book slug "${slug}" not found in books table`);
    process.exit(1);
  }
  const bookId = bookRow.id;

  // Wipe old paragraphs for this slug (e.g. earlier wikisource import)
  console.log(`Deleting existing paragraphs under slug=${slug}…`);
  const delCount = db.prepare("DELETE FROM paragraphs WHERE book_id = ?").run(bookId).changes;
  console.log(`  removed ${delCount} old paragraphs`);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO paragraphs (book_id, chapter, chapter_order, anchor, paragraph_hash, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((records) => {
    for (const r of records) {
      insert.run(bookId, r.chapter, r.chapter_order, "", hashText(`${slug}\n${r.chapter}\n${r.content}`), r.content);
    }
  });
  insertMany(allRecords);

  // Update books summary
  const newCount = db.prepare("SELECT COUNT(*) AS n FROM paragraphs WHERE book_id = ?").get(bookId).n;
  const newChapterCount = db.prepare("SELECT COUNT(DISTINCT chapter) AS n FROM paragraphs WHERE book_id = ?").get(bookId).n;
  db.prepare("UPDATE books SET paragraph_count = ?, chapter_count = ?, source_url = ?, source_type = ? WHERE id = ?").run(
    newCount,
    newChapterCount,
    state.tocUrl || "",
    "ctext",
    bookId,
  );

  console.log(`\nDone: ${slug} now has ${newCount} paragraphs across ${newChapterCount} volumes/chapters.`);
}

main().catch((e) => {
  console.error("\nfatal:", e);
  process.exit(1);
});
