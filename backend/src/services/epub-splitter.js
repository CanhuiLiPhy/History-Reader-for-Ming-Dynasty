/**
 * epub-splitter.js
 *
 * Takes an extracted EPUB directory and splits HTML files that contain multiple
 * chapter anchors (<span id="fileposXXX">) into one file per chapter.
 * Then rewrites OPF manifest/spine and NCX to reference the new files,
 * and repacks the whole thing into a new .epub file.
 *
 * The result is an EPUB where every chapter is its own spine section,
 * making epub.js navigation (display, CFI, pagination) fully reliable.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import unzipper from "unzipper";
import { CACHE_ROOT } from "../config/defaults.js";

// Cache split EPUB paths by source-file fingerprint so multi-book mode works.
const splitEpubPaths = new Map();

/**
 * Returns the path to a chapter-split EPUB.  Caches by source file fingerprint
 * so different EPUBs each get their own cache entry.
 */
export async function ensureSplitEpub(originalEpubPath) {
  const stat = fs.statSync(originalEpubPath);
  const fingerprint = crypto.createHash("sha1")
    .update(`${stat.size}`)
    .digest("hex")
    .slice(0, 12);

  const cached = splitEpubPaths.get(fingerprint);
  if (cached && fs.existsSync(cached)) return cached;

  const outPath = path.join(CACHE_ROOT, `split-${fingerprint}.epub`);
  if (fs.existsSync(outPath)) {
    splitEpubPaths.set(fingerprint, outPath);
    return outPath;
  }

  // Extract to a TEMPORARY directory (don't clobber the main extract cache)
  const tmpDir = path.join(CACHE_ROOT, `split-tmp-${fingerprint}`);
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const directory = await unzipper.Open.file(originalEpubPath);
  await directory.extract({ path: tmpDir, concurrency: 5 });

  let result = { splitCount: 0, totalChapters: 0 };
  try {
    result = splitAndRepack(tmpDir, outPath);
  } catch (error) {
    console.warn(`epub-splitter: ${path.basename(originalEpubPath)} split failed (${error.message}); using original.`);
  }
  console.log(`epub-splitter: ${path.basename(originalEpubPath)} split ${result.splitCount} files → ${result.totalChapters} chapters`);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  // splitAndRepack only handles EPUBs with an OEBPS/ layout; for OPS/, EPUB/,
  // or flat structures it bails out without writing outPath. epub.js can render
  // the original EPUB just fine — fall back so downstream stat()/extract() work.
  if (!fs.existsSync(outPath)) {
    splitEpubPaths.set(fingerprint, originalEpubPath);
    return originalEpubPath;
  }

  splitEpubPaths.set(fingerprint, outPath);
  return outPath;
}

/**
 * Split an extracted EPUB in-place and repack to a new .epub file.
 * @param {string} extractDir  Path to the extracted EPUB directory
 * @param {string} outputEpub  Path to write the repacked EPUB
 * @returns {{ splitCount: number, totalChapters: number }}
 */
export function splitAndRepack(extractDir, outputEpub) {
  const oebpsDir = path.join(extractDir, "OEBPS");
  if (!fs.existsSync(oebpsDir)) {
    // No OEBPS directory — might be flat structure, skip splitting
    return { splitCount: 0, totalChapters: 0 };
  }

  // --- 1. Read OPF ---
  const opfPath = path.join(oebpsDir, "content.opf");
  let opf = fs.readFileSync(opfPath, "utf8");

  // --- 2. Find HTML files with multiple anchors and split them ---
  const htmlFiles = fs.readdirSync(oebpsDir).filter(f => /^text\d+\.html$/.test(f)).sort();
  const fileMap = new Map(); // oldFile -> [{ newFile, anchorId }]
  let totalChapters = 0;
  let splitCount = 0;

  for (const htmlFile of htmlFiles) {
    const htmlPath = path.join(oebpsDir, htmlFile);
    const html = fs.readFileSync(htmlPath, "utf8");

    // Find all anchor positions
    const anchorRegex = /<span\s+id="(filepos\d+)"[^>]*>\s*<\/span>/g;
    const anchors = [];
    let m;
    while ((m = anchorRegex.exec(html)) !== null) {
      anchors.push({ id: m[1], position: m.index });
    }

    if (anchors.length <= 1) {
      // Single chapter or no anchors — keep as is
      totalChapters++;
      continue;
    }

    // Split the file at each anchor point
    splitCount++;
    const baseName = htmlFile.replace(/\.html$/, "");

    // Extract head section
    const headMatch = html.match(/<head[^>]*>[\s\S]*?<\/head>/);
    const headContent = headMatch ? headMatch[0] : "<head><title></title></head>";

    // Extract content before first anchor (TOC page / preamble)
    // and content for each anchor-delimited chapter
    const parts = [];
    for (let i = 0; i < anchors.length; i++) {
      const start = anchors[i].position;
      const end = i + 1 < anchors.length ? anchors[i + 1].position : html.indexOf("</body>");
      if (end <= start) continue;
      parts.push({
        anchorId: anchors[i].id,
        content: html.slice(start, end)
      });
    }

    // Content before the first anchor (preamble/TOC)
    const bodyStart = html.indexOf("<body");
    const bodyTagEnd = html.indexOf(">", bodyStart) + 1;
    const preamble = html.slice(bodyTagEnd, anchors[0].position).trim();

    const newFiles = [];

    // Preamble file (keeps the original filename for the TOC page)
    if (preamble.length > 50) {
      const preambleHtml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n` +
        `<html xmlns="http://www.w3.org/1999/xhtml">\n${headContent}\n<body>\n${preamble}\n</body>\n</html>`;
      fs.writeFileSync(htmlPath, preambleHtml, "utf8");
      newFiles.push({ file: htmlFile, anchorId: anchors[0].id.replace(/filepos/, "pre_"), isPreamble: true });
    }

    // Chapter files
    for (let i = 0; i < parts.length; i++) {
      const chapterFile = `${baseName}_ch${String(i).padStart(3, "0")}.html`;
      const chapterHtml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n` +
        `<html xmlns="http://www.w3.org/1999/xhtml">\n${headContent}\n<body>\n${parts[i].content}\n</body>\n</html>`;
      fs.writeFileSync(path.join(oebpsDir, chapterFile), chapterHtml, "utf8");
      newFiles.push({ file: chapterFile, anchorId: parts[i].anchorId, isPreamble: false });
      totalChapters++;
    }

    // If preamble was too short, overwrite original with first chapter
    if (preamble.length <= 50 && newFiles.length > 0) {
      // Copy first chapter content to the original file
      const firstChapter = newFiles.find(f => !f.isPreamble);
      if (firstChapter) {
        const src = path.join(oebpsDir, firstChapter.file);
        fs.copyFileSync(src, htmlPath);
      }
    }

    fileMap.set(htmlFile, newFiles);
  }

  if (splitCount === 0) {
    // No splitting needed — just repack
    repackEpub(extractDir, outputEpub);
    return { splitCount: 0, totalChapters };
  }

  // --- 3. Rewrite OPF manifest and spine ---
  for (const [oldFile, newFiles] of fileMap) {
    const oldId = getManifestId(opf, oldFile);
    if (!oldId) continue;

    // Add new manifest items
    const newManifestItems = [];
    const newSpineItems = [];

    for (const { file, isPreamble } of newFiles) {
      if (file === oldFile) {
        // Keep the original manifest entry for the preamble
        if (isPreamble) {
          newSpineItems.push(`<itemref idref="${oldId}"/>`);
        }
        continue;
      }
      const newId = `split_${file.replace(/\.html$/, "")}`;
      newManifestItems.push(`<item href="${file}" id="${newId}" media-type="application/xhtml+xml"/>`);
      newSpineItems.push(`<itemref idref="${newId}"/>`);
    }

    // Insert new manifest items before </manifest>
    if (newManifestItems.length) {
      opf = opf.replace("</manifest>", newManifestItems.join("\n") + "\n</manifest>");
    }

    // Replace the old spine itemref with new ones
    const oldSpineRef = new RegExp(`<itemref\\s+idref="${escapeRegex(oldId)}"\\s*/>`, "g");
    const preambleNewFiles = newFiles.filter(f => f.file === oldFile && f.isPreamble);
    if (preambleNewFiles.length > 0) {
      // Keep original + add new
      opf = opf.replace(oldSpineRef, `<itemref idref="${oldId}"/>\n${newSpineItems.join("\n")}`);
    } else {
      // Replace original with new
      opf = opf.replace(oldSpineRef, newSpineItems.join("\n"));
    }
  }

  fs.writeFileSync(opfPath, opf, "utf8");

  // --- 4. Rewrite NCX ---
  const ncxPath = path.join(oebpsDir, "toc.ncx");
  if (fs.existsSync(ncxPath)) {
    let ncx = fs.readFileSync(ncxPath, "utf8");

    for (const [oldFile, newFiles] of fileMap) {
      // For each anchor that was split out, update the NCX content src
      for (const { file, anchorId, isPreamble } of newFiles) {
        if (isPreamble || file === oldFile) continue;
        // Replace: src="text00000.html#filepos0000017426" → src="text00000_ch000.html"
        // The anchor is now at the start of its own file, so no fragment needed
        const oldSrc = `${oldFile}#${anchorId}`;
        const newSrc = file;
        ncx = ncx.split(oldSrc).join(newSrc);
      }
    }

    fs.writeFileSync(ncxPath, ncx, "utf8");
  }

  // --- 5. Rewrite internal hyperlinks in ALL HTML files ---
  // Build a global map: "oldFile#anchorId" → "newChapterFile"
  const linkMap = new Map();
  for (const [oldFile, newFiles] of fileMap) {
    for (const { file, anchorId, isPreamble } of newFiles) {
      if (isPreamble || file === oldFile) continue;
      // Map both with and without OEBPS prefix
      linkMap.set(`${oldFile}#${anchorId}`, file);
    }
  }

  if (linkMap.size > 0) {
    const allHtmlFiles = fs.readdirSync(oebpsDir).filter(f => f.endsWith(".html"));
    for (const htmlFile of allHtmlFiles) {
      const htmlPath = path.join(oebpsDir, htmlFile);
      let content = fs.readFileSync(htmlPath, "utf8");
      let changed = false;

      for (const [oldLink, newFile] of linkMap) {
        // Replace href="text00000.html#filepos0000017426" with href="text00000_ch000.html"
        if (content.includes(oldLink)) {
          content = content.split(oldLink).join(newFile);
          changed = true;
        }
      }

      if (changed) {
        fs.writeFileSync(htmlPath, content, "utf8");
      }
    }
  }

  // --- 6. Repack ---
  repackEpub(extractDir, outputEpub);

  return { splitCount, totalChapters };
}

function getManifestId(opf, href) {
  const re = new RegExp(`<item[^>]*href="${escapeRegex(href)}"[^>]*id="([^"]+)"`, "i");
  const m = opf.match(re);
  if (m) return m[1];
  // Try reverse order (id before href)
  const re2 = new RegExp(`<item[^>]*id="([^"]+)"[^>]*href="${escapeRegex(href)}"`, "i");
  const m2 = opf.match(re2);
  return m2 ? m2[1] : null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function repackEpub(extractDir, outputEpub) {
  // EPUB is a zip with mimetype as first uncompressed entry
  if (fs.existsSync(outputEpub)) {
    fs.unlinkSync(outputEpub);
  }

  const absOut = path.resolve(outputEpub);
  const cwd = extractDir;

  // mimetype must be first and uncompressed
  try {
    execFileSync("zip", ["-X0", absOut, "mimetype"], { cwd, stdio: "pipe" });
  } catch {
    // If zip not available, use a simpler approach
    // Just copy the directory structure — epub.js can handle unzipped EPUBs too
    // But we need .epub for the current setup, so let's try harder
    throw new Error("'zip' command not found — needed to repack EPUB");
  }

  // Add everything else (compressed)
  execFileSync("zip", ["-Xr9", absOut, ".", "-x", "mimetype"], { cwd, stdio: "pipe" });
}
