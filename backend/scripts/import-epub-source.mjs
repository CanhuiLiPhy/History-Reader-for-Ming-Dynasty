/**
 * Import an EPUB file as a reference source into the library database.
 * Usage: node scripts/import-epub-source.mjs --slug <slug> --file <path-to-epub>
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import unzipper from "unzipper";
import { parse } from "node-html-parser";
import { XMLParser } from "fast-xml-parser";
import { getDb, getLibraryDbPath, initializeLibrary } from "../src/services/library-db.js";

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? "" : (process.argv[idx + 1] || "");
}

const slug = readArg("--slug");
const epubPath = readArg("--file");

if (!slug || !epubPath) {
  console.error("Usage: node scripts/import-epub-source.mjs --slug <slug> --file <path-to-epub>");
  process.exit(1);
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

function arrayify(v) { return v ? (Array.isArray(v) ? v : [v]) : []; }
function normalizeText(t) { return String(t || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\u00a0/g, " ").trim(); }
function hashText(t) { return crypto.createHash("sha1").update(t).digest("hex"); }

function stripHtml(html) {
  const root = parse(html);
  root.querySelectorAll("style, script, noscript").forEach(el => el.remove());
  const title = root.querySelector("h1, h2, h3, h4")?.textContent?.trim() || "";
  const body = root.querySelector("body") || root;
  // Walk block-level elements so each paragraph keeps its boundary; falling back
  // to body textContent for layouts that don't use <p>/<div> structure.
  const blocks = body.querySelectorAll("p, div, h1, h2, h3, h4, h5, h6, li, dt, dd, blockquote, pre");
  const parts = [];
  for (const node of blocks) {
    const text = normalizeText(node.textContent || "");
    if (text) parts.push(text);
  }
  const joined = parts.length ? parts.join("\n") : normalizeText(body.textContent || "");
  return { title, text: joined };
}

function normalizeHref(baseDir, href) {
  const [filePath] = href.split("#");
  return path.posix.normalize(path.posix.join(baseDir, filePath));
}

// --- Main ---
await initializeLibrary();

// Extract EPUB to temp dir
const tmpDir = path.join(path.dirname(epubPath), `.import-tmp-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const dir = await unzipper.Open.file(epubPath);
await dir.extract({ path: tmpDir, concurrency: 5 });

// Read OPF
const containerXml = fs.readFileSync(path.join(tmpDir, "META-INF/container.xml"), "utf8");
const container = parser.parse(containerXml);
const opfRelPath = container.container.rootfiles.rootfile["@_full-path"];
const opfDir = path.posix.dirname(opfRelPath);
const opfXml = fs.readFileSync(path.join(tmpDir, opfRelPath), "utf8");
const opf = parser.parse(opfXml);

// Build spine order
const manifestItems = arrayify(opf.package.manifest.item);
const manifestMap = new Map(manifestItems.map(i => [i["@_id"], i]));
const spineItems = arrayify(opf.package.spine.itemref);

// Read NCX for labels
let tocFlat = [];
const ncxId = opf.package.spine?.["@_toc"];
const ncxItem = manifestMap.get(ncxId) || manifestItems.find(i => i["@_media-type"] === "application/x-dtbncx+xml");
if (ncxItem) {
  const ncxPath = path.join(tmpDir, opfDir, ncxItem["@_href"]);
  const ncxXml = fs.readFileSync(ncxPath, "utf8");
  const ncx = parser.parse(ncxXml);
  const ncxDir = path.posix.dirname(path.posix.join(opfDir, ncxItem["@_href"]));
  function flattenNav(points) {
    const out = [];
    for (const p of arrayify(points)) {
      const label = typeof p.navLabel?.text === "string" ? p.navLabel.text : (p.navLabel?.text?.["#text"] || "");
      const src = p.content?.["@_src"] || "";
      out.push({ label, href: normalizeHref(ncxDir, src) });
      if (p.navPoint) out.push(...flattenNav(p.navPoint));
    }
    return out;
  }
  tocFlat = flattenNav(ncx.ncx?.navMap?.navPoint);
}

// Parse chapters from spine
const chapters = [];
let chapterOrder = 0;
for (const itemref of spineItems) {
  const manifest = manifestMap.get(itemref["@_idref"]);
  if (!manifest) continue;
  const mediaType = manifest["@_media-type"] || "";
  if (!mediaType.includes("html") && !mediaType.includes("xhtml")) continue;

  const chapterHref = normalizeHref(opfDir, manifest["@_href"]);
  const chapterPath = path.join(tmpDir, chapterHref);
  if (!fs.existsSync(chapterPath)) continue;

  const html = fs.readFileSync(chapterPath, "utf8");
  const parsed = stripHtml(html);
  if (!parsed.text || parsed.text.length < 20) continue;

  // Find label from TOC
  const tocMatch = tocFlat.find(t => t.href.split("#")[0] === chapterHref);
  const label = tocMatch?.label || parsed.title || manifest["@_href"];

  const paragraphs = parsed.text.split(/\n+/).map(s => s.trim()).filter(s => s.length >= 8);
  for (const para of paragraphs) {
    chapters.push({
      chapter: label,
      chapterOrder,
      anchor: chapterHref,
      content: para,
      paragraphHash: hashText(`${slug}\n${chapterHref}\n${para}`)
    });
  }
  chapterOrder++;
}

// Write to DB
const db = getDb();
const book = db.prepare("SELECT id FROM books WHERE slug = ?").get(slug);
if (!book) {
  console.error(`Book slug "${slug}" not found in database. Add it to source-manifest.json first.`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}

const remove = db.prepare("DELETE FROM paragraphs WHERE book_id = ?");
const insert = db.prepare(`
  INSERT OR IGNORE INTO paragraphs (book_id, chapter, chapter_order, anchor, paragraph_hash, content)
  VALUES (@bookId, @chapter, @chapterOrder, @anchor, @paragraphHash, @content)
`);
const refreshCounts = db.prepare(`
  UPDATE books SET paragraph_count = (SELECT COUNT(*) FROM paragraphs WHERE book_id = ?),
                   chapter_count = (SELECT COUNT(DISTINCT chapter) FROM paragraphs WHERE book_id = ?),
                   imported_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const tx = db.transaction((rows) => {
  remove.run(book.id);
  for (const row of rows) {
    insert.run({ bookId: book.id, ...row });
  }
  refreshCounts.run(book.id, book.id, book.id);
});
tx(chapters);

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

const stats = db.prepare("SELECT chapter_count, paragraph_count FROM books WHERE id = ?").get(book.id);
console.log(`SQLite database: ${getLibraryDbPath()}`);
console.log(`${slug}: imported ${stats.chapter_count} chapters / ${stats.paragraph_count} paragraphs from ${path.basename(epubPath)}`);
