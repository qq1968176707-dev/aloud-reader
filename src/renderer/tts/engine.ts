import type { TtsEngineId, TtsVoice } from '@shared/types';

export interface SpeakRequest {
  text: string;
  /** BCP-47 tag of the *segment*, not of the book. */
  lang: string;
  voiceId?: string;
  /** 0.5 – 2.0, 1 = normal. */
  rate: number;
  /** charIndex/charLength are relative to `text`. */
  onBoundary?: (charIndex: number, charLength: number) => void;
  /** Fired the moment audio actually begins — synthesis wait is over. */
  onStart?: () => void;
  signal: AbortSignal;
}

export interface TtsEngine {
  readonly id: TtsEngineId;
  listVoices(): Promise<TtsVoice[]>;
  /** Resolves when the utterance finished; rejects on engine failure. Aborting resolves. */
  speak(req: SpeakRequest): Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): void;
  /** Optional look-ahead so the next line starts without a gap. */
  prefetch?(text: string, voiceId: string, rate: number): void;
  /** Whether this engine/voice can drive word-level highlighting. */
  wordBoundarySupport(voiceId?: string): boolean | 'unknown';
}

export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

export const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Pick the best voice for a language bucket out of a voice list. */
export function pickVoice(voices: TtsVoice[], lang: string, preferred?: string): TtsVoice | undefined {
  if (preferred) {
    const exact = voices.find((v) => v.id === preferred);
    if (exact) return exact;
  }
  const base = lang.split('-')[0].toLowerCase();
  const sameTag = voices.filter((v) => v.lang.toLowerCase() === lang.toLowerCase());
  if (sameTag.length) return sameTag[0];
  const sameLang = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  if (sameLang.length) return sameLang[0];
  return voices[0];
}
