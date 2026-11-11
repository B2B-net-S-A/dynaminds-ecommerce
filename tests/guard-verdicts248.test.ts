/** Migration 248 guard_verdict() on a real clone (docs/parity/GUARD-VERDICTS248-20261027.md; prepared as placeholder 256).
 * Runs on a fresh PG04 clone dynaminds_m248_YYYYMMDD_NN of the restored template; the real migrate() applies 218...248
 * (the first test asserts the ledger row 248_guard_verdicts). The clone's 182 generation is then
 * cold-approved the way release startup does it (ordinary187_approve, full native predicates under the exclusive fence).
 * Every call runs as the owner (the TS callers RESET ROLE first) with the application pool's session settings.
 * Tampering runs in transactions that are rolled back unless a case needs a committed state, which it restores.
 * The question for every case: can the verdict answer true from its cache in a state the full guard rejects? */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate, pool } from '../server/db';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:24[89]|25[0123456789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m248_YYYYMMDD_NN (or m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');
const dbName = database.pathname.slice(1);

const options = '-c jit=off -c timezone=UTC -c statement_timeout=120000 -c lock_timeout=8000';
let A = new pg.Client({ connectionString: database.href, options });
const B = new pg.Client({ connectionString: database.href, options });
let tenant = '', invalidatorDef = '';

const GUARDS = ['catalog_stock_control_guards', 'financial_return_guards', 'fa3_draft_guards'] as const;
type Guard = typeof GUARDS[number];
/** Non-function owner DDL each full guard rejects (false); the 182 invalidator would dirty the generation. */
const TAMPER: Record<Guard, string> = {
  catalog_stock_control_guards: 'ALTER TABLE public.catalog_stock_control_effects ADD COLUMN zz_probe248 int',
  financial_return_guards: 'ALTER TABLE public.financial_return_receipts ADD COLUMN zz_probe248 int',
  fa3_draft_guards: 'ALTER TABLE public.fa3_draft_projects ADD COLUMN zz_probe248 int',
};
/** The union of the sealed tables the three guards read (pg_stat_xact_all_tables on a 245 clone). */
const BASIS_TABLES = ['b2b_credit_upgrade', 'b2b_invoice_upgrade', 'buyer_address_manifest', 'catalog_stock_control_manifest',
  'catalog_stock_count_manifest', 'catalog_stock_legacy_group_manifest', 'catalog_stock_return_manifest', 'competitor_observation_manifest',
  'credit_source_upgrade_certificate', 'fa3_draft_manifest', 'financial_return_upgrade_certificate', 'local_invoice_manifest',
  'manual_inventory_off_certificate', 'migrations', 'order_merge_delivery209_manifest', 'order_merge_delivery209_projection_basis'];
const SHARED = ['pg_auth_members', 'pg_authid', 'pg_db_role_setting', 'pg_tablespace'];
const NEUTER = 'CREATE OR REPLACE FUNCTION public.ordinary182_invalidate() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN NULL; END$$';
const NEUTER_KEEP = "CREATE OR REPLACE FUNCTION public.ordinary182_invalidate() RETURNS event_trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$BEGIN NULL; END$$";
const OFF = 'ALTER EVENT TRIGGER ordinary182_schema_ddl DISABLE', ON = 'ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE';
const FORGE = 'UPDATE public.ordinary182_runtime_generation SET dirty=dirty';
const INVALIDATOR_SHA = '36e95a42f9eb92117ce2f74fd8ffc3b7ae07ba0882c799f3c6eaa7c26c83c968';
const replica = (q: string) => ['SET LOCAL session_replication_role=replica', q, 'SET LOCAL session_replication_role=origin'];

const approve = () => A.query("SELECT public.ordinary187_approve(repeat('a',64),repeat('b',64),repeat('c',64))");
before(async () => {
  await migrate();
  await A.connect(); await B.connect();
  tenant = (await A.query('SELECT id FROM tenants ORDER BY created_at,id LIMIT 1')).rows[0].id;
  invalidatorDef = (await A.query("SELECT pg_get_functiondef('public.ordinary182_invalidate()'::regprocedure) d")).rows[0].d;
});
/** Puts the 182 machinery back exactly (original invalidator, no rule, triggers enabled) and re-approves. */
async function restore() {
  await A.query(`DO $$BEGIN
    IF EXISTS(SELECT FROM pg_rewrite WHERE ev_class='public.ordinary182_runtime_generation'::regclass AND rulename='zz_hide248') THEN DROP RULE zz_hide248 ON public.ordinary182_runtime_generation;END IF;
    DROP TABLE IF EXISTS public.zz_gen_shadow248;
    IF EXISTS(SELECT FROM pg_event_trigger WHERE starts_with(evtname,'ordinary182_') AND evtenabled<>'O') THEN
     ALTER EVENT TRIGGER ordinary182_schema_ddl ENABLE;ALTER EVENT TRIGGER ordinary182_temp_ddl_end ENABLE;ALTER EVENT TRIGGER ordinary182_temp_drop ENABLE;END IF;END$$`);
  const h = async () => (await A.query("SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') h FROM pg_proc WHERE oid='public.ordinary182_invalidate()'::regprocedure")).rows[0].h;
  if (await h() !== INVALIDATOR_SHA) await A.query(invalidatorDef);
  assert.equal(await h(), INVALIDATOR_SHA);
  await approve();
}
after(async () => { try { await restore(); } finally { await A.end(); await B.end(); await pool.end(); } });

const guardCalls = async (g: Guard) => (await A.query('SELECT coalesce(sum(calls),0)::int n FROM pg_stat_xact_user_functions WHERE funcname=$1', [g])).rows[0].n as number;
const recorded = async (g: Guard) => (await A.query('SELECT generation::text g,basis_sha256 b FROM guard_verdicts WHERE guard=$1', [g])).rows[0];
const generation = async () => (await A.query('SELECT generation::text g,validated_generation::text v,dirty FROM ordinary182_runtime_generation')).rows[0];
/** One call as the application makes it (owner, tenant context), plus the full guard in the same state, inside the
 * open transaction. A raised error is caught at a savepoint. */
async function probe(g: Guard) {
  const one = async (sql: string) => {
    await A.query('SAVEPOINT probe');
    await A.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    try { const r = (await A.query(sql)).rows[0].v; await A.query('RELEASE SAVEPOINT probe'); return r as unknown; } catch (e: any) { await A.query('ROLLBACK TO SAVEPOINT probe'); return 'ERROR ' + e.code; }
  };
  const g0 = await guardCalls(g), t = performance.now();
  const result = await one(`SELECT public.guard_verdict('${g}') v`);
  const ms = performance.now() - t, guards = (await guardCalls(g)) - g0;
  return { result, ms, guards, full: await one(`SELECT public.${g}() v`) };
}
type Step = string | { call: Guard };
async function inTx(steps: Step[], o: { commit?: boolean; begin?: string } = {}) {
  await A.query(o.begin ?? 'BEGIN');
  try {
    await A.query("SET LOCAL track_functions='all'");
    const calls: Awaited<ReturnType<typeof probe>>[] = [];
    for (const s of steps) if (typeof s === 'string') await A.query(s); else calls.push(await probe(s.call));
    const seen = Object.fromEntries(await Promise.all(GUARDS.map(async (g) => [g, await recorded(g)])));
    await A.query(o.commit ? 'COMMIT' : 'ROLLBACK');
    return { calls, seen };
  } catch (e) { await A.query('ROLLBACK'); throw e; }
}
const committed = async (g: Guard) => (await inTx([{ call: g }], { commit: true })).calls[0];
/** The verdict did not answer from its cache: the full guard's answer, from one full run when true. */
function fullGuard(r: Awaited<ReturnType<typeof probe>>, label: string) {
  if (r.result === true) assert.equal(r.guards, 1, label + ': one full guard run, not a cache hit');
  assert.deepEqual(r.result, r.full, label + ': the same answer as the full guard');
}
const warm = async () => { for (const g of GUARDS) { await committed(g); assert.deepEqual(((r) => [r.result, r.guards])(await committed(g)), [true, 0], g + ': cached'); } };

test('248 is applied; each guard reads only basis tables and shared catalogues; together exactly the basis', async () => {
  assert.notEqual((await A.query("SELECT to_regprocedure('public.guard_verdict(text)') p")).rows[0].p, null, '248 applied');
  assert.equal((await A.query("SELECT count(*)::int n FROM migrations WHERE name='248_guard_verdicts'")).rows[0].n, 1, 'ledger row 248_guard_verdicts written by migrate()');
  const union = new Set<string>(), shared = new Set<string>();
  for (const g of GUARDS) {
    await A.query('BEGIN READ ONLY');
    try {
      const scans = async () => new Map((await A.query(`SELECT x.relname,c.relisshared s,(x.seq_scan+coalesce(x.idx_scan,0))::int n
        FROM pg_stat_xact_all_tables x JOIN pg_class c ON c.oid=x.relid WHERE x.schemaname IN ('public','pg_catalog')`)).rows.map((r) => [r.relname, r]));
      const s0 = await scans();
      assert.equal((await A.query(`SELECT public.${g}() v`)).rows[0].v, true, g);
      const read = [...(await scans()).values()].filter((r) => r.n > (s0.get(r.relname)?.n ?? 0));
      const own = read.filter((r) => !r.relname.startsWith('pg_')).map((r) => r.relname);
      for (const t of own) { assert(BASIS_TABLES.includes(t), `${g} reads ${t}, which must be in the basis`); union.add(t); }
      for (const r of read.filter((x) => x.s)) { assert(SHARED.includes(r.relname), `${g} reads shared ${r.relname}`); shared.add(r.relname); }
    } finally { await A.query('ROLLBACK'); }
  }
  assert.deepEqual([...union].sort(), BASIS_TABLES, 'the basis has no table none of the guards reads');
  console.log(JSON.stringify({ shared_read: [...shared].sort() }));
  const basis = (await A.query("SELECT prosrc FROM pg_proc WHERE oid='public.guard_verdict_basis()'::regprocedure")).rows[0].prosrc as string;
  for (const t of BASIS_TABLES) assert.match(basis, new RegExp(`FROM public\\.${t}\\)`), `${t} rows are in the basis`);
  for (const t of SHARED) assert.match(basis, new RegExp(`FROM pg_catalog\\.${t}\\)`), `${t} is in the basis`);
});

test('no privilege for dyna_app on the verdict table or any 248 function; an unknown guard name is refused', async () => {
  const acl = (await A.query(`SELECT has_function_privilege('dyna_app','public.guard_verdict(text)','EXECUTE') v,
    has_function_privilege('dyna_app','public.guard_verdict_basis()','EXECUTE') b,has_function_privilege('dyna_app','public.guard_verdict_full(text)','EXECUTE') f,
    has_function_privilege('public','public.guard_verdict(text)','EXECUTE') p,
    has_table_privilege('dyna_app','public.guard_verdicts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') t`)).rows[0];
  assert.deepEqual(acl, { v: false, b: false, f: false, p: false, t: false });
  await A.query('BEGIN');
  try {
    await A.query('SET LOCAL ROLE dyna_app');
    for (const q of ['UPDATE guard_verdicts SET generation=1', 'SELECT * FROM guard_verdicts', "SELECT public.guard_verdict('fa3_draft_guards')", 'SELECT public.guard_verdict_basis()']) {
      await A.query('SAVEPOINT denied');
      await assert.rejects(A.query(q), (e: any) => e.code === '42501', q);
      await A.query('ROLLBACK TO SAVEPOINT denied');
    }
    await A.query('RESET ROLE');
    for (const name of ['buyer_address_guards', 'warehouse_wz_issuer_guards', '', 'catalog_stock_control_guards;']) {
      await A.query('SAVEPOINT unknown');
      await assert.rejects(A.query('SELECT public.guard_verdict($1)', [name]), (e: any) => e.code === '22023', name);
      await A.query('ROLLBACK TO SAVEPOINT unknown');
    }
  } finally { await A.query('ROLLBACK'); }
});

test('without a cold-approved generation every call runs the full guard and nothing is recorded', async () => {
  await A.query('COMMENT ON TABLE guard_verdicts IS NULL'); // committed no-op owner DDL: dirty generation
  assert.equal((await generation()).dirty, true);
  for (const g of GUARDS) {
    for (let i = 0; i < 2; i++) assert.deepEqual(((r) => [r.result, r.guards])(await committed(g)), [true, 1], g + ': full guard on every call');
    assert.equal((await recorded(g)).g, null, g + ': nothing is recorded for an unapproved schema');
  }
});

test('cold-approved generation: one full verification per guard, then the verdict is reused cheaply', async () => {
  const g0 = (await approve()).rows[0];
  assert(g0);
  const out: Record<string, unknown> = {};
  for (const g of GUARDS) {
    const first = await committed(g);
    assert.deepEqual([first.result, first.guards], [true, 1], g);
    assert.equal((await recorded(g)).g, (await generation()).g);
    const runs = [];
    for (let i = 0; i < 7; i++) runs.push(await committed(g));
    for (const r of runs) assert.deepEqual([r.result, r.guards], [true, 0], g + ': no full guard while the basis is unchanged');
    const median = runs.map((r) => r.ms).sort((a, b) => a - b)[3];
    out[g] = { first_ms: +first.ms.toFixed(1), hit_median_ms: +median.toFixed(2) };
    assert(median < 50, `${g}: reused verdict median ${median.toFixed(1)} ms must stay far below the full guard`);
    if (first.ms > 200) assert(median * 10 < first.ms, g + ': reused verdict is far cheaper than the full verification');
  }
  console.log(JSON.stringify({ guard_verdict_ms: out }));
});

test('read-only READ COMMITTED reuses but never records; REPEATABLE READ and SERIALIZABLE always run the full guard', async () => {
  for (const g of GUARDS) {
    const before = await recorded(g);
    const ro = await inTx([{ call: g }], { begin: 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' });
    assert.deepEqual([ro.calls[0].result, ro.calls[0].guards], [true, 0], g);
    for (const begin of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'BEGIN ISOLATION LEVEL REPEATABLE READ', 'BEGIN ISOLATION LEVEL SERIALIZABLE']) {
      const r = await inTx([{ call: g }], { begin });
      assert.deepEqual([r.calls[0].result, r.calls[0].guards], [true, 1], `${g} ${begin}: a snapshot may predate committed owner DDL`);
    }
    await A.query("UPDATE guard_verdicts SET basis_sha256=repeat('0',64) WHERE guard=$1", [g]);
    const roMiss = await inTx([{ call: g }], { begin: 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' });
    assert.deepEqual([roMiss.calls[0].result, roMiss.calls[0].guards], [true, 1], g + ': a forged verdict basis is a miss');
    assert.equal((await recorded(g)).b, '0'.repeat(64), g + ': a read-only transaction records nothing');
    const rw = await committed(g);
    assert.deepEqual([rw.result, rw.guards], [true, 1]);
    assert.deepEqual(await recorded(g), before, g + ': the next read-write call records the true basis again');
  }
});

test('a changed row of any basis table (also in replica mode, also unchanged in value) forces the full guard; real tampering is rejected', async () => {
  for (const g of GUARDS) {
    const own = { catalog_stock_control_guards: 'catalog_stock_control_manifest', financial_return_guards: 'financial_return_upgrade_certificate', fa3_draft_guards: 'fa3_draft_manifest' }[g];
    const touched = await inTx([...replica(`UPDATE ${own} SET ${own === 'financial_return_upgrade_certificate' ? 'profile=profile' : 'fingerprint=fingerprint'}`), { call: g }]);
    assert.deepEqual([touched.calls[0].result, touched.calls[0].guards], [true, 1], g + ': new row version -> new basis -> full guard');
    const gone = await inTx([...replica(`DELETE FROM ${own}`), { call: g }]);
    fullGuard(gone.calls[0], g + ': own manifest deleted');
    assert.notEqual(gone.calls[0].result, true, g + ': tampering is rejected');
    const genRow = await inTx(['UPDATE ordinary182_runtime_generation SET generation=generation', { call: g }]);
    assert.deepEqual([genRow.calls[0].result, genRow.calls[0].guards], [true, 1], g + ': a rewritten generation row (same values) is a new basis');
  }
  for (const t of BASIS_TABLES) {
    const steps: Step[] = [...replica(`DELETE FROM ${t} WHERE ctid=(SELECT min(ctid) FROM ${t})`)];
    for (const g of GUARDS) steps.push({ call: g });
    const r = await inTx(steps);
    for (const c of r.calls) fullGuard(c, t + ': a deleted row forces the full guard');
  }
});

test('roles, memberships, role settings, tablespaces and event triggers fire no DDL event yet force the full guard', async () => {
  for (const g of GUARDS) {
    for (const s of [['ALTER ROLE dyna_app CREATEDB'], ['CREATE ROLE p248_probe_role NOLOGIN', 'GRANT p248_probe_role TO dyna_app'],
      ["ALTER ROLE dyna_app SET work_mem='8MB'"], ['ALTER TABLESPACE pg_default SET (seq_page_cost=1)'], [OFF]]) {
      const r = await inTx([...s, { call: g }]);
      fullGuard(r.calls[0], `${g}: ${s.at(-1)}`);
    }
    assert.equal((await generation()).dirty, false, 'none of them moves the 182 generation (all rolled back)');
  }
});

test('a disabled or replica-only 182 event trigger is never re-baselined; DDL it no longer sees is caught', async () => {
  try {
    for (const state of ['DISABLE', 'ENABLE REPLICA']) {
      await warm();
      await A.query(`ALTER EVENT TRIGGER ordinary182_schema_ddl ${state}`);
      for (const g of GUARDS) {
        const before = await recorded(g);
        for (let i = 0; i < 2; i++) assert.deepEqual(((r) => [r.result, r.guards])(await committed(g)), [true, 1], `${state}/${g}: full guard, every call`);
        assert.deepEqual(await recorded(g), before, `${state}/${g}: nothing is recorded`);
        const silent = await inTx([TAMPER[g], { call: g }]);
        fullGuard(silent.calls[0], `${state}/${g}: DDL unseen by the invalidator`);
        assert.notEqual(silent.calls[0].result, true);
      }
      assert.equal((await generation()).dirty, false, 'the DDL went unseen by the disabled invalidator');
      // ENABLE fires no event trigger; the 240 record guard refuses to re-baseline until the next cold approval.
      await A.query(ON);
      const back = await committed(GUARDS[0]);
      assert.deepEqual([back.result, back.guards], [true, 1], 'after the round trip: a miss that records nothing');
      await approve();
    }
  } finally { await A.query(ON); await approve(); }
  for (const setup of [['DROP EVENT TRIGGER ordinary182_temp_drop'], ['SET LOCAL event_triggers=off']])
    for (const g of GUARDS) fullGuard((await inTx([...setup, { call: g }])).calls[0], `${setup[0]}/${g}`);
});

test('owner DDL dirties the generation; the tampered state is caught; a replaced own basis is DDL too', async () => {
  await warm();
  for (const g of GUARDS) {
    const ddl = await inTx([TAMPER[g], { call: g }]);
    fullGuard(ddl.calls[0], g + ': tampered');
    assert.notEqual(ddl.calls[0].result, true, g);
    const own = await inTx(["CREATE OR REPLACE FUNCTION public.guard_verdict_basis() RETURNS text LANGUAGE sql STABLE AS $$SELECT ''$$", { call: g }]);
    assert.equal(own.calls[0].guards, 1, g + ': a replaced 248 basis is owner DDL (dirty generation)');
  }
  for (const g of GUARDS) assert.deepEqual(((r) => [r.result, r.guards])(await committed(g)), [true, 0], g + ': after rollback the recorded verdict applies again');
});

test('session state the full guard depends on: replica mode, TimeZone and other settings are a different basis', async () => {
  for (const g of GUARDS) {
    const rep = await inTx(['SET LOCAL session_replication_role=replica', { call: g }]);
    fullGuard(rep.calls[0], g + ': replica mode');
    const repDdl = await inTx(['SET LOCAL session_replication_role=replica', TAMPER[g], { call: g }]);
    fullGuard(repDdl.calls[0], g + ': replica mode + own DDL');
    assert.notEqual(repDdl.calls[0].result, true);
    for (const s of ["SET LOCAL TimeZone='Europe/Warsaw'", "SET LOCAL DateStyle='SQL, DMY'", 'SET LOCAL extra_float_digits=0', "SET LOCAL bytea_output='escape'"]) {
      // A different session basis: the full guard answers (some of them raise 55000 outside UTC; a raising call is
      // not counted by pg_stat, a hit never raises).
      const r = await inTx([s, { call: g }]);
      fullGuard(r.calls[0], `${g}: ${s}`);
      assert(r.calls[0].result !== true || r.calls[0].guards === 1, `${g}: ${s} is not a hit`);
    }
  }
});

test('a TEMP relation or type of this session forces the full guard; another session\'s TEMP objects are a new basis', async () => {
  const asApp = (ddl: string) => ['SET LOCAL ROLE dyna_app', ddl, 'RESET ROLE'];
  for (const g of GUARDS) {
    for (const ddl of [...BASIS_TABLES.map((t) => `CREATE TEMP TABLE ${t} (x int)`), 'CREATE TEMP TABLE orders (x int)',
      'CREATE TYPE pg_temp.jsonb AS (x int)', 'CREATE DOMAIN pg_temp.text AS integer', 'CREATE TEMP TABLE p248_unrelated (x int)', 'CREATE TEMP SEQUENCE p248_seq']) {
      const r = await inTx([...asApp(ddl), { call: g }]);
      fullGuard(r.calls[0], `${g}: ${ddl}`);
    }
  }
  assert.equal((await generation()).dirty, false, 'TEMP DDL does not move the 182 generation');
  await warm();
  await B.query("SELECT set_config('app.tenant_id',$1,false)", [tenant]);
  await B.query('SET ROLE dyna_app');
  try {
    await B.query('CREATE TEMP TABLE p248_other (x int)');
    for (const g of GUARDS) fullGuard((await inTx([{ call: g }])).calls[0], g + ': a TEMP table in another session is a new basis');
  } finally { await B.query('DISCARD TEMP'); await B.query('RESET ROLE'); }
  for (const g of GUARDS) assert.equal((await committed(g)).guards, 0, g + ': back to the recorded basis');
});

/** B takes its xid, A approves (commits after B's xid), B runs `steps` and commits (security review of 240, t4/t5). */
async function skewed(steps: string[]) {
  await B.query('BEGIN');
  await B.query('SELECT pg_current_xact_id()');
  await approve();
  try { for (const s of steps) await B.query(s); await B.query('COMMIT'); } catch (e) { await B.query('ROLLBACK'); throw e; }
}
const SKEWS: Record<string, string[]> = {
  neutered_invalidator: [OFF, NEUTER, ON],
  generation_rule: [OFF, 'CREATE TABLE public.zz_gen_shadow248 (LIKE public.ordinary182_runtime_generation)',
    'INSERT INTO public.zz_gen_shadow248 SELECT * FROM public.ordinary182_runtime_generation',
    'CREATE RULE zz_hide248 AS ON UPDATE TO public.ordinary182_runtime_generation DO INSTEAD UPDATE public.zz_gen_shadow248 SET generation=generation+1 WHERE singleton', ON],
};
for (const [name, steps] of Object.entries(SKEWS)) {
  test(`commit-order skew (${name}): later DDL caught, never recorded, for every guard`, async () => {
    try {
      await warm();
      await skewed(steps);
      assert.equal((await A.query('SELECT public.verdict241_ddl_intact() ok')).rows[0].ok, false, 'the 241 gate sees the content');
      for (const g of GUARDS) {
        const row = await recorded(g);
        const calls = [await committed(g), await committed(g)];
        const later = await inTx([TAMPER[g], { call: g }]);
        fullGuard(later.calls[0], `${name}/${g}: later owner DDL`);
        assert.notEqual(later.calls[0].result, true, `${name}/${g}: the tampering is rejected`);
        for (const r of calls) assert.deepEqual([r.result, r.guards], [true, 1], `${name}/${g}: the full guard on every call`);
        assert.deepEqual(await recorded(g), row, `${name}/${g}: nothing is recorded`);
      }
    } finally { await restore(); }
    await warm();
  });
}

const HIDERS: Record<string, string[]> = {
  forged_after_neuter: [OFF, NEUTER, ON, FORGE],
  forged_after_rule: [OFF, 'CREATE TABLE public.zz_gen_shadow248 (LIKE public.ordinary182_runtime_generation)',
    'INSERT INTO public.zz_gen_shadow248 SELECT * FROM public.ordinary182_runtime_generation', FORGE,
    'CREATE RULE zz_hide248 AS ON UPDATE TO public.ordinary182_runtime_generation DO INSTEAD UPDATE public.zz_gen_shadow248 SET generation=generation+1 WHERE singleton', ON],
  forged_after_generation_trigger: [OFF, 'CREATE FUNCTION public.zz_keep248() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$',
    'CREATE TRIGGER zz_keep248 BEFORE UPDATE ON public.ordinary182_runtime_generation FOR EACH ROW WHEN (NEW.dirty AND NOT OLD.dirty) EXECUTE FUNCTION public.zz_keep248()', ON, FORGE],
  forged_after_extra_event_trigger: [OFF, 'CREATE FUNCTION public.zz_evt248() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN NULL; END$$',
    'CREATE EVENT TRIGGER zz_extra248 ON ddl_command_end EXECUTE FUNCTION public.zz_evt248()', ON, FORGE],
  invalidator_config_changed: [OFF, 'ALTER FUNCTION public.ordinary182_invalidate() SECURITY INVOKER', ON, FORGE],
};
test('a forged generation row never launders a hidden invalidator, rule, generation-table trigger or extra event trigger', async () => {
  await warm();
  for (const [name, steps] of Object.entries(HIDERS)) for (const g of GUARDS) {
    const before = await recorded(g);
    const later = await inTx([...steps, { call: g }, TAMPER[g], { call: g }]);
    fullGuard(later.calls[0], `${name}/${g}`);
    fullGuard(later.calls[1], `${name}/${g}: later DDL`);
    assert.notEqual(later.calls[1].result, true, `${name}/${g}: later DDL is caught`);
    assert.deepEqual(later.seen[g], before, `${name}/${g}: nothing is recorded`);
  }
});

const shadowFor = (original: string) => `CREATE FUNCTION public.convert_to(t text, e text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $zz248$
  SELECT pg_catalog.convert_to(CASE WHEN t OPERATOR(pg_catalog.=) 'BEGIN NULL; END' THEN $zz248src$${original}$zz248src$ ELSE t END, e::name) $zz248$`;
test('a public overload shadowing a pg_catalog function never blinds the gate', async () => {
  const saved = A, c = new pg.Client({ connectionString: database.href, options });
  await c.connect(); A = c;
  try {
    const original = (await A.query("SELECT prosrc FROM pg_proc WHERE oid='public.ordinary182_invalidate()'::regprocedure")).rows[0].prosrc as string;
    const steps = [OFF, shadowFor(original), NEUTER_KEEP, ON, FORGE];
    for (const g of GUARDS) {
      const before = await recorded(g);
      const later = await inTx([...steps, { call: g }, TAMPER[g], { call: g }]);
      fullGuard(later.calls[1], `shadow/${g}: later DDL`);
      assert.notEqual(later.calls[1].result, true, `shadow/${g}: later DDL is caught`);
      assert.deepEqual(later.seen[g], before, `shadow/${g}: nothing is recorded`);
    }
  } finally { A = saved; await c.end(); }
});

test('a function swapped and restored with event triggers off, with owner DDL in between, is a miss', async () => {
  await warm();
  for (const g of GUARDS) {
    const r = await inTx(['SET LOCAL event_triggers=off', NEUTER, 'SET LOCAL event_triggers=on', TAMPER[g], 'SET LOCAL event_triggers=off', invalidatorDef, 'SET LOCAL event_triggers=on', { call: g }]);
    fullGuard(r.calls[0], g);
    assert.notEqual(r.calls[0].result, true, g + ': the DDL in between is caught');
  }
});

const SETTINGS = [
  'ALTER ROLE postgres SET event_triggers=off',
  `ALTER ROLE postgres IN DATABASE "${dbName}" SET session_replication_role=replica`,
  `ALTER DATABASE "${dbName}" SET event_triggers=off`,
  'ALTER ROLE ALL SET session_replication_role=replica',
];
test('a persistent role or database setting of event_triggers or session_replication_role refuses hit and record', async () => {
  await warm();
  for (const g of GUARDS) {
    for (const s of SETTINGS) {
      const before = await recorded(g);
      const r = await inTx([s, { call: g }, { call: g }]);
      for (const c of r.calls) assert.deepEqual([c.result, c.guards], [c.full, 1], `${s}/${g}: the full guard on every call`);
      assert.deepEqual(r.seen[g], before, `${s}/${g}: nothing is recorded`);
    }
  }
});

test('the hit does not depend on the tenant: the verdict is an installation fact', async () => {
  await warm();
  const tenants = (await A.query('SELECT id FROM tenants ORDER BY id LIMIT 3')).rows.map((r) => r.id as string);
  for (const t of tenants) for (const g of GUARDS) {
    const saved = tenant; tenant = t;
    try { assert.deepEqual(((r) => [r.result, r.guards, r.full])((await inTx([{ call: g }])).calls[0]), [true, 0, true], `${t}/${g}`); } finally { tenant = saved; }
  }
});
