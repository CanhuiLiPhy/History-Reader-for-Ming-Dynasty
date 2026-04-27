import { REIGN_PATTERN, reignYearToGregorian } from "./reign";

function shouldSkipNode(node: Text) {
  const parent = node.parentElement;
  if (!parent) return true;
  if (parent.closest("[data-year-annotation='true']")) return true;
  return Boolean(parent.closest("script, style, textarea, code, pre"));
}

export type ReaderDocumentStyleOptions = {
  layoutMode?: "horizontal" | "vertical";
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
    }
  `;
}

export function annotateYearMentions(doc: Document, options: ReaderDocumentStyleOptions = {}) {
  injectReaderDocumentStyles(doc, options);
  const root = doc.body;
  if (!root) return;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.nodeValue?.match(REIGN_PATTERN)) continue;
    if (shouldSkipNode(node)) continue;
    textNodes.push(node);
  }

  for (const node of textNodes) {
    const source = node.nodeValue || "";
    const regex = new RegExp(REIGN_PATTERN.source, "g");
    const matches = [...source.matchAll(regex)];
    if (!matches.length) continue;

    const fragment = doc.createDocumentFragment();
    let lastIndex = 0;

    for (const match of matches) {
      const index = match.index ?? 0;
      if (index > lastIndex) {
        fragment.appendChild(doc.createTextNode(source.slice(lastIndex, index)));
      }

      const span = doc.createElement("span");
      const result = reignYearToGregorian(match[1], match[2]);
      span.className = "mingshi-year-annotation";
      span.dataset.yearAnnotation = "true";
      span.textContent = match[0];
      if (result) {
        span.title = result.note;
        span.dataset.note = result.note;
      }
      fragment.appendChild(span);

      lastIndex = index + match[0].length;
    }

    if (lastIndex < source.length) {
      fragment.appendChild(doc.createTextNode(source.slice(lastIndex)));
    }

    node.parentNode?.replaceChild(fragment, node);
  }
}
