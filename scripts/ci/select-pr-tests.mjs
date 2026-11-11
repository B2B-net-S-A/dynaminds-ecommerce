#!/usr/bin/env node
/** PR sieve for the database tests (docs/ci/README.md). From the changed files of a PR picks:
 *   1. changed db test files themselves,
 *   2. db test files that import a changed module, directly or through other modules (reverse import graph),
 *      or are named after it (server/x.ts → tests/x*.test.*); nearest first (fewest import hops, then name),
 *      at most --limit files and, with --budget-min, at most that many estimated minutes (measured seconds from
 *      scripts/ci/test-durations.json, else estimateSec() in shard.mjs).
 * Changes that can break any test (server/db.ts, migrations server/*.sql, the migration manifest, package*.json,
 * tsconfig, the CI scripts and ci.yml) select the full db set instead. Static and special files never appear
 * here: static ones run in "CI Gate" on every PR, special ones are not run in CI.
 *
 *   node scripts/ci/select-pr-tests.mjs [--base origin/main] [--range A..B] [--changed-from list.txt] [--limit 40] [--budget-min M]
 *   → JSON {"mode":"full"|"selected"|"none","reason":…,"changed":n,"files":[…]}
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, classify, localImports } from './classify-tests.mjs';
import { estimateSec, loadDurations } from './shard.mjs';

export const FULL_TRIGGERS = [
  [/^server\/db\.ts$/, 'server/db.ts'],
  [/^server\/[^/]+\.sql$/, 'migracja server/*.sql'],
  [/^server\/migration-[^/]+\.ts$/, 'runner migracji'],
  [/migration-manifest\.mjs$/, 'manifest migracji'],
  [/^package(?:-lock)?\.json$/, 'package*.json'],
  [/^tsconfig\.json$/, 'tsconfig.json'],
  [/^scripts\/ci\//, 'skrypty CI'],
  [/^\.github\/workflows\/ci\.yml$/, 'ci.yml'],
];
const SOURCE = /\.(?:ts|tsx|mts|mjs|js)$/;

function gitLines(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
}

/** Reverse import graph over tracked sources: module → modules that import it. */
function reverseGraph() {
  const files = gitLines(['ls-files', 'server', 'shared', 'web', 'tests', 'scripts', 'tools']).filter((f) => SOURCE.test(f));
  const importers = new Map();
  for (const f of files) {
    let text;
    try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    for (const dep of localImports(f, text)) {
      if (!importers.has(dep)) importers.set(dep, []);
      importers.get(dep).push(f);
    }
  }
  return importers;
}

export function select(changed, { limit = 40, budgetMin = Infinity } = {}) {
  const cls = classify();
  const dbSet = new Set(cls.db);
  for (const f of changed) {
    const hit = FULL_TRIGGERS.find(([re]) => re.test(f));
    if (hit) return { mode: 'full', reason: `zmiana: ${f} (${hit[1]})`, changed: changed.length, files: cls.db };
  }
  const importers = reverseGraph();
  const distance = new Map();
  const queue = [];
  for (const f of changed) if (existsSync(join(ROOT, f))) { distance.set(f, 0); queue.push(f); }
  while (queue.length) {
    const cur = queue.shift();
    for (const imp of importers.get(cur) ?? []) {
      if (distance.has(imp)) continue;
      distance.set(imp, distance.get(cur) + 1);
      queue.push(imp);
    }
  }
  // A test named after a changed module (server/rodo228.ts → tests/rodo228*.test.*) counts as a direct importer.
  const stems = changed.filter((f) => SOURCE.test(f) && !/\.test\./.test(f)).map((f) => f.split('/').pop().replace(/\.[^.]+$/, ''));
  for (const t of dbSet) {
    const name = t.slice('tests/'.length);
    if (stems.some((st) => name.startsWith(st + '.') || name.startsWith(st + '-'))) distance.set(t, Math.min(distance.get(t) ?? 1, 1));
  }
  const hits = [...distance.entries()].filter(([f]) => dbSet.has(f))
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  if (!hits.length) return { mode: 'none', reason: 'żaden test db nie zależy od zmienionych plików', changed: changed.length, files: [] };
  // Nearest first until the file limit or the time budget (measured seconds, else estimateSec) is reached.
  const durations = loadDurations();
  const picked = [];
  let seconds = 0;
  for (const [f] of hits) {
    if (picked.length >= limit) break;
    const cost = durations[f] ?? estimateSec(f);
    if (picked.length && seconds + cost > budgetMin * 60) break;
    picked.push(f);
    seconds += cost;
  }
  const files = picked.sort();
  const byDepth = {};
  for (const [, d] of hits) byDepth[d] = (byDepth[d] ?? 0) + 1;
  const reason = hits.length > files.length
    ? `${hits.length} powiązanych testów db, wybrano ${files.length} najbliższych (limit ${limit} plików / ${budgetMin === Infinity ? 'bez budżetu' : budgetMin + ' min'}; reszta w nocnym pełnym biegu)`
    : `${hits.length} powiązanych testów db`;
  return { mode: 'selected', reason, changed: changed.length, byDepth, files };
}

function main(argv) {
  const opt = (name, dflt) => { const i = argv.indexOf(name); return i < 0 ? dflt : argv[i + 1]; };
  const from = opt('--changed-from', null);
  const range = opt('--range', null);
  const base = opt('--base', 'origin/main');
  const changed = from
    ? readFileSync(from, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
    : gitLines(['diff', '--name-only', range ?? `${base}...HEAD`]);
  const budget = opt('--budget-min', null);
  const result = select(changed, { limit: Number(opt('--limit', '40')), budgetMin: budget === null ? Infinity : Number(budget) });
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
