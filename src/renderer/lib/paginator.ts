import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * CSS-multicolumn paginator.
 *
 * The chapter flows into columns inside a fixed-size box; "turning a page" is a
 * translateX of one screen width (+ gap). Because we never re-flow or re-render the
 * content to paginate, Ranges — and therefore annotations and read-aloud highlights —
 * stay valid across page turns, resizes and single/double spread switches.
 */
export interface PaginatorApi {
  page: number;
  pages: number;
  stride: number;
  goTo: (page: number, animate?: boolean) => void;
  next: () => void;
  prev: () => void;
  /** Horizontal offset of a range in *unturned* content coordinates. */
  offsetXOf: (range: Range) => number | null;
  pageOf: (range: Range) => number | null;
  ensureVisible: (range: Range, animate?: boolean) => boolean;
  measure: () => void;
}

interface Options {
  viewportRef: React.RefObject<HTMLElement>;
  contentRef: React.RefObject<HTMLElement>;
  enabled: boolean;
  columns: number;
  gap: number;
  deps: unknown[];
  onMeasured?: () => void;
}

export function usePaginator({
  viewportRef,
  contentRef,
  enabled,
  columns,
  gap,
  deps,
  onMeasured,
}: Options): PaginatorApi {
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const strideRef = useRef(1);
  const pageRef = useRef(0);
  const pagesRef = useRef(1);
  const measuredRef = useRef(onMeasured);
  measuredRef.current = onMeasured;

  const apply = useCallback(
    (next: number, animate = true) => {
      const content = contentRef.current;
      if (!content) return;
      const clamped = Math.max(0, Math.min(next, Math.max(0, pagesRef.current - 1)));
      pageRef.current = clamped;
      content.style.transition = animate ? 'transform 280ms cubic-bezier(0.22, 0.61, 0.36, 1)' : 'none';
      content.style.transform = `translate3d(${-clamped * strideRef.current}px, 0, 0)`;
      setPage(clamped);
    },
    [contentRef],
  );

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    if (!enabled) {
      content.style.columnCount = '';
      content.style.columnGap = '';
      content.style.height = '';
      content.style.width = '';
      content.style.transform = '';
      content.style.transition = '';
      strideRef.current = 1;
      pagesRef.current = 1;
      setPages(1);
      measuredRef.current?.();
      return;
    }

    // clientWidth/Height include padding; the column box must be the *content* box or the
    // last column spills under the page margin and gets clipped by overflow:hidden.
    const cs = getComputedStyle(viewport);
    const w = viewport.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
    let h = viewport.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0');
    if (w <= 0 || h <= 0) return;
    // Snap the column to a whole number of text lines. Display scaling (125%) makes the
    // viewport height fractional, and a column that ends mid-line leaves the last line
    // riding the clip edge — snapping keeps every line fully inside with visible slack,
    // like a book's baseline grid.
    const lh = parseFloat(getComputedStyle(content).lineHeight || '');
    if (Number.isFinite(lh) && lh > 4) h = Math.max(lh, Math.floor(h / lh) * lh);
    content.style.columnCount = String(columns);
    content.style.columnGap = `${gap}px`;
    content.style.columnFill = 'auto';
    content.style.width = `${w}px`;
    content.style.height = `${h}px`;

    const stride = w + gap;
    strideRef.current = stride;
    // ceil, never round: for clean N-column content this is exactly N, but anything
    // that pokes past a column's edge (a long URL, a wide image, justified overflow)
    // pushes scrollWidth into a fraction — and rounding DOWN amputated the final page.
    // Readers heard the read-aloud voice speaking text no page could show. The 0.02
    // epsilon forgives sub-pixel hairlines so it cannot invent a blank page.
    const total = Math.max(1, Math.ceil((content.scrollWidth + gap) / stride - 0.02));
    pagesRef.current = total;
    setPages(total);
    apply(Math.min(pageRef.current, total - 1), false);
    measuredRef.current?.();
  }, [apply, columns, contentRef, enabled, gap, viewportRef]);

  useEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    ro.observe(viewport);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [measure, viewportRef]);

  const offsetXOf = useCallback(
    (range: Range): number | null => {
      const content = contentRef.current;
      if (!content) return null;
      const rects = range.getClientRects();
      const rect = rects.length ? rects[0] : range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return null;
      return rect.left - content.getBoundingClientRect().left;
    },
    [contentRef],
  );

  const pageOf = useCallback(
    (range: Range): number | null => {
      if (!enabled) return null;
      const x = offsetXOf(range);
      if (x == null) return null;
      return Math.max(0, Math.floor((x + 1) / strideRef.current));
    },
    [enabled, offsetXOf],
  );

  const ensureVisible = useCallback(
    (range: Range, animate = true): boolean => {
      const target = pageOf(range);
      if (target == null || target === pageRef.current) return false;
      apply(target, animate);
      return true;
    },
    [apply, pageOf],
  );

  return {
    page,
    pages,
    stride: strideRef.current,
    goTo: apply,
    next: () => apply(pageRef.current + 1),
    prev: () => apply(pageRef.current - 1),
    offsetXOf,
    pageOf,
    ensureVisible,
    measure,
  };
}
