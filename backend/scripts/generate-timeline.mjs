#!/usr/bin/env node
// Generates 明代大事年表-完整版.txt from the OVERRIDES table in
// parse-mineru-chronology.mjs alone. The OVERRIDES table is the
// hand-verified ground truth (transcribed from the original PDF page-by-page),
// so this output drops everything else: no MinerU markdown parsing, no
// "原书分见" synopsis lines, no stuck-month neutralization, no fallback events
// from the broken OCR.
//
// Output: donotpack/database/明代大事年表-完整版.txt

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// We re-export OVERRIDES + reignInfo + cnYear from the existing parser via
// dynamic import so we don't duplicate the (huge) data tables.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO_ROOT, "donotpack", "database", "明代大事年表-完整版.txt");
const PARSER_PATH = path.join(__dirname, "parse-mineru-chronology.mjs");

// Read parser file as text and extract the OVERRIDES literal. We don't run
// the parser; we just need its OVERRIDES, reignInfo, cnYear, TYPO_FIXES.
// Easiest: import the whole module and reach in via globalThis exports.
// The parser as written doesn't export anything, so we duplicate the small
// helpers inline and read OVERRIDES via eval-of-extracted-source.

// ---- Reign mapping (mirrors parse-mineru-chronology.mjs) ----
const MING_REIGNS = [
  { reign: "洪武", from: 1368, to: 1398 },
  { reign: "建文", from: 1399, to: 1402 },
  { reign: "永乐", from: 1403, to: 1424 },
  { reign: "洪熙", from: 1425, to: 1425 },
  { reign: "宣德", from: 1426, to: 1435 },
  { reign: "正统", from: 1436, to: 1449 },
  { reign: "景泰", from: 1450, to: 1456 },
  { reign: "天顺", from: 1457, to: 1464 },
  { reign: "成化", from: 1465, to: 1487 },
  { reign: "弘治", from: 1488, to: 1505 },
  { reign: "正德", from: 1506, to: 1521 },
  { reign: "嘉靖", from: 1522, to: 1566 },
  { reign: "隆庆", from: 1567, to: 1572 },
  { reign: "万历", from: 1573, to: 1620 },
  { reign: "泰昌", from: 1620, to: 1620 },
  { reign: "天启", from: 1621, to: 1627 },
  { reign: "崇祯", from: 1628, to: 1644 },
];
const SOUTHERN_MING = [
  { reign: "弘光", from: 1644, to: 1645 },
  { reign: "隆武", from: 1645, to: 1646 },
  { reign: "永历", from: 1647, to: 1662 },
];

const CN_DIGIT = ["零","一","二","三","四","五","六","七","八","九","十"];
function cnYear(n) {
  if (n === 1) return "元";
  if (n <= 10) return CN_DIGIT[n];
  if (n < 20) return "十" + CN_DIGIT[n - 10];
  if (n === 20) return "二十";
  if (n < 30) return "二十" + CN_DIGIT[n - 20];
  if (n === 30) return "三十";
  if (n < 40) return "三十" + CN_DIGIT[n - 30];
  if (n === 40) return "四十";
  if (n < 50) return "四十" + CN_DIGIT[n - 40];
  return String(n);
}

function reignInfo(year) {
  if (year < 1368) {
    return { reign: "元末", reignYear: year - 1340, reignYearText: cnYear(year - 1340) };
  }
  for (const r of MING_REIGNS) {
    if (year >= r.from && year <= r.to) {
      return { reign: r.reign, reignYearText: cnYear(year - r.from + 1) };
    }
  }
  for (const r of SOUTHERN_MING) {
    if (year >= r.from && year <= r.to) {
      return { reign: r.reign, reignYearText: cnYear(year - r.from + 1) };
    }
  }
  return { reign: "清初", reignYearText: cnYear(year - 1643) };
}

// ---- Extract OVERRIDES from the parser file ----
const parserSource = fs.readFileSync(PARSER_PATH, "utf8");
const overridesMatch = parserSource.match(/const OVERRIDES = (\{[\s\S]*?\n\});/);
if (!overridesMatch) {
  console.error("Could not find OVERRIDES literal in parser source.");
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const OVERRIDES = new Function(`return (${overridesMatch[1]})`)();

// ---- Extract TYPO_FIXES ----
const typoMatch = parserSource.match(/const TYPO_FIXES = (\[[\s\S]*?\n\]);/);
const TYPO_FIXES = typoMatch ? new Function(`return (${typoMatch[1]})`)() : [];
const TYPO_PAIRS = TYPO_FIXES.filter(([a, b]) => a !== b);
function applyTypoFixes(s) {
  let out = s;
  for (const [bad, good] of TYPO_PAIRS) {
    if (out.includes(bad)) out = out.split(bad).join(good);
  }
  return out;
}

// ---- Generate ----
function splitSentences(text) {
  return text.split(/。+/).map((s) => s.trim()).filter(Boolean);
}

const out = [];
out.push("# 明代大事年表 — 完整人工校订版");
out.push("# 来源: OCR/大事年表.pdf 全部 56 页人工转录 + OVERRIDES 表");
out.push("# 格式: 公元YYYY年（<年号><N>年）<月份>，<事件>。");
out.push("");

const years = Object.keys(OVERRIDES).map(Number).sort((a, b) => a - b);
let totalEvents = 0;
for (const year of years) {
  const info = reignInfo(year);
  for (const [month, text] of OVERRIDES[year]) {
    for (const sent of splitSentences(text)) {
      if (sent.length < 2) continue;
      const desc = month ? `${month}，${sent}` : sent;
      const line = `公元${year}年（${info.reign}${info.reignYearText}年）${desc}。`;
      out.push(applyTypoFixes(line));
      totalEvents++;
    }
  }
  out.push("");
}

fs.writeFileSync(OUT, out.join("\n"), "utf8");
console.log(`✓ Wrote ${OUT}`);
console.log(`  years covered: ${years.length}`);
console.log(`  events emitted: ${totalEvents}`);
console.log(`  year range: ${years[0]}–${years[years.length - 1]}`);
