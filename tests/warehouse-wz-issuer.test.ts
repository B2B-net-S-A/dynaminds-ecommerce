import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { pool, tenantTx } from '../server/db';
import { shipDemo } from '../server/domain';
import { dispatchShipping, processShipping } from '../server/shipping';
import { processDpd } from '../server/dpd-shipping';
import { seed } from './fixtures';
import { stocktakeAdjustmentFixture } from './stocktake-adjustments-fixture';
import { productCatalogFacts } from './product-catalogs-fixture';

// Source-authored only. Root executes against an exclusively owned numeric DB.
// A historical150 fixture is constructed before151; no installed module is
// removed from a shared DB and no source dispatch/stock row is fabricated.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
type Facts = Record<string, { row: Row }[]>;
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
const transport = async () => { providerCalls++; throw Error('Only local shipping simulation is allowed'); };
const config = '/warehouse-automatic-wz';
const issuerTables = ['admissions','receipts','documents','rows','counters','manifest'].map(n => 'warehouse_wz_issuer_' + n);
let migrationBefore: Awaited<ReturnType<typeof migrationCapture>>;
let migrationAfter: Awaited<ReturnType<typeof migrationCapture>>;
const rows = (f: Facts, name: string): Row[] => { assert(f[name], name); return f[name].map(x => x.row); };
const one = (xs: Row[]) => { assert.equal(xs.length, 1); return xs[0]; };
const sorted = <T>(xs: T[]) => [...xs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const int = (v: unknown) => { assert(v !== null && v !== undefined); return BigInt(String(v)); };
function added(a: Facts, b: Facts, name: string) {
  const old = rows(a, name), now = rows(b, name);
  for (const x of old) assert.deepEqual(now.filter(y => y.id === x.id), [x], 'Old immutable journal remains exact: ' + name);
  return now.filter(x => !old.some(y => y.id === x.id));
}

// Test-only observation of the already-issued private graph on the caller's
// transaction. Keep the application's deliberate SELECT denial unchanged.
async function issuedDocumentCount(c: PoolClient, tenant: string): Promise<number> {
  const identity = (await c.query("SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];
  assert.equal(identity.owner, 'postgres'); assert.equal(identity.tenant, tenant);
  assert(['postgres', 'dyna_app'].includes(identity.role));
  const restore = identity.role === 'dyna_app'; let failed = false;
  try {
    if (restore) await c.query('RESET ROLE');
    return (await c.query('SELECT count(*)::int n FROM public.warehouse_wz_issuer_documents WHERE tenant_id=$1', [tenant])).rows[0].n;
  } catch (error) { failed = true; throw error; }
  finally {
    if (restore) {
      try { await c.query('SET LOCAL ROLE dyna_app'); }
      catch (error) { if (!failed) throw error; } // An aborted TX is rolled back by tenantTx.
    }
  }
}

async function migrationCapture() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    const data: Facts = {};
    for (const { tablename } of (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows) {
      assert.match(tablename, /^[a-z][a-z0-9_]*$/);
      data[tablename] = (await c.query(`SELECT to_jsonb(r) row FROM public."${tablename}" r ORDER BY 1`)).rows;
    }
    const functions = (await c.query("SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p) meta,pg_get_functiondef(p.oid) definition FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN('f','p') ORDER BY p.oid")).rows;
    const triggers = (await c.query("SELECT t.oid,c.relname,to_jsonb(t) meta,pg_get_triggerdef(t.oid,false) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid")).rows;
    const tables = (await c.query(`SELECT c.oid,c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,
      (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.attnum),'[]') FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0) columns,
      (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.oid),'[]') FROM pg_policy p WHERE p.polrelid=c.oid) policies,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(x),'definition',pg_get_constraintdef(x.oid,false)) ORDER BY x.oid),'[]') FROM pg_constraint x WHERE x.conrelid=c.oid) constraints,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(i),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid),'[]') FROM pg_index i WHERE i.indrelid=c.oid) indexes
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.oid`)).rows;
    await c.query('COMMIT'); return { rows: data, functions, triggers, tables };
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}

async function configure(f: Awaited<ReturnType<typeof stocktakeAdjustmentFixture>>, enabled = true) {
  const before = (await f.ok(config + '/options')).warehouses.find((w: Row) => w.id === f.warehouse.id)?.configuration;
  assert(before);
  const p = (await f.ok(config + '/warehouses/' + f.warehouse.id + '/previews', 'POST', {
    client_key: randomUUID(), expected_version: before.version,
    settings: { enabled, moment: 'physical_dispatch', series_name: 'Own real WZ168', prefix: 'WZ168' },
  }, 201)).preview;
  const body = { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true };
  const result = await f.ok(config + '/previews/' + p.id + '/commit', 'POST', body, 201);
  const facts = await productCatalogFacts(f.tenant);
  assert.deepEqual((await f.ok(config + '/previews/' + p.id + '/commit', 'POST', body)).operation, result.operation);
  assert.deepEqual(await productCatalogFacts(f.tenant), facts);
  return result.operation.after;
}

before(async () => {
  assert.equal((await pool.query("SELECT to_regclass('public.migrations') ledger")).rows[0].ledger, null);
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
  const central = await readFile(new URL('../server/db.ts', import.meta.url), 'utf8');
  const section = central.slice(central.indexOf('for (const [name, file] of ['));
  assert(section.startsWith('for (const [name, file] of ['));
  const manifest = [...section.matchAll(/\[\s*'(\d{3}_[a-z0-9_]+)'\s*,\s*'\.\/([a-z0-9_-]+\.sql)'\s*,?\s*\]/g)]
    .map(m => ({ name: m[1], file: m[2] })).filter(m => Number(m.name.slice(0, 3)) <= 150);
  assert.equal(manifest.length, 150); assert.equal(manifest[0].name, '001_foundation');
  assert.equal(manifest.at(-1)?.name, '150_warehouse_automatic_wz');
  assert.deepEqual(manifest.map(m => Number(m.name.slice(0, 3))), Array.from({ length: 150 }, (_, i) => i + 1));
  const c = await pool.connect();
  try {
    for (const m of manifest) {
      await c.query('BEGIN');
      try {
        await c.query(await readFile(new URL('../server/' + m.file, import.meta.url), 'utf8'));
        if (m.name === '092_wms_stocktakes') await c.query(await readFile(new URL('../server/wms-stocktake-invariants.sql', import.meta.url), 'utf8'));
        if (m.name === '108_b2b_dropshipping') await c.query(await readFile(new URL('../server/108_b2b_dropship_dispatch.sql', import.meta.url), 'utf8'));
        await c.query('INSERT INTO migrations(name) VALUES($1)', [m.name]); await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally { c.release(); }
  await seed(); app = await buildApp({ integrationTransport: transport });
  const historical = await stocktakeAdjustmentFixture(app, true);
  await configure(historical); // Nonempty genuine150 configuration/revision/history.
  const shipped = await packed(false, false, false);
  await shipped.ok('/orders/' + shipped.order.id + '/ship-demo', 'POST', {});
  assert.equal((await shipped.ok('/orders/' + shipped.order.id)).status, 'shipped');
  await app.close(); migrationBefore = await migrationCapture();
  const issuer = await pool.connect();
  try {
    await issuer.query('BEGIN');
    await issuer.query(await readFile(new URL('../server/151_warehouse_wz_issuer.sql', import.meta.url), 'utf8'));
    await issuer.query("INSERT INTO migrations(name) VALUES('151_warehouse_wz_issuer')");
    await issuer.query('COMMIT');
  } catch (e) { await issuer.query('ROLLBACK'); throw e; } finally { issuer.release(); }
  migrationAfter = await migrationCapture(); app = await buildApp({ integrationTransport: transport });
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });

test('151 preserves genuine nonempty150 configuration and already shipped history without backfill', async () => {
  for (const [name, before] of Object.entries(migrationBefore.rows)) {
    const actual = name === 'migrations' ? migrationAfter.rows[name].filter(x => x.row.name !== '151_warehouse_wz_issuer') : migrationAfter.rows[name];
    assert.deepEqual(actual, before, 'Every old global row, including sessions, remains exact: ' + name);
  }
  assert.equal(rows(migrationAfter.rows, 'migrations').filter(r => r.name === '151_warehouse_wz_issuer').length, 1);
  assert(rows(migrationBefore.rows, 'warehouse_automatic_wz_operations').length > 0);
  assert(rows(migrationBefore.rows, 'orders').some(o => o.status === 'shipped'));
  assert(rows(migrationBefore.rows, 'wms_cost_layers').some(l => l.unit_cost_minor === null));
  assert.deepEqual(Object.keys(migrationAfter.rows).filter(n => !Object.hasOwn(migrationBefore.rows, n)).sort(), issuerTables.slice().sort());
  for (const name of issuerTables) assert.equal(migrationAfter.rows[name].length, name.endsWith('_manifest') ? 1 : 0, 'No historical dispatch is issued: ' + name);
  for (const f of migrationBefore.functions) assert.deepEqual(migrationAfter.functions.find(x => x.oid === f.oid), f, 'Old function/OID/ACL/body: ' + f.signature);
  for (const t of migrationBefore.tables) assert.deepEqual(migrationAfter.tables.find(x => x.oid === t.oid), t, 'Old columns/indexes/policies/ACL: ' + t.relname);
  for (const t of migrationBefore.triggers) assert.deepEqual(migrationAfter.triggers.find(x => x.oid === t.oid), t, 'Old trigger remains exact: ' + t.relname);
  const extra = migrationAfter.triggers.filter(t => !migrationBefore.triggers.some(x => x.oid === t.oid));
  const users = extra.filter(t => !t.meta.tgisinternal);
  assert(users.length > 0);
  const sourceTables = ['orders','order_items','shipments','reservations','reservation_locations','stock','stock_locations','wms_reservation_layers','wms_layer_positions','stock_movements','stock_location_movements','wms_operations','wms_issue_fragments','wms_layer_movements'];
  assert.deepEqual(users.filter(t => !issuerTables.includes(t.relname)).map(t => t.relname).sort(), sourceTables.slice().sort());
  for (const t of users) {
    assert(issuerTables.includes(t.relname) || (sourceTables.includes(t.relname) && t.meta.tgname === 'warehouse_wz_issuer_source_seal'), 'No unannounced old-table user trigger');
    assert.equal(t.meta.tgenabled, 'O');
    const f = migrationAfter.functions.find(x => String(x.oid) === String(t.meta.tgfoid));
    assert(f); assert(f.signature.startsWith('warehouse_wz_issuer_'));
  }
  const foreignKeys: Row[] = migrationAfter.tables.filter(t => issuerTables.includes(t.relname)).flatMap(t => t.constraints).filter((x: Row) => x.meta.contype === 'f');
  assert(foreignKeys.length > 0);
  const ri = extra.filter(t => t.meta.tgisinternal); assert.equal(ri.length, foreignKeys.length * 4);
  for (const fk of foreignKeys) {
    assert.equal(fk.meta.convalidated, true);
    const graph = ri.filter(t => String(t.meta.tgconstraint) === String(fk.meta.oid)); assert.equal(graph.length, 4);
    assert.deepEqual(graph.map(t => String(t.meta.tgrelid)).sort(), [fk.meta.conrelid, fk.meta.conrelid, fk.meta.confrelid, fk.meta.confrelid].map(String).sort());
  }
});

async function packed(on: boolean, bundle = false, enabled = true) {
  const f = await stocktakeAdjustmentFixture(app, on);
  const configuration = await configure(f, enabled);
  const b = bundle ? await f.ok('/products', 'POST', {
    name: 'Own duplicate commercial bundle168', sku: 'B168-' + randomUUID(), kind: 'bundle', price: 1501, vat: 23,
    warehouse_id: f.warehouse.id, quantity: 0, components: f.products.map(p => ({ product_id: p.id, quantity: 1 })),
  }, 201) : null;
  let order = await f.ok('/orders', 'POST', {
    source: 'manual', customer_name: 'Own issued WZ168', email: 'wz168@example.test',
    address: { street: 'Own 168', city: 'Warszawa', postal_code: '00-168', country: 'PL', phone: '500000168' },
    warehouse_id: f.warehouse.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: b ? [{ product_id: b.id, quantity: 3 }] : f.products.map(p => ({ product_id: p.id, quantity: 3 })),
    ...(b ? { manual_lines: [{ product_id: b.id, quantity: 1, line_total: 1000 }, { product_id: b.id, quantity: 2, line_total: 3401 }] } : {}),
  }, 201);
  order = await f.ok('/orders/' + order.id);
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version), kind: 'receipt', amount: order.total,
    currency: 'PLN', method: 'other', reference: 'Own local declared payment168', confirmed: true });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'picking' });
  if (on) {
    const allocations = await f.ok('/wms-lots/orders/' + order.id + '/allocations');
    assert.equal(allocations.meta.cursor, null); assert.equal(allocations.data.length, 6);
    for (const a of allocations.data) {
      const p = f.products.find(p => p.id === a.product_id); assert(p);
      for (let n = 0; n < a.quantity; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
        client_key: randomUUID(), code: p.sku, location: a.location, layer_id: a.layer_id });
    }
  } else {
    const holds = (await pool.query('SELECT * FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id,location', [f.tenant, order.id])).rows;
    assert.equal(holds.length, 6);
    for (const h of holds) {
      const p = f.products.find(p => p.id === h.product_id); assert(p);
      for (let n = 0; n < h.quantity; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: p.sku, location: h.location });
    }
  }
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
  order = await f.ok('/orders/' + order.id); assert.equal(order.status, 'packed');
  if (b) { assert.equal(order.items.length, 2); assert.notEqual(order.items[0].id, order.items[1].id); assert.deepEqual(order.items.map((r: Row) => r.line_total).sort(), [1000, 3401]); }
  return { ...f, order, bundle: b, configuration };
}
type Packed = Awaited<ReturnType<typeof packed>>;

async function claim(f: Packed, id: string) {
  const job = await tenantTx(f.tenant, async c => (await c.query(`UPDATE jobs SET state='running',lease_token=$3,attempts=attempts+1,locked_at=now()
    WHERE tenant_id=$1 AND id=$2 AND state='pending' AND kind='shipping' RETURNING *`, [f.tenant, id, randomUUID()])).rows[0]);
  assert(job); assert.equal(job.payload.actor_id, f.user); await processShipping(job, { transport });
}
async function readyShipping(f: Packed) {
  const channel = await f.ok('/shipping/example', 'POST', {});
  const p = await f.ok('/orders/' + f.order.id + '/shipping/preview', 'POST', {
    channel_id: channel.id, service: 'inpost_locker_standard', receiver: { first_name: 'Own', last_name: 'Issuer', email: 'wz168@example.test', phone: '500000168' },
    target_point: 'WAW01M', template: 'small', weight: 1, cod: 0, insurance: 0,
  });
  const q = await f.ok('/shipping-plans/' + p.id + '/queue', 'POST', {}); await claim(f, q.job_id);
  const quoted = one((await pool.query('SELECT * FROM shipping_plans WHERE tenant_id=$1 AND id=$2', [f.tenant, p.id])).rows);
  assert.equal(quoted.state, 'quoted'); assert.equal(quoted.offers.length, 1);
  const buy = await f.ok('/shipping-plans/' + p.id + '/buy', 'POST', { offer_id: quoted.offers[0].id, confirm_cost: true }); await claim(f, buy.job_id);
  const ready = one((await pool.query('SELECT * FROM shipping_plans WHERE tenant_id=$1 AND id=$2', [f.tenant, p.id])).rows);
  assert.equal(ready.state, 'ready'); assert(ready.shipment_id); return ready;
}

function physicalConservation(f: Packed, before: Facts, after: Facts, quantity = 3) {
  const sm = added(before, after, 'stock_movements'), bins = added(before, after, 'stock_location_movements');
  assert.equal(sm.length, 3); assert.equal(bins.length, quantity === 1 ? 3 : 6);
  for (const p of f.products) {
    const match = (x: Row) => x.product_id === p.id && x.warehouse_id === f.warehouse.id;
    const old = one(rows(before, 'stock').filter(match)), now = one(rows(after, 'stock').filter(match));
    assert.equal(now.on_hand, old.on_hand - quantity); assert.equal(now.reserved, old.reserved - quantity);
    assert.equal(now.available, old.available); assert.equal(int(now.version), int(old.version) + 1n);
    const aggregate = one(sm.filter(match)); assert.equal(aggregate.delta, -quantity); assert.equal(aggregate.order_id, f.order.id); assert.equal(aggregate.kind, 'shipment');
    assert.equal(bins.filter(match).reduce((n, x) => n - x.delta, 0), quantity);
  }
  for (const b of bins) {
    assert.equal(b.tenant_id, f.tenant); assert.equal(b.order_id, f.order.id); assert.equal(b.kind, 'shipment'); assert(b.delta < 0);
    const match = (x: Row) => x.product_id === b.product_id && x.warehouse_id === b.warehouse_id && x.location === b.location;
    assert.equal(one(rows(after, 'stock_locations').filter(match)).quantity, one(rows(before, 'stock_locations').filter(match)).quantity + b.delta);
  }
  assert.deepEqual(after.warehouse_documents, before.warehouse_documents, 'Automatic sidecar must never call the legacy second physical writer');
  assert.deepEqual(after.warehouse_document_lines, before.warehouse_document_lines);
  assert.deepEqual(after.wms_cost_layers, before.wms_cost_layers);
  const fragments = added(before, after, 'wms_issue_fragments'), journal = added(before, after, 'wms_layer_movements'), ops = added(before, after, 'wms_operations');
  if (!f.on) { assert.deepEqual(fragments, []); assert.deepEqual(journal, []); assert.deepEqual(ops, []); return { sm, bins, fragments, journal, ops }; }
  assert.equal(fragments.length, bins.length); assert.equal(journal.length, fragments.length);
  for (const fr of fragments) {
    const layer = one(rows(before, 'wms_cost_layers').filter(l => l.id === fr.layer_id));
    assert.equal(fr.unit_cost_minor, layer.unit_cost_minor); assert.equal(fr.currency, layer.currency); assert.equal(fr.order_id, f.order.id); assert.equal(fr.warehouse_document_id, null);
    assert.equal(fr.value_minor === null ? null : int(fr.value_minor), layer.unit_cost_minor === null ? null : int(fr.quantity) * int(layer.unit_cost_minor));
    const j = one(journal.filter(x => x.operation_id === fr.operation_id && x.layer_id === fr.layer_id && x.product_id === fr.product_id && x.location === fr.location));
    assert.equal(j.delta, -fr.quantity); assert.equal(j.value_delta === null ? null : int(j.value_delta), fr.value_minor === null ? null : -int(fr.value_minor));
    const op = one(ops.filter(x => x.id === fr.operation_id)); assert.equal(op.warehouse_document_id, null); assert.equal(op.order_id, f.order.id);
  }
  return { sm, bins, fragments, journal, ops };
}

function documentProof(f: Packed, before: Facts, after: Facts, physicalQuantity = 3, commercialIds?: string[], sourceKind: 'demo'|'shipping_plan'|'parcel' = 'demo') {
  const doc = one(added(before, after, 'warehouse_wz_issuer_documents'));
  const receipt = one(added(before, after, 'warehouse_wz_issuer_receipts'));
  const admission = one(added(before, after, 'warehouse_wz_issuer_admissions'));
  assert.equal(doc.receipt_id, receipt.id); assert.equal(receipt.id, admission.id); assert.equal(admission.sealed, true);
  assert.equal(admission.actor_id, f.user); assert.equal(admission.api_key_id, null);
  assert.equal(doc.warehouse_id, f.warehouse.id); assert.equal(doc.series_id, f.configuration.series_id);
  assert.equal(doc.revision_id, one(rows(before, 'warehouse_automatic_wz_configurations').filter(c => c.warehouse_id === f.warehouse.id)).revision_id);
  assert.equal(receipt.order_id, f.order.id); assert.equal(receipt.shipment_id, doc.shipment_id);
  assert.equal(receipt.source.kind, sourceKind); assert.equal(receipt.source.order_id, f.order.id); assert.equal(receipt.source.shipment_id, doc.shipment_id);
  assert.deepEqual(receipt.source, admission.source); assert.deepEqual(doc.payload.source, receipt.source);
  const shipment = one(rows(after, 'shipments').filter(s => s.id === doc.shipment_id)); assert.equal(shipment.order_id, f.order.id); assert(shipment.dispatched_at);
  const saved = rows(after, 'warehouse_wz_issuer_rows').filter(r => r.document_id === doc.id).sort((a, b) => a.ordinal - b.ordinal);
  assert.equal(saved.length, physicalQuantity === 1 ? 3 : 6); assert.equal(doc.payload.row_count, saved.length);
  assert.deepEqual(saved.map(r => r.ordinal), Array.from({ length: saved.length }, (_, n) => n));
  assert.equal(doc.payload.id, doc.id); assert.equal(doc.payload.receipt_id, receipt.id); assert.equal(doc.payload.kind, 'WZ');
  assert.equal(doc.payload.sequence, String(doc.sequence)); assert.equal(doc.payload.year, doc.year);
  assert.equal(doc.number, 'WZ168/' + doc.year + '/' + String(doc.sequence).padStart(6, '0')); assert.equal(doc.payload.number, doc.number);
  const counter = one(rows(after, 'warehouse_wz_issuer_counters').filter(c => c.warehouse_id === f.warehouse.id && c.series_id === doc.series_id && c.year === doc.year));
  assert.equal(int(counter.sequence), int(doc.sequence));
  const sm = added(before, after, 'stock_movements'), bins = added(before, after, 'stock_location_movements');
  const fragments = added(before, after, 'wms_issue_fragments'), journal = added(before, after, 'wms_layer_movements');
  assert.deepEqual([...new Set(saved.map(r => r.stock_movement_id))].sort(), sm.map(m => m.id).sort());
  assert.deepEqual([...new Set(saved.map(r => r.location_movement_id))].sort(), bins.map(m => m.id).sort());
  assert.equal(saved.reduce((n, r) => n + r.payload.quantity, 0), f.products.length * physicalQuantity);
  assert.equal(doc.payload.summary.physical_quantity, f.products.length * physicalQuantity);
  for (const r of saved) {
    const p = r.payload, aggregate = one(sm.filter(m => m.id === r.stock_movement_id)), bin = one(bins.filter(m => m.id === r.location_movement_id));
    assert.equal(r.tenant_id, f.tenant); assert.equal(p.ordinal, r.ordinal); assert.equal(p.product_id, r.product_id);
    assert.equal(p.stock_movement_id, aggregate.id); assert.equal(p.location_movement_id, bin.id);
    assert.equal(p.warehouse_id, f.warehouse.id); assert.equal(p.location, bin.location); assert.equal(p.product_id, aggregate.product_id); assert.equal(p.product_id, bin.product_id);
    const product = f.products.find(product => product.id === p.product_id); assert(product); assert.equal(p.sku, product.sku); assert.equal(p.name, product.name);
    if (f.on) {
      const fr = one(fragments.filter(x => x.id === r.issue_fragment_id)), j = one(journal.filter(x => x.id === r.layer_movement_id));
      const layer = one(rows(before, 'wms_cost_layers').filter(x => x.id === r.layer_id));
      assert.equal(p.physical_id, fr.id); assert.equal(p.quantity, fr.quantity); assert.equal(fr.product_id, r.product_id); assert.equal(fr.location, p.location);
      assert.equal(r.operation_id, fr.operation_id); assert.equal(r.layer_id, fr.layer_id); assert.equal(r.lot_id, layer.lot_id);
      assert.equal(j.operation_id, fr.operation_id); assert.equal(j.layer_id, layer.id); assert.equal(j.delta, -p.quantity);
      for (const key of ['operation_id','issue_fragment_id','layer_movement_id','layer_id','lot_id']) assert.equal(p[key], r[key]);
      assert.equal(p.unit_cost_minor, fr.unit_cost_minor === null ? null : String(fr.unit_cost_minor));
      assert.equal(p.value_minor, fr.value_minor === null ? null : String(fr.value_minor)); assert.equal(p.currency, fr.currency); assert.equal(p.exponent, layer.exponent);
    } else {
      assert.equal(p.physical_id, bin.id); assert.equal(p.quantity, -bin.delta);
      for (const key of ['operation_id','issue_fragment_id','layer_movement_id','layer_id','lot_id']) { assert.equal(r[key], null); assert.equal(p[key], null); }
      for (const key of ['unit_cost_minor','value_minor','currency','exponent']) assert.equal(Object.hasOwn(p, key), false, 'OFF has no invented valuation');
    }
  }
  if (f.on) {
    assert.deepEqual(saved.map(r => r.issue_fragment_id).sort(), fragments.map(fr => fr.id).sort());
    assert.deepEqual(saved.map(r => r.layer_movement_id).sort(), journal.map(j => j.id).sort());
    assert.equal(int(doc.payload.summary.known_value_minor), BigInt(physicalQuantity * 1000)); assert.equal(doc.payload.summary.unknown_quantity, physicalQuantity);
    assert.equal(doc.payload.summary.currency, 'PLN'); assert.equal(doc.payload.summary.exponent, 2);
    assert.equal(saved.filter(r => r.payload.unit_cost_minor === '0').reduce((n, r) => n + r.payload.quantity, 0), physicalQuantity);
    assert.equal(saved.filter(r => r.payload.unit_cost_minor === null).reduce((n, r) => n + r.payload.quantity, 0), physicalQuantity);
  } else assert.deepEqual(doc.payload.summary, { physical_quantity: physicalQuantity * f.products.length });
  const ids = commercialIds ?? f.order.items.map((i: Row) => i.id);
  assert.deepEqual(receipt.commercial_lines.map((l: Row) => l.item_id).sort(), ids.slice().sort());
  assert.deepEqual(doc.payload.commercial_lines, receipt.commercial_lines);
  const allocated = new Map<string, number>();
  for (const line of receipt.commercial_lines) {
    const original = one(f.order.items.filter((i: Row) => i.id === line.item_id));
    assert.equal(line.product_id, original.product_id); assert.equal(line.sku, original.sku); assert.equal(line.name, original.name); assert.equal(line.line_total, original.line_total); assert.equal(line.vat, original.vat);
    const components = original.components.length ? original.components : [{ product_id: original.product_id, quantity: 1 }];
    assert.deepEqual(line.components, components);
    for (const component of components) assert.equal(line.allocations.filter((a: Row) => a.product_id === component.product_id).reduce((n: number, a: Row) => n + a.quantity, 0), line.quantity * component.quantity);
    for (const a of line.allocations) {
      const effect = one(saved.filter(r => r.payload.physical_id === a.physical_id)).payload;
      assert.equal(a.product_id, effect.product_id); assert.equal(a.warehouse_id, effect.warehouse_id); assert(a.quantity > 0);
      allocated.set(a.physical_id, (allocated.get(a.physical_id) ?? 0) + a.quantity);
    }
  }
  assert.deepEqual([...allocated.entries()].sort(), saved.map(r => [r.payload.physical_id, r.payload.quantity]).sort(), 'Shared physical fragments are allocated exactly once across distinct commercial UUIDs');
  return { doc, receipt, admission, saved };
}

// Document/receipt field assertions are added against the actual151 SQL wire,
// rather than accepting a self-reported physical array as an independent proof.
for (const on of [false, true]) for (const kind of ['demo', 'shipping_plan'] as const) {
  test(`${on ? 'ON zero/known/NULL' : 'OFF'} ${kind} ordinary enabled dispatch emits once with the original physical journals`, async () => {
    const f = await packed(on), p = kind === 'shipping_plan' ? await readyShipping(f) : null;
    const baseline = await productCatalogFacts(f.tenant);
    const path = kind === 'demo' ? '/orders/' + f.order.id + '/ship-demo' : '/shipping-plans/' + p!.id + '/dispatch';
    await f.ok(path, 'POST', {});
    const after = await productCatalogFacts(f.tenant); physicalConservation(f, baseline, after);
    documentProof(f, baseline, after, 3, undefined, kind);
    assert.equal(added(baseline, after, 'warehouse_wz_issuer_documents').length, 1);
    assert.equal(added(baseline, after, 'warehouse_wz_issuer_receipts').length, 1);
    const replay = await f.request(path, 'POST', {}); assert.equal(replay.statusCode, kind === 'demo' ? 409 : 200);
    assert.deepEqual(await productCatalogFacts(f.tenant), after, 'No extra WZ/number/movement on ordinary source repeat');
  });
  test(`${on ? 'ON' : 'OFF'} ${kind} trusted callback failure rolls back dispatch, documents and counters together`, async () => {
    const f = await packed(on), p = kind === 'shipping_plan' ? await readyShipping(f) : null;
    const baseline = await productCatalogFacts(f.tenant); let seen = false;
    await assert.rejects(() => tenantTx(f.tenant, async c => {
      const callback = async () => {
        seen = true;
        assert.equal(await issuedDocumentCount(c, f.tenant), 1,
          'The rollback is after actual issuing, not before the new writer');
        throw Error('Own simulated downstream failure after issuer168');
      };
      return kind === 'demo' ? shipDemo(c, f.actor, f.order.id, callback) : dispatchShipping(c, f.actor, p!.id, callback);
    }), /Own simulated downstream failure after issuer168/);
    assert.equal(seen, true); assert.deepEqual(await productCatalogFacts(f.tenant), baseline);
    const path = kind === 'demo' ? '/orders/' + f.order.id + '/ship-demo' : '/shipping-plans/' + p!.id + '/dispatch';
    await f.ok(path, 'POST', {}); const after = await productCatalogFacts(f.tenant); physicalConservation(f, baseline, after);
    assert.equal(added(baseline, after, 'warehouse_wz_issuer_documents').length, 1);
  });
}

for (const on of [false, true]) test(`${on ? 'ON' : 'OFF'} disabled warehouse configuration permits the original dispatch without number or WZ`, async () => {
  const f = await packed(on, false, false), before = await productCatalogFacts(f.tenant);
  await f.ok('/orders/' + f.order.id + '/ship-demo', 'POST', {});
  const after = await productCatalogFacts(f.tenant); physicalConservation(f, before, after);
  for (const n of issuerTables) assert.deepEqual(after[n], before[n], 'Disabled warehouse cannot allocate a counter/document: ' + n);
});

test('raw dyna_app cannot read/write issuer sidecars or execute private issuer authority', async () => {
  const f = await stocktakeAdjustmentFixture(app), before = await productCatalogFacts(f.tenant);
  const tables = (await pool.query(`SELECT oid,relname,relrowsecurity,relforcerowsecurity,
    has_table_privilege('dyna_app',oid,'SELECT,INSERT,UPDATE,DELETE') app FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname`, [issuerTables])).rows;
  assert.equal(tables.length, issuerTables.length); assert(tables.every(t => t.relrowsecurity && t.relforcerowsecurity && !t.app));
  const functions = (await pool.query(`SELECT oid,oid::regprocedure::text signature,has_function_privilege('dyna_app',oid,'EXECUTE') app
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'warehouse_wz_issuer_%'`)).rows;
  assert(functions.length > 0); assert(functions.every(f => !f.app));
  const c = await pool.connect();
  try {
    for (const name of issuerTables) for (const action of ['SELECT * FROM', 'DELETE FROM']) {
      await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]); await c.query('SET LOCAL ROLE dyna_app');
      await assert.rejects(c.query(`${action} public.${name}`), (e: any) => e.code === '42501'); await c.query('ROLLBACK');
    }
    await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]); await c.query('SET LOCAL ROLE dyna_app');
    await assert.rejects(c.query('SELECT public.warehouse_wz_issuer_guards()'), (e: any) => e.code === '42501');
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  assert.deepEqual(await productCatalogFacts(f.tenant), before);
});

for (const on of [false, true]) test(`${on ? 'ON' : 'OFF'} commercial duplicate bundle parcels issue only the actual first parcel, then replay and remaining parcel once`, async () => {
  const f = await packed(on, true), cheap = f.order.items.find((i: Row) => i.line_total === 1000), expensive = f.order.items.find((i: Row) => i.line_total === 3401);
  assert(cheap && expensive); assert.notEqual(cheap.id, expensive.id); assert.equal(cheap.product_id, expensive.product_id);
  const p = (await f.ok('/order-parcels/orders/' + f.order.id + '/previews', 'POST', {
    client_key: randomUUID(), order_version: String(f.order.version), protocol: 'commercial_v1', parcels: [
      { source_kind: 'demo', cod_minor: 0, items: [{ item_id: cheap.id, quantity: 1 }] },
      { source_kind: 'demo', cod_minor: 0, items: [{ item_id: expensive.id, quantity: 2 }] },
    ],
  }, 201)).preview;
  const plan = (await f.ok('/order-parcels/previews/' + p.id + '/apply', 'POST', { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true }, 201)).plan;
  assert(plan.progress.every((r: Row) => r.state === 'pending'));
  const before = await productCatalogFacts(f.tenant), firstBody = { client_key: randomUUID(), scope_hash: plan.scope_hash, confirmed: true };
  const first = await f.ok('/order-parcels/plans/' + plan.id + '/parcels/0/dispatch', 'POST', firstBody);
  assert.equal(first.reused, false); assert.equal(first.plan.progress[0].state, 'dispatched'); assert.equal(first.plan.progress[1].state, 'pending');
  const afterFirst = await productCatalogFacts(f.tenant); physicalConservation(f, before, afterFirst, 1);
  const firstProof = documentProof(f, before, afterFirst, 1, [cheap.id], 'parcel');
  assert.equal(firstProof.receipt.source.dispatch_id, first.dispatch.id); assert.equal(firstProof.receipt.source.parcel_index, 0);
  assert.equal(added(before, afterFirst, 'warehouse_wz_issuer_documents').length, 1);
  assert.deepEqual(afterFirst.order_parcel_commercial_origins, before.order_parcel_commercial_origins,
    'The authentic commercial origins were frozen when the plan was applied');
  const oldIssues = rows(before, 'order_parcel_origin_issues'), currentIssues = rows(afterFirst, 'order_parcel_origin_issues');
  for (const old of oldIssues) assert.deepEqual(currentIssues.filter(r => r.origin_id === old.origin_id && r.dispatch_id === old.dispatch_id), [old]);
  const issues = currentIssues.filter(r => !oldIssues.some(old => old.origin_id === r.origin_id && old.dispatch_id === r.dispatch_id));
  const issue = one(issues), origin = one(rows(afterFirst, 'order_parcel_commercial_origins').filter(r => r.id === issue.origin_id));
  assert.equal(issue.tenant_id, f.tenant); assert.equal(issue.dispatch_id, first.dispatch.id); assert.equal(issue.quantity, 1);
  assert.equal(origin.item_id, cheap.id); assert.equal(origin.quantity, 1); assert.equal(origin.parcel_index, 0); assert.equal(origin.plan_id, plan.id);
  const replay = await f.ok('/order-parcels/plans/' + plan.id + '/parcels/0/dispatch', 'POST', firstBody);
  assert.equal(replay.reused, true); assert.deepEqual(replay.dispatch, first.dispatch); assert.deepEqual(await productCatalogFacts(f.tenant), afterFirst);
  assert.equal((await f.request('/order-parcels/plans/' + plan.id + '/parcels/0/dispatch', 'POST', { ...firstBody, scope_hash: 'f'.repeat(64) })).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), afterFirst);
  const second = await f.ok('/order-parcels/plans/' + plan.id + '/parcels/1/dispatch', 'POST', { client_key: randomUUID(), scope_hash: plan.scope_hash, confirmed: true });
  assert.equal(second.reused, false); assert.notEqual(second.dispatch.id, first.dispatch.id);
  const afterSecond = await productCatalogFacts(f.tenant);
  const secondProof = documentProof(f, afterFirst, afterSecond, 2, [expensive.id], 'parcel');
  assert.equal(secondProof.receipt.source.dispatch_id, second.dispatch.id); assert.equal(secondProof.receipt.source.parcel_index, 1);
  assert.equal(int(secondProof.doc.sequence), int(firstProof.doc.sequence) + 1n);
  const secondSm = added(afterFirst, afterSecond, 'stock_movements'), secondBins = added(afterFirst, afterSecond, 'stock_location_movements');
  assert.equal(secondSm.length, 3); assert.equal(secondSm.reduce((n, m) => n - m.delta, 0), 6);
  assert.equal(secondBins.reduce((n, m) => n - m.delta, 0), 6);
  assert.equal(added(afterFirst, afterSecond, 'warehouse_wz_issuer_documents').length, 1);
  for (const product of f.products) {
    const hold = one(rows(afterSecond, 'reservations').filter(r => r.order_id === f.order.id && r.product_id === product.id));
    assert.equal(hold.consumed_quantity, 3); assert.equal(hold.state, 'consumed');
    assert.equal(one(rows(afterSecond, 'stock').filter(r => r.product_id === product.id && r.warehouse_id === f.warehouse.id)).on_hand, 1);
  }
  assert.deepEqual(afterSecond.wms_cost_layers, before.wms_cost_layers);
  assert.equal(added(before, afterSecond, 'stock_movements').length, 6, 'Exactly three physical aggregates per actual parcel, no WZ second writer');
});

for (const on of [false, true]) test(`${on ? 'ON' : 'OFF'} genuine local DPD wrapper issues one WZ without carrier calls or a second physical issue`, async () => {
  const f = await packed(on), channel = await f.ok('/dpd-shipping/example', 'POST', {});
  const party = { name: 'Own local WZ168', address: 'Testowa 168', city: 'Warszawa', postalCode: '01-354', phone: '500600700', email: 'wz168@example.test' };
  const p = await f.ok('/orders/' + f.order.id + '/dpd-shipping/preview', 'POST', {
    channel_id: channel.channel_id, sender: party, receiver: party, weight: 1.25,
    dimensions: { length: 20, width: 15, height: 10 }, content: 'Own local proof168', cod: 0, insurance: 0,
  });
  const q = await f.ok('/dpd-shipping/' + p.id + '/queue', 'POST', { confirm_external: true, ack_contract_rate: true });
  const job = (await pool.query(`UPDATE jobs SET state='running',lease_token=$3,attempts=attempts+1,locked_at=now()
    WHERE tenant_id=$1 AND id=$2 AND state='pending' AND kind='shipping.dpd' RETURNING *`, [f.tenant, q.job_id, randomUUID()])).rows[0];
  assert(job); assert.equal(job.payload.actor_id, f.user); await processDpd(job, { transport });
  const ready = one((await pool.query('SELECT * FROM shipping_plans WHERE tenant_id=$1 AND id=$2', [f.tenant, p.id])).rows);
  assert.equal(ready.state, 'ready'); assert.equal(ready.result.scope, 'local_simulation'); assert(ready.shipment_id);
  const before = await productCatalogFacts(f.tenant); assert.equal(rows(before, 'warehouse_wz_issuer_documents').length, 0);
  await f.ok('/dpd-shipping/' + p.id + '/dispatch', 'POST', {});
  const after = await productCatalogFacts(f.tenant); physicalConservation(f, before, after);
  const proof = documentProof(f, before, after, 3, undefined, 'shipping_plan'); assert.equal(proof.receipt.source.plan_id, p.id);
  await f.ok('/dpd-shipping/' + p.id + '/dispatch', 'POST', {});
  assert.deepEqual(await productCatalogFacts(f.tenant), after); assert.equal(providerCalls, 0);
});

async function observedFinalPin(held: PoolClient, pending: Promise<unknown>, key: boolean, hydrated: () => boolean) {
  let completed = false;
  void pending.then(() => { completed = true; }, () => { completed = true; });
  const pid = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid, until = Date.now() + 7000;
  while (Date.now() < until) {
    assert.equal(completed, false, 'The real operation must reach the final blocked actor PIN');
    const waits = (await pool.query(`SELECT query FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rows;
    const pattern = key ? /wms_key_grant|FROM api_keys\s+WHERE tenant_id=/ : /wms_current_role|FROM memberships WHERE tenant_id=/;
    if (waits.some(r => pattern.test(r.query))) {
      assert(hydrated(), 'WZ, physical effects, constraint flush and complete source response precede the actual final wait');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('No actual issuer terminal actor/key waiter observed');
}

for (const on of [false, true]) test(`${on ? 'ON' : 'OFF'} late membership withdrawal at the observed issuer terminal PIN rolls back source, physical issue and number`, async () => {
  const f = await packed(on), before = await productCatalogFacts(f.tenant), held = await pool.connect();
  let pending: Promise<unknown> | undefined, hydrated = false;
  try {
    await held.query('BEGIN'); await held.query('UPDATE memberships SET role=role WHERE tenant_id=$1 AND user_id=$2', [f.tenant, f.user]);
    pending = tenantTx(f.tenant, async c => {
      const result = await shipDemo(c, f.actor, f.order.id);
      assert.equal(await issuedDocumentCount(c, f.tenant), 1);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE'); hydrated = true; return result;
    });
    await observedFinalPin(held, pending, false, () => hydrated);
    await held.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); await held.query('COMMIT');
    await assert.rejects(pending, (e: any) => e.status === 403);
  } finally {
    await held.query('ROLLBACK').catch(() => {}); held.release(); if (pending) await pending.catch(() => {});
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  }
  assert.deepEqual(await productCatalogFacts(f.tenant), before, 'Every journal, reservation, shipment, WZ and counter rolls back');
});

for (const on of [false, true]) for (const withdrawal of ['scope','revoked','expired'] as const) test(`${on ? 'ON' : 'OFF'} current key ${withdrawal} after actual issuer PIN wait refuses the dispatch ACK and restores the whole graph`, async () => {
  const f = await packed(on), key = await f.ok('/developer/keys', 'POST', {
    name: 'Own issuer current compound grants168', scopes: ['orders:read','orders:write','inventory:read','inventory:write','purchasing:read','purchasing:write'],
  }, 201);
  const before = await productCatalogFacts(f.tenant), original = one(rows(before, 'api_keys').filter(k => k.id === key.id)), held = await pool.connect();
  let pending: Promise<unknown> | undefined, hydrated = false;
  try {
    await held.query('BEGIN'); await held.query('UPDATE api_keys SET scopes=scopes WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]);
    pending = tenantTx(f.tenant, async c => {
      const result = await shipDemo(c, { ...f.actor, apiKeyId: key.id }, f.order.id);
      assert.equal(await issuedDocumentCount(c, f.tenant), 1);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE'); hydrated = true; return result;
    });
    await observedFinalPin(held, pending, true, () => hydrated);
    if (withdrawal === 'scope') await held.query("UPDATE api_keys SET scopes=ARRAY['orders:read','inventory:read'] WHERE tenant_id=$1 AND id=$2", [f.tenant, key.id]);
    else if (withdrawal === 'revoked') await held.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]);
    else await held.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [f.tenant, key.id]);
    await held.query('COMMIT'); await assert.rejects(pending, (e: any) => e.status === (withdrawal === 'scope' ? 403 : 401));
  } finally {
    await held.query('ROLLBACK').catch(() => {}); held.release(); if (pending) await pending.catch(() => {});
    await pool.query('UPDATE api_keys SET scopes=$3,revoked_at=$4::timestamptz,expires_at=$5::timestamptz WHERE tenant_id=$1 AND id=$2',
      [f.tenant, key.id, original.scopes, original.revoked_at, original.expires_at]);
  }
  assert.deepEqual(await productCatalogFacts(f.tenant), before);
});
