import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Stop a model server and everything it started.
 *
 * `child.kill()` on Windows terminates only the PID we hold. A Python server that has
 * forked a dataloader or a torch worker leaves those behind, and they keep the port —
 * so the next launch finds the port busy and the app looks like it failed to start.
 * `taskkill /T /F` takes the whole tree.
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
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}
