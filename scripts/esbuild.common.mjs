import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** Runtime deps stay external and are loaded from node_modules / asar at runtime. */
export const externals = ['electron', ...Object.keys(pkg.dependencies ?? {})];

/** ESM main process (Electron >= 28). Needed so we can `await import('pdfjs-dist/...')`. */
export const mainOptions = (dev) => ({
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist-electron/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: externals,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    // Edition is compile-time so the lite build does not even contain the clone paths.
    'process.env.ALOUD_EDITION': JSON.stringify(process.env.ALOUD_EDITION === 'lite' ? 'lite' : 'pro'),
  },
  logLevel: 'info',
});

/** Preload must stay CJS because the renderer runs with `sandbox: true`. */
export const preloadOptions = (dev) => ({
  entryPoints: ['src/main/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
});
