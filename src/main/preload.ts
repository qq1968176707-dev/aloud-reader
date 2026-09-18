import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { InstallProgress } from './tts/installer';
import type {
  AnnotationFile,
  BookManifest,
  DictEntry,
  EdgeSynthRequest,
  EdgeSynthResult,
  ImportResult,
  Library,
  LocalTtsConfig,
  NotebookOptions,
  LocalTtsResult,
  PlainIndex,
  ReadingState,
  HostSpeech,
  Settings,
  StatsFile,
  TtsVoice,
  InkFile,
  RecordingMark,
  RecordingMeta,
} from '@shared/types';

const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api = {
  // Widened because this file is also the *type* contract for the browser host
  // (src/web/api.ts), which reports 'web' — the renderer branches on it.
  platform: process.platform as NodeJS.Platform | 'web',
  app: {
    dataDir: () => invoke<string>('app:dataDir'),
    openExternal: (url: string) => invoke<void>('app:openExternal', url),
    revealBook: (bookId: string) => invoke<void>('app:revealBook', bookId),
    setTitlebar: (colors: { color: string; symbolColor: string }) => invoke<void>('app:titlebar', colors),
  },
  library: {
    get: () => invoke<Library>('library:get'),
    save: (lib: Library) => invoke<void>('library:save', lib),
  },
  books: {
    import: (paths?: string[]) => invoke<ImportResult[]>('books:import', paths),
    /** Same entry point as the web host: the renderer hands over dropped File objects
     *  and each host works out how to read them (paths here, bytes in the browser). */
    importFiles: (files: File[]) =>
      invoke<ImportResult[]>(
        'books:import',
        files.map((f) => webUtils.getPathForFile(f)),
      ),
    create: (opts: NotebookOptions) => invoke<ImportResult>('books:create', opts),
    addPages: (bookId: string, count: number) => invoke<number>('books:add-pages', bookId, count),
    remove: (bookId: string) => invoke<void>('books:remove', bookId),
    manifest: (bookId: string) => invoke<BookManifest | null>('books:manifest', bookId),
    plain: (bookId: string) => invoke<PlainIndex | null>('books:plain', bookId),
    chapter: (bookId: string, chapterId: string) => invoke<string>('books:chapter', bookId, chapterId),
  },
  state: {
    get: (bookId: string) => invoke<ReadingState>('state:get', bookId),
    save: (s: ReadingState) => invoke<void>('state:save', s),
  },
  annotations: {
    get: (bookId: string) => invoke<AnnotationFile>('annotations:get', bookId),
    save: (a: AnnotationFile) => invoke<void>('annotations:save', a),
  },
  ink: {
    get: (bookId: string) => invoke<InkFile>('ink:get', bookId),
    save: (f: InkFile) => invoke<void>('ink:save', f),
    importImages: (bookId: string) => invoke<string[]>('ink:import-images', bookId),
    pasteImage: (bookId: string) => invoke<string | null>('ink:paste-image', bookId),
  },
  settings: {
    get: () => invoke<Settings>('settings:get'),
    save: (s: Settings) => invoke<void>('settings:save', s),
  },
  stats: {
    get: () => invoke<StatsFile>('stats:get'),
    add: (bookId: string, seconds: number) => invoke<StatsFile>('stats:add', bookId, seconds),
    finish: (bookId: string, title: string) => invoke<StatsFile>('stats:finish', bookId, title),
  },
  tts: {
    edgeVoices: () => invoke<TtsVoice[]>('tts:edgeVoices'),
    edgeSynth: (req: EdgeSynthRequest) => invoke<EdgeSynthResult>('tts:edgeSynth', req),
    localSynth: (req: { text: string; rate: number; config: LocalTtsConfig }) =>
      invoke<LocalTtsResult>('tts:localSynth', req),
    localTest: (config: LocalTtsConfig) => invoke<{ ok: boolean; message: string }>('tts:localTest', config),
    kokoroStatus: () =>
      invoke<{ installed: boolean; running: boolean; ready: boolean; voices: string[] }>('tts:kokoroStatus'),
    kokoroStart: () => invoke<{ ok: boolean; message: string }>('tts:kokoroStart'),
    kokoroInstall: () => invoke<void>('tts:kokoroInstall'),
    /** In-app install with progress (see onInstallProgress). */
    install: (name: 'kokoro' | 'voxcpm') => invoke<InstallProgress>('tts:install', name),
    installState: (name: 'kokoro' | 'voxcpm') => invoke<InstallProgress>('tts:installState', name),
    installCancel: (name: 'kokoro' | 'voxcpm') => invoke<void>('tts:installCancel', name),
    voxcpmStatus: () =>
      invoke<{ installed: boolean; running: boolean; ready: boolean; device: string }>('tts:voxcpmStatus'),
    voxcpmStart: () => invoke<{ ok: boolean; message: string }>('tts:voxcpmStart'),
    voxcpmInstall: () => invoke<void>('tts:voxcpmInstall'),
  },
  recordings: {
    begin: (bookId: string) => invoke<{ id: string }>('recording:begin', bookId),
    chunk: (id: string, pcmBase64: string) => invoke<void>('recording:chunk', id, pcmBase64),
    end: (id: string, meta: { title: string; timeline: RecordingMark[] }) =>
      invoke<RecordingMeta | null>('recording:end', id, meta),
    list: (bookId: string) => invoke<RecordingMeta[]>('recordings:list', bookId),
    /** Playback URL. Desktop serves the WAV over its own protocol; the web host
     *  returns a blob URL instead, so the panel never builds the URL itself. */
    url: (bookId: string, id: string): Promise<string | null> =>
      Promise.resolve(`aloud://recording/${bookId}/${id}`),
    remove: (bookId: string, id: string) => invoke<void>('recording:delete', bookId, id),
  },
  voice: {
    save: (req: { name: string; transcript: string; sampleRate: number; samples: number[] }) =>
      invoke<{ id: string; path: string; durationSec: number }>('voice:save', req),
    remove: (file: string) => invoke<void>('voice:delete', file),
  },
  dict: {
    lookup: (word: string) => invoke<DictEntry | null>('dict:lookup', word),
  },
  /**
   * Host-provided speech engine. Undefined here — the desktop uses the Web Speech API
   * (SAPI5 / macOS voices) directly. The Android shell fills it in; see
   * src/web/nativeSpeech.ts and the contract in @shared/types.
   */
  speech: undefined as HostSpeech | undefined,
  /** Test harness only: resize the window (0,0 restores maximized). No-op in normal runs. */
  smokeResize: (w: number, h: number) => invoke<void>('smoke:resize', w, h),
  dialog: {
    saveText: (defaultName: string, content: string) =>
      invoke<string | null>('dialog:saveText', defaultName, content),
  },
  /** Real paths for files dropped onto the window (File objects have no .path under sandbox). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  onMenu: (cb: (command: string, payload?: unknown) => void) => {
    const handler = (_e: unknown, command: string, payload?: unknown) => cb(command, payload);
    ipcRenderer.on('menu', handler);
    return (): void => {
      ipcRenderer.off('menu', handler);
    };
  },
  onInstallProgress: (cb: (p: InstallProgress) => void) => {
    const handler = (_e: unknown, p: InstallProgress) => cb(p);
    ipcRenderer.on('tts:install-progress', handler);
    return (): void => {
      ipcRenderer.off('tts:install-progress', handler);
    };
  },
  /** macOS full screen toggles (the top bar reclaims the traffic-light gutter). */
  onFullscreen: (cb: (on: boolean) => void) => {
    const handler = (_e: unknown, on: boolean) => cb(on);
    ipcRenderer.on('window:fullscreen', handler);
    return (): void => {
      ipcRenderer.off('window:fullscreen', handler);
    };
  },
  onImportProgress: (cb: (p: { file: string; done: number; total: number }) => void) => {
    const handler = (_e: unknown, p: { file: string; done: number; total: number }) => cb(p);
    ipcRenderer.on('books:import-progress', handler);
    return (): void => {
      ipcRenderer.off('books:import-progress', handler);
    };
  },
};

export type AloudApi = typeof api;

contextBridge.exposeInMainWorld('aloud', api);
