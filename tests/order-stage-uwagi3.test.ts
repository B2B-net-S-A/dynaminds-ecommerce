// Uwagi v3 §1/§7: fulfilment stage and payment state as two indicators; demo label → Gotowe do nadania → Nadane.
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { orderFulfilmentStageSql } from '../server/order-stage';
import { stageFilterSql, paymentStateSql } from '../server/order-stage-query';
assert.equal(process.env.DYNA_TEST, 'true', 'Uruchom testy przez npm test — wymagają osobnej bazy');
let app: FastifyInstance, cookie: string, warehouse: string;
const request = (url: string, method: any = 'GET', payload?: any) =>
  app.inject({ url, method, payload, headers: { cookie } });
const ok = async (url: string, method: any = 'GET', payload?: any) => {
  const r = await request(url, method, payload);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  cookie = r.headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await request('/api/warehouses')).json().data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function order(payment_mode: 'prepaid' | 'cod', quantity = 1) {
  const sku = 'UW3B-' + randomUUID().slice(0, 8);
  const p = await ok('/api/products', 'POST', { name: 'Produkt ' + sku, sku, price: 5000, warehouse_id: warehouse, quantity: 10 });
  const o = await ok('/api/orders', 'POST', {
    customer_name: 'Klient UW3', email: 'uw3@example.test', warehouse_id: warehouse, payment_mode,
    items: [{ product_id: p.id, quantity }], shipping_cost: 1000,
    address: { city: 'Warszawa', street: 'Testowa 1', postal_code: '00-001', phone: '500600700' },
  });
  return { o, p };
}
const status = async (id: string, s: string) =>
  ok(`/api/orders/${id}/status`, 'PATCH', await legacySerialOrderStatusPayload((p) => request(p), `/api/orders/${id}/status`, { status: s }));
async function pay(id: string, amount: number) {
  const version = (await ok(`/api/orders/${id}`)).version;
  await ok(`/api/orders/${id}/payments`, 'POST', {
    client_key: randomUUID(), version, kind: 'receipt', amount, currency: 'PLN', method: 'bank_transfer', reference: 'Przelew UW3', confirmed: true,
  });
}
async function packed(payment_mode: 'prepaid' | 'cod' = 'cod') {
  const { o, p } = await order(payment_mode);
  if (payment_mode === 'prepaid') await pay(o.id, o.total);
  await status(o.id, 'picking');
  await ok(`/api/orders/${o.id}/scan`, 'POST', { code: p.sku });
  await status(o.id, 'packed');
  return o;
}
const counts = () => ok('/api/orders/status-counts');

test('reguła płatności: przelew bez wpłaty zostaje new (Czeka na wpłatę, Nieopłacone); pobranie i wpłata → paid (Nowe)', async () => {
  const prepaid = (await order('prepaid')).o, cod = (await order('cod')).o;
  assert.equal(prepaid.status, 'new');
  assert.equal(prepaid.fulfilment_stage, 'new');
  assert.equal(prepaid.payment_state, 'unpaid');
  assert.equal(cod.status, 'paid', 'pobranie od razu w Nowe');
  assert.equal(cod.payment_state, 'cod', 'pobranie nie jest „opłacone”, tylko „Pobranie”');
  await pay(prepaid.id, 1000);
  const partial = await ok(`/api/orders/${prepaid.id}`);
  assert.equal(partial.status, 'new', 'częściowa wpłata nie przenosi do Nowe');
  assert.equal(partial.payment_state, 'partial');
  await pay(prepaid.id, prepaid.total - 1000);
  const paid = await ok(`/api/orders/${prepaid.id}`);
  assert.deepEqual([paid.status, paid.fulfilment_stage, paid.payment_state], ['paid', 'paid', 'paid']);
  await pay(prepaid.id, 500);
  assert.equal((await ok(`/api/orders/${prepaid.id}`)).payment_state, 'overpaid');
});

test('etykieta demo nie nadaje: Spakowane → Gotowe do nadania → Nadane; liczniki etapów', async () => {
  const before = await counts();
  const o = await packed();
  let card = await ok(`/api/orders/${o.id}`);
  assert.deepEqual([card.status, card.fulfilment_stage], ['packed', 'packed']);
  const mid = await counts();
  assert.equal((mid.statuses.packed ?? 0) - (before.statuses.packed ?? 0), 1);
  card = await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  assert.deepEqual([card.status, card.fulfilment_stage], ['packed', 'ready_to_ship'], 'etykieta nie zmienia kodu na shipped');
  assert.equal(card.shipments.length, 1);
  assert.equal(card.shipments[0].dispatched_at, null);
  const ready = await counts();
  assert.equal((ready.statuses.ready_to_ship ?? 0) - (mid.statuses.ready_to_ship ?? 0), 1);
  assert.equal((ready.statuses.packed ?? 0) - (mid.statuses.packed ?? 0), -1, 'packed nie liczy zamówień gotowych do nadania');
  assert.equal(ready.total, mid.total);
  const again = await request(`/api/orders/${o.id}/demo-label`, 'POST', {});
  assert.equal(again.statusCode, 409, 'druga etykieta jest odrzucona');
  card = await ok(`/api/orders/${o.id}/ship-demo`, 'POST', {});
  assert.deepEqual([card.status, card.fulfilment_stage], ['shipped', 'shipped']);
  assert.equal(card.shipments.length, 1, 'nadanie używa tej samej etykiety');
  assert.ok(card.shipments[0].dispatched_at);
  assert.equal((await request(`/api/orders/${o.id}/ship-demo`, 'POST', {})).statusCode, 409);
  const after = await counts();
  assert.equal((after.statuses.ready_to_ship ?? 0) - (ready.statuses.ready_to_ship ?? 0), -1);
});

test('ship-demo bez etykiety dalej nadaje w jednym kroku; etykieta wymaga spakowania i przedpłaty', async () => {
  const o = await packed('prepaid');
  const card = await ok(`/api/orders/${o.id}/ship-demo`, 'POST', {});
  assert.equal(card.status, 'shipped');
  const notPacked = (await order('cod')).o;
  assert.equal((await request(`/api/orders/${notPacked.id}/demo-label`, 'POST', {})).statusCode, 409);
});

test('liczniki płatności i filtr etapu korzystają z tej samej semantyki co karta', async () => {
  const before = await counts();
  const unpaid = (await order('prepaid')).o, cod = (await order('cod')).o;
  const ready = await packed();
  await ok(`/api/orders/${ready.id}/demo-label`, 'POST', {});
  const now = await counts();
  for (const k of ['unpaid', 'partial', 'overpaid', 'cod']) assert.equal(typeof now.payment[k], 'number', k);
  assert.equal(now.payment.unpaid - before.payment.unpaid, 1);
  assert.equal(now.payment.cod - before.payment.cod, 2, 'pobranie nowe i gotowe do nadania');
  await tenantTx(DEMO_TENANT, async (c) => {
    const ids = [unpaid.id, cod.id, ready.id];
    const f = stageFilterSql('o', ['ready_to_ship'], 2);
    const rows = (await c.query(`SELECT o.id FROM orders o WHERE o.id=ANY($1::uuid[]) AND ${f.sql}`, [ids, ...f.params])).rows;
    assert.deepEqual(rows.map((r) => r.id), [ready.id]);
    const p = stageFilterSql('o', ['packed'], 2);
    assert.equal((await c.query(`SELECT o.id FROM orders o WHERE o.id=ANY($1::uuid[]) AND ${p.sql}`, [ids, ...p.params])).rowCount, 0);
    const none = stageFilterSql('o', null, 2);
    assert.equal((await c.query(`SELECT o.id FROM orders o WHERE o.id=ANY($1::uuid[]) AND ${none.sql}`, [ids, ...none.params])).rowCount, 3);
    const n = stageFilterSql('o', ['new', 'paid'], 2);
    assert.equal((await c.query(`SELECT o.id FROM orders o WHERE o.id=ANY($1::uuid[]) AND ${n.sql}`, [ids, ...n.params])).rowCount, 2);
    const summary = "(SELECT json_build_object('net',0,'credit',0))";
    const states = (await c.query(`SELECT o.id,${paymentStateSql('o', summary)} AS state,${orderFulfilmentStageSql('o')} AS stage FROM orders o WHERE o.id=ANY($1::uuid[])`, [ids])).rows;
    const byId = Object.fromEntries(states.map((r) => [r.id, [r.state, r.stage]]));
    assert.deepEqual(byId[unpaid.id], ['unpaid', 'new']);
    assert.deepEqual(byId[cod.id], ['cod', 'paid']);
    assert.deepEqual(byId[ready.id], ['cod', 'ready_to_ship']);
  });
});
