// Saving and restoring the precise reading position (lib/reading-position)
// against the production anchor helpers and a synthetic column layout.
// 用正式的锚点代码和模拟分栏版面，测试精确阅读位置的保存与恢复。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

/**
 * Transpile a TypeScript module and import it from a data URL.
 * 把 TypeScript 模块转译后经 data URL 导入。
 */
async function importTs(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const { findFirstTextPositionOnPage, textAnchorAt, resolveTextAnchor, pageOfTextPosition } = await importTs("../src/lib/reflow-anchor.ts");
const {
  READING_POSITION_VERSION, readingPositionStorageName, epubReadingPosition, dbReadingPosition, parseReadingPosition,
  epubPositionToRestore, dbPositionToRestore, sameReadingPosition,
} = await importTs("../src/lib/reading-position.ts");

const PROSE = "太祖開天行道肇紀立極大聖至神仁文義武俊德成功高皇帝，諱元璋，字國瑞，姓朱氏。先世家沛，徙句容，再徙泗州。";
const REIGN = "洪武元年";
const CFI = "epubcfi(/6/14!/4/2/22/1:0)";

/**
 * A section as epub.js first renders it: one text node per paragraph, with
 * whitespace-only nodes between block elements.
 */
function freshSection(paragraphs = 30) {
  const nodes = [];
  for (let i = 0; i < paragraphs; i += 1) {
    nodes.push({ data: "\n    " });
    nodes.push({ data: `　　${PROSE.repeat(1 + (i % 3))}${REIGN}正月，${PROSE}${i}` });
  }
  nodes.push({ data: "\n" });
  return nodes;
}

/**
 * The same section after year annotation: each reign date is wrapped in a span,
 * which splits its paragraph's text node into three. The text is unchanged.
 */
function annotate(nodes) {
  const out = [];
  for (const node of nodes) {
    const parts = node.data.split(REIGN);
    parts.forEach((part, i) => {
      if (i > 0) out.push({ data: REIGN });
      if (part) out.push({ data: part });
    });
  }
  return out;
}

/**
 * Layout model: visible characters fill pages of `perPage`; whitespace other
 * than the full-width indent is collapsed and has no box.
 */
function layout(nodes, perPage) {
  const pageOf = new Map();
  let visible = 0;
  for (const node of nodes) {
    const pages = [];
    for (const ch of node.data.split("")) {
      if (/\s/.test(ch) && ch !== "　") { pages.push(null); continue; }
      pages.push(Math.floor(visible / perPage));
      visible += 1;
    }
    pageOf.set(node, pages);
  }
  return { measure: (node, offset) => pageOf.get(node)[offset] ?? null, pages: Math.ceil(visible / perPage) };
}

/** Capture the first character of `page`, as the reader does when it saves. */
function captureFirstCharacter(nodes, model, page) {
  const position = findFirstTextPositionOnPage(nodes, model.measure, page);
  assert.ok(position, `page ${page} has text`);
  return textAnchorAt(nodes, position);
}

/** Page holding `anchor` in a document, as the reader computes when it restores. */
function restoredPage(nodes, model, anchor) {
  const position = resolveTextAnchor(nodes, anchor);
  assert.ok(position, "anchor resolves");
  return pageOfTextPosition(nodes, position, model.measure);
}

/** Round trip through the persistence layer, which stores JSON-compatible values. */
const storeAndLoad = (record) => JSON.parse(JSON.stringify(record));

test("EPUB: the saved first character reopens on the same page, before and after year annotation", () => {
  const fresh = freshSection();
  const annotated = annotate(fresh);
  assert.ok(annotated.length > fresh.length, "annotation splits text nodes");
  for (const perPage of [37, 120, 301]) {
    // The page is saved on the annotated DOM; reopening first lays out the fresh one.
    // 保存时是标注后的 DOM；重新打开时先排的是未标注的新 DOM。
    const savedLayout = layout(annotated, perPage);
    const freshLayout = layout(fresh, perPage);
    const reannotated = annotate(fresh);
    const reannotatedLayout = layout(reannotated, perPage);
    for (let page = 0; page < savedLayout.pages; page += 1) {
      const anchor = captureFirstCharacter(annotated, savedLayout, page);
      const saved = storeAndLoad(epubReadingPosition(CFI, 7, anchor));
      const restore = epubPositionToRestore(saved, CFI);
      assert.ok(restore, "a record saved with this CFI is restored");
      assert.equal(restore.sectionIndex, 7);
      assert.equal(restoredPage(fresh, freshLayout, restore), page, `fresh DOM, page ${page} at ${perPage}/page`);
      assert.equal(restoredPage(reannotated, reannotatedLayout, restore), page, `annotated again, page ${page}`);
      // The restored page starts with the very character that was saved.
      // 恢复后的那一页，页首正是保存的那个字。
      assert.equal(captureFirstCharacter(fresh, freshLayout, page).offset, restore.offset);
    }
  }
});

test("EPUB: a paragraph-start placement lands pages early; the saved character does not", () => {
  // epub.js's CFI points at the start of the first visible text node: the
  // paragraph start. 旧的 CFI 只能定位到首个可见文本节点的开头，也就是段首。
  const fresh = freshSection();
  const model = layout(fresh, 37);
  let earlier = 0;
  for (let page = 0; page < model.pages; page += 1) {
    const position = findFirstTextPositionOnPage(fresh, model.measure, page);
    const paragraphStartPage = pageOfTextPosition(fresh, { nodeIndex: position.nodeIndex, offset: 0 }, model.measure);
    if (paragraphStartPage < page) earlier += 1;
    const saved = storeAndLoad(epubReadingPosition(CFI, 0, textAnchorAt(fresh, position)));
    assert.equal(restoredPage(fresh, model, epubPositionToRestore(saved, CFI)), page);
  }
  assert.ok(earlier > model.pages / 2, `paragraph starts fall on an earlier page for ${earlier} of ${model.pages} pages`);
});

test("EPUB: a record applies only when the book is reopened at exactly its CFI", () => {
  const record = storeAndLoad(epubReadingPosition(CFI, 3, { offset: 120, context: "太祖開天行道" }));
  assert.ok(epubPositionToRestore(record, CFI));
  // A later CFI written without a record, a search jump to a chapter href, no location at all.
  // 之后写入的 CFI 没有配套记录、检索跳到章节 href、没有保存位置。
  assert.equal(epubPositionToRestore(record, "epubcfi(/6/16!/4/2/1:0)"), null);
  assert.equal(epubPositionToRestore(record, "Text/chapter-003.xhtml#p12"), null);
  assert.equal(epubPositionToRestore(record, ""), null);
  // A paragraph-book record never drives an EPUB. / 段落书的记录不用于 EPUB。
  assert.equal(epubPositionToRestore(dbReadingPosition(3, { offset: 120, context: "" }), CFI), null);
});

test("paragraph book: the saved chapter and first character reopen on the same page", () => {
  const fresh = freshSection(12);
  // Saved while highlights wrapped part of the text in spans. / 保存时有划线把部分文字包进了 span。
  const highlighted = annotate(fresh);
  for (const perPage of [50, 173]) {
    const savedLayout = layout(highlighted, perPage);
    const freshLayout = layout(fresh, perPage);
    for (let page = 0; page < savedLayout.pages; page += 1) {
      const saved = storeAndLoad(dbReadingPosition(4, captureFirstCharacter(highlighted, savedLayout, page)));
      const restore = dbPositionToRestore(saved, 10);
      assert.equal(restore.chapterIndex, 4);
      assert.equal(restoredPage(fresh, freshLayout, restore), page, `page ${page} at ${perPage}/page`);
    }
  }
  const saved = dbReadingPosition(4, { offset: 0, context: "　　太祖" });
  assert.equal(dbPositionToRestore(saved, 4), null, "a chapter that no longer exists opens chapter 0 instead");
  assert.equal(dbPositionToRestore(epubReadingPosition(CFI, 4, saved), 10), null, "an EPUB record never drives a paragraph book");
});

test("reopening again and again never drifts: the restored page saves the same record", () => {
  const fresh = freshSection();
  const model = layout(fresh, 61);
  const annotated = annotate(fresh);
  const page = Math.floor(model.pages * 0.6);
  const first = epubReadingPosition(CFI, 2, captureFirstCharacter(annotated, layout(annotated, 61), page));
  let saved = first;
  for (let reopen = 0; reopen < 5; reopen += 1) {
    const restore = epubPositionToRestore(storeAndLoad(saved), CFI);
    const landed = restoredPage(fresh, model, restore);
    assert.equal(landed, page);
    saved = epubReadingPosition(CFI, 2, captureFirstCharacter(fresh, model, landed));
    assert.ok(sameReadingPosition(saved, first), `reopening #${reopen + 1} saves an identical record`);
  }
});

test("text that changed before the saved character is recovered through its context", () => {
  const fresh = freshSection();
  const model = layout(fresh, 80);
  const page = 9;
  const record = storeAndLoad(dbReadingPosition(0, captureFirstCharacter(fresh, model, page)));
  // A longer chapter heading shifts every offset after it. / 章节标题变长，其后的偏移整体后移。
  const edited = [{ data: "本紀第一　太祖一（校訂本）" }, ...fresh];
  const position = resolveTextAnchor(edited, dbPositionToRestore(record, 1));
  const text = edited.map((node) => node.data).join("");
  const at = edited.slice(0, position.nodeIndex).reduce((sum, node) => sum + node.data.length, 0) + position.offset;
  assert.ok(text.startsWith(record.context, at), "the saved character is found again");
  assert.notEqual(at, record.offset);
});

test("malformed, foreign or older stored values are treated as no record", () => {
  const anchor = { offset: 10, context: "太祖開天" };
  for (const value of [
    null, undefined, "epubcfi(/6/2!/4/1:0)", 42, [], {},
    { ...epubReadingPosition(CFI, 1, anchor), v: READING_POSITION_VERSION + 1 },
    { ...epubReadingPosition(CFI, 1, anchor), kind: "pdf" },
    { ...epubReadingPosition(CFI, 1, anchor), cfi: "Text/c1.xhtml" },
    { ...epubReadingPosition(CFI, 1, anchor), sectionIndex: -1 },
    { ...epubReadingPosition(CFI, 1, anchor), offset: 1.5 },
    { ...epubReadingPosition(CFI, 1, anchor), offset: -3 },
    { ...dbReadingPosition(1, anchor), context: null },
    { ...dbReadingPosition(1, anchor), chapterIndex: "1" },
  ]) {
    assert.equal(parseReadingPosition(value), null, JSON.stringify(value));
  }
  assert.equal(epubReadingPosition(CFI, 1, null), null, "nothing is saved without an anchor");
  const long = parseReadingPosition(dbReadingPosition(0, { offset: 0, context: "字".repeat(200) }));
  assert.ok(long.context.length <= 64, "context is capped");
  assert.equal(readingPositionStorageName("ming-shi"), "reading-position:ming-shi");
});

test("unchanged positions are recognised so they are not written again", () => {
  const a = epubReadingPosition(CFI, 1, { offset: 10, context: "太祖" });
  assert.ok(sameReadingPosition(a, storeAndLoad(a)));
  assert.ok(!sameReadingPosition(a, epubReadingPosition(CFI, 1, { offset: 11, context: "祖開" })));
  assert.ok(!sameReadingPosition(a, epubReadingPosition("epubcfi(/6/4!/4/1:0)", 1, { offset: 10, context: "太祖" })));
  assert.ok(!sameReadingPosition(a, dbReadingPosition(1, { offset: 10, context: "太祖" })));
  assert.ok(!sameReadingPosition(a, null));
  assert.ok(sameReadingPosition(null, null));
});
