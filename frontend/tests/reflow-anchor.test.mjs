// Runs the production anchored re-pagination helpers against a synthetic
// column layout: N visible characters per page, collapsed whitespace has no box.
// 用「每页 N 个可见字、折叠空白不占版面」的模拟分栏版面测试正式代码。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/reflow-anchor.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const {
  findFirstTextPositionOnPage, textAnchorAt, resolveTextAnchor, locateTextOffset, pageOfTextPosition, alignToCharacter,
} = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const PROSE = "太祖開天行道肇紀立極大聖至神仁文義武俊德成功高皇帝，諱元璋，字國瑞，姓朱氏。先世家沛，徙句容，再徙泗州。";

/** Paragraph-like nodes separated by whitespace-only nodes, as in EPUB XHTML. */
function makeNodes(paragraphs = 40) {
  const nodes = [];
  for (let i = 0; i < paragraphs; i += 1) {
    nodes.push({ data: "\n    " });
    nodes.push({ data: `　　${PROSE.repeat(1 + (i % 4))}${i}` });
  }
  nodes.push({ data: "\n" });
  return nodes;
}

/**
 * Layout model: visible characters fill pages of `perPage`; whitespace
 * (other than the full-width indent) is collapsed and has no box.
 */
function layout(nodes, perPage) {
  const starts = new Map();
  let visible = 0;
  const pageOf = new Map();
  for (const node of nodes) {
    const pages = [];
    for (const ch of node.data.split("")) {
      if (/\s/.test(ch) && ch !== "　") { pages.push(null); continue; }
      pages.push(Math.floor(visible / perPage));
      visible += 1;
    }
    pageOf.set(node, pages);
    starts.set(node, visible);
  }
  let calls = 0;
  const measure = (node, offset) => { calls += 1; return pageOf.get(node)[offset] ?? null; };
  return { measure, pages: Math.ceil(visible / perPage), calls: () => calls, pageOf };
}

/** Brute-force reference: first character whose box is on page ≥ target. */
function bruteFirst(nodes, model, page) {
  for (let i = 0; i < nodes.length; i += 1) {
    const pages = model.pageOf.get(nodes[i]);
    for (let k = 0; k < pages.length; k += 1) if (pages[k] !== null && pages[k] >= page) return { nodeIndex: i, offset: k };
  }
  return null;
}

test("binary search finds exactly the first character of every page", () => {
  const nodes = makeNodes();
  for (const perPage of [37, 120, 511]) {
    const model = layout(nodes, perPage);
    for (let page = 0; page < model.pages; page += 1) {
      assert.deepEqual(findFirstTextPositionOnPage(nodes, model.measure, page), bruteFirst(nodes, model, page), `page ${page} at ${perPage}/page`);
    }
    assert.equal(findFirstTextPositionOnPage(nodes, model.measure, model.pages), null, "no text after the last page");
  }
});

test("lookups stay logarithmic on long chapters", () => {
  const nodes = makeNodes(4000);
  const model = layout(nodes, 300);
  findFirstTextPositionOnPage(nodes, model.measure, Math.floor(model.pages * 0.7));
  assert.ok(model.calls() < 600, `measured ${model.calls()} characters`);
});

test("a sticky anchor returns to the original page after any number of layout changes", () => {
  const nodes = makeNodes();
  const narrow = layout(nodes, 61);
  const wide = layout(nodes, 97);
  const startPage = 9;
  const anchor = textAnchorAt(nodes, findFirstTextPositionOnPage(nodes, wide.measure, startPage));
  const globalOffset = (position) => textAnchorAt(nodes, position).offset;
  for (let round = 0; round < 5; round += 1) {
    const inNarrow = pageOfTextPosition(nodes, resolveTextAnchor(nodes, anchor), narrow.measure);
    // The narrow page shown contains the anchor character. / 窄版面显示的那一页包含锚点字。
    assert.ok(globalOffset(findFirstTextPositionOnPage(nodes, narrow.measure, inNarrow)) <= anchor.offset);
    assert.ok(globalOffset(findFirstTextPositionOnPage(nodes, narrow.measure, inNarrow + 1)) > anchor.offset);
    assert.equal(pageOfTextPosition(nodes, resolveTextAnchor(nodes, anchor), wide.measure), startPage);
  }
});

test("re-deriving the anchor from each new layout drifts; the sticky anchor does not", () => {
  // Reproduces the previous behaviour: the new page start becomes the next reference.
  // 复现旧做法：每次重排后把新页首当成下一次的参照。
  const nodes = makeNodes();
  const narrow = layout(nodes, 61);
  const wide = layout(nodes, 97);
  let page = 9;
  for (let round = 0; round < 3; round += 1) {
    const inWide = textAnchorAt(nodes, findFirstTextPositionOnPage(nodes, wide.measure, page));
    const narrowPage = pageOfTextPosition(nodes, resolveTextAnchor(nodes, inWide), narrow.measure);
    const rederived = textAnchorAt(nodes, findFirstTextPositionOnPage(nodes, narrow.measure, narrowPage));
    page = pageOfTextPosition(nodes, resolveTextAnchor(nodes, rederived), wide.measure);
  }
  assert.ok(page < 9, `re-deriving drifted to page ${page}`);
});

test("anchors survive span wrapping and recover from changed text", () => {
  const nodes = makeNodes(12);
  const model = layout(nodes, 50);
  const position = findFirstTextPositionOnPage(nodes, model.measure, 6);
  const anchor = textAnchorAt(nodes, position);
  // Wrapping text in spans splits nodes but keeps the concatenated text.
  // 用 span 包裹文字会拆分节点，但拼接后的全文不变。
  const split = nodes.flatMap((node) => node.data.length > 8
    ? [{ data: node.data.slice(0, 5) }, { data: node.data.slice(5, 9) }, { data: node.data.slice(9) }]
    : [node]);
  const resolved = resolveTextAnchor(split, anchor);
  assert.equal(textAnchorAt(split, resolved).offset, anchor.offset);
  assert.equal(textAnchorAt(split, resolved).context, anchor.context);
  // Text inserted earlier shifts offsets; the context string finds the place again.
  // 前文多出文字时偏移会变，靠上下文重新找到原处。
  const changed = [{ data: "增補一句。" }, ...nodes];
  const recovered = resolveTextAnchor(changed, anchor);
  assert.equal(textAnchorAt(changed, recovered).context, anchor.context);
  // Unknown context falls back to the clamped offset. / 上下文找不到时退回原偏移（夹到末尾）。
  assert.deepEqual(resolveTextAnchor(nodes, { offset: 10 ** 9, context: "" }), locateTextOffset(nodes, 10 ** 9));
  assert.equal(locateTextOffset([], 3), null);
});

test("offsets never split supplementary-plane characters", () => {
  const rare = "𠀀"; // U+20000
  const nodes = [{ data: `${rare}${rare}甲${rare}乙` }];
  assert.equal(alignToCharacter(nodes[0].data, 1), 0);
  assert.equal(alignToCharacter(nodes[0].data, 3), 2);
  assert.equal(alignToCharacter(nodes[0].data, 4), 4);
  // Second page starts at the third visible glyph (the U+20000 after 甲).
  const pageOf = [0, 0, 0, 0, 0, 1, 1, 1];
  const measure = (_node, offset) => pageOf[offset];
  const position = findFirstTextPositionOnPage(nodes, measure, 1);
  assert.deepEqual(position, { nodeIndex: 0, offset: 5 });
  assert.deepEqual(locateTextOffset(nodes, 6), { nodeIndex: 0, offset: 5 });
});
