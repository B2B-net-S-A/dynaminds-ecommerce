/** Migration 236 buyer_available236() on a real clone (docs/parity/BUYER-ADDRESS236-20261027.md).
 * Runs on a fresh PG04 clone dynaminds_m236_20261027_NN of the restored template; migrate() applies the
 * pending 218…236, the upgrade path of a real install. The clone's 182 generation is then cold-approved
 * the way release startup does it (ordinary187_approve, full native predicates under the exclusive fence).
 * Every tampering case runs in a transaction that is rolled back. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate, pool } from '../server/db';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m2(?:36|40|41|42|43|44|45|46|47|48|49|50|51|52|53|54|55|56|57|58|59|60|61|62|63)_202610(?:27|28|29|30)_[0-9]{2}$/, 'fresh clone dynaminds_m236_20261027_NN (or m240/m241/m242/m243/m244/m245/m246/m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 240/241/242/243/244/245/246/247/248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');

// The application pool's session settings (server/db.ts); plain sessions give false guard negatives.
const owner = new pg.Client({ connectionString: database.href, options: '-c jit=off -c timezone=UTC -c statement_timeout=120000 -c lock_timeout=8000' });
let tenant = '';
const BASIS_TABLES = ['b2b_credit_upgrade', 'b2b_invoice_upgrade', 'buyer_address_manifest', 'competitor_observation_manifest',
  'credit_source_upgrade_certificate', 'fa3_draft_manifest', 'financial_return_upgrade_certificate', 'local_invoice_manifest',
  'manual_inventory_off_certificate', 'migrations', 'order_merge_delivery209_manifest', 'order_merge_delivery209_projection_basis'];

before(async () => {
  await migrate();
  await owner.connect();
  tenant = (await owner.query('SELECT id FROM tenants ORDER BY created_at,id LIMIT 1')).rows[0].id;
});
after(async () => { await owner.end(); await pool.end(); });

/** pg_stat_xact_* also show counts of earlier, not yet flushed transactions: measure deltas inside one transaction. */
const guardCalls = async () => (await owner.query("SELECT coalesce(sum(calls),0)::int n FROM pg_stat_xact_user_functions WHERE funcname='buyer_address_guards'")).rows[0].n as number;
/** One call as the application makes it: owner session, SET LOCAL ROLE dyna_app, tenant context.
 * `setup` runs first as the owner inside the same transaction. A raised error is caught at a savepoint. */
async function measured(setup: string[], commit: boolean) {
  await owner.query('BEGIN');
  try {
    await owner.query("SET LOCAL track_functions='all'");
    const g0 = await guardCalls();
    for (const q of setup) await owner.query(q);
    await owner.query('SAVEPOINT probe');
    await owner.query('SET LOCAL ROLE dyna_app');
    await owner.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const t = performance.now();
    let result: unknown;
    try { result = (await owner.query('SELECT public.buyer_available236() v')).rows[0].v; } catch (e: any) { result = 'ERROR ' + e.code + ' ' + e.message; await owner.query('ROLLBACK TO SAVEPOINT probe'); }
    const ms = performance.now() - t;
    await owner.query('RESET ROLE');
    const guards = (await guardCalls()) - g0;
    await owner.query(commit ? 'COMMIT' : 'ROLLBACK');
    return { result, ms, guards };
  } catch (e) { await owner.query('ROLLBACK'); throw e; }
}
const call = (setup: string[] = []) => measured(setup, false);
const committedCall = () => measured([], true);
const generation = async () => (await owner.query('SELECT generation::text g,validated_generation::text v,dirty FROM ordinary182_runtime_generation')).rows[0];
const verdict = async () => (await owner.query('SELECT generation::text g,basis_sha256 b FROM buyer_available236_verdict')).rows[0];

test('236 is applied and buyer_address_guards() reads only the twelve basis tables', async () => {
  assert.equal((await owner.query("SELECT count(*)::int n FROM migrations WHERE name='236_buyer_available_verdict'")).rows[0].n, 1);
  assert.notEqual((await owner.query("SELECT to_regprocedure('public.buyer_available236()') p")).rows[0].p, null);
  await owner.query('BEGIN READ ONLY');
  try {
    const scans = async () => new Map((await owner.query('SELECT relname,(seq_scan+coalesce(idx_scan,0))::int n FROM pg_stat_xact_user_tables')).rows.map((r) => [r.relname, r.n]));
    const s0 = await scans();
    assert.equal((await owner.query('SELECT public.buyer_address_guards() v')).rows[0].v, true);
    const read = [...(await scans())].filter(([t, n]) => n > (s0.get(t) ?? 0)).map(([t]) => t).sort();
    assert.deepEqual(read.filter((t) => !BASIS_TABLES.includes(t)), [], 'every table the full guard reads is in the 236 basis');
    assert(read.includes('buyer_address_manifest') && read.includes('order_merge_delivery209_projection_basis'), 'the scan census works');
  } finally { await owner.query('ROLLBACK'); }
});

test('only the entry point is callable by dyna_app; the verdict is not readable or writable', async () => {
  const acl = (await owner.query(`SELECT has_function_privilege('dyna_app','public.buyer_available236()','EXECUTE') e,
    has_function_privilege('dyna_app','public.buyer_available236_basis()','EXECUTE') b,
    has_table_privilege('dyna_app','public.buyer_available236_verdict','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') t`)).rows[0];
  assert.deepEqual(acl, { e: true, b: false, t: false });
  await owner.query('BEGIN');
  try {
    await owner.query('SET LOCAL ROLE dyna_app');
    await assert.rejects(owner.query('UPDATE buyer_available236_verdict SET generation=1'), (e: any) => e.code === '42501');
  } finally { await owner.query('ROLLBACK'); }
});

test('without a cold-approved generation every call runs the full guard', async () => {
  // A committed no-op owner DDL: the 182 event trigger bumps and dirties the generation (as after a migration).
  await owner.query('COMMENT ON TABLE buyer_available236_verdict IS NULL');
  assert.equal((await generation()).dirty, true);
  await owner.query('UPDATE buyer_available236_verdict SET generation=NULL,basis_sha256=NULL,verified_at=NULL');
  for (let i = 0; i < 2; i++) {
    const r = await committedCall();
    assert.equal(r.result, true);
    assert.equal(r.guards, 1, 'full guard on every call');
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
  console.log(JSON.stringify({ buyer_available236_ms: { first: +first.ms.toFixed(1), reused_median: +median.toFixed(2), reused: runs.map((r) => +r.ms.toFixed(2)) } }));
  assert(median < 50, `reused verdict median ${median.toFixed(1)} ms must stay below 50 ms (full guard ~350 ms)`);
  assert(median * 5 < first.ms, 'reused verdict is far cheaper than the full verification');
});

test('a read-only or repeatable-read transaction reuses the verdict but never records one', async () => {
  const before = await verdict();
  await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await owner.query('SET LOCAL ROLE dyna_app');
    await owner.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    assert.equal((await owner.query('SELECT public.buyer_available236() v')).rows[0].v, true);
  } finally { await owner.query('ROLLBACK'); }
  assert.deepEqual(await verdict(), before);
});

test('a changed sealed row (even in replica mode, even unchanged in value) forces the full guard; real tampering raises 55000', async () => {
  const touched = await call(["SET LOCAL session_replication_role=replica", 'UPDATE buyer_address_manifest SET profile=profile', "SET LOCAL session_replication_role=origin"]);
  assert.deepEqual([touched.result, touched.guards], [true, 1], 'new row version -> new basis -> full guard');
  for (const t of ['buyer_address_manifest', 'order_merge_delivery209_projection_basis', 'local_invoice_manifest']) {
    const r = await call(["SET LOCAL session_replication_role=replica", `DELETE FROM ${t}`, "SET LOCAL session_replication_role=origin"]);
    assert.equal(r.guards, 1, t);
    assert.match(String(r.result), /^ERROR 55000 Incomplete buyer address module/, t);
  }
  const forged = await call(["SET LOCAL session_replication_role=replica", "UPDATE buyer_address_manifest SET fingerprint=repeat('0',64)", "SET LOCAL session_replication_role=origin"]);
  assert.match(String(forged.result), /^ERROR 55000 Incomplete buyer address module/);
  const generationRow = await call(['UPDATE ordinary182_runtime_generation SET generation=generation']);
  assert.deepEqual([generationRow.result, generationRow.guards], [true, 1], 'a rewritten generation row (same values) is a new basis');
  const ledger = await call(["DELETE FROM migrations WHERE name='166_buyer_address_sidecar'"]);
  assert.equal(ledger.guards, 1, 'the ledger rows are part of the basis');
});

test('role, membership and event-trigger changes fire no DDL event yet force the full guard', async () => {
  const role = await call(['ALTER ROLE dyna_app CREATEDB']);
  assert.equal((await generation()).dirty, false, 'ALTER ROLE does not move the 182 generation');
  assert.deepEqual([role.guards, String(role.result).slice(0, 11)], [1, 'ERROR 55000'], 'app_role is in the buyer fingerprint');
  const member = await call(['CREATE ROLE buyer236_probe_role NOLOGIN', 'GRANT buyer236_probe_role TO dyna_app']);
  assert.equal(member.guards, 1, 'a new membership forces the full guard');
  const disabled = await call(['ALTER EVENT TRIGGER ordinary182_schema_ddl DISABLE']);
  assert.equal(disabled.guards, 1, 'a disabled DDL invalidator forces the full guard');
});

test('owner DDL makes the generation dirty: full guard until the next cold approval', async () => {
  const ddl = await call(["COMMENT ON TABLE buyer_available236_verdict IS 'probe'"]);
  assert.deepEqual([ddl.result, ddl.guards], [true, 1]);
  const replaced = await call(["CREATE OR REPLACE FUNCTION public.buyer_address_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$ SELECT md5(v::text) $$"]);
  assert.equal(replaced.guards, 1);
  assert.match(String(replaced.result), /^ERROR 55000 Incomplete buyer address module/, 'a replaced sidecar function is caught on the next call');
  const clean = await committedCall();
  assert.deepEqual([clean.result, clean.guards], [true, 0], 'after rollback the recorded verdict applies again');
});

// Runtime TEMP DDL by dyna_app is admitted by 182 and moves no generation, yet a session TEMP relation or
// type is searched before public (types: before pg_catalog) by every unqualified name the guard and the
// application resolve. Measured on a clone: such shadows make the full guard fail; the verdict must not hide that.
test('a session TEMP relation or type shadowing a public/pg_catalog name forces the full guard; others stay fast', async () => {
  const asApp = (ddl: string) => ['SET LOCAL ROLE dyna_app', ddl, 'RESET ROLE'];
  for (const t of ['buyer_address_state', 'buyer_address_previews', 'buyer_address_receipts'])
    for (const ddl of [`CREATE TEMP TABLE ${t} (LIKE public.${t})`, `CREATE TEMP TABLE ${t} (x int)`]) {
      const r = await call(asApp(ddl));
      assert.equal((await generation()).dirty, false, 'TEMP DDL does not move the 182 generation');
      assert.deepEqual([r.guards, String(r.result).slice(0, 11)], [1, 'ERROR 55000'], ddl);
    }
  for (const ddl of ['CREATE TEMP TABLE orders (x int)', 'CREATE TEMP VIEW buyer_address_state AS SELECT 1 x', 'CREATE TEMP VIEW migrations AS SELECT 1 x']) {
    const r = await call(asApp(ddl));
    assert.deepEqual([r.guards, String(r.result).slice(0, 11)], [1, 'ERROR 55000'], ddl);
  }
  for (const ddl of ['CREATE TYPE pg_temp.jsonb AS (x int)', 'CREATE DOMAIN pg_temp.text AS integer']) {
    const r = await call(asApp(ddl));
    assert.match(String(r.result), /^ERROR /, `${ddl}: the full guard answers (it fails), not the verdict`);
  }
  const unrelated = await call(asApp('CREATE TEMP TABLE unrelated_tmp236 (x int)'));
  assert.deepEqual([unrelated.result, unrelated.guards], [true, 0], 'a non-shadowing TEMP table keeps the fast path');
  const fast = await committedCall();
  assert.deepEqual([fast.result, fast.guards], [true, 0], 'the verdict itself is untouched by a shadowed call');
});
