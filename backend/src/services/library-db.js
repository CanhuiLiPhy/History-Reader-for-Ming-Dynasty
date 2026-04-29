import { execFile } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { parse } from "node-html-parser";
import { CACHE_ROOT } from "../config/defaults.js";
import { getBookData } from "./book-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_ROOT = path.join(__dirname, "../data");
const DB_PATH = path.join(CACHE_ROOT, "library.sqlite");
const SCHEMA_PATH = path.join(__dirname, "../db/schema.sql");
const WIKISOURCE_ORIGIN = "https://zh.wikisource.org";
const CTEXT_ORIGIN = "https://ctext.org";
const sourceManifest = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, "source-manifest.json"), "utf8"));
const BOOKS_BY_SLUG = new Map(sourceManifest.map((item) => [item.slug, item]));
const execFileAsync = promisify(execFile);

dns.setDefaultResultOrder("ipv4first");

let dbInstance = null;
let initPromise = null;

function ensureCacheDir() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
}

function hashText(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

function safeNumber(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function createDb() {
  if (dbInstance) return dbInstance;
  ensureCacheDir();
  dbInstance = new Database(DB_PATH);
  dbInstance.pragma("foreign_keys = ON");
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("synchronous = NORMAL");
  return dbInstance;
}

function applySchema(db) {
  const baseSql = fs.readFileSync(SCHEMA_PATH, "utf8");
  try {
    db.exec(baseSql);
  } catch (error) {
    if (!/trigram/i.test(String(error.message || ""))) {
      throw error;
    }
    const fallbackSql = baseSql.replace("tokenize = 'trigram'", "tokenize = 'unicode61 remove_diacritics 0'");
    db.exec(fallbackSql);
  }
}

function upsertBook(db, book) {
  const existing = db.prepare("SELECT id FROM books WHERE slug = ?").get(book.slug);
  if (existing) {
    db.prepare(
      `
      UPDATE books
      SET title = @title,
          author = @author,
          dynasty = @dynasty,
          category = @category,
          source_type = @sourceType,
          source_url = @sourceUrl,
          description = @description
      WHERE slug = @slug
      `
    ).run({
      slug: book.slug,
      title: book.title,
      author: book.author || "",
      dynasty: book.dynasty || "明",
      category: book.category || "reference",
      sourceType: book.sourceType || "manual",
      sourceUrl: book.sourceUrl || "",
      description: book.description || ""
    });
    return existing.id;
  }

  const result = db.prepare(
    `
    INSERT INTO books (slug, title, author, dynasty, category, source_type, source_url, description)
    VALUES (@slug, @title, @author, @dynasty, @category, @sourceType, @sourceUrl, @description)
    `
  ).run({
    slug: book.slug,
    title: book.title,
    author: book.author || "",
    dynasty: book.dynasty || "明",
    category: book.category || "reference",
    sourceType: book.sourceType || "manual",
    sourceUrl: book.sourceUrl || "",
    description: book.description || ""
  });

  return result.lastInsertRowid;
}

function refreshBookCounts(db, bookId) {
  const stats = db
    .prepare(
      `
      SELECT COUNT(*) AS paragraphCount, COUNT(DISTINCT chapter) AS chapterCount
      FROM paragraphs
      WHERE book_id = ?
      `
    )
    .get(bookId);

  db.prepare(
    `
    UPDATE books
    SET paragraph_count = ?, chapter_count = ?, imported_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `
  ).run(stats.paragraphCount || 0, stats.chapterCount || 0, bookId);
}

function chunkParagraphs(rawText) {
  return normalizeText(rawText)
    .split(/\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8);
}

function replaceBookParagraphs(db, { bookId, slug, paragraphs }) {
  const remove = db.prepare("DELETE FROM paragraphs WHERE book_id = ?");
  const insert = db.prepare(
    `
    INSERT OR IGNORE INTO paragraphs (book_id, chapter, chapter_order, anchor, paragraph_hash, content)
    VALUES (@bookId, @chapter, @chapterOrder, @anchor, @paragraphHash, @content)
    `
  );

  const transaction = db.transaction((items) => {
    remove.run(bookId);
    for (const item of items) {
      insert.run({
        bookId,
        chapter: item.chapter,
        chapterOrder: item.chapterOrder,
        anchor: item.anchor || "",
        paragraphHash: item.paragraphHash || hashText(`${slug}\n${item.chapter}\n${item.anchor}\n${item.content}`),
        content: item.content
      });
    }
    refreshBookCounts(db, bookId);
  });

  transaction(paragraphs);
}

function decodeWikiTitle(url) {
  const target = new URL(url);
  return decodeURIComponent(target.pathname.replace(/^\/wiki\//, "")).replace(/_/g, " ");
}

function cleanupWikisourceNode(root) {
  const selectors = [
    "style",
    "script",
    "table",
    "sup.reference",
    ".mw-editsection",
    ".noprint",
    ".ws-noexport",
    "#toc",
    ".catlinks",
    ".navbox",
    ".mw-authority-control"
  ];
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach((node) => node.remove());
  }
}

function extractParagraphsFromWikisource(html, url) {
  const root = parse(html);
  const contentRoot = root.querySelector("#mw-content-text .mw-parser-output") || root.querySelector(".mw-parser-output") || root;
  cleanupWikisourceNode(contentRoot);

  const title = normalizeText(root.querySelector("#firstHeading")?.textContent || decodeWikiTitle(url));
  const paragraphs = [];

  for (const child of contentRoot.childNodes) {
    const tagName = child.rawTagName?.toLowerCase() || "";
    if (!tagName) continue;
    if (!["p", "div", "section", "pre", "dl", "ul", "ol", "h2", "h3", "h4"].includes(tagName)) continue;

    const text = normalizeText(child.textContent || "");
    if (!text) continue;

    for (const paragraph of text.split(/\n+/).map((item) => item.trim()).filter((item) => item.length >= 8)) {
      paragraphs.push(paragraph);
    }
  }

  return {
    title,
    paragraphs: [...new Set(paragraphs)]
  };
}

async function fetchHtmlWithCurl(url) {
  const result = await execFileAsync("curl", ["-sL", "--max-time", "30", url], {
    maxBuffer: 12 * 1024 * 1024
  });

  return result.stdout;
}

export async function fetchHtml(url) {
  if (new URL(url).hostname.includes("ctext.org")) {
    const html = await fetchHtmlWithCurl(url);
    if (html.trim()) return html;
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "MingshiReaderAI/1.0 (+https://localhost)"
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      throw new Error(`抓取失败：${response.status} ${url}`);
    }

    const html = await response.text();
    if (html.includes("<title>Access unavailable</title>")) {
      throw new Error(`抓取被远端暂时限制：${url}`);
    }

    return html;
  } catch (error) {
    const stdout = await fetchHtmlWithCurl(url);

    if (!stdout.trim()) {
      throw error;
    }

    return stdout;
  }
}

async function fetchJson(url) {
  const text = await fetchHtml(url);
  return JSON.parse(text);
}

function wikiTitleToUrl(title) {
  return `${WIKISOURCE_ORIGIN}/wiki/${encodeURIComponent(title).replace(/%2F/g, "/")}`;
}

function collectTocLinks(html, source) {
  const root = parse(html);
  const contentRoot = root.querySelector("#mw-content-text .mw-parser-output") || root.querySelector(".mw-parser-output") || root;
  const prefix = source.crawl?.sameTitlePrefix || source.title;
  const urls = [];

  for (const link of contentRoot.querySelectorAll("a[href^='/wiki/']")) {
    const href = link.getAttribute("href");
    if (!href || href.includes("#") || href.includes("redlink=1")) continue;
    const fullUrl = new URL(href, WIKISOURCE_ORIGIN).toString();
    const title = decodeWikiTitle(fullUrl);
    if (title === prefix || title.startsWith(`${prefix}/`) || title.startsWith(`${source.title}/`)) {
      urls.push(fullUrl);
    }
  }

  return [...new Set(urls)];
}

async function collectAllPageUrls(source, maxPages) {
  const prefix = source.crawl?.allPagesPrefix || `${source.crawl?.sameTitlePrefix || source.title}/`;
  const excludeTitleParts = source.crawl?.excludeTitleParts || [];
  const urls = [];
  let apcontinue = "";

  while (true) {
    const apiUrl = new URL("/w/api.php", WIKISOURCE_ORIGIN);
    apiUrl.searchParams.set("action", "query");
    apiUrl.searchParams.set("list", "allpages");
    apiUrl.searchParams.set("apnamespace", "0");
    apiUrl.searchParams.set("aplimit", "50");
    apiUrl.searchParams.set("apprefix", prefix);
    apiUrl.searchParams.set("format", "json");
    if (apcontinue) apiUrl.searchParams.set("apcontinue", apcontinue);

    const payload = await fetchJson(apiUrl.toString());
    const pages = payload?.query?.allpages || [];
    for (const page of pages) {
      const title = String(page.title || "");
      if (!title || excludeTitleParts.some((part) => title.includes(part))) continue;
      urls.push(wikiTitleToUrl(title));
      if (maxPages > 0 && urls.length >= maxPages) return [...new Set(urls)];
    }

    apcontinue = payload?.continue?.apcontinue || "";
    if (!apcontinue) break;
  }

  return [...new Set(urls)];
}

function collectCtextChapterLinks(html) {
  const root = parse(html);
  const urls = [];

  for (const link of root.querySelectorAll("a[href*='chapter=']")) {
    const href = link.getAttribute("href") || "";
    if (!href) continue;
    urls.push(new URL(href.replace(/&amp;/g, "&"), CTEXT_ORIGIN).toString());
  }

  if (!urls.length) {
    for (const match of html.matchAll(/href=["']([^"']*chapter=\d+[^"']*)["']/g)) {
      const href = match[1] || "";
      if (!href) continue;
      urls.push(new URL(href.replace(/&amp;/g, "&"), CTEXT_ORIGIN).toString());
    }
  }

  return [...new Set(urls)];
}

export async function resolveSourcePageUrls(source, options = {}) {
  const maxPages = safeNumber(options.maxPages, source.crawl?.recommendedMaxPages || 0);
  if (source.crawl?.mode === "manual") {
    const pages = [...(source.crawl.pages || [])];
    return maxPages > 0 ? pages.slice(0, maxPages) : pages;
  }

  if (source.crawl?.mode === "allpages") {
    const pages = await collectAllPageUrls(source, maxPages);
    const includeIndex = source.crawl?.includeIndex === true ? [source.sourceUrl] : [];
    const extraPages = source.crawl?.extraPages || [];
    return [...includeIndex, ...extraPages, ...pages].filter((item, index, array) => item && array.indexOf(item) === index);
  }

  const indexHtml = await fetchHtml(source.sourceUrl);
  if (source.sourceType === "ctext") {
    const links = collectCtextChapterLinks(indexHtml);
    return maxPages > 0 ? links.slice(0, maxPages) : links;
  }

  const links = collectTocLinks(indexHtml, source);
  const filtered = [source.sourceUrl, ...links.filter((item) => item !== source.sourceUrl)];
  return maxPages > 0 ? filtered.slice(0, maxPages) : filtered;
}

function buildWikisourceParagraphRows(source, pages) {
  const rows = [];
  let chapterOrder = 0;

  for (const page of pages) {
    for (const paragraph of page.paragraphs) {
      rows.push({
        chapter: page.title,
        chapterOrder,
        anchor: page.url,
        content: paragraph,
        paragraphHash: hashText(`${source.slug}\n${page.url}\n${paragraph}`)
      });
    }
    chapterOrder += 1;
  }

  return rows;
}

function extractParagraphsFromCtext(html, url) {
  const root = parse(html);
  root.querySelectorAll("script, style, .noprint, .inlinecomment, img, form").forEach((node) => node.remove());
  const title =
    normalizeText(root.querySelector(".wikisectiontitle, .wikiitemtitle, h2")?.textContent || "") ||
    url;
  const textNodes = root
    .querySelectorAll("td.ctext")
    .map((node) => normalizeText(node.textContent || ""))
    .filter((text) => text.length >= 8);

  return {
    title,
    paragraphs: [...new Set(textNodes)]
  };
}

function buildCtextParagraphRows(source, pages) {
  return buildWikisourceParagraphRows(source, pages);
}

function buildMingShiParagraphRows(book) {
  const rows = [];
  let chapterOrder = 0;

  for (const chapter of book.chapters) {
    const paragraphs = chunkParagraphs(chapter.text);
    for (const paragraph of paragraphs) {
      rows.push({
        chapter: chapter.label,
        chapterOrder,
        anchor: chapter.href,
        content: paragraph,
        paragraphHash: hashText(`ming-shi\n${chapter.href}\n${paragraph}`)
      });
    }
    chapterOrder += 1;
  }

  return rows;
}

function quoteMatchTerm(term) {
  return `"${String(term).replace(/"/g, '""')}"`;
}

function buildSnippet(content, keywords) {
  const key = keywords.find((item) => item && content.includes(item)) || keywords[0] || "";
  if (!key) return content.slice(0, 120);
  const index = content.indexOf(key);
  if (index < 0) return content.slice(0, 120);
  const start = Math.max(index - 22, 0);
  const end = Math.min(index + key.length + 58, content.length);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

function localKeywordFallback(text) {
  const cleaned = normalizeText(text).replace(/[，。、《》？：；！“”‘’（）()【】\[\]、]/g, " ");
  const tokens = cleaned
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 12);

  if (tokens.length) {
    return [...new Set(tokens)].slice(0, 5);
  }

  const chars = [];
  for (let index = 0; index < cleaned.length - 1; index += 1) {
    const gram = cleaned.slice(index, index + 2).trim();
    if (gram.length === 2) chars.push(gram);
  }
  return [...new Set(chars)].slice(0, 5);
}

export function getDb() {
  return createDb();
}

export function getLibraryDbPath() {
  return DB_PATH;
}

export function getSourceManifest() {
  return sourceManifest;
}

export async function initializeLibrary() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const db = getDb();
    applySchema(db);

    for (const source of sourceManifest) {
      upsertBook(db, source);
    }

    const baseBook = db
      .prepare("SELECT id, paragraph_count AS paragraphCount, chapter_count AS chapterCount FROM books WHERE slug = 'ming-shi'")
      .get();
    if (!baseBook?.paragraphCount || (baseBook.chapterCount || 0) < 100) {
      const parsedBook = await getBookData();
      replaceBookParagraphs(db, {
        bookId: baseBook.id,
        slug: "ming-shi",
        paragraphs: buildMingShiParagraphRows(parsedBook)
      });
    }

    return db;
  })();

  return initPromise;
}

export function getLibraryOverview() {
  const db = getDb();
  return db
    .prepare(
      `
      SELECT id, slug, title, author, category, source_type AS sourceType, source_url AS sourceUrl,
             chapter_count AS chapterCount, paragraph_count AS paragraphCount, imported_at AS importedAt,
             description
      FROM books
      ORDER BY CASE WHEN category = 'base' THEN 0 ELSE 1 END, title
      `
    )
    .all();
}

export async function importWikisourceSource(slug, options = {}) {
  await initializeLibrary();
  const source = BOOKS_BY_SLUG.get(slug);
  if (!source) {
    throw new Error(`未找到书目：${slug}`);
  }
  if (source.sourceType !== "wikisource") {
    throw new Error(`${source.title} 不是 Wikisource 书目。`);
  }

  const pageUrls = await resolveSourcePageUrls(source, options);
  const pagePayload = [];
  const delayMs = safeNumber(options.delayMs, 0);
  for (let index = 0; index < pageUrls.length; index += 1) {
    const url = pageUrls[index];
    const html = await fetchHtml(url);
    const parsed = extractParagraphsFromWikisource(html, url);
    if (!parsed.paragraphs.length) continue;
    pagePayload.push({
      url,
      title: parsed.title,
      paragraphs: parsed.paragraphs
    });
    if (delayMs && index < pageUrls.length - 1) await delay(delayMs);
  }

  const db = getDb();
  const book = db.prepare("SELECT id FROM books WHERE slug = ?").get(slug);
  replaceBookParagraphs(db, {
    bookId: book.id,
    slug,
    paragraphs: buildWikisourceParagraphRows(source, pagePayload)
  });

  return {
    slug,
    title: source.title,
    pagesImported: pagePayload.length,
    paragraphsImported: pagePayload.reduce((sum, item) => sum + item.paragraphs.length, 0)
  };
}

export async function importCtextSource(slug, options = {}) {
  await initializeLibrary();
  const source = BOOKS_BY_SLUG.get(slug);
  if (!source) {
    throw new Error(`未找到书目：${slug}`);
  }
  if (source.sourceType !== "ctext") {
    throw new Error(`${source.title} 不是 CText 书目。`);
  }

  const pageUrls = await resolveSourcePageUrls(source, options);
  const pagePayload = [];
  const delayMs = safeNumber(options.delayMs, 1200);
  for (let index = 0; index < pageUrls.length; index += 1) {
    const url = pageUrls[index];
    const html = await fetchHtml(url);
    const parsed = extractParagraphsFromCtext(html, url);
    if (!parsed.paragraphs.length) continue;
    pagePayload.push({
      url,
      title: parsed.title,
      paragraphs: parsed.paragraphs
    });
    if (delayMs && index < pageUrls.length - 1) await delay(delayMs);
  }

  const db = getDb();
  const book = db.prepare("SELECT id FROM books WHERE slug = ?").get(slug);
  replaceBookParagraphs(db, {
    bookId: book.id,
    slug,
    paragraphs: buildCtextParagraphRows(source, pagePayload)
  });

  return {
    slug,
    title: source.title,
    pagesImported: pagePayload.length,
    paragraphsImported: pagePayload.reduce((sum, item) => sum + item.paragraphs.length, 0)
  };
}

export async function importReferenceSources(slugs, options = {}) {
  const targets = slugs?.length
    ? slugs
    : sourceManifest.filter((item) => ["wikisource", "ctext"].includes(item.sourceType)).map((item) => item.slug);
  const results = [];
  for (const slug of targets) {
    try {
      const source = BOOKS_BY_SLUG.get(slug);
      if (source?.sourceType === "ctext") {
        results.push(await importCtextSource(slug, options));
      } else {
        results.push(await importWikisourceSource(slug, options));
      }
    } catch (error) {
      const source = BOOKS_BY_SLUG.get(slug);
      results.push({
        slug,
        title: source?.title || slug,
        pagesImported: 0,
        paragraphsImported: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

function splitLocalTextIntoParagraphRows(source, rawText, options = {}) {
  const chapterPattern = options.chapterRegex
    ? new RegExp(options.chapterRegex)
    : /^(卷[一二三四五六七八九十百千〇零\d]+|第[一二三四五六七八九十百千〇零\d]+[卷回篇]|[一二三四五六七八九十百千〇零\d]+、)/;
  const lines = normalizeText(rawText)
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const chapters = [];
  let currentTitle = source.title;
  let currentLines = [];

  const flush = () => {
    const text = normalizeText(currentLines.join("\n"));
    if (text) {
      chapters.push({
        title: currentTitle,
        text
      });
    }
    currentLines = [];
  };

  for (const line of lines) {
    if (line.length <= 80 && chapterPattern.test(line)) {
      flush();
      currentTitle = line;
      continue;
    }
    currentLines.push(line);
  }
  flush();

  const rows = [];
  chapters.forEach((chapter, chapterOrder) => {
    for (const paragraph of chunkParagraphs(chapter.text)) {
      rows.push({
        chapter: chapter.title,
        chapterOrder,
        anchor: options.anchor || source.sourceUrl || `local://${source.slug}`,
        content: paragraph,
        paragraphHash: hashText(`${source.slug}\n${chapter.title}\n${paragraph}`)
      });
    }
  });
  return rows;
}

function readTextFileWithDetectedEncoding(filePath, encodingHint) {
  const buf = fs.readFileSync(filePath);
  // BOM detection
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buf.slice(3));
  }
  if (encodingHint) {
    return new TextDecoder(encodingHint).decode(buf);
  }
  // Try UTF-8 first; fall back to GBK if too many replacement chars
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const replacements = (utf8.match(/�/g) || []).length;
  if (replacements > 30 || replacements / Math.max(1, utf8.length) > 0.005) {
    try {
      return new TextDecoder("gb18030", { fatal: false }).decode(buf);
    } catch {
      try { return new TextDecoder("gbk", { fatal: false }).decode(buf); } catch { return utf8; }
    }
  }
  return utf8;
}

export async function importLocalTextSource(slug, filePath, options = {}) {
  await initializeLibrary();
  const source = BOOKS_BY_SLUG.get(slug);
  if (!source) {
    throw new Error(`未找到书目：${slug}`);
  }
  if (!filePath) {
    throw new Error("缺少本地文本文件路径。");
  }
  const rawText = readTextFileWithDetectedEncoding(filePath, options.encoding);
  const rows = splitLocalTextIntoParagraphRows(source, rawText, {
    chapterRegex: options.chapterRegex,
    anchor: options.anchor || `local://${path.basename(filePath)}`
  });
  const db = getDb();
  const book = db.prepare("SELECT id FROM books WHERE slug = ?").get(slug);
  replaceBookParagraphs(db, {
    bookId: book.id,
    slug,
    paragraphs: rows
  });
  return {
    slug,
    title: source.title,
    filePath,
    pagesImported: new Set(rows.map((item) => item.chapter)).size,
    paragraphsImported: rows.length
  };
}

/**
 * Search reference paragraphs with optional book scope restriction.
 * @param {string[]} bookSlugs - if provided, only search within these books
 */
export function searchReferenceParagraphs({ keywords = [], excludeSlug = "ming-shi", limit = 5, bookSlugs = [] }) {
  const db = getDb();
  const cleanedKeywords = [...new Set((keywords || []).map((item) => normalizeText(item)).filter((item) => item.length >= 2))].slice(0, 6);
  const activeKeywords = cleanedKeywords.length ? cleanedKeywords : localKeywordFallback(cleanedKeywords.join(" "));
  const matchQuery = activeKeywords.map(quoteMatchTerm).join(" OR ");

  // Build optional book scope filter
  const hasScope = bookSlugs.length > 0;
  const scopeClause = hasScope ? ` AND b.slug IN (${bookSlugs.map(() => "?").join(",")})` : "";
  const scopeParams = hasScope ? bookSlugs : [];

  if (matchQuery) {
    const rows = db
      .prepare(
        `
        SELECT p.id, p.chapter, p.anchor, p.content, b.slug AS bookSlug, b.title AS bookTitle,
               b.source_url AS sourceUrl,
               bm25(paragraphs_fts, 1.0, 0.35) AS rank
        FROM paragraphs_fts
        JOIN paragraphs p ON p.id = paragraphs_fts.rowid
        JOIN books b ON b.id = p.book_id
        WHERE paragraphs_fts MATCH ?
          AND b.slug != ?
          ${scopeClause}
        ORDER BY rank
        LIMIT ?
        `
      )
      .all(matchQuery, excludeSlug, ...scopeParams, limit);

    if (rows.length) {
      return rows.map((row, index) => ({
        index: index + 1,
        bookSlug: row.bookSlug,
        bookTitle: row.bookTitle,
        chapter: row.chapter,
        anchor: row.anchor,
        sourceUrl: row.sourceUrl,
        sourceLink: /^https?:\/\//.test(row.anchor || "") ? row.anchor : row.sourceUrl,
        snippet: buildSnippet(row.content, activeKeywords),
        content: row.content,
        score: Number((-row.rank).toFixed(3))
      }));
    }
  }

  const likeTerms = activeKeywords.length ? activeKeywords : [];
  if (!likeTerms.length) return [];

  const conditions = likeTerms.map(() => "p.content LIKE ?").join(" OR ");
  const params = likeTerms.map((item) => `%${item}%`);

  const rows = db
    .prepare(
      `
      SELECT p.id, p.chapter, p.anchor, p.content, b.slug AS bookSlug, b.title AS bookTitle,
             b.source_url AS sourceUrl
      FROM paragraphs p
      JOIN books b ON b.id = p.book_id
      WHERE b.slug != ?
        AND (${conditions})
      LIMIT ?
      `
    )
    .all(excludeSlug, ...params, limit);

  return rows.map((row, index) => ({
    index: index + 1,
    bookSlug: row.bookSlug,
    bookTitle: row.bookTitle,
    chapter: row.chapter,
    anchor: row.anchor,
    sourceUrl: row.sourceUrl,
    sourceLink: /^https?:\/\//.test(row.anchor || "") ? row.anchor : row.sourceUrl,
    snippet: buildSnippet(row.content, likeTerms),
    content: row.content,
    score: 0
  }));
}

export function deriveKeywordsFromText(text) {
  return localKeywordFallback(text);
}

/**
 * Returns a compact book catalog string for AI-guided search scoping.
 * Cached per excludeSlug since the catalog depends on which book is being read.
 */
const cachedCatalogBySlug = new Map();
export function getBookCatalogForAI(excludeSlug = "ming-shi") {
  if (cachedCatalogBySlug.has(excludeSlug)) return cachedCatalogBySlug.get(excludeSlug);
  const db = getDb();
  const books = db.prepare(`
    SELECT slug, title, author, description, chapter_count, paragraph_count
    FROM books WHERE slug != ? AND paragraph_count > 0
    ORDER BY title
  `).all(excludeSlug);
  const lines = books.map(b =>
    `${b.slug}: 《${b.title}》(${b.author || "佚名"}) ${b.chapter_count}章/${b.paragraph_count}段 — ${b.description || ""}`
  );
  const catalog = lines.join("\n");
  cachedCatalogBySlug.set(excludeSlug, catalog);
  return catalog;
}
