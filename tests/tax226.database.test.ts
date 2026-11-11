/** Native 226 tax model on a real disposable clone: the actual session routes
 * (Fastify injection with the request actor the auth hook would set) for the product
 * tax profile and OSS settings, the native local invoice preview (157) and the issue
 * with the per-line tax snapshot (tax-issue), the Base addInvoice snapshot step and
 * a natively issued invoice without a snapshot. Every expectation is read back from
 * the native rows. Root-only execution on a fresh clone dynaminds_tax226_20261023_NN
 * made from the clean 217 template with 218–226 by the guarded applier. The suite
 * issues invoices; rerun = NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tenantTx } from '../server/db';
import { Problem } from '../server/errors';
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
import { createLocalInvoiceSeries, previewLocalInvoice, issueLocalInvoice, localInvoiceRequestActor } from '../server/local-invoices';
import { registerTax226Routes } from '../server/tax226-routes';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_tax226_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 20000;
const KEY_NAME = 'Isolated tax model 226 test';
const ALL = ['orders:read', 'orders:write', 'documents:read', 'documents:write', 'products:read', 'products:write'];
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; keyId: string; actor: Actor };
let session: FastifyInstance, wire: FastifyInstance, a: Owner, b: Owner, readKey: Owner, series: { id: string; prefix: string; public: number };

async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$7,$4,$5,$6,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), scopes, KEY_NAME]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, token, keyId: id,
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
/** Bearer-key request as the developer API hook would set it. */
function call(o: Owner, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown, role: Actor['role'] = 'admin') {
  const headers = { authorization: 'Bearer ' + o.token, 'x-test-as': JSON.stringify({ tenant: o.tenant, user: o.user, role, key: o.keyId }) };
  return session.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
}
const nativeActor = (o: Owner) => localInvoiceRequestActor({ actor: { tenantId: o.tenant, userId: o.user, role: 'admin', source: 'api', apiKeyId: o.keyId },
  apiKeyId: o.keyId, currentUser: { id: o.user, tenant_id: o.tenant }, headers: { authorization: 'Bearer ' + o.token }, cookies: {} }, 'dyna_session');
const ok = (r: any, status = 200) => { assert.equal(r.statusCode, status, r.body); return r.json(); };
const refused = (r: any, status: number, pattern?: RegExp) => { assert.equal(r.statusCode, status, r.body); assert(!/SELECT |stack|dyna_api_/.test(r.body), r.body);
  if (pattern) assert.match(r.json().error, pattern); return r.json(); };
const baseOk = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const publicId = async (table: string, tenant: string, local: string) =>
  Number((await pool.query(`SELECT public_id::text p FROM ${table} WHERE tenant_id=$1 AND local_id=$2`, [tenant, local])).rows[0]?.p);
const count = async (sql: string, params: unknown[]) => (await pool.query(`SELECT count(*)::int n FROM ${sql}`, params)).rows[0].n as number;
const lastNumber = async () => Number((await pool.query("SELECT coalesce(max(last_number),0)::int n FROM local_invoice_counters WHERE series_id=$1", [series.id])).rows[0].n);
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
const lines = async (doc: string) => (await pool.query('SELECT line_no,kind,category,rate::text rate,rate_code,gtu,annex15,profile_version,exemption_basis FROM tax226_document_lines WHERE document_id=$1 ORDER BY line_no', [doc])).rows;

/** Base addOrder (paid) of 2 units, then native picking, scans, packed and a demo shipment. */
async function shippedOrder(o: Owner) {
  const sku = 'TX-' + randomBytes(4).toString('hex');
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 10 })));
  const pid = await publicId('base_wire220_product_ids', o.tenant, p.id), wid = await publicId('base_wire220_warehouse_ids', o.tenant, o.warehouse);
  const order = baseOk(await wire.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': o.token },
    payload: new URLSearchParams({ method: 'addOrder', parameters: JSON.stringify({ delivery_fullname: 'Jan Podatek', email: 'tax@example.com', phone: '500600700', delivery_address: 'Prosta 1',
      delivery_postcode: '00-001', delivery_city: 'Warszawa', delivery_country_code: 'PL', currency: 'PLN', paid: 1, delivery_price: 10,
      products: [{ storage: 'db', product_id: String(pid), warehouse_id: wid, price_brutto: 25.5, tax_rate: 23, quantity: 2 }] }) }).toString() })).order_id as number;
  const local = (await pool.query('SELECT local_id FROM base_wire220_order_ids WHERE tenant_id=$1 AND public_id=$2', [o.tenant, order])).rows[0].local_id as string;
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  for (let n = 0; n < 2; n++) await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  return { order, local, product: p.id as string, sku };
}
async function preview(o: Owner, local: string) {
  return (await previewLocalInvoice(nativeActor(o), local, { client_key: randomUUID(), series_id: series.id, order_version: await tenantTx(o.tenant, c => version(c, local)), shipping_vat: 23,
    buyer: { kind: 'consumer', name: 'Klient podatkowy', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' },
    sell_date: new Date().toISOString().slice(0, 10), tax_regime: 'ordinary_domestic', consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true })).preview;
}
const profileBody = (version: number | null, extra: Record<string, unknown> = {}) => ({ version, category: 'standard', gtu: null, annex15: false, ...extra });

before(async () => {
  for (const name of ['tax226_product_profiles', 'tax226_document_lines', 'base_wire220_invoice_ids'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 226: ' + name);
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
  a = await key(rows[0], ALL); b = await key(rows[1], ALL); readKey = await key(rows[0], ['products:read', 'documents:read', 'orders:read']);
  session = Fastify();
  session.decorateRequest('actor'); session.decorateRequest('currentUser'); session.decorateRequest('apiScopes'); session.decorateRequest('apiKeyId');
  session.addHook('onRequest', async (req: any) => {
    const as = JSON.parse(String(req.headers['x-test-as'])), k = [a, b, readKey].find(o => o.keyId === as.key)!;
    req.actor = { tenantId: as.tenant, userId: as.user, role: as.role, apiKeyId: as.key, source: 'api' };
    req.currentUser = { id: as.user, tenant_id: as.tenant, role: as.role, api_key_id: as.key };
    req.apiKeyId = as.key; req.apiScopes = (await pool.query('SELECT scopes FROM api_keys WHERE id=$1', [k.keyId])).rows[0].scopes;
  });
  session.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
    return reply.code(500).send({ error: 'Błąd serwera' });
  });
  registerTax226Routes(session, { available: true, readOnly: false, sessionName: 'dyna_session' });
  await session.ready();
  wire = Fastify();
  registerBaseWireRoutes(wire, { readOnly: false, families: [
    createBaseWireOrdersFamily({ available: true, service: createDefaultBaseWireOrdersService({ readOnly: false, mergeClaims: true }) }),
    createBaseWireInvoicesFamily({ available: true, service: createDefaultBaseWireInvoicesService({ readOnly: false }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await wire.ready();
  const prefix = 'TX' + randomBytes(3).toString('hex').toUpperCase();
  const created = await createLocalInvoiceSeries(nativeActor(a), { client_key: randomUUID(), name: 'Seria 226 ' + prefix, prefix,
    seller: { name: 'Sprzedawca testowy', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: '5260250274' },
    payment_terms_days: 14, payment_instructions: 'Przelew', notes: 'Dziękujemy', seller_vat_status: 'active_domestic' });
  // Base getSeries allocates the 220 numeric id of the new series.
  baseOk(await wire.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': a.token },
    payload: new URLSearchParams({ method: 'getSeries', parameters: '{}' }).toString() }));
  series = { id: created.series.id, prefix, public: await publicId('base_wire220_invoice_series_ids', a.tenant, created.series.id) };
  assert(Number.isSafeInteger(series.public) && series.public > 0);
});
after(async () => { await session?.close(); await wire?.close(); await pool.end(); });

test('product tax profile: default, rule refusals, optimistic version, tenant isolation, scope and admin role', async () => {
  const p = await tenantTx(a.tenant, c => createProduct(c, a.actor, productSchema.parse({ name: 'Usługa medyczna', sku: 'TXP-' + randomBytes(3).toString('hex'), price: 10000, vat: 8, catalog_id: a.catalog, warehouse_id: a.warehouse, quantity: 1 })));
  const url = `/api/products/${p.id}/tax-profile`;
  const fresh = ok(await call(a, 'GET', url));
  assert.deepEqual([fresh.product_vat, fresh.profile.version, fresh.profile.category, fresh.profile.gtu, fresh.updated_at], [8, null, 'standard', null, null]);
  refused(await call(a, 'PUT', url, profileBody(null, { category: 'zw' })), 422, /rodzaju podstawy.*podstawy prawnej/);
  refused(await call(a, 'PUT', url, profileBody(null, { category: 'np' })), 422, /NP I/);
  refused(await call(a, 'PUT', url, profileBody(null, { gtu: 'GTU_14' })), 422);
  refused(await call(a, 'PUT', url, profileBody(null), 'operator'), 403, /administrator/);
  refused(await call(readKey, 'PUT', url, profileBody(null)), 403, /products:write/);
  refused(await call(b, 'GET', url), 404);
  refused(await call(b, 'PUT', url, profileBody(null)), 404);
  assert.equal(await count('tax226_product_profiles WHERE product_id=$1', [p.id]), 0, 'refusals write nothing');
  const zw = ok(await call(a, 'PUT', url, profileBody(null, { category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'art. 43 ust. 1 pkt 18 ustawy o VAT', gtu: 'GTU_12' })));
  assert.deepEqual([zw.profile.version, zw.profile.category, zw.profile.exemption_basis, zw.profile.gtu], [1, 'zw', 'art. 43 ust. 1 pkt 18 ustawy o VAT', 'GTU_12']);
  refused(await call(a, 'PUT', url, profileBody(null)), 409, /innym oknie/);
  refused(await call(a, 'PUT', url, profileBody(7)), 409, /innym oknie/);
  const back = ok(await call(a, 'PUT', url, profileBody(1, { oss_rate_class: 'reduced_1' })));
  assert.deepEqual([back.profile.version, back.profile.category, back.profile.exemption_basis, back.profile.oss_rate_class], [2, 'standard', null, 'reduced_1']);
  assert.deepEqual(ok(await call(readKey, 'GET', url)).profile, back.profile);
  assert.equal(await count("audit_events WHERE entity_id=$1 AND action='product.tax_profile'", [p.id]), 2);
  assert.deepEqual((await pool.query('SELECT tenant_id,updated_by,api_key_id FROM tax226_product_profiles WHERE product_id=$1', [p.id])).rows, [{ tenant_id: a.tenant, updated_by: a.user, api_key_id: a.keyId }]);
});

test('OSS settings: registration with destination rates replaces the table; stale version and bad rates are refused', async () => {
  assert.deepEqual(ok(await call(a, 'GET', '/api/tax/oss')).settings, { version: null, registered: false, registered_from: null, updated_at: null });
  refused(await call(a, 'PUT', '/api/tax/oss', { version: null, registered: true, registered_from: null, rates: [] }), 422);
  refused(await call(a, 'PUT', '/api/tax/oss', { version: null, registered: false, registered_from: null, rates: [{ country: 'PL', rate_class: 'standard', rate: 23 }] }), 422);
  refused(await call(readKey, 'PUT', '/api/tax/oss', { version: null, registered: false, registered_from: null, rates: [] }), 403);
  const first = ok(await call(a, 'PUT', '/api/tax/oss', { version: null, registered: true, registered_from: '2026-07-01', rates: [{ country: 'DE', rate_class: 'standard', rate: 19 }, { country: 'FR', rate_class: 'reduced_1', rate: 5.5 }] }));
  assert.deepEqual([first.settings.version, first.settings.registered_from, first.rates], [1, '2026-07-01', [{ country: 'DE', rate_class: 'standard', rate: '19.00' }, { country: 'FR', rate_class: 'reduced_1', rate: '5.50' }]]);
  refused(await call(a, 'PUT', '/api/tax/oss', { version: null, registered: false, registered_from: null, rates: [] }), 409);
  const second = ok(await call(a, 'PUT', '/api/tax/oss', { version: 1, registered: true, registered_from: '2026-07-01', rates: [{ country: 'AT', rate_class: 'standard', rate: 20 }] }));
  assert.deepEqual([second.settings.version, second.rates.map((r: any) => r.country)], [2, ['AT']]);
  assert.deepEqual(ok(await call(b, 'GET', '/api/tax/oss')).rates, [], 'other tenant sees nothing');
});

test('tax-issue refuses a ZW line before numbering, then issues one invoice with the per-line snapshot; replay adds nothing', async () => {
  const x = await shippedOrder(a), url = `/api/products/${x.product}/tax-profile`;
  ok(await call(a, 'PUT', url, profileBody(null, { category: 'zw', exemption_basis_kind: 'P_19C', exemption_basis: 'zwolnienie testowe' })));
  const p1 = await preview(a, x.local), before = await lastNumber();
  const facts = ok(await call(a, 'GET', `/api/local-invoices/previews/${p1.id}/tax`));
  assert.deepEqual(facts.facts.lines.map((l: any) => [l.kind, l.category, l.rate_code]), [['item', 'zw', 'zw'], ['shipping', 'standard', '23']]);
  assert.equal(facts.blockers.length, 1); assert.match(facts.blockers[0], new RegExp(x.sku + ': zwolnienie ZW'));
  const body = { client_key: randomUUID(), scope_hash: p1.scope_hash, confirmed: true, local_only: true };
  refused(await call(a, 'POST', `/api/local-invoices/previews/${p1.id}/tax-issue`, body), 409, /zwolnienie ZW/);
  assert.equal(await count("documents WHERE order_id=$1 AND mode='local_invoice'", [x.local]), 0);
  assert.equal(await lastNumber(), before, 'refusal consumes no number');
  // Back to the ordinary rate with GTU_06 and annex 15; the issue snapshots those facts.
  ok(await call(a, 'PUT', url, profileBody(1, { gtu: 'GTU_06', annex15: true })));
  const p2 = await preview(a, x.local), body2 = { client_key: randomUUID(), scope_hash: p2.scope_hash, confirmed: true, local_only: true };
  refused(await call(b, 'POST', `/api/local-invoices/previews/${p2.id}/tax-issue`, body2), 404);
  const issued = ok(await call(a, 'POST', `/api/local-invoices/previews/${p2.id}/tax-issue`, body2), 201);
  assert.equal(issued.reused, false); assert.equal(issued.receipt.sequence, before + 1);
  assert.deepEqual(Object.keys(issued).filter(k => !['tax'].includes(k)).sort(), ['available', 'can_create_series', 'can_read', 'can_write', 'current_role', 'document', 'read_only', 'receipt', 'reused'].sort());
  const doc = issued.document.id as string;
  assert.deepEqual(await lines(doc), [
    { line_no: 1, kind: 'item', category: 'standard', rate: '23.00', rate_code: '23', gtu: 'GTU_06', annex15: true, profile_version: 2, exemption_basis: null },
    { line_no: 2, kind: 'shipping', category: 'standard', rate: '23.00', rate_code: '23', gtu: null, annex15: false, profile_version: null, exemption_basis: null }]);
  const head = (await pool.query('SELECT * FROM tax226_document_snapshots WHERE document_id=$1', [doc])).rows[0];
  assert.deepEqual([head.captured_with_issue, head.buyer_kind, head.buyer_country, head.procedure, String(head.gross_minor), String(head.annex15_gross_minor), head.mpp_required, head.api_key_id],
    [true, 'consumer', 'PL', 'domestic', '6100', '5100', false, a.keyId]);
  assert.deepEqual(issued.tax.lines.map((l: any) => [l.sku, l.gtu]), [[x.sku, 'GTU_06'], [issued.document.data.lines[1].sku, null]]);
  assert.match(issued.tax.mpp_reason, /nie jest podatnikiem/);
  // Lost ACK: same body answers reused with the same snapshot; nothing new.
  const again = ok(await call(a, 'POST', `/api/local-invoices/previews/${p2.id}/tax-issue`, body2), 200);
  assert.equal(again.reused, true); assert.deepEqual(again.tax, issued.tax);
  assert.equal(await count('tax226_document_lines WHERE document_id=$1', [doc]), 2);
  assert.equal(await lastNumber(), before + 1);
  // Later profile changes do not touch the issued snapshot; the snapshot itself is permanent.
  ok(await call(a, 'PUT', url, profileBody(2, { category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'inne' })));
  assert.deepEqual(ok(await call(a, 'GET', `/api/local-invoices/documents/${doc}/tax`)).tax, issued.tax);
  await assert.rejects(pool.query('UPDATE tax226_document_lines SET gtu=NULL WHERE document_id=$1', [doc]), /permanent/);
  await assert.rejects(pool.query('DELETE FROM tax226_document_snapshots WHERE document_id=$1', [doc]), /permanent/);
  refused(await call(b, 'GET', `/api/local-invoices/documents/${doc}/tax`), 404);
});

test('Base addInvoice snapshots the tax facts in its issuing transaction and refuses a ZW product before numbering', async () => {
  const x = await shippedOrder(a), url = `/api/products/${x.product}/tax-profile`, before = await lastNumber();
  ok(await call(a, 'PUT', url, profileBody(null, { category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'art. 43' })));
  const addInvoice = () => wire.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': a.token },
    payload: new URLSearchParams({ method: 'addInvoice', parameters: JSON.stringify({ order_id: x.order, series_id: series.public }) }).toString() });
  const r = await addInvoice(); assert.equal(r.statusCode, 409, r.body); assert.match(r.json().error_message, /zwolnienie ZW/);
  assert.equal(await count("documents WHERE order_id=$1 AND mode='local_invoice'", [x.local]), 0);
  assert.equal(await lastNumber(), before);
  ok(await call(a, 'PUT', url, profileBody(1, { gtu: 'GTU_01' })));
  baseOk(await addInvoice());
  const doc = (await pool.query("SELECT id FROM documents WHERE order_id=$1 AND mode='local_invoice'", [x.local])).rows[0].id;
  assert.deepEqual((await lines(doc)).map(l => [l.kind, l.rate_code, l.gtu]), [['item', '23', 'GTU_01'], ['shipping', '23', null]]);
});

test('an invoice issued through the pinned native route has no snapshot and says so', async () => {
  const x = await shippedOrder(a), p = await preview(a, x.local);
  const issued = await issueLocalInvoice(nativeActor(a), p.id, { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true, local_only: true });
  const v = ok(await call(a, 'GET', `/api/local-invoices/documents/${issued.document.id}/tax`));
  assert.equal(v.tax, null); assert.match(v.note, /bez migawki podatkowej/);
  assert.equal(await count('tax226_document_snapshots WHERE document_id=$1', [issued.document.id]), 0);
});
