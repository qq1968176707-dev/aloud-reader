import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Mount point. '/' locally; GitHub Pages project sites need '/<repo>/'. */
const rawBase = process.env.ALOUD_WEB_BASE ?? '/';
const base = `/${rawBase.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

/**
 * Browser build (the iPad PWA).
 *
 * Differences from the Electron renderer build:
 *   · entry is `index-web.html`, which boots `src/web/main-web.tsx` and installs the
 *     OPFS-backed `window.aloud` before React mounts;
 *   · `base` comes from ALOUD_WEB_BASE (default '/') — a PWA is served from a real
 *     origin, and possibly from a subdirectory of one;
 *   · Node's Buffer is polyfilled, because the MOBI decoder is written against it;
 *   · the target is Safari 17, the oldest iPadOS with both OPFS write access and the
 *     CSS Custom Highlight API that read-aloud depends on.
 */
export default defineConfig({
  define: {
    __ALOUD_EDITION__: JSON.stringify('lite'),
    __BASE__: JSON.stringify(base),
    // Some CJS dependencies test for it.
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    global: 'globalThis',
  },
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@': r('./src/renderer'),
      // The MOBI parser's HUFF/CDIC decoder does 64-bit window arithmetic against
      // Buffer. Polyfilling is deliberate: rewriting that decoder for Uint8Array would
      // risk the format handling that took the longest to get right.
      buffer: 'buffer/',
    },
  },
  optimizeDeps: { include: ['buffer'] },
  server: { port: 5200, strictPort: true, host: true },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    target: 'safari17',
    sourcemap: true,
    rollupOptions: { input: r('./index-web.html') },
  },
});
