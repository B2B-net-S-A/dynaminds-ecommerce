/** Real Fastify injection + real developer key gate + real 220 sidecars + the
 * native local invoices (157: series, preview, issue, continuous numbering) and the
 * native OMS/WMS path to a shipped order (addOrder, picking, scan, packing, shipDemo).
 * Root-only execution on a fresh disposable clone dynaminds_wireinv_20261023_NN made
 * from the clean 217+218+219 template with 220 applied by the guarded applier (nine
 * native guards before and after). The suite issues invoices, so a rerun requires a NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { pool, tenantTx } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireOrdersFamily } from '../server/base-wire-orders';
import { createDefaultBaseWireOrdersService } from '../server/base-wire-orders-runtime';
import { createBaseWireInvoicesFamily } from '../server/base-wire-invoices';
import { createDefaultBaseWireInvoicesService } from '../server/base-wire-invoices-runtime';
import { createProduct } from '../server/catalog';
import { productSchema, scan, shipDemo, type Actor } from '../server/domain';
import { transitionDirectLegacyOnReturnInTx } from '../server/legacy-return-on-command';
import { createLocalInvoiceSeries, previewLocalInvoice, issueLocalInvoice, localInvoiceDetail, localInvoiceRegister, localInvoiceRequestActor } from '../server/local-invoices';
import { localInvoicePrintHtml } from '../server/local-invoice-print';
import type { LocalInvoiceActor } from '../server/local-invoice-values';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_wireinv_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
const KEY_NAME = 'Isolated wire invoices test';
const ALL = ['orders:read', 'orders:write', 'documents:read', 'documents:write'];
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; keyId: string; actor: Actor };
let app: ReturnType<typeof Fastify>, a: Owner, b: Owner, readOnlyKey: Owner, noOrdersKey: Owner, series: { id: string; prefix: string; public: number };
async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$7,$4,$5,$6,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), scopes, KEY_NAME]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, token, keyId: id,
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
/** The native /api/v1/local-invoices request actor of this key (Bearer custody). */
const invoiceActor = (o: Owner): LocalInvoiceActor => localInvoiceRequestActor({ actor: { tenantId: o.tenant, userId: o.user, role: 'admin', source: 'api', apiKeyId: o.keyId },
  apiKeyId: o.keyId, currentUser: { id: o.user, tenant_id: o.tenant }, headers: { authorization: 'Bearer ' + o.token }, cookies: {} }, 'dyna_session');
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
const localOrder = async (tenant: string, publicOrder: number) =>
  (await pool.query('SELECT local_id FROM base_wire220_order_ids WHERE tenant_id=$1 AND public_id=$2', [tenant, publicOrder])).rows[0]?.local_id as string;
const count = async (sql: string, params: unknown[]) => (await pool.query(`SELECT count(*)::int n FROM ${sql}`, params)).rows[0].n as number;
const lastNumber = async () => Number((await pool.query("SELECT coalesce(max(last_number),0)::int n FROM local_invoice_counters WHERE series_id=$1 AND year=extract(year FROM clock_timestamp() AT TIME ZONE 'UTC')", [series.id])).rows[0].n);
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
/** Base addOrder (paid=1) and the native path to "shipped": picking, scans, packing, shipDemo. */
async function shippedBaseOrder(o: Owner) {
  const sku = 'WI-' + randomBytes(4).toString('hex');
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 10 })));
  const pid = await publicId('base_wire220_product_ids', o.tenant, p.id), wid = await publicId('base_wire220_warehouse_ids', o.tenant, o.warehouse);
  const order = success(await wire(o, 'addOrder', { delivery_fullname: 'Jan Base', email: 'base@example.com', phone: '500600700', delivery_address: 'Prosta 1',
    delivery_postcode: '00-001', delivery_city: 'Warszawa', delivery_country_code: 'PL', currency: 'PLN', paid: 1, delivery_price: 10,
    products: [{ storage: 'db', product_id: String(pid), warehouse_id: wid, price_brutto: 25.5, tax_rate: 23, quantity: 2 }] })).order_id as number;
  const local = await localOrder(o.tenant, order);
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  for (let n = 0; n < 2; n++) await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [local])).rows[0].status, 'shipped');
  return { order, local };
}

before(async () => {
  for (const name of ['base_wire220_order_ids', 'base_wire220_invoice_ids', 'base_wire220_invoice_series_ids', 'base_wire220_product_ids'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 220: ' + name);
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY_NAME])).rows[0].n, 0, 'Fresh clone required; no rerun');
  const rows = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE (SELECT currency FROM tenants t WHERE t.id=m.tenant_id)='PLN'
    AND NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND EXISTS(SELECT 1 FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)
    ORDER BY (SELECT plan FROM tenants t WHERE t.id=m.tenant_id)='enterprise' DESC,m.tenant_id LIMIT 2`)).rows;
  assert.equal(rows.length, 2);
  a = await key(rows[0], ALL); b = await key(rows[1], ALL);
  readOnlyKey = await key(rows[0], ['orders:read', 'documents:read']);
  noOrdersKey = await key(rows[0], ['documents:read', 'documents:write']);
  app = Fastify();
  registerBaseWireRoutes(app, { readOnly: false, families: [
    createBaseWireOrdersFamily({ available: true, service: createDefaultBaseWireOrdersService({ readOnly: false, mergeClaims: true }) }),
    createBaseWireInvoicesFamily({ available: true, service: createDefaultBaseWireInvoicesService({ readOnly: false }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await app.ready();
  // A native series (POST /api/local-invoices/series) created by the admin key of A.
  const prefix = 'BW' + randomBytes(3).toString('hex').toUpperCase();
  const created = await createLocalInvoiceSeries(invoiceActor(a), { client_key: randomUUID(), name: 'Seria Base ' + prefix, prefix,
    seller: { name: 'Sprzedawca testowy', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: '5260250274' },
    payment_terms_days: 14, payment_instructions: 'Przelew', notes: 'Dziękujemy', seller_vat_status: 'active_domestic' });
  series = { id: created.series.id, prefix, public: 0 };
});
after(async () => { await app?.close(); await pool.end(); });

test('getSeries lists the own native series with a numeric id; the second tenant does not see it', async () => {
  const got = success(await wire(a, 'getSeries', {})).series;
  series.public = await publicId('base_wire220_invoice_series_ids', a.tenant, series.id);
  assert(Number.isSafeInteger(series.public) && series.public > 0);
  assert.deepEqual(got.find((s: any) => s.id === series.public), { id: series.public, type: 'INVOICE', name: 'Seria Base ' + series.prefix, format: series.prefix + '/%Y/%N' });
  assert.equal(got.length, await count('local_invoice_series WHERE tenant_id=$1', [a.tenant]));
  assert(!success(await wire(b, 'getSeries', {})).series.some((s: any) => s.id === series.public));
  success(await wire(readOnlyKey, 'getSeries', {}));
  refused(await wire(noOrdersKey, 'getSeries', {}), 403);
});

test('Base addOrder -> addInvoice issues ONE native invoice with the next native number; replay and duplicates add nothing', async () => {
  const x = await shippedBaseOrder(a);
  const before = await lastNumber(), docs = await count("documents WHERE tenant_id=$1 AND mode='local_invoice'", [a.tenant]);
  // Read-only keys, keys without orders:read, foreign callers and unsupported VAT have no effect.
  refused(await wire(readOnlyKey, 'addInvoice', { order_id: x.order, series_id: series.public }), 403);
  refused(await wire(noOrdersKey, 'addInvoice', { order_id: x.order, series_id: series.public }), 403);
  refused(await wire(b, 'addInvoice', { order_id: x.order, series_id: series.public }), 404);
  assert.equal(refused(await wire(a, 'addInvoice', { order_id: x.order, series_id: series.public, vat_rate: 'ZW' }), 422).error_code, 'LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  refused(await wire(a, 'addInvoice', { order_id: x.order, series_id: series.public, number: 'FV/1/2026' }), 422);
  assert.equal(await count("documents WHERE order_id=$1 AND mode='local_invoice'", [x.local]), 0);
  const clientKey = randomUUID();
  const first = success(await wire(a, 'addInvoice', { order_id: x.order, series_id: series.public }, { 'idempotency-key': clientKey }));
  assert.deepEqual(Object.keys(first).sort(), ['invoice_id', 'status']);
  const doc = (await pool.query("SELECT d.id,d.number,d.data,r.sequence,r.year,r.api_key_id FROM documents d JOIN local_invoice_receipts r ON r.document_id=d.id WHERE d.order_id=$1 AND d.mode='local_invoice'", [x.local])).rows;
  assert.equal(doc.length, 1, 'one native local invoice');
  const year = doc[0].year as number;
  assert.equal(doc[0].sequence, before + 1, 'next native number of the series');
  assert.equal(doc[0].number, `${series.prefix}/${year}/${String(before + 1).padStart(6, '0')}`);
  assert.equal(doc[0].api_key_id, a.keyId);
  assert.equal(first.invoice_id, await publicId('base_wire220_invoice_ids', a.tenant, doc[0].id), 'returned id is the 220 invoice id');
  assert.deepEqual(doc[0].data.buyer, { kind: 'consumer', tax_id: '', name: 'Jan Base', email: 'base@example.com', address: { street: 'Prosta 1', postal_code: '00-001', city: 'Warszawa', country: 'PL' } });
  assert.equal(doc[0].data.totals.gross_minor, '6100');
  assert.deepEqual(doc[0].data.lines.map((l: any) => [l.kind, l.vat_rate, l.gross_minor]), [['item', 23, '5100'], ['shipping', 23, '1000']]);
  assert.equal(doc[0].data.sell_date, (await pool.query("SELECT to_char(min(created_at) AT TIME ZONE 'UTC','YYYY-MM-DD') d FROM order_events WHERE order_id=$1 AND kind='order.shipped'", [x.local])).rows[0].d);
  assert.equal(await count("audit_events WHERE entity_id=$1 AND action='local_invoice.issue'", [doc[0].id]), 1);
  // Lost-ACK replay: same answer, no second invoice or number; another body under the key is 409.
  assert.deepEqual(success(await wire(a, 'addInvoice', { order_id: x.order, series_id: series.public }, { 'idempotency-key': clientKey })), first);
  refused(await wire(a, 'addInvoice', { order_id: x.order, series_id: series.public, vat_rate: 'ITEM' }, { 'idempotency-key': clientKey }), 409);
  // Without a key the native one-invoice-per-order rule refuses a second document.
  refused(await wire(a, 'addInvoice', { order_id: x.order, series_id: series.public }), 409);
  assert.equal(await count("documents WHERE tenant_id=$1 AND mode='local_invoice'", [a.tenant]), docs + 1);
  assert.equal(await lastNumber(), before + 1, 'refused attempts consume no number');
  // The native register and detail (UI/REST) see the Base-created invoice.
  const detail = await localInvoiceDetail(invoiceActor(a), doc[0].id);
  assert.equal(detail.document.number, doc[0].number);
  assert((await localInvoiceRegister(invoiceActor(a))).data.some(d => d.id === doc[0].id));
  // Base reads: getInvoices by id and by order, file = base64 of the native print page.
  const listed = success(await wire(readOnlyKey, 'getInvoices', { order_id: x.order })).invoices;
  assert.deepEqual(listed.map((i: any) => [i.invoice_id, i.order_id, i.series_id, i.number, i.sub_id, i.year, i.total_price_brutto]),
    [[first.invoice_id, x.order, series.public, doc[0].number, before + 1, year, 61]]);
  const file = success(await wire(readOnlyKey, 'getInvoiceFile', { invoice_id: first.invoice_id }));
  assert.equal(file.invoice_number, doc[0].number);
  assert(file.invoice.startsWith('data:'));
  assert.equal(Buffer.from(file.invoice.slice(5), 'base64').toString('utf8'), localInvoicePrintHtml(detail.document));
  refused(await wire(b, 'getInvoiceFile', { invoice_id: first.invoice_id }), 404);
  assert.deepEqual(success(await wire(b, 'getInvoices', { invoice_id: first.invoice_id })).invoices, []);
});

test('getInvoices sees a natively issued invoice with a stable numeric id; the second tenant is isolated', async () => {
  const x = await shippedBaseOrder(a), native = invoiceActor(a);
  const o = (await pool.query('SELECT version::text v FROM orders WHERE id=$1', [x.local])).rows[0].v;
  const p = await previewLocalInvoice(native, x.local, { client_key: randomUUID(), series_id: series.id, order_version: o, shipping_vat: 23,
    buyer: { kind: 'consumer', name: 'Klient natywny', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' },
    sell_date: new Date().toISOString().slice(0, 10), tax_regime: 'ordinary_domestic', consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true });
  const issued = await issueLocalInvoice(native, p.preview.id, { client_key: randomUUID(), scope_hash: p.preview.scope_hash, confirmed: true, local_only: true });
  assert.equal(await count('base_wire220_invoice_ids WHERE local_id=$1', [issued.document.id]), 0, 'documents have no insert trigger');
  const page = success(await wire(a, 'getInvoices', { date_from: Math.floor(Date.now() / 1000) - 3600 })).invoices;
  const id = await publicId('base_wire220_invoice_ids', a.tenant, issued.document.id);
  assert(Number.isSafeInteger(id) && id > 0);
  const dto = page.find((i: any) => i.invoice_id === id);
  assert(dto, 'native invoice listed');
  assert.deepEqual([dto.order_id, dto.series_id, dto.number, dto.invoice_fullname, dto.invoice_address, dto.invoice_country_code, dto.type, dto.month],
    [x.order, series.public, issued.document.number, 'Klient natywny', 'Długa 5', 'PL', 'normal', 0]);
  assert.deepEqual(dto.items.map((i: any) => [i.quantity, i.price_brutto, i.tax_rate, i.is_shipment]), [[2, 25.5, 23, 0], [1, 10, 23, 1]]);
  for (let n = 1; n < page.length; n++) assert(page[n - 1].invoice_id < page[n].invoice_id, 'ascending invoice_id');
  // Stable: the next read (and id_from) returns the same identity.
  assert.deepEqual(success(await wire(a, 'getInvoices', { invoice_id: id })).invoices.map((i: any) => i.invoice_id), [id]);
  assert.equal(success(await wire(a, 'getInvoices', { id_from: id })).invoices[0].invoice_id, id, 'id_from is inclusive');
  assert.deepEqual(success(await wire(a, 'getInvoices', { series_id: series.public })).invoices.map((i: any) => i.series_id).filter((s: number) => s !== series.public), []);
  const native2 = Buffer.from(success(await wire(a, 'getInvoiceFile', { invoice_id: id, get_external: true })).invoice.slice(5), 'base64').toString('utf8');
  assert.equal(native2, localInvoicePrintHtml((await localInvoiceDetail(native, issued.document.id)).document));
  assert.equal(refused(await wire(a, 'getInvoices', { get_government_data: true }), 422).error_code, 'LOCAL_BASE_WIRE_UNSUPPORTED_FLAG');
  refused(await wire(noOrdersKey, 'getInvoices', {}), 403);
  const foreign = success(await wire(b, 'getInvoices', {})).invoices;
  assert(!foreign.some((i: any) => i.invoice_id === id));
  assert.equal(foreign.length, Math.min(100, await count("documents WHERE tenant_id=$1 AND mode='local_invoice'", [b.tenant])));
});
