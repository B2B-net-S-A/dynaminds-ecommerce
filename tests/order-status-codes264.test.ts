// Uwaga klienta 05.11.2026 (docs/order-status-codes.md): new = „Nieopłacone”, paid = „Nowe” (gotowe do realizacji).
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed } from './fixtures';
import { statusTarget } from '../server/order-status';
assert.equal(process.env.DYNA_TEST, 'true', 'Uruchom testy przez npm test — wymagają osobnej bazy');
let app: FastifyInstance, cookie: string, warehouse: string;
const request = (url: string, method: any = 'GET', payload?: any) =>
  app.inject({ url, method, payload, headers: { cookie } });
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
async function product() {
  const sku = 'S264-' + randomUUID().slice(0, 8);
  const r = await request('/api/products', 'POST', { name: 'Produkt ' + sku, sku, price: 5000, warehouse_id: warehouse, quantity: 10 });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function order(payment_mode: 'prepaid' | 'cod') {
  const p = await product();
  const r = await request('/api/orders', 'POST', {
    customer_name: 'Klient 264', email: 'k264@example.test', warehouse_id: warehouse, payment_mode,
    items: [{ product_id: p.id, quantity: 1 }], shipping_cost: 1000,
    address: { city: 'Warszawa', street: 'Testowa 1', postal_code: '00-001' },
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
const status = async (id: string, s: string) =>
  request(`/api/orders/${id}/status`, 'PATCH', await legacySerialOrderStatusPayload((p) => request(p), `/api/orders/${id}/status`, { status: s }));
const balance = async (id: string) => (await request(`/api/orders/${id}/payments`)).json().balance;

test('przedpłata startuje jako new (Nieopłacone); kompletacja przed wpłatą jest odrzucona', async () => {
  const o = await order('prepaid');
  assert.equal(o.status, 'new');
  const r = await status(o.id, 'picking');
  assert.equal(r.statusCode, 409, r.body);
  assert.match(r.json().detail, /Niedozwolona zmiana statusu new → picking/);
  assert.equal((await request(`/api/orders/${o.id}`)).json().status, 'new');
});

test('„Oznacz jako opłacone” (PATCH paid) księguje brakującą kwotę i przenosi do Nowe; potem kompletacja', async () => {
  const o = await order('prepaid');
  assert.equal((await balance(o.id)).amount_due, o.total);
  const r = await status(o.id, 'paid');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'paid');
  assert.equal((await balance(o.id)).amount_due, 0);
  assert.equal((await status(o.id, 'picking')).statusCode, 200);
});

test('wpłata domykająca saldo przenosi new → paid; częściowa zostawia new', async () => {
  const o = await order('prepaid');
  const pay = async (amount: number) => {
    const version = (await request(`/api/orders/${o.id}`)).json().version;
    const r = await request(`/api/orders/${o.id}/payments`, 'POST', {
      client_key: randomUUID(), version, kind: 'receipt', amount, currency: 'PLN', method: 'bank_transfer', reference: 'Przelew 264', confirmed: true,
    });
    assert.equal(r.statusCode, 200, r.body);
  };
  await pay(o.total - 100);
  assert.equal((await request(`/api/orders/${o.id}`)).json().status, 'new');
  await pay(100);
  assert.equal((await request(`/api/orders/${o.id}`)).json().status, 'paid');
});

test('pobranie startuje od razu w paid (Nowe); ponowne oznaczenie opłacenia jest odrzucone', async () => {
  const o = await order('cod');
  assert.equal(o.status, 'paid');
  assert.equal((await balance(o.id)).received, 0, 'pobranie nie dostaje fikcyjnej wpłaty');
  assert.equal((await status(o.id, 'paid')).statusCode, 409);
  assert.equal((await status(o.id, 'picking')).statusCode, 200);
});

test('kanał nie dostaje statusu opłacenia dla pobrania w paid; przedpłata w paid tak', () => {
  const ch = { id: randomUUID(), provider: 'woocommerce' };
  const base = { channel_id: ch.id, source: 'woocommerce', external_id: '264', source_snapshot: { items: [{}] } };
  assert.throws(() => statusTarget(ch, { ...base, status: 'paid', payment_mode: 'cod' }), /osobnego procesu/);
  assert.equal(statusTarget(ch, { ...base, status: 'paid', payment_mode: 'prepaid' }), 'processing');
  assert.equal(statusTarget(ch, { ...base, status: 'picking', payment_mode: 'cod' }), 'processing');
});

test('migracja 264 przenosi pobranie z new do paid, a nieopłaconą przedpłatę zostawia', async () => {
  const cod = await order('cod'), prepaid = await order('prepaid');
  // Legacy row from before 264: cash on delivery waited in new.
  await pool.query("UPDATE orders SET status='new' WHERE id=$1", [cod.id]);
  await pool.query(readFileSync(new URL('../server/264_order_status_labels.sql', import.meta.url), 'utf8'));
  const rows = (await pool.query('SELECT id,status FROM orders WHERE id=ANY($1::uuid[])', [[cod.id, prepaid.id]])).rows;
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.status])), { [cod.id]: 'paid', [prepaid.id]: 'new' });
});
