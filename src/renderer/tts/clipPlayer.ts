/**
 * Shared playback for engines that return a finished audio clip (Edge, local models).
 *
 * Karaoke highlighting is driven from `audio.currentTime` rather than from engine
 * callbacks, which means it stays correct through pause, resume and window resizes.
 *
 * Local model servers do not report word boundaries at all. Rather than dropping to
 * line-only highlighting, timings can be *estimated* from the clip duration by weighting
 * each word by how long it takes to say — a CJK character carries far more duration than
 * a Latin one. It is an approximation, but for read-along it lands within a syllable and
 * looks right; the alternative is no word highlight at all.
 */
import { AbortedError } from './engine';

export interface ClipBoundary {
  offsetMs: number;
  charIndex: number;
  charLength: number;
}

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;

/** Rough "time cost" of a character, used only for proportional distribution. */
const costOf = (ch: string): number => {
  if (CJK.test(ch)) return 1;
  if (/\s/.test(ch)) return 0.08;
  if (/[.,!?;:。，！？；：、]/.test(ch)) return 0.5;
  return 0.32;
};

export function estimateBoundaries(text: string, durationMs: number): ClipBoundary[] {
  if (!text || !Number.isFinite(durationMs) || durationMs <= 0) return [];

  const words: { start: number; end: number }[] = [];
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter !== 'undefined') {
    const locale = CJK.test(text) ? 'zh' : 'en';
    for (const piece of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)) {
      if (!piece.segment.trim()) continue;
      words.push({ start: piece.index, end: piece.index + piece.segment.length });
    }
  } else {
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) words.push({ start: m.index, end: m.index + m[0].length });
  }
  if (!words.length) return [];

  // Cumulative cost of everything before each word, including the gaps.
  const prefix: number[] = new Array(text.length + 1).fill(0);
  for (let i = 0; i < text.length; i++) prefix[i + 1] = prefix[i] + costOf(text[i]);
  const total = prefix[text.length] || 1;

  return words.map((w) => ({
    offsetMs: (prefix[w.start] / total) * durationMs,
    charIndex: w.start,
    charLength: w.end - w.start,
  }));
}

/* ---------------------------------------------------- energy alignment */

/**
 * Refine estimated boundaries against the clip's actual energy envelope.
 *
 * The proportional estimate drifts for two audible reasons: models emit leading and
 * trailing silence (several hundred ms for the cloning engine), and they pause at
 * punctuation far longer than a flat per-character cost predicts. Both are visible in
 * the waveform, so the fix is to look at it: trim the estimate to the voiced span, then
 * pin phrase boundaries (punctuation) to the longest internal silences and distribute
 * the per-character costs only *between* those pins. This is not forced alignment — but
 * pauses are where the karaoke box visibly ran ahead, and pauses are exactly what an
 * energy envelope can see.
 */
const PAUSE_PUNCT = /[。，！？；：、,.!?;:…]/;

interface Anchor {
  cost: number;
  ms: number;
}

async function refineWithEnvelope(
  bytes: Uint8Array,
  text: string,
  durationMs: number,
): Promise<ClipBoundary[] | null> {
  // A copy, because decodeAudioData detaches the buffer it is given.
  const raw = bytes.slice().buffer;
  const ctx = new AudioContext({ sampleRate: 16000 });
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(raw);
  } finally {
    void ctx.close();
  }

  // 20ms RMS envelope of the first channel.
  const data = decoded.getChannelData(0);
  const frame = Math.max(1, Math.round(decoded.sampleRate * 0.02));
  const frames = Math.floor(data.length / frame);
  if (frames < 8) return null;
  const rms = new Float32Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let j = i * frame; j < (i + 1) * frame; j++) sum += data[j] * data[j];
    rms[i] = Math.sqrt(sum / frame);
    peak = Math.max(peak, rms[i]);
  }
  if (peak <= 0) return null;
  const threshold = peak * 0.06;
  const frameMs = (frame / decoded.sampleRate) * 1000;

  // Voiced span: everything outside it is lead-in/lead-out silence.
  let first = 0;
  while (first < frames && rms[first] < threshold) first++;
  let last = frames - 1;
  while (last > first && rms[last] < threshold) last--;
  if (last - first < 4) return null;
  const voiceStartMs = first * frameMs;
  const voiceEndMs = (last + 1) * frameMs;

  // Internal silences worth pinning to (>= 140ms).
  const gaps: { midMs: number; durMs: number }[] = [];
  let runStart = -1;
  for (let i = first; i <= last; i++) {
    const silent = rms[i] < threshold;
    if (silent && runStart < 0) runStart = i;
    if ((!silent || i === last) && runStart >= 0) {
      const durMs = (i - runStart) * frameMs;
      if (durMs >= 140) gaps.push({ midMs: (runStart + (i - runStart) / 2) * frameMs, durMs });
      runStart = -1;
    }
  }

  // Character cost scale (same weights as the flat estimate).
  const prefix: number[] = new Array(text.length + 1).fill(0);
  for (let i = 0; i < text.length; i++) prefix[i + 1] = prefix[i] + costOf(text[i]);
  const total = prefix[text.length] || 1;

  // Phrase ends: the position AFTER each run of pause punctuation (not the last one).
  const phraseEnds: number[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (PAUSE_PUNCT.test(text[i]) && !PAUSE_PUNCT.test(text[i + 1] ?? '')) phraseEnds.push(i + 1);
  }

  // Pin the longest silences to the nearest-in-proportion phrase ends, monotonically.
  const span = voiceEndMs - voiceStartMs;
  const chosen = gaps
    .slice()
    .sort((a, b) => b.durMs - a.durMs)
    .slice(0, phraseEnds.length)
    .sort((a, b) => a.midMs - b.midMs);
  const anchors: Anchor[] = [{ cost: 0, ms: voiceStartMs }];
  let nextPhrase = 0;
  for (const gap of chosen) {
    const target = (gap.midMs - voiceStartMs) / span;
    let best = -1;
    let bestDelta = Infinity;
    for (let i = nextPhrase; i < phraseEnds.length; i++) {
      const delta = Math.abs(prefix[phraseEnds[i]] / total - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    // A pin that would claim more than a third of the whole clip away from its
    // proportional position is probably a mismatch (music, a cough) — skip it.
    if (best < 0 || bestDelta > 0.34) continue;
    const cost = prefix[phraseEnds[best]];
    if (cost > anchors[anchors.length - 1].cost && gap.midMs > anchors[anchors.length - 1].ms) {
      anchors.push({ cost, ms: gap.midMs });
      nextPhrase = best + 1;
    }
  }
  anchors.push({ cost: total, ms: voiceEndMs });

  // Interpolate every word's offset within its anchor interval.
  const flat = estimateBoundaries(text, durationMs);
  return flat.map((w) => {
    const c = prefix[w.charIndex];
    let k = 0;
    while (k + 1 < anchors.length - 1 && anchors[k + 1].cost <= c) k++;
    const a = anchors[k];
    const b = anchors[k + 1];
    const t = b.cost > a.cost ? (c - a.cost) / (b.cost - a.cost) : 0;
    return { ...w, offsetMs: a.ms + t * (b.ms - a.ms) };
  });
}

export interface PlayClipOptions {
  url: string;
  /** Raw clip bytes; when present, estimated timings are refined against the waveform. */
  bytes?: Uint8Array;
  text: string;
  /** Real boundaries from the engine; when absent they can be estimated. */
  boundaries?: ClipBoundary[] | null;
  estimate: boolean;
  signal: AbortSignal;
  onBoundary?: (charIndex: number, charLength: number) => void;
  onAudio?: (audio: HTMLAudioElement) => void;
}

export function playClip(options: PlayClipOptions): Promise<void> {
  const { url, text, estimate, signal, onBoundary } = options;
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());

    const audio = new Audio(url);
    options.onAudio?.(audio);
    let finished = false;
    let frame = 0;
    let lastIndex = -1;
    let marks: ClipBoundary[] = options.boundaries ?? [];

    const cleanup = (): void => {
      cancelAnimationFrame(frame);
      signal.removeEventListener('abort', onAbort);
      audio.onended = null;
      audio.onerror = null;
      audio.onloadedmetadata = null;
    };

    function onAbort(): void {
      if (finished) return;
      finished = true;
      audio.pause();
      cleanup();
      reject(new AbortedError());
    }

    const tick = (): void => {
      if (finished) return;
      if (marks.length && onBoundary) {
        const ms = audio.currentTime * 1000;
        let index = -1;
        for (let i = marks.length - 1; i >= 0; i--) {
          if (marks[i].offsetMs <= ms) {
            index = i;
            break;
          }
        }
        if (index >= 0 && index !== lastIndex) {
          lastIndex = index;
          onBoundary(marks[index].charIndex, marks[index].charLength);
        }
      }
      frame = requestAnimationFrame(tick);
    };

    audio.onloadedmetadata = () => {
      if (!marks.length && estimate && Number.isFinite(audio.duration)) {
        const durationMs = audio.duration * 1000;
        // The flat estimate starts the karaoke instantly; the envelope-refined pass
        // replaces it as soon as the decode finishes (well under the clip length).
        marks = estimateBoundaries(text, durationMs);
        if (!options.bytes) return;
        void refineWithEnvelope(options.bytes, text, durationMs)
          .then((refined) => {
            if (!finished && refined && refined.length) {
              marks = refined;
              lastIndex = -1; // let the next tick re-emit against the better timeline
            }
          })
          .catch(() => undefined); // alignment is an upgrade, never a failure mode
      }
    };
    audio.onended = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve();
    };
    audio.onerror = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error('音频播放失败（格式可能不被支持）'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    void audio.play().then(
      () => {
        frame = requestAnimationFrame(tick);
      },
      (err) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
