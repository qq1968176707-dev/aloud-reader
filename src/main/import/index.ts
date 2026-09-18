import fs from 'node:fs';
import path from 'node:path';
import {
  PLAIN_SCHEMA,
  type BookIndexEntry,
  type BookManifest,
  type ImportResult,
  type NotebookOptions,
  type PaperStyle,
  type PlainIndex,
  type SourceType,
} from '@shared/types';
import { MAX_NOTEBOOK_PAGES, appendSheets, buildNotebook } from '@shared/notebook';
import { countWords } from '@shared/text';
import { extractBlocks } from '@shared/import/html';
import {
  SUPPORTED_EXTENSIONS,
  looksImportableName,
  makeBookId,
  parseBook,
  type ImportedBook,
} from '@shared/import/index';
import { setPdfjsLoader } from '@shared/import/pdf';
import { P } from '../paths';
import { getLibrary, readJson, saveLibrary, writeJson } from '../store';

export { SUPPORTED_EXTENSIONS };

/**
 * The Electron host for book importing.
 *
 * Parsing itself lives in `@shared/import` and knows nothing about the filesystem, so
 * this file is only the two ends the desktop app owns: reading the bytes off disk and
 * writing the parsed book into userData. The browser build does the same two things
 * against a File object and OPFS.
 */

// Node resolves pdf.js at run time; the non-literal specifier keeps it out of the bundle.
setPdfjsLoader(() => import('pdfjs-dist/legacy/build/pdf.mjs' as string));

export function looksImportable(file: string): boolean {
  if (SUPPORTED_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase())) return true;
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(68);
    fs.readSync(fd, head, 0, 68, 0);
    fs.closeSync(fd);
    return looksImportableName(file, head);
  } catch {
    return false;
  }
}

export async function importFile(file: string): Promise<ImportResult> {
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch (err) {
    return { ok: false, file, error: err instanceof Error ? err.message : String(err) };
  }

  let parsed;
  try {
    parsed = await parseBook(data, path.basename(file));
  } catch (err) {
    return { ok: false, file, error: err instanceof Error ? err.message : String(err) };
  }

  // The original path is more useful than the bare name for "reveal in folder".
  parsed.book.manifest.source = { ...parsed.book.manifest.source!, originalFile: file };
  try {
    const entry = materialize(parsed.book, parsed.type);
    return { ok: true, file, bookId: parsed.bookId, title: entry.title };
  } catch (err) {
    // Leave no half-written book directory behind.
    fs.rmSync(P.bookDir(parsed.bookId), { recursive: true, force: true });
    return { ok: false, file, error: err instanceof Error ? err.message : String(err) };
  }
}

function materialize(book: ImportedBook, sourceType: SourceType): BookIndexEntry {
  const { manifest, chapters, assets } = book;
  const dir = P.bookDir(manifest.id);
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });

  for (const asset of assets) {
    const target = path.join(dir, asset.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.data);
  }

  const plain: PlainIndex = { schema: PLAIN_SCHEMA, bookId: manifest.id, chapters: [] };
  let totalWords = 0;

  for (const chapter of chapters) {
    fs.writeFileSync(path.join(dir, 'chapters', chapter.file), chapter.html, 'utf8');
    const blocks = extractBlocks(chapter.html);
    const words = blocks.reduce((sum, b) => sum + countWords(b), 0);
    totalWords += words;
    plain.chapters.push({
      id: chapter.id,
      title: manifest.readingOrder.find((c) => c.id === chapter.id)?.title,
      words,
      blocks,
    });
  }

  writeJson(P.manifest(manifest.id), manifest);
  writeJson(P.plain(manifest.id), plain);

  const entry: BookIndexEntry = {
    id: manifest.id,
    title: manifest.title,
    authors: manifest.authors ?? [],
    language: manifest.language ?? 'en-US',
    cover: manifest.cover,
    addedAt: new Date().toISOString(),
    wordCount: totalWords,
    chapterCount: chapters.length,
    progress: 0,
    shelf: 'want',
    sourceType,
  };

  const lib = getLibrary();
  lib.books = lib.books.filter((b) => b.id !== entry.id);
  lib.books.push(entry);
  lib.order = [entry.id, ...lib.order.filter((id) => id !== entry.id)];
  saveLibrary(lib);
  return entry;
}

/** Create an empty notebook and put it on the shelf. */
export function createNotebook(opts: NotebookOptions): ImportResult {
  const bookId = makeBookId(opts.title || 'notebook');
  try {
    const book = buildNotebook(opts, bookId);
    const entry = materialize(book, 'notebook');
    // A notebook is one chapter of N sheets; the shelf should count sheets, not chapters.
    const lib = getLibrary();
    const row = lib.books.find((b) => b.id === bookId);
    if (row) {
      row.chapterCount = Number(book.manifest.meta?.pages) || 1;
      row.paper = opts.paper;
      row.shelf = 'reading';
      saveLibrary(lib);
    }
    return { ok: true, file: entry.title, bookId, title: entry.title };
  } catch (err) {
    fs.rmSync(P.bookDir(bookId), { recursive: true, force: true });
    return { ok: false, file: opts.title, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Append blank sheets to an existing notebook, returning the new page count. */
export function addNotebookPages(bookId: string, count: number): number {
  const manifest = readJson<BookManifest | null>(P.manifest(bookId), null);
  if (!manifest?.meta?.notebook) throw new Error('这本不是笔记本');
  const paper = (manifest.meta.paper as PaperStyle) ?? 'blank';
  const existing = Number(manifest.meta.pages) || 0;
  const add = Math.max(1, Math.min(MAX_NOTEBOOK_PAGES - existing, Math.floor(count) || 1));
  if (add <= 0) return existing;

  const file = path.join(P.bookDir(bookId), 'chapters', 'pages.html');
  const html = appendSheets(fs.readFileSync(file, 'utf8'), paper, existing, add);
  fs.writeFileSync(file, html, 'utf8');

  manifest.meta.pages = existing + add;
  writeJson(P.manifest(bookId), manifest);

  // plain.json must keep one entry per leaf block or every anchor past the old end
  // would point at nothing.
  const plain = readJson<PlainIndex | null>(P.plain(bookId), null);
  if (plain?.chapters[0]) {
    plain.chapters[0].blocks = extractBlocks(html);
    writeJson(P.plain(bookId), plain);
  }

  const lib = getLibrary();
  const entry = lib.books.find((b) => b.id === bookId);
  if (entry) {
    entry.chapterCount = existing + add;
    saveLibrary(lib);
  }
  return existing + add;
}

export function removeBook(bookId: string): void {
  fs.rmSync(P.bookDir(bookId), { recursive: true, force: true });
  fs.rmSync(P.state(bookId), { force: true });
  fs.rmSync(P.annotations(bookId), { force: true });
  const lib = getLibrary();
  lib.books = lib.books.filter((b) => b.id !== bookId);
  lib.order = lib.order.filter((id) => id !== bookId);
  lib.collections.forEach((c) => {
    c.bookIds = c.bookIds.filter((id) => id !== bookId);
  });
  saveLibrary(lib);
}
