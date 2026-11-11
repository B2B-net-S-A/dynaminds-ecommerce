/** N28 Base-compatibility fixes on a real clone: native translations in
 * getInventoryProductsData, addInventoryProduct without stock in a catalogue with
 * two warehouses, the PZ purchase cost in getInventoryDocuments/Items and the
 * specific Polish reason of 4xx refusals. Real Fastify injection + real developer
 * key gate + real 220/224/225 sidecars and the native product, translation
 * bulk-edit, warehouse and purchasing writers. Root-only execution on a fresh
 * disposable clone dynaminds_n28fix_20261023_NN made from the clean restore
 * template with 218–225 applied by the guarded applier. The suite writes, so a
 * rerun requires a NEW clone.
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
import { createBaseWireWmsFamily } from '../server/base-wire-wms';
import { createDefaultBaseWireWmsService } from '../server/base-wire-wms-runtime';
import { createProduct } from '../server/catalog';
import { productSchema, type Actor } from '../server/domain';
import { createProductTranslationBulkEditPreview, executeProductTranslationBulkEdit } from '../server/product-translation-bulk-edit';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_n28fix_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
const KEY = 'Isolated N28 fix test';
type Owner = { tenant: string; user: string; catalog: string; token: string; actor: Actor };
let app: ReturnType<typeof Fastify>, a: Owner, b: Owner, inventoryOnly: Owner;
let cid: number, warehouses: { id: string; pid: number }[];
async function key(row: { tenant_id: string; user_id: string; catalog: string }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`, [randomUUID(), row.tenant_id, row.user_id, KEY, tokenHash(token), token.slice(0, 16), scopes]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, token, actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
async function wire(owner: Owner, method: string, parameters: unknown) {
  return app.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': owner.token },
    payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
}
const success = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const refused = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); const d = r.json(); assert.equal(d.status, 'ERROR');
  assert.deepEqual(Object.keys(d).sort(), ['error_code', 'error_message', 'status']); assert(!/SELECT |stack|dyna_api_|violates|constraint/.test(r.body)); return d; };
const publicId = async (table: string, tenant: string, local: string) =>
  Number((await pool.query(`SELECT public_id::text p FROM ${table} WHERE tenant_id=$1 AND local_id=$2`, [tenant, local])).rows[0]?.p);
const localProduct = async (tenant: string, pid: number) =>
  (await pool.query('SELECT local_id FROM base_wire220_product_ids WHERE tenant_id=$1 AND public_id=$2', [tenant, pid])).rows[0]?.local_id as string;
const stockRows = async (product: string) =>
  (await pool.query('SELECT warehouse_id,on_hand,reserved FROM stock WHERE product_id=$1 ORDER BY warehouse_id', [product])).rows;
const derivedOf = async (table: string, tenant: string, n: number) =>
  (await pool.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND (('x'||lpad(substr(replace(id::text,'-',''),1,12)||substr(replace(id::text,'-',''),14,1),16,'0'))::bit(64)::bigint+1)=$2`,
    [tenant, n])).rows.map(r => r.id as string);

before(async () => {
  for (const name of ['base_wire220_product_ids', 'base_wire220_warehouse_ids', 'base_wire224_category_ids', 'product_translations', 'purchase_receipts'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 220–225: ' + name);
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY])).rows[0].n, 0, 'Fresh clone required; no rerun');
  // Two writable tenants whose default catalogue has exactly two warehouses (N28 FAIL 3 shape).
  const rows = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND (SELECT count(*) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)=2
    ORDER BY (SELECT plan FROM tenants t WHERE t.id=m.tenant_id)='enterprise' DESC,m.tenant_id LIMIT 2`)).rows;
  assert.equal(rows.length, 2);
  const full = ['inventory:read', 'inventory:write', 'products:read', 'products:write', 'purchasing:read', 'purchasing:write'];
  a = await key(rows[0], full); b = await key(rows[1], full); inventoryOnly = await key(rows[0], ['inventory:read']);
  cid = await publicId('base_wire220_catalog_ids', a.tenant, a.catalog);
  const assigned = (await pool.query('SELECT warehouse_id FROM product_catalog_warehouses WHERE catalog_id=$1', [a.catalog])).rows.map(r => r.warehouse_id as string);
  warehouses = (await Promise.all(assigned.map(async id => ({ id, pid: await publicId('base_wire220_warehouse_ids', a.tenant, id) })))).sort((x, y) => x.pid - y.pid);
  assert.equal(warehouses.length, 2);
  app = Fastify();
  registerBaseWireRoutes(app, { readOnly: false, authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true), families: [
    createBaseWireInventoryFamily({ available: true, service: createDefaultBaseWireInventoryService({ readOnly: false, categories: true, deletions: true }) }),
    createBaseWireWmsFamily({ available: true, service: createDefaultBaseWireWmsService() })] });
  await app.ready();
});
after(async () => { await app?.close(); await pool.end(); });

test('addInventoryProduct without stock in a 2-warehouse catalogue: native product with 0 in the lowest Base warehouse ID; refusals carry their reason', async () => {
  const create = (sku: string, extra: Record<string, unknown> = {}) => wire(a, 'addInventoryProduct', { inventory_id: cid, sku, tax_rate: 23,
    text_fields: { name: 'Bez stanu ' + sku, description: 'Opis' }, prices: { [BASE]: 9.99 }, ...extra });
  const sku = 'N28-' + randomBytes(4).toString('hex');
  const created = success(await create(sku));
  const local = await localProduct(a.tenant, created.product_id);
  assert.deepEqual(await stockRows(local), [{ warehouse_id: warehouses[0].id, on_hand: 0, reserved: 0 }]);
  assert.deepEqual((await pool.query('SELECT kind,catalog_id,price FROM products WHERE id=$1', [local])).rows[0], { kind: 'simple', catalog_id: a.catalog, price: 999 });
  // The same through the Base read: one zero stock cell.
  const read = success(await wire(a, 'getInventoryProductsData', { inventory_id: cid, products: [created.product_id] })).products[String(created.product_id)];
  assert.deepEqual(read.stock, { ['bl_' + warehouses[0].pid]: 0 });
  // `stock: {}` is "no stock"; an explicit single warehouse is honoured.
  const empty = success(await create(sku + '-E', { stock: {} }));
  assert.deepEqual(await stockRows(await localProduct(a.tenant, empty.product_id)), [{ warehouse_id: warehouses[0].id, on_hand: 0, reserved: 0 }]);
  const second = success(await create(sku + '-W', { stock: { ['bl_' + warehouses[1].pid]: 3 } }));
  assert.deepEqual(await stockRows(await localProduct(a.tenant, second.product_id)), [{ warehouse_id: warehouses[1].id, on_hand: 3, reserved: 0 }]);
  // Refusals: the specific Polish reason, nothing created.
  const two = refused(await create(sku + '-2', { stock: { ['bl_' + warehouses[0].pid]: 1, ['bl_' + warehouses[1].pid]: 1 } }), 422);
  assert.deepEqual(two, { status: 'ERROR', error_code: 'LOCAL_BASE_WIRE_422', error_message: 'Podaj stan najwyżej w jednym magazynie katalogu' });
  assert.equal(refused(await create(sku), 409).error_message.length > 0, true, 'duplicate SKU refused natively');
  assert.equal(refused(await wire(b, 'addInventoryProduct', { inventory_id: cid, sku: sku + '-B', text_fields: { name: 'Obcy' }, prices: { [BASE]: 1 } }), 404).error_message,
    'Nie znaleziono własnego katalogu');
  assert.equal((await pool.query("SELECT count(*)::int n FROM products WHERE sku=ANY($1)", [[sku + '-2', sku + '-B']])).rows[0].n, 0);
});

test('getInventoryProductsData returns native translations as name|xx / description|xx; addInventoryProduct refuses them with the reason', async () => {
  const sku = 'N28T-' + randomBytes(4).toString('hex');
  const created = success(await wire(a, 'addInventoryProduct', { inventory_id: cid, sku, text_fields: { name: 'Kubek N28', description: 'Opis PL' }, prices: { [BASE]: 5 } }));
  const local = await localProduct(a.tenant, created.product_id);
  const version = (await pool.query('SELECT version FROM products WHERE id=$1', [local])).rows[0].version as number;
  // Native translation write: bulk edit preview -> confirmed execute (manual receipt provenance).
  const preview: any = await createProductTranslationBulkEditPreview(a.actor, { client_key: randomUUID(), locales: ['en', 'en-gb'], rows: [
    { product_id: local, product_version: version, locale: 'en', translation_version: null, operation: 'set', patch: { name: 'Mug N28', description: 'English mug' } },
    { product_id: local, product_version: version, locale: 'en-gb', translation_version: null, operation: 'set', patch: { name: 'Mug GB', description: '' } }] });
  assert.equal(preview.preview.ready, true, JSON.stringify(preview.preview));
  await executeProductTranslationBulkEdit(a.actor, preview.preview.id, { client_key: randomUUID(), scope_hash: preview.preview.scope_hash, confirmed: true });
  assert.deepEqual((await pool.query('SELECT locale,name FROM product_translations WHERE product_id=$1 ORDER BY locale', [local])).rows,
    [{ locale: 'en', name: 'Mug N28' }, { locale: 'en-gb', name: 'Mug GB' }]);
  const defaultLanguage = (await pool.query('SELECT default_language FROM product_catalogs WHERE id=$1', [a.catalog])).rows[0].default_language as string;
  assert.notEqual(defaultLanguage, 'en');
  const text = async (o: Owner) => success(await wire(o, 'getInventoryProductsData', { inventory_id: cid, products: [created.product_id] })).products[String(created.product_id)]?.text_fields;
  // Unqualified = the native product (default language); en-gb is not a two-letter Base language.
  assert.deepEqual(await text(inventoryOnly), { name: 'Kubek N28', description: 'Opis PL', 'name|en': 'Mug N28', 'description|en': 'English mug' });
  refused(await wire(b, 'getInventoryProductsData', { inventory_id: cid, products: [created.product_id] }), 404);
  // A translation write through Base would bypass the native provenance: refused with the reason, nothing changed.
  const r = refused(await wire(a, 'addInventoryProduct', { inventory_id: cid, product_id: created.product_id, text_fields: { 'name|en': 'Changed' } }), 422);
  assert.deepEqual(r, { status: 'ERROR', error_code: 'LOCAL_BASE_WIRE_UNSUPPORTED_FIELD', error_message: 'Tłumaczenia zapisuje natywna edycja tłumaczeń (podgląd i wykonanie), nie Base API' });
  assert.equal((await pool.query("SELECT name FROM product_translations WHERE product_id=$1 AND locale='en'", [local])).rows[0].name, 'Mug N28');
});

test('PZ of a purchase receipt carries the native purchase cost; manual PZ 0; keys without purchasing:read 0', async () => {
  const sku = 'N28P-' + randomBytes(4).toString('hex'), warehouse = warehouses[0];
  const products = await Promise.all([1, 2].map(async n => {
    const p = await tenantTx(a.tenant, c => createProduct(c, a.actor, productSchema.parse({ name: 'Zakup ' + sku + n, sku: sku + '-' + n, price: 1999, vat: 23,
      catalog_id: a.catalog, warehouse_id: warehouse.id, quantity: 0 })));
    return { id: p.id as string, pid: await publicId('base_wire220_product_ids', a.tenant, p.id) };
  }));
  const supplier = success(await wire(a, 'addInventorySupplier', { name: 'Hurtownia N28 ' + sku.slice(-4) }));
  const order = success(await wire(a, 'addInventoryPurchaseOrder', { warehouse_id: warehouse.pid, supplier_id: supplier.supplier_id, currency: 'PLN', name: 'PO N28' }));
  success(await wire(a, 'addInventoryPurchaseOrderItems', { order_id: order.order_id, items: [
    { product_id: products[0].pid, quantity: 10, item_cost: 12.5 }, { product_id: products[1].pid, quantity: 5, item_cost: 3.33 }] }));
  success(await wire(a, 'setInventoryPurchaseOrderStatus', { order_id: order.order_id, status: 1 }));
  success(await wire(a, 'setInventoryPurchaseOrderStatus', { order_id: order.order_id, status: 4,
    completed_items: [{ item_id: products[0].pid, completed_quantity: 4 }, { item_id: products[1].pid, completed_quantity: 3 }] }));
  const [orderId] = await derivedOf('purchase_orders', a.tenant, order.order_id);
  assert.equal((await pool.query('SELECT count(*)::int n FROM purchase_receipts WHERE order_id=$1', [orderId])).rows[0].n, 1);
  const docs = async (o: Owner) => success(await wire(o, 'getInventoryDocuments', { filter_source_object_type: 2, filter_source_object_id: order.order_id })).documents;
  const pz = await docs(a);
  assert.deepEqual(pz.map((d: any) => [d.document_type, d.document_status, d.source_object_id, d.total_quantity, d.total_price]), [[0, 1, order.order_id, 7, 59.99]]);
  const items = async (o: Owner, id: number) => success(await wire(o, 'getInventoryDocumentItems', { document_id: id })).items
    .map((i: any) => [i.product_id, i.quantity, i.price, i.total_price]).sort((x: any, y: any) => x[0] - y[0]);
  assert.deepEqual(await items(a, pz[0].document_id), [[products[0].pid, 4, 12.5, 50], [products[1].pid, 3, 3.33, 9.99]]);
  // Same native cost as the purchase order lines (getInventoryPurchaseOrderItems item_cost).
  assert.deepEqual(success(await wire(a, 'getInventoryPurchaseOrderItems', { order_id: order.order_id })).items.map((l: any) => l.item_cost).sort(), [12.5, 3.33]);
  // A key without purchasing:read sees the PZ but not the purchase cost.
  assert.deepEqual((await docs(inventoryOnly)).map((d: any) => d.total_price), [0]);
  assert.deepEqual(await items(inventoryOnly, pz[0].document_id), [[products[0].pid, 4, 0, 0], [products[1].pid, 3, 0, 0]]);
  // Manual PZ: no native unit cost, 0 for every key.
  const manual = success(await wire(a, 'addInventoryDocument', { warehouse_id: warehouse.pid, document_type: 0 }));
  success(await wire(a, 'addInventoryDocumentItems', { document_id: manual.document_id, items: [{ product_id: products[0].pid, quantity: 2 }] }));
  success(await wire(a, 'setInventoryDocumentStatusConfirmed', { document_id: manual.document_id }));
  const listed = success(await wire(a, 'getInventoryDocuments', { filter_document_id: manual.document_id })).documents;
  assert.deepEqual(listed.map((d: any) => [d.document_status, d.source_object_type, d.total_price]), [[1, 0, 0]]);
  assert.deepEqual(await items(a, manual.document_id), [[products[0].pid, 2, 0, 0]]);
  // Isolation: the other tenant does not see the receipt.
  assert.deepEqual(await docs(b), []);
});
