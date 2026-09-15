import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * On-disk layout (Windows: %APPDATA%\Aloud Reader\)
 *
 *   settings.json                 app settings
 *   library.json                  shelves, collections, manual order
 *   dictionary.json               optional user dictionary for double-click lookup
 *   books/<bookId>/book.json      normalised manifest
 *   books/<bookId>/chapters/*.html
 *   books/<bookId>/images/*
 *   books/<bookId>/plain.json     per-chapter leaf-block text (search / word counts)
 *   state/<bookId>.json           reading position + history
 *   annotations/<bookId>.json     highlights, underlines, notes, bookmarks
 *   stats/reading.json            daily seconds, per-book seconds, finished books
 *
 * Every file is pretty-printed JSON — inspectable and editable by hand.
 */
export const dataDir = (): string => app.getPath('userData');

export const P = {
  root: dataDir,
  settings: () => path.join(dataDir(), 'settings.json'),
  library: () => path.join(dataDir(), 'library.json'),
  dictionary: () => path.join(dataDir(), 'dictionary.json'),
  booksDir: () => path.join(dataDir(), 'books'),
  bookDir: (id: string) => path.join(dataDir(), 'books', id),
  manifest: (id: string) => path.join(dataDir(), 'books', id, 'book.json'),
  plain: (id: string) => path.join(dataDir(), 'books', id, 'plain.json'),
  chapterFile: (id: string, file: string) => path.join(dataDir(), 'books', id, 'chapters', file),
  state: (id: string) => path.join(dataDir(), 'state', `${id}.json`),
  annotations: (id: string) => path.join(dataDir(), 'annotations', `${id}.json`),
  ink: (id: string) => path.join(dataDir(), 'ink', `${id}.json`),
  /** Pasted/imported pictures for a book's ink layer (sibling of the JSON). */
  inkImagesDir: (id: string) => path.join(dataDir(), 'ink', id),
  stats: () => path.join(dataDir(), 'stats', 'reading.json'),
};

export function ensureDirs(): void {
  for (const dir of [
    dataDir(),
    P.booksDir(),
    path.join(dataDir(), 'state'),
    path.join(dataDir(), 'annotations'),
    path.join(dataDir(), 'ink'),
    path.join(dataDir(), 'stats'),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Reject anything that escapes `base` (protocol handler / importer safety). */
export function resolveInside(base: string, rel: string): string | null {
  const target = path.resolve(base, rel);
  const normBase = path.resolve(base) + path.sep;
  if (target !== path.resolve(base) && !target.startsWith(normBase)) return null;
  return target;
}
