/**
 * App icons for the APK, rasterised from the same build/icon.html as every other icon.
 *
 *   node scripts/android-icons.mjs
 *
 * Android wants the square icon, a round one, and a "foreground" layer for adaptive
 * icons — the launcher masks that layer itself, so it needs the artwork inset or the
 * corners get shaved off. `npm run icon` renders both source images; this script only
 * downscales them into the density buckets.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SRC = path.resolve('build/icon.png');
const FG = path.resolve('build/pwa/icon-foreground.png');
const RES = path.resolve('android/app/src/main/res');
// Launcher icon sizes per density bucket (mdpi 48 … xxxhdpi 192).
const BUCKETS = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
];

if (!existsSync(SRC) || !existsSync(FG)) {
  console.error('build/icon.png or build/pwa/icon-foreground.png missing — run `npm run icon` first');
  process.exit(1);
}
if (process.platform !== 'darwin') {
  console.error('sips is macOS-only; regenerate the icons on the Mac and commit them');
  process.exit(1);
}

const sips = (args) => execFileSync('sips', args, { stdio: 'ignore' });

for (const [dir, size] of BUCKETS) {
  const out = path.join(RES, dir);
  mkdirSync(out, { recursive: true });
  sips(['-z', String(size), String(size), SRC, '--out', path.join(out, 'ic_launcher.png')]);
  sips(['-z', String(size), String(size), SRC, '--out', path.join(out, 'ic_launcher_round.png')]);
  sips(['-z', String(size), String(size), FG, '--out', path.join(out, 'ic_launcher_foreground.png')]);
}

console.log(`wrote Android launcher icons into ${path.relative(process.cwd(), RES)}/mipmap-*`);
