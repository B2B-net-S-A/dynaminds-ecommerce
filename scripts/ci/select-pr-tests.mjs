#!/usr/bin/env node
/** PR sieve for the database tests (docs/ci/README.md). From the changed files of a PR picks:
 *   1. changed db test files themselves,
 *   2. db test files that import a changed module, directly or through other modules (reverse import graph),
 *      or are named after it (server/x.ts → tests/x*.test.*); nearest first (fewest import hops, then name),
 *      at most --limit files and, with --budget-min, at most that many estimated minutes (measured seconds from
 *      scripts/ci/test-durations.json, else estimateSec() in shard.mjs).
 * Changes that can break any test never select the full db set here (decision 12.11.2026: the full set runs only
 * nightly and on workflow_dispatch). Instead:
 *   - server/db.ts, migrations server/*.sql, the migration runner/manifest → the "migration bundle" (MIGRATION_BUNDLE:
 *     ledger, migration, source-compatibility, cold, guard and *-contract db tests; for server/NNN_*.sql also the
 *     db tests whose name contains NNN) ahead of the related tests,
 *   - package*.json, tsconfig.json, the CI scripts and ci.yml → a smoke set (the SMOKE_SIZE fastest db files) plus
 *     the migration bundle ahead of the related tests.
 * Both stay inside --limit / --budget-min like every other selection. Static and special files never appear
 * here: static ones run in "CI Gate" on every PR, special ones are not run in CI.
 *
 *   node scripts/ci/select-pr-tests.mjs [--base origin/main] [--range A..B] [--changed-from list.txt] [--limit 40] [--budget-min M]
 *   → JSON {"mode":"selected"|"none","reason":…,"changed":n,"bundle":n,"smoke":n,"files":[…]}
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, classify, localImports } from './classify-tests.mjs';
import { estimateSec, loadDurations } from './shard.mjs';

/** Changes that touch the schema or its migration path: the migration bundle goes first. */
export const MIGRATION_TRIGGERS = [
  [/^server\/db\.ts$/, 'server/db.ts'],
  [/^server\/[^/]+\.sql$/, 'migracja server/*.sql'],
  [/^server\/migration-[^/]+\.ts$/, 'runner migracji'],
  [/migration-manifest\.mjs$/, 'manifest migracji'],
];
/** Changes that can break any test without touching a module: smoke set + migration bundle. */
export const SMOKE_TRIGGERS = [
  [/^package(?:-lock)?\.json$/, 'package*.json'],
  [/^tsconfig\.json$/, 'tsconfig.json'],
  [/^scripts\/ci\//, 'skrypty CI'],
  [/^\.github\/workflows\/ci\.yml$/, 'ci.yml'],
];
/** Migration bundle (by test file name), in priority order: migration path and seal guards, then contracts. */
export const MIGRATION_BUNDLE = [/migration|ledger|source-compatibility|cold|guard/, /-contract/];
export const SMOKE_SIZE = 10;
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

/** Number of a migration file: server/269_x.sql → "269", server/x-fragment169.sql → "169". */
export function migrationNumber(file) {
  const name = file.split('/').pop();
  return (name.match(/^(\d{3,})_/) ?? name.match(/(\d{3,})\.sql$/))?.[1] ?? null;
}

const triggerOf = (triggers, changed) => {
  for (const f of changed) {
    const hit = triggers.find(([re]) => re.test(f));
    if (hit) return `${f} (${hit[1]})`;
  }
  return null;
};

export function select(changed, { limit = 40, budgetMin = Infinity } = {}) {
  const cls = classify();
  const dbSet = new Set(cls.db);
  const durations = loadDurations();
  const cost = (f) => durations[f] ?? estimateSec(f);
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
  const related = [...distance.entries()].filter(([f]) => dbSet.has(f))
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([f]) => f);

  // Priority: changed db tests, tests of the changed migration numbers, smoke set, migration bundle, related tests.
  const migration = triggerOf(MIGRATION_TRIGGERS, changed);
  const smokeHit = triggerOf(SMOKE_TRIGGERS, changed);
  const ordered = [];
  const bundle = new Set();
  const smoke = new Set();
  const push = (f, set) => { if (!ordered.includes(f)) { ordered.push(f); set?.add(f); } };
  for (const f of related) if (distance.get(f) === 0) push(f);
  if (migration || smokeHit) {
    const byName = [...dbSet].sort();
    const numbers = [...new Set(changed.filter((f) => /^server\/[^/]+\.sql$/.test(f)).map(migrationNumber).filter(Boolean))];
    for (const n of numbers) {
      const re = new RegExp(`(?<!\\d)${n}(?!\\d)`);
      for (const f of byName) if (re.test(f.slice('tests/'.length))) push(f, bundle);
    }
    if (smokeHit) {
      for (const f of [...dbSet].sort((a, b) => cost(a) - cost(b) || (a < b ? -1 : 1)).slice(0, SMOKE_SIZE)) push(f, smoke);
    }
    for (const re of MIGRATION_BUNDLE) for (const f of byName) if (re.test(f.slice('tests/'.length))) push(f, bundle);
  }
  for (const f of related) push(f);
  if (!ordered.length) return { mode: 'none', reason: 'żaden test db nie zależy od zmienionych plików', changed: changed.length, files: [], bundle: 0, smoke: 0 };

  // In priority order until the file limit or the time budget (measured seconds, else estimateSec) is reached.
  const picked = [];
  let seconds = 0;
  for (const f of ordered) {
    if (picked.length >= limit) break;
    if (picked.length && seconds + cost(f) > budgetMin * 60) break;
    picked.push(f);
    seconds += cost(f);
  }
  const files = picked.sort();
  const byDepth = {};
  for (const f of related) byDepth[distance.get(f)] = (byDepth[distance.get(f)] ?? 0) + 1;
  const pickedBundle = files.filter((f) => bundle.has(f)).length;
  const pickedSmoke = files.filter((f) => smoke.has(f)).length;
  const parts = [];
  if (migration || smokeHit) parts.push(`zmiana: ${migration ?? smokeHit} → pakiet migracji ${pickedBundle}/${bundle.size}${smokeHit ? `, dymny ${pickedSmoke}/${smoke.size}` : ''}`);
  parts.push(`${related.length} powiązanych testów db`);
  const reason = ordered.length > files.length
    ? `${parts.join('; ')}; wybrano ${files.length} z ${ordered.length} (limit ${limit} plików / ${budgetMin === Infinity ? 'bez budżetu' : budgetMin + ' min'}; reszta w nocnym pełnym biegu)`
    : parts.join('; ');
  return { mode: 'selected', reason, changed: changed.length, bundle: pickedBundle, smoke: pickedSmoke, byDepth, files };
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
