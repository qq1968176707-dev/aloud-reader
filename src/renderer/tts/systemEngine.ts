/**
 * Offline engine: the Web Speech API, which on Windows is backed by SAPI5 voices.
 *
 * This is the default because it needs no network, no account and no per-character
 * quota, and because Chromium's Windows implementation *does* emit `boundary` events
 * for local voices, which is what makes karaoke word highlighting possible offline.
 *
 * Reality check on Chinese: Windows ships zh-CN Huihui for SAPI5. The much better
 * Windows 11 "natural" voices (Xiaoxiao / Yunxi) are WinRT-only and are not visible
 * here — that is exactly the gap the optional Edge backend fills.
 */
import type { TtsVoice } from '@shared/types';
import { AbortedError, type SpeakRequest, type TtsEngine } from './engine';

const boundaryCapability = new Map<string, boolean>();

/**
 * The SAPI voice list is populated lazily and `voiceschanged` does not always fire on
 * Windows — measured on a clean boot it took up to ~2s. So: listen *and* poll, and give
 * it a generous budget. Resolving with an empty list is still valid (speak() then uses
 * the platform default voice).
 */
function nativeVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const now = speechSynthesis.getVoices();
    if (now.length) return resolve(now);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      speechSynthesis.removeEventListener('voiceschanged', onChanged);
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(speechSynthesis.getVoices());
    };
    const onChanged = () => finish();

    speechSynthesis.addEventListener('voiceschanged', onChanged);
    const poll = setInterval(() => {
      if (speechSynthesis.getVoices().length) finish();
    }, 200);
    const deadline = setTimeout(finish, 5000);
  });
}

export class SystemEngine implements TtsEngine {
  readonly id = 'system' as const;
  /** Chromium drops utterances that get garbage-collected mid-speech. */
  private held: SpeechSynthesisUtterance | null = null;

  async listVoices(): Promise<TtsVoice[]> {
    const voices = await nativeVoices();
    return voices.map((v) => ({
      id: v.voiceURI,
      name: v.name.replace(/^Microsoft\s+/, ''),
      lang: v.lang,
      engine: 'system' as const,
      wordBoundary: boundaryCapability.get(v.voiceURI) ?? 'unknown',
    }));
  }

  wordBoundarySupport(voiceId?: string): boolean | 'unknown' {
    if (!voiceId) return 'unknown';
    return boundaryCapability.get(voiceId) ?? 'unknown';
  }

  async speak(req: SpeakRequest): Promise<void> {
    if (req.signal.aborted) throw new AbortedError();
    const voices = await nativeVoices();
    const voice = req.voiceId ? voices.find((v) => v.voiceURI === req.voiceId) : undefined;

    // cancel() immediately followed by speak() is unreliable on Windows; let it settle.
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      await new Promise((r) => setTimeout(r, 60));
    }

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(req.text);
      this.held = utterance;
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? req.lang;
      utterance.rate = Math.max(0.1, Math.min(10, req.rate));
      utterance.volume = 1;

      let finished = false;
      let sawBoundary = false;

      const cleanup = () => {
        req.signal.removeEventListener('abort', onAbort);
        clearInterval(keepAlive);
        if (this.held === utterance) this.held = null;
      };

      const onAbort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        speechSynthesis.cancel();
        reject(new AbortedError());
      };

      // Chromium can silently stall a long queue; a periodic resume() is the standard nudge.
      const keepAlive = setInterval(() => {
        if (!speechSynthesis.paused && speechSynthesis.speaking) speechSynthesis.resume();
      }, 9000);

      utterance.onstart = () => {
        req.onStart?.();
      };
      utterance.onboundary = (event) => {
        if (event.name && event.name !== 'word') return;
        sawBoundary = true;
        if (req.voiceId) boundaryCapability.set(req.voiceId, true);
        const charIndex = event.charIndex ?? 0;
        const charLength =
          (event as SpeechSynthesisEvent & { charLength?: number }).charLength ||
          wordLengthAt(req.text, charIndex);
        req.onBoundary?.(charIndex, charLength);
      };

      utterance.onend = () => {
        if (finished) return;
        finished = true;
        if (req.voiceId && !sawBoundary && !boundaryCapability.has(req.voiceId)) {
          // Remember that this voice cannot drive word highlighting, so the UI can say so.
          boundaryCapability.set(req.voiceId, false);
        }
        cleanup();
        resolve();
      };

      utterance.onerror = (event) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (event.error === 'interrupted' || event.error === 'canceled') resolve();
        else reject(new Error(`系统语音失败：${event.error}`));
      };

      req.signal.addEventListener('abort', onAbort, { once: true });
      speechSynthesis.speak(utterance);
    });
  }

  pause(): void {
    if (speechSynthesis.speaking) speechSynthesis.pause();
  }

  resume(): void {
    if (speechSynthesis.paused) speechSynthesis.resume();
  }

  cancel(): void {
    speechSynthesis.cancel();
    this.held = null;
  }
}

/** SAPI reports only a start index for some voices; derive the word length ourselves. */
function wordLengthAt(text: string, index: number): number {
  if (index >= text.length) return 0;
  const rest = text.slice(index);
  const match = /^[\p{L}\p{N}'’-]+/u.exec(rest);
  if (match) return match[0].length;
  return 1;
}
