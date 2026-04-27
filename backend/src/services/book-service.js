import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import unzipper from "unzipper";
import Fuse from "fuse.js";
import { XMLParser } from "fast-xml-parser";
import { parse } from "node-html-parser";
import { BOOK_PATH, CACHE_ROOT } from "../config/defaults.js";
import { extractYearMentions } from "../data/reign-map.js";
import { ensureSplitEpub } from "./epub-splitter.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true
});

let cachedBook = null;
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

async function loadBook() {
  // Use the chapter-split EPUB so that TOC hrefs match what the browser loads.
  const splitEpubPath = await ensureSplitEpub(BOOK_PATH);
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

export async function getBookData() {
  if (!cachedBook) {
    cachedBook = await loadBook();
  }
  return cachedBook;
}

export async function getBookMeta() {
  const book = await getBookData();
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
  const { limit = 20, expandedQueries = [] } = options;
  const book = await getBookData();
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

export async function buildPersonChronology(person) {
  const search = await searchBook(person, { limit: 32 });
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

export async function getContextSnippets(query, limit = 6) {
  const search = await searchBook(createRetrievalQuery(query), { limit });
  return search.results.map((item, index) => ({
    index: index + 1,
    chapterTitle: item.chapterTitle,
    chapterHref: item.chapterHref,
    snippet: item.text
  }));
}
