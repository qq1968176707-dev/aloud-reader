/**
 * Read-aloud state machine (逐行导读).
 *
 * Owns "which segment is being spoken" and nothing about how it looks. The view layer
 * subscribes and paints; because a segment is identified by an id built from
 * (chapterId, blockIndex, segmentIndex), the highlight can always be re-derived after a
 * theme change, a resize, a layout-mode switch or a scroll — none of which the
 * controller needs to know about.
 */
import type { ReadAloudSegment, ReadAloudSettings, TtsEngineId, TtsVoice } from '@shared/types';
import { langTag, parseSegmentId } from '@shared/text';
import { AbortedError, delay, pickVoice, type TtsEngine } from './engine';
import { SystemEngine } from './systemEngine';
import { EdgeEngine } from './edgeEngine';
import { LocalEngine } from './localEngine';

export type RaStatus = 'idle' | 'loading' | 'playing' | 'paused';

export interface ReadAloudHost {
  /** Segments of a chapter that is already loaded, or null if it is not. */
  getSegments(chapterId: string): ReadAloudSegment[] | null;
  /** Load + display a chapter so its segments become available. */
  openChapter(chapterId: string): Promise<void>;
  nextChapterId(chapterId: string): string | null;
  onSegment(segment: ReadAloudSegment | null): void;
  onWord(charIndex: number, charLength: number): void;
  onStatus(status: RaStatus): void;
  onError(message: string): void;
  bookLanguage(): string;
}

/**
 * What the engine hears, not what the page shows.
 *
 * The name separator in 「詹姆斯·厄尔·雷」 is punctuation to a reader but a MATH DOT to
 * every TTS front-end we use — Kokoro and VoxCPM both say 乘 for it. Each variant is
 * replaced by a plain space of the SAME LENGTH, because word-boundary offsets coming
 * back from the engine index into this exact string: change its length and the karaoke
 * highlight walks off its words.
 */
const speechText = (text: string): string => text.replace(/[·•‧・･]/g, ' ');

export class ReadAloudController {
  private engines: Record<TtsEngineId, TtsEngine>;
  private settings: ReadAloudSettings;
  private voices: Record<TtsEngineId, TtsVoice[]> = { system: [], edge: [], local: [] };
  private token = 0;
  private controller: AbortController | null = null;
  private status: RaStatus = 'idle';
  private current: ReadAloudSegment | null = null;

  constructor(private host: ReadAloudHost, settings: ReadAloudSettings) {
    this.settings = settings;
    this.engines = {
      system: new SystemEngine(),
      edge: new EdgeEngine(),
      local: new LocalEngine(settings.local, settings.estimateWordTiming),
    };
  }

  get engine(): TtsEngine {
    return this.engines[this.settings.engine] ?? this.engines.system;
  }

  getStatus(): RaStatus {
    return this.status;
  }

  getCurrent(): ReadAloudSegment | null {
    return this.current;
  }

  async loadVoices(engineId: TtsEngineId): Promise<TtsVoice[]> {
    // The local engine's "voice list" is derived from its config, so never cache it.
    if (engineId !== 'local' && this.voices[engineId].length) return this.voices[engineId];
    try {
      this.voices[engineId] = await this.engines[engineId].listVoices();
    } catch {
      this.voices[engineId] = [];
    }
    return this.voices[engineId];
  }

  updateSettings(next: ReadAloudSettings): void {
    const engineChanged = next.engine !== this.settings.engine;
    this.settings = next;
    (this.engines.local as LocalEngine).update(next.local, next.estimateWordTiming);
    if (engineChanged && this.status !== 'idle') {
      const from = this.current?.id;
      this.stop();
      if (from) void this.start(from);
    }
  }

  wordHighlightAvailable(): boolean {
    if (!this.settings.highlightWords) return false;
    const lang = this.current?.lang ?? 'en';
    const voiceId = this.voiceFor(lang);
    return this.engine.wordBoundarySupport(voiceId) !== false;
  }

  private voiceFor(lang: string): string | undefined {
    const list = this.voices[this.settings.engine] ?? [];
    const preferred = this.settings.voiceByLang[lang];
    const tag = langTag(lang as 'zh' | 'en' | 'other', this.host.bookLanguage());
    return pickVoice(list, tag, preferred)?.id;
  }

  private setStatus(status: RaStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.host.onStatus(status);
  }

  /* ------------------------------------------------------------ controls */

  async start(segmentId: string): Promise<void> {
    this.cancelCurrent();
    const token = ++this.token;
    await this.loadVoices(this.settings.engine);
    if (token !== this.token) return;
    void this.run(segmentId, token);
  }

  toggle(fallbackSegmentId?: string): void {
    if (this.status === 'playing') this.pause();
    else if (this.status === 'paused') this.resume();
    else if (this.current) void this.start(this.current.id);
    else if (fallbackSegmentId) void this.start(fallbackSegmentId);
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.engine.pause();
    this.setStatus('paused');
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.engine.resume();
    this.setStatus('playing');
  }

  stop(): void {
    this.cancelCurrent();
    this.token++;
    this.current = null;
    this.host.onSegment(null);
    this.setStatus('idle');
  }

  next(): void {
    void this.step(1);
  }

  prev(): void {
    void this.step(-1);
  }

  private async step(direction: 1 | -1): Promise<void> {
    const current = this.current;
    if (!current) return;
    const segments = this.host.getSegments(current.chapterId);
    if (!segments) return;
    const index = segments.findIndex((s) => s.id === current.id);
    const target = segments[index + direction];
    if (target) {
      await this.start(target.id);
      return;
    }
    if (direction === 1) {
      const nextChapter = this.host.nextChapterId(current.chapterId);
      if (!nextChapter) {
        this.stop();
        return;
      }
      await this.host.openChapter(nextChapter);
      const first = this.host.getSegments(nextChapter)?.[0];
      if (first) await this.start(first.id);
    }
  }

  private cancelCurrent(): void {
    this.controller?.abort();
    this.controller = null;
    this.engine.cancel();
  }

  /* --------------------------------------------------------------- loop */

  private findSegment(id: string): ReadAloudSegment | null {
    const parsed = parseSegmentId(id);
    if (!parsed) return null;
    return this.host.getSegments(parsed.chapterId)?.find((s) => s.id === id) ?? null;
  }

  private async run(startId: string, token: number): Promise<void> {
    let currentId: string | null = startId;

    while (currentId && token === this.token) {
      const segment = this.findSegment(currentId);
      if (!segment) break;

      this.current = segment;
      this.host.onSegment(segment);

      const voiceId = this.voiceFor(segment.lang);
      const controller = new AbortController();
      this.controller = controller;

      // Honest status: while the model is synthesising there is nothing to hear, and a
      // bar that says "playing" through ten silent seconds reads as broken. 'loading'
      // shows 准备中…; the engine's onStart flips it the moment audio begins.
      this.setStatus('loading');

      // The model server is a single FIFO queue, so queue discipline IS the latency:
      //   1. The current line is enqueued first, always.
      //   2. Lookahead joins only AFTER the current line is audibly playing (onStart).
      //      Firing it immediately meant every seek dumped 3 synth jobs into the queue,
      //      and a few quick jumps buried the line the user actually wanted under a
      //      minute of doomed work for lines they had already skipped.
      const speaking = this.engine.speak({
        // Already whitespace-trimmed by makeSegments, so charIndex maps to start+charIndex.
        text: speechText(segment.text),
        lang: langTag(segment.lang, this.host.bookLanguage()),
        voiceId,
        rate: this.settings.rate,
        signal: controller.signal,
        onStart: () => {
          if (token !== this.token) return;
          if (this.status === 'loading') this.setStatus('playing');
          if (!voiceId) return;
          // Two segments deep: one line of lookahead cannot absorb a short line
          // followed by a long one.
          let ahead: ReadAloudSegment | null = segment;
          for (let depth = 0; depth < 2; depth++) {
            ahead = ahead ? this.peek(ahead) : null;
            if (!ahead) break;
            this.engine.prefetch?.(speechText(ahead.text), this.voiceFor(ahead.lang) ?? voiceId, this.settings.rate);
          }
        },
        // Always reported: the host uses word boundaries for more than the karaoke box —
        // page-following mid-sentence needs them even with the word highlight off.
        onBoundary: (charIndex, charLength) => {
          if (token === this.token) this.host.onWord(charIndex, charLength);
        },
      });

      try {
        await speaking;
      } catch (err) {
        if (err instanceof AbortedError || token !== this.token) return;
        this.host.onError(err instanceof Error ? err.message : String(err));
        this.setStatus('idle');
        return;
      }

      if (token !== this.token) return;
      if (this.settings.linePauseMs) await delay(this.settings.linePauseMs, controller.signal);
      if (token !== this.token) return;

      currentId = await this.advance(segment, token);
    }

    if (token === this.token) {
      this.current = null;
      this.host.onSegment(null);
      this.setStatus('idle');
    }
  }

  private peek(segment: ReadAloudSegment): ReadAloudSegment | null {
    const segments = this.host.getSegments(segment.chapterId);
    if (!segments) return null;
    const index = segments.findIndex((s) => s.id === segment.id);
    return segments[index + 1] ?? null;
  }

  private async advance(segment: ReadAloudSegment, token: number): Promise<string | null> {
    const following = this.peek(segment);
    if (following) return following.id;
    if (this.settings.stopAtChapterEnd) return null;
    const nextChapter = this.host.nextChapterId(segment.chapterId);
    if (!nextChapter) return null;
    await this.host.openChapter(nextChapter);
    if (token !== this.token) return null;
    return this.host.getSegments(nextChapter)?.[0]?.id ?? null;
  }

  dispose(): void {
    this.token++;
    this.cancelCurrent();
    for (const engine of Object.values(this.engines)) engine.cancel();
  }
}
