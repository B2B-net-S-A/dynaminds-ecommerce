#!/usr/bin/env node
/** Runs test files one process each (node tsx --test <file>), the way scripts/test.ts and the local
 * run-one-db pattern do, and writes per-file logs, a summary and measured durations.
 *
 *   node scripts/ci/run-tests.mjs --kind static --out ci-out/static [--concurrency 4] <files… | --files-from list.txt>
 *   node scripts/ci/run-tests.mjs --kind db     --out ci-out/db     [--concurrency 1] <files…>
 *
 * --kind db: one database per file, named dynaminds_test_<13 digits> (the name guards in tests accept it),
 * copied from a template that is migrated once per run (CREATE DATABASE … TEMPLATE). Files listed under
 * "freshDatabase" in scripts/ci/test-classes.json, or calling bootstrap151169() (tests/catalog-stock-control169-fixture.ts
 * asserts an empty database), get an empty database and migrate themselves.
 * Guard answers are reused while their inputs are unchanged (scripts/ci/guard-cache.mjs, preloaded via NODE_OPTIONS);
 * files listed under "noGuardCache", or reading pg_stat_xact_* / track_functions themselves, run without it.
 * Requires DYNA_LOCAL_CONFIG_PATH (dbPassword) and DYNA_TEST_PG_PORT; PostgreSQL on 127.0.0.1.
 *
 * Exit code 1 when any file fails or times out. Never touches a database it did not create.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadConfig } from './classify-tests.mjs';
import { loadDurations } from './shard.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const kind = opt('--kind', 'static');
const out = opt('--out', 'ci-out/' + kind);
const concurrency = Math.max(1, Number(opt('--concurrency', kind === 'db' ? '1' : '4')));
const timeoutMin = Number(opt('--timeout-min', process.env.CI_FILE_TIMEOUT_MIN ?? (kind === 'db' ? '45' : '10')));
const filesFrom = opt('--files-from', null);
const listed = [...args, ...(filesFrom ? readFileSync(filesFrom, 'utf8').split('\n') : [])].map((s) => s.trim()).filter(Boolean);
// Several workers: longest measured file first, so the shard does not end with one long file running alone.
const measured = concurrency > 1 ? loadDurations() : {};
const files = concurrency > 1 ? [...listed].sort((a, b) => (measured[b] ?? 0) - (measured[a] ?? 0)) : listed;
if (!['static', 'db'].includes(kind)) throw new Error('--kind static|db');
mkdirSync(out, { recursive: true });
if (!files.length) {
  console.log(`Brak plików do uruchomienia (${kind}).`);
  writeFileSync(join(out, 'durations.json'), '{}\n');
  process.exit(0);
}

const TSX = join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const port = process.env.DYNA_TEST_PG_PORT;
let admin, password, template;
if (kind === 'db') {
  if (!process.env.DYNA_LOCAL_CONFIG_PATH || !port) throw new Error('db: wymagane DYNA_LOCAL_CONFIG_PATH i DYNA_TEST_PG_PORT');
  password = JSON.parse(readFileSync(process.env.DYNA_LOCAL_CONFIG_PATH, 'utf8')).dbPassword;
  const pg = (await import('pg')).default;
  admin = new pg.Client({ host: '127.0.0.1', port: Number(port), user: 'postgres', password, database: 'postgres' });
  await admin.connect();
}
const config = loadConfig();
const source = (file) => { try { return readFileSync(join(ROOT, file), 'utf8'); } catch { return ''; } };
const freshListed = new Set(Object.keys(config.freshDatabase ?? {}));
const fresh = { has: (file) => freshListed.has(file) || /\bbootstrap151169\(\)/.test(source(file)) };
const noGuardCacheListed = new Set(Object.keys(config.noGuardCache ?? {}));
const guardCacheFor = (file) => !noGuardCacheListed.has(file) && !/pg_stat_xact|pg_stat_user_functions|track_functions/.test(source(file));
const guardCacheEnv = (file) => guardCacheFor(file) ? {
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(join(ROOT, 'scripts/ci/guard-cache.mjs')).href}`.trim(),
  DYNA_CI_GUARD_CACHE: '1',
  DYNA_CI_GUARD_CACHE_STATS: join(out, basename(file) + '.guard-cache.jsonl'),
  DYNA_CI_GUARD_CACHE_FILE: join(out, fresh.has(file) ? '_guard-cache-fresh.jsonl' : '_guard-cache-template.jsonl'),
} : {};
const guardCacheSummary = (file) => {
  let rows; try { rows = readFileSync(join(out, basename(file) + '.guard-cache.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return ''; }
  const t = rows.reduce((a, r) => ({ hits: a.hits + r.hits, shared: a.shared + (r.sharedHits ?? 0), misses: a.misses + r.misses, bypassed: a.bypassed + r.bypassed, uncacheable: a.uncacheable + r.uncacheable, guardMs: a.guardMs + r.guardMs }), { hits: 0, shared: 0, misses: 0, bypassed: 0, uncacheable: 0, guardMs: 0 });
  const causes = {};
  for (const r of rows) for (const [c, n] of Object.entries(r.missBy ?? {})) causes[c] = (causes[c] ?? 0) + n;
  const top = Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => `${c}=${n}`).join(',');
  return ` guards=${t.hits}hit(${t.shared}shared)/${t.misses}miss(${Math.round(t.guardMs / 1000)}s:${top})/${t.bypassed}bypass/${t.uncacheable}uncacheable`;
};
const dbUrl = (name) => `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${name}`;
let nameSeq = Date.now();
const nextName = () => `dynaminds_test_${String(nameSeq++).padStart(13, '0')}`;

function run(file, env, logPath, asTest = true) {
  return new Promise((resolve) => {
    const log = createWriteStream(logPath);
    const started = Date.now();
    const child = spawn(process.execPath, asTest ? [TSX, '--test', '--test-concurrency=1', file] : [TSX, file], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group: tsx and node --test start children that hold the pipes; killing only the direct child
      // left them running (ebay-offers ran 92 min past the 45 min limit, run 43205055600).
      detached: true,
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMin * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end(timedOut ? `\n# CI: przekroczony limit ${timeoutMin} min — proces zabity\n` : '');
      resolve({ code: timedOut ? 124 : code ?? 1, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

async function prepareTemplate() {
  template = 'dynaminds_ci_template';
  await admin.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${template}`);
  const started = Date.now();
  const r = await run('scripts/ci/migrate-database.ts', { DATABASE_URL: dbUrl(template), DYNA_TEST: 'true' }, join(out, '_template-migrate.log'), false);
  if (r.code !== 0) {
    console.error(readFileSync(join(out, '_template-migrate.log'), 'utf8').slice(-4000));
    throw new Error('Migracja bazy-szablonu nie przeszła');
  }
  // Statistics are copied with the template: without them the native guards (e.g. pim_dictionary_valid(),
  // called by buildApp) plan blind on every fresh copy and come close to the 8 s statement_timeout
  // (server/db.ts). Local measurement 11.11.2026: 14 s before ANALYZE, 10 s after, on a loaded machine.
  const pg = (await import('pg')).default;
  const t = new pg.Client({ host: '127.0.0.1', port: Number(port), user: 'postgres', password, database: template });
  await t.connect();
  try { await t.query('ANALYZE'); } finally { await t.end(); }
  console.log(`Szablon ${template} zmigrowany i przeanalizowany w ${Math.round((Date.now() - started) / 1000)} s.`);
}

async function createDatabase(file) {
  const name = nextName();
  if (fresh.has(file)) await admin.query(`CREATE DATABASE ${name}`);
  else {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
    // The database ACL is not copied by TEMPLATE; migration 262 put it in the ledger (server/262_revoke_public_temporary.sql).
    await admin.query(`REVOKE TEMPORARY ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT TEMPORARY ON DATABASE ${name} TO postgres`);
  }
  return name;
}

const summary = join(out, 'summary.txt');
writeFileSync(summary, '');
const durations = {};
const failed = [];
if (kind === 'db' && files.some((f) => !fresh.has(f))) await prepareTemplate();

let next = 0;
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    const logPath = join(out, basename(file) + '.log');
    let env = {};
    let database;
    if (kind === 'db') {
      database = await createDatabase(file);
      env = { DATABASE_URL: dbUrl(database), DYNA_TEST: 'true', ...guardCacheEnv(file) };
    }
    const r = await run(file, env, logPath);
    if (database) await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch((e) => console.error(`DROP ${database}: ${e.message}`));
    durations[file] = r.seconds;
    const counts = (readFileSync(logPath, 'utf8').match(/^# (?:pass|fail) \d+/gm) ?? []).join(' ');
    const line = `${r.code === 0 ? 'ok  ' : 'FAIL'} ${file} exit=${r.code} ${counts} ${r.seconds}s${kind === 'db' ? guardCacheSummary(file) : ''}`;
    console.log(line);
    appendFileSync(summary, line + '\n');
    if (r.code !== 0) failed.push(file);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
if (kind === 'db') {
  if (template) await admin.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`).catch(() => {});
  await admin.end();
}
writeFileSync(join(out, 'durations.json'), JSON.stringify(Object.fromEntries(Object.entries(durations).sort()), null, 1) + '\n');
writeFileSync(join(out, 'failed.txt'), failed.length ? failed.join('\n') + '\n' : '');
console.log(`\n${kind}: ${files.length - failed.length}/${files.length} plików zielonych.`);
if (failed.length) {
  console.log('Nie przeszły:\n' + failed.map((f) => '  ' + f).join('\n'));
  process.exit(1);
}
