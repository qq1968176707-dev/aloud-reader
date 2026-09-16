/**
 * In-app installer for the Python model runtimes.
 *
 * The scripts (install.sh / install.bat) are the same ones a user can run by hand, but
 * the app runs them itself and streams their output to the renderer, so downloading a
 * 5GB engine looks like a download — a button, a bar, a line of status — instead of a
 * terminal window the user is expected to babysit.
 *
 * Progress is honest rather than invented: pip prints no percentage, so the bar only
 * moves when the output actually carries one (huggingface_hub's tqdm does), and the
 * phase label comes from the line itself.
 */
import { BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killTree } from './killTree';
import { IS_WIN, runtimeDir, scriptFile, type RuntimeName } from './runtime';
import { scriptsDir } from './kokoro';

export type InstallName = 'kokoro' | 'voxcpm';

export interface InstallProgress {
  name: InstallName;
  /** 0-100 when the output carries a real percentage, else null. */
  percent: number | null;
  phase: string;
  line: string;
  running: boolean;
  ok?: boolean;
  message?: string;
}

const SPEC: Record<InstallName, { script: string; runtime: RuntimeName; label: string }> = {
  kokoro: { script: 'install', runtime: 'runtime', label: '内置语音' },
  voxcpm: { script: 'install-voxcpm', runtime: 'runtime-voxcpm', label: '声音克隆引擎' },
};

const jobs = new Map<InstallName, ChildProcess>();
const last = new Map<InstallName, InstallProgress>();

export const installState = (name: InstallName): InstallProgress =>
  last.get(name) ?? { name, percent: null, phase: '', line: '', running: false };

/** Which phase a line belongs to — enough to tell "still downloading" from "stuck". */
function phaseOf(line: string, previous: string): string {
  if (/Fetching \d+ files|snapshot|weights at|Downloading/i.test(line)) return '下载模型权重';
  if (/^Collecting|Downloading .*\.whl|Installing collected|Successfully installed|pip install/i.test(line))
    return '安装依赖';
  if (/creating virtual|venv|uv /i.test(line)) return '准备 Python 环境';
  if (/test synthesis|WARMUP_OK|voices cached/i.test(line)) return '首次合成自检';
  return previous;
}

function emit(win: BrowserWindow | null, p: InstallProgress): void {
  last.set(p.name, p);
  win?.webContents.send('tts:install-progress', p);
}

export function startInstall(name: InstallName, getWindow: () => BrowserWindow | null): InstallProgress {
  if (jobs.has(name)) return installState(name);
  const dir = scriptsDir();
  if (!dir) throw new Error('找不到 tts-server 目录');
  const spec = SPEC[name];
  const script = path.join(dir, scriptFile(spec.script));
  if (!fs.existsSync(script)) throw new Error(`找不到安装脚本：${script}`);
  const target = runtimeDir(dir, spec.runtime);
  fs.mkdirSync(target, { recursive: true });

  const child = IS_WIN
    ? spawn('cmd', ['/c', script, target], { cwd: dir, windowsHide: true })
    : spawn('/bin/bash', [script, target], { cwd: dir, detached: true });
  jobs.set(name, child);

  let phase = '准备 Python 环境';
  let percent: number | null = null;
  let tail = '';
  const onChunk = (buf: Buffer): void => {
    // tqdm redraws with \r and never ends its line — split on both.
    const text = tail + buf.toString('utf8');
    const parts = text.split(/[\r\n]+/);
    tail = parts.pop() ?? '';
    for (const raw of [...parts, tail]) {
      const line = raw.trim();
      if (!line) continue;
      phase = phaseOf(line, phase);
      const pct = /(\d{1,3})%\|/.exec(line) ?? /^\s*(\d{1,3})%/.exec(line);
      percent = pct ? Math.min(100, Number(pct[1])) : percent;
      emit(getWindow(), { name, percent, phase, line: line.slice(-200), running: true });
    }
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);

  child.on('exit', (code, signal) => {
    jobs.delete(name);
    const ok = code === 0;
    emit(getWindow(), {
      name,
      percent: ok ? 100 : percent,
      phase: ok ? '完成' : '未完成',
      line: '',
      running: false,
      ok,
      message: ok
        ? `${spec.label}安装完成`
        : signal
          ? `${spec.label}安装已取消`
          : `${spec.label}安装失败（退出码 ${code}）——上面最后几行说明了原因，网络问题重试即可继续（已下载的部分不会重来）`,
    });
  });

  const state: InstallProgress = { name, percent: null, phase, line: '开始安装…', running: true };
  emit(getWindow(), state);
  return state;
}

export function cancelInstall(name: InstallName): void {
  const child = jobs.get(name);
  if (!child) return;
  killTree(child);
  jobs.delete(name);
}

export const installRunning = (name: InstallName): boolean => jobs.has(name);

// Never leave a pip/download tree running after the window is gone.
export function stopAllInstalls(): void {
  for (const name of [...jobs.keys()]) cancelInstall(name);
}
