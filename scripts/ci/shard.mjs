#!/usr/bin/env node
/** Splits a list of test files into N shards, deterministically (same input → same split on every runner).
 * With measured durations (scripts/ci/test-durations.json, seconds per file) it uses LPT: longest file first
 * to the least loaded shard, ties by name and lowest shard index. Unmeasured files weigh --default-sec.
 * Unmeasured files weigh estimateSec() (from their number of tests) or a fixed --default-sec; with a fixed
 * weight and no measured file at all this degenerates to round-robin over the sorted list.
 *
 *   node scripts/ci/shard.mjs --count 4 --index 2 --files-from db.txt      files of shard 2 (0-based)
 *   node scripts/ci/shard.mjs --count 4 --out-dir plan --files-from db.txt  plan/shard-0.txt … shard-3.txt
 *   node scripts/ci/shard.mjs --plan --target-min 35 --max 20 --files-from db.txt
 *        → {"count":N,"shards":[0..N-1],"estimateMin":…,"perShardMin":[…]}
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './classify-tests.mjs';

const DURATIONS = join(ROOT, 'scripts/ci/test-durations.json');

export function loadDurations(path = DURATIONS) {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => !k.startsWith('$') && Number.isFinite(v) && v >= 0));
}

/** First-run weight of an unmeasured file: CI has no timings yet, and the number of test( calls tracks the
 * cost of these integration files far better than a flat default (local runs, 11.11.2026: 1 test ≈ 2–9 min,
 * 20+ tests ≈ 25–170 min under load). Replaced by measured seconds from scripts/ci/test-durations.json. */
export function estimateSec(file) {
  let text = '';
  try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { return 120; }
  const tests = (text.match(/(?:^|[^.\w])(?:test|it)\s*\(\s*['"`]/gm) ?? []).length;
  return 60 + 45 * Math.max(1, tests);
}

export function split(files, count, durations = {}, defaultSec = 120) {
  if (!Number.isInteger(count) || count < 1) throw new Error('count musi być liczbą całkowitą ≥ 1');
  const sorted = [...new Set(files)].sort();
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  const weight = (f) => durations[f] ?? (defaultSec === 'estimate' ? estimateSec(f) : defaultSec);
  if (defaultSec !== 'estimate' && !sorted.some((f) => f in durations)) {
    sorted.forEach((f, i) => { shards[i % count].files.push(f); shards[i % count].seconds += defaultSec; });
    return shards;
  }
  const order = [...sorted].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
  for (const f of order) {
    let best = 0;
    for (let i = 1; i < count; i++) if (shards[i].seconds < shards[best].seconds) best = i;
    shards[best].files.push(f);
    shards[best].seconds += weight(f);
  }
  for (const s of shards) s.files.sort();
  return shards;
}

/** Smallest N ≤ max whose slowest shard fits targetMin (job overhead included); max when nothing fits. */
export function plan(files, { targetMin, max, overheadMin = 4, durations = {}, defaultSec = 'estimate' }) {
  if (!files.length) return { count: 0, shards: [], estimateMin: 0, perShardMin: [] };
  const total = files.reduce((s, f) => s + (durations[f] ?? (defaultSec === 'estimate' ? estimateSec(f) : defaultSec)), 0);
  let count = Math.min(max, Math.max(1, Math.ceil(total / 60 / Math.max(1, targetMin - overheadMin))));
  let shards = split(files, count, durations, defaultSec);
  while (count < max && Math.max(...shards.map((s) => s.seconds)) / 60 + overheadMin > targetMin) {
    count++;
    shards = split(files, count, durations, defaultSec);
  }
  return {
    count,
    shards: shards.map((_, i) => i),
    estimateMin: Math.round(total / 60),
    perShardMin: shards.map((s) => Math.round(s.seconds / 60 + overheadMin)),
  };
}

function main(argv) {
  const opt = (name, dflt) => { const i = argv.indexOf(name); return i < 0 ? dflt : argv[i + 1]; };
  const from = opt('--files-from', null);
  const files = (from ? readFileSync(from, 'utf8') : readFileSync(0, 'utf8')).split('\n').map((s) => s.trim()).filter(Boolean);
  const durations = loadDurations(opt('--durations', DURATIONS));
  // Unmeasured file weight: 'estimate' (from its test count, default) or a fixed number of seconds.
  const dflt = opt('--default-sec', 'estimate');
  const defaultSec = dflt === 'estimate' ? 'estimate' : Number(dflt);
  if (argv.includes('--plan')) {
    const result = plan(files, {
      targetMin: Number(opt('--target-min', '35')), max: Number(opt('--max', '20')),
      overheadMin: Number(opt('--overhead-min', '4')), durations, defaultSec,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  const count = Number(opt('--count', '1'));
  const shards = split(files, count, durations, defaultSec);
  const outDir = opt('--out-dir', null);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    shards.forEach((s, i) => writeFileSync(join(outDir, `shard-${i}.txt`), s.files.join('\n') + (s.files.length ? '\n' : '')));
    shards.forEach((s, i) => console.log(`shard ${i}: ${s.files.length} plików, ~${Math.round(s.seconds / 60)} min`));
    return;
  }
  const index = Number(opt('--index', '0'));
  if (!(index >= 0 && index < count)) throw new Error(`--index poza zakresem 0..${count - 1}`);
  const list = shards[index].files;
  if (list.length) process.stdout.write(list.join('\n') + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
