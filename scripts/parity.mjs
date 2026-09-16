/**
 * Parser regression check.
 *
 *   node scripts/parity.mjs            compare against the recorded baseline
 *   node scripts/parity.mjs --record   write today's results as the new baseline
 *
 * Re-imports every book listed in `parity-baseline.json` — real books on this machine,
 * not fixtures — into a throwaway profile, and compares chapter and word counts against
 * the recorded numbers. Parsing changes that are meant to be invisible (the move to
 * byte-based importers for the iPad build, say) must not move a single number.
 *
 * The baseline records results, never the books: the files stay wherever the user keeps
 * them, and a machine that lacks one simply skips it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import electronPath from 'electron';

const BASELINE = path.resolve('parity-baseline.json');
const record = process.argv.includes('--record');

if (!existsSync(BASELINE)) {
  console.error(`no baseline at ${BASELINE} — run with --record once to create it`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

const runImport = (file) => {
  const profile = mkdtempSync(path.join(tmpdir(), 'aloud-parity-'));
  const out = path.join(profile, 'result.json');
  try {
    // A stale instance holds the single-instance lock and the new one exits silently.
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/IM', 'electron.exe', '/T'], { stdio: 'ignore' });
    }
    spawnSync(electronPath, ['.'], {
      env: { ...process.env, ALOUD_SMOKE: file, ALOUD_SMOKE_OUT: out, ALOUD_SMOKE_USERDATA: profile },
      stdio: 'ignore',
      timeout: 600_000,
    });
    return JSON.parse(readFileSync(out, 'utf8'));
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
};

const results = [];
let same = 0;
let diff = 0;
let skipped = 0;

for (const entry of baseline.books) {
  const label = entry.title.slice(0, 30).padEnd(32);
  if (!existsSync(entry.file)) {
    skipped++;
    console.log(`skip  ${label} 本机没有这个文件`);
    continue;
  }
  const got = runImport(entry.file);
  if (!got.ok) {
    diff++;
    console.log(`FAIL  ${label} 导入失败：${String(got.error).slice(0, 80)}`);
    results.push({ ...entry, chapters: null, words: null });
    continue;
  }
  results.push({ ...entry, chapters: got.chapters, words: got.words });
  if (got.chapters === entry.chapters && got.words === entry.words) {
    same++;
    console.log(`same  ${label} ${got.chapters} 章 / ${got.words} 字`);
  } else {
    diff++;
    console.log(
      `DIFF  ${label} 基线 ${entry.chapters} 章/${entry.words} 字 → 现在 ${got.chapters} 章/${got.words} 字`,
    );
  }
}

console.log(`\n一致 ${same} · 不一致 ${diff} · 跳过 ${skipped}`);

if (record) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ recordedAt: new Date().toISOString(), books: results }, null, 2)}\n`,
    'utf8',
  );
  console.log(`baseline written → ${BASELINE}`);
  process.exit(0);
}
process.exit(diff ? 1 : 0);
