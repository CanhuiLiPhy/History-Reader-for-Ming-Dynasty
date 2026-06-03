/**
 * epub-anchor-map.js
 *
 * The DB stores paragraph anchors using the PRE-split EPUB layout, e.g.
 *   "OEBPS/text00017.html#filepos0003788693"
 *
 * After epub-splitter.js runs, those big multi-chapter HTML files get split into
 *   OEBPS/text00017_ch000.html, _ch001.html, ...
 * each carrying ONE chapter's worth of content (with its filepos anchor at the
 * start). The wrapper `text00017.html` is overwritten with only the first
 * chapter or a small TOC stub.
 *
 * Result: hrefs like "OEBPS/text00017.html#filepos0003788693" no longer resolve
 * inside the split EPUB (epub.js loads the wrapper, anchor missing → user sees
 * the wrong chapter's first page).
 *
 * This module scans the split EPUB once per book and builds a translation:
 *   "OEBPS/text00017.html#filepos0003788693" → "OEBPS/text00017_ch001.html"
 * which book-service applies to search results before sending them out.
 */

import unzipper from "unzipper";

// slug → Map<oldHref, newHref>
const anchorMapCache = new Map();
// slug → in-flight build promise so concurrent callers share work
const inFlight = new Map();

const FILEPOS_SPLIT_RE = /OEBPS\/text\d+_ch\d+\.html$/;
const FIRST_ANCHOR_RE = /<span\s+id="(filepos\d+)"[^>]*>/;

async function buildMap(splitEpubPath) {
  const map = new Map();
  if (!splitEpubPath) return map;
  try {
    const directory = await unzipper.Open.file(splitEpubPath);
    const files = directory.files.filter((f) => FILEPOS_SPLIT_RE.test(f.path));
    for (const file of files) {
      const buf = await file.buffer();
      const content = buf.toString("utf8");
      const m = content.match(FIRST_ANCHOR_RE);
      if (!m) continue;
      const anchorId = m[1];
      const baseFile = file.path.replace(/_ch\d+\.html$/, ".html");
      map.set(`${baseFile}#${anchorId}`, file.path);
    }
  } catch (err) {
    console.warn(`[anchor-map] build failed for ${splitEpubPath}: ${err.message}`);
  }
  return map;
}

/**
 * Ensure the anchor map for `slug` is loaded. Caller supplies the split EPUB
 * path (already resolved by book-service); we cache once per slug.
 */
export async function ensureAnchorMap(slug, splitEpubPath) {
  if (!slug) return new Map();
  if (anchorMapCache.has(slug)) return anchorMapCache.get(slug);
  if (inFlight.has(slug)) return inFlight.get(slug);
  const promise = buildMap(splitEpubPath).then((map) => {
    anchorMapCache.set(slug, map);
    inFlight.delete(slug);
    return map;
  });
  inFlight.set(slug, promise);
  return promise;
}

/** Sync lookup. No-op if map for slug not loaded yet. */
export function translateAnchor(slug, anchor) {
  if (!anchor) return anchor;
  const map = anchorMapCache.get(slug);
  if (!map || map.size === 0) return anchor;
  return map.get(anchor) || anchor;
}
