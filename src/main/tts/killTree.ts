import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Stop a model server and everything it started.
 *
 * `child.kill()` terminates only the PID we hold. A Python server that has forked a
 * dataloader or a torch worker leaves those behind, and they keep the port — so the next
 * launch finds the port busy and the app looks like it failed to start.
 *
 * - Windows: `taskkill /T /F` takes the whole tree.
 * - macOS/Linux: servers are spawned with `detached: true` (see `serverSpawnOptions`),
 *   which makes them process-group leaders, so signalling `-pid` reaches every child.
 */
export function killTree(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
      return;
    } catch {
      /* fall through to the portable path */
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      /* not a group leader (or already gone) — fall through */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Spawn options for a model server so `killTree` can take down the whole tree later. */
export const serverSpawnOptions = {
  windowsHide: true,
  stdio: 'ignore' as const,
  // POSIX: own process group, so killTree can signal -pid. Windows: detached would open
  // a console window, and taskkill /T does not need it.
  detached: process.platform !== 'win32',
};
