// Runs the real App.tsx code that re-displays the current EPUB location (year
// annotation / script / column toggles, the reader becoming ready) against a
// synthetic epub.js rendition and column layout. epub.js's queue is modelled
// one task per frame, and a frame is "painted" between tasks, so the tests
// also see every page the reader could glimpse.
// 用模拟的 epub.js rendition 与分栏版面，运行 App.tsx 里真实的「重新显示当前位置」代码
// （切换年号标注、繁简、分栏，阅读器就绪）。epub.js 队列按「每帧一个任务」模拟，任务之间
// 记录一帧画面，所以测试也能看到读者可能瞥见的每一页。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

/**
 * 中文：把 TypeScript 模块转译后经 data URL 导入。
 *
 * Transpile a TypeScript module and import it from a data URL.
 *
 * @param {string} relativePath - Path relative to this test file.
 * @returns {Promise<object>} The module namespace.
 */
async function importTs(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const anchors = await importTs("../src/lib/reflow-anchor.ts");
const positions = await importTs("../src/lib/reading-position.ts");

const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "App");
assert.ok(app?.body, "App function is present");

/**
 * 中文：取 App.tsx 顶层的函数或常量声明源码。
 *
 * Source text of a module-level function or `const` declaration.
 *
 * @param {string} name - Declared name.
 * @returns {string} The declaration's source.
 */
function moduleDeclaration(name) {
  const statement = ast.statements.find((node) => (ts.isFunctionDeclaration(node) && node.name?.text === name)
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => d.name.getText(ast) === name)));
  assert.ok(statement, `module-level ${name} exists`);
  return statement.getText(ast);
}

/**
 * 中文：取 App 组件内某个函数声明的源码。
 *
 * Source text of a function declared inside the App component.
 *
 * @param {string} name - Function name.
 * @returns {string} The declaration's source.
 */
function appFunction(name) {
  const declaration = app.body.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `App.${name} exists`);
  return declaration.getText(ast);
}

/**
 * 中文：按依赖数组找出 App 里的 useEffect 回调源码。
 *
 * Source text of the App effect callback with exactly these dependencies.
 *
 * @param {string} dependencies - The dependency array as written in App.tsx.
 * @returns {string} The arrow function's source.
 */
function appEffect(dependencies) {
  for (const statement of app.body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(ast) === "useEffect" && call.arguments[1]?.getText(ast) === dependencies) {
      return call.arguments[0].getText(ast);
    }
  }
  assert.fail(`effect ${dependencies} exists`);
}

const functions = ["openLocation", "goNextPage", "epubPagedGeometry", "epubScreenAnchor", "moveEpubToAnchor",
  "correctEpubRestore", "scheduleEpubRestoreCorrections", "persistEpubReadingPosition", "saveReadingPosition",
  "epubDocumentPrefsKey", "applyReaderDocumentPreferences", "getRenditionSpread", "setEpubRepaginating",
  "epubShownDocumentPrefs", "epubSectionNeedsRender", "epubAnchorScreen", "lastHeldEpubAnchor", "holdEpubPage",
  "epubAnchorDisplayCfi",
  "redisplayEpubPage", "applyEpubHoldOnRender"];
const javascript = ts.transpileModule([
  ...["normalizeDisplayTarget", "extractAnchor", "uniqueValues", "EPUB_RESTORE_CORRECTIONS", "YEAR_ANNOTATION_CLASS"]
    .map(moduleDeclaration),
  ...functions.map(appFunction),
  `globalThis.app = { ${functions.join(", ")}, effects: {
    content: ${appEffect("[autoAnnotate, scriptVariant, readerReady]")},
    layout: ${appEffect("[readerLayout, readerReady]")},
    spread: ${appEffect("[pageSpread, readerReady]")},
  } };`,
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;

// ---- Synthetic book and layout / 模拟的书与版面 ----

const SLUG = "ming-shi";
const SECTION = 3;
const DELTA = 1000; // screen width / 每屏宽度
const LINES = 8; // lines per column / 每栏行数
const LINE_UNITS = 24; // character widths per line in the single-page layout / 单页时每行可容纳的字宽
const REIGN = "洪武元年";
// Script conversion, one character for one like OpenCC's cn → tw. / 繁简转换，与 OpenCC 一样一字对一字。
const TO_TRADITIONAL = new Map([...("发於诸军为云帅镇国归".split("").map((ch, i) => [ch, "發於諸軍為雲帥鎮國歸"[i]]))]);
const ALPHABET = "太祖起兵发于濠州诸军为之云集元帅克城攻取镇守国人归附，";

/**
 * 中文：生成一章原文（简体）：段落长短不一，每段夹几处「洪武元年」，多数屏的页首字都在段中。
 *
 * The section's original (simplified) text: paragraphs of varying length,
 * each with a few reign dates, so most screens start mid-paragraph.
 * Deterministic pseudo-random text keeps every anchor context unique.
 *
 * @returns {string[]} Paragraph texts.
 */
function sectionParagraphs() {
  let seed = 20261017;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  return Array.from({ length: 16 }, (_, para) => {
    let text = "　　";
    const length = 60 + random(360);
    while (text.length < length) {
      text += random(40) === 0 ? REIGN : ALPHABET[random(ALPHABET.length)];
    }
    return `${text}${para}。`;
  });
}
const PARAGRAPHS = sectionParagraphs();

/**
 * 中文：创建一套测试环境：模拟 rendition、版面、定时器，以及在其中运行的 App 代码。
 *
 * Build a harness: fake rendition, layout, timers and the extracted App code
 * running against them.
 *
 * @param {{columns?: number}} [options] - `columns`: columns per screen the
 *   rendition starts with (1 single page, 2 double page).
 * @returns {object} Harness API (see the returned object).
 */
function createHarness({ columns: initialColumns = 1 } = {}) {
  let columns = initialColumns;
  let structure = 0;
  let view = null;
  let renderedPending = false;
  const tasks = [];
  const timers = new Map();
  let clock = 0;
  let nextTimer = 0;
  const frames = [];
  const writes = [];
  let watched = null;
  let fontsResolve;
  const fonts = new Promise((resolve) => { fontsResolve = resolve; });
  const hostClasses = new Set();
  const host = { classList: {
    toggle: (name, on) => (on ? hostClasses.add(name) : hostClasses.delete(name)),
    remove: (name) => hostClasses.delete(name),
  } };

  /**
   * 中文：给一组文本节点排版：逐字排入行、栏、屏；年号标注的 span 两侧各多占半个字宽。
   *
   * Lay out text nodes: characters fill lines, lines fill columns, `columns`
   * columns make a screen. An annotation span's padding adds half a character
   * on each side. Whitespace-only nodes between paragraphs take no space.
   */
  function layoutOf(nodes) {
    const lineUnits = LINE_UNITS / columns;
    const marks = new Map();
    let line = -1;
    let used = 0;
    let para = null;
    for (const node of nodes) {
      if (node.ws) { marks.set(node, Array.from(node.data, () => null)); continue; }
      if (node.para !== para) { para = node.para; line += 1; used = 0; }
      const list = [];
      for (let i = 0; i < node.data.length; i += 1) {
        const width = 1 + (node.annotated && i === 0 ? 0.5 : 0) + (node.annotated && i === node.data.length - 1 ? 0.5 : 0);
        if (used + width > lineUnits) { line += 1; used = 0; }
        list.push({ screen: Math.floor(Math.floor(line / LINES) / columns), lineStart: used === 0 });
        used += width;
      }
      marks.set(node, list);
    }
    return { marks, screens: Math.floor(Math.floor(line / LINES) / columns) + 1 };
  }

  /** 中文：一份刚渲染、未经转换与标注的章节文档。 / A freshly rendered section: original text, no annotation. */
  function freshDocument() {
    const nodes = [];
    PARAGRAPHS.forEach((data, para) => { nodes.push({ data: "\n    ", ws: true }, { data, para }); });
    nodes.push({ data: "\n", ws: true });
    return {
      structure: ++structure,
      body: { textNodes: nodes },
      createRange: () => ({ setStart(node, offset) { this.node = node; this.offset = offset; }, collapse() {} }),
    };
  }

  /** 中文：模拟 annotateYearMentions：把年号包进 span，拆分文本节点。 / Fake year annotation: wrap each reign date, splitting its node. */
  function annotate(doc) {
    const out = [];
    for (const node of doc.body.textNodes) {
      if (node.ws || node.annotated || !node.data.includes(REIGN)) { out.push(node); continue; }
      node.data.split(REIGN).forEach((part, i) => {
        if (i > 0) out.push({ data: REIGN, para: node.para, annotated: true });
        if (part) out.push({ data: part, para: node.para });
      });
    }
    doc.body.textNodes = out;
    doc.structure = ++structure;
  }

  /** 中文：模拟 convertDocumentToTraditional。 / Fake script conversion, applied only when set to traditional. */
  function convert(doc) {
    if (context.scriptVariantRef.current !== "traditional") return;
    for (const node of doc.body.textNodes) node.data = Array.from(node.data, (ch) => TO_TRADITIONAL.get(ch) ?? ch).join("");
  }

  /** 中文：文本位置的全文偏移。 / Global offset of a node position in a document. */
  function globalOffset(doc, node, offset) {
    let before = 0;
    for (const candidate of doc.body.textNodes) {
      if (candidate === node) return before + offset;
      before += candidate.data.length;
    }
    return -1;
  }

  const container = {
    scrollLeft: 0,
    clientWidth: DELTA,
    getBoundingClientRect: () => ({ left: 0 }),
    get scrollWidth() { return view ? layoutOf(view.document.body.textNodes).screens * DELTA : DELTA; },
  };
  const maxScroll = () => Math.max(0, container.scrollWidth - container.clientWidth);
  const screen = () => Math.round(container.scrollLeft / DELTA);

  /** 中文：在 rendition 上装入一个新渲染的章节视图。 / Install a freshly rendered section view. */
  function renderSection() {
    const doc = freshDocument();
    view = {
      section: { index: SECTION },
      document: doc,
      iframe: { getBoundingClientRect: () => ({ left: -container.scrollLeft }) },
      contents: {
        document: doc,
        // Character CFI that ignores the annotation wrappers. / 不计标注外层 span 的字级 CFI。
        cfiFromRange: (range) => `epubcfi(/char:${globalOffset(doc, range.node, range.offset)})`,
      },
    };
    renderedPending = true;
  }

  /**
   * 中文：epub.js 报告的页首 CFI：第一个有字落在本屏的文本节点的开头（中文常是段首）。
   *
   * epub.js's `location.start.cfi`: the start of the first text node with a
   * character on this screen — for Chinese, usually the paragraph start.
   * It names the node by index, so it only resolves in the same structure.
   */
  function reportedCfi() {
    const nodes = view.document.body.textNodes;
    const layout = layoutOf(nodes);
    const index = nodes.findIndex((node) => layout.marks.get(node).some((mark) => mark?.screen === screen()));
    return `epubcfi(/node:${view.document.structure}:${index})`;
  }

  /**
   * 中文：epub.js 自己显示某个 CFI 时会翻到哪一屏。节点 CFI 在别的文档结构里解析不了时回到章首；
   * 从行首开始的 Range 会带上上一行行尾的矩形，所以行首字会被放到上一屏。
   *
   * The screen epub.js itself scrolls to for a CFI. A node CFI from another
   * document structure does not resolve and falls back to the section start;
   * a range starting a line also reports the end of the previous line, so a
   * line-initial character lands one screen early at a screen start.
   */
  function placement(target) {
    const nodes = view.document.body.textNodes;
    const layout = layoutOf(nodes);
    const node = /^epubcfi\(\/node:(\d+):(\d+)\)$/.exec(target);
    if (node) {
      if (Number(node[1]) !== view.document.structure) return 0;
      return layout.marks.get(nodes[Number(node[2])]).find(Boolean)?.screen ?? 0;
    }
    const char = /^epubcfi\(\/char:(\d+)\)$/.exec(target);
    if (!char) return 0;
    let previous = null;
    let rest = Number(char[1]);
    for (const candidate of nodes) {
      const marks = layout.marks.get(candidate);
      if (rest < candidate.data.length) {
        const mark = marks[rest];
        return mark?.lineStart && previous ? previous.screen : mark?.screen ?? 0;
      }
      for (const mark of marks) if (mark) previous = mark;
      rest -= candidate.data.length;
    }
    return 0;
  }

  const rendition = {
    q: {
      enqueue(work) {
        let resolve;
        let reject;
        const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
        tasks.push({ work, resolve, reject });
        return promise;
      },
    },
    manager: {
      settings: { axis: "horizontal", direction: "ltr", fullsize: false },
      layout: { delta: DELTA, get divisor() { return columns; } },
      container,
      views: { first: () => view ?? undefined },
      scrollTo: (x) => { container.scrollLeft = x; },
    },
    display(target) {
      return rendition.q.enqueue(async () => {
        if (!view) renderSection();
        container.scrollLeft = Math.min(placement(target) * DELTA, maxScroll());
        rendition.reportLocation();
      });
    },
    clear() { view = null; container.scrollLeft = 0; },
    next() {
      return rendition.q.enqueue(() => {
        container.scrollLeft = Math.min(container.scrollLeft + DELTA, maxScroll());
        rendition.reportLocation();
      });
    },
    getContents: () => (view ? [view.contents] : []),
    // epub.js reports in a later frame; the handler then saves the position. / epub.js 在之后一帧报告位置，处理函数随即保存。
    reportLocation() { rendition.q.enqueue(relocated); },
    spread(value) { columns = value === "always" ? 2 : 1; },
  };

  /** 中文：模拟 relocated 事件处理。 / The parts of the `relocated` handler this code relies on. */
  function relocated() {
    if (!view) return;
    const cfi = reportedCfi();
    context.currentCfiRef.current = cfi;
    context.app.persistEpubReadingPosition(rendition, SLUG, cfi);
  }

  const setTimeoutFake = (callback, ms = 0) => { const id = ++nextTimer; timers.set(id, { callback, due: clock + ms }); return id; };
  const clearTimeoutFake = (id) => timers.delete(id);
  const context = vm.createContext({
    console,
    performance,
    window: { setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake },
    meta: null,
    readerReady: true,
    renditionRef: { current: rendition },
    readerHostRef: { current: host },
    repaginationRevealTimerRef: { current: 0 },
    currentCfiRef: { current: "" },
    epubRestoreRef: { current: null },
    epubNavSerialRef: { current: 0 },
    epubTextAnchorRef: { current: null },
    epubAnchorLockRef: { current: null },
    epubPendingReflowRef: { current: null },
    epubRedisplayHiddenRef: { current: false },
    epubLastHeldRef: { current: null },
    reflowAlgorithmRef: { current: "legacy" },
    readerLayoutRef: { current: "horizontal" },
    scriptVariantRef: { current: "traditional" },
    autoAnnotateRef: { current: true },
    pageSpreadRef: { current: "single" },
    dateDisplayRef: { current: "lunar" },
    showEmperorRef: { current: false },
    activeBookSlugRef: { current: SLUG },
    savedReadingPositionsRef: { current: new Map() },
    chapterNavigationRef: { current: [] },
    pendingLocationLabelRef: { current: "" },
    pendingLocationTargetRef: { current: "" },
    forcedChapterTargetRef: { current: "" },
    pendingAnchorRef: { current: "" },
    // Imports used by the extracted code. / 被抽取代码用到的导入。
    collectAnchorTextNodes: (body) => body.textNodes,
    findFirstTextPositionOnPage: anchors.findFirstTextPositionOnPage,
    textAnchorAt: anchors.textAnchorAt,
    resolveTextAnchor: anchors.resolveTextAnchor,
    pageOfTextPosition: anchors.pageOfTextPosition,
    epubReadingPosition: positions.epubReadingPosition,
    sameReadingPosition: positions.sameReadingPosition,
    readingPositionStorageName: positions.readingPositionStorageName,
    epubCharMeasurer: (doc) => { const layout = layoutOf(doc.body.textNodes); return (node, offset) => layout.marks.get(node)?.[offset]?.screen ?? null; },
    fontsSettled: () => fonts,
    storageKey: (name) => `mingshi-reader-ai:${name}`,
    writePersistedState: (key, value) => { writes.push({ key, value }); return Promise.resolve(); },
    injectReaderDocumentStyles: () => {},
    convertDocumentToTraditional: (doc) => convert(doc),
    annotateYearMentions: (doc) => annotate(doc),
    scrollPendingAnchorIntoView: () => {},
    findTocLabel: () => "",
  });
  vm.runInContext(javascript, context, { filename: "App.tsx extracted EPUB re-display" });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  /** 中文：在当前文档里某个锚点字所在的屏。 / Screen holding an anchor character in the document on display. */
  function screenOf(anchor) {
    const nodes = view.document.body.textNodes;
    const position = anchors.resolveTextAnchor(nodes, anchor);
    return anchors.pageOfTextPosition(nodes, position, context.epubCharMeasurer(view.document));
  }

  /** 中文：记录一帧画面。 / Record what a painted frame shows. */
  function paint() {
    frames.push(view
      ? { screen: screen(), hidden: hostClasses.has("is-repaginating"), watchedScreen: watched ? screenOf(watched) : null }
      : { blank: true, hidden: hostClasses.has("is-repaginating") });
  }

  /**
   * 中文：按帧执行 epub.js 队列：每个任务后清空微任务并记录一帧；新渲染的章节随后触发 rendered（年号标注之后校正）。
   *
   * Run epub.js's queue one task per frame. After each task, microtasks run
   * (openLocation's post-display correction) and a frame is painted; a newly
   * rendered section then fires `rendered` as the App handler does it.
   */
  async function runFrames() {
    while (tasks.length) {
      const { work, resolve, reject } = tasks.shift();
      try { resolve(await work()); } catch (error) { reject(error); }
      await flush();
      paint();
      if (renderedPending && view) {
        renderedPending = false;
        context.app.applyReaderDocumentPreferences(view.document);
        context.app.applyEpubHoldOnRender(rendition, view.section.index);
        await flush();
        paint();
      }
    }
  }

  /** 中文：跑完所有帧、定时器与字体加载，直到一切静止。 / Run frames, timers and font loading until everything is idle. */
  async function settle() {
    for (let round = 0; round < 50; round += 1) {
      await runFrames();
      const due = [...timers.entries()].sort((a, b) => a[1].due - b[1].due);
      if (due.length) {
        const [id, timer] = due[0];
        timers.delete(id);
        clock = Math.max(clock, timer.due);
        timer.callback();
        await flush();
        continue;
      }
      fontsResolve();
      await flush();
      if (!tasks.length && !timers.size) return;
    }
    assert.fail("harness settles");
  }

  /** 中文：当前屏的页首字（锚点形式）。 / First character of the screen on display, as an anchor. */
  function firstCharacter() {
    const nodes = view.document.body.textNodes;
    const position = anchors.findFirstTextPositionOnPage(nodes, context.epubCharMeasurer(view.document), screen());
    return anchors.textAnchorAt(nodes, position);
  }

  /** 中文：像阅读器初始化那样打开章节并停在第 page 屏。 / Open the section at screen `page`, as the reader's init does. */
  async function boot(page) {
    renderSection();
    renderedPending = false;
    context.app.applyReaderDocumentPreferences(view.document);
    container.scrollLeft = page * DELTA;
    relocated();
    frames.length = 0;
  }

  /**
   * 中文：像带着保存位置重新打开书那样：epub.js 先粗略定位，显示后与 rendered 时校正到保存的字，再按初始化的方式安排后续校正。
   *
   * Reopen the section as the reader's init does with a saved position:
   * epub.js places it coarsely (the saved CFI does not resolve in the fresh
   * section), the restore corrects right after the display and in `rendered`,
   * and the follow-up corrections are scheduled.
   *
   * @param {{offset: number, context: string}} saved - The saved first character.
   */
  async function reopen(saved) {
    renderSection();
    const restore = { cfi: "epubcfi(/saved)", anchor: { ...saved, sectionIndex: SECTION, screen: -1, displayCfi: "", serial: -1 } };
    context.epubRestoreRef.current = restore;
    context.epubNavSerialRef.current += 1; // init's openLocation / 初始化时的 openLocation
    container.scrollLeft = 0;
    context.app.correctEpubRestore(rendition, restore);
    renderedPending = false;
    context.app.applyReaderDocumentPreferences(view.document);
    context.app.applyEpubHoldOnRender(rendition, SECTION);
    relocated();
    context.app.scheduleEpubRestoreCorrections(rendition, restore);
    frames.length = 0;
  }

  /**
   * 中文：找一屏：页首字在段中，且关掉年号标注后这个字会被挤到上一屏末尾（最难保持的情况）。
   *
   * Find a screen whose first character sits mid-paragraph, whose paragraph
   * starts on an earlier screen (so epub.js alone goes back), and whose first
   * character moves to the end of the previous screen once annotation is off.
   */
  function hardScreen() {
    const doc = freshDocument();
    convert(doc);
    annotate(doc);
    const plain = freshDocument();
    convert(plain);
    const annotatedLayout = layoutOf(doc.body.textNodes);
    for (let page = 1; page < annotatedLayout.screens; page += 1) {
      const nodes = doc.body.textNodes;
      const position = anchors.findFirstTextPositionOnPage(nodes, context.epubCharMeasurer(doc), page);
      const node = nodes[position.nodeIndex];
      const paragraphStart = annotatedLayout.marks.get(nodes.find((n) => n.para === node.para)).find(Boolean).screen;
      const anchor = anchors.textAnchorAt(nodes, position);
      const plainPosition = anchors.resolveTextAnchor(plain.body.textNodes, anchor);
      const plainScreen = anchors.pageOfTextPosition(plain.body.textNodes, plainPosition, context.epubCharMeasurer(plain));
      if (paragraphStart < page && plainScreen === page - 1) return page;
    }
    return -1;
  }

  return {
    app: context.app, context, rendition, frames, writes, hostClasses,
    boot, reopen, settle, runFrames, screen, firstCharacter, screenOf, placement, hardScreen,
    watch: (anchor) => { watched = anchor; },
    get view() { return view; },
    get columns() { return columns; },
    text: (anchor) => view.document.body.textNodes.map((node) => node.data).join("").slice(anchor.offset, anchor.offset + 6),
  };
}

/**
 * 中文：断言每一帧要么被隐藏，要么正显示着被保持的那个字所在屏。
 *
 * Assert that every painted frame was hidden or showed the held character.
 *
 * @param {object[]} frames - Frames recorded by the harness.
 */
function assertNoStrayFrame(frames) {
  for (const [index, frame] of frames.entries()) {
    if (frame.blank || frame.hidden) continue;
    assert.equal(frame.screen, frame.watchedScreen, `frame ${index} shows screen ${frame.screen}, not the held character's ${frame.watchedScreen}`);
  }
}

test("turning year annotation off and on re-renders the section and keeps the page's first character", async () => {
  const h = createHarness();
  const page = h.hardScreen();
  assert.ok(page > 0, "the synthetic book has a screen whose first character moves to the previous screen without annotation");
  await h.boot(page);
  const first = h.firstCharacter();
  const traditional = h.text(first);
  // epub.js alone returns to the paragraph start, pages earlier. / 只靠 epub.js 会回到段首所在页。
  assert.ok(h.placement(h.context.currentCfiRef.current) < page);

  h.watch(first);
  const before = h.view.document.structure;
  h.context.autoAnnotateRef.current = false;
  h.app.effects.content();
  await h.settle();
  assert.notEqual(h.view.document.structure, before, "the section was rendered again");
  assert.ok(!h.view.document.body.textNodes.some((node) => node.annotated), "annotation is gone");
  assert.equal(h.screen(), h.screenOf(first), "the page holds the same character");
  assert.equal(h.screen(), page - 1, "which annotation no longer pushes onto the next screen");
  assert.ok(h.frames.some((frame) => frame.hidden), "the section was hidden while it re-rendered");
  assertNoStrayFrame(h.frames);
  assert.equal(h.hostClasses.has("is-repaginating"), false, "and revealed again");
  assert.equal(h.context.epubRestoreRef.current, null, "the hold has ended");

  // Back on: the very same page, although the hold ended in between. / 再打开：回到同一页，尽管中间保持已结束。
  h.frames.length = 0;
  h.context.autoAnnotateRef.current = true;
  h.app.effects.content();
  await h.settle();
  assert.ok(h.view.document.body.textNodes.some((node) => node.annotated), "annotation is back");
  assert.equal(h.screen(), page);
  assert.equal(h.firstCharacter().offset, first.offset, "the page starts with the same character again");
  assert.equal(h.text(h.firstCharacter()), traditional);
  assertNoStrayFrame(h.frames);
});

test("switching the script re-renders the section with the new text on the same page", async () => {
  const h = createHarness();
  const page = h.hardScreen();
  await h.boot(page);
  const first = h.firstCharacter();
  const traditional = h.text(first);
  h.watch(first);
  h.context.scriptVariantRef.current = "simplified";
  h.app.effects.content();
  await h.settle();
  const simplified = h.text(first);
  assert.notEqual(simplified, traditional, "the original text is shown again");
  assert.equal(h.screen(), page);
  assert.equal(h.firstCharacter().offset, first.offset);
  assertNoStrayFrame(h.frames);

  h.context.scriptVariantRef.current = "traditional";
  h.app.effects.content();
  await h.settle();
  assert.equal(h.text(h.firstCharacter()), traditional);
  assert.equal(h.screen(), page);
});

test("when the reader becomes ready, the three re-displays never leave the page", async () => {
  const h = createHarness();
  const page = h.hardScreen();
  await h.boot(page);
  const first = h.firstCharacter();
  h.watch(first);
  const structure = h.view.document.structure;
  // React runs all three effects in one commit. / React 在同一次提交里依次运行三个 effect。
  h.app.effects.content();
  h.app.effects.layout();
  h.app.effects.spread();
  await h.settle();
  assert.equal(h.view.document.structure, structure, "nothing is rendered again");
  assert.equal(h.screen(), page);
  assert.equal(h.firstCharacter().offset, first.offset);
  assert.ok(h.frames.length >= 3, "each re-display painted a frame");
  assert.ok(h.frames.every((frame) => !frame.hidden && frame.screen === page), "no frame showed another page");
});

test("single → double → single columns returns to the page's first character", async () => {
  const h = createHarness();
  const page = h.hardScreen();
  await h.boot(page);
  const first = h.firstCharacter();
  h.watch(first);

  h.context.pageSpreadRef.current = "double";
  h.app.effects.spread();
  await h.settle();
  assert.equal(h.columns, 2);
  assert.equal(h.screen(), h.screenOf(first), "the double-page screen shows the held character");
  assertNoStrayFrame(h.frames);
  assert.equal(h.context.epubRestoreRef.current, null, "the hold has ended");

  h.context.pageSpreadRef.current = "single";
  h.app.effects.spread();
  await h.settle();
  assert.equal(h.columns, 1);
  assert.equal(h.screen(), page);
  assert.equal(h.firstCharacter().offset, first.offset);
});

test("a page turn ends the hold, and the next toggle keeps the new page", async () => {
  const h = createHarness();
  const page = h.hardScreen();
  await h.boot(page);
  h.context.autoAnnotateRef.current = false;
  h.app.effects.content();
  await h.settle();

  h.app.goNextPage();
  await h.settle();
  const turned = h.screen();
  const first = h.firstCharacter();
  h.context.autoAnnotateRef.current = true;
  h.app.effects.content();
  await h.settle();
  assert.equal(h.screen(), h.screenOf(first), "the turned-to page's first character is held, not the earlier one");
  assert.ok(Math.abs(h.screen() - turned) <= 1);

  // A turn during the re-render ends the hold; the section is still revealed.
  // 重新渲染期间翻页会结束保持；正文仍会显示出来。
  h.context.autoAnnotateRef.current = false;
  h.app.effects.content();
  h.app.goNextPage();
  assert.equal(h.context.epubRestoreRef.current, null);
  await h.settle();
  assert.equal(h.hostClasses.has("is-repaginating"), false);
});

test("a reopened book's restore in progress keeps its own character through a toggle", async () => {
  const h = createHarness();
  const page = h.hardScreen();
  await h.boot(page);
  // The saved character is on the next screen and not yet placed. / 保存的字在下一屏，尚未放置。
  const nodes = h.view.document.body.textNodes;
  const saved = anchors.textAnchorAt(nodes, anchors.findFirstTextPositionOnPage(nodes, h.context.epubCharMeasurer(h.view.document), page + 1));
  h.context.epubRestoreRef.current = {
    cfi: h.context.currentCfiRef.current,
    anchor: { ...saved, sectionIndex: SECTION, screen: -1, displayCfi: "", serial: -1 },
  };
  h.context.autoAnnotateRef.current = false;
  h.app.effects.content();
  await h.settle();
  assert.equal(h.screen(), h.screenOf(saved));
  assert.notEqual(h.screen(), page - 1);
});

test("the reading position saved while the page is held is the held character", async () => {
  const h = createHarness();
  const page = h.hardScreen();
  await h.boot(page);
  const first = h.firstCharacter();
  h.context.autoAnnotateRef.current = false;
  h.app.effects.content();
  await h.settle();
  const records = h.writes.filter((write) => write.key === `mingshi-reader-ai:reading-position:${SLUG}`);
  assert.ok(records.length > 0, "positions were saved");
  // Its first character is earlier than the held one, which sits at the screen's end.
  // 这一屏的页首字比被保持的字更靠前（被保持的字在屏末）。
  assert.ok(h.firstCharacter().offset < first.offset);
  for (const { value } of records) {
    assert.equal(value.offset, first.offset, "never the coarse page's first character");
    assert.equal(value.sectionIndex, SECTION);
  }
});

test("vertical text keeps epub.js's own placement and is never hidden", async () => {
  const h = createHarness();
  const page = h.hardScreen();
  await h.boot(page);
  const structure = h.view.document.structure;
  h.context.readerLayoutRef.current = "vertical";
  h.app.effects.layout();
  assert.equal(h.context.epubRestoreRef.current, null, "no position is held");
  assert.equal(h.hostClasses.has("is-repaginating"), false);
  await h.settle();
  assert.notEqual(h.view.document.structure, structure, "the section was rendered again for the new layout");
  assert.ok(h.view.document.__mingshiDocPrefs.startsWith("vertical|"));
  // Its stale CFI does not resolve in the fresh section: epub.js's section start, as before.
  // 旧 CFI 在新渲染的章节里解析不了：照旧回到章首。
  assert.equal(h.screen(), 0);
});

test("reopened on a double page, the saved character outlives the restore and returns as the single page's first", async () => {
  const single = createHarness();
  const page = single.hardScreen();
  await single.boot(page);
  const first = single.firstCharacter();

  const h = createHarness({ columns: 2 });
  h.context.pageSpreadRef.current = "double";
  await h.reopen(first);
  await h.settle();
  assert.equal(h.context.epubRestoreRef.current, null, "the restore has ended");
  assert.equal(h.screen(), h.screenOf(first), "the double page shows the saved character");
  assert.notEqual(h.firstCharacter().offset, first.offset, "below the top of that screen");
  // A later location report without navigation still saves that character.
  // 之后没有翻页的位置报告，保存的仍是这个字。
  h.rendition.reportLocation();
  await h.settle();
  const records = h.writes.filter((write) => write.key === `mingshi-reader-ai:reading-position:${SLUG}`);
  assert.equal(records.at(-1).value.offset, first.offset);

  h.context.pageSpreadRef.current = "single";
  h.app.effects.spread();
  await h.settle();
  assert.equal(h.screen(), page);
  assert.equal(h.firstCharacter().offset, first.offset);
});
