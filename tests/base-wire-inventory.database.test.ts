/** Real Fastify injection + real developer key gate + real 220 sidecars/native
 * catalog/product/stock domain. Root-only execution on a fresh disposable clone
 * dynaminds_wireinvlist_20261023_NN made from the clean 217 template with
 * 218+219+220 applied by the guarded applier (nine native guards before and
 * after each file). The suite writes, so a rerun requires a NEW clone.
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
import { createProduct } from '../server/catalog';
import { productSchema, type Actor } from '../server/domain';
import { previewProductCatalog, commitProductCatalog } from '../server/product-catalogs';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
// Also runs beside base-wire-inventory-pim.database.test.ts on its clone (distinct key names).
assert.match(selected.pathname, /^\/dynaminds_(wireinvlist|wirepim)_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; actor: Actor };
let app: ReturnType<typeof Fastify>, a: Owner, b: Owner, writeOnly: Owner, readOnlyKey: Owner;
async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,'Isolated wire220 test',$4,$5,$6,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), scopes]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, token,
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
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
const stockOf = async (product: string, warehouse: string) =>
  (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [product, warehouse])).rows[0];
const movements = async (product: string) =>
  (await pool.query("SELECT delta,kind,note FROM stock_movements WHERE product_id=$1 ORDER BY created_at,id", [product])).rows;
async function nativeProduct(o: Owner, sku: string, quantity: number) {
  return tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity })));
}

before(async () => {
  for (const name of ['base_wire219_group_ids', 'base_wire220_catalog_ids', 'base_wire220_product_ids', 'base_wire220_warehouse_ids', 'base_wire220_price_group_ids'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 219/220: ' + name);
  assert.equal((await pool.query("SELECT count(*)::int n FROM api_keys WHERE name='Isolated wire220 test'")).rows[0].n, 0, 'Fresh clone required; no rerun');
  for (const [kind, table, filter] of [['warehouse','warehouses',''],['catalog','product_catalogs',''],['product','products',''],['order','orders',''],
    ['invoice','documents'," WHERE r.kind IN('invoice','correction')"],['invoice_series','local_invoice_series','']]) {
    const r = await pool.query(`SELECT count(*)::int n FROM ${table} r LEFT JOIN base_wire220_${kind}_ids i ON(i.tenant_id,i.resource_id,i.local_id)=(r.tenant_id,r.id,r.id)${filter ? filter + ' AND' : ' WHERE'} i.public_id IS NULL`);
    assert.equal(r.rows[0].n, 0, 'Complete backfill ' + kind);
  }
  // Two tenants whose default catalog permits the legacy writer (no WMS/strict/MFA).
  const rows = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND EXISTS(SELECT 1 FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)
    ORDER BY (SELECT plan FROM tenants t WHERE t.id=m.tenant_id)='enterprise' DESC,m.tenant_id LIMIT 2`)).rows;
  assert.equal(rows.length, 2);
  // Native warehouse creation below is subject to the plan limit (starter = 1).
  assert.equal((await pool.query('SELECT plan FROM tenants WHERE id=$1', [rows[0].tenant_id])).rows[0].plan, 'enterprise');
  a = await key(rows[0], ['inventory:read', 'inventory:write']); b = await key(rows[1], ['inventory:read', 'inventory:write']);
  writeOnly = await key(rows[0], ['inventory:write']); readOnlyKey = await key(rows[0], ['inventory:read']);
  app = Fastify();
  registerBaseWireRoutes(app, { readOnly: false, families: [createBaseWireInventoryFamily({ available: true, service: createDefaultBaseWireInventoryService() })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await app.ready();
});
after(async () => { await app?.close(); await pool.end(); });

test('native warehouse/product creation allocates numeric IDs that Base reads return', async () => {
  const w = await tenantTx(a.tenant, async c => (await c.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4) RETURNING id',
    [randomUUID(), a.tenant, 'Wire220 ' + randomUUID().slice(0, 8), 'W' + randomBytes(4).toString('hex')])).rows[0].id);
  const wid = await publicId('base_wire220_warehouse_ids', a.tenant, w);
  assert(Number.isSafeInteger(wid) && wid > 0);
  const listed = success(await wire(a, 'getInventoryWarehouses', {})).warehouses;
  assert.deepEqual(listed.find((x: any) => x.warehouse_id === wid), { warehouse_type: 'bl', warehouse_id: wid, internal_warehouse_id: wid,
    name: (await pool.query('SELECT name FROM warehouses WHERE id=$1', [w])).rows[0].name, description: '', stock_edition: true, is_default: false, address: '', postcode: '', city: '', country: '' });
  const own = (await pool.query('SELECT count(*)::int n FROM warehouses WHERE tenant_id=$1', [a.tenant])).rows[0].n;
  assert.equal(listed.length, own);
  assert(!success(await wire(b, 'getInventoryWarehouses', {})).warehouses.some((x: any) => x.warehouse_id === wid), 'second tenant isolated');

  const p = await nativeProduct(a, 'W220-' + randomBytes(4).toString('hex'), 5);
  const pid = await publicId('base_wire220_product_ids', a.tenant, p.id), cid = await publicId('base_wire220_catalog_ids', a.tenant, a.catalog);
  const whid = await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse);
  const data = success(await wire(a, 'getInventoryProductsData', { inventory_id: cid, products: [pid] }));
  assert.deepEqual(Object.keys(data.products), [String(pid)]);
  const dto = data.products[String(pid)];
  assert.equal(dto.sku, p.sku); assert.equal(dto.parent_id, 0); assert.equal(dto.is_bundle, false); assert.equal(dto.tax_rate, 23);
  assert.deepEqual(dto.stock, { ['bl_' + whid]: 5 }); assert.deepEqual(dto.text_fields, { name: p.name, description: '' });
  assert(!JSON.stringify(data).includes(p.id), 'numeric identities only');
  // Foreign tenant: own catalog ID unknown to B; B's own catalog never returns A's product.
  refused(await wire(b, 'getInventoryProductsData', { inventory_id: cid, products: [pid] }), 404);
  const bcid = await publicId('base_wire220_catalog_ids', b.tenant, b.catalog);
  assert.deepEqual(success(await wire(b, 'getInventoryProductsData', { inventory_id: bcid, products: [pid] })).products, {});
});

test('getInventories and getInventoryProductsList discover a native catalog and its products page by page', async () => {
  // Native catalog through the same preview/commit as POST /api/product-catalogs/previews(/:id/commit).
  const name = 'Wire list ' + randomBytes(4).toString('hex');
  const preview = (await previewProductCatalog(a.actor, { client_key: randomUUID(), kind: 'create',
    settings: { name, active: true, languages: ['pl'], default_language: 'pl', warehouse_ids: [a.warehouse], price_list_ids: [] } })).preview;
  const catalog = (await commitProductCatalog(a.actor, preview.id, { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true })).catalog.id as string;
  const cid = await publicId('base_wire220_catalog_ids', a.tenant, catalog), whid = await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse);
  const inventories = success(await wire(readOnlyKey, 'getInventories', {})).inventories;
  assert.equal(inventories.length, (await pool.query('SELECT count(*)::int n FROM product_catalogs WHERE tenant_id=$1', [a.tenant])).rows[0].n);
  assert.deepEqual(inventories.map((x: any) => x.inventory_id), [...inventories.map((x: any) => x.inventory_id)].sort((x: number, y: number) => x - y));
  assert.deepEqual(inventories.find((x: any) => x.inventory_id === cid), { inventory_id: cid, name, description: '', languages: ['pl'], default_language: 'pl',
    price_groups: [BASE], default_price_group: BASE, warehouses: ['bl_' + whid], default_warehouse: '', reservations: true, is_default: false });
  const defaults = inventories.filter((x: any) => x.is_default);
  assert.deepEqual(defaults.map((x: any) => x.inventory_id), [await publicId('base_wire220_catalog_ids', a.tenant, a.catalog)]);
  const groups = (await pool.query(`SELECT s.public_id::text p FROM product_catalog_price_lists l JOIN base_wire220_price_group_ids s ON(s.tenant_id,s.local_id)=(l.tenant_id,l.price_list_id)
    WHERE l.catalog_id=$1 ORDER BY s.public_id`, [a.catalog])).rows.map(r => Number(r.p));
  assert.deepEqual(defaults[0].price_groups, [...groups, BASE]);
  assert(!success(await wire(b, 'getInventories', {})).inventories.some((x: any) => x.inventory_id === cid), 'second tenant isolated');

  // 1001 native products: one full Base page (1000) plus one on page 2.
  const prefix = 'WL' + randomBytes(4).toString('hex');
  await tenantTx(a.tenant, async c => { for (let n = 0; n < 1001; n++) await createProduct(c, a.actor, productSchema.parse({ name: 'Lista ' + prefix + ' ' + n,
    sku: prefix + '-' + String(n).padStart(4, '0'), price: 100, vat: 23, catalog_id: catalog, warehouse_id: a.warehouse, quantity: n < 3 ? n + 1 : 0 })); });
  const ids = (await pool.query(`SELECT s.public_id::text p,p.sku FROM base_wire220_product_ids s JOIN products p ON(p.tenant_id,p.id)=(s.tenant_id,s.local_id)
    WHERE p.catalog_id=$1 ORDER BY s.public_id`, [catalog])).rows;
  assert.equal(ids.length, 1001);
  const list = async (o: Owner, p: Record<string, unknown>) => success(await wire(o, 'getInventoryProductsList', { inventory_id: cid, ...p })).products;
  const first = await list(readOnlyKey, {}), second = await list(readOnlyKey, { page: 2 });
  assert.deepEqual(Object.keys(first), ids.slice(0, 1000).map(r => r.p));
  assert.deepEqual(Object.keys(second), [ids[1000].p]);
  assert.deepEqual(await list(readOnlyKey, { page: 3 }), {});
  assert.deepEqual(Object.keys(await list(readOnlyKey, { page: 2, filter_sort: 'id DESC' })), [ids[0].p]);
  assert.deepEqual(first[ids[0].p], { id: Number(ids[0].p), parent_id: 0, ean: '', sku: prefix + '-0000', name: 'Lista ' + prefix + ' 0', stock: { ['bl_' + whid]: 1 } });
  assert.deepEqual(Object.keys(await list(readOnlyKey, { filter_sku: prefix + '-0002' })), [ids[2].p]);
  assert.deepEqual(Object.keys(await list(readOnlyKey, { filter_id: Number(ids[1000].p) })), [ids[1000].p]);
  assert.equal(Object.keys(await list(readOnlyKey, { filter_name: prefix.toUpperCase() + ' 10' })).length, 12); // 10, 100..109, 1000
  assert.deepEqual(Object.keys(await list(readOnlyKey, { filter_stock_from: 2 })), [ids[1].p, ids[2].p]);
  assert(!JSON.stringify(first).includes(catalog), 'numeric identities only');
  refused(await wire(readOnlyKey, 'getInventoryProductsList', { inventory_id: cid, filter_category_id: 1 }), 422);
  refused(await wire(writeOnly, 'getInventoryProductsList', { inventory_id: cid }), 403);
  // Foreign tenant: A's catalog ID is unknown to B; B's own catalog never lists A's products.
  refused(await wire(b, 'getInventoryProductsList', { inventory_id: cid }), 404);
  const bcid = await publicId('base_wire220_catalog_ids', b.tenant, b.catalog);
  assert.deepEqual(await list(b, { inventory_id: bcid, filter_sku: prefix + '-0000' }), {});
});

test('Base stock update changes native stock exactly once; replay and foreign keys have no effect', async () => {
  const p = await nativeProduct(a, 'W220S-' + randomBytes(4).toString('hex'), 5);
  const pid = String(await publicId('base_wire220_product_ids', a.tenant, p.id)), cid = await publicId('base_wire220_catalog_ids', a.tenant, a.catalog);
  const wkey = 'bl_' + await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse), clientKey = randomUUID();
  const before = (await movements(p.id)).length;
  const parameters = { inventory_id: cid, products: { [pid]: { [wkey]: 12 } } };
  assert.deepEqual(success(await wire(a, 'updateInventoryProductsStock', parameters, { 'idempotency-key': clientKey })), { status: 'SUCCESS', counter: 1, warnings: {} });
  assert.deepEqual(await stockOf(p.id, a.warehouse), { on_hand: 12, reserved: 0 });
  assert.deepEqual((await movements(p.id)).slice(before), [{ delta: 7, kind: 'adjustment', note: 'Base API updateInventoryProductsStock' }]);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action='stock.adjust'", [p.id])).rows[0].n, 1);
  // Retry after a lost ACK: same key and body replays without a second movement.
  assert.deepEqual(success(await wire(a, 'updateInventoryProductsStock', parameters, { 'idempotency-key': clientKey })), { status: 'SUCCESS', counter: 1, warnings: {} });
  assert.equal((await movements(p.id)).length, before + 1); assert.equal((await stockOf(p.id, a.warehouse)).on_hand, 12);
  refused(await wire(a, 'updateInventoryProductsStock', { inventory_id: cid, products: { [pid]: { [wkey]: 13 } } }, { 'idempotency-key': clientKey }), 409);
  // Base read sees the native result.
  assert.deepEqual(success(await wire(a, 'getInventoryProductsData', { inventory_id: cid, products: [Number(pid)] })).products[pid].stock, { [wkey]: 12 });
  // Second tenant: A's product is not found in B's own catalog; A's catalog is 404.
  const bcid = await publicId('base_wire220_catalog_ids', b.tenant, b.catalog);
  const bkey = 'bl_' + await publicId('base_wire220_warehouse_ids', b.tenant, b.warehouse);
  assert.deepEqual(success(await wire(b, 'updateInventoryProductsStock', { inventory_id: bcid, products: { [pid]: { [bkey]: 1 } } })),
    { status: 'SUCCESS', counter: 0, warnings: { [pid]: 'Nie znaleziono produktu w katalogu' } });
  refused(await wire(b, 'updateInventoryProductsStock', parameters), 404);
  assert.deepEqual(success(await wire(a, 'updateInventoryProductsStock', { inventory_id: cid, products: { [pid]: { [bkey]: 1 } } })).warnings,
    { [pid]: 'Nie znaleziono własnego magazynu Base' });
  // A write needs both inventory scopes, server side.
  refused(await wire(writeOnly, 'updateInventoryProductsStock', parameters), 403);
  refused(await wire(readOnlyKey, 'updateInventoryProductsStock', parameters), 403);
  success(await wire(readOnlyKey, 'getInventoryWarehouses', {}));
  assert.equal((await stockOf(p.id, a.warehouse)).on_hand, 12); assert.equal((await movements(p.id)).length, before + 1);
});

test('a revoked key refuses the write without native effect', async () => {
  // Reservations below target are covered on closed ports; real reservations need
  // the native order/location flow, not a direct stock row edit.
  const p = await nativeProduct(a, 'W220R-' + randomBytes(4).toString('hex'), 5);
  const pid = String(await publicId('base_wire220_product_ids', a.tenant, p.id)), cid = await publicId('base_wire220_catalog_ids', a.tenant, a.catalog);
  const wkey = 'bl_' + await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse), before = (await movements(p.id)).length;
  const revoked = await key({ tenant_id: a.tenant, user_id: a.user, catalog: a.catalog, warehouse: a.warehouse }, ['inventory:read', 'inventory:write']);
  await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE token_hash=$1', [tokenHash(revoked.token)]);
  refused(await wire(revoked, 'updateInventoryProductsStock', { inventory_id: cid, products: { [pid]: { [wkey]: 9 } } }), 401);
  assert.deepEqual(await stockOf(p.id, a.warehouse), { on_hand: 5, reserved: 0 });
  assert.equal((await movements(p.id)).length, before);
});

test('220 identities are immutable and pinned namespaces allocate on demand for the current tenant only', async () => {
  const row = (await pool.query('SELECT tenant_id,resource_id,public_id::text p FROM base_wire220_product_ids WHERE tenant_id=$1 LIMIT 1', [a.tenant])).rows[0];
  // Tombstoning while the native parent still exists is refused, like any rekey.
  await assert.rejects(pool.query('UPDATE base_wire220_product_ids SET local_id=NULL WHERE tenant_id=$1 AND resource_id=$2', [row.tenant_id, row.resource_id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM base_wire220_product_ids WHERE tenant_id=$1 AND resource_id=$2', [row.tenant_id, row.resource_id]), /immutable/);
  await assert.rejects(pool.query('TRUNCATE base_wire220_product_ids'), /immutable/);
  await assert.rejects(tenantTx(a.tenant, c => c.query('INSERT INTO base_wire220_order_ids(tenant_id,resource_id,local_id) VALUES($1,$2,NULL)', [a.tenant, randomUUID()])), /permission denied/);
  const counts = async () => (await pool.query('SELECT (SELECT count(*) FROM base_wire220_order_ids)::int o,(SELECT count(*) FROM base_wire220_invoice_ids)::int i,(SELECT count(*) FROM base_wire220_invoice_series_ids)::int s')).rows[0];
  const prior = await counts();
  for (const kind of ['order', 'invoice', 'invoice_series']) await tenantTx(a.tenant, c => c.query('SELECT public.base_wire220_allocate_pending($1)', [kind]));
  assert.deepEqual(await counts(), prior, 'backfill already complete; nothing re-allocated');
  await assert.rejects(tenantTx(a.tenant, c => c.query("SELECT public.base_wire220_allocate_pending('product')")), /Invalid Base wire identity allocation/);
});
