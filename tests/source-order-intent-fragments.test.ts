import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { createOrder, orderSchema, type Actor } from '../server/domain';
import { seed, DEMO_TENANT } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
type Row = Record<string, any>;
type Fragment = { id: string; product_id: string; quantity: number; line_total: number };
type IntentLine = {
  customer_item_id: string;
  product_id: string;
  quantity: number;
  local_quantity: number;
};
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let cookie = '', warehouse = '';
let actor: Actor;
const request = (url: string, method: any = 'GET', payload?: any) =>
  app!.inject({ url: '/api' + url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: unknown): Promise<Row> {
  const response = await request(url, method, payload);
  assert(response.statusCode < 300, `${url}: ${response.statusCode} ${response.body}`);
  return response.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => { throw Error('Commercial domain fixture must not call a provider'); },
  });
  const response = await request('/auth/login', 'POST', {
    email: 'admin@demo.local', password: 'DynaDemo!2026',
  });
  assert.equal(response.statusCode, 200);
  cookie = String(response.headers['set-cookie']).split(';')[0];
  warehouse = (await ok('/warehouses')).data[0].id;
  actor = {
    tenantId: DEMO_TENANT,
    userId: (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id,
    role: 'admin', source: 'manual',
  };
});
after(async () => {
  try { await app?.close(); } finally { await pool.end(); }
});
async function product(quantity = 0): Promise<Row> {
  return ok('/products', 'POST', {
    sku: 'OWN127B-' + randomUUID(), name: 'Current PIM price must not replace source amounts',
    price: 29999, vat: 23, quantity, warehouse_id: warehouse,
  });
}
async function effects() {
  const names = [
    'orders', 'order_items', 'order_pick_items', 'reservations', 'reservation_locations',
    'stock', 'stock_locations', 'stock_movements', 'wms_reservation_layers', 'wms_layer_positions',
    'payment_entries', 'order_events', 'audit_events', 'jobs',
    'b2b_external_order_intents', 'b2b_external_order_intent_revisions',
    'b2b_external_order_allocation_proofs', 'b2b_external_order_created_orders',
  ];
  const result: Record<string, string> = {};
  for (const name of names) {
    const rows = (await pool.query(
      `SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [DEMO_TENANT],
    )).rows;
    result[name] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return result;
}
function input(fragments: Fragment[]) {
  return orderSchema.parse({
    customer_name: 'Own source fragment fixture', email: 'own127b@example.test',
    warehouse_id: warehouse, source: 'shopify', currency: 'PLN', payment_mode: 'prepaid',
    shipping_cost: 500, address: { street: 'Own 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
    items: fragments.map(({ product_id, quantity }) => ({ product_id, quantity })),
  });
}
function totals(fragments: Fragment[]) {
  const result = new Map<string, number>();
  for (const fragment of fragments)
    result.set(fragment.product_id, (result.get(fragment.product_id) ?? 0) + fragment.line_total);
  return result;
}
const lines = (fragments: Fragment[]): IntentLine[] => fragments.map((f) => ({
  customer_item_id: f.id, product_id: f.product_id, quantity: f.quantity, local_quantity: 0,
}));
async function rejected(fragments: Fragment[], intentLines: IntentLine[]) {
  const before = await effects();
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) => createOrder(c, actor, input(fragments), totals(fragments), {
      importFragments: fragments,
      externalImportIntentLines: { admission_id: randomUUID(), lines: intentLines },
    })),
    (error: any) => error.status === 422,
    'Per-commercial-line validation must reject before consulting the absent prepared admission',
  );
  assert.deepEqual(await effects(), before);
}

test('ordinary source fragments retain distinct UUIDs, historical 10/17 prices and exact non-divisible total, independent of current PIM price', async () => {
  const p = await product(10);
  const fragments: Fragment[] = [
    { id: randomUUID(), product_id: p.id, quantity: 2, line_total: 2000 },
    { id: randomUUID(), product_id: p.id, quantity: 1, line_total: 1700 },
    { id: randomUUID(), product_id: p.id, quantity: 2, line_total: 1001 },
  ];
  const before = await effects(), rollback = new Error('Own domain projection deliberately rolled back');
  await assert.rejects(tenantTx(DEMO_TENANT, async (c: PoolClient) => {
    // This exercises the real commercial constructor, not a committed import/certificate.
    const order = await createOrder(c, actor, input(fragments), totals(fragments), { importFragments: fragments });
    assert.equal(order.total, 5201);
    assert.equal(order.items.length, 3);
    for (const f of fragments) {
      const item = order.items.find((i: Row) => i.id === f.id)!;
      assert(item);
      assert.equal(item.product_id, p.id);
      assert.equal(item.quantity, f.quantity);
      assert.equal(item.line_total, f.line_total);
      assert.equal(item.price, Math.floor(f.line_total / f.quantity));
      assert.equal(item.vat, 23);
    }
    assert.deepEqual((await c.query('SELECT quantity,scanned FROM order_pick_items WHERE order_id=$1', [order.id])).rows,
      [{ quantity: 5, scanned: 0 }]);
    assert.deepEqual((await c.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [p.id, warehouse])).rows,
      [{ on_hand: 10, reserved: 5 }]);
    throw rollback;
  }), (error) => error === rollback);
  assert.deepEqual(await effects(), before);
});

test('external import intent rejects missing/duplicated commercial UUIDs and quantity swaps even when same-product aggregate quantities match', async () => {
  const p = await product();
  const fragments: Fragment[] = [
    { id: randomUUID(), product_id: p.id, quantity: 2, line_total: 2000 },
    { id: randomUUID(), product_id: p.id, quantity: 1, line_total: 1700 },
  ];
  const original = lines(fragments);
  await rejected(fragments, [{ ...original[0], customer_item_id: randomUUID() }, original[1]]);
  await rejected(fragments, [original[0], { ...original[1], customer_item_id: original[0].customer_item_id }]);
  await rejected(fragments, [{ ...original[0], quantity: 1 }, { ...original[1], quantity: 2 }]);
  await rejected(fragments, [{ ...original[0], local_quantity: 3 }, original[1]]);
});

test('external import intent rejects product swaps between genuine fragment UUIDs despite identical per-product aggregate quantities', async () => {
  const a = await product(), b = await product();
  const fragments: Fragment[] = [
    { id: randomUUID(), product_id: a.id, quantity: 1, line_total: 1000 },
    { id: randomUUID(), product_id: b.id, quantity: 1, line_total: 1700 },
  ];
  const original = lines(fragments);
  await rejected(fragments, [{ ...original[0], product_id: b.id }, { ...original[1], product_id: a.id }]);
});
