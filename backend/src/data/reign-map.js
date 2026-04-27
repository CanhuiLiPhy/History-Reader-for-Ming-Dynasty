export const MING_REIGNS = [
  { reign: "洪武", emperor: "明太祖朱元璋", startYear: 1368, endYear: 1398 },
  { reign: "建文", emperor: "明惠帝朱允炆", startYear: 1399, endYear: 1402 },
  { reign: "永乐", emperor: "明成祖朱棣", startYear: 1403, endYear: 1424 },
  { reign: "洪熙", emperor: "明仁宗朱高炽", startYear: 1425, endYear: 1425 },
  { reign: "宣德", emperor: "明宣宗朱瞻基", startYear: 1426, endYear: 1435 },
  { reign: "正统", emperor: "明英宗朱祁镇", startYear: 1436, endYear: 1449 },
  { reign: "景泰", emperor: "明代宗朱祁钰", startYear: 1450, endYear: 1456 },
  { reign: "天顺", emperor: "明英宗朱祁镇", startYear: 1457, endYear: 1464 },
  { reign: "成化", emperor: "明宪宗朱见深", startYear: 1465, endYear: 1487 },
  { reign: "弘治", emperor: "明孝宗朱祐樘", startYear: 1488, endYear: 1505 },
  { reign: "正德", emperor: "明武宗朱厚照", startYear: 1506, endYear: 1521 },
  { reign: "嘉靖", emperor: "明世宗朱厚熜", startYear: 1522, endYear: 1566 },
  { reign: "隆庆", emperor: "明穆宗朱载坖", startYear: 1567, endYear: 1572 },
  { reign: "万历", emperor: "明神宗朱翊钧", startYear: 1573, endYear: 1620 },
  { reign: "泰昌", emperor: "明光宗朱常洛", startYear: 1620, endYear: 1620 },
  { reign: "天启", emperor: "明熹宗朱由校", startYear: 1621, endYear: 1627 },
  { reign: "崇祯", emperor: "明思宗朱由检", startYear: 1628, endYear: 1644 }
];

const NUMERAL_MAP = {
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
  两: 2
};

export function chineseNumeralToInt(input) {
  if (!input) return null;
  if (input === "元") return 1;
  if (/^\d+$/.test(input)) return Number.parseInt(input, 10);

  let total = 0;
  let section = 0;
  let number = 0;

  for (const char of input) {
    const value = NUMERAL_MAP[char];
    if (value == null) continue;
    if (value >= 10) {
      if (number === 0) number = 1;
      section += number * value;
      number = 0;
    } else {
      number = value;
    }
  }

  total += section + number;
  return total || null;
}

export function intToChineseNumeral(input) {
  const value = Number.parseInt(String(input || 0), 10);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value === 1) return "元";
  if (value < 10) {
    return ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"][value];
  }

  if (value < 20) {
    return `十${value === 10 ? "" : ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"][value - 10]}`;
  }

  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return `${["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"][tens]}十${
      ones ? ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"][ones] : ""
    }`;
  }

  return String(value);
}

export function reignYearToGregorian(reign, yearText) {
  const reignInfo = MING_REIGNS.find((item) => item.reign === reign);
  if (!reignInfo) return null;

  const year = chineseNumeralToInt(yearText);
  if (!year) return null;

  const gregorian = reignInfo.startYear + year - 1;
  if (gregorian > reignInfo.endYear) return null;

  return {
    reign,
    emperor: reignInfo.emperor,
    year,
    gregorian,
    label: `${reign}${yearText}年`,
    note: `${reignInfo.emperor}在位时期，公元 ${gregorian} 年`
  };
}

const reignNames = MING_REIGNS.map((item) => item.reign).join("|");
const reignRegex = new RegExp(`(${reignNames})(元|[〇零一二三四五六七八九十百千两\\d]+)年`, "g");
const gregorianRegex = /公元\s*(\d{3,4})\s*年/g;

export function extractYearMentions(text) {
  const mentions = [];

  for (const match of text.matchAll(reignRegex)) {
    const result = reignYearToGregorian(match[1], match[2]);
    if (result) {
      mentions.push({
        type: "reign",
        text: match[0],
        gregorian: result.gregorian,
        reign: result.reign,
        emperor: result.emperor,
        note: result.note
      });
    }
  }

  for (const match of text.matchAll(gregorianRegex)) {
    mentions.push({
      type: "gregorian",
      text: match[0],
      gregorian: Number.parseInt(match[1], 10),
      note: `公元 ${match[1]} 年`
    });
  }

  return mentions;
}

export function explainReignTerm(term) {
  const match = term.match(new RegExp(`^(${reignNames})(元|[〇零一二三四五六七八九十百千两\\d]+)年$`));
  if (!match) return null;
  return reignYearToGregorian(match[1], match[2]);
}

export function gregorianToReignYear(input) {
  const gregorian = Number.parseInt(String(input || "").replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(gregorian)) return null;

  const reignInfo = MING_REIGNS.find((item) => gregorian >= item.startYear && gregorian <= item.endYear);
  if (!reignInfo) return null;

  const year = gregorian - reignInfo.startYear + 1;
  const yearText = intToChineseNumeral(year);
  return {
    reign: reignInfo.reign,
    emperor: reignInfo.emperor,
    year,
    gregorian,
    label: `公元${gregorian}年`,
    reignLabel: `${reignInfo.reign}${yearText}年`,
    note: `${reignInfo.emperor}在位时期，对应 ${reignInfo.reign}${yearText}年`
  };
}

export function convertMingYearTerm(term) {
  const cleanTerm = String(term || "").trim();
  if (!cleanTerm) return null;
  return explainReignTerm(cleanTerm) || gregorianToReignYear(cleanTerm);
}
