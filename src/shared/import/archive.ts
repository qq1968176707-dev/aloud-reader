import { openZip } from './zip';
import { basename, extname } from './pathlite';
import type { ImportedBook } from './index';

/**
 * A zip that is not a book but *contains* one.
 *
 * Chinese book sites hand out a single archive holding the same title three times —
 * `.epub`, `.azw3` and `.mobi` side by side — and dropping that on the window used to
 * fail with a confusing "no book.json" from the package importer. Pick the entry most
 * likely to survive intact and import that.
 *
 * EPUB first: it is real XHTML with a spine and a manifest, so chapter titles, the table
 * of contents and images all come through. AZW3 next, then MOBI, both of which have to be
 * reconstructed from a flat byte stream.
 */
const PREFERENCE = ['.epub', '.azw3', '.mobi', '.azw', '.prc'];

export async function importArchive(
  data: Uint8Array,
  name: string,
  bookId: string,
): Promise<ImportedBook> {
  const zip = openZip(data);

  let best: { path: string; rank: number } | null = null;
  for (const entryName of zip.names) {
    // Skip macOS resource forks, which look like real entries but are metadata.
    if (entryName.startsWith('__MACOSX/')) continue;
    const rank = PREFERENCE.indexOf(extname(entryName).toLowerCase());
    if (rank < 0) continue;
    if (!best || rank < best.rank) best = { path: entryName, rank };
  }
  if (!best) throw new Error('压缩包里没有可识别的电子书（支持 epub / azw3 / mobi）');

  // The inner importers take bytes, so the entry goes straight across — no temp file,
  // which is what the disk-reading versions used to need.
  const ext = extname(best.path).toLowerCase();
  const inner = ext === '.epub' ? (await import('./epub')).importEpub : (await import('./mobi')).importMobi;
  const book = await inner(zip.read(best.path)!, best.path, bookId);

  // The archive's own name is usually the tidier one; keep it when the inner file has
  // nothing better to offer.
  if (!book.manifest.title || /^untitled/i.test(book.manifest.title)) {
    book.manifest.title = basename(name, extname(name));
  }
  return book;
}
