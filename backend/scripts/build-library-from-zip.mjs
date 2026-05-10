#!/usr/bin/env node
/**
 * 一键导库：从一个压缩包构建完整的 25 部明代史籍数据库。
 *
 * 用法：
 *   node backend/scripts/build-library-from-zip.mjs --zip path/to/books.zip
 *
 * 工作流程：
 *   1. 解压 zip 到临时目录
 *   2. 读取 backend/src/data/source-manifest.json 拿到全部 25 部书的 slug + 标题
 *   3. 匹配 zip 里每个文件到对应的 slug，匹配规则按优先级：
 *        a. 文件名完全等于 slug.epub / slug.txt（如 ming-shi.epub）
 *        b. 文件名包含书的标题（如「明史 (张廷玉).epub」匹配 ming-shi）
 *        c. EPUB 内 OPF 元数据 title 匹配
 *      未匹配上的文件作为「自定义书」入库（自动生成 slug）
 *   4. 按 EPUB / TXT 解析，写入 books + paragraphs 表
 *   5. 打印导入摘要 + 缺漏的 slug 清单
 *
 * 选项：
 *   --zip <path>   压缩包（必填，.zip / .tar.gz / .tgz）
 *   --clean        导入前先清空 books 表（默认 append / replace 已有 slug）
 *   --chapter-regex <regex>   TXT 章节切分正则（默认匹配「卷一/第一卷/卷1」）
 *
 * 完成后启动软件即可，前端 / API 都不需要改。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import unzipper from "unzipper";
import { parse as parseHtml } from "node-html-parser";
import { XMLParser } from "fast-xml-parser";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DB_PATH = path.join(REPO_ROOT, "backend", ".cache", "library.sqlite");
const MANIFEST_PATH = path.join(REPO_ROOT, "backend", "src", "data", "source-manifest.json");

// ---------- args ----------
function readArg(flag, fallback = "") {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : (process.argv[i + 1] || fallback);
}
function hasFlag(flag) { return process.argv.includes(flag); }

const ZIP = readArg("--zip");
const CLEAN = hasFlag("--clean");
const CHAPTER_REGEX = readArg("--chapter-regex", "^(卷[一二三四五六七八九十百千〇零\\d]+|第[一二三四五六七八九十百千〇零\\d]+[卷回篇])");

if (!ZIP) {
  console.error("用法: node backend/scripts/build-library-from-zip.mjs --zip path/to/books.zip [--clean]");
  process.exit(1);
}
if (!fs.existsSync(ZIP)) {
  console.error(`找不到文件: ${ZIP}`);
  process.exit(1);
}

// ---------- helpers ----------
function hashText(t) { return crypto.createHash("sha1").update(t).digest("hex"); }
function normalizeText(t) {
  return String(t || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/ /g, " ").trim();
}
function chunkParagraphs(rawText) {
  return normalizeText(rawText).split(/\n+/).map(s => s.trim()).filter(s => s.length >= 8);
}
function arrayify(v) { return v ? (Array.isArray(v) ? v : [v]) : []; }

// 把书名里的版本/译注/出版社等噪音剥离，便于匹配
function cleanTitle(s) {
  return String(s || "")
    .replace(/\(z-?library[^)]*\)/gi, "")
    .replace(/\(1lib[^)]*\)/gi, "")
    .replace(/\(z-lib[^)]*\)/gi, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/（[^）]*）/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/【[^】]*】/g, "")
    .replace(/[，,。.\-_\s]+/g, "")
    .trim();
}

// ---------- 加载 manifest ----------
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
console.log(`[manifest] ${manifest.length} 部书已注册`);

// ---------- 解压 zip ----------
async function extractToTemp(zipPath) {
  const tmp = path.join(os.tmpdir(), `mingshi-import-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  console.log(`[1/5] 解压 ${zipPath} → ${tmp}`);
  if (zipPath.endsWith(".zip")) {
    const dir = await unzipper.Open.file(zipPath);
    for (const f of dir.files) {
      if (f.type !== "File") continue;
      const out = path.join(tmp, f.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await new Promise((res, rej) => {
        f.stream().pipe(fs.createWriteStream(out)).on("finish", res).on("error", rej);
      });
    }
  } else if (/\.(tar\.gz|tgz)$/i.test(zipPath)) {
    execSync(`tar -xzf "${zipPath}" -C "${tmp}"`);
  } else {
    throw new Error("仅支持 .zip / .tar.gz / .tgz");
  }
  return tmp;
}

function listSourceFiles(dir) {
  const out = [];
  function walk(d) {
    for (const name of fs.readdirSync(d)) {
      if (name.startsWith(".") || name === "__MACOSX") continue;
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(epub|txt)$/i.test(name)) out.push(full);
    }
  }
  walk(dir);
  return out;
}

// ---------- EPUB ----------
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

function stripHtml(html) {
  const root = parseHtml(html);
  root.querySelectorAll("style, script, noscript").forEach(el => el.remove());
  const title = root.querySelector("h1, h2, h3, h4")?.textContent?.trim() || "";
  const body = root.querySelector("body") || root;
  const blocks = body.querySelectorAll("p, div, h1, h2, h3, h4, h5, h6, li, dt, dd, blockquote, pre");
  const parts = [];
  for (const node of blocks) {
    const text = normalizeText(node.textContent || "");
    if (text) parts.push(text);
  }
  return { title, text: parts.length ? parts.join("\n") : normalizeText(body.textContent || "") };
}

function normalizeHref(baseDir, href) {
  return path.posix.normalize(path.posix.join(baseDir, href.split("#")[0]));
}

async function extractEpub(epubPath) {
  const tmp = path.join(os.tmpdir(), `epub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmp, { recursive: true });
  const dir = await unzipper.Open.file(epubPath);
  for (const f of dir.files) {
    if (f.type !== "File") continue;
    const out = path.join(tmp, f.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await new Promise((res, rej) => f.stream().pipe(fs.createWriteStream(out)).on("finish", res).on("error", rej));
  }
  return tmp;
}

function getEpubMetadata(epubDir) {
  const containerXml = fs.readFileSync(path.join(epubDir, "META-INF", "container.xml"), "utf8");
  const container = xmlParser.parse(containerXml);
  const opfPath = container?.container?.rootfiles?.rootfile?.["@_full-path"] || "OEBPS/content.opf";
  const opf = xmlParser.parse(fs.readFileSync(path.join(epubDir, opfPath), "utf8"));
  const meta = opf?.package?.metadata || {};
  const title = arrayify(meta["dc:title"]).map(t => typeof t === "string" ? t : t["#text"] || "").filter(Boolean).join(" / ") || "";
  const author = arrayify(meta["dc:creator"]).map(t => typeof t === "string" ? t : t["#text"] || "").filter(Boolean).join("、") || "";
  return { opf, opfPath, title, author };
}

function parseEpubChapters(epubDir, opf, opfPath) {
  const opfDir = path.posix.dirname(opfPath);
  const manifestItems = arrayify(opf?.package?.manifest?.item);
  const manifestMap = new Map(manifestItems.map(i => [i["@_id"], i]));
  const spineItems = arrayify(opf?.package?.spine?.itemref);

  const chapters = [];
  let order = 0;
  for (const itemref of spineItems) {
    const m = manifestMap.get(itemref["@_idref"]);
    if (!m) continue;
    if (!/html|xhtml/i.test(m["@_media-type"] || "")) continue;
    const chapterHref = normalizeHref(opfDir, m["@_href"]);
    const full = path.join(epubDir, chapterHref);
    if (!fs.existsSync(full)) continue;
    const { title, text } = stripHtml(fs.readFileSync(full, "utf8"));
    if (!text) continue;
    chapters.push({ chapter: title || `第 ${order + 1} 章`, anchor: chapterHref, text, chapterOrder: order });
    order++;
  }
  return chapters;
}

// ---------- TXT ----------
function readTextFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buf.slice(3));
  }
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const repl = (utf8.match(/�/g) || []).length;
  if (repl > 30 || repl / Math.max(1, utf8.length) > 0.005) {
    try { return new TextDecoder("gb18030", { fatal: false }).decode(buf); } catch {
      try { return new TextDecoder("gbk", { fatal: false }).decode(buf); } catch { return utf8; }
    }
  }
  return utf8;
}

function parseTxtChapters(txtPath, defaultTitle) {
  const raw = readTextFile(txtPath);
  const chapterPattern = new RegExp(CHAPTER_REGEX);
  const lines = normalizeText(raw).split(/\n+/).map(l => l.trim()).filter(Boolean);
  const chapters = [];
  let currentTitle = defaultTitle;
  let currentLines = [];
  const flush = () => {
    const text = normalizeText(currentLines.join("\n"));
    if (text) chapters.push({ chapter: currentTitle, text, anchor: `local://${path.basename(txtPath)}`, chapterOrder: chapters.length });
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
  return chapters;
}

// ---------- 匹配文件 → manifest slug ----------
async function matchFileToSlug(filePath, manifest, alreadyMatched) {
  const baseName = path.basename(filePath).replace(/\.(epub|txt)$/i, "");
  const cleanedFileName = cleanTitle(baseName);

  // a. 文件名是 slug 本身
  for (const m of manifest) {
    if (alreadyMatched.has(m.slug)) continue;
    if (baseName === m.slug || baseName.toLowerCase() === m.slug.toLowerCase()) {
      return m;
    }
  }

  // b. 文件名包含书的中文标题
  for (const m of manifest) {
    if (alreadyMatched.has(m.slug)) continue;
    const cleanedTitle = cleanTitle(m.title);
    if (cleanedTitle && (cleanedFileName.includes(cleanedTitle) || baseName.includes(m.title))) {
      return m;
    }
  }

  // c. EPUB 元数据 title 匹配
  if (/\.epub$/i.test(filePath)) {
    try {
      const epubDir = await extractEpub(filePath);
      const meta = getEpubMetadata(epubDir);
      const cleanedMeta = cleanTitle(meta.title);
      try { execSync(`rm -rf "${epubDir}"`); } catch {}
      for (const m of manifest) {
        if (alreadyMatched.has(m.slug)) continue;
        const cleanedTitle = cleanTitle(m.title);
        if (cleanedTitle && cleanedMeta && cleanedMeta.includes(cleanedTitle)) {
          return m;
        }
      }
    } catch {}
  }

  return null;
}

// ---------- DB ----------
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      dynasty TEXT,
      category TEXT,
      source_type TEXT,
      source_url TEXT,
      description TEXT,
      chapter_count INTEGER DEFAULT 0,
      paragraph_count INTEGER DEFAULT 0,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS paragraphs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter TEXT,
      chapter_order INTEGER,
      anchor TEXT,
      paragraph_hash TEXT,
      content TEXT NOT NULL,
      UNIQUE(book_id, paragraph_hash)
    );
  `);
}

function upsertBook(db, meta) {
  const exists = db.prepare("SELECT id FROM books WHERE slug = ?").get(meta.slug);
  if (exists) {
    db.prepare("UPDATE books SET title=?, author=?, dynasty=?, category=?, source_type=?, source_url=?, description=? WHERE slug=?")
      .run(meta.title, meta.author || "", meta.dynasty || "明", meta.category || "reference", meta.sourceType || "user-import", meta.sourceUrl || "", meta.description || "", meta.slug);
    return exists.id;
  }
  const r = db.prepare("INSERT INTO books (slug, title, author, dynasty, category, source_type, source_url, description) VALUES (?,?,?,?,?,?,?,?)")
    .run(meta.slug, meta.title, meta.author || "", meta.dynasty || "明", meta.category || "reference", meta.sourceType || "user-import", meta.sourceUrl || "", meta.description || "");
  return r.lastInsertRowid;
}

function replaceParagraphs(db, bookId, slug, chapters) {
  const remove = db.prepare("DELETE FROM paragraphs WHERE book_id = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO paragraphs (book_id, chapter, chapter_order, anchor, paragraph_hash, content) VALUES (?,?,?,?,?,?)");
  const tx = db.transaction(() => {
    remove.run(bookId);
    for (const ch of chapters) {
      const paras = chunkParagraphs(ch.text);
      for (const p of paras) {
        const h = hashText(`${slug}\n${ch.chapter}\n${ch.anchor}\n${p}`);
        insert.run(bookId, ch.chapter, ch.chapterOrder, ch.anchor || "", h, p);
      }
    }
    const stats = db.prepare("SELECT COUNT(*) AS pc, COUNT(DISTINCT chapter) AS cc FROM paragraphs WHERE book_id = ?").get(bookId);
    db.prepare("UPDATE books SET paragraph_count=?, chapter_count=?, imported_at=CURRENT_TIMESTAMP WHERE id=?").run(stats.pc, stats.cc, bookId);
  });
  tx();
}

// ---------- 主流程 ----------
async function main() {
  const tmp = await extractToTemp(ZIP);
  const files = listSourceFiles(tmp);
  console.log(`[2/5] 找到 ${files.length} 个候选文件 (.epub / .txt)`);
  if (!files.length) {
    console.error("压缩包里没有 .epub 或 .txt 文件");
    process.exit(1);
  }

  if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);

  if (CLEAN) {
    const r = db.prepare("DELETE FROM books").run();
    console.log(`[clean] 删除 ${r.changes} 本旧书`);
  }

  console.log(`[3/5] 匹配文件 → manifest slug`);
  const matched = new Map(); // slug → file
  const matchedSlugs = new Set();
  const unmatched = [];
  for (const file of files) {
    const m = await matchFileToSlug(file, manifest, matchedSlugs);
    if (m) {
      matched.set(m.slug, { file, manifest: m });
      matchedSlugs.add(m.slug);
      console.log(`  ✓ ${m.slug.padEnd(28)} ← ${path.basename(file)}`);
    } else {
      unmatched.push(file);
      console.log(`  ? ${"<unknown>".padEnd(28)} ← ${path.basename(file)}（按自定义书入库）`);
    }
  }

  console.log(`[4/5] 解析并入库`);
  const summary = [];
  for (const { file, manifest: m } of matched.values()) {
    try {
      const isEpub = /\.epub$/i.test(file);
      let chapters;
      let detectedTitle = m.title;
      let detectedAuthor = m.author || "";
      if (isEpub) {
        const epubDir = await extractEpub(file);
        const meta = getEpubMetadata(epubDir);
        chapters = parseEpubChapters(epubDir, meta.opf, meta.opfPath);
        if (meta.title) detectedTitle = m.title; // 仍用 manifest 的中文标题
        if (meta.author) detectedAuthor = m.author || meta.author;
        try { execSync(`rm -rf "${epubDir}"`); } catch {}
      } else {
        chapters = parseTxtChapters(file, m.title);
      }
      const bookId = upsertBook(db, {
        slug: m.slug,
        title: detectedTitle,
        author: detectedAuthor,
        dynasty: m.dynasty || "明",
        category: m.category || "reference",
        sourceType: m.sourceType || "user-import",
        sourceUrl: m.sourceUrl || `file://${path.basename(file)}`,
        description: m.description || `用户导入：${path.basename(file)}`,
      });
      replaceParagraphs(db, bookId, m.slug, chapters);
      const final = db.prepare("SELECT chapter_count, paragraph_count FROM books WHERE id=?").get(bookId);
      summary.push({ slug: m.slug, title: detectedTitle, file: path.basename(file), chapters: final.chapter_count, paragraphs: final.paragraph_count });
      console.log(`  ✓ ${m.slug.padEnd(28)} ${String(final.chapter_count).padStart(4)} 章 / ${String(final.paragraph_count).padStart(6)} 段`);
    } catch (e) {
      console.error(`  ✗ ${m.slug}: ${e.message}`);
    }
  }

  // 处理 unmatched 文件作为自定义书
  for (const file of unmatched) {
    try {
      const baseName = path.basename(file).replace(/\.(epub|txt)$/i, "");
      const cleanedName = cleanTitle(baseName) || baseName;
      const slug = `user-${hashText(file).slice(0, 10)}`;
      const isEpub = /\.epub$/i.test(file);
      let chapters, title = cleanedName, author = "";
      if (isEpub) {
        const epubDir = await extractEpub(file);
        const meta = getEpubMetadata(epubDir);
        if (meta.title) title = meta.title;
        if (meta.author) author = meta.author;
        chapters = parseEpubChapters(epubDir, meta.opf, meta.opfPath);
        try { execSync(`rm -rf "${epubDir}"`); } catch {}
      } else {
        chapters = parseTxtChapters(file, cleanedName);
      }
      const bookId = upsertBook(db, {
        slug, title, author,
        sourceType: isEpub ? "user-epub" : "user-text",
        sourceUrl: `file://${path.basename(file)}`,
        description: `用户导入（未匹配 manifest）：${path.basename(file)}`,
      });
      replaceParagraphs(db, bookId, slug, chapters);
      const final = db.prepare("SELECT chapter_count, paragraph_count FROM books WHERE id=?").get(bookId);
      summary.push({ slug, title, file: path.basename(file), chapters: final.chapter_count, paragraphs: final.paragraph_count });
      console.log(`  ✓ ${slug.padEnd(28)} ${String(final.chapter_count).padStart(4)} 章 / ${String(final.paragraph_count).padStart(6)} 段`);
    } catch (e) {
      console.error(`  ✗ ${path.basename(file)}: ${e.message}`);
    }
  }

  console.log(`\n[5/5] 完成。`);
  console.log(`匹配 manifest 入库 ${matched.size} 部，自定义入库 ${unmatched.length} 部，合计 ${summary.length} 部书。`);

  // 缺漏：manifest 里有但 zip 里没找到的 slug
  const missing = manifest.filter(m => !matchedSlugs.has(m.slug));
  if (missing.length) {
    console.log(`\n以下 ${missing.length} 部书 manifest 里有声明但本次未匹配到文件（DB 里维持旧状态，未提供则无内容）：`);
    for (const m of missing) console.log(`  - ${m.slug.padEnd(28)} ${m.title}`);
  }

  console.log(`\nDB: ${DB_PATH}`);
  console.log("启动软件即可查看新书。");
  try { execSync(`rm -rf "${tmp}"`); } catch {}
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
