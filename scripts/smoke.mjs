/**
 * Verification harness runner (see src/main/smoke.ts).
 *
 *   node scripts/smoke.mjs import <book file>   run the import pipeline headlessly
 *   node scripts/smoke.mjs ui                   boot the real window and probe the DOM
 *
 * Requires `npm run build` first. Results are printed and written to smoke-result.json.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import electronPath from 'electron';

// A previous run (or the app itself) holds the single-instance lock, and a new instance
// would quit silently with code 0 — which looks exactly like a crash. Clear it first.
if (process.platform === 'win32') {
  for (const image of ['Aloud Reader.exe', 'electron.exe']) {
    spawnSync('taskkill', ['/F', '/IM', image, '/T'], { stdio: 'ignore' });
  }
}

const [mode, file] = process.argv.slice(2);
if (mode !== 'import' && mode !== 'ui') {
  console.error('usage: node scripts/smoke.mjs import <file> | node scripts/smoke.mjs ui');
  process.exit(2);
}
if (mode === 'import' && !file) {
  console.error('import mode needs a book file');
  process.exit(2);
}

const out = path.resolve('smoke-result.json');
rmSync(out, { force: true });

const env = { ...process.env, ALOUD_SMOKE_OUT: out };
if (mode === 'import') env.ALOUD_SMOKE = path.resolve(file);
else env.ALOUD_SMOKE_UI = '1';

const child = spawn(electronPath, ['.'], { env, stdio: 'ignore' });
child.on('exit', (code) => {
  try {
    process.stdout.write(readFileSync(out, 'utf8'));
  } catch {
    console.error('no result file written — the app probably crashed before the harness ran');
  }
  process.exit(code ?? 0);
});
