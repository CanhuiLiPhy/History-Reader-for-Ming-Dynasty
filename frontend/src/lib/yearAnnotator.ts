import { REIGN_DATE_PATTERN, resolveReignDateMatch, type DateDisplayMode } from "./reign";

function shouldSkipNode(node: Text) {
  const parent = node.parentElement;
  if (!parent) return true;
  if (parent.closest("[data-year-annotation='true']")) return true;
  return Boolean(parent.closest("script, style, textarea, code, pre"));
}

// Bare "X年" without a reign prefix inherits from the most recently seen
// reign — but only within a reasonable text window. Beyond this many text
// nodes' worth of distance the inherited reign is unlikely to still apply.
const INHERIT_WINDOW_NODES = 80;

export type ReaderDocumentStyleOptions = {
  layoutMode?: "horizontal" | "vertical";
  dateDisplay?: DateDisplayMode;
  showEmperor?: boolean;
};

export function injectReaderDocumentStyles(doc: Document, options: ReaderDocumentStyleOptions = {}) {
  const vertical = options.layoutMode === "vertical";
  let style = doc.getElementById("mingshi-inline-styles") as HTMLStyleElement | null;

  if (!style) {
    style = doc.createElement("style");
    style.id = "mingshi-inline-styles";
    doc.head.appendChild(style);
  }
  // In vertical mode, we do NOT set writing-mode on body because it breaks
  // epubjs pagination (total=1 for every section). Instead we set it on a
  // wrapper div and switch to scrolled/overflow layout.
  style.textContent = `
    body {
      background: transparent !important;
      color: #1f160f !important;
      font-family: "Source Han Serif SC", "Noto Serif SC", "Songti SC", serif !important;
      line-height: 1.92 !important;
      letter-spacing: 0.01em !important;
      padding: 1.2rem 1rem !important;
      overflow-wrap: break-word !important;
      ${vertical ? "overflow-x: auto !important; overflow-y: hidden !important; writing-mode: vertical-rl !important; text-orientation: mixed !important; height: 100% !important;" : ""}
    }
    p {
      text-indent: 2em;
      margin: ${vertical ? "0 0 0 1em" : "0 0 1em"};
    }
    a {
      color: #2f2115 !important;
      text-decoration: none !important;
    }
    h1, h2, h3, h4 {
      color: #2c1c11 !important;
      text-align: center;
      font-weight: 700;
    }
    .mingshi-year-annotation {
      color: #774512;
      background: rgba(211, 152, 58, 0.14);
      border-bottom: 1px dashed rgba(119, 69, 18, 0.45);
      border-radius: 0.3rem;
      cursor: help;
      padding: 0 0.1em;
      position: relative;
    }
    /* CSS tooltip — instant, no native title delay. data-note carries the
       Gregorian year + emperor; ::after shows on hover. */
    .mingshi-year-annotation::after {
      content: attr(data-note);
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      background: rgba(38, 25, 18, 0.94);
      color: #f5e9c8;
      padding: 0.4em 0.8em;
      border-radius: 0.4em;
      font-size: 0.78rem;
      line-height: 1.55;
      width: max-content;
      max-width: min(40rem, 80vw);
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.12s ease;
      z-index: 9999;
    }
    .mingshi-year-annotation:hover::after {
      opacity: 1;
    }
  `;
}

export function annotateYearMentions(doc: Document, options: ReaderDocumentStyleOptions = {}) {
  injectReaderDocumentStyles(doc, options);
  const root = doc.body;
  if (!root) return;
  const dateMode: DateDisplayMode = options.dateDisplay ?? "lunar";
  const showEmperor = options.showEmperor ?? false;

  // Walk every text node — we now also need nodes that don't directly contain
  // "<reign>X年" so the bare "X年" cases inherit context. The pattern test on
  // each node still skips fast-path empty/non-date nodes.
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (shouldSkipNode(node)) continue;
    if (!node.nodeValue) continue;
    textNodes.push(node);
  }

  // Document-order context: which reign was most recently introduced. Reset
  // when crossing block boundaries that look like chapter / heading breaks.
  let contextReign: string | null = null;
  let nodesSinceContext = 0;

  for (const node of textNodes) {
    const source = node.nodeValue || "";

    // Heuristic chapter break: nodes whose parent is a heading element start a
    // fresh context (so a chapter about 嘉靖 doesn't bleed reign into a later
    // 万历 chapter via inherited context).
    if (node.parentElement?.closest("h1, h2, h3, h4, h5, h6")) {
      contextReign = null;
      nodesSinceContext = 0;
    }
    if (contextReign && nodesSinceContext++ > INHERIT_WINDOW_NODES) {
      contextReign = null;
    }

    const regex = new RegExp(REIGN_DATE_PATTERN.source, "g");
    const matches = [...source.matchAll(regex)];
    if (!matches.length) continue;

    const fragment = doc.createDocumentFragment();
    let lastIndex = 0;

    for (const match of matches) {
      const index = match.index ?? 0;
      if (index > lastIndex) {
        fragment.appendChild(doc.createTextNode(source.slice(lastIndex, index)));
      }

      // Inline annotation only fires when the reign is explicitly written
      // alongside the year ("嘉靖二年..."). Bare "X年" / "八月" / "甲寅" need
      // wider context that's unreliable to track inline — those cases are
      // handled by the selection-toolbar "识别日期" button instead.
      if (!match[1]) {
        fragment.appendChild(doc.createTextNode(match[0]));
        lastIndex = index + match[0].length;
        continue;
      }
      const resolved = resolveReignDateMatch(match, contextReign, dateMode, showEmperor);
      if (resolved) {
        contextReign = match[1];
        nodesSinceContext = 0;
        const span = doc.createElement("span");
        span.className = "mingshi-year-annotation";
        span.dataset.yearAnnotation = "true";
        span.textContent = match[0];
        span.title = resolved.note;
        span.dataset.note = resolved.note;
        // Store the ingredients so we can re-format the note (公历 / 农历 /
        // both) when the user toggles dateDisplay, without re-walking the DOM.
        span.dataset.reign = resolved.reign;
        span.dataset.year = resolved.yearText;
        if (match[3]) span.dataset.season = match[3];
        if (match[4]) span.dataset.leap = "1";
        if (match[5]) span.dataset.month = match[5];
        if (match[6]) span.dataset.ganzhi = match[6];
        fragment.appendChild(span);
      } else {
        fragment.appendChild(doc.createTextNode(match[0]));
      }

      lastIndex = index + match[0].length;
    }

    if (lastIndex < source.length) {
      fragment.appendChild(doc.createTextNode(source.slice(lastIndex)));
    }

    node.parentNode?.replaceChild(fragment, node);
  }
}

// Recompute notes for all year annotations in `doc` using the new mode /
// showEmperor flag. Reads the ingredient data attrs stamped by
// annotateYearMentions(), so this runs in O(annotated spans) and does not
// re-walk the document.
export function refreshAnnotationDates(doc: Document, mode: DateDisplayMode, showEmperor = false) {
  const spans = doc.querySelectorAll<HTMLSpanElement>(".mingshi-year-annotation[data-year]");
  spans.forEach((span) => {
    const reign = span.dataset.reign || "";
    const year = span.dataset.year || "";
    if (!reign || !year) return;
    const fake = ["", reign, year, span.dataset.season || "", span.dataset.leap ? "闰" : "", span.dataset.month || "", span.dataset.ganzhi || ""] as unknown as RegExpMatchArray;
    const resolved = resolveReignDateMatch(fake, null, mode, showEmperor);
    if (resolved) {
      span.title = resolved.note;
      span.dataset.note = resolved.note;
    }
  });
}
