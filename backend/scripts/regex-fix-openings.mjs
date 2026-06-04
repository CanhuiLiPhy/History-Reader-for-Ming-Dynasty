/**
 * Apply pattern-based punctuation fixes to known jiayan errors.
 *
 * Patterns target mingshilu and similar annal-style text:
 *   1. Trailing 「，」 at end → 「。」
 *   2. 「○，」 at start → 「○」
 *   3. 「，○」 between entries → 「。○」
 *   4. Final 「，」 before truly final 。 (e.g., 「。X，」 if next paragraph starts new entry)
 *
 * Validation: stripped(new) == stripped(orig) — char preservation enforced.
 *
 * Usage:
 *   node backend/scripts/regex-fix-openings.mjs --flags-file <bad-flags.json> [--dry-run]
 */
import fs from "node:fs";
import { getDb, initializeLibrary } from "../src/services/library-db.js";

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? "" : (process.argv[i + 1] || "");
}
function hasFlag(flag) { return process.argv.includes(flag); }

const FLAGS = readArg("--flags-file");
const SLUG_FILTER = readArg("--slug");
const DRY = hasFlag("--dry-run");
if (!FLAGS) { console.error("Need --flags-file"); process.exit(1); }

const PUNCT = new Set("，。：；？！「」、,.:;?!\"'《》〈〉()（）—…—- 　\n\t\xa0");
const strip = s => [...s].filter(c => !PUNCT.has(c)).join("");

function applyFixes(s) {
  let out = s;
  // basic structural fixes
  out = out.replace(/，\s*$/, "。");
  out = out.replace(/^○，/, "○");
  out = out.replace(/，○/g, "。○");
  out = out.replace(/，】/g, "】");
  out = out.replace(/【，/g, "【");
  out = out.replace(/，{2,}/g, "，");

  // Split-name fixes — Ming官名 / 寺廟 / 機構名 jiayan loves to break
  // 大將軍 / 將軍
  out = out.replace(/將，軍/g, "將軍");
  // X都督府
  out = out.replace(/都督，府/g, "都督府");
  out = out.replace(/督，府/g, "督府");
  // 都察院
  out = out.replace(/都察，院/g, "都察院");
  // 翰林院
  out = out.replace(/翰林，院/g, "翰林院");
  // 國子監
  out = out.replace(/國子，監/g, "國子監");
  // 詹事府
  out = out.replace(/詹事，府/g, "詹事府");
  // 鴻臚寺
  out = out.replace(/鴻臚，寺/g, "鴻臚寺");
  // 太常寺
  out = out.replace(/太常，寺/g, "太常寺");
  // 光祿寺
  out = out.replace(/光祿，寺/g, "光祿寺");
  out = out.replace(/光禄，寺/g, "光禄寺");
  // 大理寺
  out = out.replace(/大理，寺/g, "大理寺");
  // 通政司
  out = out.replace(/通政，司/g, "通政司");
  // 錦衣衛
  out = out.replace(/錦衣，衛/g, "錦衣衛");
  out = out.replace(/锦衣，卫/g, "锦衣卫");
  // 行中書省
  out = out.replace(/中，書省/g, "中書省");
  out = out.replace(/中書，省/g, "中書省");
  // 太僕寺
  out = out.replace(/太僕，寺/g, "太僕寺");
  // 城隍廟
  out = out.replace(/城隍，廟/g, "城隍廟");
  out = out.replace(/城隍，庙/g, "城隍庙");
  // 太廟 / 宗廟
  out = out.replace(/太，廟/g, "太廟");
  out = out.replace(/宗，廟/g, "宗廟");
  // 戟門
  out = out.replace(/戟，門/g, "戟門");
  // 奉天殿 / 文華殿 / 武英殿 / 華蓋殿
  out = out.replace(/奉天，殿/g, "奉天殿");
  out = out.replace(/文華，殿/g, "文華殿");
  out = out.replace(/武英，殿/g, "武英殿");
  out = out.replace(/華蓋，殿/g, "華蓋殿");
  out = out.replace(/文渊，閣/g, "文渊閣");
  out = out.replace(/文淵，閣/g, "文淵閣");
  // 給事中
  out = out.replace(/給事，中/g, "給事中");
  out = out.replace(/给事，中/g, "给事中");
  // 御史 + suffix
  out = out.replace(/御史，臺/g, "御史臺");
  out = out.replace(/御史，台/g, "御史台");
  // 平章 (政事)
  out = out.replace(/平，章/g, "平章");
  // 參政
  out = out.replace(/參，政/g, "參政");
  out = out.replace(/参，政/g, "参政");
  // 侍郎
  out = out.replace(/侍，郎/g, "侍郎");
  // 尚書
  out = out.replace(/尚，書/g, "尚書");
  out = out.replace(/尚，书/g, "尚书");
  // X王 + X (the second-char王名 in X王，X form is usually OK; skip)
  // 明 X (history book name): 明，史 → 明史
  out = out.replace(/明，史/g, "明史");
  // 卷之 X
  out = out.replace(/卷之，/g, "卷之");

  return out;
}

await initializeLibrary();
const db = getDb();
const select = db.prepare("SELECT content FROM paragraphs WHERE id = ?");
const update = db.prepare("UPDATE paragraphs SET content = ? WHERE id = ?");
const tx = db.transaction(items => {
  for (const { id, content } of items) update.run(content, id);
});

const flags = JSON.parse(fs.readFileSync(FLAGS, "utf8"));
const filtered = SLUG_FILTER ? flags.filter(f => f.slug === SLUG_FILTER) : flags;

let ok = 0, unchanged = 0, mismatch = 0;
const updates = [];

for (const f of filtered) {
  const r = select.get(f.id);
  if (!r) continue;
  const fixed = applyFixes(r.content);
  if (fixed === r.content) { unchanged++; continue; }
  if (strip(fixed) !== strip(r.content)) {
    mismatch++;
    continue;
  }
  updates.push({ id: f.id, content: fixed });
  ok++;
}

if (!DRY && updates.length) tx(updates);

console.log("=".repeat(60));
console.log(`Targets:          ${filtered.length}`);
console.log(`Updated:          ${ok} ${DRY ? "(dry-run)" : ""}`);
console.log(`Unchanged:        ${unchanged}`);
console.log(`Strip mismatch:   ${mismatch}`);
