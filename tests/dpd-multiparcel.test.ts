import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { processDpd, dpdInput, verifiedDpdLabel } from '../server/dpd-shipping';
import { failShipping } from '../server/shipping';
import { Problem } from '../server/errors';
assert.equal(process.env.DYNA_TEST, 'true');
// DPD multiparcel: one consignment (one package, one shipments row) with N parcels
// sharing the package reference. Fake transport only; no real carrier traffic.
let app: Awaited<ReturnType<typeof buildApp>>, cookie: string, other: string, warehouse: string;
const calls: any[] = [],
  remote = new Map<string, string[]>();
let seq = 10000,
  lostCreate = false,
  partialCreate = false,
  partialLabel = false;
const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status });
const pdf = Buffer.from('%PDF-1.4\nmultiparcel-label').toString('base64');
function labels(reference: string, waybills: string[]) {
  return {
    status: 'OK',
    session: {
      statusInfo: { status: 'OK' },
      packages: [
        {
          statusInfo: { status: 'OK' },
          parcels: waybills.map((waybill) => ({ statusInfo: { status: 'OK' }, reference, waybill })),
        },
      ],
    },
    documentData: pdf,
    traceId: randomUUID(),
  };
}
const transport = async (url: string, init: RequestInit) => {
  const operation = new URL(url).pathname.split('/').at(-1)!,
    body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, method: init.method ?? 'GET', body, operation });
  if (operation === 'postalCode') return json({ status: 'OK', traceId: randomUUID() });
  if (operation === 'generatePackagesNumbers') {
    const pkg = body.packages[0],
      reference = pkg.reference;
    assert.equal(body.packages.length, 1);
    assert(pkg.parcels.every((s: any) => s.reference === reference));
    const waybills = pkg.parcels.map(() => '00008891' + String(seq++) + 'Q');
    if (partialCreate) {
      remote.set(reference, waybills.slice(0, -1));
      return json({
        status: 'INCORRECT_DATA',
        packages: [
          {
            status: 'INCORRECT_DATA',
            reference,
            parcels: waybills.map((waybill: string, i: number) =>
              i < waybills.length - 1
                ? { status: 'OK', reference, waybill }
                : { status: 'INCORRECT_DATA', reference, waybill: null },
            ),
          },
        ],
      });
    }
    remote.set(reference, waybills);
    if (lostCreate) {
      lostCreate = false;
      throw new Problem(502, 'Lost response');
    }
    return json({
      status: 'OK',
      sessionId: 20000,
      packages: [
        {
          status: 'OK',
          reference,
          parcels: waybills.map((waybill: string) => ({ status: 'OK', reference, waybill })),
        },
      ],
    });
  }
  assert.equal(operation, 'generateSpedLabels');
  const reference = body.labelSearchParams.session.packages[0].parcels[0].reference;
  const found = remote.get(reference);
  if (!found) return json({ status: 'NOT_FOUND', traceId: randomUUID() });
  return json(labels(reference, partialLabel ? found.slice(0, -1) : found));
};
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: auth } });
async function checked(url: string, method: any = 'GET', payload?: any, auth = cookie) {
  const r = await req(url, method, payload, auth);
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
}
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
  remote.clear();
  lostCreate = partialCreate = partialLabel = false;
});
const party = {
  name: 'QA DPD',
  address: 'Testowa 1',
  city: 'Warszawa',
  postalCode: '01-354',
  phone: '500600700',
  email: 'qa@example.test',
};
async function packed() {
  const product = await checked('/api/products', 'POST', {
    sku: 'DPDM-' + randomUUID().slice(0, 10),
    name: 'DPD multiparcel synthetic',
    price: 5000,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 10,
  });
  const order = await checked('/api/orders', 'POST', {
    customer_name: 'QA DPD',
    payment_mode: 'cod',
    email: party.email,
    warehouse_id: warehouse,
    address: {
      street: party.address,
      city: party.city,
      postal_code: party.postalCode,
      country: 'PL',
      phone: party.phone,
    },
    items: [{ product_id: product.id, quantity: 2 }],
  });
  const status = (s: string) =>
    legacySerialOrderStatusPayload(
      (orderPath) => checked(orderPath, 'GET', undefined),
      '/api/orders/' + order.id + '/status',
      { status: s },
    );
  await checked('/api/orders/' + order.id + '/status', 'PATCH', await status('picking'));
  for (let n = 0; n < 2; n++)
    await checked('/api/orders/' + order.id + '/scan', 'POST', { code: product.sku });
  await checked('/api/orders/' + order.id + '/status', 'PATCH', await status('packed'));
  return { product, order: await checked('/api/orders/' + order.id) };
}
async function channel() {
  return (
    await checked('/api/integrations', 'POST', {
      provider: 'dpd',
      name: 'DPD multiparcel test',
      mode: 'sandbox',
      credentials: { username: 'fixture', password: 'fixture-password' },
      settings: { master_fid: '1495' },
    })
  ).id;
}
const extra = [
  { weight: 2.5, dimensions: { length: 30, width: 20, height: 15 } },
  { weight: 0.75, dimensions: { length: 10, width: 10, height: 10 } },
];
const input = (ch: string, additional_parcels: any[] = extra) => ({
  channel_id: ch,
  sender: party,
  receiver: party,
  weight: 1.25,
  dimensions: { length: 20, width: 15, height: 10 },
  content: 'Test',
  cod: 10000,
  insurance: 10000,
  additional_parcels,
});
async function setup(simulation = false) {
  const { product, order } = await packed();
  const ch = simulation
    ? (await checked('/api/dpd-shipping/example', 'POST', {})).channel_id
    : await channel();
  const preview = await checked(
    '/api/orders/' + order.id + '/dpd-shipping/preview',
    'POST',
    input(ch),
  );
  return { product, order, ch, preview };
}
const plan = (id: string) =>
  tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [id])).rows[0],
  );
const queue = (id: string) =>
  checked('/api/dpd-shipping/' + id + '/queue', 'POST', {
    confirm_external: true,
    ack_contract_rate: true,
  });
async function run(id: string, last = false) {
  if (last) await pool.query('UPDATE jobs SET attempts=max_attempts-1 WHERE id=$1', [id]);
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
  try {
    await processDpd(job, { transport });
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    await failShipping(job, e);
  }
}
const countCreate = () => calls.filter((c) => c.operation === 'generatePackagesNumbers').length;
const countLabels = () => calls.filter((c) => c.operation === 'generateSpedLabels').length;
const shipmentRows = async (order: string) =>
  (await pool.query('SELECT * FROM shipments WHERE tenant_id=$1 AND order_id=$2', [DEMO_TENANT, order]))
    .rows;
const parcelsOf = (waybills: string[]) => waybills.map((waybill, i) => ({ index: i + 1, waybill }));

test('DPD multiparcel preview, one consignment, per-parcel waybills and cached label', async () => {
  const f = await setup();
  assert.equal(calls.length, 0);
  const pkg = f.preview.payload.packages[0];
  assert.equal(f.preview.payload.packages.length, 1);
  assert.equal(pkg.parcels.length, 3);
  assert(pkg.parcels.every((s: any) => s.reference === pkg.reference));
  assert.deepEqual(
    pkg.parcels.map((s: any) => [s.weight, s.sizeX, s.sizeY, s.sizeZ]),
    [
      [1.25, 20, 15, 10],
      [2.5, 30, 20, 15],
      [0.75, 10, 10, 10],
    ],
  );
  await run((await queue(f.preview.id)).job_id);
  const p = await plan(f.preview.id),
    waybills = remote.get(pkg.reference)!;
  assert.equal(p.state, 'ready', p.error ?? 'Multiparcel plan must be ready');
  assert.equal(countCreate(), 1);
  assert.equal(new Set(waybills).size, 3);
  assert.deepEqual(p.result.parcels, parcelsOf(waybills));
  assert.equal(p.result.tracking_number, waybills[0]);
  assert.equal(p.result.waybill, waybills[0]);
  assert.equal(p.remote_id, waybills[0]);
  const rows = await shipmentRows(f.order.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tracking_number, waybills[0]);
  const list = await checked('/api/orders/' + f.order.id + '/shipping');
  assert.deepEqual(list.data[0].result.parcels, parcelsOf(waybills));
  assert.equal(list.data[0].result.label_base64, undefined);
  const before = calls.length;
  const r = await req('/api/shipments/' + p.shipment_id + '/label');
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'application/pdf');
  assert.equal(r.rawPayload.toString(), Buffer.from(pdf, 'base64').toString());
  assert.equal(calls.length, before);
});

test('DPD multiparcel local simulation lists every parcel without provider traffic', async () => {
  const f = await setup(true);
  await run((await queue(f.preview.id)).job_id);
  const p = await plan(f.preview.id);
  assert.equal(p.state, 'ready', p.error ?? 'Simulation must be ready');
  assert.equal(p.result.parcels.length, 3);
  assert.equal(new Set(p.result.parcels.map((s: any) => s.waybill)).size, 3);
  assert.equal(p.result.tracking_number, p.result.parcels[0].waybill);
  assert.equal((await shipmentRows(f.order.id)).length, 1);
  assert.equal(calls.length, 0);
});

test('DPD multiparcel re-queue is idempotent and a lost create recovers all waybills by labels', async () => {
  const f = await setup(),
    q = await queue(f.preview.id);
  assert.equal((await queue(f.preview.id)).job_id, q.job_id);
  lostCreate = true;
  await run(q.job_id, true);
  let p = await plan(f.preview.id);
  assert.equal(p.state, 'failed');
  assert.equal(p.phase, 'create_started');
  assert.equal(p.shipment_id, null);
  const retry = await checked('/api/dpd-shipping/' + f.preview.id + '/reconcile', 'POST', {});
  await run(retry.job_id);
  p = await plan(f.preview.id);
  const waybills = remote.get(p.payload.packages[0].reference)!;
  assert.equal(p.state, 'ready', p.error ?? 'Recovered multiparcel plan must be ready');
  assert.deepEqual(p.result.parcels, parcelsOf(waybills));
  assert.equal(p.result.tracking_number, waybills[0]);
  assert.equal(countCreate(), 1);
  assert.equal((await shipmentRows(f.order.id)).length, 1);
});

test('DPD multiparcel partial confirmation is never accepted and reconcile never repeats create', async () => {
  const f = await setup(),
    q = await queue(f.preview.id);
  partialCreate = true;
  await run(q.job_id, true);
  let p = await plan(f.preview.id);
  assert.equal(p.state, 'failed');
  assert.equal(p.phase, 'create_started');
  assert.equal(p.remote_id, null);
  assert.equal(p.shipment_id, null);
  assert.equal((await shipmentRows(f.order.id)).length, 0);
  // DPD holds two of three parcels for this reference: the label read cannot prove the consignment.
  const retry = await checked('/api/dpd-shipping/' + f.preview.id + '/reconcile', 'POST', {});
  await run(retry.job_id, true);
  p = await plan(f.preview.id);
  assert.notEqual(p.state, 'ready');
  assert.equal(p.shipment_id, null);
  assert.match(p.error, /jednoznacznej etykiety/);
  assert.equal(countCreate(), 1);
  assert.equal(countLabels(), 1);
  assert.equal((await shipmentRows(f.order.id)).length, 0);
});

test('DPD multiparcel label with fewer parcels is refused until the full set is returned', async () => {
  const f = await setup(),
    q = await queue(f.preview.id);
  lostCreate = true;
  await run(q.job_id);
  partialLabel = true;
  await run(q.job_id);
  let p = await plan(f.preview.id);
  assert.equal(p.shipment_id, null);
  assert.equal(p.remote_id, null);
  assert.match(p.error, /jednoznacznej etykiety/);
  partialLabel = false;
  await run(q.job_id);
  p = await plan(f.preview.id);
  assert.equal(p.state, 'ready', p.error ?? 'Full label set must recover');
  assert.equal(p.result.parcels.length, 3);
  assert.equal(countCreate(), 1);
  const reference = 'DYNA-' + randomUUID(),
    w = ['0000889101001Q', '0000889101002Q', '0000889101003Q'];
  assert.throws(() => verifiedDpdLabel(labels(reference, w.slice(0, 2)), reference, null, 3));
  assert.throws(() => verifiedDpdLabel(labels(reference, [w[0], w[0], w[1]]), reference, null, 3));
  assert.throws(() =>
    verifiedDpdLabel(labels(reference, [w[0], w[1], '0000889109999Q']), reference, w),
  );
  assert.deepEqual(
    verifiedDpdLabel(labels(reference, [w[2], w[0], w[1]]), reference, w).waybills,
    w,
  );
});

test('DPD multiparcel plan is invisible to another tenant', async () => {
  const f = await setup();
  for (const [url, method] of [
    ['/api/dpd-shipping/' + f.preview.id + '/queue', 'POST'],
    ['/api/dpd-shipping/' + f.preview.id + '/reconcile', 'POST'],
    ['/api/orders/' + f.order.id + '/shipping', 'GET'],
  ])
    assert.equal(
      (await req(url, method, method === 'POST' ? { confirm_external: true, ack_contract_rate: true } : undefined, other))
        .statusCode,
      404,
      url,
    );
  await run((await queue(f.preview.id)).job_id);
  const p = await plan(f.preview.id);
  assert.equal(p.state, 'ready');
  assert.equal(
    (await req('/api/shipments/' + p.shipment_id + '/label', 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(calls.filter((c) => c.operation === 'generateSpedLabels').length, 1);
});

test('DPD multiparcel refuses packing-bound previews with extra parcels and more than ten parcels', async () => {
  const b = input(randomUUID());
  assert.equal(dpdInput.safeParse(b).success, true);
  assert.deepEqual(dpdInput.parse({ ...b, additional_parcels: undefined }).additional_parcels, []);
  assert.equal(
    dpdInput.safeParse({ ...b, additional_parcels: Array(9).fill(extra[0]) }).success,
    true,
  );
  const packing = { receipt_id: randomUUID(), scope_hash: 'a'.repeat(64), profile_revision: '1' };
  const bound = dpdInput.safeParse({ ...b, packing });
  assert.equal(bound.success, false);
  assert.match(JSON.stringify(bound.error), /jedną paczkę/);
  assert.equal(dpdInput.safeParse({ ...b, packing, additional_parcels: [] }).success, true);
  for (const bad of [
    Array(10).fill(extra[0]),
    [{ ...extra[0], weight: 31.51 }],
    [{ ...extra[0], weight: 1.001 }],
    [{ ...extra[0], dimensions: { ...extra[0].dimensions, length: 176 } }],
  ])
    assert.equal(dpdInput.safeParse({ ...b, additional_parcels: bad }).success, false);
  const { order } = await packed(),
    ch = await channel();
  for (const body of [
    input(ch, Array(10).fill(extra[0])),
    { ...input(ch), packing },
  ]) {
    const r = await req('/api/orders/' + order.id + '/dpd-shipping/preview', 'POST', body);
    assert.ok([400, 422].includes(r.statusCode), r.body);
  }
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM shipping_plans WHERE order_id=$1', [order.id]))
      .rows[0].n,
    0,
  );
});
