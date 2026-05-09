#!/usr/bin/env node
/**
 * 构建人物-章节索引（biography-index.json）
 *
 * 扫描以下书的纪传部分，从章节标题 + 首段内容里抽取传主人名，
 * 算出每个人在章内的「起始段-终结段」位置，落盘成 JSON 索引。
 *
 *   - ming-shi             明史 列传第N 形式，标题尾部就是人名串
 *   - shiku-shu-houji      石匮书后集 卷第N　X列传 / X、Y、Z列传 形式
 *   - donglin-liezhuan     东林列传卷N，首段「X传（本宋史）」抽 X
 *   - zuiwei-lu            罪惟录 明书列传卷之N，首段是人名串
 *
 * 用途：人物编年 AI 调用前先查这个表，命中则把对应章节切片作为参考资料给 AI；
 * 没命中则走原本的关键词检索路径。
 *
 * 索引结构：
 *   {
 *     "郭子兴": [
 *       {
 *         bookSlug: "ming-shi",
 *         chapterLabel: "列传第十 郭子兴 韩林儿",
 *         chapterOrder: 132,
 *         anchor: "OEBPS/Text/...",
 *         personOrder: 0,        // 在本章是第几位传主（0-based）
 *         totalPersonsInChapter: 2
 *       }
 *     ],
 *     "韩林儿": [...]
 *   }
 *
 * 之所以不直接存「起始段 - 终结段」编号：段落是按 paragraphs.id ASC 顺序的，
 * 但 id 不连续；运行时根据 personOrder + 全章段落顺扫定位即可。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DB_PATH = path.join(PROJECT_ROOT, "backend", ".cache", "library.sqlite");
const OUT_PATH = path.join(PROJECT_ROOT, "backend", "src", "data", "biography-index.json");

const db = new Database(DB_PATH, { readonly: true });

// ---- 章节判定 + 人名提取（per-book）---------------------------------

// 截掉传主名后面跟附传家属的"子/孙/弟/兄/族/从子/従子"等关系字串
// "于谦子冕" → "于谦"，"刘基子琏璟" → "刘基"，"李善长子祺" → "李善长"
// 但保留正常 2-3 字名："张子明" 中 "子明" 是名字一部分，不能误切
// 启发式：只有当字串长度 > 3 且第 2 或第 3 字是关系字时才切
function trimRelationSuffix(name) {
  const RELATIONS = "子孙弟兄从従族父侄甥妹姊";
  if (name.length <= 3) return name;
  // 4字以上：扫从位置 2/3 起的关系字
  for (let i = 2; i <= 3 && i < name.length; i++) {
    if (RELATIONS.includes(name[i])) {
      return name.slice(0, i);
    }
  }
  return name;
}

function namesFromMingShiTitle(label) {
  // "列传第十 郭子兴 韩林儿" → ["郭子兴","韩林儿"]
  // "列传第十六 刘基（子琏璟） 宋濂 叶琛 章溢（子存道）" → ["刘基","宋濂","叶琛","章溢"]
  const m = label.match(/^列传第[一二三四五六七八九十百\d]+\s+(.+)$/);
  if (!m) return [];
  let tail = m[1].trim();
  tail = tail.replace(/[（(][^）)]*[）)]/g, "");
  const parts = tail.split(/[\s、，]+/).map((s) => s.trim()).filter(Boolean);
  return parts
    .map(trimRelationSuffix)
    .filter((p) => /^[一-鿿]{2,4}$/.test(p));
}

function namesFromMingShiFirstPara(label, firstPara) {
  // 标题"列传第NNN"无人名时（如"列传第十二"），首段开头会有 "○A B C 等 D" 或
  // 直接列名串。形如 "○扩廓帖木儿蔡子英 陈友定伯颜子中等 把匝剌瓦尔密"
  if (!/^列传第/.test(label)) return [];
  if (!firstPara) return [];
  // 取首段前 80 字作为候选 header（再多就到了正文）
  let head = firstPara.slice(0, 80);
  // 去掉前缀 ○ ●
  head = head.replace(/^[○●◎○]+/, "");
  // 去掉括号
  head = head.replace(/[（(][^）)]*[）)]/g, "");
  // 在第一个不是人名空格分隔符的字符（句号、长串非空白超过 5 字符）处截断
  // 简单办法：找到第一处中文人名之间最长可能的连续字串，按空白切
  // 切分前：替换"等"为空白
  head = head.replace(/等/g, " ");
  const parts = head.split(/[\s、，]+/).map((s) => s.trim()).filter(Boolean);
  // 第一段可能直接以人名+句子开头（如"扩廓帖木儿，沈丘人"），所以遇到逗号/句号截断的部分忽略
  const out = [];
  for (const p of parts) {
    const clean = p.replace(/[，。、；：．]/g, "");
    if (/^[一-鿿]{2,5}$/.test(clean)) out.push(trimRelationSuffix(clean));
    else break; // 一旦出现长串非姓名（句子开始），后面就不是 header 了
  }
  return out;
}

function namesFromShikuShuHoujiTitle(label) {
  // "石匮书后集卷第七　朱燮元列传" → ["朱燮元"]
  // "石匮书后集卷第八　孙承宗（鹿善继）、贺逢圣、吕维祺、姜曰广列传" → ["孙承宗","贺逢圣","吕维祺","姜曰广"]
  // "石匮书后集卷第二　烈皇后本纪" → []（本纪不算）
  if (!/列传/.test(label)) return [];
  // 找到「卷第X　」之后到「列传」之前的部分
  const m = label.match(/卷第[一二三四五六七八九十百\d]+[\s　]+(.+?)列传/);
  if (!m) return [];
  let tail = m[1].trim();
  tail = tail.replace(/[（(][^）)]*[）)]/g, "");
  const parts = tail.split(/[、，\s]+/).map((s) => s.trim()).filter(Boolean);
  return parts.filter((p) => /^[一-鿿]{2,4}$/.test(p));
}

function namesFromDonglinFirstPara(label, firstPara) {
  // 章节本身是 "东林列传卷X"，人名出现在首段开头有几种形式：
  //   1) "杨时传（本宋史）" — X传
  //   2) "缪昌期李应升列传" — X+Y+列传
  //   3) "邵宝字国贤无锡人..." — X字Y...（第一段直接是正文）
  if (!/^东林列传卷/.test(label)) return [];
  if (!firstPara) return [];
  const firstLine = firstPara.split(/[\n\r]/)[0].trim();

  // (1) X传 / X传（...）
  const m1 = firstLine.match(/^([一-鿿]{2,4})传(?:[（(]|$)/);
  if (m1) return [m1[1]];

  // (2) X+Y+列传 — 取整个 header 部分，去掉"列传"，按潜在人名拆分
  if (/列传$/.test(firstLine) || firstLine.endsWith("列传")) {
    const trimmed = firstLine.replace(/列传$/, "").trim();
    // 长度限制：太长就不是 header
    if (trimmed.length <= 30 && /^[一-鿿]+$/.test(trimmed)) {
      // 简单切：每 2-3 字算一个名（中文姓名通常 2-4 字）
      // 这里粗暴切：贪婪每 3 字一切，把 6 字切成两个 3 字名
      const out = [];
      let i = 0;
      while (i < trimmed.length) {
        // 默认 3 字，下一段开头如果是单字"子/孙/弟"等族属字则合并
        const name = trimmed.slice(i, i + 3);
        if (/^[一-鿿]{2,4}$/.test(name)) out.push(name);
        i += 3;
      }
      if (out.length > 0) return out;
    }
  }

  // (3) X字Y... — 单人传，X 是姓名
  const m3 = firstLine.match(/^([一-鿿]{2,4})字[一-鿿]+/);
  if (m3) return [m3[1]];

  return [];
}

function namesFromZuiweiluFirstPara(label, firstPara) {
  // 章节是 "明书列传卷之X" / "致命諸臣傳中" 等。人名串塞在首段
  // 例如 "郝景春子鳴鷺楊道選陳宜朱邦聞鄒逢吉王良鑑 阮之錫石惟壇 唐啟泰 徐日泰"
  // 这种粘连的最难解析；先做简单版：按空白切分，过滤 2-4 字段。粘连段落保留首位
  if (!/明书列传卷之|諸臣傳|諸臣传|致命/.test(label)) return [];
  if (!firstPara) return [];
  // 取首段（去掉常见前缀注释类内容）
  const head = firstPara.slice(0, 200);
  // 粗略：按空白切分
  const parts = head.split(/[\s、，；]+/).map((s) => s.trim()).filter(Boolean);
  // 仅保留长度 2-4 的中文姓名
  const candidates = parts.filter((p) => /^[一-鿿]{2,4}$/.test(p));
  // 去重保序
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

// ---- 主流程 ----------------------------------------------------------

const PARSERS = [
  { slug: "ming-shi",          fromTitle: namesFromMingShiTitle,        fromFirst: namesFromMingShiFirstPara },
  { slug: "shiku-shu-houji",   fromTitle: namesFromShikuShuHoujiTitle,  fromFirst: null },
  { slug: "donglin-liezhuan",  fromTitle: null,                          fromFirst: namesFromDonglinFirstPara },
  { slug: "zuiwei-lu",         fromTitle: null,                          fromFirst: namesFromZuiweiluFirstPara },
];

const index = {};   // person → entries[]
const stats = {};

for (const parser of PARSERS) {
  const book = db.prepare("SELECT id, title FROM books WHERE slug = ?").get(parser.slug);
  if (!book) {
    console.warn(`book not found: ${parser.slug}`);
    continue;
  }

  const chapters = db.prepare(`
    SELECT chapter, chapter_order, MIN(anchor) AS anchor, MIN(id) AS firstId
    FROM paragraphs
    WHERE book_id = ?
    GROUP BY chapter, chapter_order
    ORDER BY chapter_order, chapter
  `).all(book.id);

  let bookHits = 0;
  let bookPersons = 0;

  for (const ch of chapters) {
    let names = [];
    if (parser.fromTitle) {
      names = parser.fromTitle(ch.chapter);
    }
    if (names.length === 0 && parser.fromFirst) {
      const firstPara = db.prepare(`
        SELECT content FROM paragraphs
        WHERE book_id = ? AND chapter = ? AND chapter_order = ?
        ORDER BY id LIMIT 1
      `).get(book.id, ch.chapter, ch.chapter_order)?.content || "";
      names = parser.fromFirst(ch.chapter, firstPara);
    }
    if (names.length === 0) continue;

    bookHits++;
    bookPersons += names.length;

    names.forEach((name, i) => {
      if (!index[name]) index[name] = [];
      index[name].push({
        bookSlug: parser.slug,
        bookTitle: book.title,
        chapterLabel: ch.chapter,
        chapterOrder: ch.chapter_order,
        anchor: ch.anchor || "",
        personOrder: i,
        totalPersonsInChapter: names.length,
      });
    });
  }

  stats[parser.slug] = { biographicalChapters: bookHits, totalPersons: bookPersons };
  console.log(`${parser.slug}: ${bookHits} 章 / ${bookPersons} 人次`);
}

const totalPersons = Object.keys(index).length;
const totalEntries = Object.values(index).reduce((sum, arr) => sum + arr.length, 0);
console.log(`\nindex: ${totalPersons} 个独立人名 / ${totalEntries} 条记录`);

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(),
  stats,
  index,
}, null, 2), "utf8");
console.log(`wrote: ${OUT_PATH} (${(fs.statSync(OUT_PATH).size / 1024).toFixed(1)} KB)`);

db.close();
