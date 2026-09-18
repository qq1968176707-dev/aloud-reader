/**
 * Run ONE piece of renderer JavaScript against a real window.
 *
 *   node scripts/probe.mjs <file.js> [--book 书名] [--live] [--kill]
 *
 * The full UI harness takes many minutes because it samples read-aloud in real time.
 * When you are iterating on a single behaviour that is a terrible feedback loop, so
 * this boots the same window, evaluates one expression, prints the JSON result and
 * quits. Same globals as `smoke.ts` (`window.__aloudStore`, `window.aloud`).
 *
 * The probe file's contents are evaluated as the body of an async IIFE.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import electronPath from 'electron';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node scripts/probe.mjs <file.js> [--book 书名]');
  process.exit(2);
}
const bookFlag = args.indexOf('--book');
const wantBook = bookFlag >= 0 ? args[bookFlag + 1] : '';

// Killing every Electron also kills a smoke suite running in another terminal — which
// looked exactly like the suite hanging, twice. Only clear the lock when asked.
if (args.includes('--kill')) {
  if (process.platform === 'win32') {
    for (const image of ['Aloud Reader.exe', 'electron.exe']) {
      spawnSync('taskkill', ['/F', '/IM', image, '/T'], { stdio: 'ignore' });
    }
  } else {
    spawnSync('pkill', ['-f', path.dirname(electronPath)], { stdio: 'ignore' });
  }
}

const out = path.resolve('probe-result.json');
rmSync(out, { force: true });

/*
 * A probe runs against an EMPTY throwaway profile unless told otherwise.
 *
 * Probes flip settings (spread, type size) and create books; an interrupted one used to
 * leave those behind in the library the user actually reads — that is how a real
 * `spread` preference got changed out from under them. Copying the real profile was the
 * first idea and the wrong one: it is 378 MB here, almost all of it books.
 *
 * `--live` opts into the real profile for probes that genuinely need the user's books.
 */
let profile;
if (!args.includes('--live')) profile = mkdtempSync(path.join(tmpdir(), 'aloud-probe-'));

const child = spawn(electronPath, ['.'], {
  env: {
    ...process.env,
    ALOUD_SMOKE_PROBE: path.resolve(file),
    ALOUD_SMOKE_OUT: out,
    ALOUD_SMOKE_BOOK: wantBook,
    ...(profile ? { ALOUD_SMOKE_USERDATA: profile } : {}),
  },
  stdio: 'ignore',
});
child.on('exit', (code) => {
  try {
    process.stdout.write(readFileSync(out, 'utf8'));
  } catch {
    console.error('no result written — the window probably failed to boot');
  }
  if (profile) rmSync(profile, { recursive: true, force: true });
  process.exit(code ?? 0);
});
