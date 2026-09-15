import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml, type HTMLElement as PHTMLElement } from 'node-html-parser';
import { BOOK_SCHEMA, type BookManifest, type ChapterRef, type TocItem } from '@shared/types';
import { collapse, normaliseEol } from '@shared/text';
import { sanitizeChapter } from './html';
import { AssetPool } from './zipbook';
import type { ImportedBook } from './index';

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  trimValues: true,
});

const toArray = <T,>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const textOf = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)['#text'] ?? '');
  }
  return '';
};

function resolveFrom(from: string, rel: string): string {
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const parts = (base ? `${base}/${rel}` : rel).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

const sanitizeId = (raw: string, index: number): string => {
  const id = raw.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return id || `ch${index + 1}`;
};

export async function importEpub(file: string, bookId: string): Promise<ImportedBook> {
  const zip = new AdmZip(file);
  const entries = new Map(
    zip.getEntries().filter((e) => !e.isDirectory).map((e) => [e.entryName.replace(/\\/g, '/'), e]),
  );
  const readBuf = (p: string): Buffer | null => entries.get(p)?.getData() ?? null;
  const readText = (p: string): string | null => {
    const b = readBuf(p);
    return b ? normaliseEol(b.toString('utf8')) : null;
  };

  const containerXml = readText('META-INF/container.xml');
  if (!containerXml) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  const container = xml.parse(containerXml);
  const opfPath: string = toArray(container?.container?.rootfiles?.rootfile)[0]?.['@_full-path'];
  if (!opfPath) throw new Error('不是有效的 EPUB：container.xml 里没有 rootfile');

  const opfText = readText(opfPath);
  if (!opfText) throw new Error(`EPUB 损坏：读不到 ${opfPath}`);
  const opf = xml.parse(opfText)?.package;
  if (!opf) throw new Error('EPUB 损坏：OPF 解析失败');

  const meta = opf.metadata ?? {};
  const title = textOf(toArray(meta.title)[0]) || 'Untitled';
  const authors = toArray(meta.creator).map(textOf).filter(Boolean);
  const language = textOf(toArray(meta.language)[0]) || 'en-US';
  const description = textOf(toArray(meta.description)[0]) || undefined;
  const published = textOf(toArray(meta.date)[0]) || undefined;

  type ManifestItem = { '@_id': string; '@_href': string; '@_media-type'?: string; '@_properties'?: string };
  const items = toArray<ManifestItem>(opf.manifest?.item);
  const byId = new Map(items.map((i) => [i['@_id'], i]));

  const spine = toArray<{ '@_idref': string; '@_linear'?: string }>(opf.spine?.itemref).filter(
    (r) => r['@_linear'] !== 'no',
  );
  if (!spine.length) throw new Error('EPUB 没有可读的 spine');

  // chapter id <- spine item id; keep a href -> id map for TOC and internal links.
  const docs: { id: string; path: string }[] = [];
  const usedIds = new Set<string>();
  const hrefToId = new Map<string, string>();
  spine.forEach((ref, i) => {
    const item = byId.get(ref['@_idref']);
    if (!item) return;
    let id = sanitizeId(item['@_id'] ?? '', i);
    while (usedIds.has(id)) id = `${id}-${i}`;
    usedIds.add(id);
    const docPath = resolveFrom(opfPath, decodeURI(item['@_href']));
    docs.push({ id, path: docPath });
    hrefToId.set(docPath, id);
  });

  /* ---------------------------------------------------------------- toc */

  const navItem = items.find((i) => (i['@_properties'] ?? '').split(/\s+/).includes('nav'));
  let toc: TocItem[] = [];

  if (navItem) {
    const navPath = resolveFrom(opfPath, decodeURI(navItem['@_href']));
    const navHtml = readText(navPath);
    if (navHtml) {
      const root = parseHtml(navHtml, { comment: false });
      const navs = root.querySelectorAll('nav');
      const tocNav =
        navs.find((n) => (n.getAttribute('epub:type') ?? '').includes('toc')) ?? navs[0] ?? null;
      const walkOl = (ol: PHTMLElement | null): TocItem[] => {
        if (!ol) return [];
        const out: TocItem[] = [];
        for (const node of ol.childNodes) {
          if (node.nodeType !== 1) continue;
          const li = node as PHTMLElement;
          if ((li.rawTagName || '').toLowerCase() !== 'li') continue;
          const a = li.querySelector('a');
          const href = a?.getAttribute('href');
          const label = collapse(a?.text ?? '');
          const chapterId = href ? hrefToId.get(resolveFrom(navPath, decodeURI(href.split('#')[0]))) : undefined;
          const children = walkOl(li.querySelector('ol'));
          if (chapterId) {
            out.push({ title: label || chapterId, chapterId, children: children.length ? children : undefined });
          } else {
            out.push(...children);
          }
        }
        return out;
      };
      toc = walkOl(tocNav ? tocNav.querySelector('ol') : null);
    }
  }

  if (!toc.length) {
    const ncxId = opf.spine?.['@_toc'];
    const ncxItem = ncxId ? byId.get(ncxId) : items.find((i) => (i['@_media-type'] ?? '').includes('ncx'));
    if (ncxItem) {
      const ncxPath = resolveFrom(opfPath, decodeURI(ncxItem['@_href']));
      const ncxText = readText(ncxPath);
      if (ncxText) {
        const ncx = xml.parse(ncxText)?.ncx;
        type NavPoint = { navLabel?: { text?: unknown }; content?: { '@_src'?: string }; navPoint?: NavPoint | NavPoint[] };
        const walkNav = (points: NavPoint[]): TocItem[] => {
          const out: TocItem[] = [];
          for (const p of points) {
            const src = p.content?.['@_src'];
            const chapterId = src ? hrefToId.get(resolveFrom(ncxPath, decodeURI(src.split('#')[0]))) : undefined;
            const children = walkNav(toArray(p.navPoint));
            const label = collapse(textOf(p.navLabel?.text));
            if (chapterId) out.push({ title: label || chapterId, chapterId, children: children.length ? children : undefined });
            else out.push(...children);
          }
          return out;
        };
        toc = walkNav(toArray(ncx?.navMap?.navPoint));
      }
    }
  }

  const tocTitles = new Map<string, string>();
  const collectTitles = (list: TocItem[]): void => {
    list.forEach((t) => {
      if (!tocTitles.has(t.chapterId)) tocTitles.set(t.chapterId, t.title);
      if (t.children) collectTitles(t.children);
    });
  };
  collectTitles(toc);

  /* ----------------------------------------------------------- chapters */

  const pool = new AssetPool();
  const chapters: ImportedBook['chapters'] = [];
  const readingOrder: ChapterRef[] = [];

  docs.forEach((doc, i) => {
    const source = readText(doc.path);
    if (source == null) return;
    const html = sanitizeChapter(source, {
      bookId,
      resolveImage: (src) => {
        if (/^(https?|data):/i.test(src)) return null;
        const p = resolveFrom(doc.path, decodeURI(src));
        const data = readBuf(p);
        return data ? pool.add(p, data) : null;
      },
      resolveLink: (href) => {
        if (/^(https?|mailto):/i.test(href) || href.startsWith('#')) return null;
        return hrefToId.get(resolveFrom(doc.path, decodeURI(href.split('#')[0]))) ?? null;
      },
    });

    let chapterTitle = tocTitles.get(doc.id);
    if (!chapterTitle) {
      const h = parseHtml(html, { comment: false }).querySelector('h1,h2,h3');
      chapterTitle = h ? collapse(h.text).slice(0, 80) : `第 ${i + 1} 节`;
    }
    const fileName = `${doc.id}.html`;
    chapters.push({ id: doc.id, file: fileName, html });
    readingOrder.push({ id: doc.id, href: `chapters/${fileName}`, title: chapterTitle, format: 'html' });
  });

  if (!chapters.length) throw new Error('EPUB 里没有解析出任何章节');

  /* -------------------------------------------------------------- cover */

  let cover: string | undefined;
  const coverProp = items.find((i) => (i['@_properties'] ?? '').split(/\s+/).includes('cover-image'));
  const coverMetaId = toArray<{ '@_name'?: string; '@_content'?: string }>(meta.meta).find(
    (m) => m['@_name'] === 'cover',
  )?.['@_content'];
  const coverItem = coverProp ?? (coverMetaId ? byId.get(coverMetaId) : undefined);
  if (coverItem) {
    const p = resolveFrom(opfPath, decodeURI(coverItem['@_href']));
    const data = readBuf(p);
    if (data) cover = pool.add(p, data);
  }

  const manifest: BookManifest = {
    schema: BOOK_SCHEMA,
    id: bookId,
    title,
    authors,
    language,
    description,
    published,
    cover,
    readingOrder,
    toc: toc.length ? toc : undefined,
  };

  return { manifest, chapters, assets: pool.assets };
}
