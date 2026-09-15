/**
 * Text model shared by main and renderer.
 *
 * The single most important invariant of this app:
 *
 *   The *same* rules produce the *same* leaf blocks and the *same* character offsets
 *   in Node (at import time, for search / word counts) and in the browser (at render
 *   time, for anchoring). Anchors are therefore portable across processes, restarts,
 *   font sizes, themes and layout modes.
 *
 * Rules:
 *  1. A "leaf block" is an element whose tag is in BLOCK_TAGS and which contains no
 *     descendant that is itself in BLOCK_TAGS.
 *  2. A block's text is the *raw* concatenation of its descendant text nodes — no
 *     whitespace collapsing. (Collapsing would need a per-character index map; raw
 *     concatenation is exact and free, and both sides agree because the chapter HTML
 *     is normalised once at import: CRLF -> LF, entities decoded by both parsers.)
 *  3. Offsets in TextAnchor / ReadAloudSegment are indices into that raw block text.
 */

import type { ReadAloudSegment, SegLang } from './types';

export const BLOCK_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'blockquote', 'pre', 'figcaption', 'dd', 'dt', 'td', 'th', 'div',
] as const;

export const BLOCK_SELECTOR = BLOCK_TAGS.join(',');
const BLOCK_SET = new Set<string>(BLOCK_TAGS as readonly string[]);

export const isBlockTag = (tag: string): boolean => BLOCK_SET.has(tag.toLowerCase());

/** Normalise line endings so Node and the browser see identical text. */
export const normaliseEol = (s: string): string => s.replace(/\r\n?/g, '\n');

/** Whitespace-collapsed copy, for display only — never for offsets. */
export const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/* -------------------------------------------------------------- language */

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;
const CJK_G = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/g;
const LATIN_WORD = /[A-Za-zÀ-ɏ]+(?:['’-][A-Za-z]+)*/g;

export function detectLang(text: string): SegLang {
  const cjk = (text.match(CJK_G) ?? []).length;
  const latin = (text.match(LATIN_WORD) ?? []).length;
  if (cjk === 0 && latin === 0) return 'other';
  // A single CJK char carries roughly as much content as a latin word.
  if (cjk > latin * 0.5) return 'zh';
  return latin > 0 ? 'en' : 'other';
}

/** BCP-47 tag for Intl / TTS voice matching. */
export function langTag(lang: SegLang, bookLanguage = 'en-US'): string {
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'en') return 'en-US';
  return bookLanguage;
}

/** CJK characters + latin words. Good enough for reading-time estimates. */
export function countWords(text: string): number {
  const cjk = (text.match(CJK_G) ?? []).length;
  const latin = (text.match(LATIN_WORD) ?? []).length;
  return cjk + latin;
}

/** Words per minute used for "N minutes left". */
export const WPM: Record<SegLang, number> = { zh: 400, en: 240, other: 260 };

export function minutesFor(words: number, lang: SegLang): number {
  return words / WPM[lang];
}

/* ------------------------------------------------------------ segmenting */

export interface Span {
  start: number;
  end: number;
  text: string;
}

/** Segments longer than this get split at secondary punctuation (TTS stability). */
// Synthesis latency is proportional to segment length, and the cloning engine runs at
// barely above realtime — a 160-char sentence meant ~25s of dead air before it spoke.
// 72 chars (~14s of Mandarin) keeps the pipeline's units small enough that lookahead
// can hide them, while clauses stay long enough to keep the prosody natural.
const MAX_SEGMENT = 72;
/** Segments shorter than this get merged into the following one. */
const MIN_SEGMENT = 3;

const SECONDARY = /[，,；;：:、—–]/g;

function splitLong(span: Span): Span[] {
  if (span.text.length <= MAX_SEGMENT) return [span];
  const out: Span[] = [];
  let cursor = 0;
  while (span.text.length - cursor > MAX_SEGMENT) {
    const window = span.text.slice(cursor, cursor + MAX_SEGMENT);
    SECONDARY.lastIndex = 0;
    let cut = -1;
    let m: RegExpExecArray | null;
    while ((m = SECONDARY.exec(window))) {
      // Prefer a break past the halfway point so pieces stay balanced.
      if (m.index > MAX_SEGMENT * 0.4) cut = m.index + 1;
    }
    if (cut < 0) {
      const sp = window.lastIndexOf(' ');
      cut = sp > MAX_SEGMENT * 0.4 ? sp + 1 : MAX_SEGMENT;
    }
    out.push({
      start: span.start + cursor,
      end: span.start + cursor + cut,
      text: span.text.slice(cursor, cursor + cut),
    });
    cursor += cut;
  }
  if (cursor < span.text.length) {
    out.push({ start: span.start + cursor, end: span.end, text: span.text.slice(cursor) });
  }
  return out;
}

function mergeShort(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    if (prev && prev.text.trim().length < MIN_SEGMENT && prev.end === s.start) {
      out[out.length - 1] = { start: prev.start, end: s.end, text: prev.text + s.text };
    } else {
      out.push(s);
    }
  }
  return out;
}

let segmenterCache: Record<string, Intl.Segmenter> = {};
function sentenceSegmenter(locale: string): Intl.Segmenter | null {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter === 'undefined') return null;
  segmenterCache[locale] ??= new Intl.Segmenter(locale, { granularity: 'sentence' });
  return segmenterCache[locale];
}

/** Regex fallback for runtimes without Intl.Segmenter. */
function regexSentences(text: string): Span[] {
  const out: Span[] = [];
  const re = /[^。！？!?…\n]*[。！？!?…]+["”』」)）]*|[^。！？!?…\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0].trim()) continue;
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

/** Split one block of text into sentence-ish spans with offsets into that block. */
export function segmentText(text: string, lang: SegLang = detectLang(text)): Span[] {
  if (!text.trim()) return [];
  const seg = sentenceSegmenter(lang === 'zh' ? 'zh' : 'en');
  const base: Span[] = [];
  if (seg) {
    for (const piece of seg.segment(text)) {
      if (!piece.segment.trim()) continue;
      base.push({
        start: piece.index,
        end: piece.index + piece.segment.length,
        text: piece.segment,
      });
    }
  } else {
    base.push(...regexSentences(text));
  }
  return mergeShort(base.flatMap(splitLong));
}

export const segmentId = (chapterId: string, blockIndex: number, index: number): string =>
  `${chapterId}|${blockIndex}|${index}`;

export function parseSegmentId(id: string): { chapterId: string; blockIndex: number; index: number } | null {
  const i = id.lastIndexOf('|');
  if (i < 0) return null;
  const j = id.lastIndexOf('|', i - 1);
  if (j < 0) return null;
  const chapterId = id.slice(0, j);
  const blockIndex = Number(id.slice(j + 1, i));
  const index = Number(id.slice(i + 1));
  if (!Number.isFinite(blockIndex) || !Number.isFinite(index)) return null;
  return { chapterId, blockIndex, index };
}

/**
 * Build every read-aloud segment of a chapter from its leaf-block texts.
 *
 * Spans are trimmed to non-whitespace so that a word-boundary `charIndex` reported by
 * the speech engine (which speaks the trimmed text) maps onto `start + charIndex`
 * without any correction.
 */
export function makeSegments(chapterId: string, blocks: string[]): ReadAloudSegment[] {
  const out: ReadAloudSegment[] = [];
  blocks.forEach((text, blockIndex) => {
    const blockLang = detectLang(text);
    let index = 0;
    for (const span of segmentText(text, blockLang)) {
      const lead = span.text.length - span.text.trimStart().length;
      const trail = span.text.length - span.text.trimEnd().length;
      const start = span.start + lead;
      const end = span.end - trail;
      if (end <= start) continue;
      const trimmed = text.slice(start, end);
      const lang = detectLang(trimmed);
      out.push({
        id: segmentId(chapterId, blockIndex, index),
        chapterId,
        blockIndex,
        index,
        start,
        end,
        text: trimmed,
        lang: lang === 'other' ? blockLang : lang,
      });
      index++;
    }
  });
  return out;
}

/* ---------------------------------------------------------------- search */

export interface RawHit {
  blockIndex: number;
  start: number;
  end: number;
}

export function searchBlocks(blocks: string[], query: string, limit = 500): RawHit[] {
  const q = query.trim().toLowerCase();
  const hits: RawHit[] = [];
  if (!q) return hits;
  for (let b = 0; b < blocks.length && hits.length < limit; b++) {
    const hay = blocks[b].toLowerCase();
    let from = 0;
    for (;;) {
      const i = hay.indexOf(q, from);
      if (i < 0) break;
      hits.push({ blockIndex: b, start: i, end: i + q.length });
      if (hits.length >= limit) break;
      from = i + q.length;
    }
  }
  return hits;
}

export function makeSnippet(
  block: string,
  start: number,
  end: number,
  pad = 48,
): { snippet: string; matchStart: number; matchEnd: number } {
  const from = Math.max(0, start - pad);
  const to = Math.min(block.length, end + pad);
  const lead = from > 0 ? '…' : '';
  const tail = to < block.length ? '…' : '';
  const raw = block.slice(from, to);
  // Collapse for display, but keep the match offsets meaningful by collapsing in parts.
  const before = collapse(block.slice(from, start));
  const match = collapse(block.slice(start, end));
  const after = collapse(block.slice(end, to));
  void raw;
  const snippet = `${lead}${before}${before ? ' ' : ''}${match}${after ? ' ' : ''}${after}${tail}`;
  const matchStart = lead.length + before.length + (before ? 1 : 0);
  return { snippet, matchStart, matchEnd: matchStart + match.length };
}
