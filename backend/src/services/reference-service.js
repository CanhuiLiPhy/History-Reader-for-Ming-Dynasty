import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertMingYearTerm, explainReignTerm, extractYearMentions, MING_REIGNS } from "../data/reign-map.js";
import {
  deriveKeywordsFromText,
  fetchParagraphsByIds,
  getBookCatalogForAI,
  getLibraryOverview,
  getSourceManifest,
  initializeLibrary,
  searchReferenceParagraphs
} from "./library-db.js";
import { getContextSnippets, searchBook } from "./book-service.js";
import { aiReady, getActionPrompt, runPromptTemplate, runStructuredJsonPrompt } from "./ai-service.js";
import { searchWeb } from "./web-search-service.js";
import {
  isAvailable as embeddingAvailable,
  vectorSearch
} from "./embedding-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_ROOT = path.join(__dirname, "../data");
const charactersData = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, "characters.json"), "utf8"));
const emperorsData = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, "emperors.json"), "utf8"));
const geographyData = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, "geography.json"), "utf8"));
const officialsData = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, "officials.json"), "utf8"));
let officialsExtended = { offices: [], sections: [], chronology: [], princes: [], poems: {} };
try {
  officialsExtended = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, "officials-extended.json"), "utf8"));
} catch {
  // optional file; if missing, just use empty structures
}

const SALARY_REFERENCE = {
  正一品: "月俸米参考约 87 石，属最高档俸给。",
  从一品: "月俸米参考约 74 石，属极高档俸给。",
  正二品: "月俸米参考约 61 石，多见于六部尚书、都御史等高官。",
  从二品: "月俸米参考约 48 石，属部院重臣档。",
  正三品: "月俸米参考约 35 石，多见于侍郎、大理寺卿等。",
  从三品: "月俸米参考约 26 石。",
  正四品: "月俸米参考约 24 石。",
  从四品: "月俸米参考约 21 石。",
  正五品: "月俸米参考约 16 石。",
  从五品: "月俸米参考约 14 石。",
  正六品: "月俸米参考约 10 石。",
  从六品: "月俸米参考约 8 石。",
  正七品: "月俸米参考约 7.5 石。",
  从七品: "月俸米参考约 7 石。",
  正八品: "月俸米参考约 6.5 石。",
  从八品: "月俸米参考约 6 石。",
  正九品: "月俸米参考约 5.5 石。",
  从九品: "月俸米参考约 5 石。"
};

const EMPEROR_DETAILS = {
  taizu: {
    birthYear: 1328,
    deathYear: 1398,
    accessionDate: "1368-01-23",
    deathDate: "1398-06-24",
    father: "朱世珍",
    mother: "陈氏",
    predecessor: "无",
    successor: "惠宗朱允炆"
  },
  huizong: {
    birthYear: 1377,
    deathYear: null,
    accessionDate: "1398-06-30",
    deathDate: "1402 后不详",
    father: "懿文太子朱标",
    mother: "吕妃",
    predecessor: "太祖朱元璋",
    successor: "成祖朱棣"
  },
  chengzu: {
    birthYear: 1360,
    deathYear: 1424,
    accessionDate: "1402-07-17",
    deathDate: "1424-08-12",
    father: "太祖朱元璋",
    mother: "马皇后",
    predecessor: "惠宗朱允炆",
    successor: "仁宗朱高炽"
  },
  renzong: {
    birthYear: 1378,
    deathYear: 1425,
    accessionDate: "1424-09-07",
    deathDate: "1425-05-29",
    father: "成祖朱棣",
    mother: "徐皇后",
    predecessor: "成祖朱棣",
    successor: "宣宗朱瞻基"
  },
  xuanzong: {
    birthYear: 1399,
    deathYear: 1435,
    accessionDate: "1425-06-27",
    deathDate: "1435-01-31",
    father: "仁宗朱高炽",
    mother: "张皇后",
    predecessor: "仁宗朱高炽",
    successor: "英宗朱祁镇"
  },
  yingzong: {
    birthYear: 1427,
    deathYear: 1464,
    accessionDate: "1435-01-31",
    deathDate: "1464-02-23",
    father: "宣宗朱瞻基",
    mother: "孙皇后",
    predecessor: "宣宗朱瞻基",
    successor: "代宗朱祁钰 / 宪宗朱见深"
  },
  daizong: {
    birthYear: 1428,
    deathYear: 1457,
    accessionDate: "1449-09-06",
    deathDate: "1457-03-14",
    father: "宣宗朱瞻基",
    mother: "吴贤妃",
    predecessor: "英宗朱祁镇",
    successor: "英宗朱祁镇"
  },
  xianzong: {
    birthYear: 1447,
    deathYear: 1487,
    accessionDate: "1464-02-28",
    deathDate: "1487-09-09",
    father: "英宗朱祁镇",
    mother: "周太后",
    predecessor: "英宗朱祁镇",
    successor: "孝宗朱祐樘"
  },
  xiaozong: {
    birthYear: 1470,
    deathYear: 1505,
    accessionDate: "1487-09-22",
    deathDate: "1505-06-08",
    father: "宪宗朱见深",
    mother: "纪淑妃",
    predecessor: "宪宗朱见深",
    successor: "武宗朱厚照"
  },
  wuzong: {
    birthYear: 1491,
    deathYear: 1521,
    accessionDate: "1505-06-19",
    deathDate: "1521-04-20",
    father: "孝宗朱祐樘",
    mother: "张皇后",
    predecessor: "孝宗朱祐樘",
    successor: "世宗朱厚熜"
  },
  shizong: {
    birthYear: 1507,
    deathYear: 1567,
    accessionDate: "1521-05-27",
    deathDate: "1567-01-23",
    father: "兴献王朱祐杬",
    mother: "蒋太后",
    predecessor: "武宗朱厚照",
    successor: "穆宗朱载坖"
  },
  muzong: {
    birthYear: 1537,
    deathYear: 1572,
    accessionDate: "1567-01-23",
    deathDate: "1572-07-05",
    father: "世宗朱厚熜",
    mother: "杜康妃",
    predecessor: "世宗朱厚熜",
    successor: "神宗朱翊钧"
  },
  shenzong: {
    birthYear: 1563,
    deathYear: 1620,
    accessionDate: "1572-07-19",
    deathDate: "1620-08-18",
    father: "穆宗朱载坖",
    mother: "李太后",
    predecessor: "穆宗朱载坖",
    successor: "光宗朱常洛"
  },
  guangzong: {
    birthYear: 1582,
    deathYear: 1620,
    accessionDate: "1620-08-28",
    deathDate: "1620-09-26",
    father: "神宗朱翊钧",
    mother: "王恭妃",
    predecessor: "神宗朱翊钧",
    successor: "熹宗朱由校"
  },
  xizong: {
    birthYear: 1605,
    deathYear: 1627,
    accessionDate: "1620-10-01",
    deathDate: "1627-09-30",
    father: "光宗朱常洛",
    mother: "王才人",
    predecessor: "光宗朱常洛",
    successor: "思宗朱由检"
  },
  sizong: {
    birthYear: 1611,
    deathYear: 1644,
    accessionDate: "1627-10-02",
    deathDate: "1644-04-25",
    father: "光宗朱常洛",
    mother: "刘昭妃",
    predecessor: "熹宗朱由校",
    successor: "南明安宗朱由崧"
  },
  anexi: {
    birthYear: 1607,
    deathYear: 1646,
    accessionDate: "1644-06-19",
    deathDate: "1646-05-23",
    father: "福恭王朱常洵",
    mother: "姚氏",
    predecessor: "思宗朱由检",
    successor: "南明隆武、绍武诸政权"
  }
};

// Complete genealogical tree based on Wikipedia 明朝皇帝世系图
// isEmperor: true for reigning emperors, false for princes/crown princes
// seq: emperor sequence number (1-19) for display
const EMPEROR_FAMILY_TREE = {
  id: "taizu", isEmperor: true, seq: 1, name: "太祖朱元璋", reign: "1368-1398", life: "1328-1398",
  relation: "开国", summary: "明朝开国皇帝，削平群雄，驱逐蒙元，重建中原王朝秩序。",
  children: [
    {
      id: "zhu-biao", isEmperor: false, name: "懿文太子朱标", life: "1355-1392",
      relation: "嫡长子", summary: "太祖嫡长子，早逝未即位，追谥懿文太子，其子朱允炆继位。",
      children: [
        { id: "huizong", isEmperor: true, seq: 2, name: "惠帝朱允炆", reign: "1398-1402", life: "1377-?",
          relation: "朱标之子", summary: "即位后推行削藩，终因靖难之役失国，下落不明。", children: [] }
      ]
    },
    {
      id: "chengzu", isEmperor: true, seq: 3, name: "成祖朱棣", reign: "1402-1424", life: "1360-1424",
      relation: "第四子", summary: "靖难之变夺位，迁都北京，派郑和下西洋，编修《永乐大典》。",
      children: [
        {
          id: "renzong", isEmperor: true, seq: 4, name: "仁宗朱高炽", reign: "1424-1425", life: "1378-1425",
          relation: "成祖长子", summary: "在位不足一年，调整永乐后期苛政，政治趋向宽和。",
          children: [
            {
              id: "xuanzong", isEmperor: true, seq: 5, name: "宣宗朱瞻基", reign: "1425-1435", life: "1398-1435",
              relation: "仁宗长子", summary: "与仁宗合称'仁宣之治'，明初政治稳定期。",
              children: [
                {
                  id: "yingzong", isEmperor: true, seq: 6, name: "英宗朱祁镇", reign: "1435-1449,1457-1464", life: "1427-1464",
                  relation: "宣宗长子", summary: "土木之变被俘，景泰八年南宫复辟，两次在位。",
                  children: [
                    {
                      id: "xianzong", isEmperor: true, seq: 8, name: "宪宗朱见深", reign: "1464-1487", life: "1447-1487",
                      relation: "英宗长子", summary: "成化朝厂卫势力上升，朝政与边务并重。",
                      children: [
                        {
                          id: "xiaozong", isEmperor: true, seq: 9, name: "孝宗朱祐樘", reign: "1487-1505", life: "1470-1505",
                          relation: "宪宗第三子", summary: "勤政节俭，弘治中兴，明中后期较清明时期。",
                          children: [
                            { id: "wuzong", isEmperor: true, seq: 10, name: "武宗朱厚照", reign: "1505-1521", life: "1491-1521",
                              relation: "孝宗长子", summary: "行止多争议，无嗣而终，由堂弟入继。", children: [] }
                          ]
                        },
                        {
                          id: "ruizong", isEmperor: false, name: "睿宗朱祐杬", life: "1476-1519",
                          relation: "宪宗第四子", summary: "兴献王，世宗之父，追尊为睿宗。",
                          children: [
                            {
                              id: "shizong", isEmperor: true, seq: 11, name: "世宗朱厚熜", reign: "1521-1567", life: "1507-1567",
                              relation: "睿宗之子", summary: "武宗无嗣以堂弟入继；大礼议、倭患、严嵩专权。",
                              children: [
                                {
                                  id: "muzong", isEmperor: true, seq: 12, name: "穆宗朱载坖", reign: "1567-1572", life: "1537-1572",
                                  relation: "世宗第三子", summary: "隆庆开关与俺答封贡，边政转向影响深远。",
                                  children: [
                                    {
                                      id: "shenzong", isEmperor: true, seq: 13, name: "神宗朱翊钧", reign: "1572-1620", life: "1563-1620",
                                      relation: "穆宗第三子", summary: "前期张居正改革，后期国本之争与怠朝致朝政积弊。",
                                      children: [
                                        {
                                          id: "guangzong", isEmperor: true, seq: 14, name: "光宗朱常洛", reign: "1620", life: "1582-1620",
                                          relation: "神宗长子", summary: "在位仅一月，红丸案为晚明宫廷政治重要事件。",
                                          children: [
                                            { id: "xizong", isEmperor: true, seq: 15, name: "熹宗朱由校", reign: "1620-1627", life: "1604-1627",
                                              relation: "光宗长子", summary: "魏忠贤专权、东林党争激化，无嗣而终。", children: [] },
                                            { id: "sizong", isEmperor: true, seq: 16, name: "思宗朱由检", reign: "1627-1644", life: "1611-1644",
                                              relation: "光宗第五子", summary: "崇祯帝，面对内忧外患竭力支撑，自缢殉国。",
                                              children: [
                                                { id: "zhu-cilang", isEmperor: false, name: "献愍太子朱慈烺", life: "1629-1644?",
                                                  relation: "思宗长子", summary: "甲申之变后下落不明。", children: [] }
                                              ]
                                            }
                                          ]
                                        },
                                        {
                                          id: "zhu-changxun", isEmperor: false, name: "福忠王朱常洵", life: "1586-1641",
                                          relation: "神宗第三子", summary: "国本之争核心人物，崇祯十四年被李自成所杀。",
                                          children: [
                                            { id: "anexi", isEmperor: true, seq: 17, name: "安宗朱由崧", reign: "1644-1645", life: "1607-1646",
                                              relation: "福王之子", summary: "南明弘光帝，明亡后在南京即位。", children: [] }
                                          ]
                                        },
                                        {
                                          id: "zhu-changying", isEmperor: false, name: "桂端王朱常瀛", life: "1597-1645",
                                          relation: "神宗第七子", summary: "桂王，昭宗之父。",
                                          children: [
                                            { id: "zhaozong", isEmperor: true, seq: 19, name: "昭宗朱由榔", reign: "1646-1662", life: "1623-1662",
                                              relation: "桂王之子", summary: "南明永历帝，南明最后一帝，被吴三桂所杀。", children: [] }
                                          ]
                                        }
                                      ]
                                    }
                                  ]
                                }
                              ]
                            }
                          ]
                        }
                      ]
                    }
                  ]
                },
                {
                  id: "daizong", isEmperor: true, seq: 7, name: "景帝朱祁钰", reign: "1449-1457", life: "1428-1457",
                  relation: "宣宗次子", summary: "土木之变后代兄即位，主持北京保卫战，后英宗复辟被废。",
                  children: []
                }
              ]
            },
            {
              id: "zhu-zhanao", isEmperor: false, name: "淮靖王朱瞻墺", life: "1409-1446",
              relation: "仁宗第七子", summary: "淮王一系始封，传至南明。",
              children: [
                { id: "zhu-qiquan", isEmperor: false, name: "淮康王朱祁铨", life: "1435-1502",
                  relation: "淮靖王之子", summary: "淮王传承。",
                  children: [
                    { id: "zhu-jiandian", isEmperor: false, name: "淮端王朱见淀", life: "?-1502",
                      relation: "淮康王之子", summary: "淮王传承。",
                      children: [
                        { id: "zhu-youkui", isEmperor: false, name: "淮庄王朱祐楑", life: "1500-1537",
                          relation: "淮端王之子", summary: "淮王传承。",
                          children: [
                            { id: "zhu-houcan", isEmperor: false, name: "淮宪王朱厚燽", life: "1519-1563",
                              relation: "淮庄王之子", summary: "淮王传承。",
                              children: [
                                { id: "zhu-zaijian", isEmperor: false, name: "淮顺王朱载坚", life: "",
                                  relation: "淮宪王之子", summary: "淮王传承。",
                                  children: [
                                    { id: "zhu-yiju", isEmperor: false, name: "淮王朱翊钜", life: "",
                                      relation: "淮顺王之子", summary: "淮王传承。",
                                      children: [
                                        { id: "zhu-changqing", isEmperor: false, name: "淮王朱常清", life: "?-1649",
                                          relation: "淮王朱翊钜之子", summary: "南明淮王，崇祯末自称监国。", children: [] }
                                      ]
                                    }
                                  ]
                                }
                              ]
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      id: "zhu-jing", isEmperor: false, name: "唐定王朱桱", life: "1388-1415",
      relation: "太祖第二十三子", summary: "唐王一系始封，传至南明绍宗。",
      children: [
        { id: "zhu-qiongdi", isEmperor: false, name: "唐宪王朱琼炟", life: "1412-1475",
          relation: "唐定王之子", summary: "唐王传承。",
          children: [
            { id: "zhu-zhizhi", isEmperor: false, name: "唐庄王朱芝址", life: "1432-1485",
              relation: "唐宪王之子", summary: "唐王传承。",
              children: [
                { id: "zhu-miqian", isEmperor: false, name: "唐恭王朱弥钳", life: "?-1516",
                  relation: "唐庄王之子", summary: "唐王传承。",
                  children: [
                    { id: "zhu-yuwen", isEmperor: false, name: "唐敬王朱宇温", life: "1485-1560",
                      relation: "唐恭王之子", summary: "唐王传承。",
                      children: [
                        { id: "zhu-zhougui", isEmperor: false, name: "唐顺王朱宙栐", life: "1538-1564",
                          relation: "唐敬王之子", summary: "唐王传承。",
                          children: [
                            { id: "zhu-shuohuo", isEmperor: false, name: "唐端王朱硕熿", life: "?-1630",
                              relation: "唐顺王之子", summary: "唐王传承。",
                              children: [
                                { id: "zhu-qishang", isEmperor: false, name: "唐裕王朱器墭", life: "?-1629",
                                  relation: "唐端王之子", summary: "绍宗之父。",
                                  children: [
                                    { id: "shaozong", isEmperor: true, seq: 18, name: "绍宗朱聿键", reign: "1645-1646", life: "1602-1646",
                                      relation: "唐裕王之子", summary: "南明隆武帝，在福州称帝，后被清军俘杀。", children: [] }
                                  ]
                                }
                              ]
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  ]
};

function normalizeTerm(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/[，。、《》？：；！“”‘’（）()【】\[\]·]/g, "")
    .toLowerCase();
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function getSalaryReference(rankText = "") {
  const matchedRank = Object.keys(SALARY_REFERENCE).find((rank) => String(rankText).includes(rank));
  return matchedRank ? SALARY_REFERENCE[matchedRank] : "俸禄受品级、兼衔、折色和差遣影响，需结合具体职名细读《食货志》《会典》材料。";
}

function buildEmperorProfiles() {
  return emperorsData.timeline.map((item) => ({
    ...item,
    ...(EMPEROR_DETAILS[item.id] || {}),
    reignRangeLabel: `${item.startYear}-${item.endYear}`
  }));
}

function buildOfficialsProfiles() {
  return officialsData.institutions.map((item) => ({
    ...item,
    salaryReference: getSalaryReference(item.rank)
  }));
}

function buildSearchText(parts = []) {
  return normalizeTerm(parts.filter(Boolean).join(" "));
}

function scoreCandidate(query, entryText, extraTokens = []) {
  if (!query || !entryText) return 0;
  if (entryText === query) return 120;
  if (entryText.includes(query)) return 90;
  if (query.includes(entryText) && entryText.length >= 2) return 78;

  let score = 0;
  for (const token of extraTokens) {
    const normalized = normalizeTerm(token);
    if (normalized && query.includes(normalized)) score += 12;
    if (normalized && normalized.includes(query) && query.length >= 2) score += 8;
  }

  return score;
}

function buildReferenceEntries() {
  const entries = [];

  for (const item of officialsData.institutions) {
    entries.push({
      id: item.id,
      type: "official",
      title: item.name,
      subtitle: item.rank,
      searchText: buildSearchText([item.name, ...(item.aliases || []), ...(item.keywords || []), ...(item.subunits || [])]),
      payload: item
    });
  }

  for (const item of emperorsData.timeline) {
    entries.push({
      id: item.id,
      type: "emperor",
      title: item.name,
      subtitle: `${item.templeName} · ${item.reignTitles.join(" / ")} · ${item.startYear}-${item.endYear}`,
      searchText: buildSearchText([
        item.name,
        item.templeName,
        item.posthumousTitle,
        ...(item.reignTitles || []),
        ...(item.aliases || [])
      ]),
      payload: item
    });
  }

  for (const item of geographyData.regions) {
    entries.push({
      id: item.id,
      type: "geography",
      title: item.name,
      subtitle: item.modernEquivalent,
      searchText: buildSearchText([item.name, ...(item.aliases || []), item.modernEquivalent]),
      payload: item
    });
  }

  for (const item of charactersData.characters) {
    entries.push({
      id: item.id,
      type: "character",
      title: item.name,
      subtitle: item.summary,
      searchText: buildSearchText([item.name, ...(item.aliases || []), ...(item.keywords || [])]),
      payload: item
    });
  }

  return entries;
}

const REFERENCE_ENTRIES = buildReferenceEntries();
const EMPEROR_PROFILES = buildEmperorProfiles();
const OFFICIAL_PROFILES = buildOfficialsProfiles();

const MING_PLACE_INDEX = [
  { id: "yingtian", name: "应天府", aliases: ["南京", "金陵", "南直隶"], modernName: "江苏省南京市", lat: 32.0603, lng: 118.7969, kind: "府", note: "明初首都，永乐后为南京陪都。" },
  { id: "shuntian", name: "顺天府", aliases: ["北京", "京师", "北直隶"], modernName: "北京市", lat: 39.9042, lng: 116.4074, kind: "府", note: "永乐以后明代政治中心。" },
  { id: "fengyang", name: "凤阳府", aliases: ["濠州", "中都"], modernName: "安徽省滁州市凤阳县", lat: 32.8757, lng: 117.5612, kind: "府", note: "太祖故里，中都所在。" },
  { id: "kaifeng", name: "开封府", aliases: ["汴梁", "北京"], modernName: "河南省开封市", lat: 34.7973, lng: 114.3076, kind: "府", note: "洪武初曾定为北京。" },
  { id: "xian", name: "西安府", aliases: ["西安", "陕西布政司治"], modernName: "陕西省西安市", lat: 34.3416, lng: 108.9398, kind: "府", note: "西北重镇。" },
  { id: "suzhou", name: "苏州府", aliases: ["平江", "吴县"], modernName: "江苏省苏州市", lat: 31.2989, lng: 120.5853, kind: "府", note: "江南财赋重地。" },
  { id: "hangzhou", name: "杭州府", aliases: ["临安"], modernName: "浙江省杭州市", lat: 30.2741, lng: 120.1551, kind: "府", note: "浙江省会与江南都会。" },
  { id: "yangzhou", name: "扬州府", aliases: ["广陵"], modernName: "江苏省扬州市", lat: 32.3942, lng: 119.4129, kind: "府", note: "运河与盐务重地。" },
  { id: "jinan", name: "济南府", aliases: ["济南"], modernName: "山东省济南市", lat: 36.6512, lng: 117.1201, kind: "府", note: "山东布政司治。" },
  { id: "taiyuan", name: "太原府", aliases: ["太原"], modernName: "山西省太原市", lat: 37.8706, lng: 112.5489, kind: "府", note: "山西腹地重镇。" },
  { id: "datong", name: "大同府", aliases: ["大同", "大同镇"], modernName: "山西省大同市", lat: 40.0768, lng: 113.3001, kind: "府/边镇", note: "九边重镇之一。" },
  { id: "wuchang", name: "武昌府", aliases: ["武昌", "湖广布政司治"], modernName: "湖北省武汉市武昌区", lat: 30.5465, lng: 114.3419, kind: "府", note: "湖广政治中心。" },
  { id: "changsha", name: "长沙府", aliases: ["长沙"], modernName: "湖南省长沙市", lat: 28.2282, lng: 112.9388, kind: "府", note: "湖广南部重镇。" },
  { id: "nanchang", name: "南昌府", aliases: ["洪都", "龙兴"], modernName: "江西省南昌市", lat: 28.6829, lng: 115.8582, kind: "府", note: "江西布政司治。" },
  { id: "fuzhou", name: "福州府", aliases: ["福州"], modernName: "福建省福州市", lat: 26.0745, lng: 119.2965, kind: "府", note: "福建布政司治。" },
  { id: "guangzhou", name: "广州府", aliases: ["广州"], modernName: "广东省广州市", lat: 23.1291, lng: 113.2644, kind: "府", note: "南海贸易门户。" },
  { id: "guilin", name: "桂林府", aliases: ["桂林"], modernName: "广西壮族自治区桂林市", lat: 25.2345, lng: 110.1799, kind: "府", note: "广西政治中心。" },
  { id: "yunnanfu", name: "云南府", aliases: ["昆明", "云南布政司治"], modernName: "云南省昆明市", lat: 25.0389, lng: 102.7183, kind: "府", note: "云南省会。" },
  { id: "guiyang", name: "贵阳府", aliases: ["贵阳"], modernName: "贵州省贵阳市", lat: 26.6477, lng: 106.6302, kind: "府", note: "贵州建省后政治中心。" },
  { id: "liaoyang", name: "辽阳", aliases: ["辽东都司", "辽阳城"], modernName: "辽宁省辽阳市", lat: 41.2672, lng: 123.2369, kind: "都司/卫", note: "明代辽东军事中心之一。" },
  { id: "ningbo", name: "宁波府", aliases: ["明州"], modernName: "浙江省宁波市", lat: 29.8683, lng: 121.5440, kind: "府", note: "东南海防与贸易港口。" },
  { id: "quanzhou", name: "泉州府", aliases: ["泉州"], modernName: "福建省泉州市", lat: 24.8741, lng: 118.6757, kind: "府", note: "福建沿海重镇。" },
  { id: "songjiang", name: "松江府", aliases: ["华亭"], modernName: "上海市松江区", lat: 31.0326, lng: 121.2277, kind: "府", note: "江南棉纺与海防重地。" },
  { id: "zhenjiang", name: "镇江府", aliases: ["镇江"], modernName: "江苏省镇江市", lat: 32.1878, lng: 119.4250, kind: "府", note: "长江与运河要冲。" },
  { id: "huizhou", name: "徽州府", aliases: ["新安"], modernName: "安徽省黄山市歙县", lat: 29.8617, lng: 118.4158, kind: "府", note: "徽商与文教重地。" },
  { id: "anqing", name: "安庆府", aliases: ["安庆"], modernName: "安徽省安庆市", lat: 30.5435, lng: 117.0638, kind: "府", note: "长江中下游军事交通节点。" },
  { id: "linqing", name: "临清州", aliases: ["临清"], modernName: "山东省聊城市临清市", lat: 36.8383, lng: 115.7049, kind: "州", note: "运河商贸重镇。" },
  { id: "dengzhou", name: "登州府", aliases: ["登州"], modernName: "山东省烟台市蓬莱区", lat: 37.8110, lng: 120.7588, kind: "府", note: "山东半岛海防要地。" },
  { id: "jizhou", name: "蓟州", aliases: ["蓟镇", "蓟州镇"], modernName: "天津市蓟州区", lat: 40.0458, lng: 117.4083, kind: "州/边镇", note: "京畿北部防务要地。" }
];

function formatLocalEntry(match) {
  if (match.type === "official") {
    return {
      type: match.type,
      title: match.title,
      subtitle: match.subtitle,
      summary: match.payload.responsibilities?.[0] || "",
      details: {
        aliases: match.payload.aliases || [],
        rank: match.payload.rank,
        salaryReference: getSalaryReference(match.payload.rank),
        responsibilities: match.payload.responsibilities || [],
        subunits: match.payload.subunits || []
      }
    };
  }

  if (match.type === "emperor") {
    return {
      type: match.type,
      title: match.payload.name,
      subtitle: `${match.payload.templeName} · ${match.payload.reignTitles.join(" / ")}`,
      summary: match.payload.summary,
      details: {
        aliases: match.payload.aliases || [],
        posthumousTitle: match.payload.posthumousTitle,
        startYear: match.payload.startYear,
        endYear: match.payload.endYear,
        reignTitles: match.payload.reignTitles || [],
        birthYear: EMPEROR_DETAILS[match.payload.id]?.birthYear || null,
        deathYear: EMPEROR_DETAILS[match.payload.id]?.deathYear || null
      }
    };
  }

  if (match.type === "geography") {
    return {
      type: match.type,
      title: match.payload.name,
      subtitle: match.payload.modernEquivalent,
      summary: match.payload.summary,
      details: {
        aliases: match.payload.aliases || [],
        kind: match.payload.kind,
        modernEquivalent: match.payload.modernEquivalent
      }
    };
  }

  return {
    type: match.type,
    title: match.payload.name,
    subtitle: match.payload.summary,
    summary: match.payload.summary,
    details: {
      aliases: match.payload.aliases || [],
      career: match.payload.career || [],
      keywords: match.payload.keywords || []
    }
  };
}

function lookupLocalEntries(query) {
  const normalized = normalizeTerm(query);
  if (!normalized) return [];

  const scored = [];
  for (const entry of REFERENCE_ENTRIES) {
    const base = scoreCandidate(normalized, entry.searchText, [entry.title, entry.subtitle]);
    if (!base) continue;
    scored.push({
      ...entry,
      matchScore: base
    });
  }

  return scored.sort((a, b) => b.matchScore - a.matchScore).slice(0, 6).map(formatLocalEntry);
}

function formatGlossContext(query, localMatches) {
  const reignMatch = explainReignTerm(query);
  const lines = [];
  if (reignMatch) {
    lines.push(`【年号换算】${query} => ${reignMatch.gregorian} 年，${reignMatch.emperor}`);
  }

  for (const match of localMatches) {
    lines.push(`【${match.type}】${match.title}`);
    if (match.subtitle) lines.push(match.subtitle);
    if (match.summary) lines.push(match.summary);
    for (const [key, value] of Object.entries(match.details || {})) {
      if (!value || (Array.isArray(value) && !value.length)) continue;
      lines.push(`${key}: ${Array.isArray(value) ? value.join("、") : JSON.stringify(value)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim() || "暂无匹配到的本地结构化资料。";
}

function buildLocalGlossFallback(query, localMatches) {
  const first = localMatches[0];
  const reignMatch = explainReignTerm(query);
  const parts = [];

  if (first) {
    parts.push(`最短定义：${first.title}。${first.summary || first.subtitle || ""}`);
    if (first.type === "official") {
      parts.push(`身份/性质：${first.subtitle}`);
      parts.push(`时代位置：明代中央机构。`);
      parts.push(`阅读提示：重点关注 ${first.details.responsibilities?.slice(0, 2).join("；")}。`);
    } else if (first.type === "emperor") {
      parts.push(`身份/性质：${first.subtitle}`);
      parts.push(`时代位置：${first.details.startYear} 至 ${first.details.endYear} 年。`);
      parts.push(`阅读提示：${first.summary}`);
    } else {
      parts.push(`身份/性质：${first.subtitle || first.summary}`);
      parts.push(`时代位置：明代语境下常见条目。`);
      parts.push(`阅读提示：${first.summary}`);
    }
  }

  if (reignMatch) {
    parts.push(`年号补充：${query} 对应公元 ${reignMatch.gregorian} 年，属 ${reignMatch.emperor} 时期。`);
  }

  return parts.join("\n\n") || "当前本地资料未匹配到明确条目。";
}

function formatBookContextRows(rows) {
  if (!rows.length) return "暂无书内上下文。";
  return rows.map((item) => `【书内片段 ${item.index}｜${item.chapterTitle}】\n${item.snippet}`).join("\n\n");
}

function formatWebResultsRows(rows) {
  if (!rows.length) return "暂无网页搜索结果。";
  return rows
    .map((item, index) => `【网页 ${index + 1}｜${item.title}】\n来源：${item.source || item.url}\n摘要：${item.snippet || "无摘要"}`)
    .join("\n\n");
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function mergeSearchTerms(...groups) {
  return unique(
    groups
      .flat()
      .map((item) => String(item || "").trim())
      .filter((item) => item.length >= 2)
  );
}

// Per-slug priority bonus. Higher slugs get search-result boost so the QA
// chain prefers them when relevance is otherwise comparable. Tiers:
//   60 - 明实录（最权威官修）
//   40 - 明史纪事本末 / 国榷 / 石匮书 / 明史（同档高质量正史与编年）
//   30 - 明史四库本 / 其它（默认值，最低）
const SOURCE_PRIORITY_DEFAULT = 30;
const SOURCE_PRIORITY = {
  "ming-shi-lu": 60,
  "mingshi-jishi-benmo": 40,
  "guoque": 40,
  "shiku-shu": 40,
  "ming-shi": 40,
  "siku-mingshi": 30,
};

function scoreReferenceContext(item, tokens = []) {
  const text = normalizeTerm(`${item.bookTitle} ${item.chapter} ${item.content}`);
  let score = 0;
  for (const token of tokens) {
    const normalized = normalizeTerm(token);
    if (!normalized) continue;
    if (text.includes(normalized)) score += Math.max(8, normalized.length * 2);
  }
  const priority = SOURCE_PRIORITY[item.bookSlug] ?? SOURCE_PRIORITY_DEFAULT;
  return score + (item.score || 0) + priority;
}

function buildReferenceSearchPlan(data = {}) {
  return {
    // Default true for backwards compat: if the AI didn't return the field
    // (older planner runs / fallback path), assume the question wants library
    // lookup. The new prompt explicitly sets false for chitchat / off-topic.
    needsLibraryLookup: data.needsLibraryLookup !== false,
    selectionRelevant: data.selectionRelevant !== false,
    needWebSearch: Boolean(data.needWebSearch),
    people: unique([...(data.people || []), ...(data.personAliases || [])]).slice(0, 12),
    events: unique([...(data.events || []), ...(data.eventAliases || [])]).slice(0, 10),
    institutions: unique(data.institutions || []).slice(0, 8),
    places: unique([...(data.places || []), ...(data.entities || [])]).slice(0, 10),
    keywords: unique(data.keywords || []).slice(0, 10),
    timeHints: unique(data.timeHints || []).slice(0, 6),
    webQuery: String(data.webQuery || "").trim(),
    note: String(data.note || data.coreEventSummary || "").trim(),
    // Natural-language text used by embedding-service to run vector KNN
    // search and RRF-fuse with FTS5 candidates. Empty → embedding step
    // skipped (FTS5-only fallback, identical to pre-v1.2 behavior).
    embeddingQuery: String(data.embeddingQuery || "").trim()
  };
}

// Drop reference contexts that the AI judges irrelevant to the question.
// One small-model call returning a JSON array of "kept" indices. Cheaper than
// asking the main QA model to filter inline (which is unreliable to parse).
export async function filterRelevantReferences({ question, selection, references, aiSettings }) {
  if (!references.length || !aiReady(aiSettings)) return references;
  // For tiny questions and tiny reference sets, skip the filter — overhead
  // would be larger than the benefit.
  if (references.length <= 1) return references;
  const promptList = references
    .map((item, i) => `[${i + 1}] 《${item.bookTitle}》${item.chapter}：${String(item.content || "").slice(0, 200)}`)
    .join("\n");
  try {
    const { data } = await runStructuredJsonPrompt({
      prompt: {
        system: "你是史料相关性评审助手。判断哪些片段与用户问题或选段直接相关（指向同一人物、同一事件、或构成因果衔接），剔除无关片段。只输出 JSON。",
        userTemplate: `用户问题：{{question}}\n用户选段：{{selection}}\n\n候选片段（编号从 1 开始）：\n{{context}}\n\n输出 JSON：{"keep": [...编号]}\n\n判定标准：\n- 片段必须与问题/选段中的人物（包括字号、谥号、庙号等异名）、事件、制度、地名、时代有具体内容呼应才算相关；\n- 仅含相同朝代 / 模糊背景信息不算相关；\n- 注意保留多书互证、多角度记载的相关片段，不要因为已有一条就舍弃后续；\n- 同名异人 / 时代错位 / 巧合用词必须剔除；\n- 如果都不相关，输出 {"keep": []}\n- 不要输出 markdown`
      },
      variables: { question, selection, context: promptList },
      aiSettings,
      temperature: 0,
      maxTokens: 600,
      modelStrategy: "small",
    });
    const keep = Array.isArray(data?.keep)
      ? data.keep.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= references.length)
      : [];
    if (!keep.length) return [];
    const set = new Set(keep);
    return references.filter((_, i) => set.has(i + 1));
  } catch {
    // On any error, be conservative: keep all (current behavior).
    return references;
  }
}

async function buildQuestionPlan({ selection, question, bookContext, aiSettings }) {
  // 喂给 embedding KNN 的自然语句：优先用问题 + 选段拼接（如果有），
  // 否则单独用其中一个。比纯关键词更能命中语义近邻。
  const embeddingQuery = [question, selection].filter((s) => s && s.trim()).join("\n").slice(0, 1000);

  if (!aiReady(aiSettings)) {
    return buildReferenceSearchPlan({
      selectionRelevant: Boolean(selection.trim()),
      needWebSearch: !selection.trim(),
      keywords: deriveKeywordsFromText(`${question} ${selection}`),
      webQuery: question || selection,
      embeddingQuery,
      note: "AI 未启用，使用本地关键词回退。"
    });
  }

  try {
    const plan = await runStructuredJsonPrompt({
      prompt: getActionPrompt("qaPlan"),
      variables: {
        selection,
        question,
        context: formatBookContextRows(bookContext)
      },
      aiSettings,
      temperature: 0.1,
      maxTokens: 500,
      modelStrategy: "small"
    });
    return buildReferenceSearchPlan({ ...plan.data, embeddingQuery });
  } catch {
    return buildReferenceSearchPlan({
      selectionRelevant: Boolean(selection.trim()),
      needWebSearch: !selection.trim(),
      keywords: deriveKeywordsFromText(`${question} ${selection}`),
      webQuery: question || selection,
      embeddingQuery
    });
  }
}

/**
 * Collect reference contexts with optional AI-guided book scoping.
 * @param {object} plan - search plan with people, events, keywords, etc.
 * @param {number} limit - max results
 * @param {object} [aiSettings] - if provided, uses AI to narrow book scope first
 */
async function collectReferenceContexts(plan, limit = 10, aiSettings = null, tokenTracker = null, excludeSlug = "ming-shi") {
  const T0 = Date.now();
  const tlog = (label) => console.log(`[collectRefs] +${((Date.now()-T0)/1000).toFixed(1)}s ${label}`);
  const SEARCH_LIMIT = 200;

  // FAST PATH: embedding 可用 + 有自然语言查询 → 完全跳过 AI 选书 + FTS5 关键词检索 + 启发式打分。
  // vec KNN 已经在全 22 本书库做语义近邻搜索，比 LLM「选书 → 关键词 OR 匹配」更准更省。
  // 失败时 (vec 返 0 或 sidecar 挂) 才走 SLOW PATH 兜底。
  let scored = [];
  let bookSlugs = [];
  const useEmbeddingFastPath = plan.embeddingQuery && embeddingAvailable() && plan.embeddingQuery.length >= 2;
  let embeddingPathSucceeded = false;

  if (useEmbeddingFastPath) {
    try {
      tlog("FAST PATH: pure embedding vec KNN (skip AI scoping + FTS5)...");
      const vecResults = await vectorSearch(plan.embeddingQuery, 200);
      tlog(`vec returned ${vecResults.length} candidates`);
      if (vecResults.length > 0) {
        const ids = vecResults.map((v) => v.paragraph_id);
        const rows = fetchParagraphsByIds(ids, excludeSlug);
        const byId = new Map(rows.map((r) => [r.paragraphId, r]));
        scored = vecResults
          .map((v) => {
            const row = byId.get(v.paragraph_id);
            if (!row) return null;
            return { ...row, relevance: 1000 - v.distance, _vecDistance: v.distance };
          })
          .filter(Boolean)
          .slice(0, 200);
        tlog(`FAST PATH done — ${scored.length} candidates`);
        embeddingPathSucceeded = true;
      } else {
        tlog("vec returned 0 — falling back to FTS5 slow path");
      }
    } catch (err) {
      tlog(`embedding FAILED ${err?.name}: ${String(err?.message || "").slice(0, 100)} — falling back to FTS5 slow path`);
    }
  }

  // SLOW PATH: 嵌入不可用 / 查询过短 / vec 返 0 → 旧的 FTS5 + AI 选书 + 启发式打分流程
  if (!embeddingPathSucceeded) {
    // Step 1: AI-guided book scoping
    if (aiReady(aiSettings)) {
      try {
        tlog("SLOW PATH STEP 1: AI book scoping (small model)...");
        const catalog = getBookCatalogForAI(excludeSlug);
        const searchHint = [
          plan.people.length ? `人物：${plan.people.join("、")}` : "",
          plan.events.length ? `事件：${plan.events.join("、")}` : "",
          plan.keywords.length ? `关键词：${plan.keywords.join("、")}` : "",
          plan.timeHints.length ? `时间：${plan.timeHints.join("、")}` : "",
        ].filter(Boolean).join("；");

        const scopeResult = await runStructuredJsonPrompt({
          prompt: {
            system: "你是明史研究资料检索助手。根据用户的检索需求，从资料库中选出最可能包含相关内容的书。只输出JSON。",
            userTemplate: `检索需求：{{selection}}\n\n资料库目录：\n{{context}}\n\n请选出所有可能相关的书的slug（不要遗漏），输出JSON：{"slugs":[...]}`
          },
          variables: { selection: searchHint, context: catalog },
          aiSettings,
          temperature: 0.1,
          maxTokens: 300,
          modelStrategy: "small"
        });
        if (tokenTracker && scopeResult.usage) { tokenTracker.small.prompt += scopeResult.usage.prompt_tokens || 0; tokenTracker.small.completion += scopeResult.usage.completion_tokens || 0; tokenTracker.small.calls += 1; }
        bookSlugs = unique(scopeResult.data?.slugs || []).slice(0, 10);
        tlog(`SLOW PATH STEP 1 done model=${scopeResult.model} books=${bookSlugs.length} (${bookSlugs.join(',')})`);
      } catch (err) {
        tlog(`SLOW PATH STEP 1 FAILED ${err?.name}: ${String(err?.message || '').slice(0,80)} — fallback to search all`);
      }
    } else {
      tlog("SLOW PATH STEP 1 skipped (no AI)");
    }

    // Step 2: Wide search — fetch up to 100 candidates per batch
    const searchOpts = bookSlugs.length > 0 ? { bookSlugs } : {};
    const primaryBatches = [
      mergeSearchTerms(plan.people),
      mergeSearchTerms(plan.people, plan.events),
      mergeSearchTerms(plan.institutions, plan.places, plan.keywords),
    ];

    let collected = [];
    for (const keywords of primaryBatches) {
      if (!keywords.length) continue;
      const result = searchReferenceParagraphs({
        keywords,
        excludeSlug,
        limit: SEARCH_LIMIT,
        ...searchOpts
      });
      collected = dedupeBy([...collected, ...result], (item) => `${item.bookSlug}:${item.chapter}:${item.content.slice(0, 80)}`);
    }

    if (collected.length < 10) {
      const fallbackBatch = mergeSearchTerms(plan.timeHints, plan.keywords);
      if (fallbackBatch.length) {
        const result = searchReferenceParagraphs({
          keywords: fallbackBatch,
          excludeSlug: "ming-shi",
          limit: SEARCH_LIMIT,
          ...searchOpts
        });
        collected = dedupeBy([...collected, ...result], (item) => `${item.bookSlug}:${item.chapter}:${item.content.slice(0, 80)}`);
      }
    }

    // Step 3: Score by keyword overlap
    const strongTokens = mergeSearchTerms(plan.people, plan.events, plan.institutions, plan.places, plan.keywords);
    const hasPeopleOrEvents = plan.people.length > 0 || plan.events.length > 0;
    scored = collected
      .map((item) => ({ ...item, relevance: scoreReferenceContext(item, strongTokens) }))
      .filter((item) => !hasPeopleOrEvents || item.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 200);

    tlog(`SLOW PATH STEP 2-3 FTS done collected=${collected.length} scored=${scored.length}`);
  }

  // Step 4: AI relevance filtering — strict semantic check by small model.
  // 大批量候选（>50）拆成若干 50 条小批，并行喂给小模型，最后合并保留 ID。
  // 单批 50 条比单次 200 条快 ~3-4×；并行 4 路又能再砍一半墙钟时间。
  if (aiReady(aiSettings) && scored.length > 0) {
    const BATCH_SIZE = 50;
    const batches = [];
    for (let i = 0; i < scored.length; i += BATCH_SIZE) {
      batches.push({ offset: i, items: scored.slice(i, i + BATCH_SIZE) });
    }
    tlog(`STEP 2.4 AI filter (small model, ${scored.length} candidates → ${batches.length} parallel batches of ${BATCH_SIZE})...`);

    const selectionContext = [
      `原文选段核心内容：`,
      plan.people.length ? `涉及人物：${plan.people.join("、")}` : "",
      plan.events.length ? `涉及事件：${plan.events.join("、")}` : "",
      plan.timeHints.length ? `涉及时间：${plan.timeHints.join("、")}` : "",
      plan.keywords.length ? `其他关键词：${plan.keywords.join("、")}` : "",
    ].filter(Boolean).join("\n");

    const filterPrompt = {
      system: `你是史料相关性判断专家。你的任务是从候选片段中筛选出与《明史》原文选段**指向同一人物或同一事件**的材料。

判断"指向同一事件"的标准（同时满足至少两条即可保留）：
1. 提到选段涉及的**同一人物**（注意人物可能以本名 / 字 / 号 / 庙号 / 谥号 / 官职代称出现，须主动识别同人异称）；
2. 描述的是**同一事件、同一战役、同一上奏、同一处置、同一封赏、同一政变**或与选段构成因果链的前后续事件；
3. 时间段相符或紧邻（同一年/同一年号年内，或前后几年构成因果衔接）；
4. 地点 / 制度 / 机构与选段叙事单元呼应。

以下情况判为**不相关**，必须排除：
- 仅因出现相同朝代/年号就匹配，但人物和事件完全不同；
- 仅因出现同一普通词（如"上""诏""兵"）就匹配；
- 人物同名但显然是不同时期的不同人；
- 描述的事件与选段无任何实质联系。

注意：宁可多保留几条疑似相关的，让最终报告环节再行斟酌；但同名异人 / 时代错位 / 巧合用词必须剔除。只输出JSON。`,
      userTemplate: `${selectionContext}

候选史料片段（共{{batchSize}}条）：
{{context}}

请判断哪些片段与原文选段指向同一人物/同一事件，只输出本批中相关条目的编号 JSON：
{"relevant":[编号1,编号2,...],"reason":"一句话说明筛选依据"}`
    };

    const runBatch = async (batch) => {
      const { offset, items } = batch;
      const candidateList = items
        .map((item, i) => `[${i}] 《${item.bookTitle}》${item.chapter}：${item.content.slice(0, 200)}`)
        .join("\n");
      try {
        const result = await runStructuredJsonPrompt({
          prompt: filterPrompt,
          variables: { batchSize: items.length, context: candidateList },
          aiSettings,
          temperature: 0.05,
          maxTokens: 400,
          modelStrategy: "small"
        });
        if (tokenTracker && result.usage) {
          tokenTracker.small.prompt += result.usage.prompt_tokens || 0;
          tokenTracker.small.completion += result.usage.completion_tokens || 0;
          tokenTracker.small.calls += 1;
        }
        const localIds = result.data?.relevant || [];
        // local id (within batch) → global id (within scored[])
        return { ok: true, model: result.model, ids: localIds.map((id) => offset + id) };
      } catch (err) {
        tlog(`  batch[${offset}] FAILED ${err?.name}: ${String(err?.message || '').slice(0,80)}`);
        return { ok: false, ids: [] };
      }
    };

    const batchResults = await Promise.all(batches.map(runBatch));
    const okCount = batchResults.filter((r) => r.ok).length;
    const allRelevantIds = new Set();
    for (const r of batchResults) {
      for (const id of r.ids) allRelevantIds.add(id);
    }

    if (okCount === 0) {
      tlog(`STEP 2.4 ALL BATCHES FAILED — keep keyword-scored top ${limit}`);
      scored = scored.slice(0, limit);
    } else {
      const sampleModel = batchResults.find((r) => r.ok)?.model;
      tlog(`STEP 2.4 done batches_ok=${okCount}/${batches.length} model=${sampleModel} relevant=${allRelevantIds.size}`);
      if (allRelevantIds.size > 0) {
        scored = scored.filter((_, i) => allRelevantIds.has(i));
      } else {
        scored = [];
      }
    }
  } else if (scored.length === 0) {
    tlog("STEP 2.4 skipped (no scored results)");
  }

  tlog(`STEP 2 final return ${Math.min(scored.length, limit)} contexts`);
  return scored.slice(0, limit);
}

function guessNamedEntity(text) {
  const normalized = normalizeTerm(text);
  if (!normalized) return "";

  const templeHit = EMPEROR_PROFILES.find((item) => normalized.includes(normalizeTerm(item.templeName)));
  if (templeHit) return `${templeHit.templeName}${templeHit.name}`;

  const emperor = EMPEROR_PROFILES.find((item) =>
    [item.name, item.templeName, ...(item.aliases || []), ...(item.reignTitles || [])].some((token) => normalized.includes(normalizeTerm(token)))
  );
  if (emperor) return `${emperor.templeName}${emperor.name}`;

  const character = charactersData.characters.find((item) =>
    [item.name, ...(item.aliases || [])].some((token) => normalized.includes(normalizeTerm(token)))
  );
  if (character) return character.name;

  return "";
}

function pickEmperorFromText(text) {
  const source = String(text || "");
  let best = null;

  for (const item of EMPEROR_PROFILES) {
    for (const token of [item.templeName, item.name, ...(item.aliases || []), ...(item.reignTitles || [])]) {
      if (!token) continue;
      const index = source.indexOf(token);
      if (index === -1) continue;
      if (!best || index < best.index || (index === best.index && token.length > best.token.length)) {
        best = { item, index, token };
      }
    }
  }

  return best?.item || null;
}

// v1.2.1: 模型偶尔不听话，仍在报告里写「## 七、剔除项」「## 未采用材料」之类章节。
// 这里在拿到 LLM 输出后做一道兜底过滤：扫描所有 H2 / H3 章节，凡标题命中
// 「剔除 / 未采用 / 不相关材料 / 排除材料 / 已剔除 / 已删除」之一的，整段（含其内容直到下一个同级或更高级标题）删除。
// 注意：保留 markdown 其他部分（表格、列表、加粗）原样。
function stripExcludedSections(markdown) {
  if (!markdown || typeof markdown !== "string") return markdown;
  const BAD_TITLE = /(剔除|未采用|不相关材料|排除材料|已删除|已剔除|未采用材料)/;
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let skipping = false;
  let skipLevel = 0; // 进入 skip 时的标题级别（## = 2, ### = 3）
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (m) {
      const level = m[1].length;
      const title = m[2];
      if (skipping) {
        // 遇到同级或更高级（数字更小）标题就结束 skip
        if (level <= skipLevel) {
          skipping = false;
        }
      }
      if (!skipping && BAD_TITLE.test(title)) {
        skipping = true;
        skipLevel = level;
        continue;
      }
    }
    if (!skipping) out.push(line);
  }
  // 二次清理：删除单行内嵌的「（备注：…未采用/已剔除…）」类括注
  return out
    .join("\n")
    .replace(/[（(][^()（）]*?(剔除|未采用|不相关|排除)[^()（）]*?[)）]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatReferenceContextRows(rows) {
  if (!rows.length) return "暂无命中的其他史料片段。";
  return rows
    .map(
      (item) =>
        `【${item.index}｜${item.bookTitle}｜${item.chapter}】\n来源：${item.sourceLink || item.anchor || item.sourceUrl || "未提供"}\n${item.content}`
    )
    .join("\n\n");
}

function buildLocalCompareFallback(selectedText, keywords, contexts) {
  const lines = [
    "# 史料交叉比对报告",
    "",
    "## 一、选段摘要",
    selectedText.slice(0, 120),
    "",
    "## 二、时间线对齐",
    "| 时间/年号 | 《明史》记载 | 其他史料对应信息 | 备注 |",
    "| --- | --- | --- | --- |"
  ];

  const yearMentions = extractYearMentions(selectedText);
  if (yearMentions.length) {
    for (const year of yearMentions.slice(0, 4)) {
      lines.push(`| ${year.text} | 见选段原文 | ${contexts[0]?.bookTitle || "暂无"} | ${year.note} |`);
    }
  } else {
    lines.push(`| 未显式出现 | ${selectedText.slice(0, 24)}… | ${contexts[0]?.bookTitle || "暂无命中"} | 需要进一步考定 |`);
  }

  lines.push("", "## 三、异同点");
  if (contexts.length) {
    lines.push(`- 一致处：检索结果多围绕 ${keywords.join("、")} 展开，和《明史》选段主题相近。`);
    lines.push(`- 一致处：${contexts[0].bookTitle} 也提到与选段相邻的事件人物或地名。`);
    lines.push(`- 差异处：其他史料的叙述重心偏向 ${contexts[0].chapter}，不一定与《明史》的叙事角度相同。`);
    lines.push("- 差异处：当前命中材料有限，尚不能判定全部细节差异。");
  } else {
    lines.push("- 一致处：暂无足够其他史料命中。");
    lines.push("- 差异处：暂无足够其他史料命中。");
  }

  lines.push("", "## 四、可考结论");
  lines.push("- 较可靠：当前关键词提取与文本主题基本一致。");
  lines.push("- 需要保留判断：检索命中数量有限，不能据此下最终定论。");
  lines.push("- 仍待补证：建议继续扩充《国榷》《明实录》等库后再比对。");
  lines.push("", "## 五、参考史料");

  if (contexts.length) {
    for (const item of contexts) {
      const link = item.sourceLink || item.anchor || item.sourceUrl;
      lines.push(link ? `- [${item.bookTitle}《${item.chapter}》](${link})` : `- ${item.bookTitle}《${item.chapter}》`);
    }
  } else {
    lines.push("- 本次未命中其他参考史料。");
  }

  return lines.join("\n");
}

function resolveEmperorByHint(hintText) {
  const normalized = normalizeTerm(hintText);
  if (!normalized) return null;

  let best = null;
  for (const emperor of emperorsData.timeline) {
    const aliases = unique([
      emperor.name,
      emperor.templeName,
      ...(emperor.reignTitles || []),
      ...(emperor.aliases || [])
    ]);
    const bundle = buildSearchText([emperor.posthumousTitle, ...aliases]);
    let score = scoreCandidate(normalized, bundle, aliases);

    if (/本纪/.test(hintText) && normalized.includes(normalizeTerm(emperor.templeName))) {
      score += 120;
    }

    if (normalized.includes(normalizeTerm(emperor.name))) {
      score += 70;
    }

    if (emperor.reignTitles.some((item) => normalized.includes(normalizeTerm(item)))) {
      score += 80;
    }

    if (!score) continue;
    if (!best || score > best.score) {
      best = { emperor, score };
    }
  }

  if (best) return best.emperor;

  const year = extractYearMentions(hintText)[0]?.gregorian;
  if (!year) return null;
  return emperorsData.timeline.find((item) => year >= item.startYear && year <= item.endYear) || null;
}

function buildLocalGeocodeIndex() {
  const provinceRecords = geographyData.regions.map((item) => ({
    id: item.id,
    name: item.name,
    aliases: item.aliases || [],
    modernName: item.modernEquivalent,
    kind: item.kind,
    note: item.summary,
    lat: item.lat,
    lng: item.lng
  }));

  return [...MING_PLACE_INDEX, ...provinceRecords].filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
}

function matchLocalPlace(term) {
  const normalized = normalizeTerm(term);
  if (!normalized) return null;
  const records = buildLocalGeocodeIndex();
  let best = null;

  for (const item of records) {
    const tokens = unique([item.name, item.modernName, ...(item.aliases || [])]);
    let score = 0;
    for (const token of tokens) {
      const current = normalizeTerm(token);
      if (!current) continue;
      if (current === normalized) score = Math.max(score, 120);
      else if (current.includes(normalized) || normalized.includes(current)) score = Math.max(score, 88);
    }
    if (score && (!best || score > best.score)) {
      best = { ...item, score, source: "local" };
    }
  }

  return best;
}

async function geocodeWithNominatim(term) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", term);
  url.searchParams.set("limit", "1");
  url.searchParams.set("accept-language", "zh-CN");

  // Node 22 native fetch has IPv6/DNS issues that cause timeouts.
  // Use curl as a reliable fallback.
  let rows;
  try {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("curl", [
      "-s", "-L", "--max-time", "8",
      "-H", "User-Agent: MingshiReaderAI/1.0",
      url.toString()
    ], { maxBuffer: 512 * 1024, encoding: "utf8" });
    rows = JSON.parse(stdout);
  } catch {
    // curl failed, try native fetch as last resort
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "MingshiReaderAI/1.0" },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) return null;
      rows = await response.json();
    } catch {
      return null;
    }
  }

  const first = rows?.[0];
  if (!first) return null;

  return {
    id: `nominatim-${normalizeTerm(term).slice(0, 10) || "place"}`,
    name: term,
    aliases: [],
    modernName: first.display_name,
    kind: first.type || "place",
    note: "由 OpenStreetMap Nominatim 在线地理编码返回；古今对应需结合上下文复核。",
    lat: Number.parseFloat(first.lat),
    lng: Number.parseFloat(first.lon),
    score: 60,
    source: "nominatim"
  };
}

export async function ensureReferenceLibraryReady() {
  await initializeLibrary();
  return {
    books: getLibraryOverview(),
    sources: getSourceManifest()
  };
}

export async function lookupReadingReference(query, aiSettings) {
  await initializeLibrary();
  const localMatches = lookupLocalEntries(query);
  const reignMatch = explainReignTerm(query);
  const payload = {
    query,
    localMatches,
    reignMatch,
    aiExplanation: "",
    model: "",
    library: getLibraryOverview()
  };

  if (!aiReady(aiSettings)) {
    payload.aiExplanation = buildLocalGlossFallback(query, localMatches);
    return payload;
  }

  try {
    const prompt = getActionPrompt("gloss");
    const result = await runPromptTemplate({
      prompt,
      variables: {
        selection: query,
        context: formatGlossContext(query, localMatches)
      },
      aiSettings,
      temperature: 0.25,
      maxTokens: 900
    });

    payload.aiExplanation = result.text;
    payload.model = result.model;
  } catch (error) {
    payload.aiExplanation = `${buildLocalGlossFallback(query, localMatches)}\n\n补充说明：AI 释义暂不可用，已回退为本地资料整理。`;
    payload.model = "";
  }
  return payload;
}

export async function runCrossSourceComparison(selectedText, aiSettings, currentBookSlug = "ming-shi") {
  const T0 = Date.now();
  const tlog = (label) => console.log(`[crossCompare] +${((Date.now()-T0)/1000).toFixed(1)}s ${label}`);
  tlog(`START selection.length=${selectedText.length} chars from=${currentBookSlug}`);

  await initializeLibrary();
  const excludeSlug = currentBookSlug || "ming-shi";

  // Token usage tracking
  const tokenUsage = { small: { prompt: 0, completion: 0, calls: 0 }, large: { prompt: 0, completion: 0, calls: 0 } };
  function trackUsage(result, type = "small") {
    if (result?.usage) {
      tokenUsage[type].prompt += result.usage.prompt_tokens || 0;
      tokenUsage[type].completion += result.usage.completion_tokens || 0;
      tokenUsage[type].calls += 1;
    }
  }

  const keywordPrompt = getActionPrompt("extractKeywords");
  let keywords = [];
  let people = [];
  let personAliases = [];
  let events = [];
  let eventAliases = [];
  let entities = [];
  let places = [];
  let timeHints = [];
  let coreEventSummary = "";
  let keywordModel = "";

  if (aiReady(aiSettings)) {
    try {
      tlog("STEP 1/3 extractKeywords (small model)...");
      const extracted = await runStructuredJsonPrompt({
        prompt: keywordPrompt,
        variables: { selection: selectedText },
        aiSettings,
        temperature: 0.1,
        maxTokens: 600,
        modelStrategy: "small"
      });
      tlog(`STEP 1/3 done model=${extracted.model} keywords=${(extracted.data?.keywords || []).length}`);
      trackUsage(extracted, "small");
      people = unique(extracted.data?.people || []);
      personAliases = unique(extracted.data?.personAliases || []);
      events = unique(extracted.data?.events || []);
      eventAliases = unique(extracted.data?.eventAliases || []);
      entities = unique(extracted.data?.entities || []);
      places = unique(extracted.data?.places || []);
      timeHints = unique(extracted.data?.timeHints || []);
      coreEventSummary = String(extracted.data?.coreEventSummary || "").trim();
      keywords = unique([
        ...people,
        ...personAliases,
        ...events,
        ...eventAliases,
        ...(extracted.data?.keywords || []),
        ...entities,
        ...places,
        ...timeHints
      ]).slice(0, 18);
      keywordModel = extracted.model;
    } catch {
      keywords = deriveKeywordsFromText(selectedText);
    }
  } else {
    keywords = deriveKeywordsFromText(selectedText);
  }

  tlog("STEP 2/3 collectReferenceContexts (含 AI 选书 + 多次 FTS + AI 过滤)...");
  const contexts = await collectReferenceContexts(
    buildReferenceSearchPlan({
      selectionRelevant: true,
      people,
      personAliases,
      events,
      eventAliases,
      entities,
      places,
      keywords,
      timeHints,
      note: coreEventSummary,
      // 用选段原文做 embedding 查询（最语义、最不丢信息）；
      // collectReferenceContexts 内部会判 embedding 是否可用。
      embeddingQuery: selectedText
    }),
    25,
    aiSettings,
    tokenUsage,
    excludeSlug
  );
  tlog(`STEP 2/3 done contexts=${contexts.length}`);

  const payload = {
    selectedText,
    keywords,
    contexts,
    reportMarkdown: "",
    model: keywordModel
  };

  if (!aiReady(aiSettings)) {
    payload.reportMarkdown = buildLocalCompareFallback(selectedText, keywords, contexts);
    return payload;
  }

  try {
    tlog("STEP 3/3 crossCompare report (large model)...");
    const prompt = getActionPrompt("crossCompare");
    const compareHints = [
      coreEventSummary ? `核心事件：${coreEventSummary}` : "",
      people.length ? `核心人物：${people.join("、")}` : "",
      personAliases.length ? `人物异名：${personAliases.join("、")}` : "",
      events.length ? `事件：${events.join("、")}` : "",
      eventAliases.length ? `事件别名：${eventAliases.join("、")}` : "",
      timeHints.length ? `时间线索：${timeHints.join("、")}` : "",
      places.length ? `地点：${places.join("、")}` : "",
    ].filter(Boolean).join("\n");
    const result = await runPromptTemplate({
      prompt,
      variables: {
        selection: selectedText,
        question: compareHints || keywords.join("、") || "未提取出稳定关键词",
        context: formatReferenceContextRows(contexts)
      },
      aiSettings,
      temperature: 0.2,
      maxTokens: 3000
    });

    tlog(`STEP 3/3 done model=${result.model} text.length=${result.text.length}`);
    trackUsage(result, "large");
    payload.reportMarkdown = stripExcludedSections(result.text);
    payload.model = result.model;
  } catch (err) {
    tlog(`STEP 3/3 FAILED ${err?.name}: ${String(err?.message || '').slice(0, 120)}`);
    console.error("crossCompare report error:", err?.message?.slice?.(0, 80) || err);
    payload.reportMarkdown = buildLocalCompareFallback(selectedText, keywords, contexts);
    payload.model = "";
  }

  // Append token usage summary
  const smallTotal = tokenUsage.small.prompt + tokenUsage.small.completion;
  const largeTotal = tokenUsage.large.prompt + tokenUsage.large.completion;
  if (smallTotal > 0 || largeTotal > 0) {
    let line = `本次检索消耗：小模型 ${smallTotal} tokens（${tokenUsage.small.calls}次调用，输入${tokenUsage.small.prompt}/输出${tokenUsage.small.completion}）`;
    if (largeTotal > 0) {
      line += `，大模型 ${largeTotal} tokens（${tokenUsage.large.calls}次调用，输入${tokenUsage.large.prompt}/输出${tokenUsage.large.completion}，模型${payload.model}）`;
    }
    payload.reportMarkdown += `\n\n---\n\n> ${line}`;
  }

  return payload;
}

export function getTimelinePayload(hintText = "") {
  const current = resolveEmperorByHint(hintText);
  return {
    current,
    timeline: EMPEROR_PROFILES,
    reigns: MING_REIGNS
  };
}

export function getGeographyPayload() {
  return geographyData;
}

export async function geocodePlaces(query = "", aiSettings = null) {
  const terms = String(query || "")
    .split(/[\n,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);

  const results = [];
  for (const term of terms) {
    // 1. Local database
    const local = matchLocalPlace(term);
    if (local) {
      results.push({ query: term, ...local });
      continue;
    }

    // 2. AI: identify modern name AND approximate coordinates directly
    if (aiReady(aiSettings)) {
      try {
        const aiResult = await runStructuredJsonPrompt({
          prompt: {
            system: `你是中国历史地理专家，精通明代（1368-1644）行政区划沿革。
用户给出一个中国古地名（府、州、县、卫、所、关、镇、路等），请：
1. 判断其在明代属于哪一级行政单位
2. 给出对应的现代地名（精确到市或县区）
3. 给出该地的大致经纬度坐标（WGS84，精确到小数点后2位即可）
4. 一句话沿革说明
只输出JSON。`,
            userTemplate: `"{{selection}}"对应的现代位置是什么？

输出JSON：
{
  "modernName": "现代省市县名",
  "mingLevel": "明代行政级别",
  "lat": 纬度数字,
  "lng": 经度数字,
  "note": "一句话沿革说明"
}`
          },
          variables: { selection: term },
          aiSettings,
          temperature: 0.1,
          maxTokens: 300,
          modelStrategy: "small"
        });
        const d = aiResult.data || {};
        const lat = typeof d.lat === "number" ? d.lat : null;
        const lng = typeof d.lng === "number" ? d.lng : null;
        if (d.modernName) {
          results.push({
            query: term, name: term, aliases: [],
            modernName: d.modernName,
            kind: d.mingLevel || "place",
            note: `${term} → ${d.modernName}。${d.note || ""}`,
            lat, lng,
            source: lat != null ? "ai" : "ai",
            score: 80
          });
          continue;
        }
      } catch (aiError) {
        console.error("geocodePlaces AI error:", aiError?.message || aiError);
      }
    }

    results.push({ query: term, name: term, aliases: [], modernName: "", kind: "unknown", note: "未找到可定位结果。可尝试输入现代地名或更具体的古地名。", lat: null, lng: null, source: "none" });
  }

  return {
    query,
    results,
    places: results
  };
}

export function getEmperorPayload() {
  return {
    list: EMPEROR_PROFILES,
    familyTree: EMPEROR_FAMILY_TREE
  };
}

export function getOfficialsPayload() {
  // Annotate parsed offices with salary references so the UI can show 俸禄
  // alongside rank without requiring frontend lookup.
  const officesWithSalary = officialsExtended.offices.map((o) => ({
    ...o,
    salary: SALARY_REFERENCE[o.rank] || "",
  }));
  return {
    institutions: OFFICIAL_PROFILES,
    characters: charactersData.characters,
    offices: officesWithSalary,
    sections: officialsExtended.sections,
    chronology: officialsExtended.chronology,
    princes: officialsExtended.princes,
    poems: officialsExtended.poems,
  };
}

export function convertChronologyTerm(term = "") {
  return convertMingYearTerm(term);
}

export async function searchOfficeReferences(query = "") {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    return {
      query: cleanQuery,
      bookResults: [],
      referenceResults: []
    };
  }

  const bookSearch = await searchBook(cleanQuery, { limit: 8 });
  const referenceResults = searchReferenceParagraphs({
    keywords: [cleanQuery],
    excludeSlug: "__none__",
    limit: 8
  });

  return {
    query: cleanQuery,
    bookResults: bookSearch.results,
    referenceResults
  };
}

export async function answerReadingQuestion({ selection = "", question = "", aiSettings }) {
  await initializeLibrary();

  const cleanSelection = String(selection || "").trim();
  const cleanQuestion = String(question || "").trim();
  const bookContext = cleanSelection ? await getContextSnippets(cleanSelection, 8) : cleanQuestion ? await getContextSnippets(cleanQuestion, 8) : [];
  const plan = await buildQuestionPlan({
    selection: cleanSelection,
    question: cleanQuestion,
    bookContext,
    aiSettings
  });

  // Short-circuit when the planner says the question doesn't need a library
  // lookup at all (e.g. greetings, chitchat, programming questions, modern
  // current events). Fall through to a slim direct-answer prompt with no
  // reference context attached, and return empty contextSnippets so the UI
  // doesn't show "已检索 X 条" cards that were never used.
  if (!plan.needsLibraryLookup && aiReady(aiSettings)) {
    try {
      const result = await runPromptTemplate({
        prompt: {
          system: "你是 AI 助手。用户的问题与明代史无关，直接清晰回答即可，不要硬扯到史料。",
          userTemplate: `用户问题：{{question}}\n${cleanSelection ? "（用户在阅读《明史》，但问题与选段无直接关联）\n选段：{{selection}}\n" : ""}\n请充分回答，不必拘泥字数。`
        },
        variables: { question: cleanQuestion, selection: cleanSelection },
        aiSettings,
        temperature: 0.3,
        maxTokens: 2000,
        modelStrategy: "large",
      });
      return { answer: result.text, model: result.model, contextSnippets: [] };
    } catch {
      // fall through to the full chain on any error
    }
  }

  const rawReferences = await collectReferenceContexts(plan, 30, aiSettings);
  // Filter out references that turn out to be off-topic. The QA prompt is
  // told to "宁可不引用" but in practice models still pull in tangential
  // materials; an explicit relevance gate keeps the chain honest.
  const referenceContexts = await filterRelevantReferences({
    question: cleanQuestion,
    selection: cleanSelection,
    references: rawReferences,
    aiSettings,
  });
  const shouldSearchWeb = (!cleanSelection || !plan.selectionRelevant || plan.needWebSearch) && Boolean(plan.webQuery || cleanQuestion);
  const webResults = shouldSearchWeb ? await searchWeb(plan.webQuery || cleanQuestion || cleanSelection, 8) : [];

  if (!aiReady(aiSettings)) {
    const selectionEntity = pickEmperorFromText(cleanSelection);
    const fallbackText = `${cleanSelection}\n${bookContext.map((item) => item.snippet).join("\n")}`;
    const directEmperor =
      selectionEntity || pickEmperorFromText(fallbackText);
    const guessedEntity = directEmperor ? `${directEmperor.templeName}${directEmperor.name}` : guessNamedEntity(fallbackText);
    const fallbackLines = [];
    if (cleanSelection && /谁|何人|哪个人/.test(cleanQuestion) && guessedEntity) {
      fallbackLines.push(`简答：这段写的是 ${guessedEntity}。`);
    } else {
      fallbackLines.push(`简答：${cleanQuestion || "当前未提供问题。"}需要结合原文与资料继续判断。`);
    }
    if (bookContext[0]) {
      fallbackLines.push(`依据：书内最相关片段见《${bookContext[0].chapterTitle}》：${bookContext[0].snippet.slice(0, 90)}…`);
    }
    if (referenceContexts[0]) {
      fallbackLines.push(`补充：${referenceContexts[0].bookTitle}《${referenceContexts[0].chapter}》亦提到相关人物或事件。`);
    }
    if (webResults[0]) {
      fallbackLines.push(`网页线索：${webResults[0].title}。`);
    }
    return {
      answer: fallbackLines.join("\n\n"),
      model: "",
      contextSnippets: bookContext
    };
  }

  const context = [
    "【选段附近原文】",
    formatBookContextRows(bookContext),
    "",
    "【本地参考史料】",
    formatReferenceContextRows(referenceContexts),
    "",
    "【网页搜索结果】",
    formatWebResultsRows(webResults),
    "",
    "【检索规划】",
    JSON.stringify(plan, null, 2)
  ].join("\n");

  try {
    const result = await runPromptTemplate({
      prompt: getActionPrompt("qa"),
      variables: {
        question: cleanQuestion,
        selection: cleanSelection,
        context
      },
      aiSettings,
      temperature: 0.2,
      maxTokens: 3500,
      modelStrategy: "large"
    });

    // Display contextSnippets only when the selection-anchored bookContext
    // is actually relevant to the question. Otherwise the UI would show
    // "依据" cards that have nothing to do with the user's query.
    const displaySnippets = plan.selectionRelevant ? bookContext : [];
    return {
      answer: result.text,
      model: result.model,
      contextSnippets: displaySnippets
    };
  } catch {
    const fallback = [];
    const selectionEntity = pickEmperorFromText(cleanSelection);
    const fallbackText = `${cleanSelection}\n${bookContext.map((item) => item.snippet).join("\n")}`;
    const directEmperor =
      selectionEntity || pickEmperorFromText(fallbackText);
    const guessedEntity = directEmperor ? `${directEmperor.templeName}${directEmperor.name}` : guessNamedEntity(fallbackText);
    if (cleanSelection) {
      if (/谁|何人|哪个人/.test(cleanQuestion) && guessedEntity) {
        fallback.push(`简答：这段写的是 ${guessedEntity}。`);
      } else {
        fallback.push(`简答：这段主要指向 ${cleanSelection.slice(0, 24)}… 所涉及的人物或事件。`);
      }
    } else {
      fallback.push(`简答：${cleanQuestion || "当前问题"}需要结合现有线索审慎回答。`);
    }
    if (bookContext[0]) {
      fallback.push(`依据：书内最相关片段来自《${bookContext[0].chapterTitle}》。`);
    }
    if (referenceContexts[0]) {
      fallback.push(`补充：${referenceContexts[0].bookTitle}《${referenceContexts[0].chapter}》可作旁证。`);
    }
    if (webResults[0] && !cleanSelection) {
      fallback.push(`网页线索：${webResults[0].title}。`);
    }

    return {
      answer: fallback.join("\n\n"),
      model: "",
      contextSnippets: bookContext
    };
  }
}

export function getAuxiliaryDatasetSummary() {
  return {
    officialsCount: officialsData.institutions.length,
    emperorsCount: emperorsData.timeline.length,
    geographyCount: geographyData.regions.length,
    charactersCount: charactersData.characters.length
  };
}
