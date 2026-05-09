#!/usr/bin/env node
// Audits 明代大事年表-完整版.txt for two classes of issues:
//   1. Suspicious years where the per-月 distribution looks wrong:
//      - all entries marked 是年/是岁 (no real month info)
//      - >5 entries crammed into a single month (likely month-inheritance bug)
//      - no entries at all
//   2. Known OCR typos (mostly Ming-era names where the source MD mis-recognized
//      a character). For each match we report file line(s) so they can be fixed
//      in the OVERRIDES table or via a bulk replace.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(REPO_ROOT, "donotpack", "database", "明代大事年表-完整版.txt");

const lines = fs.readFileSync(SRC, "utf8").split("\n");

// ---------- 1. Per-year suspicion scan ----------
const MONTH_TOKENS = new Set([
  "正月","一月","二月","三月","四月","五月","六月","七月","八月","九月","十月","十一月","十二月",
  "闰正月","闰一月","闰二月","闰三月","闰四月","闰五月","闰六月","闰七月","闰八月","闰九月","闰十月","闰十一月","闰十二月",
  "是年","是月","是岁","是冬","是春","是夏","是秋",
]);

const yearMonthCount = new Map(); // year → Map<month, count>
const yearTotal = new Map();
const reignByYear = new Map();

for (const line of lines) {
  const m = line.match(/^公元(\d{4})年（([^）]+)）(.+?)。$/);
  if (!m) continue;
  const year = +m[1];
  reignByYear.set(year, m[2]);
  const body = m[3];
  let month = "(none)";
  for (const tok of MONTH_TOKENS) {
    if (body.startsWith(tok + "，") || body.startsWith(tok + ",")) { month = tok; break; }
  }
  yearTotal.set(year, (yearTotal.get(year) || 0) + 1);
  if (!yearMonthCount.has(year)) yearMonthCount.set(year, new Map());
  const mm = yearMonthCount.get(year);
  mm.set(month, (mm.get(month) || 0) + 1);
}

const suspicious = [];
for (const [year, total] of [...yearTotal.entries()].sort((a, b) => a[0] - b[0])) {
  const mm = yearMonthCount.get(year);
  const onlyShiNian = [...mm.keys()].every((k) => k === "是年" || k === "是岁" || k === "是月");
  const noMonth = mm.has("(none)") && mm.get("(none)") === total;
  // Find any month that swallowed 5+ entries
  let dominantMonth = null;
  let dominantCount = 0;
  for (const [k, v] of mm) {
    if (k !== "是年" && k !== "是岁" && k !== "(none)" && v >= 5 && v > dominantCount) {
      dominantMonth = k;
      dominantCount = v;
    }
  }
  // > 60% of entries in a single non-是年 month is suspicious if total >= 6
  const monthEntropy = total > 0 ? -1 * [...mm.values()].reduce((s, v) => s + (v / total) * Math.log2(v / total), 0) : 0;
  const lowEntropy = total >= 6 && monthEntropy < 1.2; // < 1.2 bits ≈ very concentrated
  if (noMonth) suspicious.push({ year, total, kind: "全无月份", detail: "" });
  else if (onlyShiNian) suspicious.push({ year, total, kind: "全是“是年/是岁/是月”", detail: "" });
  else if (dominantMonth) suspicious.push({ year, total, kind: `单月集中`, detail: `${dominantMonth}=${dominantCount}/${total}` });
  else if (lowEntropy) suspicious.push({ year, total, kind: `分布过于集中`, detail: `entropy=${monthEntropy.toFixed(2)} bits` });
}

console.log("================================================================");
console.log("【可疑年份】");
console.log("================================================================");
for (const s of suspicious) {
  console.log(`  ${s.year}（${reignByYear.get(s.year)}）— ${s.total} 条 — ${s.kind} ${s.detail}`);
}
console.log(`  合计：${suspicious.length} 年`);

// ---------- 2. Typo scan ----------
// Known OCR typos. left = wrong (as appears in MinerU output); right = correct.
// Sourced from common Ming-era proper names + repeated patterns I've seen.
const TYPO_MAP = [
  // Names that often misread
  ["朱元章", "朱元璋"],
  ["陈友諛", "陈友谅"],
  ["陈友譌", "陈友谅"],
  ["陈友諅", "陈友谅"],
  ["陈友讲", "陈友谅"],
  ["燕廷弼", "熊廷弼"],
  ["李罗帖木儿", "孛罗帖木儿"],
  ["张诚士誠", "张士诚"],
  ["張士咸", "张士诚"],
  ["张士咸", "张士诚"],
  ["朱祁弼", "朱祁钰"],
  ["朱尤奴", "朱允炆"],
  ["朱丞", "朱标"],
  ["徐送", "徐达"],
  ["戚輿光", "戚继光"],
  ["戚継光", "戚继光"],
  ["俞大酉", "俞大猷"],
  ["俞大歐", "俞大猷"],
  ["俞大嶽", "俞大猷"],
  ["俞大歐", "俞大猷"],
  ["朱轨", "朱纨"],
  ["朱軾", "朱纨"],
  ["罗敛順", "罗钦顺"],
  ["罗欽順", "罗钦顺"],
  ["罗敛顺", "罗钦顺"],
  ["楊廷和", "杨廷和"],
  ["楊鎮", "杨镐"],
  ["楊嗣昌", "杨嗣昌"],
  ["徐光啟", "徐光启"],
  ["李懿", "李贽"],
  ["李成桂", "李成桂"],
  ["朱載曼", "朱载垕"],
  ["朱由檢", "朱由检"],
  ["朱由校", "朱由校"],
  ["朱常洛", "朱常洛"],
  ["朱常淘", "朱常洵"],
  ["朱翊钧", "朱翊钧"],
  ["朱厚熜", "朱厚熜"],
  ["朱厚照", "朱厚照"],
  ["朱见深", "朱见深"],
  ["朱見深", "朱见深"],
  ["袁崇焕", "袁崇焕"],
  ["熊廷弼", "熊廷弼"],
  ["孫傳庭", "孙传庭"],
  ["朱燮元", "朱燮元"],
  ["奢崇明", "奢崇明"],
  ["安邦彥", "安邦彦"],
  ["李思齐", "李思齐"],
  ["王嘉胤", "王嘉胤"],
  ["王自用", "王自用"],
  ["王左挂", "王左挂"],
  ["高迎祥", "高迎祥"],
  ["高迎群", "高迎祥"],
  ["李自成", "李自成"],
  ["张献忠", "张献忠"],
  ["張献忠", "张献忠"],
  ["何应钦", "何应钦"],
  ["毛皇孩", "毛里孩"],
  ["毛龙孩", "毛里孩"],
  ["明王珍", "明玉珍"],
  ["明貰古思帖木儿", "脱古思帖木儿"],
  ["元貰古思帖木儿", "脱古思帖木儿"],
  ["顾宪成", "顾宪成"],
  ["申时行", "申时行"],
  ["徐霞客", "徐霞客"],
  ["黃宗羲", "黄宗羲"],
  ["顾炎武", "顾炎武"],
  ["史可法", "史可法"],
  ["馬士英", "马士英"],
  ["朱由崧", "朱由崧"],
  ["丁僧年", "丁鹤年"],
  ["丁僧鶴", "丁鹤年"],
  ["柯九思", "柯九思"],

  // Place names
  ["望海場", "望海堝"],
  ["吊梁洪", "吕梁洪"],
  ["奔牛", "奔牛"],
  ["澶州", "濠州"], // common 元末 misread for 濠州 (朱元璋家乡)
  // ↑ careful: 澶州 IS a real place (河南濮阳); but in 元末 context "起义于澶州" usually means 濠州
  ["阜城", "阜城"],

  // Tribal / dynasty
  ["韃靼", "鞑靼"],
  ["鐵兵", "鞑兵"],
  ["瓦刺", "瓦剌"],
  ["元拔都", "元拔都"],
  ["蒙古察哈尔", "蒙古察哈尔"],
  ["女真", "女真"],
  ["满洲", "满洲"],
  ["後金", "后金"],

  // Office / institution
  ["錦衣衛", "锦衣卫"],
  ["内閣", "内阁"],
  ["内閥", "内阁"],
  ["内闕", "内阁"],
  ["官官", "宦官"],   // very common — 宦 OCR'd as 官
  ["宫官", "宦官"],
  ["閤", "阁"],
  ["宝鈎", "宝钞"],
  ["宝鈔", "宝钞"],
  ["大都督府", "大都督府"],
  ["五軍都督府", "五军都督府"],
  ["布政使", "布政使"],
  ["按察使", "按察使"],
  ["都督府", "都督府"],
  ["六科給事中", "六科给事中"],

  // Common verb / character errors
  ["除帝", "称帝"],
  ["即帝", "即帝"],
  ["雯韬", "雯韬"],   // (don't have a fix)
  ["庸誅", "诛"],
  ["藁年", "次年"],
  ["輞", "鞑"],   // when context is dynasty
  ["剛", "鞑"],   // similar
  ["朝鮮", "朝鲜"],
  ["浙江", "浙江"],
  ["畿内", "畿内"],
  ["敕咸", "敕戚"],
  ["勅咸", "勋戚"],
  ["勅戚", "勋戚"],
  ["勘戚", "勋戚"],
  ["勋戚", "勋戚"],

  // Specific bad strings observed
  ["明帝自稱", "明帝自缢"],
  ["明帝自称", "明帝自缢"],   // 明 emperor self-缢 (1644 崇祯)
  ["雍发", "薙发"],
  ["雍髪", "薙发"],
  ["遙罗", "暹罗"],
  ["錢譴益", "钱谦益"],
  ["錢譟益", "钱谦益"],
  ["錢諫益", "钱谦益"],
  ["禁白蓮、天為諸教", "禁白莲、天主诸教"],
  ["禁白莲、天为诸教", "禁白莲、天主诸教"],
  ["合潤", "台湾"],   // 1621 荷兰侵入
  ["浙东等地", "浙东等地"],
  ["黑水峪之战", "黑水峪之战"],
  ["慈胤之战", "黑水峪之战"],
  ["慈胤", "黑水峪"],
  ["閥", "阁"],
  ["閥職", "阁职"],
  ["閣職斬崇", "阁职渐崇"],
];

// Dedupe entries that are identity (left == right) — those are no-ops.
const TYPOS = TYPO_MAP.filter(([l, r]) => l !== r);

console.log();
console.log("================================================================");
console.log("【可能的错别字命中】（左 = 文中实际出现，右 = 建议改成）");
console.log("================================================================");

const hitMap = new Map(); // typo → { count, lineNumbers: [] }
for (let i = 0; i < lines.length; i++) {
  for (const [bad, good] of TYPOS) {
    if (lines[i].includes(bad)) {
      const key = `${bad}→${good}`;
      if (!hitMap.has(key)) hitMap.set(key, { bad, good, count: 0, sample: "" });
      const h = hitMap.get(key);
      h.count++;
      if (!h.sample) h.sample = lines[i].slice(0, 80);
    }
  }
}

const hits = [...hitMap.values()].sort((a, b) => b.count - a.count);
for (const h of hits) {
  console.log(`  ${h.bad} → ${h.good} (×${h.count})`);
  console.log(`      e.g. ${h.sample}`);
}
console.log(`  合计：${hits.length} 种错别字`);
