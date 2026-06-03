/**
 * 明代货币 / 米价时变汇率数据库
 *
 * 基本货币单位 = 银两（1 两 = 37.3 g 银）。
 * 所有汇率以 "1 单位 X = N 两银" 方式表示，N 用浮点数。
 * 宝钞按市官价；制钱、金银亦按官价。
 *
 * 数据来源：
 *   - 米价：彭信威《中国货币史》明代十年期米价表（公石值银公分=克）
 *           缺失的 1411-1420 段按用户指定 11.73 公分补齐。
 *   - 金银比：彭信威表 + 各正史 / 续文献通考 / 续文献通考·钱币考。
 *   - 制钱：彭信威表（每贯合银两数，官价为主）。
 *   - 宝钞：吴慧《大明宝钞价格表》— 官价优先；
 *           洪武末以后宝钞贬值剧烈，多年仅市价记载，本表以官价为基线。
 *   - 现代米价：用户指定 2026-05-26 NFSRA 中晚籼稻市价 2611 元/吨。
 */

export type RatePoint = {
  year: number;          // 公元年（西历）
  silver: number;        // 1 单位 = N 两银
  source: string;
};

// 1 公石（hectoliter）= 100 升 ≈ 78 kg 中晚籼稻（密度按 780 kg/m³ 估算）
export const GONGSHI_KG = 78;
// 现代米价：2026-05-26 NFSRA 中晚籼稻 2611 元/t = 2.611 元/kg
export const MODERN_RICE_PRICE_RMB_PER_KG = 2.611;
export const MODERN_RICE_DATE = "2026-05-26";
export const MODERN_RICE_SOURCE = "NFSRA 统计口径中晚籼稻市价";
// 1 公石现代价值（元）
export const MODERN_GONGSHI_RMB = GONGSHI_KG * MODERN_RICE_PRICE_RMB_PER_KG;
// 1 两银 = 37.3 g 银
export const SILVER_LIANG_GRAMS = 37.3;

// ---- 黄金 → 银 比率（1 两黄金 = N 两银）----
export const GOLD_SILVER_RATES: RatePoint[] = [
  { year: 1368, silver: 5,     source: "明会典·钞法（洪武元年）" },
  { year: 1375, silver: 4,     source: "明史·食货志（洪武八年）" },
  { year: 1385, silver: 5,     source: "明会典 / 明史·赋役（洪武十八年）" },
  { year: 1386, silver: 6,     source: "明实录 / 续文献通考（洪武十九年）" },
  { year: 1395, silver: 5,     source: "明史·食货志（洪武二十八年）" },
  { year: 1397, silver: 5,     source: "明会典（洪武三十年）" },
  { year: 1407, silver: 4.8,   source: "续文献通考·钱币（永乐五年）" },
  { year: 1413, silver: 4.8,   source: "明书（永乐十一年）" },
  { year: 1426, silver: 7.5,   source: "明会典（宣德元年）" },
  { year: 1431, silver: 7.5,   source: "明实录（宣德六年）" },
  { year: 1481, silver: 7,     source: "明会典（成化十七年）" },
  { year: 1502, silver: 9,     source: "明会典（弘治十五年）" },
  { year: 1530, silver: 6,     source: "明会典（嘉靖九年）" },
  { year: 1534, silver: 6.363, source: "天下郡国利病书（嘉靖十三年）" },
  { year: 1568, silver: 8,     source: "名山藏（隆庆二年）" },
  { year: 1572, silver: 8,     source: "明会典（隆庆六年）" },
  { year: 1576, silver: 7.5,   source: "明会典（万历四年）" },
  { year: 1620, silver: 8,     source: "巴塔维亚日志（万历四十八年）" },
  { year: 1635, silver: 10,    source: "日知录·东印度公司记录（崇祯中）" },
];

// ---- 制钱（每贯 = N 两银）---- 官价
export const ZHIQIAN_RATES: RatePoint[] = [
  { year: 1368, silver: 1.00,    source: "明会典（洪武元年）" },
  { year: 1466, silver: 1.25,    source: "明会典（成化二年）" },
  { year: 1488, silver: 1.42857, source: "明会典（弘治元年）" },
  { year: 1529, silver: 1.42857, source: "明会典（嘉靖八年 官价）" },
  { year: 1570, silver: 1.25,    source: "明会典（隆庆四年）" },
  { year: 1576, silver: 1.25,    source: "明会典（万历四年）" },
  { year: 1589, silver: 2.00,    source: "明会典（万历十七年）" },
  { year: 1611, silver: 1.515,   source: "明会典（万历卅九年）" },
];

// ---- 宝钞（每贯 = N 两银）---- 优先官价
export const BAOCHAO_RATES: RatePoint[] = [
  { year: 1376, silver: 1.00,     source: "明史（洪武九年 大明宝钞初定）" },
  { year: 1386, silver: 0.20,     source: "续文献通考（洪武十九年）" },
  { year: 1391, silver: 0.20,     source: "明实录（洪武二十四年）" },
  { year: 1395, silver: 0.07153,  source: "续文献通考（洪武二十八年）" },
  { year: 1407, silver: 0.012,    source: "续文献通考（永乐五年）" },
  { year: 1413, silver: 0.0476,   source: "续文献通考（永乐十一年）" },
  { year: 1426, silver: 0.0025,   source: "明实录（宣德元年）" },
  { year: 1429, silver: 0.0025,   source: "明实录（宣德四年）" },
  { year: 1452, silver: 0.0021,   source: "明会典（景泰元年）" },
  { year: 1456, silver: 0.00142,  source: "续文献通考（景泰七年）" },
  { year: 1465, silver: 0.005,    source: "明会典（成化元年）" },
  { year: 1488, silver: 0.001428, source: "明会典 / 续文献通考（弘治元年）" },
  { year: 1493, silver: 0.001333, source: "续文献通考（弘治六年）" },
  { year: 1501, silver: 0.000625, source: "明史·刑法（弘治十四年）" },
  { year: 1525, silver: 0.003,    source: "明史（嘉靖四年）" },
  { year: 1527, silver: 0.001143, source: "续文献通考（嘉靖六年）" },
  { year: 1528, silver: 0.009,    source: "世宗实录（嘉靖七年 官价）" },
  { year: 1529, silver: 0.003,    source: "续文献通考（嘉靖八年 官价）" },
  { year: 1540, silver: 0.00032,  source: "梁材疏（嘉靖十九年）" },
  { year: 1566, silver: 0.0002,   source: "续文献通考（嘉靖四十五年）" },
  { year: 1567, silver: 0.0006,   source: "续文献通考（隆庆元年）" },
];

// ---- 米价：十年期，每公石 = N 克银（=N "公分"）----
// 数据源：彭信威《中国货币史》明代十年期米价表
// 1411-1420 按用户指定 11.73 公分补齐（原表此段缺失）
export type RiceDecade = {
  from: number;       // 起始年（含）
  to: number;         // 终止年（含）
  gramsPerGongshi: number;
  source: string;
};

export const RICE_DECADES: RiceDecade[] = [
  { from: 1361, to: 1370, gramsPerGongshi: 11.12, source: "彭信威·中国货币史" },
  { from: 1371, to: 1380, gramsPerGongshi: 34.73, source: "彭信威·中国货币史" },
  { from: 1381, to: 1390, gramsPerGongshi: 17.35, source: "彭信威·中国货币史" },
  { from: 1391, to: 1400, gramsPerGongshi: 13.02, source: "彭信威·中国货币史" },
  { from: 1401, to: 1410, gramsPerGongshi: 10.59, source: "彭信威·中国货币史" },
  { from: 1411, to: 1420, gramsPerGongshi: 11.73, source: "用户指定（原表此段缺失）" },
  { from: 1421, to: 1430, gramsPerGongshi: 12.87, source: "彭信威·中国货币史" },
  { from: 1431, to: 1440, gramsPerGongshi: 9.63,  source: "彭信威·中国货币史" },
  { from: 1441, to: 1450, gramsPerGongshi: 10.41, source: "彭信威·中国货币史" },
  { from: 1451, to: 1460, gramsPerGongshi: 12.38, source: "彭信威·中国货币史" },
  { from: 1461, to: 1470, gramsPerGongshi: 15.07, source: "彭信威·中国货币史" },
  { from: 1471, to: 1480, gramsPerGongshi: 14.74, source: "彭信威·中国货币史" },
  { from: 1481, to: 1490, gramsPerGongshi: 18.39, source: "彭信威·中国货币史" },
  { from: 1491, to: 1500, gramsPerGongshi: 22.31, source: "彭信威·中国货币史" },
  { from: 1501, to: 1510, gramsPerGongshi: 21.30, source: "彭信威·中国货币史" },
  { from: 1511, to: 1520, gramsPerGongshi: 17.83, source: "彭信威·中国货币史" },
  { from: 1521, to: 1530, gramsPerGongshi: 20.14, source: "彭信威·中国货币史" },
  { from: 1531, to: 1540, gramsPerGongshi: 21.30, source: "彭信威·中国货币史" },
  { from: 1541, to: 1550, gramsPerGongshi: 20.48, source: "彭信威·中国货币史" },
  { from: 1551, to: 1560, gramsPerGongshi: 22.75, source: "彭信威·中国货币史" },
  { from: 1561, to: 1570, gramsPerGongshi: 22.80, source: "彭信威·中国货币史" },
  { from: 1571, to: 1580, gramsPerGongshi: 19.66, source: "彭信威·中国货币史" },
  { from: 1581, to: 1590, gramsPerGongshi: 24.93, source: "彭信威·中国货币史" },
  { from: 1591, to: 1600, gramsPerGongshi: 24.07, source: "彭信威·中国货币史" },
  { from: 1601, to: 1610, gramsPerGongshi: 26.40, source: "彭信威·中国货币史" },
  { from: 1611, to: 1620, gramsPerGongshi: 22.57, source: "彭信威·中国货币史" },
  { from: 1621, to: 1630, gramsPerGongshi: 28.32, source: "彭信威·中国货币史" },
  { from: 1631, to: 1640, gramsPerGongshi: 33.57, source: "彭信威·中国货币史" },
  { from: 1641, to: 1650, gramsPerGongshi: 47.11, source: "彭信威·中国货币史" },
];

/** 找最近且 ≤ 目标年的汇率点。若全部 > 目标年，取最早一个。 */
export function nearestRate(
  table: RatePoint[],
  year: number,
): { point: RatePoint; usedYear: number } {
  let best: RatePoint = table[0];
  for (const p of table) {
    if (p.year <= year) best = p;
    else break;
  }
  return { point: best, usedYear: best.year };
}

export function decadeForYear(year: number): RiceDecade {
  for (const d of RICE_DECADES) {
    if (year >= d.from && year <= d.to) return d;
  }
  // 边界：早于第一个十年期 → 用第一个；晚于最后 → 用最后
  if (year < RICE_DECADES[0].from) return RICE_DECADES[0];
  return RICE_DECADES[RICE_DECADES.length - 1];
}

// ============================================================
//  统一货币单位定义 — 全部转换为"两银"（在指定 year 下）
// ============================================================

export type Currency =
  | "wen"          // 铜钱（文）
  | "qian-yin"     // 白银（钱）
  | "liang-yin"   // 白银（两）— BASE
  | "liang-jin"    // 黄金（两）
  | "guan-bao"     // 宝钞（贯）
  | "guan-zhi"     // 制钱（贯）
  | "rmb"          // 平价购买力（元，2026 米价）
  | "shi-mi";      // 米（石）= 1 公石

export type CurrencyMeta = {
  id: Currency;
  label: string;
  hint?: string;
};

export const CURRENCIES: CurrencyMeta[] = [
  { id: "wen",        label: "铜钱（文）" },
  { id: "qian-yin",   label: "白银（钱）",  hint: "1 钱 = 0.1 两" },
  { id: "liang-yin",  label: "白银（两）",  hint: "基准单位，1 两 ≈ 37.3 g" },
  { id: "liang-jin",  label: "黄金（两）" },
  { id: "guan-bao",   label: "宝钞（贯）" },
  { id: "guan-zhi",   label: "制钱（贯）",  hint: "1 贯 = 1000 文（官价）" },
  { id: "rmb",        label: "平价购买力（元）", hint: "现代等效，按米价折算" },
  { id: "shi-mi",     label: "米（石）",    hint: "约 1 公石 ≈ 78 kg" },
];

export type ConversionContext = {
  year: number;
  goldUsed?: { point: RatePoint };
  zhiqianUsed?: { point: RatePoint };
  baochaoUsed?: { point: RatePoint };
  riceDecadeUsed?: RiceDecade;
  modernRiceUsed?: boolean;
};

/**
 * 将 1 单位 currency 转换为 "两银" — 同时把使用到的汇率源记录到 ctx。
 */
export function toSilver(currency: Currency, year: number, ctx: ConversionContext): number {
  switch (currency) {
    case "liang-yin": return 1;
    case "qian-yin":  return 0.1;
    case "liang-jin": {
      const { point } = nearestRate(GOLD_SILVER_RATES, year);
      ctx.goldUsed = { point };
      return point.silver;
    }
    case "guan-zhi": {
      const { point } = nearestRate(ZHIQIAN_RATES, year);
      ctx.zhiqianUsed = { point };
      return point.silver;
    }
    case "wen": {
      const { point } = nearestRate(ZHIQIAN_RATES, year);
      ctx.zhiqianUsed = { point };
      return point.silver / 1000;
    }
    case "guan-bao": {
      const { point } = nearestRate(BAOCHAO_RATES, year);
      ctx.baochaoUsed = { point };
      return point.silver;
    }
    case "shi-mi": {
      // 1 石 ≈ 1 公石 → decadeGrams 克银
      const decade = decadeForYear(year);
      ctx.riceDecadeUsed = decade;
      return decade.gramsPerGongshi / SILVER_LIANG_GRAMS;
    }
    case "rmb": {
      // 1 元 → 多少两银？
      // 1 两银 = SILVER_LIANG_GRAMS g = SILVER_LIANG_GRAMS / decadeGrams 公石
      //        = SILVER_LIANG_GRAMS / decadeGrams × MODERN_GONGSHI_RMB 元
      // 反过来 1 元 = decadeGrams / SILVER_LIANG_GRAMS / MODERN_GONGSHI_RMB 两银
      const decade = decadeForYear(year);
      ctx.riceDecadeUsed = decade;
      ctx.modernRiceUsed = true;
      return decade.gramsPerGongshi / SILVER_LIANG_GRAMS / MODERN_GONGSHI_RMB;
    }
  }
}

/** 把 N 两银折算成目标 currency 的数量（同时把所用源记录到 ctx）。 */
export function fromSilver(silver: number, target: Currency, year: number, ctx: ConversionContext): number {
  const unitToSilver = toSilver(target, year, ctx);
  if (unitToSilver === 0) return 0;
  return silver / unitToSilver;
}

/** 主转换接口。 */
export function convertCurrency(
  amount: number,
  from: Currency,
  to: Currency,
  year: number,
): { value: number; ctx: ConversionContext } {
  const ctx: ConversionContext = { year };
  const inSilver = amount * toSilver(from, year, ctx);
  const result = fromSilver(inSilver, to, year, ctx);
  return { value: result, ctx };
}

/** 给定一种来源货币的数量，计算所有 8 种货币的等价值（用于网格展示）。 */
export function convertAll(amount: number, from: Currency, year: number): {
  rows: { currency: Currency; value: number }[];
  ctx: ConversionContext;
} {
  const ctx: ConversionContext = { year };
  const inSilver = amount * toSilver(from, year, ctx);
  const rows = CURRENCIES.map((c) => ({
    currency: c.id,
    value: fromSilver(inSilver, c.id, year, ctx),
  }));
  return { rows, ctx };
}
