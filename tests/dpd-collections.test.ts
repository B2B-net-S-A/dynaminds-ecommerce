import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { scheduleDpdPickupsDue, scheduledPickupDate } from '../server/dpd-pickup-schedules';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, tenantTx, migrate } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processDpd } from '../server/dpd-shipping';
import {
  processCollection,
  failCollection,
  pickupDate,
  verifiedProtocol,
  collectionInput,
} from '../server/dpd-collections';
import { tick } from '../server/worker';
import { Problem } from '../server/errors';
assert.equal(process.env.DYNA_TEST, 'true');
let app: any, cookie: string, viewer: string, other: string, operator: string, warehouse: string;
let lost = false,
  lostCancel = false,
  bad = false,
  hook: ((op: string) => Promise<void>) | undefined,
  availabilityReply: (() => Response) | undefined;
const calls: any[] = [],
  waybills = new Map<string, string>();
const pdf = Buffer.from('%PDF-1.4\nprotocol-fixture').toString('base64');
const reply = (v: any) => new Response(JSON.stringify(v));
function protocol(packages: any[]) {
  return {
    status: 'OK',
    documentData: bad ? 'bm90LXBkZg==' : pdf,
    session: {
      statusInfo: { status: 'OK' },
      packages: packages.map((p) => ({
        statusInfo: { status: 'OK' },
        parcels: p.parcels.map((p: any) => ({ ...p, statusInfo: { status: 'OK' } })),
      })),
    },
  };
}
const transport = async (url: string, init: RequestInit) => {
  const u = new URL(url),
    op = u.pathname.split('/').at(-1)!;
  const b = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ op, method: init.method ?? 'GET', body: b, url, headers: init.headers });
  await hook?.(op);
  assert.equal((init.headers as any)['x-dpd-fid'], '1495');
  if (op === 'postalCode') return reply({ status: 'OK' });
  if (op === 'courierOrderAvailability')
    return availabilityReply?.() ?? reply({ status: 'OK', ranges: [{ range: '09:00-17:00', offset: 360 }] });
  if (op === 'generatePackagesNumbers') {
    const p = b.packages[0];
    const waybill = '00008891' + String(waybills.size + 10000) + 'Q';
    waybills.set(p.reference, waybill);
    return reply({
      status: 'OK',
      packages: [
        {
          status: 'OK',
          reference: p.reference,
          parcels: [{ status: 'OK', reference: p.reference, waybill }],
        },
      ],
    });
  }
  if (op === 'generateSpedLabels')
    return reply(
      protocol(
        b.labelSearchParams.session.packages.map((p: any) => ({
          ...p,
          parcels: p.parcels.map((s: any) => ({ ...s, waybill: waybills.get(s.reference) })),
        })),
      ),
    );
  if (op === 'generateProtocol') return reply(protocol(b.protocolSearchParams.session.packages));
  assert.equal(op, 'packagesPickupCall');
  if (init.method === 'DELETE') {
    assert(u.searchParams.get('orderNumber'));
    assert(u.searchParams.get('checkSum'));
    if (lostCancel) {
      lostCancel = false;
      throw new Problem(502, 'Lost cancel response');
    }
    return reply({ status: { status: 'OK' } });
  }
  assert.equal(init.method, 'POST');
  if (lost) {
    lost = false;
    throw new Problem(502, 'Lost create response');
  }
  return reply(
    bad
      ? { status: { status: 'OK' }, orderNumber: b.orderNumber }
      : { status: { status: 'OK' }, orderNumber: b.orderNumber, checkSum: '123456789012' },
  );
};
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: auth } });
async function api(url: string, method: any = 'GET', body?: any, auth = cookie) {
  const r = await req(url, method, body, auth);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const login = async (email: string) =>
    (await req('/api/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
      'set-cookie'
    ]
      .toString()
      .split(';')[0];
  cookie = await login('admin@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await api('/api/warehouses')).data[0].id;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
beforeEach(() => {
  calls.length = 0;
  lost = lostCancel = bad = false;
  hook = availabilityReply = undefined;
});
const party = {
  name: 'QA DPD',
  address: 'Testowa 1',
  city: 'Warszawa',
  postalCode: '01354',
  phone: '500600700',
  email: 'qa@example.test',
  countryCode: 'PL',
};
async function claimJob(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',locked_at=now(),lease_token=$2,attempts=attempts+1 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function fixture(count = 1, simulation = false) {
  const ch = simulation
    ? (await api('/api/dpd-shipping/example', 'POST', {})).channel_id
    : (
        await api('/api/integrations', 'POST', {
          provider: 'dpd',
          name: 'Collection fixture',
          mode: 'sandbox',
          credentials: { username: 'fixture', password: 'fixture-password' },
          settings: { master_fid: '1495' },
        })
      ).id;
  const ids: string[] = [],
    orders: any[] = [],
    products: any[] = [];
  for (let i = 0; i < count; i++) {
    const p = await api('/api/products', 'POST', {
      sku: 'COL-' + randomUUID().slice(0, 12),
      name: 'Paczka QA',
      price: 5000,
      vat: 23,
      warehouse_id: warehouse,
      quantity: 12,
    });
    products.push(p);
    const o = await api('/api/orders', 'POST', {
      customer_name: 'QA',
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
      items: [{ product_id: p.id, quantity: 2 }],
    });
    orders.push(o);
    await api('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'picking' }));
    for (let n = 0; n < 2; n++) await api('/api/orders/' + o.id + '/scan', 'POST', { code: p.sku });
    await api('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'packed' }));
    const plan = await api('/api/orders/' + o.id + '/dpd-shipping/preview', 'POST', {
      channel_id: ch,
      sender: party,
      receiver: party,
      weight: 1.25 + i,
      dimensions: { length: 20 + i, width: 15, height: 10 },
      content: 'Test',
      cod: 10000,
      insurance: 10000,
    });
    const q = await api('/api/dpd-shipping/' + plan.id + '/queue', 'POST', {
      confirm_external: true,
      ack_contract_rate: true,
    });
    await processDpd(await claimJob(q.job_id), { transport });
    ids.push(plan.id);
  }
  return { ch, ids, orders, products };
}
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const input = (f: any, kind = 'pickup', key = randomUUID()) =>
  kind === 'pickup'
    ? { kind, client_key: key, plan_ids: f.ids, date: tomorrow(), from: '09:00', to: '17:00' }
    : { kind, client_key: key, plan_ids: f.ids };
const preview = (f: any, kind = 'pickup') =>
  api('/api/integrations/' + f.ch + '/dpd-collections', 'POST', input(f, kind));
const queued = (id: string) =>
  api('/api/dpd-collections/' + id + '/queue', 'POST', { confirm_external: true });
async function row(id: string) {
  return tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM dpd_collections WHERE id=$1', [id])).rows[0],
  );
}
async function run(id: string) {
  const j = await claimJob(id);
  try {
    await processCollection(j, { transport });
  } catch (e) {
    await failCollection(j, e);
  }
  return j;
}
const pickups = () => calls.filter((c) => c.op === 'packagesPickupCall' && c.method === 'POST');
const deletes = () => calls.filter((c) => c.op === 'packagesPickupCall' && c.method === 'DELETE');
test('collection dates use Warsaw time and reject past, reversed and long windows', () => {
  const now = new Date('2026-10-04T10:00:00Z');
  assert.doesNotThrow(() => pickupDate('2026-10-04', '13:00', '14:00', now));
  for (const v of [
    ['2026-10-04', '11:00', '14:00'],
    ['2026-10-03', '13:00', '14:00'],
    ['2026-10-19', '13:00', '14:00'],
    ['2026-10-05', '14:00', '13:00'],
  ])
    assert.throws(() => pickupDate(v[0], v[1], v[2], now));
  assert.throws(() =>
    collectionInput.parse({
      kind: 'protocol',
      plan_ids: [randomUUID()],
      client_key: randomUUID(),
      date: '2026-10-05',
    }),
  );
});
test('pickup preview has no HTTP, sums packages and requires external consent; replay freezes original plan', async () => {
  const f = await fixture(2);
  calls.length = 0;
  const b = input(f);
  const p = await api('/api/integrations/' + f.ch + '/dpd-collections', 'POST', b);
  assert.equal(calls.length, 0);
  assert.equal(p.input.count, 2);
  assert.equal(p.input.weight, 3.5);
  assert.equal(p.payload.packagesForCollection.packagesParams.parcel.maxWeight, 2.25);
  assert.match(p.requested_number, /^AD1\d{11}$/);
  assert.equal((await api('/api/integrations/' + f.ch + '/dpd-collections', 'POST', b)).id, p.id);
  assert.equal(
    (await req('/api/integrations/' + f.ch + '/dpd-collections', 'POST', { ...b, to: '16:00' }))
      .statusCode,
    409,
  );
  assert.equal((await req('/api/dpd-collections/' + p.id + '/queue', 'POST', {})).statusCode, 422);
  await run((await queued(p.id)).job_id);
  const r = await row(p.id);
  assert.equal(r.state, 'ready');
  assert.equal(r.result.scope, 'external_sandbox_verified');
  assert.equal(pickups().length, 1);
  for (const product of f.products)
    assert.deepEqual(
      (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [product.id]))
        .rows[0],
      { on_hand: 12, reserved: 2 },
    );
});
test('concurrent previews and approvals claim one pickup; cancellation releases it once', async () => {
  const f = await fixture();
  const a = await preview(f),
    b = await preview(f);
  const q = await Promise.all([queued(a.id), queued(a.id)]);
  assert.equal(q[0].job_id, q[1].job_id);
  assert.equal(
    (await req('/api/dpd-collections/' + b.id + '/queue', 'POST', { confirm_external: true }))
      .statusCode,
    409,
  );
  await run(q[0].job_id);
  assert.equal((await req('/api/dpd-collections/' + a.id + '/cancel', 'POST', {})).statusCode, 422);
  const cancel = await api('/api/dpd-collections/' + a.id + '/cancel', 'POST', {
    confirm_external: true,
  });
  assert.equal(
    (await api('/api/dpd-collections/' + a.id + '/cancel', 'POST', { confirm_external: true }))
      .job_id,
    cancel.job_id,
  );
  await run(cancel.job_id);
  assert.equal((await row(a.id)).state, 'cancelled');
  assert.equal(deletes().length, 1);
  await run((await queued(b.id)).job_id);
  assert.equal(pickups().length, 2);
});
test('lost pickup response remains uncertain, rejects automatic second create and keeps claim', async () => {
  const f = await fixture(),
    p = await preview(f);
  lost = true;
  const j = await run((await queued(p.id)).job_id);
  assert.equal((await row(p.id)).state, 'uncertain');
  await pool.query("UPDATE dpd_collections SET state='queued' WHERE id=$1", [p.id]);
  await run(j.id);
  assert.equal(pickups().length, 1);
  assert.equal((await row(p.id)).state, 'uncertain');
  assert.equal(
    (await req('/api/dpd-collections/' + p.id + '/cancel', 'POST', { confirm_external: true }))
      .statusCode,
    409,
  );
  assert.equal(
    (await req('/api/dpd-collections/' + p.id + '/retry', 'POST', { confirm_external: true }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await req('/api/dpd-collections/' + (await preview(f)).id + '/queue', 'POST', {
        confirm_external: true,
      })
    ).statusCode,
    409,
  );
});
test('uncertain creation can be manually confirmed with evidence, never labelled API verified', async () => {
  const f = await fixture(),
    p = await preview(f);
  lost = true;
  await run((await queued(p.id)).job_id);
  const body = {
    outcome: 'created',
    evidence: 'Potwierdzono w testowym panelu dostawcy',
    confirmed: true,
    order_number: p.requested_number,
    checksum: '123456789012',
  };
  assert.equal(
    (await req('/api/dpd-collections/' + p.id + '/resolve', 'POST', body, operator)).statusCode,
    403,
  );
  await api('/api/dpd-collections/' + p.id + '/resolve', 'POST', body);
  const r = await row(p.id);
  assert.equal(r.state, 'ready');
  assert.equal(r.result.scope, 'manual_confirmation');
  assert.equal(pickups().length, 1);
  await run(
    (await api('/api/dpd-collections/' + p.id + '/cancel', 'POST', { confirm_external: true }))
      .job_id,
  );
  assert.equal((await row(p.id)).state, 'cancelled');
});
test('manual nonexistence and cancellation require explicit evidence and release only correct claims', async () => {
  const f = await fixture(),
    p = await preview(f);
  lost = true;
  await run((await queued(p.id)).job_id);
  assert.equal(
    (
      await req('/api/dpd-collections/' + p.id + '/resolve', 'POST', {
        outcome: 'not_created',
        evidence: 'No',
        confirmed: true,
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req('/api/dpd-collections/' + p.id + '/resolve', 'POST', {
        outcome: 'cancelled',
        evidence: 'Sprawdzono w panelu testowym',
        confirmed: true,
      })
    ).statusCode,
    422,
  );
  await api('/api/dpd-collections/' + p.id + '/resolve', 'POST', {
    outcome: 'not_created',
    evidence: 'Dostawca potwierdził brak zlecenia testowego',
    confirmed: true,
  });
  assert.equal((await row(p.id)).state, 'cancelled');
  await run((await queued((await preview(f)).id)).job_id);
});
test('lost cancellation is not repeated and manual still active cannot replace remote identity', async () => {
  const f = await fixture(),
    p = await preview(f);
  await run((await queued(p.id)).job_id);
  lostCancel = true;
  const j = await run(
    (await api('/api/dpd-collections/' + p.id + '/cancel', 'POST', { confirm_external: true }))
      .job_id,
  );
  assert.equal((await row(p.id)).state, 'uncertain');
  await pool.query("UPDATE dpd_collections SET state='cancel_queued' WHERE id=$1", [p.id]);
  await run(j.id);
  assert.equal(deletes().length, 1);
  const b = {
    outcome: 'still_active',
    evidence: 'DPD potwierdziło aktywne zlecenie w panelu',
    confirmed: true,
  };
  assert.equal(
    (
      await req('/api/dpd-collections/' + p.id + '/resolve', 'POST', {
        ...b,
        order_number: 'wrong',
      })
    ).statusCode,
    422,
  );
  await api('/api/dpd-collections/' + p.id + '/resolve', 'POST', b);
  assert.equal((await row(p.id)).state, 'ready');
});
test('protocol verifies exact parcel set and cached document is offline without stock dispatch', async () => {
  const f = await fixture(2),
    p = await preview(f, 'protocol');
  await run((await queued(p.id)).job_id);
  const r = await row(p.id);
  assert.equal(r.state, 'ready');
  const n = calls.length;
  const doc = await req('/api/dpd-collections/' + p.id + '/document');
  assert.equal(doc.statusCode, 200);
  assert.equal(doc.headers['content-type'], 'application/pdf');
  assert.equal(doc.headers['cache-control'], 'no-store');
  assert.equal(doc.rawPayload.toString(), Buffer.from(pdf, 'base64').toString());
  assert.equal(calls.length, n);
  const list = await api('/api/integrations/' + f.ch + '/dpd-collections');
  assert.equal(list.data[0].result.document_base64, undefined);
  assert.equal(list.data[0].checksum, undefined);
  for (const o of f.orders) assert.equal((await api('/api/orders/' + o.id)).status, 'packed');
});
test('bad or partial protocol cannot pass, retry generates only the same document request', async () => {
  const f = await fixture(2),
    p = await preview(f, 'protocol');
  bad = true;
  await run((await queued(p.id)).job_id);
  assert.equal((await row(p.id)).state, 'failed');
  assert.equal((await req('/api/dpd-collections/' + p.id + '/document')).statusCode, 404);
  bad = false;
  await run(
    (await api('/api/dpd-collections/' + p.id + '/retry', 'POST', { confirm_external: true }))
      .job_id,
  );
  assert.equal((await row(p.id)).state, 'ready');
  const expected = p.payload.protocolSearchParams.session.packages.flatMap((p: any) => p.parcels);
  assert.throws(() =>
    verifiedProtocol(
      protocol(p.payload.protocolSearchParams.session.packages.slice(0, 1)),
      expected,
    ),
  );
  const raw = protocol(p.payload.protocolSearchParams.session.packages);
  raw.session.packages[0].parcels[0].waybill = 'wrong';
  assert.throws(() => verifiedProtocol(raw, expected));
});
test('roles and RLS isolate previews, parcel lists, claims, cached PDF and manual resolutions', async () => {
  const f = await fixture(),
    p = await preview(f, 'protocol');
  assert.equal(
    (await req('/api/integrations/' + f.ch + '/dpd-collections', 'POST', input(f), viewer))
      .statusCode,
    403,
  );
  assert.equal(
    (await req('/api/integrations/' + f.ch + '/dpd-parcels', 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (
      await req(
        '/api/dpd-collections/' + p.id + '/queue',
        'POST',
        { confirm_external: true },
        other,
      )
    ).statusCode,
    404,
  );
  await run((await queued(p.id)).job_id);
  assert.equal(
    (await req('/api/dpd-collections/' + p.id + '/document', 'GET', undefined, other)).statusCode,
    404,
  );
  const res = await tenantTx(
    DEMO_TENANT,
    async (c) =>
      (await c.query('SELECT * FROM dpd_collections WHERE tenant_id<>$1', [DEMO_TENANT])).rowCount,
  );
  assert.equal(res, 0);
});
test('account replacement after POST fences acceptance and retains uncertain pickup', async () => {
  const f = await fixture(),
    p = await preview(f);
  hook = async (op) => {
    if (op === 'packagesPickupCall')
      await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
        f.ch,
        encrypt({ username: 'other', password: 'other' }),
      ]);
  };
  await run((await queued(p.id)).job_id);
  assert.equal((await row(p.id)).state, 'uncertain');
  assert.equal((await row(p.id)).remote_id, null);
  assert.equal(pickups().length, 1);
});
test('revoked role and expired lease stop transport before writing', async () => {
  const f = await fixture(),
    p = await preview(f);
  const q = await queued(p.id),
    job = await claimJob(q.job_id);
  await pool.query("UPDATE jobs SET locked_at=now()-interval '3 minutes' WHERE id=$1", [job.id]);
  await assert.rejects(() => processCollection(job, { transport }));
  assert.equal(pickups().length, 0);
  await failCollection(job, new Problem(409, 'Expired'));
  const p2 = await preview(f, 'protocol'),
    j2 = await claimJob((await queued(p2.id)).job_id);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    j2.payload.actor_id,
  ]);
  try {
    await assert.rejects(() => processCollection(j2, { transport }));
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      j2.payload.actor_id,
    ]);
  }
});
test('replaced lease after protocol response cannot commit or clobber replacement job', async () => {
  const f = await fixture(),
    p = await preview(f, 'protocol');
  hook = async (op) => {
    if (op === 'generateProtocol')
      await pool.query(
        'UPDATE jobs SET lease_token=$2 WHERE id=(SELECT job_id FROM dpd_collections WHERE id=$1)',
        [p.id, randomUUID()],
      );
  };
  await run((await queued(p.id)).job_id);
  const r = await row(p.id);
  assert.equal(r.state, 'queued');
  assert.equal(r.result, null);
});
test('dispatched parcels cannot be booked for pickup, mixed senders and stale previews fail before HTTP', async () => {
  const f = await fixture(2);
  await pool.query(
    "UPDATE shipping_plans SET input=jsonb_set(input,'{sender,name}','\"Other\"') WHERE id=$1",
    [f.ids[1]],
  );
  assert.equal(
    (await req('/api/integrations/' + f.ch + '/dpd-collections', 'POST', input(f))).statusCode,
    422,
  );
  f.ids = f.ids.slice(0, 1);
  const p = await preview(f);
  await api('/api/dpd-shipping/' + f.ids[0] + '/dispatch', 'POST', {});
  assert.equal(
    (await req('/api/dpd-collections/' + p.id + '/queue', 'POST', { confirm_external: true }))
      .statusCode,
    409,
  );
  assert.equal(pickups().length, 0);
});
test('local pickup/protocol/cancellation uses no provider, and worker dispatch handles collection job', async () => {
  const f = await fixture(1, true);
  calls.length = 0;
  const p = await preview(f);
  const q = await queued(p.id);
  await pool.query("UPDATE jobs SET run_at=now()-interval '1 day' WHERE id=$1", [q.job_id]);
  await tick({ transport });
  assert.equal((await row(p.id)).state, 'ready');
  assert.equal((await row(p.id)).result.scope, 'local_simulation');
  const d = await preview(f, 'protocol');
  await run((await queued(d.id)).job_id);
  assert.match((await req('/api/dpd-collections/' + d.id + '/document')).body, /PROTOKÓŁ TESTOWY/);
  await run((await api('/api/dpd-collections/' + p.id + '/cancel', 'POST', {})).job_id);
  assert.equal(calls.length, 0);
});
test('restore preview serves cached protocol and blocks external availability and mutations', async () => {
  const f = await fixture(),
    p = await preview(f, 'protocol');
  await run((await queued(p.id)).job_id);
  const restored = await buildApp({
    readOnly: true,
    integrationTransport: async () => {
      throw new Error('No external traffic');
    },
  });
  try {
    const login = await restored.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    });
    const headers = { cookie: login.headers['set-cookie']!.toString().split(';')[0] };
    assert.equal(
      (await restored.inject({ url: '/api/dpd-collections/' + p.id + '/document', headers }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await restored.inject({
          url: '/api/integrations/' + f.ch + '/dpd-availability?postal_code=01354',
          headers,
        })
      ).statusCode,
      423,
    );
    assert.equal(
      (
        await restored.inject({
          url: '/api/dpd-collections/' + p.id + '/cancel',
          method: 'POST',
          headers,
          payload: {},
        })
      ).statusCode,
      423,
    );
  } finally {
    await restored.close();
  }
});
test('courier availability sends exact authenticated DPD GET and returns only bounded parsed ranges', async () => {
  const ch = (
    await api('/api/integrations', 'POST', {
      provider: 'dpd',
      name: 'Availability fixture',
      mode: 'sandbox',
      credentials: { username: 'fixture', password: 'fixture-password' },
      settings: { master_fid: '1495' },
    })
  ).id;
  const path = '/api/integrations/' + ch + '/dpd-availability?postal_code=';
  availabilityReply = () =>
    reply({
      status: 'OK',
      ranges: [
        { range: '09:00-17:00', offset: 360 },
        { range: '10:00-14:00', offset: 0 },
      ],
      session: 'not-forwarded',
    });
  assert.deepEqual(await api(path + '01-354'), {
    scope: 'external_sandbox_verified',
    ranges: [
      { range: '09:00-17:00', offset: 360 },
      { range: '10:00-14:00', offset: 0 },
    ],
  });
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(calls[0].op, 'courierOrderAvailability');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, null);
  assert.equal(u.origin + u.pathname, 'https://dpdservicesdemo.dpd.com.pl/public/courierorder/v1/courierOrderAvailability');
  assert.deepEqual([...u.searchParams], [
    ['countryCode', 'PL'],
    ['zipCode', '01354'],
  ]);
  assert.deepEqual(calls[0].headers, {
    Accept: 'application/json',
    Authorization: 'Basic ' + Buffer.from('fixture:fixture-password').toString('base64'),
    'x-dpd-fid': '1495',
  });
  // The read calls DPD, so it has the same admin/operator gate as the other pickup routes:
  // a viewer is refused before any provider call, an operator reads hours; another tenant cannot see the channel.
  calls.length = 0;
  const refused = await req(path + '01354', 'GET', undefined, viewer);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().detail, 'Brak uprawnień do zleceń DPD');
  assert.equal(calls.length, 0);
  assert.equal((await req(path + '01354', 'GET', undefined, operator)).statusCode, 200);
  assert.equal(calls.length, 1);
  calls.length = 0;
  const foreign = await req(path + '01354', 'GET', undefined, other);
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().detail, 'Nie znaleziono konta DPD');
  for (const code of ['1354', '01-3541', 'ab-cde', ''])
    assert.equal((await req(path + code)).statusCode, 422, code);
  assert.equal(calls.length, 0);
  const sim = (await api('/api/dpd-shipping/example', 'POST', {})).channel_id;
  assert.deepEqual(await api('/api/integrations/' + sim + '/dpd-availability?postal_code=01354'), {
    scope: 'local_simulation',
    ranges: [{ range: '09:00-17:00', offset: 0 }],
  });
  assert.equal(calls.length, 0);
  // Provider refusals and malformed responses never return hours to the client.
  const cases: [() => Response, number, string, number][] = [
    [() => reply({ status: 'ERROR', ranges: [] }), 502, 'DPD nie potwierdziło dostępności', 1],
    [() => reply({ status: 'OK' }), 502, 'DPD nie potwierdziło dostępności', 1],
    [() => new Response('<html>', { status: 200 }), 502, 'Nieprawidłowa odpowiedź JSON dostawcy', 1],
    [() => new Response('{}', { status: 401 }), 401, 'API dostawcy: HTTP 401', 1],
    [() => new Response('{}', { status: 500 }), 502, 'API dostawcy: HTTP 500', 3],
    // Range parsing uses zod, so an out-of-contract provider row surfaces as validation 422.
    [() => reply({ status: 'OK', ranges: [{ range: '09:00-17:00', offset: -1 }] }), 422, '0.offset', 1],
    [() => reply({ status: 'OK', ranges: Array.from({ length: 101 }, () => ({ range: 'x', offset: 0 })) }), 422, 'Too big', 1],
  ];
  for (const [response, status, detail, attempts] of cases) {
    calls.length = 0;
    availabilityReply = response;
    const r = await req(path + '01354');
    assert.equal(r.statusCode, status, r.body);
    assert(r.json().detail.includes(detail), r.body);
    assert.equal(r.json().ranges, undefined);
    assert.equal(calls.length, attempts);
  }
  const revoked = await req(path + '01354', 'GET', undefined, '');
  assert.equal(revoked.statusCode, 401);
});

test('200 historical parcels are paginated without gaps and form one bounded exact protocol', async () => {
  const f = await fixture();
  const original = f.ids[0];
  await api('/api/dpd-shipping/' + original + '/dispatch', 'POST', {});
  // Synthetic historical labels isolate batching from shipment creation and courier limits.
  await tenantTx(DEMO_TENANT, async (c) => {
    for (let i = 1; i < 200; i++) {
      const pid = randomUUID(),
        sid = randomUUID(),
        oid = randomUUID(),
        tracking = '00008899' + String(i + 10000) + 'Q',
        reference = 'DYNA-' + pid;
      await c.query(
        'INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||$2::jsonb)).* FROM orders o WHERE id=$1',
        [
          f.orders[0].id,
          JSON.stringify({
            id: oid,
            number: 'COL-HISTORY-' + oid,
            portal_token: randomBytes(24).toString('hex'),
            portal_enabled: false,
          }),
        ],
      );
      await c.query(
        'INSERT INTO shipments SELECT (jsonb_populate_record(NULL::shipments,to_jsonb(s)||$2::jsonb)).* FROM shipments s WHERE id=(SELECT shipment_id FROM shipping_plans WHERE id=$1)',
        [
          original,
          JSON.stringify({
            id: sid,
            order_id: oid,
            tracking_number: tracking,
            external_id: tracking,
          }),
        ],
      );
      await c.query(
        'INSERT INTO shipping_plans SELECT (jsonb_populate_record(NULL::shipping_plans,to_jsonb(p)||$2::jsonb)).* FROM shipping_plans p WHERE id=$1',
        [
          original,
          JSON.stringify({
            id: pid,
            order_id: oid,
            shipment_id: sid,
            remote_id: tracking,
            payload: {
              generationPolicy: 'STOP_ON_FIRST_ERROR',
              packages: [{ reference, parcels: [{ reference }] }],
            },
            result: {
              tracking_number: tracking,
              scope: 'external_sandbox_verified',
              status: 'label_ready',
            },
          }),
        ],
      );
      f.ids.push(pid);
    }
  });
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < 4; i++) {
    const p = await api(
      '/api/integrations/' + f.ch + '/dpd-parcels' + (cursor ? '?after=' + cursor : ''),
    );
    assert.equal(p.data.length, 50);
    for (const r of p.data) {
      assert(!seen.has(r.id));
      seen.add(r.id);
    }
    cursor = p.next;
  }
  assert.equal(cursor, null);
  assert.equal(seen.size, 200);
  assert.equal(
    (
      await req('/api/integrations/' + f.ch + '/dpd-collections', 'POST', {
        ...input(f, 'protocol'),
        plan_ids: [...f.ids, randomUUID()],
      })
    ).statusCode,
    422,
  );
  const start = performance.now(),
    p = await preview(f, 'protocol');
  assert.equal(p.input.count, 200);
  assert.equal(p.input.weight, 250);
  await run((await queued(p.id)).job_id);
  assert.equal((await row(p.id)).state, 'ready');
  assert.equal(calls.filter((c) => c.op === 'generateProtocol').length, 1);
  console.log(
    'DPD protocol 200 parcels synthetic transport ms:',
    Math.round(performance.now() - start),
  );
});

test('operator can preview, approve and cancel own pickup, while another author cannot approve it', async () => {
  const f = await fixture();
  const p = await api('/api/integrations/' + f.ch + '/dpd-collections', 'POST', input(f), operator);
  assert.equal(
    (await req('/api/dpd-collections/' + p.id + '/queue', 'POST', { confirm_external: true }))
      .statusCode,
    403,
  );
  const q = await api(
    '/api/dpd-collections/' + p.id + '/queue',
    'POST',
    { confirm_external: true },
    operator,
  );
  await run(q.job_id);
  assert.equal((await row(p.id)).state, 'ready');
  const cancel = await api(
    '/api/dpd-collections/' + p.id + '/cancel',
    'POST',
    { confirm_external: true },
    operator,
  );
  await run(cancel.job_id);
  assert.equal((await row(p.id)).state, 'cancelled');
});

const scheduleBody = (extra: any = {}) => ({
  version: 0,
  enabled: true,
  time: '08:00',
  weekdays: [1, 2, 3, 4, 5],
  business_days: 1,
  from: '09:00',
  to: '17:00',
  confirm_external: true,
  ...extra,
});
const schedulePath = (channel: string) => '/api/integrations/' + channel + '/dpd-pickup-schedule';
async function makeDue(channel: string, minutes = 0) {
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "UPDATE dpd_pickup_schedules SET next_at=now()-make_interval(mins=>$2)-interval '1 second' WHERE channel_id=$1",
      [channel, minutes],
    ),
  );
}
async function scheduledRows(channel: string) {
  return (await api(schedulePath(channel))).runs[0];
}

test('DPD schedule validates consent, weekdays, optimistic version and tenant administrator', async () => {
  const f = await fixture();
  assert.equal(
    (await req(schedulePath(f.ch), 'PUT', scheduleBody({ confirm_external: false }))).statusCode,
    422,
  );
  assert.equal((await req(schedulePath(f.ch), 'PUT', scheduleBody(), viewer)).statusCode, 403);
  assert.equal((await req(schedulePath(f.ch), 'PUT', scheduleBody(), operator)).statusCode, 403);
  assert.equal((await req(schedulePath(f.ch), 'PUT', scheduleBody(), other)).statusCode, 404);
  assert.equal(
    (await req(schedulePath(f.ch), 'PUT', scheduleBody({ weekdays: [1, 1] }))).statusCode,
    422,
  );
  assert.equal(
    (
      await req(
        schedulePath(f.ch),
        'PUT',
        scheduleBody({ business_days: 0, time: '09:00', from: '09:15' }),
      )
    ).statusCode,
    422,
  );
  const s = await api(schedulePath(f.ch), 'PUT', scheduleBody());
  assert.equal(s.schedule.version, 1);
  assert.equal((await req(schedulePath(f.ch), 'PUT', scheduleBody())).statusCode, 409);
  assert.equal((await req(schedulePath(f.ch), 'GET', undefined, other)).statusCode, 404);
  assert.equal(pickups().length, 0);
});

test('Warsaw schedule follows weekday selection and daylight saving; pickup offset skips weekends', async () => {
  const next = async (time: string, days: number[], now: string) =>
    (
      await pool.query('SELECT automation_next_at($1,$2) n', [
        { kind: 'daily', timezone: 'Europe/Warsaw', time, weekdays: days },
        now,
      ])
    ).rows[0].n.toISOString();
  assert.equal(await next('09:00', [1], '2026-10-23T12:00:00Z'), '2026-10-26T08:00:00.000Z');
  assert.equal(await next('02:30', [7], '2026-10-24T12:00:00Z'), '2026-10-25T01:30:00.000Z');
  assert.equal(await next('02:30', [7], '2026-03-28T12:00:00Z'), '2026-03-29T01:30:00.000Z');
  assert.equal(scheduledPickupDate(new Date('2026-10-09T23:00:00Z'), 1), '2026-10-12');
});

test('concurrent DPD schedulers atomically create one run and worker uses approved pickup payload', async () => {
  const f = await fixture(2);
  await api(schedulePath(f.ch), 'PUT', scheduleBody());
  await makeDue(f.ch);
  await Promise.all([scheduleDpdPickupsDue(), scheduleDpdPickupsDue()]);
  const d = await api(schedulePath(f.ch)),
    r = d.runs[0];
  assert.equal(d.runs.length, 1);
  assert.equal(r.count, 2);
  assert.equal(r.collection_ids.length, 1);
  assert.equal(pickups().length, 0);
  assert.equal(d.eligible, 0);
  const p = await row(r.collection_ids[0]);
  assert.equal(p.schedule_version, 1);
  assert.equal(p.state, 'queued');
  await run(p.job_id);
  assert.equal((await row(p.id)).state, 'ready');
  assert.equal(pickups().length, 1);
  assert.equal(pickups()[0].body.packagesForCollection.packagesParams.parcel.count, 2);
  for (const product of f.products)
    assert.deepEqual(
      (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [product.id]))
        .rows[0],
      { on_hand: 12, reserved: 2 },
    );
});

test('pause cancels scheduled pre-write jobs and frees claims; old claimed worker never transports', async () => {
  const f = await fixture();
  await api(schedulePath(f.ch), 'PUT', scheduleBody());
  await makeDue(f.ch);
  await scheduleDpdPickupsDue();
  const r = await scheduledRows(f.ch),
    p = await row(r.collection_ids[0]),
    job = await claimJob(p.job_id);
  const disabled = await api(
    schedulePath(f.ch),
    'PUT',
    scheduleBody({ version: 1, enabled: false, confirm_external: false }),
  );
  assert.equal(disabled.stopped, 1);
  assert.equal((await row(p.id)).state, 'cancelled');
  await assert.rejects(() => processCollection(job, { transport }));
  assert.equal(pickups().length, 0);
  assert.equal((await api(schedulePath(f.ch))).eligible, 1);
});

test('pause during scheduled POST retains uncertain result and claim, never schedules second pickup', async () => {
  const f = await fixture();
  await api(schedulePath(f.ch), 'PUT', scheduleBody());
  await makeDue(f.ch);
  await scheduleDpdPickupsDue();
  const r = await scheduledRows(f.ch),
    p = await row(r.collection_ids[0]);
  hook = async (op) => {
    if (op === 'packagesPickupCall')
      await api(schedulePath(f.ch), 'PUT', scheduleBody({ version: 1, enabled: false }));
  };
  await run(p.job_id);
  assert.equal((await row(p.id)).state, 'uncertain');
  assert.equal(pickups().length, 1);
  assert.equal((await api(schedulePath(f.ch))).eligible, 0);
  await scheduleDpdPickupsDue();
  assert.equal(pickups().length, 1);
});

test('empty and missed DPD slots are durable and do not call provider or accumulate catch-up jobs', async () => {
  const f = await fixture();
  await api('/api/dpd-shipping/' + f.ids[0] + '/dispatch', 'POST', {});
  await api(schedulePath(f.ch), 'PUT', scheduleBody());
  await makeDue(f.ch);
  await scheduleDpdPickupsDue();
  assert.equal((await scheduledRows(f.ch)).state, 'empty');
  await makeDue(f.ch, 16);
  await scheduleDpdPickupsDue();
  assert.equal((await scheduledRows(f.ch)).state, 'missed');
  await scheduleDpdPickupsDue();
  assert.equal((await api(schedulePath(f.ch))).runs.length, 2);
  assert.equal(pickups().length, 0);
});

test('changed DPD account and revoked administrator suspend schedule without transport', async () => {
  const f = await fixture();
  await api(schedulePath(f.ch), 'PUT', scheduleBody());
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE channels SET settings=settings||\'{"master_fid":"1496"}\' WHERE id=$1', [f.ch]),
  );
  await makeDue(f.ch);
  await scheduleDpdPickupsDue();
  assert.equal((await api(schedulePath(f.ch))).schedule.enabled, false);
  const g = await fixture();
  await api(schedulePath(g.ch), 'PUT', scheduleBody());
  await makeDue(g.ch);
  const actor = (
    await pool.query('SELECT actor_id FROM dpd_pickup_schedules WHERE channel_id=$1', [g.ch])
  ).rows[0].actor_id;
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    actor,
  ]);
  try {
    await scheduleDpdPickupsDue();
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      actor,
    ]);
  }
  assert.equal((await api(schedulePath(g.ch))).schedule.enabled, false);
  assert.equal(pickups().length, 0);
});

test('DPD schedule splits 201 synthetic ready labels into two exact disjoint pickup batches', async () => {
  const f = await fixture();
  const original = f.ids[0];
  await tenantTx(DEMO_TENANT, async (c) => {
    for (let i = 1; i < 201; i++) {
      const pid = randomUUID(),
        sid = randomUUID(),
        oid = randomUUID(),
        tracking = '00008897' + String(i + 10000) + 'Q',
        reference = 'DYNA-' + pid;
      await c.query(
        'INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||$2::jsonb)).* FROM orders o WHERE id=$1',
        [
          f.orders[0].id,
          JSON.stringify({
            id: oid,
            number: 'COL-SCHEDULE-HISTORY-' + oid,
            portal_token: randomBytes(24).toString('hex'),
            portal_enabled: false,
          }),
        ],
      );
      await c.query(
        'INSERT INTO shipments SELECT (jsonb_populate_record(NULL::shipments,to_jsonb(s)||$2::jsonb)).* FROM shipments s WHERE id=(SELECT shipment_id FROM shipping_plans WHERE id=$1)',
        [
          original,
          JSON.stringify({
            id: sid,
            order_id: oid,
            tracking_number: tracking,
            external_id: tracking,
          }),
        ],
      );
      await c.query(
        'INSERT INTO shipping_plans SELECT (jsonb_populate_record(NULL::shipping_plans,to_jsonb(p)||$2::jsonb)).* FROM shipping_plans p WHERE id=$1',
        [
          original,
          JSON.stringify({
            id: pid,
            order_id: oid,
            shipment_id: sid,
            remote_id: tracking,
            payload: {
              generationPolicy: 'STOP_ON_FIRST_ERROR',
              packages: [{ reference, parcels: [{ reference }] }],
            },
            result: {
              tracking_number: tracking,
              scope: 'external_sandbox_verified',
              status: 'label_ready',
            },
          }),
        ],
      );
      f.ids.push(pid);
    }
  });
  await api(schedulePath(f.ch), 'PUT', scheduleBody());
  await makeDue(f.ch);
  await scheduleDpdPickupsDue();
  const r = await scheduledRows(f.ch);
  assert.equal(r.count, 201);
  assert.equal(r.collection_ids.length, 2);
  const all = new Set<string>();
  for (const id of r.collection_ids) {
    const p = await row(id);
    assert(p.input.count <= 200);
    for (const pid of p.input.plan_ids) {
      assert(!all.has(pid));
      all.add(pid);
    }
    await run(p.job_id);
    assert.equal((await row(p.id)).state, 'ready');
  }
  assert.equal(all.size, 201);
  assert.equal(pickups().length, 2);
  assert.equal(
    pickups().reduce((n, c) => n + c.body.packagesForCollection.packagesParams.parcel.count, 0),
    201,
  );
});

test('DPD schedule separates sender addresses and retains tenant isolation in schedule tables', async () => {
  const f = await fixture(2);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "UPDATE shipping_plans SET input=jsonb_set(input,'{sender,address}',to_jsonb('Inna 2'::text)) WHERE id=$1",
      [f.ids[1]],
    ),
  );
  await api(schedulePath(f.ch), 'PUT', scheduleBody());
  await makeDue(f.ch);
  await scheduleDpdPickupsDue();
  const r = await scheduledRows(f.ch);
  assert.equal(r.count, 2);
  assert.equal(r.collection_ids.length, 2);
  const senders = new Set<string>();
  for (const id of r.collection_ids) {
    const p = await row(id);
    senders.add(p.input.sender.address);
    assert.equal(p.input.count, 1);
  }
  assert.deepEqual([...senders].sort(), ['Inna 2', 'Testowa 1']);
  const tenant = (await pool.query('SELECT id FROM tenants WHERE id<>$1 LIMIT 1', [DEMO_TENANT]))
    .rows[0].id;
  await tenantTx(tenant, async (c) => {
    assert.equal(
      (await c.query('SELECT * FROM dpd_pickup_schedules WHERE channel_id=$1', [f.ch])).rowCount,
      0,
    );
    assert.equal((await c.query('SELECT * FROM dpd_pickup_runs WHERE id=$1', [r.id])).rowCount, 0);
  });
});

test('DPD schedule backpressure rolls back the entire run, collections and parcel claims', async () => {
  const f = await fixture();
  await api(schedulePath(f.ch), 'PUT', scheduleBody());
  const ids: string[] = [];
  await tenantTx(DEMO_TENANT, async (c) => {
    for (let n = 0; n < 1000; n++) {
      const id = randomUUID();
      ids.push(id);
      await c.query(
        "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1::uuid,$2,'test.schedule.capacity','{}',$1::text)",
        [id, DEMO_TENANT],
      );
    }
  });
  try {
    await makeDue(f.ch);
    await scheduleDpdPickupsDue();
    const d = await api(schedulePath(f.ch));
    assert.equal(d.runs.length, 0);
    assert.equal(d.eligible, 1);
    assert.match(d.schedule.error, /pełna/);
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM dpd_collections WHERE channel_id=$1', [f.ch]))
        .rows[0].n,
      0,
    );
    assert.equal(pickups().length, 0);
  } finally {
    await pool.query('DELETE FROM jobs WHERE id=ANY($1::uuid[])', [ids]);
  }
});

test('scheduled pickup loses authority when its owner becomes operator after enqueue', async () => {
  const f = await fixture();
  await api(schedulePath(f.ch), 'PUT', scheduleBody());
  await makeDue(f.ch);
  await scheduleDpdPickupsDue();
  const r = await scheduledRows(f.ch),
    p = await row(r.collection_ids[0]);
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    p.actor_id,
  ]);
  try {
    await run(p.job_id);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      p.actor_id,
    ]);
  }
  assert.equal((await row(p.id)).state, 'failed');
  assert.equal(pickups().length, 0);
});
