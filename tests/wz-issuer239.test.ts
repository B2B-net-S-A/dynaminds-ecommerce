/** Migration 239 wz_issuer239_verdict() on a real clone (docs/parity/WZ-ISSUER239-20261027.md).
 * Runs on a fresh PG04 clone dynaminds_m239_20261027_NN of the restored template; migrate() applies the
 * pending 218…239, the upgrade path of a real install. The clone's 182 generation is then cold-approved
 * the way release startup does it (ordinary187_approve, full native predicates under the exclusive fence).
 * Every call runs as the owner (the WZ issuer guard is owner-only; the TS callers RESET ROLE first) and
 * every tampering case runs in a transaction that is rolled back. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate, pool } from '../server/db';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m2(?:39|41|42|43|44|45|46|47|48|49|50|51|52|53|54|55|56|57|58|59|60|61|62|63)_202610(?:27|28|29|30)_[0-9]{2}$/, 'fresh clone dynaminds_m239_20261027_NN (or m241/m242/m243/m244/m245/m246/m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 241/242/243/244/245/246/247/248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');

// The application pool's session settings (server/db.ts).
const options = '-c jit=off -c timezone=UTC -c statement_timeout=120000 -c lock_timeout=8000';
const owner = new pg.Client({ connectionString: database.href, options });
const other = new pg.Client({ connectionString: database.href, options });
let tenant = '', member = '';
/** Exactly the sealed tables warehouse_wz_issuer_guards() reads (pg_stat_xact_user_tables on a 238 clone). */
const BASIS_TABLES = ['b2b_credit_upgrade', 'b2b_invoice_upgrade', 'buyer_address_manifest', 'competitor_observation_manifest',
  'cooperation171_certificate', 'credit_source_upgrade_certificate', 'fa3_draft_manifest', 'financial_return_upgrade_certificate',
  'local_invoice_manifest', 'manual_inventory_off_certificate', 'migrations', 'nested172_certificate', 'operative_delivery_certificate',
  'order_merge_delivery209_manifest', 'order_merge_delivery209_projection_basis', 'packed_label_print_manifest',
  'parcel_physical_wz_certificate', 'pim_dictionary_manifest', 'warehouse_automatic_wz_manifest', 'warehouse_wz_issuer_manifest',
  'wave_print177_certificate'];
/** Shared catalogues it reads: no event trigger fires for their changes. */
const SHARED = ['pg_auth_members', 'pg_authid', 'pg_db_role_setting', 'pg_tablespace'];

before(async () => {
  await migrate();
  await owner.connect();
  await other.connect();
  const m = (await owner.query("SELECT tenant_id::text t,user_id::text u FROM memberships WHERE role IN ('admin','operator') ORDER BY tenant_id,user_id LIMIT 1")).rows[0];
  tenant = m.t; member = m.u;
});
after(async () => { await owner.end(); await other.end(); await pool.end(); });

/** pg_stat_xact_* also show counts of earlier, not yet flushed transactions: measure deltas inside one transaction. */
const guardCalls = async (c = owner) => (await c.query("SELECT coalesce(sum(calls),0)::int n FROM pg_stat_xact_user_functions WHERE funcname='warehouse_wz_issuer_guards'")).rows[0].n as number;
/** One call as the application makes it: owner session (RESET ROLE), tenant context. `setup` runs first inside the
 * same transaction; a raised error is caught at a savepoint. `full` also asks the full guard in the same state. */
async function measured(setup: string[], o: { commit?: boolean; begin?: string; sql?: string; full?: boolean } = {}) {
  await owner.query(o.begin ?? 'BEGIN');
  try {
    await owner.query("SET LOCAL track_functions='all'");
    await owner.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    for (const q of setup) await owner.query(q);
    const g0 = await guardCalls();
    await owner.query('SAVEPOINT probe');
    const t = performance.now();
    let result: unknown;
    try { result = (await owner.query(o.sql ?? 'SELECT public.wz_issuer239_verdict() v')).rows[0].v; } catch (e: any) { result = 'ERROR ' + e.code; await owner.query('ROLLBACK TO SAVEPOINT probe'); }
    const ms = performance.now() - t;
    const guards = (await guardCalls()) - g0;
    let full: unknown;
    if (o.full) try { full = (await owner.query('SELECT public.warehouse_wz_issuer_guards() v')).rows[0].v; } catch (e: any) { full = 'ERROR ' + e.code; await owner.query('ROLLBACK TO SAVEPOINT probe'); }
    await owner.query(o.commit ? 'COMMIT' : 'ROLLBACK');
    return { result, ms, guards, full };
  } catch (e) { await owner.query('ROLLBACK'); throw e; }
}
const call = (setup: string[] = [], o: { full?: boolean; begin?: string } = {}) => measured(setup, o);
const committedCall = () => measured([], { commit: true });
const generation = async () => (await owner.query('SELECT generation::text g,validated_generation::text v,dirty FROM ordinary182_runtime_generation')).rows[0];
const verdict = async () => (await owner.query('SELECT generation::text g,basis_sha256 b FROM wz_issuer239_verdict')).rows[0];
/** The verdict did not answer from the cache: the same answer as the full guard in the same state, and a true
 * answer came from one full run (a raising guard is not counted by pg_stat, but a cache hit never raises). */
function fullGuard(r: Awaited<ReturnType<typeof measured>>, label: string) {
  assert.deepEqual(r.result, r.full, label + ': the same answer as the full guard');
  if (r.result === true) assert.equal(r.guards, 1, label + ': one full guard run');
}
/** The cold approval of a release start (re-baselines the 182 generation). */
const approve = () => owner.query("SELECT public.ordinary187_approve(repeat('a',64),repeat('b',64),repeat('c',64))");
const replica = (q: string) => ["SET LOCAL session_replication_role=replica", q, "SET LOCAL session_replication_role=origin"];

test('239 is applied and warehouse_wz_issuer_guards() reads exactly the 21 basis tables and four shared catalogues', async () => {
  assert.equal((await owner.query("SELECT count(*)::int n FROM migrations WHERE name='239_wz_issuer_verdict'")).rows[0].n, 1);
  assert.notEqual((await owner.query("SELECT to_regprocedure('public.wz_issuer239_verdict()') p")).rows[0].p, null);
  await owner.query('BEGIN READ ONLY');
  try {
    const scans = async () => new Map((await owner.query(`SELECT x.relname,c.relisshared s,(x.seq_scan+coalesce(x.idx_scan,0))::int n
      FROM pg_stat_xact_all_tables x JOIN pg_class c ON c.oid=x.relid WHERE x.schemaname IN ('public','pg_catalog')`)).rows.map((r) => [r.relname, r]));
    const s0 = await scans();
    assert.equal((await owner.query('SELECT public.warehouse_wz_issuer_guards() v')).rows[0].v, true);
    const read = [...(await scans()).values()].filter((r) => r.n > (s0.get(r.relname)?.n ?? 0));
    assert.deepEqual(read.filter((r) => !r.relname.startsWith('pg_')).map((r) => r.relname).sort(), BASIS_TABLES, 'the full guard reads exactly the 239 basis tables');
    assert.deepEqual(read.filter((r) => r.s).map((r) => r.relname).sort(), SHARED, 'and exactly these shared catalogues');
  } finally { await owner.query('ROLLBACK'); }
  const basis = (await owner.query("SELECT prosrc FROM pg_proc WHERE oid='public.wz_issuer239_basis()'::regprocedure")).rows[0].prosrc as string;
  for (const t of BASIS_TABLES) assert.match(basis, new RegExp(`FROM public\\.${t}\\)`), `${t} rows are in the basis`);
  for (const t of SHARED) assert.match(basis, new RegExp(`FROM pg_catalog\\.${t}\\)`), `${t} is in the basis`);
});

test('no privilege for dyna_app on the verdict table or any 239 function; nothing named like a sealed family', async () => {
  const acl = (await owner.query(`SELECT has_function_privilege('dyna_app','public.wz_issuer239_verdict()','EXECUTE') v,
    has_function_privilege('dyna_app','public.wz_issuer239_basis()','EXECUTE') b,
    has_function_privilege('dyna_app','public.wz_issuer239_prepare_skip(uuid,uuid,jsonb)','EXECUTE') s,
    has_table_privilege('dyna_app','public.wz_issuer239_verdict','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') t`)).rows[0];
  assert.deepEqual(acl, { v: false, b: false, s: false, t: false });
  assert.deepEqual((await owner.query(`SELECT count(*)::int n FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wz_issuer239')
    AND (proname LIKE 'warehouse_wz_issuer_%' OR proname LIKE 'warehouse_automatic_wz_%' OR starts_with(proname,'parcel_physical_wz_'))`)).rows[0], { n: 0 });
  await owner.query('BEGIN');
  try {
    await owner.query('SET LOCAL ROLE dyna_app');
    for (const q of ['UPDATE wz_issuer239_verdict SET generation=1', 'SELECT * FROM wz_issuer239_verdict', 'SELECT public.wz_issuer239_verdict()', 'SELECT public.wz_issuer239_basis()']) {
      await owner.query('SAVEPOINT denied');
      await assert.rejects(owner.query(q), (e: any) => e.code === '42501', q);
      await owner.query('ROLLBACK TO SAVEPOINT denied');
    }
  } finally { await owner.query('ROLLBACK'); }
});

test('without a cold-approved generation every call runs the full guard', async () => {
  // A committed no-op owner DDL: the 182 event trigger bumps and dirties the generation (as after a migration).
  await owner.query('COMMENT ON TABLE wz_issuer239_verdict IS NULL');
  assert.equal((await generation()).dirty, true);
  await owner.query('UPDATE wz_issuer239_verdict SET generation=NULL,basis_sha256=NULL,verified_at=NULL');
  for (let i = 0; i < 2; i++) {
    const r = await committedCall();
    assert.deepEqual([r.result, r.guards], [true, 1], 'full guard on every call');
  }
  assert.equal((await verdict()).g, null, 'nothing is recorded for an unapproved schema');
});

test('cold-approved generation: one full verification, then the verdict is reused cheaply', async () => {
  const g = (await owner.query("SELECT public.ordinary187_approve(repeat('a',64),repeat('b',64),repeat('c',64)) g")).rows[0].g;
  assert.equal(g.contract_id, 'ordinary182-cold-schema-runtime/v1');
  const first = await committedCall();
  assert.deepEqual([first.result, first.guards], [true, 1]);
  assert.equal((await verdict()).g, (await generation()).g);
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await committedCall());
  for (const r of runs) assert.deepEqual([r.result, r.guards], [true, 0], 'no full guard while the basis is unchanged');
  const median = runs.map((r) => r.ms).sort((a, b) => a - b)[2];
  console.log(JSON.stringify({ wz_issuer239_verdict_ms: { first: +first.ms.toFixed(1), reused_median: +median.toFixed(2), reused: runs.map((r) => +r.ms.toFixed(2)) } }));
  assert(median < 50, `reused verdict median ${median.toFixed(1)} ms must stay below 50 ms (full guard ~1 900 ms)`);
  assert(median * 20 < first.ms, 'reused verdict is far cheaper than the full verification');
});

test('read-only READ COMMITTED reuses but never records; REPEATABLE READ and SERIALIZABLE always run the full guard', async () => {
  const before = await verdict();
  const ro = await call([], { begin: 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' });
  assert.deepEqual([ro.result, ro.guards], [true, 0]);
  for (const begin of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'BEGIN ISOLATION LEVEL REPEATABLE READ', 'BEGIN ISOLATION LEVEL SERIALIZABLE']) {
    const r = await call([], { begin });
    assert.deepEqual([r.result, r.guards], [true, 1], begin + ': a snapshot may predate committed owner DDL');
  }
  await owner.query("UPDATE wz_issuer239_verdict SET basis_sha256=repeat('0',64)");
  const roMiss = await call([], { begin: 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' });
  assert.deepEqual([roMiss.result, roMiss.guards], [true, 1], 'a forged verdict basis is a miss');
  assert.equal((await verdict()).b, '0'.repeat(64), 'a read-only transaction records nothing');
  const rw = await committedCall();
  assert.deepEqual([rw.result, rw.guards], [true, 1]);
  assert.deepEqual(await verdict(), before, 'the next read-write call records the true basis again');
});

test('a changed sealed row (even in replica mode, even unchanged in value) forces the full guard; real tampering is false', async () => {
  const touched = await call(replica('UPDATE warehouse_wz_issuer_manifest SET fingerprint=fingerprint'));
  assert.deepEqual([touched.result, touched.guards], [true, 1], 'new row version -> new basis -> full guard');
  for (const t of ['warehouse_wz_issuer_manifest', 'parcel_physical_wz_certificate', 'wave_print177_certificate', 'operative_delivery_certificate', 'order_merge_delivery209_projection_basis']) {
    const r = await call(replica(`DELETE FROM ${t}`), { full: true });
    fullGuard(r, t);
    assert.notEqual(r.result, true, t + ': tampering is rejected');
  }
  const forged = await call(replica("UPDATE warehouse_wz_issuer_manifest SET fingerprint=repeat('0',64)"), { full: true });
  fullGuard(forged, 'forged fingerprint');
  assert.notEqual(forged.result, true);
  const generationRow = await call(['UPDATE ordinary182_runtime_generation SET generation=generation']);
  assert.deepEqual([generationRow.result, generationRow.guards], [true, 1], 'a rewritten generation row (same values) is a new basis');
  const ledger = await call(["DELETE FROM migrations WHERE name='168_physical_parcel_wz'"], { full: true });
  fullGuard(ledger, 'the ledger rows are part of the basis');
  for (const t of BASIS_TABLES) {
    const w = await call(replica(`DELETE FROM ${t} WHERE ctid=(SELECT min(ctid) FROM ${t})`), { full: true });
    fullGuard(w, t + ': a deleted row forces the full guard');
  }
});

test('roles, memberships, role settings, tablespaces and event triggers fire no DDL event yet force the full guard', async () => {
  const role = await call(['ALTER ROLE dyna_app CREATEDB'], { full: true });
  assert.equal((await generation()).dirty, false, 'ALTER ROLE does not move the 182 generation');
  assert.deepEqual([role.guards, role.result, role.full], [1, false, false], 'app_role is in the parcel_physical_wz fingerprint');
  const member = await call(['CREATE ROLE wz239_probe_role NOLOGIN', 'GRANT wz239_probe_role TO dyna_app'], { full: true });
  fullGuard(member, 'a new membership forces the full guard');
  const setting = await call(["ALTER ROLE dyna_app SET work_mem='8MB'"]);
  assert.equal(setting.guards, 1, 'a role setting (pg_db_role_setting) forces the full guard');
  const tablespace = await call(['ALTER TABLESPACE pg_default SET (seq_page_cost=1)']);
  assert.equal(tablespace.guards, 1, 'a tablespace change forces the full guard');
  const disabled = await call(['ALTER EVENT TRIGGER ordinary182_schema_ddl DISABLE']);
  assert.equal(disabled.guards, 1, 'a disabled DDL invalidator forces the full guard');
});

// Security review 27.10: a committed ALTER EVENT TRIGGER ... DISABLE changed the basis, the miss ran the full guard
// (which does not look at event triggers), recorded true, and from then on owner DDL no longer dirtied the generation.
test('a disabled, replica-only or missing 182 event trigger is never re-baselined: every call runs the full guard', async () => {
  try {
    for (const state of ['DISABLE', 'ENABLE REPLICA']) {
      const warm = await committedCall();
      console.log(JSON.stringify({ event_trigger_case_warm_guards: warm.guards, state }));
      assert.equal((await committedCall()).guards, 0, 'cached before');
      await owner.query(`ALTER EVENT TRIGGER ordinary182_schema_ddl ${state}`);
      const before = await verdict();
      for (let i = 0; i < 2; i++) assert.deepEqual([(await committedCall()).guards, (await committedCall()).result], [1, true], state + ': full guard, every call');
      assert.deepEqual(await verdict(), before, state + ': nothing is recorded');
      assert.equal((await generation()).dirty, false);
      const silent = await call(["CREATE OR REPLACE FUNCTION public.warehouse_wz_issuer_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT md5(j::text)$$"], { full: true });
      assert.equal((await generation()).dirty, false, 'the DDL went unseen by the disabled invalidator');
      assert.deepEqual([silent.result, silent.full], [false, false], state + ': the replaced function is still caught');
      await owner.query('ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE');
      // 258: an event trigger row written after the cold approval blocks recording until the next approval (the 240
      // record guard), so the trigger put back is re-approved the way a release start does it before the next case.
      await approve();
    }
  } finally { await owner.query('ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE'); }
  for (const setup of [['DROP EVENT TRIGGER ordinary182_temp_drop'], ['SET LOCAL event_triggers=off']]) {
    const r = await measured(setup, { commit: false, full: true });
    fullGuard(r, setup[0]);
  }
  await approve();
  const back = await committedCall();
  assert.equal(back.result, true);
});

test('owner DDL dirties the generation; a replaced sealed function is caught on the next call', async () => {
  const ddl = await call(["COMMENT ON TABLE wz_issuer239_verdict IS 'probe'"]);
  assert.deepEqual([ddl.result, ddl.guards], [true, 1]);
  const replaced = await call(["CREATE OR REPLACE FUNCTION public.warehouse_wz_issuer_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT md5(j::text)$$"], { full: true });
  assert.deepEqual([replaced.guards, replaced.result, replaced.full], [1, false, false]);
  const own = await call(["CREATE OR REPLACE FUNCTION public.wz_issuer239_basis() RETURNS text LANGUAGE sql STABLE AS $$SELECT ''$$"]);
  assert.equal(own.guards, 1, 'a replaced 239 basis is owner DDL too');
  const clean = await committedCall();
  assert.deepEqual([clean.result, clean.guards], [true, 0], 'after rollback the recorded verdict applies again');
});

test('session state the full guard depends on: replica mode, TimeZone, other session settings', async () => {
  const rep = await call(['SET LOCAL session_replication_role=replica'], { full: true });
  assert.deepEqual([rep.guards, rep.result, rep.full], [1, false, false], 'replica mode: the full guard answers (false)');
  for (const s of ["SET LOCAL TimeZone='Europe/Warsaw'", "SET LOCAL DateStyle='SQL, DMY'", 'SET LOCAL extra_float_digits=0', 'SET LOCAL quote_all_identifiers=on', "SET LOCAL bytea_output='escape'"]) {
    const r = await call([s]);
    assert.equal(r.guards, 1, s + ' is a different session basis');
  }
});

// Runtime TEMP DDL by dyna_app is admitted by 182 and moves no generation. A session TEMP relation or type is
// searched before public (types: before pg_catalog) by the guard's unqualified names, and every session's TEMP
// catalogue rows are visible to its catalogue scans. The verdict must never answer for such a state.
test('a TEMP relation or type of this session forces the full guard: each basis table, types, non-colliding names', async () => {
  const asApp = (ddl: string) => ['SET LOCAL ROLE dyna_app', ddl, 'RESET ROLE'];
  for (const t of BASIS_TABLES) {
    const r = await call(asApp(`CREATE TEMP TABLE ${t} (x int)`), { full: true });
    assert.equal((await generation()).dirty, false, 'TEMP DDL does not move the 182 generation');
    fullGuard(r, `TEMP ${t}`);
  }
  for (const ddl of ['CREATE TEMP VIEW warehouse_wz_issuer_manifest AS SELECT 1 x', 'CREATE TEMP TABLE orders (x int)',
    'CREATE TYPE pg_temp.jsonb AS (x int)', 'CREATE DOMAIN pg_temp.text AS integer', 'CREATE TYPE pg_temp.wz239_probe AS (x int)',
    'CREATE TEMP TABLE wz239_unrelated (x int)', 'CREATE TEMP SEQUENCE wz239_seq']) {
    const r = await call(asApp(ddl), { full: true });
    fullGuard(r, ddl);
  }
  const fast = await committedCall();
  assert.deepEqual([fast.result, fast.guards], [true, 0], 'the verdict itself is untouched by a TEMP call');
});

test("another session's committed TEMP objects are in the basis (the guard scans trigger names in every schema)", async () => {
  await other.query("SELECT set_config('app.tenant_id',$1,false)", [tenant]);
  await other.query('SET ROLE dyna_app');
  try {
    await other.query('CREATE TEMP TABLE wz239_other (x int)');
    const table = await call([], { full: true });
    fullGuard(table, 'a new TEMP table elsewhere is a new basis');
    await committedCall(); // records the basis that includes the foreign TEMP table
    assert.equal((await committedCall()).guards, 0);
    await other.query('CREATE TRIGGER parcel_physical_wz_probe BEFORE UPDATE ON wz239_other FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()');
    const trigger = await call([], { full: true });
    assert.equal(trigger.full, false, 'the full guard rejects a parcel_physical_wz_ trigger in any schema');
    assert.deepEqual([trigger.guards, trigger.result], [1, false], 'and so does the verdict');
    await other.query('ALTER TABLE wz239_other RENAME TO warehouse_wz_issuer_probe');
    assert.equal((await call()).guards, 1, 'a renamed foreign TEMP table');
  } finally {
    await other.query('DISCARD TEMP');
    await other.query('RESET ROLE');
  }
  const back = await committedCall();
  assert.deepEqual([back.result, back.guards], [true, 1], 'foreign TEMP objects gone: one full guard, recorded again');
  assert.equal((await committedCall()).guards, 0);
});

// warehouse_wz_issuer_prepare() starts with warehouse_wz_issuer_require() (the full guard). It returns NULL without
// writing anything when the shipment is already dispatched or no enabled configuration covers its warehouses;
// prepare_skip() proves exactly that outcome with the reused verdict, else the caller runs the sealed prepare.
test('prepare_skip is true only where the sealed prepare returns NULL', async () => {
  const dispatched = (await owner.query(`SELECT s.tenant_id::text t,s.order_id::text o,s.id::text s FROM shipments s JOIN memberships m
    ON m.tenant_id=s.tenant_id AND m.role IN ('admin','operator') WHERE s.dispatched_at IS NOT NULL ORDER BY s.tenant_id,s.id LIMIT 1`)).rows[0];
  const enabled = (await owner.query(`SELECT r.tenant_id::text t,r.order_id::text o FROM reservations r JOIN warehouse_automatic_wz_configurations c
    ON c.tenant_id=r.tenant_id AND c.warehouse_id=r.warehouse_id AND c.settings->>'enabled'='true' JOIN memberships m ON m.tenant_id=r.tenant_id AND m.role IN ('admin','operator')
    WHERE r.state='active' ORDER BY r.tenant_id,r.order_id LIMIT 1`)).rows[0];
  const memberOf = async (t: string) => (await owner.query("SELECT user_id::text u FROM memberships WHERE tenant_id=$1 AND role IN ('admin','operator') ORDER BY user_id LIMIT 1", [t])).rows[0].u as string;
  const demo = (o = randomUUID(), s = randomUUID()) => ({ kind: 'demo', order_id: o, shipment_id: s });
  const cases: { name: string; t: string; u: string; k: string | null; src: object; skip: boolean; setup?: string[] }[] = [
    { name: 'no configuration covers an empty source', t: tenant, u: member, k: null, src: demo(), skip: true },
    { name: 'parcel without its allocation (P0002)', t: tenant, u: member, k: null, src: { kind: 'parcel', order_id: randomUUID(), shipment_id: randomUUID(), plan_id: randomUUID(), parcel_index: 0 }, skip: false },
    { name: 'not a member (42501)', t: tenant, u: randomUUID(), k: null, src: demo(), skip: false },
    { name: 'unknown API key (28000)', t: tenant, u: member, k: randomUUID(), src: demo(), skip: false },
    { name: 'tampered issuer (55000)', t: tenant, u: member, k: null, src: demo(), skip: false, setup: replica('DELETE FROM warehouse_wz_issuer_manifest') },
  ];
  if (dispatched) cases.push({ name: 'already dispatched shipment', t: dispatched.t, u: await memberOf(dispatched.t), k: null, src: demo(dispatched.o, dispatched.s), skip: true });
  if (enabled) cases.push({ name: 'enabled configuration for the reserved warehouse', t: enabled.t, u: await memberOf(enabled.t), k: null, src: demo(enabled.o), skip: false });
  console.log(JSON.stringify({ prepare_skip_cases: cases.map((x) => x.name) }));
  assert(dispatched && enabled, 'the clone has a dispatched shipment and an enabled configuration with an active reservation');
  for (const x of cases) {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.tenant_id',$1,true)", [x.t]);
      for (const q of x.setup ?? []) await owner.query(q);
      const args = [x.u, x.k, JSON.stringify(x.src)];
      const skip = (await owner.query('SELECT public.wz_issuer239_prepare_skip($1,$2,$3::jsonb) v', args)).rows[0].v;
      await owner.query('SAVEPOINT sealed');
      let sealed: unknown;
      try { sealed = (await owner.query('SELECT public.warehouse_wz_issuer_prepare($1,$2,$3::jsonb) v', args)).rows[0].v; } catch (e: any) { sealed = 'ERROR ' + e.code; await owner.query('ROLLBACK TO SAVEPOINT sealed'); }
      assert.equal(skip, x.skip, x.name);
      if (skip) assert.equal(sealed, null, x.name + ': the sealed prepare returns NULL');
      else assert.notEqual(sealed, null, x.name + ': the sealed prepare does not return NULL (' + String(sealed) + ')');
    } finally { await owner.query('ROLLBACK'); }
  }
  const hot = await measured([], { sql: `SELECT public.wz_issuer239_prepare_skip('${member}',NULL,'${JSON.stringify(demo())}'::jsonb) v` });
  assert.deepEqual([hot.result, hot.guards], [true, 0], 'the skip reuses the verdict');
  console.log(JSON.stringify({ wz_issuer239_prepare_skip_ms: +hot.ms.toFixed(2) }));
});
