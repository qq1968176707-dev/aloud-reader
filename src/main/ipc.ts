import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  type AnnotationFile,
  type RecordingMeta,
  type InkFile,
  type BookManifest,
  type EdgeSynthRequest,
  type ImportResult,
  type Library,
  type NotebookOptions,
  type LocalTtsConfig,
  type PlainIndex,
  type ReadingState,
  type Settings,
} from '@shared/types';
import { P, resolveInside } from './paths';
import * as store from './store';
import {
  SUPPORTED_EXTENSIONS,
  addNotebookPages,
  createNotebook,
  importFile,
  looksImportable,
  removeBook,
} from './import';
import { listEdgeVoices, synthesizeEdge } from './tts/edge';
import { synthesizeLocal, testLocal, type LocalSynthRequest } from './tts/local';
import { ensureKokoro, kokoroStatus, scriptsDir } from './tts/kokoro';
import { ensureVoxcpm, voxcpmStatus } from './tts/voxcpm';
import { deleteVoiceSample, saveVoiceSample, type SaveVoiceRequest } from './tts/voices';
import {
  appendRecording,
  beginRecording,
  deleteRecording,
  endRecording,
  listRecordings,
} from './recordings';
import { openInstaller, type RuntimeName } from './tts/runtime';
import { cancelInstall, installState, startInstall, type InstallName } from './tts/installer';
import { lookup } from './dictionary';
import { HAS_CLONE } from './edition';
import { applyUpdate, checkForUpdates, updateState } from './updater';

const readManifest = (bookId: string): BookManifest | null =>
  store.readJson<BookManifest | null>(P.manifest(bookId), null);

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  /* ------------------------------------------------------------- app */

  ipcMain.handle('app:dataDir', () => P.root());

  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http/https 链接');
    await shell.openExternal(url);
  });

  ipcMain.handle('app:revealBook', (_e, bookId: string) => {
    const dir = P.bookDir(bookId);
    if (fs.existsSync(dir)) shell.openPath(dir);
  });

  ipcMain.handle('app:titlebar', (_e, colors: { color: string; symbolColor: string }) => {
    const win = getWindow();
    if (!win || process.platform !== 'win32') return;
    try {
      win.setTitleBarOverlay({ ...colors, height: 44 });
    } catch {
      /* overlay not available on this platform/config */
    }
  });

  /* --------------------------------------------------------- library */

  ipcMain.handle('library:get', (): Library => store.getLibrary());
  ipcMain.handle('library:save', (_e, lib: Library) => store.saveLibrary(lib));

  ipcMain.handle('books:import', async (_e, paths?: string[]): Promise<ImportResult[]> => {
    let files = paths;
    if (!files?.length) {
      const win = getWindow();
      const result = await dialog.showOpenDialog(win!, {
        title: '导入图书',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '电子书', extensions: SUPPORTED_EXTENSIONS },
          { name: 'EPUB', extensions: ['epub'] },
          { name: 'Kindle', extensions: ['mobi', 'azw', 'azw3', 'prc'] },
          { name: 'PDF', extensions: ['pdf'] },
          { name: 'Aloud 图书包', extensions: ['zip', 'aloudbook'] },
          // Downloads often keep a browser's temp extension (.crswap, .part). The format
          // is detected from the file header, so let those through.
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.canceled) return [];
      files = result.filePaths;
    }
    const out: ImportResult[] = [];
    for (const file of files) {
      const win = getWindow();
      win?.webContents.send('books:import-progress', { file, done: out.length, total: files.length });
      out.push(await importFile(file));
    }
    return out;
  });

  ipcMain.handle('books:create', (_e, opts: NotebookOptions): ImportResult => createNotebook(opts));
  ipcMain.handle('books:add-pages', (_e, bookId: string, count: number): number =>
    addNotebookPages(bookId, count),
  );

  ipcMain.handle('books:remove', (_e, bookId: string) => removeBook(bookId));
  ipcMain.handle('books:manifest', (_e, bookId: string) => readManifest(bookId));
  ipcMain.handle('books:plain', (_e, bookId: string) =>
    store.readJson<PlainIndex | null>(P.plain(bookId), null),
  );

  ipcMain.handle('books:chapter', (_e, bookId: string, chapterId: string): string => {
    const manifest = readManifest(bookId);
    const ref = manifest?.readingOrder.find((c) => c.id === chapterId);
    if (!ref) throw new Error(`章节不存在：${chapterId}`);
    const file = resolveInside(P.bookDir(bookId), ref.href);
    if (!file) throw new Error('非法的章节路径');
    return fs.readFileSync(file, 'utf8');
  });

  /* ----------------------------------------------------------- state */

  ipcMain.handle('state:get', (_e, bookId: string): ReadingState => store.getState(bookId));
  ipcMain.handle('state:save', (_e, s: ReadingState) => store.saveState(s));

  ipcMain.handle('annotations:get', (_e, bookId: string): AnnotationFile => store.getAnnotations(bookId));
  ipcMain.handle('annotations:save', (_e, a: AnnotationFile) => store.saveAnnotations(a));

  ipcMain.handle('ink:get', (_e, bookId: string) => store.getInk(bookId));
  ipcMain.handle('ink:save', (_e, f: InkFile) => {
    store.saveInk(f);
    // GC pictures no item references any more (deleted stickers).
    try {
      const dir = P.inkImagesDir(f.bookId);
      if (fs.existsSync(dir)) {
        const used = new Set(f.strokes.map((s) => (s as { file?: string }).file).filter(Boolean));
        for (const name of fs.readdirSync(dir)) {
          if (!used.has(name)) fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    } catch {
      /* cosmetic cleanup only */
    }
  });

  /** Copy user-picked pictures into the book's ink dir; renderer measures + anchors. */
  ipcMain.handle('ink:import-images', async (_e, bookId: string): Promise<string[]> => {
    if (!/^[a-z0-9-]+$/i.test(bookId)) return [];
    const win = getWindow();
    if (!win) return [];
    const picked = await dialog.showOpenDialog(win, {
      title: '插入图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (picked.canceled) return [];
    const dir = P.inkImagesDir(bookId);
    fs.mkdirSync(dir, { recursive: true });
    const out: string[] = [];
    for (const src of picked.filePaths) {
      const name = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${path.extname(src).toLowerCase() || '.png'}`;
      try {
        fs.copyFileSync(src, path.join(dir, name));
        out.push(name);
      } catch {
        /* skip unreadable file */
      }
    }
    return out;
  });

  /** Clipboard picture (Ctrl+V onto the page) → PNG in the ink dir, or null. */
  ipcMain.handle('ink:paste-image', (_e, bookId: string): string | null => {
    if (!/^[a-z0-9-]+$/i.test(bookId)) return null;
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const dir = P.inkImagesDir(bookId);
    fs.mkdirSync(dir, { recursive: true });
    const name = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`;
    fs.writeFileSync(path.join(dir, name), img.toPNG());
    return name;
  });

  ipcMain.handle('settings:get', (): Settings => store.getSettings());
  ipcMain.handle('settings:save', (_e, s: Settings) => store.saveSettings(s));

  /* ----------------------------------------------------------- stats */

  ipcMain.handle('stats:get', () => store.getStats());

  ipcMain.handle('stats:add', (_e, bookId: string, seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) return store.getStats();
    const stats = store.getStats();
    const day = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local time
    stats.days[day] = (stats.days[day] ?? 0) + seconds;
    stats.byBook[bookId] = (stats.byBook[bookId] ?? 0) + seconds;
    store.saveStats(stats);
    return stats;
  });

  ipcMain.handle('stats:finish', (_e, bookId: string, title: string) => {
    const stats = store.getStats();
    if (!stats.finished.some((f) => f.bookId === bookId)) {
      stats.finished.push({ bookId, title, at: new Date().toISOString() });
      store.saveStats(stats);
    }
    return stats;
  });

  /* ------------------------------------------------------------- tts */

  ipcMain.handle('tts:edgeVoices', () => listEdgeVoices());
  ipcMain.handle('tts:edgeSynth', (_e, req: EdgeSynthRequest) => synthesizeEdge(req));
  ipcMain.handle('tts:localSynth', (_e, req: LocalSynthRequest) => synthesizeLocal(req));
  ipcMain.handle('tts:localTest', (_e, config: LocalTtsConfig) => testLocal(config));
  ipcMain.handle('tts:kokoroStatus', () => kokoroStatus());
  ipcMain.handle('tts:kokoroStart', () => ensureKokoro());
  // In-app install (button + progress bar). The terminal path stays available for
  // anyone who wants to watch pip themselves, or to retry after a failure.
  ipcMain.handle('tts:install', (_e, name: InstallName) => {
    if (name === 'voxcpm' && !HAS_CLONE) throw new Error('这个版本不含声音克隆引擎');
    return startInstall(name, getWindow);
  });
  ipcMain.handle('tts:installState', (_e, name: InstallName) => installState(name));
  ipcMain.handle('tts:installCancel', (_e, name: InstallName) => cancelInstall(name));
  const runInstaller = (base: string, runtime: RuntimeName, title: string): void => {
    const dir = scriptsDir();
    if (!dir) throw new Error('找不到 tts-server 目录');
    openInstaller(dir, base, runtime, title);
  };
  ipcMain.handle('tts:kokoroInstall', () => runInstaller('install', 'runtime', '内置语音安装'));
  ipcMain.handle('tts:voxcpmInstall', () => {
    if (!HAS_CLONE) throw new Error('这个版本不含声音克隆引擎');
    runInstaller('install-voxcpm', 'runtime-voxcpm', '声音克隆引擎安装');
  });
  ipcMain.handle('tts:voxcpmStatus', () =>
    HAS_CLONE ? voxcpmStatus() : { installed: false, running: false, ready: false, device: '', error: '这个版本不含声音克隆引擎' },
  );
  ipcMain.handle('tts:voxcpmStart', () =>
    HAS_CLONE ? ensureVoxcpm() : { ok: false, message: '这个版本不含声音克隆引擎' },
  );

  ipcMain.handle('voice:save', (_e, req: SaveVoiceRequest) => saveVoiceSample(req));
  ipcMain.handle('voice:delete', (_e, file: string) => deleteVoiceSample(file));

  /* ------------------------------------------------------ recordings */

  ipcMain.handle('recording:begin', (_e, bookId: string) => beginRecording(bookId));
  ipcMain.handle('recording:chunk', (_e, id: string, pcm: string) => appendRecording(id, pcm));
  ipcMain.handle('recording:end', (_e, id: string, meta: { title: string; timeline: RecordingMeta['timeline'] }) =>
    endRecording(id, meta),
  );
  ipcMain.handle('recordings:list', (_e, bookId: string) => listRecordings(bookId));
  ipcMain.handle('recording:delete', (_e, bookId: string, id: string) => deleteRecording(bookId, id));

  /* ------------------------------------------------------------ misc */

  ipcMain.handle('dict:lookup', (_e, word: string) => lookup(word));

  ipcMain.handle('update:check', (_e, manual?: boolean) => checkForUpdates(!!manual));
  ipcMain.handle('update:apply', () => applyUpdate());
  ipcMain.handle('update:state', () => updateState());

  // Test harness only: lets the smoke run reproduce windowed-mode layout. Inert in
  // normal sessions so a stray renderer call cannot yank the user's window around.
  ipcMain.handle('smoke:resize', (_e, w: number, h: number) => {
    if (!process.env.ALOUD_SMOKE_UI) return;
    const win = getWindow();
    if (!win) return;
    // A fractional w is a zoom factor: reproduces display-scaling geometry (125% scaling
    // makes every CSS viewport height fractional, which integer-px layouts get wrong).
    if (w > 0 && w < 4) {
      win.webContents.setZoomFactor(w);
      return;
    }
    if (!w || !h) win.maximize();
    else {
      win.unmaximize();
      win.setBounds({ width: Math.round(w), height: Math.round(h) });
    }
  });

  ipcMain.handle('dialog:saveText', async (_e, defaultName: string, content: string) => {
    const win = getWindow();
    const result = await dialog.showSaveDialog(win!, {
      title: '导出',
      defaultPath: defaultName,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '纯文本', extensions: ['txt'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, content, 'utf8');
    return result.filePath;
  });
}

/** Files dropped on the window / passed on argv. */
export const importableFromArgv = (argv: string[]): string[] =>
  argv
    .slice(1)
    .filter((a) => fs.existsSync(a))
    .filter((a) => looksImportable(a));
