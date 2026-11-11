/** Real Fastify injection + real developer key gate + real 220 sidecars and the
 * native product/price writers for the PIM methods of the Base inventory family.
 * Root-only execution on a fresh disposable clone dynaminds_wirepim_20261023_NN
 * made from the clean 217 template with 218+219+220+221 applied by the guarded
 * applier. The suite writes, so a rerun requires a NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { pool, tenantTx } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireInventoryFamily, BASE_WIRE_BASE_PRICE_GROUP_ID as BASE } from '../server/base-wire-inventory';
import { createDefaultBaseWireInventoryService } from '../server/base-wire-inventory-runtime';
import { listProducts, productDetail } from '../server/catalog';
import { prices } from '../server/pricing';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_wirepim_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string };
let app: ReturnType<typeof Fastify>, a: Owner, b: Owner, readOnlyKey: Owner, writeOnly: Owner;
let rule: { id: string; gid: number }, euro: { id: string; gid: number }, currency: string;
const KEY = 'Isolated wirepim test';
async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`, [randomUUID(), row.tenant_id, row.user_id, KEY, tokenHash(token), token.slice(0, 16), scopes]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, token };
}
async function wire(owner: Owner, method: string, parameters: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/connector.php',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': owner.token, ...headers },
    payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
}
const success = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const refused = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); const d = r.json(); assert.equal(d.status, 'ERROR');
  assert.deepEqual(Object.keys(d).sort(), ['error_code','error_message','status']); assert(!/SELECT |stack|dyna_api_/.test(r.body)); return d; };
const publicId = async (table: string, tenant: string, local: string) =>
  Number((await pool.query(`SELECT public_id::text p FROM ${table} WHERE tenant_id=$1 AND local_id=$2`, [tenant, local])).rows[0]?.p);
const localProduct = async (tenant: string, pid: number) =>
  (await pool.query('SELECT local_id FROM base_wire220_product_ids WHERE tenant_id=$1 AND public_id=$2', [tenant, pid])).rows[0]?.local_id as string;
const row = async (id: string) => (await pool.query('SELECT * FROM products WHERE id=$1', [id])).rows[0];
const items = async (id: string) => (await pool.query('SELECT price_list_id,price FROM price_list_items WHERE product_id=$1 ORDER BY price_list_id', [id])).rows;
const listVersion = async (id: string) => (await pool.query('SELECT version FROM price_lists WHERE id=$1', [id])).rows[0].version as number;

before(async () => {
  for (const name of ['base_wire220_catalog_ids', 'base_wire220_product_ids', 'base_wire220_warehouse_ids', 'base_wire220_price_group_ids'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 220: ' + name);
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY])).rows[0].n, 0, 'Fresh clone required; no rerun');
  // Two tenants whose default catalogue has exactly one warehouse and permits the legacy writer.
  const rows = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND (SELECT count(*) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)=1
    ORDER BY m.tenant_id LIMIT 2`)).rows;
  assert.equal(rows.length, 2);
  a = await key(rows[0], ['inventory:read', 'products:read', 'products:write']); b = await key(rows[1], ['inventory:read', 'products:read', 'products:write']);
  readOnlyKey = await key(rows[0], ['inventory:read', 'products:read']); writeOnly = await key(rows[0], ['products:write']);
  currency = (await pool.query('SELECT currency FROM tenants WHERE id=$1', [a.tenant])).rows[0].currency;
  // Bulk native fixtures in one transaction, same INSERT as POST /api/price-lists
  // (its birth trigger enrolls the list in the default catalogue).
  [rule, euro] = await tenantTx(a.tenant, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${a.tenant}`]);
    const out = [];
    for (const [name, cur, fallback, bps, amount] of [['Wire PIM hurt', currency, true, -1000, 50], ['Wire PIM EUR', currency === 'EUR' ? 'USD' : 'EUR', false, 0, 0]] as const)
      out.push((await c.query('INSERT INTO price_lists(id,tenant_id,name,currency,fallback,adjustment_bps,adjustment_amount) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [randomUUID(), a.tenant, name + ' ' + randomBytes(3).toString('hex'), cur, fallback, bps, amount])).rows[0].id as string);
    return out;
  }).then(async ids => Promise.all(ids.map(async id => ({ id, gid: await publicId('base_wire220_price_group_ids', a.tenant, id) }))));
  app = Fastify();
  registerBaseWireRoutes(app, { readOnly: false, families: [createBaseWireInventoryFamily({ available: true, service: createDefaultBaseWireInventoryService() })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await app.ready();
});
after(async () => { await app?.close(); await pool.end(); });

test('getInventoryPriceGroups lists own native price lists by 220 ID plus the base group; getInventories assigns them', async () => {
  const groups = success(await wire(readOnlyKey, 'getInventoryPriceGroups', {})).price_groups;
  const own = (await pool.query('SELECT count(*)::int n FROM price_lists WHERE tenant_id=$1', [a.tenant])).rows[0].n;
  assert.equal(groups.length, own + 1);
  assert.deepEqual(groups.find((g: any) => g.price_group_id === rule.gid), { price_group_id: rule.gid, name: groups.find((g: any) => g.price_group_id === rule.gid).name,
    description: '', currency, is_default: false, price_group_type: 'dependent_on_price_group', source_price_group_id: BASE, price_multiplier: 0.9, price_addition: 0.5,
    is_bundle_price_calculated: false, bundle_price_multiplier: 1, bundle_price_addition: 0 });
  assert.equal(groups.find((g: any) => g.price_group_id === euro.gid).price_group_type, 'standard');
  assert.deepEqual(groups.at(-1), { price_group_id: BASE, name: 'Cena podstawowa', description: '', currency, is_default: true, price_group_type: 'standard',
    source_price_group_id: 0, price_multiplier: 1, price_addition: 0, is_bundle_price_calculated: false, bundle_price_multiplier: 1, bundle_price_addition: 0 });
  const cid = await publicId('base_wire220_catalog_ids', a.tenant, a.catalog);
  const inventory = success(await wire(readOnlyKey, 'getInventories', {})).inventories.find((x: any) => x.inventory_id === cid);
  assert(inventory.price_groups.includes(rule.gid) && inventory.price_groups.includes(euro.gid) && inventory.price_groups.at(-1) === BASE);
  assert.equal(inventory.default_price_group, BASE);
  assert(!success(await wire(b, 'getInventoryPriceGroups', {})).price_groups.some((g: any) => g.price_group_id === rule.gid), 'second tenant isolated');
});

test('addInventoryProduct creates a native product visible natively and through the Base reads; update changes only given fields', async () => {
  const cid = await publicId('base_wire220_catalog_ids', a.tenant, a.catalog), wkey = 'bl_' + await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse);
  const sku = 'WPIM-' + randomBytes(4).toString('hex'), clientKey = randomUUID();
  const body = { inventory_id: cid, product_id: '', parent_id: 0, sku, ean: '5901234', tags: ['wire', 'pim'], tax_rate: 8,
    text_fields: { name: 'Produkt Base ' + sku, description: 'Opis z Base' }, prices: { [BASE]: 12.34, [rule.gid]: 10, [euro.gid]: 3.5 },
    stock: { [wkey]: 7 }, images: { '0': 'url:https://example.com/wire-pim.jpg' }, asin: '', weight: 0, category_id: 0, suppliers: [] };
  const created = success(await wire(a, 'addInventoryProduct', body, { 'idempotency-key': clientKey }));
  const pid = created.product_id;
  assert(Number.isSafeInteger(pid) && pid > 0); assert.deepEqual(created, { status: 'SUCCESS', product_id: pid, warnings: {} });
  const local = await localProduct(a.tenant, pid);
  // Lost ACK retry: same key and body replays the same ID, no second product.
  assert.deepEqual(success(await wire(a, 'addInventoryProduct', body, { 'idempotency-key': clientKey })), created);
  assert.equal((await pool.query('SELECT count(*)::int n FROM products WHERE tenant_id=$1 AND sku=$2', [a.tenant, sku])).rows[0].n, 1);
  // Native catalogue functions (GET /api/products/:id and GET /api/products) see the same product.
  const detail = await tenantTx(a.tenant, c => productDetail(c, local));
  assert.equal(detail.sku, sku); assert.equal(detail.name, 'Produkt Base ' + sku); assert.equal(detail.price, 1234); assert.equal(detail.vat, 8);
  assert.equal(detail.ean, '5901234'); assert.deepEqual(detail.tags, ['pim', 'wire']); assert.deepEqual(detail.images, ['https://example.com/wire-pim.jpg']);
  assert.equal(detail.catalog_id, a.catalog); assert.equal(detail.kind, 'simple'); assert.equal(detail.stock[0].on_hand, 7);
  const listed = await tenantTx(a.tenant, c => listProducts(c, { search: sku, catalog_id: a.catalog, limit: 10 }));
  assert.deepEqual(listed.data.map((p: any) => p.id), [local]);
  assert.deepEqual(await items(local), [{ price_list_id: rule.id, price: 1000 }, { price_list_id: euro.id, price: 350 }].sort((x, y) => x.price_list_id.localeCompare(y.price_list_id)));
  const data = success(await wire(readOnlyKey, 'getInventoryProductsData', { inventory_id: cid, products: [pid] })).products[String(pid)];
  assert.equal(data.sku, sku); assert.equal(data.tax_rate, 8); assert.deepEqual(data.text_fields, { name: 'Produkt Base ' + sku, description: 'Opis z Base' });
  assert.deepEqual(data.stock, { [wkey]: 7 }); assert.deepEqual(data.images, { '1': 'https://example.com/wire-pim.jpg' });
  assert.deepEqual(success(await wire(readOnlyKey, 'getInventoryProductsStock', { inventory_id: cid, filter_id: pid })).products,
    { [pid]: { product_id: pid, stock: { [wkey]: 7 }, reservations: { [wkey]: 0 }, variants: {} } });

  // Update: only the name and one SKU price change natively.
  const beforeRow = await row(local), beforeItems = await items(local);
  assert.deepEqual(success(await wire(a, 'addInventoryProduct', { inventory_id: cid, product_id: pid, text_fields: { name: 'Nowa nazwa ' + sku }, prices: { [euro.gid]: 4 } })),
    { status: 'SUCCESS', product_id: pid, warnings: {} });
  const afterRow = await row(local);
  assert.equal(afterRow.name, 'Nowa nazwa ' + sku); assert.equal(afterRow.version, beforeRow.version + 1);
  assert.deepEqual({ ...afterRow, name: beforeRow.name, version: beforeRow.version }, beforeRow);
  assert.deepEqual(await items(local), beforeItems.map(i => i.price_list_id === euro.id ? { ...i, price: 400 } : i));
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action='product.update'", [local])).rows[0].n, 1);
  // Kind/parent/stock stay native; unsupported fields refused with no effect.
  refused(await wire(a, 'addInventoryProduct', { inventory_id: cid, product_id: pid, stock: { [wkey]: 1 } }), 422);
  refused(await wire(a, 'addInventoryProduct', { inventory_id: cid, product_id: pid, category_id: 5 }), 422);
  refused(await wire(a, 'addInventoryProduct', { inventory_id: cid, product_id: pid, is_bundle: true }), 422);
  assert.deepEqual(await row(local), afterRow);
  // Second create with the same SKU follows the native uniqueness rule.
  refused(await wire(a, 'addInventoryProduct', { ...body, text_fields: { name: 'Duplikat' } }), 409);
  assert.equal((await pool.query('SELECT count(*)::int n FROM products WHERE tenant_id=$1 AND sku=$2', [a.tenant, sku])).rows[0].n, 1);
});

test('prices round-trip through a native price list and the base price; native quote agrees', async () => {
  const cid = await publicId('base_wire220_catalog_ids', a.tenant, a.catalog), wkey = 'bl_' + await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse);
  const sku = 'WPIMP-' + randomBytes(4).toString('hex');
  const pid = success(await wire(a, 'addInventoryProduct', { inventory_id: cid, sku, text_fields: { name: 'Ceny ' + sku }, prices: { [BASE]: 19.99 }, stock: { [wkey]: 0 } })).product_id;
  const local = await localProduct(a.tenant, pid);
  const read = async () => {
    for (let page = 1; ; page++) {
      const products = success(await wire(readOnlyKey, 'getInventoryProductsPrices', { inventory_id: cid, page })).products;
      if (products[String(pid)] || !Object.keys(products).length) return products[String(pid)];
    }
  };
  // Rule list: 1999*0.9 rounded half up = 1799, +50 = 18.49; EUR list without SKU price: no price.
  assert.deepEqual(await read(), { product_id: pid, prices: { [rule.gid]: 18.49, [BASE]: 19.99 }, variants: {} });
  const quote = await tenantTx(a.tenant, c => prices(c, [local], rule.id, a.tenant));
  assert.equal(quote.items[0].price, 1849); assert.equal(quote.items[0].source, 'rule');
  const version = await listVersion(euro.id), clientKey = randomUUID();
  const missing = String(Number.MAX_SAFE_INTEGER - 1);
  const parameters = { inventory_id: cid, products: { [pid]: { [euro.gid]: 5.25, [BASE]: 21 }, [missing]: { [euro.gid]: 1 } } };
  const r = success(await wire(a, 'updateInventoryProductsPrices', parameters, { 'idempotency-key': clientKey }));
  assert.deepEqual(r, { status: 'SUCCESS', counter: 1, warnings: { [missing]: 'Nie znaleziono produktu w katalogu' } });
  assert.equal((await row(local)).price, 2100);
  assert.deepEqual(await items(local), [{ price_list_id: euro.id, price: 525 }]);
  assert.equal(await listVersion(euro.id), version + 1);
  // The rule list follows the new base price: 2100*0.9 = 1890, +50 = 19.40.
  const euroQuote = await tenantTx(a.tenant, c => prices(c, [local], euro.id, a.tenant));
  assert.equal(euroQuote.items[0].price, 525); assert.equal(euroQuote.items[0].source, 'override');
  assert.deepEqual(await read(), { product_id: pid, prices: { [rule.gid]: 19.4, [euro.gid]: 5.25, [BASE]: 21 }, variants: {} });
  // Replay: no second native write; inexact or unassigned prices are refused.
  assert.deepEqual(success(await wire(a, 'updateInventoryProductsPrices', parameters, { 'idempotency-key': clientKey })), r);
  assert.equal(await listVersion(euro.id), version + 1);
  refused(await wire(a, 'updateInventoryProductsPrices', { inventory_id: cid, products: { [pid]: { [euro.gid]: 1.005 } } }), 422);
  assert.deepEqual(await items(local), [{ price_list_id: euro.id, price: 525 }]);
});

test('foreign tenant is isolated; read-only and write-only keys are refused for writes; skipped methods are unknown', async () => {
  const cid = await publicId('base_wire220_catalog_ids', a.tenant, a.catalog), bcid = await publicId('base_wire220_catalog_ids', b.tenant, b.catalog);
  const wkey = 'bl_' + await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse);
  const pid = success(await wire(a, 'addInventoryProduct', { inventory_id: cid, sku: 'WPIMF-' + randomBytes(4).toString('hex'), text_fields: { name: 'Obcy test' },
    prices: { [BASE]: 1 }, stock: { [wkey]: 0 } })).product_id;
  const local = await localProduct(a.tenant, pid), before = await row(local);
  refused(await wire(b, 'getInventoryProductsPrices', { inventory_id: cid }), 404);
  refused(await wire(b, 'addInventoryProduct', { inventory_id: cid, product_id: pid, text_fields: { name: 'Przejęty' } }), 404);
  refused(await wire(b, 'addInventoryProduct', { inventory_id: bcid, product_id: pid, text_fields: { name: 'Przejęty' } }), 404);
  assert.deepEqual(success(await wire(b, 'updateInventoryProductsPrices', { inventory_id: bcid, products: { [pid]: { [BASE]: 2 } } })),
    { status: 'SUCCESS', counter: 0, warnings: { [pid]: 'Nie znaleziono produktu w katalogu' } });
  assert.deepEqual(success(await wire(b, 'getInventoryProductsStock', { inventory_id: bcid, filter_id: pid })).products, {});
  for (const owner of [readOnlyKey, writeOnly]) {
    refused(await wire(owner, 'addInventoryProduct', { inventory_id: cid, product_id: pid, text_fields: { name: 'Bez zakresu' } }), 403);
    refused(await wire(owner, 'updateInventoryProductsPrices', { inventory_id: cid, products: { [pid]: { [BASE]: 3 } } }), 403);
  }
  refused(await wire(writeOnly, 'getInventoryProductsPrices', { inventory_id: cid }), 403);
  assert.deepEqual(await row(local), before);
  // Category writes are variant B: unknown method.
  refused(await wire(a, 'addInventoryCategory', {}), 400);
  // Deletion needs the 225 capability, which this family instance does not select (product-deletions225.database.test.ts).
  refused(await wire(a, 'deleteInventoryProduct', { product_id: pid }), 503);
  // Category reads need the 224 capability, which this family instance does not select.
  refused(await wire(a, 'getInventoryCategories', { inventory_id: cid }), 503);
  assert.deepEqual(await row(local), before);
});
