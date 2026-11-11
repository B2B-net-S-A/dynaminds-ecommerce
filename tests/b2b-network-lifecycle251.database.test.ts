/** Migration 251 (prepared as 258) on a disposable clone: B2B-002 disconnect/reconnect, B2B-003 unbind/rebind and purchase
 * price sync, B2B-004-X supplier acceptance with an expiring reservation, B2B-005 dropshipping tracking copied to the
 * customer order. Exact stock and money, no oversell, idempotent sync, refusals.
 * Database test on a fresh disposable clone dynaminds_m251_YYYYMMDD_NN of the restored template; the real migrate()
 * applies 218...251 (before() asserts the ledger row 251_b2b_network_lifecycle). */
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed } from './fixtures';
import { processB2bCatalog, failB2bCatalog } from '../server/b2b-network';
import { sweepB2bNetworkLifecycleDue } from '../server/b2b-network-decisions';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:25[123456789]|26[0123])_202610(?:28|29|30)_[0-9]{2}$/, 'fresh clone dynaminds_m251_YYYYMMDD_NN (or m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 252/253/254/255/256/257/258/259/260/261/262) of the restored template');
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

let app: any, admin = '', viewer = '', buyer = '', warehouse = '', buyerWarehouse = '', buyerTenant = '', supplierTenant = '';
let ip = 1;
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie }, remoteAddress: '127.0.58.' + ((ip % 250) + 1) });
async function api(path: string, method: any = 'GET', body?: any, cookie = admin) {
  const r = await req(path, method, body, cookie);
  assert(r.statusCode < 300, method + ' ' + path + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
const loginAs = async (email: string) => {
  const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie'].toString().split(';')[0];
};
before(async () => {
  await migrate();
  assert.equal((await pool.query("SELECT count(*)::int n FROM migrations WHERE name='251_b2b_network_lifecycle'")).rows[0].n, 1, 'migrate() applied 251');
  await seed();
  app = await buildApp();
  admin = await loginAs('admin@demo.local');
  viewer = await loginAs('viewer@demo.local');
  buyer = await loginAs('other@demo.local');
  warehouse = (await api('/warehouses')).data[0].id;
  buyerWarehouse = (await api('/warehouses', 'GET', undefined, buyer)).data[0].id;
  buyerTenant = (await pool.query("SELECT m.tenant_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='other@demo.local' ORDER BY m.tenant_id LIMIT 1")).rows[0].tenant_id;
  supplierTenant = (await pool.query("SELECT tenant_id FROM warehouses WHERE id=$1", [warehouse])).rows[0].tenant_id;
});
after(async () => {
  await app?.close();
  await pool.end();
});

const stock = async (product: string) =>
  (await pool.query('SELECT coalesce(sum(on_hand),0)::int on_hand,coalesce(sum(reserved),0)::int reserved FROM stock WHERE product_id=$1', [product])).rows[0];
async function refresh(f: any) {
  const run = await api(f.base + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true }, buyer);
  for (let n = 0; n < 600; n++) {
    const r = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1', [run.id])).rows[0];
    if (r.state === 'done') return;
    assert.equal(r.state, 'queued', r.error);
    const job = (await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *", [r.job_id, randomUUID()])).rows[0];
    try { await processB2bCatalog(job); } catch (e) { await failB2bCatalog(job, e); throw e; }
  }
  assert.fail('catalog run did not finish');
}
/** A supplier product (stock 40, list price 123,45), an approved account, a link accepted by the buyer company, the
 * catalogue read and the offer imported as the buyer's own product. */
async function linked(stockQty = 40) {
  ip++;
  const f: any = {};
  f.product = await api('/products', 'POST', { name: 'Karton 258', sku: 'L258-' + randomUUID().slice(0, 10), price: 20000, vat: 23, warehouse_id: warehouse, quantity: stockQty });
  f.list = await api('/price-lists', 'POST', { name: 'Cennik 258 ' + randomUUID().slice(0, 6), currency: 'PLN' });
  f.list = { ...f.list, version: (await api('/price-lists/' + f.list.id + '/items', 'PUT', { version: f.list.version, items: [{ product_id: f.product.id, price: 12345 }] })).version };
  f.body = {
    name: 'Kontrahent 258 ' + randomUUID().slice(0, 6), email: randomUUID() + '@example.test', warehouse_id: warehouse, price_list_id: f.list.id,
    address: { street: 'Hurtowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' }, min_total: 0, min_quantity: 1, quantity_step: 1, shipping_cost: 0, payment_mode: 'prepaid',
  };
  const a = await api('/b2b/accounts', 'POST', f.body);
  f.account = await api('/b2b/accounts/' + a.id, 'PATCH', { ...f.body, version: a.version, active: true, confirmed: true });
  const invite = await api('/b2b/accounts/' + f.account.id + '/network-invite', 'POST', { version: f.account.version, recipient_email: 'other@demo.local', confirmed: true });
  f.link = await api('/b2b/network/accept', 'POST', { token: invite.token, confirmed: true }, buyer);
  f.base = '/b2b/network/links/' + f.link.id;
  await refresh(f);
  f.item = (await api(f.base + '/catalog', 'GET', undefined, buyer)).data[0];
  f.local = (await api(f.base + '/catalog/' + f.item.id + '/product', 'POST', { version: f.item.version, sku: 'OWN-' + randomUUID().slice(0, 10), sale_price: 25000, warehouse_id: buyerWarehouse, confirmed: true }, buyer)).product_id;
  return f;
}
const quote = (f: any, qty: number) => req(f.base + '/quotes', 'POST', { client_key: randomUUID(), warehouse_id: buyerWarehouse, items: [{ item_id: f.item.id, quantity: qty }] }, buyer);
async function purchase(f: any, qty: number) {
  const q = await quote(f, qty);
  assert.equal(q.statusCode, 200, q.body);
  const o = await req(f.base + '/quotes/' + q.json().id + '/checkout', 'POST', { confirmed: true }, buyer);
  assert.equal(o.statusCode, 200, o.body);
  return o.json();
}
const linkState = async (linkId: string) => (await pool.query('SELECT * FROM b2b258_link_states WHERE link_id=$1', [linkId])).rows[0];
const linkEvents = async (linkId: string) => (await pool.query('SELECT kind,side,reason FROM b2b258_link_events WHERE link_id=$1 ORDER BY created_at,id', [linkId])).rows;

// ---- B2B-002 ---------------------------------------------------------------------------------------------
test('B2B-002: the buyer disconnects; new purchases and settings stop, the open order and stock stay exactly', async () => {
  const f = await linked();
  const o = await purchase(f, 3);
  const before = await stock(f.product.id);
  assert.deepEqual(before, { on_hand: 40, reserved: 3 });
  const l = (await api('/b2b/network/links', 'GET', undefined, buyer)).data.find((x: any) => x.id === f.link.id);
  assert.equal((await req(f.base + '/disconnect', 'POST', { version: l.version, reason: 'Koniec współpracy', confirmed: true }, admin)).statusCode, 404, 'another company');
  assert.equal((await req(f.base + '/disconnect', 'POST', { version: l.version + 5, reason: 'Koniec współpracy', confirmed: true }, buyer)).statusCode, 409, 'stale version');
  assert.equal((await req(f.base + '/disconnect', 'POST', { version: l.version, reason: '', confirmed: true }, buyer)).statusCode, 422, 'a reason is required');
  const d = await api(f.base + '/disconnect', 'POST', { version: l.version, reason: 'Koniec współpracy', confirmed: true }, buyer);
  assert.equal(d.state.state, 'disconnected');
  assert.equal(d.state.disconnected_side, 'buyer');
  assert.equal(d.reused, false);
  const again = await api(f.base + '/disconnect', 'POST', { version: l.version, reason: 'Koniec współpracy', confirmed: true }, buyer);
  assert.equal(again.reused, true, 'replay of an already disconnected link');
  assert.deepEqual(await linkEvents(f.link.id), [{ kind: 'disconnected', side: 'buyer', reason: 'Koniec współpracy' }]);
  const row = (await pool.query('SELECT paused,next_at FROM b2b_links WHERE id=$1', [f.link.id])).rows[0];
  assert.deepEqual(row, { paused: true, next_at: null });
  // No new quote, purchase, catalogue refresh or unpause.
  assert.equal((await quote(f, 1)).statusCode, 409);
  assert.equal((await req(f.base + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true }, buyer)).statusCode, 409);
  const now = (await api('/b2b/network/links', 'GET', undefined, buyer)).data.find((x: any) => x.id === f.link.id);
  const unpause = await req(f.base, 'PATCH', { version: now.version, paused: false, schedule_minutes: 0, confirmed: true }, buyer);
  assert.equal(unpause.statusCode, 409, unpause.body);
  assert.match(unpause.json().detail, /odłączone/);
  // History stays readable; stock and the open order are untouched.
  assert.equal((await api('/b2b/network/orders/' + o.id, 'GET', undefined, buyer)).state, 'ordered');
  assert.deepEqual(await stock(f.product.id), before);
  assert.equal((await api('/orders/' + o.source_order_id)).status, 'new');
  // The supplier sees the state on its account; both sides have their audit entry.
  const seen = await api('/b2b/accounts/' + f.account.id + '/network-link');
  assert.deepEqual([seen.link.id, seen.link.state, seen.link.disconnected_side], [f.link.id, 'disconnected', 'buyer']);
  const audits = (await pool.query("SELECT tenant_id,action FROM audit_events WHERE entity_id=$1 AND action LIKE 'b2b.network.disconnect%' ORDER BY action", [f.link.id])).rows;
  assert.deepEqual(audits.map((a) => a.action).sort(), ['b2b.network.disconnect', 'b2b.network.disconnected_by_partner']);
  // The buyer may still cancel the open purchase, which releases the supplier reservation exactly.
  const cancel = await req('/b2b/network/orders/' + o.id + '/cancel', 'POST', { version: o.version, client_key: randomUUID(), reason: 'Po odłączeniu', confirmed: true }, buyer);
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.deepEqual(await stock(f.product.id), { on_hand: 40, reserved: 0 });
});

test('B2B-002: the supplier disconnects; a new invitation reconnects the same link for the same company only', async () => {
  const f = await linked();
  assert.equal((await req('/b2b/accounts/' + f.account.id + '/network-disconnect', 'POST', { reason: 'Zaległości', confirmed: true }, viewer)).statusCode, 403);
  // While connected a second invitation is refused.
  const acc = f.account;
  assert.equal((await req('/b2b/accounts/' + f.account.id + '/network-invite', 'POST', { version: acc.version, recipient_email: 'other@demo.local', confirmed: true })).statusCode, 409);
  const d = await api('/b2b/accounts/' + f.account.id + '/network-disconnect', 'POST', { reason: 'Zaległości', confirmed: true });
  assert.deepEqual([d.state.state, d.state.disconnected_side, d.reused], ['disconnected', 'supplier', false]);
  assert.equal((await quote(f, 1)).statusCode, 409);
  // A pending invitation can be revoked; the revoked token no longer connects.
  const first = await api('/b2b/accounts/' + f.account.id + '/network-invite', 'POST', { version: acc.version, recipient_email: 'other@demo.local', confirmed: true });
  assert.equal((await api('/b2b/accounts/' + f.account.id + '/network-invite/revoke', 'POST', { confirmed: true })).revoked, 1);
  assert.equal((await api('/b2b/accounts/' + f.account.id + '/network-invite/revoke', 'POST', { confirmed: true })).revoked, 0, 'nothing left');
  assert.equal((await req('/b2b/network/accept', 'POST', { token: first.token, confirmed: true }, buyer)).statusCode, 404);
  // Another company of the same administrator cannot take the account over.
  const third = randomUUID(), user = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'")).rows[0].id;
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Trzecia firma 258','enterprise')", [third]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [third, user]);
  const sw = await req('/workspaces/switch', 'POST', { tenant_id: third }, await loginAs('other@demo.local'));
  assert.equal(sw.statusCode, 200, sw.body);
  const thirdCookie = String(sw.headers['set-cookie']).split(';')[0];
  const second = await api('/b2b/accounts/' + f.account.id + '/network-invite', 'POST', { version: acc.version, recipient_email: 'other@demo.local', confirmed: true });
  const taken = await req('/b2b/network/accept', 'POST', { token: second.token, confirmed: true }, thirdCookie);
  assert.equal(taken.statusCode, 409, taken.body);
  assert.match(taken.json().detail, /inną firmą/);
  assert.equal((await pool.query('SELECT state FROM b2b_link_invitations WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1', [f.account.id])).rows[0].state, 'pending', 'the refusal rolled back');
  // The original company accepts: the same link row, a new version, active again.
  const versionBefore = (await pool.query('SELECT version FROM b2b_links WHERE id=$1', [f.link.id])).rows[0].version;
  const back = await api('/b2b/network/accept', 'POST', { token: second.token, confirmed: true }, buyer);
  assert.equal(back.id, f.link.id);
  assert.equal(back.paused, false);
  assert.equal(back.version, versionBefore + 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM b2b_links WHERE account_id=$1', [f.account.id])).rows[0].n, 1);
  assert.equal((await linkState(f.link.id)).state, 'connected');
  assert.deepEqual((await linkEvents(f.link.id)).map((e) => [e.kind, e.side]), [['disconnected', 'supplier'], ['reconnected', 'buyer']]);
  assert.equal((await quote(f, 1)).statusCode, 200, 'purchases work again');
});

// ---- B2B-003 ---------------------------------------------------------------------------------------------
test('B2B-003: unbind blocks purchases of the offer, rebind restores or switches it, with history', async () => {
  const f = await linked();
  const other = await api('/products', 'POST', { name: 'Własny karton B', sku: 'OWNB-' + randomUUID().slice(0, 8), price: 3000, vat: 23, warehouse_id: buyerWarehouse, quantity: 0 }, buyer);
  const base = f.base + '/catalog/' + f.item.id;
  assert.equal((await req(base + '/unbind', 'POST', { reason: 'Zmiana', confirmed: true }, admin)).statusCode, 404, 'another company');
  const u = await api(base + '/unbind', 'POST', { reason: 'Zły produkt', confirmed: true }, buyer);
  assert.deepEqual([u.mapping.state, u.mapping.product_id, u.reused], ['unbound', f.local, false]);
  assert.equal((await api(base + '/unbind', 'POST', { reason: 'Zły produkt', confirmed: true }, buyer)).reused, true);
  const refused = await quote(f, 1);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.match(refused.json().detail, /odpięte/);
  // Reattach to the same product, then switch to another own product (this offer has no 144 proof).
  assert.equal((await api(base + '/rebind', 'POST', { product_id: f.local, confirmed: true }, buyer)).mapping.state, 'bound');
  assert.equal((await quote(f, 1)).statusCode, 200);
  const s = await api(base + '/rebind', 'POST', { product_id: other.id, confirmed: true }, buyer);
  assert.deepEqual([s.mapping.state, s.mapping.product_id], ['bound', other.id]);
  assert.equal((await pool.query('SELECT product_id FROM b2b_catalog_items WHERE id=$1', [f.item.id])).rows[0].product_id, other.id);
  assert.equal((await api(base + '/rebind', 'POST', { product_id: other.id, confirmed: true }, buyer)).reused, true);
  assert.equal((await req(base + '/rebind', 'POST', { product_id: randomUUID(), confirmed: true }, buyer)).statusCode, 409, 'not an own product');
  const q = await quote(f, 2);
  assert.equal(q.statusCode, 200);
  assert.equal(q.json().summary.items[0].product_id, other.id, 'the purchase now lands on the new product');
  const history = (await api(base + '/history', 'GET', undefined, buyer)).data.map((e: any) => [e.kind, e.product_before, e.product_after]);
  assert.deepEqual(history, [['rebound', f.local, other.id], ['rebound', f.local, f.local], ['unbound', f.local, null]]);
  // Own stock is never written by the mapping.
  assert.deepEqual(await stock(other.id), { on_hand: 0, reserved: 0 });
});

test('B2B-003: a bound offer with the 144 proof unbinds and reattaches, but never switches to another product', async () => {
  const f = await linked();
  const own = await api('/products', 'POST', { name: 'Własny dowód', sku: 'OWNP-' + randomUUID().slice(0, 8), price: 3000, vat: 23, warehouse_id: buyerWarehouse, quantity: 0 }, buyer);
  const another = await api('/products', 'POST', { name: 'Inny produkt', sku: 'OWNQ-' + randomUUID().slice(0, 8), price: 3000, vat: 23, warehouse_id: buyerWarehouse, quantity: 0 }, buyer);
  // A second supplier product, bound through the existing bind route (writes the immutable 144 proof).
  const p2 = await api('/products', 'POST', { name: 'Karton dowodu', sku: 'L258P-' + randomUUID().slice(0, 8), price: 20000, vat: 23, warehouse_id: warehouse, quantity: 5 });
  await api('/price-lists/' + f.list.id + '/items', 'PUT', { version: f.list.version, items: [{ product_id: f.product.id, price: 12345 }, { product_id: p2.id, price: 999 }] });
  await refresh(f);
  const item = (await api(f.base + '/catalog', 'GET', undefined, buyer)).data.find((i: any) => i.source_product_id === p2.id);
  const bound = await req(f.base + '/catalog/' + item.id + '/bind', 'POST', { client_key: randomUUID(), version: item.version, product_id: own.id, confirmed: true }, buyer);
  assert.equal(bound.statusCode, 201, bound.body);
  const base = f.base + '/catalog/' + item.id;
  assert.equal((await api(base + '/unbind', 'POST', { reason: 'Przegląd', confirmed: true }, buyer)).mapping.state, 'unbound');
  const sw = await req(base + '/rebind', 'POST', { product_id: another.id, confirmed: true }, buyer);
  assert.equal(sw.statusCode, 409, sw.body);
  assert.match(sw.json().detail, /tylko do tego samego produktu/);
  assert.equal((await api(base + '/rebind', 'POST', { product_id: own.id, confirmed: true }, buyer)).mapping.state, 'bound');
  assert.equal((await pool.query('SELECT count(*)::int n FROM b2b_catalog_bindings WHERE item_id=$1', [item.id])).rows[0].n, 1, 'the proof is unchanged');
});

test('B2B-003: the purchase price sync follows the supplier price exactly, once; own price and stock stay', async () => {
  const f = await linked();
  const first = await api(f.base + '/mappings/price-sync', 'POST', { confirmed: true }, buyer);
  assert.deepEqual([first.changed, first.unchanged], [1, 0]);
  const again = await api(f.base + '/mappings/price-sync', 'POST', { confirmed: true }, buyer);
  assert.deepEqual([again.changed, again.unchanged], [0, 1], 'idempotent');
  // The supplier raises the price by one grosz; the diff shows it before the sync.
  await api('/price-lists/' + f.list.id + '/items', 'PUT', { version: f.list.version, items: [{ product_id: f.product.id, price: 12346 }] });
  await refresh(f);
  const diff = (await api(f.base + '/mappings', 'GET', undefined, buyer)).data.find((r: any) => r.item_id === f.item.id);
  assert.deepEqual([diff.supplier_price_minor, diff.purchase_price_minor, diff.price_delta_minor, diff.price_changed, diff.own_price_minor, diff.currency],
    [12346, 12345, 1, true, 25000, 'PLN']);
  assert.equal(diff.supplier_available, 40);
  const synced = await api(f.base + '/mappings/price-sync', 'POST', { confirmed: true }, buyer);
  assert.equal(synced.changed, 1);
  const row = (await pool.query('SELECT purchase_price_minor::int p,purchase_currency c FROM b2b258_mappings WHERE item_id=$1', [f.item.id])).rows[0];
  assert.deepEqual(row, { p: 12346, c: 'PLN' });
  const events = (await pool.query("SELECT price_before_minor::int b,price_after_minor::int a FROM b2b258_mapping_events WHERE item_id=$1 AND kind='price_synced' ORDER BY created_at", [f.item.id])).rows;
  assert.deepEqual(events, [{ b: null, a: 12345 }, { b: 12345, a: 12346 }]);
  const own = await api('/products/' + f.local, 'GET', undefined, buyer);
  assert.equal(own.price, 25000, 'the sale price is never written');
  assert.deepEqual(await stock(f.local), { on_hand: 0, reserved: 0 }, 'supplier availability is never written into own stock');
  assert.equal((await req(f.base + '/mappings/price-sync', 'POST', { confirmed: true }, admin)).statusCode, 404, 'another company');
});

// ---- B2B-004-X -------------------------------------------------------------------------------------------
const decisions = (state = 'pending') => api('/b2b/network/decisions?state=' + state);
const decide = (orderId: string, body: any, cookie = admin) => req('/b2b/network/decisions/' + orderId, 'POST', { confirmed: true, reason: '', ...body }, cookie);
const buyerEvents = async (o: any) => (await api('/b2b/network/orders/' + o.id + '/events', 'GET', undefined, buyer));

test('B2B-004-X: a purchase waits for the supplier; acceptance notifies the buyer once; the reservation holds, no oversell', async () => {
  const f = await linked(10);
  const o = await purchase(f, 7);
  assert.deepEqual(await stock(f.product.id), { on_hand: 10, reserved: 7 });
  const pending = (await decisions()).data.find((d: any) => d.order_id === o.source_order_id);
  assert(pending, 'the supplier inbox lists it');
  assert.equal(pending.state, 'pending');
  assert.equal(pending.total_gross, 7 * 12345);
  const hours = (new Date(pending.decide_by).getTime() - new Date(pending.created_at).getTime()) / 3600e3;
  assert.equal(Math.round(hours), 48);
  assert.equal((await api('/b2b/network/orders/' + o.id, 'GET', undefined, buyer)).decision.state, 'pending');
  // The pending order's reservation counts: 4 more would oversell the 3 left, so the checkout books nothing.
  const over = await quote(f, 4);
  assert.equal(over.statusCode, 200, 'a quote reserves nothing');
  assert.equal((await req(f.base + '/quotes/' + over.json().id + '/checkout', 'POST', { confirmed: true }, buyer)).statusCode, 409);
  assert.deepEqual(await stock(f.product.id), { on_hand: 10, reserved: 7 });
  // Only the supplier's administrator decides.
  assert.equal((await decide(o.source_order_id, { decision: 'accept', version: 1 }, viewer)).statusCode, 403);
  assert.equal((await decide(o.source_order_id, { decision: 'accept', version: 1 }, buyer)).statusCode, 404);
  assert.equal((await decide(o.source_order_id, { decision: 'accept', version: 2 })).statusCode, 409);
  const ok = await decide(o.source_order_id, { decision: 'accept', version: 1 });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual([ok.json().decision.state, ok.json().reused], ['accepted', false]);
  const replay = await decide(o.source_order_id, { decision: 'accept', version: 1 });
  assert.equal(replay.json().reused, true);
  assert.equal((await decide(o.source_order_id, { decision: 'reject', version: 2, reason: 'Za późno' })).statusCode, 409, 'a decision is final');
  const ev = await buyerEvents(o);
  assert.deepEqual(ev.data.map((e: any) => e.kind), ['accepted']);
  assert.equal(ev.decision.state, 'accepted');
  assert.deepEqual(await stock(f.product.id), { on_hand: 10, reserved: 7 }, 'acceptance keeps the reservation');
  assert.equal((await purchase(f, 3)).decision.state, 'pending', 'exactly the free 3');
  assert.deepEqual(await stock(f.product.id), { on_hand: 10, reserved: 10 });
});

test('B2B-004-X: a rejection cancels the supplier order, releases exactly its reservation and frees the trade credit', async () => {
  const f = await linked(10);
  const line = await req('/b2b/accounts/' + f.account.id + '/trade-credit', 'PUT', { currency: 'PLN', term_days: 14, active: true, confirmed: true, limit_minor: 100000, version: 0 });
  assert.equal(line.statusCode, 200, line.body);
  const keep = await purchase(f, 2);
  const o = await purchase(f, 5);
  assert.deepEqual(await stock(f.product.id), { on_hand: 10, reserved: 7 });
  const credit = async () => (await api('/b2b/accounts/' + f.account.id + '/trade-credit')).summary.exposure_minor;
  assert.equal(await credit(), 7 * 12345);
  assert.equal((await decide(o.source_order_id, { decision: 'reject', version: 1, reason: '' })).statusCode, 422, 'a rejection needs a reason');
  const r = await decide(o.source_order_id, { decision: 'reject', version: 1, reason: 'Brak mocy produkcyjnych' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().decision.state, 'rejected');
  assert.deepEqual(await stock(f.product.id), { on_hand: 10, reserved: 2 }, 'exactly the 5 released');
  assert.equal((await api('/orders/' + o.source_order_id)).status, 'cancelled');
  assert.equal(await credit(), 2 * 12345, 'the rejected order owes nothing');
  const mine = await api('/b2b/network/orders/' + o.id, 'GET', undefined, buyer);
  assert.equal(mine.state, 'cancelled');
  assert.deepEqual(mine.cancel_request, { by: 'supplier', reason: 'Brak mocy produkcyjnych' });
  const ev = await buyerEvents(o);
  assert.deepEqual(ev.data.map((e: any) => [e.kind, e.detail.reason]), [['rejected', 'Brak mocy produkcyjnych']]);
  assert.equal((await api('/b2b/network/orders/' + keep.id, 'GET', undefined, buyer)).decision.state, 'pending', 'the other order is untouched');
});

test('B2B-004-X: the sweep expires an undecided order, accepts a dispatched one, and is idempotent', async () => {
  const f = await linked(10);
  const late = await purchase(f, 4), shipped = await purchase(f, 1), cancel = await purchase(f, 2);
  // The buyer withdraws one before any decision.
  const withdrawn = await req('/b2b/network/orders/' + cancel.id + '/cancel', 'POST', { version: cancel.version, client_key: randomUUID(), reason: 'Rezygnacja', confirmed: true }, buyer);
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  assert.equal((await api('/b2b/network/orders/' + cancel.id, 'GET', undefined, buyer)).decision.state, 'withdrawn');
  // The supplier ships one without an explicit decision.
  const s = shipped.source_order_id;
  for (const status of ['paid', 'picking']) await api('/orders/' + s + '/status', 'PATCH', await legacySerialOrderStatusPayload((p) => api(p), '/orders/' + s + '/status', { status }));
  await api('/orders/' + s + '/scan', 'POST', { code: f.product.sku });
  await api('/orders/' + s + '/status', 'PATCH', await legacySerialOrderStatusPayload((p) => api(p), '/orders/' + s + '/status', { status: 'packed' }));
  await api('/orders/' + s + '/ship-demo', 'POST', {});
  await pool.query("UPDATE b2b258_order_decisions SET created_at=now()-interval '3 days',decide_by=now()-interval '1 second' WHERE network_order_id = ANY($1::uuid[])", [[late.id, shipped.id]]);
  assert.deepEqual(await stock(f.product.id), { on_hand: 9, reserved: 4 });
  await sweepB2bNetworkLifecycleDue();
  await sweepB2bNetworkLifecycleDue();
  const state = async (o: any) => (await api('/b2b/network/orders/' + o.id, 'GET', undefined, buyer));
  const l = await state(late), sh = await state(shipped);
  assert.deepEqual([l.decision.state, l.decision.decided_via, l.state], ['expired', 'expiry', 'cancelled']);
  assert.deepEqual([sh.decision.state, sh.decision.decided_via, sh.state], ['accepted', 'dispatch', 'ordered']);
  assert.equal((await api('/orders/' + late.source_order_id)).status, 'cancelled');
  assert.deepEqual(await stock(f.product.id), { on_hand: 9, reserved: 0 }, 'only the expired order released, exactly 4');
  assert.deepEqual((await buyerEvents(late)).data.map((e: any) => e.kind), ['expired']);
  const shippedEvents = (await buyerEvents(shipped)).data;
  assert.deepEqual(shippedEvents.map((e: any) => e.kind), ['accepted', 'dispatched'], 'one event each, after two sweeps');
  assert.match(shippedEvents[1].detail.tracking_number, /.+/);
  // The buyer's manual sync adds nothing new.
  const sync = await api('/b2b/network/orders/' + shipped.id + '/events/sync', 'POST', { confirmed: true }, buyer);
  assert.equal(sync.added, 0);
  assert.deepEqual((await buyerEvents(cancel)).data.map((e: any) => e.kind), ['withdrawn']);
});

test('B2B-004-X: a due decision whose cancel is refused is parked with the reason, keeps its reservation and starves nothing', async () => {
  const f = await linked(10);
  const stuck = await purchase(f, 3), clean = await purchase(f, 2);
  // The supplier queued an external invoice for one order: cancelOrder refuses it (409).
  const channel = randomUUID();
  await pool.query("INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'fakturownia','Faktury 258','sandbox','x','{}')", [channel, supplierTenant]);
  const user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  await pool.query("INSERT INTO invoice_plans(id,tenant_id,order_id,channel_id,actor_id,kind,mode,state,input,payload,order_snapshot) VALUES($1,$2,$3,$4,$5,'invoice','external','queued','{}','{}','{}')",
    [randomUUID(), supplierTenant, stuck.source_order_id, channel, user]);
  await pool.query("UPDATE b2b258_order_decisions SET created_at=now()-interval '3 days',decide_by=now()-interval '1 second' WHERE network_order_id = ANY($1::uuid[])", [[stuck.id, clean.id]]);
  await sweepB2bNetworkLifecycleDue();
  const d = (await pool.query('SELECT state,sweep_error,sweep_after>now() parked FROM b2b258_order_decisions WHERE network_order_id=$1', [stuck.id])).rows[0];
  assert.deepEqual([d.state, d.parked], ['pending', true]);
  assert.match(d.sweep_error, /Faktura/);
  assert.equal((await api('/b2b/network/orders/' + clean.id, 'GET', undefined, buyer)).decision.state, 'expired', 'the clean order still expires');
  assert.deepEqual(await stock(f.product.id), { on_hand: 10, reserved: 3 }, 'only the clean 2 released');
  const inbox = (await decisions()).data.find((x: any) => x.order_id === stuck.source_order_id);
  assert.match(inbox.sweep_error, /Faktura/, 'the supplier sees why');
  await sweepB2bNetworkLifecycleDue();
  assert.equal((await pool.query('SELECT state FROM b2b258_order_decisions WHERE network_order_id=$1', [stuck.id])).rows[0].state, 'pending', 'parked rows wait');
});

test('B2B-004-X: the supplier cannot reject an order already in fulfilment', async () => {
  const f = await linked(10);
  const o = await purchase(f, 1), s = o.source_order_id;
  for (const status of ['paid', 'picking']) await api('/orders/' + s + '/status', 'PATCH', await legacySerialOrderStatusPayload((p) => api(p), '/orders/' + s + '/status', { status }));
  const r = await decide(s, { decision: 'reject', version: 1, reason: 'Jednak nie' });
  assert.equal(r.statusCode, 409, r.body);
  assert.match(r.json().detail, /Realizacja zamówienia już trwa/);
  assert.equal((await decide(s, { decision: 'accept', version: 1 })).statusCode, 200);
});

// ---- B2B-005 ---------------------------------------------------------------------------------------------
test('B2B-005: the supplier parcel number reaches the customer order once, with the customer order event', async () => {
  const f = await linked(30);
  // The seller's own stock of the imported product and a retail customer order.
  const doc = await api('/warehouse-documents', 'POST', { kind: 'receipt', warehouse_id: buyerWarehouse, reference: 'Stan 258', note: '', lines: [{ product_id: f.local, quantity: 20, location: 'DS-58' }] }, buyer);
  await api('/warehouse-documents/' + doc.id + '/post', 'POST', { version: doc.version }, buyer);
  const order = await api('/orders', 'POST', {
    shipping_cost: 900, customer_name: 'Klient detaliczny', email: 'retail258@example.test', warehouse_id: buyerWarehouse, currency: 'PLN', payment_mode: 'prepaid',
    address: { street: 'Klienta 9', city: 'Gdańsk', postal_code: '80-001', country: 'PL', phone: '555000258' }, items: [{ product_id: f.local, quantity: 2 }],
  }, buyer);
  const path = f.base + '/dropshipping';
  const q = await req(path + '/quotes', 'POST', { client_key: randomUUID(), customer_order_id: order.id, items: [{ customer_item_id: order.items[0].id, quantity: 2, mappings: [{ product_id: f.local, catalog_item_id: f.item.id }] }] }, buyer);
  assert.equal(q.statusCode, 201, q.body);
  const quoteRow = q.json().quote;
  const c = await req(path + '/quotes/' + quoteRow.id + '/checkout', 'POST', { client_key: randomUUID(), scope_hash: quoteRow.scope_hash, confirmed: true, confirmed_receiver: true }, buyer);
  assert.equal(c.statusCode, 201, c.body);
  const drop = c.json().order;
  const sync = () => req(path + '/orders/' + drop.id + '/tracking/sync', 'POST', { confirmed: true }, buyer);
  const none = await sync();
  assert.equal(none.statusCode, 200, none.body);
  assert.deepEqual(none.json().order.customer_tracking, [], 'nothing dispatched yet');
  // The supplier dispatches its order.
  const s = drop.supplier_order_id;
  for (const status of ['paid', 'picking']) await api('/orders/' + s + '/status', 'PATCH', await legacySerialOrderStatusPayload((p) => api(p), '/orders/' + s + '/status', { status }));
  for (let n = 0; n < 2; n++) await api('/orders/' + s + '/scan', 'POST', { code: f.product.sku });
  await api('/orders/' + s + '/status', 'PATCH', await legacySerialOrderStatusPayload((p) => api(p), '/orders/' + s + '/status', { status: 'packed' }));
  await api('/orders/' + s + '/ship-demo', 'POST', {});
  const parcel = (await pool.query('SELECT carrier,tracking_number FROM shipments WHERE order_id=$1', [s])).rows[0];
  assert.equal((await req(path + '/orders/' + drop.id + '/tracking/sync', 'POST', { confirmed: true }, admin)).statusCode, 404, 'another company');
  const [a, b] = await Promise.all([sync(), sync()]);
  assert.deepEqual([a.statusCode, b.statusCode], [200, 200], a.body + b.body);
  const copies = (await pool.query('SELECT customer_order_id,carrier,tracking_number FROM b2b258_tracking_copies WHERE dropship_order_id=$1', [drop.id])).rows;
  assert.deepEqual(copies, [{ customer_order_id: order.id, carrier: parcel.carrier, tracking_number: parcel.tracking_number }], 'exactly one copy under concurrency');
  assert.deepEqual(a.json().order.customer_tracking.map((t: any) => t.tracking_number), [parcel.tracking_number]);
  const events = (await pool.query("SELECT detail FROM order_events WHERE order_id=$1 AND kind='order.dropship_tracking'", [order.id])).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.tracking_number, parcel.tracking_number);
  await sweepB2bNetworkLifecycleDue();
  assert.equal((await pool.query('SELECT count(*)::int n FROM b2b258_tracking_copies WHERE dropship_order_id=$1', [drop.id])).rows[0].n, 1, 'the sweep adds nothing');
  // The customer order itself is not shipped by the copy and no local parcel is invented.
  assert.equal((await pool.query('SELECT count(*)::int n FROM shipments WHERE order_id=$1', [order.id])).rows[0].n, 0);
});
