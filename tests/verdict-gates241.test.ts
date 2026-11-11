/** Migration 241 content-based gates of the two cached integrity verdicts on a real clone
 * (docs/parity/VERDICT-GATES241-20261027.md). Runs on a fresh PG04 clone dynaminds_m241_20261027_NN of the restored
 * template; migrate() applies the pending 218…241 and the clone's 182 generation is then cold-approved the way release
 * startup does it (ordinary187_approve).
 * buyer_available236() (240) and wz_issuer239_verdict() (239) trusted the 182 generation as a schema version while the
 * three 182 event triggers were present and enabled, and 240 refused to record over 182 machinery written "after" the
 * approval in xid order. A transaction that took its xid before the approval and committed after it, with a neutered
 * invalidator or a rule on the generation table, passed both; so did a forged generation UPDATE, a caller in replica
 * mode and a persistent role setting that turns event triggers off. Two owner sessions reproduce the commit-order skew. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate, pool } from '../server/db';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:24[123456789]|25[0123456789]|26[0123])_202610(?:27|28|29|30)_[0-9]{2}$/, 'fresh clone dynaminds_m241_20261027_NN (or m242/m243/m244/m245/m246/m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 242/243/244/245/246/247/248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');
const dbName = database.pathname.slice(1);

// The application pool's session settings (server/db.ts); plain sessions give false guard negatives.
const options = '-c jit=off -c timezone=UTC -c statement_timeout=120000 -c lock_timeout=8000';
// A is swapped for a fresh session where a test needs one (PostgreSQL 18 keeps a session's SQL-function plans, which a
// new overload does not invalidate).
let A = new pg.Client({ connectionString: database.href, options });
const B = new pg.Client({ connectionString: database.href, options });
let tenant = '', invalidatorDef = '';

type Verdict = 'buyer' | 'wz';
const V: Record<Verdict, { guard: string; table: string; tamper: string; call: string; full: string; asApp: boolean }> = {
  buyer: {
    guard: 'buyer_address_guards', table: 'buyer_available236_verdict', asApp: true,
    // Non-function owner DDL: the full guard raises 55000, the 182 invalidator would dirty the generation.
    tamper: 'ALTER TABLE public.buyer_address_state ADD COLUMN zz_probe241 int',
    call: 'SELECT public.buyer_available236() v', full: 'SELECT public.buyer_address_available() v',
  },
  wz: {
    guard: 'warehouse_wz_issuer_guards', table: 'wz_issuer239_verdict', asApp: false,
    tamper: 'CREATE OR REPLACE FUNCTION public.warehouse_wz_issuer_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT md5(j::text)$$',
    call: 'SELECT public.wz_issuer239_verdict() v', full: 'SELECT public.warehouse_wz_issuer_guards() v',
  },
};
const NEUTER = 'CREATE OR REPLACE FUNCTION public.ordinary182_invalidate() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN NULL; END$$';
const NEUTER_KEEP = "CREATE OR REPLACE FUNCTION public.ordinary182_invalidate() RETURNS event_trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$BEGIN NULL; END$$";
const OFF = 'ALTER EVENT TRIGGER ordinary182_schema_ddl DISABLE', ON = 'ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE';
const FORGE = 'UPDATE public.ordinary182_runtime_generation SET dirty=dirty';
const INVALIDATOR_SHA = '36e95a42f9eb92117ce2f74fd8ffc3b7ae07ba0882c799f3c6eaa7c26c83c968';

const approve = () => A.query("SELECT public.ordinary187_approve(repeat('a',64),repeat('b',64),repeat('c',64))");
before(async () => {
  await migrate();
  await A.connect(); await B.connect();
  tenant = (await A.query('SELECT id FROM tenants ORDER BY created_at,id LIMIT 1')).rows[0].id;
  invalidatorDef = (await A.query("SELECT pg_get_functiondef('public.ordinary182_invalidate()'::regprocedure) d")).rows[0].d;
  await approve();
});
/** Puts the 182 machinery back exactly (the original invalidator text, no rule, triggers enabled) and re-approves. */
async function restore() {
  await A.query(`DO $$BEGIN
    IF EXISTS(SELECT FROM pg_rewrite WHERE ev_class='public.ordinary182_runtime_generation'::regclass AND rulename='zz_hide241') THEN DROP RULE zz_hide241 ON public.ordinary182_runtime_generation;END IF;
    DROP TABLE IF EXISTS public.zz_gen_shadow241;
    IF EXISTS(SELECT FROM pg_event_trigger WHERE starts_with(evtname,'ordinary182_') AND evtenabled<>'O') THEN
     ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE;ALTER EVENT TRIGGER ordinary182_temp_ddl_end ENABLE;ALTER EVENT TRIGGER ordinary182_temp_drop ENABLE;END IF;END$$`);
  const h = (await A.query("SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') h FROM pg_proc WHERE oid='public.ordinary182_invalidate()'::regprocedure")).rows[0].h;
  if (h !== INVALIDATOR_SHA) await A.query(invalidatorDef);
  assert.equal((await A.query("SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') h FROM pg_proc WHERE oid='public.ordinary182_invalidate()'::regprocedure")).rows[0].h, INVALIDATOR_SHA);
  // 258: relhasrules stays true after DROP RULE until VACUUM, and the WZ verdict records nothing while it is set;
  // "no rule" includes that flag, so the generation table is vacuumed before the re-approval.
  await A.query('VACUUM public.ordinary182_runtime_generation');
  await approve();
}
after(async () => { try { await restore(); } finally { await A.end(); await B.end(); await pool.end(); } });

const guardCalls = async (v: Verdict) => (await A.query('SELECT coalesce(sum(calls),0)::int n FROM pg_stat_xact_user_functions WHERE funcname=$1', [V[v].guard])).rows[0].n as number;
const recorded = async (v: Verdict) => (await A.query(`SELECT generation::text g,basis_sha256 b FROM ${V[v].table}`)).rows[0];
/** One call as the application makes it (buyer: SET LOCAL ROLE dyna_app; WZ: the owner), plus the full guard in the
 * same state, inside the open transaction. */
async function probe(v: Verdict) {
  const one = async (sql: string) => {
    await A.query('SAVEPOINT probe');
    if (V[v].asApp) await A.query('SET LOCAL ROLE dyna_app');
    await A.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    let r: unknown;
    try { r = (await A.query(sql)).rows[0].v; await A.query('RELEASE SAVEPOINT probe'); } catch (e: any) { r = 'ERROR ' + e.code; await A.query('ROLLBACK TO SAVEPOINT probe'); }
    if (V[v].asApp) await A.query('RESET ROLE');
    return r;
  };
  const g0 = await guardCalls(v), t = performance.now();
  const result = await one(V[v].call);
  const ms = performance.now() - t, guards = (await guardCalls(v)) - g0;
  return { result, ms, guards, full: await one(V[v].full) };
}
type Step = string | { call: Verdict };
/** Owner statements and verdict calls in one transaction (committed or rolled back); returns each call and the
 * verdict row as the transaction saw it at the end. */
async function inTx(steps: Step[], commit = false) {
  await A.query('BEGIN');
  try {
    await A.query("SET LOCAL track_functions='all'");
    const calls: Awaited<ReturnType<typeof probe>>[] = [];
    for (const s of steps) if (typeof s === 'string') await A.query(s); else calls.push(await probe(s.call));
    const seen = { buyer: await recorded('buyer'), wz: await recorded('wz') };
    await A.query(commit ? 'COMMIT' : 'ROLLBACK');
    return { calls, seen };
  } catch (e) { await A.query('ROLLBACK'); throw e; }
}
const committed = async (v: Verdict) => (await inTx([{ call: v }], true)).calls[0];
/** The verdict did not answer from its cache: the full guard's answer, from one full run when true. */
function fullGuard(r: Awaited<ReturnType<typeof probe>>, label: string) {
  if (r.result === true) assert.equal(r.guards, 1, label + ': one full guard run, not a cache hit');
  assert.deepEqual(r.result, r.full, label + ': the same answer as the full guard');
}
const warm = async () => { for (const v of ['buyer', 'wz'] as Verdict[]) { await committed(v); assert.deepEqual(((r) => [r.result, r.guards])(await committed(v)), [true, 0], v + ': cached'); } };

test('241 is applied: both verdicts ask verdict241_ddl_intact(), which is owner-only and true on the clean clone', async () => {
  assert.equal((await A.query("SELECT count(*)::int n FROM migrations WHERE name='241_verdict_gates'")).rows[0].n, 1);
  for (const f of ['buyer_available236()', 'wz_issuer239_verdict()']) {
    const src = (await A.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure', ['public.' + f])).rows[0].prosrc as string;
    assert.equal(src.split('public.verdict241_ddl_intact()').length - 1, 2, f + ': pre-check and record gate');
  }
  const acl = (await A.query(`SELECT has_function_privilege('dyna_app','public.verdict241_ddl_intact()','EXECUTE') a,
    has_function_privilege('dyna_app','public.buyer_available236()','EXECUTE') b,has_function_privilege('dyna_app','public.wz_issuer239_verdict()','EXECUTE') w,
    public.verdict241_ddl_intact() ok`)).rows[0];
  assert.deepEqual(acl, { a: false, b: true, w: false, ok: true });
});

test('the clean state keeps both fast paths; the gate itself costs well under a millisecond', async () => {
  await warm();
  const out: Record<string, number> = {};
  for (const v of ['buyer', 'wz'] as Verdict[]) {
    const runs = [];
    for (let i = 0; i < 11; i++) runs.push(await committed(v));
    for (const r of runs) assert.deepEqual([r.result, r.guards], [true, 0], v + ': hit');
    out[v + '_hit_median_ms'] = +runs.map((r) => r.ms).sort((a, b) => a - b)[5].toFixed(2);
    assert(out[v + '_hit_median_ms'] < 50, v + ' hit median stays far below the full guard');
  }
  const t = performance.now();
  for (let i = 0; i < 50; i++) assert.equal((await A.query('SELECT public.verdict241_ddl_intact() ok')).rows[0].ok, true);
  out.gate_round_trip_ms = +((performance.now() - t) / 50).toFixed(3);
  out.gate_server_ms = +(await A.query("EXPLAIN (ANALYZE, FORMAT JSON) SELECT public.verdict241_ddl_intact()")).rows[0]['QUERY PLAN'][0]['Execution Time'].toFixed(3);
  console.log(JSON.stringify({ verdict241: out }));
});

/** B takes its xid, A approves (commits after B's xid), B runs `steps` and commits: B's catalogue rows have xmin older
 * than the generation row although they committed after the approval. */
async function skewed(steps: string[]) {
  await B.query('BEGIN');
  await B.query('SELECT pg_current_xact_id()');
  await approve();
  try { for (const s of steps) await B.query(s); await B.query('COMMIT'); } catch (e) { await B.query('ROLLBACK'); throw e; }
}
const SKEWS: Record<string, string[]> = {
  // Security review of 240, t4: the invalidator neutered in a transaction that began before the approval.
  neutered_invalidator: [OFF, NEUTER, ON],
  // t5: a rule redirects the invalidator's UPDATE to a shadow table.
  generation_rule: [OFF, 'CREATE TABLE public.zz_gen_shadow241 (LIKE public.ordinary182_runtime_generation)',
    'INSERT INTO public.zz_gen_shadow241 SELECT * FROM public.ordinary182_runtime_generation',
    'CREATE RULE zz_hide241 AS ON UPDATE TO public.ordinary182_runtime_generation DO INSTEAD UPDATE public.zz_gen_shadow241 SET generation=generation+1 WHERE singleton', ON],
};
for (const [name, steps] of Object.entries(SKEWS)) for (const v of ['buyer', 'wz'] as Verdict[]) {
  test(`commit-order skew (${name}) / ${v}: later DDL caught, never recorded`, async () => {
    try {
      await warm();
      await skewed(steps);
      if ((await A.query("SELECT to_regprocedure('public.verdict241_ddl_intact()') p")).rows[0].p)
        assert.equal((await A.query('SELECT public.verdict241_ddl_intact() ok')).rows[0].ok, false, 'the gate sees the content');
      const row = await recorded(v);
      const calls = [await committed(v), await committed(v)];
      const seen = await recorded(v);
      const later = await inTx([V[v].tamper, { call: v }]);
      // The bypass first (red before 241): the verdict true while the full guard rejects the later owner DDL.
      fullGuard(later.calls[0], `${name}/${v}: later owner DDL`);
      assert.notEqual(later.calls[0].result, true, `${name}/${v}: the tampering is rejected`);
      for (const r of calls) assert.deepEqual([r.result, r.guards], [true, 1], `${name}/${v}: the full guard on every call`);
      assert.deepEqual(seen, row, `${name}/${v}: nothing is recorded`);
    } finally { await restore(); }
    await warm();
  });
}

// Security review of 240 (non-blocking): a forged generation UPDATE gives the generation row the newest xmin, so the
// xid-ordered record guard let a neutered invalidator (or another hider) through. All in one rolled-back transaction.
const HIDERS: Record<string, string[]> = {
  forged_after_neuter: [OFF, NEUTER, ON, FORGE],
  // The forged UPDATE first: once the rule exists it would be redirected as well.
  forged_after_rule: [OFF, 'CREATE TABLE public.zz_gen_shadow241 (LIKE public.ordinary182_runtime_generation)',
    'INSERT INTO public.zz_gen_shadow241 SELECT * FROM public.ordinary182_runtime_generation', FORGE,
    'CREATE RULE zz_hide241 AS ON UPDATE TO public.ordinary182_runtime_generation DO INSTEAD UPDATE public.zz_gen_shadow241 SET generation=generation+1 WHERE singleton', ON],
  // RETURN OLD keeps the approved values (RETURN NULL would make the invalidator raise 55000 itself).
  forged_after_generation_trigger: [OFF, "CREATE FUNCTION public.zz_keep241() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$",
    'CREATE TRIGGER zz_keep241 BEFORE UPDATE ON public.ordinary182_runtime_generation FOR EACH ROW WHEN (NEW.dirty AND NOT OLD.dirty) EXECUTE FUNCTION public.zz_keep241()', ON, FORGE],
  forged_after_extra_event_trigger: [OFF, "CREATE FUNCTION public.zz_evt241() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN NULL; END$$",
    'CREATE EVENT TRIGGER zz_extra241 ON ddl_command_end EXECUTE FUNCTION public.zz_evt241()', ON, FORGE],
  invalidator_config_changed: [OFF, 'ALTER FUNCTION public.ordinary182_invalidate() SECURITY INVOKER', ON, FORGE],
};
for (const v of ['buyer', 'wz'] as Verdict[]) {
  test(`a forged generation row never launders a hidden invalidator, rule, generation-table trigger or extra event trigger / ${v}`, async () => {
    for (const [name, steps] of Object.entries(HIDERS)) {
      const before = await recorded(v);
      const later = await inTx([...steps, { call: v }, V[v].tamper, { call: v }]);
      fullGuard(later.calls[1], `${name}/${v}: later DDL`);
      assert.notEqual(later.calls[1].result, true, `${name}/${v}: later DDL is caught`);
      const r = await inTx([...steps, { call: v }, { call: v }]);
      for (const c of r.calls) fullGuard(c, `${name}/${v}`);
      assert.deepEqual(r.seen[v], before, `${name}/${v}: nothing is recorded`);
    }
  });
}

// Security review of 241: with search_path pg_catalog,public an exact-type public overload beats pg_catalog.convert_to(text,
// name), so a shadow can hand the gate the original invalidator's bytes while the invalidator is neutered.
const shadowFor = (original: string) => `CREATE FUNCTION public.convert_to(t text, e text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $zz241$
  SELECT pg_catalog.convert_to(CASE WHEN t OPERATOR(pg_catalog.=) 'BEGIN NULL; END' THEN $zz241src$${original}$zz241src$ ELSE t END, e::name) $zz241$`;
async function freshSession<T>(fn: () => Promise<T>) {
  const saved = A, c = new pg.Client({ connectionString: database.href, options });
  await c.connect(); A = c;
  try { return await fn(); } finally { A = saved; await c.end(); }
}
for (const v of ['buyer', 'wz'] as Verdict[]) {
  test(`a public overload shadowing a pg_catalog function never blinds the gate / ${v}`, () => freshSession(async () => {
    const original = (await A.query("SELECT prosrc FROM pg_proc WHERE oid='public.ordinary182_invalidate()'::regprocedure")).rows[0].prosrc as string;
    assert(!original.includes('$zz241src$'));
    // The neutered body keeps the 182 header (owner, SECURITY DEFINER, configuration), so only its sha256 differs.
    const steps = [OFF, shadowFor(original), NEUTER_KEEP, ON, FORGE];
    const before = await recorded(v);
    const later = await inTx([...steps, { call: v }, V[v].tamper, { call: v }]);
    fullGuard(later.calls[1], `shadow/${v}: later DDL`);
    assert.notEqual(later.calls[1].result, true, `shadow/${v}: later DDL is caught`);
    assert.deepEqual(later.seen[v], before, `shadow/${v}: nothing is recorded`);
    // Any such shadow (created unseen, then a forged row) is refused, whatever it does.
    for (const ddl of [["CREATE FUNCTION public.lower(t text) RETURNS text LANGUAGE sql AS $$SELECT pg_catalog.lower(t)$$"],
      ['CREATE FUNCTION public.zz_eq241(a text[], b text[]) RETURNS boolean LANGUAGE sql AS $$SELECT true$$', 'CREATE OPERATOR public.= (LEFTARG=text[],RIGHTARG=text[],FUNCTION=public.zz_eq241)']]) {
      const r = await inTx([OFF, ...ddl, ON, FORGE, { call: v }, { call: v }]);
      for (const c of r.calls) fullGuard(c, `${ddl.at(-1)!.slice(0, 40)}/${v}`);
      assert.deepEqual(r.seen[v], before, `${ddl.at(-1)!.slice(0, 40)}/${v}: nothing is recorded`);
    }
  }));
}

// Security review of 241 (WZ only before the fix): the invalidator neutered and restored while event triggers were off
// in this transaction (the documented class), with owner DDL in between: every content check holds again afterwards,
// only the row versions of the public functions show it. (A rule created and dropped the same way shows only while the
// generation table's relhasrules was still false: the documented class, see docs/parity/VERDICT-GATES241-20261027.md.)
const restoreOff = () => ['SET LOCAL event_triggers=off', invalidatorDef, 'SET LOCAL event_triggers=on'];
const SWAPS: Record<string, () => string[]> = {
  swap_off: () => ['SET LOCAL event_triggers=off', NEUTER, 'SET LOCAL event_triggers=on'],
};
const UNSWAP: Record<string, () => string[]> = {
  swap_off: restoreOff,
};
for (const v of ['buyer', 'wz'] as Verdict[]) {
  test(`a function swapped and restored with event triggers off is a miss / ${v}`, async () => {
    await warm();
    for (const name of Object.keys(SWAPS)) {
      const r = await inTx([...SWAPS[name](), V[v].tamper, ...UNSWAP[name](), { call: v }]);
      fullGuard(r.calls[0], `${name}/${v}`);
      assert.notEqual(r.calls[0].result, true, `${name}/${v}: the DDL in between is caught`);
    }
  });
}

test('a caller in replica mode gets the full guard and records nothing', async () => {
  await warm();
  for (const v of ['buyer', 'wz'] as Verdict[]) {
    const before = await recorded(v);
    const plain = await inTx(['SET LOCAL session_replication_role=replica', { call: v }, { call: v }]);
    for (const c of plain.calls) fullGuard(c, v + ': replica');
    assert.deepEqual(plain.seen[v], before, v + ': nothing is recorded');
    const tampered = await inTx(['SET LOCAL session_replication_role=replica', V[v].tamper, { call: v }]);
    fullGuard(tampered.calls[0], v + ': replica + own DDL');
    assert.notEqual(tampered.calls[0].result, true, v + ': own DDL in replica mode is caught');
  }
});

// ALTER ROLE / ALTER DATABASE ... SET fires no event trigger and turns them off for every later session.
const SETTINGS = [
  'ALTER ROLE postgres SET event_triggers=off',
  `ALTER ROLE postgres IN DATABASE ${'"'}${dbName}${'"'} SET session_replication_role=replica`,
  `ALTER DATABASE ${'"'}${dbName}${'"'} SET event_triggers=off`,
  'ALTER ROLE ALL SET session_replication_role=replica',
];
test('a persistent role or database setting of event_triggers or session_replication_role refuses hit and record', async () => {
  await warm();
  for (const v of ['buyer', 'wz'] as Verdict[]) {
    for (const s of SETTINGS) {
      const before = await recorded(v);
      const r = await inTx([s, { call: v }, { call: v }]);
      // The full guard on every call (the WZ guard itself rejects some role settings: false, never a cached true).
      for (const c of r.calls) assert.deepEqual([c.result, c.guards], [c.full, 1], `${s}/${v}: the full guard on every call`);
      assert.deepEqual(r.seen[v], before, `${s}/${v}: nothing is recorded`);
    }
    // Another database's setting does not concern this one, nor (buyer) does an unrelated setting: the WZ basis (which
    // has pg_db_role_setting rows) misses once and records again, then hits; the buyer verdict hits throughout. The WZ
    // guard itself rejects any dyna_app role setting (false), so the unrelated case is buyer-only.
    for (const s of ['ALTER ROLE postgres IN DATABASE postgres SET event_triggers=off', ...(v === 'buyer' ? ["ALTER ROLE dyna_app SET work_mem='8MB'"] : [])]) {
      const r = await inTx([s, { call: v }, { call: v }]);
      assert.deepEqual(r.calls.map((c) => c.result), [true, true], s);
      assert.equal(r.calls[1].guards, 0, `${s}/${v}: recorded and hit`);
    }
  }
});

test('the 239/240 gates stay: a disabled DDL invalidator and event_triggers=off still force the full guard', async () => {
  await warm();
  for (const v of ['buyer', 'wz'] as Verdict[]) {
    for (const s of [OFF, 'ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE REPLICA', 'SET LOCAL event_triggers=off']) {
      const before = await recorded(v);
      const r = await inTx([s, { call: v }, V[v].tamper, { call: v }]);
      fullGuard(r.calls[0], `${s}/${v}`);
      fullGuard(r.calls[1], `${s}/${v}: tampered`);
      assert.notEqual(r.calls[1].result, true);
      assert.deepEqual(r.seen[v], before, `${s}/${v}: nothing is recorded`);
    }
    const fast = await committed(v);
    assert.deepEqual([fast.result, fast.guards], [true, 0], v + ': the normal state keeps the fast path');
  }
});
