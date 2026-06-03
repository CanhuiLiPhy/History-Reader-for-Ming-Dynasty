import { useMemo, useState } from "react";
import { Lunar, Solar } from "lunar-javascript";
import { MING_REIGNS, TIANGAN, DIZHI, chineseNumeralToInt } from "../lib/reign";
import {
  CURRENCIES,
  type Currency,
  convertAll,
  type ConversionContext,
  MODERN_RICE_DATE,
  MODERN_RICE_SOURCE,
  MODERN_RICE_PRICE_RMB_PER_KG,
  GONGSHI_KG,
  SILVER_LIANG_GRAMS,
} from "../lib/ming-rates";

type Tab = "date" | "measure" | "currency";

// Build a single regex that recognises any known reign or alias.
const ALL_REIGN_FORMS = (() => {
  const forms = new Set<string>();
  for (const r of MING_REIGNS) {
    forms.add(r.reign);
    for (const a of r.aliases) forms.add(a);
  }
  return [...forms].sort((a, b) => b.length - a.length);
})();

const REIGN_ALT = ALL_REIGN_FORMS.map((f) => f.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|");
const NUMS = "[一二三四五六七八九十零〇百千两元0-9]+";

function canonicalReign(name: string): { reign: string; emperor: string; startYear: number; endYear: number } | null {
  for (const r of MING_REIGNS) {
    if (r.reign === name) return r;
    if (r.aliases.includes(name)) return r;
  }
  return null;
}

function parseChineseMonth(input: string): { month: number; isLeap: boolean } | null {
  if (!input) return null;
  let str = input.trim();
  let isLeap = false;
  if (str.startsWith("闰") || str.startsWith("閏")) {
    isLeap = true;
    str = str.slice(1);
  }
  if (str === "正") return { month: 1, isLeap };
  if (str === "腊" || str === "臘" || str === "腊月" || str === "臘月") return { month: 12, isLeap };
  if (str === "冬") return { month: 11, isLeap };
  const n = chineseNumeralToInt(str.replace(/月$/, ""));
  if (n && n >= 1 && n <= 12) return { month: n, isLeap };
  return null;
}

function isGanzhi(s: string): boolean {
  return s.length === 2 && TIANGAN.includes(s[0]) && DIZHI.includes(s[1]);
}

/** Search forward day-by-day within a given lunar month, find first matching ganzhi.  */
function findGanzhiDayInLunarMonth(
  year: number,
  month: number,
  isLeap: boolean,
  targetGz: string,
): { lunarDay: number; solar: { y: number; m: number; d: number }; ganzhi: string } | null {
  // Iterate days 1..30; lunar-javascript throws if day exceeds month length, so guard.
  for (let day = 1; day <= 30; day++) {
    try {
      const lm = isLeap ? -month : month;
      const lunar = Lunar.fromYmd(year, lm, day);
      const gz = lunar.getDayInGanZhi();
      if (gz === targetGz) {
        const solar = lunar.getSolar();
        return {
          lunarDay: day,
          solar: { y: solar.getYear(), m: solar.getMonth(), d: solar.getDay() },
          ganzhi: gz,
        };
      }
    } catch {
      break;
    }
  }
  return null;
}

/** Get the year-ganzhi (干支纪年) for a lunar year. */
function getYearGanzhi(lunarYear: number): string {
  // Use the first day of the lunar year to read year-ganzhi.
  try {
    const lunar = Lunar.fromYmd(lunarYear, 1, 1);
    // lunar-javascript: Lunar has getYearInGanZhi; not in our shim — call via cast.
    const fn = (lunar as unknown as { getYearInGanZhi?: () => string }).getYearInGanZhi;
    if (typeof fn === "function") return fn.call(lunar);
  } catch { /* ignore */ }
  // Fallback formula: 1864 was 甲子.
  const idx = ((lunarYear - 4) % 60 + 60) % 60;
  return TIANGAN[idx % 10] + DIZHI[idx % 12];
}

type DateResult =
  | { kind: "reign-only"; reign: string; emperor: string; startYear: number; endYear: number }
  | { kind: "reign-year"; reign: string; year: number; gregorian: number; emperor: string; ganzhi: string }
  | { kind: "reign-month"; reign: string; year: number; gregorian: number; emperor: string; lunarMonth: number; isLeap: boolean; lastDay: number; startSY: number; startSM: number; startSD: number; endSY: number; endSM: number; endSD: number; yearGanzhi: string }
  | { kind: "reign-day"; reign: string; year: number; gregorian: number; emperor: string; lunarMonth: number; isLeap: boolean; lunarDay: number; solarY: number; solarM: number; solarD: number; dayGanzhi: string; yearGanzhi: string }
  | { kind: "reign-ganzhi-day"; reign: string; year: number; gregorian: number; emperor: string; lunarMonth: number; isLeap: boolean; matchedDay: number; solarY: number; solarM: number; solarD: number; dayGanzhi: string; yearGanzhi: string; note?: string }
  | { kind: "gregorian-date"; solarY: number; solarM: number; solarD: number; lunarY: number; lunarM: number; isLeap: boolean; lunarD: number; reign: string | null; reignYear: number | null; emperor: string | null; dayGanzhi: string; yearGanzhi: string }
  | { kind: "gregorian-year"; gregorian: number; reigns: { reign: string; year: number; emperor: string; ganzhi: string }[] }
  | { kind: "error"; message: string };

function parseDateInput(raw: string): DateResult {
  const input = raw.trim().replace(/\s+/g, "");
  if (!input) return { kind: "error", message: "请输入内容。" };

  // ---- Pattern A: 公元 / 西元 / 阳历 / pure gregorian date ----
  // "1490" / "公元1490年" / "1644年4月25日" / "1644-04-25"
  const gregFull = input.match(/^(?:公元|西元|公历|公曆|阳历|陽曆)?(\d{3,4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?$/);
  if (gregFull) {
    const y = +gregFull[1], m = +gregFull[2], d = +gregFull[3];
    return handleGregorianDate(y, m, d);
  }
  const gregYearOnly = input.match(/^(?:公元|西元|公历|公曆|阳历|陽曆)?(\d{3,4})年?$/);
  if (gregYearOnly) {
    const y = +gregYearOnly[1];
    return handleGregorianYear(y);
  }

  // ---- Pattern B: reign-based ----
  // Try longest-first: 年号 + 年 + 月 + (干支日 | 日) | 年号 + 年 + 月 | 年号 + 年 | 年号-only
  const reignNumYearMonthDay = new RegExp(`^(${REIGN_ALT})(${NUMS})年(闰|閏)?(${NUMS}|正|腊|臘|冬)月(${NUMS}|[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥])日?$`);
  const m = input.match(reignNumYearMonthDay);
  if (m) {
    const [, reignName, yearTxt, leapMark, monthTxt, dayTxt] = m;
    return handleReignDay(reignName, yearTxt, !!leapMark, monthTxt, dayTxt);
  }
  // 年号 + 年 + 月 + 干支日 without 日 suffix
  const reignNumYearMonthGz = new RegExp(`^(${REIGN_ALT})(${NUMS})年(闰|閏)?(${NUMS}|正|腊|臘|冬)月([甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥])$`);
  const m2 = input.match(reignNumYearMonthGz);
  if (m2) {
    const [, reignName, yearTxt, leapMark, monthTxt, dayTxt] = m2;
    return handleReignDay(reignName, yearTxt, !!leapMark, monthTxt, dayTxt);
  }
  // 年号 + 年 + 月（无日）
  const reignNumYearMonth = new RegExp(`^(${REIGN_ALT})(${NUMS})年(闰|閏)?(${NUMS}|正|腊|臘|冬)月$`);
  const m25 = input.match(reignNumYearMonth);
  if (m25) {
    const [, reignName, yearTxt, leapMark, monthTxt] = m25;
    return handleReignMonth(reignName, yearTxt, !!leapMark, monthTxt);
  }
  // 年号 + 年（无月日）
  const reignYearOnly = new RegExp(`^(${REIGN_ALT})(${NUMS})年?$`);
  const m3 = input.match(reignYearOnly);
  if (m3) {
    const [, reignName, yearTxt] = m3;
    return handleReignYear(reignName, yearTxt);
  }
  // 仅年号
  const reignOnly = new RegExp(`^(${REIGN_ALT})$`);
  const m4 = input.match(reignOnly);
  if (m4) {
    return handleReignOnly(m4[1]);
  }

  return { kind: "error", message: "无法识别输入。试试：弘治 / 永乐四年 / 永乐四年正月甲午 / 1644-04-25" };
}

function handleReignOnly(name: string): DateResult {
  const r = canonicalReign(name);
  if (!r) return { kind: "error", message: `未识别的年号「${name}」` };
  return { kind: "reign-only", reign: r.reign, emperor: r.emperor, startYear: r.startYear, endYear: r.endYear };
}

function handleReignYear(name: string, yearTxt: string): DateResult {
  const r = canonicalReign(name);
  if (!r) return { kind: "error", message: `未识别的年号「${name}」` };
  const yr = chineseNumeralToInt(yearTxt);
  if (!yr || yr < 1) return { kind: "error", message: `无法解析年份「${yearTxt}」` };
  const gregorian = r.startYear + yr - 1;
  if (gregorian > r.endYear) {
    return { kind: "error", message: `${r.reign}仅 ${r.endYear - r.startYear + 1} 年（公元 ${r.startYear}–${r.endYear}），无 ${yr} 年` };
  }
  return {
    kind: "reign-year",
    reign: r.reign,
    year: yr,
    gregorian,
    emperor: r.emperor,
    ganzhi: getYearGanzhi(gregorian),
  };
}

function lastDayOfLunarMonth(year: number, month: number, isLeap: boolean): number {
  const lm = isLeap ? -month : month;
  for (let day = 30; day >= 28; day--) {
    try {
      Lunar.fromYmd(year, lm, day);
      return day;
    } catch { /* try smaller */ }
  }
  return 29;
}

function handleReignMonth(name: string, yearTxt: string, isLeap: boolean, monthTxt: string): DateResult {
  const r = canonicalReign(name);
  if (!r) return { kind: "error", message: `未识别的年号「${name}」` };
  const yr = chineseNumeralToInt(yearTxt);
  if (!yr || yr < 1) return { kind: "error", message: `无法解析年份「${yearTxt}」` };
  const gregorian = r.startYear + yr - 1;
  if (gregorian > r.endYear) {
    return { kind: "error", message: `${r.reign}仅 ${r.endYear - r.startYear + 1} 年，无 ${yr} 年` };
  }
  const parsedMonth = parseChineseMonth(isLeap ? `闰${monthTxt}` : monthTxt);
  if (!parsedMonth) return { kind: "error", message: `无法解析月份「${monthTxt}」` };

  // 闰月校验
  try {
    Lunar.fromYmd(gregorian, parsedMonth.isLeap ? -parsedMonth.month : parsedMonth.month, 1);
  } catch (e) {
    if (parsedMonth.isLeap) {
      return { kind: "error", message: `${r.reign}${yr}年（公元${gregorian}年）无闰${monthTxt}月（${(e as Error).message}）` };
    }
    return { kind: "error", message: `日期不存在：${r.reign}${yr}年${monthTxt}月（${(e as Error).message}）` };
  }

  const lm = parsedMonth.isLeap ? -parsedMonth.month : parsedMonth.month;
  const lastDay = lastDayOfLunarMonth(gregorian, parsedMonth.month, parsedMonth.isLeap);
  const startLunar = Lunar.fromYmd(gregorian, lm, 1);
  const endLunar = Lunar.fromYmd(gregorian, lm, lastDay);
  const ss = startLunar.getSolar();
  const es = endLunar.getSolar();

  return {
    kind: "reign-month",
    reign: r.reign,
    year: yr,
    gregorian,
    emperor: r.emperor,
    lunarMonth: parsedMonth.month,
    isLeap: parsedMonth.isLeap,
    lastDay,
    startSY: ss.getYear(), startSM: ss.getMonth(), startSD: ss.getDay(),
    endSY: es.getYear(), endSM: es.getMonth(), endSD: es.getDay(),
    yearGanzhi: getYearGanzhi(gregorian),
  };
}

function handleReignDay(name: string, yearTxt: string, isLeap: boolean, monthTxt: string, dayTxt: string): DateResult {
  const r = canonicalReign(name);
  if (!r) return { kind: "error", message: `未识别的年号「${name}」` };
  const yr = chineseNumeralToInt(yearTxt);
  if (!yr || yr < 1) return { kind: "error", message: `无法解析年份「${yearTxt}」` };
  const gregorian = r.startYear + yr - 1;
  if (gregorian > r.endYear) {
    return { kind: "error", message: `${r.reign}仅 ${r.endYear - r.startYear + 1} 年，无 ${yr} 年` };
  }
  const parsedMonth = parseChineseMonth(isLeap ? `闰${monthTxt}` : monthTxt);
  if (!parsedMonth) return { kind: "error", message: `无法解析月份「${monthTxt}」` };
  const yearGz = getYearGanzhi(gregorian);

  if (isGanzhi(dayTxt)) {
    // Search forward from M-1 within this lunar month for first matching ganzhi day.
    const hit = findGanzhiDayInLunarMonth(gregorian, parsedMonth.month, parsedMonth.isLeap, dayTxt);
    if (hit) {
      return {
        kind: "reign-ganzhi-day",
        reign: r.reign, year: yr, gregorian, emperor: r.emperor,
        lunarMonth: parsedMonth.month, isLeap: parsedMonth.isLeap,
        matchedDay: hit.lunarDay,
        solarY: hit.solar.y, solarM: hit.solar.m, solarD: hit.solar.d,
        dayGanzhi: hit.ganzhi, yearGanzhi: yearGz,
      };
    }
    // Not found in this month — search forward up to 90 days from month start.
    try {
      const lm = parsedMonth.isLeap ? -parsedMonth.month : parsedMonth.month;
      const startLunar = Lunar.fromYmd(gregorian, lm, 1);
      const startSolar = startLunar.getSolar();
      const startDate = new Date(startSolar.getYear(), startSolar.getMonth() - 1, startSolar.getDay());
      for (let off = 0; off < 90; off++) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + off);
        const s = Solar.fromYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
        const lun = s.getLunar();
        const gz = lun.getDayInGanZhi();
        if (gz === dayTxt) {
          // Express as lunar
          // Note: lib uses negative month for leap.
          const rawMonth = (lun as unknown as { getMonth: () => number }).getMonth();
          const lunDay = (lun as unknown as { getDay: () => number }).getDay();
          const lunYr = (lun as unknown as { getYear: () => number }).getYear();
          // Reverse-lookup reign for lunYr (may have rolled over)
          const reigningYear = lunYr;
          const note = off === 0 ? undefined : `${r.reign}${yr}年${parsedMonth.isLeap ? "闰" : ""}${parsedMonth.month}月无${dayTxt}日，往后顺寻得最近的${dayTxt}日`;
          return {
            kind: "reign-ganzhi-day",
            reign: r.reign, year: yr, gregorian: reigningYear, emperor: r.emperor,
            lunarMonth: Math.abs(rawMonth), isLeap: rawMonth < 0,
            matchedDay: lunDay,
            solarY: s.getYear(), solarM: s.getMonth(), solarD: s.getDay(),
            dayGanzhi: gz, yearGanzhi: getYearGanzhi(reigningYear), note,
          };
        }
      }
    } catch { /* fall through */ }
    return { kind: "error", message: `自 ${r.reign}${yr}年${monthTxt}月 起 90 日内未找到${dayTxt}日` };
  }

  // Numeric day
  const day = chineseNumeralToInt(dayTxt.replace(/日$/, ""));
  if (!day || day < 1) return { kind: "error", message: `无法解析日期「${dayTxt}」` };
  try {
    const lm = parsedMonth.isLeap ? -parsedMonth.month : parsedMonth.month;
    const lun = Lunar.fromYmd(gregorian, lm, day);
    const solar = lun.getSolar();
    return {
      kind: "reign-day",
      reign: r.reign, year: yr, gregorian, emperor: r.emperor,
      lunarMonth: parsedMonth.month, isLeap: parsedMonth.isLeap, lunarDay: day,
      solarY: solar.getYear(), solarM: solar.getMonth(), solarD: solar.getDay(),
      dayGanzhi: lun.getDayInGanZhi(),
      yearGanzhi: yearGz,
    };
  } catch (e) {
    return { kind: "error", message: `日期不存在：${r.reign}${yr}年${monthTxt}月${day}日 (${(e as Error).message})` };
  }
}

function handleGregorianYear(y: number): DateResult {
  // Find ALL reigns that include this year (handles overlap like 1620 = 万历48/泰昌1, 1644 = 崇祯17/顺治1)
  const hits = MING_REIGNS.filter((r) => y >= r.startYear && y <= r.endYear);
  if (!hits.length) return { kind: "error", message: `公元 ${y} 年不在本表记录的年号范围内（${MING_REIGNS[0].startYear}–${MING_REIGNS[MING_REIGNS.length-1].endYear}）` };
  return {
    kind: "gregorian-year",
    gregorian: y,
    reigns: hits.map((r) => ({
      reign: r.reign,
      year: y - r.startYear + 1,
      emperor: r.emperor,
      ganzhi: getYearGanzhi(y),
    })),
  };
}

function handleGregorianDate(y: number, m: number, d: number): DateResult {
  try {
    const solar = Solar.fromYmd(y, m, d);
    const lunar = solar.getLunar();
    const rawMonth = (lunar as unknown as { getMonth: () => number }).getMonth();
    const lunarY = (lunar as unknown as { getYear: () => number }).getYear();
    const lunarD = (lunar as unknown as { getDay: () => number }).getDay();
    const isLeap = rawMonth < 0;
    const lunarM = Math.abs(rawMonth);
    // Find reign for this lunar year (use solar year as approximation; cross-year edge cases acknowledged)
    const yearForReign = lunarY;
    const reign = MING_REIGNS.find((r) => yearForReign >= r.startYear && yearForReign <= r.endYear);
    return {
      kind: "gregorian-date",
      solarY: y, solarM: m, solarD: d,
      lunarY: lunarY, lunarM, isLeap, lunarD,
      reign: reign?.reign ?? null,
      reignYear: reign ? lunarY - reign.startYear + 1 : null,
      emperor: reign?.emperor ?? null,
      dayGanzhi: lunar.getDayInGanZhi(),
      yearGanzhi: getYearGanzhi(lunarY),
    };
  } catch (e) {
    return { kind: "error", message: `日期非法：${y}-${m}-${d}（${(e as Error).message}）` };
  }
}

function intToChineseNum(n: number): string {
  const chars = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n < 0) return String(n);
  if (n === 0) return "〇";
  if (n < 10) return chars[n];
  if (n < 20) return n === 10 ? "十" : `十${chars[n - 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${chars[tens]}十${ones ? chars[ones] : ""}`;
  }
  return String(n);
}

function DateResultView({ r }: { r: DateResult }) {
  if (r.kind === "error") return <div className="calc-error">{r.message}</div>;
  if (r.kind === "reign-only") {
    return (
      <div className="calc-result">
        <div className="calc-row"><strong>年号</strong>{r.reign}</div>
        <div className="calc-row"><strong>皇帝</strong>{r.emperor}</div>
        <div className="calc-row"><strong>起讫</strong>公元 {r.startYear}–{r.endYear} 年（共 {r.endYear - r.startYear + 1} 年）</div>
      </div>
    );
  }
  if (r.kind === "reign-year") {
    return (
      <div className="calc-result">
        <div className="calc-row"><strong>明代</strong>{r.reign}{intToChineseNum(r.year)}年</div>
        <div className="calc-row"><strong>公元</strong>{r.gregorian} 年</div>
        <div className="calc-row"><strong>皇帝</strong>{r.emperor}</div>
        <div className="calc-row"><strong>干支</strong>{r.ganzhi}</div>
      </div>
    );
  }
  if (r.kind === "reign-month") {
    return (
      <div className="calc-result">
        <div className="calc-row"><strong>明代</strong>{r.reign}{intToChineseNum(r.year)}年 {r.isLeap ? "闰" : ""}{intToChineseNum(r.lunarMonth)}月（共 {r.lastDay} 日）</div>
        <div className="calc-row"><strong>公历</strong>{r.startSY}年{r.startSM}月{r.startSD}日 — {r.endSY}年{r.endSM}月{r.endSD}日</div>
        <div className="calc-row"><strong>公元</strong>{r.gregorian} 年</div>
        <div className="calc-row"><strong>干支年</strong>{r.yearGanzhi}</div>
        <div className="calc-row"><strong>皇帝</strong>{r.emperor}</div>
      </div>
    );
  }
  if (r.kind === "reign-day") {
    return (
      <div className="calc-result">
        <div className="calc-row"><strong>明代</strong>{r.reign}{intToChineseNum(r.year)}年（公元{r.gregorian}年）{r.isLeap ? "闰" : ""}{intToChineseNum(r.lunarMonth)}月{intToChineseNum(r.lunarDay)}日</div>
        <div className="calc-row"><strong>公历</strong>{r.solarY}年{r.solarM}月{r.solarD}日</div>
        <div className="calc-row"><strong>干支日</strong>{r.dayGanzhi}</div>
        <div className="calc-row"><strong>干支年</strong>{r.yearGanzhi}</div>
        <div className="calc-row"><strong>皇帝</strong>{r.emperor}</div>
      </div>
    );
  }
  if (r.kind === "reign-ganzhi-day") {
    return (
      <div className="calc-result">
        <div className="calc-row"><strong>明代</strong>{r.reign}{intToChineseNum(r.year)}年 {r.isLeap ? "闰" : ""}{intToChineseNum(r.lunarMonth)}月 {r.dayGanzhi}（农历第 {r.matchedDay} 日）</div>
        <div className="calc-row"><strong>公历</strong>{r.solarY}年{r.solarM}月{r.solarD}日</div>
        <div className="calc-row"><strong>干支年</strong>{r.yearGanzhi}</div>
        <div className="calc-row"><strong>皇帝</strong>{r.emperor}</div>
        {r.note && <div className="calc-note">{r.note}</div>}
      </div>
    );
  }
  if (r.kind === "gregorian-date") {
    return (
      <div className="calc-result">
        <div className="calc-row"><strong>公历</strong>{r.solarY}年{r.solarM}月{r.solarD}日</div>
        <div className="calc-row"><strong>农历</strong>{r.lunarY}年 {r.isLeap ? "闰" : ""}{intToChineseNum(r.lunarM)}月{intToChineseNum(r.lunarD)}日</div>
        {r.reign && r.reignYear && (
          <div className="calc-row"><strong>明代</strong>{r.reign}{intToChineseNum(r.reignYear)}年</div>
        )}
        {r.emperor && <div className="calc-row"><strong>皇帝</strong>{r.emperor}</div>}
        <div className="calc-row"><strong>干支日</strong>{r.dayGanzhi}</div>
        <div className="calc-row"><strong>干支年</strong>{r.yearGanzhi}</div>
      </div>
    );
  }
  // gregorian-year
  return (
    <div className="calc-result">
      <div className="calc-row"><strong>公元</strong>{r.gregorian} 年</div>
      {r.reigns.length > 1 && <div className="calc-note">此年跨年号：</div>}
      {r.reigns.map((rg, i) => (
        <div key={i} className="calc-row">
          <strong>{r.reigns.length > 1 ? `年号 ${i + 1}` : "年号"}</strong>
          {rg.reign}{intToChineseNum(rg.year)}年 · {rg.emperor} · 干支{rg.ganzhi}
        </div>
      ))}
    </div>
  );
}

// ============ Unit Converter ============

type UnitGroup = {
  key: string;
  title: string;
  note: string;
  units: { id: string; label: string; toBase: number; baseHint?: string }[];
  baseSymbol: string;
};

// All conversion factors expressed against a base unit. Ming-era measures
// vary across sources; values below follow《明会典》/《大明律》通用记载。
const UNIT_GROUPS: UnitGroup[] = [
  {
    key: "length", title: "长度", baseSymbol: "厘米",
    note: "明营造尺 ≈ 32 cm；步弓尺（量地）= 5 尺。",
    units: [
      { id: "ming-cun", label: "明寸", toBase: 3.2 },
      { id: "ming-chi", label: "明尺 (营造)", toBase: 32 },
      { id: "ming-bu", label: "明步 (5 尺)", toBase: 160 },
      { id: "ming-zhang", label: "明丈 (10 尺)", toBase: 320 },
      { id: "ming-li", label: "明里 (180 丈)", toBase: 57600 },
      { id: "cm", label: "厘米 cm", toBase: 1 },
      { id: "m", label: "米 m", toBase: 100 },
      { id: "km", label: "千米 km", toBase: 100000 },
    ],
  },
  {
    key: "area", title: "面积", baseSymbol: "平方米",
    note: "明 1 亩 ≈ 614.4 m²（240 步²）；1 顷 = 100 亩；1 亩 = 10 分 = 100 厘。",
    units: [
      { id: "ming-chi2", label: "明平方尺", toBase: 0.1024 },
      { id: "ming-bu2", label: "明平方步", toBase: 2.56 },
      { id: "ming-li-area", label: "明厘 (1/100 亩)", toBase: 6.144 },
      { id: "ming-fen-area", label: "明分 (1/10 亩)", toBase: 61.44 },
      { id: "ming-mu", label: "明亩 (240 步²)", toBase: 614.4 },
      { id: "ming-qing", label: "明顷 (100 亩)", toBase: 61440 },
      { id: "m2", label: "平方米 m²", toBase: 1 },
      { id: "ha", label: "公顷 ha", toBase: 10000 },
    ],
  },
  {
    key: "weight", title: "重量", baseSymbol: "克",
    note: "明营造库平：1 斤 = 16 两 = 596.8 克；1 两 ≈ 37.3 克。",
    units: [
      { id: "ming-fen", label: "明分", toBase: 0.373 },
      { id: "ming-qian", label: "明钱", toBase: 3.73 },
      { id: "ming-liang", label: "明两 (1/16 斤)", toBase: 37.3 },
      { id: "ming-jin", label: "明斤 (16 两)", toBase: 596.8 },
      { id: "ming-dan", label: "明担/石 (120 斤)", toBase: 71616 },
      { id: "g", label: "克 g", toBase: 1 },
      { id: "kg", label: "千克 kg", toBase: 1000 },
      { id: "ton", label: "公吨 t", toBase: 1000000 },
    ],
  },
  {
    key: "volume", title: "容量", baseSymbol: "升",
    note: "明 1 斛 = 5 斗 ≈ 51.7 升；1 斗 ≈ 10.35 升；后期「石」（容量单位）= 2 斛 = 100 升上下。",
    units: [
      { id: "ming-ge", label: "明合", toBase: 0.1035 },
      { id: "ming-sheng", label: "明升 (10 合)", toBase: 1.035 },
      { id: "ming-dou", label: "明斗 (10 升)", toBase: 10.35 },
      { id: "ming-hu", label: "明斛 (5 斗)", toBase: 51.7 },
      { id: "ming-shi-vol", label: "明石 (容量, 2 斛)", toBase: 103.5 },
      { id: "L", label: "升 L", toBase: 1 },
      { id: "m3", label: "立方米 m³", toBase: 1000 },
    ],
  },
];

function MeasureSection() {
  const [groupKey, setGroupKey] = useState<string>(UNIT_GROUPS[0].key);

  return (
    <div className="calc-unit-root" data-no-convert>
      <div className="calc-unit-tabs">
        {UNIT_GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            className={`tab-button ${groupKey === g.key ? "is-active" : ""}`}
            onClick={() => setGroupKey(g.key)}
          >
            {g.title}
          </button>
        ))}
      </div>
      <MeasureConverter groupKey={groupKey} />
    </div>
  );
}

function MeasureConverter({ groupKey }: { groupKey: string }) {
  const group = useMemo(() => UNIT_GROUPS.find((g) => g.key === groupKey) ?? UNIT_GROUPS[0], [groupKey]);
  const [fromUnit, setFromUnit] = useState<string>(group.units[0].id);
  const [toUnit, setToUnit] = useState<string>(group.units[group.units.length - 1].id);
  const [value, setValue] = useState<string>("1");

  // Reset units when group changes
  useMemo(() => {
    if (!group.units.find((u) => u.id === fromUnit)) setFromUnit(group.units[0].id);
    if (!group.units.find((u) => u.id === toUnit)) setToUnit(group.units[group.units.length - 1].id);
  }, [group, fromUnit, toUnit]);

  const fromUnitObj = useMemo(() => group.units.find((u) => u.id === fromUnit) ?? group.units[0], [group, fromUnit]);
  const toUnitObj = useMemo(() => group.units.find((u) => u.id === toUnit) ?? group.units[1], [group, toUnit]);

  const v = Number.parseFloat(value);
  const baseAmount = Number.isFinite(v) ? v * fromUnitObj.toBase : 0;
  const resultVal = Number.isFinite(v) ? baseAmount / toUnitObj.toBase : 0;
  const formatted = Number.isFinite(resultVal) ? formatNum(resultVal) : "—";

  return (
    <>
      <div className="calc-unit-form">
        <input
          type="number"
          className="text-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          step="any"
        />
        <select className="text-input" value={fromUnit} onChange={(e) => setFromUnit(e.target.value)}>
          {group.units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        </select>
        <span className="calc-arrow">=</span>
        <input type="text" className="text-input" value={formatted} readOnly />
        <select className="text-input" value={toUnit} onChange={(e) => setToUnit(e.target.value)}>
          {group.units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        </select>
      </div>
      <div className="calc-unit-note">{group.note}</div>
      <div className="calc-unit-grid">
        {group.units.map((u) => (
          <div key={u.id} className="calc-unit-cell">
            <strong>{u.label}</strong>
            <span>{formatNum(baseAmount / u.toBase)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ============ Currency Converter (year-aware) ============

function yearToReignLabel(y: number): string {
  for (const r of MING_REIGNS) {
    if (y >= r.startYear && y <= r.endYear) {
      const n = y - r.startYear + 1;
      return `${r.reign}${n === 1 ? "元" : intToChineseNum(n)}年`;
    }
  }
  return `公元${y}年`;
}

function CurrencyConverter() {
  const [year, setYear] = useState<number>(1528); // 默认 嘉靖七年
  const [fromCur, setFromCur] = useState<Currency>("guan-bao");
  const [amount, setAmount] = useState<string>("1");

  const v = Number.parseFloat(amount);
  const result = useMemo(() => {
    if (!Number.isFinite(v)) return null;
    return convertAll(v, fromCur, year);
  }, [v, fromCur, year]);

  return (
    <div className="calc-currency-root" data-no-convert>
      <div className="calc-year-slider">
        <label>
          <span>年份基准：</span>
          <strong>{yearToReignLabel(year)} （公元 {year} 年）</strong>
        </label>
        <input
          type="range"
          min={1368}
          max={1644}
          step={1}
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        />
        <div className="calc-year-quicks">
          {[
            ["洪武元", 1368],
            ["永乐元", 1403],
            ["宣德元", 1426],
            ["成化元", 1465],
            ["弘治元", 1488],
            ["嘉靖七", 1528],
            ["万历元", 1573],
            ["崇祯元", 1628],
          ].map(([label, y]) => (
            <button
              key={String(label)}
              type="button"
              className={`calc-hint-chip ${year === y ? "is-active" : ""}`}
              onClick={() => setYear(y as number)}
            >
              {label as string}
            </button>
          ))}
        </div>
      </div>

      <div className="calc-currency-form">
        <input
          type="number"
          className="text-input"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          step="any"
        />
        <select className="text-input" value={fromCur} onChange={(e) => setFromCur(e.target.value as Currency)}>
          {CURRENCIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <span className="calc-arrow">→ 等价于：</span>
      </div>

      {result && (
        <>
          <div className="calc-unit-grid">
            {result.rows.map((row) => {
              const meta = CURRENCIES.find((c) => c.id === row.currency)!;
              return (
                <div key={row.currency} className={`calc-unit-cell ${row.currency === fromCur ? "is-source" : ""}`}>
                  <strong>{meta.label}</strong>
                  <span>{formatNum(row.value)}</span>
                  {meta.hint && <em>{meta.hint}</em>}
                </div>
              );
            })}
          </div>
          <CurrencySources ctx={result.ctx} />
        </>
      )}
    </div>
  );
}

function CurrencySources({ ctx }: { ctx: ConversionContext }) {
  const items: { label: string; detail: string }[] = [];
  if (ctx.goldUsed) {
    items.push({
      label: "金银比",
      detail: `${yearToReignLabel(ctx.goldUsed.point.year)} (${ctx.goldUsed.point.year})：1 两黄金 = ${ctx.goldUsed.point.silver} 两银 — ${ctx.goldUsed.point.source}`,
    });
  }
  if (ctx.zhiqianUsed) {
    items.push({
      label: "制钱汇率",
      detail: `${yearToReignLabel(ctx.zhiqianUsed.point.year)} (${ctx.zhiqianUsed.point.year})：1 贯 = ${ctx.zhiqianUsed.point.silver} 两银 — ${ctx.zhiqianUsed.point.source}`,
    });
  }
  if (ctx.baochaoUsed) {
    items.push({
      label: "宝钞官价",
      detail: `${yearToReignLabel(ctx.baochaoUsed.point.year)} (${ctx.baochaoUsed.point.year})：1 贯 = ${ctx.baochaoUsed.point.silver} 两银 — ${ctx.baochaoUsed.point.source}`,
    });
  }
  if (ctx.riceDecadeUsed) {
    items.push({
      label: "米价",
      detail: `${ctx.riceDecadeUsed.from}-${ctx.riceDecadeUsed.to} 年平均：1 公石 米 = ${ctx.riceDecadeUsed.gramsPerGongshi} 公分（克）银 — ${ctx.riceDecadeUsed.source}`,
    });
  }
  if (ctx.modernRiceUsed) {
    items.push({
      label: "现代米价",
      detail: `${MODERN_RICE_DATE} ${MODERN_RICE_SOURCE}：中晚籼稻 ${MODERN_RICE_PRICE_RMB_PER_KG * 1000} 元/吨（折 ${MODERN_RICE_PRICE_RMB_PER_KG} 元/kg；1 公石 ≈ ${GONGSHI_KG} kg；1 两银 = ${SILVER_LIANG_GRAMS} g）`,
    });
  }
  if (!items.length) {
    return <div className="calc-unit-note">本次换算仅涉及银两 / 钱之间的定义性换算，未引用历史汇率。</div>;
  }
  return (
    <div className="calc-sources">
      <div className="calc-sources-title">本次换算引用的汇率基准</div>
      {items.map((it, i) => (
        <div key={i} className="calc-source-row">
          <strong>{it.label}</strong>
          <span>{it.detail}</span>
        </div>
      ))}
    </div>
  );
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs >= 1e6 || abs < 1e-4) return n.toExponential(4);
  if (abs >= 100) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(4).replace(/\.?0+$/, "");
  return n.toFixed(6).replace(/\.?0+$/, "");
}

// ============ Main Component ============

export function HistoricalCalculator() {
  const [tab, setTab] = useState<Tab>("date");
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<DateResult | null>(null);

  const submit = () => {
    if (!draft.trim()) return;
    setResult(parseDateInput(draft));
  };

  return (
    <div className="calc-root">
      <div className="calc-tabs">
        <button
          type="button"
          className={`tab-button ${tab === "date" ? "is-active" : ""}`}
          onClick={() => setTab("date")}
        >
          年号 / 日期换算
        </button>
        <button
          type="button"
          className={`tab-button ${tab === "measure" ? "is-active" : ""}`}
          onClick={() => setTab("measure")}
        >
          度量衡
        </button>
        <button
          type="button"
          className={`tab-button ${tab === "currency" ? "is-active" : ""}`}
          onClick={() => setTab("currency")}
        >
          货币换算
        </button>
      </div>

      {tab === "date" && (
        <div className="calc-date-root">
          <div className="calc-input-row">
            <input
              className="text-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="弘治 / 永乐四年 / 永乐四年正月甲午 / 永乐四年正月三日 / 1644-04-25"
            />
            <button type="button" className="primary-button" onClick={submit} disabled={!draft.trim()}>
              换算
            </button>
          </div>
          <div className="calc-hints">
            <span>支持：</span>
            <button type="button" className="calc-hint-chip" onClick={() => { setDraft("弘治"); }}>弘治</button>
            <button type="button" className="calc-hint-chip" onClick={() => { setDraft("永乐四年"); }}>永乐四年</button>
            <button type="button" className="calc-hint-chip" onClick={() => { setDraft("永乐四年正月甲午"); }}>永乐四年正月甲午</button>
            <button type="button" className="calc-hint-chip" onClick={() => { setDraft("永乐四年正月三日"); }}>永乐四年正月三日</button>
            <button type="button" className="calc-hint-chip" onClick={() => { setDraft("1644-04-25"); }}>1644-04-25</button>
          </div>
          {result && <DateResultView r={result} />}
        </div>
      )}

      {tab === "measure" && <MeasureSection />}
      {tab === "currency" && <CurrencyConverter />}
    </div>
  );
}
