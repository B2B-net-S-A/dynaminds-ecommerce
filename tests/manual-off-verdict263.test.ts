/** Migration 263_manual_off_verdict (prepared as 281, registered after 262; docs/parity/MANUAL-OFF-GEN281-20261030.md
 * "Integracja jako 263") on a real clone: a fresh PG04 dynaminds_m263_YYYYMMDD_NN of the restored template, the real migrate()
 * to HEAD (which applies 263), then the 182 generation cold-approved the way the release startup does (ordinary187_approve);
 * the file is applied by hand only to re-create the family after the TS test drops it. Every SQL call runs as the owner with the application pool's session settings, in transactions that
 * are rolled back; the TS part goes through the real routes (buildApp + inject) of an own disposable tenant.
 * The questions: is each copy exactly its sealed original apart from the guard calls; does it answer (value or error) as the
 * sealed function in every state, also one the full guard rejects; does it skip the full manual OFF guard only on a 248 hit;
 * and does TS call the copies when installed and the sealed functions otherwise. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { migrate, pool } from '../server/db';
import { buildApp } from '../server/app';
import { seed } from './fixtures';
import { adjustmentActor } from './stocktake-adjustments-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m263_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m263_YYYYMMDD_NN of the restored template required');

const SQL = readFileSync(new URL('../server/263_manual_off_verdict.sql', import.meta.url), 'utf8');
const options = '-c jit=off -c timezone=UTC -c statement_timeout=120000 -c lock_timeout=8000';
const A = new pg.Client({ connectionString: database.href, options });
const REQ = ['manual_inventory_off_require()', 'manual_off_verdict_require()'] as const, FRAME = ['manual_inventory_off_frame(', 'manual_off_verdict_frame('] as const;
/** copy, sealed original, the only substitutions in its body. */
const FAMILY: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
  ['manual_off_verdict_require()', 'manual_inventory_off_require()', [['manual_inventory_off_valid()', 'manual_off_verdict_valid()']]],
  ['manual_off_verdict_frame(uuid,uuid,boolean)', 'manual_inventory_off_frame(uuid,uuid,boolean)', [REQ]],
  ['manual_off_verdict_preview(uuid,uuid,jsonb)', 'manual_inventory_off_preview(uuid,uuid,jsonb)', [REQ, FRAME]],
  ['manual_off_verdict_preview_can_apply(uuid)', 'manual_inventory_off_preview_can_apply(uuid)', [FRAME]],
  ['manual_off_verdict_apply(uuid,uuid,uuid,jsonb)', 'manual_inventory_off_apply(uuid,uuid,uuid,jsonb)', [REQ, FRAME,
    ['catalog_stock_control_effect_prepare(', 'stock_verdict_effect_prepare('], ['catalog_stock_control_effect_finish(', 'stock_verdict_effect_finish(']]],
];
type Cell = { t: string; u: string; p: string; w: string; l: string };
let plain: Cell, strict: Cell;
const approve = () => A.query("SELECT public.ordinary187_approve(repeat('a',64),repeat('b',64),repeat('c',64))");
const installed = async () => (await A.query("SELECT to_regprocedure('public.manual_off_verdict_valid()') IS NOT NULL v")).rows[0].v === true;
const install = async () => { await A.query('BEGIN'); await A.query(SQL); await A.query('COMMIT'); await approve(); };
const cell = async (isStrict: boolean): Promise<Cell> => (await A.query(`SELECT s.tenant_id t,s.warehouse_id w,s.product_id p,s.location l,
    (SELECT m.user_id FROM memberships m WHERE m.tenant_id=s.tenant_id AND m.role='admin' ORDER BY m.user_id LIMIT 1) u
  FROM stock s JOIN products p ON (p.tenant_id,p.id)=(s.tenant_id,s.product_id)
  WHERE p.kind='simple' AND s.available>=2 AND NOT EXISTS(SELECT FROM wms_policies w WHERE w.tenant_id=s.tenant_id AND w.enabled)
   AND NOT EXISTS(SELECT FROM bundle_components b WHERE b.tenant_id=s.tenant_id AND b.bundle_id=p.id)
   AND EXISTS(SELECT FROM stock_locations l WHERE (l.tenant_id,l.warehouse_id,l.product_id,l.location)=(s.tenant_id,s.warehouse_id,s.product_id,s.location))
   AND EXISTS(SELECT FROM catalog_stock_control_policies h WHERE (h.tenant_id,h.catalog_id)=(p.tenant_id,p.catalog_id))=$1
   AND EXISTS(SELECT FROM memberships m WHERE m.tenant_id=s.tenant_id AND m.role='admin')
  ORDER BY s.tenant_id,s.product_id LIMIT 1`, [isStrict])).rows[0];

before(async () => {
  await migrate();
  await A.connect();
  assert.deepEqual((await A.query("SELECT name FROM migrations WHERE name LIKE '263%' OR name LIKE '281%' ORDER BY name")).rows.map((r) => r.name), ['263_manual_off_verdict'], 'the real migrate() recorded 263; no 281 row');
  assert(await installed(), 'the real migrate() applied 263');
  await approve();
  plain = await cell(false); strict = await cell(true);
  assert(plain?.u && strict?.u, 'template fixture: a non-strict and a strict manual OFF cell (simple product, default bin, no WMS) with an admin');
});
after(async () => { try { await A.end(); } finally { await pool.end(); } });

const calls = async (name: string) => +(await A.query('SELECT coalesce(sum(calls),0) n FROM pg_stat_xact_user_functions WHERE funcname=$1', [name])).rows[0].n;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
/** Fresh ids and clock times differ between two calls in the same state; every other field must be equal. */
function norm(v: unknown, keep: Set<string>): unknown {
  if (typeof v === 'string') return UUID.test(v) && !keep.has(v) ? '<new uuid>' : TS.test(v) ? '<time>' : v;
  if (Array.isArray(v)) return v.map((x) => norm(x, keep));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x, keep)]));
  return v;
}
/** One call at a savepoint inside the open transaction (rolled back): its value (or error code) and the full guards it ran. */
async function call(c: Cell, sql: string, params: unknown[]) {
  await A.query('SAVEPOINT c281');
  await A.query("SELECT set_config('app.tenant_id',$1,true)", [c.t]);
  const g0 = await calls('manual_inventory_off_valid'), k0 = await calls('catalog_stock_control_guards');
  let value: unknown;
  try { value = norm((await A.query(sql, params)).rows[0].v, new Set([c.t, c.u, c.p, c.w, ...params.filter((x): x is string => typeof x === 'string' && UUID.test(x))])); }
  catch (e: any) { value = 'ERROR ' + e.code + ' ' + e.message; }
  await A.query('ROLLBACK TO SAVEPOINT c281');
  return { value, guards: (await calls('manual_inventory_off_valid')) - g0, catalog: (await calls('catalog_stock_control_guards')) - k0 };
}
async function inTx<T>(work: () => Promise<T>, o: { begin?: string; commit?: boolean } = {}) {
  await A.query(o.begin ?? 'BEGIN');
  try { await A.query("SET LOCAL track_functions='all'"); const r = await work(); await A.query(o.commit ? 'COMMIT' : 'ROLLBACK'); return r; }
  catch (e) { await A.query('ROLLBACK'); throw e; }
}
/** A committed RC call records the verdict, as the application's first write does. */
const warm = () => inTx(async () => { assert.equal((await A.query("SELECT public.guard_verdict('catalog_stock_control_guards') v")).rows[0].v, true); }, { commit: true });
const frameOf = async (c: Cell) => { await A.query("SELECT set_config('app.tenant_id',$1,true)", [c.t]); return (await A.query('SELECT public.manual_inventory_off_frame($1,$2,false) f', [c.p, c.w])).rows[0].f; };
/** Committed state for the pairs (inside the test transaction, before the savepoints): one preview per cell, one applied receipt. */
async function committed(c: Cell) {
  const cellBody = async (delta: number) => ({ client_key: randomUUID(), revision: (await frameOf(c)).source.revision, product_id: c.p, warehouse_id: c.w, location: c.l, delta, note: 'Own p281 pair' });
  const done = await cellBody(1);
  const dpv = (await A.query('SELECT public.manual_inventory_off_preview($1,NULL,$2::jsonb) v', [c.u, JSON.stringify(done)])).rows[0].v.preview;
  const dconsent = { client_key: randomUUID(), scope_hash: dpv.scope_hash, confirmed: true };
  await A.query('SELECT public.manual_inventory_off_apply($1,NULL,$2,$3::jsonb)', [c.u, dpv.id, JSON.stringify(dconsent)]);
  // The open preview is taken after the applied one, so its frame is the current one.
  const body = await cellBody(-1);
  const pv = (await A.query('SELECT public.manual_inventory_off_preview($1,NULL,$2::jsonb) v', [c.u, JSON.stringify(body)])).rows[0].v.preview;
  return { body, pv, consent: { client_key: randomUUID(), scope_hash: pv.scope_hash, confirmed: true }, dpv, dconsent };
}
type Pair = readonly [string, Cell, string, string, unknown[]];
const sealedAndCopy = (fn: string, args: string): [string, string] => [`SELECT public.manual_inventory_off_${fn}(${args}) v`, `SELECT public.manual_off_verdict_${fn}(${args}) v`];
async function pairs(): Promise<Pair[]> {
  const out: Pair[] = [];
  for (const [label, c] of [['plain', plain], ['strict', strict]] as const) {
    const k = await committed(c), fresh = { ...k.body, client_key: randomUUID() };
    out.push(
      [`${label} require`, c, 'SELECT public.manual_inventory_off_require()::text v', 'SELECT public.manual_off_verdict_require()::text v', []],
      [`${label} frame read`, c, ...sealedAndCopy('frame', '$1,$2,false'), [c.p, c.w]],
      [`${label} frame locking`, c, ...sealedAndCopy('frame', '$1,$2,true'), [c.p, c.w]],
      [`${label} frame, foreign product (P0002)`, c, ...sealedAndCopy('frame', '$1,$2,false'), [randomUUID(), c.w]],
      [`${label} preview, fresh`, c, ...sealedAndCopy('preview', '$1,NULL,$2::jsonb'), [c.u, JSON.stringify(fresh)]],
      [`${label} preview, replay`, c, ...sealedAndCopy('preview', '$1,NULL,$2::jsonb'), [c.u, JSON.stringify(k.body)]],
      [`${label} preview, key conflict (23514)`, c, ...sealedAndCopy('preview', '$1,NULL,$2::jsonb'), [c.u, JSON.stringify({ ...k.body, note: 'Other p281 note' })]],
      [`${label} preview, stale revision (40001)`, c, ...sealedAndCopy('preview', '$1,NULL,$2::jsonb'), [c.u, JSON.stringify({ ...fresh, revision: '0'.repeat(64) })]],
      [`${label} can apply, open preview`, c, ...sealedAndCopy('preview_can_apply', '$1'), [k.pv.id]],
      [`${label} can apply, applied preview`, c, ...sealedAndCopy('preview_can_apply', '$1'), [k.dpv.id]],
      [`${label} apply`, c, ...sealedAndCopy('apply', '$1,NULL,$2,$3::jsonb'), [c.u, k.pv.id, JSON.stringify(k.consent)]],
      [`${label} apply, replay`, c, ...sealedAndCopy('apply', '$1,NULL,$2,$3::jsonb'), [c.u, k.dpv.id, JSON.stringify(k.dconsent)]],
      [`${label} apply, the preview's own key (23514)`, c, ...sealedAndCopy('apply', '$1,NULL,$2,$3::jsonb'), [c.u, k.pv.id, JSON.stringify({ ...k.consent, client_key: k.body.client_key })]],
      [`${label} apply, implicit consent (23514)`, c, ...sealedAndCopy('apply', '$1,NULL,$2,$3::jsonb'), [c.u, k.pv.id, JSON.stringify({ ...k.consent, extra: true })]],
      [`${label} apply, foreign preview (P0002)`, c, ...sealedAndCopy('apply', '$1,NULL,$2,$3::jsonb'), [c.u, randomUUID(), JSON.stringify(k.consent)]],
      [`${label} apply, foreign operator (23514)`, c, ...sealedAndCopy('apply', '$1,NULL,$2,$3::jsonb'), [randomUUID(), k.pv.id, JSON.stringify(k.consent)]],
    );
  }
  return out;
}

test('263 is installed: exactly the six owner-only manual_off_verdict_ functions, nothing granted', async () => {
  const rows = (await A.query(`SELECT p.oid::regprocedure::text sig,p.proowner::regrole::text owner,p.proacl::text acl,p.prosecdef secdef,
    has_function_privilege('dyna_app',p.oid,'EXECUTE') app,has_function_privilege('public',p.oid,'EXECUTE') pub
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'manual_off_verdict_') ORDER BY 1`)).rows;
  assert.deepEqual(rows.map((r) => r.sig), ['manual_off_verdict_valid()', ...FAMILY.map(([c]) => c)].sort());
  for (const r of rows) assert.deepEqual([r.owner, r.acl, r.secdef, r.app, r.pub], ['postgres', '{postgres=X/postgres}', true, false, false], r.sig);
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
  // The pinned catalog guard: its last statement is the full manual OFF guard and every other exit is false.
  const g = (await A.query("SELECT prosrc,encode(sha256(convert_to(prosrc,'UTF8')),'hex') h FROM pg_proc WHERE oid='public.catalog_stock_control_guards()'::regprocedure")).rows[0];
  assert.equal(g.h, 'ef9c31fbabca36776256efe76dcd16265c9f742ce4a64cbd7cc000c056baf225');
  assert.deepEqual([...g.prosrc.matchAll(/RETURN ([^;]+);/g)].map((m: RegExpMatchArray) => m[1].trim()), ['false', 'false', 'false', 'public.manual_inventory_off_valid()']);
  assert.match(g.prosrc, /RETURN public\.manual_inventory_off_valid\(\);END $/);
});

test('the guards stay true with the family installed', async () => {
  await inTx(async () => {
    for (const g of ['manual_inventory_off_valid', 'manual_off_verdict_valid', 'catalog_stock_control_guards', 'financial_return_guards', 'stocktake_adjustment_guards'])
      assert.equal((await A.query(`SELECT public.${g}() v`)).rows[0].v, true, g);
  }, { begin: 'BEGIN READ ONLY' });
});

test('manual_off_verdict_valid: READ COMMITTED answers from the recorded verdict; REPEATABLE READ and a dirty generation run the full guard', async () => {
  await warm();
  const v = () => call(plain, 'SELECT public.manual_off_verdict_valid() v', []);
  assert.deepEqual(await inTx(v), { value: true, guards: 0, catalog: 0 }, 'RC hit');
  assert.deepEqual(await inTx(v, { begin: 'BEGIN READ ONLY' }), { value: true, guards: 0, catalog: 0 }, 'RC READ ONLY hit');
  assert.deepEqual(await inTx(v, { begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' }), { value: true, guards: 1, catalog: 0 }, 'RR: the full manual OFF guard only');
  await inTx(async () => {
    await A.query('CREATE FUNCTION public.zz_probe281() RETURNS int LANGUAGE sql AS $$SELECT 1$$');
    assert.equal((await A.query('SELECT dirty FROM ordinary182_runtime_generation')).rows[0].dirty, true, 'owner DDL dirties the generation');
    const r = await v();
    assert.equal(r.value, true);
    assert(r.guards >= 1 && r.catalog >= 1, 'dirty generation: the 248 verdict runs the full catalog guard (with manual_inventory_off_valid in it)');
  });
});

test('a state the full guard rejects: the guard and every copy refuse as the sealed functions, never true from memory', async () => {
  await warm();
  const ps = await inTx(async () => (await pairs()).filter(([l]) => / require$| frame read$| preview, fresh$| can apply, open preview$| apply$/.test(l)));
  for (const tamper of [
    // replica mode: no event trigger, no generation change; the certificate row is part of the 248 basis
    ['SET LOCAL session_replication_role=replica', "UPDATE public.manual_inventory_off_certificate SET payload=jsonb_set(payload,'{own_fingerprint}',to_jsonb(text 'p281-tampered'))", 'SET LOCAL session_replication_role=origin'],
    // owner DDL on a manual OFF table: the generation is dirty and manual_inventory_off_valid() is false
    ['ALTER TABLE public.manual_inventory_off_receipts ADD COLUMN zz_probe281 int'],
  ]) await inTx(async () => {
    const k = await inTxState();
    for (const q of tamper) await A.query(q);
    assert.equal((await A.query('SELECT public.manual_inventory_off_valid() v')).rows[0].v, false, tamper[0] + ': the full manual OFF guard rejects');
    const g = await call(plain, 'SELECT public.manual_off_verdict_valid() v', []);
    assert.equal(g.value, false, tamper[0] + ': the guard copy is false');
    assert(g.guards >= 1, tamper[0] + ': the full guard answered');
    for (const [label, c, sealed, copy] of ps) {
      const params = await k(label, c);
      const s = await call(c, sealed, params), cp = await call(c, copy, params);
      assert.deepEqual(cp.value, s.value, `${tamper[0]} / ${label}: same refusal`);
      assert.match(String(cp.value), /^ERROR 55000 Incomplete manual OFF family$|^false$/, `${tamper[0]} / ${label}: 55000 (can apply: false)`);
      assert(cp.guards >= 1, `${tamper[0]} / ${label}: no cached answer`);
    }
  });
});
/** Parameters of the refusal pairs, built in the open transaction before the tamper (previews need an intact module). */
async function inTxState() {
  const k = { plain: await committed(plain), strict: await committed(strict) };
  return async (label: string, c: Cell): Promise<unknown[]> => {
    const s = c === plain ? k.plain : k.strict;
    if (/ require$/.test(label)) return [];
    if (/ frame read$/.test(label)) return [c.p, c.w];
    if (/ preview, fresh$/.test(label)) return [c.u, JSON.stringify({ ...s.body, client_key: randomUUID() })];
    if (/ can apply, open preview$/.test(label)) return [s.pv.id];
    return [c.u, s.pv.id, JSON.stringify(s.consent)];
  };
}

test('the catalog guard pin: a catalog_stock_control_guards() replaced by RETURN true does not let a broken manual OFF module through', async () => {
  await warm();
  await inTx(async () => {
    await A.query("CREATE OR REPLACE FUNCTION public.catalog_stock_control_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN RETURN true;END$$");
    for (const q of ['SET LOCAL session_replication_role=replica', "UPDATE public.manual_inventory_off_certificate SET payload=jsonb_set(payload,'{own_fingerprint}',to_jsonb(text 'p281-tampered'))", 'SET LOCAL session_replication_role=origin'])
      await A.query(q);
    assert.equal((await A.query("SELECT public.guard_verdict('catalog_stock_control_guards') v")).rows[0].v, true, 'the replaced catalog guard says true');
    assert.equal((await A.query('SELECT public.manual_inventory_off_valid() v')).rows[0].v, false, 'the module is broken');
    assert.deepEqual(await call(plain, 'SELECT public.manual_off_verdict_valid() v', []), { value: false, guards: 1, catalog: 0 }, 'pin mismatch: the full manual OFF guard answers');
    assert.match(String((await call(plain, 'SELECT public.manual_off_verdict_require()::text v', [])).value), /^ERROR 55000 /);
  });
});

test('approved generation, READ COMMITTED write transaction: every copy answers as its sealed original without a full guard', async () => {
  await warm();
  const out = await inTx(async () => {
    const r: Record<string, unknown> = {};
    for (const [label, c, sealed, copy, params] of await pairs()) {
      const s = await call(c, sealed, params), cp = await call(c, copy, params);
      assert.deepEqual(cp.value, s.value, label + ': same value or error');
      // can_apply of an applied preview answers false before its frame (no guard in either); every other sealed call guards.
      if (/can apply, applied preview$/.test(label)) assert.equal(s.guards, 0, label);
      else assert(s.guards >= 1, label + ': the sealed function runs the full manual OFF guard');
      assert.deepEqual([cp.guards, cp.catalog], [0, 0], label + ': the copy answers from the recorded verdict');
      r[label] = [String(typeof s.value === 'string' ? s.value : JSON.stringify(s.value)).slice(0, 50), s.guards, s.catalog, cp.guards];
    }
    return r;
  });
  console.log(JSON.stringify(out));
  assert.match(String((out as any)['strict apply'][0]), /"reused":false/, 'the strict apply succeeds (stock_verdict_effect_prepare/_finish in the copy)');
  assert.match(String((out as any)['plain apply'][0]), /"reused":false/);
});

test('REPEATABLE READ: the read copies run the same full guard as the sealed ones', async () => {
  await warm();
  await inTx(async () => {
    for (const [label, c, sealed, copy, params] of [['frame read', plain, ...sealedAndCopy('frame', '$1,$2,false'), [plain.p, plain.w]]] as const) {
      const s = await call(c, sealed, [...params]), cp = await call(c, copy, [...params]);
      assert.deepEqual(cp.value, s.value, label);
      assert.deepEqual([cp.guards, cp.catalog], [s.guards, s.catalog], label + ': the same full guard runs');
    }
  }, { begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' });
});

test('a recorded verdict is reused only while its basis holds: a basis row change in the transaction is a miss', async () => {
  await warm();
  await inTx(async () => {
    assert.deepEqual(await call(plain, 'SELECT public.manual_off_verdict_require()::text v', []), { value: '', guards: 0, catalog: 0 });
    for (const q of ['SET LOCAL session_replication_role=replica', 'UPDATE public.manual_inventory_off_certificate SET payload=payload', 'SET LOCAL session_replication_role=origin']) await A.query(q);
    assert.deepEqual(await call(plain, 'SELECT public.manual_off_verdict_require()::text v', []), { value: '', guards: 1, catalog: 1 }, 'a new certificate row version: one full catalog guard');
  });
});

test('TS: the manual OFF routes call the copies when installed and the sealed functions otherwise, with the same answers', async () => {
  await seed();
  const app = await buildApp({ integrationTransport: async () => { throw new Error('no transport'); } });
  const sent: string[] = [];
  const orig = (pg.Client.prototype as any).query;
  (pg.Client.prototype as any).query = function (this: any, q: any, ...rest: any[]) { sent.push(String(typeof q === 'string' ? q : q?.text)); return orig.call(this, q, ...rest); };
  try {
    const tenant = randomUUID();
    await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own p281 manual OFF','enterprise')", [tenant]);
    const f = await adjustmentActor(app, tenant);
    const wh = await f.ok('/warehouses', 'POST', { name: 'P281 WH', code: 'P281-' + randomUUID().slice(0, 8) });
    const product = await f.ok('/products', 'POST', { name: 'P281 product', sku: 'P281-' + randomUUID(), price: 1000, vat: 23, warehouse_id: wh.id, quantity: 10, location: 'A-01' }, 201);
    const flow = async (delta: number) => {
      sent.length = 0;
      const src = (await f.ok(`/inventory/manual-corrections/source?product_id=${product.id}&warehouse_id=${wh.id}`)).source;
      const pv = (await f.ok('/inventory/manual-corrections/previews', 'POST', { client_key: randomUUID(), revision: src.revision, product_id: product.id, warehouse_id: wh.id,
        location: src.stock.default_location, delta, note: 'Korekta p281' }, 201)).preview;
      const detail = await f.ok('/inventory/manual-corrections/previews/' + pv.id);
      const r = await f.ok(`/inventory/manual-corrections/previews/${pv.id}/apply`, 'POST', { client_key: randomUUID(), scope_hash: pv.scope_hash, confirmed: true }, 201);
      const receipt = await f.ok('/inventory/manual-corrections/receipts/' + r.receipt.id);
      const text = sent.join('\n');
      return { r, detail, receipt, copies: (text.match(/SELECT manual_off_verdict_(?:valid|frame|preview|preview_can_apply|apply)\(/g) ?? []).length, sealed: (text.match(/SELECT manual_inventory_off_(?:valid|frame|preview|preview_can_apply|apply)\(/g) ?? []).length };
    };
    const a = await flow(-1);
    assert.equal(a.r.reused, false);
    assert.equal(a.detail.can_apply, true);
    assert.equal(a.receipt.receipt.document.kind, 'RW');
    assert(a.copies >= 12 && a.sealed === 0, `installed: copies ${a.copies}, sealed ${a.sealed}`);
    await A.query('DROP FUNCTION public.manual_off_verdict_apply(uuid,uuid,uuid,jsonb),public.manual_off_verdict_preview_can_apply(uuid),public.manual_off_verdict_preview(uuid,uuid,jsonb),public.manual_off_verdict_frame(uuid,uuid,boolean),public.manual_off_verdict_require(),public.manual_off_verdict_valid()');
    await approve();
    const b = await flow(1);
    assert.equal(b.r.reused, false);
    assert.equal(b.receipt.receipt.document.kind, 'PW');
    assert(b.copies === 0 && b.sealed >= 12, `dropped: copies ${b.copies}, sealed ${b.sealed}`);
    assert.equal((await pool.query('SELECT on_hand FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [tenant, wh.id, product.id])).rows[0].on_hand, 10);
  } finally {
    (pg.Client.prototype as any).query = orig;
    await app.close();
    if (!await installed()) await install();
  }
});
