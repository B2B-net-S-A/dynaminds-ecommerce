/** Carriers 234 (DHL Parcel Polska, Poczta Polska) on a real disposable clone with real migrate(): the
 * actual routes (buildApp) and job processors against the local fakes only (no network):
 * - a shipment per carrier: preview → queue → job → shipment row (carrier, numbers, COD) → stored label PDF
 *   → tracking read → dispatch; the plan keeps the COD account for the payment import;
 * - an idempotent retry after a lost create answer reconciles (DHL by reference, Poczta Polska by the
 *   buffer guid) without a second create;
 * - DHL courier booking and its cancellation on dhl234_pickups;
 * - InPost and DPD keep their own processes (the generic InPost routes refuse the new plans);
 * - the ten guards are true before and after.
 * Root-only on a fresh clone dynaminds_l3_20261026_NN with 234. Rerun = NEW clone. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { Problem } from '../server/errors';
import { failShipping } from '../server/shipping';
import { processDhl } from '../server/dhl-shipping';
import { processPocztaPolska } from '../server/pocztapolska-shipping';
import { processDhlPickup, failDhlPickup } from '../server/dhl-pickups';
import { createDhlFake, DHL_FAKE_USER, DHL_FAKE_PASSWORD } from '../server/carrier-dhl-fake';
import { pocztaPolskaFake } from '../server/carrier-pocztapolska-fake';
import { PP_TRACKING_ENDPOINT } from '../server/carrier-pocztapolska-tracking';
import { relaxPoolTimeouts } from './failure-helpers';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_l3_20261026_[0-9]{2}$/);
relaxPoolTimeouts();
const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid',
  'return_credit211_metadata_valid', 'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards'];
const NRB = '61109010140000071219812874';
const dhl = createDhlFake();
const pp = pocztaPolskaFake();
let loseDhlCreate = false;
const network: string[] = [];
const transport = async (url: string, init: RequestInit) => {
  network.push(new URL(url).host);
  if (url.startsWith('https://sandbox.dhl24.com.pl/')) {
    const res = await dhl.transport(url, init);
    if (loseDhlCreate && String(init.body).includes('createShipments')) {
      loseDhlCreate = false;
      throw new TypeError('fetch failed after commit'); // ACK loss: DHL created the shipment
    }
    return res;
  }
  if (url.startsWith('https://en-testwebapi.poczta-polska.pl/') || url === PP_TRACKING_ENDPOINT) return pp.transport(url, init);
  throw new Error('unexpected network ' + url);
};
let app: Awaited<ReturnType<typeof buildApp>>, cookie: string, warehouse: string;
const req = (url: string, method: any = 'GET', payload?: any) => app.inject({ url, method, payload, headers: { cookie } });
async function checked(url: string, method: any = 'GET', payload?: any) {
  const r = await req(url, method, payload);
  assert.ok(r.statusCode < 300, url + ' ' + r.body);
  return r.json();
}
async function guards() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query('SET LOCAL search_path TO "$user",public');
    await c.query("SET LOCAL statement_timeout='180s'");
    const out: Record<string, boolean> = {};
    for (const g of GUARDS) out[g] = (await c.query(`SELECT public.${g}() v`)).rows[0].v;
    await c.query('ROLLBACK');
    return out;
  } finally {
    c.release();
  }
}
const allTrue = Object.fromEntries(GUARDS.map((g) => [g, true]));
before(async () => {
  await migrate();
  await seed();
  assert.deepEqual(await guards(), allTrue, 'guards before');
  app = await buildApp({ integrationTransport: transport });
  cookie = (
    await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } })
  ).headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await checked('/api/warehouses')).data[0].id;
});
after(async () => {
  assert.deepEqual(await guards(), allTrue, 'guards after');
  await app.close();
  await pool.end();
});
const party = { name: 'QA Przewoźnik', address: 'Testowa 1', city: 'Warszawa', postalCode: '01-354', phone: '500600700', email: 'qa@example.test' };
/** A packed COD order of 2 × 50 zł (amount due 10 000 gr). */
async function packed() {
  const product = await checked('/api/products', 'POST', { sku: 'C234-' + randomUUID().slice(0, 10), name: 'Carrier synthetic', price: 5000, vat: 23, warehouse_id: warehouse, quantity: 10 });
  const order = await checked('/api/orders', 'POST', {
    customer_name: party.name, payment_mode: 'cod', email: party.email, warehouse_id: warehouse,
    address: { street: party.address, city: party.city, postal_code: party.postalCode, country: 'PL', phone: party.phone },
    items: [{ product_id: product.id, quantity: 2 }],
  });
  const status = async (s: string) => checked('/api/orders/' + order.id + '/status', 'PATCH',
    await legacySerialOrderStatusPayload((p) => checked(p, 'GET', undefined), '/api/orders/' + order.id + '/status', { status: s }));
  await status('picking');
  for (let n = 0; n < 2; n++) await checked('/api/orders/' + order.id + '/scan', 'POST', { code: product.sku });
  await status('packed');
  return checked('/api/orders/' + order.id);
}
async function run(kind: 'dhl' | 'pp' | 'pickup', jobId: string) {
  const job = (await pool.query("UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *", [jobId, randomUUID()])).rows[0];
  try {
    if (kind === 'dhl') await processDhl(job, { transport });
    else if (kind === 'pp') await processPocztaPolska(job, { transport });
    else await processDhlPickup(job, { transport });
    return null;
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    if (kind === 'pickup') await failDhlPickup(job, e);
    else await failShipping(job, e);
    return e;
  }
}
const plan = (id: string) => tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [id])).rows[0]);
const shipment = (id: string) => tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM shipments WHERE id=$1', [id])).rows[0]);
const dhlInput = (ch: string) => ({
  channel_id: ch, sender: party, receiver: party, weight: 1.25, dimensions: { length: 20, width: 15, height: 10 },
  content: 'Towar testowy', cod: 10000, cod_bank_account: NRB, insurance: 10000,
});
const ppInput = (ch: string) => ({
  channel_id: ch, service: 'pocztex_kurier', sender: party, receiver: party, weight: 1.25, dimensions: { length: 20, width: 15, height: 10 },
  content: 'Towar testowy', cod: 10000, cod_account: 'PL ' + NRB, insurance: 10000,
});
let dhlChannel = '', ppChannel = '';

test('channels: DHL and Poczta Polska settings are validated, credentials hidden, connection read on the fake', async () => {
  const bad = await req('/api/integrations', 'POST', { provider: 'dhl', name: 'Zły', mode: 'sandbox', credentials: { username: 'a', password: 'b' }, settings: { sap_account: 'x1' } });
  assert.ok(bad.statusCode >= 400 && bad.statusCode < 500);
  dhlChannel = (await checked('/api/integrations', 'POST', {
    provider: 'dhl', name: 'DHL test', mode: 'sandbox', credentials: { username: DHL_FAKE_USER, password: DHL_FAKE_PASSWORD },
    settings: { sap_account: '1234567', endpoint: 'https://attacker.example.test' },
  })).id;
  ppChannel = (await checked('/api/integrations', 'POST', {
    provider: 'pocztapolska', name: 'Poczta Polska test', mode: 'sandbox', credentials: pp.credentials, settings: { urzad_nadania: pp.settings.urzad_nadania },
  })).id;
  const list = await checked('/api/integrations');
  const d = list.channels.find((c: any) => c.id === dhlChannel);
  assert.deepEqual(d.settings, { sap_account: '1234567' }, 'the endpoint override is not stored');
  assert(!JSON.stringify(list).includes(DHL_FAKE_PASSWORD) && !JSON.stringify(list).includes(pp.credentials.password));
  await checked('/api/integrations/' + dhlChannel + '/test', 'POST', {});
  await checked('/api/integrations/' + ppChannel + '/test', 'POST', {});
  assert.deepEqual([...new Set(network)].sort(), ['en-testwebapi.poczta-polska.pl', 'sandbox.dhl24.com.pl']);
  const channels = (await checked('/api/shipping/channels')).data.map((c: any) => c.provider);
  assert(channels.includes('dhl') && channels.includes('pocztapolska'));
});

test('DHL: shipment with COD → stored label → tracking → dispatch; InPost routes refuse the plan', async () => {
  const order = await packed();
  const preview = await checked('/api/orders/' + order.id + '/dhl-shipping/preview', 'POST', dhlInput(dhlChannel));
  assert.equal(preview.payload.shipment.receiver.postalCode, '01354');
  assert.match(preview.payload.reference, /^DY[0-9A-F]{20}$/);
  assert.equal((await req('/api/dhl-shipping/' + preview.id + '/queue', 'POST', {})).statusCode, 422, 'contract confirmation required');
  for (const path of ['/buy', '/refresh', '/reconcile'])
    assert.equal((await req('/api/shipping-plans/' + preview.id + path, 'POST', { offer_id: '1' })).statusCode, 422, 'InPost route ' + path);
  assert.equal((await req('/api/shipping-plans/' + preview.id + '/queue', 'POST', {})).statusCode, 422, 'InPost queue');
  const q = await checked('/api/dhl-shipping/' + preview.id + '/queue', 'POST', { confirm_external: true, ack_contract_rate: true });
  assert.equal((await checked('/api/dhl-shipping/' + preview.id + '/queue', 'POST', { confirm_external: true, ack_contract_rate: true })).job_id, q.job_id);
  assert.equal(await run('dhl', q.job_id), null);
  const p = await plan(preview.id);
  assert.equal(p.state, 'ready');
  assert.equal(p.phase, 'confirmed');
  assert.deepEqual(p.result.cod, { amount: 10000, currency: 'PLN', bank_account: NRB });
  const s = await shipment(p.shipment_id);
  assert.equal(s.carrier, 'DHL Parcel Polska');
  assert.equal(s.mode, 'sandbox');
  assert.equal(s.tracking_number, p.remote_id);
  assert.equal(s.external_id, p.remote_id);
  assert.equal(Number(s.cod_expected), 10000, 'COD recorded on the shipment');
  assert.equal(dhl.shipments.size, 1);
  const label = await req('/api/shipments/' + s.id + '/label');
  assert.equal(label.statusCode, 200);
  assert.equal(label.headers['content-type'], 'application/pdf');
  assert.equal(label.rawPayload.subarray(0, 5).toString(), '%PDF-');
  const before = dhl.calls.length;
  await req('/api/shipments/' + s.id + '/label');
  assert.equal(dhl.calls.length, before, 'the stored label is served without a provider call');
  dhl.setEvents(s.tracking_number, [{ status: 'PODJ', timestamp: '2026-10-26 08:00:00' }, { status: 'DWP', timestamp: '2026-10-26 09:30:00' }]);
  const t = await checked('/api/shipments/' + s.id + '/tracking', 'POST', {});
  assert.equal(t.applied, true);
  assert.equal(t.status, 'out_for_delivery');
  assert.equal((await shipment(s.id)).status, 'out_for_delivery');
  const shipped = await checked('/api/dhl-shipping/' + preview.id + '/dispatch', 'POST', {});
  assert.equal(shipped.status, 'shipped');
  assert.equal((await plan(preview.id)).state, 'dispatched');
});

test('DHL: lost createShipments answer → retry reconciles by reference, never a second create', async () => {
  const order = await packed();
  const preview = await checked('/api/orders/' + order.id + '/dhl-shipping/preview', 'POST', dhlInput(dhlChannel));
  const q = await checked('/api/dhl-shipping/' + preview.id + '/queue', 'POST', { confirm_external: true, ack_contract_rate: true });
  const creates = () => dhl.calls.filter((c) => c.method === 'createShipments').length;
  const before = creates(), stored = dhl.shipments.size;
  loseDhlCreate = true;
  const lost = await run('dhl', q.job_id);
  assert.equal(lost?.status, 504);
  assert.match(lost!.code ?? '', /DHL_UNCERTAIN/);
  assert.equal(dhl.shipments.size, stored + 1, 'DHL committed the shipment');
  let p = await plan(preview.id);
  assert.equal(p.phase, 'create_started');
  assert.equal(p.state, 'queued', 'a retryable uncertainty keeps the job');
  assert.equal(await run('dhl', q.job_id), null);
  assert.equal(creates(), before + 1, 'exactly one createShipments');
  assert(dhl.calls.some((c) => c.method === 'getMyShipments'), 'reconciled by getMyShipments');
  p = await plan(preview.id);
  assert.equal(p.state, 'ready');
  assert.equal(p.result.reconciled, true);
  const created = [...dhl.shipments.values()].find((x) => x.reference === preview.payload.reference)!;
  assert.equal(p.remote_id, created.waybill);
});

test('Poczta Polska: shipment with COD → stored label → tracking; lost addShipment answer reads the buffer by guid', async () => {
  const order = await packed();
  const preview = await checked('/api/orders/' + order.id + '/pocztapolska-shipping/preview', 'POST', ppInput(ppChannel));
  assert.equal(preview.payload.pobranie.kwotaPobrania, 10000);
  assert.equal(preview.payload.guid, preview.id.replace(/-/g, '').toUpperCase());
  const q = await checked('/api/pocztapolska-shipping/' + preview.id + '/queue', 'POST', { confirm_external: true, ack_contract_rate: true });
  const adds = () => pp.calls.filter((c) => c === 'addShipment').length;
  const before = adds();
  pp.fail({ kind: 'lose_answer' });
  const lost = await run('pp', q.job_id);
  assert.equal(lost?.code, 'PP_OUTCOME_UNCERTAIN');
  assert.equal(pp.buffer.size, 1, 'eNadawca committed the parcel');
  assert.equal((await plan(preview.id)).phase, 'create_started');
  assert.equal(await run('pp', q.job_id), null);
  assert.equal(adds(), before + 1, 'exactly one addShipment');
  const p = await plan(preview.id);
  assert.equal(p.state, 'ready');
  assert.equal(p.result.reconciled, true);
  assert.equal(p.result.guid, preview.payload.guid);
  assert.deepEqual(p.result.cod, { amount: 10000, currency: 'PLN', bank_account: NRB });
  const s = await shipment(p.shipment_id);
  assert.equal(s.carrier, 'Poczta Polska');
  assert.equal(s.tracking_number, pp.buffer.get(preview.payload.guid)!.number);
  assert.equal(s.external_id, s.tracking_number);
  assert.equal(Number(s.cod_expected), 10000);
  const label = await req('/api/shipments/' + s.id + '/label');
  assert.equal(label.statusCode, 200);
  assert.equal(label.rawPayload.subarray(0, 5).toString(), '%PDF-');
  pp.setTracking(s.tracking_number, `<ns:sprawdzPrzesylkeResponse><return><numer>${s.tracking_number}</numer><status>0</status><danePrzesylki><zdarzenia><zdarzenie><czas>2026-10-26 09:15</czas><kod>P_NAD</kod><nazwa>Nadanie</nazwa><konczace>false</konczace></zdarzenie></zdarzenia></danePrzesylki></return></ns:sprawdzPrzesylkeResponse>`);
  const t = await checked('/api/shipments/' + s.id + '/tracking', 'POST', {});
  assert.equal(t.applied, true);
  assert.equal(t.tracking_details.length, 1);
  assert.equal((await checked('/api/pocztapolska-shipping/' + preview.id + '/dispatch', 'POST', {})).status, 'shipped');
});

test('Poczta Polska local example: DEMO number, no HTTP', async () => {
  const order = await packed();
  const example = (await checked('/api/pocztapolska-shipping/example', 'POST', {})).channel_id;
  const calls = network.length;
  const preview = await checked('/api/orders/' + order.id + '/pocztapolska-shipping/preview', 'POST', ppInput(example));
  const q = await checked('/api/pocztapolska-shipping/' + preview.id + '/queue', 'POST', {});
  assert.equal(await run('pp', q.job_id), null);
  const p = await plan(preview.id);
  assert.equal(p.result.scope, 'local_simulation');
  const s = await shipment(p.shipment_id);
  assert.equal(s.mode, 'demo');
  assert.equal(s.tracking_number, 'DEMO-PP-' + preview.id.slice(0, 12));
  assert.equal(network.length, calls, 'no HTTP for the example');
});

test('DHL courier booking: preview → queue → booked; cancel → cancelled; a second booking of the same parcel refuses', async () => {
  const order = await packed();
  const preview = await checked('/api/orders/' + order.id + '/dhl-shipping/preview', 'POST', dhlInput(dhlChannel));
  const q = await checked('/api/dhl-shipping/' + preview.id + '/queue', 'POST', { confirm_external: true, ack_contract_rate: true });
  assert.equal(await run('dhl', q.job_id), null);
  const sid = (await plan(preview.id)).shipment_id;
  const day = new Date(Date.now() + 86400000);
  while ([0, 6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() + 1);
  const body = { client_key: randomUUID(), shipment_ids: [sid], date: day.toISOString().slice(0, 10), from: '10:00', to: '14:00', postcode: '01-354' };
  const pick = await checked('/api/integrations/' + dhlChannel + '/dhl-pickups/preview', 'POST', body);
  assert.equal(pick.state, 'preview');
  assert.equal((await checked('/api/integrations/' + dhlChannel + '/dhl-pickups/preview', 'POST', body)).id, pick.id, 'same key replays');
  assert.equal((await req('/api/integrations/' + dhlChannel + '/dhl-pickups/preview', 'POST', { ...body, to: '15:00' })).statusCode, 409);
  assert.equal((await req('/api/dhl-pickups/' + pick.id + '/queue', 'POST', {})).statusCode, 422);
  const job = await checked('/api/dhl-pickups/' + pick.id + '/queue', 'POST', { confirm_external: true });
  assert.equal(await run('pickup', job.job_id), null);
  const booked = (await checked('/api/integrations/' + dhlChannel + '/dhl-pickups')).data.find((r: any) => r.id === pick.id);
  assert.equal(booked.state, 'booked');
  assert.equal(booked.order_ids.length, 1);
  assert.equal(dhl.bookings.size, 1);
  assert.equal((await req('/api/integrations/' + dhlChannel + '/dhl-pickups/preview', 'POST', { ...body, client_key: randomUUID() })).statusCode, 409);
  const cancel = await checked('/api/dhl-pickups/' + pick.id + '/cancel', 'POST', {});
  assert.equal(await run('pickup', cancel.job_id), null);
  const cancelled = (await checked('/api/integrations/' + dhlChannel + '/dhl-pickups')).data.find((r: any) => r.id === pick.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal([...dhl.bookings.values()][0].cancelled, true);
});

test('the shipment guard admits a DHL or Poczta Polska shipment only from its own running plan', async () => {
  const order = await packed();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [DEMO_TENANT]);
    await c.query(
      "INSERT INTO shipping_plans(id,tenant_id,order_id,channel_id,actor_id,state,phase,input,payload,order_snapshot,remote_id) SELECT $1,$2,$3,$4,(SELECT user_id FROM memberships WHERE tenant_id=$2 AND role='admin' LIMIT 1),'queued','numbers_ready',$5,'{}','{}','1234567890'",
      [randomUUID(), DEMO_TENANT, order.id, dhlChannel, JSON.stringify({ provider: 'dhl', cod: 10000 })],
    );
    await assert.rejects(
      c.query("INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,status,channel_id,external_id,cod_expected) VALUES($1,$2,$3,'DHL Parcel Polska','1234567890','sandbox','label_ready',$4,'1234567890',10000)",
        [randomUUID(), DEMO_TENANT, order.id, dhlChannel]),
      /Aktywny plan nadania blokuje inną paczkę/,
      'no running shipping.dhl job holds the plan',
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
