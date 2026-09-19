/**
 * Where the PWA is mounted: '/' on its own origin, '/aloud-reader/' on GitHub Pages.
 *
 * Injected at build time by both pipelines (Vite for the app, esbuild for the service
 * worker) from ALOUD_WEB_BASE, so the app, the SW scope, the manifest and the asset
 * routes cannot disagree.
 */
declare const __BASE__: string;

/** package.json's version, injected by vite.web.config.ts — what the updater compares against. */
declare const __APP_VERSION__: string;
