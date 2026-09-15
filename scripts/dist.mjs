/**
 * Windows packaging.
 *
 * electron-builder downloads its toolchain (winCodeSign, nsis) into
 * %LOCALAPPDATA%\electron-builder\Cache and finishes each download with a rename.
 * On a machine whose user profile is EFS-encrypted that rename fails with
 * "cannot move the file to a different disk drive" and the build dies in a retry loop.
 * Keeping the cache next to the project sidesteps it, so packaging works out of the box.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const cache = process.env.ELECTRON_BUILDER_CACHE ?? path.resolve('.eb-cache');
const args = process.argv.slice(2);

// shell: true — Node >= 20 refuses to spawn .cmd shims directly on Windows.
const child = spawn('npx', ['electron-builder', ...(args.length ? args : ['--win', '--publish', 'never'])], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ELECTRON_BUILDER_CACHE: cache },
});
child.on('exit', (code) => process.exit(code ?? 0));
