/** Migration 242 (docs/parity/PAYU242-20261027.md): the buyer pays the order's open balance from the customer
 * portal through PayU (COM-PORTAL-6). PayU runs as the local stateful fake (DYNA_PAYU_FAKE=local), nothing leaves
 * the machine. Database test on a disposable clone migrated to HEAD: configuration rights, the portal button,
 * the session amount, signed notifications (bad signature, peer, token, unknown session, replay, out of order,
 * COMPLETED after CANCELED, amount mismatch), exactly one payment, a lost notification read back, a refund, the
 * settlement report and tenant isolation. */
process.env.DYNA_PAYU_FAKE = 'local';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantReadTx } from '../server/db';
import { paymentBalance } from '../server/payments';
import { payu242Fake, payu242FakeNotification } from '../server/payu242';
import { PAYU242_NOTIFY_IPS } from '../server/payu242-session';
import { seed, DEMO_TENANT } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:24[23456789]|25[0123456789]|26[0123])_202610(?:27|28|29|30)_[0-9]{2}$/, 'fresh clone dynaminds_m242_20261027_NN (or m243/m244/m245/m246/m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 243/244/245/246/247/248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');
// The ungated local preflight reads every guard (several seconds); same allowance as messages-s5.
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

let app: Awaited<ReturnType<typeof buildApp>>;
const cookies: Record<string, string> = {};
let warehouse = '';
const SANDBOX_PEER = PAYU242_NOTIFY_IPS.sandbox[1];
const api = (url: string, method: any = 'GET', payload?: any, who = 'admin') =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie: cookies[who], ...(url === '/orders' ? { 'idempotency-key': randomUUID() } : {}) } });
async function ok(url: string, method: any = 'GET', payload?: any, who = 'admin') {
  const r = await api(url, method, payload, who);
  assert(r.statusCode < 300, url + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
const pub = (token: string, path = '', method: any = 'GET', payload?: any) =>
  app.inject({ url: '/api/public/orders/' + token + path, method, payload, remoteAddress: '203.0.113.7' });
const notify = (path: string, body: string, headers: Record<string, string>, peer = SANDBOX_PEER) =>
  app.inject({ method: 'POST', url: path, payload: body, headers: { 'content-type': 'application/json', ...headers }, remoteAddress: peer });
const config = { environment: 'sandbox', pos_id: '300746', public_origin: 'https://sklep.example.test', client_secret: 'synthetic-secret-242-aaaa', second_key: 'synthetic-second-key-242' };
let configId = '';

before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  for (const who of ['admin', 'viewer', 'operator', 'other']) {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: who + '@demo.local', password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    cookies[who] = r.headers['set-cookie']!.toString().split(';')[0];
  }
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function order(price = 12345, extra: any = {}) {
  const p = await ok('/products', 'POST', { name: 'PayU 242', sku: 'PAYU-' + randomUUID().slice(0, 8), price, quantity: 50, warehouse_id: warehouse });
  const o = await ok('/orders', 'POST', { customer_name: 'Kupujący PayU', email: 'kupujacy242@example.test', warehouse_id: warehouse, items: [{ product_id: p.id, quantity: 1 }], shipping_cost: 0, ...extra });
  return ok('/orders/' + o.id);
}
async function pay(o: any, key = randomUUID()) {
  const r = await pub(o.portal_token, '/payments/payu', 'POST', { client_key: key });
  return { r, key, body: r.json() };
}
const entries = async (orderId: string) => (await pool.query("SELECT * FROM payment_entries WHERE order_id=$1 AND method='payu' ORDER BY created_at", [orderId])).rows;
const session = async (id: string) => (await pool.query('SELECT * FROM payu242_sessions WHERE id=$1', [id])).rows[0];
const logs = async (sessionId: string | null) => (await pool.query('SELECT * FROM payu242_notifications WHERE session_id IS NOT DISTINCT FROM $1 ORDER BY received_at', [sessionId])).rows;
/** PayU sets a status and notifies; returns the notification as PayU would send it. */
function payuSays(orderId: string, status: 'PENDING' | 'COMPLETED' | 'CANCELED') {
  payu242Fake(configId)!.setStatus(orderId, status);
  return payu242FakeNotification(orderId)!;
}

test('only an administrator session configures PayU; secrets are write-only and encrypted; production is off', async () => {
  for (const who of ['viewer', 'operator']) {
    assert.equal((await api('/payu/config', 'PUT', config, who)).statusCode, 403, who);
    assert.equal((await api('/payu/config', 'GET', undefined, who)).statusCode, 403, who);
  }
  assert.equal((await api('/payu/config', 'PUT', { ...config, environment: 'production' })).statusCode, 422, 'production disabled locally');
  assert.equal((await api('/payu/config', 'PUT', { ...config, public_origin: 'http://sklep.example.test' })).statusCode, 422, 'plain HTTP origin');
  assert.equal((await api('/payu/config', 'PUT', { ...config, second_key: undefined })).statusCode, 422, 'both secrets on create');
  const saved = await ok('/payu/config', 'PUT', config);
  assert.equal(saved.configured, true);
  assert.equal(saved.simulation, true);
  assert.equal(saved.client_secret_set, true);
  assert.equal(JSON.stringify(saved).includes(config.client_secret) || JSON.stringify(saved).includes(config.second_key), false, 'no secret in the answer');
  const row = (await pool.query('SELECT * FROM payu242_configs WHERE tenant_id=$1', [DEMO_TENANT])).rows[0];
  configId = row.id;
  assert.equal(row.credentials.includes(config.client_secret) || row.credentials.includes(config.second_key), false, 'stored encrypted');
  assert.equal((await api('/payu/config', 'PUT', { ...config, version: 99 })).statusCode, 409, 'stale form');
  const again = await ok('/payu/config', 'PUT', { ...config, client_secret: undefined, second_key: undefined, version: saved.version });
  assert.equal(again.version, saved.version + 1, 'omitted secrets keep the stored ones');
  // Another organisation sees no configuration of this one.
  assert.equal((await ok('/payu/config', 'GET', undefined, 'other')).configured, false);
});

test('the portal offers „Zapłać” only with an open balance; the session takes the server-side balance', async () => {
  const o = await order(12345);
  const data = (await pub(o.portal_token, '/data')).json();
  assert.deepEqual(data.payu, { available: true, pending: false, last_status: null });
  assert.match((await pub(o.portal_token)).body, /id="payu-pay" class="primary" type="button">Zapłać przez PayU/);
  // The buyer cannot choose the amount: extra fields are refused, the session amount is the balance.
  assert.equal((await pub(o.portal_token, '/payments/payu', 'POST', { client_key: randomUUID(), amount: 1 })).statusCode, 422);
  const { r, key, body } = await pay(o);
  assert.equal(r.statusCode, 201, r.body);
  assert.match(body.redirect, /^\/payu-fake\/pay\/SYNTH/);
  const s = await session(body.session_id);
  assert.deepEqual([s.amount, s.currency, s.status, s.phase, s.order_id, s.simulated], [12345, 'PLN', 'NEW', 'created', o.id, true]);
  const fakeOrder = payu242Fake(configId)!.orders.get(s.provider_order_id)!;
  assert.equal(fakeOrder.totalAmount, 12345);
  assert.deepEqual(fakeOrder.request.buyer, { email: 'kupujacy242@example.test', language: 'pl' }, 'e-mail and language only');
  assert.match(fakeOrder.request.notifyUrl, new RegExp('^https://sklep\\.example\\.test/callbacks/payu/' + configId + '/[A-Za-z0-9_-]{43}$'));
  assert.equal(fakeOrder.request.continueUrl.includes(o.portal_token), false, 'PayU never sees the portal token');
  assert.equal(fakeOrder.request.customerIp, '203.0.113.7');
  // Same click again: same session, no second PayU order.
  const replay = await pay(o, key);
  assert.equal(replay.r.statusCode, 200);
  assert.equal(replay.body.session_id, body.session_id);
  // A new click while the attempt is open reuses its pay link.
  const reused = await pay(o);
  assert.equal(reused.body.session_id, body.session_id);
  assert.equal(payu242Fake(configId)!.orders.size, 1);
  assert.equal((await pub(o.portal_token, '/data')).json().payu.pending, true);
  // Cash on delivery and a paid order get no button.
  const cod = await order(500, { payment_mode: 'cod' });
  assert.equal((await pub(cod.portal_token, '/data')).json().payu.available, false);
  assert.equal((await pay(cod)).r.statusCode, 409);
});

test('notification denial paths: peer, token, signature, unknown session, amount — nothing is booked', async () => {
  const o = await order(2000);
  const { body } = await pay(o);
  const s = await session(body.session_id);
  const n = payuSays(s.provider_order_id, 'COMPLETED');
  assert.equal((await notify(n.path, n.body, n.headers, '127.0.0.1')).statusCode, 403, 'not a PayU sender');
  assert.equal((await notify(n.path, n.body, n.headers, PAYU242_NOTIFY_IPS.production[0])).statusCode, 403, 'production sender for a sandbox shop');
  assert.equal((await notify(n.path.replace(/[^/]+$/, 'A'.repeat(43)), n.body, n.headers)).statusCode, 404, 'wrong path token');
  assert.equal((await notify(n.path.replace(configId, randomUUID()), n.body, n.headers)).statusCode, 404, 'unknown configuration');
  const tampered = n.body.replace('"2000"', '"1"');
  assert.equal((await notify(n.path, tampered, n.headers)).statusCode, 401, 'body changed after signing');
  const fake = payu242Fake(configId)!;
  assert.equal((await notify(n.path, n.body, fake.sign(n.body, 'MD5', 'wrong-second-key'))).statusCode, 401, 'wrong second key');
  assert.equal((await notify(n.path, n.body, {})).statusCode, 401, 'no signature');
  assert.equal((await notify(n.path, n.body, { ...n.headers, 'content-type': 'text/plain' })).statusCode, 415);
  // Signed correctly, but for an extOrderId this shop never started.
  const foreign = n.body.replace(s.ext_order_id, randomUUID());
  assert.equal((await notify(n.path, foreign, fake.sign(foreign))).statusCode, 404, 'unknown session');
  // Signed correctly, matching session, other amount.
  const cheaper = n.body.replace('"totalAmount":"2000"', '"totalAmount":"1999"');
  assert.notEqual(cheaper, n.body);
  assert.equal((await notify(n.path, cheaper, fake.sign(cheaper))).statusCode, 409, 'amount mismatch refused');
  assert.equal((await entries(o.id)).length, 0, 'nothing booked');
  assert.equal((await session(s.id)).review, 'amount_mismatch');
  assert.equal((await session(s.id)).status, 'NEW');
  const outcomes = (await logs(s.id)).map((l) => l.outcome);
  assert.deepEqual(outcomes, ['amount_mismatch']);
  const all = (await pool.query('SELECT outcome,signature_valid FROM payu242_notifications WHERE config_id=$1', [configId])).rows;
  assert.equal(all.filter((l) => l.outcome === 'invalid_signature' && l.signature_valid === false).length, 3, 'signature refusals are logged');
  assert.equal(all.filter((l) => l.outcome === 'unknown_session').length, 1);
  assert.equal(JSON.stringify(all).includes('kupujacy242'), false);
});

test('PENDING then COMPLETED books exactly one receipt; replays and a late CANCELED change nothing', async () => {
  const o = await order(3100);
  const { body } = await pay(o);
  const s = await session(body.session_id);
  const pending = payuSays(s.provider_order_id, 'PENDING');
  assert.equal((await notify(pending.path, pending.body, pending.headers)).statusCode, 200);
  assert.equal((await session(s.id)).status, 'PENDING');
  const done = payuSays(s.provider_order_id, 'COMPLETED');
  // The same notification three times, two of them at once.
  const answers = await Promise.all([notify(done.path, done.body, done.headers), notify(done.path, done.body, done.headers)]);
  assert.deepEqual(answers.map((a) => a.statusCode), [200, 200]);
  assert.equal((await notify(done.path, done.body, done.headers)).statusCode, 200);
  // PENDING arriving late, and CANCELED after COMPLETED.
  assert.equal((await notify(pending.path, pending.body, pending.headers)).statusCode, 200);
  const cancelled = n2(done.body, 'CANCELED');
  assert.equal((await notify(done.path, cancelled, payu242Fake(configId)!.sign(cancelled))).statusCode, 200);
  const booked = await entries(o.id);
  assert.equal(booked.length, 1, 'one payment');
  assert.deepEqual([booked[0].kind, booked[0].amount, booked[0].currency, booked[0].client_key], ['receipt', 3100, 'PLN', 'payu:' + s.provider_order_id]);
  assert.match(booked[0].reference, /^PayU SYMULACJA /);
  const after = await session(s.id);
  assert.deepEqual([after.status, after.receipt_entry_id], ['COMPLETED', booked[0].id]);
  assert.equal((await ok('/orders/' + o.id)).status, 'paid');
  const b = await tenantReadTx(DEMO_TENANT, (c) => paymentBalance(c, o.id));
  assert.deepEqual([b.received, b.amount_due, b.overpayment], [3100, 0, 0]);
  assert.deepEqual((await logs(s.id)).map((l) => l.outcome).sort(), ['applied', 'booked', 'duplicate', 'duplicate', 'ignored_terminal', 'ignored_terminal'].sort());
  // Visible on the order card (payments history) and the portal offers nothing more.
  const history = await ok('/orders/' + o.id + '/payments');
  assert.equal(history.data.filter((e: any) => e.method === 'payu').length, 1);
  assert.equal((await pub(o.portal_token, '/data')).json().payu.available, false);
  const sessions = await ok('/orders/' + o.id + '/payu-sessions', 'GET', undefined, 'viewer');
  assert.equal(sessions.data[0].status, 'COMPLETED');
});
const n2 = (body: string, status: string) => body.replace(/"status":"[A-Z_]+"/, `"status":"${status}"`);

test('COMPLETED after CANCELED is held for review and books nothing', async () => {
  const o = await order(4200);
  const { body } = await pay(o);
  const s = await session(body.session_id);
  const cancel = payuSays(s.provider_order_id, 'CANCELED');
  assert.equal((await notify(cancel.path, cancel.body, cancel.headers)).statusCode, 200);
  assert.equal((await session(s.id)).status, 'CANCELED');
  const late = n2(cancel.body, 'COMPLETED');
  assert.equal((await notify(cancel.path, late, payu242Fake(configId)!.sign(late))).statusCode, 200, 'acknowledged so PayU stops repeating');
  const after = await session(s.id);
  assert.deepEqual([after.status, after.review, after.receipt_entry_id], ['CANCELED', 'completed_after_canceled', null]);
  assert.equal((await entries(o.id)).length, 0);
  // PayU may have taken the money: the buyer is not asked to pay again until the seller resolves it (review A).
  assert.equal((await pay(o)).r.statusCode, 409);
  assert.deepEqual((await pub(o.portal_token, '/data')).json().payu, { available: false, pending: true, last_status: 'CANCELED' });
});
test('a buyer who cancelled at PayU can start a new attempt', async () => {
  const o = await order(4300);
  const { body } = await pay(o);
  const s = await session(body.session_id);
  const cancel = payuSays(s.provider_order_id, 'CANCELED');
  assert.equal((await notify(cancel.path, cancel.body, cancel.headers)).statusCode, 200);
  const next = await pay(o);
  assert.equal(next.r.statusCode, 201, next.r.body);
  assert.notEqual(next.body.session_id, s.id);
});

test('a lost notification is read back by „Sprawdź w PayU” and books once; viewers cannot trigger it', async () => {
  const o = await order(5100);
  const { body } = await pay(o);
  const s = await session(body.session_id);
  payu242Fake(configId)!.setStatus(s.provider_order_id, 'COMPLETED'); // paid, notification never arrives
  const path = '/orders/' + o.id + '/payu-sessions/' + s.id + '/reconcile';
  assert.equal((await api(path, 'POST', {}, 'viewer')).statusCode, 403);
  const r1 = await ok(path, 'POST', {}, 'operator');
  assert.deepEqual([r1.outcome, r1.session.status], ['booked', 'COMPLETED']);
  const r2 = await ok(path, 'POST', {});
  assert.equal(r2.outcome, 'duplicate');
  assert.equal((await entries(o.id)).length, 1);
  // And the delayed notification after the read is a duplicate too.
  const n = payu242FakeNotification(s.provider_order_id)!;
  assert.equal((await notify(n.path, n.body, n.headers)).statusCode, 200);
  assert.equal((await entries(o.id)).length, 1);
});

test('a payment that arrives after a manual one becomes an overpayment and is refunded through PayU', async () => {
  const o = await order(6000);
  const { body } = await pay(o);
  const s = await session(body.session_id);
  // The operator records a bank transfer before PayU confirms: PayU's money is still booked (it arrived).
  await ok('/orders/' + o.id + '/payments', 'POST', { client_key: randomUUID(), version: Number((await ok('/orders/' + o.id)).version), kind: 'receipt', amount: 6000, currency: 'PLN', method: 'bank_transfer', reference: 'Przelew 242', confirmed: true });
  const n = payuSays(s.provider_order_id, 'COMPLETED');
  assert.equal((await notify(n.path, n.body, n.headers)).statusCode, 200);
  let b = await tenantReadTx(DEMO_TENANT, (c) => paymentBalance(c, o.id));
  assert.deepEqual([b.received, b.overpayment], [12000, 6000]);
  const path = '/orders/' + o.id + '/payu-sessions/' + s.id + '/refunds';
  const key = randomUUID();
  assert.equal((await api(path, 'POST', { client_key: key, amount: 6000, confirmed: true }, 'operator')).statusCode, 403, 'refund is admin only');
  assert.equal((await api(path, 'POST', { client_key: randomUUID(), amount: 6001, confirmed: true })).statusCode, 422, 'more than the payment');
  const r = await api(path, 'POST', { client_key: key, amount: 6000, confirmed: true });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().refund.status, 'PENDING');
  assert.equal((await api(path, 'POST', { client_key: key, amount: 6000, confirmed: true })).statusCode, 200, 'replay');
  const fake = payu242Fake(configId)!;
  assert.equal(fake.refunds.get(s.provider_order_id)!.length, 1, 'one refund at PayU');
  // PayU finalizes; the status read books the refund once.
  const refund = fake.refunds.get(s.provider_order_id)![0];
  fake.finalizeRefund(s.provider_order_id, refund.refundId);
  const rec = await ok('/orders/' + o.id + '/payu-sessions/' + s.id + '/reconcile', 'POST', {});
  assert.equal(rec.session.refunds[0].status, 'FINALIZED');
  await ok('/orders/' + o.id + '/payu-sessions/' + s.id + '/reconcile', 'POST', {});
  const refunds = (await pool.query("SELECT * FROM payment_entries WHERE order_id=$1 AND kind='refund'", [o.id])).rows;
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amount, 6000);
  b = await tenantReadTx(DEMO_TENANT, (c) => paymentBalance(c, o.id));
  assert.deepEqual([b.received, b.refunded, b.overpayment, b.amount_due], [12000, 6000, 0, 0]);
});

test('refunds still pending at PayU reduce what may be refunded next (review 1)', async () => {
  const o = await order(6000);
  const { body } = await pay(o);
  const s = await session(body.session_id);
  await ok('/orders/' + o.id + '/payments', 'POST', { client_key: randomUUID(), version: Number((await ok('/orders/' + o.id)).version), kind: 'receipt', amount: 3000, currency: 'PLN', method: 'bank_transfer', reference: 'Przelew 242b', confirmed: true });
  const n = payuSays(s.provider_order_id, 'COMPLETED');
  assert.equal((await notify(n.path, n.body, n.headers)).statusCode, 200);
  const path = '/orders/' + o.id + '/payu-sessions/' + s.id + '/refunds';
  assert.equal((await api(path, 'POST', { client_key: randomUUID(), amount: 3000, confirmed: true })).statusCode, 201);
  const second = await api(path, 'POST', { client_key: randomUUID(), amount: 3000, confirmed: true });
  assert.equal(second.statusCode, 422, 'the first refund is still on its way out');
  const fake = payu242Fake(configId)!;
  assert.equal(fake.refunds.get(s.provider_order_id)!.length, 1, 'PayU got one refund');
  fake.finalizeRefund(s.provider_order_id, fake.refunds.get(s.provider_order_id)![0].refundId);
  await ok('/orders/' + o.id + '/payu-sessions/' + s.id + '/reconcile', 'POST', {});
  const b = await tenantReadTx(DEMO_TENANT, (c) => paymentBalance(c, o.id));
  assert.deepEqual([b.received, b.refunded, b.overpayment, b.amount_due], [9000, 3000, 0, 0]);
  assert.equal((await api(path, 'POST', { client_key: randomUUID(), amount: 1, confirmed: true })).statusCode, 422, 'nothing left to give back');
});

test('the settlement report counts the PayU payment like any other, to the grosz', async () => {
  const o = await order(7300);
  const { body } = await pay(o);
  const s = await session(body.session_id);
  const n = payuSays(s.provider_order_id, 'COMPLETED');
  assert.equal((await notify(n.path, n.body, n.headers)).statusCode, 200);
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
  const report = await ok('/settlement-report?from=' + day + '&to=' + day);
  const row = report.rows.find((x: any) => x.order_id === o.id);
  assert(row, 'row of the order');
  const b = await tenantReadTx(DEMO_TENANT, (c) => paymentBalance(c, o.id));
  assert.deepEqual([row.order_total, row.received, row.net_paid, row.payment_difference, row.amount_due], [7300, 7300, 7300, 0, 7300]);
  assert.deepEqual([row.received, row.net_paid], [b.received, b.net]);
  const t = report.totals.find((x: any) => x.currency === 'PLN');
  assert.equal(t.received, report.rows.filter((x: any) => x.in_totals && x.currency === 'PLN').reduce((sum: number, x: any) => sum + x.received, 0));
});

test('tenant isolation and the portal link of another order', async () => {
  const a = await order(800), b = await order(900);
  const { body } = await pay(a);
  // Another organisation cannot see, read back or refund this order's sessions.
  assert.equal((await api('/orders/' + a.id + '/payu-sessions', 'GET', undefined, 'other')).statusCode, 404);
  assert.equal((await api('/orders/' + a.id + '/payu-sessions/' + body.session_id + '/reconcile', 'POST', {}, 'other')).statusCode, 404);
  // The session of order A is not reachable through order B, and B's link cannot replay A's key.
  assert.equal((await api('/orders/' + b.id + '/payu-sessions/' + body.session_id + '/reconcile', 'POST', {})).statusCode, 404);
  const s = await session(body.session_id);
  assert.equal((await pub(b.portal_token, '/payments/payu', 'POST', { client_key: s.client_key })).statusCode, 409);
  // A disabled link refuses before any session work.
  await ok('/orders/' + b.id + '/portal', 'POST', { action: 'disable' });
  assert.equal((await pay(b)).r.statusCode, 404);
  // The return page needs the session's own secret.
  assert.equal((await app.inject({ url: '/payu/return/' + body.session_id + '?s=' + 'A'.repeat(43) })).statusCode, 404);
  const continueUrl = new URL(payu242Fake(configId)!.orders.get(s.provider_order_id)!.request.continueUrl);
  const ret = await app.inject({ url: continueUrl.pathname + continueUrl.search });
  assert.equal(ret.statusCode, 200);
  assert.match(ret.body, /Płatność PayU/);
  assert.match(ret.headers['content-security-policy'] as string, /script-src 'nonce-/);
});

test('the local SYMULACJA pay page drives PayU’s sequence end to end', async () => {
  const o = await order(1500);
  const { body } = await pay(o);
  const page = await app.inject({ url: body.redirect });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /SYMULACJA/);
  const u = new URL(body.redirect, 'http://x');
  assert.equal((await app.inject({ url: u.pathname })).statusCode, 404, 'no key, no fake pay page (review C)');
  assert.equal((await app.inject({ method: 'POST', url: u.pathname + '/complete?k=' + 'A'.repeat(43) })).statusCode, 404);
  assert.equal((await entries(o.id)).length, 0);
  // The browser posts the page's HTML form (urlencoded, empty body).
  const r = await app.inject({ method: 'POST', url: u.pathname + '/complete' + u.search, payload: '', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.statusCode, 303);
  assert.match(String(r.headers.location), new RegExp('^/payu/return/' + body.session_id + '\\?s='));
  assert.equal((await entries(o.id)).length, 1);
  assert.deepEqual((await logs(body.session_id)).map((l) => l.outcome), ['applied', 'booked']);
});
