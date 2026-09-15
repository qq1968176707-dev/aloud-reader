import type { RecordingMark } from '@shared/types';

/**
 * A live reading-recording session.
 *
 * Audio goes out as a stream of ~1 s Int16 chunks (base64 over IPC) — never buffered
 * whole, so an hour-long session costs constant renderer memory. Alongside the audio,
 * `mark()` samples the reading position; the marks become the timeline that lets
 * playback walk the book to wherever the reader was at that second.
 */
export class RecordingSession {
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private stream: MediaStream | null = null;
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private flushing = Promise.resolve();
  private startedAtMs = 0;
  private marks: RecordingMark[] = [];
  private lastMarkKey = '';

  private constructor(
    readonly id: string,
    readonly bookId: string,
  ) {}

  static async start(bookId: string): Promise<RecordingSession> {
    const { id } = await window.aloud.recordings.begin(bookId);
    const session = new RecordingSession(id, bookId);
    try {
      await session.open();
    } catch (err) {
      // The file was opened in main; close it out so no orphan handle survives.
      void window.aloud.recordings.end(id, { title: '', timeline: [] });
      throw err;
    }
    return session;
  }

  private async open(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext({ sampleRate: 48_000 });
    this.ctx = ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    const source = ctx.createMediaStreamSource(this.stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    this.node = node;
    node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const ints = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const v = Math.max(-1, Math.min(1, input[i]));
        ints[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      this.pending.push(ints);
      this.pendingSamples += ints.length;
      // ~1 s of audio per IPC hop.
      if (this.pendingSamples >= 48_000) this.flush();
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    this.startedAtMs = performance.now();
  }

  /** Milliseconds recorded so far. */
  elapsedMs(): number {
    return this.startedAtMs ? performance.now() - this.startedAtMs : 0;
  }

  /** Record "the reader is HERE now"; deduped so page-turn bursts cost one mark. */
  mark(chapterIndex: number, chapterId: string, blockIndex: number): void {
    const key = `${chapterIndex}|${blockIndex}`;
    if (key === this.lastMarkKey) return;
    this.lastMarkKey = key;
    this.marks.push({ t: Math.round(this.elapsedMs()), chapterIndex, chapterId, blockIndex });
  }

  private flush(): void {
    if (!this.pending.length) return;
    const chunks = this.pending;
    this.pending = [];
    this.pendingSamples = 0;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Int16Array(total);
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.length;
    }
    // Serialise the sends so chunks can never land out of order.
    const bytes = new Uint8Array(joined.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const b64 = btoa(bin);
    this.flushing = this.flushing.then(() => window.aloud.recordings.chunk(this.id, b64));
  }

  async stop(title: string): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') void ctx.close();
    this.flush();
    await this.flushing;
    await window.aloud.recordings.end(this.id, { title, timeline: this.marks });
  }
}
