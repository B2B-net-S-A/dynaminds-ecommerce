/** Automation rules v2, "Przypisz magazyn" (assign_warehouse): why the effect stays unsupported.
 * An order's reservations are keyed by (tenant, order, product) and pinned to the warehouse they were made in. The
 * app role cannot move them: the warehouse identity of a reservation row is sealed (146_warehouse_inventory_policies),
 * location rows are never deleted (no DELETE grant), a released reservation keeps its location rows, and a second
 * reservation of the same product in another warehouse breaks the primary key. Every createOrder reserves its
 * physical lines with location rows, so no order could change warehouse without dropping custody. These checks are a
 * tripwire: when one of them stops refusing, the effect can be built on that path. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed } from './fixtures';
import { DEFAULT_RUN } from '../shared/automation-v2';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, tenant: string, from: string, to: string, product: string, orderId: string;
let baseline: Record<string, number>;
const V2 = '/api/automations/v2';
const req = (url: string, method: any = 'GET', payload?: any) => app.inject({ url, method, payload, headers: { cookie: admin } });
const reservedByWarehouse = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    (await pool.query('SELECT warehouse_id,reserved FROM stock WHERE product_id=$1 AND warehouse_id=ANY($2::uuid[])', [product, [from, to]])).rows.map(
      (r) => [r.warehouse_id, r.reserved],
    ),
  );
async function ok(url: string, method: any = 'GET', payload?: any) {
  const r = await req(url, method, payload);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(login.statusCode, 200, login.body);
  admin = login.headers['set-cookie']!.toString().split(';')[0];
  const warehouses = (await ok('/api/warehouses')).data;
  assert.ok(warehouses.length >= 2, 'the demo tenant has two warehouses');
  [from, to] = [warehouses[0].id, warehouses[1].id];
  // A demo product on hand in both warehouses, so stock is not the reason for a refusal.
  product = (
    await pool.query(
      `SELECT a.product_id FROM stock a JOIN stock b USING(tenant_id,product_id) JOIN products p ON p.id=a.product_id
        WHERE a.warehouse_id=$1 AND b.warehouse_id=$2 AND a.on_hand-a.reserved>=2 AND b.on_hand-b.reserved>=2
          AND p.active AND p.kind IN ('simple','variant') ORDER BY p.sku LIMIT 1`,
      [from, to],
    )
  ).rows[0].product_id;
  baseline = await reservedByWarehouse();
  const o = await ok('/api/orders', 'POST', {
    customer_name: 'QA magazyn',
    email: 'magazyn@example.test',
    warehouse_id: from,
    items: [{ product_id: product, quantity: 2 }],
    address: { country: 'PL', city: 'Warszawa', phone: '500600700' },
  });
  orderId = o.id;
  tenant = (await pool.query('SELECT tenant_id FROM orders WHERE id=$1', [orderId])).rows[0].tenant_id;
});
after(async () => {
  await app.close();
  await pool.end();
});

/** Runs the statements as the app role in the order's tenant and returns the error; always rolls back. */
async function asApp(...statements: Array<[string, unknown[]]>): Promise<{ code?: string; message: string }> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await c.query('SET LOCAL ROLE dyna_app');
    for (const [sql, params] of statements) await c.query(sql, params);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    return { message: 'no error' };
  } catch (e: any) {
    return { code: e.code, message: e.message };
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
/** The order's reservation released as releaseOrderStockInTx does (stock.reserved back, state released). */
const released = (): Array<[string, unknown[]]> => [
  ['UPDATE stock SET reserved=reserved-2 WHERE product_id=$1 AND warehouse_id=$2', [product, from]],
  ["UPDATE reservations SET state='released' WHERE order_id=$1", [orderId]],
];

test('the order holds its custody in the source warehouse: reservation with location rows', async () => {
  const r = (await pool.query('SELECT warehouse_id,state,quantity FROM reservations WHERE order_id=$1', [orderId])).rows;
  assert.deepEqual(r, [{ warehouse_id: from, state: 'active', quantity: 2 }]);
  const l = (await pool.query('SELECT warehouse_id,sum(quantity)::int q FROM reservation_locations WHERE order_id=$1 GROUP BY 1', [orderId])).rows;
  assert.deepEqual(l, [{ warehouse_id: from, q: 2 }]);
});

test('the app role cannot move a reservation to another warehouse', async () => {
  const moved = await asApp(['UPDATE reservations SET warehouse_id=$2 WHERE order_id=$1', [orderId, to]]);
  assert.equal(moved.code, '23514');
  assert.equal(moved.message, 'Tożsamość fizycznego stanu magazynu jest stała');
  const bins = await asApp(['UPDATE reservation_locations SET warehouse_id=$2 WHERE order_id=$1', [orderId, to]]);
  assert.equal(bins.code, '23514');
});

test('the app role cannot drop the old custody rows to make room for new ones', async () => {
  const bins = await asApp(['DELETE FROM reservation_locations WHERE order_id=$1', [orderId]]);
  assert.equal(bins.code, '42501', bins.message);
  const reservation = await asApp(...released(), ['DELETE FROM reservations WHERE order_id=$1', [orderId]]);
  assert.equal(reservation.code, '23503', reservation.message);
  assert.match(reservation.message, /reservation_locations/);
  const second = await asApp(...released(), [
    'INSERT INTO reservations(tenant_id,order_id,product_id,warehouse_id,quantity) VALUES($1,$2,$3,$4,2)',
    [tenant, orderId, product, to],
  ]);
  assert.equal(second.code, '23505', second.message);
  assert.match(second.message, /reservations_pkey/);
});

test('nothing above changed the stock or the reservation', async () => {
  assert.deepEqual(await reservedByWarehouse(), { [from]: baseline[from] + 2, [to]: baseline[to] });
  assert.equal((await pool.query("SELECT state FROM reservations WHERE order_id=$1", [orderId])).rows[0].state, 'active');
  assert.equal((await pool.query('SELECT warehouse_id FROM orders WHERE id=$1', [orderId])).rows[0].warehouse_id, from);
});

test('catalog: assign_warehouse is unsupported with the real reason; a rule with it is refused', async () => {
  const c = await ok(V2 + '/catalog');
  const e = c.effects.find((x: any) => x.type === 'assign_warehouse');
  assert.equal(e.supported, false);
  assert.match(e.hint, /przypięte do magazynu/);
  const r = await req(V2 + '/rules', 'POST', {
    name: 'Magazyn ' + randomUUID().slice(0, 8),
    trigger: 'order.matches',
    enabled: true,
    config: {
      version: 2,
      group: 'Testy',
      scope: 'orders',
      run: { ...DEFAULT_RUN, auto: false, manual_button: true },
      conditions: { match: 'all', items: [] },
      effects: [{ type: 'assign_warehouse', params: { warehouse_id: to } }],
      stop_further: false,
    },
  });
  assert.equal(r.statusCode, 422, r.body);
  assert.match(r.body, /Efekt niedostępny: Rezerwacje zamówienia są trwale przypięte do magazynu/);
});
