import type { InkImage, InkItem, InkShape, InkStroke, InkText } from '@shared/types';
import type { BlockModel } from './anchors';
import { inkImageUrl } from './util';

/**
 * Handwriting and page elements over reflowable text.
 *
 * GoodNotes draws on fixed PDF pages; this book reflows on every font or window
 * change, so nothing can be stored in page coordinates. Every item — stroke, shape,
 * picture, text box — is anchored to a LEAF BLOCK and stored in block-width units
 * relative to the block's top-left. On every layout pass the items are re-projected
 * from the blocks' current rectangles, so margin scribbles, circles and stickers stay
 * glued to the paragraph they were made on through font-size changes, column switches
 * and window resizes.
 *
 * The SVG layer lives INSIDE the paginator's content element, so it rides the
 * page-turn translate for free and never needs per-page repainting. Absolutely
 * positioned children of a multicolumn box do not fragment — the layer spans the
 * whole flowed strip in plain layout coordinates.
 */

export const PEN_COLORS = ['ink', 'red', 'blue', 'orange'] as const;
export const MARKER_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;

export const isStroke = (it: InkItem): it is InkStroke => !('kind' in it) || it.kind === undefined || it.kind === 'stroke';
export const isShape = (it: InkItem): it is InkShape => (it as InkShape).kind === 'shape';
export const isImage = (it: InkItem): it is InkImage => (it as InkImage).kind === 'image';
export const isText = (it: InkItem): it is InkText => (it as InkText).kind === 'text';

const strokeColorVar = (it: InkStroke | InkShape): string =>
  isStroke(it) && it.tool === 'marker' ? `var(--hl-${it.color})` : `var(--pen-${it.color})`;

/** Layout-space rect of a block, robust under the content's translate transform. */
export function blockRect(
  content: HTMLElement,
  block: BlockModel,
): { x: number; y: number; w: number; h: number } {
  const c = content.getBoundingClientRect();
  const b = block.el.getBoundingClientRect();
  return { x: b.left - c.left, y: b.top - c.top, w: Math.max(1, b.width), h: b.height };
}

/** The block a freshly made item belongs to: the nearest one to its first point. */
export function pickAnchorBlock(
  content: HTMLElement,
  blocks: BlockModel[],
  x: number,
  y: number,
): BlockModel | null {
  let best: BlockModel | null = null;
  let bestScore = Infinity;
  for (const block of blocks) {
    const r = blockRect(content, block);
    if (r.w < 2 || r.h < 2) continue;
    // Distance to the rect (0 when inside), with a slight preference for blocks whose
    // vertical band contains the point — margin notes sit beside their paragraph.
    const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - (r.x + r.w) : 0;
    const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - (r.y + r.h) : 0;
    const score = dy * 2 + dx;
    if (score < bestScore) {
      bestScore = score;
      best = block;
    }
  }
  return best;
}

interface Projection {
  r: { x: number; y: number; w: number; h: number };
  scale: number;
}

function projection(content: HTMLElement, blocks: BlockModel[], it: InkItem): Projection | null {
  const block = blocks[it.blockIndex];
  if (!block) return null;
  const r = blockRect(content, block);
  const w0 = (it as InkStroke).w0;
  return { r, scale: r.w / (w0 || r.w) };
}

/** Projected polyline of a stroke or shape in current layout coordinates. */
export function projectStroke(
  content: HTMLElement,
  blocks: BlockModel[],
  it: InkStroke | InkShape,
): { pts: number[]; width: number } | null {
  const p = projection(content, blocks, it);
  if (!p) return null;
  const pts: number[] = [];
  for (let i = 0; i < it.points.length; i += 2) {
    pts.push(p.r.x + it.points[i] * p.r.w, p.r.y + it.points[i + 1] * p.r.w);
  }
  return { pts, width: Math.max(0.8, it.size * p.scale) };
}

/** Smooth SVG path through the points (quadratic through midpoints). */
export function pathFrom(pts: number[]): string {
  if (pts.length < 4) {
    // A dot: tiny closed segment so stroke-linecap paints it round.
    return pts.length >= 2 ? `M ${pts[0]} ${pts[1]} l 0.01 0` : '';
  }
  let d = `M ${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2;
    const my = (pts[i + 1] + pts[i + 3]) / 2;
    d += ` Q ${pts[i]} ${pts[i + 1]} ${mx} ${my}`;
  }
  d += ` L ${pts[pts.length - 2]} ${pts[pts.length - 1]}`;
  return d;
}

/**
 * Variable-width outline for the fountain pen: offset each point along its normal by
 * half its local width, then close left rail + reversed right rail into one filled
 * polygon. Round caps come from the first/last width collapsing toward the tip.
 */
export function fountainOutline(pts: number[], ws: number[], base: number): string {
  const n = pts.length / 2;
  if (n < 2) return pathFrom(pts);
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    const px = pts[Math.max(0, i - 1) * 2];
    const py = pts[Math.max(0, i - 1) * 2 + 1];
    const nx2 = pts[Math.min(n - 1, i + 1) * 2];
    const ny2 = pts[Math.min(n - 1, i + 1) * 2 + 1];
    let tx = nx2 - px;
    let ty = ny2 - py;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const half = (base * (ws[i] ?? 1)) / 2;
    left.push(x - ty * half, y + tx * half);
    right.push(x + ty * half, y - tx * half);
  }
  const rev: number[] = [];
  for (let i = n - 1; i >= 0; i--) rev.push(right[i * 2], right[i * 2 + 1]);
  const rail = (arr: number[]): string => {
    let d = '';
    for (let i = 2; i < arr.length - 2; i += 2) {
      const mx = (arr[i] + arr[i + 2]) / 2;
      const my = (arr[i + 1] + arr[i + 3]) / 2;
      d += ` Q ${arr[i]} ${arr[i + 1]} ${mx} ${my}`;
    }
    d += ` L ${arr[arr.length - 2]} ${arr[arr.length - 1]}`;
    return d;
  };
  return `M ${left[0]} ${left[1]}${rail(left)} L ${rev[0]} ${rev[1]}${rail(rev)} Z`;
}

/** SVG path for a perfect shape from its two drag corners (layout space). */
export function shapePath(shape: InkShape['shape'], pts: number[], width: number): string {
  const [x0, y0, x1, y1] = pts;
  if (shape === 'line') return `M ${x0} ${y0} L ${x1} ${y1}`;
  if (shape === 'arrow') {
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const head = Math.max(9, width * 3.6);
    const a1 = ang + Math.PI * 0.82;
    const a2 = ang - Math.PI * 0.82;
    return (
      `M ${x0} ${y0} L ${x1} ${y1}` +
      ` M ${x1 + Math.cos(a1) * head} ${y1 + Math.sin(a1) * head} L ${x1} ${y1}` +
      ` L ${x1 + Math.cos(a2) * head} ${y1 + Math.sin(a2) * head}`
    );
  }
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  if (shape === 'rect') return `M ${x} ${y} h ${w} v ${h} h ${-w} Z`;
  // Ellipse as two arcs.
  const cx = x + w / 2;
  const cy = y + h / 2;
  return `M ${cx - w / 2} ${cy} a ${w / 2} ${h / 2} 0 1 0 ${w} 0 a ${w / 2} ${h / 2} 0 1 0 ${-w} 0 Z`;
}

/** Ensure the ink SVG (with its pencil-grain filter) exists inside the content element. */
export function ensureInkLayer(content: HTMLElement): SVGSVGElement {
  let svg = content.querySelector<SVGSVGElement>(':scope > svg.ink-layer');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ink-layer');
    svg.setAttribute('aria-hidden', 'true');
    // Sketchy pencil edge: fractal noise displacing the stroke outline a hair.
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML =
      '<filter id="ink-grain" x="-8%" y="-8%" width="116%" height="116%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="2" seed="7" result="n"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="2.6"/>' +
      '</filter>';
    svg.appendChild(defs);
    content.appendChild(svg);
  }
  svg.style.width = `${content.scrollWidth}px`;
  svg.style.height = `${content.clientHeight}px`;
  return svg;
}

const NS = 'http://www.w3.org/2000/svg';

function renderStroke(svg: SVGSVGElement, it: InkStroke, proj: { pts: number[]; width: number }): void {
  const el = document.createElementNS(NS, 'path');
  const style = it.tool === 'marker' ? 'marker' : (it.style ?? 'ball');
  if (style === 'fountain') {
    el.setAttribute('d', fountainOutline(proj.pts, it.ws ?? [], proj.width));
    el.setAttribute('fill', strokeColorVar(it));
    el.setAttribute('class', 'ink-pen ink-fountain');
  } else {
    el.setAttribute('d', pathFrom(proj.pts));
    el.setAttribute('stroke', strokeColorVar(it));
    el.setAttribute('fill', 'none');
    if (style === 'marker') {
      el.setAttribute('stroke-width', String(proj.width * 4.5));
      el.setAttribute('class', 'ink-marker');
    } else if (style === 'pencil') {
      el.setAttribute('stroke-width', String(proj.width));
      el.setAttribute('class', 'ink-pen ink-pencil');
      el.setAttribute('filter', 'url(#ink-grain)');
    } else {
      el.setAttribute('stroke-width', String(proj.width));
      el.setAttribute('class', 'ink-pen');
    }
  }
  el.setAttribute('data-ink-id', it.id);
  svg.appendChild(el);
}

/** Repaint every item of the current chapter into the layer. */
export function renderInk(
  content: HTMLElement,
  blocks: BlockModel[],
  items: InkItem[],
  chapterId: string,
  bookId: string,
): void {
  const svg = ensureInkLayer(content);
  for (const el of [...svg.children]) if (el.tagName !== 'defs') el.remove();
  for (const it of items) {
    if (it.chapterId !== chapterId) continue;
    if (isImage(it)) {
      const p = projection(content, blocks, it);
      if (!p) continue;
      const el = document.createElementNS(NS, 'image');
      el.setAttribute('href', inkImageUrl(bookId, it.file));
      el.setAttribute('x', String(p.r.x + it.nx * p.r.w));
      el.setAttribute('y', String(p.r.y + it.ny * p.r.w));
      el.setAttribute('width', String(it.nw * p.r.w));
      el.setAttribute('height', String(it.nh * p.r.w));
      el.setAttribute('preserveAspectRatio', 'none');
      el.setAttribute('data-ink-id', it.id);
      el.setAttribute('class', 'ink-image');
      svg.appendChild(el);
      continue;
    }
    if (isText(it)) {
      const p = projection(content, blocks, it);
      if (!p) continue;
      const el = document.createElementNS(NS, 'text');
      const font = Math.max(9, it.nsize * p.r.w);
      el.setAttribute('x', String(p.r.x + it.nx * p.r.w));
      el.setAttribute('y', String(p.r.y + it.ny * p.r.w + font));
      el.setAttribute('fill', `var(--pen-${it.color})`);
      el.setAttribute('font-size', String(font));
      el.setAttribute('data-ink-id', it.id);
      el.setAttribute('class', 'ink-text');
      const x = p.r.x + it.nx * p.r.w;
      it.text.split('\n').forEach((line, i) => {
        const tspan = document.createElementNS(NS, 'tspan');
        tspan.setAttribute('x', String(x));
        if (i > 0) tspan.setAttribute('dy', '1.3em');
        tspan.textContent = line || ' ';
        el.appendChild(tspan);
      });
      svg.appendChild(el);
      continue;
    }
    if (isShape(it)) {
      const proj = projectStroke(content, blocks, it);
      if (!proj) continue;
      const el = document.createElementNS(NS, 'path');
      el.setAttribute('d', shapePath(it.shape, proj.pts, proj.width));
      el.setAttribute('stroke', strokeColorVar(it));
      el.setAttribute('stroke-width', String(proj.width));
      el.setAttribute('fill', 'none');
      el.setAttribute('data-ink-id', it.id);
      el.setAttribute('class', 'ink-pen ink-shape');
      svg.appendChild(el);
      continue;
    }
    const proj = projectStroke(content, blocks, it as InkStroke);
    if (!proj) continue;
    renderStroke(svg, it as InkStroke, proj);
  }
}

/** Sampled layout-space outline points of any item, for eraser/lasso hit tests. */
export function samplePoints(content: HTMLElement, blocks: BlockModel[], it: InkItem): number[] {
  if (isImage(it) || isText(it)) {
    const box = itemBBox(content, blocks, it);
    if (!box) return [];
    const { x, y, w, h } = box;
    return [x, y, x + w, y, x + w, y + h, x, y + h, x + w / 2, y + h / 2];
  }
  const proj = projectStroke(content, blocks, it as InkStroke | InkShape);
  if (!proj) return [];
  if (isShape(it)) {
    const [x0, y0, x1, y1] = proj.pts;
    const out: number[] = [];
    if (it.shape === 'line' || it.shape === 'arrow') {
      for (let t = 0; t <= 1; t += 0.1) out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    } else if (it.shape === 'rect') {
      for (let t = 0; t <= 1; t += 0.25) {
        out.push(x0 + (x1 - x0) * t, y0, x0 + (x1 - x0) * t, y1, x0, y0 + (y1 - y0) * t, x1, y0 + (y1 - y0) * t);
      }
    } else {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        out.push(cx + (Math.abs(x1 - x0) / 2) * Math.cos(a), cy + (Math.abs(y1 - y0) / 2) * Math.sin(a));
      }
    }
    return out;
  }
  return proj.pts;
}

/** Ids of items whose outline passes within `radius` px of (x, y). */
export function itemsNear(
  content: HTMLElement,
  blocks: BlockModel[],
  items: InkItem[],
  chapterId: string,
  x: number,
  y: number,
  radius = 14,
): string[] {
  const hit: string[] = [];
  const r2 = radius * radius;
  for (const it of items) {
    if (it.chapterId !== chapterId) continue;
    const pts = samplePoints(content, blocks, it);
    for (let i = 0; i < pts.length; i += 2) {
      const dx = pts[i] - x;
      const dy = pts[i + 1] - y;
      if (dx * dx + dy * dy <= r2) {
        hit.push(it.id);
        break;
      }
    }
  }
  return hit;
}

/** Layout-space bounding box of an item (strokes padded by half their width). */
export function itemBBox(
  content: HTMLElement,
  blocks: BlockModel[],
  it: InkItem,
): { x: number; y: number; w: number; h: number } | null {
  const p = projection(content, blocks, it);
  if (!p) return null;
  if (isImage(it)) {
    return { x: p.r.x + it.nx * p.r.w, y: p.r.y + it.ny * p.r.w, w: it.nw * p.r.w, h: it.nh * p.r.w };
  }
  if (isText(it)) {
    const font = Math.max(9, it.nsize * p.r.w);
    const lines = it.text.split('\n');
    const longest = Math.max(1, ...lines.map((l) => [...l].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 1 : 0.55), 0)));
    return {
      x: p.r.x + it.nx * p.r.w,
      y: p.r.y + it.ny * p.r.w,
      w: longest * font,
      h: lines.length * font * 1.3 + font * 0.3,
    };
  }
  const proj = projectStroke(content, blocks, it as InkStroke | InkShape);
  if (!proj || proj.pts.length < 2) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < proj.pts.length; i += 2) {
    x0 = Math.min(x0, proj.pts[i]);
    x1 = Math.max(x1, proj.pts[i]);
    y0 = Math.min(y0, proj.pts[i + 1]);
    y1 = Math.max(y1, proj.pts[i + 1]);
  }
  const pad = proj.width * ((it as InkStroke).tool === 'marker' ? 2.5 : 0.5) + 2;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

/** Point-in-polygon (ray casting), polygon as flat [x, y, …]. */
export function inPolygon(px: number, py: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ids of items captured by a lasso polygon (majority of sample points inside). */
export function itemsInLasso(
  content: HTMLElement,
  blocks: BlockModel[],
  items: InkItem[],
  chapterId: string,
  poly: number[],
): string[] {
  if (poly.length < 6) return [];
  const out: string[] = [];
  for (const it of items) {
    if (it.chapterId !== chapterId) continue;
    const pts = samplePoints(content, blocks, it);
    if (!pts.length) continue;
    let inside = 0;
    for (let i = 0; i < pts.length; i += 2) if (inPolygon(pts[i], pts[i + 1], poly)) inside++;
    if (inside >= Math.max(1, Math.ceil(pts.length / 4))) out.push(it.id);
  }
  return out;
}

/** A copy of `it` translated by (dx, dy) layout px — converted into its block's units. */
export function moveItem(
  content: HTMLElement,
  blocks: BlockModel[],
  it: InkItem,
  dx: number,
  dy: number,
): InkItem {
  const p = projection(content, blocks, it);
  if (!p) return it;
  const ux = dx / p.r.w;
  const uy = dy / p.r.w;
  if (isImage(it) || isText(it)) {
    return { ...it, nx: it.nx + ux, ny: it.ny + uy };
  }
  const src = it as InkStroke | InkShape;
  const points = src.points.slice();
  for (let i = 0; i < points.length; i += 2) {
    points[i] += ux;
    points[i + 1] += uy;
  }
  return { ...src, points };
}
