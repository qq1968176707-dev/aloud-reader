/**
 * PDF import.
 *
 * Deliberate trade-off: instead of a second, fixed-layout rendering pipeline, PDFs are
 * converted into the same reflowable chapter model as everything else. That means every
 * feature (themes, font size, annotations, search, read-aloud) works on PDFs for free.
 * The cost is that original page layout and embedded images are not preserved —
 * a fixed-layout canvas view is on the v2 backlog.
 */
import { BOOK_SCHEMA, type BookManifest, type ChapterRef, type TocItem } from '@shared/types';
import { collapse } from '@shared/text';
import { basename, extname } from './pathlite';
import type { ImportedBook } from './index';

/**
 * pdf.js is loaded through a host-supplied hook rather than a bare `import()`.
 *
 * Electron wants a NON-literal specifier so esbuild leaves pdf.js out of the main
 * bundle and Node resolves it at run time; the browser build needs the opposite — a
 * literal specifier Vite can see and bundle, because a bare module name cannot be
 * resolved in a page. One hook satisfies both.
 */
type PdfjsLoader = () => Promise<any>;
let loadPdfjs: PdfjsLoader = () => import(/* @vite-ignore */ 'pdfjs-dist/legacy/build/pdf.mjs' as string);
export const setPdfjsLoader = (fn: PdfjsLoader): void => {
  loadPdfjs = fn;
};

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

const escapeText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const endsSentence = (s: string): boolean => /[.!?。！？…”"』」]\s*$/.test(s);
const isCjkEdge = (s: string): boolean => /[㐀-䶿一-鿿豈-﫿]/.test(s);

function joinLines(lines: string[]): string[] {
  const paragraphs: string[] = [];
  const widths = lines.map((l) => l.length).sort((a, b) => a - b);
  const median = widths.length ? widths[Math.floor(widths.length / 2)] : 0;
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t) paragraphs.push(t);
    buf = '';
  };
  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      flush();
      continue;
    }
    if (!buf) {
      buf = text;
    } else {
      const glue = isCjkEdge(buf.slice(-1)) || isCjkEdge(text.slice(0, 1)) ? '' : ' ';
      buf += glue + text;
    }
    // A short line that also closes a sentence is very likely a paragraph end.
    if (endsSentence(text) && text.length < median * 0.92) flush();
  }
  flush();
  return paragraphs;
}

/** Group text items into visual lines using their baseline y. */
function pageLines(items: TextItem[]): string[] {
  const lines: string[] = [];
  let current: string[] = [];
  let lastY: number | null = null;
  for (const item of items) {
    const y = item.transform?.[5] ?? 0;
    const newLine = lastY !== null && Math.abs(y - lastY) > (item.height || 10) * 0.6;
    if (newLine && current.length) {
      lines.push(current.join(''));
      current = [];
    }
    current.push(item.str);
    if (item.hasEOL) {
      lines.push(current.join(''));
      current = [];
      lastY = null;
      continue;
    }
    lastY = y;
  }
  if (current.length) lines.push(current.join(''));
  return lines;
}

export async function importPdf(data: Uint8Array, name: string, bookId: string): Promise<ImportedBook> {
  void bookId;
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;

  const pageCount: number = doc.numPages;
  const pageParagraphs: string[][] = [];
  for (let n = 1; n <= pageCount; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items = (content.items as TextItem[]).filter((i) => typeof i.str === 'string');
    pageParagraphs.push(joinLines(pageLines(items)));
    page.cleanup();
  }

  /* ---------------------------------------------------- chapter splitting */

  interface Split {
    title: string;
    firstPage: number; // 0-based
  }
  const splits: Split[] = [];
  try {
    const outline = await doc.getOutline();
    for (const entry of outline ?? []) {
      const dest = typeof entry.dest === 'string' ? await doc.getDestination(entry.dest) : entry.dest;
      if (!Array.isArray(dest) || !dest[0]) continue;
      const pageIndex: number = await doc.getPageIndex(dest[0]);
      splits.push({ title: collapse(entry.title ?? '') || `第 ${pageIndex + 1} 页`, firstPage: pageIndex });
    }
  } catch {
    /* outline is optional */
  }
  splits.sort((a, b) => a.firstPage - b.firstPage);
  const deduped = splits.filter((s, i) => i === 0 || s.firstPage > splits[i - 1].firstPage);

  const ranges: { id: string; title: string; from: number; to: number }[] = [];
  if (deduped.length >= 2) {
    deduped.forEach((s, i) => {
      const to = i + 1 < deduped.length ? deduped[i + 1].firstPage : pageCount;
      if (to > s.firstPage) {
        ranges.push({ id: `ch${ranges.length + 1}`, title: s.title, from: s.firstPage, to });
      }
    });
    if (deduped[0].firstPage > 0) {
      ranges.unshift({ id: 'ch0', title: '前言', from: 0, to: deduped[0].firstPage });
    }
  } else {
    const CHUNK = 20;
    for (let from = 0; from < pageCount; from += CHUNK) {
      const to = Math.min(pageCount, from + CHUNK);
      ranges.push({
        id: `p${from + 1}-${to}`,
        title: `第 ${from + 1}–${to} 页`,
        from,
        to,
      });
    }
  }

  const chapters: ImportedBook['chapters'] = [];
  const readingOrder: ChapterRef[] = [];
  const toc: TocItem[] = [];

  for (const range of ranges) {
    const parts: string[] = [`<h2>${escapeText(range.title)}</h2>`];
    for (let p = range.from; p < range.to; p++) {
      const paragraphs = pageParagraphs[p] ?? [];
      paragraphs.forEach((text, i) => {
        const attr = i === 0 ? ` data-page="${p + 1}"` : '';
        parts.push(`<p${attr}>${escapeText(text)}</p>`);
      });
    }
    const fileName = `${range.id}.html`;
    chapters.push({ id: range.id, file: fileName, html: parts.join('\n') });
    readingOrder.push({ id: range.id, href: `chapters/${fileName}`, title: range.title, format: 'html' });
    toc.push({ title: range.title, chapterId: range.id });
  }

  const info = (await doc.getMetadata().catch(() => null))?.info ?? {};
  const manifest: BookManifest = {
    schema: BOOK_SCHEMA,
    id: bookId,
    title: collapse(info.Title || '') || basename(name, extname(name)),
    authors: info.Author ? [collapse(info.Author)] : [],
    language: /[一-鿿]/.test(pageParagraphs.flat().slice(0, 20).join('')) ? 'zh-CN' : 'en-US',
    readingOrder,
    toc,
    meta: { pages: pageCount },
  };

  await doc.destroy();
  return { manifest, chapters, assets: [] };
}
