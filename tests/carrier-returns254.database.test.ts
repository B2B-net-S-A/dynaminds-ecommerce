/** Return labels, migration 254_carrier_returns (prepared as 261; DPD Polska, InPost ShipX) on a real disposable
 * clone: the real migrate() applies 254 and its ledger row (the prepared run applied 261 by hand). Real routes (buildApp) and job processors against a local fake only:
 * - a dispatched DPD shipment → return preview (idempotent client key) → queue (same job) → worker → label PDF
 *   stored and served without a provider call; the original shipment, order and stock stay as they were;
 * - a lost DPD create answer is recovered by the label read (one create); a clean DPD rejection fails locally;
 * - InPost: create → offer within the approved ceiling → buy → label; a lost create answer is found in the
 *   history (one POST); a dearer offer is never bought;
 * - refusals: not dispatched yet, a second live return, another tenant (404), immutable confirmed row;
 * - the ten guards and warehouse_wz_issuer_guards are true before and after.
 * Root-only on a fresh clone dynaminds_m254_YYYYMMDD_NN of the restored template. Rerun = NEW clone. */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { encrypt } from '../server/security';
import { Problem } from '../server/errors';
import { processDpd } from '../server/dpd-shipping';
import { processShipping, failShipping } from '../server/shipping';
import { processCarrierReturn, failCarrierReturn } from '../server/carrier-returns';
import { relaxPoolTimeouts } from './failure-helpers';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_m(?:25[456789]|26[0123])_202610(?:29|30)_[0-9]{2}$/, 'fresh clone dynaminds_m254_YYYYMMDD_NN of the restored template');
relaxPoolTimeouts(900);
const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid',
  'return_credit211_metadata_valid', 'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards', 'warehouse_wz_issuer_guards'];
const PDF = Buffer.from('%PDF-1.4\nreturn-fixture').toString('base64');
const calls: { host: string; path: string; method: string; body: any }[] = [];
const dpdRefs = new Map<string, string>(), shipx = new Map<string, any>();
let next = 70000, loseDpdCreate = false, rejectDpd = false, loseShipxCreate = false, returnRate = '15.99';
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status });
const transport = async (url: string, init: RequestInit) => {
  const u = new URL(url), method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ host: u.host, path: u.pathname, method, body });
  if (u.host === 'dpdservicesdemo.dpd.com.pl') {
    const op = u.pathname.split('/').at(-1);
    if (op === 'postalCode') return json({ status: 'OK' });
    if (op === 'generatePackagesNumbers') {
      const reference = body.packages[0].reference;
      if (rejectDpd)
        return json({ status: 'INCORRECT_DATA', packages: [{ status: 'INCORRECT_DATA', reference, parcels: [{ status: 'INCORRECT_DATA', reference, waybill: null }] }] });
      const waybill = '0000' + next++ + 'U';
      dpdRefs.set(reference, waybill);
      if (loseDpdCreate) { loseDpdCreate = false; throw new Problem(502, 'Lost DPD response'); }
      return json({ status: 'OK', packages: [{ status: 'OK', reference, parcels: [{ status: 'OK', reference, waybill }] }] });
    }
    assert.equal(op, 'generateSpedLabels');
    const reference = body.labelSearchParams.session.packages[0].parcels[0].reference;
    if (!dpdRefs.has(reference)) return json({ status: 'NOT_FOUND' });
    return json({ status: 'OK', session: { statusInfo: { status: 'OK' }, packages: [{ statusInfo: { status: 'OK' }, parcels: [{ statusInfo: { status: 'OK' }, reference, waybill: dpdRefs.get(reference) }] }] }, documentData: PDF });
  }
  assert.equal(u.host, 'sandbox-api-shipx-pl.easypack24.net');
  if (u.pathname.endsWith('/label')) return new Response(Buffer.from(PDF, 'base64'), { headers: { 'content-type': 'application/pdf' } });
  if (u.pathname.includes('/organizations/')) {
    if (method === 'GET') return json({ items: [...shipx.values()], count: shipx.size });
    const id = String(next++);
    const r = { ...body, id, status: 'offers_prepared', tracking_number: null, cod: body.cod ?? null, insurance: body.insurance ?? null,
      offers: [{ id: next++, service: { id: body.parcels[0].template ? 'inpost_locker_standard' : 'inpost_courier_standard' }, status: 'available',
        rate: body.reference.startsWith('DYNA-') && body.sender ? returnRate : '12.99', currency: 'PLN', expires_at: new Date(Date.now() + 300000).toISOString() }],
      selected_offer: null };
    shipx.set(id, r);
    if (loseShipxCreate) { loseShipxCreate = false; throw new Problem(502, 'Lost ShipX response'); }
    return json({ ...r, offers: [] }, 201);
  }
  const seg = u.pathname.split('/'), id = seg.at(-1) === 'buy' ? seg.at(-2)! : seg.at(-1)!, r = shipx.get(id);
  if (!r) return json({}, 404);
  if (method === 'POST') {
    assert.equal(body.offer_id, r.offers[0].id);
    Object.assign(r, { selected_offer: { ...r.offers[0], status: 'selected' }, service: r.offers[0].service.id, status: 'confirmed', tracking_number: '6900' + id });
  }
  return json(r);
};
let app: Awaited<ReturnType<typeof buildApp>>, cookie: string, other: string, warehouse: string;
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) => app.inject({ url, method, payload, headers: { cookie: auth } });
async function checked(url: string, method: any = 'GET', payload?: any, auth = cookie) {
  const r = await req(url, method, payload, auth);
  assert.ok(r.statusCode < 300, url + ' ' + r.statusCode + ' ' + r.body);
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
  assert.equal((await pool.query("SELECT count(*)::int n FROM migrations WHERE name='254_carrier_returns'")).rows[0].n, 1, 'migrate() applied 254');
  await seed();
  assert.deepEqual(await guards(), allTrue, 'guards before');
  app = await buildApp({ integrationTransport: transport });
  const login = async (email: string) =>
    (await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } })).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  warehouse = (await checked('/api/warehouses')).data[0].id;
});
after(async () => {
  assert.deepEqual(await guards(), allTrue, 'guards after');
  await app.close();
  await pool.end();
});
beforeEach(() => {
  calls.length = 0;
  loseDpdCreate = rejectDpd = loseShipxCreate = false;
  returnRate = '15.99';
});
/** A packed order of 2 × 100 zł, half paid, half COD. */
async function packed() {
  const p = await checked('/api/products', 'POST', { sku: 'RET261-' + randomUUID().slice(0, 10), name: 'Zwrot QA', price: 10000, vat: 23, warehouse_id: warehouse, quantity: 10 });
  const o = await checked('/api/orders', 'POST', {
    customer_name: 'Kupujący QA', payment_mode: 'cod', email: 'buyer@example.test', warehouse_id: warehouse,
    address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' },
    items: [{ product_id: p.id, quantity: 2 }],
  });
  await checked('/api/orders/' + o.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(o.version), kind: 'receipt', amount: 10000, currency: 'PLN', reference: 'Zaliczka QA', confirmed: true });
  const status = async (s: string) => checked('/api/orders/' + o.id + '/status', 'PATCH',
    await legacySerialOrderStatusPayload((x) => checked(x, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: s }));
  await status('picking');
  for (let n = 0; n < 2; n++) await checked('/api/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  await status('packed');
  return o;
}
async function channel(provider: 'dpd' | 'inpost', simulation = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,$3,$4,'sandbox',$5,$6)", [
      id, DEMO_TENANT, provider, provider + ' zwroty QA',
      encrypt(provider === 'dpd' ? { username: 'fixture', password: 'fixture-password' } : { access_token: 'fixture' }),
      JSON.stringify(provider === 'dpd' ? { master_fid: '1495', simulation } : { organization_id: '1', simulation }),
    ]),
  );
  return id;
}
async function lease(jobId: string) {
  return (await pool.query("UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *", [jobId, randomUUID()])).rows[0];
}
async function runShipping(jobId: string, dpd = false) {
  const job = await lease(jobId);
  try {
    if (dpd) await processDpd(job, { transport });
    else await processShipping(job, { transport });
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    await failShipping(job, e);
  }
}
async function runReturn(jobId: string) {
  const job = await lease(jobId);
  try {
    await processCarrierReturn(job, { transport });
    return null;
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    await failCarrierReturn(job, e);
    return e;
  }
}
const row = (id: string) => tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM carrier261_returns WHERE id=$1', [id])).rows[0]);
const party = { name: 'Kupujący QA', address: 'Testowa 1', city: 'Warszawa', postalCode: '00-001', phone: '500600700', email: 'buyer@example.test' };
const merchant = { name: 'Magazyn zwrotów QA', address: 'Zwrotna 2', city: 'Łódź', postalCode: '90-001', phone: '500600701', email: 'returns@example.test' };
/** A DPD shipment created and dispatched through the real routes and worker. */
async function dispatchedDpd() {
  const o = await packed(), ch = await channel('dpd');
  const p = await checked('/api/orders/' + o.id + '/dpd-shipping/preview', 'POST', {
    channel_id: ch, sender: merchant, receiver: party, weight: 1.5, dimensions: { length: 30, width: 20, height: 10 }, content: 'Towar QA', cod: 10000, insurance: 10000,
  });
  await runShipping((await checked('/api/dpd-shipping/' + p.id + '/queue', 'POST', { confirm_external: true, ack_contract_rate: true })).job_id, true);
  await checked('/api/dpd-shipping/' + p.id + '/dispatch', 'POST', {});
  const s = (await tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM shipments WHERE order_id=$1', [o.id])).rows))[0];
  assert.ok(s?.dispatched_at, 'DPD shipment dispatched');
  return { o, s };
}
async function dispatchedInPost() {
  const o = await packed(), ch = await channel('inpost');
  const p = await checked('/api/orders/' + o.id + '/shipping/preview', 'POST', {
    channel_id: ch, service: 'inpost_locker_standard', target_point: 'WAW01A',
    receiver: { first_name: 'Kupujący', last_name: 'QA', email: 'buyer@example.test', phone: '500600700' }, cod: 10000, insurance: 10000,
  });
  await runShipping((await checked('/api/shipping-plans/' + p.id + '/queue', 'POST', {})).job_id);
  const quoted = await tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [p.id])).rows[0]);
  assert.equal(quoted.state, 'quoted', quoted.error);
  await runShipping((await checked('/api/shipping-plans/' + p.id + '/buy', 'POST', { offer_id: quoted.offers[0].id, confirm_cost: true, ack_unknown_rate: true })).job_id);
  await checked('/api/shipping-plans/' + p.id + '/dispatch', 'POST', {});
  const s = (await tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM shipments WHERE order_id=$1', [o.id])).rows))[0];
  assert.ok(s?.dispatched_at, 'InPost shipment dispatched');
  return { o, s };
}
const dpdReturn = (key = randomUUID()) => ({ client_key: key, sender: party, receiver: merchant, weight: 1.5, dimensions: { length: 30, width: 20, height: 10 }, content: 'Zwrot towaru' });
const inpostReturn = (max = 2000, key = randomUUID()) => ({
  client_key: key, sender: { first_name: 'Kupujący', last_name: 'QA', email: 'buyer@example.test', phone: '500600700' },
  receiver: { first_name: 'Magazyn', last_name: 'Zwrotów', email: 'returns@example.test', phone: '500600701' }, target_point: 'LOD02B', max_rate_minor: max,
});
const count = (path: string, method = 'POST') => calls.filter((x) => x.path.endsWith(path) && x.method === method).length;

test('DPD return label: idempotent preview and queue, one create, stored PDF; original shipment and order untouched', async () => {
  const { o, s } = await dispatchedDpd();
  const before = await checked('/api/orders/' + o.id);
  const key = randomUUID();
  const preview = await checked('/api/shipments/' + s.id + '/returns/preview', 'POST', dpdReturn(key));
  assert.equal(preview.provider, 'dpd');
  assert.equal(preview.state, 'preview');
  assert.equal(preview.payload.packages[0].sender.name, party.name);
  assert.equal(preview.payload.packages[0].receiver.name, merchant.name);
  assert.equal(preview.payload.packages[0].services.length, 0, 'a return carries no COD');
  assert.equal((await checked('/api/shipments/' + s.id + '/returns/preview', 'POST', dpdReturn(key))).id, preview.id);
  const reused = await req('/api/shipments/' + s.id + '/returns/preview', 'POST', { ...dpdReturn(key), weight: 2 });
  assert.equal(reused.statusCode, 409);
  const unconfirmed = await req('/api/carrier-returns/' + preview.id + '/queue', 'POST', {});
  assert.equal(unconfirmed.statusCode, 422);
  const q = await checked('/api/carrier-returns/' + preview.id + '/queue', 'POST', { confirm_external: true });
  assert.equal((await checked('/api/carrier-returns/' + preview.id + '/queue', 'POST', { confirm_external: true })).job_id, q.job_id);
  calls.length = 0;
  assert.equal(await runReturn(q.job_id), null);
  const r = await row(preview.id);
  assert.equal(r.state, 'label_ready', r.error);
  assert.equal(r.tracking_number, dpdRefs.get(r.reference));
  assert.equal(r.result.scope, 'external_sandbox_verified');
  assert.equal(count('generatePackagesNumbers'), 1);
  calls.length = 0;
  const pdf = await req('/api/carrier-returns/' + preview.id + '/label');
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.ok(pdf.rawPayload.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.equal(calls.length, 0, 'the stored label needs no provider call');
  const listed = await checked('/api/shipments/' + s.id + '/returns');
  assert.equal(listed.data[0].id, preview.id);
  assert.equal(listed.data[0].label_base64, undefined);
  const after = await checked('/api/orders/' + o.id);
  assert.equal(after.status, before.status);
  assert.equal(after.version, before.version);
  const rows = await tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT id,dispatched_at FROM shipments WHERE order_id=$1', [o.id])).rows);
  assert.deepEqual(rows.map((x) => x.id), [s.id], 'no shipments row for the return');
  // One live return per shipment; the confirmed row is immutable even for the owner.
  const second = await checked('/api/shipments/' + s.id + '/returns/preview', 'POST', dpdReturn());
  assert.equal((await req('/api/carrier-returns/' + second.id + '/queue', 'POST', { confirm_external: true })).statusCode, 409);
  await assert.rejects(pool.query("UPDATE carrier261_returns SET tracking_number='X1' WHERE id=$1", [preview.id]), /niezmienna/);
  await assert.rejects(pool.query('DELETE FROM carrier261_returns WHERE id=$1', [preview.id]), /trwała/);
});

test('DPD lost create answer: the retry reads the label by reference, never a second create', async () => {
  const { s } = await dispatchedDpd();
  const p = await checked('/api/shipments/' + s.id + '/returns/preview', 'POST', dpdReturn());
  const q = await checked('/api/carrier-returns/' + p.id + '/queue', 'POST', { confirm_external: true });
  calls.length = 0;
  loseDpdCreate = true;
  const e = await runReturn(q.job_id);
  assert.equal(e?.status, 502, e?.message ?? "");
  let r = await row(p.id);
  assert.equal(r.state, 'queued');
  assert.equal(r.phase, 'create_started');
  assert.equal(await runReturn(q.job_id), null);
  r = await row(p.id);
  assert.equal(r.state, 'label_ready', r.error);
  assert.equal(r.tracking_number, dpdRefs.get(r.reference));
  assert.equal(count('generatePackagesNumbers'), 1);
  assert.equal(count('generateSpedLabels'), 1);
});

test('DPD clean rejection fails locally, can be withdrawn; a shipment not yet dispatched is refused', async () => {
  const { s } = await dispatchedDpd();
  const p = await checked('/api/shipments/' + s.id + '/returns/preview', 'POST', dpdReturn());
  const q = await checked('/api/carrier-returns/' + p.id + '/queue', 'POST', { confirm_external: true });
  rejectDpd = true;
  const rejected = await runReturn(q.job_id);
  assert.equal(rejected?.status, 422, rejected?.message ?? "");
  const r = await row(p.id);
  assert.deepEqual([r.state, r.phase], ['failed', 'rejected']);
  assert.equal((await req('/api/carrier-returns/' + p.id + '/reconcile', 'POST', {})).statusCode, 409);
  assert.equal((await checked('/api/carrier-returns/' + p.id + '/cancel', 'POST', {})).state, 'cancelled');
  // A packed order with a label but no dispatch has no return yet.
  const o = await packed(), ch = await channel('dpd');
  const plan = await checked('/api/orders/' + o.id + '/dpd-shipping/preview', 'POST', {
    channel_id: ch, sender: merchant, receiver: party, weight: 1.5, dimensions: { length: 30, width: 20, height: 10 }, content: 'Towar QA', cod: 10000, insurance: 10000,
  });
  rejectDpd = false;
  await runShipping((await checked('/api/dpd-shipping/' + plan.id + '/queue', 'POST', { confirm_external: true, ack_contract_rate: true })).job_id, true);
  const ready = (await tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT * FROM shipments WHERE order_id=$1', [o.id])).rows))[0];
  assert.equal((await req('/api/shipments/' + ready.id + '/returns/preview', 'POST', dpdReturn())).statusCode, 409);
});

test('InPost return label: create, offer within the approved ceiling, one buy, label; lost create found in history', async () => {
  const { s } = await dispatchedInPost();
  const p = await checked('/api/shipments/' + s.id + '/returns/preview', 'POST', inpostReturn(2000));
  assert.equal(p.provider, 'inpost');
  assert.equal(p.payload.custom_attributes.target_point, 'LOD02B');
  const q = await checked('/api/carrier-returns/' + p.id + '/queue', 'POST', { confirm_external: true });
  calls.length = 0;
  loseShipxCreate = true;
  assert.equal((await runReturn(q.job_id))?.status, 502);
  assert.equal((await row(p.id)).phase, 'create_started');
  assert.equal(await runReturn(q.job_id), null);
  const r = await row(p.id);
  assert.equal(r.state, 'label_ready', r.error);
  assert.equal(r.tracking_number, '6900' + r.remote_id);
  assert.equal(r.result.rate_minor, 1599);
  assert.equal(count('/organizations/1/shipments'), 1, 'one create');
  assert.equal(count('/organizations/1/shipments', 'GET'), 1, 'history read once');
  assert.equal(count('/buy'), 1, 'one purchase');
  const pdf = await req('/api/carrier-returns/' + p.id + '/label');
  assert.equal(pdf.statusCode, 200);
});

test('InPost return dearer than the approved ceiling is never bought', async () => {
  const { s } = await dispatchedInPost();
  const p = await checked('/api/shipments/' + s.id + '/returns/preview', 'POST', inpostReturn(1000));
  const q = await checked('/api/carrier-returns/' + p.id + '/queue', 'POST', { confirm_external: true });
  calls.length = 0;
  const e = await runReturn(q.job_id);
  assert.equal(e?.status, 422, e?.message ?? "");
  assert.match(e!.message, /przekracza zatwierdzony limit/);
  const r = await row(p.id);
  assert.equal(r.state, 'failed', 'created at InPost, not bought: no money moved');
  assert.equal(r.phase, 'created');
  assert.equal(count('/buy'), 0);
  assert.equal((await req('/api/carrier-returns/' + p.id + '/label')).statusCode, 404);
  // The author withdraws it and the shipment can get a new return with a higher ceiling.
  assert.equal((await checked('/api/carrier-returns/' + p.id + '/cancel', 'POST', {})).state, 'cancelled');
  const again = await checked('/api/shipments/' + s.id + '/returns/preview', 'POST', inpostReturn(2000));
  await runReturn((await checked('/api/carrier-returns/' + again.id + '/queue', 'POST', { confirm_external: true })).job_id);
  assert.equal((await row(again.id)).state, 'label_ready');
  assert.equal(count('/buy'), 1);
});

test('tenant isolation: another tenant cannot list, preview, queue or download a return label', async () => {
  const { s } = await dispatchedDpd();
  const p = await checked('/api/shipments/' + s.id + '/returns/preview', 'POST', dpdReturn());
  await runReturn((await checked('/api/carrier-returns/' + p.id + '/queue', 'POST', { confirm_external: true })).job_id);
  assert.equal((await row(p.id)).state, 'label_ready');
  assert.equal((await req('/api/shipments/' + s.id + '/returns', 'GET', undefined, other)).statusCode, 404);
  assert.equal((await req('/api/shipments/' + s.id + '/returns/preview', 'POST', dpdReturn(), other)).statusCode, 404);
  assert.equal((await req('/api/carrier-returns/' + p.id + '/queue', 'POST', { confirm_external: true }, other)).statusCode, 404);
  assert.equal((await req('/api/carrier-returns/' + p.id + '/label', 'GET', undefined, other)).statusCode, 404);
  const seen = await tenantTx(DEMO_TENANT, async (c) => (await c.query('SELECT count(*)::int n FROM carrier261_returns WHERE id=$1', [p.id])).rows[0].n);
  assert.equal(seen, 1);
});
