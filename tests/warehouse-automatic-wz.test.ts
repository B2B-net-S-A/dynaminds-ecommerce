import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { pool, tenantTx } from '../server/db';
import { shipDemo } from '../server/domain';
import { dispatchShipping, processShipping } from '../server/shipping';
import { seed } from './fixtures';
import { stocktakeAdjustmentFixture, adjustmentActor } from './stocktake-adjustments-fixture';
import { productCatalogFacts } from './product-catalogs-fixture';
import * as S from '../server/warehouse-automatic-wz';
import * as V from '../server/warehouse-automatic-wz-schema';

// Authored source only. Root executes in its isolated, numeric PostgreSQL DB.
// These first cases prove the physical collector foundation, NOT an emitted WZ.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
type Facts = Record<string, { row: Row }[]>;
type Physical = {
  stock_movements: { id: string; product_id: string; warehouse_id: string; quantity: number }[];
  location_movements: { id: string; product_id: string; warehouse_id: string; location: string; quantity: number }[];
  wms: null | { operation_id: string; fragment_ids: string[]; layer_movement_ids: string[] }[];
};
type Collected = { source: { kind: 'shipping_plan' | 'demo'; order_id: string; shipment_id: string; plan_id?: string }; physical: Physical };
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
const prefix = '/warehouse-automatic-wz';
const family = ['previews','operations','revisions','configurations','admissions','manifest'].map(n => 'warehouse_automatic_wz_' + n);
let migrationBefore: Awaited<ReturnType<typeof captureMigration>>, migrationAfter: Awaited<ReturnType<typeof captureMigration>>;
before(async () => {
  // Construct genuine149 even after the central registry eventually includes
  //150. Never hide/remove150 from an existing DB or rely on migrate stopping149.
  assert.equal((await pool.query("SELECT to_regclass('public.migrations') ledger")).rows[0].ledger, null);
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
  const central = await readFile(new URL('../server/db.ts', import.meta.url), 'utf8');
  const section = central.slice(central.indexOf('for (const [name, file] of ['));
  assert(section.startsWith('for (const [name, file] of ['));
  const manifest = [...section.matchAll(/\[\s*'(\d{3}_[a-z0-9_]+)'\s*,\s*'\.\/([a-z0-9_-]+\.sql)'\s*,?\s*\]/g)]
    .map(m => ({ name:m[1],file:m[2] })).filter(m => Number(m.name.slice(0,3))<=149);
  assert.equal(manifest.length,149); assert.equal(manifest[0].name,'001_foundation'); assert.equal(manifest.at(-1)?.name,'149_stocktake_adjustments');
  assert.deepEqual(manifest.map(m=>Number(m.name.slice(0,3))),Array.from({length:149},(_,i)=>i+1));
  const historical = await pool.connect();
  try {
    for(const migration of manifest) {
      await historical.query('BEGIN');
      try {
        await historical.query(await readFile(new URL('../server/'+migration.file,import.meta.url),'utf8'));
        if(migration.name==='092_wms_stocktakes') await historical.query(await readFile(new URL('../server/wms-stocktake-invariants.sql',import.meta.url),'utf8'));
        if(migration.name==='108_b2b_dropshipping') await historical.query(await readFile(new URL('../server/108_b2b_dropship_dispatch.sql',import.meta.url),'utf8'));
        await historical.query('INSERT INTO migrations(name) VALUES($1)',[migration.name]); await historical.query('COMMIT');
      } catch(e) {await historical.query('ROLLBACK');throw e;}
    }
  } finally {historical.release();}
  assert.equal((await pool.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,'149_stocktake_adjustments');
  await seed();
  assert.equal((await pool.query("SELECT to_regprocedure('public.warehouse_automatic_wz_installed()') marker")).rows[0].marker, null,
    'Foundation150 is applied explicitly here, never removed from a shared/current schema');
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw Error('Only local shipping simulation is allowed'); } });
  await stocktakeAdjustmentFixture(app, true); // Genuine nonempty bins, layers and ordinary API history before150.
  await app.close();
  migrationBefore = await captureMigration();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(await readFile(new URL('../server/150_warehouse_automatic_wz.sql', import.meta.url), 'utf8'));
    await c.query("INSERT INTO migrations(name) VALUES('150_warehouse_automatic_wz')");
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  migrationAfter = await captureMigration();
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw Error('Only local shipping simulation is allowed'); } });
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });
const raw = (f: Facts, name: string): Row[] => { assert(f[name]); return f[name].map(x => x.row); };
const sorted = <T>(xs: T[]) => [...xs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const one = (xs: Row[]) => { assert.equal(xs.length, 1); return xs[0]; };
const added = (a: Facts, b: Facts, name: string) => {
  const old = raw(a, name), now = raw(b, name);
  for (const x of old) assert.deepEqual(now.filter(y => y.id === x.id), [x], 'Historical journal remains exact: ' + name);
  return now.filter(x => !old.some(y => y.id === x.id));
};
async function captureMigration() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    const rows: Facts = {};
    for (const { tablename } of (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows) {
      assert.match(tablename, /^[a-z][a-z0-9_]*$/);
      rows[tablename] = (await c.query(`SELECT to_jsonb(r) row FROM public."${tablename}" r ORDER BY 1`)).rows;
    }
    const functions = (await c.query("SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p) meta,pg_get_functiondef(p.oid) definition FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN('f','p') ORDER BY p.oid")).rows;
    const triggers = (await c.query("SELECT t.oid,c.relname,to_jsonb(t) meta,pg_get_triggerdef(t.oid,false) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid")).rows;
    const tables = (await c.query(`SELECT c.oid,c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,
      (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.attnum),'[]') FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0) columns,
      (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.oid),'[]') FROM pg_policy p WHERE p.polrelid=c.oid) policies,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(x),'definition',pg_get_constraintdef(x.oid,false)) ORDER BY x.oid),'[]') FROM pg_constraint x WHERE x.conrelid=c.oid) constraints,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(i),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid),'[]') FROM pg_index i WHERE i.indrelid=c.oid) indexes
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.oid`)).rows;
    await c.query('COMMIT'); return { rows, functions, triggers, tables };
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}

async function packed(on: boolean) {
  const f = await stocktakeAdjustmentFixture(app, on);
  // Three genuine physical products, six bins and ON six original layers:
  // known0/known1000/NULL. No direct stock, hold, layer or shipped-row injection.
  const born = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie: f.cookie, 'Idempotency-Key': randomUUID() },
    payload: { source: 'manual', customer_name: 'Own collector buyer167', email: 'collector167@example.test',
      address: { street: 'Testowa 167', city: 'Warszawa', postal_code: '00-167', country: 'PL', phone: '500000167' },
      warehouse_id: f.warehouse.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
      items: f.products.map(p => ({ product_id: p.id, quantity: 3 })) } });
  assert.equal(born.statusCode, 201); const order = born.json();
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version), kind: 'receipt',
    amount: order.total, currency: 'PLN', method: 'other', reference: 'Synthetic local payment declaration167', confirmed: true });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'picking' });
  if (on) {
    const allocations = await f.ok('/wms-lots/orders/' + order.id + '/allocations');
    assert.equal(allocations.meta.cursor, null); assert.equal(allocations.data.length, 6);
    for (const r of allocations.data) { const p = f.products.find(p => p.id === r.product_id); assert(p);
      for (let i = 0; i < r.quantity; i++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
        client_key: randomUUID(), code: p.sku, location: r.location, layer_id: r.layer_id }); }
  } else {
    const holds = (await pool.query('SELECT * FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id,location', [f.tenant, order.id])).rows;
    assert.equal(holds.length, 6);
    for (const r of holds) { const p = f.products.find(p => p.id === r.product_id); assert(p);
      for (let i = 0; i < r.quantity; i++) await f.ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: p.sku, location: r.location }); }
  }
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
  assert.equal((await f.ok('/orders/' + order.id)).status, 'packed');
  return { ...f, order };
}
type Packed = Awaited<ReturnType<typeof packed>>;
async function claimOwnSimulation(f: Packed, id: string) {
  const job = await tenantTx(f.tenant, async c => (await c.query(`UPDATE jobs SET state='running',lease_token=$3,attempts=attempts+1,locked_at=now()
    WHERE tenant_id=$1 AND id=$2 AND state='pending' AND kind='shipping' RETURNING *`, [f.tenant, id, randomUUID()])).rows[0]);
  assert(job); assert.equal(job.payload.actor_id, f.user);
  await processShipping(job, { transport: async () => { providerCalls++; throw Error('Simulation must not request a carrier'); } });
}
async function readyShipping(f: Packed) {
  const channel = await f.ok('/shipping/example', 'POST', {});
  const preview = await f.ok('/orders/' + f.order.id + '/shipping/preview', 'POST', { channel_id: channel.id,
    service: 'inpost_locker_standard', receiver: { first_name: 'Own', last_name: 'Collector', email: 'collector167@example.test', phone: '500000167' },
    target_point: 'WAW01M', template: 'small', weight: 1, cod: 0, insurance: 0 });
  const queued = await f.ok('/shipping-plans/' + preview.id + '/queue', 'POST', {}); await claimOwnSimulation(f, queued.job_id);
  const quoted = one((await pool.query('SELECT * FROM shipping_plans WHERE tenant_id=$1 AND id=$2', [f.tenant, preview.id])).rows);
  assert.equal(quoted.state, 'quoted'); assert.equal(quoted.offers.length, 1);
  const bought = await f.ok('/shipping-plans/' + preview.id + '/buy', 'POST', { offer_id: quoted.offers[0].id, confirm_cost: true });
  await claimOwnSimulation(f, bought.job_id);
  const ready = one((await pool.query('SELECT * FROM shipping_plans WHERE tenant_id=$1 AND id=$2', [f.tenant, preview.id])).rows);
  assert.equal(ready.state, 'ready'); assert(ready.shipment_id);
  assert.equal(one((await pool.query('SELECT * FROM shipments WHERE tenant_id=$1 AND id=$2', [f.tenant, ready.shipment_id])).rows).dispatched_at, null);
  return ready;
}
async function execute(f: Packed, kind: 'demo' | 'shipping_plan', plan: Row | null, callback: (r: Collected) => Promise<void>) {
  return tenantTx(f.tenant, (c: PoolClient) => kind === 'demo'
    ? shipDemo(c, f.actor, f.order.id, callback)
    : dispatchShipping(c, f.actor, plan!.id, callback));
}

function physicalProof(f: Packed, before: Facts, after: Facts, got: Collected, kind: 'demo' | 'shipping_plan', plan: Row | null) {
  assert.equal(got.source.kind, kind); assert.equal(got.source.order_id, f.order.id);
  if (kind === 'shipping_plan') { assert.equal(got.source.plan_id, plan!.id); assert.equal(got.source.shipment_id, plan!.shipment_id); }
  const shipment = one(raw(after, 'shipments').filter(s => s.id === got.source.shipment_id));
  assert.equal(shipment.order_id, f.order.id); assert(shipment.dispatched_at);
  assert.equal(one(raw(after, 'orders').filter(o => o.id === f.order.id)).status, 'shipped');
  const holds = raw(before, 'reservations').filter(r => r.order_id === f.order.id);
  const bins = raw(before, 'reservation_locations').filter(r => r.order_id === f.order.id);
  assert.equal(holds.length, 3); assert.equal(bins.length, 6);
  const sm = added(before, after, 'stock_movements'), lm = added(before, after, 'stock_location_movements');
  assert.equal(sm.length, 3, 'The collector must not add a second aggregate physical writer');
  assert.equal(lm.length, 6, 'The collector must not add a second bin physical writer');
  assert.deepEqual(sorted(got.physical.stock_movements), sorted(sm.map(m => ({ id: m.id, product_id: m.product_id, warehouse_id: m.warehouse_id, quantity: -m.delta }))));
  assert.deepEqual(sorted(got.physical.location_movements), sorted(lm.map(m => ({ id: m.id, product_id: m.product_id, warehouse_id: m.warehouse_id, location: m.location, quantity: -m.delta }))));
  assert.deepEqual(sorted(sm.map(m => [m.product_id, m.warehouse_id, -m.delta])), sorted(holds.map(r => [r.product_id, r.warehouse_id, r.quantity])));
  assert.deepEqual(sorted(lm.map(m => [m.product_id, m.warehouse_id, m.location, -m.delta])), sorted(bins.map(r => [r.product_id, r.warehouse_id, r.location, r.quantity])));
  for (const m of [...sm, ...lm]) { assert.equal(m.kind, 'shipment'); assert.equal(m.order_id, f.order.id); assert.equal(m.tenant_id, f.tenant); assert(m.delta < 0); assert.equal(m.warehouse_document_id ?? null, null); }
  for (const r of holds) {
    const old = one(raw(before, 'stock').filter(s => s.product_id === r.product_id && s.warehouse_id === r.warehouse_id));
    const now = one(raw(after, 'stock').filter(s => s.product_id === r.product_id && s.warehouse_id === r.warehouse_id));
    assert.equal(now.on_hand, old.on_hand - r.quantity); assert.equal(now.reserved, old.reserved - r.quantity);
    assert.equal(now.available, old.available); assert.equal(BigInt(now.version), BigInt(old.version) + 1n);
    const consumed = one(raw(after, 'reservations').filter(x => x.order_id === f.order.id && x.product_id === r.product_id));
    assert.equal(consumed.state, 'consumed'); assert.equal(consumed.quantity, r.quantity);
  }
  for (const r of bins) {
    const select = (x: Row) => x.product_id === r.product_id && x.warehouse_id === r.warehouse_id && x.location === r.location;
    assert.equal(one(raw(after, 'stock_locations').filter(select)).quantity, one(raw(before, 'stock_locations').filter(select)).quantity - r.quantity);
  }
  // Current foundation intentionally emits no WZ or second document workflow.
  for (const n of ['warehouse_documents', 'warehouse_document_lines', 'stocktake_adjustment_documents', 'stocktake_adjustment_counters']) assert.deepEqual(after[n], before[n]);
  assert.deepEqual(after.wms_cost_layers, before.wms_cost_layers, 'Issuing freezes original costs; no cost-layer rewrite');
  const ops = added(before, after, 'wms_operations'), fragments = added(before, after, 'wms_issue_fragments'), journal = added(before, after, 'wms_layer_movements');
  if (!f.on) { assert.equal(got.physical.wms, null); assert.deepEqual(ops, []); assert.deepEqual(fragments, []); assert.deepEqual(journal, []); return; }
  assert(got.physical.wms); assert.equal(ops.length, 3); assert.equal(fragments.length, 6); assert.equal(journal.length, 6);
  assert.equal(new Set(got.physical.wms.map(x => x.operation_id)).size, 3);
  assert.deepEqual(got.physical.wms.map(x => x.operation_id).sort(), ops.map(x => x.id).sort());
  const layerHolds = raw(before, 'wms_reservation_layers').filter(x => x.order_id === f.order.id);
  assert.deepEqual(sorted(fragments.map(x => [x.product_id, x.warehouse_id, x.layer_id, x.location, x.quantity])), sorted(layerHolds.map(x => [x.product_id, x.warehouse_id, x.layer_id, x.location, x.quantity])));
  for (const op of ops) {
    assert.equal(op.kind, 'dispatch'); assert.equal(op.order_id, f.order.id); assert.equal(op.warehouse_document_id, null);
    const proof = one(got.physical.wms.filter(x => x.operation_id === op.id));
    assert.deepEqual(proof.fragment_ids.slice().sort(), fragments.filter(x => x.operation_id === op.id).map(x => x.id).sort());
    assert.deepEqual(proof.layer_movement_ids.slice().sort(), journal.filter(x => x.operation_id === op.id).map(x => x.id).sort());
  }
  for (const fr of fragments) {
    const layer = one(raw(before, 'wms_cost_layers').filter(x => x.id === fr.layer_id));
    assert.equal(fr.unit_cost_minor, layer.unit_cost_minor); assert.equal(fr.currency, layer.currency); assert.equal(fr.order_id, f.order.id); assert.equal(fr.warehouse_document_id, null);
    assert.equal(fr.value_minor === null ? null : BigInt(fr.value_minor), layer.unit_cost_minor === null ? null : BigInt(fr.quantity) * BigInt(layer.unit_cost_minor));
    const j = one(journal.filter(x => x.operation_id === fr.operation_id && x.product_id === fr.product_id && x.layer_id === fr.layer_id && x.location === fr.location));
    // The actual layer journal stores value_delta, not unit_cost_minor or a
    // warehouse-document pointer. Frozen unit cost belongs to the issue/layer.
    assert.equal(j.delta, -fr.quantity); assert.equal(j.kind, 'dispatch');
    assert.equal(j.value_delta === null ? null : BigInt(j.value_delta), fr.value_minor === null ? null : -BigInt(fr.value_minor));
    const pos = (x: Row) => x.product_id === fr.product_id && x.warehouse_id === fr.warehouse_id && x.layer_id === fr.layer_id && x.location === fr.location;
    const old = one(raw(before, 'wms_layer_positions').filter(pos)), now = one(raw(after, 'wms_layer_positions').filter(pos));
    assert.equal(now.quantity, old.quantity - fr.quantity); assert.equal(now.reserved, old.reserved - fr.quantity);
  }
  assert.deepEqual([...new Set(fragments.map(x => x.unit_cost_minor === null ? null : String(x.unit_cost_minor)))].sort((a, b) => String(a).localeCompare(String(b))), ['0', '1000', null].sort((a, b) => String(a).localeCompare(String(b))));
}

for (const on of [false, true]) for (const kind of ['demo', 'shipping_plan'] as const) {
  test(`${on ? 'ON' : 'OFF'} ${kind} genuine packed dispatch returns exact existing aggregate/bin/layer IDs with one physical writer`, async () => {
    const f = await packed(on), plan = kind === 'shipping_plan' ? await readyShipping(f) : null;
    const before = await productCatalogFacts(f.tenant); let collected: Collected | undefined, calls = 0;
    const result = await execute(f, kind, plan, async r => { calls++; collected = structuredClone(r); });
    assert.equal(calls, 1); assert(collected); assert.equal(result.status, 'shipped');
    const after = await productCatalogFacts(f.tenant); physicalProof(f, before, after, collected, kind, plan);
    if (kind === 'shipping_plan') {
      const replay = await execute(f, kind, plan, async () => { assert.fail('Committed state replay must not execute physical collector callback'); });
      assert.equal(replay.status, 'shipped'); assert.deepEqual(await productCatalogFacts(f.tenant), after);
    } else { assert.equal((await f.request('/orders/' + f.order.id + '/ship-demo', 'POST', {})).statusCode, 409); assert.deepEqual(await productCatalogFacts(f.tenant), after); }
  });
  test(`${on ? 'ON' : 'OFF'} ${kind} trusted document callback failure rolls back actual physical issue and shipment/status in the same TX`, async () => {
    const f = await packed(on), plan = kind === 'shipping_plan' ? await readyShipping(f) : null;
    const before = await productCatalogFacts(f.tenant), failure = new Error('Deliberate trusted document finish failure167'); let calls = 0;
    await assert.rejects(execute(f, kind, plan, async r => { calls++; assert.equal(r.source.order_id, f.order.id); assert.equal(r.physical.stock_movements.length, 3); assert.equal(r.physical.location_movements.length, 6); throw failure; }), e => e === failure);
    assert.equal(calls, 1); assert.deepEqual(await productCatalogFacts(f.tenant), before, 'Entire own graph including journals, reservations, layers, source state and audits rolls back');
    let proof: Collected | undefined; await execute(f, kind, plan, async r => { proof = structuredClone(r); }); assert(proof);
    physicalProof(f, before, await productCatalogFacts(f.tenant), proof, kind, plan);
  });
}

const settings = (enabled = true) => ({ enabled, moment: 'physical_dispatch' as const, series_name: 'Own physical dispatch167', prefix: 'WZ167' });
const draft = (expected_version = '0', enabled = true) => ({ client_key: randomUUID(), expected_version, settings: settings(enabled) });
const consent = (p: Row) => ({ client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true as const });
const status = (expected: number) => (e: any) => e.status === expected;
function onlyConfigurationChanged(a: Facts, b: Facts) {
  assert.deepEqual(Object.keys(b), Object.keys(a));
  for (const name of Object.keys(a)) if (!family.includes(name)) assert.deepEqual(b[name], a[name], 'No physical/number/provider/audit mutation: ' + name);
}
async function configPreview(f: Awaited<ReturnType<typeof stocktakeAdjustmentFixture>>, b = draft(), key?: Row) {
  return (await f.ok(prefix + '/warehouses/' + f.warehouse.id + '/previews', 'POST', b, 201, key)).preview;
}
async function configCommit(f: Awaited<ReturnType<typeof stocktakeAdjustmentFixture>>, p: Row, b = consent(p), key?: Row) {
  return f.ok(prefix + '/previews/' + p.id + '/commit', 'POST', b, 201, key);
}

test('additive150 preserves genuine preexisting ON rows, sessions, all old helper/OID/ACL and table metadata without history backfill', async () => {
  for (const [name, before] of Object.entries(migrationBefore.rows))
    assert.deepEqual(name === 'migrations' ? migrationAfter.rows[name].filter(x => x.row.name !== '150_warehouse_automatic_wz') : migrationAfter.rows[name], before, name);
  assert.equal(raw(migrationAfter.rows, 'migrations').filter(x => x.name === '150_warehouse_automatic_wz').length, 1);
  assert(raw(migrationBefore.rows, 'wms_cost_layers').some(x => x.unit_cost_minor === null));
  assert(raw(migrationBefore.rows, 'stock_locations').length > 0);
  assert.deepEqual(Object.keys(migrationAfter.rows).filter(n => !Object.hasOwn(migrationBefore.rows, n)).sort(), [...family].sort());
  for (const name of family) assert.equal(migrationAfter.rows[name].length, name.endsWith('_manifest') ? 1 : 0, 'No issued document, series or configuration backfill: ' + name);
  for (const f of migrationBefore.functions) assert.deepEqual(migrationAfter.functions.find(x => x.oid === f.oid), f, 'Old function body/OID/owner/ACL/config: ' + f.signature);
  for (const t of migrationBefore.tables) assert.deepEqual(migrationAfter.tables.find(x => x.oid === t.oid), t, 'Old table columns/indexes/constraints/RLS/ACL: ' + t.relname);
  for (const t of migrationBefore.triggers) assert.deepEqual(migrationAfter.triggers.find(x => x.oid === t.oid), t, 'Old trigger identity/definition: ' + t.relname);
  const extra = migrationAfter.triggers.filter(t => !migrationBefore.triggers.some(x => x.oid === t.oid));
  const users = extra.filter(t => !t.meta.tgisinternal);
  assert.equal(users.length, 7);
  for (const t of users) {
    assert(family.includes(t.relname)); assert.equal(t.meta.tgenabled, 'O');
    const fn = migrationAfter.functions.find(f => String(f.oid) === String(t.meta.tgfoid)); assert(fn); assert(fn.signature.startsWith('warehouse_automatic_wz_'));
    if (t.meta.tgname === 'warehouse_automatic_wz_complete') { assert.equal(t.relname, 'warehouse_automatic_wz_admissions'); assert.equal(t.meta.tgdeferrable, true); assert.equal(t.meta.tginitdeferred, true); }
    else assert(['warehouse_automatic_wz_record_guard','warehouse_automatic_wz_manifest_guard'].includes(t.meta.tgname));
  }
  const fks: Row[] = migrationAfter.tables.filter(t => family.includes(t.relname)).flatMap(t => t.constraints).filter((x: Row) => x.meta.contype === 'f');
  assert(fks.length > 0); const ri = extra.filter(t => t.meta.tgisinternal); assert.equal(ri.length, fks.length * 4);
  for (const fk of fks) {
    assert.equal(fk.meta.convalidated, true);
    const graph = ri.filter(t => String(t.meta.tgconstraint) === String(fk.meta.oid)); assert.equal(graph.length, 4);
    assert.deepEqual(graph.map(t => String(t.meta.tgrelid)).sort(), [fk.meta.conrelid,fk.meta.conrelid,fk.meta.confrelid,fk.meta.confrelid].map(String).sort());
  }
  assert.equal(await S.warehouseAutomaticWzAvailable(), true);
});

test('strict configuration consent accepts implicit version0 and rejects fabricated stock/issuer/cost authority', () => {
  assert(V.automaticWzPreviewInput.safeParse(draft()).success);
  assert(V.automaticWzCommitInput.safeParse(consent({ scope_hash: 'a'.repeat(64) })).success);
  for (const expected_version of ['00','-1','1.0','9223372036854775807']) assert(!V.automaticWzPreviewInput.safeParse(draft(expected_version)).success);
  for (const extra of [{ issuer_available: true },{ stock_movements: [] },{ warehouse_id: randomUUID() },{ unit_cost_minor: '0' }]) assert(!V.automaticWzPreviewInput.safeParse({ ...draft(), ...extra }).success);
  for (const extra of [{ confirmed: false },{ scope_hash: 'A'.repeat(64) },{ force: true }]) assert(!V.automaticWzCommitInput.safeParse({ ...consent({ scope_hash: 'a'.repeat(64) }), ...extra }).success);
});

test('OFF/ON separate preview/commit CAS stores one permanent warehouse series; exact historical replay never emits WZ or physical movement', async () => {
  for (const on of [false,true]) {
    const f = await stocktakeAdjustmentFixture(app, on), before = await productCatalogFacts(f.tenant);
    const options = await f.ok(prefix + '/options'); assert.equal(options.issuer_available, false); assert.equal(options.can_manage, true);
    assert.deepEqual(options.warehouses.find((w: Row) => w.id === f.warehouse.id).configuration, { warehouse_id: f.warehouse.id, version: '0', series_id: null, settings: null });
    const b = draft(), p = await configPreview(f, b), stale = await configPreview(f);
    assert.equal(p.snapshot.before.version, '0'); assert.equal(p.snapshot.after.version, '1'); assert(p.can_commit);
    const pb = await productCatalogFacts(f.tenant), again = await f.ok(prefix + '/warehouses/' + f.warehouse.id + '/previews', 'POST', b);
    assert(again.reused); assert.deepEqual(again.preview, p); assert.deepEqual(await productCatalogFacts(f.tenant), pb);
    const cb = consent(p), first = await configCommit(f, p, cb);
    assert.equal(first.issuer_available, false); assert.equal(first.operation.after.version, '1'); assert.equal(first.operation.after.series_id, p.snapshot.after.series_id);
    const secondPreview = await configPreview(f, draft('1', false)), second = await configCommit(f, secondPreview);
    assert.equal(second.operation.after.version, '2'); assert.equal(second.operation.after.series_id, first.operation.after.series_id);
    assert.equal(second.operation.after.settings.enabled, false);
    const saved = await productCatalogFacts(f.tenant); onlyConfigurationChanged(before, saved);
    for (const n of ['operations','revisions','admissions']) assert.equal(raw(saved, 'warehouse_automatic_wz_' + n).length, 2);
    assert.equal(raw(saved, 'warehouse_automatic_wz_configurations').length, 1);
    assert(raw(saved, 'warehouse_automatic_wz_admissions').every(a => a.sealed));
    const replay = await f.ok(prefix + '/previews/' + p.id + '/commit', 'POST', cb);
    assert(replay.reused); assert.deepEqual(replay.operation, first.operation);
    const historical = await f.ok(prefix + '/operations/' + first.operation.id); assert.deepEqual(historical.operation, first.operation);
    assert.equal((await f.request(prefix + '/previews/' + stale.id + '/commit', 'POST', consent(stale))).statusCode, 409);
    assert.equal((await f.request(prefix + '/previews/' + p.id + '/commit', 'POST', { ...cb, scope_hash: '0'.repeat(64) })).statusCode, 409);
    assert.equal((await f.request(prefix + '/warehouses/' + f.warehouse.id + '/previews', 'POST', { ...b, settings: settings(false) })).statusCode, 409);
    const ids: string[] = []; let cursor: string | null = null;
    do { const h: Row = await f.ok(prefix + '/history?kind=operation&warehouse_id=' + f.warehouse.id + '&limit=1' + (cursor ? '&cursor=' + cursor : '')); ids.push(...h.data.map((r: Row) => r.id)); cursor = h.next_cursor; assert(ids.length <= 2); } while (cursor);
    assert.deepEqual(ids.slice().sort(), [first.operation.id,second.operation.id].sort());
    assert.deepEqual(await productCatalogFacts(f.tenant), saved);
  }
});

test('foreign warehouse/preview/operation and distinct key/principal replay cannot access or mutate another configuration', async () => {
  const f = await stocktakeAdjustmentFixture(app), foreign = await stocktakeAdjustmentFixture(app);
  const p = await configPreview(f), cb = consent(p), done = await configCommit(f, p, cb);
  const key = await f.ok('/developer/keys', 'POST', { name: 'Own config writer167', scopes: ['inventory:read','inventory:write'] }, 201);
  const kp = await configPreview(f, draft('1'), key);
  const reader = await adjustmentActor(app, f.tenant, 'operator@demo.local');
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [f.tenant,reader.user]);
  const ownBefore = await productCatalogFacts(f.tenant), otherBefore = await productCatalogFacts(foreign.tenant);
  assert.equal((await foreign.request(prefix + '/warehouses/' + f.warehouse.id + '/previews', 'POST', draft())).statusCode, 404);
  for (const path of ['/previews/' + p.id,'/operations/' + done.operation.id,'/history?warehouse_id=' + f.warehouse.id]) assert.equal((await foreign.request(prefix + path)).statusCode, 404);
  assert.equal((await foreign.request(prefix + '/previews/' + p.id + '/commit','POST',cb)).statusCode,404);
  assert.equal((await f.request(prefix + '/previews/' + kp.id + '/commit','POST',consent(kp))).statusCode,409, 'Session cannot execute a key-owned preview');
  assert.equal((await reader.request(prefix + '/warehouses/' + f.warehouse.id + '/previews','POST',draft('1'))).statusCode,403);
  const read = await reader.ok(prefix + '/operations/' + done.operation.id); assert.deepEqual(read.operation, done.operation); assert.equal(read.can_manage,false); assert.equal(read.issuer_available,false);
  const keyRead = await f.ok('/developer/keys','POST',{ name:'Read config167',scopes:['inventory:read'] },201);
  const withKey = await productCatalogFacts(f.tenant);
  assert.equal((await f.request(prefix + '/warehouses/' + f.warehouse.id + '/previews','POST',draft('1'),keyRead)).statusCode,403);
  assert.equal((await f.ok(prefix + '/options','GET',undefined,200,keyRead)).can_manage,false);
  assert.deepEqual(await productCatalogFacts(f.tenant),withKey);
  // The one deliberate key birth is not a configuration or commerce change.
  for (const n of Object.keys(ownBefore)) if (!['api_keys','audit_events'].includes(n)) assert.deepEqual(withKey[n],ownBefore[n],n);
  assert.deepEqual(await productCatalogFacts(foreign.tenant),otherBefore);
});

async function observedPin(held: PoolClient, pending: Promise<unknown>) {
  void pending.catch(() => undefined);
  const pid = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid, end = Date.now()+5000;
  while (Date.now()<end) {
    const waits = (await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",[pid])).rows;
    if (waits.some(r => /warehouse_automatic_wz_access/.test(r.query))) return;
    await new Promise(resolve => setTimeout(resolve,10));
  }
  assert.fail('Real final access function must wait on the held current membership/key PIN');
}
test('configuration commit final membership PIN after actual wait rejects late withdrawal and rolls back the entire private graph', async () => {
  const f = await stocktakeAdjustmentFixture(app), p = await configPreview(f), before = await productCatalogFacts(f.tenant), held = await pool.connect(); let pending: Promise<Row>|undefined;
  try {
    await held.query('BEGIN'); await held.query('UPDATE memberships SET role=role WHERE tenant_id=$1 AND user_id=$2',[f.tenant,f.user]);
    pending = S.commitWarehouseAutomaticWz(f.actor,p.id,consent(p)); await observedPin(held,pending);
    await held.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",[f.tenant,f.user]); await held.query('COMMIT');
    await assert.rejects(pending,status(403));
  } finally { await held.query('ROLLBACK').catch(() => undefined); held.release(); if(pending) await pending.catch(()=>undefined); await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2",[f.tenant,f.user]); }
  assert.deepEqual(await productCatalogFacts(f.tenant),before);
});
for (const withdrawal of ['scope','revoked','expired'] as const) test(`configuration key ${withdrawal} after observed final PIN wait refuses ACK and preserves all rows`, async () => {
  const f = await stocktakeAdjustmentFixture(app), key = await f.ok('/developer/keys','POST',{name:'Own late key167',scopes:['inventory:read','inventory:write']},201);
  const p = await configPreview(f,draft(),key), before = await productCatalogFacts(f.tenant);
  const original = one(raw(before,'api_keys').filter(k=>k.id===key.id)), held = await pool.connect(); let pending: Promise<Row>|undefined;
  try {
    await held.query('BEGIN'); await held.query('UPDATE api_keys SET scopes=scopes WHERE tenant_id=$1 AND id=$2',[f.tenant,key.id]);
    pending = S.commitWarehouseAutomaticWz({...f.actor,apiKeyId:key.id},p.id,consent(p)); await observedPin(held,pending);
    if(withdrawal==='scope') await held.query("UPDATE api_keys SET scopes=ARRAY['inventory:read'] WHERE tenant_id=$1 AND id=$2",[f.tenant,key.id]);
    else if(withdrawal==='revoked') await held.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[f.tenant,key.id]);
    else await held.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[f.tenant,key.id]);
    await held.query('COMMIT'); await assert.rejects(pending,status(withdrawal==='scope'?403:401));
  } finally {
    await held.query('ROLLBACK').catch(()=>undefined); held.release(); if(pending) await pending.catch(()=>undefined);
    await pool.query('UPDATE api_keys SET scopes=$3,revoked_at=$4::timestamptz,expires_at=$5::timestamptz WHERE tenant_id=$1 AND id=$2',[f.tenant,key.id,original.scopes,original.revoked_at,original.expires_at]);
  }
  assert.deepEqual(await productCatalogFacts(f.tenant),before);
});

test('private table/function access, immutable UPDATE/DELETE, orphan admission and torn ACL are denied with unconditional rollback', async () => {
  const f = await stocktakeAdjustmentFixture(app), p = await configPreview(f), done = await configCommit(f,p), before = await productCatalogFacts(f.tenant);
  const security = (await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity,has_table_privilege('dyna_app',oid,'SELECT,INSERT,UPDATE,DELETE') app FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname",[family])).rows;
  assert.equal(security.length,6); assert(security.every(r=>r.relrowsecurity && r.relforcerowsecurity && !r.app));
  const functions = (await pool.query("SELECT oid,has_function_privilege('dyna_app',oid,'EXECUTE') app FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'warehouse_automatic_wz_%'")).rows;
  assert(functions.length>0); assert(functions.every(f=>!f.app));
  const c = await pool.connect();
  try {
    for (const query of ["SELECT * FROM public.warehouse_automatic_wz_configurations", "SELECT public.warehouse_automatic_wz_current($1,$2)"]) {
      await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]); await c.query('SET LOCAL ROLE dyna_app');
      await assert.rejects(c.query(query,query.includes('$1')?[f.tenant,f.warehouse.id]:[]),(e:any)=>e.code==='42501'); await c.query('ROLLBACK');
    }
    for(const query of ['UPDATE public.warehouse_automatic_wz_operations SET snapshot=snapshot WHERE id=$1','DELETE FROM public.warehouse_automatic_wz_operations WHERE id=$1']) {
      await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]);
      await assert.rejects(c.query(query,[done.operation.id]),(e:any)=>e.code==='23514'); await c.query('ROLLBACK');
    }
    const uncommitted = await configPreview(f,draft('1'));
    const orphanBefore = await productCatalogFacts(f.tenant);
    await c.query('BEGIN'); await c.query("SET LOCAL TimeZone='UTC'"); await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]);
    await c.query(`INSERT INTO public.warehouse_automatic_wz_admissions(id,tenant_id,warehouse_id,actor_id,api_key_id,preview_id,operation_id,revision_id,request)
      VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8::jsonb)`,[randomUUID(),f.tenant,f.warehouse.id,f.user,uncommitted.id,randomUUID(),randomUUID(),JSON.stringify(consent(uncommitted))]);
    await assert.rejects(c.query('SET CONSTRAINTS warehouse_automatic_wz_complete IMMEDIATE'),(e:any)=>e.code==='23514'); await c.query('ROLLBACK');
    assert.deepEqual(await productCatalogFacts(f.tenant),orphanBefore);
    await c.query('BEGIN'); await c.query('GRANT SELECT ON public.warehouse_automatic_wz_configurations TO pg_read_all_data');
    await assert.rejects(S.warehouseAutomaticWzAvailable(c),status(503)); await c.query('ROLLBACK');
    assert.equal(await S.warehouseAutomaticWzAvailable(),true);
    // Only the explicit additional uncommitted preview was born.
    const after = await productCatalogFacts(f.tenant); for(const n of Object.keys(before)) if(n!=='warehouse_automatic_wz_previews') assert.deepEqual(after[n],before[n],n);
    assert.equal(after.warehouse_automatic_wz_previews.length,before.warehouse_automatic_wz_previews.length+1);
  } finally { await c.query('ROLLBACK').catch(()=>undefined); c.release(); }
});

test('restored normal/v1 malformed configuration mutations are rejected423 before parse; GET history is pure', async () => {
  const f = await stocktakeAdjustmentFixture(app), p = await configPreview(f), done = await configCommit(f,p), before = await productCatalogFacts(f.tenant);
  const copy = await buildApp({readOnly:true,integrationTransport:async()=>{providerCalls++;throw Error('Readonly configuration cannot call a provider');}});
  try {
    for(const namespace of ['/api','/api/v1']) for(const path of ['/warehouses/'+f.warehouse.id+'/previews','/previews/'+p.id+'/commit']) {
      const r = await copy.inject({method:'POST',url:namespace+prefix+path,headers:{'content-type':'application/json'},payload:'{'}); assert.equal(r.statusCode,423);
    }
    const read = await S.warehouseAutomaticWzDetail(f.actor,'operation',done.operation.id,{readOnly:true});
    assert.deepEqual(read.operation,done.operation); assert.equal(read.can_manage,false); assert.equal(read.issuer_available,false); assert.equal(read.read_only,true);
    assert.deepEqual(await productCatalogFacts(f.tenant),before);
  } finally {await copy.close();}
});
