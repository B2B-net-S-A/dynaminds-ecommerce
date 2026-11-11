import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import {
  processTracking,
  failTracking,
  scheduleTrackingDue,
  readShipmentTracking,
  TRACKING_BATCH,
  TRACKING_BACKLOG,
} from '../server/tracking';
import { tick } from '../server/worker';
import {
  DpdInfo,
  DPD_INFO_ENDPOINT,
  dpdEventTime,
  dpdStatus,
  parseDpdEvents,
} from '../server/dpd-info';
import { decrypt } from '../server/security';
import type { IntegrationContext } from '../server/channel-access';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  viewer: string,
  other: string,
  operator: string,
  warehouse: string,
  actorId: string;
const responses = new Map<string, string>(),
  calls: string[] = [];
let hook: (() => Promise<void>) | undefined,
  failure = 0;
const ctx: IntegrationContext = {
  transport: async (url, init) => {
    assert.equal(url, DPD_INFO_ENDPOINT);
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('soapaction'), '""');
    const body = String(init.body);
    assert.match(body, /<eventsSelectType>ALL<\/eventsSelectType>/);
    assert.match(body, /<login>fixture-info<\/login>/);
    assert.match(body, /<password>fixture-info-pass<\/password>/);
    assert.equal(new Headers(init.headers).has('authorization'), false);
    const number = body.match(/<waybill>([^<]+)<\/waybill>/)![1];
    calls.push(number);
    const h = hook;
    hook = undefined;
    await h?.();
    if (failure) {
      const status = failure;
      failure = 0;
      return new Response('PRIVATE_PROVIDER_ERROR', { status });
    }
    return new Response(responses.get(number) ?? soap([]), { status: 200 });
  },
};
const req = (p: string, m: any = 'GET', b?: any, auth = cookie) =>
  app.inject({
    url: '/api' + p,
    method: m,
    payload: b,
    headers: { cookie: auth, ...(p === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
  });
async function ok(p: string, m: any = 'GET', b?: any, auth = cookie) {
  const r = await req(p, m, b, auth);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  for (const [email, set] of [
    ['admin@demo.local', (v: string) => (cookie = v)],
    ['viewer@demo.local', (v: string) => (viewer = v)],
    ['other@demo.local', (v: string) => (other = v)],
    ['operator@demo.local', (v: string) => (operator = v)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    set(r.headers['set-cookie']!.toString().split(';')[0]);
  }
  warehouse = (await ok('/warehouses')).data[0].id;
  actorId = (await ok('/auth/me')).user.id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => {
  calls.length = 0;
  hook = undefined;
  failure = 0;
});
const read = (sql: string, args: any[] = []) =>
  tenantTx(DEMO_TENANT, async (c) => (await c.query(sql, args)).rows);
async function channel(sim = false, mode = 'live') {
  const id = randomUUID();
  await read(
    "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'dpd','DPD Tracking QA',$3,$4,$5)",
    [
      id,
      DEMO_TENANT,
      mode,
      encrypt({
        username: 'fixture-rest',
        password: 'fixture-rest-pass',
        info_login: 'fixture-info',
        info_password: 'fixture-info-pass',
      }),
      JSON.stringify({ simulation: sim, master_fid: '1495' }),
    ],
  );
  return id;
}
async function shipment(ch: string) {
  const p = await ok('/products', 'POST', {
    sku: 'TRACK-' + randomUUID(),
    name: 'Tracking fixture',
    price: 10000,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 2,
  });
  const o = await ok('/orders', 'POST', {
    customer_name: 'Tracking QA',
    email: 'tracking@example.test',
    warehouse_id: warehouse,
    address: {
      street: 'Testowa 1',
      city: 'Warszawa',
      postal_code: '00-001',
      country: 'PL',
      phone: '500600700',
    },
    items: [{ product_id: p.id, quantity: 1 }],
  });
  for (const status of ['paid', 'picking'])
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status }));
  await ok('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'packed' }));
  await ok('/orders/' + o.id + '/ship-demo', 'POST', {});
  const s = (
    await read(
      "UPDATE shipments SET channel_id=$2,external_id='123',status='confirmed',dispatched_at=now() WHERE order_id=$1 RETURNING *",
      [o.id, ch],
    )
  )[0];
  s.tracking_number = String(Date.now()).padStart(13, '0') + 'Q';
  await read('UPDATE shipments SET tracking_number=$2 WHERE id=$1', [s.id, s.tracking_number]);
  responses.set(s.tracking_number, soap([event(s.tracking_number, '170101')]));
  return { s, o, p };
}
async function configure(ch: string, patch: any = {}) {
  const d = await ok('/integrations/' + ch + '/tracking');
  return ok('/integrations/' + ch + '/tracking', 'PATCH', {
    version: d.config?.version ?? 0,
    enabled: true,
    interval_seconds: 60,
    mark_delivered: true,
    confirm_external: true,
    ...patch,
  });
}
async function queue(ch: string) {
  await ok('/integrations/' + ch + '/tracking', 'POST');
  return await read(
    "SELECT * FROM jobs WHERE kind='shipping.tracking' AND payload->>'channel_id'=$1 AND state='pending' ORDER BY created_at,id",
    [ch],
  );
}
async function run(id: string, catchError = true) {
  const j = (
    await read(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  )[0];
  try {
    await processTracking(j, ctx);
  } catch (e) {
    if (!catchError) throw e;
    await failTracking(j, e);
  }
  return j;
}
async function state(id: string) {
  return (await read('SELECT * FROM shipments WHERE id=$1', [id]))[0];
}
const soap = (events: string[]) =>
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><n:getEventsForWaybillV1Response xmlns:n="http://events.dpdinfoservices.dpd.com.pl/"><return><confirmId>0</confirmId>${events.join('')}</return></n:getEventsForWaybillV1Response></s:Body></s:Envelope>`;
const event = (waybill: string, code = '190104', time = '2026-10-04T12:00:00', next?: string) =>
  `<eventsList><businessCode>${code}</businessCode><description>PRIVATE_RECIPIENT_NAME</description><eventTime>${time}</eventTime><objectId>7305000000269747964</objectId><waybill>${waybill}</waybill><eventDataList><code>03</code><value>${next ?? 'PRIVATE_RECIPIENT_NAME'}</value></eventDataList></eventsList>`;
const credentials = { info_login: 'fixture-info', info_password: 'fixture-info-pass' };
test('official SOAP request escapes credentials, fixed endpoint, ALL, PL, empty channel and SOAPAction', async () => {
  const data = await new DpdInfo(
    { info_login: 'a<&', info_password: 'b"\'' },
    async (url, init) => {
      assert.equal(url, DPD_INFO_ENDPOINT);
      assert.equal(init.method, 'POST');
      assert.match(
        String(init.body),
        /<channel><\/channel><login>a&lt;&amp;<\/login><password>b&quot;&apos;<\/password>/,
      );
      assert.match(String(init.body), /<language>PL<\/language>/);
      return new Response(soap([event('0000889102958Q')]));
    },
  ).tracking({ tracking_number: '0000889102958Q' });
  assert.equal(data.status, 'delivered');
  assert.equal(data.provider_updated_at, '2026-10-04T10:00:00.000Z');
  assert(!JSON.stringify(data).includes('PRIVATE_RECIPIENT'));
  assert.equal(data.tracking_details[0].object_id, '7305000000269747964');
});
test('timestamps use Warsaw winter/summer, explicit offsets, strict calendar, DST gap and deterministic overlap', () => {
  assert.equal(dpdEventTime('2026-01-01T12:00:00.123'), '2026-01-01T11:00:00.123Z');
  assert.equal(dpdEventTime('2026-07-01T12:00:00'), '2026-07-01T10:00:00.000Z');
  assert.equal(dpdEventTime('2026-10-25T02:30:00'), '2026-10-25T01:30:00.000Z');
  assert.equal(dpdEventTime('2026-07-01T12:00:00+03:00'), '2026-07-01T09:00:00.000Z');
  for (const v of [
    '2026-03-29T02:30:00',
    '2026-02-30T12:00:00',
    '2026-13-01T12:00:00',
    '2026-01-01T25:00:00',
    '2026-01-01T12:00:00+99:00',
  ])
    assert.throws(() => dpdEventTime(v));
});
test('documented delivery codes, collection, notifications, lost and returning delivery mapping', () => {
  for (const c of [
    '190101',
    '190102',
    '190103',
    '190104',
    '190105',
    '190201',
    '190202',
    '190203',
    '190204',
    '501300',
    '501304',
    '501340',
    '511901',
    '511902',
    '511903',
    '600103',
    '600104',
    '701901',
    '701902',
  ]) {
    assert.equal(dpdStatus(c), 'delivered');
    assert.equal(dpdStatus(c, true), 'returned_to_sender');
  }
  assert.equal(dpdStatus('511201'), 'ready_to_pickup');
  assert.equal(dpdStatus('170101'), 'out_for_delivery');
  assert.equal(dpdStatus('230403'), 'return_in_transit');
  assert.equal(dpdStatus('230309'), 'lost');
  assert.equal(dpdStatus('170305'), null);
  assert.equal(dpdStatus('999999'), null);
});
test('SOAP fault, namespace spoofing, DTD, malformed and duplicate scalar fields never expose provider data', () => {
  const good = soap([event('0000889102958Q')]);
  for (const xml of [
    good.replace('http://events.dpdinfoservices.dpd.com.pl/', 'https://evil.test'),
    good.replace('</return>', '</bad>'),
    good.replace('<businessCode>', '<businessCode>190101</businessCode><businessCode>'),
    `<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///private">]>${good}`,
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>PRIVATE_SECRET</faultstring></s:Fault></s:Body></s:Envelope>`,
  ]) {
    assert.throws(
      () => parseDpdEvents(xml, '0000889102958Q'),
      (e) => e instanceof Error && !e.message.includes('PRIVATE'),
    );
  }
  assert.throws(() => parseDpdEvents(good, '0000889109999Q'));
});
test('streamed bytes, depth and event count have hard bounds', async () => {
  assert.throws(() =>
    parseDpdEvents(
      soap(Array.from({ length: 1001 }, () => event('0000889102958Q'))),
      '0000889102958Q',
    ),
  );
  assert.throws(() => parseDpdEvents('<x>'.repeat(21) + '</x>'.repeat(21), '0000889102958Q'));
  await assert.rejects(
    new DpdInfo(credentials, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))).events(
      '0000889102958Q',
    ),
  );
});
test('redirect follows changed waybill and return delivery means returned to sender; reads do not acknowledge a customer feed', async () => {
  const a = '0000889102958Q',
    b = '0000889102959Q',
    c = '0000889102960Q';
  const replies = new Map([
    [a, soap([event(a, '230402', '2026-10-04T10:00:00', b)])],
    [b, soap([event(b, '230403', '2026-10-04T11:00:00', c)])],
    [c, soap([event(c, '190101', '2026-10-04T12:00:00')])],
  ]);
  const queried: string[] = [];
  const client = new DpdInfo(credentials, async (_, init) => {
    const n = String(init.body).match(/<waybill>([^<]+)</)![1];
    queried.push(n);
    return new Response(replies.get(n));
  });
  const first = await client.tracking({ tracking_number: a });
  assert.equal(first.status, 'returned_to_sender');
  assert.equal(first.current_waybill, c);
  assert.equal(first.return_leg, true);
  assert.deepEqual(queried, [a, b, c]);
  assert.deepEqual(
    first.lineage.map((x) => x.return_leg),
    [false, false, true],
  );
  const replay = await client.tracking({ tracking_number: a, tracking_data: first });
  assert.equal(replay.tracking_details.length, 3);
});
test('renumber cycles, ambiguous targets and hop overflow fail without reporting completion', async () => {
  const a = '0000889102958Q',
    b = '0000889102959Q';
  await assert.rejects(
    new DpdInfo(credentials, async (_, init) => {
      const n = String(init.body).match(/<waybill>([^<]+)</)![1];
      return new Response(soap([event(n, '230403', '2026-10-04T11:00:00', n === a ? b : a)]));
    }).tracking({ tracking_number: a }),
    /cykl/,
  );
  await assert.rejects(
    new DpdInfo(
      credentials,
      async () =>
        new Response(
          soap([
            event(a, '230402', '2026-10-04T10:00:00', b),
            event(a, '230403', '2026-10-04T11:00:00', '0000889102960Q'),
          ]),
        ),
    ).tracking({ tracking_number: a }),
    /niejednoznaczna/,
  );
  let n = 0;
  await assert.rejects(
    new DpdInfo(credentials, async (_, init) => {
      const w = String(init.body).match(/<waybill>([^<]+)</)![1];
      return new Response(
        soap([event(w, '230402', '2026-10-04T10:00:00', String(8880000000000 + ++n) + 'Q')]),
      );
    }).tracking({ tracking_number: a }),
    /limit/,
  );
});
test('empty response preserves history and a new empty redirected leg cannot inherit old delivery', async () => {
  const a = '0000889102958Q',
    b = '0000889102959Q';
  const previous = await new DpdInfo(
    credentials,
    async () => new Response(soap([event(a)])),
  ).tracking({ tracking_number: a });
  const empty = await new DpdInfo(credentials, async () => new Response(soap([]))).tracking({
    tracking_number: a,
    tracking_data: previous,
  });
  assert.equal(empty.status, 'delivered');
  assert.equal(empty.tracking_details.length, 1);
  assert.equal(empty.empty_history, true);
  const redirected = await new DpdInfo(
    credentials,
    async (_, init) =>
      new Response(
        String(init.body).includes(`<waybill>${a}</waybill>`)
          ? soap([event(a, '230402', '2026-10-04T13:00:00', b)])
          : soap([]),
      ),
  ).tracking({ tracking_number: a, tracking_data: previous });
  assert.equal(redirected.status, 'redirected');
  assert.equal(redirected.current_waybill, b);
});
test('DPD automatic delivered commits shipment, OMS and job once; COD receipts and warehouse remain unchanged', async () => {
  const ch = await channel(),
    { s, o, p } = await shipment(ch);
  await configure(ch);
  const beforeStock = await read('SELECT * FROM stock WHERE product_id=$1', [p.id]);
  const beforePayments = await read('SELECT * FROM payment_entries WHERE order_id=$1 ORDER BY id', [
    o.id,
  ]);
  const beforeMovements = await read(
    'SELECT * FROM stock_movements WHERE product_id=$1 ORDER BY id',
    [p.id],
  );
  responses.set(s.tracking_number, soap([event(s.tracking_number)]));
  const [j] = await queue(ch);
  await run(j.id);
  assert.equal((await state(s.id)).tracking_data.status, 'delivered');
  assert.equal((await ok('/orders/' + o.id)).status, 'delivered');
  assert.equal((await read('SELECT state FROM jobs WHERE id=$1', [j.id]))[0].state, 'done');
  assert.deepEqual(await read('SELECT * FROM stock WHERE product_id=$1', [p.id]), beforeStock);
  assert.deepEqual(
    await read('SELECT * FROM payment_entries WHERE order_id=$1 ORDER BY id', [o.id]),
    beforePayments,
  );
  assert.deepEqual(
    await read('SELECT * FROM stock_movements WHERE product_id=$1 ORDER BY id', [p.id]),
    beforeMovements,
  );
  await ok('/shipments/' + s.id + '/tracking', 'POST', {});
  assert.equal((await state(s.id)).tracking_data.tracking_details.length, 1);
});
test('return renumber is retained in OMS tracking without delivery or physical return intake', async () => {
  const ch = await channel(),
    { s, o, p } = await shipment(ch);
  await configure(ch);
  const b = '0000889109988Q';
  responses.set(
    s.tracking_number,
    soap([event(s.tracking_number, '230403', '2026-10-04T11:00:00', b)]),
  );
  responses.set(b, soap([event(b)]));
  const before = await read('SELECT * FROM stock WHERE product_id=$1', [p.id]);
  const [j] = await queue(ch);
  await run(j.id);
  const result = (await state(s.id)).tracking_data;
  assert.equal(result.status, 'returned_to_sender');
  assert.equal(result.current_waybill, b);
  assert.equal((await ok('/orders/' + o.id)).status, 'shipped');
  assert.deepEqual(await read('SELECT * FROM stock WHERE product_id=$1', [p.id]), before);
});
test('credentials are encrypted, existing REST login retained, UI never returns secrets and rotation cancels schedule/jobs', async () => {
  const ch = await channel();
  const { s } = await shipment(ch);
  await configure(ch);
  const [j] = await queue(ch);
  assert.equal(
    (
      await req(
        '/integrations/' + ch + '/tracking-credentials',
        'PATCH',
        { info_login: 'rotated', info_password: 'SECRET_ROTATED' },
        operator,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await req(
        '/integrations/' + ch + '/tracking-credentials',
        'PATCH',
        { info_login: 'rotated', info_password: 'SECRET_ROTATED' },
        other,
      )
    ).statusCode,
    404,
  );
  await ok('/integrations/' + ch + '/tracking-credentials', 'PATCH', {
    info_login: 'rotated',
    info_password: 'SECRET_ROTATED',
  });
  const encrypted = (await read('SELECT credentials FROM channels WHERE id=$1', [ch]))[0]
    .credentials;
  assert(!encrypted.includes('SECRET'));
  assert.equal(decrypt(encrypted).username, 'fixture-rest');
  assert.equal(decrypt(encrypted).info_login, 'rotated');
  const ui = await ok('/integrations/' + ch + '/tracking');
  assert(ui.channel.info_configured);
  assert.equal(ui.config.enabled, false);
  assert(!JSON.stringify(ui).includes('SECRET'));
  assert.equal(ui.channel.credentials, undefined);
  await run(j.id);
  assert.equal(calls.length, 0);
  assert.equal((await state(s.id)).tracking_at, null);
});
test('sandbox or missing separate InfoServices credentials cannot enable or manually read external tracking', async () => {
  const ch = await channel(false, 'sandbox'),
    { s } = await shipment(ch);
  assert.equal(
    (
      await req('/integrations/' + ch + '/tracking', 'PATCH', {
        version: 0,
        enabled: true,
        interval_seconds: 60,
        mark_delivered: false,
        confirm_external: true,
      })
    ).statusCode,
    422,
  );
  assert.equal((await req('/shipments/' + s.id + '/tracking', 'POST', {})).statusCode, 422);
  await read("UPDATE channels SET mode='live',credentials=$2 WHERE id=$1", [
    ch,
    encrypt({ username: 'rest', password: 'rest-pass' }),
  ]);
  assert.equal((await req('/shipments/' + s.id + '/tracking', 'POST', {})).statusCode, 422);
  assert.equal(calls.length, 0);
});
test('pause during read and credential rotation during read reject result after HTTP', async () => {
  for (const rotate of [false, true]) {
    const ch = await channel(),
      { s } = await shipment(ch);
    await configure(ch);
    const [j] = await queue(ch);
    hook = async () => {
      if (rotate)
        await ok('/integrations/' + ch + '/tracking-credentials', 'PATCH', {
          info_login: 'rotated',
          info_password: 'rotated',
        });
      else await configure(ch, { enabled: false });
    };
    await run(j.id);
    assert.equal((await state(s.id)).tracking_at, null);
    assert.equal((await read('SELECT state FROM jobs WHERE id=$1', [j.id]))[0].state, 'failed');
  }
});
test('each retry and each changed-waybill read rechecks approval before network', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  await configure(ch);
  const [j] = await queue(ch);
  failure = 503;
  hook = async () => {
    await configure(ch, { enabled: false });
  };
  await run(j.id);
  assert.equal(calls.length, 1);
  assert.equal((await state(s.id)).tracking_at, null);
  const next = await channel(),
    fixture = await shipment(next);
  await configure(next);
  const [job] = await queue(next);
  responses.set(
    fixture.s.tracking_number,
    soap([event(fixture.s.tracking_number, '230403', '2026-10-04T11:00:00', '0000889109988Q')]),
  );
  hook = async () => {
    await configure(next, { enabled: false });
  };
  calls.length = 0;
  await run(job.id);
  assert.equal(calls.length, 1);
  assert.equal((await state(fixture.s.id)).tracking_at, null);
});
test('older provider event cannot regress status; notification alone preserves known physical state', async () => {
  const ch = await channel(),
    { s } = await shipment(ch);
  responses.set(
    s.tracking_number,
    soap([event(s.tracking_number, '170101', '2026-10-04T13:00:00')]),
  );
  await ok('/shipments/' + s.id + '/tracking', 'POST', {});
  responses.set(
    s.tracking_number,
    soap([
      event(s.tracking_number, '040101', '2026-10-04T11:00:00'),
      event(s.tracking_number, '170305', '2026-10-04T14:00:00'),
    ]),
  );
  await ok('/shipments/' + s.id + '/tracking', 'POST', {});
  assert.equal((await state(s.id)).tracking_data.status, 'out_for_delivery');
});
test('simulated DPD worker and terminal job avoid all external reads', async () => {
  const ch = await channel(true, 'sandbox'),
    { s, o } = await shipment(ch);
  await configure(ch);
  await ok('/shipments/' + s.id + '/tracking-example', 'POST', { status: 'delivered' });
  const [j] = await queue(ch);
  await run(j.id);
  assert.equal((await state(s.id)).tracking_data.scope, 'local_simulation');
  assert.equal((await ok('/orders/' + o.id)).status, 'delivered');
  assert.equal(calls.length, 0);
});
test('tracking API paginates DPD history without leaking tenants or allowing viewers', async () => {
  const ch = await channel(),
    { s, o } = await shipment(ch);
  for (let n = 0; n < 26; n++) {
    const oid = randomUUID();
    await read(
      `INSERT INTO orders(id,tenant_id,number,customer_name,email,address,currency,status,total,warehouse_id,portal_token)
      SELECT $2,tenant_id,$3,customer_name,email,address,currency,'shipped',total,warehouse_id,$4 FROM orders WHERE id=$1`,
      [o.id, oid, 'DPD-PAGE-' + oid, randomUUID() + randomUUID()],
    );
    await read(
      "INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,status,channel_id,dispatched_at) VALUES($1,$2,$3,'DPD',$4,'demo','confirmed',$5,now())",
      [randomUUID(), DEMO_TENANT, oid, '00008891' + String(10000 + n) + 'Q', ch],
    );
  }
  const page = await ok('/integrations/' + ch + '/tracking');
  assert.equal(page.data.length, 25);
  assert.equal(page.stats.total, 27);
  assert(page.meta.cursor);
  const next = await ok('/integrations/' + ch + '/tracking?after=' + page.meta.cursor);
  assert.equal(next.data.length, 2);
  assert.equal(next.meta.cursor, null);
  assert.equal(new Set([...page.data, ...next.data].map((s) => s.id)).size, 27);
  assert.equal(
    (await req('/integrations/' + ch + '/tracking', 'GET', undefined, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req('/integrations/' + ch + '/tracking', 'GET', undefined, other)).statusCode,
    404,
  );
});
test('cached renumbering survives an empty closed original-waybill history and still follows return leg', async () => {
  const a = '0000889102958Q',
    b = '0000889102959Q';
  let closed = false;
  const queries: string[] = [];
  const client = new DpdInfo(credentials, async (_, init) => {
    const n = String(init.body).match(/<waybill>([^<]+)</)![1];
    queries.push(n);
    return new Response(
      n === a
        ? closed
          ? soap([])
          : soap([event(a, '230403', '2026-10-04T11:00:00', b)])
        : soap([event(b, '190101', '2026-10-04T12:00:00')]),
    );
  });
  const first = await client.tracking({ tracking_number: a });
  closed = true;
  queries.length = 0;
  const second = await client.tracking({ tracking_number: a, tracking_data: first });
  assert.equal(second.current_waybill, b);
  assert.equal(second.status, 'returned_to_sender');
  assert.deepEqual(queries, [a, b]);
  assert.equal(second.tracking_details.length, 2);
});
