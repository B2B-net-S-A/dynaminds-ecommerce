/** Real Fastify injection + real developer key gate + real 220 sidecars + the native
 * warehouse documents, purchasing and stocktakes (createWarehouseDocument/edit/post,
 * supplierSave, purchaseSave/Action/Receipt, createStocktake). Root-only execution on a fresh
 * disposable clone dynaminds_wirewms_20261023_NN made from the clean restore template with
 * 218–221 applied by the guarded applier (nine native guards before and after). The suite
 * writes, so a rerun requires a NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { pool, tenantTx } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireWmsFamily, baseWireWmsId } from '../server/base-wire-wms';
import { createDefaultBaseWireWmsService } from '../server/base-wire-wms-runtime';
import { createProduct } from '../server/catalog';
import { productSchema, type Actor } from '../server/domain';
import { warehouseDetail } from '../server/warehouse';
import { purchaseDetail } from '../server/purchasing';
import { createStocktake, stocktakeInput } from '../server/stocktakes';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_wirewms_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; actor: Actor };
let app: ReturnType<typeof Fastify>, a: Owner, b: Owner, readOnlyKey: Owner;
const FULL = ['inventory:read', 'inventory:write', 'purchasing:read', 'purchasing:write'];
async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,'Isolated wire WMS test',$4,$5,$6,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), scopes]);
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
const derivedOf = async (table: string, tenant: string, publicNumber: number) =>
  (await pool.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND (('x'||lpad(substr(replace(id::text,'-',''),1,12)||substr(replace(id::text,'-',''),14,1),16,'0'))::bit(64)::bigint+1)=$2`,
    [tenant, publicNumber])).rows.map(r => r.id as string);
const count = async (sql: string, params: unknown[]) => (await pool.query(`SELECT count(*)::int n FROM ${sql}`, params)).rows[0].n as number;
const onHand = async (o: Owner, product: string) =>
  (await pool.query('SELECT on_hand FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [o.tenant, o.warehouse, product])).rows[0]?.on_hand as number;
async function product(o: Owner) {
  const sku = 'WMS-' + randomBytes(4).toString('hex');
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 5 })));
  return { id: p.id as string, sku, pid: await publicId('base_wire220_product_ids', o.tenant, p.id), wid: await publicId('base_wire220_warehouse_ids', o.tenant, o.warehouse) };
}

before(async () => {
  for (const name of ['base_wire220_product_ids', 'base_wire220_warehouse_ids', 'warehouse_documents', 'purchase_orders', 'suppliers', 'stocktakes'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 220 and WMS: ' + name);
  assert.equal((await pool.query("SELECT count(*)::int n FROM api_keys WHERE name='Isolated wire WMS test'")).rows[0].n, 0, 'Fresh clone required; no rerun');
  const rows = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND EXISTS(SELECT 1 FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)
    ORDER BY (SELECT plan FROM tenants t WHERE t.id=m.tenant_id)='enterprise' DESC,m.tenant_id LIMIT 2`)).rows;
  assert.equal(rows.length, 2);
  a = await key(rows[0], FULL); b = await key(rows[1], FULL);
  readOnlyKey = await key(rows[0], ['inventory:read', 'purchasing:read']);
  app = Fastify();
  registerBaseWireRoutes(app, { readOnly: false, families: [createBaseWireWmsFamily({ available: true, service: createDefaultBaseWireWmsService() })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await app.ready();
});
after(async () => { await app?.close(); await pool.end(); });

test('Base PZ: addInventoryDocument + items + confirm -> native stock exactly once; replay safe; isolation; read-only refused', async () => {
  const p = await product(a), location = 'W' + randomBytes(3).toString('hex').toUpperCase();
  const before = await onHand(a, p.id);
  refused(await wire(readOnlyKey, 'addInventoryDocument', { warehouse_id: p.wid, document_type: 0 }), 403);
  refused(await wire(a, 'addInventoryDocument', { warehouse_id: p.wid, document_type: 1 }), 422);
  const created = success(await wire(a, 'addInventoryDocument', { warehouse_id: p.wid, document_type: 0, invoice_no: 'FV/1/2026', notes: 'Dostawa Base' }));
  assert.deepEqual(Object.keys(created).sort(), ['document_id', 'document_number', 'status']);
  const [docId] = await derivedOf('warehouse_documents', a.tenant, created.document_id);
  assert.ok(docId, 'document_id derived from the native UUID');
  assert.equal(created.document_id, baseWireWmsId(docId));
  let native = await tenantTx(a.tenant, c => warehouseDetail(c, docId));
  assert.deepEqual({ kind: native.kind, status: native.status, reference: native.reference, note: native.note, lines: native.lines.length, number: native.number },
    { kind: 'receipt', status: 'draft', reference: 'FV/1/2026', note: 'Dostawa Base', lines: 0, number: created.document_number });
  // An empty draft is never confirmed; a foreign tenant cannot touch it.
  refused(await wire(a, 'setInventoryDocumentStatusConfirmed', { document_id: created.document_id }), 422);
  refused(await wire(b, 'addInventoryDocumentItems', { document_id: created.document_id, items: [{ product_id: p.pid, quantity: 3 }] }), 404);
  refused(await wire(a, 'addInventoryDocumentItems', { document_id: created.document_id, items: [{ product_id: p.pid, quantity: 3, batch: 'L1' }] }), 422);

  const items = success(await wire(a, 'addInventoryDocumentItems', { document_id: created.document_id, items: [{ product_id: p.pid, quantity: 3, location_name: location }] }));
  assert.deepEqual(items.items, [{ item_id: p.pid, position: 1 }]);
  refused(await wire(a, 'addInventoryDocumentItems', { document_id: created.document_id, items: [{ product_id: p.pid, quantity: 1 }] }), 409);
  native = await tenantTx(a.tenant, c => warehouseDetail(c, docId));
  assert.deepEqual(native.lines.map((l: any) => [l.product_id, l.quantity, l.location]), [[p.id, 3, location]]);
  assert.equal(await onHand(a, p.id), before, 'a draft changes no stock');
  const draft = success(await wire(readOnlyKey, 'getInventoryDocuments', { filter_document_id: created.document_id })).documents;
  assert.equal(draft.length, 1);
  assert.deepEqual({ type: draft[0].document_type, status: draft[0].document_status, confirmed: draft[0].date_confirmed, items: draft[0].items_count, quantity: draft[0].total_quantity, wh: draft[0].warehouse_id },
    { type: 0, status: 0, confirmed: 0, items: 1, quantity: 3, wh: p.wid });

  refused(await wire(readOnlyKey, 'setInventoryDocumentStatusConfirmed', { document_id: created.document_id }), 403);
  refused(await wire(b, 'setInventoryDocumentStatusConfirmed', { document_id: created.document_id }), 404);
  const confirmKey = randomUUID();
  success(await wire(a, 'setInventoryDocumentStatusConfirmed', { document_id: created.document_id }, { 'idempotency-key': confirmKey }));
  assert.equal(await onHand(a, p.id), before + 3);
  // Lost-ACK replay with the key and a plain repeat: still exactly one stock effect.
  success(await wire(a, 'setInventoryDocumentStatusConfirmed', { document_id: created.document_id }, { 'idempotency-key': confirmKey }));
  success(await wire(a, 'setInventoryDocumentStatusConfirmed', { document_id: created.document_id }));
  assert.equal(await onHand(a, p.id), before + 3, 'stock effect exactly once');
  assert.equal(await count('stock_movements WHERE warehouse_document_id=$1', [docId]), 1);
  native = await tenantTx(a.tenant, c => warehouseDetail(c, docId));
  assert.equal(native.status, 'posted');
  const posted = success(await wire(a, 'getInventoryDocuments', { filter_document_id: created.document_id, filter_document_status: 1 })).documents[0];
  assert.equal(posted.document_status, 1); assert.ok(posted.date_confirmed > 0);
  assert.deepEqual(success(await wire(b, 'getInventoryDocuments', { filter_document_id: created.document_id })).documents, []);
  const lines = success(await wire(a, 'getInventoryDocumentItems', { document_id: created.document_id })).items;
  assert.deepEqual(lines.map((l: any) => [l.item_id, l.document_id, l.position, l.product_id, l.product_sku, l.quantity, l.location_name]),
    [[p.pid, created.document_id, 1, p.pid, p.sku, 3, location]]);
  refused(await wire(a, 'addInventoryDocumentItems', { document_id: created.document_id, items: [{ product_id: p.pid, quantity: 1 }] }), 409);

  // Native stocktake over the new location is visible through the stocktake reads.
  const st = await tenantTx(a.tenant, c => createStocktake(c, a.actor, stocktakeInput.parse({ warehouse_id: a.warehouse, name: 'Spis Base ' + location, location_prefix: location, client_key: randomUUID() })));
  const stocktake = success(await wire(readOnlyKey, 'getInventoryStocktakes', { filter_stocktake_id: baseWireWmsId(st.id) })).stocktakes;
  assert.deepEqual(stocktake.map((s: any) => [s.stocktake_status, s.items_count, s.verified_items_count, s.warehouse_id]), [[2, 1, 0, p.wid]]);
  const counted = success(await wire(readOnlyKey, 'getInventoryStocktakeItems', { stocktake_id: baseWireWmsId(st.id) })).items;
  assert.deepEqual(counted.map((l: any) => [l.product_id, l.quantity, l.is_verified, l.location_name]), [[p.pid, 3, false, location]]);
  refused(await wire(b, 'getInventoryStocktakeItems', { stocktake_id: baseWireWmsId(st.id) }), 404);
});

test('Base supplier + purchase order -> native PO, status changes, receipt PZ exactly once, isolation', async () => {
  const p = await product(a), before = await onHand(a, p.id);
  refused(await wire(readOnlyKey, 'addInventorySupplier', { name: 'Hurtownia Base' }), 403);
  refused(await wire(a, 'addInventorySupplier', { name: 'Hurtownia Base', city: 'Łódź' }), 422);
  const supplier = success(await wire(a, 'addInventorySupplier', { name: 'Hurtownia Base', email: 'zakupy@example.com', phone: '500100200', tax_no: '1234567890', address: 'Prosta 2' }));
  const [supplierId] = await derivedOf('suppliers', a.tenant, supplier.supplier_id);
  assert.ok(supplierId);
  assert.deepEqual((await pool.query('SELECT name,email,phone,tax_id,address,active FROM suppliers WHERE id=$1', [supplierId])).rows[0],
    { name: 'Hurtownia Base', email: 'zakupy@example.com', phone: '500100200', tax_id: '1234567890', address: 'Prosta 2', active: true });
  success(await wire(a, 'addInventorySupplier', { supplier_id: supplier.supplier_id, phone: '500100201' }));
  const listed = success(await wire(readOnlyKey, 'getInventorySuppliers', { filter_id: supplier.supplier_id })).suppliers;
  assert.deepEqual(listed, [{ supplier_id: supplier.supplier_id, name: 'Hurtownia Base', address: 'Prosta 2', postcode: '', city: '', phone: '500100201',
    email: 'zakupy@example.com', email_copy_to: '', currency: '', tax_no: '1234567890' }]);
  assert.deepEqual(success(await wire(a, 'getInventorySuppliers', { filter_name: 'hurtownia base' })).suppliers.map((s: any) => s.supplier_id).includes(supplier.supplier_id), true);
  assert.deepEqual(success(await wire(b, 'getInventorySuppliers', { filter_id: supplier.supplier_id })).suppliers, []);

  refused(await wire(b, 'addInventoryPurchaseOrder', { warehouse_id: p.wid, supplier_id: supplier.supplier_id, currency: 'PLN' }), 404);
  const poKey = randomUUID(), po = { warehouse_id: p.wid, supplier_id: supplier.supplier_id, payer_id: 0, currency: 'PLN', name: 'Zamówienie Base', notes: 'Pilne' };
  const order = success(await wire(a, 'addInventoryPurchaseOrder', po, { 'idempotency-key': poKey }));
  assert.deepEqual(success(await wire(a, 'addInventoryPurchaseOrder', po, { 'idempotency-key': poKey })), order);
  const [orderId] = await derivedOf('purchase_orders', a.tenant, order.order_id);
  assert.equal(await count('purchase_orders WHERE tenant_id=$1 AND supplier_id=$2', [a.tenant, supplierId]), 1, 'one native PO for the replayed create');
  success(await wire(a, 'addInventoryPurchaseOrderItems', { order_id: order.order_id, items: [{ product_id: p.pid, quantity: 4, item_cost: 12.5, supplier_code: 'HB-1' }] }));
  const more = success(await wire(a, 'addInventoryPurchaseOrderItems', { order_id: order.order_id, items: [{ product_id: p.pid, quantity: 2, item_cost: 12.5, supplier_code: 'HB-1' }] }));
  assert.deepEqual(more.items, [{ item_id: p.pid, position: 1 }]);
  refused(await wire(a, 'addInventoryPurchaseOrderItems', { order_id: order.order_id, items: [{ product_id: p.pid, quantity: 1, item_cost: 13 }] }), 409);
  let native = await tenantTx(a.tenant, c => purchaseDetail(c, orderId));
  assert.deepEqual({ state: native.state, number: native.number, reference: native.reference, note: native.note, supplier: native.supplier_id,
    lines: native.lines.map((l: any) => [l.product_id, l.quantity, l.unit_cost, l.supplier_sku]) },
  { state: 'draft', number: order.document_number, reference: 'Zamówienie Base', note: 'Pilne', supplier: supplierId, lines: [[p.id, 6, 1250, 'HB-1']] });

  refused(await wire(readOnlyKey, 'setInventoryPurchaseOrderStatus', { order_id: order.order_id, status: 1 }), 403);
  refused(await wire(b, 'setInventoryPurchaseOrderStatus', { order_id: order.order_id, status: 1 }), 404);
  success(await wire(a, 'setInventoryPurchaseOrderStatus', { order_id: order.order_id, status: 1 }));
  assert.equal((await tenantTx(a.tenant, c => purchaseDetail(c, orderId))).state, 'ordered');
  let listedPo = success(await wire(readOnlyKey, 'getInventoryPurchaseOrders', { supplier_id: supplier.supplier_id })).purchase_orders;
  assert.deepEqual(listedPo.map((x: any) => [x.id, x.status, x.total_quantity, x.total_cost, x.warehouse_id, x.supplier_id, x.name, x.document_number]),
    [[order.order_id, 1, 6, 75, p.wid, supplier.supplier_id, 'Zamówienie Base', order.document_number]]);
  assert.ok(listedPo[0].date_sent > 0);

  // Partial receipt: absolute completed_quantity 2 -> one native PZ, stock +2; the same call again receives nothing.
  const partial = { order_id: order.order_id, status: 4, completed_items: [{ item_id: p.pid, completed_quantity: 2 }] };
  success(await wire(a, 'setInventoryPurchaseOrderStatus', partial));
  success(await wire(a, 'setInventoryPurchaseOrderStatus', partial));
  assert.equal(await onHand(a, p.id), before + 2, 'receipt stock effect exactly once');
  assert.equal(await count('purchase_receipts WHERE order_id=$1', [orderId]), 1);
  native = await tenantTx(a.tenant, c => purchaseDetail(c, orderId));
  assert.deepEqual([native.state, native.lines[0].received_quantity], ['partial', 2]);
  const receiptDocs = success(await wire(a, 'getInventoryDocuments', { filter_source_object_type: 2, filter_source_object_id: order.order_id })).documents;
  assert.deepEqual(receiptDocs.map((d: any) => [d.document_type, d.document_status, d.source_object_type, d.source_object_id, d.total_quantity]),
    [[0, 1, 2, order.order_id, 2]]);
  assert.deepEqual(success(await wire(a, 'getInventoryPurchaseOrderItems', { order_id: order.order_id })).items.map((l: any) => [l.item_id, l.quantity, l.completed_quantity, l.item_cost, l.supplier_code]),
    [[p.pid, 6, 2, 12.5, 'HB-1']]);
  refused(await wire(a, 'setInventoryPurchaseOrderStatus', { order_id: order.order_id, status: 4, completed_items: [{ item_id: p.pid, completed_quantity: 1 }] }), 409);
  refused(await wire(a, 'setInventoryPurchaseOrderStatus', { order_id: order.order_id, status: 2 }), 422);

  // Completed: the open remainder is closed natively; Base reads status 3.
  success(await wire(a, 'setInventoryPurchaseOrderStatus', { order_id: order.order_id, status: 3 }));
  native = await tenantTx(a.tenant, c => purchaseDetail(c, orderId));
  assert.deepEqual([native.state, native.lines[0].closed_quantity], ['closed', 4]);
  listedPo = success(await wire(a, 'getInventoryPurchaseOrders', { supplier_id: supplier.supplier_id })).purchase_orders;
  assert.deepEqual(listedPo.map((x: any) => [x.status, x.completed_total_quantity, x.completed_total_cost]), [[3, 2, 25]]);
  refused(await wire(a, 'setInventoryPurchaseOrderStatus', { order_id: order.order_id, status: 5 }), 409);
  assert.equal(await onHand(a, p.id), before + 2);
  refused(await wire(b, 'getInventoryPurchaseOrderItems', { order_id: order.order_id }), 404);
  assert.deepEqual(success(await wire(b, 'getInventoryPurchaseOrders', { supplier_id: supplier.supplier_id })).purchase_orders, []);
});
