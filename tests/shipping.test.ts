import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processShipping, failShipping, rateMinor } from '../server/shipping';
import { InPost } from '../server/integrations';
import { Problem } from '../server/errors';
import { tick } from '../server/worker';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  operator: string,
  warehouse: string;
const calls: { url: string; method: string; body: any }[] = [],
  store = new Map<string, any>();
let next = 20000,
  lostCreate = false,
  lostBuy = false,
  noOffers = false,
  pendingBuy = false,
  nullRate = false,
  badPdf = false,
  wrongTracking = false,
  paginated = false;
let beforeRemoteBuy: (() => Promise<void>) | undefined;
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status });
const transport = async (url: string, init: RequestInit) => {
  const u = new URL(url),
    method = init.method ?? 'GET',
    body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, method, body });
  if (
    u.pathname.endsWith('/tracking/' + u.pathname.split('/').at(-1)) &&
    u.pathname.includes('/tracking/')
  ) {
    assert.equal((init.headers as any)?.Authorization, undefined);
    return json({
      tracking_number: wrongTracking ? 'wrong' : u.pathname.split('/').at(-1),
      status: 'delivered',
      tracking_details: [{ status: 'delivered', datetime: new Date().toISOString() }],
    });
  }
  if (u.pathname.endsWith('/label'))
    return new Response(badPdf ? '<html>bad</html>' : '%PDF-1.4\nfixture', {
      headers: { 'content-type': 'application/pdf' },
    });
  if (u.pathname.includes('/organizations/')) {
    if (method === 'GET') {
      assert.ok(u.searchParams.get('created_at_gteq'));
      assert.equal(
        u.searchParams.get('reference'),
        null,
        'ShipX does not document a reference filter',
      );
      const page = Number(u.searchParams.get('page'));
      return json({
        items:
          paginated && page === 1
            ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, reference: 'other-' + i }))
            : [...store.values()],
        count: paginated ? 101 : store.size,
      });
    }
    assert.equal(method, 'POST');
    assert.equal(body.service, undefined);
    assert.equal(body.only_choice_of_offer, true);
    const sid = String(next++),
      r = {
        ...body,
        id: sid,
        status: 'offers_prepared',
        tracking_number: null,
        cod: body.cod ?? null,
        insurance: body.insurance ?? null,
        offers: [
          {
            id: next++,
            service: {
              id: body.parcels[0].template ? 'inpost_locker_standard' : 'inpost_courier_standard',
            },
            status: 'available',
            rate: nullRate ? null : '12.99',
            currency: 'PLN',
            expires_at: new Date(Date.now() + 300000).toISOString(),
          },
        ],
        selected_offer: null,
      };
    store.set(sid, r);
    if (lostCreate) {
      lostCreate = false;
      throw new Problem(502, 'Odpowiedź utracona');
    }
    return json({ ...r, offers: [] }, 201);
  }
  const seg = u.pathname.split('/'),
    sid = seg.at(-1) === 'buy' ? seg.at(-2)! : seg.at(-1)!,
    r = store.get(sid);
  if (!r) return json({}, 404);
  if (method === 'DELETE') {
    r.status = 'cancelled';
    return new Response(null, { status: 204 });
  }
  if (method === 'PUT') {
    r.offers[0].rate = '13.49';
    r.offers[0].expires_at = new Date(Date.now() + 300000).toISOString();
    return json(r);
  }
  if (method === 'POST') {
    await beforeRemoteBuy?.();
    assert.equal(body.offer_id, r.offers[0].id);
    r.selected_offer = { ...r.offers[0], status: 'selected' };
    r.service = r.offers[0].service.id;
    r.status = pendingBuy ? 'offer_selected' : 'confirmed';
    r.tracking_number = pendingBuy ? null : '630000' + sid;
    if (lostBuy) {
      lostBuy = false;
      throw new Problem(502, 'Odpowiedź zakupu utracona');
    }
    return json(r);
  }
  return json(noOffers ? { ...r, offers: [] } : r);
};
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: auth } });
const checked = async (url: string, method: any = 'GET', payload?: any, auth = cookie) => {
  const r = await req(url, method, payload, auth);
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const login = async (email: string) =>
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email, password: 'DynaDemo!2026' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await checked('/api/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => {
  calls.length = 0;
  store.clear();
  lostCreate =
    lostBuy =
    noOffers =
    pendingBuy =
    nullRate =
    badPdf =
    wrongTracking =
    paginated =
      false;
  beforeRemoteBuy = undefined;
});
async function packed() {
  const p = await checked('/api/products', 'POST', {
    sku: 'SHIP-' + randomUUID().slice(0, 10),
    name: 'Przesyłka QA',
    price: 10000,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 10,
  });
  const o = await checked('/api/orders', 'POST', {
    customer_name: 'Odbiorca QA',
    payment_mode: 'cod',
    email: 'shipping@example.test',
    warehouse_id: warehouse,
    address: {
      street: 'Testowa 1',
      city: 'Warszawa',
      postal_code: '00-001',
      country: 'PL',
      phone: '500600700',
    },
    items: [{ product_id: p.id, quantity: 2 }],
  });
  await checked('/api/orders/' + o.id + '/payments', 'POST', {
    client_key: randomUUID(),
    version: Number(o.version),
    kind: 'receipt',
    amount: 10000,
    currency: 'PLN',
    reference: 'Zaliczka QA',
    confirmed: true,
  });
  await checked('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => checked(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'picking' }));
  await checked('/api/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  await checked('/api/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  await checked('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => checked(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'packed' }));
  return { o, p };
}
async function channel(mode = 'sandbox', simulation = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'inpost','InPost QA',$3,$4,$5)",
      [
        id,
        DEMO_TENANT,
        mode,
        encrypt({ access_token: 'fixture' }),
        JSON.stringify({ organization_id: '1', simulation }),
      ],
    ),
  );
  return id;
}
const input = (ch: string) => ({
  channel_id: ch,
  service: 'inpost_locker_standard',
  receiver: {
    first_name: 'Odbiorca',
    last_name: 'QA',
    email: 'shipping@example.test',
    phone: '500600700',
  },
  target_point: 'WAW01M',
  template: 'small',
  weight: 1,
  cod: 10000,
  insurance: 10000,
});
async function setup(mode = 'sandbox', simulation = false, auth = cookie) {
  const { o, p } = await packed(),
    ch = await channel(mode, simulation),
    plan = await checked('/api/orders/' + o.id + '/shipping/preview', 'POST', input(ch), auth);
  return { o, p, ch, plan };
}
async function plan(id: string) {
  return tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [id])).rows[0],
  );
}
async function run(jobId: string) {
  const job = await tenantTx(
    DEMO_TENANT,
    async (c) =>
      (
        await c.query(
          "UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *",
          [jobId, randomUUID()],
        )
      ).rows[0],
  );
  try {
    await processShipping(job, { transport });
  } catch (e) {
    await failShipping(job, e);
  }
  return job;
}
async function quote(id: string) {
  await run((await checked('/api/shipping-plans/' + id + '/queue', 'POST', {})).job_id);
  return plan(id);
}
async function buy(id: string, auth = cookie) {
  const p = await plan(id);
  const q = await checked(
    '/api/shipping-plans/' + id + '/buy',
    'POST',
    { offer_id: p.offers[0].id, confirm_cost: true, ack_unknown_rate: true },
    auth,
  );
  await run(q.job_id);
  return plan(id);
}
const count = (suffix: string, method: string) =>
  calls.filter((x) => new URL(x.url).pathname.endsWith(suffix) && x.method === method).length;
const stock = async (pid: string) =>
  tenantTx(
    DEMO_TENANT,
    async (c) =>
      (
        await c.query(
          'SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2',
          [pid, warehouse],
        )
      ).rows[0],
  );
test('quote → label → physical dispatch: stock consumed once, concurrent replay and return restores it', async () => {
  const { o, p, plan: q } = await setup();
  assert.equal(q.payload.cod.amount, 100);
  assert.equal(q.payload.custom_attributes.sending_method, 'any_point');
  let s = await quote(q.id);
  assert.equal(s.state, 'quoted');
  assert.equal(s.offers[0].rate, 1299);
  assert.deepEqual(await stock(p.id), { on_hand: 10, reserved: 2 });
  s = await buy(q.id);
  assert.equal(s.state, 'ready');
  assert.equal((await checked('/api/orders/' + o.id)).status, 'packed');
  assert.deepEqual(await stock(p.id), { on_hand: 10, reserved: 2 });
  const pdf = await req('/api/shipments/' + s.shipment_id + '/label');
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.match(pdf.headers['content-type']!, /application\/pdf/);
  assert.equal(pdf.headers['cache-control'], 'no-store');
  assert.ok(pdf.body.startsWith('%PDF-'));
  const dispatched = await Promise.all([
    req('/api/shipping-plans/' + q.id + '/dispatch', 'POST', {}),
    req('/api/shipping-plans/' + q.id + '/dispatch', 'POST', {}),
  ]);
  // On a loaded CI runner (run 43425966080) a dispatch can pass the 8 s statement limit and answer 503
  // "spróbuj ponownie"; the client replays it once. Stock consumed exactly once is asserted right below.
  for (const [i, x] of dispatched.entries())
    if (x.statusCode === 503)
      dispatched[i] = await req('/api/shipping-plans/' + q.id + '/dispatch', 'POST', {});
  assert.ok(
    dispatched.every((x) => x.statusCode === 200),
    dispatched.map((x) => x.statusCode + ' ' + x.body.slice(0, 300)).join('\n'),
  );
  assert.deepEqual(await stock(p.id), { on_hand: 8, reserved: 0 });
  assert.equal(
    await tenantTx(
      DEMO_TENANT,
      async (c) =>
        (
          await c.query(
            "SELECT count(*)::int AS n FROM stock_movements WHERE order_id=$1 AND kind='shipment'",
            [o.id],
          )
        ).rows[0].n,
    ),
    1,
  );
  await checked('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => checked(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'return_initiated' }));
  await checked('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => checked(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'return_received' }));
  assert.deepEqual(await stock(p.id), { on_hand: 10, reserved: 0 });
});
test('lost creation response is recovered by paginated organization history without a second POST', async () => {
  const { plan: q } = await setup();
  lostCreate = true;
  const queued = await checked('/api/shipping-plans/' + q.id + '/queue', 'POST', {});
  await run(queued.job_id);
  assert.equal((await plan(q.id)).phase, 'create_started');
  paginated = true;
  await run(queued.job_id);
  assert.equal((await plan(q.id)).state, 'quoted');
  assert.equal(count('/organizations/1/shipments', 'POST'), 1);
  assert.equal(count('/organizations/1/shipments', 'GET'), 2);
});
test('uncertain create with no matching remote blocks retry POST and second plan', async () => {
  const { o, plan: q, ch } = await setup();
  lostCreate = true;
  const j = await checked('/api/shipping-plans/' + q.id + '/queue', 'POST', {});
  await run(j.job_id);
  store.clear();
  await run(j.job_id);
  assert.equal((await plan(q.id)).state, 'failed');
  assert.equal(count('/organizations/1/shipments', 'POST'), 1);
  const p = await checked('/api/orders/' + o.id + '/shipping/preview', 'POST', input(ch));
  assert.equal((await req('/api/shipping-plans/' + p.id + '/queue', 'POST', {})).statusCode, 409);
});
test('lost buy response recovers confirmed shipment without another payment', async () => {
  const { plan: q } = await setup();
  await quote(q.id);
  lostBuy = true;
  let p = await buy(q.id);
  assert.equal(p.phase, 'buy_started');
  assert.equal(p.state, 'buy_queued');
  await run(p.job_id);
  p = await plan(q.id);
  assert.equal(p.state, 'ready');
  assert.equal(count('/buy', 'POST'), 1);
});
test('asynchronous purchase is polled without paying again', async () => {
  const { plan: q } = await setup();
  await quote(q.id);
  pendingBuy = true;
  let p = await buy(q.id);
  assert.equal(p.state, 'buy_queued');
  const r = store.get(p.remote_id);
  r.status = 'confirmed';
  r.tracking_number = '6300' + r.id;
  await run(p.job_id);
  assert.equal((await plan(q.id)).state, 'ready');
  assert.equal(count('/buy', 'POST'), 1);
});
test('asynchronous offer calculation is polled without creating again', async () => {
  const { plan: q } = await setup();
  noOffers = true;
  const j = await checked('/api/shipping-plans/' + q.id + '/queue', 'POST', {});
  await run(j.job_id);
  assert.equal((await plan(q.id)).state, 'queued');
  noOffers = false;
  await run(j.job_id);
  assert.equal((await plan(q.id)).state, 'quoted');
  assert.equal(count('/organizations/1/shipments', 'POST'), 1);
});
test('changed remote price prevents charge and requires a fresh accepted quote', async () => {
  const { plan: q } = await setup();
  const p = await quote(q.id);
  store.get(p.remote_id).offers[0].rate = '99.00';
  assert.equal((await buy(q.id)).state, 'failed');
  assert.equal(count('/buy', 'POST'), 0);
  const j = await checked('/api/shipping-plans/' + q.id + '/refresh', 'POST', {});
  await run(j.job_id);
  assert.equal((await plan(q.id)).offers[0].rate, 1349);
  assert.equal((await buy(q.id)).state, 'ready');
});
test('changed remote weight or COD prevents purchase', async () => {
  for (const field of ['parcels', 'cod']) {
    const { plan: q } = await setup();
    const p = await quote(q.id),
      r = store.get(p.remote_id);
    if (field === 'parcels') r.parcels[0].weight.amount = 7;
    else r.cod.amount = 500;
    assert.equal((await buy(q.id)).state, 'failed');
  }
  assert.equal(count('/buy', 'POST'), 0);
});
test('live transfer and live cost are independently authorized; debit rate is never assumed zero', async () => {
  const { plan: q } = await setup('live');
  nullRate = true;
  assert.equal((await req('/api/shipping-plans/' + q.id + '/queue', 'POST', {})).statusCode, 422);
  const j = await checked('/api/shipping-plans/' + q.id + '/queue', 'POST', { confirm_live: true });
  await run(j.job_id);
  const p = await plan(q.id);
  assert.equal(p.offers[0].rate, null);
  const body = { offer_id: p.offers[0].id };
  assert.equal((await req('/api/shipping-plans/' + q.id + '/buy', 'POST', body)).statusCode, 422);
  assert.equal(
    (await req('/api/shipping-plans/' + q.id + '/buy', 'POST', { ...body, confirm_cost: true }))
      .statusCode,
    422,
  );
  await checked('/api/shipping-plans/' + q.id + '/buy', 'POST', {
    ...body,
    confirm_cost: true,
    ack_unknown_rate: true,
  });
});
test('expired offer cannot be purchased', async () => {
  const { plan: q } = await setup();
  await quote(q.id);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "UPDATE shipping_plans SET offers=jsonb_set(offers,'{0,expires_at}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1",
      [q.id],
    ),
  );
  const p = await plan(q.id);
  assert.equal(
    (await req('/api/shipping-plans/' + q.id + '/buy', 'POST', { offer_id: p.offers[0].id }))
      .statusCode,
    409,
  );
  assert.equal(count('/buy', 'POST'), 0);
});
test('cancel unpaid shipment observes DELETE 204, releases order guard, preserves stock', async () => {
  const { o, p, plan: q } = await setup();
  await quote(q.id);
  assert.equal((await req('/api/orders/' + o.id + '/ship-demo', 'POST', {})).statusCode, 409);
  assert.equal(
    (await req('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'cancelled' }))).statusCode,
    409,
  );
  const j = await checked('/api/shipping-plans/' + q.id + '/cancel', 'POST', {});
  await run(j.job_id);
  assert.equal((await plan(q.id)).state, 'cancelled');
  assert.equal(count('/' + (await plan(q.id)).remote_id, 'DELETE'), 1);
  await checked('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => checked(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'cancelled' }));
  assert.deepEqual(await stock(p.id), { on_hand: 10, reserved: 0 });
});
test('paid label cannot be cancelled or bypassed by demo fulfillment', async () => {
  const { o, plan: q } = await setup();
  await quote(q.id);
  await buy(q.id);
  assert.equal((await req('/api/shipping-plans/' + q.id + '/cancel', 'POST', {})).statusCode, 409);
  assert.equal((await req('/api/orders/' + o.id + '/ship-demo', 'POST', {})).statusCode, 409);
});
test('preview races and changed order snapshots never create remote duplicates', async () => {
  const { o, ch, plan: q } = await setup(),
    otherPlan = await checked('/api/orders/' + o.id + '/shipping/preview', 'POST', input(ch));
  const results = await Promise.all([
    req('/api/shipping-plans/' + q.id + '/queue', 'POST', {}),
    req('/api/shipping-plans/' + otherPlan.id + '/queue', 'POST', {}),
  ]);
  assert.deepEqual(results.map((x) => x.statusCode).sort(), [200, 409]);
  const second = await setup();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("UPDATE orders SET updated_at=now(),note='changed' WHERE id=$1", [second.o.id]),
  );
  assert.equal(
    (await req('/api/shipping-plans/' + second.plan.id + '/queue', 'POST', {})).statusCode,
    409,
  );
});
test('tenant isolation, viewer denial, operator fulfillment and plan author enforcement', async () => {
  const { o, plan: q } = await setup();
  assert.equal(
    (await req('/api/orders/' + o.id + '/shipping', 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req('/api/shipping-plans/' + q.id + '/queue', 'POST', {}, other)).statusCode,
    404,
  );
  assert.equal(
    (await req('/api/orders/' + o.id + '/shipping/preview', 'POST', input(q.channel_id), viewer))
      .statusCode,
    403,
  );
  assert.equal(
    (await req('/api/shipping-plans/' + q.id + '/queue', 'POST', {}, operator)).statusCode,
    403,
  );
  const op = await setup('sandbox', false, operator);
  await run(
    (await checked('/api/shipping-plans/' + op.plan.id + '/queue', 'POST', {}, operator)).job_id,
  );
  await buy(op.plan.id, operator);
  await checked('/api/shipping-plans/' + op.plan.id + '/dispatch', 'POST', {}, operator);
});
test('PDF validates bytes and label access is scoped by tenant; sandbox tracking is explicit', async () => {
  const { plan: q } = await setup();
  await quote(q.id);
  const p = await buy(q.id);
  assert.equal(
    (await req('/api/shipments/' + p.shipment_id + '/label', 'GET', undefined, other)).statusCode,
    404,
  );
  badPdf = true;
  assert.equal((await req('/api/shipments/' + p.shipment_id + '/label')).statusCode, 502);
  assert.equal(
    (await req('/api/shipments/' + p.shipment_id + '/tracking', 'POST', {})).statusCode,
    422,
  );
});
test('live tracking is provider verified, rejects mismatched number and does not fake physical dispatch', async () => {
  const { o, plan: q } = await setup('live');
  await run(
    (await checked('/api/shipping-plans/' + q.id + '/queue', 'POST', { confirm_live: true }))
      .job_id,
  );
  const p = await buy(q.id);
  wrongTracking = true;
  assert.equal(
    (await req('/api/shipments/' + p.shipment_id + '/tracking', 'POST', {})).statusCode,
    502,
  );
  wrongTracking = false;
  const t = await checked('/api/shipments/' + p.shipment_id + '/tracking', 'POST', {});
  assert.equal(t.scope, 'external_api_verified');
  assert.equal(t.status, 'delivered');
  assert.equal((await checked('/api/orders/' + o.id)).status, 'packed');
});
test('courier requires address, dimensions, COD insurance and validates perimeter', async () => {
  const { o, ch } = await setup();
  const body = { ...input(ch), service: 'inpost_courier_standard' };
  assert.equal(
    (await req('/api/orders/' + o.id + '/shipping/preview', 'POST', body)).statusCode,
    422,
  );
  const valid = {
    ...body,
    receiver: {
      ...body.receiver,
      address: { street: 'Testowa', building_number: '1', city: 'Warszawa', post_code: '00-001' },
    },
    dimensions: { length: 400, width: 300, height: 200 },
  };
  const p = await checked('/api/orders/' + o.id + '/shipping/preview', 'POST', valid);
  assert.equal(p.payload.custom_attributes.sending_method, 'dispatch_order');
  assert.equal(p.payload.parcels[0].dimensions.unit, 'mm');
  assert.equal(
    (await req('/api/orders/' + o.id + '/shipping/preview', 'POST', { ...valid, insurance: 0 }))
      .statusCode,
    422,
  );
  assert.equal(
    (
      await req('/api/orders/' + o.id + '/shipping/preview', 'POST', {
        ...valid,
        dimensions: { length: 1200, width: 1200, height: 100 },
      })
    ).statusCode,
    422,
  );
});
test('lease fencing rejects a stale worker before any provider mutation', async () => {
  const { plan: q } = await setup();
  const j = await checked('/api/shipping-plans/' + q.id + '/queue', 'POST', {});
  const job = await tenantTx(
    DEMO_TENANT,
    async (c) =>
      (
        await c.query("UPDATE jobs SET state='running',lease_token=$2 WHERE id=$1 RETURNING *", [
          j.job_id,
          randomUUID(),
        ])
      ).rows[0],
  );
  job.lease_token = randomUUID();
  await processShipping(job, { transport });
  assert.equal(calls.length, 0);
  assert.equal((await plan(q.id)).phase, 'ready');
});
test('worker dispatches local example with no external requests; simulated tracking is labelled', async () => {
  const { o, plan: q } = await setup('sandbox', true);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("UPDATE jobs SET run_at=now()+interval '1 day' WHERE state='pending'"),
  );
  await checked('/api/shipping-plans/' + q.id + '/queue', 'POST', {});
  await tick({ transport });
  assert.equal((await plan(q.id)).state, 'quoted');
  const p = await buy(q.id);
  assert.equal(p.result.scope, 'local_simulation');
  await checked('/api/shipping-plans/' + q.id + '/dispatch', 'POST', {});
  const t = await checked('/api/shipments/' + p.shipment_id + '/tracking', 'POST', {
    demo_status: 'delivered',
  });
  assert.equal(t.scope, 'local_simulation');
  assert.equal((await checked('/api/orders/' + o.id)).status, 'shipped');
  assert.equal(calls.length, 0);
});
test('rate parsing is exact and bounded; binary label size is bounded', async () => {
  assert.equal(rateMinor('12.01'), 1201);
  assert.equal(rateMinor(null), null);
  assert.throws(() => rateMinor('1.001'));
  const client = new InPost(
    'sandbox',
    { access_token: 'fixture' },
    async () =>
      new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'application/pdf' },
      }),
  );
  await assert.rejects(client.label('1'), /zbyt duża/);
});
test('revoked operator role stops queued provider writes', async () => {
  const { plan: q } = await setup('sandbox', false, operator),
    j = await checked('/api/shipping-plans/' + q.id + '/queue', 'POST', {}, operator),
    uid = (await checked('/api/auth/me', 'GET', undefined, operator)).user.id;
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    uid,
  ]);
  try {
    await run(j.job_id);
    assert.equal((await plan(q.id)).state, 'failed');
    assert.equal(calls.length, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      uid,
    ]);
  }
});
test('failed uncertain purchase can be explicitly reconciled without another buy', async () => {
  const { plan: q } = await setup();
  await quote(q.id);
  lostBuy = true;
  const p = await buy(q.id);
  await tenantTx(DEMO_TENANT, async (c) => {
    await c.query("UPDATE jobs SET state='failed' WHERE id=$1", [p.job_id]);
    await c.query("UPDATE shipping_plans SET state='failed' WHERE id=$1", [q.id]);
  });
  assert.equal((await req('/api/shipping-plans/' + q.id + '/cancel', 'POST', {})).statusCode, 409);
  await run((await checked('/api/shipping-plans/' + q.id + '/reconcile', 'POST', {})).job_id);
  assert.equal((await plan(q.id)).state, 'ready');
  assert.equal(count('/buy', 'POST'), 1);
});
test('post-purchase price discrepancy is surfaced and never charged again', async () => {
  const { plan: q } = await setup();
  await quote(q.id);
  beforeRemoteBuy = async () => {
    for (const r of store.values()) r.offers[0].rate = '99.99';
  };
  const p = await buy(q.id);
  assert.equal(p.phase, 'buy_started');
  assert.equal(p.state, 'failed');
  assert.match(p.error, /Cena.*po zakupie/);
  assert.equal(p.shipment_id, null);
  await run((await checked('/api/shipping-plans/' + q.id + '/reconcile', 'POST', {})).job_id);
  assert.equal((await plan(q.id)).state, 'failed');
  assert.equal(count('/buy', 'POST'), 1);
});
