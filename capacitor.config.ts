import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android shell.
 *
 * The APK is the same web build as the iPad PWA (`dist-web/`), wrapped in a WebView, so
 * the reader ships whole: no server, no download on first run, works offline from the
 * first launch.
 *
 * `androidScheme: 'https'` keeps the page on a secure origin (https://localhost), which
 * is what OPFS and the service worker require. When the WebView refuses to register the
 * worker anyway, `src/web/imageFallback.ts` reads book pictures straight out of OPFS.
 */
const config: CapacitorConfig = {
  appId: 'com.aloudreader.app',
  appName: '逐读',
  webDir: 'dist-web',
  android: {
    // The reader paints its own background; a white flash between splash and first
    // paint is more jarring than the paper tone it is about to show.
    backgroundColor: '#f5f4f2',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
