import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { returnAssistantFixture } from './return-assistant-fixture';
import { productCatalogFacts } from './product-catalogs-fixture';
import { dispatchOrderParcel } from '../server/order-parcels';
import { receiveReturn, receiveInput } from '../server/returns';
import { previewWarehouseInventoryPolicy, commitWarehouseInventoryPolicy } from '../server/warehouse-inventory-policies';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_[a-zA-Z0-9_]+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await migrate(); await seed();
  app = await buildApp({ integrationTransport: async () => { throw Error('No provider in parcel warehouse lock test'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

async function waiter(observer: PoolClient, blocker: number, query: RegExp, failure?: () => string | undefined): Promise<number> {
  return waiterAtStage(observer, [{ blocker, query }], failure);
}
async function waiterAtStage(observer: PoolClient, stages: { blocker: number; query: RegExp }[], failure?: () => string | undefined): Promise<number> {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const code = failure?.();
    if (code) assert.fail('Actual preceding transaction rejected before expected lock wait: ' + code);
    await observer.query('SELECT pg_stat_clear_snapshot()');
    const rows = (await observer.query<{ pid: number; query: string; blockers: number[] }>(`SELECT pid,query,pg_blocking_pids(pid) blockers FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND pg_blocking_pids(pid)&&$1::integer[]`, [stages.map(stage => stage.blocker)])).rows;
    const found = rows.find(row => stages.some(stage => row.blockers.includes(stage.blocker) && stage.query.test(row.query)));
    if (found) return found.pid;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected real blocker and matching SQL waiter, not a timed concurrent promise');
}

for (const on of [false, true]) test(`${on ? 'ON bundle serialized WMS admission' : 'OFF actual quota/warehouse wait'} completes with queued policy writer; committed replay survives custody`, async () => {
  const f = await returnAssistantFixture(app, on);
  // A separate, ordinary own warehouse contains exactly the three sale units.
  // The original fixture commerce is unchanged and cannot make this WH nonempty.
  const warehouse = await f.ok('/warehouses', 'POST', { name: 'Own parcel lock source', code: 'PL-' + randomUUID().slice(0, 8) });
  if (on) {
    await f.ok('/wms-lots/receipts', 'POST', {
      client_key: randomUUID(), policy_version: '1', warehouse_id: warehouse.id, confirmed: true,
      note: 'Genuine parcel lock PZ',
      stock_versions: f.components.map(p => ({ warehouse_id: warehouse.id, product_id: p.id, version: '0' })),
      lines: f.components.map(p => ({ product_id: p.id, quantity: 3 * p.recipe, location: 'PARCEL-161',
        lot_code: 'PL-' + randomUUID(), unit_cost_minor: p.cost, currency: 'PLN' })),
    }, 201);
  } else {
    const pz = await f.ok('/warehouse-documents', 'POST', { kind: 'receipt', warehouse_id: warehouse.id,
      reference: 'Genuine parcel lock PZ', lines: [{ product_id: f.product.id, quantity: 3, location: 'PARCEL-161' }] }, 201);
    await f.ok('/warehouse-documents/' + pz.id + '/post', 'POST', { version: pz.version });
  }
  let order = await f.ok('/orders', 'POST', { source: 'manual', customer_name: 'Own parcel lock buyer', email: 'lock@example.test',
    address: f.order.address, warehouse_id: warehouse.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: [{ product_id: f.product.id, quantity: 3 }] }, 201);
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version),
    kind: 'receipt', amount: order.total, currency: 'PLN', method: 'other', reference: 'Synthetic own local ledger', confirmed: true });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
  if (on) {
    const allocations = await f.ok('/wms-lots/orders/' + order.id + '/allocations');
    assert.equal(allocations.meta?.cursor ?? null, null);
    for (const allocation of allocations.data) {
      const component = f.components.find(p => p.id === allocation.product_id); assert(component);
      for (let i = 0; i < allocation.quantity; i++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
        client_key: randomUUID(), code: component.sku, location: allocation.location, layer_id: allocation.layer_id });
    }
  } else for (let i = 0; i < 3; i++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
    client_key: randomUUID(), code: f.product.sku, location: 'PARCEL-161' });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'packed' }));
  order = await f.ok('/orders/' + order.id);
  const originalItems = order.items;
  const preview = (await f.ok('/order-parcels/orders/' + order.id + '/previews', 'POST', {
    client_key: randomUUID(), order_version: String(order.version), protocol: 'commercial_v1',
    parcels: [1, 2].map(quantity => ({ source_kind: 'demo', cod_minor: 0, items: [{ item_id: originalItems[0].id, quantity }] })),
  }, 201)).preview;
  const plan = (await f.ok('/order-parcels/previews/' + preview.id + '/apply', 'POST', {
    client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true }, 201)).plan;
  await dispatchOrderParcel(f.actor, plan.id, 0, { client_key: randomUUID(), scope_hash: plan.scope_hash, confirmed: true });
  order = await f.ok('/orders/' + order.id);
  const origin = order.returns.parcel_origins[0]; assert(origin && origin.quantity === 1);
  const rma = await f.ok('/orders/' + order.id + '/returns', 'POST', { client_key: randomUUID(), reason: 'Own genuine first parcel return',
    shipping_refund: 0, items: [{ item_id: origin.item_id, quantity: 1 }],
    parcel_origins: [{ item_id: origin.item_id, dispatch_id: origin.dispatch_id, quantity: 1 }] }, 201);
  // Hold remains accepted without physical restock under the existing core.
  const receive = receiveInput.parse({ version: Number(rma.version), shipping_refund: 0, note: 'Own item held outside stock',
    items: [{ item_id: origin.item_id, accepted: 1, restocked: 0 }] });
  // A no-op sale revision is legal even while reservations exist. It still
  // acquires the real warehouse UPDATE lock and reproduces lock queue ordering.
  const policyPreview = (await previewWarehouseInventoryPolicy(f.actor, warehouse.id,
    { client_key: randomUUID(), version: '0', usage: 'sale', enabled: true })).preview;
  assert.equal(policyPreview.ready, true);
  const secondBody = { client_key: randomUUID(), scope_hash: plan.scope_hash, confirmed: true };
  const quota = await pool.connect();
  let returned: Promise<Awaited<ReturnType<typeof receiveReturn>>> | undefined;
  let policy: Promise<Awaited<ReturnType<typeof commitWarehouseInventoryPolicy>>> | undefined;
  let dispatched: Promise<Awaited<ReturnType<typeof dispatchOrderParcel>>> | undefined;
  try {
    await quota.query('BEGIN');
    const pid = (await quota.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await quota.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['order.parcels.quota:' + f.tenant]);
    let returnFailure: string | undefined;
    returned = tenantTx(f.tenant, c => receiveReturn(c, f.actor, rma.id, receive));
    returned.catch((error: unknown) => {
      const code = (error as { code?: unknown }).code;
      returnFailure = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'UNCLASSIFIED';
    });
    const returnPid = await waiter(quota, pid, /order_parcel_return_lock/, () => returnFailure);
    policy = commitWarehouseInventoryPolicy(f.actor, policyPreview.id,
      { client_key: randomUUID(), scope_hash: policyPreview.scope_hash, confirmed: true }); policy.catch(() => undefined);
    const policyPid = await waiter(quota, returnPid, /warehouse_inventory_policy_commit/);
    dispatched = dispatchOrderParcel(f.actor, plan.id, 1, secondBody); dispatched.catch(() => undefined);
    if (on) {
      // ON serializes genuine WMS writers before entering the service callback.
      // The return owns that admission while waiting on parcel quota; dispatch
      // must wait on it rather than falsely claiming it reached the WH lock.
      await waiter(quota, returnPid, /pg_advisory_xact_lock/);
    } else await waiterAtStage(quota, [
      { blocker: policyPid, query: /warehouse_inventory_policy_lock/ },
      { blocker: pid, query: /order_parcel_prepare_dispatch/ },
    ]);
    // Compatible OFF SHARE may pass the queued WH writer and reach quota;
    // otherwise it waits on WH. ON waits on the prior WMS admission. Every
    // alternative proves the actual expected SQL stage and exact blocker.
    await quota.query('COMMIT');
    const result = await returned; assert.equal(result.state, 'refund_pending');
    assert.equal(result.refund_amount, 1000);
    assert.equal(result.items[0].accepted, 1); assert.equal(result.items[0].restocked, 0);
    assert.equal((await policy).operation.after.version, '1');
    const sent = await dispatched; assert.equal(sent.reused, false); assert.equal(sent.plan.complete, true);
    assert.deepEqual((await f.ok('/orders/' + order.id)).items, originalItems);
    for (const component of f.components) {
      const stock = (await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
        [f.tenant, warehouse.id, component.id])).rows[0];
      assert.deepEqual(stock, { on_hand: 0, reserved: 0 });
    }
    const custodyPreview = (await previewWarehouseInventoryPolicy(f.actor, warehouse.id,
      { client_key: randomUUID(), version: '1', usage: 'custody', enabled: true })).preview;
    assert.equal(custodyPreview.ready, true);
    await commitWarehouseInventoryPolicy(f.actor, custodyPreview.id,
      { client_key: randomUUID(), scope_hash: custodyPreview.scope_hash, confirmed: true });
    const facts = await productCatalogFacts(f.tenant);
    const replay = await dispatchOrderParcel(f.actor, plan.id, 1, secondBody);
    assert.equal(replay.reused, true); assert.deepEqual(replay.dispatch, sent.dispatch);
    assert.deepEqual(await productCatalogFacts(f.tenant), facts, 'Policy drift cannot turn committed replay into another physical write or audit');
  } finally {
    await quota.query('ROLLBACK').catch(() => undefined); quota.release();
    await Promise.allSettled([returned, policy, dispatched].map(p => p?.catch(() => undefined)));
  }
});
