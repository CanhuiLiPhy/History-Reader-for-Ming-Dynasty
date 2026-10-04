// Runs the real App.tsx navigation functions and pagination effect in isolation.
// Only React state, DOM layout and the chapter API are replaced with fakes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "App");
assert.ok(app?.body, "App function is present");

function appFunction(name) {
  const declaration = app.body.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `App.${name} exists`);
  return declaration.getText(ast);
}

function paginationEffect() {
  for (const statement of app.body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(ast) !== "useEffect") continue;
    const callback = call.arguments[0];
    if (!callback || !ts.isArrowFunction(callback)) continue;
    if (callback.getText(ast).includes("const recompute =")) return callback.getText(ast);
  }
  assert.fail("DB pagination recompute effect exists");
}

function keyboardEffect() {
  for (const statement of app.body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(ast) !== "useEffect") continue;
    const callback = call.arguments[0];
    if (callback?.getText(ast).includes("function onKeyDown(e: KeyboardEvent)")) {
      return { callback: callback.getText(ast), dependencies: call.arguments[1].getText(ast) };
    }
  }
  assert.fail("reader keyboard effect exists");
}

const functions = ["loadDbReaderChapter", "captureDbAnchor", "flipDbPage", "jumpDbPage", "scrollToSearchTarget"];
const keyboard = keyboardEffect();
const javascript = ts.transpileModule([
  ...functions.map(appFunction),
  `const runPaginationEffect = ${paginationEffect()};`,
  `globalThis.navigation = { ${functions.join(", ")}, runPaginationEffect };`,
  // Separate render scopes reproduce React's stale callback behavior. The
  // actual dependency array determines whether the actual effect is replaced.
  `globalThis.keyboardRender = function(dbReaderIndex, dbReaderChapter, dbReaderLoading, bookSwitching) {
    ${functions.map(appFunction).join("\n")}
    return { setup: ${keyboard.callback}, dependencies: ${keyboard.dependencies} };
  };`
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function createHarness({ index = 1, totalChapters = 3, page = 1, totalPages = 3 } = {}) {
  const slug = "test-book";
  const chapter = (chapterIndex) => ({ slug, chapterIndex, chapter: `卷${chapterIndex + 1}`, paragraphs: [] });
  const chapters = { slug, chapters: Array.from({ length: totalChapters }, (_, order) => ({ order })) };
  const state = { chapter: chapter(index), index, page, totalPages, loading: false, error: "" };
  const frames = new Map();
  const timers = new Map();
  const requests = [];
  const scrolls = [];
  const listeners = new Map();
  const windowListeners = new Map();
  const article = { style: { columnWidth: "500px" } };
  const paragraphs = new Map();
  function paragraph(id, offsetLeft) {
    const classes = new Set();
    const node = { offsetLeft, dataset: { paragraphId: String(id) }, classList: {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name)
    } };
    paragraphs.set(String(id), node);
    return node;
  }
  paragraph(10, 0);
  paragraph(11, 500);
  paragraph(12, 1000);
  const host = {
    clientWidth: 500,
    scrollWidth: totalPages * 500,
    scrollLeft: page * 500,
    querySelector(selector) {
      if (selector === ".db-reader-article") return article;
      return paragraphs.get(selector.match(/data-paragraph-id="([^"]+)"/)?.[1]) ?? null;
    },
    querySelectorAll: () => Array.from(paragraphs.values()),
    scrollTo(options) { scrolls.push(options); host.scrollLeft = options.left; },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name)
  };
  let nextTimer = 0;
  const setTimeoutFake = (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; };
  const clearTimeoutFake = (id) => timers.delete(id);
  const setFrame = (callback) => { const id = ++nextTimer; frames.set(id, callback); return id; };
  const context = vm.createContext({
    console,
    AbortController,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    requestAnimationFrame: setFrame,
    cancelAnimationFrame: (id) => frames.delete(id),
    window: {
      setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake,
      addEventListener: (name, callback) => windowListeners.set(name, callback),
      removeEventListener: (name) => windowListeners.delete(name),
      getSelection: () => ({ isCollapsed: true })
    },
    document: { querySelector: () => null },
    ResizeObserver: class { observe() {} disconnect() {} },
    dbReaderHostRef: { current: host },
    dbChaptersRef: { current: chapters },
    dbReaderChapters: chapters,
    activeBookSlugRef: { current: slug },
    chapterRequestRef: { current: null },
    dbTargetPageRef: { current: page },
    dbAnchorParaRef: { current: null },
    skipNextDbScrollResetRef: { current: false },
    pendingSearchNavRef: { current: null },
    renditionRef: { current: null },
    readableBooks: [{ slug, hasEpub: false }],
    currentBookSlug: slug,
    bookSwitching: false,
    keyboardPagingEnabled: true,
    goPrevPage() {},
    goNextPage() {},
    setBootError: (value) => { state.error = value; },
    setDbReaderLoading: (value) => { state.loading = value; },
    setDbReaderChapter: (value) => { state.chapter = value; },
    setDbReaderIndex: (value) => { state.index = value; },
    setDbPageIndex: (value) => { state.page = value; },
    setDbPageTotal: (value) => { state.totalPages = value; },
    fetchReaderChapter(requestSlug, requestIndex, signal) {
      const request = { ...deferred(), slug: requestSlug, index: requestIndex, signal };
      requests.push(request);
      return request.promise;
    }
  });
  function render() {
    Object.assign(context, {
      dbReaderChapter: state.chapter,
      dbReaderIndex: state.index,
      dbPageIndex: state.page,
      dbPageTotal: state.totalPages,
      dbReaderLoading: state.loading
    });
  }
  render();
  vm.runInContext(javascript, context, { filename: "App.tsx extracted DB navigation" });
  function flushFrames() {
    const pending = Array.from(frames.values());
    frames.clear();
    for (const callback of pending) callback();
  }
  function layout() {
    render();
    const cleanup = context.navigation.runPaginationEffect();
    flushFrames();
    cleanup?.();
  }
  let keyboardDependencies;
  let keyboardCleanup;
  function commitKeyboardEffect() {
    const next = context.keyboardRender(state.index, state.chapter, state.loading, context.bookSwitching);
    if (!keyboardDependencies || next.dependencies.some((value, index) => !Object.is(value, keyboardDependencies[index]))) {
      keyboardCleanup?.();
      keyboardCleanup = next.setup();
      keyboardDependencies = next.dependencies;
    }
  }
  function pressKey(key) {
    windowListeners.get("keydown")?.({ key, target: null, preventDefault() {} });
  }
  return { api: context.navigation, context, state, host, article, requests, scrolls, chapter,
    frames, timers, paragraph, render, flushFrames, layout, commitKeyboardEffect, pressKey };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("DB paging keeps first and last book boundaries stable", () => {
  const first = createHarness({ index: 0, page: 0 });
  first.api.flipDbPage(-1);
  assert.equal(first.host.scrollLeft, 0);
  assert.equal(first.requests.length, 0);
  const last = createHarness({ index: 2, page: 2 });
  last.api.flipDbPage(1);
  assert.equal(last.host.scrollLeft, 1000);
  assert.equal(last.requests.length, 0);
});

test("DB flips within a chapter accumulate their logical target during rapid clicks", () => {
  const h = createHarness({ page: 0, totalPages: 5 });
  h.api.flipDbPage(1);
  h.api.flipDbPage(1);
  assert.equal(h.context.dbTargetPageRef.current, 2);
  assert.equal(h.host.scrollLeft, 1000);
  assert.equal(h.requests.length, 0);
});

test("the last page advances to the next chapter's first page without duplicate loads", async () => {
  const h = createHarness({ index: 1, page: 2 });
  h.context.dbAnchorParaRef.current = "12";
  h.api.flipDbPage(1);
  h.api.flipDbPage(1); // React has not committed loading state yet.
  h.api.jumpDbPage(0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].index, 2);
  assert.equal(h.requests[0].signal.aborted, false);
  h.requests[0].resolve(h.chapter(2));
  await flush();
  h.layout();
  assert.equal(h.state.index, 2);
  assert.equal(h.host.scrollLeft, 0);
  assert.equal(h.context.dbTargetPageRef.current, 0);
  assert.equal(h.context.dbAnchorParaRef.current, null);
  assert.equal(h.context.chapterRequestRef.current, null);
  assert.equal(h.state.loading, false);
});

test("the first page returns to the previous chapter's last newly measured page", async () => {
  const h = createHarness({ index: 1, page: 0 });
  h.context.dbAnchorParaRef.current = "10";
  h.api.flipDbPage(-1);
  h.api.flipDbPage(-1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].index, 0);
  h.requests[0].resolve(h.chapter(0));
  await flush();
  h.host.scrollWidth = 2500; // The destination chapter has five pages.
  h.layout();
  assert.equal(h.state.index, 0);
  assert.equal(h.state.page, 4);
  assert.equal(h.host.scrollLeft, 2000);
  assert.equal(h.context.dbTargetPageRef.current, 4);
  assert.equal(h.context.dbAnchorParaRef.current, null);
});

test("keyboard paging uses the newly loaded chapter across successive chapter boundaries", async () => {
  const h = createHarness({ index: 0, page: 2 });
  h.commitKeyboardEffect();
  h.pressKey("ArrowRight");
  assert.equal(h.requests[0].index, 1);
  h.requests[0].resolve(h.chapter(1));
  await flush();
  h.commitKeyboardEffect();
  h.context.dbTargetPageRef.current = 2;
  h.host.scrollLeft = 1000;
  h.pressKey("ArrowRight");
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].index, 2);
  h.requests[1].resolve(h.chapter(2));
  await flush();
});

test("absolute DB jumps use the latest layout and cancel an active smooth turn", () => {
  const h = createHarness({ page: 0 });
  h.api.flipDbPage(1);
  h.host.scrollWidth = 2500; // React's page total is deliberately still three.
  h.api.jumpDbPage(0.75);
  assert.equal(h.context.dbTargetPageRef.current, 3);
  assert.equal(h.state.totalPages, 5);
  assert.equal(h.state.page, 3);
  assert.equal(h.host.scrollLeft, 1500);
  assert.equal(h.scrolls.at(-1).behavior, "instant");
  h.api.jumpDbPage(-10);
  assert.equal(h.host.scrollLeft, 0);
  h.api.jumpDbPage(10);
  assert.equal(h.host.scrollLeft, 2000);
  const single = createHarness({ page: 0, totalPages: 1 });
  single.api.jumpDbPage(1);
  assert.equal(single.host.scrollLeft, 0);
  assert.equal(single.state.page, 0);
});

test("hidden readers and active chapter loads do not accept page navigation", () => {
  const h = createHarness();
  h.host.clientWidth = 0;
  h.api.flipDbPage(1);
  h.api.jumpDbPage(1);
  assert.equal(h.scrolls.length, 0);
  assert.equal(h.requests.length, 0);
  h.host.clientWidth = 500;
  h.context.dbReaderLoading = true;
  h.api.flipDbPage(1);
  h.api.jumpDbPage(1);
  assert.equal(h.scrolls.length, 0);
  assert.equal(h.requests.length, 0);
});

test("a superseded chapter response cannot overwrite the latest chapter", async () => {
  const h = createHarness({ index: 0 });
  const stale = h.api.loadDbReaderChapter(1);
  const current = h.api.loadDbReaderChapter(2);
  assert.equal(h.requests[0].signal.aborted, true);
  h.requests[1].resolve(h.chapter(2));
  await current;
  h.requests[0].resolve(h.chapter(1));
  await stale;
  assert.equal(h.state.index, 2);
  assert.equal(h.state.chapter.chapterIndex, 2);
  assert.equal(h.state.loading, false);
});

test("a stale completion cannot unlock a newer pending chapter request", async () => {
  const h = createHarness({ index: 0 });
  const stale = h.api.loadDbReaderChapter(1);
  const current = h.api.loadDbReaderChapter(2);
  const activeController = h.context.chapterRequestRef.current;
  h.requests[0].resolve(h.chapter(1));
  await stale;
  assert.equal(h.state.loading, true);
  assert.equal(h.context.chapterRequestRef.current, activeController);
  h.requests[1].resolve(h.chapter(2));
  await current;
  assert.equal(h.state.loading, false);
  assert.equal(h.context.chapterRequestRef.current, null);
});

test("switching books rejects a late chapter response even if its fetch ignores abort", async () => {
  const h = createHarness({ index: 0 });
  const pending = h.api.loadDbReaderChapter(1);
  h.context.activeBookSlugRef.current = "another-book";
  h.requests[0].resolve(h.chapter(1));
  await pending;
  assert.equal(h.state.index, 0);
  assert.equal(h.state.chapter.chapterIndex, 0);
});

test("repeating a search in the loaded chapter does not reset its page", async () => {
  const h = createHarness({ page: 2 });
  h.context.pendingSearchNavRef.current = { paragraphId: 12, text: "", anchor: "", attempts: 0 };
  h.context.skipNextDbScrollResetRef.current = true;
  await h.api.loadDbReaderChapter(1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.api.scrollToSearchTarget(), true);
  h.flushFrames();
  assert.equal(h.host.scrollLeft, 1000);
  assert.equal(h.context.pendingSearchNavRef.current, null);
});

test("a same-chapter search does not leave a reset exemption on the next chapter", async () => {
  const h = createHarness({ index: 1, page: 2 });
  h.context.pendingSearchNavRef.current = { paragraphId: 12, text: "", anchor: "", attempts: 0 };
  h.context.skipNextDbScrollResetRef.current = true;
  await h.api.loadDbReaderChapter(1);
  assert.equal(h.api.scrollToSearchTarget(), true);
  const next = h.api.loadDbReaderChapter(2);
  h.requests[0].resolve(h.chapter(2));
  await next;
  h.layout();
  assert.equal(h.host.scrollLeft, 0);
  assert.equal(h.context.dbTargetPageRef.current, 0);
  assert.equal(h.context.dbAnchorParaRef.current, null);
});

test("search waits for columns, then preserves its paragraph during recompute", () => {
  const h = createHarness({ page: 0 });
  h.article.style.columnWidth = "";
  h.context.pendingSearchNavRef.current = { paragraphId: 12, text: "", anchor: "", attempts: 0 };
  assert.equal(h.api.scrollToSearchTarget(), false);
  assert.ok(h.context.pendingSearchNavRef.current);
  assert.equal(h.scrolls.length, 0);
  h.layout();
  assert.equal(h.api.scrollToSearchTarget(), true);
  assert.equal(h.host.scrollLeft, 1000);
});

test("a consumed search target is not reset by the chapter loading frame", async () => {
  const h = createHarness({ index: 0, page: 0 });
  h.context.pendingSearchNavRef.current = { paragraphId: 12, text: "", anchor: "", attempts: 0 };
  h.context.skipNextDbScrollResetRef.current = true;
  const pending = h.api.loadDbReaderChapter(1);
  h.requests[0].resolve(h.chapter(1));
  await pending;
  assert.equal(h.api.scrollToSearchTarget(), true);
  h.layout();
  assert.equal(h.host.scrollLeft, 1000);
  assert.equal(h.context.dbTargetPageRef.current, 2);
});
