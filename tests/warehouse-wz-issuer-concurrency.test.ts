import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { stocktakeAdjustmentFixture, type AdjustmentFixture, type AdjustmentTestRow } from './stocktake-adjustments-fixture';
import { productCatalogFacts } from './product-catalogs-fixture';

// Root executes this module in an exclusively owned numeric scratch database.
// All stock, packing and parcel provenance is produced by actual public APIs.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = AdjustmentTestRow;
type Facts = Awaited<ReturnType<typeof productCatalogFacts>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let providerCalls = 0;
before(async () => {
  await migrate(); await seed();
  assert.equal((await pool.query('SELECT public.warehouse_wz_issuer_guards() ok')).rows[0].ok, true);
  app = await buildApp({ integrationTransport: async () => {
    providerCalls++; throw Error('The concurrency fixture must not call a provider');
  } });
});
after(async () => {
  try { assert.equal(providerCalls, 0); await app?.close(); }
  finally { await pool.end(); }
});
const rows = (facts: Facts, name: string): Row[] => {
  assert(facts[name], name); return facts[name].map(x => x.row);
};
const added = (a: Facts, b: Facts, name: string): Row[] => {
  const old = rows(a, name), now = rows(b, name);
  for (const row of old) assert.deepEqual(now.filter(x => x.id === row.id), [row], 'Original journal: ' + name);
  return now.filter(x => !old.some(row => row.id === x.id));
};

async function fixture() {
  // OFF is intentional: both requests can actually reach the issuer quota
  // before either dispatch commits, independently of ON WMS admission mutexes.
  const f = await stocktakeAdjustmentFixture(app, false);
  const configuration = (await f.ok('/warehouse-automatic-wz/options')).warehouses
    .find((w: Row) => w.id === f.warehouse.id)?.configuration;
  assert(configuration);
  const preview = (await f.ok('/warehouse-automatic-wz/warehouses/' + f.warehouse.id + '/previews', 'POST', {
    client_key: randomUUID(), expected_version: configuration.version,
    settings: { enabled: true, moment: 'physical_dispatch', series_name: 'Concurrent WZ168', prefix: 'WZ-RACE' },
  }, 201)).preview;
  await f.ok('/warehouse-automatic-wz/previews/' + preview.id + '/commit', 'POST', {
    client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true,
  }, 201);
  return f;
}
async function packed(f: AdjustmentFixture, bundle?: Row) {
  let order = await f.ok('/orders', 'POST', {
    source: 'manual', customer_name: 'Own concurrent issue168', email: 'race168@example.test',
    address: { street: 'Own 168', city: 'Warszawa', postal_code: '00-168', country: 'PL', phone: '500000168' },
    warehouse_id: f.warehouse.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: bundle ? [{ product_id: bundle.id, quantity: 2 }] : f.products.map(p => ({ product_id: p.id, quantity: 1 })),
    ...(bundle ? { manual_lines: [
      { product_id: bundle.id, quantity: 1, line_total: 1000 },
      { product_id: bundle.id, quantity: 1, line_total: 3401 },
    ] } : {}),
  }, 201);
  order = await f.ok('/orders/' + order.id);
  await f.ok('/orders/' + order.id + '/payments', 'POST', {
    client_key: randomUUID(), version: Number(order.version), kind: 'receipt', amount: order.total,
    currency: 'PLN', method: 'other', reference: 'Local declared payment for race168', confirmed: true,
  });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'picking' });
  const holds = (await pool.query('SELECT * FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id,location',
    [f.tenant, order.id])).rows;
  assert.equal(holds.reduce((n, h) => n + h.quantity, 0), bundle ? 6 : 3);
  for (const h of holds) {
    const product = f.products.find(p => p.id === h.product_id); assert(product);
    for (let i = 0; i < h.quantity; i++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
      client_key: randomUUID(), code: product.sku, location: h.location,
    });
  }
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
  order = await f.ok('/orders/' + order.id); assert.equal(order.status, 'packed');
  return order;
}

async function waitForTwoQuotaWaiters(controller: PoolClient, pid: number, terminal: () => boolean) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await controller.query('SELECT pg_stat_clear_snapshot()');
    const waiters = (await controller.query(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
      AND state='active' AND wait_event_type='Lock'
      AND query LIKE '%warehouse_wz_issuer_prepare%'
      AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rows;
    if (waiters.length === 2) { assert.notEqual(waiters[0].pid, waiters[1].pid); return; }
    assert.equal(terminal(), false, 'Both actual HTTP calls must still wait at issuer prepare');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Two actual issuer requests did not wait behind the owned quota lock');
}
async function concurrently<T>(tenant: string, start: () => Promise<T>[]) {
  const controller = await pool.connect();
  let requests: Promise<T>[] = [];
  let released = false;
  try {
    await controller.query('BEGIN');
    const identity = (await controller.query('SELECT current_database() database,pg_backend_pid() pid')).rows[0];
    assert.equal(identity.database, database.pathname.slice(1));
    await controller.query("SELECT pg_advisory_xact_lock(hashtextextended('wz.issuer.quota:'||$1::text,0))", [tenant]);
    requests = start(); assert.equal(requests.length, 2);
    let terminal = false;
    // Observe termination without replacing or retrying either request.
    for (const request of requests) void request.then(() => { terminal = true; }, () => { terminal = true; });
    await waitForTwoQuotaWaiters(controller, identity.pid, () => terminal);
    await controller.query('COMMIT'); released = true;
    return await Promise.all(requests);
  } finally {
    if (!released) await controller.query('ROLLBACK').catch(() => {});
    await Promise.allSettled(requests);
    controller.release();
  }
}
function physicalOnce(f: AdjustmentFixture, before: Facts, after: Facts, orderIds: string[], perProduct: number, journalCount: number) {
  const stock = added(before, after, 'stock_movements'), bins = added(before, after, 'stock_location_movements');
  assert.equal(stock.length, journalCount); assert.equal(bins.length, journalCount);
  for (const m of [...stock, ...bins]) {
    assert(orderIds.includes(m.order_id)); assert.equal(m.tenant_id, f.tenant);
    assert.equal(m.kind, 'shipment'); assert(m.delta < 0);
  }
  // Only aggregate stock journals have this legacy document column. Bin
  // journals bind their actual operation_id; do not invent a nullable column.
  for (const m of stock) assert.equal(m.warehouse_document_id, null);
  for (const m of bins) assert.equal(Object.hasOwn(m, 'warehouse_document_id'), false);
  for (const product of f.products) {
    const original = rows(before, 'stock').find(s => s.product_id === product.id && s.warehouse_id === f.warehouse.id);
    const current = rows(after, 'stock').find(s => s.product_id === product.id && s.warehouse_id === f.warehouse.id);
    assert(original && current);
    assert.equal(current.on_hand, original.on_hand - perProduct);
    assert.equal(current.reserved, original.reserved - perProduct);
    assert.equal(current.available, original.available);
    assert.equal(stock.filter(m => m.product_id === product.id).reduce((n, m) => n - m.delta, 0), perProduct);
    assert.equal(bins.filter(m => m.product_id === product.id).reduce((n, m) => n - m.delta, 0), perProduct);
  }
  for (const name of ['wms_operations','wms_issue_fragments','wms_layer_movements','wms_cost_layers','warehouse_documents','stocktake_adjustment_documents'])
    assert.deepEqual(after[name], before[name], 'OFF WZ adds no second physical or legacy document writer: ' + name);
}

test('two real packed orders in one warehouse wait concurrently then issue consecutive unique WZ without duplicate stock writers', async () => {
  const f = await fixture(), a = await packed(f), b = await packed(f);
  assert.notEqual(a.id, b.id);
  const before = await productCatalogFacts(f.tenant);
  const responses = await concurrently(f.tenant, () => [
    f.request('/orders/' + a.id + '/ship-demo', 'POST', {}).then(r => r),
    f.request('/orders/' + b.id + '/ship-demo', 'POST', {}).then(r => r),
  ]);
  for (const [i, response] of responses.entries()) {
    assert.equal(response.statusCode, 200); assert.equal(response.json().id, [a.id,b.id][i]);
    assert.equal(response.json().status, 'shipped');
  }
  const after = await productCatalogFacts(f.tenant);
  physicalOnce(f, before, after, [a.id,b.id], 2, 6);
  const documents = added(before, after, 'warehouse_wz_issuer_documents');
  assert.equal(documents.length, 2); assert.equal(new Set(documents.map(d => d.number)).size, 2);
  assert.equal(new Set(documents.map(d => d.series_id)).size, 1);
  assert.deepEqual(documents.map(d => d.shipment_id).sort(), added(before, after, 'shipments').map(s => s.id).sort());
  const sequences = documents.map(d => BigInt(d.sequence)).sort((a,b) => a<b?-1:a>b?1:0);
  assert.deepEqual(sequences, [1n,2n]);
  assert.equal(rows(after, 'warehouse_wz_issuer_counters').length, 1);
  assert.equal(BigInt(rows(after, 'warehouse_wz_issuer_counters')[0].sequence), 2n);
  assert.equal(added(before, after, 'warehouse_wz_issuer_admissions').length, 2);
  assert(rows(after, 'warehouse_wz_issuer_admissions').every(a => a.sealed));
  assert.equal(added(before, after, 'warehouse_wz_issuer_receipts').length, 2);
});

test('same commercial parcel and exact body wait concurrently then return one actual dispatch and one reused receipt without orphan WZ', async () => {
  const f = await fixture();
  const bundle = await f.ok('/products', 'POST', {
    name: 'Own concurrent duplicate bundle168', sku: 'RACE-' + randomUUID(), kind: 'bundle', price: 1501, vat: 23,
    warehouse_id: f.warehouse.id, quantity: 0, components: f.products.map(p => ({ product_id: p.id, quantity: 1 })),
  }, 201);
  const order = await packed(f, bundle);
  assert.equal(order.items.length, 2); assert.notEqual(order.items[0].id, order.items[1].id);
  assert.deepEqual(order.items.map((i: Row) => i.line_total).sort((a:number,b:number)=>a-b), [1000,3401]);
  const cheap = order.items.find((i: Row) => i.line_total === 1000);
  const expensive = order.items.find((i: Row) => i.line_total === 3401);
  assert(cheap && expensive);
  const preview = (await f.ok('/order-parcels/orders/' + order.id + '/previews', 'POST', {
    client_key: randomUUID(), order_version: String(order.version), protocol: 'commercial_v1',
    parcels: [
      { source_kind: 'demo', cod_minor: 0, items: [{ item_id: cheap.id, quantity: 1 }] },
      { source_kind: 'demo', cod_minor: 0, items: [{ item_id: expensive.id, quantity: 1 }] },
    ],
  }, 201)).preview;
  const plan = (await f.ok('/order-parcels/previews/' + preview.id + '/apply', 'POST', {
    client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true,
  }, 201)).plan;
  // A genuine parcel plan requires at least two parcels. Issue the first
  // through its ordinary endpoint, then race the final parcel to exercise
  // both quota waiting and the packed -> shipped exact-replay boundary.
  const first = await f.ok('/order-parcels/plans/' + plan.id + '/parcels/0/dispatch', 'POST', {
    client_key: randomUUID(), scope_hash: plan.scope_hash, confirmed: true,
  });
  assert.equal(first.reused, false); assert.equal(first.plan.complete, false);
  assert.equal(first.plan.order_status, 'packed');
  const before = await productCatalogFacts(f.tenant);
  assert.equal(rows(before, 'warehouse_wz_issuer_documents').length, 1);
  assert.equal(BigInt(rows(before, 'warehouse_wz_issuer_counters')[0].sequence), 1n);
  const body = { client_key: randomUUID(), scope_hash: plan.scope_hash, confirmed: true };
  const path = '/order-parcels/plans/' + plan.id + '/parcels/1/dispatch';
  const replies = await concurrently(f.tenant, () => [f.request(path,'POST',body).then(r=>r),f.request(path,'POST',body).then(r=>r)]);
  assert(replies.every(r => r.statusCode === 200));
  const received = replies.map(r => r.json());
  assert.deepEqual(received.map(r => r.reused).sort(), [false,true]);
  assert.deepEqual(received[0].dispatch, received[1].dispatch);
  assert(received.every(r => r.plan.complete && r.plan.order_status === 'shipped'));
  const after = await productCatalogFacts(f.tenant);
  physicalOnce(f, before, after, [order.id], 1, 3);
  assert.equal(added(before, after, 'order_parcel_dispatches').length, 1);
  assert.equal(added(before, after, 'warehouse_wz_issuer_admissions').length, 1);
  assert.equal(added(before, after, 'warehouse_wz_issuer_receipts').length, 1);
  const documents = added(before, after, 'warehouse_wz_issuer_documents'); assert.equal(documents.length, 1);
  assert.equal(BigInt(documents[0].sequence), 2n);
  assert.equal(documents[0].payload.source.dispatch_id, received[0].dispatch.id);
  assert.deepEqual(documents[0].payload.commercial_lines.map((l:Row)=>l.item_id), [expensive.id]);
  assert.equal(rows(after, 'warehouse_wz_issuer_counters').length, 1);
  assert.equal(BigInt(rows(after, 'warehouse_wz_issuer_counters')[0].sequence), 2n);
  assert(rows(after, 'warehouse_wz_issuer_admissions').every(a => a.sealed));
});
