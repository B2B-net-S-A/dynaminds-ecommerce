/** Migration 240 buyer_available236() event-trigger pre-checks on a real clone (docs/parity/BUYER-ADDRESS240-20261027.md).
 * Runs on a fresh PG04 clone dynaminds_m240_20261027_NN of the restored template; migrate() applies the pending
 * 218…240. The clone's 182 generation is then cold-approved the way release startup does it (ordinary187_approve).
 * The 236 verdict is only sound while the three 182 event triggers fire: a disabled, replica-only, replaced or
 * dropped one (or event_triggers=off) changes the 236 basis, and a miss used to re-record the full guard's true,
 * after which owner DDL no longer dirtied the generation and a replaced buyer_address_ function went unseen. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate, pool } from '../server/db';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:24[0123456789]|25[0123456789]|26[0123])_202610(?:27|28|29|30)_[0-9]{2}$/, 'fresh clone dynaminds_m240_20261027_NN (or m241/m242/m243/m244/m245/m246/m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 241/242/243/244/245/246/247/248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');

// The application pool's session settings (server/db.ts); plain sessions give false guard negatives.
const owner = new pg.Client({ connectionString: database.href, options: '-c jit=off -c timezone=UTC -c statement_timeout=120000 -c lock_timeout=8000' });
let tenant = '';
// A sealed buyer_address_ function replaced by owner DDL: the full guard raises 55000, the 182 trigger dirties the generation.
const TAMPER = 'CREATE OR REPLACE FUNCTION public.buyer_address_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$ SELECT md5(v::text) $$';

before(async () => {
  await migrate();
  await owner.connect();
  tenant = (await owner.query('SELECT id FROM tenants ORDER BY created_at,id LIMIT 1')).rows[0].id;
  const g = (await owner.query("SELECT public.ordinary187_approve(repeat('a',64),repeat('b',64),repeat('c',64)) g")).rows[0].g;
  assert.equal(g.contract_id, 'ordinary182-cold-schema-runtime/v1');
});
after(async () => {
  for (const t of ['ordinary182_schema_ddl', 'ordinary182_temp_ddl_end', 'ordinary182_temp_drop']) await owner.query(`ALTER EVENT TRIGGER ${t} ENABLE`);
  await owner.end(); await pool.end();
});

const guardCalls = async () => (await owner.query("SELECT coalesce(sum(calls),0)::int n FROM pg_stat_xact_user_functions WHERE funcname='buyer_address_guards'")).rows[0].n as number;
const generation = async () => (await owner.query('SELECT generation::text g,validated_generation::text v,dirty FROM ordinary182_runtime_generation')).rows[0];
const verdict = async () => (await owner.query('SELECT generation::text g,basis_sha256 b FROM buyer_available236_verdict')).rows[0];
/** One call as the application makes it (SET LOCAL ROLE dyna_app, tenant context) inside an open transaction. */
async function appCall() {
  await owner.query('SAVEPOINT probe');
  await owner.query('SET LOCAL ROLE dyna_app');
  await owner.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  const g0 = await guardCalls(), t = performance.now();
  let result: unknown;
  try { result = (await owner.query('SELECT public.buyer_available236() v')).rows[0].v; await owner.query('RELEASE SAVEPOINT probe'); } catch (e: any) { result = 'ERROR ' + e.code; await owner.query('ROLLBACK TO SAVEPOINT probe'); }
  const ms = performance.now() - t;
  await owner.query('RESET ROLE');
  return { result, ms, guards: (await guardCalls()) - g0 };
}
/** Setup statements as the owner, then the given number of calls, in one transaction (committed or rolled back). */
async function inTx(setup: string[], calls: number, commit: boolean) {
  await owner.query('BEGIN');
  try {
    await owner.query("SET LOCAL track_functions='all'");
    for (const q of setup) await owner.query(q);
    const out = [];
    for (let i = 0; i < calls; i++) out.push(await appCall());
    const seen = await verdict();
    await owner.query(commit ? 'COMMIT' : 'ROLLBACK');
    return { calls: out, verdict: seen };
  } catch (e) { await owner.query('ROLLBACK'); throw e; }
}
const committedCall = async () => (await inTx([], 1, true)).calls[0];
const approve = async () => owner.query("SELECT public.ordinary187_approve(repeat('a',64),repeat('b',64),repeat('c',64))");

test('240 is applied: buyer_available236() checks the three 182 event triggers', async () => {
  assert.equal((await owner.query("SELECT count(*)::int n FROM migrations WHERE name='240_buyer_available_events'")).rows[0].n, 1);
  const src = (await owner.query("SELECT prosrc FROM pg_proc WHERE oid='public.buyer_available236()'::regprocedure")).rows[0].prosrc as string;
  for (const t of ['ordinary182_schema_ddl', 'ordinary182_temp_ddl_end', 'ordinary182_temp_drop']) assert(src.includes(`e.evtname='${t}'`), t);
  const acl = (await owner.query(`SELECT has_function_privilege('dyna_app','public.buyer_available236()','EXECUTE') e,
    has_function_privilege('dyna_app','public.buyer_available236_basis()','EXECUTE') b,
    has_table_privilege('dyna_app','public.buyer_available236_verdict','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') t,
    (SELECT prosecdef FROM pg_proc WHERE oid='public.buyer_available236()'::regprocedure) d,
    (SELECT proconfig FROM pg_proc WHERE oid='public.buyer_available236()'::regprocedure) c`)).rows[0];
  assert.deepEqual(acl, { e: true, b: false, t: false, d: true, c: ['search_path=pg_catalog, public, pg_temp', 'TimeZone=UTC'] });
});

test('the cold-approved verdict is still reused cheaply while the three event triggers fire', async () => {
  const first = await committedCall();
  assert.equal(first.result, true);
  const runs = [];
  for (let i = 0; i < 10; i++) runs.push(await committedCall());
  for (const r of runs) assert.deepEqual([r.result, r.guards], [true, 0], 'hit');
  const median = runs.map((r) => r.ms).sort((a, b) => a - b)[5];
  console.log(JSON.stringify({ buyer_available240_hit_ms: { first: +first.ms.toFixed(1), median: +median.toFixed(2), runs: runs.map((r) => +r.ms.toFixed(2)) } }));
  assert(median < 50, `hit median ${median.toFixed(1)} ms must stay below 50 ms (full guard ~450 ms)`);
});

// The bypass (red before 240): a committed DISABLE changed the basis, the miss re-recorded true, and from then on
// a replaced buyer_address_ function moved neither the generation nor the basis: true while the full guard raised.
test('a committed disabled or replica-only DDL invalidator is never re-baselined; a silent replacement is caught', async () => {
  try {
    for (const state of ['DISABLE', 'ENABLE REPLICA']) {
      await committedCall();
      assert.equal((await committedCall()).guards, 0, state + ': cached before');
      await owner.query(`ALTER EVENT TRIGGER ordinary182_schema_ddl ${state}`);
      const before = await verdict();
      for (let i = 0; i < 2; i++) {
        const r = await committedCall();
        assert.deepEqual([r.result, r.guards], [true, 1], state + ': the full guard answers every call');
      }
      assert.deepEqual(await verdict(), before, state + ': nothing is recorded');
      await owner.query('BEGIN');
      try {
        await owner.query("SET LOCAL track_functions='all'");
        await owner.query(TAMPER);
        assert.equal((await generation()).dirty, false, state + ': the DDL went unseen by the invalidator');
        for (let i = 0; i < 2; i++) assert.match(String((await appCall()).result), /^ERROR 55000/, state + ': the replaced function is caught');
      } finally { await owner.query('ROLLBACK'); }
      await owner.query('ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE');
      // Re-enabled after the cold approval: the event trigger row is newer than the generation row, so nothing is
      // recorded until the next approval (security review of 240: a DISABLE/ENABLE round trip must not re-baseline).
      const before2 = await verdict();
      for (let i = 0; i < 2; i++) assert.deepEqual(((r) => [r.result, r.guards])(await committedCall()), [true, 1], state + ': full guard until re-approval');
      assert.deepEqual(await verdict(), before2, state + ': still nothing recorded');
      await approve();
      assert.equal((await committedCall()).guards, 1, state + ': the first call after the approval records');
      assert.deepEqual(((r) => [r.result, r.guards])(await committedCall()), [true, 0], state + ': hit again after the approval');
    }
  } finally { await owner.query("DO $$BEGIN IF EXISTS(SELECT FROM pg_event_trigger WHERE evtname='ordinary182_schema_ddl' AND evtenabled<>'O') THEN ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE;END IF;END$$"); }
});

// The 239 security review variants: any 182 event trigger not present, origin-enabled, untagged, on its expected
// event and function (or event_triggers=off here) -> the full guard on every call, nothing recorded.
const NOOP = 'CREATE FUNCTION public.zz_noop_evt240() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN NULL; END$$';
const recreate = (spec: string) => ['DROP EVENT TRIGGER ordinary182_schema_ddl', `CREATE EVENT TRIGGER ordinary182_schema_ddl ${spec}`];
const VARIANTS: Record<string, string[]> = {
  disable: ['ALTER EVENT TRIGGER ordinary182_schema_ddl DISABLE'],
  enable_replica: ['ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE REPLICA'],
  enable_always: ['ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE ALWAYS'],
  // Disabled first: CREATE FUNCTION would otherwise dirty the generation itself.
  noop_function: ['ALTER EVENT TRIGGER ordinary182_schema_ddl DISABLE', NOOP, ...recreate('ON ddl_command_start EXECUTE FUNCTION public.zz_noop_evt240()')],
  when_tag: recreate("ON ddl_command_start WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.ordinary182_invalidate()"),
  renamed: ['ALTER EVENT TRIGGER ordinary182_schema_ddl RENAME TO zz_renamed240'],
  ddl_command_end: recreate('ON ddl_command_end EXECUTE FUNCTION public.ordinary182_invalidate()'),
  dropped: ['DROP EVENT TRIGGER ordinary182_schema_ddl'],
  temp_ddl_end_disabled: ['ALTER EVENT TRIGGER ordinary182_temp_ddl_end DISABLE'],
  temp_drop_dropped: ['DROP EVENT TRIGGER ordinary182_temp_drop'],
  event_triggers_off: ['SET LOCAL event_triggers=off'],
};
test('every 239 review variant runs the full guard on every call, records nothing, and a replaced function is caught', async () => {
  const recorded = await verdict();
  for (const [name, setup] of Object.entries(VARIANTS)) {
    const plain = await inTx(setup, 2, false);
    for (const r of plain.calls) assert.deepEqual([r.result, r.guards], [true, 1], name + ': full guard');
    assert.deepEqual(plain.verdict, recorded, name + ': nothing is recorded');
    const tampered = await inTx([...setup, TAMPER], 2, false);
    for (const r of tampered.calls) assert.match(String(r.result), /^ERROR 55000/, name + ': the replaced function is caught');
  }
  assert.deepEqual(await verdict(), recorded);
  const fast = await committedCall();
  assert.deepEqual([fast.result, fast.guards], [true, 0], 'the normal state keeps the fast path');
});

// Security review of 240: a round trip (the trigger off only while the DDL runs) restores every value the 236 basis
// hashed. Row versions are in the basis now, and a miss never records over an event trigger, an ordinary182_
// function or a generation-table rule/trigger written after the cold approval.
const TAMPER_TABLE = 'ALTER TABLE public.buyer_address_state ADD COLUMN zz_probe240 int';
const NEUTER = 'CREATE OR REPLACE FUNCTION public.ordinary182_invalidate() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN NULL; END$$';
const OFF = 'ALTER EVENT TRIGGER ordinary182_schema_ddl DISABLE', ON = 'ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE';
const ROUND_TRIPS: Record<string, { setup: string[]; tamper: boolean }> = {
  disable_function: { setup: [OFF, TAMPER, ON], tamper: true },
  disable_table: { setup: [OFF, TAMPER_TABLE, ON], tamper: true },
  replica_function: { setup: ['ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE REPLICA', TAMPER, ON], tamper: true },
  always_table: { setup: ['ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE ALWAYS', TAMPER_TABLE, ON], tamper: true },
  event_triggers_off_function: { setup: ['SET LOCAL event_triggers=off', TAMPER, 'SET LOCAL event_triggers=on'], tamper: true },
  plain: { setup: [OFF, ON], tamper: false },
  neutered_invalidator: { setup: [OFF, NEUTER, ON], tamper: false },
  neutered_invalidator_events_off: { setup: ['SET LOCAL event_triggers=off', NEUTER, 'SET LOCAL event_triggers=on'], tamper: false },
  // A rule or trigger on the generation table is in the basis too (a DO INSTEAD NOTHING rule makes the invalidator
  // itself raise 55000 on the next DDL; not run here, the session's plan cache keeps the rewritten UPDATE).
};
test('a DDL round trip around the 182 invalidator is a miss, and a healthy-looking state after it is never re-baselined', async () => {
  const recorded = await verdict();
  for (const [name, { setup, tamper }] of Object.entries(ROUND_TRIPS)) {
    const r = await inTx(setup, 2, false);
    for (const c of r.calls) {
      if (tamper) assert.match(String(c.result), /^ERROR 55000/, name + ': the round-trip DDL is caught');
      else assert.deepEqual([c.result, c.guards], [true, 1], name + ': full guard on every call');
    }
    assert.deepEqual(r.verdict, recorded, name + ': nothing is recorded');
    if (!tamper) {
      // The neutered machinery would hide later owner DDL; it must stay on the full guard.
      const later = await inTx([...setup, TAMPER_TABLE], 2, false);
      for (const c of later.calls) assert.match(String(c.result), /^ERROR 55000/, name + ': later DDL is caught');
    }
  }
  const fast = await committedCall();
  assert.deepEqual([fast.result, fast.guards], [true, 0]);
});

test('236 guarantees stay: owner DDL dirties the generation, a TEMP shadow forces the full guard, a changed sealed row too', async () => {
  assert.equal((await committedCall()).result, true);
  const ddl = await inTx([TAMPER], 1, false);
  assert.match(String(ddl.calls[0].result), /^ERROR 55000/);
  const shadow = await inTx(['SET LOCAL ROLE dyna_app', 'CREATE TEMP TABLE buyer_address_state (x int)', 'RESET ROLE'], 1, false);
  assert.match(String(shadow.calls[0].result), /^ERROR 55000/);
  const unrelated = await inTx(['SET LOCAL ROLE dyna_app', 'CREATE TEMP TABLE unrelated_tmp240 (x int)', 'RESET ROLE'], 1, false);
  assert.deepEqual([unrelated.calls[0].result, unrelated.calls[0].guards], [true, 0], 'a non-shadowing TEMP table keeps the fast path');
  const row = await inTx(["SET LOCAL session_replication_role=replica", "UPDATE buyer_address_manifest SET fingerprint=repeat('0',64)", "SET LOCAL session_replication_role=origin"], 1, false);
  assert.match(String(row.calls[0].result), /^ERROR 55000/);
  const role = await inTx(['ALTER ROLE dyna_app CREATEDB'], 1, false);
  assert.match(String(role.calls[0].result), /^ERROR 55000/);
});
