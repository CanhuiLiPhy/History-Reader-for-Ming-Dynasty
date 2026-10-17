/**
 * 中文：触控板双指滑动、鼠标滚轮翻页的手势识别。
 *
 * Page-turn recognition for trackpad two-finger swipes and mouse wheels.
 *
 * Browsers expose a two-finger swipe only as a stream of `wheel` events: the
 * active phase while the fingers move, then (on macOS and Windows precision
 * touchpads) a long inertial tail that keeps arriving after the fingers lift.
 * The DOM gives no phase information, so a naive "turn on every event" would
 * flip a dozen pages per swipe. This module turns that stream into at most one
 * page turn per physical swipe while still allowing quick consecutive swipes.
 *
 * The module is deliberately DOM-free (no imports, no globals) so the exact
 * production logic runs in the Node test suite.
 */

/**
 * 中文：翻页手势模式：关闭 / 只认左右滑动 / 左右与上下（含鼠标滚轮）都认。
 *
 * Which wheel axes may turn pages.
 * - `"off"`: never turn pages and never consume events.
 * - `"horizontal"`: horizontal two-finger swipes only (the default).
 * - `"all"`: horizontal swipes plus vertical scrolling and mouse wheels.
 */
export type WheelPagingMode = "off" | "horizontal" | "all";

/**
 * 中文：一次 wheel 事件里识别器需要的字段。
 *
 * The subset of a `WheelEvent` the recogniser needs.
 *
 * @property deltaX - Horizontal delta in `deltaMode` units; positive scrolls right.
 * @property deltaY - Vertical delta in `deltaMode` units; positive scrolls down.
 * @property deltaMode - 0 = pixels, 1 = lines, 2 = pages.
 * @property ctrlKey - Trackpad pinch-zoom arrives as a wheel event with ctrlKey.
 * @property time - Milliseconds on one monotonic clock shared by every event
 *   source. EPUB pages live in iframes whose `event.timeStamp` uses a different
 *   origin, so callers pass `performance.now()` from the top window instead.
 */
export type WheelSample = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  time: number;
};

/**
 * 中文：识别结果：是否吞掉事件、是否翻页及方向。
 *
 * Result of feeding one sample to the recogniser.
 *
 * @property consume - The caller should call `preventDefault()`. This stops the
 *   browser's own horizontal scroll and Chrome/Safari's "swipe to go back".
 * @property turn - 1 = next page, -1 = previous page, 0 = no page turn.
 */
export type WheelPagingDecision = {
  consume: boolean;
  turn: -1 | 0 | 1;
};

/**
 * 中文：识别阈值。数值按 macOS 触控板与 Windows 鼠标滚轮的实际事件流设定。
 *
 * Recogniser thresholds, sized for macOS trackpads and Windows mouse wheels.
 *
 * - `turnDistance` (px): accumulated travel along one axis before a page turns.
 *   One Windows wheel notch is 100 px, so a single notch turns immediately.
 * - `axisRatio`: the turning axis must exceed the other by this factor, so a
 *   diagonal or mostly-vertical scroll never turns a page sideways.
 * - `gestureGap` (ms): silence that ends a gesture, inertial tail included.
 * - `minTurnInterval` (ms): one swipe can never produce two turns faster.
 * - `decayRatio`: after a turn, magnitude must fall to this fraction of the
 *   swipe's peak before a fresh rise may count as a new swipe.
 * - `reaccelerateRatio` / `reaccelerateMin` (px): how far magnitude must rise
 *   above the post-turn trough to count as a new swipe during inertia.
 * - `reverseMin` (px): an opposite-direction delta this large starts a new
 *   gesture immediately; inertia never reverses direction.
 * - `linePx` / `pagePx`: conversions for `deltaMode` 1 and 2.
 */
export const WHEEL_PAGING_THRESHOLDS = {
  turnDistance: 48,
  axisRatio: 1.25,
  gestureGap: 170,
  minTurnInterval: 300,
  decayRatio: 0.35,
  reaccelerateRatio: 2.5,
  reaccelerateMin: 10,
  reverseMin: 4,
  linePx: 16,
  pagePx: 400,
} as const;

const NO_ACTION: WheelPagingDecision = { consume: false, turn: 0 };

/**
 * 中文：把一串 wheel 事件折算成「每次滑动最多翻一页」的翻页指令。
 *
 * Stateful recogniser that converts wheel events into page turns.
 *
 * Gesture model:
 * 1. A gesture starts after `gestureGap` ms without events. Deltas accumulate
 *    per axis; once one axis passes `turnDistance` and dominates the other by
 *    `axisRatio`, one page turns and the gesture becomes "turned".
 * 2. While turned, every further event of the gesture is consumed without
 *    turning (this swallows the inertial tail). The tail is tracked as
 *    peak → decay → trough.
 * 3. A new swipe is recognised early, without waiting for silence, when the
 *    delta reverses direction, or when magnitude climbs back above the trough
 *    (`max(trough × reaccelerateRatio, trough + reaccelerateMin)`) after having
 *    decayed below `peak × decayRatio`. Both require `minTurnInterval` ms since
 *    the previous turn, so the noisy active phase of one slow swipe can never
 *    turn two pages.
 *
 * Direction: positive deltaX (content scrolls left, i.e. "forward" under both
 * natural and classic scrolling conventions) and positive deltaY mean next
 * page. `rtl` mirrors the horizontal axis for books paginated right-to-left.
 */
export class WheelPageGesture {
  private accX = 0;
  private accY = 0;
  private lastTime = Number.NEGATIVE_INFINITY;
  private turned = false;
  private turnTime = Number.NEGATIVE_INFINITY;
  private turnAxis: "x" | "y" = "x";
  private turnSign = 0;
  private peak = 0;
  private trough = Number.POSITIVE_INFINITY;
  private decayed = false;

  /**
   * 中文：喂入一次 wheel 事件，返回是否吞掉、是否翻页。
   *
   * Feed one wheel sample and decide what to do with it.
   *
   * @param sample - The normalised wheel event, see {@link WheelSample}.
   * @param mode - Which axes may turn pages, see {@link WheelPagingMode}.
   * @param rtl - True when the next page lies to the left (right-to-left books).
   * @returns Whether to consume the event and which way (if any) to turn.
   */
  handle(sample: WheelSample, mode: WheelPagingMode, rtl = false): WheelPagingDecision {
    if (mode === "off") return NO_ACTION;
    // Pinch-zoom is not paging; forget any half-built swipe. / 双指缩放不是翻页，丢弃未完成的手势。
    if (sample.ctrlKey) {
      this.reset();
      return NO_ACTION;
    }
    const t = WHEEL_PAGING_THRESHOLDS;
    const scale = sample.deltaMode === 1 ? t.linePx : sample.deltaMode === 2 ? t.pagePx : 1;
    const dx = (Number.isFinite(sample.deltaX) ? sample.deltaX : 0) * scale;
    const dy = (Number.isFinite(sample.deltaY) ? sample.deltaY : 0) * scale;
    if (dx === 0 && dy === 0) return NO_ACTION;
    const allowVertical = mode === "all";
    // In horizontal mode a vertical-dominant event is not ours to consume, but
    // it still counts toward the axis test so long vertical scrolls cannot
    // creep into a sideways turn through jitter.
    // 只认左右时，竖向为主的事件不吞掉，但仍计入累计，防止长时间上下滚动的横向抖动攒成一次误翻。
    const ours = allowVertical || Math.abs(dx) >= Math.abs(dy);

    if (sample.time - this.lastTime > t.gestureGap) this.startGesture();
    this.lastTime = sample.time;

    if (this.turned) {
      const axisDelta = this.turnAxis === "x" ? dx : dy;
      const otherDelta = this.turnAxis === "x" ? dy : dx;
      // Only events dominated by the turning axis describe the inertial tail. / 只用翻页轴为主的事件刻画惯性尾巴。
      if (Math.abs(axisDelta) < Math.abs(otherDelta)) return { consume: ours, turn: 0 };
      const magnitude = Math.abs(axisDelta);
      const reversed = Math.sign(axisDelta) !== this.turnSign && magnitude >= t.reverseMin;
      if (!this.decayed) {
        this.peak = Math.max(this.peak, magnitude);
        if (magnitude <= this.peak * t.decayRatio) {
          this.decayed = true;
          this.trough = magnitude;
        }
      } else {
        this.trough = Math.min(this.trough, magnitude);
      }
      const reaccelerated = this.decayed
        && magnitude >= Math.max(this.trough * t.reaccelerateRatio, this.trough + t.reaccelerateMin);
      if (!(reversed || reaccelerated) || sample.time - this.turnTime < t.minTurnInterval) {
        return { consume: ours, turn: 0 };
      }
      // A new swipe began inside the old one's tail; this event is its start. / 惯性尾巴里开始了新的一次滑动，本事件即其起点。
      this.startGesture();
    }

    this.accX += dx;
    this.accY += dy;
    const absX = Math.abs(this.accX);
    const absY = Math.abs(this.accY);
    let turn: -1 | 0 | 1 = 0;
    if (absX >= t.turnDistance && absX >= absY * t.axisRatio) {
      this.turnAxis = "x";
      this.turnSign = Math.sign(this.accX);
      turn = (this.accX > 0) !== rtl ? 1 : -1;
    } else if (allowVertical && absY >= t.turnDistance && absY >= absX * t.axisRatio) {
      this.turnAxis = "y";
      this.turnSign = Math.sign(this.accY);
      turn = this.accY > 0 ? 1 : -1;
    }
    if (turn !== 0) {
      this.turned = true;
      this.turnTime = sample.time;
      this.peak = Math.abs(this.turnAxis === "x" ? dx : dy);
      this.decayed = false;
      this.trough = Number.POSITIVE_INFINITY;
      this.accX = 0;
      this.accY = 0;
    }
    return { consume: ours, turn };
  }

  /**
   * 中文：清空全部手势状态（如换书或关闭该功能时）。
   *
   * Forget all gesture state, e.g. after switching books or disabling paging.
   */
  reset(): void {
    this.startGesture();
    this.lastTime = Number.NEGATIVE_INFINITY;
    this.turnTime = Number.NEGATIVE_INFINITY;
  }

  /**
   * 中文：开始新的一次手势：清零累计量与惯性跟踪。
   *
   * Begin a fresh gesture: clear accumulation and inertia tracking. The time
   * of the previous turn is kept so `minTurnInterval` still applies.
   */
  private startGesture(): void {
    this.accX = 0;
    this.accY = 0;
    this.turned = false;
    this.peak = 0;
    this.trough = Number.POSITIVE_INFINITY;
    this.decayed = false;
  }
}
