/**
 * Packaging.
 *
 *   node scripts/dist.mjs --mac            完整版（含声音克隆）
 *   node scripts/dist.mjs --mac --lite     轻量版（不含声音克隆）
 *   node scripts/dist.mjs --win [--lite]
 *
 * With no platform flag it packages for the current OS. The renderer and the main
 * process are rebuilt here (not by a separate npm step) because the edition has to be
 * compiled into both — see src/main/edition.ts.
 *
 * electron-builder downloads its toolchain (winCodeSign, nsis) into the user's cache and
 * finishes each download with a rename. On a machine whose user profile is EFS-encrypted
 * that rename fails with "cannot move the file to a different disk drive" and the build
 * dies in a retry loop. Keeping the cache next to the project sidesteps it.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2).filter((a) => a !== '--lite');
const lite = process.argv.includes('--lite');
const edition = lite ? 'lite' : 'pro';
const cache = process.env.ELECTRON_BUILDER_CACHE ?? path.resolve('.eb-cache');
const env = { ...process.env, ALOUD_EDITION: edition, ELECTRON_BUILDER_CACHE: cache };

console.log(`\n=== 打包 ${edition === 'lite' ? '轻量版（无声音克隆）' : '完整版（含声音克隆）'} ===\n`);

const build = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit', env });
if (build.status) process.exit(build.status);

const platform = args.some((a) => a.startsWith('--mac') || a.startsWith('--win') || a.startsWith('--linux'))
  ? []
  : [process.platform === 'darwin' ? '--mac' : '--win'];
const passthrough = args.length ? args : ['--publish', 'never'];

// shell: true — Node >= 20 refuses to spawn .cmd shims directly on Windows.
const child = spawn(
  'npx',
  ['electron-builder', ...platform, ...passthrough, ...(args.includes('--publish') ? [] : ['--publish', 'never'])],
  { stdio: 'inherit', shell: true, env },
);
child.on('exit', (code) => process.exit(code ?? 0));
