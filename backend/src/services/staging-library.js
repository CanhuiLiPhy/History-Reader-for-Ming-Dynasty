/**
 * 中文：临时书库——管理员上传的书放这里，独立于正文库 library.sqlite。
 * 这些书不进主库、不建全文索引、不做向量嵌入，但在前端书目里和其他书一样可读。
 *
 * Staging library for administrator-uploaded books.
 *
 * Design contract (deliberate, not an oversight):
 *   - Books live in their own SQLite file (staging.sqlite) under `.userdata/`,
 *     never in library.sqlite. Re-syncing the curated corpus therefore cannot
 *     clobber uploads, and uploads cannot corrupt the curated corpus.
 *   - They are NOT indexed for full-text search, cross-source comparison, or
 *     vector/embedding retrieval — those all read library.sqlite only.
 *   - They ARE readable: the reader endpoints fall through to this module when
 *     a slug is absent from the main library, so an uploaded book appears in
 *     the book list and opens in the DB-reader alongside the curated titles.
 *
 * Every staged slug carries a `tmp-` prefix, which guarantees it can never
 * collide with, or shadow, a curated slug.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import unzipper from "unzipper";
import { parse as parseHtml } from "node-html-parser";
import { XMLParser } from "fast-xml-parser";
import { DATA_ROOT } from "../config/defaults.js";

/** Directory holding the staging DB and the original uploaded files. / 临时库目录。 */
export const STAGING_ROOT = process.env.MINGSHI_STAGING_ROOT
  ? path.resolve(process.env.MINGSHI_STAGING_ROOT)
  : path.join(DATA_ROOT, ".userdata", "staging");

/** Path of the staging SQLite file. / 临时库数据库文件。 */
export const STAGING_DB_PATH = path.join(STAGING_ROOT, "staging.sqlite");

/** Where the original uploaded EPUB/TXT files are kept. / 上传原件存放目录。 */
export const STAGING_UPLOAD_DIR = path.join(STAGING_ROOT, "uploads");

/** Slug prefix that marks a book as staged. / 临时库 slug 前缀。 */
export const STAGING_SLUG_PREFIX = "tmp-";

/** Maximum accepted upload size in bytes (150 MB). / 单个上传文件大小上限。 */
export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

/** Default TXT chapter-splitting pattern, matching 卷X / 第X卷 / 第X回 / 第X篇. */
const DEFAULT_CHAPTER_REGEX = "^(卷[一二三四五六七八九十百千〇零\\d]+|第[一二三四五六七八九十百千〇零\\d]+[卷回篇章])";

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

let stagingDb = null;

/**
 * 中文：打开（并按需初始化）临时书库。
 *
 * Open the staging database, creating directories and schema on first use.
 *
 * Returns:
 *   Database: an open better-sqlite3 handle in WAL mode.
 */
export function getStagingDb() {
  if (stagingDb) return stagingDb;
  fs.mkdirSync(STAGING_UPLOAD_DIR, { recursive: true });
  stagingDb = new Database(STAGING_DB_PATH);
  stagingDb.pragma("journal_mode = WAL");
  stagingDb.pragma("foreign_keys = ON");
  stagingDb.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      slug            TEXT UNIQUE NOT NULL,
      title           TEXT NOT NULL,
      author          TEXT NOT NULL DEFAULT '',
      dynasty         TEXT NOT NULL DEFAULT '',
      description     TEXT NOT NULL DEFAULT '',
      original_name   TEXT NOT NULL DEFAULT '',
      stored_file     TEXT NOT NULL DEFAULT '',
      uploaded_by     TEXT NOT NULL DEFAULT '',
      chapter_count   INTEGER NOT NULL DEFAULT 0,
      paragraph_count INTEGER NOT NULL DEFAULT 0,
      char_count      INTEGER NOT NULL DEFAULT 0,
      uploaded_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS paragraphs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter       TEXT NOT NULL DEFAULT '',
      chapter_order INTEGER NOT NULL DEFAULT 0,
      anchor        TEXT NOT NULL DEFAULT '',
      content       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_staging_para_book ON paragraphs(book_id, chapter_order, id);
  `);
  return stagingDb;
}

// ---------------------------------------------------------------------------
// Text helpers / 文本处理
// ---------------------------------------------------------------------------

/**
 * 中文：规整空白字符。
 *
 * Normalise whitespace in extracted text: strip CR, collapse runs of blank
 * lines, convert non-breaking spaces, trim.
 *
 * Args:
 *   value (string): raw extracted text.
 *
 * Returns:
 *   string: normalised text.
 */
function normalizeText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ /g, " ")
    .trim();
}

/**
 * 中文：把一段文本切成段落，丢掉过短的碎片。
 *
 * Split a chapter body into paragraphs, discarding fragments shorter than 8
 * characters (page numbers, stray punctuation, OCR noise).
 *
 * Args:
 *   rawText (string): chapter body.
 *
 * Returns:
 *   Array<string>: paragraph strings, each >= 8 chars.
 */
function chunkParagraphs(rawText) {
  return normalizeText(rawText).split(/\n+/).map((s) => s.trim()).filter((s) => s.length >= 8);
}

/**
 * 中文：把 XML 解析结果里可能是单值也可能是数组的字段统一成数组。
 *
 * Coerce a fast-xml-parser field (scalar, object, array or undefined) to an
 * array.
 *
 * Args:
 *   value (any): the parsed field.
 *
 * Returns:
 *   Array: empty when the field was absent.
 */
function arrayify(value) {
  return value ? (Array.isArray(value) ? value : [value]) : [];
}

/**
 * 中文：从 XHTML 里抽出标题和正文块。
 *
 * Extract a heading and block-level text from one EPUB (X)HTML document.
 *
 * Args:
 *   html (string): the document source.
 *
 * Returns:
 *   object: {title (string), text (string)} — `text` is block texts joined by
 *     newlines, falling back to the whole body when no block elements match.
 */
function stripHtml(html) {
  const root = parseHtml(html);
  root.querySelectorAll("style, script, noscript").forEach((el) => el.remove());
  const title = root.querySelector("h1, h2, h3, h4")?.textContent?.trim() || "";
  const body = root.querySelector("body") || root;
  const parts = [];
  for (const node of body.querySelectorAll("p, div, h1, h2, h3, h4, h5, h6, li, dt, dd, blockquote, pre")) {
    const text = normalizeText(node.textContent || "");
    if (text) parts.push(text);
  }
  return { title, text: parts.length ? parts.join("\n") : normalizeText(body.textContent || "") };
}

/**
 * 中文：读文本文件，自动识别 UTF-8 / GB18030 编码。
 *
 * Read a text file, auto-detecting the encoding. Strips a UTF-8 BOM; when the
 * UTF-8 decode produces an implausible number of replacement characters the
 * bytes are re-decoded as GB18030 (the usual encoding of Chinese e-texts).
 *
 * Args:
 *   filePath (string): absolute path to the .txt file.
 *
 * Returns:
 *   string: decoded text.
 */
function readTextFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buf.subarray(3));
  }
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const replacements = (utf8.match(/�/g) || []).length;
  if (replacements > 30 || replacements / Math.max(1, utf8.length) > 0.005) {
    try {
      return new TextDecoder("gb18030", { fatal: false }).decode(buf);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

// ---------------------------------------------------------------------------
// Parsing / 解析
// ---------------------------------------------------------------------------

/**
 * 中文：把 EPUB 解压到临时目录。
 *
 * Extract an EPUB (a zip) into a fresh temporary directory.
 *
 * Args:
 *   epubPath (string): absolute path to the .epub file.
 *
 * Returns:
 *   Promise<string>: absolute path of the temp directory holding the contents.
 */
async function extractEpub(epubPath) {
  const dir = path.join(os.tmpdir(), `mingshi-staging-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  const archive = await unzipper.Open.file(epubPath);
  for (const entry of archive.files) {
    if (entry.type !== "File") continue;
    // Guard against zip-slip: never write outside the extraction directory.
    const target = path.resolve(dir, entry.path);
    if (!target.startsWith(path.resolve(dir) + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await new Promise((resolve, reject) => {
      entry.stream().pipe(fs.createWriteStream(target)).on("finish", resolve).on("error", reject);
    });
  }
  return dir;
}

/**
 * 中文：按 spine 顺序把 EPUB 切成章。
 *
 * Parse an extracted EPUB into ordered chapters by walking the OPF spine.
 *
 * Args:
 *   epubDir (string): directory produced by extractEpub().
 *
 * Returns:
 *   object: {title (string), author (string), chapters (Array<object>)} where
 *     each chapter is {chapter, anchor, text, chapterOrder}.
 *
 * Raises:
 *   Error: when META-INF/container.xml or the OPF cannot be read.
 */
function parseEpub(epubDir) {
  const containerXml = fs.readFileSync(path.join(epubDir, "META-INF", "container.xml"), "utf8");
  const container = xmlParser.parse(containerXml);
  const opfPath = container?.container?.rootfiles?.rootfile?.["@_full-path"] || "OEBPS/content.opf";
  const opf = xmlParser.parse(fs.readFileSync(path.join(epubDir, opfPath), "utf8"));

  const meta = opf?.package?.metadata || {};
  const title = arrayify(meta["dc:title"])
    .map((t) => (typeof t === "string" ? t : t?.["#text"] || ""))
    .filter(Boolean).join(" / ");
  const author = arrayify(meta["dc:creator"])
    .map((t) => (typeof t === "string" ? t : t?.["#text"] || ""))
    .filter(Boolean).join("、");

  const opfDir = path.posix.dirname(opfPath);
  const manifestMap = new Map(arrayify(opf?.package?.manifest?.item).map((item) => [item["@_id"], item]));
  const chapters = [];
  let order = 0;
  for (const itemref of arrayify(opf?.package?.spine?.itemref)) {
    const item = manifestMap.get(itemref["@_idref"]);
    if (!item) continue;
    if (!/html|xhtml/i.test(item["@_media-type"] || "")) continue;
    const href = path.posix.normalize(path.posix.join(opfDir, String(item["@_href"]).split("#")[0]));
    const full = path.join(epubDir, href);
    if (!fs.existsSync(full)) continue;
    const { title: chapterTitle, text } = stripHtml(fs.readFileSync(full, "utf8"));
    if (!text) continue;
    chapters.push({ chapter: chapterTitle || `第 ${order + 1} 章`, anchor: href, text, chapterOrder: order });
    order += 1;
  }
  return { title, author, chapters };
}

/**
 * 中文：按章节正则把 TXT 切成章。
 *
 * Split a plain-text book into chapters. A line is treated as a chapter
 * heading when it is at most 80 characters long and matches `chapterRegex`.
 *
 * Args:
 *   txtPath (string): absolute path to the .txt file.
 *   defaultTitle (string): heading used for text preceding the first match.
 *   chapterRegex (string): JS regular-expression source. Default splits on
 *     卷X / 第X卷 / 第X回 / 第X篇 / 第X章.
 *
 * Returns:
 *   Array<object>: chapters of {chapter, anchor, text, chapterOrder}.
 */
function parseTxt(txtPath, defaultTitle, chapterRegex = DEFAULT_CHAPTER_REGEX) {
  let pattern;
  try {
    pattern = new RegExp(chapterRegex);
  } catch {
    pattern = new RegExp(DEFAULT_CHAPTER_REGEX);
  }
  const lines = normalizeText(readTextFile(txtPath)).split(/\n+/).map((l) => l.trim()).filter(Boolean);

  const chapters = [];
  let currentTitle = defaultTitle;
  let buffer = [];
  const flush = () => {
    const text = normalizeText(buffer.join("\n"));
    if (text) {
      chapters.push({
        chapter: currentTitle,
        anchor: `staging://${path.basename(txtPath)}#${chapters.length}`,
        text,
        chapterOrder: chapters.length,
      });
    }
    buffer = [];
  };
  for (const line of lines) {
    if (line.length <= 80 && pattern.test(line)) {
      flush();
      currentTitle = line;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chapters;
}

/**
 * 中文：由书名生成不会与正库冲突的 slug。
 *
 * Build a staging slug that can never collide with a curated slug, because it
 * always carries the `tmp-` prefix and a content-derived suffix.
 *
 * Args:
 *   title (string): the book title.
 *   seed (string): extra entropy, typically the original filename.
 *
 * Returns:
 *   string: e.g. `tmp-mingshi-jishi-a1b2c3`.
 */
function buildStagingSlug(title, seed) {
  const ascii = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = crypto.createHash("sha1").update(`${title}\n${seed}\n${Date.now()}`).digest("hex").slice(0, 6);
  return `${STAGING_SLUG_PREFIX}${ascii || "book"}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Public API / 对外接口
// ---------------------------------------------------------------------------

/**
 * 中文：把上传的文件导入临时书库。
 *
 * Import an uploaded EPUB or TXT into the staging library.
 *
 * The uploaded file is moved into `uploads/` under a slug-derived name and
 * retained, so a book can be re-parsed later without asking for a re-upload.
 *
 * Args:
 *   spec (object):
 *     filePath (string): absolute path of the freshly uploaded temp file.
 *     originalName (string): filename as supplied by the browser.
 *     title (string): optional title override; falls back to EPUB metadata,
 *       then to the filename stem.
 *     author (string): optional author override.
 *     description (string): optional note shown in the book list.
 *     uploadedBy (string): username of the uploader, for display and audit.
 *     chapterRegex (string): optional TXT chapter pattern override.
 *
 * Returns:
 *   Promise<object>: {slug, title, author, chapterCount, paragraphCount,
 *     charCount} describing the imported book.
 *
 * Raises:
 *   Error: for unsupported extensions, unreadable archives, or a file that
 *     yields no extractable text.
 */
export async function importStagingBook(spec) {
  const { filePath, originalName, uploadedBy = "" } = spec;
  const ext = path.extname(originalName || filePath).toLowerCase();
  const stem = path.basename(originalName || filePath).replace(/\.(epub|txt)$/i, "");

  let title = String(spec.title || "").trim();
  let author = String(spec.author || "").trim();
  let chapters = [];
  let tempDir = null;

  try {
    if (ext === ".epub") {
      tempDir = await extractEpub(filePath);
      const parsed = parseEpub(tempDir);
      chapters = parsed.chapters;
      if (!title) title = parsed.title || stem;
      if (!author) author = parsed.author || "";
    } else if (ext === ".txt") {
      if (!title) title = stem;
      chapters = parseTxt(filePath, title, spec.chapterRegex);
    } else {
      throw new Error("只支持 .epub 和 .txt 文件。");
    }
  } finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  if (!chapters.length) throw new Error("未能从文件中解析出任何正文内容。");

  const slug = buildStagingSlug(title || stem, originalName || "");
  const storedFile = `${slug}${ext}`;
  await fsp.mkdir(STAGING_UPLOAD_DIR, { recursive: true });
  await fsp.rename(filePath, path.join(STAGING_UPLOAD_DIR, storedFile)).catch(async () => {
    // rename fails across filesystems (temp dir on another mount) — fall back to copy.
    await fsp.copyFile(filePath, path.join(STAGING_UPLOAD_DIR, storedFile));
    await fsp.unlink(filePath).catch(() => {});
  });

  const database = getStagingDb();
  const insertBook = database.prepare(`
    INSERT INTO books (slug, title, author, description, original_name, stored_file, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertParagraph = database.prepare(
    "INSERT INTO paragraphs (book_id, chapter, chapter_order, anchor, content) VALUES (?, ?, ?, ?, ?)"
  );

  const run = database.transaction(() => {
    const bookId = insertBook.run(
      slug, title || stem, author, String(spec.description || ""),
      String(originalName || ""), storedFile, uploadedBy
    ).lastInsertRowid;

    let paragraphCount = 0;
    let charCount = 0;
    // Chapters whose every fragment fell below the 8-character floor (covers,
    // colophons, blank spine entries) end up with no paragraph rows at all.
    // Count only the chapters that actually survived, so the book list agrees
    // with what the reader's table of contents will show.
    let chapterCount = 0;
    for (const chapter of chapters) {
      const paragraphs = chunkParagraphs(chapter.text);
      if (!paragraphs.length) continue;
      chapterCount += 1;
      for (const paragraph of paragraphs) {
        insertParagraph.run(bookId, chapter.chapter, chapter.chapterOrder, chapter.anchor || "", paragraph);
        paragraphCount += 1;
        charCount += paragraph.length;
      }
    }
    database.prepare(
      "UPDATE books SET chapter_count = ?, paragraph_count = ?, char_count = ? WHERE id = ?"
    ).run(chapterCount, paragraphCount, charCount, bookId);
    return { chapterCount, paragraphCount, charCount };
  });

  const stats = run();
  return {
    slug,
    title: title || stem,
    author,
    chapterCount: stats.chapterCount,
    paragraphCount: stats.paragraphCount,
    charCount: stats.charCount,
  };
}

/**
 * 中文：列出临时库中的所有书。
 *
 * List every staged book, newest upload first.
 *
 * Returns:
 *   Array<object>: {slug, title, author, description, originalName,
 *     uploadedBy, chapterCount, paragraphCount, charCount, uploadedAt}.
 */
export function listStagingBooks() {
  return getStagingDb().prepare(`
    SELECT slug, title, author, dynasty, description,
           original_name   AS originalName,
           uploaded_by     AS uploadedBy,
           chapter_count   AS chapterCount,
           paragraph_count AS paragraphCount,
           char_count      AS charCount,
           uploaded_at     AS uploadedAt
    FROM books
    ORDER BY uploaded_at DESC
  `).all();
}

/**
 * 中文：判断某 slug 是否属于临时库。
 *
 * Test whether a slug belongs to the staging library. The prefix check short-
 * circuits the query for the overwhelmingly common curated-slug case.
 *
 * Args:
 *   slug (string): the book slug to test.
 *
 * Returns:
 *   boolean: true when the slug names a staged book.
 */
export function isStagingSlug(slug) {
  const value = String(slug || "");
  if (!value.startsWith(STAGING_SLUG_PREFIX)) return false;
  return Boolean(getStagingDb().prepare("SELECT 1 FROM books WHERE slug = ?").get(value));
}

/**
 * 中文：临时库书籍的章节目录，形状与正库 getReaderChapters 一致。
 *
 * Chapter list for a staged book, shaped exactly like the curated library's
 * getReaderChapters() so the frontend needs no special case.
 *
 * Args:
 *   slug (string): staged book slug.
 *
 * Returns:
 *   object|null: {slug, title, author, staging: true, chapters: Array<{order,
 *     rawOrder, label, paragraphCount, charCount}>}, or null when not found.
 */
export function getStagingChapters(slug) {
  const database = getStagingDb();
  const book = database.prepare("SELECT id, title, author FROM books WHERE slug = ?").get(slug);
  if (!book) return null;
  const chapters = database.prepare(`
    SELECT chapter, chapter_order AS chapterOrder,
           COUNT(*) AS paragraphCount,
           COALESCE(SUM(LENGTH(content)), 0) AS charCount
    FROM paragraphs WHERE book_id = ?
    GROUP BY chapter, chapter_order
    ORDER BY chapter_order, chapter
  `).all(book.id);
  return {
    slug,
    title: book.title,
    author: book.author || "",
    staging: true,
    chapters: chapters.map((c, index) => ({
      order: index,
      rawOrder: c.chapterOrder,
      label: c.chapter,
      paragraphCount: c.paragraphCount,
      charCount: Number(c.charCount || 0),
    })),
  };
}

/**
 * 中文：临时库书籍的单章正文，形状与正库 getReaderChapter 一致。
 *
 * Chapter body for a staged book, shaped like the curated library's
 * getReaderChapter().
 *
 * Args:
 *   slug (string): staged book slug.
 *   chapterIndex (number): zero-based index into the chapter list.
 *
 * Returns:
 *   object|null: {slug, bookTitle, chapter, chapterIndex, rawOrder,
 *     chapterCount, staging: true, paragraphs: Array<{id, content, hash,
 *     anchor}>}, or null when the book or chapter does not exist.
 */
export function getStagingChapter(slug, chapterIndex) {
  const database = getStagingDb();
  const book = database.prepare("SELECT id, title FROM books WHERE slug = ?").get(slug);
  if (!book) return null;

  const chapters = database.prepare(`
    SELECT chapter, chapter_order AS chapterOrder
    FROM paragraphs WHERE book_id = ?
    GROUP BY chapter, chapter_order
    ORDER BY chapter_order, chapter
  `).all(book.id);
  const target = chapters[chapterIndex];
  if (!target) return null;

  const rows = database.prepare(`
    SELECT id, content, anchor FROM paragraphs
    WHERE book_id = ? AND chapter = ? AND chapter_order = ?
    ORDER BY id
  `).all(book.id, target.chapter, target.chapterOrder);

  return {
    slug,
    bookTitle: book.title,
    chapter: target.chapter,
    chapterIndex,
    rawOrder: target.chapterOrder,
    chapterCount: chapters.length,
    staging: true,
    paragraphs: rows.map((r) => ({
      id: r.id,
      content: r.content,
      hash: crypto.createHash("sha1").update(r.content).digest("hex"),
      anchor: r.anchor || "",
    })),
  };
}

/**
 * 中文：修改临时库书籍的元信息（书名、作者、说明）。
 *
 * Update the display metadata of a staged book.
 *
 * Args:
 *   slug (string): staged book slug.
 *   patch (object): any of {title, author, dynasty, description}.
 *
 * Returns:
 *   boolean: true when a row was updated.
 */
export function updateStagingBook(slug, patch) {
  const sets = [];
  const values = [];
  for (const [key, column] of [["title", "title"], ["author", "author"], ["dynasty", "dynasty"], ["description", "description"]]) {
    if (patch[key] !== undefined) { sets.push(`${column} = ?`); values.push(String(patch[key])); }
  }
  if (!sets.length) return false;
  values.push(slug);
  return getStagingDb().prepare(`UPDATE books SET ${sets.join(", ")} WHERE slug = ?`).run(...values).changes > 0;
}

/**
 * 中文：从临时库删除一本书，同时移除保留的上传原件。
 *
 * Remove a staged book and its retained upload. Paragraphs cascade away.
 *
 * Args:
 *   slug (string): staged book slug.
 *
 * Returns:
 *   boolean: true when a book was removed.
 */
export function deleteStagingBook(slug) {
  const database = getStagingDb();
  const book = database.prepare("SELECT id, stored_file AS storedFile FROM books WHERE slug = ?").get(slug);
  if (!book) return false;
  database.prepare("DELETE FROM books WHERE id = ?").run(book.id);
  if (book.storedFile) {
    fs.rmSync(path.join(STAGING_UPLOAD_DIR, book.storedFile), { force: true });
  }
  return true;
}
