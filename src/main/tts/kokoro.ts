/**
 * Manager for the built-in Kokoro TTS server (tts-server/server.py).
 *
 * The reader auto-starts it on first use of the built-in voice and kills it on quit.
 * Scripts live in tts-server/ (dev: project root, packaged: resources/tts-server via
 * extraResources); the venv + model cache live in tts-server/runtime — deliberately NOT
 * under the user profile, which on this machine is both EFS-encrypted and subject to
 * MSIX virtualization (two different processes would see two different directories).
 */
import { app } from 'electron';
import { killTree } from './killTree';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const KOKORO_PORT = 8973;
const BASE = `http://127.0.0.1:${KOKORO_PORT}`;

let child: ChildProcess | null = null;
let starting: Promise<StartResult> | null = null;

export interface KokoroStatus {
  scriptsDir: string | null;
  installed: boolean;
  running: boolean;
  ready: boolean;
  voices: string[];
  error?: string;
}

export interface StartResult {
  ok: boolean;
  message: string;
}

export function scriptsDir(): string | null {
  const candidates = [
    process.env.ALOUD_TTS_DIR ?? '',
    // packaged: <win-unpacked>/resources/tts-server
    path.join(process.resourcesPath ?? '', 'tts-server'),
    // packaged inside the project tree: release/win-unpacked/../../tts-server
    path.resolve(path.dirname(app.getPath('exe')), '..', '..', 'tts-server'),
    // dev: launched from the project root
    path.resolve('tts-server'),
  ].filter((dir) => dir && fs.existsSync(path.join(dir, 'server.py')));
  if (!candidates.length) return null;
  // Prefer wherever the runtime is actually installed — the packaged resources copy has
  // the scripts but the 1GB venv/model usually live beside the project's copy.
  return candidates.find((dir) => fs.existsSync(venvPython(dir))) ?? candidates[0];
}

const runtimeDir = (dir: string): string => path.join(dir, 'runtime');
const venvPython = (dir: string): string => path.join(runtimeDir(dir), 'venv', 'Scripts', 'python.exe');

async function health(timeoutMs = 1200): Promise<{ ready: boolean; voices: string[] } | null> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const json = (await res.json()) as { ready?: boolean; voices?: string[] };
    return { ready: !!json.ready, voices: json.voices ?? [] };
  } catch {
    return null;
  }
}

export async function kokoroStatus(): Promise<KokoroStatus> {
  const dir = scriptsDir();
  const installed = !!dir && fs.existsSync(venvPython(dir));
  const live = await health(600);
  let voices = live?.voices ?? [];
  if (!voices.length && dir) {
    try {
      voices = JSON.parse(fs.readFileSync(path.join(runtimeDir(dir), 'voices.json'), 'utf8')) as string[];
    } catch {
      voices = [];
    }
  }
  return { scriptsDir: dir, installed, running: !!live, ready: !!live?.ready, voices };
}

/** Start the server if needed and wait until the model is ready. */
export async function ensureKokoro(): Promise<StartResult> {
  if (starting) return starting;
  starting = ensureInner().finally(() => {
    starting = null;
  });
  return starting;
}

async function ensureInner(): Promise<StartResult> {
  const live = await health(600);
  if (live?.ready) return { ok: true, message: '服务已就绪' };

  const dir = scriptsDir();
  if (!dir) return { ok: false, message: '找不到 tts-server 目录' };
  const python = venvPython(dir);
  if (!fs.existsSync(python)) {
    return { ok: false, message: `内置语音尚未安装：请运行 ${path.join(dir, 'install.bat')}（需联网，一次即可）` };
  }

  if (!child || child.exitCode !== null) {
    child = spawn(python, [path.join(dir, 'server.py'), '--port', String(KOKORO_PORT)], {
      cwd: dir,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ALOUD_KOKORO_DATA: runtimeDir(dir) },
    });
    child.on('exit', () => {
      child = null;
    });
  }

  // Model load takes a few seconds (first ever start may download nothing — warmup
  // already cached everything — but torch import alone is ~2-4s).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await health(1000);
    if (state?.ready) return { ok: true, message: '内置语音已启动' };
    await new Promise((r) => setTimeout(r, 700));
  }
  return { ok: false, message: '内置语音启动超时（60s）——看看 tts-server 目录下能否手动运行 run.bat' };
}

export function stopKokoro(): void {
  killTree(child);
  child = null;
}

// Belt and braces: `will-quit` is skipped by app.exit() and by a crash, and a stranded
// model server would hold the port against the next launch.
app.on('will-quit', stopKokoro);
app.on('before-quit', stopKokoro);
process.on('exit', stopKokoro);
