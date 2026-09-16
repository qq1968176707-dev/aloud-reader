import {
  ANNOTATIONS_SCHEMA,
  BOOK_SCHEMA,
  INK_SCHEMA,
  LIBRARY_SCHEMA,
  PLAIN_SCHEMA,
  STATE_SCHEMA,
  STATS_SCHEMA,
  type AnnotationFile,
  type BookIndexEntry,
  type BookManifest,
  type ImportResult,
  type InkFile,
  type Library,
  type PlainIndex,
  type ReadingState,
  type RecordingMark,
  type RecordingMeta,
  type Settings,
  type StatsFile,
} from '@shared/types';
import { countWords } from '@shared/text';
import { extractBlocks } from '@shared/import/html';
import { SUPPORTED_EXTENSIONS, parseBook, type ImportedBook } from '@shared/import/index';
import { setPdfjsLoader } from '@shared/import/pdf';
import { ASSET_BASE } from './assets';
import { createNativeSpeech, isNativeShell } from './nativeSpeech';
import * as fsx from './storage';
import { P } from './storage';
import { defaultSettings, defaultStats } from './defaults';

/**
 * The browser implementation of the `window.aloud` contract.
 *
 * `src/main/preload.ts` is the contract; this file satisfies it with OPFS and Web APIs
 * so the 8,700-line renderer runs unchanged on iPad. Everything the desktop app can do
 * through Node — spawning Python TTS servers, reading arbitrary paths, revealing a
 * folder — is either unavailable in a browser or meaningless on a tablet, and those
 * members degrade explicitly rather than throwing.
 */

// Vite can see this literal and bundles pdf.js into the web build.
setPdfjsLoader(() => import('pdfjs-dist/build/pdf.mjs'));

const nowIso = (): string => new Date().toISOString();

/* ------------------------------------------------------------------ books */

/** Write a parsed book into OPFS — the browser twin of the desktop `materialize`. */
async function materialize(book: ImportedBook, sourceType: string): Promise<BookIndexEntry> {
  const { manifest, chapters, assets } = book;
  const dir = P.bookDir(manifest.id);

  for (const asset of assets) {
    await fsx.writeBytes(`${dir}/${asset.rel}`, asset.data);
  }

  const plain: PlainIndex = { schema: PLAIN_SCHEMA, bookId: manifest.id, chapters: [] };
  let totalWords = 0;
  for (const chapter of chapters) {
    await fsx.writeBytes(`${dir}/chapters/${chapter.file}`, chapter.html);
    const blocks = extractBlocks(chapter.html);
    const words = blocks.reduce((sum, b) => sum + countWords(b), 0);
    totalWords += words;
    plain.chapters.push({
      id: chapter.id,
      title: manifest.readingOrder.find((c) => c.id === chapter.id)?.title,
      words,
      blocks,
    });
  }

  await fsx.writeJson(P.manifest(manifest.id), manifest);
  await fsx.writeJson(P.plain(manifest.id), plain);

  const entry: BookIndexEntry = {
    id: manifest.id,
    title: manifest.title,
    authors: manifest.authors ?? [],
    language: manifest.language ?? 'en-US',
    cover: manifest.cover,
    addedAt: nowIso(),
    wordCount: totalWords,
    chapterCount: chapters.length,
    progress: 0,
    shelf: 'want',
    sourceType: sourceType as BookIndexEntry['sourceType'],
  };

  const lib = await getLibrary();
  lib.books = lib.books.filter((b) => b.id !== entry.id);
  lib.books.push(entry);
  lib.order = [entry.id, ...lib.order.filter((id) => id !== entry.id)];
  await fsx.writeJson(P.library(), lib);
  return entry;
}

async function getLibrary(): Promise<Library> {
  const lib = await fsx.readJson<Library>(P.library(), {
    schema: LIBRARY_SCHEMA,
    order: [],
    books: [],
    collections: [],
  });
  lib.schema ??= LIBRARY_SCHEMA;
  lib.order ??= [];
  lib.books ??= [];
  lib.collections ??= [];
  return lib;
}

/** Ask the user for files; iPadOS surfaces iCloud Drive and Files here. */
function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    // Downloads often keep a temp extension, and iOS is inconsistent about MIME types
    // for .mobi, so the accept list stays advisory — the format is sniffed from bytes.
    input.accept = SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(',');
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const done = (files: File[]): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files ?? [])]));
    // A cancelled picker fires nothing on some iOS versions; the focus return is the
    // only signal, and it can arrive before `change`, hence the delay.
    window.addEventListener(
      'focus',
      () => setTimeout(() => done([...(input.files ?? [])]), 800),
      { once: true },
    );
    input.click();
  });
}

type Listener<T> = (payload: T) => void;
const importListeners = new Set<Listener<{ file: string; done: number; total: number }>>();
const menuListeners = new Set<(command: string, payload?: unknown) => void>();

async function importFiles(files: File[]): Promise<ImportResult[]> {
  const out: ImportResult[] = [];
  for (const file of files) {
    for (const cb of importListeners) {
      cb({ file: file.name, done: out.length, total: files.length });
    }
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const parsed = await parseBook(data, file.name);
      const entry = await materialize(parsed.book, parsed.type);
      out.push({ ok: true, file: file.name, bookId: parsed.bookId, title: entry.title });
    } catch (err) {
      out.push({ ok: false, file: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/* ------------------------------------------------------------ recordings */

interface LiveRecording {
  id: string;
  bookId: string;
  chunks: Uint8Array<ArrayBuffer>[];
  bytes: number;
  startedAt: number;
}
const live = new Map<string, LiveRecording>();

const uid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** 16-bit PCM mono WAV header — the same format the desktop recorder writes. */
function wavHeader(dataBytes: number, sampleRate = 48_000): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

const base64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/* ------------------------------------------------------------------- api */

export const webApi = {
  platform: 'web' as const,
  // Android only: a bridge to the system TTS, because the WebView's speechSynthesis is
  // an empty shell. Undefined in every browser, where the Web Speech API works.
  speech: isNativeShell() ? createNativeSpeech() : undefined,
  /** Lets the renderer hide desktop-only affordances without sniffing the UA. */
  isWeb: true,

  app: {
    dataDir: async () => 'OPFS',
    openExternal: async (url: string) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http/https 链接');
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    revealBook: async () => {
      /* no folders to reveal in a browser */
    },
    setTitlebar: async () => {
      /* the PWA status bar follows theme-color */
    },
  },

  library: {
    get: getLibrary,
    save: (lib: Library) => fsx.writeJson(P.library(), lib),
  },

  books: {
    import: async (): Promise<ImportResult[]> => importFiles(await pickFiles()),
    /** Used by the drop handler, which has real File objects already. */
    importFiles,
    remove: async (bookId: string) => {
      await fsx.remove(P.bookDir(bookId), true);
      await fsx.remove(P.state(bookId));
      await fsx.remove(P.annotations(bookId));
      const lib = await getLibrary();
      lib.books = lib.books.filter((b) => b.id !== bookId);
      lib.order = lib.order.filter((id) => id !== bookId);
      lib.collections.forEach((c) => {
        c.bookIds = c.bookIds.filter((id) => id !== bookId);
      });
      await fsx.writeJson(P.library(), lib);
    },
    manifest: (bookId: string) => fsx.readJson<BookManifest | null>(P.manifest(bookId), null),
    plain: (bookId: string) => fsx.readJson<PlainIndex | null>(P.plain(bookId), null),
    chapter: async (bookId: string, chapterId: string): Promise<string> => {
      const manifest = await fsx.readJson<BookManifest | null>(P.manifest(bookId), null);
      const ref = manifest?.readingOrder.find((c) => c.id === chapterId);
      if (!ref) throw new Error(`章节不存在：${chapterId}`);
      if (ref.href.includes('..')) throw new Error('非法的章节路径');
      const html = await fsx.readText(`${P.bookDir(bookId)}/${ref.href}`);
      if (html == null) throw new Error(`读不到章节文件：${ref.href}`);
      // Images are baked as aloud://book/... at import time so both hosts share one
      // parser. A page cannot resolve that scheme, so point them at the service
      // worker's same-origin route instead.
      return html.replaceAll('aloud://book/', ASSET_BASE);
    },
  },

  state: {
    get: (bookId: string) =>
      fsx.readJson<ReadingState>(P.state(bookId), {
        schema: STATE_SCHEMA,
        bookId,
        history: [],
        updatedAt: nowIso(),
      }),
    save: (s: ReadingState) => fsx.writeJson(P.state(s.bookId), s),
  },

  annotations: {
    get: (bookId: string) =>
      fsx.readJson<AnnotationFile>(P.annotations(bookId), {
        schema: ANNOTATIONS_SCHEMA,
        bookId,
        annotations: [],
      }),
    save: (a: AnnotationFile) => fsx.writeJson(P.annotations(a.bookId), a),
  },

  ink: {
    get: (bookId: string) =>
      fsx.readJson<InkFile>(P.ink(bookId), { schema: INK_SCHEMA, bookId, strokes: [] }),
    save: async (f: InkFile) => {
      await fsx.writeJson(P.ink(f.bookId), f);
      // Drop pictures nothing references any more.
      const used = new Set(f.strokes.map((s) => (s as { file?: string }).file).filter(Boolean));
      for (const name of await fsx.list(P.inkImagesDir(f.bookId))) {
        if (!used.has(name)) await fsx.remove(`${P.inkImagesDir(f.bookId)}/${name}`);
      }
    },
    importImages: async (bookId: string): Promise<string[]> => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      const files = await new Promise<File[]>((resolve) => {
        input.addEventListener('change', () => resolve([...(input.files ?? [])]), { once: true });
        window.addEventListener('focus', () => setTimeout(() => resolve([...(input.files ?? [])]), 800), {
          once: true,
        });
        input.click();
      });
      const names: string[] = [];
      for (const file of files) {
        const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase();
        const name = `img-${uid()}${ext}`;
        await fsx.writeBytes(`${P.inkImagesDir(bookId)}/${name}`, new Uint8Array(await file.arrayBuffer()));
        names.push(name);
      }
      return names;
    },
    pasteImage: async (bookId: string): Promise<string | null> => {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (!type) continue;
          const blob = await item.getType(type);
          const ext = type === 'image/jpeg' ? '.jpg' : type === 'image/webp' ? '.webp' : '.png';
          const name = `img-${uid()}${ext}`;
          await fsx.writeBytes(`${P.inkImagesDir(bookId)}/${name}`, new Uint8Array(await blob.arrayBuffer()));
          return name;
        }
      } catch {
        // Safari only allows clipboard reads inside a user gesture, and denies it
        // outright without one — the toolbar's picture button is the way in.
      }
      return null;
    },
  },

  settings: {
    get: async (): Promise<Settings> => {
      const d = defaultSettings();
      const s = await fsx.readJson<Settings>(P.settings(), d);
      return {
        ...d,
        ...s,
        readAloud: { ...d.readAloud, ...(s.readAloud ?? {}), local: d.readAloud.local },
        goals: { ...d.goals, ...(s.goals ?? {}) },
        library: { ...d.library, ...(s.library ?? {}) },
      };
    },
    save: (s: Settings) => fsx.writeJson(P.settings(), s),
  },

  stats: {
    get: () => fsx.readJson<StatsFile>(P.stats(), defaultStats()),
    add: async (bookId: string, seconds: number): Promise<StatsFile> => {
      const stats = await fsx.readJson<StatsFile>(P.stats(), defaultStats());
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) return stats;
      const day = new Date().toISOString().slice(0, 10);
      stats.days[day] = (stats.days[day] ?? 0) + seconds;
      stats.byBook[bookId] = (stats.byBook[bookId] ?? 0) + seconds;
      await fsx.writeJson(P.stats(), stats);
      return stats;
    },
    finish: async (bookId: string, title: string): Promise<StatsFile> => {
      const stats = await fsx.readJson<StatsFile>(P.stats(), defaultStats());
      if (!stats.finished.some((f) => f.bookId === bookId)) {
        stats.finished.push({ bookId, title, at: nowIso() });
        await fsx.writeJson(P.stats(), stats);
      }
      return stats;
    },
  },

  /**
   * Speech is the platform's own voice on this build.
   *
   * The desktop app can run Kokoro or a cloned VoxCPM voice because it can spawn a
   * Python server with a GPU behind it. An iPad can do neither, so every engine except
   * the system one reports itself unavailable and the UI hides the rest.
   */
  tts: {
    edgeVoices: async () => [],
    edgeSynth: async () => ({ ok: false as const, error: 'web 版不支持 Edge 语音' }),
    localSynth: async () => ({ ok: false as const, error: 'web 版不支持本地模型' }),
    localTest: async () => ({ ok: false, message: 'web 版不支持本地模型，请使用系统语音' }),
    kokoroStatus: async () => ({ installed: false, running: false, ready: false, voices: [] }),
    kokoroStart: async () => ({ ok: false, message: 'web 版不支持本地模型' }),
    kokoroInstall: async () => {
      /* nothing to install */
    },
    install: async () => ({ name: 'kokoro', stage: 'error', message: 'web 版不支持本地模型' }) as never,
    installState: async () => ({ name: 'kokoro', stage: 'idle' }) as never,
    installCancel: async () => {
      /* nothing running */
    },
    voxcpmStatus: async () => ({ installed: false, running: false, ready: false, device: '' }),
    voxcpmStart: async () => ({ ok: false, message: 'web 版不支持声音克隆' }),
    voxcpmInstall: async () => {
      /* nothing to install */
    },
  },

  recordings: {
    begin: async (bookId: string) => {
      const id = uid();
      live.set(id, { id, bookId, chunks: [], bytes: 0, startedAt: Date.now() });
      return { id };
    },
    chunk: async (id: string, pcmBase64: string) => {
      const rec = live.get(id);
      if (!rec) return;
      const bytes = base64ToBytes(pcmBase64);
      rec.chunks.push(bytes);
      rec.bytes += bytes.length;
    },
    end: async (
      id: string,
      meta: { title: string; timeline: RecordingMark[] },
    ): Promise<RecordingMeta | null> => {
      const rec = live.get(id);
      live.delete(id);
      if (!rec || !rec.bytes) return null;
      const header = wavHeader(rec.bytes);
      const wav = new Uint8Array(header.length + rec.bytes);
      wav.set(header, 0);
      let at = header.length;
      for (const c of rec.chunks) {
        wav.set(c, at);
        at += c.length;
      }
      const dir = P.recordingsDir(rec.bookId);
      await fsx.writeBytes(`${dir}/${rec.id}.wav`, wav);
      const info: RecordingMeta = {
        id: rec.id,
        bookId: rec.bookId,
        title: meta.title,
        durationSec: rec.bytes / 2 / 48_000,
        createdAt: new Date(rec.startedAt).toISOString(),
        timeline: meta.timeline,
      };
      await fsx.writeJson(`${dir}/${rec.id}.json`, info);
      return info;
    },
    list: async (bookId: string): Promise<RecordingMeta[]> => {
      const dir = P.recordingsDir(bookId);
      const out: RecordingMeta[] = [];
      for (const name of await fsx.list(dir)) {
        if (!name.endsWith('.json')) continue;
        const meta = await fsx.readJson<RecordingMeta | null>(`${dir}/${name}`, null);
        if (meta) out.push(meta);
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    remove: async (bookId: string, id: string) => {
      if (!/^[a-z0-9]+$/.test(id)) return;
      const dir = P.recordingsDir(bookId);
      await fsx.remove(`${dir}/${id}.wav`);
      await fsx.remove(`${dir}/${id}.json`);
    },
    /** Blob URL for playback — the renderer's <audio> needs a real URL. */
    url: async (bookId: string, id: string): Promise<string | null> => {
      const bytes = await fsx.readBytes(`${P.recordingsDir(bookId)}/${id}.wav`);
      return bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' })) : null;
    },
  },

  voice: {
    save: async () => {
      throw new Error('web 版不支持声音克隆');
    },
    remove: async () => {
      /* nothing stored */
    },
  },

  dict: {
    lookup: async () => null,
  },

  smokeResize: async () => {
    /* the browser window is the user's */
  },

  dialog: {
    saveText: async (defaultName: string, content: string): Promise<string | null> => {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return defaultName;
    },
  },

  /** A browser File has no path; the web import path takes the File itself. */
  pathForFile: (file: File): string => file.name,

  onMenu: (cb: (command: string, payload?: unknown) => void) => {
    menuListeners.add(cb);
    return () => menuListeners.delete(cb);
  },
  onInstallProgress: () => () => {
    /* nothing installs on web */
  },
  onFullscreen: (cb: (on: boolean) => void) => {
    const handler = (): void => cb(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  },
  onImportProgress: (cb: Listener<{ file: string; done: number; total: number }>) => {
    importListeners.add(cb);
    return () => importListeners.delete(cb);
  },
};

/** Let the app shell drive the same commands the desktop menus send. */
export const sendMenu = (command: string, payload?: unknown): void => {
  for (const cb of menuListeners) cb(command, payload);
};

export const BOOK_SCHEMA_VERSION = BOOK_SCHEMA;
export const STATS_SCHEMA_VERSION = STATS_SCHEMA;
