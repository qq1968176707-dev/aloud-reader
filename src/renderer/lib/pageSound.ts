/**
 * Page-turn sound, synthesised rather than sampled.
 *
 * A paper flip is essentially filtered noise with a fast attack and a couple of flutters
 * as the sheet passes. Generating it means no audio asset to ship or license, and every
 * turn can be varied slightly so repeated turns never sound looped.
 */
let context: AudioContext | null = null;

function ensureContext(): AudioContext | null {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
    return context;
  } catch {
    return null;
  }
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min);

export function playPageTurn(volume: number, direction: 1 | -1 = 1): void {
  if (volume <= 0) return;
  const ctx = ensureContext();
  if (!ctx) return;

  const duration = rand(0.26, 0.34);
  const sampleRate = ctx.sampleRate;
  const frames = Math.ceil(sampleRate * duration);
  const buffer = ctx.createBuffer(1, frames, sampleRate);
  const data = buffer.getChannelData(0);

  // Two overlapping rustles: the sheet lifting, then settling.
  const flutter = rand(38, 52);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.012);
    const body = Math.exp(-t * rand(9, 12));
    const ripple = 0.72 + 0.28 * Math.sin(t * flutter * Math.PI);
    data[i] = (Math.random() * 2 - 1) * attack * body * ripple;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  // High-pass removes the "rumble"; the band-pass sweep is what makes it read as paper
  // sliding past rather than plain static.
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = rand(700, 950);

  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.Q.value = 0.65;
  const from = direction === 1 ? rand(1300, 1700) : rand(2600, 3200);
  const to = direction === 1 ? rand(2900, 3600) : rand(1200, 1600);
  bandpass.frequency.setValueAtTime(from, ctx.currentTime);
  bandpass.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + duration * 0.8);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume * 0.22), ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

  source.connect(highpass).connect(bandpass).connect(gain).connect(ctx.destination);
  source.start();
  source.stop(ctx.currentTime + duration + 0.02);
}
