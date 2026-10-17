// Runs the production wheel-gesture recogniser against synthetic event streams
// shaped like macOS trackpad swipes (active phase + inertial tail) and wheels.
// 用模拟的触控板滑动（含惯性尾巴）与滚轮事件流，直接测试正式代码。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/wheel-paging.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { WheelPageGesture, WHEEL_PAGING_THRESHOLDS } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const FRAME = 16;

/** One swipe: an accelerating active phase, then an exponentially decaying tail. */
function swipe({ peak = 44, sign = 1, axis = "x", inertiaFrames = 60, decay = 0.9, jitter = 0 } = {}) {
  const active = [0.05, 0.15, 0.35, 0.6, 0.85, 1, 0.9, 0.7].map((f) => f * peak);
  const tail = Array.from({ length: inertiaFrames }, (_, i) => 0.65 * peak * decay ** i).filter((v) => v >= 0.5);
  return [...active, ...tail].map((v, i) => ({
    dx: axis === "x" ? sign * v : (i % 2 ? jitter : -jitter),
    dy: axis === "y" ? sign * v : (i % 2 ? -jitter : jitter),
  }));
}

/** Feed deltas at frame intervals; returns the list of turns and consume flags. */
function run(gesture, deltas, { mode = "horizontal", rtl = false, start = 0, step = FRAME, deltaMode = 0, ctrlKey = false } = {}) {
  const turns = [];
  const consumed = [];
  deltas.forEach(({ dx, dy }, i) => {
    const time = start + i * step;
    const result = gesture.handle({ deltaX: dx, deltaY: dy, deltaMode, ctrlKey, time }, mode, rtl);
    consumed.push(result.consume);
    if (result.turn) turns.push({ turn: result.turn, time, index: i });
  });
  return { turns, consumed, end: start + deltas.length * step };
}

test("one trackpad swipe with a long inertial tail turns exactly one page", () => {
  const gesture = new WheelPageGesture();
  const deltas = swipe();
  const { turns, consumed } = run(gesture, deltas);
  assert.deepEqual(turns.map((t) => t.turn), [1]);
  // The turn fires as soon as the accumulated travel passes the threshold.
  // 累计位移一越过门槛就翻页，不等手指抬起。
  let travel = 0;
  const expectedIndex = deltas.findIndex(({ dx }) => (travel += dx) >= WHEEL_PAGING_THRESHOLDS.turnDistance);
  assert.equal(turns[0].index, expectedIndex);
  assert.ok(consumed.every(Boolean), "every horizontal event is consumed so the browser cannot swipe back");
});

test("swiping the other way turns back, and separate swipes each turn once", () => {
  const gesture = new WheelPageGesture();
  const first = run(gesture, swipe({ sign: -1 }));
  assert.deepEqual(first.turns.map((t) => t.turn), [-1]);
  const second = run(gesture, swipe(), { start: first.end + 400 });
  const third = run(gesture, swipe(), { start: second.end + 400 });
  assert.deepEqual([...second.turns, ...third.turns].map((t) => t.turn), [1, 1]);
});

test("a new swipe that starts inside the previous inertial tail is recognised", () => {
  const gesture = new WheelPageGesture();
  const tailCut = swipe().slice(0, 30); // fingers land again while inertia still runs
  const ramp = [1, 3, 8, 18, 30, 40, 36, 20, 10, 5, 2].map((dx) => ({ dx, dy: 0 }));
  const { turns } = run(gesture, [...tailCut, ...ramp]);
  assert.deepEqual(turns.map((t) => t.turn), [1, 1]);
  assert.ok(turns[1].time - turns[0].time >= WHEEL_PAGING_THRESHOLDS.minTurnInterval);
});

test("a reversal inside the tail turns back without waiting for silence", () => {
  const gesture = new WheelPageGesture();
  const forward = swipe().slice(0, 28);
  const back = [-2, -6, -14, -26, -38, -30, -12].map((dx) => ({ dx, dy: 0 }));
  const { turns } = run(gesture, [...forward, ...back]);
  assert.deepEqual(turns.map((t) => t.turn), [1, -1]);
});

test("a slow, uneven swipe still turns only one page", () => {
  const gesture = new WheelPageGesture();
  const deltas = [3, 5, 8, 10, 12, 14, 12, 10, 13, 15, 12, 9, 11, 14, 10, 8, 6, 4, 3, 2, 1]
    .map((dx) => ({ dx, dy: 0 }));
  assert.deepEqual(run(gesture, deltas).turns.map((t) => t.turn), [1]);
});

test("vertical scrolling never turns pages sideways in horizontal mode", () => {
  const gesture = new WheelPageGesture();
  const deltas = swipe({ axis: "y", peak: 60, jitter: 3, inertiaFrames: 90 });
  const { turns, consumed } = run(gesture, deltas);
  assert.equal(turns.length, 0);
  assert.ok(deltas.every(({ dx, dy }, i) => Math.abs(dy) <= Math.abs(dx) || consumed[i] === false),
    "vertical-dominant events are left to the page");
  // Drift from slightly diagonal jitter cannot accumulate into a turn either.
  // 斜向抖动也攒不成横向翻页。
  const diagonal = Array.from({ length: 80 }, () => ({ dx: 3, dy: 25 }));
  assert.equal(run(new WheelPageGesture(), diagonal).turns.length, 0);
});

test("in all-axes mode vertical swipes and mouse wheel notches turn pages", () => {
  const gesture = new WheelPageGesture();
  assert.deepEqual(run(gesture, swipe({ axis: "y" }), { mode: "all" }).turns.map((t) => t.turn), [1]);
  // Windows mouse notches: 100 px each. A burst turns once; a later notch turns again.
  // Windows 鼠标每格 100px：连续快拨只翻一页，停顿后再拨再翻。
  const wheel = new WheelPageGesture();
  const burst = run(wheel, [{ dx: 0, dy: 100 }, { dx: 0, dy: 100 }, { dx: 0, dy: 100 }], { mode: "all", step: 40 });
  assert.deepEqual(burst.turns.map((t) => t.index), [0]);
  const later = run(wheel, [{ dx: 0, dy: -100 }], { mode: "all", start: burst.end + 400 });
  assert.deepEqual(later.turns.map((t) => t.turn), [-1]);
  // Line-based wheels (Firefox): three lines reach the threshold.
  // 以行为单位的滚轮（Firefox）：三行即达门槛。
  const lines = run(new WheelPageGesture(), [{ dx: 0, dy: 3 }], { mode: "all", deltaMode: 1 });
  assert.deepEqual(lines.turns.map((t) => t.turn), [1]);
});

test("pinch-zoom, disabled mode and right-to-left books", () => {
  const pinch = run(new WheelPageGesture(), swipe(), { ctrlKey: true });
  assert.equal(pinch.turns.length, 0);
  assert.ok(pinch.consumed.every((value) => value === false));
  const off = run(new WheelPageGesture(), swipe(), { mode: "off" });
  assert.equal(off.turns.length, 0);
  assert.ok(off.consumed.every((value) => value === false));
  assert.deepEqual(run(new WheelPageGesture(), swipe(), { rtl: true }).turns.map((t) => t.turn), [-1]);
});
