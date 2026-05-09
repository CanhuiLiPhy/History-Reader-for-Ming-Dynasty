import { Lunar } from "lunar-javascript";

const MING_REIGNS = [
  // `aliases` lists traditional forms (and any common typographic variants)
  // that the regex should also accept; reignYearToGregorian normalizes them
  // back to the canonical simplified `reign`. The default reader scriptVariant
  // is "traditional", so traditional matches are the common case.
  //
  // 范围说明：本表已扩展到包含 元朝晚期 + 清朝前期 的年号，主要服务于：
  //   - 明实录卷首/罪惟录早期对元末年号（至正、天历、至顺等）的引用
  //   - 廿二史札记、明史纪事本末、读通鉴论 等清人著作里清前期年号
  //   - 跨明清史料比对时正确识别公元年份
  // 名为 MING_REIGNS 是历史遗留，实际是"本库识别的所有年号"列表。

  // ====== 元朝晚期（与明初接轨）======
  { reign: "至元", aliases: [], emperor: "元世祖忽必烈/元顺帝妥懽帖睦尔", startYear: 1264, endYear: 1340 }, // 早 1264-1294 (世祖) + 晚 1335-1340 (顺帝)，按晚期连续段处理
  { reign: "元贞", aliases: [], emperor: "元成宗铁穆耳", startYear: 1295, endYear: 1297 },
  { reign: "大德", aliases: [], emperor: "元成宗铁穆耳", startYear: 1297, endYear: 1307 },
  { reign: "至大", aliases: [], emperor: "元武宗海山", startYear: 1308, endYear: 1311 },
  { reign: "皇庆", aliases: ["皇慶"], emperor: "元仁宗爱育黎拔力八达", startYear: 1312, endYear: 1313 },
  { reign: "延祐", aliases: ["延祐", "延佑"], emperor: "元仁宗爱育黎拔力八达", startYear: 1314, endYear: 1320 },
  { reign: "至治", aliases: [], emperor: "元英宗硕德八剌", startYear: 1321, endYear: 1323 },
  { reign: "泰定", aliases: [], emperor: "元泰定帝也孙铁木儿", startYear: 1324, endYear: 1328 },
  { reign: "致和", aliases: [], emperor: "元泰定帝也孙铁木儿", startYear: 1328, endYear: 1328 },
  { reign: "天历", aliases: ["天曆"], emperor: "元文宗图帖睦尔", startYear: 1328, endYear: 1330 },
  { reign: "至顺", aliases: ["至順"], emperor: "元文宗图帖睦尔/元宁宗", startYear: 1330, endYear: 1333 },
  { reign: "元统", aliases: ["元統"], emperor: "元顺帝妥懽帖睦尔", startYear: 1333, endYear: 1335 },
  { reign: "至正", aliases: [], emperor: "元顺帝妥懽帖睦尔", startYear: 1341, endYear: 1370 },

  // ====== 明朝（核心）======
  // 吴：朱元璋称帝前的自立年号（1364 自立为吴王 → 1364-1367 计年；1368 改元洪武）
  { reign: "吴", aliases: ["吳"], emperor: "明太祖朱元璋（称帝前）", startYear: 1364, endYear: 1367 },
  { reign: "洪武", aliases: [], emperor: "明太祖朱元璋", startYear: 1368, endYear: 1398 },
  { reign: "建文", aliases: [], emperor: "明惠帝朱允炆", startYear: 1399, endYear: 1402 },
  { reign: "永乐", aliases: ["永樂"], emperor: "明成祖朱棣", startYear: 1403, endYear: 1424 },
  { reign: "洪熙", aliases: [], emperor: "明仁宗朱高炽", startYear: 1425, endYear: 1425 },
  { reign: "宣德", aliases: [], emperor: "明宣宗朱瞻基", startYear: 1426, endYear: 1435 },
  { reign: "正统", aliases: ["正統"], emperor: "明英宗朱祁镇", startYear: 1436, endYear: 1449 },
  { reign: "景泰", aliases: [], emperor: "明代宗朱祁钰", startYear: 1450, endYear: 1456 },
  { reign: "天顺", aliases: ["天順"], emperor: "明英宗朱祁镇", startYear: 1457, endYear: 1464 },
  { reign: "成化", aliases: [], emperor: "明宪宗朱见深", startYear: 1465, endYear: 1487 },
  { reign: "弘治", aliases: [], emperor: "明孝宗朱祐樘", startYear: 1488, endYear: 1505 },
  { reign: "正德", aliases: [], emperor: "明武宗朱厚照", startYear: 1506, endYear: 1521 },
  { reign: "嘉靖", aliases: [], emperor: "明世宗朱厚熜", startYear: 1522, endYear: 1566 },
  { reign: "隆庆", aliases: ["隆慶"], emperor: "明穆宗朱载坖", startYear: 1567, endYear: 1572 },
  { reign: "万历", aliases: ["萬曆", "萬歷", "万歷"], emperor: "明神宗朱翊钧", startYear: 1573, endYear: 1620 },
  { reign: "泰昌", aliases: [], emperor: "明光宗朱常洛", startYear: 1620, endYear: 1620 },
  { reign: "天启", aliases: ["天啟"], emperor: "明熹宗朱由校", startYear: 1621, endYear: 1627 },
  { reign: "崇祯", aliases: ["崇禎"], emperor: "明思宗朱由检", startYear: 1628, endYear: 1644 },

  // ====== 清朝前期（南明史料/清人著作里常见）======
  { reign: "顺治", aliases: ["順治"], emperor: "清世祖福临", startYear: 1644, endYear: 1661 },
  { reign: "康熙", aliases: [], emperor: "清圣祖玄烨", startYear: 1662, endYear: 1722 },
  { reign: "雍正", aliases: [], emperor: "清世宗胤禛", startYear: 1723, endYear: 1735 },
  { reign: "乾隆", aliases: [], emperor: "清高宗弘历", startYear: 1736, endYear: 1795 },
  { reign: "嘉庆", aliases: ["嘉慶"], emperor: "清仁宗颙琰", startYear: 1796, endYear: 1820 },
  { reign: "道光", aliases: [], emperor: "清宣宗旻宁", startYear: 1821, endYear: 1850 },
];

// Map any reign-name form (simplified or traditional alias) to its canonical
// (simplified) form. Used after a regex match to look up the right reign row.
const REIGN_CANONICAL: Record<string, string> = {};
for (const r of MING_REIGNS) {
  REIGN_CANONICAL[r.reign] = r.reign;
  for (const a of r.aliases) REIGN_CANONICAL[a] = r.reign;
}

const NUMERAL_MAP: Record<string, number> = {
  元: 1,
  正: 1, // 正月 — defensive: callers normally remap "正" → "一" before calling, but this catches direct calls.
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  百: 100,
  千: 1000,
  两: 2,
};

export function chineseNumeralToInt(value: string): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  if (value === "元") return 1;

  let total = 0;
  let section = 0;
  let current = 0;

  for (const char of value) {
    const numeric = NUMERAL_MAP[char];
    if (numeric == null) continue;
    if (numeric >= 10) {
      if (current === 0) current = 1;
      section += current * numeric;
      current = 0;
    } else {
      current = numeric;
    }
  }

  total += section + current;
  return total || null;
}

export function reignYearToGregorian(reign: string, yearText: string) {
  // Accept traditional aliases by normalizing to the canonical simplified
  // reign name first.
  const canonical = REIGN_CANONICAL[reign] || reign;
  const reignInfo = MING_REIGNS.find((item) => item.reign === canonical);
  if (!reignInfo) return null;

  const year = chineseNumeralToInt(yearText);
  if (!year) return null;

  const gregorian = reignInfo.startYear + year - 1;
  if (gregorian > reignInfo.endYear) return null;

  return {
    gregorian,
    emperor: reignInfo.emperor,
    note: `${reign}${yearText}年 = 公元 ${gregorian} 年（${reignInfo.emperor}）`,
  };
}

// Phase-1 enriched matcher: optional reign prefix + (元|N)年 + optional season
// + optional month + optional 干支 day. The 月-then-干支 anchor is what lets
// us safely recognize 干支 days without spuriously matching them inside names.
//
// Group layout (1-based):
//   1: reign name (optional — bare "X年" inherits last seen reign)
//   2: year text  (元 or numerals)
//   3: season     (春|夏|秋|冬, optional)
//   4: '闰'       (optional)
//   5: month text (元|正|N)
//   6: 干支 day   (壬午 etc., optional)
//
// We accept ASCII whitespace and 中文标点 between components so phrases like
// "天順元年 春正月 壬午" still match.
export const TIANGAN = "甲乙丙丁戊己庚辛壬癸";
export const DIZHI = "子丑寅卯辰巳午未申酉戌亥";

// ---------------------------------------------------------------------------
// 干支纪年：60 年一周期，给定 干支 + 候选年份范围 → 唯一年份
// ---------------------------------------------------------------------------
//
// 古历用 干支 标年（"乙未春正月戊午" 里 "乙未" 就是 干支年）。一个 干支 对
// 应每 60 年出现一次的年份；只要给定一个不超过 60 年的窗口就能唯一定位。
// 公元年→干支：(year - 4) mod 60 → 干支 序号（0=甲子）
const TIANGAN_ARR = TIANGAN.split("");
const DIZHI_ARR = DIZHI.split("");

function ganzhiYearOf(year: number): string {
  const n = ((year - 4) % 60 + 60) % 60;
  return TIANGAN_ARR[n % 10] + DIZHI_ARR[n % 12];
}

/**
 * 给定 干支 字符串和一个候选年份窗口，返回窗口内唯一的公元年；窗口跨度
 * 大于 60 年时返回多个候选，由上层逻辑（章节上下文）来挑选。
 */
export function ganzhiToYear(ganzhi: string, fromYear: number, toYear: number): number[] {
  const out: number[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    if (ganzhiYearOf(y) === ganzhi) out.push(y);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 明实录 干支纪年专属逻辑：仅适用 太祖实录/卷之一 ~ 卷之二十一
// ---------------------------------------------------------------------------
//
// 明实录 大部分卷仍用 「年号+年」（永乐X年 / 洪武Y年 / 宣德Z年 ...）—— 走
// 通用 reign+year 解析路径即可。**唯一**需要干支专属处理的是 太祖实录前
// 21 卷：覆盖 朱元璋 出生（1328）到 称帝前一年 吴元年（1367）这段，无明朝
// 年号可用，元朝年号也基本被作者刻意废弃，文中以 干支 标年（"乙未春正月戊午"
// 这种）。
//
// 卷之二十二 起进入 洪武元年，正常用「洪武 N 年」纪年，跟其它实录无异。
//
// 范围限定 [1328, 1367]：1328 = 朱元璋 生年；1367 = 吴元年（自立 吴 王末年）。
// 1368 起用 洪武，由通用路径接管。

type ShiluRange = { from: number; to: number; primaryReign?: string };

const TAIZU_PRE_REIGN_RANGE: ShiluRange = { from: 1328, to: 1367 };

/**
 * 给定章节标签返回该章节适用的「干支年→公元年」反查窗口。返回 null 表示
 * 该章节走通用 reign+year 解析路径，不进入 实录 干支专属分支。
 *
 * 命中条件（仅有这一种）：
 *   - 章节是 太祖实录/序 或 太祖实录/卷之X，且 X 的汉字数字 1..21
 *
 * 其它实录（太宗实录…崇祯实录）以及 太祖实录/卷之二十二 之后，统统返回
 * null —— 它们都正常使用「年号+年」纪年，没必要绕道。
 */
export function shiluRangesForChapter(chapterLabel: string): ShiluRange[] | null {
  if (!chapterLabel.startsWith("太祖实录")) return null;
  // 太祖实录/序 一并适用（小序通常含纪年信息）
  if (chapterLabel.startsWith("太祖实录/序")) {
    return [TAIZU_PRE_REIGN_RANGE];
  }
  // 太祖实录/卷之X — 仅 1..21
  const m = chapterLabel.match(/^太祖实录\/卷之([元一二三四五六七八九十百\d]+)/);
  if (!m) return null;
  const n = chineseNumeralToInt(m[1]);
  if (n == null) return null;
  if (n < 1 || n > 21) return null;
  return [TAIZU_PRE_REIGN_RANGE];
}
// REIGN_NAMES enumerates every accepted spelling (canonical + traditional
// aliases), so the regex matches whichever form appears in the text.
const REIGN_NAMES = MING_REIGNS.flatMap((item) => [item.reign, ...item.aliases]).join("|");
const NUM_CLASS = "〇零一二三四五六七八九十百千两\\d";
const LEAP = "(?:闰|閏)";
// GAP 允许「年」「月」「日」之间出现的分隔符。补上 句号 / 分号 / 中文逗号
// / 中文/英文括号注释起讫等，以兼容 "永乐元年。春正月戊午"、
// "嘉靖三十六年（1557）八月" 这种带注释或标点的写法。
const GAP = "[\\s·、，,。．；;（）()【】\\[\\]]*";

export const REIGN_DATE_PATTERN = new RegExp(
  `(${REIGN_NAMES})?(元|[${NUM_CLASS}]+)年` +
    `(?:${GAP}([春夏秋冬]?)(${LEAP}?)([元正${NUM_CLASS}]+)月` +
      `(?:${GAP}([${TIANGAN}][${DIZHI}])日?)?` +
    `)?`,
  "g",
);

const SEASON_MONTH_DEFAULT: Record<string, number> = {
  春: 1, // arbitrary; we only use season as decorative if month explicit
  夏: 4,
  秋: 7,
  冬: 10,
};

const MONTH_NORMALIZE: Record<string, string> = {
  元: "正", // "元月" is rare but seen
  正: "正",
};

// Render a 1-12 month number in traditional Chinese form for lunar display.
// 1 → 正; 10 → 十; 11 → 十一; 12 → 十二. Used when we need to format a numeric
// monthOrdinal back to Chinese (e.g. after lunar lookup returns a number).
function monthOrdinalToChinese(n: number): string {
  if (n === 1) return "正";
  const small = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n >= 2 && n <= 9) return small[n];
  if (n === 10) return "十";
  if (n === 11) return "十一";
  if (n === 12) return "十二";
  return String(n);
}

export type ReignDateMatch = {
  reign: string;
  year: number;
  yearText: string;
  gregorian: number;
  emperor: string;
  // Optional extras
  season?: string;
  isLeapMonth?: boolean;
  monthText?: string;     // "正" / "二" ...
  monthOrdinal?: number;  // 1-12 (best effort)
  ganzhiDay?: string;     // 壬午 etc.
  raw: string;            // full matched text (for display)
  note: string;           // formatted tooltip text
  // Resolved when 干支日 is present and lunar lookup succeeds. Lunar fields
  // reflect the actual lunar (year, month, day) — could differ slightly from
  // the reign's startYear+offset arithmetic if the lunar new year fell after
  // the reign change.
  lunarDayChinese?: string;  // 十七
  lunarDayNum?: number;      // 17
  solarYear?: number;        // 1457
  solarMonth?: number;       // 2
  solarDay?: number;         // 11
};

// Walk the days of (lunarYear, lunarMonth, isLeap) and find the day whose
// 干支 matches `ganzhi`. Returns null if not found (some month/year combos
// have only 29 days; some 干支 just don't fall in that month).
function findDayByGanzhi(lunarYear: number, lunarMonth: number, isLeap: boolean, ganzhi: string) {
  const monthArg = isLeap ? -lunarMonth : lunarMonth;
  for (let d = 1; d <= 30; d++) {
    try {
      const lunar = Lunar.fromYmd(lunarYear, monthArg, d);
      if (lunar.getDayInGanZhi() === ganzhi) {
        const solar = lunar.getSolar();
        return {
          lunarDayChinese: lunar.getDayInChinese(),
          lunarDayNum: d,
          solarYear: solar.getYear(),
          solarMonth: solar.getMonth(),
          solarDay: solar.getDay(),
        };
      }
    } catch {
      // out-of-range day in this month
    }
  }
  return null;
}

// Lunar new year for Ming dynasty doesn't always equal the reign's startYear+
// offset arithmetic — but very close (off-by-one within early Jan/Feb). For
// our reign-year → lunar-year mapping we just use the same number. If a
// reign starts mid-year on the Gregorian calendar, the user would see a
// slight discrepancy at the boundary; acceptable for now.

export type DateDisplayMode = "gregorian" | "lunar" | "both";

// Resolve a regex match to a structured date. `contextReign` supplies the
// reign for bare "X年" mentions (caller maintains it from prior matches in
// document order). `mode` controls the rendered note (公历/农历/both).
// `showEmperor` appends the emperor name in parentheses when true.
export function resolveReignDateMatch(
  match: RegExpMatchArray,
  contextReign: string | null,
  mode: DateDisplayMode = "lunar",
  showEmperor = false,
): ReignDateMatch | null {
  const reignName = match[1] || contextReign || "";
  if (!reignName) return null;
  const yearText = match[2];
  const seasonRaw = match[3] || "";
  const isLeap = Boolean(match[4]);
  const monthRaw = match[5] || "";
  const ganzhi = match[6] || "";

  const base = reignYearToGregorian(reignName, yearText);
  if (!base) return null;

  // Normalize traditional aliases (e.g. 永樂 → 永乐) before looking up the
  // reign metadata; raw `reignName` may be a traditional form from the text.
  const canonicalReign = REIGN_CANONICAL[reignName] || reignName;
  const reignInfo = MING_REIGNS.find((r) => r.reign === canonicalReign)!;

  let monthOrdinal: number | undefined;
  let monthText: string | undefined;
  if (monthRaw) {
    monthText = MONTH_NORMALIZE[monthRaw] ?? monthRaw;
    const num = chineseNumeralToInt(monthText === "正" ? "一" : monthText);
    if (num && num >= 1 && num <= 12) monthOrdinal = num;
  } else if (seasonRaw && SEASON_MONTH_DEFAULT[seasonRaw]) {
    monthOrdinal = SEASON_MONTH_DEFAULT[seasonRaw];
  }

  const raw = match[0];

  // Resolve precise lunar day & Gregorian date when 干支日 is given.
  let resolved: ReturnType<typeof findDayByGanzhi> = null;
  if (ganzhi && monthOrdinal) {
    resolved = findDayByGanzhi(base.gregorian, monthOrdinal, isLeap, ganzhi);
  }

  // Build the human-friendly source phrase shown in the tooltip.
  let phrase = `${reignName}${yearText}年`;
  if (seasonRaw) phrase += seasonRaw;
  if (monthRaw) phrase += `${isLeap ? "闰" : ""}${monthRaw}月`;
  if (ganzhi) phrase += ganzhi + "日";

  // Build the resolution detail per mode. Layout:
  //   gregorian → 公元 1457 年 2 月 11 日（明英宗朱祁镇）
  //   lunar     → 农历一四五七年正月十七（明英宗朱祁镇）
  //   both      → both lines
  const lines: string[] = [];

  if (resolved) {
    if (mode === "gregorian" || mode === "both") {
      lines.push(`公元 ${resolved.solarYear} 年 ${resolved.solarMonth} 月 ${resolved.solarDay} 日`);
    }
    if (mode === "lunar" || mode === "both") {
      lines.push(`农历 ${base.gregorian} 年${isLeap ? "闰" : ""}${monthText || ""}月${resolved.lunarDayChinese}`);
    }
  } else if (monthOrdinal) {
    if (mode === "gregorian" || mode === "both") {
      lines.push(`公元 ${base.gregorian} 年（${isLeap ? "闰" : ""}农历${monthOrdinal}月）`);
    }
    if (mode === "lunar" || mode === "both") {
      lines.push(`农历 ${base.gregorian} 年${isLeap ? "闰" : ""}${monthText || ""}月`);
    }
  } else {
    // year-only — Gregorian and lunar effectively the same number for our
    // purposes (lunar year ≈ Gregorian year, off by ~1 month at year ends)
    lines.push(`公元 ${base.gregorian} 年`);
  }

  const note = `${phrase} = ${lines.join(" / ")}${showEmperor ? `（${reignInfo.emperor}）` : ""}`;

  return {
    reign: reignName,
    year: chineseNumeralToInt(yearText)!,
    yearText,
    gregorian: base.gregorian,
    emperor: reignInfo.emperor,
    season: seasonRaw || undefined,
    isLeapMonth: isLeap || undefined,
    monthText,
    monthOrdinal,
    ganzhiDay: ganzhi || undefined,
    raw,
    note,
    lunarDayChinese: resolved?.lunarDayChinese,
    lunarDayNum: resolved?.lunarDayNum,
    solarYear: resolved?.solarYear,
    solarMonth: resolved?.solarMonth,
    solarDay: resolved?.solarDay,
  };
}

// Backwards-compat: legacy callers (search-result rendering) used REIGN_PATTERN
// for the simple "<reign><N>年" shape. Keep the export pointing to the new
// pattern but anchored — it still matches that shape (groups 3-6 are optional).
export const REIGN_PATTERN = REIGN_DATE_PATTERN;

// ---------------------------------------------------------------------------
// Selection-driven date resolution
//
// Inline annotation is too noisy for bare 月/干支 mentions. Users invoke the
// "识别日期" button on a highlighted range; we then:
//   1. Find the first date-token in the selection (year/month/ganzhi).
//   2. Walk the surrounding text BEFORE the selection to fill in missing
//      context (most recent reign+year, most recent month).
//   3. Compute precise date. If a 干支 day claims a month that doesn't
//      contain it, also try the following lunar month (text often elides
//      month boundaries).
// ---------------------------------------------------------------------------

// ANCHOR_RE retired — superseded by YEAR_OPTIONAL_REIGN_RE below which
// matches both `<reign>N年` and bare `N年` in one pass. Keep for any
// external callers (none in tree right now) — `void` to silence TS unused.
const ANCHOR_RE = new RegExp(`(${REIGN_NAMES})(元|[${NUM_CLASS}]+)年`, "g");
void ANCHOR_RE;
// Plain month — used by lastMonthBefore (context lookup). Doesn't capture
// trailing ganzhi; that's handled by MONTH_WITH_DAY_RE in the selection
// matcher.
const MONTH_RE = new RegExp(`(${LEAP}?)([元正${NUM_CLASS}]+)月`, "g");
// Selection-side: a month plus an optional adjacent ganzhi day. This is what
// catches "秋七月癸酉" or "七月癸酉日" — without this the bare-month and
// bare-ganzhi tokens would be matched separately and the day would be lost.
const MONTH_WITH_DAY_RE = new RegExp(
  `([春夏秋冬]?)(${LEAP}?)([元正${NUM_CLASS}]+)月(?:${GAP}([${TIANGAN}][${DIZHI}])日?)?`,
  "g",
);
const GANZHI_RE = new RegExp(`[${TIANGAN}][${DIZHI}](?=日|[，。、；,;\\s]|$)`, "g");

type Anchor = { reign: string; yearText: string; year: number; gregorianYear: number; emperor: string };

// 单一遍历的年份搜索：捕获 `(reign)?N年` 形式（reign 可选）。这样可以一次
// 遍历就能按位置向后扫描，**最近的"X年"优先**（不管带不带年号），符合
// "先找年、再回溯年号"的逻辑。
//   - 命中带年号 → 直接组成 anchor
//   - 命中裸年 → 从裸年位置往前再找最近的年号名（永乐 / 嘉靖 / …）配上
//   - 都失败 → null（caller 通常会扩 context 到上一章重试）
const YEAR_OPTIONAL_REIGN_RE = new RegExp(
  `(${REIGN_NAMES})?\\s*(元|[${NUM_CLASS}]+)年`,
  "g",
);
const REIGN_NAME_RE = new RegExp(`(${REIGN_NAMES})`, "g");

function lastReignNameBefore(text: string): string | null {
  const matches = [...text.matchAll(REIGN_NAME_RE)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1];
}

function lastAnchorBefore(text: string): Anchor | null {
  const matches = [...text.matchAll(YEAR_OPTIONAL_REIGN_RE)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const yearText = m[2];
    let reign = m[1];
    if (!reign) {
      // 裸年 → 从该年位置之前再回溯最近的年号名
      reign = lastReignNameBefore(text.slice(0, m.index ?? 0)) ?? "";
    }
    if (!reign) continue;
    const base = reignYearToGregorian(reign, yearText);
    if (!base) continue;
    const canonical = REIGN_CANONICAL[reign] || reign;
    const reignInfo = MING_REIGNS.find((r) => r.reign === canonical);
    if (!reignInfo) continue;
    return {
      reign,
      yearText,
      year: chineseNumeralToInt(yearText)!,
      gregorianYear: base.gregorian,
      emperor: reignInfo.emperor,
    };
  }
  return null;
}

// =====================================================================
// 明实录专用日期解析
// =====================================================================
//
// 这条路径**只**给章节是 X实录/卷之N 的选段用，不影响通用 resolveSelectionDate。
// 实录用 干支 标年（"乙未春正月戊午" → 乙未 = 1355 年），通用逻辑（年号+年）
// 在这里完全失效。
//
// 三种识别目标：
//   (a) 选段就是「干支+季节[+月][+干支日]」    → 自包含，直接算
//       例: "乙未春正月戊午" / "癸巳春" / "丙申夏四月丁巳"
//   (b) 选段是「月[+干支日]」                  → 月在选段里，年从 contextBefore 拿
//       例: "正月辛巳"
//   (c) 选段是「干支日」                       → 月+年都从 contextBefore 拿
//       例: "辛巳"
//
// contextBefore 里的 anchor 形态（重要的是这两种 ——「干支+季节」就够当年用）：
//   "干支+季节[+月]"  例: "乙未春正月戊午" / "癸巳春" / "丙申夏四月"
//
// 由于 干支 60 年一周期，要靠章节所在 实录 的年份范围把 干支 反查为公元年。
// 太祖实录跨度 70 年（1328-1398），SHILU_RANGES 把它拆成 1328-1368（元末）+
// 1368-1398（洪武）两段，分别反查后取**靠近 contextBefore 末尾**的候选。

const SHILU_GZ_SEASON_MONTH_RE = new RegExp(
  `([${TIANGAN}][${DIZHI}])([春夏秋冬])(?:${GAP}(${LEAP}?)([元正${NUM_CLASS}]+)月)?`,
  "g",
);
// 选段里的「干支+季节(+月)(+干支日)」
const SEL_SHILU_FULL_RE = new RegExp(
  `([${TIANGAN}][${DIZHI}])([春夏秋冬])` +
    `(?:${GAP}(${LEAP}?)([元正${NUM_CLASS}]+)月)?` +
    `(?:${GAP}([${TIANGAN}][${DIZHI}])日?)?`,
);
// 选段里的「[闰]月[+干支日]」
const SEL_MONTH_DAY_RE = new RegExp(
  `(${LEAP}?)([元正${NUM_CLASS}]+)月(?:${GAP}([${TIANGAN}][${DIZHI}])日?)?`,
);
// 选段里的「干支日」
const SEL_BARE_GANZHI_RE = new RegExp(`[${TIANGAN}][${DIZHI}]`);

// =====================================================================
// 章节级默认 干支年 补丁
// =====================================================================
//
// 卷21 开头是 "丙午八月庚戌朔..."，但卷20 末尾是廖永安传记倒叙了 乙未/甲辰
// 等更早年份，用 "text 位置最靠后" 或 "max year" 之类启发式都会被传记内容
// 误导。比起加复杂的"识别叙事年 vs 传记年"逻辑，这里直接给这一章登记一个
// 硬编码默认值：当 selection / contextBefore 都找不出 干支年 时，回退到
// "丙午"。其它卷如果之后发现类似 corner case 再补这张表即可。
const CHAPTER_DEFAULT_GANZHI: Record<string, string> = {
  "太祖实录/卷之二十一": "丙午",
};

function ganzhiYearToGregorian(ganzhi: string, ranges: Array<{ from: number; to: number }>): number | null {
  // 在每个 range 段内反查，返回最靠后的候选（实录顺序写，靠后 = 较晚事件 = 较大年份）
  let candidates: number[] = [];
  for (const r of ranges) {
    candidates.push(...ganzhiToYear(ganzhi, r.from, r.to));
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a - b);
  return candidates[candidates.length - 1];
}

function monthAndDayFromMonthMatch(
  m: RegExpExecArray,
  leapIdx = 1,
  monthIdx = 2,
  dayIdx = 3,
): { isLeap: boolean; monthOrdinal: number; monthText: string; ganzhiDay?: string } | null {
  const monthRaw = m[monthIdx];
  if (!monthRaw) return null;
  const monthText = MONTH_NORMALIZE[monthRaw] ?? monthRaw;
  const ord = chineseNumeralToInt(monthText === "正" ? "一" : monthText);
  if (!ord || ord < 1 || ord > 12) return null;
  return {
    isLeap: Boolean(m[leapIdx]),
    monthOrdinal: ord,
    monthText,
    ganzhiDay: m[dayIdx] || undefined,
  };
}

/**
 * 明实录专用日期解析。仅当 chapterLabel 命中 SHILU_RANGES 时调用。
 *
 * 算法：
 *   1. 选段里如果有「干支+季节」，用它作年（必要时还用它带的月/日）。
 *   2. 选段里如果有「月+干支日」，月直接用；年回溯 contextBefore 找最近的
 *      「干支+季节」复合体。
 *   3. 选段里只有「干支日」，年和月都回溯 contextBefore 找最近的
 *      「干支+季节[+月]」复合体；如果该复合体里没带月，再回退到 lastMonthBefore。
 *   4. 用 SHILU_RANGES 把 干支年 反查为公元年；落到对应年号上下文，构造结果。
 */
export function resolveShiluSelectionDate(
  selectionText: string,
  contextBefore: string,
  chapterLabel: string,
  mode: DateDisplayMode = "lunar",
): ResolvedSelectionDate | null {
  const ranges = shiluRangesForChapter(chapterLabel);
  if (!ranges) return null;

  let ganzhiYear = "";
  let monthOrdinal: number | undefined;
  let monthText: string | undefined;
  let isLeap = false;
  let ganzhiDay = "";
  let season = "";

  // (a) 选段含「干支+季节(+月)(+干支日)」
  const fullSel = SEL_SHILU_FULL_RE.exec(selectionText);
  if (fullSel) {
    ganzhiYear = fullSel[1];
    season = fullSel[2];
    isLeap = Boolean(fullSel[3]);
    if (fullSel[4]) {
      const md = monthAndDayFromMonthMatch(fullSel as RegExpExecArray, 3, 4, 5);
      if (md) {
        monthOrdinal = md.monthOrdinal;
        monthText = md.monthText;
        if (md.ganzhiDay) ganzhiDay = md.ganzhiDay;
      }
    }
  } else {
    // (b) 选段含「[闰]月[+干支日]」
    const monthSel = SEL_MONTH_DAY_RE.exec(selectionText);
    if (monthSel) {
      const md = monthAndDayFromMonthMatch(monthSel as RegExpExecArray, 1, 2, 3);
      if (md) {
        isLeap = md.isLeap;
        monthOrdinal = md.monthOrdinal;
        monthText = md.monthText;
        if (md.ganzhiDay) ganzhiDay = md.ganzhiDay;
      }
    } else {
      // (c) 选段只有「干支日」
      const ganzhiSel = SEL_BARE_GANZHI_RE.exec(selectionText);
      if (ganzhiSel) ganzhiDay = ganzhiSel[0];
    }
  }

  // 选段没年 → 回溯 contextBefore 找最近的「干支+季节(+月)」
  if (!ganzhiYear) {
    const ctxMatches = [...contextBefore.matchAll(SHILU_GZ_SEASON_MONTH_RE)];
    if (ctxMatches.length > 0) {
      const last = ctxMatches[ctxMatches.length - 1];
      ganzhiYear = last[1];
      if (!season) season = last[2];
      // 选段里没有月 → 用 anchor 复合体里的月（如果有）
      if (monthOrdinal === undefined && last[4]) {
        const md = monthAndDayFromMonthMatch(last as unknown as RegExpExecArray, 3, 4, -1);
        if (md) {
          isLeap = md.isLeap;
          monthOrdinal = md.monthOrdinal;
          monthText = md.monthText;
        }
      }
    } else {
      // 章节级硬编码补丁（CHAPTER_DEFAULT_GANZHI 表）
      const fallback = CHAPTER_DEFAULT_GANZHI[chapterLabel];
      if (fallback) ganzhiYear = fallback;
    }
  }
  if (!ganzhiYear) return null;

  // 干支年 → 公元年
  const gregorianYear = ganzhiYearToGregorian(ganzhiYear, ranges);
  if (!gregorianYear) return null;

  // 命中年号信息（用于显示）
  const reignInfo = MING_REIGNS.find((r) => gregorianYear >= r.startYear && gregorianYear <= r.endYear);
  const reign = reignInfo?.reign || "";
  const yearInReign = reignInfo ? gregorianYear - reignInfo.startYear + 1 : 0;
  const yearLabel = reign
    ? `${reign}${yearInReign === 1 ? "元" : monthOrdinalToChinese(yearInReign)}年（${ganzhiYear}）`
    : `${ganzhiYear}年（${gregorianYear}）`;

  // 拼显示用 phrase
  let phrase = yearLabel;
  if (season) phrase += season;
  if (monthOrdinal !== undefined && monthText) {
    phrase += `${isLeap ? "闰" : ""}${monthText}月`;
  }
  if (ganzhiDay) phrase += ganzhiDay + "日";

  // 算具体公历日（如有月+干支日）
  let gregorian: string | undefined;
  let lunar: string | undefined;
  let preciseSolarY: number | undefined;
  let preciseSolarM: number | undefined;
  let preciseSolarD: number | undefined;
  let rolledOver = false;

  if (ganzhiDay && monthOrdinal !== undefined) {
    const precise = resolvePreciseDate(gregorianYear, monthOrdinal, isLeap, ganzhiDay);
    if (precise) {
      rolledOver = precise.rolledOver;
      preciseSolarY = precise.solarYear;
      preciseSolarM = precise.solarMonth;
      preciseSolarD = precise.solarDay;
      gregorian = `${precise.solarYear} 年 ${precise.solarMonth} 月 ${precise.solarDay} 日`;
      lunar = `${gregorianYear} 年${precise.isLeap ? "闰" : ""}${monthOrdinalToChinese(precise.monthOrdinal)}月${precise.lunarDayChinese}`;
    }
  } else if (monthOrdinal !== undefined) {
    gregorian = `${gregorianYear} 年（${isLeap ? "闰" : ""}农历${monthOrdinal}月）`;
    lunar = `${gregorianYear} 年${isLeap ? "闰" : ""}${monthOrdinalToChinese(monthOrdinal)}月`;
  } else {
    gregorian = `${gregorianYear} 年`;
    lunar = `${gregorianYear} 年（农历）`;
  }

  let gregOut: string | undefined;
  let lunarOut: string | undefined;
  if (mode === "gregorian" || mode === "both") gregOut = gregorian;
  if (mode === "lunar" || mode === "both") lunarOut = lunar;

  return {
    phrase,
    gregorian: gregOut,
    lunar: lunarOut,
    reign,
    emperor: reignInfo?.emperor,
    rolledOver: rolledOver || undefined,
    reignYear: yearInReign,
    gregorianYear,
    solarYear: preciseSolarY,
    solarMonth: preciseSolarM,
    solarDay: preciseSolarD,
    monthOrdinal: monthOrdinal,
    isLeapMonth: isLeap || undefined,
  };
}

function lastMonthBefore(text: string): { isLeap: boolean; ordinal: number; monthText: string } | null {
  const matches = [...text.matchAll(MONTH_RE)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const isLeap = Boolean(m[1]);
    const monthText = MONTH_NORMALIZE[m[2]] ?? m[2];
    const ord = chineseNumeralToInt(monthText === "正" ? "一" : monthText);
    if (ord && ord >= 1 && ord <= 12) return { isLeap, ordinal: ord, monthText };
  }
  return null;
}

// Find earliest occurrence (smallest start index) of any date-shaped token
// in `selectionText`. Token kinds, in priority order on tie:
//   "year" — a `<reign><N>年` or bare `<N>年`
//   "month" — `<N>月` or `闰<N>月`
//   "ganzhi" — `甲子`, `壬午`, etc. (excluding contexts where it's likely a name)
type SelToken =
  | { kind: "year"; index: number; reign?: string; yearText: string; isLeap?: boolean; monthText?: string; monthOrdinal?: number; ganzhi?: string }
  | { kind: "month"; index: number; isLeap: boolean; monthText: string; monthOrdinal: number; ganzhi?: string }
  | { kind: "ganzhi"; index: number; ganzhi: string };

function firstDateTokenInSelection(text: string): SelToken | null {
  const candidates: SelToken[] = [];

  // 1. Reign-anchored date phrase (most specific)
  for (const m of text.matchAll(REIGN_DATE_PATTERN)) {
    if (!m[1]) continue;
    const monthOrd = m[5] ? chineseNumeralToInt((MONTH_NORMALIZE[m[5]] ?? m[5]) === "正" ? "一" : m[5]) : null;
    candidates.push({
      kind: "year",
      index: m.index ?? 0,
      reign: m[1],
      yearText: m[2],
      isLeap: Boolean(m[4]),
      monthText: m[5] ? MONTH_NORMALIZE[m[5]] ?? m[5] : undefined,
      monthOrdinal: monthOrd ?? undefined,
      ganzhi: m[6] || undefined,
    });
  }

  // 2. Bare X年 (no reign)
  const bareYearRe = new RegExp(`(?<![${REIGN_NAMES.replace(/\|/g, "")}])(元|[${NUM_CLASS}]+)年`, "g");
  for (const m of text.matchAll(bareYearRe)) {
    candidates.push({ kind: "year", index: m.index ?? 0, yearText: m[1] });
  }

  // 3. Months — with optional trailing ganzhi (so "七月癸酉" reads as one
  //    date, not two separate tokens). Group layout: [season, leap, month, ganzhi]
  for (const m of text.matchAll(MONTH_WITH_DAY_RE)) {
    const monthText = MONTH_NORMALIZE[m[3]] ?? m[3];
    const ord = chineseNumeralToInt(monthText === "正" ? "一" : monthText);
    if (!ord || ord < 1 || ord > 12) continue;
    candidates.push({
      kind: "month",
      index: m.index ?? 0,
      isLeap: Boolean(m[2]),
      monthText,
      monthOrdinal: ord,
      ganzhi: m[4] || undefined,
    });
  }

  // 4. Bare ganzhi (no month immediately before within the selection text)
  for (const m of text.matchAll(GANZHI_RE)) {
    candidates.push({ kind: "ganzhi", index: m.index ?? 0, ganzhi: m[0] });
  }

  if (!candidates.length) return null;
  // Prefer earliest index. On tie, more-specific kind wins (year > month > ganzhi).
  const kindRank = { year: 0, month: 1, ganzhi: 2 };
  candidates.sort((a, b) => a.index - b.index || kindRank[a.kind] - kindRank[b.kind]);
  return candidates[0];
}

// Resolve the lunar/solar date for a (year, month, isLeap, ganzhi). If the
// ganzhi doesn't fall in that month, try the next lunar month — texts often
// describe events crossing a month boundary without re-stating the month.
function resolvePreciseDate(gregorianYear: number, monthOrdinal: number, isLeap: boolean, ganzhi: string) {
  const direct = findDayByGanzhi(gregorianYear, monthOrdinal, isLeap, ganzhi);
  if (direct) return { ...direct, monthOrdinal, isLeap, rolledOver: false };

  // Try next month. If current month is the leap month, the next month is
  // monthOrdinal+1 (non-leap). If the year has a leap month at monthOrdinal+1,
  // we should try the leap version too.
  let nextOrd = monthOrdinal + (isLeap ? 1 : 1);
  let nextLeap = false;
  if (nextOrd > 12) {
    const next = findDayByGanzhi(gregorianYear + 1, 1, false, ganzhi);
    if (next) return { ...next, monthOrdinal: 1, isLeap: false, rolledOver: true };
    return null;
  }
  let attempt = findDayByGanzhi(gregorianYear, nextOrd, nextLeap, ganzhi);
  if (attempt) return { ...attempt, monthOrdinal: nextOrd, isLeap: nextLeap, rolledOver: true };
  // Try the leap version of next month if it exists in this year.
  attempt = findDayByGanzhi(gregorianYear, nextOrd, true, ganzhi);
  if (attempt) return { ...attempt, monthOrdinal: nextOrd, isLeap: true, rolledOver: true };
  return null;
}

export type ResolvedSelectionDate = {
  phrase: string;        // "嘉靖三十六年八月甲寅"
  gregorian?: string;    // "1557 年 9 月 12 日"
  lunar?: string;        // "1557 年八月二十一"
  reign?: string;
  emperor?: string;
  warning?: string;      // "选段未含年号，已用前文最近年号" 之类
  rolledOver?: boolean;  // true if 干支 was found in next month (text-elision)
  // Numeric breakdown — useful for sorting / range filtering. Set when the
  // resolver had enough info to compute them (year always; solar*/lunar* only
  // when 干支 day was given and a precise date came back).
  reignYear?: number;     // numeric reign-year (e.g. 36 for 嘉靖三十六年)
  gregorianYear?: number; // year derived from reign (e.g. 1557)
  solarYear?: number;     // precise solar Y/M/D when 干支 found
  solarMonth?: number;
  solarDay?: number;
  monthOrdinal?: number;  // 1-12 lunar month if known
  isLeapMonth?: boolean;
};

export function resolveSelectionDate(
  selectionText: string,
  contextBefore: string,
  mode: DateDisplayMode = "lunar",
  _showEmperor = false,
): ResolvedSelectionDate | null {
  // showEmperor is consumed by the caller via the returned `emperor` field;
  // the modal decides whether to render it. Plumbed here for symmetry with
  // resolveReignDateMatch.
  void _showEmperor;
  const token = firstDateTokenInSelection(selectionText);
  if (!token) return null;

  let anchor: Anchor | null = null;
  let monthInfo: { isLeap: boolean; ordinal: number; monthText: string } | null = null;
  let ganzhi = "";

  // Resolve anchor (reign+year) and month based on token kind.
  if (token.kind === "year") {
    const reign = token.reign || lastAnchorBefore(contextBefore)?.reign || "";
    if (!reign) return null;
    const base = reignYearToGregorian(reign, token.yearText);
    if (!base) return null;
    const canonical = REIGN_CANONICAL[reign] || reign;
    const reignInfo = MING_REIGNS.find((r) => r.reign === canonical)!;
    anchor = { reign, yearText: token.yearText, year: chineseNumeralToInt(token.yearText)!, gregorianYear: base.gregorian, emperor: reignInfo.emperor };
    if (token.monthOrdinal) {
      monthInfo = { isLeap: Boolean(token.isLeap), ordinal: token.monthOrdinal, monthText: token.monthText! };
    }
    if (token.ganzhi) ganzhi = token.ganzhi;
  } else if (token.kind === "month") {
    anchor = lastAnchorBefore(contextBefore);
    if (!anchor) return null;
    monthInfo = { isLeap: token.isLeap, ordinal: token.monthOrdinal, monthText: token.monthText };
    if (token.ganzhi) ganzhi = token.ganzhi;
  } else {
    // ganzhi only
    anchor = lastAnchorBefore(contextBefore);
    if (!anchor) return null;
    const beforeGanzhi = selectionText.slice(0, token.index);
    monthInfo = lastMonthBefore(beforeGanzhi) || lastMonthBefore(contextBefore);
    if (!monthInfo) return null;
    ganzhi = token.ganzhi;
  }

  // Build display phrase from the actually-resolved bits.
  let phrase = `${anchor.reign}${anchor.yearText}年`;
  if (monthInfo) phrase += `${monthInfo.isLeap ? "闰" : ""}${monthInfo.monthText}月`;
  if (ganzhi) phrase += ganzhi + "日";

  // Compute precise date if we have ganzhi + month.
  let gregorian: string | undefined;
  let lunar: string | undefined;
  let rolledOver = false;
  let preciseSolarY: number | undefined;
  let preciseSolarM: number | undefined;
  let preciseSolarD: number | undefined;

  if (ganzhi && monthInfo) {
    const precise = resolvePreciseDate(anchor.gregorianYear, monthInfo.ordinal, monthInfo.isLeap, ganzhi);
    if (precise) {
      rolledOver = precise.rolledOver;
      preciseSolarY = precise.solarYear;
      preciseSolarM = precise.solarMonth;
      preciseSolarD = precise.solarDay;
      gregorian = `${precise.solarYear} 年 ${precise.solarMonth} 月 ${precise.solarDay} 日`;
      lunar = `${anchor.gregorianYear} 年${precise.isLeap ? "闰" : ""}${monthOrdinalToChinese(precise.monthOrdinal)}月${precise.lunarDayChinese}`;
    }
  } else if (monthInfo) {
    // year+month, no day: just label the month
    gregorian = `${anchor.gregorianYear} 年（${monthInfo.isLeap ? "闰" : ""}农历${monthInfo.ordinal}月）`;
    lunar = `${anchor.gregorianYear} 年${monthInfo.isLeap ? "闰" : ""}${monthOrdinalToChinese(monthInfo.ordinal)}月`;
  } else {
    gregorian = `${anchor.gregorianYear} 年`;
    lunar = `${anchor.gregorianYear} 年（农历）`;
  }

  // Build the result strings honouring `mode`.
  let gregOut: string | undefined;
  let lunarOut: string | undefined;
  if (mode === "gregorian" || mode === "both") gregOut = gregorian;
  if (mode === "lunar" || mode === "both") lunarOut = lunar;

  return {
    phrase,
    gregorian: gregOut,
    lunar: lunarOut,
    reign: anchor.reign,
    emperor: anchor.emperor,
    rolledOver: rolledOver || undefined,
    warning: token.kind !== "year" || !token.reign
      ? `选段未含完整年号，已用前文最近的「${anchor.reign}${anchor.yearText}年」作为参照`
      : undefined,
    reignYear: anchor.year,
    gregorianYear: anchor.gregorianYear,
    solarYear: preciseSolarY,
    solarMonth: preciseSolarM,
    solarDay: preciseSolarD,
    monthOrdinal: monthInfo?.ordinal,
    isLeapMonth: monthInfo?.isLeap || undefined,
  };
}
