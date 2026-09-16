import fs from 'node:fs';
import path from 'node:path';
import { P, ensureDirs } from './paths';
import {
  ANNOTATIONS_SCHEMA,
  LIBRARY_SCHEMA,
  SETTINGS_SCHEMA,
  INK_SCHEMA,
  STATE_SCHEMA,
  STATS_SCHEMA,
  type AnnotationFile,
  type InkFile,
  type Library,
  type LocalTtsConfig,
  type ReadingState,
  type Settings,
  type StatsFile,
} from '@shared/types';

/* ------------------------------------------------------------- json i/o */

export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Atomic-ish write: temp file + rename, so a crash can never truncate user data.
 *
 * The rename is best-effort. Some Windows profiles reject `rename()` with EXDEV/EPERM
 * even when source and target sit in the same directory — EFS-encrypted user folders,
 * cloud-sync clients and some AV filter drivers all do this. Losing atomicity is far
 * better than losing the user's library, so we fall back to writing in place.
 */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    fs.writeFileSync(file, data, 'utf8');
  }
}

/* ------------------------------------------------------------ defaults */

import {
  defaultLocalTts,
  defaultSettings,
  defaultLibrary,
  defaultState,
  defaultAnnotations,
  defaultStats,
} from '@shared/defaults';

export { defaultLocalTts, defaultSettings, defaultLibrary, defaultState, defaultAnnotations, defaultStats };

/* ------------------------------------------------------------ accessors */

export const getSettings = (): Settings => {
  const s = readJson<Settings>(P.settings(), defaultSettings());
  const d = defaultSettings();
  // Shallow-merge so new settings keys appear without wiping the user's file.
  const merged: Settings = {
    ...d,
    ...s,
    readAloud: {
      ...d.readAloud,
      ...(s.readAloud ?? {}),
      local: { ...d.readAloud.local, ...(s.readAloud?.local ?? {}) },
    },
    goals: { ...d.goals, ...(s.goals ?? {}) },
    library: { ...d.library, ...(s.library ?? {}) },
    migrations: { ...(s.migrations ?? {}) },
  };

  // One-shot migrations: run in whatever process actually owns the settings file, which
  // matters on this machine — a sandboxed helper writing the file directly can end up in
  // an MSIX-virtualized copy the real app never reads.
  let changed = false;
  if (!merged.migrations!['2026-08-double-and-builtin-voice']) {
    merged.spread = 'double';
    merged.readAloud.engine = 'local';
    merged.readAloud.local = defaultLocalTts();
    merged.migrations!['2026-08-double-and-builtin-voice'] = true;
    changed = true;
  }
  if (!merged.migrations!['2026-08-no-word-box']) {
    merged.readAloud.highlightWords = false;
    merged.migrations!['2026-08-no-word-box'] = true;
    changed = true;
  }
  // The word box came back once its timing was aligned to the clip's energy envelope
  // (silences pinned to punctuation) — the earlier complaint was the drift, not the box.
  if (!merged.migrations!['2026-08-word-box-synced']) {
    merged.readAloud.highlightWords = true;
    merged.readAloud.estimateWordTiming = true;
    merged.migrations!['2026-08-word-box-synced'] = true;
    changed = true;
  }
  if (changed) saveSettings(merged);
  return merged;
};
export const saveSettings = (s: Settings): void => writeJson(P.settings(), s);

export const getLibrary = (): Library => {
  const lib = readJson<Library>(P.library(), defaultLibrary());
  lib.schema ??= LIBRARY_SCHEMA;
  lib.order ??= [];
  lib.books ??= [];
  lib.collections ??= [];
  return lib;
};
export const saveLibrary = (lib: Library): void => writeJson(P.library(), lib);

export const getState = (bookId: string): ReadingState =>
  readJson<ReadingState>(P.state(bookId), defaultState(bookId));
export const saveState = (s: ReadingState): void => writeJson(P.state(s.bookId), s);

export const getInk = (bookId: string): InkFile =>
  readJson<InkFile>(P.ink(bookId), { schema: INK_SCHEMA, bookId, strokes: [] });
export const saveInk = (f: InkFile): void => writeJson(P.ink(f.bookId), f);

export const getAnnotations = (bookId: string): AnnotationFile =>
  readJson<AnnotationFile>(P.annotations(bookId), defaultAnnotations(bookId));
export const saveAnnotations = (a: AnnotationFile): void => writeJson(P.annotations(a.bookId), a);

export const getStats = (): StatsFile => {
  const s = readJson<StatsFile>(P.stats(), defaultStats());
  s.days ??= {};
  s.byBook ??= {};
  s.finished ??= [];
  return s;
};
export const saveStats = (s: StatsFile): void => writeJson(P.stats(), s);

export function init(): void {
  ensureDirs();
  if (!fs.existsSync(P.settings())) saveSettings(defaultSettings());
  if (!fs.existsSync(P.library())) saveLibrary(defaultLibrary());
  if (!fs.existsSync(P.stats())) saveStats(defaultStats());
}
