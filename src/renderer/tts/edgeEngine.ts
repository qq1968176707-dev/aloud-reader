/**
 * Optional online engine: Microsoft Edge neural voices, synthesised in the main process
 * and played back here as an mp3 blob.
 *
 * Word highlighting is *better* than the system engine's: the service returns exact
 * word offsets in audio time, so we drive the karaoke highlight from `audio.currentTime`
 * instead of from engine callbacks. That also means highlighting stays correct when the
 * user pauses, seeks or changes the window size mid-line.
 */
import type { EdgeSynthResult, TtsVoice } from '@shared/types';
import { AbortedError, type SpeakRequest, type TtsEngine } from './engine';
import { playClip, type ClipBoundary } from './clipPlayer';

interface Clip {
  url: string;
  boundaries: ClipBoundary[];
}

const key = (text: string, voice: string, rate: number): string => `${voice}|${rate}|${text}`;

/** Map the service's word strings back onto character offsets in the segment text. */
function toCharOffsets(text: string, result: EdgeSynthResult): Clip['boundaries'] {
  let cursor = 0;
  return result.boundaries.map((b) => {
    const word = b.text ?? '';
    let index = word ? text.indexOf(word, cursor) : -1;
    if (index < 0 && word) index = text.indexOf(word); // service may normalise punctuation
    if (index >= 0) cursor = index + word.length;
    return { offsetMs: b.offsetMs, charIndex: index < 0 ? cursor : index, charLength: word.length };
  });
}

export class EdgeEngine implements TtsEngine {
  readonly id = 'edge' as const;
  private audio: HTMLAudioElement | null = null;
  private cache = new Map<string, Promise<Clip>>();

  listVoices(): Promise<TtsVoice[]> {
    return window.aloud.tts.edgeVoices();
  }

  wordBoundarySupport(): boolean {
    return true;
  }

  private load(text: string, voice: string, rate: number): Promise<Clip> {
    const k = key(text, voice, rate);
    const hit = this.cache.get(k);
    if (hit) return hit;
    const promise = window.aloud.tts
      .edgeSynth({ text, voice, rate })
      .then((result) => {
        const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
        return { url, boundaries: toCharOffsets(text, result) };
      })
      .catch((err) => {
        this.cache.delete(k);
        throw err;
      });
    this.cache.set(k, promise);
    // Keep the cache small: 4 clips is enough for "current + look-ahead".
    if (this.cache.size > 4) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest && oldest !== k) {
        void this.cache.get(oldest)?.then((clip) => URL.revokeObjectURL(clip.url)).catch(() => undefined);
        this.cache.delete(oldest);
      }
    }
    return promise;
  }

  prefetch(text: string, voiceId: string, rate: number): void {
    if (!voiceId || !text.trim()) return;
    void this.load(text, voiceId, rate).catch(() => undefined);
  }

  async speak(req: SpeakRequest): Promise<void> {
    if (!req.voiceId) throw new Error('未选择在线语音');
    if (req.signal.aborted) throw new AbortedError();
    const clip = await this.load(req.text, req.voiceId, req.rate);
    if (req.signal.aborted) throw new AbortedError();
    return playClip({
      url: clip.url,
      text: req.text,
      boundaries: clip.boundaries,
      estimate: true,
      signal: req.signal,
      onBoundary: req.onBoundary,
      onAudio: (audio) => {
        this.audio = audio;
      },
    });
  }

  pause(): void {
    this.audio?.pause();
  }

  resume(): void {
    void this.audio?.play();
  }

  cancel(): void {
    this.audio?.pause();
    this.audio = null;
  }
}
