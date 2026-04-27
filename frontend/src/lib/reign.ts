const MING_REIGNS = [
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
  { reign: "崇祯", emperor: "明思宗朱由检", startYear: 1628, endYear: 1644 },
];

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
  const reignInfo = MING_REIGNS.find((item) => item.reign === reign);
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

export const REIGN_PATTERN = new RegExp(
  `(${MING_REIGNS.map((item) => item.reign).join("|")})(元|[〇零一二三四五六七八九十百千两\\d]+)年`,
  "g",
);
