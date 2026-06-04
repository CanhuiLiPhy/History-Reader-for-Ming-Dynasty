/**
 * 用 AI 重新标点每篇前 ~200 字，修复 jiayan 在开篇段落的常见错误
 * （专名切开 / 句末类型不分 / 主语过早断句）。
 *
 * 算法：
 *   1. 按 (book, chapter_order) 分组，取前若干段直到累计 >= 200 字
 *   2. 把当前（jiayan 标点过的）content 喂给 AI，prompt 要求：只改标点，不增删字
 *   3. AI 返回后做严格校验：去掉所有标点后必须与原 content 去标点后完全相同
 *   4. 通过校验后 UPDATE paragraphs.content
 *
 * Usage:
 *   node backend/scripts/repunct-chapter-openings.mjs --slugs ming-shi-lu,siku-mingshi,donglin-liezhuan,shu-yuan-zaji [--limit N] [--dry-run] [--concurrency 8]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(HERE, "..", ".env");
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

import { getDb, initializeLibrary } from "../src/services/library-db.js";

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? "" : (process.argv[i + 1] || "");
}
function hasFlag(flag) { return process.argv.includes(flag); }

const SLUGS = (readArg("--slugs") || "ming-shi-lu,siku-mingshi,donglin-liezhuan,shu-yuan-zaji").split(",").map(s => s.trim()).filter(Boolean);
const LIMIT = Number(readArg("--limit") || "0");
const DRY = hasFlag("--dry-run");
const CONC = Number(readArg("--concurrency") || "8");
const MIN_CHARS = Number(readArg("--min-chars") || "200");
const MODEL = readArg("--model") || process.env.AI_SMALL_MODEL || "qwen3.6-flash";

const BASE_URL = process.env.AI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const API_KEY = process.env.AI_API_KEY;
if (!API_KEY) { console.error("AI_API_KEY missing"); process.exit(1); }

const PUNCT_CHARS_SET = new Set("，。：；？！「」、,.:;?!\"'《》〈〉()（）—…—-");

function stripPunct(s) {
  let out = "";
  for (const c of s) if (!PUNCT_CHARS_SET.has(c) && c !== " " && c !== "\n" && c !== "\t" && c !== "　") out += c;
  return out;
}

const SYSTEM_PROMPT = `你是古籍标点专家。给你一段或多段未加标点的明清史料文段（多段之间以换行隔开），请按古文阅读习惯加上中文标点（，。：；？！、）。

严格规则：
- 绝对不要增删或修改任何非标点字符：所有汉字、繁体字、异体字、校勘括号【】〖〗、空白圆点○、IDS 字符 ⿰⿱⿲ 等一律原样保留。
- 输入有几行，输出就要有几行（行数与位置完全对应）。
- 注意专有名词（人名、地名、书名、官署名）不要被逗号切开。
- 句末用「。」、感叹用「！」、问句用「？」。
- 不要给书名加《》、不要给引文加「」、不要做繁简转换、不要订正错字。
- 输出仅返回加好标点的纯文本，不要任何解释、引号、markdown 或前后语。`;

function stripAllPunct(s) {
  // strip punct AND whitespace — match stripPunct exactly
  return stripPunct(s);
}

function buildUserPrompt(text) {
  return `请给下面这段古文加上标点：\n\n${text}`;
}

async function callAI(text, attempt = 0) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(text) },
    ],
    temperature: 0.0,
    max_tokens: Math.max(2048, text.length * 4 + 1500),
  };
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    const json = JSON.parse(txt);
    const out = (json.choices?.[0]?.message?.content || "").trim();
    return out;
  } catch (e) {
    if (attempt < 1 && /timeout|ECONN|ETIMEDOUT|429|500|503/i.test(String(e))) {
      return callAI(text, attempt + 1);
    }
    throw e;
  }
}

await initializeLibrary();
const db = getDb();
const updateStmt = db.prepare(`UPDATE paragraphs SET content = ? WHERE id = ?`);
const tx = db.transaction(updates => {
  for (const { id, content } of updates) updateStmt.run(content, id);
});

// Gather work items per slug
const allTasks = []; // { slug, chapter_order, ids: [], origs: [], combined: str }
for (const slug of SLUGS) {
  const book = db.prepare("SELECT id, title FROM books WHERE slug = ?").get(slug);
  if (!book) { console.warn(`[skip] slug not found: ${slug}`); continue; }
  const rows = db.prepare(`
    SELECT id, chapter, chapter_order, content
    FROM paragraphs WHERE book_id = ?
    ORDER BY chapter_order, id
  `).all(book.id);
  const byCh = new Map();
  for (const r of rows) {
    if (!byCh.has(r.chapter_order)) byCh.set(r.chapter_order, []);
    byCh.get(r.chapter_order).push(r);
  }
  for (const [chOrder, paras] of byCh) {
    const picked = [];
    let total = 0;
    for (const p of paras) {
      picked.push(p);
      total += p.content.length;
      if (total >= MIN_CHARS) break;
    }
    allTasks.push({ slug, chapter: paras[0].chapter, chapter_order: chOrder, paras: picked });
  }
}

if (LIMIT > 0) allTasks.length = Math.min(LIMIT, allTasks.length);

console.log(`Books: ${SLUGS.join(", ")}`);
console.log(`Chapters to process: ${allTasks.length}`);
console.log(`Model: ${MODEL} via ${BASE_URL}`);
console.log(`Concurrency: ${CONC}, Min chars: ${MIN_CHARS}`);
console.log(`Mode: ${DRY ? "DRY-RUN" : "LIVE UPDATE"}`);
console.log();

let done = 0, ok = 0, failed = 0, charMis = 0;
const failures = [];

async function processOne(task) {
  // Concatenate paragraphs with newline; AI will return same shape
  const origCombined = task.paras.map(p => p.content).join("\n");
  // Strip ALL punctuation before sending; AI re-punctuates from scratch
  const strippedInput = task.paras.map(p => stripAllPunct(p.content)).join("\n");
  let result;
  try {
    result = await callAI(strippedInput);
  } catch (e) {
    failed++;
    failures.push({ slug: task.slug, chapter: task.chapter, error: e.message });
    return;
  }
  // Split back by newline; AI may collapse or add. Try to handle:
  let returnedParts = result.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (returnedParts.length !== task.paras.length) {
    // Try: if AI returned single line, split proportionally by stripped-char position
    if (returnedParts.length === 1 && task.paras.length > 1) {
      const stripped = stripPunct(returnedParts[0]);
      const expectedTotal = stripPunct(origCombined);
      if (stripped !== expectedTotal) {
        charMis++;
        failures.push({ slug: task.slug, chapter: task.chapter, note: "single-line mismatch", origLen: expectedTotal.length, gotLen: stripped.length });
        return;
      }
      // Re-split by char-counting against each paragraph's stripped length
      const newParts = [];
      let pos = 0;
      for (let i = 0; i < task.paras.length; i++) {
        const targetLen = stripPunct(task.paras[i].content).length;
        // Walk through `returnedParts[0]` collecting chars until we cover targetLen content chars
        let collected = 0, j = pos;
        while (j < returnedParts[0].length && collected < targetLen) {
          if (!PUNCT_CHARS_SET.has(returnedParts[0][j])) collected++;
          j++;
        }
        // Also trail any punctuation right after
        while (j < returnedParts[0].length && PUNCT_CHARS_SET.has(returnedParts[0][j])) j++;
        newParts.push(returnedParts[0].slice(pos, j));
        pos = j;
      }
      returnedParts = newParts;
    } else {
      charMis++;
      failures.push({ slug: task.slug, chapter: task.chapter, note: `part count mismatch: got ${returnedParts.length}, want ${task.paras.length}` });
      return;
    }
  }
  // Strict per-paragraph validation: stripped content must match
  const updates = [];
  for (let i = 0; i < task.paras.length; i++) {
    const orig = task.paras[i].content;
    const got = returnedParts[i];
    if (stripPunct(orig) !== stripPunct(got)) {
      charMis++;
      failures.push({ slug: task.slug, chapter: task.chapter, paraId: task.paras[i].id, note: "char mismatch", origLen: stripPunct(orig).length, gotLen: stripPunct(got).length });
      return;
    }
    if (got !== orig) {
      updates.push({ id: task.paras[i].id, content: got });
    }
  }
  if (!DRY && updates.length) tx(updates);
  ok++;
}

async function runBatch() {
  // Proper worker pool: CONC workers each pull from shared queue
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < allTasks.length) {
      const myIdx = nextIdx++;
      const task = allTasks[myIdx];
      try { await processOne(task); }
      catch (e) { failed++; failures.push({ slug: task.slug, chapter: task.chapter, error: e.message || String(e) }); }
      done++;
      if (done % 25 === 0 || done === allTasks.length) {
        console.log(`progress: ${done}/${allTasks.length} (ok=${ok}, fail=${failed}, char-mismatch=${charMis})`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
}

await runBatch();

console.log("");
console.log("=".repeat(70));
console.log(`Chapters processed: ${done}`);
console.log(`Updated OK:         ${ok}`);
console.log(`API failed:         ${failed}`);
console.log(`Char mismatch:      ${charMis}`);
if (failures.length && failures.length <= 12) {
  for (const f of failures) console.log("  ", f);
} else if (failures.length) {
  console.log(`  ${failures.length} failures (first 8):`);
  for (const f of failures.slice(0, 8)) console.log("  ", f);
}
