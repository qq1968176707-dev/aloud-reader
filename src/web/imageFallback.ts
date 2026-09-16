/**
 * Serve book and ink pictures without a service worker.
 *
 * Both hosts bake `/bookasset/<id>/…` (and `/inkasset/…`) into the page, and normally
 * the service worker answers those out of OPFS. A service worker is not always there:
 * Android's WebView inside the Capacitor shell may refuse to register one, Safari
 * evicts them, and a first load can paint before the worker has claimed the page. When
 * that happens every illustration in the book is a broken image.
 *
 * So: watch for such `<img>`/`<image>` elements and swap their source for a blob URL
 * read straight from OPFS. Blob URLs are cached per path — a picture that appears on
 * ten pages is read once — and the whole thing is inert while a worker is in control.
 */
import { ASSET_BASE, INK_BASE } from './assets';
import { readBytes } from './storage';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const cache = new Map<string, Promise<string | null>>();

/** `/bookasset/a/b.png` -> OPFS `books/a/b.png`; `/inkasset/…` -> `ink/…`. */
function opfsPath(url: string): string | null {
  const path = url.startsWith(ASSET_BASE)
    ? `books/${url.slice(ASSET_BASE.length)}`
    : url.startsWith(INK_BASE)
      ? `ink/${url.slice(INK_BASE.length)}`
      : null;
  if (!path || path.includes('..')) return null;
  return decodeURIComponent(path);
}

function blobUrl(assetUrl: string): Promise<string | null> {
  const hit = cache.get(assetUrl);
  if (hit) return hit;
  const path = opfsPath(assetUrl);
  const pending = !path
    ? Promise.resolve(null)
    : readBytes(path).then((bytes) => {
        if (!bytes) return null;
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        return URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] ?? 'application/octet-stream' }));
      });
  cache.set(assetUrl, pending);
  return pending;
}

/** The attribute that carries the URL: `src` on <img>, `href` on an SVG <image>. */
const attrOf = (el: Element): 'src' | 'href' => (el.tagName.toLowerCase() === 'image' ? 'href' : 'src');

function isOurs(value: string | null): value is string {
  return !!value && (value.startsWith(ASSET_BASE) || value.startsWith(INK_BASE));
}

function fix(el: Element): void {
  const attr = attrOf(el);
  const value = el.getAttribute(attr);
  if (!isOurs(value)) return;
  void blobUrl(value).then((url) => {
    // Re-check: a page turn may have replaced the element's source in the meantime.
    if (url && el.getAttribute(attr) === value) el.setAttribute(attr, url);
  });
}

const scan = (root: ParentNode): void => {
  for (const el of root.querySelectorAll('img, image')) fix(el);
};

/**
 * Start watching. Safe to call always: it returns immediately when a service worker is
 * already controlling the page, which is the normal case in a browser.
 */
export function installImageFallback(): void {
  if (navigator.serviceWorker?.controller) return;

  scan(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element) {
        fix(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        fix(node);
        scan(node);
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href'],
  });
}
