/** scripts/ci/guard-cache.mjs reuses a guard answer only while its inputs are unchanged. A guard here announces
 * every real run with RAISE NOTICE; a reused answer arrives without one. Own probe objects only (ci_guard_probe*). */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.equal(process.env.DYNA_TEST, 'true');
const url = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.match(url.pathname, /^\/dynaminds_test_\d+$/);
process.env.DYNA_CI_GUARD_CACHE = '1';
const { GUARD_QUERY } = await import('../scripts/ci/guard-cache.mjs');
assert.equal((pg.Client.prototype as any).__dynaGuardCache, true, 'preload installed');

// Roles are cluster-wide: one per database copy, dropped afterwards.
const reader = 'ci_guard_probe_' + url.pathname.slice('/dynaminds_test_'.length);
const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
let runs: string[] = [];
const watch = (c: pg.Client) => c.on('notice', (n) => { if (n.message?.startsWith('probe-ran:')) runs.push(n.message); });
async function call(c: pg.Client, text = 'SELECT ci_guard_probe_valid() ok') {
  runs = [];
  const r = await c.query(text);
  return { ok: r.rows[0].ok, ran: runs.length > 0 };
}
before(async () => {
  await owner.connect(); await other.connect(); watch(owner); watch(other);
  await owner.query(`CREATE ROLE ${reader}`);
  await owner.query(`CREATE TABLE ci_guard_probe(id int PRIMARY KEY, good boolean NOT NULL)`);
  await owner.query(`CREATE TABLE ci_guard_probe_pid(backend_pid int)`);
  await owner.query(`INSERT INTO ci_guard_probe VALUES (1, true)`);
  await owner.query(`CREATE FUNCTION ci_guard_probe_valid() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
    BEGIN RAISE NOTICE 'probe-ran:%', pg_backend_pid();
    RETURN (SELECT bool_and(good) FROM ci_guard_probe) AND coalesce(current_setting('ci.probe', true), '') <> 'off'; END $$`);
  await owner.query(`CREATE TABLE ci_guard_probe_log(at timestamptz)`);
  await owner.query(`CREATE FUNCTION ci_guard_probe_volatile() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
    BEGIN RAISE NOTICE 'probe-ran:v'; RETURN (SELECT bool_and(good) FROM ci_guard_probe); END $$`);
  await owner.query(`CREATE FUNCTION ci_guard_probe_writes() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
    BEGIN RAISE NOTICE 'probe-ran:w'; INSERT INTO ci_guard_probe_log VALUES (clock_timestamp()); RETURN true; END $$`);
  await owner.query(`CREATE FUNCTION ci_guard_probe_raises() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
    BEGIN RAISE NOTICE 'probe-ran:e'; RAISE EXCEPTION 'probe refused' USING ERRCODE = 'P0001'; END $$`);
  await owner.query(`CREATE FUNCTION ci_guard_probe_fence_valid() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
    BEGIN RAISE NOTICE 'probe-ran:f'; RETURN NOT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND objid=982376); END $$`);
  await owner.query(`CREATE FUNCTION ci_guard_probe_own_fence_valid() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
    BEGIN RAISE NOTICE 'probe-ran:o';
    RETURN EXISTS(SELECT FROM pg_locks l WHERE l.locktype='advisory' AND l.pid=pg_backend_pid() AND l.objid=982377); END $$`);
  await owner.query(`CREATE FUNCTION ci_guard_probe_pid_valid() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
    BEGIN RAISE NOTICE 'probe-ran:p'; RETURN EXISTS(SELECT FROM ci_guard_probe_pid WHERE backend_pid = pg_backend_pid()); END $$`);
  await owner.query(`GRANT EXECUTE ON FUNCTION ci_guard_probe_valid() TO ${reader}`);
  await owner.query(`GRANT SELECT ON ci_guard_probe TO ${reader}`);
});
after(async () => {
  await owner.query(`DROP OWNED BY ${reader}`);
  await owner.query(`DROP ROLE ${reader}`);
  for (const c of [owner, other]) await c.end();
});

test('only zero-argument call lists are guard-shaped', () => {
  for (const q of ['SELECT a_valid() ok', 'SELECT public.a_guards() ok,b_installed() installed', 'SELECT a_installed() AND a_guards() AS ok',
    'SELECT (SELECT count(*)::integer FROM public.a_certificate) certificate_count,public.a_valid() valid'])
    assert.match(q, GUARD_QUERY);
  for (const q of ['SELECT a_valid($1) ok', 'SELECT a_valid() ok FROM t', "SELECT to_regclass('x') ok", 'SELECT 1; SELECT a_valid()',
    'SELECT (SELECT count(*) FROM a WHERE b) n'])
    assert.doesNotMatch(q, GUARD_QUERY);
});

test('the same state answers from the cache, also on another connection', async () => {
  assert.deepEqual(await call(owner), { ok: true, ran: true });
  assert.deepEqual(await call(owner), { ok: true, ran: false });
  assert.deepEqual(await call(other), { ok: true, ran: false });
});

test('a changed row the guard read runs it again', async () => {
  await owner.query('UPDATE ci_guard_probe SET good=false WHERE id=1');
  assert.deepEqual(await call(owner), { ok: false, ran: true });
  await owner.query('UPDATE ci_guard_probe SET good=true WHERE id=1');
  assert.deepEqual(await call(other), { ok: true, ran: true });
  await owner.query('INSERT INTO ci_guard_probe VALUES (2, false)');
  assert.deepEqual(await call(owner), { ok: false, ran: true });
  await owner.query('DELETE FROM ci_guard_probe WHERE id=2');
  assert.deepEqual(await call(owner), { ok: true, ran: false }, 'the same row versions as two calls ago');
});

test('a replaced function body or other DDL runs it again', async () => {
  assert.deepEqual(await call(owner), { ok: true, ran: false });
  await owner.query('ALTER TABLE ci_guard_probe ADD COLUMN note text');
  assert.deepEqual(await call(owner), { ok: true, ran: true });
  await owner.query(`CREATE OR REPLACE FUNCTION ci_guard_probe_valid() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
    BEGIN RAISE NOTICE 'probe-ran:%', pg_backend_pid(); RETURN false; END $$`);
  assert.deepEqual(await call(owner), { ok: false, ran: true });
  await owner.query(`CREATE OR REPLACE FUNCTION ci_guard_probe_valid() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
    BEGIN RAISE NOTICE 'probe-ran:%', pg_backend_pid();
    RETURN (SELECT bool_and(good) FROM ci_guard_probe) AND coalesce(current_setting('ci.probe', true), '') <> 'off'; END $$`);
  assert.deepEqual(await call(owner), { ok: true, ran: true });
});

test('uncommitted changes of the own transaction are seen, and a rollback restores the cached answer', async () => {
  assert.deepEqual(await call(owner), { ok: true, ran: false });
  await owner.query('BEGIN');
  await owner.query('UPDATE ci_guard_probe SET good=false WHERE id=1');
  assert.deepEqual(await call(owner), { ok: false, ran: true });
  assert.deepEqual(await call(owner), { ok: false, ran: false });
  assert.deepEqual(await call(other), { ok: true, ran: false }, 'the other session still sees the committed row');
  await owner.query('ROLLBACK');
  assert.deepEqual(await call(owner), { ok: true, ran: false });
});

test('session settings and the role are part of the key; placeholders and locks only for a guard that reads them', async () => {
  await owner.query("SET search_path = public, pg_catalog");
  assert.deepEqual(await call(owner), { ok: true, ran: true });
  await owner.query('RESET search_path');
  await owner.query("SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000001', false)");
  assert.deepEqual(await call(owner), { ok: true, ran: true }, 'the probe reads current_setting()');
  await owner.query("SELECT set_config('app.tenant_id', '', false)");
  await owner.query("SET ci.probe = 'off'");
  assert.deepEqual(await call(owner), { ok: false, ran: true });
  await owner.query('RESET ci.probe');
  assert.equal((await call(owner)).ok, true);
  const fence = 'SELECT ci_guard_probe_fence_valid() ok';
  assert.deepEqual(await call(owner, fence), { ok: true, ran: true });
  await owner.query('SELECT pg_advisory_lock(982376)');
  assert.deepEqual(await call(owner), { ok: true, ran: false }, 'the probe never looks at locks');
  assert.deepEqual(await call(owner, fence), { ok: false, ran: true });
  await owner.query('SELECT pg_advisory_unlock(982376)');
  assert.deepEqual(await call(owner, fence), { ok: true, ran: false });
  await owner.query(`SET ROLE ${reader}`);
  assert.deepEqual(await call(owner), { ok: true, ran: true });
  assert.deepEqual(await call(owner), { ok: true, ran: true }, 'no superuser: never cached');
  await owner.query('RESET ROLE');
});

test('a guard reading only its own session locks ignores locks of other connections', async () => {
  const own = 'SELECT ci_guard_probe_own_fence_valid() ok', fence = 'SELECT ci_guard_probe_fence_valid() ok';
  assert.deepEqual(await call(owner, own), { ok: false, ran: true });
  assert.deepEqual(await call(owner, fence), { ok: true, ran: false });
  await other.query('SELECT pg_advisory_lock(982377)');
  assert.deepEqual(await call(owner, own), { ok: false, ran: false }, 'another session’s lock is not read');
  await other.query('SELECT pg_advisory_lock(982376)');
  assert.deepEqual(await call(owner, fence), { ok: false, ran: true }, 'pg_locks without the own-pid filter sees every session');
  await other.query('SELECT pg_advisory_unlock_all()');
  await owner.query('SELECT pg_advisory_lock(982377)');
  assert.deepEqual(await call(owner, own), { ok: true, ran: true });
  await owner.query('SELECT pg_advisory_unlock(982377)');
  assert.deepEqual(await call(owner, own), { ok: false, ran: false });
});

test('a read-only VOLATILE guard is cached; writing and raising guards always run, the error is the guard’s own', async () => {
  assert.deepEqual(await call(owner, 'SELECT ci_guard_probe_volatile() ok'), { ok: true, ran: true });
  assert.deepEqual(await call(owner, 'SELECT ci_guard_probe_volatile() ok'), { ok: true, ran: false });
  for (let i = 0; i < 2; i++) assert.deepEqual(await call(owner, 'SELECT ci_guard_probe_writes() ok'), { ok: true, ran: true });
  assert.equal((await owner.query('SELECT count(*)::int n FROM ci_guard_probe_log')).rows[0].n, 2);
  for (let i = 0; i < 2; i++) {
    runs = [];
    await assert.rejects(owner.query('SELECT ci_guard_probe_raises() ok'), (e: any) => e.code === 'P0001' && e.message === 'probe refused');
    assert.equal(runs.length, 1);
  }
  runs = [];
  assert.equal((await owner.query('SELECT now() ok')).rows.length, 1);
  assert.equal((await owner.query('SELECT now() ok')).rows.length, 1);
});

test('a guard that read a pid column answers per backend', async () => {
  await owner.query('INSERT INTO ci_guard_probe_pid SELECT pg_backend_pid()');
  assert.deepEqual(await call(owner, 'SELECT ci_guard_probe_pid_valid() ok'), { ok: true, ran: true });
  assert.deepEqual(await call(owner, 'SELECT ci_guard_probe_pid_valid() ok'), { ok: true, ran: false });
  assert.deepEqual(await call(other, 'SELECT ci_guard_probe_pid_valid() ok'), { ok: false, ran: true });
});

test('a row count beside the guard follows inserts into its table', async () => {
  const text = 'SELECT (SELECT count(*)::integer FROM public.ci_guard_probe_log) n,ci_guard_probe_valid() ok';
  const first = await owner.query(text);
  assert.equal((await owner.query(text)).rows[0].n, first.rows[0].n);
  await owner.query('INSERT INTO ci_guard_probe_log VALUES (now())');
  assert.equal((await owner.query(text)).rows[0].n, first.rows[0].n + 1);
});

test('a later process with the same cache file (the next test file of a shard) reuses the answer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-guard-cache-'));
  const child = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import pg from 'pg';
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    let ran = false; c.on('notice', (n) => { if (n.message.startsWith('probe-ran:')) ran = true; });
    const ok = (await c.query('SELECT ci_guard_probe_valid() ok')).rows[0].ok; await c.end();
    console.log(JSON.stringify({ ok, ran }));`], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DYNA_CI_GUARD_CACHE_FILE: join(dir, 'cache.jsonl'), DYNA_CI_GUARD_CACHE_STATS: '' },
    encoding: 'utf8',
  }).trim().split('\n').at(-1)!);
  try {
    assert.deepEqual(child(), { ok: true, ran: true });
    assert.deepEqual(child(), { ok: true, ran: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the pool callback form returns the cached answer', async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const r = await new Promise<pg.QueryResult>((resolve, reject) => pool.query('SELECT ci_guard_probe_valid() ok', (e, res) => e ? reject(e) : resolve(res)));
    assert.equal(r.rows[0].ok, true);
  } finally { await pool.end(); }
});
