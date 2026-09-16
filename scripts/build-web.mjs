/**
 * Production build for the iPad PWA.
 *
 *   node scripts/build-web.mjs        -> dist-web/
 *
 * Four steps:
 *   1. Vite builds the shared renderer against the browser host  -> dist-web/
 *   2. PWA icons are rasterised from the same build/icon.html the desktop icons use
 *   3. manifest.webmanifest is written
 *   4. The service worker is bundled with the *real* hashed asset list baked in, so an
 *      install precaches exactly what this build produced and never a stale mix.
 */
import esbuild from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';

const OUT = path.resolve('dist-web');

/** Mount point, same normalisation as vite.web.config.ts. '/' unless ALOUD_WEB_BASE. */
const BASE = `/${(process.env.ALOUD_WEB_BASE ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

/* ------------------------------------------------------------ 1. renderer */

rmSync(OUT, { recursive: true, force: true });
await viteBuild({ configFile: 'vite.web.config.ts', mode: 'production' });

// Vite nests the output under the html file's directory when the input is not at the
// root of `root`; normalise so index-web.html lands as dist-web/index.html.
const nestedHtml = path.join(OUT, 'index-web.html');
if (existsSync(nestedHtml)) {
  const { renameSync } = await import('node:fs');
  renameSync(nestedHtml, path.join(OUT, 'index.html'));
}

/* --------------------------------------------------------------- 2. icons */

const ICON_SIZES = [180, 192, 512];
const PWA_ICONS = path.resolve('build/pwa');
const havePrebuilt = ICON_SIZES.every((s) => existsSync(path.join(PWA_ICONS, `icon-${s}.png`)));

if (havePrebuilt) {
  // The committed icons (see scripts/make-icon.mjs) keep Electron — 100MB of binary —
  // out of the web build and out of CI.
  const { copyFileSync } = await import('node:fs');
  for (const size of ICON_SIZES) {
    copyFileSync(path.join(PWA_ICONS, `icon-${size}.png`), path.join(OUT, `icon-${size}.png`));
  }
  console.log(`copied PWA icons from build/pwa/`);
} else {
  await new Promise((resolve, reject) => {
    const iconHtml = path.resolve('build/icon.html');
    if (!existsSync(iconHtml)) {
      console.warn('build/icon.html missing — skipping PWA icons');
      resolve();
      return;
    }
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'aloud-web-icon-'));
    const mainFile = path.join(tmp, 'main.cjs');
    // loadFile() hands Chromium a half-converted Windows path, and this project lives
    // under a Chinese directory name — the load fails with ERR_FAILED. pathToFileURL
    // percent-encodes it correctly, so the URL form is the one that works on both
    // platforms.
    const iconUrl = pathToFileURL(iconHtml).href;
    writeFileSync(
      mainFile,
      `const { app, BrowserWindow } = require('electron');
       const fs = require('node:fs');
       const sizes = ${JSON.stringify(ICON_SIZES)};
       // Destroying the window at the end of an iteration leaves zero windows open, and
       // Electron's default behaviour is to quit right there — which silently produced
       // only the first icon and still exited 0. Hold the app open until the loop ends.
       app.on('window-all-closed', () => {});
       app.whenReady().then(async () => {
         for (const size of sizes) {
           const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false });
           await win.loadURL(${JSON.stringify(iconUrl)});
           await new Promise((r) => setTimeout(r, 300));
           const image = await win.webContents.capturePage();
           fs.writeFileSync(require('node:path').join(${JSON.stringify(OUT)}, 'icon-' + size + '.png'), image.toPNG());
           win.destroy();
         }
         app.exit(0);
       }).catch((err) => { console.error('icon render failed:', err); app.exit(3); });`,
    );
    const child = spawn(electronPath, [mainFile], { stdio: 'inherit' });
    child.on('exit', (code) => {
      rmSync(tmp, { recursive: true, force: true });
      if (code) {
        reject(new Error(`icon render failed (${code})`));
        return;
      }
      // A zero exit is not proof: verify every icon the manifest promises really exists.
      const missing = ICON_SIZES.filter((s) => !existsSync(path.join(OUT, `icon-${s}.png`)));
      if (missing.length) {
        reject(new Error(`icon render produced no file for: ${missing.join(', ')}`));
        return;
      }
      console.log(`wrote PWA icons: ${ICON_SIZES.map((s) => `icon-${s}.png`).join(', ')}`);
      resolve();
    });
  });
}

/* ------------------------------------------------------------ 3. manifest */

writeFileSync(
  path.join(OUT, 'manifest.webmanifest'),
  `${JSON.stringify(
    {
      name: '逐读 Aloud Reader',
      short_name: '逐读',
      description: '逐行朗读的本地电子书阅读器',
      start_url: BASE,
      scope: BASE,
      display: 'standalone',
      orientation: 'any',
      background_color: '#fbfbfd',
      theme_color: '#fbfbfd',
      lang: 'zh-CN',
      icons: [
        { src: `${BASE}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `${BASE}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `${BASE}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  )}\n`,
  'utf8',
);

/* ------------------------------------------------------ 4. service worker */

/** Every file the shell needs, as root-relative URLs. */
const shell = [BASE, `${BASE}index.html`, `${BASE}manifest.webmanifest`, ...ICON_SIZES.map((s) => `${BASE}icon-${s}.png`)];
const assetsDir = path.join(OUT, 'assets');
if (existsSync(assetsDir)) {
  for (const name of readdirSync(assetsDir)) {
    // Source maps are for debugging, not for the offline shell — they would double the
    // precache for no user-visible benefit.
    if (name.endsWith('.map')) continue;
    if (statSync(path.join(assetsDir, name)).isFile()) shell.push(`${BASE}assets/${name}`);
  }
}

const cacheName = `aloud-${Date.now().toString(36)}`;
await esbuild.build({
  entryPoints: ['src/web/sw.ts'],
  outfile: path.join(OUT, 'sw.js'),
  bundle: true,
  format: 'iife',
  target: 'safari17',
  minify: true,
  define: {
    __SHELL__: JSON.stringify(shell),
    __CACHE__: JSON.stringify(cacheName),
    __BASE__: JSON.stringify(BASE),
  },
});

const bytes = readdirSync(OUT, { recursive: true })
  .map((f) => path.join(OUT, String(f)))
  .filter((f) => statSync(f).isFile())
  .reduce((sum, f) => sum + statSync(f).size, 0);

console.log(`\nWeb build complete -> dist-web/  (${shell.length} shell files, ${(bytes / 1048576).toFixed(1)} MB)`);
console.log(`挂载路径：${BASE}（改用子目录：ALOUD_WEB_BASE=/aloud-reader/ npm run build:web）`);
console.log('部署：把 dist-web/ 整个目录放到任意 HTTPS 静态站点，iPad 用 Safari 打开后「添加到主屏幕」。');
