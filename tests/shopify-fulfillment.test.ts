import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteShipmentFixture } from './shipment-identity-fixture';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT } from './fixtures';
import { Shopify } from '../server/shopify';
import { shopifyFulfillmentBody } from '../server/shopify-fulfillment-api';
import {
  processShopifyFulfillment,
  failShopifyFulfillment,
  demoShopifyFulfillmentState,
} from '../server/shopify-fulfillment';
import { shopifyFulfillmentFixture } from './shopify-fulfillment-fixture';
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  other = '',
  viewer = '',
  user = '',
  f = shopifyFulfillmentFixture(),
  ip = 1;
const ctx = { transport: (u: string, i: RequestInit) => f.transport(u, i) };
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api' + url,
    method,
    payload,
    headers: { cookie: auth },
    remoteAddress: '127.0.3.' + ip,
  });
const ok = async (p: string, m: any = 'GET', b?: any, a = cookie) => {
  const r = await req(p, m, b, a);
  assert(r.statusCode < 300, r.body);
  return r.json();
};
before(async () => {
  assert.equal(process.env.DYNA_TEST, 'true');
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  const login = async (email: string) =>
    (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  user = (await ok('/auth/me')).user.id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  ip++;
  f = shopifyFulfillmentFixture();
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
});
afterEach(async () => {
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
});
async function fixture(
  simulation = false,
  shipped = true,
  auth = cookie,
  store = 'https://qa-' + randomUUID() + '.myshopify.com',
) {
  const wh = (await ok('/warehouses', 'GET', undefined, auth)).data[0].id,
    ch = (
      await ok(
        '/integrations',
        'POST',
        {
          provider: 'shopify',
          name: 'QA fulfillment',
          mode: 'sandbox',
          settings: { store_url: store },
          credentials: { access_token: 'qa-not-a-real-token-2026' },
        },
        auth,
      )
    ).id;
  const product = await ok(
    '/products',
    'POST',
    {
      sku: 'SF-' + randomUUID(),
      name: 'Shopify shipping QA',
      price: 1500,
      vat: 23,
      quantity: 10,
      warehouse_id: wh,
    },
    auth,
  );
  await ok(
    '/integrations/' + ch + '/mappings',
    'POST',
    { external_id: 'gid://shopify/ProductVariant/701', sku: product.sku },
    auth,
  );
  if (simulation)
    await pool.query(
      'UPDATE channels SET settings=settings||\'{"simulation":true}\'::jsonb WHERE id=$1',
      [ch],
    );
  const staged = await ok(
      '/integrations/' + ch + '/stage-orders',
      'POST',
      { data: [f.state.raw] },
      auth,
    ),
    inbound = staged.data[0],
    o = await ok(
      '/imports/' + inbound.id + '/commit',
      'POST',
      { warehouse_id: wh, expected_hash: inbound.source_hash },
      auth,
    );
  if (shipped) {
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, auth), '/orders/' + o.id + '/status', { status: 'picking' }), auth);
    for (let i = 0; i < 2; i++)
      await ok('/orders/' + o.id + '/scan', 'POST', { code: product.sku }, auth);
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, auth), '/orders/' + o.id + '/status', { status: 'packed' }), auth);
    await ok('/orders/' + o.id + '/ship-demo', 'POST', {}, auth);
  }
  if (!simulation && shipped)
    await rewriteShipmentFixture("UPDATE shipments SET mode='sandbox',tracking_number=$2 WHERE order_id=$1", [
      o.id,
      'QA' + randomUUID().replaceAll('-', ''),
    ]);
  return { ch, product, o, store };
}
type F = Awaited<ReturnType<typeof fixture>>;
const preview = (x: F, b: any = { company: 'DPD' }, a = cookie) =>
  req('/orders/' + x.o.id + '/shopify-fulfillment/preview', 'POST', b, a);
const plan = async (x: F, b: any = { company: 'DPD' }) => {
  const r = await preview(x, b);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const queue = (p: any, confirm_external = true, a = cookie) =>
  req('/shopify-fulfillment-plans/' + p.id + '/queue', 'POST', { confirm_external }, a);
const stored = async (p: any) =>
  (await pool.query('SELECT * FROM shopify_fulfillment_plans WHERE id=$1', [p.id])).rows[0];
const writes = () => f.calls.filter((c) => c.query.includes('mutation DynaFulfillmentCreate'));
async function execute(p: any, last = false) {
  const s = await stored(p);
  if (last) await pool.query('UPDATE jobs SET attempts=max_attempts-1 WHERE id=$1', [s.job_id]);
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [s.job_id, randomUUID()],
    )
  ).rows[0];
  try {
    await processShopifyFulfillment(j, ctx);
  } catch (e) {
    await failShopifyFulfillment(j, e);
  }
  return stored(p);
}
const snapshot = async (x: F) => ({
  order: (await pool.query('SELECT * FROM orders WHERE id=$1', [x.o.id])).rows[0],
  stock: (
    await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [x.product.id])
  ).rows,
  payments: (
    await pool.query('SELECT * FROM payment_entries WHERE order_id=$1 ORDER BY id', [x.o.id])
  ).rows,
});

test('Shopify: exact FulfillmentInput, explicit FO line quantities, no notification, GET proof and replay preserve OMS', async () => {
  const x = await fixture(),
    before = await snapshot(x),
    p = await plan(x);
  assert.equal(p.payload.location_id, 'gid://shopify/Location/1');
  assert.equal(p.payload.fulfillment.notifyCustomer, false);
  assert.equal((await queue(p)).statusCode, 200);
  const result = await execute(p);
  assert.equal(result.state, 'done', result.error);
  assert.equal(result.phase, 'done');
  assert.equal(result.remote_id, 'gid://shopify/Fulfillment/88001');
  assert.equal(writes().length, 1);
  assert.deepEqual(writes()[0].variables, {
    fulfillment: {
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/98001',
          fulfillmentOrderLineItems: [
            { id: 'gid://shopify/FulfillmentOrderLineItem/980010', quantity: 2 },
          ],
        },
      ],
      notifyCustomer: false,
      trackingInfo: { company: 'DPD', number: p.payload.fulfillment.trackingInfo.number },
    },
  });
  assert.equal((await queue(p)).statusCode, 200);
  await execute(p);
  assert.equal(writes().length, 1);
  assert.deepEqual(await snapshot(x), before);
});
test('Shopify: local simulation performs zero provider calls', async () => {
  const x = await fixture(true),
    p = await plan(x, { company: 'DPD', notify_customer: true });
  await queue(p);
  assert.equal((await execute(p)).state, 'done');
  assert.equal(f.calls.length, 0);
  assert.equal(
    (
      await pool.query(
        'SELECT fulfillments FROM shopify_fulfillment_simulations WHERE order_id=$1',
        [x.o.id],
      )
    ).rows[0].fulfillments.length,
    1,
  );
});
test('Shopify: packing is insufficient; DEMO never goes to a real store', async () => {
  const x = await fixture(false, false);
  const beforeFirst = f.calls.length;
  assert.equal((await preview(x)).statusCode, 409);
  assert.equal(f.calls.length, beforeFirst);
  const y = await fixture();
  const beforeSecond = f.calls.length;
  await rewriteShipmentFixture("UPDATE shipments SET mode='demo' WHERE order_id=$1", [y.o.id]);
  assert.equal((await preview(y)).statusCode, 422);
  assert.equal(f.calls.length, beforeSecond);
});
test('Shopify: external confirmation required, read-only roles and other tenant denied', async () => {
  const x = await fixture();
  assert.equal((await preview(x, undefined, viewer)).statusCode, 403);
  assert.equal((await preview(x, undefined, other)).statusCode, 404);
  const p = await plan(x);
  assert.equal((await queue(p, false)).statusCode, 422);
  assert.equal((await queue(p, true, viewer)).statusCode, 403);
  assert.equal((await queue(p, true, other)).statusCode, 404);
  assert.equal(
    (await req('/orders/' + x.o.id + '/shopify-fulfillment', 'GET', undefined, '')).statusCode,
    401,
  );
  assert.equal(writes().length, 0);
});
test('Shopify: lost accepted response retries GET only and confirms original fulfillment', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.lose = true;
  let r = await execute(p);
  assert.equal(r.phase, 'write_started');
  assert.equal(r.state, 'queued');
  f.state.lose = false;
  r = await execute(p);
  assert.equal(r.state, 'done', r.error);
  assert.equal(writes().length, 1);
});
test('Shopify: rejected or unknown mutation is never resent and can be reconciled manually', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.apply = false;
  f.state.post = 500;
  let r = await execute(p, true);
  assert.equal(r.state, 'failed');
  assert.equal(r.phase, 'write_started');
  assert.equal(writes().length, 1);
  const r1 = await req('/shopify-fulfillment-plans/' + p.id + '/reconcile', 'POST');
  assert.equal(r1.statusCode, 409);
  const r2 = await ok('/shopify-fulfillment-plans/' + p.id + '/reconcile', 'POST', {
    acknowledge_mismatch: true,
  });
  assert.equal(r2.state, 'conflict');
  assert.equal(r2.phase, 'done');
  assert.equal(r2.result.matched, false);
  assert.equal(writes().length, 1);
  const next = await plan(x);
  assert.equal((await queue(next)).statusCode, 409);
});
test('Shopify: existing exact full shipment is adopted by GET without creating another', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  await execute(p);
  const f1 = f.state.fulfillments[0];
  const x2 = await fixture(false, true, cookie, x.store);
  // Tracking is unique per tenant, carrier, mode and channel (shipments_tracking_identity), so
  // the remote fulfillment carries the second order's own local tracking instead of a duplicate.
  const tracking = (
    await pool.query('SELECT tracking_number FROM shipments WHERE order_id=$1', [x2.o.id])
  ).rows[0].tracking_number;
  f1.tracking[0] = { ...f1.tracking[0], number: tracking };
  const second = await plan(x2);
  assert.equal(second.remote.existing, f1.id);
  assert.equal((await queue(second)).statusCode, 409);
  assert.equal(writes().length, 1);
});
test('Shopify: concurrent plans and cross-tenant same-store order have one durable claim', async () => {
  const x = await fixture(),
    p1 = await plan(x),
    p2 = await plan(x);
  const result = await Promise.all([queue(p1), queue(p2)]);
  assert.deepEqual(result.map((r) => r.statusCode).sort(), [200, 409]);
  const x2 = await fixture(false, true, other, x.store),
    p = (await preview(x2, undefined, other)).json();
  assert.equal((await queue(p, true, other)).statusCode, 409);
});
test('Shopify: read and write grant omissions stop before mutation', async () => {
  const x = await fixture();
  f.state.scopes = ['read_orders'];
  assert.equal((await preview(x)).statusCode, 403);
  f.state.scopes = ['read_orders', 'read_merchant_managed_fulfillment_orders'];
  assert.equal((await preview(x)).statusCode, 403);
  assert.equal(writes().length, 0);
});
test('Shopify: a hold, closed order or external-service assignment cannot be fulfilled', async () => {
  const x = await fixture();
  for (const change of [
    (o: any) => (o.status = 'ON_HOLD'),
    (o: any) => (o.supportedActions = []),
    (o: any) => (o.requestStatus = 'ACCEPTED'),
  ]) {
    const state = demoShopifyFulfillmentState(f.state.raw);
    change(state.orders[0]);
    f.state.orders = state.orders;
    assert.equal((await preview(x)).statusCode, 409);
  }
  assert.equal(writes().length, 0);
});
test('Shopify: incomplete coverage, wrong variant and changed quantity rejected', async () => {
  const x = await fixture();
  for (const change of [
    (l: any) => (l.remainingQuantity = 1),
    (l: any) => (l.lineItem.variant.id = 'gid://shopify/ProductVariant/702'),
    (l: any) => (l.remainingQuantity = 3),
  ]) {
    const state = demoShopifyFulfillmentState(f.state.raw);
    change(state.orders[0].lineItems[0]);
    f.state.orders = state.orders;
    assert.equal((await preview(x)).statusCode, 409);
  }
  assert.equal(writes().length, 0);
});
test('Shopify: multiple FO allocations at one location map quantities once; different locations rejected', async () => {
  const x = await fixture(),
    v = demoShopifyFulfillmentState(f.state.raw);
  v.orders[0].lineItems[0].remainingQuantity = 1;
  v.orders[0].lineItems[0].totalQuantity = 1;
  const second = structuredClone(v.orders[0]);
  second.id = 'gid://shopify/FulfillmentOrder/98002';
  second.lineItems[0].id = 'gid://shopify/FulfillmentOrderLineItem/980020';
  f.state.orders = [v.orders[0], second];
  let p = await plan(x);
  assert.equal(p.payload.fulfillment.lineItemsByFulfillmentOrder.length, 2);
  await queue(p);
  assert.equal((await execute(p)).state, 'done');
  assert.equal(writes().length, 1);
  const y = await fixture();
  f.state.fulfillments = [];
  second.assignedLocation.location.id = 'gid://shopify/Location/2';
  assert.equal((await preview(y)).statusCode, 409);
});
test('Shopify: address and money changes stop a ready plan before POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.raw.shippingAddress.address1 = 'Inny adres';
  const r = await execute(p);
  assert.equal(r.state, 'conflict');
  assert.equal(r.phase, 'ready');
  assert.equal(writes().length, 0);
});
test('Shopify: allocation version change after preview stops write', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  const v = demoShopifyFulfillmentState(f.state.raw);
  v.orders[0].updatedAt = '2026-10-05T01:00:00.000Z';
  f.state.orders = v.orders;
  const r = await execute(p);
  assert.equal(r.state, 'conflict');
  assert.equal(writes().length, 0);
});
test('Shopify: local order edit, token replacement and current role are fenced', async () => {
  for (const kind of ['local', 'token', 'role']) {
    const x = await fixture(),
      p = await plan(x);
    await queue(p);
    if (kind === 'local')
      await pool.query('UPDATE orders SET version=version+1 WHERE id=$1', [x.o.id]);
    if (kind === 'token') {
      const { encrypt } = await import('../server/security');
      await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
        x.ch,
        encrypt({ access_token: 'changed-provider-token-2026' }),
      ]);
    }
    if (kind === 'role')
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]);
    assert(['conflict', 'failed'].includes((await execute(p)).state));
    assert.equal(writes().length, 0);
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  }
});
test('Shopify: mutation after preflight source read is rejected by final local fence', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.mutate = async () => {
    await pool.query('UPDATE orders SET version=version+1 WHERE id=$1', [x.o.id]);
  };
  assert.equal((await execute(p)).state, 'conflict');
  assert.equal(writes().length, 0);
});
test('Shopify: worker lease revoked during source read prevents POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.mutate = async () => {
    await pool.query("UPDATE jobs SET lease_token=NULL,state='failed' WHERE id=$1", [
      (await stored(p)).job_id,
    ]);
  };
  await execute(p);
  assert.equal(writes().length, 0);
});
test('Shopify: cancellation and source change leave an unused claim available', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  assert.equal(
    (await ok('/shopify-fulfillment-plans/' + p.id + '/cancel', 'POST')).state,
    'cancelled',
  );
  const next = await plan(x);
  assert.equal((await queue(next)).statusCode, 200);
  assert.equal((await execute(next)).state, 'done');
  assert.equal(
    (await req('/shopify-fulfillment-plans/' + next.id + '/cancel', 'POST')).statusCode,
    409,
  );
});
test('Shopify: uncertain result matches original order even after local status/version edit', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.lose = true;
  await execute(p, true);
  await pool.query("UPDATE orders SET version=version+1,status='completed' WHERE id=$1", [x.o.id]);
  const r = await ok('/shopify-fulfillment-plans/' + p.id + '/reconcile', 'POST');
  assert.equal(r.state, 'done');
  assert(r.result.stale_local);
  assert.equal(writes().length, 1);
});
test('Shopify: wrong number, quantity or duplicate matching shipments cannot falsely complete', async () => {
  for (const edit of [
    (v: any) => (v.lines[0].quantity = 1),
    (v: any) => (v.tracking[0].company = 'Other'),
    (v: any) => (v.location_id = 'gid://shopify/Location/2'),
  ]) {
    const x = await fixture(),
      p = await plan(x);
    await queue(p);
    f.state.lose = true;
    await execute(p, true);
    edit(f.state.fulfillments[0]);
    assert.equal(
      (await req('/shopify-fulfillment-plans/' + p.id + '/reconcile', 'POST')).statusCode,
      409,
    );
    f.state.fulfillments = [];
    f.state.lose = false;
  }
  assert.equal(writes().length, 3);
});
test('Shopify: FO and line pagination are complete, no partial-page fulfillment', async () => {
  const x = await fixture(),
    v = demoShopifyFulfillmentState(f.state.raw),
    base = v.orders[0];
  base.lineItems[0].remainingQuantity = 1;
  const second = structuredClone(base);
  second.id = 'gid://shopify/FulfillmentOrder/98002';
  second.lineItems[0].id = 'gid://shopify/FulfillmentOrderLineItem/980020';
  f.state.foPage = 1;
  f.state.orders = [base, second];
  const p = await plan(x);
  assert.equal(p.payload.fulfillment.lineItemsByFulfillmentOrder.length, 2);
  assert.equal(f.calls.filter((c) => c.query.includes('DynaFulfillmentState')).length, 2);
});
test('Shopify: missing fulfillment count, foreign FO and wrong API version rejected', async () => {
  const x = await fixture();
  f.state.badCount = true;
  assert.equal((await preview(x)).statusCode, 422);
  f.state.badCount = false;
  f.state.badVersion = true;
  assert.equal((await preview(x)).statusCode, 502);
  f.state.badVersion = false;
  f.state.mutate = (d) => {
    d.order.fulfillmentOrders.nodes[0].orderId = 'gid://shopify/Order/9';
  };
  assert.equal((await preview(x)).statusCode, 502);
  assert.equal(writes().length, 0);
});
test('Shopify: public API scopes and strict schemas reject broader mutation payloads', async () => {
  const x = await fixture(true),
    read = await ok('/developer/keys', 'POST', { name: 'SF read', scopes: ['orders:read'] }),
    write = await ok('/developer/keys', 'POST', { name: 'SF write', scopes: ['orders:write'] }),
    r = await app.inject({
      url: '/api/v1/orders/' + x.o.id + '/shopify-fulfillment',
      headers: { authorization: 'Bearer ' + read.token },
    });
  assert.equal(r.statusCode, 200, r.body);
  const denied = await app.inject({
    url: '/api/v1/orders/' + x.o.id + '/shopify-fulfillment/preview',
    method: 'POST',
    headers: { authorization: 'Bearer ' + read.token },
    payload: { company: 'DPD' },
  });
  assert.equal(denied.statusCode, 403);
  const allowed = await app.inject({
    url: '/api/v1/orders/' + x.o.id + '/shopify-fulfillment/preview',
    method: 'POST',
    headers: { authorization: 'Bearer ' + write.token },
    payload: { company: 'DPD' },
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal((await preview(x, { company: 'DPD', tracking_number: 'invented' })).statusCode, 422);
  assert(
    !shopifyFulfillmentBody.safeParse({
      lineItemsByFulfillmentOrder: [
        { fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/1', fulfillmentOrderLineItems: [] },
      ],
      trackingInfo: { company: 'DPD', number: '123' },
      notifyCustomer: false,
    }).success,
  );
});
test('Shopify: DB FORCE RLS and frozen intent prevent tenant leakage and write restart', async () => {
  const x = await fixture(true),
    p = await plan(x);
  const meta = (
    await pool.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='shopify_fulfillment_plans'::regclass",
    )
  ).rows[0];
  assert(meta.relrowsecurity && meta.relforcerowsecurity);
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query("UPDATE shopify_fulfillment_plans SET payload='{}' WHERE id=$1", [p.id]),
    ),
    /immutable/,
  );
  await queue(p);
  await execute(p);
  await assert.rejects(
    pool.query("UPDATE shopify_fulfillment_plans SET phase='ready' WHERE id=$1", [p.id]),
    /cannot be reset/,
  );
  assert.equal(
    (await req('/orders/' + x.o.id + '/shopify-fulfillment', 'GET', undefined, other)).statusCode,
    404,
  );
});

test('Shopify: already-existing matching fulfillment is adopted without any POST', async () => {
  const x = await fixture();
  const t = (await pool.query('SELECT tracking_number FROM shipments WHERE order_id=$1', [x.o.id]))
    .rows[0].tracking_number;
  f.state.fulfillments = [
    {
      id: 'gid://shopify/Fulfillment/99901',
      status: 'SUCCESS',
      order_id: f.state.raw.id,
      location_id: 'gid://shopify/Location/1',
      lines: [{ id: 'gid://shopify/LineItem/980011', quantity: 2 }],
      fulfillment_order_ids: ['gid://shopify/FulfillmentOrder/98001'],
      tracking: [{ company: 'DPD', number: t }],
    },
  ];
  const p = await plan(x);
  assert.equal(p.remote.existing, 'gid://shopify/Fulfillment/99901');
  await queue(p);
  const r = await execute(p);
  assert.equal(r.state, 'done', r.error);
  assert(r.result.unchanged);
  assert.equal(writes().length, 0);
});
test('Shopify: nested line pages are fully collected and changed FO version rejected', async () => {
  const v = demoShopifyFulfillmentState(f.state.raw);
  const a = v.orders[0].lineItems[0];
  v.orders[0].lineItems = [
    a,
    { ...structuredClone(a), id: 'gid://shopify/FulfillmentOrderLineItem/980011' },
  ];
  f.state.orders = v.orders;
  f.state.linePage = 1;
  const client = new Shopify(
    { store_url: 'https://qa-lines.myshopify.com' },
    { access_token: 'qa-not-real-token-2026' },
    f.transport,
    async () => {},
  );
  let r = await client.fulfillmentState(f.state.raw.id);
  assert.equal(r.orders[0].lineItems.length, 2);
  assert.equal(f.calls.filter((c) => c.query.includes('DynaFulfillmentLines')).length, 1);
  const changed = new Shopify(
    { store_url: 'https://qa-lines.myshopify.com' },
    { access_token: 'qa-not-real-token-2026' },
    async (u, i) => {
      const response = await f.transport(u, i);
      if (String(i.body).includes('DynaFulfillmentLines')) {
        const b: any = await response.json();
        b.data.fulfillmentOrder.updatedAt = '2026-10-05T03:00:00.000Z';
        return new Response(JSON.stringify(b), { headers: { 'X-Shopify-API-Version': '2026-10' } });
      }
      return response;
    },
  );
  await assert.rejects(changed.fulfillmentState(f.state.raw.id), /zmieniło/);
});
test('Shopify: duplicate tracker and changed response ID do not confirm another fulfillment', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.lose = true;
  await execute(p, true);
  const v = structuredClone(f.state.fulfillments[0]);
  v.id = 'gid://shopify/Fulfillment/88002';
  f.state.fulfillments.push(v);
  assert.equal(
    (await req('/shopify-fulfillment-plans/' + p.id + '/reconcile', 'POST')).statusCode,
    409,
  );
  assert.equal(writes().length, 1);
});
test('Shopify: HTTP429 and userErrors have one mutation attempt and retain GET-only phase', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.apply = false;
  f.state.post = 429;
  let r = await execute(p, true);
  assert.equal(r.state, 'failed');
  assert.equal(r.phase, 'write_started');
  assert.equal(writes().length, 1);
  const input = shopifyFulfillmentBody.parse(p.payload.fulfillment);
  const client = new Shopify(
    { store_url: 'https://qa-error.myshopify.com' },
    { access_token: 'qa-not-real-token-2026' },
    async (u, i) => {
      await f.transport(u, i);
      return new Response(
        JSON.stringify({
          data: {
            fulfillmentCreate: {
              fulfillment: null,
              userErrors: [{ field: ['quantity'], message: 'PRIVATE PROVIDER DETAIL' }],
            },
          },
        }),
        { headers: { 'X-Shopify-API-Version': '2026-10' } },
      );
    },
  );
  await assert.rejects(
    client.createFulfillment(input, f.state.raw.id, async () => {}),
    (e) => !String(e).includes('PRIVATE') && /odrzucił realizację/.test(String(e)),
  );
  assert.equal(writes().length, 2);
});
test('Shopify: complete-item SQL changes and expired preview require a new approval', async () => {
  const x = await fixture(),
    p = await plan(x);
  await pool.query('UPDATE order_items SET quantity=quantity+1 WHERE order_id=$1', [x.o.id]);
  assert.equal((await queue(p)).statusCode, 409);
  await pool.query('UPDATE order_items SET quantity=quantity-1 WHERE order_id=$1', [x.o.id]);
  // Frozen creation time cannot be edited to simulate expiry; a controlled old INSERT exercises TTL.
  const old = randomUUID();
  await pool.query(
    "INSERT INTO shopify_fulfillment_plans(id,tenant_id,order_id,shipment_id,channel_id,actor_id,local_hash,connection_hash,account_scope,payload,remote,created_at) SELECT $2,tenant_id,order_id,shipment_id,channel_id,actor_id,local_hash,connection_hash,account_scope,payload,remote,now()-interval '31 minutes' FROM shopify_fulfillment_plans WHERE id=$1",
    [p.id, old],
  );
  assert.equal((await queue({ id: old })).statusCode, 409);
  assert.equal(writes().length, 0);
});
test('Shopify: restored schema without feature reports 404; full read-only preview blocks all mutations', async () => {
  const x = await fixture(true),
    p = await plan(x),
    readOnly = await buildApp({ readOnly: true, integrationTransport: ctx.transport });
  try {
    for (const path of [
      '/orders/' + x.o.id + '/shopify-fulfillment/preview',
      '/shopify-fulfillment-plans/' + p.id + '/queue',
      '/shopify-fulfillment-plans/' + p.id + '/cancel',
      '/shopify-fulfillment-plans/' + p.id + '/reconcile',
    ])
      assert.equal(
        (
          await readOnly.inject({
            url: '/api' + path,
            method: 'POST',
            payload: {},
            headers: { cookie },
          })
        ).statusCode,
        423,
      );
  } finally {
    await readOnly.close();
  }
  await pool.query('ALTER TABLE shopify_fulfillment_plans RENAME TO shopify_fulfillment_saved');
  let legacy: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    legacy = await buildApp();
    const h = (await legacy.inject({ url: '/api/health' })).json();
    assert.equal(h.shopify_fulfillment_available, false);
    assert.equal(
      (
        await legacy.inject({
          url: '/api/orders/' + x.o.id + '/shopify-fulfillment',
          headers: { cookie },
        })
      ).statusCode,
      404,
    );
  } finally {
    if (legacy) await legacy.close();
    await pool.query('ALTER TABLE shopify_fulfillment_saved RENAME TO shopify_fulfillment_plans');
  }
});

test('Shopify: concurrent queues respect the last free slot and a rejected queue leaves no claim', async () => {
  const x = await fixture(true),
    y = await fixture(true),
    p = await plan(x),
    q = await plan(y);
  await pool.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) SELECT gen_random_uuid(),$1,'shopify.fulfillment','{}','QA-slot-'||gen_random_uuid() FROM generate_series(1,99)",
    [DEMO_TENANT],
  );
  const result = await Promise.all([queue(p), queue(q)]);
  assert.deepEqual(result.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind='shopify.fulfillment' AND state IN ('pending','running')",
        [DEMO_TENANT],
      )
    ).rows[0].n,
    100,
  );
  const blocked = result[0].statusCode === 409 ? p : q;
  assert.equal(
    (await pool.query('SELECT 1 FROM shopify_fulfillment_scopes WHERE plan_id=$1', [blocked.id]))
      .rowCount,
    0,
  );
  await pool.query(
    "UPDATE jobs SET state='done' WHERE id=(SELECT id FROM jobs WHERE dedup_key LIKE 'QA-slot-%' AND state='pending' LIMIT 1)",
  );
  assert.equal((await queue(blocked)).statusCode, 200);
});
test('Shopify: an accepted partial return blocks a new write but preserves read-only reconciliation', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.lose = true;
  await execute(p, true);
  const o = await ok('/orders/' + x.o.id),
    r = await ok('/orders/' + x.o.id + '/returns', 'POST', {
      client_key: randomUUID(),
      reason: 'QA return',
      items: [{ item_id: o.items[0].id, quantity: 1 }],
    });
  await ok('/returns/' + r.id + '/receive', 'POST', {
    version: Number(r.version),
    shipping_refund: 0,
    note: 'QA przyjęcie',
    items: [{ item_id: o.items[0].id, accepted: 1, restocked: 1 }],
  });
  assert.equal((await preview(x)).statusCode, 409);
  const done = await ok('/shopify-fulfillment-plans/' + p.id + '/reconcile', 'POST');
  assert.equal(done.state, 'done');
  const history = await ok('/orders/' + x.o.id + '/shopify-fulfillment');
  assert.equal(history.ready, false);
  assert.match(history.reason, /Realizacja przesyłki została potwierdzona/);
  assert.equal(history.data[0].remote_id, done.remote_id);
  assert.equal(writes().length, 1);
});
