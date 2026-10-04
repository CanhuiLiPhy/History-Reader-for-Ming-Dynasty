// Narrow declarations for the installed epub.js 0.3.93 manager internals used
// by our lifecycle adapter. Its package only declares the public Manager API.
declare module "epubjs/src/managers/default/index.js" {
  export default class DefaultViewManager {
    constructor(options: object);
    settings: { fullsize?: boolean };
    container?: HTMLElement;
    rendered: boolean;
    q?: { stop: () => void };
    renditionQueue?: { stop: () => void };
    stage?: {
      orientationChangeFunc?: EventListener;
      resizeFunc?: EventListener & { cancel?: () => void };
    };
    onScroll: EventListener;
    addEventListeners(): void;
    removeEventListeners(): void;
    render(element: Element, size: { width: number; height: number }): void;
    destroy(): void;
  }
}
