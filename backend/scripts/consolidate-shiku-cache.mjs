/**
 * Consolidate the 64 raw HTML files in shiku-shu-ctext-cache into a single
 * clean TXT (one volume per section, paragraphs separated by blank lines),
 * so the cache directory can be replaced with one tidy file.
 *
 * Usage:
 *   node backend/scripts/consolidate-shiku-cache.mjs
 *
 * Outputs:
 *   donotpack/database/shiku-shu-ctext.txt
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseHtml } from "node-html-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const cacheDir = path.join(REPO_ROOT, "donotpack", "database", "shiku-shu-ctext-cache");
const progressPath = path.join(cacheDir, "progress.json");
const outPath = path.join(REPO_ROOT, "donotpack", "database", "shiku-shu-ctext.txt");

function normalizeText(t) {
  return String(t || "").replace(/\r/g, "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function extractAllText(node) {
  node.querySelectorAll("script, style, #menubar, #menu, .menuitem, #search, .noprint, .urnlabel, #footer, .wikibox, .restable").forEach((el) => el.remove());
  node.querySelectorAll(".note, .footnote").forEach((el) => el.remove());
  const out = [];
  const seen = new Set();
  const cells = [
    ...node.querySelectorAll("td.ctext"),
    ...node.querySelectorAll("p"),
    ...node.querySelectorAll("div.ctext"),
  ];
  for (const c of cells) {
    const t = normalizeText(c.textContent);
    if (!t || t.length < 4) continue;
    if (/^[\d\s\.\-、]+$/.test(t)) continue;
    if (/(下一卷|上一卷|目录|查看正文|修改|查看历史)/.test(t) && t.length < 30) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function extractVolumes(html) {
  const root = parseHtml(html);
  const rawHtml = root.toString();
  const anchorPattern = /<(?:a|span|h2)\s+(?:name|id)="([^"]*卷[^"]*)"[^>]*>/g;
  const splits = [];
  let m;
  while ((m = anchorPattern.exec(rawHtml))) splits.push({ name: m[1], offset: m.index });
  splits.push({ name: null, offset: rawHtml.length });
  if (splits.length === 1) {
    const title = root.querySelector("title")?.textContent?.trim() || "未知卷";
    return [{ volumeTitle: title, paragraphs: extractAllText(root) }];
  }
  const volumes = [];
  for (let i = 0; i < splits.length - 1; i++) {
    const a = splits[i];
    const b = splits[i + 1];
    if (!a.name) continue;
    const fragment = parseHtml(rawHtml.slice(a.offset, b.offset));
    const paragraphs = extractAllText(fragment);
    if (paragraphs.length) volumes.push({ volumeTitle: a.name, paragraphs });
  }
  return volumes;
}

const state = JSON.parse(fs.readFileSync(progressPath, "utf8"));
const chapters = Object.entries(state.chapters)
  .filter(([, info]) => info.status === "ok" && info.htmlFile)
  .map(([id, info]) => ({ id, ...info }));

const allVolumes = [];
for (const ch of chapters) {
  const html = fs.readFileSync(path.join(cacheDir, ch.htmlFile), "utf8");
  const volumes = extractVolumes(html);
  for (const v of volumes) allVolumes.push({ chapterId: ch.id, ...v });
}

// Sort by 卷号 numerically when possible (extract from "石匮书·卷第N")
const numerals = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function chineseNum(s) {
  // Greedy: handle "二百三十一" etc.
  let total = 0, section = 0;
  for (const ch of s) {
    if (ch === "百") { section = (section || 1) * 100; total += section; section = 0; continue; }
    if (ch === "十") { section = (section || 1) * 10; total += section; section = 0; continue; }
    const d = numerals[ch];
    if (d != null) section = section * 10 + d;
  }
  return total + section;
}
function volumeOrder(title) {
  const m = title.match(/卷第([一二三四五六七八九十百]+)/);
  return m ? chineseNum(m[1]) : 99999;
}
allVolumes.sort((a, b) => volumeOrder(a.volumeTitle) - volumeOrder(b.volumeTitle));

const lines = [
  "石匮书 — 张岱 撰",
  "（采自中国哲学书电子化计划 ctext.org）",
  `共 ${allVolumes.length} 卷 / ${allVolumes.reduce((n, v) => n + v.paragraphs.length, 0)} 段`,
  "",
];
for (const v of allVolumes) {
  lines.push(`========== ${v.volumeTitle} ==========`);
  lines.push("");
  for (const p of v.paragraphs) lines.push(p);
  lines.push("");
}

fs.writeFileSync(outPath, lines.join("\n"));
console.log(`wrote ${outPath}`);
console.log(`  ${allVolumes.length} volumes, ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
