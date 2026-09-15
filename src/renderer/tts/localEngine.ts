/**
 * Local model engine: talks to a TTS server running on the user's own machine
 * (GPT-SoVITS / CosyVoice / any OpenAI-compatible endpoint).
 *
 * This is where the good voices are — character voices, cloned voices, and emotion
 * control — at the cost of the user running a model server. Synthesis happens in the
 * main process; this class only queues, caches, plays and drives the highlight.
 */
import type { LocalTtsConfig, TtsVoice } from '@shared/types';
import { AbortedError, type SpeakRequest, type TtsEngine } from './engine';
import { playClip } from './clipPlayer';

interface Clip {
  url: string;
  /** Raw clip bytes, handed to the envelope aligner so it never has to fetch(). */
  bytes: Uint8Array;
}

export class LocalEngine implements TtsEngine {
  readonly id = 'local' as const;
  private audio: HTMLAudioElement | null = null;
  private cache = new Map<string, Promise<Clip>>();
  private config: LocalTtsConfig;
  private estimate = true;

  constructor(config: LocalTtsConfig, estimate: boolean) {
    this.config = config;
    this.estimate = estimate;
  }

  update(config: LocalTtsConfig, estimate: boolean): void {
    const changed = JSON.stringify(config) !== JSON.stringify(this.config);
    this.config = config;
    this.estimate = estimate;
    if (changed) this.clearCache();
  }

  /**
   * Local servers have no standard voice-list endpoint, and the "voice" means something
   * different per preset (a name, a reference wav path, a speaker id). The picker in the
   * UI is therefore a text field; this only reports what is configured.
   */
  async listVoices(): Promise<TtsVoice[]> {
    const label =
      this.config.preset === 'gpt-sovits'
        ? `GPT-SoVITS · ${this.config.voice.split(/[\\/]/).pop() || '未设置参考音频'}`
        : this.config.preset === 'cosyvoice'
          ? `CosyVoice · ${this.config.cosyMode === 'sft' ? this.config.voice || '中文女' : '参考音色'}`
          : `${this.config.model || 'tts'} · ${this.config.voice || '默认'}`;
    return [{ id: 'local:current', name: label, lang: 'zh-CN', engine: 'local', wordBoundary: this.estimate }];
  }

  wordBoundarySupport(): boolean {
    // No local server reports real boundaries; estimated timings stand in for them.
    return this.estimate;
  }

  private key(text: string, rate: number): string {
    return `${rate}|${JSON.stringify(this.config)}|${text}`;
  }

  private load(text: string, rate: number): Promise<Clip> {
    const k = this.key(text, rate);
    const hit = this.cache.get(k);
    if (hit) return hit;
    const promise = window.aloud.tts
      .localSynth({ text, rate, config: this.config })
      .then((result) => {
        const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
        return {
          url: URL.createObjectURL(new Blob([bytes], { type: result.mime })),
          // Kept for the envelope aligner: the CSP has no reason to allow fetch()ing
          // blob: URLs when the bytes are already right here.
          bytes,
        };
      })
      .catch((err) => {
        this.cache.delete(k);
        throw err;
      });
    this.cache.set(k, promise);
    // Current line + two of lookahead + a few lines of history for prev/replay.
    if (this.cache.size > 8) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest && oldest !== k) {
        void this.cache
          .get(oldest)
          ?.then((clip) => URL.revokeObjectURL(clip.url))
          .catch(() => undefined);
        this.cache.delete(oldest);
      }
    }
    return promise;
  }

  prefetch(text: string, _voiceId: string, rate: number): void {
    if (!text.trim()) return;
    void this.load(text, rate).catch(() => undefined);
  }

  async speak(req: SpeakRequest): Promise<void> {
    if (req.signal.aborted) throw new AbortedError();
    const clip = await this.load(req.text, req.rate);
    if (req.signal.aborted) throw new AbortedError();
    req.onStart?.();
    return playClip({
      url: clip.url,
      bytes: clip.bytes,
      text: req.text,
      boundaries: null,
      estimate: this.estimate,
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

  private clearCache(): void {
    for (const promise of this.cache.values()) {
      void promise.then((clip) => URL.revokeObjectURL(clip.url)).catch(() => undefined);
    }
    this.cache.clear();
  }
}
