import { useRef, useState, type CSSProperties } from "react";
import { pageToSliderProgress, sliderProgressToPage, sliderTotal } from "../lib/page-slider";

type Preview = { progress: number; page: number; total: number; active: boolean };
type PointerGesture = { id: number; progress: number; startProgress: number };

/** Preview a drag locally; navigate once on release instead of queueing pages. */
export function PageSlider({ page, total, disabled, onCommit }: {
  page: number;
  total: number;
  disabled?: boolean;
  onCommit: (progress: number) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const gesture = useRef<PointerGesture | null>(null);
  const max = sliderTotal(total);
  const currentPage = sliderProgressToPage(pageToSliderProgress(page, max), max);
  // A relocation acknowledges the optimistic preview. During a drag, retain
  // the ratio across pagination changes rather than treating it as a page ID.
  const currentPreview = preview && (preview.active || (preview.page === currentPage && preview.total === max));
  const progress = currentPreview ? preview.progress : pageToSliderProgress(currentPage, max);
  const value = sliderProgressToPage(progress, max);

  const commit = (target: number) => {
    setPreview({ progress: target, page: currentPage, total: max, active: false });
    onCommit(target);
  };
  const finishPointer = (pointerId?: number) => {
    const active = gesture.current;
    if (!active || (pointerId !== undefined && pointerId !== active.id)) return;
    // Clear first: pointerup can be followed by lostpointercapture and blur.
    gesture.current = null;
    if (disabled || max <= 1 || active.progress === active.startProgress) {
      setPreview(null);
      return;
    }
    commit(active.progress);
  };

  return <div className="page-slider">
    <input
      type="range"
      min={1}
      max={max}
      step={1}
      value={value}
      style={{ "--range-progress": `${max <= 1 ? 0 : progress * 100}%` } as CSSProperties}
      disabled={disabled || max <= 1}
      aria-label="本章阅读进度"
      aria-valuetext={`第 ${value} 页，共 ${max} 页`}
      onPointerDown={(event) => {
        if (disabled || max <= 1 || gesture.current || event.button !== 0) return;
        const startProgress = pageToSliderProgress(Number(event.currentTarget.value), max);
        gesture.current = { id: event.pointerId, progress: startProgress, startProgress };
        setPreview({ progress: startProgress, page: currentPage, total: max, active: true });
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onChange={(event) => {
        if (disabled || max <= 1) return;
        const next = pageToSliderProgress(Number(event.currentTarget.value), max);
        if (gesture.current) {
          gesture.current.progress = next;
          setPreview({ progress: next, page: currentPage, total: max, active: true });
        } else if (next !== progress) {
          // Native range keyboard and assistive-technology changes commit
          // immediately. Keep their latest value while relocation is pending.
          commit(next);
        }
      }}
      onPointerUp={(event) => finishPointer(event.pointerId)}
      onLostPointerCapture={(event) => finishPointer(event.pointerId)}
      onPointerCancel={(event) => {
        if (gesture.current?.id !== event.pointerId) return;
        gesture.current = null;
        setPreview(null);
      }}
      onBlur={() => finishPointer()}
    />
    <output className="page-slider-label">{value} / {max} 页</output>
  </div>;
}
