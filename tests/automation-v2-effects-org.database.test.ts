/** Automation rules v2, lane M effects (server/automation-v2-effects-org.ts): owner and priority as order fields,
 * manual stock reservation and release through the order-edit custody path. */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed } from './fixtures';
import { DEFAULT_RUN } from '../shared/automation-v2';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, operator: string, warehouse: string, product: string;
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
    return r.headers['set-cookie']!.toString().split(';')[0];
  };
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await ok('/api/warehouses')).data[0].id;
  product = (await ok('/api/products', 'POST', { name: 'Reguły org', sku: 'ORG-' + randomUUID(), price: 2500, warehouse_id: warehouse, quantity: 1000 })).id;
});
beforeEach(async () => {
  await pool.query('UPDATE automation_rules SET enabled=false,version=version+1 WHERE enabled');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE state IN ('pending','running')");
});
after(async () => {
  await app.close();
  await pool.end();
});

async function order(productId = product, quantity = 1) {
  return ok('/api/orders', 'POST', {
    customer_name: 'QA org',
    email: 'org@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: productId, quantity }],
    address: { country: 'PL', city: 'Warszawa', phone: '500600700' },
  });
}
const get = (o: any) => ok('/api/orders/' + o.id);
const act = (o: any, a: any, c = admin) => req('/api/orders/' + o.id + '/operations', 'POST', a, c);
const body = (effects: any[]) => ({
  name: 'Org ' + randomUUID().slice(0, 8),
  trigger: 'order.matches',
  enabled: true,
  config: { version: 2, group: 'Testy', scope: 'orders', run: { ...DEFAULT_RUN, auto: false, manual_button: true }, conditions: { match: 'all', items: [] }, effects, stop_further: false },
});
const rule = (effects: any[]) => ok(V2 + '/rules', 'POST', body(effects));
async function run(r: any, o: any, cookie = admin) {
  const [x] = (await ok(V2 + '/rules/' + r.id + '/run', 'POST', { order_ids: [o.id] }, cookie)).runs;
  const row = (await pool.query('SELECT result FROM automation_runs WHERE id=$1', [x.id])).rows[0];
  return { ...x, effects: row?.result?.effects ?? [] };
}
const fieldOf = async (o: any, key: string) => (await ok('/api/orders/' + o.id + '/fields')).data.find((f: any) => f.definition.key === key);
const stock = async (productId: string) =>
  (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [productId, warehouse])).rows[0];
const reservation = async (o: any, productId: string) =>
  (await pool.query('SELECT state,quantity FROM reservations WHERE order_id=$1 AND product_id=$2', [o.id, productId])).rows[0];

test('catalog: the lane effects are supported with tenant people and priorities', async () => {
  const c = await ok(V2 + '/catalog');
  const by = (t: string) => c.effects.find((e: any) => e.type === t);
  for (const t of ['assign_user', 'set_priority', 'reserve_stock', 'release_stock']) assert.equal(by(t).supported, undefined, t);
  assert.ok(by('assign_user').params[0].options.length > 0);
  assert.deepEqual(by('set_priority').params[0].options.map((o: any) => o.value), ['high', 'normal', 'low']);
  // 269: the order and its reservations move through the owner function (tests/automation-v2-assign-warehouse.database.test.ts).
  assert.equal(by('assign_warehouse').supported, undefined);
  assert.equal(by('assign_warehouse').params[0].key, 'warehouse_id');
});

test('assign_user: owner order field created on first use, shown on the card; rerun is unchanged; foreign person refused', async () => {
  const people = (await ok(V2 + '/catalog')).effects.find((e: any) => e.type === 'assign_user').params[0].options;
  const [first, second] = people;
  const r = await rule([{ type: 'assign_user', params: { user_id: first.value } }]);
  const o = await order();
  // An operator runs it: the rule's admin author provisions the field definition when it is missing.
  const x = await run(r, o, operator);
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.match(x.effects[0].message, /Przypisano opiekuna|Opiekun bez zmian/);
  const f = await fieldOf(o, 'opiekun_zamowienia');
  assert.equal(f.definition.label, 'Opiekun');
  assert.equal(f.definition.type, 'select');
  assert.equal(f.value.value, first.value);
  assert.equal(f.value.options_snapshot[0].label, first.label);
  assert.ok(!(await get(o)).tags.some((t: string) => t.startsWith('Opiekun ')));
  const again = await run(r, o);
  assert.equal(again.status, 'done');
  assert.equal(again.effects[0].changed, false);
  assert.match(again.effects[0].message, /bez zmian/);
  if (second) {
    const r2 = await rule([{ type: 'assign_user', params: { user_id: second.value } }]);
    const y = await run(r2, o);
    assert.equal(y.status, 'done', JSON.stringify(y));
    assert.equal((await fieldOf(o, 'opiekun_zamowienia')).value.value, second.value);
  }
  const bad = await req(V2 + '/rules', 'POST', body([{ type: 'assign_user', params: { user_id: randomUUID() } }]));
  assert.equal(bad.statusCode, 422);
  assert.match(bad.json().message ?? bad.body, /nie należy do zespołu/);
  const extra = await req(V2 + '/rules', 'POST', body([{ type: 'assign_user', params: { user_id: first.value, name: 'x' } }]));
  assert.equal(extra.statusCode, 422);
});

test('set_priority: priority order field high/normal/low, no legacy tag; rerun unchanged; bad value refused', async () => {
  const high = await rule([{ type: 'set_priority', params: { priority: 'high' } }]);
  const normal = await rule([{ type: 'set_priority', params: { priority: 'normal' } }]);
  const o = await order();
  const x = await run(high, o);
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.equal(x.effects[0].message, 'Ustawiono priorytet: wysoki');
  const f = await fieldOf(o, 'priorytet_zamowienia');
  assert.equal(f.definition.label, 'Priorytet');
  assert.deepEqual(f.definition.options.filter((p: any) => p.enabled).map((p: any) => p.label).sort(), ['Niski', 'Normalny', 'Wysoki']);
  assert.equal(f.value.options_snapshot[0].label, 'Wysoki');
  assert.ok(!(await get(o)).tags.includes('Priorytet wysoki'));
  const same = await run(high, o);
  assert.equal(same.effects[0].changed, false);
  assert.equal(same.effects[0].message, 'Priorytet bez zmian: wysoki');
  assert.equal((await run(normal, o)).status, 'done');
  assert.equal((await fieldOf(o, 'priorytet_zamowienia')).value.options_snapshot[0].label, 'Normalny');
  const bad = await req(V2 + '/rules', 'POST', body([{ type: 'set_priority', params: { priority: 'urgent' } }]));
  assert.equal(bad.statusCode, 422);
});

test('owner and priority: a field disabled by the admin refuses the run in Polish and rolls back', async () => {
  const people = (await ok(V2 + '/catalog')).effects.find((e: any) => e.type === 'assign_user').params[0].options;
  const both = await rule([{ type: 'set_priority', params: { priority: 'low' } }, { type: 'assign_user', params: { user_id: people[0].value } }]);
  const o = await order();
  const defs = (await ok('/api/order-fields')).data;
  const owner = defs.find((d: any) => d.key === 'opiekun_zamowienia');
  assert.ok(owner, 'pole opiekuna istnieje po poprzednim teście');
  await ok('/api/order-fields/' + owner.id, 'DELETE', { version: owner.version });
  try {
    const x = await run(both, o);
    assert.equal(x.status, 'failed');
    assert.match(x.error, /Opiekun.*wyłączone/);
    // The earlier priority effect of the same rule is rolled back with it.
    assert.equal((await fieldOf(o, 'priorytet_zamowienia')).value, null);
  } finally {
    const d = (await ok('/api/order-fields')).data.find((x: any) => x.key === 'opiekun_zamowienia');
    const { label, display, position, read_role, write_role, required_on, config, version } = d;
    await ok('/api/order-fields/' + d.id, 'PATCH', {
      version, label, display, position, read_role, write_role, required_on, config, enabled: true,
      options: d.options.map(({ id, label, enabled }: any) => ({ id, label, enabled })),
    });
  }
  assert.equal((await run(both, o)).status, 'done');
});

test('owner and priority in a run_rule chain: the nested rule writes its field under its own request key', async () => {
  const people = (await ok(V2 + '/catalog')).effects.find((e: any) => e.type === 'assign_user').params[0].options;
  const inner = await rule([{ type: 'set_priority', params: { priority: 'high' } }]);
  const outer = await rule([{ type: 'assign_user', params: { user_id: people[0].value } }, { type: 'run_rule', params: { rule_id: inner.id } }]);
  const o = await order();
  const x = await run(outer, o);
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.equal((await fieldOf(o, 'opiekun_zamowienia')).value.value, people[0].value);
  assert.equal((await fieldOf(o, 'priorytet_zamowienia')).value.options_snapshot[0].label, 'Wysoki');
});

test('release_stock / reserve_stock: custody follows, repeats are unchanged, picking needs a reservation', async () => {
  const p = (await ok('/api/products', 'POST', { name: 'Rezerwacja org', sku: 'ORG-R-' + randomUUID(), price: 1000, warehouse_id: warehouse, quantity: 2 })).id;
  const release = await rule([{ type: 'release_stock', params: {} }]);
  const reserve = await rule([{ type: 'reserve_stock', params: {} }]);
  const extra = await req(V2 + '/rules', 'POST', body([{ type: 'reserve_stock', params: { warehouse_id: warehouse } }]));
  assert.equal(extra.statusCode, 422);
  const o = await order(p, 2);
  assert.equal((await stock(p)).reserved, 2);
  // Already reserved: no second reservation.
  const noop = await run(reserve, o);
  assert.equal(noop.status, 'done', JSON.stringify(noop));
  assert.equal(noop.effects[0].changed, false);
  assert.match(noop.effects[0].message, /bez zmian/);
  assert.equal((await stock(p)).reserved, 2);

  const rel = await run(release, o);
  assert.equal(rel.status, 'done', JSON.stringify(rel));
  assert.equal(rel.effects[0].message, 'Zwolniono rezerwację stanu zamówienia');
  assert.equal((await stock(p)).reserved, 0);
  assert.equal((await reservation(o, p)).state, 'released');
  const rel2 = await run(release, o);
  assert.equal(rel2.effects[0].changed, false);
  assert.equal((await stock(p)).reserved, 0);

  // Paid (ready to fulfil) without a reservation: picking is refused until the stock is reserved again.
  const paid = await act(o, { type: 'set_status', status: 'paid' });
  assert.ok(paid.statusCode < 300, paid.body);
  const picking = await act(o, { type: 'set_status', status: 'picking' });
  assert.equal(picking.statusCode, 409);
  assert.match(picking.json().message ?? picking.body, /zwolnioną rezerwację/);

  // Another order takes the freed units: reserving again is refused in Polish and changes nothing.
  const rival = await order(p, 2);
  const short = await run(reserve, o);
  assert.equal(short.status, 'failed');
  assert.match(short.error, /Za mało towaru/);
  assert.equal((await reservation(o, p)).state, 'released');
  assert.equal((await stock(p)).reserved, 2);

  const cancelled = await act(rival, { type: 'set_status', status: 'cancelled' });
  assert.ok(cancelled.statusCode < 300, cancelled.body);
  assert.equal((await get(rival)).status, 'cancelled');
  const res = await run(reserve, o);
  assert.equal(res.status, 'done', JSON.stringify(res));
  assert.equal(res.effects[0].message, 'Zarezerwowano stan dla pozycji zamówienia');
  assert.deepEqual(await reservation(o, p), { state: 'active', quantity: 2 });
  assert.equal((await stock(p)).reserved, 2);
  const loc = (await pool.query("SELECT sum(l.quantity)::int q FROM reservation_locations l WHERE l.order_id=$1 AND l.product_id=$2", [o.id, p])).rows[0].q;
  assert.equal(loc, 2);
  assert.ok((await act(o, { type: 'set_status', status: 'picking' })).statusCode < 300);

  // Once picking started neither effect may touch the reservation.
  for (const r of [release, reserve]) {
    const x = await run(r, o);
    assert.equal(x.status, 'failed');
    assert.match(x.error, /przed rozpoczęciem kompletacji/);
  }
  assert.equal((await reservation(o, p)).state, 'active');
});
