/** Automation rules v2, effect merge_orders ("Połącz z innymi otwartymi zamówieniami tego samego klienta").
 * The rule never merges by itself: the merge module needs an administrator's live session (209 address inheritance),
 * so the rule checks the pairs with the module's own checks and leaves a proposal + bell notification for admins,
 * who merge in the module. Runs go through POST /rules/:id/run (the request actor). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed } from './fixtures';
import { DEFAULT_RUN } from '../shared/automation-v2';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, operator: string, other: string, warehouse: string, product: string, sku: string;
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
  other = await login('other@demo.local');
  warehouse = (await ok('/api/warehouses')).data[0].id;
  sku = 'V2J-' + randomUUID().slice(0, 8);
  product = (await ok('/api/products', 'POST', { name: 'Reguły łączenie', sku, price: 2500, warehouse_id: warehouse, quantity: 1000 })).id;
});
after(async () => {
  await app.close();
  await pool.end();
});

const ADDRESS = { street: 'Łączna 1', postal_code: '00-001', country: 'PL', city: 'Warszawa', phone: '500600700' };
async function order(email: string, extra: Record<string, unknown> = {}, cookie = admin, wh = warehouse, pr = product) {
  return ok('/api/orders', 'POST', { customer_name: 'QA łączenie', email, warehouse_id: wh, items: [{ product_id: pr, quantity: 1 }], address: ADDRESS, ...extra }, cookie);
}
const act = (o: any, a: any) => ok('/api/orders/' + o.id + '/operations', 'POST', a);
const rule = (params: Record<string, unknown> = {}) =>
  ok(V2 + '/rules', 'POST', {
    name: 'J ' + randomUUID().slice(0, 8),
    trigger: 'order.matches',
    enabled: true,
    config: {
      version: 2,
      group: 'Testy łączenia',
      scope: 'orders',
      run: { ...DEFAULT_RUN, manual_button: true, auto: false },
      conditions: { match: 'all', items: [] },
      effects: [{ type: 'merge_orders', params }],
      stop_further: false,
    },
  });
async function run(r: any, o: any, cookie = admin) {
  const [s] = (await ok(V2 + '/rules/' + r.id + '/run', 'POST', { order_ids: [o.id] }, cookie)).runs;
  const row = (await pool.query('SELECT state,error,result FROM automation_runs WHERE id=$1', [s.id])).rows[0];
  return { ...row, effects: row.result?.effects ?? [] };
}
const proposals = async (id: string) =>
  (await pool.query("SELECT detail FROM audit_events WHERE action='automation.merge_proposal' AND detail->'order_ids' ? $1", [id])).rows.map((r) => r.detail);
const merged = async (ids: string[]) =>
  (await pool.query('SELECT count(*)::int n FROM order_merge_claims WHERE source_order_id=ANY($1::uuid[])', [ids])).rows[0].n;
const mail = () => `j-${randomUUID().slice(0, 8)}@example.test`;

test('catalog: merge_orders is a supported effect with the admin picker', async () => {
  const c = await ok(V2 + '/catalog');
  const e = c.effects.find((x: any) => x.type === 'merge_orders');
  assert.equal(e.supported, undefined);
  assert.ok(e.params.some((p: any) => p.key === 'user_ids' && p.kind === 'multiselect'));
});

test('merge_orders: same customer and address -> proposal for the admins, nothing merged; idempotent', async () => {
  const email = mail();
  const a = await order(email),
    b = await order(email);
  const r = await rule();
  const s = await run(r, b, operator);
  assert.equal(s.state, 'done', s.error);
  assert.equal(s.effects[0].changed, true, s.effects[0].message);
  assert.match(s.effects[0].message, new RegExp(`Propozycja połączenia zamówień ${a.number}, ${b.number}`));
  assert.equal(await merged([a.id, b.id]), 0);
  const [p] = await proposals(a.id);
  assert.deepEqual([...p.order_ids].sort(), [a.id, b.id].sort());
  assert.equal(p.main_order_id, a.id);
  // History of both orders names the rule.
  for (const o of [a, b]) {
    const ev = (await pool.query("SELECT detail FROM order_events WHERE order_id=$1 AND kind='automation.merge_proposed'", [o.id])).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].detail.rule_id, r.id);
  }
  // Bell: the admin sees the proposal with the orders to merge; the operator (cannot merge) gets nothing.
  const bell = (await ok(V2 + '/notifications')).data.find((n: any) => n.merge_order_ids?.includes(a.id));
  assert.ok(bell, 'admin notification');
  assert.deepEqual([...bell.merge_order_ids].sort(), [a.id, b.id].sort());
  assert.match(bell.message, /module łączenia zamówień/);
  assert.equal((await ok(V2 + '/notifications', 'GET', undefined, operator)).data.some((n: any) => n.merge_order_ids?.includes(a.id)), false);
  // Second run (and a run from the other order): same set -> no second proposal, no second notification.
  for (const o of [b, a]) {
    const again = await run(r, o);
    assert.equal(again.state, 'done', again.error);
    assert.equal(again.effects[0].changed, false);
    assert.match(again.effects[0].message, /już czeka/);
  }
  assert.equal((await proposals(a.id)).length, 1);

  // The admin approves in the merge module (preview -> execute) with the proposal's orders.
  const pv = (
    await ok('/api/order-merges/previews', 'POST', {
      client_key: randomUUID(),
      main_order_id: p.main_order_id,
      order_ids_to_merge: p.order_ids.filter((id: string) => id !== p.main_order_id),
      merge_mode: 'technical_merge',
      sum_delivery_costs: false,
    })
  ).preview;
  assert.equal(pv.ready, true);
  assert.equal(pv.receiver_conflict, false);
  const e = (await ok('/api/order-merges/execute', 'POST', { client_key: randomUUID(), preview_id: pv.id, scope_hash: pv.scope_hash, confirmed: true })).execution;
  assert.equal(await merged([a.id, b.id]), 2);
  // No loop: the merged order has no open pair left, and a merged source is refused.
  const target = await run(r, { id: e.target_order_id });
  assert.equal(target.state, 'done', target.error);
  assert.equal(target.effects[0].changed, false);
  assert.match(target.effects[0].message, /Brak innych otwartych zamówień/);
  const source = await run(r, a);
  assert.equal(source.effects[0]?.changed ?? false, false);
  assert.equal((await proposals(e.target_order_id)).length, 0);
});

test('merge_orders: a different address, e-mail spelling or payment is refused with the module reason', async () => {
  const email = mail();
  const a = await order(email);
  await order(email, { address: { ...ADDRESS, street: 'Inna 2' } });
  await order(email.toUpperCase());
  await order(email, { payment_mode: 'cod' });
  const s = await run(await rule(), a);
  assert.equal(s.state, 'done', s.error);
  assert.equal(s.effects[0].changed, false);
  assert.match(s.effects[0].message, /inny odbiorca lub adres/);
  assert.match(s.effects[0].message, /inny sposób płatności/);
  assert.equal((await proposals(a.id)).length, 0);
});

test('merge_orders: another customer, packed orders and another company are not pairs', async () => {
  const email = mail();
  const a = await order(email);
  await order(mail());
  const packed = await order(email);
  await act(packed, { type: 'set_status', status: 'paid' });
  await act(packed, { type: 'set_status', status: 'picking' });
  await ok(`/api/orders/${packed.id}/scan`, 'POST', { code: sku });
  await act(packed, { type: 'set_status', status: 'packed' });
  // The same buyer in another company.
  const wh2 = (await ok('/api/warehouses', 'GET', undefined, other)).data[0].id;
  const p2 = (await ok('/api/products', 'POST', { name: 'Obca', sku: 'V2J-' + randomUUID().slice(0, 8), price: 2500, warehouse_id: wh2, quantity: 10 }, other)).id;
  await order(email, {}, other, wh2, p2);
  const r = await rule();
  const s = await run(r, a);
  assert.equal(s.state, 'done', s.error);
  assert.equal(s.effects[0].changed, false);
  assert.match(s.effects[0].message, /Brak innych otwartych zamówień tego klienta/);
  assert.equal((await proposals(a.id)).length, 0);
  // A packed order itself is not open: nothing proposed.
  const own = await run(r, packed);
  assert.equal(own.effects[0].changed, false);
  assert.match(own.effects[0].message, /nie jest otwarte/);
});

test('merge_orders: chosen people must be admins of the company', async () => {
  const me = (await ok('/api/auth/me', 'GET', undefined, operator)).user.id;
  const bad = await req(V2 + '/rules', 'POST', {
    name: 'J zły', trigger: 'order.matches', enabled: true,
    config: { version: 2, group: 'Testy łączenia', scope: 'orders', run: { ...DEFAULT_RUN, manual_button: true, auto: false }, conditions: { match: 'all', items: [] }, effects: [{ type: 'merge_orders', params: { user_ids: [me] } }], stop_further: false },
  });
  assert.equal(bad.statusCode, 422, bad.body);
  assert.match(bad.body, /administrator/);
});
