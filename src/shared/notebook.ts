import { BOOK_SCHEMA, type BookManifest, type NotebookOptions, type PaperStyle } from './types';
import type { ImportedBook } from './import/index';

/**
 * Notebooks: books you write rather than read.
 *
 * A notebook is deliberately *not* a new document type. It is an ordinary book whose
 * single chapter holds N empty leaf blocks — one per sheet — so every feature the
 * reader already has applies to it for free: page turns, position memory, the whole
 * handwriting toolset, recordings, statistics.
 *
 * Two decisions worth keeping:
 *
 *  · **One chapter, N sheets** rather than one chapter per sheet. Turning a page then
 *    stays inside a chapter, which is the well-tested path; a chapter boundary would
 *    drag in the snapshot/crossfade machinery on every single page turn.
 *
 *  · **Empty leaf blocks.** Ink anchors to a leaf block and normalises by its width,
 *    so each sheet is a natural anchor — steadier than text, which reflows. The blocks
 *    must be sized by CSS (see `.paper-sheet`), because a zero-height block is skipped
 *    by the ink layer's anchor search.
 */

export const PAPER_LABELS: Record<PaperStyle, string> = {
  blank: '白纸',
  lined: '横线纸',
  grid: '方格纸',
  dotted: '点阵纸',
};

export const DEFAULT_NOTEBOOK_PAGES = 20;
/** Guard rail: a notebook is cheap, but a typo should not create ten thousand sheets. */
export const MAX_NOTEBOOK_PAGES = 500;

/** HTML for one chapter holding `pages` sheets. */
export function sheetsHtml(paper: PaperStyle, from: number, count: number): string {
  const sheets: string[] = [];
  for (let i = 0; i < count; i++) {
    // Deliberately empty. The sheet gets its size from CSS (`height: 100%`), so it
    // needs no placeholder character — and a zero-width space would NOT be removed
    // by trim() (U+200B is not whitespace), leaving every sheet holding an
    // invisible "character" for read-aloud and search to trip over.
    sheets.push(`<p class="paper-sheet" data-paper="${paper}" data-sheet="${from + i}"></p>`);
  }
  return sheets.join('\n');
}

export function buildNotebook(opts: NotebookOptions, bookId: string): ImportedBook {
  const pages = Math.max(1, Math.min(MAX_NOTEBOOK_PAGES, Math.floor(opts.pages) || 1));
  const paper: PaperStyle = opts.paper;
  const title = opts.title.trim() || '未命名笔记本';

  const manifest: BookManifest = {
    schema: BOOK_SCHEMA,
    id: bookId,
    title,
    authors: [],
    language: 'zh-CN',
    readingOrder: [{ id: 'pages', href: 'chapters/pages.html', title, format: 'html' }],
    toc: [{ title, chapterId: 'pages' }],
    // The reader reads `paper` back to draw the ruling and `pages` to append more.
    meta: { notebook: true, paper, pages },
  };

  return {
    manifest,
    chapters: [
      {
        id: 'pages',
        file: 'pages.html',
        // Sheets are top-level on purpose: `.paper-sheet { height: 100% }` resolves
        // against the paginated flow's explicit height, and any wrapper in between
        // would be auto-height, which makes that percentage indeterminate.
        html: sheetsHtml(paper, 1, pages),
      },
    ],
    assets: [],
  };
}

/** Existing chapter HTML plus `count` more sheets, for the "add pages" action. */
export function appendSheets(html: string, paper: PaperStyle, existing: number, count: number): string {
  return `${html}\n${sheetsHtml(paper, existing + 1, count)}`;
}
