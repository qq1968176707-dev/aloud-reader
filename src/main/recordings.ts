/**
 * Reading recordings — GoodNotes' Record-while-you-work, adapted to a reader.
 *
 * While a recording runs, the renderer streams PCM chunks here AND samples the reading
 * position; both land on disk together (a WAV plus a JSON sidecar with the position
 * timeline). Playback can then do the GoodNotes trick in reverse: as the audio plays,
 * the book follows to wherever you were reading at that moment.
 *
 * Audio is streamed, never buffered whole: a half-hour recording is ~160 MB of float
 * samples, which would have to cross the IPC boundary as one giant array. Chunks are
 * Int16 PCM as base64, appended straight to the file behind a placeholder header; the
 * header is patched with the true sizes on finish, so even a crash mid-recording leaves
 * a file that is playable up to the last chunk after one header fix.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import type { RecordingMeta } from '@shared/types';

const SAMPLE_RATE = 48_000;

const recDir = (bookId: string): string => {
  const dir = path.join(app.getPath('userData'), 'recordings', bookId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

interface Live {
  fd: number;
  bookId: string;
  file: string;
  bytes: number;
  startedAt: string;
}

const live = new Map<string, Live>();

export function beginRecording(bookId: string): { id: string } {
  const id = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const file = path.join(recDir(bookId), `${id}.wav`);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, wavHeader(0)); // placeholder, patched on finish
  live.set(id, { fd, bookId, file, bytes: 0, startedAt: new Date().toISOString() });
  return { id };
}

export function appendRecording(id: string, base64Pcm16: string): void {
  const rec = live.get(id);
  if (!rec) return; // stopped already — a late chunk is not an error
  const buf = Buffer.from(base64Pcm16, 'base64');
  fs.writeSync(rec.fd, buf);
  rec.bytes += buf.length;
}

export function endRecording(
  id: string,
  meta: { title: string; timeline: RecordingMeta['timeline'] },
): RecordingMeta | null {
  const rec = live.get(id);
  if (!rec) return null;
  live.delete(id);
  // Patch the header with the real data size.
  const header = wavHeader(rec.bytes);
  fs.writeSync(rec.fd, header, 0, 44, 0);
  fs.closeSync(rec.fd);

  const out: RecordingMeta = {
    id,
    bookId: rec.bookId,
    title: meta.title,
    durationSec: rec.bytes / 2 / SAMPLE_RATE,
    createdAt: rec.startedAt,
    timeline: meta.timeline ?? [],
  };
  fs.writeFileSync(path.join(recDir(rec.bookId), `${id}.json`), JSON.stringify(out, null, 2));
  return out;
}

/** A recording whose session died (crash, force-quit) is still salvageable. */
export function abortRecording(id: string): void {
  const rec = live.get(id);
  if (!rec) return;
  live.delete(id);
  const header = wavHeader(rec.bytes);
  try {
    fs.writeSync(rec.fd, header, 0, 44, 0);
    fs.closeSync(rec.fd);
  } catch {
    /* nothing to salvage */
  }
}

export function listRecordings(bookId: string): RecordingMeta[] {
  const dir = recDir(bookId);
  const out: RecordingMeta[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as RecordingMeta;
      if (fs.existsSync(path.join(dir, `${meta.id}.wav`))) out.push(meta);
    } catch {
      /* skip broken sidecars */
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function deleteRecording(bookId: string, id: string): void {
  // The id came over IPC: never let it path-escape the recordings directory.
  if (!/^[a-z0-9]+$/i.test(id)) return;
  const dir = recDir(bookId);
  fs.rmSync(path.join(dir, `${id}.wav`), { force: true });
  fs.rmSync(path.join(dir, `${id}.json`), { force: true });
}

/** Absolute path for the aloud:// protocol to serve. */
export function recordingPath(bookId: string, id: string): string | null {
  if (!/^[a-z0-9]+$/i.test(id)) return null;
  const file = path.join(recDir(bookId), `${id}.wav`);
  return fs.existsSync(file) ? file : null;
}

app.on('will-quit', () => {
  for (const id of [...live.keys()]) abortRecording(id);
});
