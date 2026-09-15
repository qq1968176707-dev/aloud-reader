/**
 * DOM side of the anchoring system.
 *
 * A chapter's rendered DOM is reduced to an ordered list of *leaf blocks* using exactly
 * the same rule the importer used in Node (shared/text.ts), so `blockIndex` means the
 * same thing in both places. Inside a block, positions are plain character offsets into
 * the concatenation of its text nodes — no whitespace collapsing, so the mapping back to
 * (textNode, offset) is exact.
 *
 * Nothing here depends on fonts, themes, column layout or window size: a TextAnchor is
 * resolved to a live DOM Range on demand, and Ranges reflow with the text for free.
 */
import { BLOCK_SELECTOR, isBlockTag } from '@shared/text';
import type { TextAnchor } from '@shared/types';

export interface BlockNodeSpan {
  node: Text;
  start: number;
  end: number;
}

export interface BlockModel {
  index: number;
  el: HTMLElement;
  text: string;
  nodes: BlockNodeSpan[];
}

function buildModel(el: HTMLElement, index: number): BlockModel {
  const nodes: BlockNodeSpan[] = [];
  let offset = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    nodes.push({ node, start: offset, end: offset + len });
    offset += len;
    node = walker.nextNode() as Text | null;
  }
  return { index, el, text: nodes.map((n) => n.node.data).join(''), nodes };
}

/** Leaf blocks in document order; also stamps `data-blk` for hit-testing. */
export function buildBlocks(root: HTMLElement): BlockModel[] {
  const blocks: BlockModel[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (isBlockTag(el.tagName) && !el.querySelector(BLOCK_SELECTOR)) {
      el.dataset.blk = String(blocks.length);
      blocks.push(buildModel(el, blocks.length));
      return;
    }
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return blocks;
}

function locate(block: BlockModel, offset: number, preferEnd = false): { node: Text; offset: number } | null {
  if (!block.nodes.length) return null;
  const clamped = Math.max(0, Math.min(block.text.length, offset));
  for (const span of block.nodes) {
    if (preferEnd ? clamped > span.start && clamped <= span.end : clamped >= span.start && clamped < span.end) {
      return { node: span.node, offset: clamped - span.start };
    }
  }
  const last = block.nodes[block.nodes.length - 1];
  const first = block.nodes[0];
  return clamped <= first.start
    ? { node: first.node, offset: 0 }
    : { node: last.node, offset: last.node.data.length };
}

export function rangeIn(block: BlockModel, start: number, end: number): Range | null {
  const from = locate(block, start);
  const to = locate(block, end, true);
  if (!from || !to) return null;
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return range;
}

/* -------------------------------------------------------------- resolve */

const near = (a: string, b: string): number => {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let same = 0;
  for (let i = 1; i <= n; i++) if (a[a.length - i] === b[b.length - i]) same++;
  return same / n;
};

/**
 * Re-anchor after the chapter text changed (book re-imported, source edited).
 * Uses the stored quote plus its immediate context to pick the best block.
 */
function reanchor(blocks: BlockModel[], anchor: TextAnchor): { block: BlockModel; start: number; end: number } | null {
  const exact = anchor.exact;
  if (!exact) return null;
  let best: { block: BlockModel; start: number; score: number } | null = null;
  for (const block of blocks) {
    let from = 0;
    for (;;) {
      const i = block.text.indexOf(exact, from);
      if (i < 0) break;
      const prefixScore = anchor.prefix ? near(block.text.slice(Math.max(0, i - anchor.prefix.length), i), anchor.prefix) : 0.5;
      const suffixScore = anchor.suffix
        ? near(anchor.suffix, block.text.slice(i + exact.length, i + exact.length + anchor.suffix.length))
        : 0.5;
      const distance = Math.abs(block.index - anchor.blockIndex);
      const score = prefixScore + suffixScore - distance * 0.01;
      if (!best || score > best.score) best = { block, start: i, score };
      from = i + 1;
    }
  }
  return best ? { block: best.block, start: best.start, end: best.start + exact.length } : null;
}

export function resolveAnchor(blocks: BlockModel[], anchor: TextAnchor): Range | null {
  const block = blocks[anchor.blockIndex];
  if (block) {
    const slice = block.text.slice(anchor.start, anchor.end);
    if (!anchor.exact || slice === anchor.exact) return rangeIn(block, anchor.start, anchor.end);
  }
  const fixed = reanchor(blocks, anchor);
  if (fixed) return rangeIn(fixed.block, fixed.start, fixed.end);
  return block ? rangeIn(block, anchor.start, anchor.end) : null;
}

/* ------------------------------------------------------------- inspect */

export const blockOf = (blocks: BlockModel[], node: Node | null): BlockModel | null => {
  let el = node?.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : (node?.parentElement ?? null);
  el = el?.closest('[data-blk]') ?? null;
  if (!el) return null;
  const index = Number(el.dataset.blk);
  return Number.isFinite(index) ? (blocks[index] ?? null) : null;
};

export function offsetInBlock(block: BlockModel, node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    const span = block.nodes.find((s) => s.node === node);
    return span ? span.start + offset : 0;
  }
  // Element container: offset counts child nodes.
  const child = node.childNodes[Math.max(0, offset - 1)] ?? null;
  if (!child) return 0;
  const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
  const last = (() => {
    let n = walker.nextNode() as Text | null;
    let out: Text | null = null;
    while (n) {
      out = n;
      n = walker.nextNode() as Text | null;
    }
    return out;
  })();
  const span = last ? block.nodes.find((s) => s.node === last) : undefined;
  return span ? span.end : 0;
}

const CONTEXT = 32;

export function anchorFromRange(
  chapterId: string,
  blocks: BlockModel[],
  range: Range,
): TextAnchor | null {
  const block = blockOf(blocks, range.startContainer);
  if (!block) return null;
  const start = offsetInBlock(block, range.startContainer, range.startOffset);
  const endBlock = blockOf(blocks, range.endContainer) ?? block;
  const end =
    endBlock === block
      ? offsetInBlock(block, range.endContainer, range.endOffset)
      : block.text.length; // selection spilled into the next block: clamp to this one
  if (end <= start) return null;
  return {
    chapterId,
    blockIndex: block.index,
    start,
    end,
    exact: block.text.slice(start, end),
    prefix: block.text.slice(Math.max(0, start - CONTEXT), start),
    suffix: block.text.slice(end, end + CONTEXT),
  };
}

/** Anchor for an arbitrary (blockIndex, start, end) triple, with context filled in. */
export function anchorAt(
  chapterId: string,
  blocks: BlockModel[],
  blockIndex: number,
  start: number,
  end: number,
): TextAnchor {
  const block = blocks[blockIndex];
  const text = block?.text ?? '';
  return {
    chapterId,
    blockIndex,
    start,
    end,
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

/** Point (viewport coords) -> position inside the block model. */
export function positionFromPoint(
  blocks: BlockModel[],
  x: number,
  y: number,
): { block: BlockModel; offset: number } | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  } else if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  }
  if (!node) return null;
  // A page-turn overlay is a deep CLONE of the chapter: it carries data-blk attributes
  // that resolve into the real block list, but its text nodes are not in any block's
  // node table, so the offset silently collapses to 0. A save racing a turn animation
  // then recorded "block N at 0" — the chapter title — and reopening the book landed a
  // page back. The overlay is scenery, never a position: treat hitting it as a miss so
  // the caller falls back to real geometry.
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  if (el?.closest('.pt-overlay')) return null;
  const block = blockOf(blocks, node);
  if (!block) return null;
  return { block, offset: offsetInBlock(block, node, offset) };
}
