/** Automation rules v2, lane M (orders): split_order and set_delivery_method on the real 222 split and
 * order-section modules. Runs go through POST /rules/:id/run (the request actor). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { DEFAULT_RUN } from '../shared/automation-v2';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, operator: string, warehouse: string, product: string, other: string;
const V2 = '/api/automations/v2';
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) => app.inject({ url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = async (email: string) => {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0]!;
  };
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await ok('/api/warehouses')).data[0].id;
  const make = async (name: string, category?: string) =>
    (await ok('/api/products', 'POST', { name, sku: 'V2M-' + randomUUID().slice(0, 8), price: 2500, warehouse_id: warehouse, quantity: 1000, ...(category ? { category } : {}) })).id;
  product = await make('Reguły M');
  other = await make('Reguły M gabaryt');
});
after(async () => {
  await app.close();
  await pool.end();
});

async function order(email: string, items: { product_id: string; quantity: number }[] = [{ product_id: product, quantity: 1 }]) {
  return ok('/api/orders', 'POST', {
    customer_name: 'QA reguły M',
    email,
    warehouse_id: warehouse,
    items,
    address: { street: 'Testowa 1', postal_code: '00-001', country: 'PL', city: 'Warszawa', phone: '500600700' },
  });
}
const act = (o: any, a: any) => ok('/api/orders/' + o.id + '/operations', 'POST', a);
const rule = (effects: any[]) =>
  ok(V2 + '/rules', 'POST', {
    name: 'M ' + randomUUID().slice(0, 8),
    trigger: 'order.matches',
    enabled: true,
    config: {
      version: 2,
      group: 'Testy M',
      scope: 'orders',
      run: { ...DEFAULT_RUN, manual_button: true, auto: false },
      conditions: { match: 'all', items: [] },
      effects,
      stop_further: false,
    },
  });
async function run(r: any, o: any, cookie = admin) {
  const [s] = (await ok(V2 + '/rules/' + r.id + '/run', 'POST', { order_ids: [o.id] }, cookie)).runs;
  const row = (await pool.query('SELECT state,error,result FROM automation_runs WHERE id=$1', [s.id])).rows[0];
  return { ...row, effects: row.result?.effects ?? [] };
}
const header = async (id: string) => (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
/** Purchasing source epoch (purchasing_source_version): unchanged = the run wrote no purchasing source (PO, receipt,
 * B2B network order, stock), so the stronger purchasingAdmission of the HTTP merge/split transaction is not needed. */
const purchasingSource = async () =>
  (
    await pool.query(
      'SELECT coalesce((SELECT version FROM purchasing_source_versions WHERE tenant_id=$1),0)::text v,coalesce((SELECT max(id) FROM purchasing_stock_changes WHERE tenant_id=$1),0)::text s',
      [DEMO_TENANT],
    )
  ).rows[0];

test('split_order: moves the chosen product lines to one new order through the 222 split', async () => {
  const o = await order(`s-${randomUUID().slice(0, 8)}@example.test`, [
    { product_id: product, quantity: 2 },
    { product_id: other, quantity: 3 },
  ]);
  const r = await rule([{ type: 'split_order', params: { mode: 'products', product_ids: [other] } }]);
  const source = await purchasingSource();
  const s = await run(r, o, operator);
  assert.equal(s.state, 'done', s.error);
  assert.equal(s.effects[0].changed, true);
  assert.match(s.effects[0].message, new RegExp(`do nowego zamówienia ${o.number}-S1`));
  assert.deepEqual(await purchasingSource(), source);
  const child = (await pool.query('SELECT id,total FROM orders WHERE number=$1', [o.number + '-S1'])).rows[0];
  assert.ok(child);
  const lines = async (id: string) => (await pool.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1', [id])).rows;
  assert.deepEqual(await lines(child.id), [{ product_id: other, quantity: 3 }]);
  assert.deepEqual(await lines(o.id), [{ product_id: product, quantity: 2 }]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM order_split222_executions WHERE parent_order_id=$1', [o.id])).rows[0].n, 1);
  // Nothing of that product left: bez zmian, no second child.
  const again = await run(r, o);
  assert.equal(again.state, 'done');
  assert.equal(again.effects[0].changed, false);
  // A foreign product is refused when the rule is saved.
  const bad = await req(V2 + '/rules', 'POST', {
    name: 'M zły', trigger: 'order.matches', enabled: true,
    config: { version: 2, group: 'Testy M', scope: 'orders', run: { ...DEFAULT_RUN, manual_button: true, auto: false }, conditions: { match: 'all', items: [] }, effects: [{ type: 'split_order', params: { mode: 'products', product_ids: [randomUUID()] } }], stop_further: false },
  });
  assert.equal(bad.statusCode, 422, bad.body);
});

test('split_order: the module refuses an order in picking; the reason is the run error', async () => {
  const o = await order(`p-${randomUUID().slice(0, 8)}@example.test`, [
    { product_id: product, quantity: 1 },
    { product_id: other, quantity: 1 },
  ]);
  await act(o, { type: 'set_status', status: 'paid' });
  await act(o, { type: 'set_status', status: 'picking' });
  const r = await rule([{ type: 'split_order', params: { mode: 'products', product_ids: [other] } }]);
  const s = await run(r, o);
  assert.equal(s.state, 'failed');
  assert.match(s.error, /Podział jest możliwy tylko dla zamówienia nowego lub opłaconego/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM order_split222_executions WHERE parent_order_id=$1', [o.id])).rows[0].n, 0);
});

test('set_delivery_method: section save with history, weight tiers and "bez zmian"', async () => {
  const o = await order(`d-${randomUUID().slice(0, 8)}@example.test`);
  const r = await rule([{ type: 'set_delivery_method', params: { method: 'parcel_locker', carrier: 'InPost' } }]);
  const s = await run(r, o, operator);
  assert.equal(s.state, 'done', s.error);
  assert.equal(s.effects[0].changed, true);
  assert.match(s.effects[0].message, /Zmieniono sposób dostawy na Paczkomat \/ automat paczkowy, InPost/);
  const ev = (await pool.query("SELECT detail FROM order_events WHERE order_id=$1 AND kind='order.section_edited' ORDER BY created_at DESC,id DESC LIMIT 1", [o.id])).rows[0].detail;
  assert.equal(ev.section, 'delivery_method');
  assert.deepEqual(ev.changes.find((x: any) => x.field === 'method'), { field: 'method', label: 'Sposób dostawy', before: 'Kurier', after: 'Paczkomat / automat paczkowy' });
  assert.match(ev.actor_name, /reguła M /);
  const card = await ok('/api/orders/' + o.id);
  assert.equal(card.section_values.delivery_method.method, 'parcel_locker');
  assert.equal(card.section_values.delivery_method.carrier, 'InPost');
  const same = await run(r, o);
  assert.equal(same.state, 'done');
  assert.equal(same.effects[0].changed, false);
  assert.match(same.effects[0].message, /bez zmian/);
  // Weight variant: the order weighs 0 g (no logistics data), so the "up to" tier applies.
  const w = await rule([{ type: 'set_delivery_method', params: { method: 'courier', carrier: 'Tani kurier', weight_over_g: 1000, method_over: 'courier', carrier_over: 'Kurier gabaryt' } }]);
  const tier = await run(w, o);
  assert.equal(tier.state, 'done', tier.error);
  assert.match(tier.effects[0].message, /Kurier, Tani kurier \(waga 0 g ≤ 1000 g\)/);
  // An incomplete weight variant is refused when the rule is saved.
  const bad = await req(V2 + '/rules', 'POST', {
    name: 'M waga', trigger: 'order.matches', enabled: true,
    config: { version: 2, group: 'Testy M', scope: 'orders', run: { ...DEFAULT_RUN, manual_button: true, auto: false }, conditions: { match: 'all', items: [] }, effects: [{ type: 'set_delivery_method', params: { method: 'courier', weight_over_g: 500 } }], stop_further: false },
  });
  assert.equal(bad.statusCode, 422, bad.body);
});

test('set_delivery_method: a locked section (cancelled order) refuses with the section\'s reason', async () => {
  const o = await order(`c-${randomUUID().slice(0, 8)}@example.test`);
  await run(await rule([{ type: 'cancel_order', params: {} }]), o);
  assert.equal((await header(o.id)).status, 'cancelled');
  const before = (await pool.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='order.section_edited'", [o.id])).rows[0].n;
  const s = await run(await rule([{ type: 'set_delivery_method', params: { method: 'post' } }]), o);
  assert.equal(s.state, 'failed');
  assert.ok(s.error && s.error.length > 3, s.error);
  assert.equal((await pool.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='order.section_edited'", [o.id])).rows[0].n, before);
});
