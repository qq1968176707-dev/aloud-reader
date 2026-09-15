/**
 * Range painting.
 *
 * Primary implementation is the CSS Custom Highlight API: highlights are *Ranges*, not
 * DOM nodes, so painting them costs no reflow, never invalidates other annotations, and
 * survives font-size / theme / column changes with no bookkeeping at all. It is also the
 * only sane way to paint overlapping highlights (a note inside a read-aloud line).
 *
 * The fallback (absolutely positioned rects) exists for environments without the API and
 * is only used for the read-aloud line/word, where a missing highlight would break the
 * core feature.
 */

export const HIGHLIGHT_SUPPORTED =
  typeof CSS !== 'undefined' && typeof (CSS as unknown as { highlights?: unknown }).highlights !== 'undefined';

let fallbackLayer: HTMLElement | null = null;

export function setFallbackLayer(el: HTMLElement | null): void {
  fallbackLayer = el;
}

const fallbackClass = (name: string): string => `hl-fb hl-fb-${name.replace(/[^\w-]/g, '')}`;

function paintFallback(name: string, ranges: Range[]): void {
  if (!fallbackLayer) return;
  fallbackLayer.querySelectorAll(`.hl-fb-${name.replace(/[^\w-]/g, '')}`).forEach((n) => n.remove());
  const origin = fallbackLayer.getBoundingClientRect();
  for (const range of ranges) {
    for (const rect of Array.from(range.getClientRects())) {
      const div = document.createElement('div');
      div.className = fallbackClass(name);
      div.style.left = `${rect.left - origin.left}px`;
      div.style.top = `${rect.top - origin.top}px`;
      div.style.width = `${rect.width}px`;
      div.style.height = `${rect.height}px`;
      fallbackLayer.appendChild(div);
    }
  }
}

const active = new Set<string>();

export function setHighlight(name: string, ranges: Range[]): void {
  if (!HIGHLIGHT_SUPPORTED) {
    paintFallback(name, ranges);
    if (ranges.length) active.add(name);
    else active.delete(name);
    return;
  }
  if (!ranges.length) {
    CSS.highlights.delete(name);
    active.delete(name);
    return;
  }
  CSS.highlights.set(name, new Highlight(...ranges));
  active.add(name);
}

export function clearHighlight(name: string): void {
  setHighlight(name, []);
}

export function clearHighlights(prefix: string): void {
  for (const name of [...active]) {
    if (name.startsWith(prefix)) clearHighlight(name);
  }
}

/** Fallback rects are absolute: they must be repainted whenever geometry changes. */
export function repaintFallback(painters: Record<string, Range[]>): void {
  if (HIGHLIGHT_SUPPORTED) return;
  for (const [name, ranges] of Object.entries(painters)) paintFallback(name, ranges);
}
