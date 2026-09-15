/**
 * Manager for the voice-cloning server (tts-server/voxcpm_server.py).
 *
 * Mirrors kokoro.ts: the app starts it on demand and kills it on quit. Kept separate
 * because it has its own venv (PyTorch CUDA, ~5GB) that most users will never install.
 */
import { app } from 'electron';
import { killTree } from './killTree';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scriptsDir } from './kokoro';

export const VOXCPM_PORT = 8974;
const BASE = `http://127.0.0.1:${VOXCPM_PORT}`;

let child: ChildProcess | null = null;
let starting: Promise<{ ok: boolean; message: string }> | null = null;

const runtimeDir = (dir: string): string => path.join(dir, 'runtime-voxcpm');
const venvPython = (dir: string): string => path.join(runtimeDir(dir), 'venv', 'Scripts', 'python.exe');

export interface VoxcpmStatus {
  installed: boolean;
  running: boolean;
  ready: boolean;
  device: string;
  error?: string;
}

async function health(timeoutMs = 1200): Promise<{ ready: boolean; device: string } | null> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const json = (await res.json()) as { ready?: boolean; device?: string };
    return { ready: !!json.ready, device: json.device ?? 'cpu' };
  } catch {
    return null;
  }
}

export async function voxcpmStatus(): Promise<VoxcpmStatus> {
  const dir = scriptsDir();
  const installed = !!dir && fs.existsSync(venvPython(dir));
  const live = await health(600);
  return { installed, running: !!live, ready: !!live?.ready, device: live?.device ?? '' };
}

export async function ensureVoxcpm(): Promise<{ ok: boolean; message: string }> {
  if (starting) return starting;
  starting = (async () => {
    const live = await health(600);
    if (live?.ready) return { ok: true, message: `克隆引擎已就绪（${live.device}）` };

    const dir = scriptsDir();
    if (!dir) return { ok: false, message: '找不到 tts-server 目录' };
    const python = venvPython(dir);
    if (!fs.existsSync(python)) {
      return { ok: false, message: `克隆引擎未安装：请运行 ${path.join(dir, 'install-voxcpm.bat')}（约 5GB，一次即可）` };
    }
    if (!child || child.exitCode !== null) {
      child = spawn(python, [path.join(dir, 'voxcpm_server.py'), '--port', String(VOXCPM_PORT)], {
        cwd: dir,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, ALOUD_VOXCPM_DATA: runtimeDir(dir) },
      });
      child.on('exit', () => {
        child = null;
      });
    }
    // Loading a 0.5B model onto the GPU takes noticeably longer than Kokoro.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const state = await health(1500);
      if (state?.ready) return { ok: true, message: `克隆引擎已启动（${state.device}）` };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { ok: false, message: '克隆引擎启动超时（3 分钟）' };
  })().finally(() => {
    starting = null;
  });
  return starting;
}

export function stopVoxcpm(): void {
  killTree(child);
  child = null;
}

// Belt and braces: `will-quit` is skipped by app.exit() and by a crash, and a stranded
// model server would hold the port against the next launch.
app.on('will-quit', stopVoxcpm);
app.on('before-quit', stopVoxcpm);
process.on('exit', stopVoxcpm);
