/**
 * Desktop self-update.
 *
 * Windows: electron-updater against GitHub Releases — it reads `latest.yml` (or
 * `lite.yml` for the lite edition), downloads the NSIS installer in the background,
 * verifies its sha512 and runs it on quit / on "重启更新". Unsigned installers are fine.
 *
 * macOS: electron-updater's mac path is Squirrel.Mac, which refuses to install into an
 * app that is not signed with a Developer ID — and ours is ad-hoc signed. So the mac
 * path is our own and deliberately boring: ask GitHub for the latest release, download
 * the `.zip` for this chip and edition, unpack it next to us, check the version inside,
 * and when the app quits a detached shell script swaps the bundle and (if asked)
 * reopens it. Files fetched by the app itself carry no quarantine flag, so Gatekeeper
 * does not stop the new copy.
 *
 * Every check is silent unless the user asked for it: a flaky network in the morning is
 * not something to show a dialog about.
 */
import { app, BrowserWindow, net, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UPDATE_REPO, newerVersion, type UpdateState } from '@shared/types';
import { EDITION } from './edition';

const RELEASES = `https://github.com/${UPDATE_REPO}/releases/latest`;

let state: UpdateState = { kind: 'idle' };
let getWindow: () => BrowserWindow | null = () => null;
let manualCheck = false;

function emit(next: UpdateState): void {
  state = next;
  getWindow()?.webContents.send('update:state', next);
}

export const updateState = (): UpdateState => state;

/* ------------------------------------------------------------- Windows */

/** electron-builder's portable exe unpacks to a temp dir on every launch: nothing to update in place. */
const isPortable = (): boolean => !!process.env.PORTABLE_EXECUTABLE_DIR;

type AutoUpdater = typeof import('electron-updater').autoUpdater;
let win: AutoUpdater | null = null;

async function windowsUpdater(): Promise<AutoUpdater> {
  if (win) return win;
  // CJS package from an ESM main process: the named export lives on the default.
  const mod = await import('electron-updater');
  const au = (mod.default?.autoUpdater ?? mod.autoUpdater) as AutoUpdater;
  // The two editions ship side by side in one release; each reads its own manifest.
  au.channel = EDITION === 'lite' ? 'lite' : 'latest';
  // Setting a channel quietly turns downgrades on; a release is never older on purpose.
  au.allowDowngrade = false;
  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;
  au.logger = null;
  au.on('checking-for-update', () => emit({ kind: 'checking' }));
  au.on('update-available', (info) => emit({ kind: 'downloading', version: info.version, percent: 0 }));
  au.on('download-progress', (p) => {
    if (state.kind === 'downloading') emit({ ...state, percent: Math.round(p.percent) });
  });
  au.on('update-downloaded', (info) => emit({ kind: 'ready', version: info.version }));
  au.on('update-not-available', () =>
    emit(manualCheck ? { kind: 'latest', version: app.getVersion() } : { kind: 'idle' }),
  );
  au.on('error', (err) =>
    emit(manualCheck ? { kind: 'error', message: friendly(err) } : { kind: 'idle' }),
  );
  win = au;
  return au;
}

/* --------------------------------------------------------------- macOS */

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

/** The newest published release, or null when GitHub cannot be reached. */
async function latestRelease(): Promise<{ version: string; assets: ReleaseAsset[] } | null> {
  const res = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AloudReader-updater' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  const json = (await res.json()) as { tag_name: string; assets: ReleaseAsset[] };
  return { version: json.tag_name.replace(/^v/, ''), assets: json.assets };
}

/** `…/Aloud Reader.app`, from the executable inside it. */
const bundlePath = (): string => path.resolve(app.getPath('exe'), '..', '..', '..');

/**
 * Where swapping the bundle would fail: a mounted dmg, App Translocation (macOS runs an
 * app opened straight from Downloads out of a random read-only mount), or a folder we
 * cannot write. In those cases the only honest thing is "download it yourself".
 */
function macBlocker(): string | null {
  const bundle = bundlePath();
  if (bundle.startsWith('/Volumes/')) return '应用还在安装盘里运行——先把它拖进「应用程序」再打开';
  if (bundle.includes('/AppTranslocation/')) return '先把应用拖进「应用程序」再打开，macOS 才允许它自己更新';
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch {
    return '没有权限替换应用文件';
  }
  return null;
}

let staged: { version: string; app: string } | null = null;

async function download(url: string, to: string, version: string, size: number): Promise<void> {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(20 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`下载失败（${res.status}）`);
  const total = Number(res.headers.get('content-length')) || size || 0;
  const out = fs.createWriteStream(to);
  let got = 0;
  let lastPct = -1;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
    const pct = total ? Math.floor((got / total) * 100) : null;
    if (pct !== lastPct) {
      lastPct = pct ?? -1;
      emit({ kind: 'downloading', version, percent: pct });
    }
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
}

async function checkMac(): Promise<void> {
  if (staged) {
    emit({ kind: 'ready', version: staged.version });
    return;
  }
  emit({ kind: 'checking' });
  const latest = await latestRelease();
  if (!latest || !newerVersion(latest.version, app.getVersion())) {
    emit(manualCheck ? { kind: 'latest', version: app.getVersion() } : { kind: 'idle' });
    return;
  }
  const { version } = latest;
  const want = `AloudReader-${version}-${process.arch}-${EDITION}.zip`;
  const asset = latest.assets.find((a) => a.name === want);
  const blocker = macBlocker();
  if (!asset || blocker) {
    emit({ kind: 'manual', version, url: RELEASES });
    if (blocker && manualCheck) emit({ kind: 'error', message: blocker });
    return;
  }

  const dir = path.join(app.getPath('temp'), `aloud-update-${version}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, want);
  emit({ kind: 'downloading', version, percent: 0 });
  await download(asset.browser_download_url, zip, version, asset.size);

  // ditto keeps the bundle's symlinks and extended attributes intact; unzip does not.
  const unpacked = spawnSync('ditto', ['-x', '-k', zip, dir], { stdio: 'ignore' });
  const next = path.join(dir, 'Aloud Reader.app');
  if (unpacked.status !== 0 || !fs.existsSync(next)) throw new Error('解压新版本失败');
  const plist = spawnSync('defaults', ['read', path.join(next, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'], {
    encoding: 'utf8',
  });
  if (plist.stdout.trim() !== version) throw new Error(`下载的包版本不对（${plist.stdout.trim() || '读不出'}）`);
  fs.rmSync(zip, { force: true });

  staged = { version, app: next };
  emit({ kind: 'ready', version });
}

/**
 * Swap the bundle once this process is gone. Runs detached so it outlives us; keeps the
 * old copy until the new one is in place, and puts it back if the move fails.
 */
function installMac(relaunch: boolean): void {
  if (!staged) return;
  const script = path.join(path.dirname(staged.app), 'swap.sh');
  fs.writeFileSync(
    script,
    `#!/bin/bash
PID="$1"; TARGET="$2"; NEW="$3"; RELAUNCH="$4"
for _ in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
rm -rf "$TARGET.updating-old"
if mv "$TARGET" "$TARGET.updating-old" && mv "$NEW" "$TARGET"; then
  rm -rf "$TARGET.updating-old"
else
  [ -d "$TARGET.updating-old" ] && [ ! -d "$TARGET" ] && mv "$TARGET.updating-old" "$TARGET"
fi
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
[ "$RELAUNCH" = "1" ] && open "$TARGET"
`,
    { mode: 0o755 },
  );
  spawn('/bin/bash', [script, String(process.pid), bundlePath(), staged.app, relaunch ? '1' : '0'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  staged = null;
}

/* ------------------------------------------------------------- shared */

function friendly(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|timeout|aborted|net::/i.test(text)) return '连不上 GitHub（网络不通或被墙），稍后再试';
  if (/404/.test(text)) return '还没有发布过新版本';
  return text.split('\n')[0].slice(0, 160);
}

export async function checkForUpdates(manual = false): Promise<void> {
  manualCheck = manual;
  if (!app.isPackaged) {
    if (manual) emit({ kind: 'error', message: '开发版不做自动更新（打包后的版本才会）' });
    return;
  }
  if (state.kind === 'downloading' || state.kind === 'checking') return;
  try {
    if (process.platform === 'win32') {
      if (isPortable()) {
        const latest = await latestRelease();
        if (latest && newerVersion(latest.version, app.getVersion())) {
          emit({ kind: 'manual', version: latest.version, url: RELEASES });
        } else if (manual) {
          emit({ kind: 'latest', version: app.getVersion() });
        }
        return;
      }
      await (await windowsUpdater()).checkForUpdates();
    } else if (process.platform === 'darwin') {
      await checkMac();
    }
  } catch (err) {
    emit(manual ? { kind: 'error', message: friendly(err) } : { kind: 'idle' });
  }
}

/** "重启更新": install now and come back on the new version. */
export async function applyUpdate(): Promise<void> {
  if (state.kind === 'manual') {
    await shell.openExternal(state.url);
    return;
  }
  if (state.kind !== 'ready') return;
  if (process.platform === 'win32' && win) {
    win.quitAndInstall(false, true);
    return;
  }
  if (process.platform === 'darwin') {
    installMac(true);
    app.quit();
  }
}

export function initUpdater(getWin: () => BrowserWindow | null): void {
  getWindow = getWin;
  if (!app.isPackaged || process.env.ALOUD_SMOKE_UI || process.env.ALOUD_SMOKE) return;
  // Not at launch: the first seconds belong to opening the book, not to the network.
  setTimeout(() => void checkForUpdates(false), 8_000);
  // Long sessions (a book left open for days) still hear about releases.
  setInterval(() => void checkForUpdates(false), 6 * 60 * 60_000);
  // A downloaded mac update the user did not restart for goes in on the way out, like
  // Windows does with autoInstallOnAppQuit — but without reopening the app.
  app.on('will-quit', () => {
    if (process.platform === 'darwin' && staged) installMac(false);
  });
}
