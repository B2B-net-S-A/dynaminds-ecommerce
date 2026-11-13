import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteShipmentFixture } from './shipment-identity-fixture';
import { randomUUID, createHash } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { amazonSecrets, amazonConfig } from './amazon-fixture';
import { amazonFulfillmentFixture } from './amazon-fulfillment-fixture';
import {
  processAmazonFulfillment,
  failAmazonFulfillment,
  amazonPackageCollection,
} from '../server/amazon-fulfillment';
import { Amazon, amazonShipmentBody } from '../server/amazon';
import { amazonApiTransport } from '../server/amazon-api-limits';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  viewer = '',
  other = '',
  warehouse = '',
  user = '',
  ip = 1,
  f = amazonFulfillmentFixture();
const ctx = { transport: (u: string, i: RequestInit) => f.transport(u, i) };
// These fixtures execute minutes of user work in milliseconds; quota wait behavior is tested separately below.
const resetReadQuota = () =>
  pool.query("DELETE FROM amazon_api_buckets WHERE family<>'shipment_write'");
const req = async (p: string, method: any = 'GET', payload?: any, auth = cookie) => {
  await resetReadQuota();
  return app.inject({
    url: '/api' + p,
    method,
    payload,
    headers: { cookie: auth },
    remoteAddress: '127.0.2.' + ip,
  });
};
async function ok(p: string, method: any = 'GET', payload?: any, auth = cookie) {
  const r = await req(p, method, payload, auth);
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
  ip++;
  f = amazonFulfillmentFixture();
  await pool.query('DELETE FROM amazon_api_buckets');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
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
  seller = 'AQATEST' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase(),
) {
  const wh = (await ok('/warehouses', 'GET', undefined, auth)).data[0].id;
  const ch = (
    await ok(
      '/integrations',
      'POST',
      {
        provider: 'amazon',
        name: 'Amazon fulfillment test',
        mode: 'sandbox',
        credentials: amazonSecrets,
        settings: { ...amazonConfig, selling_partner_id: seller, shipment_write: 'true' },
      },
      auth,
    )
  ).id;
  const p = await ok(
    '/products',
    'POST',
    {
      sku: 'AMF-' + randomUUID(),
      name: 'Amazon shipping test',
      price: 12300,
      vat: 23,
      warehouse_id: wh,
      quantity: 12,
    },
    auth,
  );
  await ok(
    `/integrations/${ch}/mappings`,
    'POST',
    { external_id: 'AMAZON-DEMO-SKU', sku: p.sku },
    auth,
  );
  await ok(`/integrations/${ch}/fetch-orders`, 'POST', { page: 1 }, auth);
  const inbound = (await ok(`/integrations/${ch}/imports`, 'GET', undefined, auth)).data[0];
  const o = await ok(
    `/imports/${inbound.id}/commit`,
    'POST',
    { warehouse_id: wh, expected_hash: inbound.source_hash },
    auth,
  );
  if (shipped) {
    await ok(
      `/orders/${o.id}/payments`,
      'POST',
      {
        client_key: randomUUID(),
        version: Number(o.version),
        kind: 'receipt',
        amount: 24690,
        currency: 'PLN',
        confirmed: true,
        method: 'bank_transfer',
        reference: 'AMF-' + randomUUID(),
      },
      auth,
    );
    await ok(`/orders/${o.id}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, auth), `/orders/${o.id}/status`, { status: 'picking' }), auth);
    for (let n = 0; n < 2; n++) await ok(`/orders/${o.id}/scan`, 'POST', { code: p.sku }, auth);
    await ok(`/orders/${o.id}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, auth), `/orders/${o.id}/status`, { status: 'packed' }), auth);
    await ok(`/orders/${o.id}/ship-demo`, 'POST', {}, auth);
  }
  if (simulation)
    await pool.query(
      'UPDATE channels SET settings=settings||\'{"simulation":true}\'::jsonb WHERE id=$1',
      [ch],
    );
  else if (shipped)
    await rewriteShipmentFixture(
      "UPDATE shipments SET mode='sandbox',carrier='QA DPD',tracking_number=$2 WHERE order_id=$1",
      [o.id, '003' + randomUUID().replaceAll('-', '')],
    );
  const shipment = (await pool.query('SELECT * FROM shipments WHERE order_id=$1', [o.id])).rows[0];
  return { ch, p, o, shipment, seller };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const preview = (x: Fixture, body: any = { carrier_code: 'DPD' }, auth = cookie) =>
  req(`/orders/${x.o.id}/amazon-fulfillment/preview`, 'POST', body, auth);
async function plan(x: Fixture, auth = cookie) {
  const r = await preview(x, undefined, auth);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const queue = (p: any, confirm_external = true, auth = cookie) =>
  req(`/amazon-fulfillment-plans/${p.id}/queue`, 'POST', { confirm_external }, auth);
const stored = async (p: any) =>
  (await pool.query('SELECT * FROM amazon_fulfillment_plans WHERE id=$1', [p.id])).rows[0];
const claim = async (id: string) =>
  (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
async function execute(p: any, last = false) {
  await resetReadQuota();
  const current = await stored(p);
  if (last)
    await pool.query('UPDATE jobs SET attempts=max_attempts-1 WHERE id=$1', [current.job_id]);
  const j = await claim(current.job_id);
  try {
    await processAmazonFulfillment(j, ctx);
  } catch (e) {
    await failAmazonFulfillment(j, e);
  }
  return stored(p);
}
const writes = () => f.calls.filter((c) => c.url.endsWith('/shipmentConfirmation'));
const stock = async (x: Fixture) =>
  assert.deepEqual(
    (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [x.p.id])).rows,
    [{ on_hand: 10, reserved: 0 }],
  );

test('Amazon fulfillment: exact v0 request, 204 followed by 2026 PACKAGES verification, one write and unchanged OMS finances/stock', async () => {
  const x = await fixture(),
    p = await plan(x);
  assert.equal((await ok(`/orders/${x.o.id}/amazon-fulfillment`)).ready, true);
  assert.equal((await queue(p, false)).statusCode, 422);
  assert.equal((await queue(p)).statusCode, 200);
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.phase, 'done');
  assert.equal((await ok(`/orders/${x.o.id}/amazon-fulfillment`)).ready, false);
  assert.equal(writes().length, 1);
  const d = p.payload.packageDetail;
  assert.deepEqual(d.orderItems, [{ orderItemId: '12345678901', quantity: 2 }]);
  assert.match(d.packageReferenceId, /^[1-9]\d{17}$/);
  assert.equal(d.trackingNumber, x.shipment.tracking_number);
  assert.equal(done.remote_id, d.packageReferenceId);
  assert.equal(done.result.fulfillment.packageStatus.status, 'SHIPPED');
  await stock(x);
  assert.deepEqual(
    (await pool.query('SELECT amount FROM payment_entries WHERE order_id=$1', [x.o.id])).rows,
    [{ amount: 24690 }],
  );
  assert.equal((await ok(`/orders/${x.o.id}`)).status, 'shipped');
  await execute(p);
  assert.equal(writes().length, 1);
  assert.equal((await preview(x)).statusCode, 409);
  assert.equal((await queue(p)).statusCode, 200);
});
test('Amazon fulfillment: simulation performs zero provider HTTP and uses existing DEMO shipment', async () => {
  const x = await fixture(true),
    n = f.calls.length,
    p = await plan(x);
  assert.equal((await queue(p, false)).statusCode, 200);
  assert.equal((await execute(p)).state, 'done');
  assert.equal(f.calls.length, n);
  await stock(x);
});
test('Amazon fulfillment: local packing, grant opt-in, account ID, DEMO/live mismatch, tracking and future dispatch guard', async () => {
  const x = await fixture(false, false);
  assert.equal((await preview(x)).statusCode, 409);
  const y = await fixture();
  const original = { ...y.shipment };
  for (const change of [
    "mode='demo'",
    "mode='live'",
    "tracking_number='bad tracking'",
    "dispatched_at=now()+interval '1 hour'",
    'dispatched_at=NULL',
  ]) {
    await rewriteShipmentFixture(`UPDATE shipments SET ${change} WHERE order_id=$1`, [y.o.id]);
    assert([409, 422].includes((await preview(y)).statusCode));
    await rewriteShipmentFixture(
      'UPDATE shipments SET mode=$2,tracking_number=$3,dispatched_at=$4 WHERE order_id=$1',
      [y.o.id, original.mode, original.tracking_number, original.dispatched_at],
    );
  }
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"shipment_write":false}\'::jsonb WHERE id=$1',
    [y.ch],
  );
  assert.equal((await preview(y)).statusCode, 403);
  assert.equal(writes().length, 0);
});
test('Amazon fulfillment: Other requires carrierName, optional service, unknown fields and Japan-only COD', async () => {
  const x = await fixture();
  assert.equal((await preview(x, { carrier_code: 'Other' })).statusCode, 422);
  const p = (
    await preview(x, { carrier_code: 'Other', carrier_name: 'Local QA', shipping_method: 'Parcel' })
  ).json();
  assert.equal(p.payload.packageDetail.carrierName, 'Local QA');
  assert.equal((await preview(x, { carrier_code: 'DPD', surprise: true })).statusCode, 422);
  assert.equal(
    (await preview(x, { carrier_code: 'DPD', cod_collection_method: 'DirectPayment' })).statusCode,
    422,
  );
  assert.equal((await queue(p)).statusCode, 200);
  assert.equal((await execute(p)).state, 'done');
});
test('Amazon fulfillment: changed local snapshot/address/tracking and remote cancellations, programs, prices and line identity stop before POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await rewriteShipmentFixture("UPDATE shipments SET tracking_number='CHANGED' WHERE order_id=$1", [x.o.id]);
  assert.equal((await queue(p)).statusCode, 409);
  for (const edit of [
    (r: any) => (r.recipient.deliveryAddress.city = 'Other'),
    (r: any) => (r.orderItems[0].orderItemId = 'other'),
    (r: any) => (r.orderItems[0].cancellation = { cancellationRequest: {} }),
    (r: any) => (r.programs = ['SHIP_PLUS']),
    (r: any) => (r.proceeds.grandTotal.amount = '250.00'),
  ]) {
    const y = await fixture();
    f.state.edit = edit;
    assert([409, 422].includes((await preview(y)).statusCode));
    f.state.edit = undefined;
  }
  assert.equal(writes().length, 0);
});
test('Amazon fulfillment: lost POST response is read-only on retry even after local order status changes', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.lose = true;
  assert.equal((await execute(p)).phase, 'write_started');
  assert.equal(writes().length, 1);
  await pool.query("UPDATE orders SET version=version+1,status='delivered' WHERE id=$1", [x.o.id]);
  f.state.lose = false;
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert(done.result.stale_local);
  assert.equal(writes().length, 1);
  await stock(x);
});
test('Amazon fulfillment: 204 without observable package is not success and never triggers second POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.hide = true;
  const pending = await execute(p);
  assert.equal(pending.state, 'queued');
  assert.equal(pending.phase, 'verify');
  const failed = await execute(p, true);
  assert.equal(failed.state, 'failed');
  assert.equal(writes().length, 1);
  f.state.hide = false;
  const r = await ok(`/amazon-fulfillment-plans/${p.id}/reconcile`, 'POST', {});
  assert.equal(r.state, 'done');
  assert.equal(writes().length, 1);
});
test('Amazon fulfillment: 401 mutation is never replayed or automatically refreshed after dispatch', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.post = 401;
  f.state.apply = false;
  const failed = await execute(p, true);
  assert.equal(failed.phase, 'write_started');
  assert.equal(failed.state, 'failed');
  assert.equal(writes().length, 1);
  assert.equal(
    (await req(`/amazon-fulfillment-plans/${p.id}/reconcile`, 'POST', {})).statusCode,
    409,
  );
  assert.equal(writes().length, 1);
});
test('Amazon fulfillment: 429 before quota permit leaves ready; 429 after POST leaves write_started and waits for GET', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  const scope = createHash('sha256')
    .update(
      JSON.stringify({
        mode: 'sandbox',
        region: 'eu',
        clientId: amazonSecrets.client_id,
        family: 'shipment_write',
      }),
    )
    .digest('hex');
  await pool.query(
    "INSERT INTO amazon_api_buckets(scope_hash,family,tokens,cooldown_until) VALUES($1,'shipment_write',10,now()+interval '1 hour')",
    [scope],
  );
  const ready = await execute(p);
  assert.equal(ready.phase, 'ready');
  assert.equal(writes().length, 0);
  await pool.query('UPDATE amazon_api_buckets SET cooldown_until=now() WHERE scope_hash=$1', [
    scope,
  ]);
  f.state.post = 429;
  const uncertain = await execute(p);
  assert.equal(uncertain.phase, 'write_started');
  assert.equal(writes().length, 1);
  assert.equal((await execute(p)).state, 'done');
  assert.equal(writes().length, 1);
});
test('Amazon fulfillment: cancel before write revokes lease and scope; cancel after dispatch is rejected', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  const j = await claim((await stored(p)).job_id);
  assert.equal((await req(`/amazon-fulfillment-plans/${p.id}/cancel`, 'POST', {})).statusCode, 200);
  await processAmazonFulfillment(j, ctx);
  assert.equal(writes().length, 0);
  const q = await plan(x);
  await queue(q);
  f.state.lose = true;
  await execute(q);
  assert.equal((await req(`/amazon-fulfillment-plans/${q.id}/cancel`, 'POST', {})).statusCode, 409);
});
test('Amazon fulfillment: admin role revoked after enqueue and connection grant changed stop dispatch', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  assert.equal((await execute(p)).state, 'conflict');
  assert.equal(writes().length, 0);
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  const q = await plan(x);
  await queue(q);
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"selling_partner_id":"DIFFERENT"}\'::jsonb WHERE id=$1',
    [x.ch],
  );
  assert.equal((await execute(q)).state, 'conflict');
  assert.equal(writes().length, 0);
});
test('Amazon fulfillment: concurrent queue is idempotent, conflicting previews cannot both own account/order', async () => {
  const x = await fixture(),
    p = await plan(x),
    q = await plan(x);
  const rs = await Promise.all([queue(p), queue(p), queue(q)]);
  assert.equal(rs[0].statusCode, 200);
  assert.equal(rs[1].statusCode, 200);
  assert.equal(rs[2].statusCode, 409);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE kind='amazon.fulfillment' AND payload->>'plan_id'=$1",
        [p.id],
      )
    ).rows[0].n,
    1,
  );
});
test('Amazon fulfillment: RLS, role denial, composite relationships and service-only global scopes', async () => {
  const x = await fixture(),
    p = await plan(x);
  assert.equal((await preview(x, undefined, viewer)).statusCode, 403);
  assert.equal((await preview(x, undefined, other)).statusCode, 404);
  assert.equal((await queue(p, true, other)).statusCode, 404);
  assert.equal(
    (await req(`/orders/${x.o.id}/amazon-fulfillment`, 'GET', undefined, other)).statusCode,
    404,
  );
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal(
      (await c.query('SELECT * FROM amazon_fulfillment_plans WHERE id=$1', [p.id])).rowCount,
      0,
    );
    assert.equal(
      (await c.query('SELECT amazon_fulfillment_scope($1) value', [p.id])).rows[0].value,
      null,
    );
  });
  for (const action of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
    assert.equal(
      (
        await pool.query('SELECT has_table_privilege($1,$2,$3) ok', [
          'dyna_app',
          'amazon_fulfillment_scopes',
          action,
        ])
      ).rows[0].ok,
      false,
    );
  const foreign = await fixture(false, true, other);
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE amazon_fulfillment_plans SET shipment_id=$2 WHERE id=$1', [
        p.id,
        foreign.shipment.id,
      ]),
    ),
    (e: any) => e.code === '23503',
  );
});
test('Amazon fulfillment: stable seller/order claim spans firms and stays held after success or uncertain acknowledgement', async () => {
  const seller = 'ASHARED' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
  const x = await fixture(false, true, cookie, seller),
    p = await plan(x);
  await queue(p);
  const y = await fixture(false, true, other, seller),
    q = await plan(y, other);
  assert.equal((await queue(q, true, other)).statusCode, 409);
  f.state.apply = false;
  f.state.lose = true;
  await execute(p, true);
  f.state.lose = false;
  assert.equal(
    (await req(`/amazon-fulfillment-plans/${p.id}/reconcile`, 'POST', {})).statusCode,
    409,
  );
  const r = await ok(`/amazon-fulfillment-plans/${p.id}/reconcile`, 'POST', {
    acknowledge_mismatch: true,
  });
  assert.equal(r.state, 'conflict');
  assert.equal(r.phase, 'done');
  assert.equal(r.result.matched, false);
  assert.equal((await queue(q, true, other)).statusCode, 409);
  assert.equal(writes().length, 1);
});
test('Amazon fulfillment: incomplete, duplicate, mismatched or pending packages never prove successful shipment', async () => {
  assert.throws(() =>
    amazonPackageCollection([{ packageReferenceId: '1' }, { packageReferenceId: '1' }]),
  );
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.lose = true;
  await execute(p, true);
  f.state.lose = false;
  f.packages[0].packageStatus.status = 'PENDING';
  assert.equal(
    (await req(`/amazon-fulfillment-plans/${p.id}/reconcile`, 'POST', {})).statusCode,
    409,
  );
  f.packages[0].packageStatus.status = 'SHIPPED';
  f.packages[0].packageItems[0].quantity = 1;
  assert.equal(
    (await req(`/amazon-fulfillment-plans/${p.id}/reconcile`, 'POST', {})).statusCode,
    409,
  );
  assert.equal(writes().length, 1);
});
test('Amazon fulfillment: public scopes, OpenAPI and restore preview refuse writes', async () => {
  const x = await fixture(true);
  const token = await ok('/developer/keys', 'POST', {
    name: 'Amazon fulfillment QA',
    scopes: ['orders:read'],
  });
  const r = await app.inject({
    url: `/api/v1/orders/${x.o.id}/amazon-fulfillment`,
    headers: { authorization: 'Bearer ' + token.token },
  });
  assert.equal(r.statusCode, 200, r.body);
  const denied = await app.inject({
    url: `/api/v1/orders/${x.o.id}/amazon-fulfillment/preview`,
    method: 'POST',
    payload: { carrier_code: 'DPD' },
    headers: { authorization: 'Bearer ' + token.token },
  });
  assert.equal(denied.statusCode, 403);
  const schema = await ok('/v1/openapi');
  assert(schema.paths['/orders/{id}/amazon-fulfillment/preview']);
  const restore = await buildApp({ readOnly: true, integrationTransport: ctx.transport });
  try {
    const post = await restore.inject({
      url: `/api/orders/${x.o.id}/amazon-fulfillment/preview`,
      method: 'POST',
      payload: { carrier_code: 'DPD' },
      headers: { cookie },
    });
    assert.equal(post.statusCode, 423);
  } finally {
    await restore.close();
  }
});
test('Amazon confirmShipment: body validation and fence failures precede dispatch; unauthorized POST sends once', async () => {
  const body = amazonShipmentBody.parse({
    marketplaceId: amazonConfig.marketplace_id,
    packageDetail: {
      packageReferenceId: '1',
      carrierCode: 'DPD',
      trackingNumber: '123',
      shipDate: new Date().toISOString(),
      orderItems: [{ orderItemId: '1', quantity: 1 }],
    },
  });
  let begins = 0;
  const client = new Amazon(
    'sandbox',
    { ...amazonConfig, selling_partner_id: 'ATEST', shipment_write: true },
    amazonSecrets,
    amazonApiTransport('sandbox', 'eu', amazonSecrets.client_id, ctx.transport),
  );
  await assert.rejects(
    client.confirmShipment(
      'invalid',
      body,
      async () => {
        begins++;
      },
      async () => {},
    ),
  );
  assert.equal(begins, 0);
  await assert.rejects(
    client.confirmShipment(
      f.base.orders[0].orderId,
      body,
      async () => {
        throw Error('blocked');
      },
      async () => {},
    ),
  );
  assert.equal(writes().length, 0);
  f.state.post = 401;
  f.state.apply = false;
  await assert.rejects(
    client.confirmShipment(
      f.base.orders[0].orderId,
      body,
      async () => {
        begins++;
      },
      async () => {},
    ),
  );
  assert.equal(begins, 1);
  assert.equal(writes().length, 1);
  assert.equal(f.base.state.token, 1);
});

test('Amazon fulfillment: two workers for one live lease serialize and POST once', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  await resetReadQuota();
  const j = await claim((await stored(p)).job_id);
  await Promise.all([processAmazonFulfillment(j, ctx), processAmazonFulfillment(j, ctx)]);
  assert.equal((await stored(p)).state, 'done');
  assert.equal(writes().length, 1);
});
test('Amazon fulfillment: expired lease during provider POST cannot complete; replacement worker only reads', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.hook = async (u) => {
    if (u.pathname.endsWith('/shipmentConfirmation'))
      await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [
        (await stored(p)).job_id,
        randomUUID(),
      ]);
  };
  const uncertain = await execute(p);
  assert.equal(uncertain.phase, 'write_started');
  assert.equal(uncertain.state, 'queued');
  assert.equal(writes().length, 1);
  f.state.hook = undefined;
  assert.equal((await execute(p)).state, 'done');
  assert.equal(writes().length, 1);
});
test('Amazon fulfillment: acknowledged different parcel remains conflict and does not release seller/order claim', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.lose = true;
  await execute(p, true);
  f.state.lose = false;
  f.packages[0].trackingNumber = 'DIFFERENT';
  assert.equal(
    (await req(`/amazon-fulfillment-plans/${p.id}/reconcile`, 'POST', {})).statusCode,
    409,
  );
  const r = await ok(`/amazon-fulfillment-plans/${p.id}/reconcile`, 'POST', {
    acknowledge_mismatch: true,
  });
  assert.equal(r.state, 'conflict');
  assert.equal(r.result.matched, false);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM amazon_fulfillment_scopes WHERE plan_id=$1', [
        p.id,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(writes().length, 1);
});
test('Amazon fulfillment: old-schema restore registers public aliases and returns explicit unavailable without missing-table errors', async () => {
  const x = await fixture(true);
  let old: Awaited<ReturnType<typeof buildApp>> | undefined;
  await pool.query(
    'ALTER TABLE amazon_fulfillment_plans RENAME TO amazon_fulfillment_plans_qa_old',
  );
  try {
    old = await buildApp({ readOnly: true, integrationTransport: ctx.transport });
    const h = await old.inject({ url: '/api/health' });
    assert.equal(h.json().amazon_fulfillment_available, false);
    const login = await old.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(login.statusCode, 200);
    const auth = login.headers['set-cookie']!.toString().split(';')[0];
    const read = await old.inject({
      url: `/api/orders/${x.o.id}/amazon-fulfillment`,
      headers: { cookie: auth },
    });
    assert.equal(read.statusCode, 404, read.body);
    const spec = await old.inject({ url: '/api/v1/openapi' });
    assert.equal(spec.statusCode, 200);
    assert(spec.json().paths['/orders/{id}/amazon-fulfillment']);
  } finally {
    await old?.close();
    await pool.query(
      'ALTER TABLE amazon_fulfillment_plans_qa_old RENAME TO amazon_fulfillment_plans',
    );
  }
});
