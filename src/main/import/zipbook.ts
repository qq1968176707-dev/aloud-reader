import AdmZip from 'adm-zip';
import path from 'node:path';
import { marked } from 'marked';
import { BOOK_SCHEMA, type BookManifest, type ChapterRef, type TocItem } from '@shared/types';
import { normaliseEol } from '@shared/text';
import { sanitizeChapter } from './html';
import type { ImportedBook } from './index';

/** posix-style resolve inside the package (zip entries always use "/"). */
function resolvePkg(from: string, rel: string): string {
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const parts = (base ? `${base}/${rel}` : rel).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Copies referenced binaries into the book directory under unique names. */
export class AssetPool {
  private readonly map = new Map<string, string>();
  private readonly used = new Set<string>();
  readonly assets: { rel: string; data: Buffer }[] = [];

  add(pkgPath: string, data: Buffer, folder = 'images'): string {
    const existing = this.map.get(pkgPath);
    if (existing) return existing;
    const base = path.posix.basename(pkgPath).replace(/[^\w.-]+/g, '_') || 'asset';
    let name = base;
    let n = 1;
    while (this.used.has(name)) {
      const ext = path.posix.extname(base);
      name = `${path.posix.basename(base, ext)}-${n++}${ext}`;
    }
    this.used.add(name);
    const rel = `${folder}/${name}`;
    this.map.set(pkgPath, rel);
    this.assets.push({ rel, data });
    return rel;
  }
}

function validate(manifest: BookManifest): void {
  if (!manifest || typeof manifest !== 'object') throw new Error('book.json 不是一个对象');
  if (manifest.schema !== BOOK_SCHEMA) {
    throw new Error(`book.json 的 schema 必须是 "${BOOK_SCHEMA}"，实际是 "${manifest.schema}"`);
  }
  if (!manifest.title?.trim()) throw new Error('book.json 缺少 title');
  if (!Array.isArray(manifest.readingOrder) || manifest.readingOrder.length === 0) {
    throw new Error('book.json 的 readingOrder 必须至少包含一章');
  }
  const seen = new Set<string>();
  manifest.readingOrder.forEach((c, i) => {
    if (!c.id || !/^[\w.-]{1,64}$/.test(c.id)) throw new Error(`readingOrder[${i}].id 非法：${c.id}`);
    if (seen.has(c.id)) throw new Error(`readingOrder 中章节 id 重复：${c.id}`);
    seen.add(c.id);
    if (!c.href) throw new Error(`readingOrder[${i}] 缺少 href`);
  });
  const ids = seen;
  const walk = (items?: TocItem[]): void => {
    items?.forEach((t) => {
      if (!ids.has(t.chapterId)) throw new Error(`toc 指向了不存在的章节：${t.chapterId}`);
      walk(t.children);
    });
  };
  walk(manifest.toc);
}

export async function importZipBook(file: string, bookId: string): Promise<ImportedBook> {
  const zip = new AdmZip(file);
  const entries = new Map(zip.getEntries().filter((e) => !e.isDirectory).map((e) => [e.entryName.replace(/\\/g, '/'), e]));

  // book.json may sit at the root or one folder down (as produced by "zip the folder").
  const manifestKey = [...entries.keys()].find((k) => k === 'book.json' || k.endsWith('/book.json'));
  if (!manifestKey) throw new Error('压缩包里没有找到 book.json');
  const prefix = manifestKey.slice(0, manifestKey.length - 'book.json'.length);
  const read = (pkgPath: string): Buffer | null => entries.get(prefix + pkgPath)?.getData() ?? null;

  const manifest = JSON.parse(zip.readAsText(entries.get(manifestKey)!)) as BookManifest;
  validate(manifest);

  const pool = new AssetPool();
  const chapters: ImportedBook['chapters'] = [];
  const readingOrder: ChapterRef[] = [];

  for (const ref of manifest.readingOrder) {
    const raw = read(ref.href);
    if (!raw) throw new Error(`readingOrder 指向的文件不存在：${ref.href}`);
    const text = normaliseEol(raw.toString('utf8'));
    const isMarkdown = (ref.format ?? (/\.(md|markdown)$/i.test(ref.href) ? 'markdown' : 'html')) === 'markdown';
    const html = isMarkdown ? (marked.parse(text, { async: false }) as string) : text;

    const clean = sanitizeChapter(html, {
      bookId,
      resolveImage: (src) => {
        if (/^(https?|data):/i.test(src)) return null; // no remote loads, ever
        const pkgPath = resolvePkg(ref.href, decodeURI(src));
        const data = read(pkgPath);
        return data ? pool.add(pkgPath, data) : null;
      },
      resolveLink: (href) => {
        if (href.startsWith('#')) return null;
        const target = resolvePkg(ref.href, href.split('#')[0]);
        return manifest.readingOrder.find((c) => resolvePkg('', c.href) === target)?.id ?? null;
      },
    });

    const fileName = `${ref.id}.html`;
    chapters.push({ id: ref.id, file: fileName, html: clean });
    readingOrder.push({ id: ref.id, href: `chapters/${fileName}`, title: ref.title, format: 'html' });
  }

  let cover = manifest.cover;
  if (cover) {
    const data = read(cover);
    cover = data ? pool.add(cover, data) : undefined;
  }

  return {
    manifest: {
      ...manifest,
      id: bookId,
      schema: BOOK_SCHEMA,
      authors: manifest.authors ?? [],
      language: manifest.language ?? 'en-US',
      cover,
      readingOrder,
    },
    chapters,
    assets: pool.assets,
  };
}
