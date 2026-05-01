import { Lunar } from "lunar-javascript";

const MING_REIGNS = [
  // `aliases` lists traditional forms (and any common typographic variants)
  // that the regex should also accept; reignYearToGregorian normalizes them
  // back to the canonical simplified `reign`. The default reader scriptVariant
  // is "traditional", so traditional matches are the common case.
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
// REIGN_NAMES enumerates every accepted spelling (canonical + traditional
// aliases), so the regex matches whichever form appears in the text.
const REIGN_NAMES = MING_REIGNS.flatMap((item) => [item.reign, ...item.aliases]).join("|");
const NUM_CLASS = "〇零一二三四五六七八九十百千两\\d";
const LEAP = "(?:闰|閏)";
const GAP = "[\\s·、，,]*";

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

const ANCHOR_RE = new RegExp(`(${REIGN_NAMES})(元|[${NUM_CLASS}]+)年`, "g");
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

function lastAnchorBefore(text: string): Anchor | null {
  const matches = [...text.matchAll(ANCHOR_RE)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const base = reignYearToGregorian(m[1], m[2]);
    if (!base) continue;
    const canonical = REIGN_CANONICAL[m[1]] || m[1];
    const reignInfo = MING_REIGNS.find((r) => r.reign === canonical)!;
    return {
      reign: m[1],
      yearText: m[2],
      year: chineseNumeralToInt(m[2])!,
      gregorianYear: base.gregorian,
      emperor: reignInfo.emperor,
    };
  }
  return null;
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
    // Find most recent month — could be in selection BEFORE the ganzhi index, or in contextBefore
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

  if (ganzhi && monthInfo) {
    const precise = resolvePreciseDate(anchor.gregorianYear, monthInfo.ordinal, monthInfo.isLeap, ganzhi);
    if (precise) {
      rolledOver = precise.rolledOver;
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
  };
}
