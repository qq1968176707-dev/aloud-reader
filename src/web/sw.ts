/// <reference lib="webworker" />

/**
 * Service worker for the iPad build.
 *
 * Two jobs:
 *
 *  1. Offline. The app shell is precached on install, so the reader opens on a plane
 *     exactly like a native app. Books were never on the network to begin with — they
 *     live in OPFS — so once the shell is cached the whole app works offline.
 *
 *  2. Book images. Chapter HTML references `/bookasset/<bookId>/<path>`, which exists
 *     nowhere on the server; this worker answers those requests from OPFS. Going
 *     through a URL rather than blob: means <img> tags in sanitized chapter HTML need
 *     no rewriting at render time and nothing has to be revoked.
 */

// The empty export makes this a module, so the `self` declaration below shadows the
// lib's `WorkerGlobalScope` one instead of colliding with it.
export {};

declare const self: ServiceWorkerGlobalScope;

// Injected at build time (see scripts/build-web.mjs) — the hashed asset list plus a
// cache name that changes with every build, so an update never serves a mixed shell.
declare const __SHELL__: string[];
declare const __CACHE__: string;

const ASSET_BASE = '/bookasset/';
const INK_BASE = '/inkasset/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(__CACHE__)
      .then((cache) => cache.addAll(__SHELL__))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== __CACHE__).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

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

/** Read one file out of OPFS by its slash-separated path. */
async function opfsFile(path: string): Promise<File | null> {
  try {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) return null;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

/** `/bookasset/<bookId>/<rel...>` -> `books/...`, `/inkasset/<bookId>/<file>` -> `ink/...`. */
async function serveAsset(url: URL, base: string, dir: string): Promise<Response> {
  const rel = decodeURIComponent(url.pathname.slice(base.length));
  if (!rel || rel.includes('..')) return new Response('Forbidden', { status: 403 });
  const file = await opfsFile(`${dir}/${rel}`);
  if (!file) return new Response('Not found', { status: 404 });
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
  return new Response(file, {
    status: 200,
    headers: {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith(ASSET_BASE)) {
    event.respondWith(serveAsset(url, ASSET_BASE, 'books'));
    return;
  }

  if (url.pathname.startsWith(INK_BASE)) {
    event.respondWith(serveAsset(url, INK_BASE, 'ink'));
    return;
  }

  if (event.request.mode === 'navigate') {
    // Single-page app: any route resolves to the shell, offline included.
    event.respondWith(
      caches.match('/index.html').then((hit) => hit ?? fetch(event.request)),
    );
    return;
  }

  // Cache-first for the hashed build assets, network for everything else.
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ??
        fetch(event.request).then((res) => {
          if (res.ok && url.pathname.startsWith('/assets/')) {
            const copy = res.clone();
            void caches.open(__CACHE__).then((c) => c.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});
