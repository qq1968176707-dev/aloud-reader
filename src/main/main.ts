import { BrowserWindow, Menu, app, net, protocol, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, ensureDirs, resolveInside } from './paths';
import { recordingPath } from './recordings';
import * as store from './store';
import { registerIpc, importableFromArgv } from './ipc';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const IS_DEV = !!DEV_URL;
const distDir = path.join(__dirname, '..', 'dist');

/**
 * Production is served from `aloud://app/` rather than `file://` for two reasons:
 * it gives the renderer a real origin (so localStorage / fetch behave normally), and it
 * lets us attach a strict CSP to every response, which `file://` cannot do.
 */
// The smoke harness records for real: a fake device delivers a silent stream without
// any permission prompt, so the whole recording pipeline runs end to end.
if (process.env.ALOUD_SMOKE_UI) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aloud',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  },
]);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' aloud: data: blob:",
  "media-src 'self' aloud: blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' aloud:",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

let win: BrowserWindow | null = null;
const getWindow = (): BrowserWindow | null => win;

function registerBookProtocol(): void {
  protocol.handle('aloud', async (request) => {
    const url = new URL(request.url);
    let file: string | null = null;

    if (url.host === 'app') {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      file = resolveInside(distDir, rel);
    } else if (url.host === 'book') {
      // aloud://book/<bookId>/<package-relative path>
      const parts = decodeURIComponent(url.pathname).replace(/^\/+/, '').split('/');
      const bookId = parts.shift();
      if (bookId) file = resolveInside(P.bookDir(bookId), parts.join('/'));
    } else if (url.host === 'recording') {
      // aloud://recording/<bookId>/<id> — playback of reading recordings.
      const parts = decodeURIComponent(url.pathname).replace(/^\/+/, '').split('/');
      const bookId = parts.shift();
      const id = parts.shift();
      if (bookId && id) file = recordingPath(bookId, id);
    } else if (url.host === 'ink-img') {
      // aloud://ink-img/<bookId>/<file> — pictures pasted onto the ink layer.
      const parts = decodeURIComponent(url.pathname).replace(/^\/+/, '').split('/');
      const bookId = parts.shift();
      if (bookId) file = resolveInside(P.inkImagesDir(bookId), parts.join('/'));
    }

    if (!file) return new Response('Forbidden', { status: 403 });

    const res = await net.fetch(pathToFileURL(file).toString());
    if (!res.ok) return new Response('Not found', { status: 404 });
    const headers = new Headers(res.headers);
    if (url.host === 'app') headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: 200, headers });
  });
}

function buildMenu(): void {
  const send = (channel: string, ...args: unknown[]) => () => win?.webContents.send(channel, ...args);
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '导入图书…', accelerator: 'CmdOrCtrl+O', click: send('menu', 'import') },
        { label: '返回书架', accelerator: 'CmdOrCtrl+L', click: send('menu', 'library') },
        { type: 'separator' },
        { label: '导出本书批注…', click: send('menu', 'export-annotations') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '分页模式', accelerator: 'CmdOrCtrl+1', click: send('menu', 'layout:paginated') },
        { label: '滚动模式', accelerator: 'CmdOrCtrl+2', click: send('menu', 'layout:scroll') },
        { type: 'separator' },
        { label: '白色', click: send('menu', 'theme:white') },
        { label: '棕褐', click: send('menu', 'theme:sepia') },
        { label: '灰色', click: send('menu', 'theme:gray') },
        { label: '夜间', click: send('menu', 'theme:night') },
        { type: 'separator' },
        { label: '增大字号', accelerator: 'CmdOrCtrl+Plus', click: send('menu', 'font:bigger') },
        { label: '减小字号', accelerator: 'CmdOrCtrl+-', click: send('menu', 'font:smaller') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '朗读',
      submenu: [
        { label: '开始 / 暂停', accelerator: 'CmdOrCtrl+Shift+Space', click: send('menu', 'ra:toggle') },
        { label: '上一行', accelerator: 'CmdOrCtrl+Up', click: send('menu', 'ra:prev') },
        { label: '下一行', accelerator: 'CmdOrCtrl+Down', click: send('menu', 'ra:next') },
        { type: 'separator' },
        { label: '加速', accelerator: 'CmdOrCtrl+Shift+.', click: send('menu', 'ra:faster') },
        { label: '减速', accelerator: 'CmdOrCtrl+Shift+,', click: send('menu', 'ra:slower') },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(P.root()) },
        { label: '图书包格式说明', click: send('menu', 'help:format') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const settings = store.getSettings();
  const bounds = settings.window ?? { width: 1320, height: 880 };
  const dark = settings.theme === 'night';

  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: dark ? '#111113' : '#f7f6f3',
    title: 'Aloud Reader',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: dark ? '#111113' : '#f7f6f3', symbolColor: dark ? '#e8e6e3' : '#3a3733', height: 44 }
        : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: false,
    },
  });

  if (bounds.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());

  // The only capability the page ever asks for is the microphone, and only when the user
  // clicks "record my voice". Everything else stays denied.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const wantsMicOnly =
      permission === 'media' && (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === 'audio') !== false;
    callback(wantsMicOnly);
  });

  const persistBounds = () => {
    if (!win) return;
    const s = store.getSettings();
    const b = win.getNormalBounds();
    s.window = { width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized() };
    store.saveSettings(s);
  };
  win.on('close', persistBounds);
  win.on('closed', () => {
    win = null;
  });

  // Never let book content navigate the shell or spawn windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = IS_DEV ? url.startsWith(DEV_URL!) : url.startsWith('aloud://app');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  if (IS_DEV) void win.loadURL(DEV_URL!);
  else void win.loadURL('aloud://app/index.html');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const files = importableFromArgv(argv);
    if (files.length) win.webContents.send('menu', 'import-files', files);
  });

  void app.whenReady().then(async () => {
    if (process.env.ALOUD_SMOKE) {
      const { runImportSmoke } = await import('./smoke');
      await runImportSmoke(process.env.ALOUD_SMOKE);
      return;
    }
    ensureDirs();
    store.init();
    registerBookProtocol();
    registerIpc(getWindow);
    buildMenu();
    createWindow();

    if (process.env.ALOUD_SMOKE_UI && win) {
      const { runUiSmoke } = await import('./smoke');
      await runUiSmoke(win);
      return;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
