import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/reader-pagination.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { renderedPagination, jumpRenderedProgress } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const require = createRequire(import.meta.url);
const DefaultViewManager = require("epubjs/lib/managers/default/index.js").default;

// Execute installed scrollTo/scrollBy/next/prev. Only DOM view loading is
// replaced; no book, browser, server or account is required.
function fixture({ screens = 9, width = 487, height = 600, divisor = 1,
  axis = "horizontal", direction = "ltr", rtlScrollType = "negative" } = {}) {
  const manager = new DefaultViewManager({ settings: { axis, direction, rtlScrollType, fullsize: false } });
  const stride = axis === "horizontal" ? width : height;
  const max = (screens - 1) * stride;
  let left = direction === "rtl" && rtlScrollType === "default" ? max : 0;
  let top = 0;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  manager.container = {
    clientWidth: width, offsetWidth: width,
    clientHeight: height, offsetHeight: height,
    scrollWidth: axis === "horizontal" ? screens * width : width,
    scrollHeight: axis === "vertical" ? screens * height : height,
    get scrollLeft() { return left; },
    set scrollLeft(value) { left = direction === "rtl" && rtlScrollType === "negative" ? clamp(value, -max, 0) : clamp(value, 0, max); },
    get scrollTop() { return top; },
    set scrollTop(value) { top = clamp(value, 0, max); },
  };
  manager.layout = { name: "reflowable", delta: width, height, divisor, pageWidth: width / divisor };
  manager.isPaginated = true;
  const loaded = [];
  const previous = { id: "previous", properties: [], prev: () => null, next: () => current };
  const following = { id: "following", properties: [], next: () => null, prev: () => current };
  const current = { id: "current", properties: [], next: () => following, prev: () => previous };
  let section = current;
  manager.views = {
    length: 1, last: () => ({ section }), first: () => ({ section }), show() {},
  };
  manager.clear = () => { manager.scrollTo(0, 0, true); };
  manager.updateLayout = () => {};
  manager.append = manager.prepend = async (nextSection) => {
    loaded.push(nextSection.id);
    section = nextSection;
  };
  return {
    manager, loaded, max, stride,
    logicalOffset: () => axis === "vertical" ? top
      : direction !== "rtl" || rtlScrollType === "reverse" ? left
      : rtlScrollType === "default" ? max - left : (-left || 0),
  };
}

test("rendered columns become screen pages including the last double-page spread", () => {
  assert.deepEqual(renderedPagination({ page: 26, total: 26 }), { page: 26, total: 26 });
  assert.deepEqual(renderedPagination({ page: 11, total: 12 }, 2), { page: 6, total: 6 });
  assert.deepEqual(renderedPagination({ page: 12, total: 12 }, 2), { page: 6, total: 6 });
  assert.deepEqual(renderedPagination({ page: 13, total: 13 }, 2), { page: 7, total: 7 });
  assert.deepEqual(renderedPagination({ page: 999, total: 12 }, 2), { page: 6, total: 6 });
  assert.deepEqual(renderedPagination({ page: -2, total: 12 }, 2), { page: 1, total: 6 });
  assert.deepEqual(renderedPagination(), { page: 1, total: 1 });
  assert.deepEqual(renderedPagination({ page: NaN, total: Infinity }, NaN), { page: 1, total: 1 });
});

test("0/25/50/75/100 percent snap to the closest screen for varied chapter lengths", () => {
  for (const screens of [1, 2, 9, 26, 34]) {
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      const f = fixture({ screens });
      assert.equal(jumpRenderedProgress(f.manager, ratio), true);
      assert.equal(f.logicalOffset(), Math.round(ratio * (screens - 1)) * f.stride);
      assert.equal(f.loaded.length, 0, "slider jumps must stay in the chapter");
      assert.equal(f.manager.ignore, true, "use installed silent scrollTo");
    }
  }
});

test("absolute jumps remove fractional drift and repeated jumps cannot accumulate it", () => {
  const f = fixture({ screens: 26 });
  f.manager.container.scrollLeft = 105.375;
  jumpRenderedProgress(f.manager, 0.5);
  assert.equal(f.logicalOffset(), 13 * 487);
  f.manager.container.scrollLeft += 0.625;
  jumpRenderedProgress(f.manager, 0.5);
  assert.equal(f.logicalOffset(), 13 * 487);
  jumpRenderedProgress(f.manager, 1);
  assert.equal(f.logicalOffset(), f.max);
});

test("rounded scroll dimensions do not invent a phantom screen", () => {
  const f = fixture({ screens: 6, width: 488 });
  f.manager.layout.delta = 487.5;
  f.manager.container.scrollWidth = 2925;
  f.manager.container.clientWidth = 487;
  jumpRenderedProgress(f.manager, 0.75);
  assert.equal(f.logicalOffset(), 4 * 487.5);
  jumpRenderedProgress(f.manager, 1);
  assert.equal(f.logicalOffset(), 2438);
});

test("double-page mode moves by screens and reaches the real final spread", () => {
  const f = fixture({ screens: 6, width: 1000, divisor: 2 });
  jumpRenderedProgress(f.manager, 0.5);
  assert.equal(f.logicalOffset(), 3000);
  jumpRenderedProgress(f.manager, 1);
  assert.equal(f.logicalOffset(), 5000);
  assert.deepEqual(renderedPagination({ page: 11, total: 12 }, 2), { page: 6, total: 6 });
});

test("vertical pagination uses height and ignores horizontal column geometry", () => {
  const f = fixture({ screens: 9, axis: "vertical" });
  for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
    jumpRenderedProgress(f.manager, ratio);
    assert.equal(f.logicalOffset(), Math.round(ratio * 8) * 600);
    assert.equal(f.manager.container.scrollLeft, 0);
  }
});

test("RTL offsets honor default, negative and reverse browser scroll models", () => {
  for (const rtlScrollType of ["default", "negative", "reverse"]) {
    const f = fixture({ direction: "rtl", rtlScrollType });
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      jumpRenderedProgress(f.manager, ratio);
      assert.equal(f.logicalOffset(), Math.round(ratio * 8) * 487);
    }
  }
});

test("installed next advances within a chapter then crosses only the final screen", async () => {
  for (const options of [
    {}, { divisor: 2, width: 1000 }, { axis: "vertical" },
    { direction: "rtl", rtlScrollType: "default" },
    { direction: "rtl", rtlScrollType: "negative" },
  ]) {
    const f = fixture(options);
    jumpRenderedProgress(f.manager, 0.75);
    await f.manager.next();
    assert.equal(f.logicalOffset(), 7 * f.stride);
    assert.equal(f.loaded.length, 0);
    await f.manager.next();
    assert.equal(f.logicalOffset(), f.max);
    assert.equal(f.loaded.length, 0);
    await f.manager.next();
    assert.deepEqual(f.loaded, ["following"]);
  }
});

test("installed prev goes backward then crosses only the first screen", async () => {
  for (const options of [{}, { divisor: 2 }, { axis: "vertical" },
    { direction: "rtl", rtlScrollType: "default" },
    { direction: "rtl", rtlScrollType: "negative" }]) {
    const f = fixture(options);
    jumpRenderedProgress(f.manager, 0.25);
    await f.manager.prev();
    assert.equal(f.logicalOffset(), f.stride);
    assert.equal(f.loaded.length, 0);
    await f.manager.prev();
    assert.equal(f.logicalOffset(), 0);
    await f.manager.prev();
    assert.deepEqual(f.loaded, ["previous"]);
  }
});

test("single-screen chapters still cross forward and backward", async () => {
  const next = fixture({ screens: 1 });
  jumpRenderedProgress(next.manager, 1);
  assert.equal(next.logicalOffset(), 0);
  await next.manager.next();
  assert.deepEqual(next.loaded, ["following"]);
  const previous = fixture({ screens: 1 });
  jumpRenderedProgress(previous.manager, 0);
  await previous.manager.prev();
  assert.deepEqual(previous.loaded, ["previous"]);
});

test("proportions clamp to the chapter and unavailable geometry returns false", () => {
  const f = fixture();
  jumpRenderedProgress(f.manager, -2);
  assert.equal(f.logicalOffset(), 0);
  jumpRenderedProgress(f.manager, 2);
  assert.equal(f.logicalOffset(), f.max);
  assert.equal(jumpRenderedProgress(f.manager, NaN), false);
  assert.equal(jumpRenderedProgress({ ...f.manager, container: undefined }, 0.5), false);
  f.manager.layout.delta = 0;
  assert.equal(jumpRenderedProgress(f.manager, 0.5), false);
});
