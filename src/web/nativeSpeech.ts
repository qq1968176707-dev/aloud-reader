/**
 * Speech on Android, through the system TTS engine.
 *
 * Android's WebView is not Chrome: `window.speechSynthesis` exists there but has no
 * engine behind it — `getVoices()` returns nothing and `speak()` is silent. Since
 * read-aloud is the whole point of this app, the Capacitor shell bridges to Android's
 * native TextToSpeech instead, and `systemEngine.ts` prefers this bridge whenever the
 * host provides one.
 *
 * Word highlighting survives the trip: Android reports `onRangeStart` (API 26+) with
 * the character range it is about to speak, which is exactly what the karaoke
 * highlight needs — the same information Chromium's `boundary` event carries.
 *
 * What does not survive: pausing. Android TTS can only stop. So a pause stops the
 * utterance and a resume speaks the current line again from its start; the reader
 * never loses its place, it just re-reads a line. That is the honest behaviour, and it
 * beats a pause button that silently does nothing.
 */
import type { HostSpeech, HostSpeechRequest, TtsVoice } from '@shared/types';

/** True inside the Capacitor shell (the APK), false in any browser. */
export function isNativeShell(): boolean {
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

export function createNativeSpeech(): HostSpeech {
  // Imported lazily so a browser build never pulls the plugin in at startup.
  const plugin = import('@capacitor-community/text-to-speech').then((m) => m.TextToSpeech);
  let voices: { id: string; index: number; name: string; lang: string }[] = [];
  // Android can only stop, so a pause is "stop and remember to say it again".
  let paused = false;
  let releaseResume: (() => void) | null = null;
  const wakeResume = (): void => {
    releaseResume?.();
    releaseResume = null;
  };

  const listVoices = async (): Promise<TtsVoice[]> => {
    const tts = await plugin;
    const { voices: list } = await tts.getSupportedVoices();
    voices = list.map((v, index) => ({
      id: `${index}:${v.lang}:${v.name}`,
      index,
      name: v.name || v.lang,
      lang: v.lang,
    }));
    return voices.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang,
      engine: 'system' as const,
      wordBoundary: true as const,
    }));
  };

  const speak = async (req: HostSpeechRequest): Promise<void> => {
    const tts = await plugin;
    if (!voices.length) await listVoices();
    const voice = req.voiceId ? voices.find((v) => v.id === req.voiceId) : undefined;

    const range = await tts.addListener('onRangeStart', (info) => {
      req.onBoundary?.(info.start, Math.max(1, info.end - info.start));
    });
    // An abort while paused must not leave the caller waiting forever.
    req.signal.addEventListener('abort', wakeResume, { once: true });

    try {
      for (;;) {
        req.onStart?.();
        await tts.speak({
          text: req.text,
          lang: voice?.lang ?? req.lang,
          rate: req.rate,
          voice: voice?.index,
        });
        // Stopped by pause(): hold the line open and say it again on resume. Anything
        // else — finished, aborted — ends the line.
        if (req.signal.aborted || !paused) break;
        await new Promise<void>((resolve) => {
          releaseResume = resolve;
        });
        if (req.signal.aborted) break;
      }
    } finally {
      req.signal.removeEventListener('abort', wakeResume);
      await range.remove();
    }
  };

  return {
    listVoices,
    speak,
    // Android TTS has no pause: stop now, and speak the line again on resume.
    pause: () => {
      paused = true;
      void plugin.then((tts) => tts.stop());
    },
    resume: () => {
      paused = false;
      wakeResume();
    },
    cancel: () => {
      paused = false;
      wakeResume();
      void plugin.then((tts) => tts.stop());
    },
    wordBoundary: true,
  };
}
