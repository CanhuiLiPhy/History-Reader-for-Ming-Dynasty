/**
 * 中文：「锚定阅读位置」重排算法的核心：以页首那个字为锚，重排后翻到它所在的页。
 *
 * Core of the anchored re-pagination algorithm.
 *
 * Problem with the previous approach: after a layout change (a docked side
 * panel opening, a window resize, a font-size change) the reader re-derived
 * its position from whatever the new layout happened to show, and that new
 * page start then became the reference for the next change. Every change
 * therefore drifted by up to a page, and opening + closing a panel did not
 * return to the original page. Two coarse references made it worse:
 * - EPUB: epub.js reports a page start as the start of the first visible text
 *   node. Chinese text has no spaces, so that is the start of the whole
 *   paragraph, often several pages earlier.
 * - Paragraph books: the anchor was the first paragraph *starting* on or after
 *   the page, which lies on a later page whenever a long paragraph fills it.
 *
 * Algorithm used here:
 * 1. Precise anchor — the first character rendered on the page the reader
 *    navigated to, found by binary search over the text in document order
 *    (CSS columns lay text out monotonically, so "page of character i" never
 *    decreases with i).
 * 2. Sticky anchor — only navigation (page turn, slider, table of contents,
 *    search) replaces it. A re-pagination never does, so any number of layout
 *    changes cannot accumulate drift, and returning to an earlier layout lands
 *    on exactly the earlier page: in that layout the anchor was its first
 *    character.
 * 3. Structure-proof addressing — the anchor is stored as a character offset
 *    over all text nodes plus a short context string. Wrapping text in spans
 *    (year annotations, highlights) changes neither, so the anchor resolves in
 *    a freshly rendered document too; the context string recovers it when
 *    text itself changed.
 *
 * Everything here is DOM-agnostic except the two small helpers marked as DOM
 * helpers, so the production logic is unit-tested in Node with a synthetic
 * layout model.
 */

/**
 * 中文：最小的文本节点接口，便于在 Node 里用假节点测试。
 *
 * The part of a DOM `Text` node this module reads. Real `Text` nodes satisfy
 * it; tests pass plain objects.
 */
export type AnchorTextNode = { readonly data: string };

/**
 * 中文：文本位置：第几个文本节点、节点内第几个 UTF-16 码元。
 *
 * A position inside a list of text nodes.
 *
 * @property nodeIndex - Index into the node list.
 * @property offset - UTF-16 code-unit offset inside that node's `data`.
 */
export type TextPosition = { nodeIndex: number; offset: number };

/**
 * 中文：可持久的阅读锚点：全文字符偏移 + 一小段上下文文字。
 *
 * A re-pagination-proof reading anchor.
 *
 * @property offset - Code-unit offset into the concatenation of all anchor
 *   text nodes of the scope (document order).
 * @property context - Up to {@link ANCHOR_CONTEXT_LENGTH} characters starting
 *   at `offset`, used to verify the offset and to recover it if text changed.
 */
export type TextAnchor = { offset: number; context: string };

/**
 * 中文：测量函数：返回某个字所在的页号；该字不占版面（被折叠的空白等）时返回 null。
 *
 * Measures the page (screen) index of one character.
 *
 * @param node - The text node holding the character.
 * @param offset - Code-unit offset of the character inside `node.data`.
 * @returns The zero-based page index, or `null` when the character has no box
 *   (collapsed whitespace, hidden content).
 */
export type CharPageMeasurer = (node: AnchorTextNode, offset: number) => number | null;

/** 中文：上下文片段长度。 / Characters of context stored with an anchor. */
export const ANCHOR_CONTEXT_LENGTH = 16;

/**
 * 中文：遇到不占版面的字时，最多向前/向后探查多少个字。
 *
 * How many characters to probe past an unmeasurable one.
 */
const PROBE_LIMIT = 24;

/**
 * 中文：遇到不占版面的节点（块元素之间的换行缩进等）时，最多跳过多少个节点。
 *
 * How many consecutive box-less nodes (indentation between block elements,
 * empty anchors) to skip while looking for laid-out text.
 */
const NODE_PROBE_LIMIT = 256;

/** 中文：TreeWalker 的 SHOW_TEXT 常量。 / NodeFilter.SHOW_TEXT without the global. */
const SHOW_TEXT = 0x4;

/** 中文：这些元素里的文字不参与排版。 / Text inside these elements is never laid out. */
const NON_RENDERED_PARENTS = "script, style, noscript, template, textarea";

/**
 * 中文：判断是否 UTF-16 代理对的高位。
 *
 * @param code - A UTF-16 code unit.
 * @returns True for a high (leading) surrogate, 0xD800–0xDBFF.
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 中文：判断是否 UTF-16 代理对的低位。
 *
 * @param code - A UTF-16 code unit.
 * @returns True for a low (trailing) surrogate, 0xDC00–0xDFFF.
 */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 中文：把偏移挪到字的开头，避免切开扩展区汉字（代理对）。
 *
 * Move an offset back onto a character boundary so it never splits a
 * surrogate pair (CJK Extension B+ characters are common in classical texts).
 *
 * @param data - The text node's data.
 * @param offset - A code-unit offset in `[0, data.length]`.
 * @returns `offset`, or `offset - 1` when it pointed at a trailing surrogate.
 */
export function alignToCharacter(data: string, offset: number): number {
  if (offset > 0 && offset < data.length && isLowSurrogate(data.charCodeAt(offset))
    && isHighSurrogate(data.charCodeAt(offset - 1))) {
    return offset - 1;
  }
  return offset;
}

/**
 * 中文：取最后一个占版面的字所在页；整个节点都不占版面则返回 null。
 *
 * Page of the last measurable character of a node.
 *
 * @param node - The text node.
 * @param measure - Character page measurer.
 * @returns The page index, or `null` if none of the last
 *   {@link PROBE_LIMIT} characters has a box.
 */
function lastMeasurablePage(node: AnchorTextNode, measure: CharPageMeasurer): number | null {
  const end = node.data.length - 1;
  for (let k = end; k >= 0 && end - k < PROBE_LIMIT; k -= 1) {
    const page = measure(node, alignToCharacter(node.data, k));
    if (page !== null) return page;
  }
  return null;
}

/**
 * 中文：在节点内从 offset 起向后找第一个占版面的字的页号。
 *
 * Page of the first measurable character at or after `offset` in one node.
 *
 * @param node - The text node.
 * @param offset - Starting code-unit offset.
 * @param measure - Character page measurer.
 * @returns The page index, or `null` if nothing within
 *   {@link PROBE_LIMIT} characters has a box.
 */
function forwardMeasurablePage(node: AnchorTextNode, offset: number, measure: CharPageMeasurer): number | null {
  const length = node.data.length;
  for (let k = offset; k < length && k - offset < PROBE_LIMIT; k += 1) {
    const page = measure(node, alignToCharacter(node.data, k));
    if (page !== null) return page;
  }
  return null;
}

/**
 * 中文：二分查找：找出排版在第 page 页（或更后面）的第一个字。
 *
 * Find the first character, in document order, that is rendered on page
 * `page` or later — i.e. the character at the top of that page.
 *
 * Two nested binary searches, each over a monotone predicate:
 * 1. over nodes: "the node's last character is on page ≥ `page`";
 * 2. inside the chosen node: "character k is on page ≥ `page`".
 * An unmeasurable node borrows the answer of the next measurable node (it sits
 * between its neighbours in the flow); an unmeasurable character borrows the
 * next measurable character. When even probing finds nothing the predicate is
 * taken as true, which errs towards an earlier anchor — showing a few
 * already-read lines is preferable to skipping unread ones.
 *
 * Cost: O(log N + log M) measurements (each probe bounded by
 * {@link PROBE_LIMIT}), where N = node count and M = node length.
 *
 * @param nodes - Text nodes in document order.
 * @param measure - Character page measurer for the current layout.
 * @param page - Zero-based target page index.
 * @returns The position of the page's first character, or `null` when no text
 *   is laid out on or after `page` (e.g. a trailing blank page).
 */
export function findFirstTextPositionOnPage(
  nodes: readonly AnchorTextNode[],
  measure: CharPageMeasurer,
  page: number,
): TextPosition | null {
  const nodeEndsOnOrAfter = (index: number): boolean => {
    for (let j = index; j < nodes.length && j - index < NODE_PROBE_LIMIT; j += 1) {
      if (!nodes[j].data.length) continue;
      const last = lastMeasurablePage(nodes[j], measure);
      if (last !== null) return last >= page;
    }
    return true;
  };
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (nodeEndsOnOrAfter(mid)) hi = mid;
    else lo = mid + 1;
  }
  // A box-less node cannot be the page's first character, and a node that ends
  // before the page does not reach it; skip both.
  // 不占版面的节点不可能是页首字，整段落在目标页之前的节点也够不到目标页，都跳过。
  for (let nodeIndex = lo; nodeIndex < nodes.length && nodeIndex - lo < NODE_PROBE_LIMIT; nodeIndex += 1) {
    const node = nodes[nodeIndex];
    if (!node.data.length) continue;
    const last = lastMeasurablePage(node, measure) ?? forwardMeasurablePage(node, 0, measure);
    if (last === null || last < page) continue;
    const charOnOrAfter = (k: number): boolean => {
      const measured = forwardMeasurablePage(node, k, measure);
      return measured === null ? true : measured >= page;
    };
    let a = 0;
    let b = node.data.length;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (charOnOrAfter(mid)) b = mid;
      else a = mid + 1;
    }
    if (a >= node.data.length) continue;
    return { nodeIndex, offset: alignToCharacter(node.data, a) };
  }
  return null;
}

/**
 * 中文：把（节点, 偏移）换算成全文偏移，并截取上下文，生成锚点。
 *
 * Turn a node position into a structure-independent {@link TextAnchor}.
 *
 * @param nodes - Text nodes in document order (the same list for capture and
 *   for later resolution).
 * @param position - The position to anchor, usually from
 *   {@link findFirstTextPositionOnPage}.
 * @returns The anchor: global code-unit offset plus context text.
 */
export function textAnchorAt(nodes: readonly AnchorTextNode[], position: TextPosition): TextAnchor {
  let offset = 0;
  for (let i = 0; i < position.nodeIndex && i < nodes.length; i += 1) offset += nodes[i].data.length;
  offset += position.offset;
  let context = "";
  for (let i = position.nodeIndex; i < nodes.length && context.length < ANCHOR_CONTEXT_LENGTH; i += 1) {
    context += i === position.nodeIndex ? nodes[i].data.slice(position.offset) : nodes[i].data;
  }
  return { offset, context: context.slice(0, ANCHOR_CONTEXT_LENGTH) };
}

/**
 * 中文：全文偏移 → （节点, 偏移）；超出范围时夹到最后一个字。
 *
 * Map a global code-unit offset back onto a node position.
 *
 * @param nodes - Text nodes in document order.
 * @param offset - Global code-unit offset; clamped to the available text.
 * @returns The node position, or `null` when the nodes hold no text at all.
 */
export function locateTextOffset(nodes: readonly AnchorTextNode[], offset: number): TextPosition | null {
  let remaining = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
  let lastNonEmpty = -1;
  for (let i = 0; i < nodes.length; i += 1) {
    const length = nodes[i].data.length;
    if (!length) continue;
    lastNonEmpty = i;
    if (remaining < length) return { nodeIndex: i, offset: alignToCharacter(nodes[i].data, remaining) };
    remaining -= length;
  }
  if (lastNonEmpty < 0) return null;
  const data = nodes[lastNonEmpty].data;
  return { nodeIndex: lastNonEmpty, offset: alignToCharacter(data, data.length - 1) };
}

/**
 * 中文：在全文里找离预期偏移最近的一处上下文。
 *
 * Find the occurrence of `needle` in `text` closest to `expected`.
 *
 * @param text - The concatenated text of the scope.
 * @param needle - Context string to look for (non-empty).
 * @param expected - The offset where it was expected.
 * @returns The closest match offset, or -1 when `needle` does not occur.
 */
function nearestOccurrence(text: string, needle: string, expected: number): number {
  let best = -1;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (best === -1 || Math.abs(at - expected) < Math.abs(best - expected)) best = at;
    if (at > expected) break;
  }
  return best;
}

/**
 * 中文：在当前文档里还原锚点：先按偏移核对上下文，不符则就近搜索上下文。
 *
 * Resolve an anchor against the current text.
 *
 * 1. If the text at `anchor.offset` starts with `anchor.context`, use it.
 * 2. Otherwise (text changed, e.g. simplified ↔ traditional conversion with
 *    different lengths) use the nearest occurrence of the context, then of its
 *    first half.
 * 3. Otherwise fall back to the raw offset, clamped.
 *
 * @param nodes - Text nodes of the current document, in document order.
 * @param anchor - The anchor captured earlier.
 * @returns The node position of the anchor character, or `null` if there is
 *   no text.
 */
export function resolveTextAnchor(nodes: readonly AnchorTextNode[], anchor: TextAnchor): TextPosition | null {
  const context = anchor.context || "";
  if (context) {
    const text = nodes.map((node) => node.data).join("");
    if (!text.startsWith(context, anchor.offset)) {
      for (const needle of [context, context.slice(0, Math.ceil(context.length / 2))]) {
        if (needle.length < 4) continue;
        const found = nearestOccurrence(text, needle, anchor.offset);
        if (found !== -1) return locateTextOffset(nodes, found);
      }
    }
  }
  return locateTextOffset(nodes, anchor.offset);
}

/**
 * 中文：某个文本位置所在页；该字不占版面时向后（再向前）找最近的字。
 *
 * Page index of a text position, probing forward (then backward) past
 * characters and nodes that have no box.
 *
 * @param nodes - Text nodes in document order.
 * @param position - The position to measure.
 * @param measure - Character page measurer for the current layout.
 * @returns The page index, or `null` when nothing nearby is measurable.
 */
export function pageOfTextPosition(
  nodes: readonly AnchorTextNode[],
  position: TextPosition,
  measure: CharPageMeasurer,
): number | null {
  const start = nodes[position.nodeIndex];
  if (!start) return null;
  const forward = forwardMeasurablePage(start, position.offset, measure);
  if (forward !== null) return forward;
  for (let i = position.nodeIndex + 1; i < nodes.length && i - position.nodeIndex <= NODE_PROBE_LIMIT; i += 1) {
    const page = forwardMeasurablePage(nodes[i], 0, measure);
    if (page !== null) return page;
  }
  for (let i = position.nodeIndex; i >= 0 && position.nodeIndex - i <= NODE_PROBE_LIMIT; i -= 1) {
    const page = lastMeasurablePage(nodes[i], measure);
    if (page !== null) return page;
  }
  return null;
}

/**
 * 中文：DOM 工具：按文档顺序收集参与排版的全部文本节点。
 *
 * DOM helper: every text node under `root` that can be laid out, in document
 * order. Whitespace-only nodes are kept on purpose: dropping them would make
 * offsets depend on how text happens to be split into nodes, whereas keeping
 * everything makes the global offset equal to the scope's rendered text, which
 * span-wrapping (annotations, highlights) leaves unchanged.
 *
 * @param root - The scope element (EPUB `<body>`, the paragraph article, ...).
 * @returns Text nodes in document order.
 */
export function collectAnchorTextNodes(root: Node): Text[] {
  const doc = root.ownerDocument;
  if (!doc) return [];
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data.length) continue;
    if (text.parentElement?.closest(NON_RENDERED_PARENTS)) continue;
    nodes.push(text);
  }
  return nodes;
}

/**
 * 中文：DOM 工具：用一个 Range 逐字测量，把字的版面矩形换算成页号。
 *
 * DOM helper: build a {@link CharPageMeasurer} from a document and a mapping
 * from a character's client rect to a page index.
 *
 * @param doc - The document owning the text nodes (an EPUB iframe's document
 *   or the main document).
 * @param pageOfRect - Maps a character's client rect (in `doc`'s viewport
 *   coordinates) to a zero-based page index.
 * @returns A measurer that reuses a single Range for every measurement.
 */
export function createRangeCharMeasurer(
  doc: Document,
  pageOfRect: (rect: DOMRect) => number,
): CharPageMeasurer {
  const range = doc.createRange();
  return (node, offset) => {
    const text = node as Text;
    const length = text.data.length;
    if (offset < 0 || offset >= length) return null;
    // A supplementary-plane character spans two code units. / 扩展区汉字占两个码元。
    const end = Math.min(length, offset + (isHighSurrogate(text.data.charCodeAt(offset)) ? 2 : 1));
    try {
      range.setStart(text, offset);
      range.setEnd(text, end);
    } catch {
      return null;
    }
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i += 1) {
      const rect = rects[i];
      if (rect.width > 0 || rect.height > 0) return pageOfRect(rect);
    }
    return null;
  };
}
