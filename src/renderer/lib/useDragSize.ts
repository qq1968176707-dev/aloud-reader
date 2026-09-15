import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A draggable edge for a fixed-width panel.
 *
 * The live width is local state so the drag stays at frame rate, and the value is only
 * written back to settings on release — persisting on every mousemove would round-trip
 * through IPC and a disk write a hundred times per gesture.
 *
 * `edge` is the side the grip sits on: dragging the right edge of a left-hand sidebar
 * grows it, dragging the left edge of a right-hand panel grows it too, so the sign of
 * the delta flips between the two.
 */
export function useDragSize({
  value,
  min,
  max,
  edge,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  edge: 'right' | 'left';
  onCommit: (next: number) => void;
}): { size: number; dragging: boolean; onMouseDown: (e: React.MouseEvent) => void } {
  const [size, setSize] = useState(value);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, base: 0 });

  // Follow external changes (a reset, or the other window) unless mid-drag.
  useEffect(() => {
    if (!dragging) setSize(value);
  }, [value, dragging]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startRef.current = { x: e.clientX, base: size };
      setDragging(true);
    },
    [size],
  );

  useEffect(() => {
    if (!dragging) return;
    let latest = size;
    const clamp = (n: number): number => Math.max(min, Math.min(max, n));
    const onMove = (e: MouseEvent): void => {
      if (e.buttons === 0) {
        onUp();
        return;
      }
      const dx = e.clientX - startRef.current.x;
      latest = clamp(startRef.current.base + (edge === 'right' ? dx : -dx));
      setSize(latest);
    };
    const onUp = (): void => {
      setDragging(false);
      onCommit(Math.round(latest));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, edge, min, max]);

  return { size, dragging, onMouseDown };
}
