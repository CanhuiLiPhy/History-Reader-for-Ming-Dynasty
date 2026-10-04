import DefaultViewManager from "epubjs/src/managers/default/index.js";

/**
 * epub.js 0.3.93 binds an anonymous window unload listener for each manager
 * and never removes it. Keep only this small listener bridge local; all
 * pagination, layout and view management still use the installed manager.
 */
export class ReaderViewManager extends DefaultViewManager {
  private disposed = false;
  private scroller: EventTarget | null = null;
  private scrollListener: EventListener | null = null;
  private readonly unloadListener = () => this.destroy();

  override addEventListeners() {
    if (this.disposed) return;
    this.removeEventListeners();
    this.scroller = this.settings.fullsize ? window : (this.container ?? null);
    this.scrollListener = this.onScroll.bind(this);
    this.scroller?.addEventListener("scroll", this.scrollListener);
    window.addEventListener("unload", this.unloadListener);
  }

  override removeEventListeners() {
    window.removeEventListener("unload", this.unloadListener);
    if (this.scrollListener) this.scroller?.removeEventListener("scroll", this.scrollListener);
    this.scrollListener = null;
    this.scroller = null;
  }

  override render(element: Element, size: { width: number; height: number }) {
    // A queued attach must not resurrect an instance after a fast book switch.
    if (!this.disposed) super.render(element, size);
  }

  override destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.q?.stop();
    this.renditionQueue?.stop();
    this.removeEventListeners();

    // Stage registers lowercase "orientationchange", but 0.3.93 attempts to
    // remove "orientationChange". That listener otherwise retains the stage.
    const stage = this.stage;
    if (stage?.orientationChangeFunc) {
      window.removeEventListener("orientationchange", stage.orientationChangeFunc);
    }
    if (stage?.resizeFunc) window.removeEventListener("resize", stage.resizeFunc);
    stage?.resizeFunc?.cancel?.();

    // Upstream destroy assumes render() created a stage. A book may be
    // switched before its EPUB finishes opening, so skip that unsafe path.
    if (stage) super.destroy();
    this.rendered = false;
  }
}

type RenditionCleanup = {
  q?: { stop: () => void };
  manager?: { destroy: () => void };
  hooks?: Record<string, { clear?: () => void }>;
  themes?: { destroy?: () => void };
};

const preparedRenditions = new WeakSet<object>();

/**
 * Call immediately before book.destroy(), which owns rendition.destroy().
 * Upstream leaves the rendition startup queue, hooks and themes alive.
 * Stopping the queue first also prevents a late book.opened from mounting it.
 */
export function prepareEpubRenditionForDestroy(rendition: object): void {
  if (preparedRenditions.has(rendition)) return;
  preparedRenditions.add(rendition);
  const runtime = rendition as RenditionCleanup;
  runtime.q?.stop();
  try {
    // Our manager is idempotent. Release its window listeners immediately,
    // even if a partly initialized book throws before reaching its rendition.
    runtime.manager?.destroy();
  } finally {
    for (const hook of Object.values(runtime.hooks ?? {})) hook.clear?.();
    runtime.themes?.destroy?.();
  }
}
