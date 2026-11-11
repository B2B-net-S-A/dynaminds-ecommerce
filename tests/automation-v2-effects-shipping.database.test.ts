import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processShipping, failShipping } from '../server/shipping';
import { processDpd } from '../server/dpd-shipping';
import { DEFAULT_RUN } from '../shared/automation-v2';
assert.equal(process.env.DYNA_TEST, 'true');

// Lane M: create_shipment (DEMO, InPost ShipX, DPD) and print_label effects of automation rules v2.
// No real network: simulation connections never call a provider, the production InPost path runs on
// the fake ShipX transport below, and every carrier job is processed here with that transport.
let app: FastifyInstance, admin: string, warehouse: string;
const V2 = '/api/automations/v2';
const calls: Array<{ url: string; method: string }> = [];
const store = new Map<string, any>();
let next = 30000;
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status });
const transport = async (url: string, init: RequestInit) => {
  const u = new URL(url),
    method = init.method ?? 'GET',
    body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, method });
  if (u.pathname.includes('/organizations/')) {
    assert.equal(method, 'POST', 'Lost-create reconciliation is not exercised here');
    const sid = String(next++);
    const r = {
      ...body,
      id: sid,
      status: 'offers_prepared',
      tracking_number: null,
      cod: body.cod ?? null,
      insurance: body.insurance ?? null,
      offers: [
        {
          id: next++,
          service: { id: 'inpost_locker_standard' },
          status: 'available',
          rate: '12.99',
          currency: 'PLN',
          expires_at: new Date(Date.now() + 300000).toISOString(),
        },
      ],
      selected_offer: null,
    };
    store.set(sid, r);
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
    return json(r);
  }
  return json(r);
};
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) => app.inject({ url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  admin = r.headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await ok('/api/warehouses')).data[0].id;
});
beforeEach(async () => {
  calls.length = 0;
  await pool.query('UPDATE automation_rules SET enabled=false,version=version+1 WHERE enabled');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE state IN ('pending','running')");
});
after(async () => {
  await app.close();
  await pool.end();
});

async function order(opts: { packed?: boolean; locker?: string } = {}) {
  const product = await ok('/api/products', 'POST', {
    sku: 'V2M-' + randomUUID().slice(0, 10),
    name: 'Reguły v2 wysyłka',
    price: 5000,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 10,
  });
  const o = await ok('/api/orders', 'POST', {
    customer_name: 'Anna Odbiorca',
    payment_mode: 'cod',
    email: 'v2m@example.test',
    warehouse_id: warehouse,
    address: {
      street: 'Testowa 1',
      city: 'Warszawa',
      postal_code: '01-354',
      country: 'PL',
      phone: '500 600 700',
      ...(opts.locker ? { locker_code: opts.locker } : {}),
    },
    items: [{ product_id: product.id, quantity: 1 }],
  });
  if (opts.packed === false) return o;
  const status = async (s: string) =>
    ok('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((p) => ok(p), '/api/orders/' + o.id + '/status', { status: s }));
  await status('picking');
  await ok('/api/orders/' + o.id + '/scan', 'POST', { code: product.sku });
  await status('packed');
  return ok('/api/orders/' + o.id);
}
const rule = (effects: any[]) =>
  ok(V2 + '/rules', 'POST', {
    name: 'V2M ' + randomUUID().slice(0, 8),
    trigger: 'order.matches',
    enabled: true,
    config: {
      version: 2,
      group: 'Testy wysyłki',
      scope: 'orders',
      run: { ...DEFAULT_RUN, manual_button: true, auto: false },
      conditions: { match: 'all', items: [] },
      effects,
      stop_further: false,
    },
  });
async function runRule(ruleId: string, orderId: string) {
  const [r] = (await ok(V2 + '/rules/' + ruleId + '/run', 'POST', { order_ids: [orderId] })).runs;
  const row = (await pool.query('SELECT * FROM automation_runs WHERE rule_id=$1 AND order_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', [ruleId, orderId])).rows[0];
  return { ...r, effects: row.result?.effects ?? [], error: r.error ?? row.error };
}
const plans = async (orderId: string) =>
  (await pool.query('SELECT * FROM shipping_plans WHERE order_id=$1 ORDER BY created_at,id', [orderId])).rows;
const shipments = async (orderId: string) => (await pool.query('SELECT * FROM shipments WHERE order_id=$1', [orderId])).rows;
async function lease(jobId: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *",
      [jobId, randomUUID()],
    )
  ).rows[0];
}
async function runInPost(jobId: string) {
  const job = await lease(jobId);
  try {
    await processShipping(job, { transport });
  } catch (e) {
    await failShipping(job, e);
    throw e;
  }
}
async function inpostChannel(mode: 'sandbox' | 'live') {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'inpost',$3,$4,$5,$6)", [
      id,
      DEMO_TENANT,
      'InPost V2M ' + mode,
      mode,
      encrypt({ access_token: 'fixture' }),
      JSON.stringify({ organization_id: '1', simulation: false }),
    ]),
  );
  return id;
}
let printer: any;
async function printerFixture() {
  if (printer) return printer;
  const station = (
    await ok('/api/packing/stations', 'POST', { client_key: randomUUID(), code: 'V2M-' + randomUUID().slice(0, 8), label: 'Stanowisko V2M', enabled: true })
  ).station;
  printer = (
    await ok('/api/print-jobs/printers', 'POST', {
      client_key: randomUUID(),
      station_id: station.id,
      station_version: String(station.version),
      name: 'Drukarka V2M',
      format: 'pdf',
      output_mode: 'file',
      cups_queue: null,
      enabled: true,
    })
  ).printer;
  return printer;
}

test('catalog: create_shipment and print_label are supported with carrier, connection and printer options', async () => {
  const p = await printerFixture();
  const sim = (await ok('/api/shipping/example', 'POST', {})).id;
  const c = await ok(V2 + '/catalog');
  const create = c.effects.find((e: any) => e.type === 'create_shipment');
  const print = c.effects.find((e: any) => e.type === 'print_label');
  assert.equal(create.supported, undefined);
  assert.equal(print.supported, undefined);
  assert.deepEqual(create.params.find((x: any) => x.key === 'carrier').options.map((o: any) => o.value), ['demo', 'inpost', 'dpd']);
  assert.ok(create.params.find((x: any) => x.key === 'channel_id').options.some((o: any) => o.value === sim && /symulacja/.test(o.label)));
  assert.equal(create.params.find((x: any) => x.key === 'buy_without_confirmation').kind, 'bool');
  assert.ok(print.params.find((x: any) => x.key === 'printer_id').options.some((o: any) => o.value === p.id));
});

test('DEMO: empty params keep the previous behaviour; a second run changes nothing', async () => {
  const r = await rule([{ type: 'create_shipment', params: {} }]);
  const o = await order();
  const first = await runRule(r.id, o.id);
  assert.equal(first.status, 'done', JSON.stringify(first));
  assert.equal(first.effects[0].message, 'Utworzono i wydano przesyłkę DEMO');
  const [s] = await shipments(o.id);
  assert.equal(s.mode, 'demo');
  const again = await runRule(r.id, o.id);
  assert.equal(again.status, 'done');
  assert.deepEqual([again.effects[0].changed, again.effects[0].message], [false, 'Zamówienie ma już przesyłkę']);
  assert.equal((await shipments(o.id)).length, 1);
});

test('DEMO: an unpacked order is refused in Polish and nothing is created', async () => {
  const r = await rule([{ type: 'create_shipment', params: { carrier: 'demo' } }]);
  const o = await order({ packed: false });
  const run = await runRule(r.id, o.id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /spakuj/);
  assert.equal((await shipments(o.id)).length, 0);
});

test('InPost simulation: plan through preview → queue, quote and automatic label purchase', async () => {
  const ch = (await ok('/api/shipping/example', 'POST', {})).id;
  const r = await rule([{ type: 'create_shipment', params: { carrier: 'inpost', channel_id: ch, template: 'medium' } }]);
  const o = await order({ locker: 'WAW01M' });
  const run = await runRule(r.id, o.id);
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.match(run.effects[0].message, /Zlecono wycenę i zakup etykiety InPost \(paczkomat WAW01M, gabaryt B — średnia, symulacja\)/);
  let [p] = await plans(o.id);
  assert.equal(p.state, 'queued');
  assert.equal(p.input.target_point, 'WAW01M');
  assert.equal(p.input.template, 'medium');
  assert.equal(p.input.receiver.first_name, 'Anna');
  assert.equal(p.input.receiver.phone, '500600700');
  assert.equal(p.input.automation_buy.confirm_cost, false);
  await runInPost(p.job_id);
  [p] = await plans(o.id);
  assert.equal(p.state, 'buy_queued', 'The quoted plan queues its purchase on its own');
  await runInPost(p.job_id);
  [p] = await plans(o.id);
  assert.equal(p.state, 'ready');
  const [s] = await shipments(o.id);
  assert.deepEqual([s.carrier, s.mode, s.id], ['InPost ShipX', 'demo', p.shipment_id]);
  assert.equal(calls.length, 0, 'Simulation never calls ShipX');
  const again = await runRule(r.id, o.id);
  assert.deepEqual([again.effects[0].changed, again.effects[0].message], [false, 'Zamówienie ma już przesyłkę']);
});

test('InPost: an order without a parcel locker is refused and no plan is left behind', async () => {
  const ch = (await ok('/api/shipping/example', 'POST', {})).id;
  const r = await rule([{ type: 'create_shipment', params: { carrier: 'inpost', channel_id: ch } }]);
  const o = await order();
  const run = await runRule(r.id, o.id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /InPost: uzupełnij punkt odbioru/);
  assert.equal((await plans(o.id)).length, 0);
  assert.equal((await req(V2 + '/rules', 'POST', { name: 'Zła', trigger: 'order.matches', enabled: true, config: { version: 2, scope: 'orders', run: DEFAULT_RUN, conditions: { match: 'all', items: [] }, effects: [{ type: 'create_shipment', params: { carrier: 'inpost' } }], stop_further: false } })).statusCode, 422);
});

test('DPD simulation: plan through preview → queue and a label-ready shipment', async () => {
  const ch = (await ok('/api/dpd-shipping/example', 'POST', {})).channel_id;
  const r = await rule([{ type: 'create_shipment', params: { carrier: 'dpd', channel_id: ch, weight: 2.5, length: 30, width: 20, height: 10 } }]);
  const o = await order();
  const run = await runRule(r.id, o.id);
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.equal(run.effects[0].message, 'Zlecono utworzenie etykiety DPD (symulacja)');
  let [p] = await plans(o.id);
  assert.equal(p.state, 'queued');
  assert.equal(p.input.weight, 2.5);
  assert.deepEqual(p.input.dimensions, { length: 30, width: 20, height: 10 });
  assert.equal(p.input.receiver.name, 'Anna Odbiorca');
  assert.equal(p.input.cod, Number(o.total));
  await processDpd(await lease(p.job_id), { transport });
  [p] = await plans(o.id);
  assert.equal(p.state, 'ready');
  const [s] = await shipments(o.id);
  assert.deepEqual([s.carrier, s.status], ['DPD Polska', 'label_ready']);
  assert.equal(calls.length, 0, 'Simulation never calls DPD');
});

test('DPD: a sandbox connection without a known sender is refused in Polish', async () => {
  const ch = (
    await ok('/api/integrations', 'POST', {
      provider: 'dpd',
      name: 'DPD V2M sandbox',
      mode: 'sandbox',
      credentials: { username: 'fixture', password: 'fixture-password' },
      settings: { master_fid: '1495' },
    })
  ).id;
  const r = await rule([{ type: 'create_shipment', params: { carrier: 'dpd', channel_id: ch } }]);
  const o = await order();
  const run = await runRule(r.id, o.id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /Brak danych nadawcy DPD/);
  assert.equal((await plans(o.id)).length, 0);
});

test('production: never without buy_without_confirmation; with it the same ShipX path buys on the fake transport', async () => {
  // Saving a rule on a production connection without the flag is refused.
  const live = await inpostChannel('live');
  const refused = await req(V2 + '/rules', 'POST', {
    name: 'Prod',
    trigger: 'order.matches',
    enabled: true,
    config: { version: 2, scope: 'orders', run: { ...DEFAULT_RUN, manual_button: true, auto: false }, conditions: { match: 'all', items: [] }, effects: [{ type: 'create_shipment', params: { carrier: 'inpost', channel_id: live } }], stop_further: false },
  });
  assert.equal(refused.statusCode, 422);
  assert.match(refused.body, /produkcyjne/);
  // A sandbox connection switched to production after the rule was saved is refused at run time.
  const switched = await inpostChannel('sandbox');
  const r = await rule([{ type: 'create_shipment', params: { carrier: 'inpost', channel_id: switched } }]);
  await pool.query("UPDATE channels SET mode='live' WHERE id=$1", [switched]);
  const o = await order({ locker: 'WAW01M' });
  const run = await runRule(r.id, o.id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /produkcyjne/);
  assert.equal((await plans(o.id)).length, 0);
  assert.equal((await pool.query("SELECT 1 FROM jobs WHERE kind='shipping' AND payload->>'channel_id'=$1", [switched])).rowCount, 0);
  assert.equal(calls.length, 0);
  // Explicit consent: the plan is queued with the purchase confirmation and the label is bought.
  const consented = await rule([{ type: 'create_shipment', params: { carrier: 'inpost', channel_id: live, buy_without_confirmation: true } }]);
  const ok2 = await runRule(consented.id, o.id);
  assert.equal(ok2.status, 'done', JSON.stringify(ok2));
  assert.match(ok2.effects[0].message, /produkcja/);
  let [p] = await plans(o.id);
  assert.equal(p.input.automation_buy.confirm_cost, true);
  await runInPost(p.job_id);
  [p] = await plans(o.id);
  assert.equal(p.state, 'buy_queued');
  await runInPost(p.job_id);
  [p] = await plans(o.id);
  assert.equal(p.state, 'ready');
  const [s] = await shipments(o.id);
  assert.equal(s.mode, 'live');
  assert.ok(calls.every((x) => new URL(x.url).hostname.length > 0) && calls.some((x) => x.url.endsWith('/buy')));
});

test('print_label: queues the ready label on the chosen printer once per run', async () => {
  const p = await printerFixture();
  const o = await order();
  await runRule((await rule([{ type: 'create_shipment', params: {} }])).id, o.id);
  const r = await rule([
    { type: 'print_label', params: { printer_id: p.id } },
    { type: 'print_label', params: { printer_id: p.id } },
  ]);
  const run = await runRule(r.id, o.id);
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.equal(run.effects[0].changed, true);
  assert.match(run.effects[0].message, /Zlecono druk etykiety .* na drukarce „Drukarka V2M”/);
  assert.deepEqual([run.effects[1].changed, /już w kolejce/.test(run.effects[1].message)], [false, true]);
  const jobs = (await pool.query("SELECT * FROM print_jobs WHERE order_id=$1 AND source_kind='shipment_label'", [o.id])).rows;
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0].printer_id, jobs[0].state], [p.id, 'queued']);
  // A new run is a new request: one more job.
  await runRule(r.id, o.id);
  assert.equal((await pool.query('SELECT 1 FROM print_jobs WHERE order_id=$1', [o.id])).rowCount, 2);
});

test('print_label: later stock writes in the same transaction keep deferred constraints (bulk run of two orders)', async () => {
  // The label queue flushes constraints; the next order's DEMO shipment moves stock under the deferred
  // stock_location_* triggers (025) and must not see them fire mid-operation.
  const p = await printerFixture();
  const a = await order(), b = await order();
  const r = await rule([
    { type: 'create_shipment', params: {} },
    { type: 'print_label', params: { printer_id: p.id } },
  ]);
  const res = await req(V2 + '/rules/' + r.id + '/run', 'POST', { order_ids: [a.id, b.id] });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().runs.map((x: any) => x.status), ['done', 'done'], res.body);
  for (const o of [a, b]) {
    assert.equal((await shipments(o.id)).length, 1);
    assert.equal((await pool.query("SELECT 1 FROM print_jobs WHERE order_id=$1 AND source_kind='shipment_label'", [o.id])).rowCount, 1);
  }
});

test('print_label: refused without a label, for an inactive or foreign printer', async () => {
  const p = await printerFixture();
  const o = await order();
  const r = await rule([{ type: 'print_label', params: { printer_id: p.id } }]);
  const none = await runRule(r.id, o.id);
  assert.equal(none.status, 'failed');
  assert.match(none.error, /nie ma jeszcze przesyłki/);
  const foreign = await req(V2 + '/rules', 'POST', {
    name: 'Obca',
    trigger: 'order.matches',
    enabled: true,
    config: { version: 2, scope: 'orders', run: DEFAULT_RUN, conditions: { match: 'all', items: [] }, effects: [{ type: 'print_label', params: { printer_id: randomUUID() } }], stop_further: false },
  });
  assert.equal(foreign.statusCode, 422);
  assert.match(foreign.body, /należy do innej organizacji/);
  await runRule((await rule([{ type: 'create_shipment', params: {} }])).id, o.id);
  const station = (await pool.query('SELECT version FROM packing_stations WHERE id=$1', [p.station_id])).rows[0];
  const current = (await pool.query('SELECT version FROM print_printers WHERE id=$1', [p.id])).rows[0];
  await ok('/api/print-jobs/printers/' + p.id, 'PATCH', {
    client_key: randomUUID(),
    version: String(current.version),
    station_id: p.station_id,
    station_version: String(station.version),
    name: p.name,
    format: 'pdf',
    output_mode: 'file',
    cups_queue: null,
    enabled: false,
  });
  printer = undefined;
  const off = await runRule(r.id, o.id);
  assert.equal(off.status, 'failed');
  assert.match(off.error, /Drukarka „Drukarka V2M” jest nieaktywna/);
  assert.equal((await pool.query('SELECT 1 FROM print_jobs WHERE order_id=$1', [o.id])).rowCount, 0);
});
