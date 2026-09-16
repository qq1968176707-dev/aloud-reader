import { BOOK_SCHEMA, type BookManifest, type SourceType } from '@shared/types';
import { basename, extname } from './pathlite';
import { importZipBook } from './zipbook';
import { importEpub } from './epub';
import { importPdf } from './pdf';
import { importMobi } from './mobi';
import { importArchive } from './archive';

/**
 * Book parsing, with no runtime of its own.
 *
 * Everything here takes bytes and returns plain data, so the identical code path runs
 * in the Electron main process (which then writes to disk) and in the browser build
 * for iPad (which writes to OPFS). The hosts differ only in where the bytes come from
 * and where the result is stored — see `materialize` in each host.
 */

export interface ImportedBook {
  manifest: BookManifest;
  chapters: { id: string; file: string; html: string }[];
  assets: { rel: string; data: Uint8Array }[];
}

/** `name` is the original file name, used only for title and id fallbacks. */
export type Importer = (data: Uint8Array, name: string, bookId: string) => Promise<ImportedBook>;

const IMPORTERS: Record<string, { fn: Importer; type: SourceType }> = {
  '.zip': { fn: importZipBook, type: 'zip' },
  '.aloudbook': { fn: importZipBook, type: 'zip' },
  '.epub': { fn: importEpub, type: 'epub' },
  '.pdf': { fn: importPdf, type: 'pdf' },
  '.mobi': { fn: importMobi, type: 'mobi' },
  '.prc': { fn: importMobi, type: 'mobi' },
  '.azw': { fn: importMobi, type: 'mobi' },
  '.azw3': { fn: importMobi, type: 'mobi' },
};

export const SUPPORTED_EXTENSIONS = Object.keys(IMPORTERS).map((e) => e.slice(1));

/** Last resort for a zip: a plain archive with book files inside it. */
const ARCHIVE: { fn: Importer; type: SourceType } = { fn: importArchive, type: 'epub' };

export type Candidate = { fn: Importer; type: SourceType };

const latin1 = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, to));

/**
 * Decide the format from the file's own bytes.
 *
 * Extensions lie: browsers leave half-renamed downloads behind (`book.mobi.crswap`),
 * and book sites hand out `.zip` files that are really EPUBs. Every format here is
 * identifiable from its header, so the header is what we trust — the extension is only
 * a fast path.
 *
 * A ZIP could be either an EPUB or this app's own package, and telling them apart needs
 * the central directory rather than the first bytes, so both are returned and tried in
 * turn.
 */
export function sniffBytes(head: Uint8Array): Candidate[] {
  if (head.length < 4) return [];
  if (latin1(head, 0, 4) === '%PDF') return [IMPORTERS['.pdf']];
  // ZIP local file header: EPUB, this app's package, and plenty of mislabelled books.
  if (head[0] === 0x50 && head[1] === 0x4b) return [IMPORTERS['.epub'], IMPORTERS['.zip'], ARCHIVE];
  // PalmDB stores type+creator at offset 60; MOBI/AZW/AZW3 all sit behind BOOKMOBI.
  if (head.length >= 68) {
    const palm = latin1(head, 60, 68);
    if (palm === 'BOOKMOBI' || palm === 'TEXtREAd') return [IMPORTERS['.mobi']];
  }
  return [];
}

/** Candidates to try for a file, extension first and bytes as the tiebreaker. */
export function candidatesFor(name: string, head: Uint8Array): Candidate[] {
  const ext = extname(name).toLowerCase();
  if (ext === '.zip' || ext === '.aloudbook') return [IMPORTERS[ext], IMPORTERS['.epub'], ARCHIVE];
  if (IMPORTERS[ext]) return [IMPORTERS[ext]];
  return sniffBytes(head);
}

export function looksImportableName(name: string, head?: Uint8Array): boolean {
  const ext = extname(name).slice(1).toLowerCase();
  if (SUPPORTED_EXTENSIONS.includes(ext)) return true;
  return head ? sniffBytes(head).length > 0 : false;
}

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .toLowerCase();

const randomHex = (bytes: number): string => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export function makeBookId(name: string): string {
  const base = slug(basename(name, extname(name))) || 'book';
  return `${base}-${randomHex(3)}`;
}

export interface ParsedBook {
  book: ImportedBook;
  type: SourceType;
  bookId: string;
}

/**
 * Parse `data` into a book, trying every candidate format in turn.
 *
 * Throws with the last parser's message when none of them can read it — the caller
 * decides how to report that, since the two hosts surface errors differently.
 */
export async function parseBook(data: Uint8Array, name: string): Promise<ParsedBook> {
  const candidates = candidatesFor(name, data.subarray(0, 68));
  if (!candidates.length) {
    throw new Error(`不支持的格式：${extname(name) || '(无扩展名)'}`);
  }
  let lastError = '';
  for (const candidate of candidates) {
    const bookId = makeBookId(name);
    try {
      const book = await candidate.fn(data, name, bookId);
      book.manifest.id = bookId;
      book.manifest.schema = BOOK_SCHEMA;
      book.manifest.source = {
        type: candidate.type,
        originalFile: name,
        importedAt: new Date().toISOString(),
      };
      return { book, type: candidate.type, bookId };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastError || '无法解析这个文件');
}
