import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import {
  ebayApplicationHash,
  ebayApiScope,
  ebaySimulationApplication,
} from '../server/ebay-api-limits';
import {
  scheduleEbayFulfillmentsDue,
  processEbayFulfillmentScan,
  failEbayFulfillmentScan,
} from '../server/ebay-fulfillment-schedules';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteShipmentFixture } from './shipment-identity-fixture';
import { tenantScopedOwnerQuery } from './tenant-scoped-owner-write';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { ebaySecrets } from './ebay-fixture';
import { ebayFulfillmentFixture } from './ebay-fulfillment-fixture';
import {
  processEbayFulfillment,
  failEbayFulfillment,
  fulfillmentCollection,
} from '../server/ebay-fulfillment';
import { encrypt } from '../server/security';
import {
  EBAY_FULFILLMENT_WRITE_SCOPE,
  EBAY_READ_SCOPE,
  EBAY_INVENTORY_SCOPE,
  ebayReadScopes,
} from '../server/ebay';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  viewer = '',
  other = '',
  warehouse = '',
  user = '',
  f = ebayFulfillmentFixture(),
  testIp = 1;
const ctx = { transport: (u: string, i: RequestInit) => f.transport(u, i) };
const req = (p: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api' + p,
    method,
    payload,
    headers: { cookie: auth },
    remoteAddress: '127.0.1.' + testIp,
  });
async function ok(p: string, method: any = 'GET', payload?: any) {
  const r = await req(p, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  const login = async (email: string) =>
    (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  user = (await ok('/auth/me')).user.id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query('DELETE FROM ebay_api_leases; DELETE FROM ebay_api_buckets');
  testIp++;
  f = ebayFulfillmentFixture();
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
  await pool.query('UPDATE ebay_fulfillment_configs SET enabled=false,next_run_at=NULL');
});
afterEach(async () => {
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
});
async function fixture(simulation = false, shipped = true) {
  const ch = (
    await ok('/integrations', 'POST', {
      provider: 'ebay',
      name: 'Fulfillment test',
      mode: 'sandbox',
      credentials: { ...ebaySecrets, ru_name: 'FULFILLMENT-QA' },
      settings: { fulfillment_write: 'true' },
    })
  ).id;
  const p = await ok('/products', 'POST', {
    sku: 'EBF-' + randomUUID(),
    name: 'eBay shipping test',
    price: 9999,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 12,
  });
  await ok(`/integrations/${ch}/mappings`, 'POST', {
    external_id: f.order.lineItems[0].sku,
    sku: p.sku,
  });
  await ok(`/integrations/${ch}/fetch-orders`, 'POST', { page: 1 });
  const inbound = (await ok(`/integrations/${ch}/imports`)).data[0];
  const o = await ok(`/imports/${inbound.id}/commit`, 'POST', {
    warehouse_id: warehouse,
    expected_hash: inbound.source_hash,
  });
  if (shipped) {
    await ok(`/orders/${o.id}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), `/orders/${o.id}/status`, { status: 'picking' }));
    for (let n = 0; n < 2; n++) await ok(`/orders/${o.id}/scan`, 'POST', { code: p.sku });
    await ok(`/orders/${o.id}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), `/orders/${o.id}/status`, { status: 'packed' }));
    await ok(`/orders/${o.id}/ship-demo`, 'POST', {});
  }
  if (simulation)
    await pool.query(
      'UPDATE channels SET settings=settings||\'{"simulation":true}\'::jsonb WHERE id=$1',
      [ch],
    );
  else if (shipped)
    await rewriteShipmentFixture(
      "UPDATE shipments SET mode='sandbox',carrier='DPD QA synthetic',tracking_number=$2 WHERE order_id=$1",
      [o.id, '003' + randomUUID().replaceAll('-', '')],
    );
  const shipment = (await pool.query('SELECT * FROM shipments WHERE order_id=$1', [o.id])).rows[0];
  return { ch, p, o, shipment };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const preview = (x: Fixture, auth = cookie, body: any = { shipping_carrier_code: 'DPD' }) =>
  req(`/orders/${x.o.id}/ebay-fulfillment/preview`, 'POST', body, auth);
async function plan(x: Fixture) {
  const r = await preview(x);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const queue = (p: any, confirm_external = true) =>
  req(`/ebay-fulfillment-plans/${p.id}/queue`, 'POST', { confirm_external });
const stored = async (p: any) =>
  (await pool.query('SELECT * FROM ebay_fulfillment_plans WHERE id=$1', [p.id])).rows[0];
const claim = async (id: string) =>
  (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
async function execute(p: any, last = false) {
  const current = await stored(p);
  if (last)
    await pool.query('UPDATE jobs SET attempts=max_attempts-1 WHERE id=$1', [current.job_id]);
  const j = await claim(current.job_id);
  try {
    await processEbayFulfillment(j, ctx);
  } catch (e) {
    await failEbayFulfillment(j, e);
  }
  return stored(p);
}
const writes = () =>
  f.calls.filter((c) => c.init.method === 'POST' && c.url.endsWith('/shipping_fulfillment'));
const unchangedStock = async (x: Fixture) =>
  assert.deepEqual(
    (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [x.p.id])).rows,
    [{ on_hand: 10, reserved: 0 }],
  );

test('eBay shipping: full workflow posts exact lineItemId/quantity/carrier/tracking/date once and preserves OMS stock/payments', async () => {
  const x = await fixture(),
    p = await plan(x);
  assert.equal((await queue(p, false)).statusCode, 422);
  assert.equal((await queue(p)).statusCode, 200);
  const done = await execute(p);
  assert.equal(done.state, 'done');
  assert.equal(done.phase, 'done');
  assert.equal(writes().length, 1);
  assert.equal(done.remote_id, x.shipment.tracking_number);
  assert.deepEqual(p.payload.lineItems, [{ lineItemId: '6001001', quantity: 2 }]);
  assert.equal(p.payload.trackingNumber, x.shipment.tracking_number);
  assert.equal(p.payload.shippedDate, new Date(x.shipment.dispatched_at).toISOString());
  await unchangedStock(x);
  assert.deepEqual(
    (await pool.query('SELECT amount FROM payment_entries WHERE order_id=$1', [x.o.id])).rows,
    [{ amount: 10001 }],
  );
  assert.equal((await ok(`/orders/${x.o.id}`)).status, 'shipped');
  await execute(p);
  assert.equal(writes().length, 1);
  const again = await plan(x);
  assert(again.remote.existing);
  assert.equal((await queue(again)).statusCode, 200);
  assert.equal((await execute(again)).result.unchanged, true);
  assert.equal(writes().length, 1);
});
test('eBay shipping: local simulation uses DEMO parcel and creates no provider HTTP', async () => {
  const x = await fixture(true),
    n = f.calls.length,
    p = await plan(x);
  assert.equal((await queue(p, false)).statusCode, 200);
  assert.equal((await execute(p)).state, 'done');
  assert.equal(f.calls.length, n);
  await unchangedStock(x);
});
test('eBay shipping: packing, DEMO/live environment and invalid tracking block transmission', async () => {
  const unshipped = await fixture(false, false);
  assert.equal((await preview(unshipped)).statusCode, 409);
  for (const change of [
    "mode='demo'",
    "mode='live'",
    "tracking_number='003-abc'",
    "dispatched_at=now()+interval '1 hour'",
    'dispatched_at=NULL',
  ]) {
    const x = await fixture();
    await rewriteShipmentFixture(`UPDATE shipments SET ${change} WHERE order_id=$1`, [x.o.id]);
    assert([409, 422].includes((await preview(x)).statusCode));
  }
  assert.equal(writes().length, 0);
});
test('eBay shipping: no broad scope without explicit configuration, creation validation and OAuth scope replacement', async () => {
  assert.equal(
    ebayReadScopes({ fulfillment_write: true, inventory_access: 'orders_inventory' }),
    EBAY_FULFILLMENT_WRITE_SCOPE + ' ' + EBAY_INVENTORY_SCOPE,
  );
  assert.equal(ebayReadScopes({}), EBAY_READ_SCOPE);
  const x = await fixture();
  await pool.query(
    "UPDATE channels SET settings=jsonb_set(settings,'{fulfillment_write}','false') WHERE id=$1",
    [x.ch],
  );
  assert.equal((await preview(x)).statusCode, 403);
  await pool.query(
    "UPDATE channels SET settings=jsonb_set(settings,'{fulfillment_write}','true'),oauth_scopes=$2 WHERE id=$1",
    [x.ch, EBAY_READ_SCOPE],
  );
  assert.equal((await preview(x)).statusCode, 403);
  assert.equal(writes().length, 0);
});
test('eBay shipping: tenant/viewer fences cover read, preview, queue, cancel and reconcile; RLS isolates both tables', async () => {
  const x = await fixture(),
    p = await plan(x);
  for (const auth of [viewer, other]) {
    const expected = auth === viewer ? 403 : 404;
    assert.equal(
      (await req(`/orders/${x.o.id}/ebay-fulfillment`, 'GET', undefined, auth)).statusCode,
      expected,
    );
    assert.equal((await preview(x, auth)).statusCode, expected);
    for (const endpoint of ['queue', 'cancel', 'reconcile'])
      assert.equal(
        (await req(`/ebay-fulfillment-plans/${p.id}/${endpoint}`, 'POST', {}, auth)).statusCode,
        expected,
      );
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [randomUUID()]);
    for (const t of ['ebay_fulfillment_plans', 'ebay_fulfillment_simulations'])
      assert.equal((await c.query(`SELECT * FROM ${t}`)).rowCount, 0);
    await c.query('ROLLBACK');
  } finally {
    c.release();
  }
});
test('eBay shipping: changed tracking, order or connection invalidates preview before queue', async () => {
  for (const kind of ['tracking', 'order', 'connection']) {
    const x = await fixture(),
      p = await plan(x);
    if (kind === 'tracking')
      await rewriteShipmentFixture("UPDATE shipments SET tracking_number='OTHER003' WHERE order_id=$1", [
        x.o.id,
      ]);
    else if (kind === 'order')
      await pool.query('UPDATE orders SET version=version+1 WHERE id=$1', [x.o.id]);
    else
      await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
        x.ch,
        encrypt({ ...ebaySecrets, client_secret: 'CHANGED' }),
      ]);
    assert.equal((await queue(p)).statusCode, 409);
  }
  assert.equal(writes().length, 0);
});
test('eBay shipping: expired preview and concurrent competing plans cannot create extra jobs', async () => {
  const x = await fixture(),
    old = await plan(x);
  await pool.query(
    "UPDATE ebay_fulfillment_plans SET created_at=now()-interval '31 minutes' WHERE id=$1",
    [old.id],
  );
  assert.equal((await queue(old)).statusCode, 409);
  const a = await plan(x),
    b = await plan(x),
    r = await Promise.all([queue(a), queue(b)]);
  assert.deepEqual(r.map((v) => v.statusCode).sort(), [200, 409]);
  assert.equal((await queue(r[0].statusCode === 200 ? a : b)).statusCode, 200);
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM jobs WHERE kind='ebay.fulfillment' AND payload->>'channel_id'=$1",
        [x.ch],
      )
    ).rowCount,
    1,
  );
});
test('eBay shipping: pending OAuth blocks preview/queue, queued fulfillment blocks reconnection', async () => {
  const x = await fixture(),
    p = await plan(x);
  await ok(`/integrations/${x.ch}/ebay-account/verify`, 'POST', {});
  let r = await ok(`/integrations/${x.ch}/oauth/start`, 'POST', {
    confirm_same_account: true,
    fulfillment_write: true,
  });
  assert.equal((await preview(x)).statusCode, 409);
  assert.equal((await queue(p)).statusCode, 409);
  await ok('/oauth/ebay/finish', 'POST', {
    state: new URL(r.url).searchParams.get('state'),
    error: 'access_denied',
  });
  assert.equal((await queue(p)).statusCode, 200);
  assert.equal(
    (await req(`/integrations/${x.ch}/oauth/start`, 'POST', { confirm_same_account: true }))
      .statusCode,
    409,
  );
});
test('eBay shipping: remote cancel, refund, unpaid, changed address or line IDs prevent POST', async () => {
  for (const kind of ['cancel', 'refund', 'unpaid', 'address', 'line']) {
    f = ebayFulfillmentFixture();
    const x = await fixture(),
      p = await plan(x);
    assert.equal((await queue(p)).statusCode, 200);
    if (kind === 'cancel') f.order.cancelStatus.cancelState = 'CANCEL_REQUESTED';
    else if (kind === 'refund')
      (f.order.paymentSummary.refunds as any[]).push({
        amount: { value: '1.00', currency: 'PLN' },
      });
    else if (kind === 'unpaid') f.order.orderPaymentStatus = 'PENDING';
    else if (kind === 'address')
      f.order.fulfillmentStartInstructions[0].shippingStep.shipTo.contactAddress.addressLine1 =
        'Changed';
    else f.order.lineItems[0].lineItemId = 'OTHER';
    const end = await execute(p);
    assert.equal(end.state, 'conflict');
    assert.equal(end.phase, 'ready');
    assert.equal(writes().length, 0);
  }
});
test('eBay shipping: other fulfillment, wrong quantities/carrier/date or duplicate tracking is a conflict', async () => {
  for (const kind of ['quantity', 'carrier', 'date', 'duplicate']) {
    f = ebayFulfillmentFixture();
    const x = await fixture(),
      p = await plan(x);
    const v = {
      fulfillmentId: 'EXISTING',
      lineItems: p.payload.lineItems,
      shippingCarrierCode: p.payload.shippingCarrierCode,
      shipmentTrackingNumber: p.payload.trackingNumber,
      shippedDate: p.payload.shippedDate,
    };
    if (kind === 'quantity') v.lineItems = [{ lineItemId: '6001001', quantity: 1 }];
    if (kind === 'carrier') v.shippingCarrierCode = 'USPS';
    if (kind === 'date') v.shippedDate = '2025-01-01T00:00:00.000Z';
    f.fulfillments.push(v);
    if (kind === 'duplicate') f.fulfillments.push({ ...v, fulfillmentId: 'OTHER' });
    assert.equal((await preview(x)).statusCode, 409);
    assert.equal(writes().length, 0);
  }
});
test('eBay shipping: missing, oversized, duplicate or incomplete collection is rejected', async () => {
  for (const v of [
    { total: 1, fulfillments: [] },
    { total: 501, fulfillments: [] },
    { total: 0, next: 'evil' },
    {},
    null,
    [],
  ])
    assert.throws(() => fulfillmentCollection(v));
  const x = await fixture();
  f.state.collectionEdit = (v) => (v.total = 1);
  assert.equal((await preview(x)).statusCode, 502);
  assert.equal(writes().length, 0);
});
test('eBay shipping: cancellation before worker fences ready POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  await ok(`/ebay-fulfillment-plans/${p.id}/cancel`, 'POST');
  assert.equal((await execute(p)).state, 'cancelled');
  assert.equal(writes().length, 0);
});
test('eBay shipping: revoked role or changed tracking during final GET blocks POST', async () => {
  for (const kind of ['role', 'tracking']) {
    const x = await fixture(),
      p = await plan(x);
    await queue(p);
    let changed = false;
    f.state.hook = async (u) => {
      if (u.pathname.endsWith('/shipping_fulfillment') && !changed) {
        changed = true;
        if (kind === 'role')
          await pool.query(
            "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
            [DEMO_TENANT, user],
          );
        else
          await rewriteShipmentFixture("UPDATE shipments SET tracking_number='OTHER003' WHERE order_id=$1", [
            x.o.id,
          ]);
      }
    };
    const end = await execute(p);
    assert.equal(end.state, 'conflict');
    assert.equal(writes().length, 0);
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  }
});
test('eBay shipping: lost response after accepted POST recovers by GET without second POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.lose = true;
  let end = await execute(p);
  assert.equal(end.phase, 'write_started');
  assert.equal(end.state, 'queued');
  assert.equal(writes().length, 1);
  end = await execute(p);
  assert.equal(end.state, 'done');
  assert.equal(writes().length, 1);
  await unchangedStock(x);
});
test('eBay shipping: 401/429/503 and malformed Location never repeat POST; later GET confirms applied result', async () => {
  for (const kind of [401, 429, 503, 'location']) {
    f = ebayFulfillmentFixture();
    const x = await fixture(),
      p = await plan(x);
    await queue(p);
    if (kind === 'location') f.state.badLocation = true;
    else f.state.post = Number(kind);
    let end = await execute(p);
    assert.equal(end.phase, 'write_started');
    assert.equal(writes().length, 1);
    end = await execute(p);
    assert.equal(end.state, 'done');
    assert.equal(writes().length, 1);
  }
});
test('eBay shipping: unapplied uncertain POST blocks new queue/cancel/OAuth until explicit reconciliation', async () => {
  const x = await fixture(),
    p = await plan(x),
    second = await plan(x);
  await queue(p);
  f.state.apply = false;
  f.state.lose = true;
  const end = await execute(p, true);
  assert.equal(end.state, 'failed');
  assert.equal(end.phase, 'write_started');
  assert.equal((await queue(second)).statusCode, 409);
  assert.equal((await req(`/ebay-fulfillment-plans/${p.id}/cancel`, 'POST')).statusCode, 409);
  assert.equal(
    (await req(`/integrations/${x.ch}/oauth/start`, 'POST', { confirm_same_account: true }))
      .statusCode,
    409,
  );
  assert.equal((await req(`/ebay-fulfillment-plans/${p.id}/reconcile`, 'POST')).statusCode, 409);
  assert.equal(
    (await ok(`/ebay-fulfillment-plans/${p.id}/reconcile`, 'POST', { acknowledge_mismatch: true }))
      .phase,
    'done',
  );
  assert.equal(writes().length, 1);
});
test('eBay shipping: accepted result after final retry failure can be reconciled read-only', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.lose = true;
  const failed = await execute(p, true);
  assert.equal(failed.state, 'failed');
  const r = await ok(`/ebay-fulfillment-plans/${p.id}/reconcile`, 'POST');
  assert.equal(r.state, 'done');
  assert.equal(writes().length, 1);
});
test('eBay shipping: lease loss during POST preserves uncertain phase; new worker verifies once', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  let changed = false;
  f.state.hook = async (u, i) => {
    if (i.method === 'POST' && u.pathname.endsWith('/shipping_fulfillment') && !changed) {
      changed = true;
      await pool.query(
        'UPDATE jobs SET lease_token=$2 WHERE id=(SELECT job_id FROM ebay_fulfillment_plans WHERE id=$1)',
        [p.id, randomUUID()],
      );
    }
  };
  const uncertain = await execute(p);
  assert.equal(uncertain.phase, 'write_started');
  f.state.hook = undefined;
  assert.equal((await execute(p)).state, 'done');
  assert.equal(writes().length, 1);
});
test('eBay shipping: verification detects wrong confirmed quantities and leaves plan uncertain', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.hook = async (u, i) => {
    if (i.method === 'POST' && u.pathname.endsWith('/shipping_fulfillment'))
      f.state.collectionEdit = (v) =>
        v.fulfillments.forEach((a: any) => (a.lineItems[0].quantity = 1));
  };
  const end = await execute(p, true);
  assert.equal(end.state, 'failed');
  assert.equal(end.phase, 'verify');
  assert.equal(writes().length, 1);
});
test('eBay shipping: simultaneous callbacks to a claimed job cannot duplicate POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  const j = await claim((await stored(p)).job_id);
  await Promise.all([processEbayFulfillment(j, ctx), processEbayFulfillment(j, ctx)]);
  assert.equal((await stored(p)).state, 'done');
  assert.equal(writes().length, 1);
});
test('eBay shipping: restored preview blocks all new mutations without provider HTTP', async () => {
  const x = await fixture(),
    p = await plan(x),
    n = f.calls.length,
    a = await buildApp({ readOnly: true, integrationTransport: ctx.transport });
  try {
    for (const path of [
      `/orders/${x.o.id}/ebay-fulfillment/preview`,
      ...['queue', 'cancel', 'reconcile'].map((v) => `/ebay-fulfillment-plans/${p.id}/${v}`),
    ])
      assert.equal(
        (await a.inject({ url: '/api' + path, method: 'POST', payload: {}, headers: { cookie } }))
          .statusCode,
        423,
      );
    assert.equal(f.calls.length, n);
  } finally {
    await a.close();
  }
});

test('eBay shipping: role revoked after POST leaves result uncertain and read-only reconciliation completes after restoration', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.hook = async (u, i) => {
    if (i.method === 'POST' && u.pathname.endsWith('/shipping_fulfillment'))
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]);
  };
  const end = await execute(p);
  assert.equal(end.state, 'failed');
  assert.equal(end.phase, 'verify');
  assert.equal(writes().length, 1);
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  f.state.hook = undefined;
  assert.equal((await ok(`/ebay-fulfillment-plans/${p.id}/reconcile`, 'POST')).state, 'done');
  assert.equal(writes().length, 1);
});
test('eBay shipping: verification addresses original eBay order after local mutation during POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.hook = async (u, i) => {
    if (i.method === 'POST' && u.pathname.endsWith('/shipping_fulfillment'))
      await pool.query(
        "UPDATE orders SET external_id='LOCAL-CHANGED',version=version+1 WHERE id=$1",
        [x.o.id],
      );
  };
  const end = await execute(p);
  assert.equal(end.state, 'done');
  assert.equal(end.result.stale_local, true);
  assert.equal(writes().length, 1);
  assert(
    f.calls
      .filter((c) => c.url.endsWith('/shipping_fulfillment'))
      .every((c) => c.url.includes('/' + f.order.orderId + '/')),
  );
});
test('eBay shipping: ready cancellation during GET prevents the subsequent POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  let cancelled = false;
  f.state.hook = async (u, i) => {
    if (!cancelled && i.method === 'GET' && u.pathname.endsWith('/shipping_fulfillment')) {
      cancelled = true;
      await ok(`/ebay-fulfillment-plans/${p.id}/cancel`, 'POST');
    }
  };
  assert.equal((await execute(p)).state, 'cancelled');
  assert.equal(writes().length, 0);
});
test('eBay shipping: changed connection during accepted POST blocks verification on another account', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.hook = async (u, i) => {
    if (i.method === 'POST' && u.pathname.endsWith('/shipping_fulfillment'))
      await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
        x.ch,
        encrypt({ ...ebaySecrets, refresh_token: 'OTHER-ACCOUNT' }),
      ]);
  };
  const end = await execute(p);
  assert.equal(end.state, 'failed');
  assert.equal(end.phase, 'verify');
  assert.equal(writes().length, 1);
  assert.equal((await req(`/ebay-fulfillment-plans/${p.id}/reconcile`, 'POST')).statusCode, 409);
});
test('eBay shipping: GET retries are fenced again and never turn into a write after role revocation', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.getError = 429;
  let called = false;
  f.state.hook = async (u, i) => {
    if (!called && i.method === 'GET' && u.pathname.endsWith('/shipping_fulfillment')) {
      called = true;
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]);
    }
  };
  assert.equal((await execute(p)).state, 'conflict');
  assert.equal(writes().length, 0);
});

const scheduleUrl = (x: Fixture) => `/integrations/${x.ch}/ebay-fulfillment`;
const configBody = (x: Fixture, version = 0, enabled = true) => ({
  version,
  enabled,
  confirm_external: true,
  shipped_since: new Date(Date.now() - 60000).toISOString(),
  carrier_mappings: [{ local_carrier: x.shipment.carrier, ebay_code: 'DPD' }],
});
async function config(x: Fixture) {
  await ok(`/integrations/${x.ch}/ebay-account/verify`, 'POST', {});
  return ok(scheduleUrl(x), 'PATCH', configBody(x));
}
async function scanJob(x: Fixture) {
  await pool.query('UPDATE ebay_fulfillment_configs SET next_run_at=now() WHERE channel_id=$1', [
    x.ch,
  ]);
  await scheduleEbayFulfillmentsDue();
  return (
    await pool.query(
      "SELECT * FROM jobs WHERE kind='ebay.fulfillment.scan' AND payload->>'channel_id'=$1 ORDER BY created_at DESC LIMIT 1",
      [x.ch],
    )
  ).rows[0];
}
async function scan(x: Fixture) {
  const j = await claim((await scanJob(x)).id);
  try {
    await processEbayFulfillmentScan(j, ctx);
  } catch (e) {
    await failEbayFulfillmentScan(j, e);
  }
  return (await pool.query('SELECT * FROM jobs WHERE id=$1', [j.id])).rows[0];
}
async function autoPlans(x: Fixture) {
  return (
    await pool.query(
      'SELECT * FROM ebay_fulfillment_plans WHERE channel_id=$1 AND config_version IS NOT NULL ORDER BY created_at',
      [x.ch],
    )
  ).rows;
}

test('eBay automatic shipping: verified account, mappings, explicit grant, strict inputs, role, tenant and config version', async () => {
  const x = await fixture();
  assert.equal((await req(scheduleUrl(x), 'PATCH', configBody(x))).statusCode, 409);
  await ok(`/integrations/${x.ch}/ebay-account/verify`, 'POST', {});
  assert.equal(
    (await req(scheduleUrl(x), 'PATCH', { ...configBody(x), confirm_external: false })).statusCode,
    422,
  );
  for (const b of [
    { ...configBody(x), carrier_mappings: [] },
    { ...configBody(x), carrier_mappings: [{ local_carrier: 'X', ebay_code: 'wrong-code' }] },
    {
      ...configBody(x),
      carrier_mappings: [
        { local_carrier: 'X', ebay_code: 'DPD' },
        { local_carrier: 'X', ebay_code: 'UPS' },
      ],
    },
    { ...configBody(x), unexpected: true },
  ])
    assert.equal((await req(scheduleUrl(x), 'PATCH', b)).statusCode, 422);
  assert.equal((await req(scheduleUrl(x), 'PATCH', configBody(x), viewer)).statusCode, 403);
  assert.equal((await req(scheduleUrl(x), 'PATCH', configBody(x), other)).statusCode, 404);
  assert.equal((await req(scheduleUrl(x), 'GET', undefined, other)).statusCode, 404);
  const cfg = await ok(scheduleUrl(x), 'PATCH', configBody(x));
  assert.equal(cfg.version, 1);
  assert(cfg.external_authorized);
  assert.equal((await req(scheduleUrl(x), 'PATCH', configBody(x))).statusCode, 409);
  const r = await scan(x);
  assert.equal(r.state, 'done');
  assert.deepEqual(r.payload.stats, { checked: 1, queued: 1, skipped: 0, errors: 0 });
  const p = (await autoPlans(x))[0];
  assert.equal(p.config_version, 1);
  assert.equal((await execute(p)).state, 'done');
  assert.equal(writes().length, 1);
  await unchangedStock(x);
  const again = await scan(x);
  assert.equal(again.payload.stats.checked, 0);
  assert.equal(writes().length, 1);
});

test('eBay automatic shipping: simulation never requests provider; done shipment stays skipped across new config', async () => {
  const x = await fixture(true);
  await config(x);
  f.calls.length = 0;
  assert.equal((await scan(x)).payload.stats.queued, 1);
  const p = (await autoPlans(x))[0];
  assert.equal((await execute(p)).state, 'done');
  assert.equal(f.calls.length, 0);
  await ok(scheduleUrl(x), 'PATCH', configBody(x, 1));
  const j = await scan(x);
  assert.equal(j.payload.stats.skipped, 1);
  assert.equal((await autoPlans(x)).length, 1);
  assert.equal(f.calls.length, 0);
});

test('eBay automatic shipping: unmapped carrier is durable conflict once; mapping correction enables safe new attempt', async () => {
  const x = await fixture(true);
  await ok(`/integrations/${x.ch}/ebay-account/verify`, 'POST', {});
  await ok(scheduleUrl(x), 'PATCH', {
    ...configBody(x),
    carrier_mappings: [{ local_carrier: 'Different carrier', ebay_code: 'DPD' }],
  });
  assert.equal((await scan(x)).payload.stats.errors, 1);
  assert.equal((await scan(x)).payload.stats.checked, 0);
  const r = (await ok(scheduleUrl(x))).receipts;
  assert.equal(r.length, 1);
  assert.equal(r[0].state, 'conflict');
  assert.match(r[0].error, /mapowania/);
  await ok(scheduleUrl(x), 'PATCH', configBody(x, 1));
  assert.equal((await scan(x)).payload.stats.queued, 1);
  assert.equal((await execute((await autoPlans(x))[0])).state, 'done');
});

test('eBay automatic shipping: pause cancels ready automatic plans but leaves manual plan independent', async () => {
  const x = await fixture(true);
  await config(x);
  await scan(x);
  const p = (await autoPlans(x))[0];
  await ok(scheduleUrl(x), 'PATCH', configBody(x, 1, false));
  assert.equal((await stored(p)).state, 'conflict');
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [p.job_id])).rows[0].state,
    'failed',
  );
  const manual = await plan(x);
  await queue(manual);
  assert.equal((await execute(manual)).state, 'done');
});

test('eBay automatic shipping: pause after POST retains GET-only verification and no repeat mutation', async () => {
  const x = await fixture();
  await config(x);
  await scan(x);
  const p = (await autoPlans(x))[0];
  let changed = false;
  f.state.hook = async (u, i) => {
    if (!changed && i.method === 'POST' && u.pathname.endsWith('/shipping_fulfillment')) {
      changed = true;
      await ok(scheduleUrl(x), 'PATCH', configBody(x, 1, false));
    }
  };
  assert.equal((await execute(p)).state, 'done');
  assert.equal(writes().length, 1);
  assert.equal((await ok(scheduleUrl(x))).config.enabled, false);
});

test('eBay automatic shipping: uncertain result blocks future versions; reconcile uses only GET', async () => {
  const x = await fixture();
  await config(x);
  await scan(x);
  const p = (await autoPlans(x))[0];
  f.state.lose = true;
  f.state.hook = async (u, i) => {
    if (i.method === 'POST' && u.pathname.endsWith('/shipping_fulfillment')) f.state.getError = 503;
  };
  const failed = await execute(p, true);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.phase, 'write_started');
  await ok(scheduleUrl(x), 'PATCH', configBody(x, 1));
  assert.equal((await scan(x)).payload.stats.skipped, 1);
  assert.equal(writes().length, 1);
  f.state.getError = 0;
  assert.equal((await ok(`/ebay-fulfillment-plans/${p.id}/reconcile`, 'POST', {})).state, 'done');
  assert.equal(writes().length, 1);
});

test('eBay automatic shipping: role or credentials changed during preview prevent queue; scan disables stale grant', async () => {
  for (const role of [true, false]) {
    const x = await fixture();
    await config(x);
    let changed = false;
    f.state.hook = async (u) => {
      if (!changed && u.pathname.endsWith('/shipping_fulfillment')) {
        changed = true;
        if (role)
          await pool.query(
            "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
            [DEMO_TENANT, user],
          );
        else
          await pool.query(
            'UPDATE channels SET settings=settings||\'{"marketplace":"EBAY_GB"}\'::jsonb WHERE id=$1',
            [x.ch],
          );
      }
    };
    const j = await scan(x);
    assert.equal(j.state, 'failed');
    assert.equal((await autoPlans(x)).length, 0);
    assert.equal(writes().length, 0);
    assert.equal(
      (await pool.query('SELECT enabled FROM ebay_fulfillment_configs WHERE channel_id=$1', [x.ch]))
        .rows[0].enabled,
      false,
    );
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
    f.state.hook = undefined;
  }
});

test('eBay automatic shipping: expired lease cannot queue or record receipts', async () => {
  const x = await fixture();
  await config(x);
  const j = await claim((await scanJob(x)).id);
  let changed = false;
  f.state.hook = async (u) => {
    if (!changed && u.pathname.endsWith('/shipping_fulfillment')) {
      changed = true;
      await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [j.id, randomUUID()]);
    }
  };
  await assert.rejects(() => processEbayFulfillmentScan(j, ctx), /dzierżawa/);
  await failEbayFulfillmentScan(j, Error('old lease'));
  assert.equal((await autoPlans(x)).length, 0);
  assert.equal((await ok(scheduleUrl(x))).receipts.length, 0);
  assert.equal(writes().length, 0);
});

test('eBay automatic shipping: overlapping schedulers produce one scan and OAuth pauses automation', async () => {
  const x = await fixture();
  await config(x);
  await Promise.all([scheduleEbayFulfillmentsDue(), scheduleEbayFulfillmentsDue()]);
  const jobs = (
    await pool.query(
      "SELECT id FROM jobs WHERE kind='ebay.fulfillment.scan' AND payload->>'channel_id'=$1 AND state IN ('pending','running')",
      [x.ch],
    )
  ).rows;
  assert.equal(jobs.length, 1);
  assert.equal(
    (await req(`/integrations/${x.ch}/oauth/start`, 'POST', { confirm_same_account: true }))
      .statusCode,
    409,
  );
  await pool.query("UPDATE jobs SET state='done' WHERE id=$1", [jobs[0].id]);
  assert.equal(
    (await req(`/integrations/${x.ch}/oauth/start`, 'POST', { confirm_same_account: true }))
      .statusCode,
    200,
  );
  const cfg = (await ok(scheduleUrl(x))).config;
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.external_authorized, false);
  assert.equal(cfg.version, 2);
});

async function cloneShipped(x: Fixture) {
  const id = randomUUID(),
    shipment = randomUUID();
  await pool.query(
    'INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||$2::jsonb)).* FROM orders o WHERE id=$1',
    [
      x.o.id,
      JSON.stringify({
        id,
        external_id: 'PAGE-' + id,
        number: 'PAGE-' + id,
        portal_token: randomUUID(),
      }),
    ],
  );
  await rewriteShipmentFixture(
    'INSERT INTO shipments SELECT (jsonb_populate_record(NULL::shipments,to_jsonb(s)||$2::jsonb)).* FROM shipments s WHERE order_id=$1',
    [
      x.o.id,
      JSON.stringify({
        id: shipment,
        order_id: id,
        tracking_number: 'PAGE' + id.replaceAll('-', ''),
      }),
    ],
  );
  return { id, shipment };
}
test('eBay automatic shipping: 26 synthetic unmapped parcels persist progress across two batches with no replay', async () => {
  const x = await fixture(true);
  await ok(`/integrations/${x.ch}/ebay-account/verify`, 'POST', {});
  for (let i = 0; i < 25; i++) await cloneShipped(x);
  await ok(scheduleUrl(x), 'PATCH', {
    ...configBody(x),
    carrier_mappings: [{ local_carrier: 'Unmapped', ebay_code: 'DPD' }],
  });
  const job = await scanJob(x),
    start = performance.now();
  await processEbayFulfillmentScan(await claim(job.id), ctx);
  let storedJob = (await pool.query('SELECT * FROM jobs WHERE id=$1', [job.id])).rows[0];
  assert.equal(storedJob.state, 'pending');
  assert.equal(storedJob.payload.stats.checked, 25);
  assert(storedJob.payload.after);
  await processEbayFulfillmentScan(await claim(job.id), ctx);
  storedJob = (await pool.query('SELECT * FROM jobs WHERE id=$1', [job.id])).rows[0];
  assert.equal(storedJob.state, 'done');
  assert.equal(storedJob.payload.stats.checked, 26);
  assert.equal(storedJob.payload.stats.errors, 26);
  assert.equal((await ok(scheduleUrl(x))).receipts.length, 26);
  assert.equal((await scan(x)).payload.stats.checked, 0);
  assert.equal((await autoPlans(x)).length, 0);
  console.log(
    'Synthetic pagination 26 parcels / 2 batches: ' + Math.round(performance.now() - start) + 'ms',
  );
});
test('eBay automatic shipping: queue capacity pauses scan before any read and preserves cursor', async () => {
  const x = await fixture(true);
  await config(x);
  const template = await plan(x);
  for (let i = 0; i < 100; i++) {
    const o = await cloneShipped(x);
    await pool.query(
      'INSERT INTO ebay_fulfillment_plans SELECT (jsonb_populate_record(NULL::ebay_fulfillment_plans,to_jsonb(p)||$2::jsonb)).* FROM ebay_fulfillment_plans p WHERE id=$1',
      [
        template.id,
        JSON.stringify({
          id: randomUUID(),
          order_id: o.id,
          shipment_id: o.shipment,
          state: 'queued',
          job_id: null,
        }),
      ],
    );
  }
  const j = await scan(x);
  assert.equal(j.state, 'pending');
  assert.equal(j.payload.after, null);
  assert.equal(j.payload.stats.checked, 0);
  assert.equal((await ok(scheduleUrl(x))).receipts.length, 0);
});
test('eBay automatic shipping: RLS isolation and cross-tenant receipt FK; preview restores read-only scheduling', async () => {
  const x = await fixture(true);
  await config(x);
  await scan(x);
  await tenantTx(SECOND_TENANT, async (c) => {
    for (const t of ['ebay_fulfillment_configs', 'ebay_fulfillment_receipts'])
      assert.equal(
        (await c.query(`SELECT 1 FROM ${t} WHERE tenant_id<>$1`, [SECOND_TENANT])).rowCount,
        0,
      );
  });
  await assert.rejects(
    () =>
      pool.query(
        "INSERT INTO ebay_fulfillment_receipts(tenant_id,channel_id,config_version,order_id,shipment_id,state) VALUES($1,$2,99,$3,$4,'skipped')",
        [SECOND_TENANT, x.ch, x.o.id, x.shipment.id],
      ),
    /foreign key/,
  );
  const previewApp = await buildApp({ integrationTransport: ctx.transport, readOnly: true });
  try {
    const l = await previewApp.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
      }),
      pc = l.headers['set-cookie']!.toString().split(';')[0];
    assert.equal(
      (await previewApp.inject({ url: '/api' + scheduleUrl(x), headers: { cookie: pc } }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await previewApp.inject({
          method: 'PATCH',
          url: '/api' + scheduleUrl(x),
          headers: { cookie: pc },
          payload: configBody(x, 1),
        })
      ).statusCode,
      423,
    );
  } finally {
    await previewApp.close();
  }
});

test('eBay automatic shipping: dispatched date bounds and local stage exclude future, old and unshipped orders', async () => {
  const x = await fixture(true);
  await config(x);
  await rewriteShipmentFixture("UPDATE shipments SET dispatched_at=now()+interval '1 day' WHERE order_id=$1", [
    x.o.id,
  ]);
  assert.equal((await scan(x)).payload.stats.checked, 0);
  await rewriteShipmentFixture("UPDATE shipments SET dispatched_at=now()-interval '2 days' WHERE order_id=$1", [
    x.o.id,
  ]);
  assert.equal((await scan(x)).payload.stats.checked, 0);
  await rewriteShipmentFixture('UPDATE shipments SET dispatched_at=now() WHERE order_id=$1', [x.o.id]);
  // Packing-field guards (189) resolve the order in the declared tenant scope.
  await tenantScopedOwnerQuery(DEMO_TENANT, "UPDATE orders SET status='packed' WHERE id=$1", [x.o.id]);
  assert.equal((await scan(x)).payload.stats.checked, 0);
  assert.equal((await autoPlans(x)).length, 0);
});

for (const simulation of [false, true])
  test(`API limit: fulfillment ${simulation ? 'simulation' : 'connector'} waits before POST and completes once after release`, async () => {
    const x = await fixture(simulation),
      p = await plan(x);
    assert.equal((await queue(p)).statusCode, 200);
    const appHash = simulation
      ? ebaySimulationApplication(DEMO_TENANT, 'sandbox')
      : ebayApplicationHash('sandbox', ebaySecrets.client_id);
    await pool.query(
      "INSERT INTO ebay_api_buckets(scope_hash,app_hash,family,cooldown_until) VALUES($1,$2,'fulfillment',now()+interval '1 hour') ON CONFLICT(scope_hash) DO UPDATE SET cooldown_until=excluded.cooldown_until",
      [ebayApiScope(appHash, 'fulfillment'), appHash],
    );
    const before = f.calls.length,
      waiting = await execute(p);
    assert.equal(waiting.state, 'queued');
    assert.equal(waiting.phase, 'ready');
    assert.equal(writes().length, 0);
    if (simulation) assert.equal(f.calls.length, before);
    const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [waiting.job_id])).rows[0];
    assert.equal(job.state, 'pending');
    assert.equal(job.attempts, 0);
    assert(job.provider_wait_until);
    await pool.query("UPDATE ebay_api_buckets SET cooldown_until='-infinity'");
    assert.equal((await execute(p)).state, 'done');
    assert.equal(writes().length, simulation ? 0 : 1);
  });

test('API limit: accepted fulfillment with provider 429 waits and resumes GET without second POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.post = 429;
  f.state.retryAfter = '3600';
  const uncertain = await execute(p);
  assert.equal(uncertain.phase, 'write_started');
  assert.equal(writes().length, 1);
  const waiting = await execute(p);
  assert.equal(waiting.state, 'queued');
  assert.equal(waiting.phase, 'write_started');
  assert.equal(writes().length, 1);
  const history = await ok(`/orders/${x.o.id}/ebay-fulfillment`);
  assert(history.data[0].provider_wait_until);
  await pool.query("UPDATE ebay_api_buckets SET cooldown_until='-infinity'");
  assert.equal((await execute(p)).state, 'done');
  assert.equal(writes().length, 1);
});

test('API limit: automatic fulfillment wait keeps the cursor and resumes without a conflict receipt', async () => {
  const x = await fixture();
  await config(x);
  const j = await claim((await scanJob(x)).id),
    appHash = ebayApplicationHash('sandbox', ebaySecrets.client_id);
  await pool.query(
    "INSERT INTO ebay_api_buckets(scope_hash,app_hash,family,cooldown_until) VALUES($1,$2,'fulfillment',now()+interval '1 hour') ON CONFLICT(scope_hash) DO UPDATE SET cooldown_until=excluded.cooldown_until",
    [ebayApiScope(appHash, 'fulfillment'), appHash],
  );
  try {
    await processEbayFulfillmentScan(j, ctx);
    assert.fail('expected API wait');
  } catch (e) {
    await failEbayFulfillmentScan(j, e);
  }
  const waiting = (await pool.query('SELECT * FROM jobs WHERE id=$1', [j.id])).rows[0];
  assert.equal(waiting.state, 'pending');
  assert.equal(waiting.attempts, 0);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM ebay_fulfillment_receipts WHERE channel_id=$1',
        [x.ch],
      )
    ).rows[0].n,
    0,
  );
  await pool.query("UPDATE ebay_api_buckets SET cooldown_until='-infinity'");
  await processEbayFulfillmentScan(await claim(j.id), ctx);
  assert.equal((await autoPlans(x)).length, 1);
});
