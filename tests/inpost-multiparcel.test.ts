import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processShipping, failShipping } from '../server/shipping';
import { Problem } from '../server/errors';
assert.equal(process.env.DYNA_TEST, 'true');
// InPost ShipX multiparcel: one courier shipment with N parcels, one shipments row,
// per-parcel tracking in shipping_plans.result. Fake ShipX transport, no real carrier calls.
let app: Awaited<ReturnType<typeof buildApp>>, cookie: string, other: string, warehouse: string;
const calls: { url: string; method: string; body: any }[] = [],
  store = new Map<string, any>();
let next = 40000,
  lostCreate = false,
  dropParcel = false;
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status });
const transport = async (url: string, init: RequestInit) => {
  const u = new URL(url),
    method = init.method ?? 'GET',
    body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, method, body });
  if (u.pathname.endsWith('/label'))
    return new Response('%PDF-1.4\nmultiparcel', { headers: { 'content-type': 'application/pdf' } });
  if (u.pathname.includes('/organizations/')) {
    if (method === 'GET') return json({ items: [...store.values()], count: store.size });
    assert.equal(method, 'POST');
    const sid = String(next++),
      parcels = (dropParcel ? body.parcels.slice(0, -1) : body.parcels).map((x: any, k: number) => ({
        ...x,
        id: String(900000 + Number(sid) * 10 + k),
        tracking_number: null,
      })),
      r = {
        ...body,
        parcels,
        id: sid,
        status: 'offers_prepared',
        tracking_number: null,
        cod: body.cod ?? null,
        insurance: body.insurance ?? null,
        offers: [
          {
            id: next++,
            service: { id: body.parcels[0].template ? 'inpost_locker_standard' : 'inpost_courier_standard' },
            status: 'available',
            rate: '29.99',
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
  if (method === 'POST') {
    assert.equal(body.offer_id, r.offers[0].id);
    r.selected_offer = { ...r.offers[0], status: 'selected' };
    r.service = r.offers[0].service.id;
    r.status = 'confirmed';
    r.tracking_number = '630000' + sid;
    r.parcels = r.parcels.map((x: any, k: number) => ({ ...x, tracking_number: '63000' + sid + k }));
    return json(r);
  }
  return json(r);
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
  warehouse = (await checked('/api/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => {
  calls.length = 0;
  store.clear();
  lostCreate = dropParcel = false;
});
async function packed() {
  const p = await checked('/api/products', 'POST', {
    sku: 'MPAR-' + randomUUID().slice(0, 10),
    name: 'Multipaczka QA',
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
    address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' },
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
  const status = async (s: string) =>
    checked('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((x) => checked(x, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: s }));
  await status('picking');
  await checked('/api/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  await checked('/api/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  await status('packed');
  return o;
}
async function channel(simulation = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'inpost','InPost multipaczka QA','sandbox',$3,$4)",
      [id, DEMO_TENANT, encrypt({ access_token: 'fixture' }), JSON.stringify({ organization_id: '1', simulation })],
    ),
  );
  return id;
}
const extra = [
  { dimensions: { length: 300, width: 200, height: 100 }, weight: 2.5 },
  { dimensions: { length: 500, width: 400, height: 300 }, weight: 7 },
];
const courier = (ch: string, additional_parcels: any[] = extra) => ({
  channel_id: ch,
  service: 'inpost_courier_standard',
  receiver: {
    first_name: 'Odbiorca',
    last_name: 'QA',
    email: 'shipping@example.test',
    phone: '500600700',
    address: { street: 'Testowa', building_number: '1', city: 'Warszawa', post_code: '00-001' },
  },
  dimensions: { length: 400, width: 300, height: 200 },
  weight: 1,
  cod: 10000,
  insurance: 10000,
  additional_parcels,
});
async function setup(simulation = false) {
  const o = await packed(),
    ch = await channel(simulation),
    plan = await checked('/api/orders/' + o.id + '/shipping/preview', 'POST', courier(ch));
  return { o, ch, plan };
}
const plan = (id: string) =>
  tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [id])).rows[0]);
const shipments = (orderId: string) =>
  tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM shipments WHERE order_id=$1', [orderId])).rows);
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
}
async function quote(id: string) {
  await run((await checked('/api/shipping-plans/' + id + '/queue', 'POST', {})).job_id);
  return plan(id);
}
async function buy(id: string) {
  const p = await plan(id);
  const q = await checked('/api/shipping-plans/' + id + '/buy', 'POST', {
    offer_id: p.offers[0].id,
    confirm_cost: true,
    ack_unknown_rate: true,
  });
  await run(q.job_id);
  return plan(id);
}
const count = (suffix: string, method: string) =>
  calls.filter((x) => new URL(x.url).pathname.endsWith(suffix) && x.method === method).length;

test('courier multiparcel: 3 parcels in one ShipX shipment, one shipments row, per-parcel tracking, one label', async () => {
  const { o, plan: q } = await setup();
  assert.equal(q.payload.parcels.length, 3);
  assert.deepEqual(
    q.payload.parcels.map((x: any) => [x.dimensions.length, x.dimensions.unit, x.weight.amount]),
    [[400, 'mm', 1], [300, 'mm', 2.5], [500, 'mm', 7]],
  );
  let s = await quote(q.id);
  assert.equal(s.state, 'quoted', s.error);
  assert.equal(calls.find((x) => x.method === 'POST')!.body.parcels.length, 3);
  s = await buy(q.id);
  assert.equal(s.state, 'ready', s.error);
  const rows = await shipments(o.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tracking_number, '630000' + s.remote_id);
  assert.equal(s.result.tracking_number, '630000' + s.remote_id);
  assert.equal(s.result.parcels.length, 3);
  assert.deepEqual(s.result.parcels.map((x: any) => x.index), [0, 1, 2]);
  assert.ok(s.result.parcels.every((x: any, k: number) => x.tracking_number === '63000' + s.remote_id + k && x.id));
  const listed = (await checked('/api/orders/' + o.id + '/shipping')).data.find((x: any) => x.id === q.id);
  assert.equal(listed.result.parcels.length, 3);
  const pdf = await req('/api/shipments/' + s.shipment_id + '/label');
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.ok(pdf.body.startsWith('%PDF-'));
  assert.equal(count('/label', 'GET'), 1);
});
test('local simulation mirrors all parcels with tracking numbers after buy', async () => {
  const { plan: q } = await setup(true);
  await quote(q.id);
  const s = await buy(q.id);
  assert.equal(s.state, 'ready', s.error);
  assert.equal(s.result.parcels.length, 3);
  assert.ok(s.result.parcels.every((x: any, k: number) => x.tracking_number === 'DEMO-' + q.id.slice(0, 12) + '-' + (k + 1)));
  assert.equal(calls.length, 0);
});
test('idempotent queue and lost create response recovered by history without a second POST', async () => {
  const { plan: q } = await setup();
  lostCreate = true;
  const first = await checked('/api/shipping-plans/' + q.id + '/queue', 'POST', {});
  const again = await checked('/api/shipping-plans/' + q.id + '/queue', 'POST', {});
  assert.equal(again.job_id, first.job_id);
  await run(first.job_id);
  assert.equal((await plan(q.id)).phase, 'create_started');
  await run(first.job_id);
  const s = await plan(q.id);
  assert.equal(s.state, 'quoted', s.error);
  assert.equal(count('/organizations/1/shipments', 'POST'), 1);
  assert.equal(count('/organizations/1/shipments', 'GET'), 1);
  assert.equal((await buy(q.id)).result.parcels.length, 3);
});
test('ShipX returning 2 of 3 parcels is refused: no buy, no shipments row, reconcile never POSTs again', async () => {
  const { o, plan: q } = await setup();
  dropParcel = true;
  const s = await quote(q.id);
  assert.equal(s.state, 'failed');
  assert.match(s.error, /Liczba paczek/);
  assert.equal(count('/buy', 'POST'), 0);
  assert.equal((await shipments(o.id)).length, 0);
  await run((await checked('/api/shipping-plans/' + q.id + '/reconcile', 'POST', {})).job_id);
  assert.equal((await plan(q.id)).state, 'failed');
  assert.equal(count('/organizations/1/shipments', 'POST'), 1);
  assert.equal((await shipments(o.id)).length, 0);
});
test('one differing parcel weight is refused before purchase', async () => {
  const { o, plan: q } = await setup();
  const p = await quote(q.id);
  store.get(p.remote_id).parcels[2].weight.amount = 3;
  assert.equal((await buy(q.id)).state, 'failed');
  assert.equal(count('/buy', 'POST'), 0);
  assert.equal((await shipments(o.id)).length, 0);
});
test('tenant isolation: another tenant cannot read the plan or its label', async () => {
  const { o, plan: q } = await setup();
  await quote(q.id);
  const s = await buy(q.id);
  assert.equal((await req('/api/orders/' + o.id + '/shipping', 'GET', undefined, other)).statusCode, 404);
  assert.equal((await req('/api/shipping-plans/' + q.id + '/queue', 'POST', {}, other)).statusCode, 404);
  assert.equal((await req('/api/shipments/' + s.shipment_id + '/label', 'GET', undefined, other)).statusCode, 404);
});
test('refusals: locker with extra parcels, packing binding with extra parcels, more than 10 parcels, oversize extra parcel', async () => {
  const o = await packed(),
    ch = await channel(),
    url = '/api/orders/' + o.id + '/shipping/preview';
  const locker = await req(url, 'POST', {
    ...courier(ch),
    service: 'inpost_locker_standard',
    target_point: 'WAW01M',
    template: 'small',
  });
  assert.equal(locker.statusCode, 422);
  assert.match(locker.body, /Paczkomat przyjmuje jedną paczkę/);
  const packing = await req(url, 'POST', {
    ...courier(ch),
    packing: { receipt_id: randomUUID(), scope_hash: 'a'.repeat(64), profile_revision: '1' },
  });
  assert.equal(packing.statusCode, 422);
  assert.match(packing.body, /jednej paczki/);
  const many = await req(url, 'POST', courier(ch, Array.from({ length: 10 }, () => extra[0])));
  assert.equal(many.statusCode, 422);
  assert.match(many.body, /najwyżej 10 paczek/);
  const big = await req(url, 'POST', courier(ch, [{ dimensions: { length: 1200, width: 1200, height: 100 }, weight: 1 }]));
  assert.equal(big.statusCode, 422);
  assert.equal(
    (await req(url, 'POST', courier(ch, Array.from({ length: 9 }, () => extra[0])))).statusCode,
    200,
  );
});
