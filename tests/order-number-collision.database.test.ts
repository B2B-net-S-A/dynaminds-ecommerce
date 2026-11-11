/** A taken order number never reaches the user (docs/scale/LOAD-TEST-FULL-20261029.md §4.4: one 409
 * „Rekord już istnieje”, orders_tenant_id_number_key, at ~10k orders/day/company). createOrder draws a new
 * DE-<date>-<8 hex> number inside the same transaction. Runs on a fresh PG04 clone
 * dynaminds_fix29b_20261029_NN of the restored template migrated to HEAD; it writes products and orders. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, tenantTx } from '../server/db';
import { createProduct } from '../server/catalog';
import { createOrder, orderSchema, productSchema, type Actor } from '../server/domain';
import { injectOrderNumberSuffixForTest } from '../server/order-number';
import { relaxPoolTimeouts } from './failure-helpers';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_(?:fix29b|int29b)_20261029_[0-9]{2}$/, 'fresh clone dynaminds_fix29b_20261029_NN or dynaminds_int29b_20261029_NN required');
relaxPoolTimeouts();

type Owner = { tenant: string; catalog: string; warehouse: string; currency: string; actor: Actor; product: string };
let o: Owner;
before(async () => {
  const r = (
    await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse,
      (SELECT currency FROM tenants t WHERE t.id=m.tenant_id) currency
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND EXISTS(SELECT 1 FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)
    ORDER BY m.tenant_id LIMIT 1`)
  ).rows[0];
  assert(r, 'clone needs a tenant with a default catalog and warehouse');
  const actor: Actor = { tenantId: r.tenant_id, userId: r.user_id, role: 'admin', source: 'manual' };
  const sku = 'NUM-' + randomUUID().slice(0, 8);
  const p = await tenantTx(r.tenant_id, (c) =>
    createProduct(c, actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: r.catalog, warehouse_id: r.warehouse, quantity: 50 })),
  );
  o = { tenant: r.tenant_id, catalog: r.catalog, warehouse: r.warehouse, currency: r.currency, actor, product: p.id };
});
after(async () => {
  injectOrderNumberSuffixForTest(null);
  await pool.end();
});

const order = () =>
  tenantTx(o.tenant, (c) =>
    createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Klient numer', email: 'numer@example.com', warehouse_id: o.warehouse,
      currency: o.currency, items: [{ product_id: o.product, quantity: 1 }] }), undefined, { fieldSource: 'manual' }),
  );
const rows = async (number: string) =>
  (await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1 AND number=$2', [o.tenant, number])).rows[0].n as number;

test('a taken number is redrawn inside the same createOrder: one order, new readable number, stock reserved once', async () => {
  const first = await order();
  const taken = String(first.number).slice(-8);
  assert.match(first.number, /^DE-\d{8}-[0-9A-F]{8}$/);
  const fresh = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const draws = [taken, taken, fresh];
  injectOrderNumberSuffixForTest(() => draws.shift() ?? fresh);
  const reservedBefore = Number((await pool.query('SELECT reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [o.product, o.warehouse])).rows[0].reserved);
  try {
    const second = await order();
    assert.equal(draws.length, 0, 'two collisions, then the fresh suffix');
    assert.match(second.number, /^DE-\d{8}-[0-9A-F]{8}$/);
    assert.equal(String(second.number).slice(-8), fresh);
    assert.equal(await rows(first.number), 1);
    assert.equal(await rows(second.number), 1);
    const items = (await pool.query('SELECT count(*)::int n FROM order_items WHERE order_id=$1', [second.id])).rows[0].n;
    assert.equal(items, 1);
    const reservedAfter = Number((await pool.query('SELECT reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [o.product, o.warehouse])).rows[0].reserved);
    assert.equal(reservedAfter - reservedBefore, 1);
  } finally {
    injectOrderNumberSuffixForTest(null);
  }
});

test('the retry is bounded: a generator that only repeats a taken number still fails, without a second order', async () => {
  const first = await order();
  const taken = String(first.number).slice(-8);
  let draws = 0;
  injectOrderNumberSuffixForTest(() => (draws++, taken));
  const count = async () => (await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [o.tenant])).rows[0].n as number;
  const before = await count();
  try {
    await assert.rejects(order(), (e: any) => e.code === '23505' && e.constraint === 'orders_tenant_id_number_key');
    assert.equal(draws, 8);
    assert.equal(await count(), before);
  } finally {
    injectOrderNumberSuffixForTest(null);
  }
});
