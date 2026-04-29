/**
 * Parse the user-provided 明代 reference TXT files into a unified JSON:
 *   - offices[]      from 明代官职表
 *   - chronology[]   from 七卿年表 + 南京七卿表 + 内阁辅臣年表
 *   - princes[]      from 藩王列表 (simplified extraction)
 *
 * Output: backend/src/data/officials-extended.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATABASE = path.join(__dirname, "../../donotpack/database");
const OUT = path.join(__dirname, "../src/data/officials-extended.json");

function readUtf8(p) {
  return fs.readFileSync(p, "utf8").replace(/\r/g, "");
}

const stripRefs = (s) =>
  String(s || "")
    .replace(/\[(注\s*)?\d+\]/g, "")
    .replace(/\[(注\s*)?[一二三四五六七八九十]+\]/g, "")
    .trim();

// Heuristic: looks like a Ming-era personal name (Chinese characters, 2-7
// chars, optionally with a trailing role suffix like "署/兼" or "X月降/进").
function looksLikeName(s) {
  if (!s) return false;
  if (/[，。、；：《》【】（）()「」“”""\d]/.test(s)) return false;
  const cleaned = s.replace(/\s+(?:署|兼|进|降|进士|辞|罢|卒|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月|正月|闰月|十二月降|.{1,3}月降|.{1,3}月进|.{1,3}月辞|.{1,3}月卒|.{1,3}月罢|右都御史|左都御史|加|改).*$/, "").trim();
  if (cleaned.length < 2 || cleaned.length > 5) return false;
  return /^[一-鿿]+$/.test(cleaned);
}

// ─── 1. 明代官职表 ──────────────────────────────────────
function parseOfficeTable() {
  const text = readUtf8(path.join(DATABASE, "明代官职表.txt"));
  const lines = text.split("\n");
  const offices = [];
  const sections = [];
  let currentSection = { name: "", description: "" };
  let inTable = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("名称\t")) {
      inTable = true;
      continue;
    }
    if (inTable) {
      const parts = line.split("\t");
      if (parts.length >= 4 && /^[一-鿿]/.test(parts[0])) {
        offices.push({
          name: stripRefs(parts[0]),
          count: stripRefs(parts[1]),
          rank: stripRefs(parts[2]),
          department: stripRefs(parts[3]),
          notes: stripRefs(parts[4] || ""),
          section: currentSection.name,
        });
        continue;
      }
      // Non-tabular line ends the table block
      inTable = false;
    }
    if (!inTable) {
      // Section heading: short line that doesn't look like prose. Heuristic:
      // <= 14 chars, no full stops, not a bracket/citation, no English digits.
      if (line.length <= 14 && !/[。，、《》（）()]/.test(line) && !/\d/.test(line)) {
        currentSection = { name: line.trim(), description: "" };
        sections.push(currentSection);
      } else if (currentSection) {
        currentSection.description = (currentSection.description ? currentSection.description + "\n" : "") + stripRefs(line);
      }
    }
  }
  return { offices, sections };
}

// ─── 2. Chronology (七卿 / 南京七卿 / 内阁辅臣) ─────────────
//
// Format pattern:
//   {era}年间                                        <- era heading
//   ... prose ...
//   年代<tab>colA<tab>colB...                        <- column header (may span >1 line)
//   {year_label}                                     <- year line 1
//   （{gregorian}年）<tab>cell0<tab>cell1...         <- year line 2 + first row
//   continuation lines without leading tab append to the last column being filled;
//   a tab inside a continuation line shifts to the NEXT column.
function parseChronology(filePath, scope) {
  const text = readUtf8(filePath);
  const lines = text.split("\n");

  let currentEra = "";
  let columns = [];           // array of column header strings
  let activeRows = [];        // rows belonging to the current header block
  let lastRowCol = -1;        // index of the last column being filled in the most recent row
  const allEntries = [];

  const eraRe = /^(?:附：?)?[一-鿿]{1,6}年间$/;
  const yearLabelRe = /^[一-鿿]{1,8}(?:元年|[一二三四五六七八九十百]+年)/; // 洪武元年 / 永乐二十二年甲辰
  const gregorianRe = /^（(\d+)年）/;
  const headerRe = /^(?:年代|时间)\t/;

  function flushPendingColumnLine(line) {
    // "御史台\n御史大夫" — second-line addition to LAST column header.
    if (columns.length > 0 && line && !line.includes("\t")) {
      columns[columns.length - 1] = columns[columns.length - 1] + "/" + line.trim();
    }
  }

  let pendingHeaderExtension = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      pendingHeaderExtension = false;
      continue;
    }
    // Era heading
    if (eraRe.test(line.trim())) {
      currentEra = line.trim();
      pendingHeaderExtension = false;
      continue;
    }
    // Column header
    if (headerRe.test(line)) {
      columns = line.split("\t").map((s) => stripRefs(s).trim()).slice(1); // drop "年代"
      pendingHeaderExtension = true;
      lastRowCol = -1;
      continue;
    }
    if (pendingHeaderExtension) {
      // Header line 2 (rare, e.g., "御史大夫" extending "御史台"). Only treat as
      // extension if it isn't a year-label start and is super short.
      if (!line.includes("\t") && line.length <= 6 && !/[（。、]/.test(line) && !yearLabelRe.test(line.trim())) {
        flushPendingColumnLine(line);
        continue;
      }
      pendingHeaderExtension = false;
    }

    // Year row part 1: "{年号}{year}{甲子?}"
    if (yearLabelRe.test(line.trim()) && !line.includes("\t")) {
      // Start a new pending row; year label is line + (later) （YYYY年）.
      // Snapshot the column names here so each row remembers its own header
      // (multiple header blocks may exist within one file).
      activeRows.push({
        yearLabel: line.trim(),
        gregorian: null,
        cells: columns.map(() => []),
        columnsSnapshot: [...columns],
        era: currentEra,
      });
      lastRowCol = -1;
      continue;
    }

    // Year row part 2: "（YYYY年）\t...cells..."
    const greg = line.match(gregorianRe);
    if (greg && line.includes("\t")) {
      const last = activeRows[activeRows.length - 1];
      if (last) {
        last.gregorian = Number.parseInt(greg[1], 10);
        last.yearLabel = `${last.yearLabel}（${greg[1]}年）`;
      } else {
        // No prior label line → standalone year row
        activeRows.push({
          yearLabel: `（${greg[1]}年）`,
          gregorian: Number.parseInt(greg[1], 10),
          cells: columns.map(() => []),
          era: currentEra,
        });
      }
      const rest = line.replace(gregorianRe, "");
      const parts = rest.split("\t");
      // parts[0] is "" (the bit between "(YYYY年)" and the first tab); skip
      const row = activeRows[activeRows.length - 1];
      if (!row.cells || row.cells.length === 0) {
        row.cells = columns.map(() => []);
        row.columnsSnapshot = [...columns];
      }
      for (let p = 1; p < parts.length; p++) {
        const colIdx = p - 1;
        if (colIdx >= columns.length) break;
        if (!row.cells[colIdx]) row.cells[colIdx] = [];
        const value = stripRefs(parts[p]);
        if (value) row.cells[colIdx].push(value);
        lastRowCol = colIdx;
      }
      continue;
    }

    // Continuation lines belong to the most recent row
    const row = activeRows[activeRows.length - 1];
    if (!row) continue;

    const parts = line.split("\t");
    let colIdx = lastRowCol >= 0 ? lastRowCol : 0;
    for (let p = 0; p < parts.length; p++) {
      const value = stripRefs(parts[p]);
      if (p > 0) colIdx++;
      if (colIdx >= columns.length) break;
      if (!row.cells[colIdx]) row.cells[colIdx] = [];
      if (value) row.cells[colIdx].push(value);
    }
    lastRowCol = colIdx;
  }

  // Flatten activeRows → entries; filter cell values to keep only plausible
  // person names (drops prose that wandered into early cells). 内阁辅臣 cells
  // tend to contain multiple "、"-separated names — split before filtering.
  for (const row of activeRows) {
    if (!row.gregorian) continue;
    const cols = row.columnsSnapshot || columns;
    for (let c = 0; c < (row.cells?.length || 0); c++) {
      const raw = row.cells[c]?.filter(Boolean) ?? [];
      const expanded = raw.flatMap((s) => s.split(/[、，]/).map((x) => x.trim()).filter(Boolean));
      const people = [...new Set(expanded.filter(looksLikeName))];
      if (people.length === 0) continue;
      // Skip the 御史台 mash-up that the吴年间 prefix produced. Drop entries
      // whose position name accidentally absorbed prose (>10 chars or contains
      // 年/月).
      const position = cols[c] || "未知";
      if (position.length > 10 || position === "未知" || position === "背景") continue;
      allEntries.push({
        scope,
        era: row.era,
        yearLabel: row.yearLabel,
        gregorian: row.gregorian,
        position,
        people,
      });
    }
  }
  return allEntries;
}

// ─── 3. 藩王列表 — prince extraction ─────────────────────
function parsePrinces() {
  const text = readUtf8(path.join(DATABASE, "明代藩王列表.txt"));
  const lines = text.split("\n");

  // Generation-naming poems: "X府：<chars>...<chars>。"
  const poems = {};
  const poemRe = /^([一-鿿]+府|東宮)：([^（\n]+)/;
  for (const line of lines) {
    const m = line.match(poemRe);
    if (m) {
      poems[m[1]] = m[2].replace(/[，。]/g, "").trim();
    }
  }

  // Section headings: "X诸子列表" or "明X追封…诸王" or "崇祯帝诸子列表".
  // Lines starting with a prince title (王/公/太子/皇X) followed by 朱X are
  // prince records, even when followed by descriptive prose like "封国XX府".
  const princes = [];
  let currentSection = "";
  const sectionRe1 = /^[一-鿿]{1,4}诸子列表$/;          // 朱仲八诸子列表 / 崇祯帝诸子列表 / 懿文太子诸子列表
  const sectionRe2 = /^明[一-鿿]+诸子列表$/;             // 明德祖/明太祖/明成祖诸子列表
  const sectionRe3 = /^明[一-鿿]+追封[一-鿿]*诸王$/;     // 明太祖追封父祖诸王
  const sectionRe4 = /^[一-鿿]{1,6}(?:朝|府)(?:诸王|郡王|藩王)列表$/; // 弘光朝诸王列表 / 秦府藩王列表
  const sectionRe5 = /^(?:监国鲁王|南明分封|南明追赠|明朝追赠)[一-鿿]*列表?$/; // 监国鲁王诸王列表 / 南明追赠诸王 / 明朝追赠异姓王列表
  const sectionRe6 = /^南明(?:分封|追赠)诸王[：:]?$/;
  // Flexible prince-line regex:
  //   group 1 = title (e.g., "秦愍王", "皇太子", "燕　王", "虞怀王")
  //   group 2 = personal name (always starts with 朱)
  // Allows full-width spaces and minimal length 2 chars total title.
  const princeRe = /^([一-鿿　\s]{1,10}?(?:王|公|太子|皇[一-鿿]{0,3}))(朱[一-鿿㐀-䶿豈-﫿]{1,3})/;
  const bareNameRe = /^朱[一-鿿㐀-䶿豈-﫿]{1,3}$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Strip wiki-style refs like [注 9] / [21]
    const stripped = line.replace(/\[(?:注\s*)?[0-9一二三四五六七八九十]+\]/g, "");

    if (sectionRe1.test(stripped) || sectionRe2.test(stripped) || sectionRe3.test(stripped) ||
        sectionRe4.test(stripped) || sectionRe5.test(stripped) || sectionRe6.test(stripped)) {
      currentSection = stripped;
      continue;
    }
    // Bare name (e.g., "朱仲八")
    if (bareNameRe.test(stripped)) {
      princes.push({ section: currentSection, title: "", name: stripped });
      continue;
    }
    // Titled prince entry; description after first comma is captured as note
    const m = stripped.match(princeRe);
    if (m) {
      const title = m[1].replace(/[　\s]+/g, "").trim();
      const name = m[2];
      const rest = stripped.slice(m[0].length).replace(/^[，,]/, "").trim();
      princes.push({ section: currentSection, title, name, note: rest.slice(0, 60) });
    }
  }

  // Dedupe within a section by name. The 王府藩王列表 sections repeat each
  // 嗣封亲王 once as a son in his father's list and once as a sub-heading for
  // his own children. Keep the FIRST occurrence (which usually has the
  // descriptive note); drop subsequent name-only repeats.
  const dedupedPrinces = [];
  const seen = new Set();
  for (const p of princes) {
    const key = `${p.section}::${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedPrinces.push(p);
  }

  return { poems, princes: dedupedPrinces };
}

// ─── Run ────────────────────────────────────────────────
const { offices, sections } = parseOfficeTable();
const central = parseChronology(path.join(DATABASE, "明代七卿年表.txt"), "中央六部");
const nanjing = parseChronology(path.join(DATABASE, "明代南京七卿表.txt"), "南京六部");
const cabinet = parseChronology(path.join(DATABASE, "明代内阁辅臣年表.txt"), "内阁");
const { poems, princes } = parsePrinces();

const chronology = [...central, ...nanjing, ...cabinet];

const out = {
  generatedAt: new Date().toISOString(),
  offices,
  sections,
  chronology,
  princes,
  poems,
  stats: {
    officeCount: offices.length,
    sectionCount: sections.length,
    chronologyCount: chronology.length,
    princeCount: princes.length,
    poemCount: Object.keys(poems).length,
  },
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log("Stats:", out.stats);
