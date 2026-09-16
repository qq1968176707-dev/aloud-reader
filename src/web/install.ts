import { webApi } from './api';
import { ASSET_BASE, INK_BASE } from './assets';
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
    /** Same for `inkImageUrl`. */
    __aloudInkBase?: string;
  }
}

window.__aloudAssetBase = ASSET_BASE;
window.__aloudInkBase = INK_BASE;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).aloud = webApi;

document.documentElement.classList.add('web');
// iPadOS reports a coarse pointer; the CSS widens hit targets and disables the
// hover states that would otherwise stick after a tap.
if (matchMedia('(pointer: coarse)').matches) document.documentElement.classList.add('touch');

// Home-screen installs get persistent storage; ask once, ignore a refusal.
void requestPersistence();

/**
 * Unlock speech on the first touch.
 *
 * iOS only lets `speechSynthesis.speak()` start from inside a user gesture, and our
 * first real call cannot be: the engine awaits the voice list (which on iOS is empty
 * until `voiceschanged`) before speaking, and an await ends the gesture. So spend one
 * silent utterance inside the very first gesture of the session — after that iOS
 * treats speech as allowed and every later, asynchronous call works.
 */
let speechUnlocked = false;
function unlockSpeech(): void {
  if (speechUnlocked || !('speechSynthesis' in window)) return;
  speechUnlocked = true;
  try {
    const warm = new SpeechSynthesisUtterance(' ');
    warm.volume = 0;
    speechSynthesis.speak(warm);
    speechSynthesis.cancel();
  } catch {
    /* a browser that refuses is no worse off than before */
  }
}
for (const type of ['pointerdown', 'touchend', 'keydown']) {
  window.addEventListener(type, unlockSpeech, { once: true, capture: true });
}
