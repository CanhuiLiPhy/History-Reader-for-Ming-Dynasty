import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import unzipper from "unzipper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import Fuse from "fuse.js";
import { XMLParser } from "fast-xml-parser";
import { parse } from "node-html-parser";
import * as OpenCC from "opencc-js";
import { BOOK_PATH, BOOKS_DIR, CACHE_ROOT } from "../config/defaults.js";
import { extractYearMentions } from "../data/reign-map.js";
import { ensureSplitEpub } from "./epub-splitter.js";
import { ensureAnchorMap, translateAnchor, extractAnchorFragment } from "./epub-anchor-map.js";
import { getDb } from "./library-db.js";

export const DEFAULT_BOOK_SLUG = "ming-shi";

// 繁简转换：corpus 大部分以简体落库，但用户常用繁体输入（软件 UI 默认繁体
// 显示）。把查询关键词同时扩成简体 + 繁体两种形式去匹配，覆盖两类场景。
const t2s = OpenCC.Converter({ from: "t", to: "cn" });
const s2t = OpenCC.Converter({ from: "cn", to: "t" });

function expandSimpTradVariants(term) {
  const t = String(term || "").trim();
  if (!t) return [];
  const variants = new Set([t]);
  try { variants.add(t2s(t)); } catch { /* ignore */ }
  try { variants.add(s2t(t)); } catch { /* ignore */ }
  return [...variants].filter(Boolean);
}

export function resolveBookEpubPath(slug) {
  // ming-shi defaults to BOOK_PATH (env-configurable for the legacy single-book setup)
  if (!slug || slug === DEFAULT_BOOK_SLUG) {
    if (BOOK_PATH && fsSync.existsSync(BOOK_PATH)) return BOOK_PATH;
    const fallback = path.join(BOOKS_DIR, `${DEFAULT_BOOK_SLUG}.epub`);
    if (fsSync.existsSync(fallback)) return fallback;
    return BOOK_PATH; // last resort, may not exist
  }
  return path.join(BOOKS_DIR, `${slug}.epub`);
}

export function bookEpubExists(slug) {
  return fsSync.existsSync(resolveBookEpubPath(slug));
}

export function listEpubBookSlugs() {
  const slugs = new Set();
  if (fsSync.existsSync(BOOKS_DIR)) {
    for (const f of fsSync.readdirSync(BOOKS_DIR)) {
      const m = f.match(/^(.+)\.epub$/);
      if (m) slugs.add(m[1]);
    }
  }
  if (BOOK_PATH && fsSync.existsSync(BOOK_PATH)) slugs.add(DEFAULT_BOOK_SLUG);
  return [...slugs];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true
});

// Per-slug in-memory cache so multi-book mode can keep multiple parsed EPUBs hot.
const bookCacheBySlug = new Map();
const MAX_SEARCH_QUERY_LENGTH = 120;
const MAX_RETRIEVAL_QUERY_LENGTH = 32;
const MAX_FUSE_QUERY_LENGTH = 24;
const MAX_KEYWORD_LENGTH = 20;
const MAX_KEYWORD_COUNT = 6;

function arrayify(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeWhitespace(text) {
  return text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function sanitizeQuery(query, maxLength = MAX_SEARCH_QUERY_LENGTH) {
  return String(query || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeHref(baseDir, href, keepHash = false) {
  const [filePath, hash = ""] = href.split("#");
  const normalized = path.posix.normalize(path.posix.join(baseDir, filePath));
  return keepHash && hash ? `${normalized}#${hash}` : normalized;
}

function stripHash(href) {
  return href.split("#")[0];
}

function hashString(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function extractEpub(epubPath) {
  const stat = await fs.stat(epubPath);
  // Use only file size for fingerprint — path and mtime differ across machines
  const fingerprint = hashString(`${stat.size}`);
  const extractDir = path.join(CACHE_ROOT, `epub-${fingerprint}`);

  if (!(await pathExists(extractDir))) {
    await ensureDir(CACHE_ROOT);
    await ensureDir(extractDir);
    const directory = await unzipper.Open.file(epubPath);
    await directory.extract({ path: extractDir, concurrency: 5 });
  }

  return extractDir;
}

async function readXml(filePath) {
  const xml = await fs.readFile(filePath, "utf8");
  return parser.parse(xml);
}

function flattenToc(items, output = []) {
  for (const item of items) {
    output.push({ label: item.label, href: item.href });
    if (item.children?.length) flattenToc(item.children, output);
  }
  return output;
}

function buildTocTree(navPoints, baseDir) {
  return arrayify(navPoints).map((point) => {
    const labelNode = point.navLabel?.text;
    const label = typeof labelNode === "string" ? labelNode : labelNode?.["#text"] || point["navLabel"]?.["text"] || "未命名";
    const src = point.content?.["@_src"] || "";
    return {
      label,
      href: normalizeHref(baseDir, src, true),
      children: buildTocTree(point.navPoint, baseDir)
    };
  });
}

function getMetadataValue(metadata, key) {
  const value = metadata?.[key];
  if (Array.isArray(value)) return value[0];
  if (typeof value === "object" && value != null) return value["#text"] || value["@_id"] || "";
  return value || "";
}

function stripTextFromHtml(html) {
  const root = parse(html);
  const title = root.querySelector("h1, h2, h3")?.textContent?.trim() || "";
  const body = root.querySelector("body") || root;
  const text = normalizeWhitespace(body.textContent || "");
  return { title, text };
}

function cleanupReaderNode(root) {
  root.querySelectorAll("style, script, noscript").forEach((node) => node.remove());
}

function findNamedElement(root, anchor) {
  if (!anchor) return null;
  for (const node of root.querySelectorAll("[id], [name]")) {
    if (node.getAttribute("id") === anchor || node.getAttribute("name") === anchor) {
      return node;
    }
  }
  return null;
}

function topLevelChildIndex(body, node) {
  let current = node;
  while (current?.parentNode && current.parentNode !== body) {
    current = current.parentNode;
  }

  const index = body.childNodes.indexOf(current);
  return index >= 0 ? index : 0;
}

function extractTextRangeFromHtml(html, startAnchor = "", endAnchor = "") {
  const root = parse(html);
  const body = root.querySelector("body") || root;
  cleanupReaderNode(body);

  const startNode = startAnchor ? findNamedElement(body, startAnchor) : null;
  const endNode = endAnchor ? findNamedElement(body, endAnchor) : null;
  const startIndex = startNode ? topLevelChildIndex(body, startNode) : 0;
  const endIndex = endNode ? Math.max(startIndex + 1, topLevelChildIndex(body, endNode)) : body.childNodes.length;

  const parts = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const text = normalizeWhitespace(body.childNodes[index]?.textContent || "");
    if (text) parts.push(text);
  }

  return normalizeWhitespace(parts.join("\n"));
}

function buildVirtualChaptersFromToc({ tocItems, spineChapters, spineHtmlByHref }) {
  if (!tocItems.length) return spineChapters;

  const spineOrder = new Map(spineChapters.map((chapter, index) => [chapter.href, index]));
  const entries = tocItems
    .map((item, index) => {
      const normalizedHref = item.href;
      const [sectionHref, anchor = ""] = normalizedHref.split("#");
      return {
        index,
        label: item.label,
        href: normalizedHref,
        sectionHref,
        anchor,
        order: spineOrder.get(sectionHref) ?? Number.MAX_SAFE_INTEGER
      };
    })
    .filter((item) => item.order !== Number.MAX_SAFE_INTEGER)
    .sort((left, right) => left.order - right.order || left.index - right.index);

  if (entries.length < 15) return spineChapters;

  const virtualChapters = [];
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    const next = entries[index + 1] || null;
    let text = "";

    if (!next || current.sectionHref === next.sectionHref) {
      text = extractTextRangeFromHtml(
        spineHtmlByHref.get(current.sectionHref) || "",
        current.anchor,
        next?.anchor || ""
      );
    } else {
      const parts = [];
      const currentOrder = current.order;
      const nextOrder = next.order;
      parts.push(extractTextRangeFromHtml(spineHtmlByHref.get(current.sectionHref) || "", current.anchor, ""));

      for (let spineIndex = currentOrder + 1; spineIndex < nextOrder; spineIndex += 1) {
        const middle = spineChapters[spineIndex];
        if (middle) parts.push(middle.text);
      }

      text = normalizeWhitespace(parts.join("\n"));
    }

    if (!text) continue;
    virtualChapters.push({
      id: `chapter-${String(index + 1).padStart(3, "0")}-${hashString(current.href)}`,
      href: current.href,
      label: current.label,
      title: current.label,
      text,
      words: text.length
    });
  }

  return virtualChapters.length >= 15 ? virtualChapters : spineChapters;
}

/**
 * Parse an HTML page for internal hyperlinks that likely represent a table of contents.
 * Returns an array of {label, href} items resolved to absolute EPUB paths.
 */
function extractInPageLinks(html, baseDir, spineHrefSet) {
  const root = parse(html);
  root.querySelectorAll("style, script, noscript").forEach((el) => el.remove());

  const links = [];
  const seen = new Set();

  for (const anchor of root.querySelectorAll("a[href]")) {
    const rawHref = (anchor.getAttribute("href") || "").trim();
    // Skip external, fragment-only, or empty hrefs
    if (!rawHref || rawHref.startsWith("http") || rawHref.startsWith("//") || rawHref.startsWith("mailto:") || rawHref === "#") continue;

    const label = (anchor.textContent || "").trim().replace(/\s+/g, " ");
    if (!label || label.length < 1 || label.length > 40) continue;

    const normalizedHref = normalizeHref(baseDir, rawHref, true);
    const fileHref = normalizedHref.split("#")[0];

    // Only include links that point to actual EPUB spine content
    if (!spineHrefSet.has(fileHref)) continue;
    if (seen.has(normalizedHref)) continue;
    seen.add(normalizedHref);

    links.push({ label, href: normalizedHref, children: [] });
  }

  return links;
}

function pickChapterLabel(chapterHref, tocFlat, fallbackTitle) {
  const found = tocFlat.find((item) => stripHash(item.href) === chapterHref);
  return found?.label || fallbackTitle || path.basename(chapterHref);
}

function buildSegments(chapters) {
  const segments = [];
  let order = 0;

  for (const chapter of chapters) {
    const paragraphs = chapter.text
      .split(/\n+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 10);

    let buffer = "";

    const pushBuffer = () => {
      if (!buffer.trim()) return;
      const text = buffer.trim();
      segments.push({
        id: `${chapter.id}-seg-${segments.length + 1}`,
        order: order++,
        chapterId: chapter.id,
        chapterHref: chapter.href,
        chapterTitle: chapter.label,
        text,
        normalizedText: normalizeSearchText(text),
        normalizedTitle: normalizeSearchText(chapter.label),
        years: extractYearMentions(text)
      });
      buffer = "";
    };

    for (const paragraph of paragraphs) {
      if ((buffer + paragraph).length > 220 && buffer) {
        pushBuffer();
      }
      buffer += `${paragraph}\n`;
    }
    pushBuffer();
  }

  return segments;
}

function normalizeSearchText(text) {
  return text.replace(/[\s，。、《》？：；！“”‘’（）()【】\[\]·]/g, "").toLowerCase();
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function heuristicKeywords(query) {
  const normalized = sanitizeQuery(query);
  if (!normalized) return [];

  const cleaned = normalized
    .replace(/[，。、《》？：；！“”‘’（）()【】\[\]、]/g, "\n")
    .split(/\s+|\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .flatMap((item) =>
      item.length > MAX_KEYWORD_LENGTH
        ? [item.slice(0, MAX_KEYWORD_LENGTH), item.slice(-MAX_KEYWORD_LENGTH)]
        : [item]
    );

  if (cleaned.length) return unique(cleaned).slice(0, MAX_KEYWORD_COUNT);

  const gramSource = normalized.slice(0, MAX_KEYWORD_LENGTH);
  const grams = [];
  for (let i = 0; i < gramSource.length - 1; i += 1) {
    const gram = gramSource.slice(i, i + 2);
    if (gram.length >= 2) grams.push(gram);
  }
  return unique([gramSource, ...grams]).slice(0, MAX_KEYWORD_COUNT);
}

function createRetrievalQuery(query) {
  const normalized = sanitizeQuery(query, MAX_SEARCH_QUERY_LENGTH * 2);
  if (!normalized) return "";

  const sentence = normalized
    .split(/[。！？；!?]/)
    .map((item) => item.trim())
    .find((item) => item.length >= 4);

  return sanitizeQuery(sentence || normalized, MAX_RETRIEVAL_QUERY_LENGTH);
}

function scoreExact(segment, queries) {
  const normalizedText = segment.normalizedText || normalizeSearchText(segment.text);
  const normalizedTitle = segment.normalizedTitle || normalizeSearchText(segment.chapterTitle);

  let score = 0;
  for (const query of queries) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) continue;

    if (normalizedTitle.includes(normalizedQuery)) score += 28;
    if (normalizedText.includes(normalizedQuery)) {
      score += 60 - Math.min(normalizedText.indexOf(normalizedQuery), 40);
    } else {
      const chars = [...normalizedQuery];
      const hits = chars.filter((char) => normalizedText.includes(char)).length;
      score += hits * 2;
    }
  }

  return score;
}

function collectCandidateSegments(segments, queries) {
  const seedTerms = unique(
    queries
      .map((query) => normalizeSearchText(query).slice(0, 4))
      .filter((item) => item.length >= 2)
  ).slice(0, 4);

  if (!seedTerms.length) return segments;

  return segments.filter((segment) =>
    seedTerms.some((term) => segment.normalizedTitle.includes(term) || segment.normalizedText.includes(term))
  );
}

function toSnippet(text, query) {
  const normalized = sanitizeQuery(query, 40);
  if (!normalized) return text.slice(0, 120);
  const index = text.indexOf(normalized);
  if (index === -1) return text.slice(0, 120);
  const start = Math.max(index - 26, 0);
  const end = Math.min(index + normalized.length + 60, text.length);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

async function loadBook(slug = DEFAULT_BOOK_SLUG) {
  const epubPath = resolveBookEpubPath(slug);
  // Use the chapter-split EPUB so that TOC hrefs match what the browser loads.
  const splitEpubPath = await ensureSplitEpub(epubPath);
  const extractDir = await extractEpub(splitEpubPath);
  const container = await readXml(path.join(extractDir, "META-INF", "container.xml"));
  const opfRelativePath = container.container.rootfiles.rootfile["@_full-path"];
  const opfPath = path.join(extractDir, opfRelativePath);
  const opfDir = path.posix.dirname(opfRelativePath);
  const opf = await readXml(opfPath);
  const manifestItems = arrayify(opf.package.manifest.item);
  const manifestMap = new Map(manifestItems.map((item) => [item["@_id"], item]));
  const metadata = opf.package.metadata || {};
  const spineItems = arrayify(opf.package.spine.itemref);

  const ncxItemId = opf.package.spine?.["@_toc"];
  const ncxManifest = manifestMap.get(ncxItemId) || manifestItems.find((item) => item["@_media-type"] === "application/x-dtbncx+xml");
  const ncxRelativePath = ncxManifest?.["@_href"];
  const ncxPath = ncxRelativePath ? path.join(extractDir, opfDir, ncxRelativePath) : null;

  let tocTree = [];
  if (ncxPath) {
    const ncx = await readXml(ncxPath);
    const ncxDir = path.posix.dirname(path.posix.join(opfDir, ncxRelativePath));
    tocTree = buildTocTree(ncx.ncx.navMap?.navPoint, ncxDir);
  }
  const tocFlat = flattenToc(tocTree);

  const spineChapters = [];
  const spineHtmlByHref = new Map();
  for (const itemref of spineItems) {
    const manifest = manifestMap.get(itemref["@_idref"]);
    if (!manifest) continue;
    const mediaType = manifest["@_media-type"] || "";
    if (!mediaType.includes("html") && !mediaType.includes("xhtml")) continue;

    const chapterHref = normalizeHref(opfDir, manifest["@_href"]);
    const chapterPath = path.join(extractDir, chapterHref);
    const html = await fs.readFile(chapterPath, "utf8");
    spineHtmlByHref.set(chapterHref, html);
    const parsed = stripTextFromHtml(html);
    const label = pickChapterLabel(chapterHref, tocFlat, parsed.title || manifest["@_href"]);

    spineChapters.push({
      id: manifest["@_id"],
      href: chapterHref,
      label,
      title: parsed.title || label,
      text: parsed.text,
      words: parsed.text.length
    });
  }

  // Extract in-page TOC: scan first few spine items for a page with many internal links
  const spineHrefSet = new Set(spineChapters.map((c) => c.href));
  let inPageToc = [];
  const scanLimit = Math.min(4, spineChapters.length);
  for (let i = 0; i < scanLimit; i++) {
    const chapterPath = path.join(extractDir, spineChapters[i].href);
    try {
      const html = await fs.readFile(chapterPath, "utf8");
      const baseDir = path.posix.dirname(spineChapters[i].href);
      const links = extractInPageLinks(html, baseDir, spineHrefSet);
      if (links.length > inPageToc.length) {
        inPageToc = links;
      }
    } catch {
      // Skip unreadable pages
    }
  }
  // Only use if we found a meaningful in-page TOC (at least 15 entries)
  if (inPageToc.length < 15) inPageToc = [];

  const chapters = buildVirtualChaptersFromToc({
    tocItems: inPageToc,
    spineChapters,
    spineHtmlByHref
  });
  const segments = buildSegments(chapters);
  const fuse = new Fuse(segments, {
    includeScore: true,
    ignoreLocation: true,
    threshold: 0.48,
    keys: [
      { name: "text", weight: 0.8 },
      { name: "chapterTitle", weight: 0.2 }
    ]
  });

  return {
    slug,
    metadata: {
      title: getMetadataValue(metadata, "dc:title") || "明史",
      creator: getMetadataValue(metadata, "dc:creator") || "张廷玉",
      language: getMetadataValue(metadata, "dc:language") || "zh-CN"
    },
    tocTree,
    inPageToc,
    chapters,
    segments,
    fuse
  };
}

export async function getBookData(slug = DEFAULT_BOOK_SLUG) {
  if (!bookCacheBySlug.has(slug)) {
    bookCacheBySlug.set(slug, await loadBook(slug));
  }
  return bookCacheBySlug.get(slug);
}

export async function getBookMeta(slug = DEFAULT_BOOK_SLUG) {
  const book = await getBookData(slug);
  return {
    metadata: book.metadata,
    tocTree: book.tocTree,
    inPageToc: book.inPageToc || [],
    chapters: book.chapters.map((chapter, index) => ({
      id: chapter.id,
      href: chapter.href,
      label: chapter.label,
      title: chapter.title,
      order: index,
      words: chapter.words
    })),
    stats: {
      chapterCount: book.chapters.length,
      segmentCount: book.segments.length,
      totalChars: book.chapters.reduce((sum, chapter) => sum + chapter.words, 0)
    }
  };
}

export async function searchBook(query, options = {}) {
  const { limit = 20, expandedQueries = [], slug = DEFAULT_BOOK_SLUG } = options;
  const book = await getBookData(slug);
  const safeQuery = sanitizeQuery(query);
  const primarySearchQuery = sanitizeQuery(createRetrievalQuery(safeQuery) || safeQuery, MAX_FUSE_QUERY_LENGTH);
  const normalizedExpandedQueries = expandedQueries.map((item) => sanitizeQuery(item, MAX_FUSE_QUERY_LENGTH));
  const queries = unique([primarySearchQuery, ...normalizedExpandedQueries, ...heuristicKeywords(safeQuery)]).slice(0, 10);

  if (!queries.length) {
    return {
      query: safeQuery,
      expandedQueries: [],
      total: 0,
      results: []
    };
  }

  const candidateSegments = collectCandidateSegments(book.segments, queries);
  const exactMatches = [];
  for (const segment of candidateSegments) {
    const score = scoreExact(segment, queries);
    if (score > 0) {
      exactMatches.push({
        ...segment,
        score
      });
    }
  }

  exactMatches.sort((a, b) => b.score - a.score || a.order - b.order);

  const combinedById = new Map(exactMatches.map((segment) => [segment.id, segment]));
  const useFuzzyFallback = safeQuery.length <= MAX_FUSE_QUERY_LENGTH && exactMatches.length < limit;

  if (useFuzzyFallback) {
    const fuzzyQueries = queries.slice(0, 4);
    for (const currentQuery of fuzzyQueries) {
      const fuseQuery = sanitizeQuery(currentQuery, MAX_FUSE_QUERY_LENGTH);
      if (!fuseQuery) continue;
      for (const result of book.fuse.search(fuseQuery, { limit: limit * 4 })) {
        if (combinedById.has(result.item.id)) continue;
        combinedById.set(result.item.id, {
          ...result.item,
          score: 50 - Math.round((result.score || 0) * 50)
        });
      }
    }
  }

  const combined = [...combinedById.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((segment) => ({
      id: segment.id,
      chapterId: segment.chapterId,
      chapterHref: segment.chapterHref,
      chapterTitle: segment.chapterTitle,
      score: segment.score,
      snippet: toSnippet(segment.text, safeQuery || queries[0] || ""),
      text: segment.text,
      years: segment.years
    }));

  return {
    query: safeQuery,
    expandedQueries: queries,
    total: combined.length,
    results: combined
  };
}

// Cross-book full-text search via library-db FTS5. Supports optional book
// scope (empty `slugs` = all readable books). Used by 「本地模糊检索」 when the
// user wants to search across multiple titles instead of just the current book.
//
// Returns paragraph-shaped results carrying the host book's slug & title so
// the frontend can route clicks through switchBook + chapter jump.
export async function searchAcrossBooks(query, options = {}) {
  const { limit = 30, slugs = [], expandedQueries = [] } = options;
  const safeQuery = sanitizeQuery(query);
  if (!safeQuery) {
    return { query: safeQuery, expandedQueries: [], total: 0, results: [] };
  }

  // Build keyword set: primary query + AI-expanded + heuristic n-grams.
  // FTS5 requires terms ≥ 2 chars; we already filter inside library-db.
  const keywords = unique([
    safeQuery,
    ...expandedQueries.map((it) => sanitizeQuery(it)),
    ...heuristicKeywords(safeQuery),
  ]).filter(Boolean);

  const db = getDb();
  // 关键词清洗 + 简繁同时扩展。corpus 多数为简体落库，但用户输入常为繁体，
  // 不扩两形会导致繁体查询完全空命中。
  const baseKeywords = unique(
    keywords
      .map((it) => String(it || "").trim())
      .filter((it) => it.length >= 2)
  ).slice(0, 8);
  const cleanedKeywords = unique(baseKeywords.flatMap(expandSimpTradVariants)).slice(0, 16);

  if (!cleanedKeywords.length) {
    return { query: safeQuery, expandedQueries: keywords, total: 0, results: [] };
  }

  const matchExpr = cleanedKeywords.map((it) => `"${it.replace(/"/g, '""')}"`).join(" OR ");
  const hasScope = Array.isArray(slugs) && slugs.length > 0;
  const scopeClause = hasScope ? ` AND b.slug IN (${slugs.map(() => "?").join(",")})` : "";
  const scopeParams = hasScope ? slugs : [];

  let rows = [];
  try {
    rows = db
      .prepare(
        `
        SELECT p.id, p.chapter, p.chapter_order AS chapterOrder, p.anchor, p.content,
               b.slug AS bookSlug, b.title AS bookTitle,
               bm25(paragraphs_fts, 1.0, 0.35) AS rank
        FROM paragraphs_fts
        JOIN paragraphs p ON p.id = paragraphs_fts.rowid
        JOIN books b ON b.id = p.book_id
        WHERE paragraphs_fts MATCH ?
          ${scopeClause}
        ORDER BY rank
        LIMIT ?
        `
      )
      .all(matchExpr, ...scopeParams, limit);
  } catch {
    // 通常是 FTS MATCH 语法报错（极少数特殊字符）—— 回退到 LIKE。
    rows = [];
  }

  if (!rows.length) {
    // LIKE fallback for queries FTS5 trigram can't match (≤2-char queries 等).
    // SQLite 没有内建 occurrence-count 函数，单纯 LIKE 不带排序时结果按物理
    // 插入顺序回，先导入的明史几乎独占 — 给 frontend 看就像 "搜索仍只覆盖明史"。
    // 解决：用 (length - length-without-term)/term-length 算每段的命中次数，
    // 按它倒序，自然把命中最密集的段排前面，再叠加给跨书结果一个软配额。
    const term = cleanedKeywords[0];
    const conditions = cleanedKeywords.map(() => "p.content LIKE ?").join(" OR ");
    const params = cleanedKeywords.map((it) => `%${it}%`);
    const overFetch = limit * 4;
    const candidates = db
      .prepare(
        `
        SELECT p.id, p.chapter, p.chapter_order AS chapterOrder, p.anchor, p.content,
               b.slug AS bookSlug, b.title AS bookTitle,
               CAST(LENGTH(p.content) - LENGTH(REPLACE(p.content, ?, '')) AS REAL) / NULLIF(LENGTH(?),0) AS hits,
               LENGTH(p.content) AS plen
        FROM paragraphs p
        JOIN books b ON b.id = p.book_id
        WHERE (${conditions})
          ${scopeClause}
        ORDER BY hits DESC, plen ASC
        LIMIT ?
        `
      )
      .all(term, term, ...params, ...scopeParams, overFetch);
    // 软配额：每本书最多 ceil(limit / 4)，避免某一本（通常是明史）独占
    // 整页结果。balanced 不够 limit 时不再用同本书的 overflow 补齐 —— 用户
    // 想看更多某本书的命中，可以用「检索范围」面板把它单选出来再搜。
    const perBookCap = Math.max(2, Math.ceil(limit / 4));
    const pickedByBook = new Map();
    const balanced = [];
    for (const row of candidates) {
      const cnt = pickedByBook.get(row.bookSlug) || 0;
      if (cnt >= perBookCap) continue;
      pickedByBook.set(row.bookSlug, cnt + 1);
      balanced.push({ ...row, rank: -row.hits });
      if (balanced.length >= limit) break;
    }
    rows = balanced;
  }

  // Preload anchor-maps for every distinct book in the result so translateAnchor
  // returns the post-split chapter file instead of the legacy wrapper href.
  const slugSet = new Set(rows.map((r) => r.bookSlug).filter(Boolean));
  await Promise.all(
    [...slugSet].map(async (slug) => {
      try {
        const epubPath = resolveBookEpubPath(slug);
        if (!epubPath) return;
        const splitPath = await ensureSplitEpub(epubPath);
        if (splitPath && splitPath !== epubPath) {
          await ensureAnchorMap(slug, splitPath);
        } else {
          await ensureAnchorMap(slug, null); // mark as no-op map
        }
      } catch {
        await ensureAnchorMap(slug, null);
      }
    })
  );

  const results = rows.map((row, index) => ({
    id: `${row.bookSlug}-${row.id}`,
    bookSlug: row.bookSlug,
    bookTitle: row.bookTitle,
    chapterId: String(row.chapterOrder ?? index),
    chapterOrder: row.chapterOrder ?? null,
    chapterHref: translateAnchor(row.bookSlug, row.anchor || ""),
    paragraphAnchor: extractAnchorFragment(row.anchor || ""),
    chapterTitle: row.chapter || "",
    score: typeof row.rank === "number" ? Number((-row.rank).toFixed(3)) : 0,
    snippet: toSnippet(row.content, safeQuery),
    text: row.content,
    years: extractYearMentions ? extractYearMentions(row.content).slice(0, 5) : [],
  }));

  return {
    query: safeQuery,
    expandedQueries: cleanedKeywords,
    total: results.length,
    results,
  };
}

// 真·模糊检索：把查询切成 bigram，对每个段落计算「命中了几个不同的 bigram」
// 作为 coverage 分。即使查询里有 1–2 个字与正文不一致，剩下的 bigram 仍能命
// 中，按 coverage 排序仍能把高度相关的段落排上来。配合 simp/trad 双展。
//
// 用途：用户记不全完整原文 / 输入有错字 / 想找语义相近的段落。
export async function searchFuzzy(query, options = {}) {
  const { limit = 18, slugs = [] } = options;
  const safeQuery = sanitizeQuery(query);
  if (!safeQuery || safeQuery.length < 2) {
    return { query: safeQuery, expandedQueries: [], total: 0, results: [] };
  }

  // bigram + (一定长度阈值后) trigram 一起做。trigram 加分能让长查询里
  // 完全连续的片段比零散 bigram 命中得分更高。
  const bigrams = [];
  for (let i = 0; i < safeQuery.length - 1; i += 1) bigrams.push(safeQuery.slice(i, i + 2));
  const trigrams = [];
  if (safeQuery.length >= 4) {
    for (let i = 0; i < safeQuery.length - 2; i += 1) trigrams.push(safeQuery.slice(i, i + 3));
  }
  const baseGrams = unique([...bigrams, ...trigrams]);
  // simp/trad 双展，控制总变体数 ≤ 64（SQLite 参数上限是几百个，留余地）
  const variants = unique(baseGrams.flatMap(expandSimpTradVariants)).slice(0, 64);
  if (!variants.length) {
    return { query: safeQuery, expandedQueries: [], total: 0, results: [] };
  }

  const totalQueryGrams = bigrams.length || 1;
  const db = getDb();
  const hasScope = Array.isArray(slugs) && slugs.length > 0;
  const scopeClause = hasScope ? ` AND b.slug IN (${slugs.map(() => "?").join(",")})` : "";
  const scopeParams = hasScope ? slugs : [];

  // 一次 SQL：covered = sum(CASE WHEN content LIKE %v% THEN 1 ELSE 0 END)
  // WHERE 至少命中一个 variant；ORDER BY covered DESC, plen ASC（更短段落排前
  // 面 → 更聚焦的命中段落优先）。
  const likeParams = variants.map((v) => `%${v}%`);
  const coverageExpr = variants.map(() => "(CASE WHEN p.content LIKE ? THEN 1 ELSE 0 END)").join(" + ");
  const whereOr = variants.map(() => "p.content LIKE ?").join(" OR ");
  const overFetch = limit * 6;
  const candidates = db
    .prepare(
      `
      SELECT p.id, p.chapter, p.chapter_order AS chapterOrder, p.anchor, p.content,
             b.slug AS bookSlug, b.title AS bookTitle,
             (${coverageExpr}) AS coverage,
             LENGTH(p.content) AS plen
      FROM paragraphs p
      JOIN books b ON b.id = p.book_id
      WHERE (${whereOr})
        ${scopeClause}
      ORDER BY coverage DESC, plen ASC
      LIMIT ?
      `
    )
    .all(...likeParams, ...likeParams, ...scopeParams, overFetch);

  // 每本书软配额，避免一本独占
  const perBookCap = Math.max(2, Math.ceil(limit / 4));
  const pickedByBook = new Map();
  const balanced = [];
  for (const row of candidates) {
    const cnt = pickedByBook.get(row.bookSlug) || 0;
    if (cnt >= perBookCap) continue;
    pickedByBook.set(row.bookSlug, cnt + 1);
    balanced.push(row);
    if (balanced.length >= limit) break;
  }

  // Preload anchor maps so translateAnchor can rewrite legacy wrapper hrefs.
  const slugSet2 = new Set(balanced.map((r) => r.bookSlug).filter(Boolean));
  await Promise.all(
    [...slugSet2].map(async (slug) => {
      try {
        const epubPath = resolveBookEpubPath(slug);
        if (!epubPath) return;
        const splitPath = await ensureSplitEpub(epubPath);
        await ensureAnchorMap(slug, splitPath && splitPath !== epubPath ? splitPath : null);
      } catch {
        await ensureAnchorMap(slug, null);
      }
    })
  );

  const results = balanced.map((row) => ({
    id: `${row.bookSlug}-${row.id}`,
    bookSlug: row.bookSlug,
    bookTitle: row.bookTitle,
    chapterId: String(row.chapterOrder ?? 0),
    chapterOrder: row.chapterOrder ?? null,
    chapterHref: translateAnchor(row.bookSlug, row.anchor || ""),
    paragraphAnchor: extractAnchorFragment(row.anchor || ""),
    chapterTitle: row.chapter || "",
    score: Math.round((row.coverage / variants.length) * 100) / 100,
    snippet: toSnippet(row.content, safeQuery),
    text: row.content,
    years: extractYearMentions(row.content).slice(0, 5),
  }));

  return {
    query: safeQuery,
    expandedQueries: variants,
    total: results.length,
    results,
  };
}

export async function buildPersonChronology(person, slug = DEFAULT_BOOK_SLUG) {
  const search = await searchBook(person, { limit: 32, slug });
  const timeline = search.results.map((result, index) => ({
    id: `${person}-${index + 1}`,
    chapterTitle: result.chapterTitle,
    chapterHref: result.chapterHref,
    snippet: result.snippet,
    years: result.years
  }));

  return {
    person,
    total: timeline.length,
    items: timeline
  };
}

// --- Biography-index aware extraction ----------------------------------
//
// `biography-index.json` (built by scripts/build-biography-index.mjs) lists
// where each notable person's dedicated 列传 / 世家 chapter lives across
// 明史 / 石匮书后集 / 东林列传 / 罪惟录. When the user queries a person who
// IS in the index, we extract that exact chapter slice (from the person's
// section start to the next person's start) and pass it as the AI's primary
// reference material — far higher quality than the keyword-fuzzy results
// returned by buildPersonChronology(). Falls back to keyword search when no
// biographical chapter is indexed for that person.

let _bioIndexCache = null;
function loadBiographyIndex() {
  if (_bioIndexCache) return _bioIndexCache;
  try {
    const file = path.resolve(__dirname, "../data/biography-index.json");
    const raw = fsSync.readFileSync(file, "utf8");
    _bioIndexCache = JSON.parse(raw);
  } catch (e) {
    console.warn(`[biography-index] failed to load: ${e.message}`);
    _bioIndexCache = { index: {} };
  }
  return _bioIndexCache;
}

/**
 * Extract the slice of a chapter that belongs to a specific person.
 * Heuristic: paragraphs are scanned in order; the slice starts at the first
 * paragraph whose leading text begins with the person's name (or contains
 * `<name>，字` / `<name>，<surname>` style biographical opener), and ends
 * at the first paragraph after that whose leading text begins with the NEXT
 * person's name (or end-of-chapter if the person is the last in the chapter).
 *
 * Returns { paragraphs: string[], chapterLabel, bookSlug, bookTitle, anchor }
 * or null if the slice can't be located.
 */
function extractPersonSlice(db, entry, personName, allPersonsInChapter) {
  const book = db.prepare("SELECT id, title FROM books WHERE slug = ?").get(entry.bookSlug);
  if (!book) return null;
  const rows = db.prepare(`
    SELECT content FROM paragraphs
    WHERE book_id = ? AND chapter = ? AND chapter_order = ?
    ORDER BY id
  `).all(book.id, entry.chapterLabel, entry.chapterOrder);
  if (!rows.length) return null;

  // Locate the paragraph where a given person's biographical section begins.
  // Two heuristics, in order:
  //   (a) Clean case — the paragraph's head (after stripping leading
  //       whitespace and ○/●/◎ markers) begins with the name. This is the
  //       common 明史 / 罪惟录 layout where each new biography starts a
  //       fresh paragraph.
  //   (b) Mid-paragraph case — paragraph chunking concatenated the previous
  //       person's tail onto this person's opener (e.g. paragraph contains
  //       "...特以拱故，不容于朝。张居正，字叔大，..."). Detect by searching
  //       for `<name>，字` or `<name>，<surname>` as a known biographical
  //       opener anywhere in the first half of the paragraph.
  const findStartIdx = (rows, name) => {
    for (let i = 0; i < rows.length; i++) {
      const head = rows[i].content.replace(/^[○●◎○\s]+/, "").slice(0, 8);
      if (head.startsWith(name)) return i;
    }
    // Fallback: biographical opener anywhere in the first half of the para
    for (let i = 0; i < rows.length; i++) {
      const text = rows[i].content;
      const idx = text.indexOf(`${name}，字`);
      if (idx >= 0 && idx < Math.max(40, text.length / 2)) return i;
    }
    return -1;
  };

  let startIdx = findStartIdx(rows, personName);
  if (startIdx < 0) startIdx = 0; // unable to locate — fall back to whole chapter
  let endIdx = rows.length;

  // Find end: first paragraph after startIdx whose head/opener matches a
  // later person's section in the chapter.
  if (entry.personOrder < allPersonsInChapter.length - 1) {
    const laterNames = allPersonsInChapter.slice(entry.personOrder + 1);
    for (let i = startIdx + 1; i < rows.length; i++) {
      const text = rows[i].content;
      const head = text.replace(/^[○●◎○\s]+/, "").slice(0, 8);
      const matched = laterNames.some(
        (n) =>
          head.startsWith(n) ||
          (() => {
            const idx = text.indexOf(`${n}，字`);
            return idx >= 0 && idx < Math.max(40, text.length / 2);
          })()
      );
      if (matched) {
        endIdx = i;
        break;
      }
    }
  }

  return {
    paragraphs: rows.slice(startIdx, endIdx).map((r) => r.content),
    chapterLabel: entry.chapterLabel,
    bookSlug: entry.bookSlug,
    bookTitle: book.title,
    anchor: entry.anchor || "",
    sliceFromIndex: startIdx,
    sliceToIndex: endIdx,
    chapterParagraphCount: rows.length,
  };
}

/**
 * Returns biography-aware chronology references for a person query.
 *  - When the person IS in the biography index: the dedicated chapter slice
 *    from each indexed book is returned as the primary reference.
 *  - When NOT indexed: returns null (caller should fall back to keyword
 *    search via buildPersonChronology()).
 */
export function lookupBiographicalReferences(personQuery) {
  const idx = loadBiographyIndex();
  const name = (personQuery || "").trim();
  if (!name) return null;
  // 索引 key 全是简体；用户输入可能繁体 (張居正 / 劉基) — 用 expandSimpTradVariants
  // 把查询展成简繁两种形式，按命中数取第一个非空结果。
  const variants = expandSimpTradVariants(name);
  let entries = null;
  let canonicalName = name;
  for (const v of variants) {
    const found = idx.index?.[v];
    if (found && found.length) {
      entries = found;
      canonicalName = v;
      break;
    }
  }
  if (!entries || !entries.length) return null;

  // We need the list of every person in each chapter (to know where the
  // current person's slice ends). Build a quick lookup by walking the index.
  const personsInChapter = new Map(); // `${slug}#${order}` -> [name, …] sorted by personOrder
  for (const [pname, plist] of Object.entries(idx.index || {})) {
    for (const e of plist) {
      const key = `${e.bookSlug}#${e.chapterOrder}`;
      if (!personsInChapter.has(key)) personsInChapter.set(key, []);
      personsInChapter.get(key).push({ name: pname, order: e.personOrder });
    }
  }
  for (const arr of personsInChapter.values()) arr.sort((a, b) => a.order - b.order);

  const db = getDb();
  const slices = [];
  for (const e of entries) {
    const key = `${e.bookSlug}#${e.chapterOrder}`;
    const orderedNames = (personsInChapter.get(key) || []).map((x) => x.name);
    const slice = extractPersonSlice(db, e, canonicalName, orderedNames);
    if (slice) slices.push(slice);
  }
  return slices.length ? slices : null;
}

export async function getContextSnippets(query, limit = 6, slug = DEFAULT_BOOK_SLUG) {
  const search = await searchBook(createRetrievalQuery(query), { limit, slug });
  return search.results.map((item, index) => ({
    index: index + 1,
    chapterTitle: item.chapterTitle,
    chapterHref: item.chapterHref,
    snippet: item.text
  }));
}
