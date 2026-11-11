/** Fiscal fixtures of the S4 failure tests (receipts 233, invoices 230/157) on an S4 clone: an admin
 * API key of a PLN tenant of the restored copy, real shipped orders, the receipt, 230 and 157 routes on a
 * bare Fastify with the actor the auth hook would set, and the local fake fiscal printer.
 * Mirrors the setup of tests/receipts233.database.test.ts (owned by the 233 lane). */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tenantTx } from '../server/db';
import { Problem } from '../server/errors';
import { tokenHash } from '../server/security';
import { createProduct } from '../server/catalog';
import { createOrder, orderSchema, productSchema, scan, shipDemo, type Actor } from '../server/domain';
import { advancePaid, confirmOutstanding } from '../server/payments';
import { transitionDirectLegacyOnReturnInTx } from '../server/legacy-return-on-command';
import { createLocalInvoiceSeries, localInvoiceRequestActor, previewLocalInvoice } from '../server/local-invoices';
import type { LocalInvoiceActor } from '../server/local-invoice-values';
import { registerTax226Routes } from '../server/tax226-routes';
import { taxInvoiceActor } from '../server/tax226-local-invoices';
import { registerInvoice230Routes } from '../server/invoice230-routes';
import { registerReceipt233Routes } from '../server/receipt233-routes';

const SESSION = 'dyna_session';
const ALL = ['orders:read', 'orders:write', 'documents:read', 'documents:write', 'products:read', 'products:write'];
export type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; keyId: string; actor: Actor; seller: string };
export type Series = { id: string; prefix: string };
export type Res = Awaited<ReturnType<FastifyInstance['inject']>>;

/** The first PLN admin tenant of the copy without WMS, MFA or strict stock control (as the 233 test). */
export async function fiscalOwner(keyName: string): Promise<Owner> {
  const row = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse,
    (SELECT coalesce(d.data#>>'{seller,tax_id}',d.data#>>'{fiscal_snapshot,seller,tax_id}') FROM documents d WHERE d.tenant_id=m.tenant_id AND d.mode IN ('local_invoice','b2b_invoice') LIMIT 1) seller
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE (SELECT currency FROM tenants t WHERE t.id=m.tenant_id)='PLN'
    AND NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND EXISTS(SELECT 1 FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)
    ORDER BY (SELECT plan FROM tenants t WHERE t.id=m.tenant_id)='enterprise' DESC,m.tenant_id LIMIT 1`)).rows[0];
  assert(row, 'no PLN tenant for fiscal tests');
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at) VALUES($1,$2,$3,$7,$4,$5,$6,clock_timestamp()+interval '1 day')`,
    [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), ALL, keyName]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, token, keyId: id, seller: row.seller ?? '5260250274',
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
export const nativeActor = (o: Owner): LocalInvoiceActor => localInvoiceRequestActor({ actor: { tenantId: o.tenant, userId: o.user, role: 'admin', source: 'api', apiKeyId: o.keyId },
  apiKeyId: o.keyId, currentUser: { id: o.user, tenant_id: o.tenant }, headers: { authorization: 'Bearer ' + o.token }, cookies: {} }, SESSION);

/** The actor of the FV identity frame (taxInvoiceTransaction), as the receipt routes build it. */
export const frameActor = (o: Owner): LocalInvoiceActor => taxInvoiceActor({ actor: { tenantId: o.tenant, userId: o.user, role: 'admin', source: 'api', apiKeyId: o.keyId },
  apiKeyId: o.keyId, currentUser: { id: o.user, tenant_id: o.tenant }, headers: { authorization: 'Bearer ' + o.token }, cookies: {} }, SESSION);

export async function fiscalApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('actor'); app.decorateRequest('currentUser'); app.decorateRequest('apiScopes'); app.decorateRequest('apiKeyId');
  app.addHook('onRequest', async (req: any) => {
    const as = JSON.parse(String(req.headers['x-test-as']));
    req.actor = { tenantId: as.tenant, userId: as.user, role: 'admin', apiKeyId: as.key, source: 'api' };
    req.currentUser = { id: as.user, tenant_id: as.tenant, role: 'admin', api_key_id: as.key }; req.cookies = {};
    req.apiKeyId = as.key; req.apiScopes = (await pool.query('SELECT scopes FROM api_keys WHERE id=$1', [as.key])).rows[0].scopes;
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
    process.stderr.write('failure-fiscal 500: ' + (err?.code ?? '') + ' ' + String(err?.message ?? err).slice(0, 400) + '\n');
    return reply.code(500).send({ error: 'Błąd serwera' });
  });
  registerTax226Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerInvoice230Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerReceipt233Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  await app.ready();
  return app;
}
export function call(app: FastifyInstance, o: Owner, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown): Promise<Res> {
  const headers = { authorization: 'Bearer ' + o.token, 'x-test-as': JSON.stringify({ tenant: o.tenant, user: o.user, key: o.keyId }) };
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
}
export const ok = (r: Res, status = 200) => { assert.equal(r.statusCode, status, r.body); return r.json(); };
export const refused = (r: Res, status: number, pattern?: RegExp) => {
  assert.equal(r.statusCode, status, r.body);
  if (pattern) assert.match(r.json().error, pattern);
  return r.json();
};
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
export const utcToday = async () => (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d")).rows[0].d as string;

/** A PLN product and a paid, picked, packed and shipped order of one unit. */
export async function shippedOrder(o: Owner, price: number, email: string): Promise<string> {
  const sku = 'S4F-' + randomBytes(4).toString('hex');
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Kubek ' + sku, sku, price, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 20 })));
  const local = (await tenantTx(o.tenant, c => createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Nabywca S4', email, warehouse_id: o.warehouse,
    currency: 'PLN', shipping_cost: 0, address: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600722' },
    items: [{ product_id: p.id, quantity: 1 }] })))).id as string;
  await tenantTx(o.tenant, async c => { await confirmOutstanding(c, o.actor, local); await advancePaid(c, o.actor, local); });
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  return local;
}
export async function series(o: Owner): Promise<Series> {
  const prefix = 'S' + randomBytes(3).toString('hex').toUpperCase();
  const created = await createLocalInvoiceSeries(nativeActor(o), { client_key: randomUUID(), name: 'Seria S4 ' + prefix, prefix,
    seller: { name: 'Sprzedawca S4', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: o.seller },
    payment_terms_days: 14, payment_instructions: 'Przelew na rachunek 00 1111 2222', notes: 'Dziękujemy', seller_vat_status: 'active_domestic' });
  return { id: created.series.id as string, prefix };
}
const consumer = { kind: 'consumer', name: 'Jan Kowalski', address: { street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' } };
export async function preview230(app: FastifyInstance, o: Owner, s: Series, local: string): Promise<Res> {
  return call(app, o, 'POST', `/api/invoice230/orders/${local}/previews`, { client_key: randomUUID(), series_id: s.id,
    order_version: await tenantTx(o.tenant, c => version(c, local)), shipping_vat: 23, buyer: consumer, sell_date: await utcToday() });
}
/** Preview and issue of a 230 consumer invoice; returns the issue response. */
export async function issue230(app: FastifyInstance, o: Owner, s: Series, local: string): Promise<Res> {
  const pv = ok(await preview230(app, o, s, local), 201);
  return call(app, o, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true, local_only: true });
}
/** Preview and issue of a 157 local B2C invoice (which confirms "not issued to a fiscal receipt"). */
export async function issue157(app: FastifyInstance, o: Owner, s: Series, local: string): Promise<Res> {
  const p = await previewLocalInvoice(nativeActor(o), local, { client_key: randomUUID(), series_id: s.id, order_version: await tenantTx(o.tenant, c => version(c, local)), shipping_vat: 23,
    buyer: { kind: 'consumer', name: 'Klient 157', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, sell_date: await utcToday(),
    tax_regime: 'ordinary_domestic', consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true } as any);
  return call(app, o, 'POST', `/api/local-invoices/previews/${p.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: p.preview.scope_hash, confirmed: true, local_only: true });
}
