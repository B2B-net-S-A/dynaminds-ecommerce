/** Migration 255_stock_verdict (prepared as 270) stock_verdict_ family on a real clone (docs/parity/CATALOG-STOCK-GEN270-20261029.md
 * "Integracja jako 255"). Runs on a fresh PG04 clone dynaminds_m255_YYYYMMDD_NN of the restored template: the real migrate()
 * brings it to HEAD and applies 255 with its ledger row (the prepared run applied 270 by hand; that step is dropped), and the 182
 * generation is cold-approved the way the other verdict tests do (ordinary187_approve).
 * Every call runs as the owner with the application pool's session settings, in transactions that are rolled back.
 * The questions: is each copy exactly its sealed original apart from the guard call; does it answer (value or error) as
 * the sealed function in every state, also one the full guard rejects; and does it skip the full guard only on a hit? */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate, pool } from '../server/db';
import { beginCatalogStockControlTransaction, endCatalogStockControlTransaction } from '../server/catalog-stock-control-transaction';
import { prepareCatalogStockEffectInTx } from '../server/catalog-stock-control';
import { prepareCatalogStockReturnInTx } from '../server/catalog-stock-return-effects';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:25[56789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m255_YYYYMMDD_NN required');

const options = '-c jit=off -c timezone=UTC -c statement_timeout=120000 -c lock_timeout=8000';
const A = new pg.Client({ connectionString: database.href, options });
const R = ['public.catalog_stock_control_require()', 'public.stock_verdict_require()'] as const;
/** copy, sealed original, the only substitutions in its body. */
const FAMILY: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
  ['stock_verdict_require()', 'catalog_stock_control_require()', [['public.catalog_stock_control_guards()', "public.guard_verdict('catalog_stock_control_guards')"]]],
  ['stock_verdict_return_require()', 'catalog_stock_return_require()', [R]],
  ['stock_verdict_return_frame(uuid,uuid,jsonb)', 'catalog_stock_return_frame(uuid,uuid,jsonb)', [R]],
  ['stock_verdict_effect_prepare(uuid,uuid,jsonb)', 'catalog_stock_control_effect_prepare(uuid,uuid,jsonb)', [R]],
  ['stock_verdict_effect_finish(uuid,uuid,uuid,jsonb)', 'catalog_stock_control_effect_finish(uuid,uuid,uuid,jsonb)', [R]],
  ['stock_verdict_return_prepare(uuid,uuid,jsonb)', 'catalog_stock_return_prepare(uuid,uuid,jsonb)', [
    ['public.catalog_stock_return_require()', 'public.stock_verdict_return_require()'],
    ['public.catalog_stock_return_frame(', 'public.stock_verdict_return_frame('],
    ['public.catalog_stock_control_effect_prepare(', 'public.stock_verdict_effect_prepare(']]],
];
type Fixture = { strictTenant: string; strictAdmin: string; strictProduct: string; strictWarehouse: string; historicalReturn: string;
  plainTenant: string; plainAdmin: string; plainProduct: string; plainWarehouse: string };
let f: Fixture;
const approve = () => A.query("SELECT public.ordinary187_approve(repeat('a',64),repeat('b',64),repeat('c',64))");

before(async () => {
  await migrate();
  await A.connect();
  assert.equal((await A.query("SELECT count(*)::int n FROM migrations WHERE name='255_stock_verdict'")).rows[0].n, 1, 'the real migrate() applied 255 with its ledger row');
  await approve();
  const s = (await A.query(`SELECT p.tenant_id t,p.id p,(SELECT m.user_id FROM memberships m WHERE m.tenant_id=p.tenant_id AND m.role='admin' ORDER BY m.user_id LIMIT 1) u,
    (SELECT r.id FROM return_cases r WHERE r.tenant_id=p.tenant_id AND r.state<>'requested' AND EXISTS(SELECT FROM return_items i,jsonb_array_elements(i.components) c
      WHERE (i.tenant_id,i.return_id)=(r.tenant_id,r.id) AND c->>'product_id'=p.id::text) ORDER BY r.id LIMIT 1) r,
    (SELECT r.warehouse_id FROM return_cases r WHERE r.tenant_id=p.tenant_id AND EXISTS(SELECT FROM return_items i,jsonb_array_elements(i.components) c
      WHERE (i.tenant_id,i.return_id)=(r.tenant_id,r.id) AND c->>'product_id'=p.id::text) ORDER BY r.id LIMIT 1) w
    FROM products p JOIN catalog_stock_control_policies h ON (h.tenant_id,h.catalog_id)=(p.tenant_id,p.catalog_id) ORDER BY p.tenant_id,p.id LIMIT 1`)).rows[0];
  const n = (await A.query(`SELECT p.tenant_id t,p.id p,(SELECT m.user_id FROM memberships m WHERE m.tenant_id=p.tenant_id AND m.role='admin' ORDER BY m.user_id LIMIT 1) u,
    (SELECT w.id FROM warehouses w WHERE w.tenant_id=p.tenant_id ORDER BY w.id LIMIT 1) w FROM products p
    WHERE NOT EXISTS(SELECT FROM catalog_stock_control_policies h WHERE h.tenant_id=p.tenant_id) ORDER BY p.tenant_id,p.id LIMIT 1`)).rows[0];
  assert(s?.u && s.r && s.w && n?.u && n.w, 'template fixture: a strict product with an admin and a non-requested return; a tenant without strict catalogs');
  f = { strictTenant: s.t, strictAdmin: s.u, strictProduct: s.p, strictWarehouse: s.w, historicalReturn: s.r, plainTenant: n.t, plainAdmin: n.u, plainProduct: n.p, plainWarehouse: n.w };
});
after(async () => { try { await A.end(); } finally { await pool.end(); } });

const calls = async (name: string) => +(await A.query('SELECT coalesce(sum(calls),0) n FROM pg_stat_xact_user_functions WHERE funcname=$1', [name])).rows[0].n;
/** One call at a savepoint inside the open transaction: its value (or error code) and the full guards it ran. */
async function call(tenant: string, sql: string, params: unknown[]) {
  await A.query('SAVEPOINT c270');
  await A.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  const g0 = await calls('catalog_stock_control_guards');
  let value: unknown;
  try { value = (await A.query(sql, params)).rows[0].v; await A.query('RELEASE SAVEPOINT c270'); }
  catch (e: any) { value = 'ERROR ' + e.code + ' ' + e.message; await A.query('ROLLBACK TO SAVEPOINT c270'); }
  return { value, guards: (await calls('catalog_stock_control_guards')) - g0 };
}
async function inTx<T>(work: () => Promise<T>, o: { begin?: string; commit?: boolean } = {}) {
  await A.query(o.begin ?? 'BEGIN');
  try { await A.query("SET LOCAL track_functions='all'"); const r = await work(); await A.query(o.commit ? 'COMMIT' : 'ROLLBACK'); return r; }
  catch (e) { await A.query('ROLLBACK'); throw e; }
}
/** A committed RC call records the verdict, as the application's first write does. */
const warm = () => inTx(async () => { assert.equal((await A.query("SELECT public.guard_verdict('catalog_stock_control_guards') v")).rows[0].v, true); }, { commit: true });
const src = (kind: string, w: string, p: string) => JSON.stringify({ source_kind: kind, source_id: randomUUID(), warehouse_ids: [w], product_ids: [p] });
/** [label, tenant, sealed SQL, copy SQL, params]: each pair is asked in the same state. */
const pairs = () => {
  const plain = src('dispatch', f.plainWarehouse, f.plainProduct), strict = src('dispatch', f.strictWarehouse, f.strictProduct);
  const ret = JSON.stringify({ return_id: f.historicalReturn, protocol: 'rma', request: { version: 0, items: [] } });
  return [
    ['require', f.plainTenant, 'SELECT public.catalog_stock_control_require()::text v', 'SELECT public.stock_verdict_require()::text v', []],
    ['return require', f.strictTenant, 'SELECT public.catalog_stock_return_require()::text v', 'SELECT public.stock_verdict_return_require()::text v', []],
    ['effect prepare, no strict catalog (NULL)', f.plainTenant, 'SELECT public.catalog_stock_control_effect_prepare($1,NULL,$2::jsonb) v', 'SELECT public.stock_verdict_effect_prepare($1,NULL,$2::jsonb) v', [f.plainAdmin, plain]],
    ['effect prepare, strict catalog (admission)', f.strictTenant, "SELECT public.catalog_stock_control_effect_prepare($1,NULL,$2::jsonb)-'id' v", "SELECT public.stock_verdict_effect_prepare($1,NULL,$2::jsonb)-'id' v", [f.strictAdmin, strict]],
    ['effect prepare, foreign operator (42501)', f.plainTenant, 'SELECT public.catalog_stock_control_effect_prepare($1,NULL,$2::jsonb) v', 'SELECT public.stock_verdict_effect_prepare($1,NULL,$2::jsonb) v', [randomUUID(), plain]],
    ['effect finish, unknown admission (23514)', f.strictTenant, 'SELECT public.catalog_stock_control_effect_finish($1,NULL,$2,$3::jsonb)::text v', 'SELECT public.stock_verdict_effect_finish($1,NULL,$2,$3::jsonb)::text v', [f.strictAdmin, randomUUID(), '{}']],
    ['return frame, closed RMA', f.strictTenant, 'SELECT public.catalog_stock_return_frame($1,NULL,$2::jsonb) v', 'SELECT public.stock_verdict_return_frame($1,NULL,$2::jsonb) v', [f.strictAdmin, ret]],
    ['return prepare, closed RMA', f.strictTenant, 'SELECT public.catalog_stock_return_prepare($1,NULL,$2::jsonb) v', 'SELECT public.stock_verdict_return_prepare($1,NULL,$2::jsonb) v', [f.strictAdmin, ret]],
  ] as const;
};

test('255 is applied: exactly the six owner-only stock_verdict_ functions, nothing granted', async () => {
  const rows = (await A.query(`SELECT p.oid::regprocedure::text sig,p.proowner::regrole::text owner,p.proacl::text acl,
    has_function_privilege('dyna_app',p.oid,'EXECUTE') app,has_function_privilege('public',p.oid,'EXECUTE') pub
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'stock\\_verdict\\_%' ORDER BY 1`)).rows;
  assert.deepEqual(rows.map((r) => r.sig), FAMILY.map(([c]) => c).sort());
  for (const r of rows) assert.deepEqual([r.owner, r.acl, r.app, r.pub], ['postgres', '{postgres=X/postgres}', false, false], r.sig);
});

test('each copy is its sealed original with only the declared calls swapped: same body, declarations, owner and ACL', async () => {
  const meta = `SELECT p.prosrc,p.proargtypes::text,p.proargnames::text,p.proargmodes::text,p.prorettype::regtype::text rettype,p.prolang,
    p.prosecdef,p.provolatile,p.proparallel,p.proisstrict,p.proleakproof,p.procost,p.prorows,p.prokind,p.proconfig::text,
    p.proowner,p.proacl::text,pg_get_function_arguments(p.oid) args FROM pg_proc p WHERE p.oid=$1::regprocedure`;
  for (const [copy, sealed, subs] of FAMILY) {
    const c = (await A.query(meta, ['public.' + copy])).rows[0], s = (await A.query(meta, ['public.' + sealed])).rows[0];
    let expected = s.prosrc as string;
    for (const [from, to] of subs) { assert(expected.includes(from), `${sealed} calls ${from}`); expected = expected.split(from).join(to); }
    assert.equal(c.prosrc, expected, copy + ': body = sealed body with the declared substitutions');
    for (const k of Object.keys(s)) if (k !== 'prosrc') assert.deepEqual(c[k], s[k], `${copy}: ${k} as ${sealed}`);
  }
});

test('the guards stay true with the family installed; the sealed bodies and their fingerprints do not move', async () => {
  await inTx(async () => {
    for (const g of ['catalog_stock_control_guards', 'catalog_stock_return_guards', 'financial_return_guards', 'manual_inventory_off_valid'])
      assert.equal((await A.query(`SELECT public.${g}() v`)).rows[0].v, true, g);
  }, { begin: 'BEGIN READ ONLY' });
});

test('approved generation, READ COMMITTED write transaction: every copy answers as its sealed original without a full guard', async () => {
  await warm();
  const out = await inTx(async () => {
    const r: Record<string, unknown> = {};
    for (const [label, tenant, sealed, copy, params] of pairs()) {
      const s = await call(tenant, sealed, [...params]), c = await call(tenant, copy, [...params]);
      assert.deepEqual(c.value, s.value, label + ': same value or error');
      assert(s.guards >= 1, label + ': the sealed function runs the full guard');
      assert.equal(c.guards, 0, label + ': the copy answers from the recorded verdict');
      r[label] = [String(s.value).slice(0, 60), s.guards, c.guards];
    }
    return r;
  });
  console.log(JSON.stringify(out));
});

test('REPEATABLE READ: the copies run the full guard, as the 248 verdict does outside READ COMMITTED', async () => {
  await warm();
  await inTx(async () => {
    for (const [label, tenant, sealed, copy, params] of pairs().filter(([l]) => l === 'require' || l.startsWith('effect prepare, no'))) {
      const s = await call(tenant, sealed, [...params]), c = await call(tenant, copy, [...params]);
      assert.deepEqual(c.value, s.value, label);
      assert.equal(c.guards, s.guards, label + ': the same full guard runs');
    }
  }, { begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ' });
});

test('a state the full guard rejects: every copy refuses as the sealed original (owner DDL and a replica-mode manifest change)', async () => {
  await warm();
  for (const tamper of [
    ['ALTER TABLE public.catalog_stock_control_effects ADD COLUMN zz_probe270 int'],
    ['SET LOCAL session_replication_role=replica', "UPDATE public.catalog_stock_control_manifest SET fingerprint=repeat('0',64)", 'SET LOCAL session_replication_role=origin'],
  ]) await inTx(async () => {
    for (const q of tamper) await A.query(q);
    assert.equal((await A.query('SELECT public.catalog_stock_control_guards() v')).rows[0].v, false, tamper[0] + ': the full guard rejects');
    for (const [label, tenant, sealed, copy, params] of pairs()) {
      const s = await call(tenant, sealed, [...params]), c = await call(tenant, copy, [...params]);
      assert.deepEqual(c.value, s.value, `${tamper[0]} / ${label}: same refusal`);
      assert.match(String(c.value), /^ERROR 55000 /, `${tamper[0]} / ${label}: 55000`);
      assert(c.guards >= 1, `${tamper[0]} / ${label}: no cached answer`);
    }
  });
});

test('a recorded verdict is reused only while its basis holds: a basis row change in the transaction is a miss', async () => {
  await warm();
  await inTx(async () => {
    const before = await call(f.plainTenant, 'SELECT public.stock_verdict_require()::text v', []);
    assert.equal(before.guards, 0);
    for (const q of ['SET LOCAL session_replication_role=replica', 'UPDATE public.migrations SET name=name WHERE name=(SELECT max(name) FROM public.migrations)',
      'SET LOCAL session_replication_role=origin']) await A.query(q);
    const missed = await call(f.plainTenant, 'SELECT public.stock_verdict_require()::text v', []);
    assert.deepEqual([missed.value, missed.guards], ['', 1], 'a new row version in a basis table: one full guard');
  });
});

test('TS adapters call the copies when installed and the sealed functions otherwise', async () => {
  await warm();
  const c = await pool.connect(), returnOutcomes: string[] = [];
  try {
    for (const installed of [true, false]) {
      await c.query('BEGIN');
      try {
        await c.query("SET LOCAL track_functions='all'");
        if (!installed) await c.query('DROP FUNCTION public.stock_verdict_effect_prepare(uuid,uuid,jsonb),public.stock_verdict_return_prepare(uuid,uuid,jsonb)');
        // Deltas only: function counts not yet flushed after an earlier transaction stay in the xact view.
        const NAMES = ['stock_verdict_effect_prepare', 'catalog_stock_control_effect_prepare', 'stock_verdict_return_require', 'catalog_stock_return_require', 'catalog_stock_control_guards'];
        const counts = async () => Object.fromEntries((await c.query('SELECT n,coalesce((SELECT sum(calls) FROM pg_stat_xact_user_functions WHERE funcname=n),0)::int k FROM unnest($1::text[]) n', [NAMES])).rows.map((r) => [r.n, r.k]));
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.strictTenant]);
        beginCatalogStockControlTransaction(c);
        const c0 = await counts();
        const actor = { tenantId: f.strictTenant, userId: f.strictAdmin, source: 'manual' as const };
        const token = await prepareCatalogStockEffectInTx(c, actor, JSON.parse(src('dispatch', f.strictWarehouse, f.strictProduct)));
        assert(token && token.tenant_id === f.strictTenant, 'strict dispatch admission');
        // A closed RMA: null (historical) or 409 (a sealed admission with another body), the same either way.
        await c.query('SAVEPOINT r270');
        const outcome = await prepareCatalogStockReturnInTx(c, actor, { return_id: f.historicalReturn, protocol: 'rma', request: { version: 0, items: [] } })
          .then(async (v) => { await c.query('RELEASE SAVEPOINT r270'); return JSON.stringify(v); },
            async (e: any) => { await c.query('ROLLBACK TO SAVEPOINT r270'); return 'HTTP ' + e.status; });
        returnOutcomes.push(outcome);
        const c1 = await counts(), n = async (name: string) => c1[name] - c0[name];
        assert.deepEqual([await n('stock_verdict_effect_prepare'), await n('catalog_stock_control_effect_prepare')], installed ? [1, 0] : [0, 1], `installed=${installed}: effect prepare`);
        // A call that ends in an error is not counted itself; the require it completed first is.
        assert.deepEqual([await n('stock_verdict_return_require'), await n('catalog_stock_return_require')], installed ? [1, 0] : [0, 1], `installed=${installed}: return prepare`);
        if (installed) assert.equal(await n('catalog_stock_control_guards'), 0, 'installed: no full guard on the hit path');
      } finally { endCatalogStockControlTransaction(c); await c.query('ROLLBACK'); }
    }
    assert.equal(returnOutcomes[0], returnOutcomes[1], 'return prepare: the same outcome through the copy and the sealed function');
    assert.match(returnOutcomes[0], /^(?:null|HTTP 409)$/);
  } finally { c.release(); }
});
