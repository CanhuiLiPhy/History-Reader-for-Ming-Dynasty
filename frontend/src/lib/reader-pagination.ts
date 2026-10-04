/** EPUB character locations are not visual pages: use the rendered layout. */
export function renderedPageDelta(current: number, target: number, total: number, divisor = 1): number {
  const spread = Math.max(1, Math.floor(divisor));
  const clamp = (page: number) => Math.max(1, Math.min(Math.round(page), Math.max(1, total)));
  const spreadStart = (page: number) => Math.floor((clamp(page) - 1) / spread) * spread;
  return spreadStart(target) - spreadStart(current);
}
