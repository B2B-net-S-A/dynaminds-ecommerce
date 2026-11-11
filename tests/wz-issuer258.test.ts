/** Migration 258_wz_issuer_refresh (prepared as 273; object names keep 273) on a real clone (docs/parity/WZ-ISSUER-GEN273-20261029.md
 * "Integracja jako 258"). Runs on a fresh PG04 clone dynaminds_m258_YYYYMMDD_NN of the restored template migrated to HEAD by
 * the real migrate(), which applies 258 and its ledger row (the prepared run applied 273 by hand; that step is dropped).
 * Root cause pinned first: after every cold approval the WZ verdict record is stale, and a miss is healed only by a
 * request whose full guard finishes inside the 8 s request budget and whose transaction commits; under load neither
 * holds, so every ship-demo ran the full guard until its statement timeout. 273 records the verdict in its own
 * transaction with the cold budget (startup and after a 57014). The question for every case stays the one of 239/241:
 * can the verdict or the refresh answer true from the cache in a state the full guard rejects? */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate, pool } from '../server/db';
import { refreshWzIssuerVerdict, scheduleWzIssuerRefresh } from '../server/wz-issuer273-refresh';
import { issuedWzAvailable } from '../server/warehouse-wz-issued';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:25[89]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m258_YYYYMMDD_NN of the restored template required');

// The application pool's session settings (server/db.ts), with room for the full guard in the test sessions.
const options = '-c jit=off -c timezone=UTC -c statement_timeout=120000 -c lock_timeout=8000';
const A = new pg.Client({ connectionString: database.href, options });
const B = new pg.Client({ connectionString: database.href, options });
let tenant = '', member = '';
const approve = () => A.query("SELECT public.ordinary187_approve(repeat('a',64),repeat('b',64),repeat('c',64))");
const recorded = async () => (await A.query('SELECT generation::text g,basis_sha256 b,verified_at::text at FROM wz_issuer239_verdict')).rows[0];
const generation = async () => (await A.query('SELECT generation::text g,validated_generation::text v,dirty FROM ordinary182_runtime_generation')).rows[0];
const guardCalls = async () => (await A.query("SELECT coalesce(sum(calls),0)::int n FROM pg_stat_xact_user_functions WHERE funcname='warehouse_wz_issuer_guards'")).rows[0].n as number;
const demo = () => JSON.stringify({ kind: 'demo', order_id: randomUUID(), shipment_id: randomUUID() });

before(async () => {
  await migrate();
  await A.connect(); await B.connect();
  const m = (await A.query("SELECT tenant_id::text t,user_id::text u FROM memberships WHERE role IN ('admin','operator') ORDER BY tenant_id,user_id LIMIT 1")).rows[0];
  tenant = m.t; member = m.u;
  await approve();
});
after(async () => { try { await approve(); } finally { await A.end(); await B.end(); await pool.end(); } });

/** One statement as the ship path makes it (owner, tenant context), inside A's transaction: result, ms, full guards. */
async function one(sql: string, args: unknown[] = []) {
  const g0 = await guardCalls();
  await A.query('SAVEPOINT probe');
  const t = performance.now();
  let result: unknown;
  try { result = (await A.query(sql, args)).rows[0].v; } catch (e: any) { result = 'ERROR ' + e.code; await A.query('ROLLBACK TO SAVEPOINT probe'); }
  const ms = performance.now() - t;
  return { result, ms, guards: (await guardCalls()) - g0 };
}
async function inTx<T>(steps: string[], fn: () => Promise<T>, o: { begin?: string; commit?: boolean } = {}): Promise<T> {
  await A.query(o.begin ?? 'BEGIN');
  try {
    await A.query("SET LOCAL track_functions='all'");
    await A.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    for (const q of steps) await A.query(q);
    const r = await fn();
    await A.query(o.commit ? 'COMMIT' : 'ROLLBACK');
    return r;
  } catch (e) { await A.query('ROLLBACK'); throw e; }
}
const skip = () => one('SELECT public.wz_issuer239_prepare_skip($1,NULL,$2::jsonb) v', [member, demo()]);
const fullNow = () => one('SELECT public.warehouse_wz_issuer_guards() v');

test('258 is applied by the real migrate(): owner-only definer functions; the refresh has the prepare_skip settings', async () => {
  assert.equal((await A.query("SELECT count(*)::int n FROM migrations WHERE name='258_wz_issuer_refresh'")).rows[0].n, 1, 'ledger row 258');
  const rows = (await A.query(`SELECT p.oid::regprocedure::text f,p.prosecdef d,p.provolatile v,p.proconfig c,pg_get_function_result(p.oid) r,
    has_function_privilege('dyna_app',p.oid,'EXECUTE') app,has_function_privilege('public',p.oid,'EXECUTE') pub,
    position('UNION ALL SELECT xmin FROM pg_catalog.pg_rewrite' in p.prosrc)>0 xmin_guard
    FROM pg_proc p WHERE p.oid IN(to_regprocedure('public.wz_issuer273_refresh()'),to_regprocedure('public.wz_issuer239_verdict()')) ORDER BY 1`)).rows;
  assert.deepEqual(rows, [
    { f: 'wz_issuer239_verdict()', d: true, v: 'v', c: ['search_path=pg_catalog, public, pg_temp'], r: 'boolean', app: false, pub: false, xmin_guard: true },
    { f: 'wz_issuer273_refresh()', d: true, v: 'v', c: ['search_path=pg_catalog, public, pg_temp', 'TimeZone=UTC'], r: 'boolean', app: false, pub: false, xmin_guard: false },
  ]);
  await A.query('BEGIN');
  try {
    await A.query('SET LOCAL ROLE dyna_app');
    await assert.rejects(A.query('SELECT public.wz_issuer273_refresh()'), (e: any) => e.code === '42501');
  } finally { await A.query('ROLLBACK'); }
});

test('root cause: after a cold approval a miss cut by the request budget, or rolled back, records nothing', async () => {
  await approve();
  const stale = await recorded();
  for (let i = 0; i < 3; i++) {
    const r = await inTx(["SET LOCAL statement_timeout='500ms'"], skip);
    assert.equal(r.result, 'ERROR 57014', 'the full guard of the miss outlives the budget');
    assert.deepEqual(await recorded(), stale, 'a cancelled miss records nothing: the next request misses again');
  }
  const done = await inTx([], skip);
  assert.deepEqual([done.result, done.guards], [true, 1], 'a completed miss runs the full guard');
  assert.deepEqual(await recorded(), stale, 'and records nothing when its transaction rolls back');
});

test('a refresh in its own committed transaction records the verdict; prepare_skip then hits within a budget below one full guard', async () => {
  await approve();
  const t = performance.now();
  assert.equal(await refreshWzIssuerVerdict(pool), true);
  const refreshMs = performance.now() - t;
  const rec = await recorded();
  assert.equal(rec.g, (await generation()).g);
  const runs = [];
  for (let i = 0; i < 7; i++) runs.push(await inTx(["SET LOCAL statement_timeout='500ms'"], skip));
  for (const r of runs) assert.deepEqual([r.result, r.guards], [true, 0], 'a hit: no full guard');
  const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
  console.log(JSON.stringify({ wz_issuer273: { refresh_ms: Math.round(refreshMs), prepare_skip_hit_ms: { median: +ms[3].toFixed(2), max: +ms[6].toFixed(2) } } }));
  const again = await inTx([], () => one('SELECT public.wz_issuer273_refresh() v'));
  assert.deepEqual([again.result, again.guards], [true, 0], 'a refresh over a fresh record is a hit as well');
  assert.deepEqual(await recorded(), rec);
});

test('a refresh from another session time zone records exactly what prepare_skip compares', async () => {
  await approve();
  const r = await inTx(["SET LOCAL TimeZone='Europe/Warsaw'"], () => one('SELECT public.wz_issuer273_refresh() v'), { commit: true });
  assert.deepEqual([r.result, r.guards], [true, 1]);
  const hit = await inTx(["SET LOCAL statement_timeout='500ms'"], skip);
  assert.deepEqual([hit.result, hit.guards], [true, 0]);
});

test('outside READ COMMITTED READ WRITE, or while another session refreshes, the refresh answers NULL at once and runs no guard', async () => {
  await approve();
  const stale = await recorded();
  for (const begin of ['BEGIN ISOLATION LEVEL REPEATABLE READ', 'BEGIN ISOLATION LEVEL SERIALIZABLE', 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY']) {
    const r = await inTx([], () => one('SELECT public.wz_issuer273_refresh() v'), { begin, commit: true });
    assert.deepEqual([r.result, r.guards], [null, 0], begin);
  }
  await B.query('BEGIN');
  try {
    await B.query('SELECT pg_advisory_xact_lock(273,239)');
    const r = await inTx(["SET LOCAL lock_timeout='200ms'"], () => one('SELECT public.wz_issuer273_refresh() v'), { commit: true });
    assert.deepEqual([r.result, r.guards], [null, 0], 'busy: no wait, no second full guard');
    assert.equal(await refreshWzIssuerVerdict(pool), null);
  } finally { await B.query('ROLLBACK'); }
  assert.deepEqual(await recorded(), stale, 'nothing recorded');
  const [x, y] = [scheduleWzIssuerRefresh(pool), scheduleWzIssuerRefresh(pool)];
  assert.equal(x, y, 'one background refresh per process');
  assert.equal(await x, true);
  assert.notDeepEqual(await recorded(), stale, 'the background refresh recorded');
});

test('startup (the Pool) refreshes: the first request after a cold approval hits', async () => {
  await approve();
  const stale = await recorded();
  assert.equal(await issuedWzAvailable(pool), true);
  assert.notDeepEqual(await recorded(), stale);
  const hit = await inTx(["SET LOCAL statement_timeout='500ms'"], skip);
  assert.deepEqual([hit.result, hit.guards], [true, 0]);
});

// Tampering after a recorded verdict: every refresh and every verdict answers like the full guard, never a cached true.
const OFF = 'SET LOCAL event_triggers=off', ON = 'SET LOCAL event_triggers=on';
const HASH = 'CREATE OR REPLACE FUNCTION public.warehouse_wz_issuer_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT md5(j::text)$$';
const TAMPER: Record<string, string[]> = {
  sealed_function_replaced: [HASH],
  sealed_function_replaced_events_off: [OFF, HASH, ON],
  sealed_row_deleted_replica: ['SET LOCAL session_replication_role=replica', 'DELETE FROM warehouse_wz_issuer_manifest', 'SET LOCAL session_replication_role=origin'],
};
for (const [name, steps] of Object.entries(TAMPER)) {
  test(`tampering after a recorded verdict: the refresh and the verdict answer like the full guard / ${name}`, async () => {
    await approve();
    assert.equal(await refreshWzIssuerVerdict(pool), true);
    const before = await recorded();
    const r = await inTx(steps, async () => ({ refresh: await one('SELECT public.wz_issuer273_refresh() v'), verdict: await one('SELECT public.wz_issuer239_verdict() v'),
      full: await fullNow(), seen: await recorded() }));
    assert.notEqual(r.full.result, true, name + ': the full guard rejects the state');
    assert.equal(r.refresh.result, r.full.result, name + ': refresh = full guard');
    assert.equal(r.verdict.result, r.full.result, name + ': verdict = full guard');
    assert.deepEqual(r.seen, before, name + ': nothing recorded');
  });
}

// docs/parity/VERDICT-GATES241-20261027.md, „Czego werdykty nadal nie widzą”: a rule on the generation table created and
// dropped with event triggers off is visible only through relhasrules. Window 1 (no DDL) sets it and the miss recorded the
// new basis; window 2 (the rule hides the invalidator's UPDATE around owner DDL) then left no trace: a stale true in WZ.
// 273 adds the 240 record guard of buyer_available236(): after window 1 the generation table row is newer than the
// generation row, so nothing is recorded until the next cold approval.
test('two hidden rule windows give no stale true (241 documented class, closed by the 240 record guard)', async () => {
  await approve();
  assert.equal(await refreshWzIssuerVerdict(pool), true);
  const RULE = 'CREATE RULE zz_r273 AS ON UPDATE TO public.ordinary182_runtime_generation DO INSTEAD UPDATE public.zz_gen_shadow273 SET generation=generation+1 WHERE singleton';
  const DROP = 'DROP RULE zz_r273 ON public.ordinary182_runtime_generation';
  const r = await inTx([], async () => {
    for (const s of [OFF, 'CREATE TABLE public.zz_gen_shadow273 (LIKE public.ordinary182_runtime_generation)',
      'INSERT INTO public.zz_gen_shadow273 SELECT * FROM public.ordinary182_runtime_generation', RULE, DROP, ON]) await A.query(s);
    const window1 = await one('SELECT public.wz_issuer239_verdict() v');
    for (const s of [OFF, RULE, ON, 'ALTER TABLE public.warehouse_wz_issuer_receipts ADD COLUMN zz_probe273 int', OFF, DROP, ON]) await A.query(s);
    assert.equal((await generation()).dirty, false, 'the rule hid the invalidator: the generation stays approved');
    return { window1, window2: await one('SELECT public.wz_issuer239_verdict() v'), refresh: await one('SELECT public.wz_issuer273_refresh() v'), full: await fullNow() };
  });
  assert.deepEqual([r.window1.result, r.window1.guards], [true, 1], 'window 1 is a miss with a true full guard');
  assert.equal(r.full.result, false, 'after window 2 the full guard rejects the schema');
  assert.equal(r.window2.result, false, 'no stale true from the verdict');
  assert.equal(r.refresh.result, false, 'nor from the refresh');
});

// Security review of 273: window 1 from a transaction whose xid predates the cold approval leaves a generation-table
// pg_class row that the age guard counts as older than the generation row. relhasrules stays true after DROP RULE, so the
// record is refused as well. Window 1 commits (B); window 2 runs in A's rolled-back transaction; the cleanup VACUUMs the
// generation table (relhasrules back to false), drops the shadow table and re-approves.
test('two hidden rule windows, the first from a transaction older than the cold approval, give no stale true', async () => {
  const RULE = 'CREATE RULE zz_r273 AS ON UPDATE TO public.ordinary182_runtime_generation DO INSTEAD UPDATE public.zz_gen_shadow273b SET generation=generation+1 WHERE singleton';
  const DROP = 'DROP RULE zz_r273 ON public.ordinary182_runtime_generation';
  try {
    await B.query('BEGIN');
    await B.query('SELECT pg_current_xact_id()');
    await approve();
    assert.equal(await refreshWzIssuerVerdict(pool), true);
    for (const s of [OFF, 'CREATE TABLE public.zz_gen_shadow273b (LIKE public.ordinary182_runtime_generation)',
      'INSERT INTO public.zz_gen_shadow273b SELECT * FROM public.ordinary182_runtime_generation', RULE, DROP]) await B.query(s);
    await B.query('COMMIT');
    const w1 = (await A.query(`SELECT c.relhasrules r,pg_catalog.age(c.xmin)>pg_catalog.age(g.xmin) older FROM pg_class c,ordinary182_runtime_generation g
      WHERE c.oid='public.ordinary182_runtime_generation'::regclass`)).rows[0];
    assert.deepEqual(w1, { r: true, older: true }, 'window 1 left relhasrules and a pg_class row "older" than the approval');
    const miss = await inTx([], () => one('SELECT public.wz_issuer273_refresh() v'), { commit: true });
    assert.deepEqual([miss.result, miss.guards], [true, 1], 'a miss with a true full guard');
    const recordedAfterWindow1 = await recorded();
    const r = await inTx([], async () => {
      for (const s of [OFF, RULE, ON, 'ALTER TABLE public.warehouse_wz_issuer_receipts ADD COLUMN zz_probe273 int', OFF, DROP, ON]) await A.query(s);
      assert.equal((await generation()).dirty, false, 'the rule hid the invalidator');
      return { verdict: await one('SELECT public.wz_issuer239_verdict() v'), refresh: await one('SELECT public.wz_issuer273_refresh() v'), full: await fullNow() };
    });
    assert.equal(r.full.result, false, 'after window 2 the full guard rejects the schema');
    assert.equal(r.verdict.result, false, 'no stale true from the verdict');
    assert.equal(r.refresh.result, false, 'nor from the refresh');
    assert.deepEqual(await recorded(), recordedAfterWindow1);
  } finally {
    await B.query('ROLLBACK').catch(() => undefined);
    await A.query('VACUUM public.ordinary182_runtime_generation');
    await A.query('DROP TABLE IF EXISTS public.zz_gen_shadow273b');
    await approve();
    assert.equal((await A.query("SELECT relhasrules r FROM pg_class WHERE oid='public.ordinary182_runtime_generation'::regclass")).rows[0].r, false, 'clean again');
  }
});
