// Run: node --experimental-vm-modules --test frontend/tests/epubReaderManager.test.mjs
// Executes the installed epub.js manager, Stage, Queue, Hook and Themes with
// fake event targets. No browser, book files, account or network is needed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

class TrackedTarget {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!callback) return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  count(type) { return this.listeners.get(type)?.size ?? 0; }
  dispatch(type) { for (const callback of [...(this.listeners.get(type) ?? [])]) callback(); }
}

const frameCallbacks = [];
const browserWindow = new TrackedTarget();
browserWindow.requestAnimationFrame = (callback) => frameCallbacks.push(callback);
browserWindow.scrollTo = () => {};
globalThis.window = browserWindow;
const require = createRequire(import.meta.url);
const DefaultViewManager = require("epubjs/lib/managers/default/index.js").default;
const Stage = require("epubjs/lib/managers/helpers/stage.js").default;
const Queue = require("epubjs/lib/utils/queue.js").default;
const Hook = require("epubjs/lib/utils/hook.js").default;
const Themes = require("epubjs/lib/themes.js").default;
const Rendition = require("epubjs/lib/rendition.js").default;

const source = await readFile(new URL("../src/lib/epubReaderManager.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText;
const context = vm.createContext({ window: browserWindow });
const upstream = new vm.SyntheticModule(["default"], function () {
  this.setExport("default", DefaultViewManager);
}, { context });
const module = new vm.SourceTextModule(javascript, { context });
await module.link((specifier) => {
  assert.equal(specifier, "epubjs/src/managers/default/index.js");
  return upstream;
});
await module.evaluate();
const { ReaderViewManager, prepareEpubRenditionForDestroy } = module.namespace;

function createManager(Manager = ReaderViewManager, fullsize = false) {
  const renditionQueue = new Queue({});
  const manager = new Manager({ settings: { fullsize }, queue: renditionQueue });
  manager.container = new TrackedTarget();
  let clears = 0;
  manager.views = { hide() {}, clear() { clears += 1; } };
  const stage = Object.create(Stage.prototype);
  stage.settings = { hidden: false };
  stage.container = manager.container;
  stage.element = { contains: () => false };
  stage.resizeFunc = () => {};
  stage.orientationChangeFunc = () => {};
  browserWindow.addEventListener("resize", stage.resizeFunc);
  browserWindow.addEventListener("orientationchange", stage.orientationChangeFunc);
  manager.stage = stage;
  manager.rendered = true;
  return { manager, renditionQueue, clears: () => clears };
}

test("the installed upstream manager reproduces unload and orientation listener retention", () => {
  const { manager } = createManager(DefaultViewManager);
  manager.addEventListeners();
  manager.destroy();
  assert.equal(browserWindow.count("unload"), 1);
  assert.equal(browserWindow.count("orientationchange"), 1);
  // Test-only fake window cleanup; no real event target is touched.
  browserWindow.listeners.clear();
});

test("repeated book teardown returns all window and container listeners to baseline", () => {
  for (let i = 0; i < 30; i += 1) {
    const { manager, renditionQueue, clears } = createManager();
    manager.addEventListeners();
    manager.q._q.push({});
    renditionQueue._q.push({});
    assert.equal(manager.container.count("scroll"), 1);
    manager.destroy();
    manager.destroy();
    assert.equal(manager.container.count("scroll"), 0);
    assert.equal(browserWindow.count("unload"), 0);
    assert.equal(browserWindow.count("orientationchange"), 0);
    assert.equal(browserWindow.count("resize"), 0);
    assert.equal(manager.q.length(), 0);
    assert.equal(renditionQueue.length(), 0);
    assert.equal(clears(), 1, "upstream view cleanup must run only once");
  }
});

test("listener attachment is idempotent and fullsize scrolling is released", () => {
  const { manager } = createManager(ReaderViewManager, true);
  manager.addEventListeners();
  manager.addEventListeners();
  assert.equal(browserWindow.count("unload"), 1);
  assert.equal(browserWindow.count("scroll"), 1);
  browserWindow.dispatch("unload");
  assert.equal(browserWindow.count("unload"), 0);
  assert.equal(browserWindow.count("scroll"), 0);
  assert.equal(browserWindow.count("orientationchange"), 0);
});

test("teardown before render is safe and a late attach cannot resurrect the manager", () => {
  const manager = new ReaderViewManager({ settings: {}, queue: new Queue({}) });
  assert.doesNotThrow(() => manager.destroy());
  assert.doesNotThrow(() => manager.destroy());
  // Upstream render would need a real DOM; after destroy this must be a no-op.
  assert.doesNotThrow(() => manager.render({}, { width: 800, height: 600 }));
  manager.addEventListeners();
  assert.equal(browserWindow.count("unload"), 0);
  assert.equal(manager.rendered, false);
});

test("pending throttled resize work is cancelled while cleaning the stage", () => {
  const { manager } = createManager();
  let cancelled = 0;
  manager.stage.resizeFunc.cancel = () => { cancelled += 1; };
  manager.destroy();
  manager.destroy();
  assert.equal(cancelled, 1);
});

test("preparation clears real hooks and theme references without destroying the rendition twice", () => {
  const { manager, clears } = createManager();
  const rendition = {
    q: new Queue({}),
    manager,
    hooks: { content: new Hook({}), unloaded: new Hook({}) },
  };
  rendition.themes = new Themes(rendition);
  rendition.hooks.content.register(() => "application closure");
  manager.addEventListeners();
  let renditionDestroys = 0;
  rendition.destroy = () => { renditionDestroys += 1; manager.destroy(); };
  prepareEpubRenditionForDestroy(rendition);
  prepareEpubRenditionForDestroy(rendition);
  assert.equal(renditionDestroys, 0, "book.destroy owns rendition.destroy");
  // Same relationship used by the installed Book.destroy implementation.
  rendition.destroy();
  assert.equal(renditionDestroys, 1);
  assert.equal(clears(), 1);
  assert.equal(rendition.hooks.content.list().length, 0);
  assert.equal(rendition.hooks.unloaded.list().length, 0);
  assert.equal(rendition.themes.rendition, undefined);
  assert.equal(browserWindow.count("unload"), 0);
});

test("a rendition stopped before book.opened never runs its queued startup", async () => {
  let resolveOpened;
  const opened = new Promise((resolve) => { resolveOpened = resolve; });
  let starts = 0;
  const originalStart = Rendition.prototype.start;
  Rendition.prototype.start = () => { starts += 1; };
  const rendition = new Rendition({ opened, spine: { hooks: { content: new Hook({}) } } });
  Rendition.prototype.start = originalStart;
  prepareEpubRenditionForDestroy(rendition);
  resolveOpened();
  for (let i = 0; i < 8; i += 1) {
    for (const callback of frameCallbacks.splice(0)) callback();
    await Promise.resolve();
  }
  assert.equal(starts, 0);
  assert.equal(rendition.q.length(), 0);
  assert.doesNotThrow(() => rendition.destroy());
});
