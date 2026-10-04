export function sliderTotal(total: number): number {
  return Number.isFinite(total) ? Math.max(1, Math.floor(total)) : 1;
}

export function sliderProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
}

export function pageToSliderProgress(page: number, total: number): number {
  const max = sliderTotal(total);
  return max <= 1 ? 0 : sliderProgress((page - 1) / (max - 1));
}

export function sliderProgressToPage(progress: number, total: number): number {
  return Math.round(sliderProgress(progress) * (sliderTotal(total) - 1)) + 1;
}
