import { BrowserWindow, Menu, app, dialog, net, protocol, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, ensureDirs, resolveInside } from './paths';
import { recordingPath } from './recordings';
import * as store from './store';
import { registerIpc, importableFromArgv } from './ipc';
import { EDITION, HAS_CLONE } from './edition';
import { checkForUpdates, initUpdater } from './updater';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const IS_DEV = !!DEV_URL;
const distDir = path.join(__dirname, '..', 'dist');
const IS_MAC = process.platform === 'darwin';

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

/**
 * Send the harness's reads and writes to a throwaway profile.
 *
 * Import checks used to land in the real library, so verifying a parser change meant
 * adding duplicate books to whatever the user was reading. With this the same check
 * runs against an empty profile and leaves nothing behind.
 */
if (process.env.ALOUD_SMOKE_USERDATA) {
  app.setPath('userData', process.env.ALOUD_SMOKE_USERDATA);
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

const AUTHOR = 'qq1968176707-dev';
const COPYRIGHT = `Copyright © 2026 ${AUTHOR}\n保留所有权利 · All rights reserved`;
const EDITION_LABEL = HAS_CLONE ? '完整版（含声音克隆）' : '轻量版';

/** One place that says whose software this is — shown in ⌘ 关于 and in 帮助 › 关于. */
function aboutText(): string {
  return [
    `Aloud Reader · 逐读 ${app.getVersion()}`,
    EDITION_LABEL,
    '',
    `作者：${AUTHOR}`,
    COPYRIGHT,
    '',
    '未经作者书面授权，不得复制、分发、修改或反向工程本软件。',
  ].join('\n');
}

function showAbout(): void {
  if (process.platform === 'darwin') {
    app.showAboutPanel();
    return;
  }
  void dialog.showMessageBox(win ?? undefined!, {
    type: 'none',
    title: '关于 逐读',
    message: `Aloud Reader · 逐读 ${app.getVersion()}`,
    detail: aboutText().split('\n').slice(1).join('\n'),
    buttons: ['好'],
    noLink: true,
  });
}

function buildMenu(): void {
  const send = (channel: string, ...args: unknown[]) => () => win?.webContents.send(channel, ...args);
  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS: the first menu is always the app menu (about / hide / quit).
    ...(IS_MAC
      ? ([
          {
            label: app.name,
            submenu: [
              { label: `关于 ${app.name}`, click: showAbout },
              { label: '检查更新…', click: () => void checkForUpdates(true) },
              { type: 'separator' },
              { role: 'services', label: '服务' },
              { type: 'separator' },
              { role: 'hide', label: `隐藏 ${app.name}` },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: `退出 ${app.name}` },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: '文件',
      submenu: [
        { label: '导入图书…', accelerator: 'CmdOrCtrl+O', click: send('menu', 'import') },
        { label: '返回书架', accelerator: 'CmdOrCtrl+L', click: send('menu', 'library') },
        { type: 'separator' },
        { label: '导出本书批注…', click: send('menu', 'export-annotations') },
        { type: 'separator' },
        IS_MAC ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    // Without an Edit menu carrying these roles, ⌘C / ⌘V / ⌘A do nothing on macOS —
    // not in the search box, not in notes. Windows gets them from the OS.
    ...(IS_MAC
      ? ([
          {
            label: '编辑',
            submenu: [
              { role: 'undo', label: '撤销' },
              { role: 'redo', label: '重做' },
              { type: 'separator' },
              { role: 'cut', label: '剪切' },
              { role: 'copy', label: '拷贝' },
              { role: 'paste', label: '粘贴' },
              { role: 'selectAll', label: '全选' },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
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
    ...(IS_MAC
      ? ([
          {
            label: '窗口',
            role: 'window',
            submenu: [
              { role: 'minimize', label: '最小化' },
              { role: 'zoom', label: '缩放' },
              { type: 'separator' },
              { role: 'front', label: '前置全部窗口' },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
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
      role: IS_MAC ? 'help' : undefined,
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(P.root()) },
        { label: '图书包格式说明', click: send('menu', 'help:format') },
        ...(IS_MAC
          ? []
          : ([
              { type: 'separator' },
              { label: '检查更新…', click: () => void checkForUpdates(true) },
              { label: '关于 逐读', click: showAbout },
            ] as Electron.MenuItemConstructorOptions[])),
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
    titleBarStyle: 'hidden',
    // Centre the traffic lights on the 44px top bar (the renderer reserves room for them).
    trafficLightPosition: IS_MAC ? { x: 16, y: 15 } : undefined,
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
  // macOS hides the traffic lights in full screen; the top bar can take their space back.
  win.on('enter-full-screen', () => win?.webContents.send('window:fullscreen', true));
  win.on('leave-full-screen', () => win?.webContents.send('window:fullscreen', false));
  win.on('closed', () => {
    win = null;
    pageReady = false;
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

  // Books opened from Finder before the page was listening.
  win.webContents.once('did-finish-load', flushPendingOpens);

  if (IS_DEV) void win.loadURL(DEV_URL!);
  else void win.loadURL('aloud://app/index.html');
}

/**
 * macOS delivers files dropped on the Dock icon / "Open With" through `open-file`, not
 * argv, and it can fire before the app is ready. Queue them until the page can import.
 */
let pendingOpens: string[] = [];
let pageReady = false;
function flushPendingOpens(): void {
  pageReady = true;
  if (!win || !pendingOpens.length) return;
  const files = pendingOpens;
  pendingOpens = [];
  // Give the renderer a beat to mount its menu listener.
  setTimeout(() => win?.webContents.send('menu', 'import-files', files), 600);
}
app.on('open-file', (event, file) => {
  event.preventDefault();
  const files = importableFromArgv(['', file]);
  if (!files.length) return;
  if (win && pageReady) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('menu', 'import-files', files);
  } else {
    pendingOpens.push(...files);
    if (app.isReady() && !win) createWindow();
  }
});

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
    app.setAboutPanelOptions({
      applicationName: 'Aloud Reader · 逐读',
      applicationVersion: `${app.getVersion()} · ${EDITION_LABEL}`,
      version: EDITION,
      copyright: COPYRIGHT,
      credits: `作者：${AUTHOR}｜未经书面授权不得复制、分发或反向工程`,
    });
    ensureDirs();
    store.init();
    registerBookProtocol();
    registerIpc(getWindow);
    buildMenu();
    createWindow();
    initUpdater(getWindow);

    if (process.env.ALOUD_SMOKE_PROBE && win) {
      const { runProbe } = await import('./smoke');
      await runProbe(win, process.env.ALOUD_SMOKE_PROBE);
      return;
    }
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
