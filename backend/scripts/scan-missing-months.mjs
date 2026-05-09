#!/usr/bin/env node
// Scans the generated 明代大事年表-完整版.txt and reports years where most/all
// events lack a month prefix (i.e. went straight to the description without a
// 月份， marker). These are the years where the OCR lost the per-月 sub-row
// structure and the user may want to hand-transcribe replacements.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(REPO_ROOT, "donotpack", "database", "明代大事年表-完整版.txt");

const MONTH_TOKENS = [
  "正月","一月","二月","三月","四月","五月","六月","七月","八月","九月","十月","十一月","十二月",
  "闰正月","闰一月","闰二月","闰三月","闰四月","闰五月","闰六月","闰七月","闰八月","闰九月","闰十月","闰十一月","闰十二月",
  "是年","是月","是岁","是冬","是春","是夏","是秋",
];

const byYear = new Map();
const reignByYear = new Map();
const lines = fs.readFileSync(SRC, "utf8").split("\n");
for (const line of lines) {
  const m = line.match(/^公元(\d{4})年（([^）]+)）(.+?)。$/);
  if (!m) continue;
  const year = +m[1];
  const reign = m[2];
  const body = m[3];
  reignByYear.set(year, reign);
  if (!byYear.has(year)) byYear.set(year, { total: 0, withMonth: 0, withShiNian: 0 });
  const stat = byYear.get(year);
  stat.total++;
  // body starts with "<month>，..." if month present
  let hasMonth = false;
  let isShiNian = false;
  for (const tok of MONTH_TOKENS) {
    if (body.startsWith(tok + "，") || body.startsWith(tok + ",")) {
      hasMonth = true;
      if (tok.startsWith("是")) isShiNian = true;
      break;
    }
  }
  if (hasMonth) stat.withMonth++;
  if (isShiNian) stat.withShiNian++;
}

// Categories:
//   A) zero month markers at all → fully lost
//   B) only 是年/是岁/是月 markers → also basically lost (no real month splits)
//   C) some real-month + some 是年 → partial
const groupA = [];
const groupB = [];
const groupC = [];

for (const [year, s] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
  if (s.withMonth === 0 && s.total > 0) {
    groupA.push({ year, ...s });
  } else if (s.withMonth === s.withShiNian && s.withShiNian > 0 && s.total - s.withShiNian > 0) {
    // Only 是年/是岁 prefixes, but other lines have NO prefix at all
    groupB.push({ year, ...s });
  } else if (s.withMonth < s.total && s.total - s.withMonth >= 2) {
    groupC.push({ year, ...s });
  }
}

const fmt = (arr) =>
  arr
    .map((x) => `  ${x.year}（${reignByYear.get(x.year)}）— total ${x.total}, 有月份 ${x.withMonth}（其中是年/是岁 ${x.withShiNian}）`)
    .join("\n");

console.log("================================================================");
console.log("A) 完全没有月份标记的年份（最严重，建议优先人工补）：");
console.log(fmt(groupA) || "  （无）");
console.log();
console.log("B) 只有“是年/是岁”能匹配，其他事件都裸描述无月份：");
console.log(fmt(groupB) || "  （无）");
console.log();
console.log("C) 有部分月份标记但仍有≥2 行无月份的年份（次严重）：");
console.log(fmt(groupC) || "  （无）");
console.log();
console.log(`合计：A组 ${groupA.length} 年，B组 ${groupB.length} 年，C组 ${groupC.length} 年`);
