// Automation rules v2, Uwagi v3 §0 "Zdarzenia" (lane J): status from/to, item missing, stock change, label cancel,
// carrier status (DEMO simulation) and customer message, raised by real flows and evaluated by the worker.
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { tick } from '../server/worker';
import { scheduleV2StockChecks } from '../server/automation-v2-stock';
import { messageExcerpt } from '../server/customer-messages';
import { DEFAULT_RUN } from '../shared/automation-v2';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, viewer: string, warehouse: string;
const V2 = '/api/automations/v2';
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) => app.inject({ url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
async function refused(url: string, method: any, payload: any, status: number, message?: RegExp, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  if (message) assert.match(r.json().message ?? r.body, message);
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = async (email: string) => {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  };
  admin = await login('admin@demo.local');
  viewer = await login('viewer@demo.local');
  warehouse = (await ok('/api/warehouses')).data[0].id;
});
beforeEach(async () => {
  await pool.query('UPDATE automation_rules SET enabled=false,version=version+1 WHERE enabled');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE state IN ('pending','running')");
});
after(async () => {
  await app.close();
  await pool.end();
});

async function drain() {
  for (let i = 0; i < 300; i++) if (!(await tick())) return;
  assert.fail('Kolejka nie wygasła w 300 krokach');
}
const rule = (trigger: string, patch: any = {}) =>
  ok(V2 + '/rules', 'POST', {
    name: 'J ' + randomUUID().slice(0, 8),
    trigger,
    enabled: true,
    config: {
      version: 2,
      group: 'Zdarzenia',
      scope: 'orders',
      run: DEFAULT_RUN,
      conditions: patch.conditions ?? { match: 'all', items: [] },
      effects: [{ type: 'add_tag', params: { tag: patch.tag ?? 'J' } }],
      stop_further: false,
      ...(patch.status_change ? { status_change: patch.status_change } : {}),
    },
  });
async function product(quantity = 10) {
  const sku = 'J-' + randomUUID().slice(0, 8);
  return ok('/api/products', 'POST', { name: 'Produkt ' + sku, sku, price: 4000, warehouse_id: warehouse, quantity });
}
async function order(p: any, quantity = 1, email = 'j@example.test') {
  return ok('/api/orders', 'POST', {
    customer_name: 'Klient J', email, warehouse_id: warehouse, payment_mode: 'cod',
    items: [{ product_id: p.id, quantity }],
    address: { city: 'Warszawa', street: 'Testowa 1', postal_code: '00-001', phone: '500600700' },
  });
}
const card = (o: any) => ok('/api/orders/' + o.id);
const status = async (id: string, s: string) =>
  ok(`/api/orders/${id}/status`, 'PATCH', await legacySerialOrderStatusPayload((p) => req(p), `/api/orders/${id}/status`, { status: s }));
async function packed() {
  const p = await product();
  const o = await order(p);
  await status(o.id, 'picking');
  await ok(`/api/orders/${o.id}/scan`, 'POST', { code: p.sku });
  await status(o.id, 'packed');
  return { o, p };
}
const events = async (orderId: string, kind: string) =>
  (await pool.query('SELECT detail FROM order_events WHERE order_id=$1 AND kind=$2 ORDER BY created_at,id', [orderId, kind])).rows.map((r) => r.detail);
const tagged = async (o: any, tag = 'J') => (await card(o)).tags.includes(tag);

test('catalog: the six events are available; status filter validated against trigger, codes and tenant', async () => {
  const c = await ok(V2 + '/catalog', 'GET', undefined, viewer);
  for (const key of ['order.status_changed', 'order.item_missing', 'stock.changed', 'shipment.cancelled', 'shipment.status_changed', 'customer_message.received'])
    assert.notEqual(c.triggers.find((t: any) => t.key === key).supported, false, key);
  const statuses = c.fields.find((f: any) => f.key === 'shipping.shipment_status').options;
  assert.ok(statuses.some((o: any) => o.value === 'picked_up' && o.label === 'Odebrana przez kuriera'));
  const body = (trigger: string, status_change: any) => ({
    name: 'Zła reguła', trigger, enabled: true,
    config: { version: 2, group: 'Testy', scope: 'orders', run: DEFAULT_RUN, conditions: { match: 'all', items: [] }, effects: [{ type: 'add_tag', params: { tag: 'X' } }], stop_further: false, status_change },
  });
  await refused(V2 + '/rules', 'POST', body('order.created', { from: ['paid'], to: [] }), 422, /tylko dla zdarzenia/);
  await refused(V2 + '/rules', 'POST', body('order.status_changed', { from: ['ready_to_ship'], to: [] }), 422, /Nieznany status/);
  await refused(V2 + '/rules', 'POST', body('order.status_changed', { from: [], to: [randomUUID()] }), 422, /spoza organizacji/);
  // An empty filter means "any status" and is not stored.
  const any = await ok(V2 + '/rules', 'POST', body('order.status_changed', { from: [], to: [] }));
  assert.equal(any.config.status_change, undefined);
});

test('order.status_changed: z wybranego statusu na wybrany; other transitions do not fire', async () => {
  const toPicking = await rule('order.status_changed', { status_change: { from: ['paid'], to: ['picking'] }, tag: 'PAID-PICK' });
  const fromNew = await rule('order.status_changed', { status_change: { from: ['new'], to: ['picking'] }, tag: 'NEW-PICK' });
  const toPacked = await rule('order.status_changed', { status_change: { from: [], to: ['packed'] }, tag: 'ANY-PACKED' });
  assert.deepEqual(toPicking.config.status_change, { from: ['paid'], to: ['picking'] });
  const p = await product();
  const o = await order(p); // cash on delivery: paid at once
  await status(o.id, 'picking');
  await drain();
  let c = await card(o);
  assert.ok(c.tags.includes('PAID-PICK'), 'paid → picking fires');
  assert.ok(!c.tags.includes('NEW-PICK'), 'from new does not match paid');
  assert.ok(!c.tags.includes('ANY-PACKED'), 'to packed does not match picking');
  await ok(`/api/orders/${o.id}/scan`, 'POST', { code: p.sku });
  await status(o.id, 'packed');
  await drain();
  c = await card(o);
  assert.ok(c.tags.includes('ANY-PACKED'), 'any → packed fires');
  const runs = (await pool.query('SELECT rule_id FROM automation_runs WHERE order_id=$1', [o.id])).rows.map((r) => r.rule_id);
  assert.ok(!runs.includes(fromNew.id));
  assert.equal(runs.filter((id) => id === toPicking.id).length, 1, 'picking → packed does not fire paid → picking again');
});

test('order.item_missing: Zgłoś brak raises the event once per key; refusals for viewer, quantity, line, stage', async () => {
  await rule('order.item_missing', { tag: 'BRAK' });
  const p = await product();
  const o = await order(p, 2);
  const item = (await card(o)).items[0];
  const url = `/api/orders/${o.id}/items/${item.id}/missing`;
  await refused(url, 'POST', { quantity_missing: 1 }, 403, /tylko do odczytu/, viewer);
  await refused(url, 'POST', { quantity_missing: 3 }, 422, /przekraczać/);
  await refused(url, 'POST', { quantity_missing: 0 }, 422, /co najmniej 1/);
  await refused(`/api/orders/${o.id}/items/${randomUUID()}/missing`, 'POST', { quantity_missing: 1 }, 404);
  const key = randomUUID();
  const first = await ok(url, 'POST', { quantity_missing: 2, client_key: key });
  const again = await ok(url, 'POST', { quantity_missing: 2, client_key: key });
  assert.equal(again.event_id, first.event_id);
  assert.equal(again.replayed, true);
  await refused(url, 'POST', { quantity_missing: 1, client_key: key }, 409, /Klucz/);
  const ev = await events(o.id, 'order.item_missing');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].sku, p.sku);
  assert.equal(ev[0].quantity_missing, 2);
  assert.equal(ev[0].item_id, item.id);
  assert.ok(ev[0].actor.user_id);
  await drain();
  assert.ok(await tagged(o, 'BRAK'));
  const unpaid = await ok('/api/orders', 'POST', {
    customer_name: 'Klient J', email: 'j@example.test', warehouse_id: warehouse, payment_mode: 'prepaid',
    items: [{ product_id: p.id, quantity: 1 }],
  });
  const unpaidItem = (await card(unpaid)).items[0];
  await refused(`/api/orders/${unpaid.id}/items/${unpaidItem.id}/missing`, 'POST', { quantity_missing: 1 }, 409, /w realizacji/);
});

test('stock.changed: a receipt raises the event for open orders of the product; "Stan wystarcza" is checked', async () => {
  const sufficient = { match: 'all', items: [{ field: 'product.stock_sufficient', op: 'is_true', quantifier: 'all' }] };
  const enough = await rule('stock.changed', { conditions: sufficient, tag: 'DOSTAWA' });
  const short = { match: 'all', items: [{ field: 'product.stock_sufficient', op: 'is_false' }] };
  await rule('stock.changed', { conditions: short, tag: 'NIEDOBOR' });
  const p = await product(1);
  const waiting = await order(p, 1); // the order reserves the only piece
  const other = await product(5);
  const unrelated = await order(other, 1);
  const shippedP = await packed();
  await ok(`/api/orders/${shippedP.o.id}/ship-demo`, 'POST', {});
  await scheduleV2StockChecks([DEMO_TENANT], true); // first check records the current values only
  assert.equal((await events(waiting.id, 'stock.changed')).length, 0);
  await ok('/api/inventory/adjust', 'POST', { product_id: p.id, warehouse_id: warehouse, delta: 10, note: 'Dostawa J' });
  await ok('/api/inventory/adjust', 'POST', { product_id: shippedP.p.id, warehouse_id: warehouse, delta: 3, note: 'Dostawa J' });
  await scheduleV2StockChecks([DEMO_TENANT], true);
  const ev = await events(waiting.id, 'stock.changed');
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].product_id, ev[0].sku, ev[0].after - ev[0].before], [p.id, p.sku, 10]);
  assert.equal((await events(unrelated.id, 'stock.changed')).length, 0, 'another product does not raise it');
  assert.equal((await events(shippedP.o.id, 'stock.changed')).length, 0, 'a shipped order is not open');
  await drain();
  assert.ok(await tagged(waiting, 'DOSTAWA'), 'stock covers the line');
  assert.ok(!(await tagged(waiting, 'NIEDOBOR')), 'the opposite condition does not fire');
  const run = (await pool.query("SELECT result FROM automation_runs WHERE rule_id=$1 AND order_id=$2 AND state='done'", [enough.id, waiting.id])).rows[0];
  const checked = run.result.conditions.find((x: any) => x.field === 'product.stock_sufficient');
  assert.equal(checked.ok, true, 'the rule evaluated "Stan wystarcza" on the new stock');
  // No change since the last check: nothing new.
  await scheduleV2StockChecks([DEMO_TENANT], true);
  assert.equal((await events(waiting.id, 'stock.changed')).length, 1);
});

test('shipment.cancelled: Anuluj etykietę returns Gotowe do nadania to Spakowane and opens the sections', async () => {
  await rule('shipment.cancelled', { tag: 'ANULOWANA' });
  const { o } = await packed();
  let c = await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  assert.equal(c.fulfilment_stage, 'ready_to_ship');
  c = await card(o);
  assert.equal(c.section_locks.delivery_address.action, 'cancel_label');
  await refused(`/api/orders/${o.id}/cancel-label`, 'POST', {}, 403, /tylko do odczytu/, viewer);
  c = await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  assert.deepEqual([c.status, c.fulfilment_stage], ['packed', 'packed']);
  c = await card(o);
  assert.equal(c.section_locks.delivery_address.locked, false, 'the label lock is gone');
  assert.equal(c.section_locks.delivery_method.locked, false);
  const ev = await events(o.id, 'shipment.cancelled');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].scope, 'local');
  await refused(`/api/orders/${o.id}/cancel-label`, 'POST', {}, 409, /nie ma etykiety/);
  await refused(`/api/orders/${o.id}/demo-label`, 'POST', {}, 409, /anulowano/);
  // The server refuses to print or fetch a cancelled label, not only the hidden card button.
  const sid = (await pool.query('SELECT id FROM shipments WHERE order_id=$1', [o.id])).rows[0].id;
  const uuid = randomUUID;
  const printBody = { client_key: uuid(), order_version: '1', station_id: uuid(), station_version: '1', printer_id: uuid(), printer_version: '1', copies: 1 };
  await refused(`/api/print-jobs/shipments/${sid}/label-previews`, 'POST', printBody, 409, /anulowan/);
  // "Przekaż kurierowi (DEMO)" must not hand over the cancelled label.
  await refused(`/api/orders/${o.id}/ship-demo`, 'POST', {}, 409, /anulowano/);
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [o.id])).rows[0].status, 'packed');
  assert.equal((await pool.query('SELECT count(*)::int n FROM shipments WHERE order_id=$1 AND dispatched_at IS NOT NULL', [o.id])).rows[0].n, 0);
  await drain();
  assert.ok(await tagged(o, 'ANULOWANA'));
  const plain = await packed();
  await refused(`/api/orders/${plain.o.id}/cancel-label`, 'POST', {}, 409, /nie ma etykiety/);
  await ok(`/api/orders/${plain.o.id}/demo-label`, 'POST', {});
  await ok(`/api/orders/${plain.o.id}/ship-demo`, 'POST', {});
  await refused(`/api/orders/${plain.o.id}/cancel-label`, 'POST', {}, 409, /przed nadaniem/);
});

test('shipment.status_changed: DEMO simulation sets the carrier status that the condition sees', async () => {
  const inTransit = { match: 'all', items: [{ field: 'shipping.shipment_status', op: 'in', value: ['in_transit'] }] };
  await rule('shipment.status_changed', { conditions: inTransit, tag: 'W-DRODZE' });
  const { o } = await packed();
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  await refused(`/api/orders/${o.id}/demo-shipment-status`, 'POST', { status: 'in_transit' }, 409, /przekaż/);
  await ok(`/api/orders/${o.id}/ship-demo`, 'POST', {});
  await refused(`/api/orders/${o.id}/demo-shipment-status`, 'POST', { status: 'lost_forever' }, 422, /status przesyłki/);
  await refused(`/api/orders/${o.id}/demo-shipment-status`, 'POST', { status: 'in_transit' }, 403, /tylko do odczytu/, viewer);
  await drain();
  assert.ok(!(await tagged(o, 'W-DRODZE')));
  const c = await ok(`/api/orders/${o.id}/demo-shipment-status`, 'POST', { status: 'in_transit' });
  assert.equal(c.shipments[0].status, 'in_transit');
  await refused(`/api/orders/${o.id}/demo-shipment-status`, 'POST', { status: 'in_transit' }, 409, /ma już status/);
  const ev = await events(o.id, 'shipment.status_changed');
  assert.deepEqual([ev[0].to, ev[0].status, ev[0].scope], ['in_transit', 'in_transit', 'demo']);
  await drain();
  assert.ok(await tagged(o, 'W-DRODZE'));
  const unlabelled = await packed();
  await refused(`/api/orders/${unlabelled.o.id}/demo-shipment-status`, 'POST', { status: 'delivered' }, 409, /DEMO/);
});

test('customer_message.received: portal and marketplace messages of an order raise the event', async () => {
  await rule('customer_message.received', { tag: 'WIADOMOSC' });
  const p = await product();
  const email = 'kupujacy-' + randomUUID().slice(0, 6) + '@example.test';
  const o = await order(p, 1, email);
  const token = o.portal_token;
  assert.ok(token, 'the order has a buyer portal token');
  await ok('/api/public/orders/' + token + '/messages', 'POST', { client_key: randomUUID(), body: 'Gdzie   jest\nmoja paczka?' }, '');
  let ev = await events(o.id, 'customer_message.received');
  const portal = ev.find((d) => d.channel === 'portal');
  assert.ok(portal);
  assert.equal(portal.excerpt, 'Gdzie jest moja paczka?');
  assert.ok(portal.message_id);
  await drain();
  assert.ok(await tagged(o, 'WIADOMOSC'));
  const conn = (await ok('/api/channel-inbox/connections', 'POST', { channel: 'allegro', name: 'Allegro J ' + randomUUID().slice(0, 4) })).connection;
  const msg = (n: string, order_number: string | null) => ({
    external_thread_id: 'T-' + n, external_message_id: 'M-' + n, body: 'Pytanie z Allegro', buyer_ref: email, order_number,
  });
  const ingest = await ok(`/api/channel-inbox/connections/${conn.id}/messages`, 'POST', {
    messages: [msg(randomUUID(), (await card(o)).number), msg(randomUUID(), null)],
  });
  assert.equal(ingest.created, 2);
  ev = await events(o.id, 'customer_message.received');
  assert.equal(ev.filter((d) => d.channel === 'allegro').length, 1, 'only the message linked to the order');
  assert.equal(messageExcerpt('x'.repeat(200)).length, 120);
});
