/** "Zmień magazyn" on the order card and the rule effect "Przypisz magazyn" (assign_warehouse), migration 269.
 * Both go through transferOrderWarehouseInTx and the owner function order_warehouse269_transfer: in one transaction
 * the old warehouse gets its reserved stock and location rows back, orders.warehouse_id changes and the new warehouse
 * reserves the same quantities with location rows, as createOrder does. Every refusal is in Polish and leaves the
 * stock, the reservations and the order exactly as they were. The app role still cannot move a reservation row by
 * itself (146 seals its warehouse) nor read the transfer log. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { DEFAULT_RUN } from '../shared/automation-v2';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, viewer: string, tenant: string, from: string, to: string, foreign: string, product: string, onlyFrom: string;
const V2 = '/api/automations/v2';
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) => app.inject({ url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
const login = async (email: string) => {
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie']!.toString().split(';')[0];
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  admin = await login('admin@demo.local');
  viewer = await login('viewer@demo.local');
  const warehouses = (await ok('/api/warehouses')).data;
  assert.ok(warehouses.length >= 2, 'the demo tenant has two warehouses');
  [from, to] = [warehouses[0].id, warehouses[1].id];
  tenant = (await pool.query('SELECT tenant_id FROM warehouses WHERE id=$1', [from])).rows[0].tenant_id;
  foreign = (await pool.query('SELECT id FROM warehouses WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])).rows[0].id;
  // A demo product on hand (and in locations) in both warehouses, so stock is not the reason for a refusal.
  product = (
    await pool.query(
      `SELECT a.product_id FROM stock a JOIN stock b USING(tenant_id,product_id) JOIN products p ON p.id=a.product_id
        WHERE a.warehouse_id=$1 AND b.warehouse_id=$2 AND a.on_hand-a.reserved>=10 AND b.on_hand-b.reserved>=10
          AND p.active AND p.kind IN ('simple','variant') ORDER BY p.sku LIMIT 1`,
      [from, to],
    )
  ).rows[0].product_id;
  // A product stocked only in the source warehouse.
  onlyFrom = (await ok('/api/products', 'POST', { name: 'Tylko w jednym magazynie', sku: 'WH269-' + randomUUID(), price: 1500, warehouse_id: from, quantity: 50 })).id;
});
after(async () => {
  await app.close();
  await pool.end();
});

async function order(items: Array<{ product_id: string; quantity: number }> = [{ product_id: product, quantity: 2 }], extra: Record<string, unknown> = {}) {
  return ok('/api/orders', 'POST', {
    customer_name: 'QA magazyn',
    email: 'magazyn@example.test',
    warehouse_id: from,
    items,
    address: { country: 'PL', city: 'Warszawa', phone: '500600700' },
    ...extra,
  });
}
/** Stock, reservations, location rows and the order's warehouse: everything a move touches. */
async function custody(orderId: string) {
  const q = async (sql: string, p: unknown[]) => (await pool.query(sql, p)).rows;
  return {
    stock: await q('SELECT warehouse_id,product_id,on_hand,reserved FROM stock WHERE warehouse_id=ANY($1::uuid[]) AND product_id=ANY($2::uuid[]) ORDER BY 1,2', [[from, to], [product, onlyFrom]]),
    reservations: await q('SELECT product_id,warehouse_id,quantity,state FROM reservations WHERE order_id=$1 ORDER BY 1', [orderId]),
    locations: await q('SELECT product_id,warehouse_id,location,quantity FROM reservation_locations WHERE order_id=$1 ORDER BY 1,3', [orderId]),
    order: (await q('SELECT warehouse_id,status FROM orders WHERE id=$1', [orderId]))[0],
  };
}
const reservedIn = async (warehouse: string, productId = product) =>
  (await pool.query('SELECT reserved FROM stock WHERE warehouse_id=$1 AND product_id=$2', [warehouse, productId])).rows[0]?.reserved ?? 0;
const move = (orderId: string, warehouseId: string, cookie = admin) => req(`/api/orders/${orderId}/warehouse`, 'POST', { warehouse_id: warehouseId }, cookie);

/** Runs the statements as the app role in the demo tenant and returns the first error; always rolls back. */
async function asApp(...statements: Array<[string, unknown[]]>): Promise<{ code?: string; message: string; rows?: any[] }> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await c.query('SET LOCAL ROLE dyna_app');
    let rows: any[] = [];
    for (const [sql, params] of statements) rows = (await c.query(sql, params)).rows;
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    return { message: 'no error', rows };
  } catch (e: any) {
    return { code: e.code, message: e.message };
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const adminId = async () => (await pool.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='admin' ORDER BY user_id LIMIT 1", [tenant])).rows[0].user_id;

test('Zmień magazyn: reservations, location rows and reserved stock move to the new warehouse in one step', async () => {
  const o = await order();
  const before = { from: await reservedIn(from), to: await reservedIn(to) };
  const held = await custody(o.id);
  assert.deepEqual(held.reservations, [{ product_id: product, warehouse_id: from, quantity: 2, state: 'active' }]);
  const r = await move(o.id, to);
  assert.equal(r.statusCode, 200, r.body);
  const moved = r.json();
  assert.equal(moved.from_warehouse_id, from);
  assert.equal(moved.to_warehouse_id, to);
  assert.deepEqual(moved.lines.map((l: any) => [l.product_id, l.quantity]), [[product, 2]]);
  const after = await custody(o.id);
  assert.equal(after.order.warehouse_id, to);
  assert.deepEqual(after.reservations, [{ product_id: product, warehouse_id: to, quantity: 2, state: 'active' }]);
  assert.ok(after.locations.length > 0 && after.locations.every((l: any) => l.warehouse_id === to));
  assert.equal(after.locations.reduce((s: number, l: any) => s + l.quantity, 0), 2);
  assert.deepEqual(moved.lines[0].from_locations, held.locations.map((l: any) => ({ location: l.location, quantity: l.quantity })));
  assert.equal(await reservedIn(from), before.from - 2, 'the old warehouse gets its reserved stock back');
  assert.equal(await reservedIn(to), before.to + 2, 'the new warehouse reserves the same quantity');
  // One log row (owner-private) and one entry in the order history.
  const log = (await pool.query('SELECT from_warehouse_id,to_warehouse_id,source,jsonb_array_length(lines) n FROM order_warehouse269_transfers WHERE order_id=$1', [o.id])).rows;
  assert.deepEqual(log, [{ from_warehouse_id: from, to_warehouse_id: to, source: 'manual', n: 1 }]);
  const card = await ok('/api/orders/' + o.id);
  const e = card.events.find((x: any) => x.kind === 'order.warehouse_changed');
  assert.ok(e, 'history entry');
  assert.equal(e.detail.from, from);
  assert.equal(e.detail.to, to);
  assert.equal(card.warehouse_id, to);
  // The moved order moves back the same way.
  assert.equal((await move(o.id, from)).statusCode, 200);
  assert.equal((await custody(o.id)).order.warehouse_id, from);
  assert.equal(await reservedIn(to), before.to);
});

test('refusals in Polish leave stock, reservations and the order as they were', async () => {
  const o = await order();
  const held = await custody(o.id);
  const refused = async (warehouseId: string, status: number, message: RegExp, cookie = admin) => {
    const r = await move(o.id, warehouseId, cookie);
    assert.equal(r.statusCode, status, r.body);
    assert.match(r.json().message ?? r.json().detail ?? r.body, message);
    assert.deepEqual(await custody(o.id), held);
  };
  await refused(from, 409, /Zamówienie jest już przypisane do magazynu/);
  await refused(foreign, 404, /Magazyn nie należy do tej firmy/);
  await refused(randomUUID(), 404, /Magazyn nie należy do tej firmy/);
  await refused(to, 403, /tylko do odczytu/, viewer);
  const bad = await req(`/api/orders/${o.id}/warehouse`, 'POST', { warehouse_id: 'x' });
  assert.equal(bad.statusCode, 422);
});

test('not enough stock in the new warehouse: the whole move is refused, no line moves', async () => {
  const o = await order([
    { product_id: product, quantity: 1 },
    { product_id: onlyFrom, quantity: 2 },
  ]);
  const held = await custody(o.id);
  const r = await move(o.id, to);
  assert.equal(r.statusCode, 409, r.body);
  assert.match(r.body, /Za mało towaru w magazynie „[^”]+”: WH269-[^ ]+ \(dostępne 0, potrzebne 2\)/);
  assert.deepEqual(await custody(o.id), held, 'the line with stock did not move either');
});

test('an order in picking or with a document keeps its warehouse', async () => {
  const picking = await order(undefined, { payment_mode: 'cod' });
  const p = await ok('/api/orders/' + picking.id);
  await ok(`/api/orders/${picking.id}/status`, 'PATCH', { status: 'picking', expected_version: String(p.version) });
  const r = await move(picking.id, to);
  assert.equal(r.statusCode, 409, r.body);
  assert.match(r.body, /Magazyn można zmienić tylko przed rozpoczęciem kompletacji/);
  assert.equal((await custody(picking.id)).order.warehouse_id, from);

  const documented = await order(undefined, { payment_mode: 'cod' });
  await ok(`/api/orders/${documented.id}/documents`, 'POST', { kind: 'invoice' });
  const d = await move(documented.id, to);
  assert.equal(d.statusCode, 409, d.body);
  assert.match(d.body, /Nie można zmienić magazynu, bo zamówienie ma .*wystawione dokumenty/);
  assert.equal((await custody(documented.id)).order.warehouse_id, from);
});

test('the owner function checks on its own: tenant, member, status and stock, all or nothing', async () => {
  const o = await order();
  const actor = await adminId();
  const call = (warehouseId: string, who: string = actor, source = 'manual') =>
    asApp(['SELECT order_warehouse269_transfer($1,$2,$3,$4) moved', [o.id, warehouseId, who, source]]);
  assert.equal((await call(foreign)).message, 'Magazyn nie należy do tej firmy');
  assert.equal((await call(from)).message.startsWith('Zamówienie jest już przypisane do magazynu'), true);
  const stranger = await call(to, randomUUID());
  assert.equal(stranger.code, '42501');
  assert.equal(stranger.message, 'Brak uprawnień do zmiany magazynu zamówienia');
  assert.equal((await call(to, actor, 'anything')).code, '22023');
  const fine = await call(to);
  assert.equal(fine.message, 'no error', 'the deferred checks pass at once (SET CONSTRAINTS ALL IMMEDIATE)');
  assert.equal(fine.rows![0].moved.to_warehouse_id, to);
  // Picking is refused by the function too, without the HTTP admission.
  const picked = await asApp(
    ["UPDATE orders SET status='paid' WHERE id=$1", [o.id]],
    ["UPDATE orders SET status='picking' WHERE id=$1", [o.id]],
    ['SELECT order_warehouse269_transfer($1,$2,$3,$4)', [o.id, to, actor, 'manual']],
  );
  assert.equal(picked.message, 'Magazyn można zmienić tylko przed rozpoczęciem kompletacji');
  assert.equal((await custody(o.id)).order.warehouse_id, from, 'every call above rolled back');
});

test('the app role alone still cannot move a reservation row, delete location rows or read the transfer log', async () => {
  const o = await order();
  const moved = await asApp(['UPDATE reservations SET warehouse_id=$2 WHERE order_id=$1', [o.id, to]]);
  assert.equal(moved.code, '23514');
  assert.equal(moved.message, 'Tożsamość fizycznego stanu magazynu jest stała');
  assert.equal((await asApp(['DELETE FROM reservation_locations WHERE order_id=$1', [o.id]])).code, '42501');
  assert.equal((await asApp(['SELECT * FROM order_warehouse269_transfers', []])).code, '42501');
  assert.equal((await asApp(['INSERT INTO order_warehouse269_transfers(tenant_id,order_id,from_warehouse_id,to_warehouse_id,actor_id,source,lines) VALUES($1,$2,$3,$4,$5,$6,$7)', [tenant, o.id, from, to, randomUUID(), 'manual', '[]']])).code, '42501');
});

test('rule effect Przypisz magazyn: supported with the warehouses to pick; runs the same move; rerun is unchanged', async () => {
  const c = await ok(V2 + '/catalog');
  const e = c.effects.find((x: any) => x.type === 'assign_warehouse');
  assert.equal(e.supported, undefined);
  assert.equal(e.params[0].key, 'warehouse_id');
  assert.deepEqual(e.params[0].options.map((x: any) => x.value).sort(), [from, to].sort());
  const body = (warehouseId: string) => ({
    name: 'Magazyn ' + randomUUID().slice(0, 8),
    trigger: 'order.matches',
    enabled: true,
    config: {
      version: 2,
      group: 'Testy',
      scope: 'orders',
      run: { ...DEFAULT_RUN, auto: false, manual_button: true },
      conditions: { match: 'all', items: [] },
      effects: [{ type: 'assign_warehouse', params: { warehouse_id: warehouseId } }],
      stop_further: false,
    },
  });
  const foreignRule = await req(V2 + '/rules', 'POST', body(foreign));
  assert.equal(foreignRule.statusCode, 422, foreignRule.body);
  assert.match(foreignRule.body, /Magazyn nie należy do tej firmy/);
  const rule = await ok(V2 + '/rules', 'POST', body(to));
  const o = await order();
  const run = async () => {
    const [x] = (await ok(V2 + '/rules/' + rule.id + '/run', 'POST', { order_ids: [o.id] })).runs;
    const row = (await pool.query('SELECT result FROM automation_runs WHERE id=$1', [x.id])).rows[0];
    return { ...x, effects: row?.result?.effects ?? [] };
  };
  const first = await run();
  assert.equal(first.status, 'done', JSON.stringify(first));
  assert.equal(first.effects[0].changed, true);
  assert.match(first.effects[0].message, /^Przeniesiono do magazynu /);
  const now = await custody(o.id);
  assert.equal(now.order.warehouse_id, to);
  assert.deepEqual(now.reservations, [{ product_id: product, warehouse_id: to, quantity: 2, state: 'active' }]);
  assert.equal((await pool.query('SELECT source FROM order_warehouse269_transfers WHERE order_id=$1', [o.id])).rows[0].source, 'automation');
  const again = await run();
  assert.equal(again.status, 'done');
  assert.equal(again.effects[0].changed, false);
  assert.match(again.effects[0].message, /^Magazyn bez zmian: /);
  await pool.query('UPDATE automation_rules SET enabled=false,version=version+1 WHERE id=$1', [rule.id]);
});
