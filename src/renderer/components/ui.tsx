import React, { useEffect, useRef } from 'react';
import { cx } from '../lib/util';

const PATHS: Record<string, string> = {
  library: 'M4 4h5v16H4zM11 4h4v16h-4zM17.2 4.6l3.6 1-3.4 14.2-3.6-1z',
  back: 'M15 5l-7 7 7 7',
  search: 'M11 4a7 7 0 1 0 4.2 12.6L20 21.4 21.4 20l-4.8-4.8A7 7 0 0 0 11 4m0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10',
  toc: 'M4 6h16M4 12h16M4 18h10',
  aa: 'M3 19l5.5-14h2L16 19h-2.2l-1.4-4H6.6l-1.4 4zm4.2-6h4.2L9.5 7.2zM17 19v-8h1.8v1.2A2.6 2.6 0 0 1 21 11v1.8c-1.4 0-2.2.7-2.2 2V19z',
  bookmark: 'M6 3h12v18l-6-4.2L6 21z',
  bookmarkOff: 'M6 3h12v18l-6-4.2L6 21z',
  cursor: 'M5 2.8 5 18.2 9.1 14.3 11.8 20 14.6 18.7 11.9 13.2 17.4 12.9Z',
  note: 'M4 4h16v11l-5 5H4zM15 20v-5h5',
  speaker: 'M4 9h3.5L12 5v14l-4.5-4H4zM16 9.2a4 4 0 0 1 0 5.6M18.6 6.6a7.6 7.6 0 0 1 0 10.8',
  play: 'M8 5.5v13l10-6.5z',
  pause: 'M8 5h3.2v14H8zM12.8 5H16v14h-3.2z',
  prevLine: 'M6 6h12M17 12H8m0 0 3.4-3.4M8 12l3.4 3.4M6 18h12',
  nextLine: 'M6 6h12M7 12h9m0 0-3.4-3.4M16 12l-3.4 3.4M6 18h12',
  chevronLeft: 'M14.5 5.5 8 12l6.5 6.5',
  chevronRight: 'M9.5 5.5 16 12l-6.5 6.5',
  close: 'M6 6l12 12M18 6L6 18',
  gear: 'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8M4.2 12a7.8 7.8 0 0 1 .1-1.2l-2-1.5 2-3.5 2.3 1a7.8 7.8 0 0 1 2-1.2L9 3h4l.4 2.6c.7.3 1.4.7 2 1.2l2.3-1 2 3.5-2 1.5c.1.8.1 1.6 0 2.4l2 1.5-2 3.5-2.3-1c-.6.5-1.3.9-2 1.2L13 21H9l-.4-2.6a7.8 7.8 0 0 1-2-1.2l-2.3 1-2-3.5 2-1.5A7.8 7.8 0 0 1 4.2 12',
  plus: 'M12 5v14M5 12h14',
  chart: 'M4 20V9m5 11V4m5 16v-7m5 7V7',
  trash: 'M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13',
  export: 'M12 16V4m0 0L8 8m4-4 4 4M4 17v3h16v-3',
  download: 'M12 4v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M4 6h16M4 12h16M4 18h16',
  zoom: 'M11 4a7 7 0 1 0 4.2 12.6L20 21.4 21.4 20l-4.8-4.8A7 7 0 0 0 11 4M8.5 11h5M11 8.5v5',
  check: 'M5 12.5 10 17l9-10',
  folder: 'M4 6h6l2 2h8v11H4z',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  book: 'M4 5.5c3-1.2 5-1.2 8 0v13c-3-1.2-5-1.2-8 0zM12 5.5c3-1.2 5-1.2 8 0v13c-3-1.2-5-1.2-8 0z',
  reset: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4',
  mic: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6',
  pen: 'M4 20l1.2-4.2L16.4 4.6a2 2 0 0 1 2.8 0l0.2 0.2a2 2 0 0 1 0 2.8L8.2 18.8zM14.5 6.5l3 3',
  lasso: 'M12 4c4.7 0 8.5 2.4 8.5 5.4S16.7 14.8 12 14.8c-1 0-2-0.1-2.9-0.3M3.5 9.4C3.5 6.4 7.3 4 12 4M3.5 9.4c0 1.7 1.2 3.2 3.1 4.2M6.6 13.6c-1.6 0.5-2.6 1.6-2.6 2.9 0 1.2 0.9 2.2 2.3 2.8M6.3 19.3c0.3 0.1 0.5 0.9 0.3 1.7',
  shapes: 'M8.5 3.5 13 11H4zM16.5 12.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  textTool: 'M5 6V4h14v2M12 4v16M9 20h6',
  image: 'M4 5.5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM8 10a1.4 1.4 0 1 0 0-2.8A1.4 1.4 0 0 0 8 10zM21 15l-4.8-4.8-5.4 5.4-2.4-2.4L3 18.5',
  shapeLine: 'M4.5 19.5 19.5 4.5',
  shapeArrow: 'M4.5 19.5 19 5M19.5 11V4.5H13',
  shapeRect: 'M4.5 6h15v12h-15z',
  shapeEllipse: 'M12 5.5c4.7 0 8.5 2.9 8.5 6.5s-3.8 6.5-8.5 6.5S3.5 15.6 3.5 12 7.3 5.5 12 5.5z',
  notebook: 'M6 3.5h11a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2zM4 7.5h2M4 12h2M4 16.5h2M9.5 8.5h5M9.5 12h5',
  grip: 'M9 6h0.01M15 6h0.01M9 12h0.01M15 12h0.01M9 18h0.01M15 18h0.01',
  undo: 'M8 5 4 9l4 4M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M16 5l4 4-4 4M20 9H10a6 6 0 0 0 0 12h3',
  marker: 'M6 15.5 15.2 6.3a2 2 0 0 1 2.8 0l-0.3-0.3a2 2 0 0 1 0 2.8L8.5 18zM6 15.5 5 19l3.5-1M4 21h16',
  eraser: 'M8.5 19 4 14.5a2 2 0 0 1 0-2.8l7-7a2 2 0 0 1 2.8 0l4.5 4.5a2 2 0 0 1 0 2.8L12 18.3a2 2 0 0 1-1.4 0.7H8.5zM7 10.5l6.5 6.5M13 19h7',
};

export function Icon({
  name,
  size = 17,
  filled = false,
}: {
  name: keyof typeof PATHS | string;
  size?: number;
  /** Solid version of the glyph — used for on/off states like an active bookmark. */
  filled?: boolean;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: 'none' }}
    >
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button key={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  label,
  checked,
  onChange,
}: {
  label: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="switch">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        <span>{format ? format(value) : value}</span>
      </label>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** Closes on outside click or Escape. */
export function useDismiss(ref: React.RefObject<HTMLElement>, onDismiss: () => void, active = true): void {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cb.current();
      }
    };
    // `capture: false` + timeout so the click that opened us does not close us.
    const timer = setTimeout(() => document.addEventListener('mousedown', onPointer), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [active, ref]);
}

export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 210),
    top: Math.min(y, window.innerHeight - 240),
  };
  return (
    <div ref={ref} className="context-menu" style={style} onClick={onClose}>
      {children}
    </div>
  );
}

export const Row = ({ children, className }: { children: React.ReactNode; className?: string }): JSX.Element => (
  <div className={cx('row', className)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    {children}
  </div>
);
