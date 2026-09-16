import { webApi } from './api';
import { ASSET_BASE } from './assets';
import { requestPersistence } from './storage';

/**
 * Installs the browser host onto `window` — and must run before ANY renderer module
 * is evaluated.
 *
 * `state/store.ts` subscribes to `window.aloud.onImportProgress` at module top level.
 * ES module imports are evaluated before the importing module's own body, so assigning
 * `window.aloud` inside the entry file was already too late: the store threw
 * "Cannot read properties of undefined" while the entry's first line was still
 * pending. Keeping the assignment in its own module, imported first, is what fixes the
 * ordering — the side effect happens during *this* module's evaluation, which the
 * entry sequences ahead of the App import.
 */

declare global {
  interface Window {
    /** Makes `bookAssetUrl` emit service-worker URLs instead of aloud://. */
    __aloudAssetBase?: string;
  }
}

window.__aloudAssetBase = ASSET_BASE;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).aloud = webApi;

document.documentElement.classList.add('web');
// iPadOS reports a coarse pointer; the CSS widens hit targets and disables the
// hover states that would otherwise stick after a tap.
if (matchMedia('(pointer: coarse)').matches) document.documentElement.classList.add('touch');

// Home-screen installs get persistent storage; ask once, ignore a refusal.
void requestPersistence();
