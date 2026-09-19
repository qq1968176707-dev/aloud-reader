/**
 * Self-update for the browser host — two very different mechanisms behind one API.
 *
 * iPad / any browser (the PWA): the service worker already fetches new builds; what was
 * missing is telling the page. The worker precaches the new shell and takes control
 * (skipWaiting + clients.claim), and the page used to keep running the old bundle until
 * the user happened to close the app twice. Now a control change right after launch
 * reloads straight into the new version, and one later in a session offers "刷新" —
 * never yanking a page someone is reading.
 *
 * Android (the APK): the app is a fixed bundle inside the package, so an update is a new
 * APK. We ask GitHub for the latest release, download it natively (ApkUpdaterPlugin)
 * and hand it to the system installer — which always asks the user to confirm; Android
 * allows nothing quieter.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { UPDATE_REPO, newerVersion, type HostUpdater, type UpdateState } from '@shared/types';
import { BASE } from './assets';
import { isNativeShell } from './nativeSpeech';

/** Baked in at build time from package.json (vite.web.config.ts). */
export const APP_VERSION = __APP_VERSION__;

type Listener = (s: UpdateState) => void;

function hub(): { emit: Listener; subscribe: (cb: Listener) => () => void; now: () => UpdateState } {
  let state: UpdateState = { kind: 'idle' };
  const listeners = new Set<Listener>();
  return {
    emit: (s) => {
      state = s;
      for (const cb of listeners) cb(s);
    },
    subscribe: (cb) => {
      listeners.add(cb);
      cb(state);
      return () => listeners.delete(cb);
    },
    now: () => state,
  };
}

/* ------------------------------------------------------------ Android */

interface ApkUpdaterPlugin {
  download(options: { url: string }): Promise<{ bytes: number }>;
  install(): Promise<void>;
  addListener(event: 'progress', cb: (p: { percent: number }) => void): Promise<PluginListenerHandle>;
}

function androidUpdater(): HostUpdater {
  const plugin = registerPlugin<ApkUpdaterPlugin>('ApkUpdater');
  const { emit, subscribe, now } = hub();
  let pending: { version: string; url: string } | null = null;

  const check = async (manual = false): Promise<void> => {
    const cur = now();
    if (cur.kind === 'downloading' || cur.kind === 'ready') return;
    try {
      emit({ kind: 'checking' });
      const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
      const json = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
      const version = json.tag_name.replace(/^v/, '');
      const apk = json.assets.find((a) => a.name === `AloudReader-${version}.apk`);
      if (!apk || !newerVersion(version, APP_VERSION)) {
        emit(manual ? { kind: 'latest', version: APP_VERSION } : { kind: 'idle' });
        return;
      }
      pending = { version, url: apk.browser_download_url };
      // Asks before downloading: a phone may be on metered data.
      emit({ kind: 'available', version });
    } catch (err) {
      emit(manual ? { kind: 'error', message: friendly(err) } : { kind: 'idle' });
    }
  };

  const download = async (): Promise<void> => {
    if (!pending) return;
    const { version, url } = pending;
    emit({ kind: 'downloading', version, percent: 0 });
    const progress = await plugin.addListener('progress', ({ percent }) =>
      emit({ kind: 'downloading', version, percent }),
    );
    try {
      await plugin.download({ url });
      emit({ kind: 'ready', version });
    } catch (err) {
      emit({ kind: 'error', message: friendly(err) });
    } finally {
      await progress.remove();
    }
  };

  const apply = async (): Promise<void> => {
    try {
      await plugin.install();
    } catch (err) {
      emit({ kind: 'error', message: friendly(err) });
    }
  };

  // Once per launch, a little after the shelf is on screen.
  setTimeout(() => void check(false), 6_000);
  return { check, download, apply, onState: subscribe };
}

/* ------------------------------------------------------ iPad / browser */

function pwaUpdater(): HostUpdater {
  const { emit, subscribe } = hub();
  const loadedAt = performance.now();
  // The very first visit also sees a controller change (no worker → the first one).
  // That is an install, not an update: nothing to reload into.
  const hadController = !!navigator.serviceWorker?.controller;
  let manual = false;
  /** Set once a newer worker has taken over: from then on this page's own
   *  APP_VERSION is stale, and "already latest" would be a wrong answer. */
  let updatedTo: string | null = null;

  const registration = (): Promise<ServiceWorkerRegistration | undefined> =>
    navigator.serviceWorker?.getRegistration(BASE) ?? Promise.resolve(undefined);

  /** Which version the freshly activated worker brought, for the banner's wording. */
  const deployedVersion = async (): Promise<string> => {
    try {
      const res = await fetch(`${BASE}version.json`, { cache: 'no-store' });
      return ((await res.json()) as { version: string }).version;
    } catch {
      return '新版本';
    }
  };

  navigator.serviceWorker?.addEventListener('controllerchange', () => {
    if (!hadController) return;
    // Right after launch nobody is reading yet: go straight to the new version.
    if (performance.now() - loadedAt < 10_000) {
      location.reload();
      return;
    }
    void deployedVersion().then((version) => {
      updatedTo = version;
      emit({ kind: 'ready', version });
    });
  });

  const check = async (asked = false): Promise<void> => {
    manual = asked;
    // The new version is already here and only needs a refresh — say that, whatever
    // the network check would find.
    if (updatedTo) {
      if (manual) emit({ kind: 'ready', version: updatedTo });
      return;
    }
    const reg = await registration();
    if (!reg) {
      if (manual) emit({ kind: 'error', message: '离线外壳还没装好，联网打开一次再试' });
      return;
    }
    try {
      await reg.update();
      // No new worker installing after the check = this is the newest.
      if (manual && !reg.installing && !reg.waiting) emit({ kind: 'latest', version: APP_VERSION });
    } catch (err) {
      if (manual) emit({ kind: 'error', message: friendly(err) });
    }
  };

  // Check when the app comes back to the foreground (an iPad app is resumed far more
  // often than it is launched) and every half hour while it stays open.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check(false);
  });
  setInterval(() => void check(false), 30 * 60_000);

  return {
    check,
    download: () => Promise.resolve(),
    apply: async () => location.reload(),
    onState: subscribe,
  };
}

function friendly(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/Failed to fetch|NetworkError|timeout|aborted|Load failed/i.test(text)) return '连不上更新服务器，稍后再试';
  return text.slice(0, 160);
}

export const createUpdater = (): HostUpdater => (isNativeShell() ? androidUpdater() : pwaUpdater());
