import AdmZip from 'adm-zip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ImportedBook, Importer } from './index';

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

export async function importArchive(file: string, bookId: string): Promise<ImportedBook> {
  const zip = new AdmZip(file);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);

  let best: { entry: AdmZip.IZipEntry; rank: number } | null = null;
  for (const entry of entries) {
    // Skip macOS resource forks, which look like real entries but are metadata.
    if (entry.entryName.startsWith('__MACOSX/')) continue;
    const rank = PREFERENCE.indexOf(path.extname(entry.entryName).toLowerCase());
    if (rank < 0) continue;
    if (!best || rank < best.rank) best = { entry, rank };
  }
  if (!best) throw new Error('压缩包里没有可识别的电子书（支持 epub / azw3 / mobi）');

  // The inner importers read from disk (MOBI in particular seeks by byte offset), so the
  // entry is spilled to a temp file rather than handed over as a buffer.
  const ext = path.extname(best.entry.entryName).toLowerCase();
  const temp = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'aloud-zip-')),
    `${crypto.randomBytes(4).toString('hex')}${ext}`,
  );
  try {
    fs.writeFileSync(temp, best.entry.getData());
    const inner: Importer =
      ext === '.epub' ? (await import('./epub')).importEpub : (await import('./mobi')).importMobi;
    const book = await inner(temp, bookId);
    // The archive's own name is usually the tidier one; keep it when the inner file has
    // nothing better to offer.
    if (!book.manifest.title || /^untitled/i.test(book.manifest.title)) {
      book.manifest.title = path.basename(file, path.extname(file));
    }
    return book;
  } finally {
    fs.rmSync(path.dirname(temp), { recursive: true, force: true });
  }
}
