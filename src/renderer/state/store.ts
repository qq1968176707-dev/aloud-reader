import { create } from 'zustand';
import type { ImportResult,
  BookIndexEntry,
  Library,
  ReadAloudSettings,
  Settings,
  StatsFile,
} from '@shared/types';
import { debounce } from '../lib/util';

export type Route = { name: 'library' } | { name: 'reader'; bookId: string } | { name: 'stats' };

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

interface AppStore {
  ready: boolean;
  settings: Settings;
  library: Library;
  stats: StatsFile;
  route: Route;
  toasts: Toast[];
  importing: boolean;
  /** Live progress while a multi-file import runs; null otherwise. */
  importProgress: { file: string; done: number; total: number } | null;

  init: () => Promise<void>;
  patchSettings: (patch: Partial<Settings>) => void;
  patchReadAloud: (patch: Partial<ReadAloudSettings>) => void;
  setLibrary: (next: Library) => void;
  updateBook: (bookId: string, patch: Partial<BookIndexEntry>) => void;
  importBooks: (paths?: string[]) => Promise<void>;
  /** Books dropped on the window — Files, because the browser host never sees paths. */
  importFiles: (files: File[]) => Promise<void>;
  /** Shared tail of both importers: toasts, failures, library refresh. */
  runImport: (run: () => Promise<ImportResult[]>) => Promise<void>;
  removeBook: (bookId: string) => Promise<void>;
  refreshStats: () => Promise<void>;
  navigate: (route: Route) => void;
  toast: (message: string, tone?: 'info' | 'error') => void;
  dismissToast: (id: number) => void;
}

const persistSettings = debounce((settings: Settings) => {
  void window.aloud.settings.save(settings);
}, 350);

const persistLibrary = debounce((library: Library) => {
  void window.aloud.library.save(library);
}, 350);

let toastSeq = 0;

export const useStore = create<AppStore>((set, get) => ({
  ready: false,
  settings: {} as Settings,
  library: { schema: 'aloud-library/1', order: [], books: [], collections: [] },
  stats: { schema: 'aloud-stats/1', days: {}, byBook: {}, finished: [] },
  route: { name: 'library' },
  toasts: [],
  importing: false,
  importProgress: null,

  init: async () => {
    const [settings, library, stats] = await Promise.all([
      window.aloud.settings.get(),
      window.aloud.library.get(),
      window.aloud.stats.get(),
    ]);
    set({ settings, library, stats, ready: true });
  },

  patchSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    persistSettings(settings);
  },

  patchReadAloud: (patch) => {
    const current = get().settings;
    const settings = { ...current, readAloud: { ...current.readAloud, ...patch } };
    set({ settings });
    persistSettings(settings);
  },

  setLibrary: (next) => {
    set({ library: next });
    persistLibrary(next);
  },

  updateBook: (bookId, patch) => {
    const library = get().library;
    const next: Library = {
      ...library,
      books: library.books.map((b) => (b.id === bookId ? { ...b, ...patch } : b)),
    };
    set({ library: next });
    persistLibrary(next);
  },

  importBooks: async (paths) => get().runImport(() => window.aloud.books.import(paths)),
  importFiles: async (files) => get().runImport(() => window.aloud.books.importFiles(files)),
  runImport: async (run) => {
    set({ importing: true });
    try {
      const results = await run();
      const failed = results.filter((r) => !r.ok);
      const ok = results.filter((r) => r.ok);
      if (ok.length) {
        set({ library: await window.aloud.library.get() });
        get().toast(`已导入 ${ok.length} 本：${ok.map((r) => r.title).join('、')}`);
      }
      failed.forEach((r) => {
        const name = r.file.split(/[\/]/).pop() ?? r.file;
        get().toast(`导入失败 ${name}：${r.error}`, 'error');
      });
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      set({ importing: false, importProgress: null });
    }
  },

  removeBook: async (bookId) => {
    await window.aloud.books.remove(bookId);
    set({ library: await window.aloud.library.get() });
  },

  refreshStats: async () => set({ stats: await window.aloud.stats.get() }),

  navigate: (route) => {
    // One surface morphing into the next, not a hard swap. Guarded: the API only
    // exists in Chromium 111+, and a transition already in flight just applies.
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
    if (doc.startViewTransition) doc.startViewTransition(() => set({ route }));
    else set({ route });
  },

  toast: (message, tone = 'info') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, message, tone }] });
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 6000 : 3200);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/**
 * Settings and library writes are debounced so a slider drag is one write, not fifty.
 * That means a quit inside the debounce window would drop the change, so flush on the
 * way out: the IPC message is posted to the main process before the renderer tears down.
 */
export const flushPendingWrites = (): void => {
  persistSettings.flush();
  persistLibrary.flush();
};
window.addEventListener('beforeunload', flushPendingWrites);
window.addEventListener('pagehide', flushPendingWrites);

// Per-file import progress: a 100MB mobi takes long enough that a frozen "导入中…"
// reads as a hang.
window.aloud.onImportProgress((p) => {
  useStore.setState({ importProgress: p.total > 0 ? p : null });
});

/** Debug handle used by the smoke harness and by the devtools console. */
(window as unknown as { __aloudStore: typeof useStore }).__aloudStore = useStore;
