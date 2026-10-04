/** EPUB reports physical columns; the controls count visible screens. */
export function renderedPagination(
  displayed?: { page?: number; total?: number },
  divisor = 1,
): { page: number; total: number } {
  const spread = Number.isFinite(divisor) ? Math.max(1, Math.floor(divisor)) : 1;
  const columns = Number.isFinite(displayed?.total) ? Math.max(1, Math.ceil(displayed!.total!)) : 1;
  const column = Number.isFinite(displayed?.page)
    ? Math.max(1, Math.min(columns, Math.floor(displayed!.page!))) : 1;
  return { page: Math.floor((column - 1) / spread) + 1, total: Math.ceil(columns / spread) };
}

export type PaginatedManager = {
  settings: { axis?: string; direction?: string; rtlScrollType?: string; fullsize?: boolean };
  layout: { delta?: number; height?: number; divisor?: number };
  container?: Pick<HTMLElement, "scrollWidth" | "scrollHeight" | "clientWidth" | "clientHeight">;
  scrollTo: (x: number, y: number, silent: boolean) => void;
};

/** Snap a chapter proportion to its nearest screen without accumulating drift. */
export function jumpRenderedProgress(manager: PaginatedManager, progress: number): boolean {
  const container = manager.container;
  // The reader owns an embedded viewport; full-window managers have a
  // different scroll origin and must use window geometry instead.
  if (!container || manager.settings.fullsize || !Number.isFinite(progress)) return false;
  const horizontal = manager.settings.axis === "horizontal";
  const stride = horizontal ? manager.layout.delta : manager.layout.height;
  const viewport = horizontal ? container.clientWidth : container.clientHeight;
  const extent = horizontal ? container.scrollWidth : container.scrollHeight;
  if (!stride || !Number.isFinite(stride) || stride <= 0 || !Number.isFinite(viewport) || viewport <= 0 || !Number.isFinite(extent)) return false;
  const maxOffset = Math.max(0, extent - viewport);
  // CSS widths can be fractional while scroll/client dimensions round to
  // integer pixels. Do not invent an extra screen for a rounding remainder.
  const screens = Math.max(1, Math.ceil(Math.max(0, maxOffset - 1) / stride) + 1);
  const ratio = Math.max(0, Math.min(1, progress));
  const screen = Math.round(ratio * (screens - 1));
  const offset = screens === 1 ? 0 : screen === screens - 1 ? maxOffset : Math.min(screen * stride, maxOffset);
  let x = horizontal ? offset : 0;
  if (horizontal && manager.settings.direction === "rtl") {
    if (manager.settings.rtlScrollType === "default") x = maxOffset - offset;
    else if (manager.settings.rtlScrollType === "reverse") x = offset;
    else x = -offset;
  }
  manager.scrollTo(x, horizontal ? 0 : offset, true);
  return true;
}
