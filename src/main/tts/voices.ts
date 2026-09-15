/**
 * Storage for recorded voice samples used by the cloning engine.
 *
 * The renderer captures mono PCM off the audio graph and hands over raw float samples;
 * this module writes a real 16-bit WAV, because that is what every TTS model's reference
 * loader expects.
 *
 * Samples are the one thing here the user cannot regenerate — they recorded them — so
 * they live under the user data directory, which survives reinstalls and rebuilds. The
 * model runtime folder does not: it is disposable, and an earlier version of this file
 * put samples there, so anything left behind is migrated on first use.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { scriptsDir } from './kokoro';

let migrated = false;

export const voicesDir = (): string => {
  const dir = path.join(app.getPath('userData'), 'voices');
  fs.mkdirSync(dir, { recursive: true });
  if (!migrated) {
    migrated = true;
    const legacy = scriptsDir() ? path.join(scriptsDir()!, 'runtime-voxcpm', 'voices') : null;
    if (legacy && fs.existsSync(legacy)) {
      for (const f of fs.readdirSync(legacy)) {
        const to = path.join(dir, f);
        if (!f.endsWith('.wav') || fs.existsSync(to)) continue;
        try {
          fs.copyFileSync(path.join(legacy, f), to);
        } catch {
          /* a sample we cannot copy is not worth failing the app over */
        }
      }
    }
  }
  return dir;
};

/**
 * Where a stored sample actually is now.
 *
 * Settings keep absolute paths, so a sample recorded before the move still points at the
 * runtime folder. Resolve by filename against the durable directory first.
 */
export const resolveVoicePath = (stored: string): string => {
  if (!stored) return stored;
  const here = path.join(voicesDir(), path.basename(stored));
  if (fs.existsSync(here)) return here;
  return stored;
};

function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface SaveVoiceRequest {
  name: string;
  transcript: string;
  sampleRate: number;
  /** Mono float samples, -1..1, as a plain array over IPC. */
  samples: number[];
}

export function saveVoiceSample(req: SaveVoiceRequest): {
  id: string;
  path: string;
  durationSec: number;
} {
  const samples = Float32Array.from(req.samples);
  if (!samples.length) throw new Error('录音为空');
  const id = `${Date.now().toString(36)}`;
  const file = path.join(voicesDir(), `${id}.wav`);
  fs.writeFileSync(file, encodeWav(samples, req.sampleRate));
  return { id, path: file, durationSec: samples.length / req.sampleRate };
}

export function deleteVoiceSample(file: string): void {
  const dir = voicesDir();
  const resolved = path.resolve(file);
  // Only ever delete inside our own voices directory.
  if (resolved.startsWith(path.resolve(dir))) fs.rmSync(resolved, { force: true });
}
