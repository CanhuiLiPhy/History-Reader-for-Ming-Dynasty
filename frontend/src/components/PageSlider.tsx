import { useRef, useState, type CSSProperties } from "react";

/** Preview a drag locally; navigate once on release instead of queueing pages. */
export function PageSlider({ page, total, disabled, onCommit }: {
  page: number;
  total: number;
  disabled?: boolean;
  onCommit: (page: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const dragging = useRef(false);
  const max = Math.max(1, total);
  const value = Math.max(1, Math.min(draft ?? page, max));
  const commit = (target: number) => {
    dragging.current = false;
    setDraft(null);
    onCommit(target);
  };

  return <div className="page-slider">
    <input
      type="range"
      min={1}
      max={max}
      step={1}
      value={value}
      style={{ "--range-progress": `${max <= 1 ? 0 : ((value - 1) / (max - 1)) * 100}%` } as CSSProperties}
      disabled={disabled || max <= 1}
      aria-label="本章阅读进度"
      aria-valuetext={`第 ${value} 页，共 ${max} 页`}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        if (dragging.current) setDraft(next);
        else commit(next);
      }}
      onPointerUp={(event) => commit(Number(event.currentTarget.value))}
      onPointerCancel={() => { dragging.current = false; setDraft(null); }}
      onBlur={(event) => { if (dragging.current) commit(Number(event.currentTarget.value)); }}
    />
    <output className="page-slider-label">{value} / {max} 页</output>
  </div>;
}
