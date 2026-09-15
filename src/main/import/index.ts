import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  BOOK_SCHEMA,
  PLAIN_SCHEMA,
  type BookIndexEntry,
  type BookManifest,
  type ImportResult,
  type PlainIndex,
  type SourceType,
} from '@shared/types';
import { countWords } from '@shared/text';
import { P } from '../paths';
import { getLibrary, saveLibrary, writeJson } from '../store';
import { extractBlocks } from './html';
import { importZipBook } from './zipbook';
import { importEpub } from './epub';
import { importPdf } from './pdf';
import { importMobi } from './mobi';
import { importArchive } from './archive';

export interface ImportedBook {
  manifest: BookManifest;
  chapters: { id: string; file: string; html: string }[];
  assets: { rel: string; data: Buffer }[];
}

export type Importer = (file: string, bookId: string) => Promise<ImportedBook>;

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .toLowerCase();

export function makeBookId(file: string): string {
  const base = slug(path.basename(file, path.extname(file))) || 'book';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

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

type Candidate = { fn: Importer; type: SourceType };

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
function sniff(file: string): Candidate[] {
  let head: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    head = Buffer.alloc(68);
    fs.readSync(fd, head, 0, 68, 0);
    fs.closeSync(fd);
  } catch {
    return [];
  }
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return [IMPORTERS['.pdf']];
  // ZIP local file header: EPUB, this app's package, and plenty of mislabelled books.
  if (head[0] === 0x50 && head[1] === 0x4b) return [IMPORTERS['.epub'], IMPORTERS['.zip'], ARCHIVE];
  // PalmDB stores type+creator at offset 60; MOBI/AZW/AZW3 all sit behind BOOKMOBI.
  const palm = head.subarray(60, 68).toString('latin1');
  if (palm === 'BOOKMOBI' || palm === 'TEXtREAd') return [IMPORTERS['.mobi']];
  return [];
}

export function looksImportable(file: string): boolean {
  const ext = path.extname(file).slice(1).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext) || sniff(file).length > 0;
}

export async function importFile(file: string): Promise<ImportResult> {
  const ext = path.extname(file).toLowerCase();
  const candidates =
    ext === '.zip' || ext === '.aloudbook'
      ? [IMPORTERS[ext], IMPORTERS['.epub'], ARCHIVE]
      : IMPORTERS[ext]
        ? [IMPORTERS[ext]]
        : sniff(file);
  if (!candidates.length) return { ok: false, file, error: `不支持的格式：${ext || '(无扩展名)'}` };

  let lastError = '';
  for (const importer of candidates) {
    const bookId = makeBookId(file);
    try {
      const book = await importer.fn(file, bookId);
      book.manifest.id = bookId;
      book.manifest.schema = BOOK_SCHEMA;
      book.manifest.source = {
        type: importer.type,
        originalFile: file,
        importedAt: new Date().toISOString(),
      };
      const entry = materialize(book, importer.type);
      return { ok: true, file, bookId, title: entry.title };
    } catch (err) {
      // Leave no half-written book directory behind before trying the next candidate.
      fs.rmSync(P.bookDir(bookId), { recursive: true, force: true });
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, file, error: lastError };
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
