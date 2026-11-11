/** B2B-007 (DOM-B2B-007) on migration 246 (prepared as placeholder 254): trade credit per B2B account. The supplier's administrator
 * sets currency, limit and term; a checkout of an account with an active line (portal, network) is charged to it
 * under the line lock; a refusal (limit, overdue, currency) books nothing at all; the exposure is the open balance
 * of the charged orders, equal to the settlement report's amount_due, so payments and cancellation settle it; a
 * credit order may go to picking before payment. Exact to the grosz.
 * Database test on a disposable clone dynaminds_m246_<YYYYMMDD>_NN; the real migrate() applies 246 after 245. */
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed } from './fixtures';
import { processB2bCatalog, failB2bCatalog } from '../server/b2b-network';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:24[6789]|25[0123456789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m246_YYYYMMDD_NN (or m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 247/248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

let app: any, admin = '', viewer = '', operator = '', buyer = '', warehouse = '', buyerWarehouse = '';
let ip = 1;
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie }, remoteAddress: '127.0.0.' + ((ip % 250) + 1) });
async function api(path: string, method: any = 'GET', body?: any, cookie = admin) {
  const r = await req(path, method, body, cookie);
  assert(r.statusCode < 300, method + ' ' + path + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
before(async () => {
  await migrate();
  assert((await pool.query("SELECT EXISTS(SELECT FROM migrations WHERE name='246_b2b_trade_credit_directory') ok")).rows[0].ok, 'migrate() applied 246');
  await seed();
  app = await buildApp();
  for (const [email, set] of [
    ['admin@demo.local', (c: string) => (admin = c)],
    ['viewer@demo.local', (c: string) => (viewer = c)],
    ['operator@demo.local', (c: string) => (operator = c)],
    ['other@demo.local', (c: string) => (buyer = c)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    assert.equal(r.statusCode, 200, r.body);
    set(r.headers['set-cookie'].toString().split(';')[0]);
  }
  warehouse = (await api('/warehouses')).data[0].id;
  buyerWarehouse = (await api('/warehouses', 'GET', undefined, buyer)).data[0].id;
});
after(async () => {
  await app?.close();
  await pool.end();
});

const address = { street: 'Hurtowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' };
const password = 'BuyerDemo!2026';
// 2 × 123,45 + 5,00 shipping = 251,90 per order.
const ORDER = 25190;
async function account(extra: any = {}) {
  ip++;
  const product = await api('/products', 'POST', { name: 'Produkt kredytu', sku: 'TC-' + randomUUID().slice(0, 10), price: 20000, vat: 23, warehouse_id: warehouse, quantity: 40 });
  const list = await api('/price-lists', 'POST', { name: 'Cennik kredytu ' + randomUUID().slice(0, 6), currency: 'PLN' });
  await api('/price-lists/' + list.id + '/items', 'PUT', { version: list.version, items: [{ product_id: product.id, price: 12345 }] });
  const body = {
    name: 'Kontrahent kredytu ' + randomUUID().slice(0, 6), email: randomUUID() + '@example.test', warehouse_id: warehouse,
    price_list_id: list.id, address, min_total: 0, min_quantity: 1, quantity_step: 1, shipping_cost: 500, payment_mode: 'prepaid', ...extra,
  };
  const a = await api('/b2b/accounts', 'POST', body);
  const approved = await api('/b2b/accounts/' + a.id, 'PATCH', { ...body, version: a.version, active: true, confirmed: true });
  return { product, list, body, account: approved };
}
async function portal(extra: any = {}) {
  const f: any = await account(extra);
  const invite = await api('/b2b/accounts/' + f.account.id + '/invite', 'POST', { version: f.account.version, confirmed: true });
  f.base = '/public/b2b/' + f.account.id;
  await api(f.base + '/activate', 'POST', { token: invite.invitation.split('#invite=')[1], password }, '');
  const login = await req(f.base + '/login', 'POST', { email: f.body.email, password }, '');
  assert.equal(login.statusCode, 200, login.body);
  f.cookie = login.headers['set-cookie'].toString().split(';')[0];
  return f;
}
const line = (f: any, b: any, cookie = admin) => req('/b2b/accounts/' + f.account.id + '/trade-credit', 'PUT', { currency: 'PLN', term_days: 14, active: true, confirmed: true, ...b }, cookie);
const credit = (f: any, cookie = admin) => api('/b2b/accounts/' + f.account.id + '/trade-credit', 'GET', undefined, cookie);
const quote = (f: any) => api(f.base + '/quotes', 'POST', { client_key: randomUUID(), items: [{ product_id: f.product.id, quantity: 2 }] }, f.cookie);
const checkout = (f: any, q: any) => req(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, f.cookie);
const ordersOf = async (accountId: string) => (await pool.query('SELECT count(*)::int n FROM orders WHERE b2b_account_id=$1', [accountId])).rows[0].n as number;
const chargesOf = async (accountId: string) => (await pool.query('SELECT order_id,amount_minor::int amount,exposure_before_minor::int before,limit_minor::int lim,channel,currency FROM b2b254_trade_charges WHERE account_id=$1 ORDER BY created_at', [accountId])).rows;
async function pay(orderId: string, amount: number) {
  const o = await api('/orders/' + orderId);
  return api('/orders/' + orderId + '/payments', 'POST', { client_key: randomUUID(), version: o.version, kind: 'receipt', amount, currency: 'PLN', method: 'bank_transfer', reference: 'Przelew kredytu', confirmed: true });
}
const status = async (orderId: string, s: string) =>
  req('/orders/' + orderId + '/status', 'PATCH', await legacySerialOrderStatusPayload((p) => api(p), '/orders/' + orderId + '/status', { status: s }));

test('the administrator sets the line; versions guard changes; viewer and operator read only; other companies see nothing', async () => {
  const f = await portal();
  assert.deepEqual((await credit(f, viewer)).line, null);
  for (const who of [viewer, operator]) assert.equal((await line(f, { limit_minor: 1000, version: 0 }, who)).statusCode, 403);
  for (const bad of [{ limit_minor: -1 }, { limit_minor: 10.5 }, { term_days: 0 }, { currency: 'JPY' }])
    assert.equal((await line(f, { limit_minor: 1000, version: 0, ...bad })).statusCode, 422, JSON.stringify(bad));
  const created = await line(f, { limit_minor: 50380, version: 0 });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().line.version, 1);
  assert.equal((await line(f, { limit_minor: 1, version: 0 })).statusCode, 409, 'a second create');
  assert.equal((await line(f, { limit_minor: 1, version: 7 })).statusCode, 409, 'a stale version');
  const read = await credit(f, viewer);
  assert.deepEqual({ ...read.summary }, { currency: 'PLN', limit_minor: 50380, term_days: 14, active: true, exposure_minor: 0, available_minor: 50380, overdue_minor: 0, overdue_orders: 0, open_orders: 0 });
  assert.equal((await req('/b2b/accounts/' + f.account.id + '/trade-credit', 'GET', undefined, buyer)).statusCode, 404, 'other tenant');
  const cod = await account({ payment_mode: 'cod' });
  assert.equal((await line(cod, { limit_minor: 1000, version: 0 })).statusCode, 409, 'credit is for transfer accounts, not cash on delivery');
  const audit = (await pool.query("SELECT action FROM audit_events WHERE entity_id=$1 AND action LIKE 'b2b.trade_credit.%'", [created.json().line.id])).rows.map((r) => r.action);
  assert.deepEqual(audit, ['b2b.trade_credit.line_created']);
});

test('portal: orders are charged up to exactly the limit; one grosz more is refused and books nothing', async () => {
  const f = await portal();
  assert.equal((await line(f, { limit_minor: 2 * ORDER, version: 0 })).statusCode, 200);
  const first = await checkout(f, await quote(f));
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().trade_credit.amount_minor, ORDER);
  const second = await checkout(f, await quote(f));
  assert.equal(second.statusCode, 200, second.body);
  assert.equal((await credit(f)).summary.available_minor, 0);
  const stockBefore = (await pool.query('SELECT coalesce(sum(reserved),0)::int r FROM stock WHERE product_id=$1', [f.product.id])).rows[0].r;
  const q3 = await quote(f);
  const refused = await checkout(f, q3);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.match(refused.json().detail, /przekracza wolny limit kredytu kupieckiego: 0,00 PLN/);
  assert.equal(refused.json().code, 'TRADE_CREDIT_LIMIT');
  assert.equal(await ordersOf(f.account.id), 2, 'no order for the refused checkout');
  assert.equal((await pool.query('SELECT order_id FROM b2b_quotes WHERE id=$1', [q3.id])).rows[0].order_id, null);
  assert.equal((await pool.query('SELECT coalesce(sum(reserved),0)::int r FROM stock WHERE product_id=$1', [f.product.id])).rows[0].r, stockBefore, 'no reservation');
  assert.deepEqual((await chargesOf(f.account.id)).map((c) => [c.amount, c.before, c.lim, c.channel, c.currency]), [
    [ORDER, 0, 2 * ORDER, 'portal', 'PLN'],
    [ORDER, ORDER, 2 * ORDER, 'portal', 'PLN'],
  ]);
  // A replay of a placed checkout returns the same order and charges nothing again.
  const again = await req(f.base + '/quotes/' + (await pool.query('SELECT id FROM b2b_quotes WHERE order_id=$1', [first.json().id])).rows[0].id + '/checkout', 'POST', { confirmed: true }, f.cookie);
  assert.equal(again.statusCode, 200);
  assert.equal((await chargesOf(f.account.id)).length, 2);
  // Partial payment frees exactly what was paid; the next order fits only after the whole order is paid.
  await pay(first.json().id, ORDER - 1);
  assert.equal((await credit(f)).summary.available_minor, ORDER - 1);
  assert.equal((await checkout(f, q3)).statusCode, 409, 'one grosz short');
  await pay(first.json().id, 1);
  const third = await checkout(f, q3);
  assert.equal(third.statusCode, 200, third.body);
  assert.equal((await credit(f)).summary.exposure_minor, 2 * ORDER);
  // The buyer sees the same balance in the portal.
  const mine = await api(f.base + '/trade-credit', 'GET', undefined, f.cookie);
  assert.equal(mine.summary.exposure_minor, 2 * ORDER);
  assert.equal(mine.summary.available_minor, 0);
});

test('the exposure equals the settlement report amount_due of the charged orders; cancellation frees the order', async () => {
  const f = await portal();
  await line(f, { limit_minor: 1000000, version: 0 });
  const a = (await checkout(f, await quote(f))).json(), b = (await checkout(f, await quote(f))).json();
  await pay(a.id, 10001);
  const day = new Date().toISOString().slice(0, 10);
  const report = await api('/settlement-report?from=' + day + '&to=' + day);
  // The report's amount_due is what the order is worth after credits; the open part is amount_due − net_paid.
  const due = report.rows.filter((r: any) => [a.id, b.id].includes(r.order_id)).reduce((n: number, r: any) => n + Math.max(0, Number(r.amount_due) - Number(r.net_paid)), 0);
  assert.equal(due, 2 * ORDER - 10001);
  assert.equal((await credit(f)).summary.exposure_minor, due);
  assert.equal((await status(b.id, 'cancelled')).statusCode, 200);
  assert.equal((await credit(f)).summary.exposure_minor, ORDER - 10001);
  // Fully paid drops out of the exposure; reversing the 10001 grosz payment reopens exactly 10001.
  await pay(a.id, ORDER - 10001);
  assert.equal((await credit(f)).summary.exposure_minor, 0);
  const entry = (await pool.query("SELECT id FROM payment_entries WHERE order_id=$1 AND amount=10001 AND kind='receipt'", [a.id])).rows[0].id;
  const o = await api('/orders/' + a.id);
  await api('/orders/' + a.id + '/payments/reverse', 'POST', { client_key: randomUUID(), version: o.version, entry_id: entry, reason: 'Błędnie zaksięgowany przelew', confirmed: true });
  const s = (await credit(f)).summary;
  assert.deepEqual([s.exposure_minor, s.open_orders], [10001, 1]);
});

test('an overdue balance blocks new credit orders until it is paid; a credit order goes to picking before payment', async () => {
  const f = await portal();
  await line(f, { limit_minor: 1000000, version: 0 });
  const a = (await checkout(f, await quote(f))).json();
  assert.equal((await status(a.id, 'picking')).statusCode, 200, 'credit order is released like cash on delivery');
  await pool.query("UPDATE b2b254_trade_charges SET created_at=now()-interval '20 days',due_at=now()-interval '1 second' WHERE order_id=$1", [a.id]);
  const s = (await credit(f)).summary;
  assert.equal(s.overdue_minor, ORDER);
  assert.equal(s.overdue_orders, 1);
  const q = await quote(f);
  const blocked = await checkout(f, q);
  assert.equal(blocked.statusCode, 409);
  assert.match(blocked.body, /po terminie \(251,90 PLN\)/);
  await pay(a.id, ORDER);
  assert.equal((await checkout(f, q)).statusCode, 200);
  // Without a line the same prepaid account still waits for payment before picking.
  const plain = await portal();
  const p = (await checkout(plain, await quote(plain))).json();
  assert.equal(p.trade_credit, undefined);
  assert.equal((await status(p.id, 'picking')).statusCode, 409);
});

test('a line in another currency refuses the order; an inactive line leaves the prepaid flow unchanged', async () => {
  const f = await portal();
  await line(f, { limit_minor: 1000000, version: 0, currency: 'EUR' });
  const r = await checkout(f, await quote(f));
  assert.equal(r.statusCode, 409);
  assert.match(r.body, /w EUR, a zamówienie w PLN/);
  assert.equal(await ordersOf(f.account.id), 0);
  const v = (await credit(f)).line.version;
  assert.equal((await line(f, { limit_minor: 1000000, version: v, currency: 'EUR', active: false })).statusCode, 200);
  const ok = await checkout(f, await quote(f));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().trade_credit, undefined);
  assert.equal((await chargesOf(f.account.id)).length, 0);
  // Changing the currency is refused while orders are open on the line.
  const g = await portal();
  await line(g, { limit_minor: 1000000, version: 0 });
  await checkout(g, await quote(g));
  assert.equal((await line(g, { limit_minor: 1000000, version: 1, currency: 'EUR' })).statusCode, 409);
});

test('concurrent checkouts that fit only one at a time: exactly one is charged', async () => {
  const f = await portal();
  await line(f, { limit_minor: ORDER + ORDER - 1, version: 0 });
  const [q1, q2] = [await quote(f), await quote(f)];
  const rs = await Promise.all([checkout(f, q1), checkout(f, q2)]);
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409], rs.map((r) => r.body).join(' | '));
  assert.equal(await ordersOf(f.account.id), 1);
  assert.equal((await chargesOf(f.account.id)).length, 1);
});

// ---- network checkout ------------------------------------------------------------------------------------
async function networkLink() {
  const f: any = await account({ shipping_cost: 0 });
  const invite = await api('/b2b/accounts/' + f.account.id + '/network-invite', 'POST', { version: f.account.version, recipient_email: 'other@demo.local', confirmed: true });
  f.link = await api('/b2b/network/accept', 'POST', { token: invite.token, confirmed: true }, buyer);
  f.base = '/b2b/network/links/' + f.link.id;
  const run = await api(f.base + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true }, buyer);
  for (let n = 0; n < 600; n++) {
    const r = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1', [run.id])).rows[0];
    if (r.state === 'done') break;
    assert.equal(r.state, 'queued', r.error);
    const job = (await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *", [r.job_id, randomUUID()])).rows[0];
    try { await processB2bCatalog(job); } catch (e) { await failB2bCatalog(job, e); throw e; }
  }
  f.item = (await api(f.base + '/catalog', 'GET', undefined, buyer)).data[0];
  await api(f.base + '/catalog/' + f.item.id + '/product', 'POST', { version: f.item.version, sku: 'LOCAL-' + randomUUID(), sale_price: 25000, warehouse_id: buyerWarehouse, confirmed: true }, buyer);
  return f;
}
const netQuote = (f: any, qty: number) => api(f.base + '/quotes', 'POST', { client_key: randomUUID(), warehouse_id: buyerWarehouse, items: [{ item_id: f.item.id, quantity: qty }] }, buyer);
const netCheckout = (f: any, q: any) => req(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, buyer);

test('network: the buyer company buys on the supplier line, sees the same balance, and a refusal creates neither side', async () => {
  const f = await networkLink();
  assert.equal((await line(f, { limit_minor: 3 * 12345, version: 0 })).statusCode, 200);
  const ok = await netCheckout(f, await netQuote(f, 2));
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual((await chargesOf(f.account.id)).map((c) => [c.amount, c.channel]), [[2 * 12345, 'network']]);
  const seen = await api(f.base + '/trade-credit', 'GET', undefined, buyer);
  assert.equal(seen.summary.exposure_minor, 2 * 12345);
  assert.equal(seen.summary.available_minor, 12345);
  assert.equal((await req(f.base + '/trade-credit', 'GET', undefined, viewer)).statusCode, 404, 'the supplier company does not own the link');
  const purchases = async () => (await pool.query('SELECT count(*)::int n FROM b2b_network_orders WHERE link_id=$1', [f.link.id])).rows[0].n;
  const before = [await purchases(), await ordersOf(f.account.id)];
  const refused = await netCheckout(f, await netQuote(f, 2));
  assert.equal(refused.statusCode, 409, refused.body);
  assert.deepEqual([await purchases(), await ordersOf(f.account.id)], before, 'neither the supplier order nor the buyer purchase');
  assert.equal((await netCheckout(f, await netQuote(f, 1))).statusCode, 200, 'exactly the free 123,45');
  assert.equal((await api(f.base + '/trade-credit', 'GET', undefined, buyer)).summary.available_minor, 0);
});
