#!/usr/bin/env node
/**
 * Import corrected texts of 石匱書 vol5-17 (replace existing) and 石匱書後集 vol14-63 (append).
 *
 * - 石匱書 vol5-17: re-imports from donotpack/database/shiku-shu-ocr/v3-audit/修正版-vol-NN.txt
 *   - replaces existing chapter content (17 chapters total in db)
 * - 石匱書後集 vol14-63: appends new chapters to shiku-shu-houji book
 *   - reads donotpack/database/shiku-shu-houji-bu/应用版/卷N.md
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DB_PATH = path.join(ROOT, 'backend/.cache/library.sqlite');
const V3_DIR = path.join(ROOT, 'donotpack/database/shiku-shu-ocr/v3-audit');
const HOUJI_DIR = path.join(ROOT, 'donotpack/database/shiku-shu-houji-bu/应用版');

const CN = {
  1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十',
  11: '十一', 12: '十二', 13: '十三', 14: '十四', 15: '十五', 16: '十六', 17: '十七',
  18: '十八', 19: '十九', 20: '二十', 21: '二十一', 22: '二十二', 23: '二十三', 24: '二十四',
  25: '二十五', 28: '二十八', 29: '二十九', 32: '三十二', 34: '三十四', 35: '三十五',
  36: '三十六', 37: '三十七', 38: '三十八', 39: '三十九', 40: '四十', 41: '四十一',
  42: '四十二', 44: '四十四', 45: '四十五', 46: '四十六', 48: '四十八', 49: '四十九',
  50: '五十', 51: '五十一', 52: '五十二', 53: '五十三', 56: '五十六', 57: '五十七',
  58: '五十八', 59: '五十九', 60: '六十', 61: '六十一', 62: '六十二', 63: '六十三'
};

const SHIKU_SHU_TITLES = {
  5: '宣宗本紀', 6: '英宗本紀', 7: '景帝本紀', 8: '憲宗本紀', 9: '孝宗本紀',
  10: '武宗本紀', 11: '世宗本紀', 12: '穆宗本紀', 13: '神宗本紀', 14: '光宗本紀',
  15: '熹宗本紀', 16: '皇后本紀', 17: '太子本紀'
};

const HOUJI_TITLES = {
  12: '周延儒、楊嗣昌、溫體仁列傳',
  13: '蔣德璟、黃景昉、吳甡列傳',
  14: '流寇死事諸臣列傳', 15: '盧象昇列傳', 16: '流寇死戰諸臣列傳',
  17: '朱之馮、衛景瑗、蔡懋德列傳', 18: '曹文詔、賀人龍列傳', 19: '陸夢龍列傳',
  20: '甲申死難列傳', 21: '勳戚殉難列傳', 22: '倪元璐列傳',
  23: '鄉紳死義列傳／凌駉列傳', 24: '史可法列傳', 25: '左良玉列傳',
  28: '劉華楊劉續沈李鄺蔡列傳', 29: '左懋第列傳', 32: '乙酉殉難列傳',
  34: '江南死義列傳', 35: '夏之旭、滿之章、何光顯列傳',
  36: '劉宗周、祁彪佳列傳', 37: '黃道周、金聲列傳', 38: '黃得功列傳附三鎮',
  39: '丙戌殉難列傳', 40: '張國維列傳', 41: '朱大典列傳附吳邦瑭、何武',
  42: '王之仁、張鵬翼列傳', 44: '熊汝霖等列傳', 45: '余煌、陳函輝、陳潛夫列傳',
  46: '萬楊郭揭詹會陳胡傅徐列傳（附堵胤錫、何騰蛟）', 48: '馬士英、阮大鋮列傳附方國安',
  49: '陳劉張黎姚陳蘇彭王列傳', 50: '辛卯殉難列傳',
  51: '黃斌卿、張名振、王朝先、阮俊列傳', 52: '瞿式耜列傳',
  53: '陶仰用、朱旻如、蔣武烈、廖應登列傳', 56: '孝子列傳', 57: '義人列傳',
  58: '文苑列傳', 59: '列女列傳', 60: '妙藝列傳', 61: '宦者列傳',
  62: '中原羣盜列傳', 63: '盜賊列傳'
};

function hash(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }

function splitParagraphs(text) {
  // strip the "==== 卷N 修正版 ====" header line if present
  text = text.replace(/^=+\s*卷\d+[^=\n]*=+\s*\n/m, '');
  // strip [p.NN] page markers
  text = text.replace(/\[p\.\d+\]/g, '');
  // split by double newlines or chapter markers
  const blocks = text.split(/\n\s*\n+/).map(s => s.trim()).filter(s => s.length > 0);
  // filter out heading/title-only blocks
  return blocks.filter(b => {
    if (b.startsWith('#')) return false;
    if (b.length < 8) return false; // too short, likely chapter title
    return true;
  });
}

function loadV3Vol(n) {
  const fname = `修正版-vol-${String(n).padStart(2, '0')}.txt`;
  const fpath = path.join(V3_DIR, fname);
  if (!fs.existsSync(fpath)) return null;
  return fs.readFileSync(fpath, 'utf-8');
}

function loadHoujiVol(n) {
  // Try plain 卷N.md first; for duplicated 23a/23b combine
  const tryFiles = [`卷${n}.md`, `卷${n}a.md`, `卷${n}b.md`];
  let pieces = [];
  for (const f of tryFiles) {
    const fp = path.join(HOUJI_DIR, f);
    if (fs.existsSync(fp)) pieces.push(fs.readFileSync(fp, 'utf-8'));
  }
  return pieces.length > 0 ? pieces.join('\n\n') : null;
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ===== STEP 1: replace 石匱書 vol 5-17 =====
const shikuBook = db.prepare("SELECT * FROM books WHERE slug='shiku-shu'").get();
console.log(`shiku-shu book id = ${shikuBook.id}`);

const delShiku = db.prepare(
  "DELETE FROM paragraphs WHERE book_id=? AND chapter LIKE ?"
);
const insertPara = db.prepare(
  "INSERT INTO paragraphs (book_id, chapter, chapter_order, anchor, paragraph_hash, content) VALUES (?, ?, ?, ?, ?, ?)"
);

const tx1 = db.transaction(() => {
  for (let n = 5; n <= 17; n++) {
    const cnNum = CN[n];
    const subtitle = SHIKU_SHU_TITLES[n];
    const chapter = `卷第${cnNum}·${subtitle}`;
    // Delete existing paragraphs matching this chapter
    const r = delShiku.run(shikuBook.id, `卷第${cnNum}%`);
    console.log(`  deleted ${r.changes} existing paragraphs of ${chapter}`);
    const text = loadV3Vol(n);
    if (!text) { console.log(`  !! ${n} missing`); continue; }
    const paras = splitParagraphs(text);
    paras.forEach((p, idx) => {
      const h = hash(`${shikuBook.id}|${chapter}|${idx}|${p.slice(0, 80)}`);
      insertPara.run(shikuBook.id, chapter, n, '', h, p);
    });
    console.log(`  inserted ${paras.length} paragraphs into ${chapter}`);
  }
});
tx1();

// ===== STEP 2: append 石匱書後集 vol 14-63 =====
const houjiBook = db.prepare("SELECT * FROM books WHERE slug='shiku-shu-houji'").get();
console.log(`\nshiku-shu-houji book id = ${houjiBook.id}`);

const delHouji = db.prepare(
  "DELETE FROM paragraphs WHERE book_id=? AND chapter LIKE ?"
);

const houjiVols = [12,13,14,15,16,17,18,19,20,21,22,23,24,25,28,29,32,34,35,36,37,38,39,40,41,42,44,45,46,48,49,50,51,52,53,56,57,58,59,60,61,62,63];

// Wipe everything tied to chapter_order=12 first (kills the legacy simplified-Chinese
// chapter mistitled "卷第十三" plus its 前言 modern essay tail).
const wipeOrder12 = db.prepare(
  "DELETE FROM paragraphs WHERE book_id=? AND chapter_order=12"
);
const r0 = wipeOrder12.run(houjiBook.id);
if (r0.changes > 0) console.log(`  wiped ${r0.changes} legacy paragraphs at chapter_order=12`);

const tx2 = db.transaction(() => {
  for (const n of houjiVols) {
    const cnNum = CN[n];
    if (!cnNum) { console.log(`  !! no CN for ${n}, skip`); continue; }
    const subtitle = HOUJI_TITLES[n] || '';
    const chapter = subtitle ? `石匱書後集卷第${cnNum}　${subtitle}` : `石匱書後集卷第${cnNum}`;
    // remove if already imported
    const r = delHouji.run(houjiBook.id, `石匱書後集卷第${cnNum}%`);
    if (r.changes > 0) console.log(`  removed ${r.changes} stale paras for vol ${n}`);
    const text = loadHoujiVol(n);
    if (!text) { console.log(`  !! ${n} missing`); continue; }
    const paras = splitParagraphs(text);
    paras.forEach((p, idx) => {
      const h = hash(`${houjiBook.id}|${chapter}|${idx}|${p.slice(0, 80)}`);
      insertPara.run(houjiBook.id, chapter, n, '', h, p);
    });
    console.log(`  inserted ${paras.length} paragraphs into ${chapter}`);
  }
});
tx2();

// Update book row counts
const updBook = db.prepare("UPDATE books SET chapter_count=?, paragraph_count=? WHERE id=?");
for (const id of [shikuBook.id, houjiBook.id]) {
  const stats = db.prepare(
    "SELECT COUNT(DISTINCT chapter) AS chapters, COUNT(*) AS paras FROM paragraphs WHERE book_id=?"
  ).get(id);
  updBook.run(stats.chapters, stats.paras, id);
  console.log(`  book ${id}: ${stats.chapters} chapters, ${stats.paras} paragraphs`);
}

db.close();
console.log('\ndone.');
