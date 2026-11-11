/** Gaps left by 230, on a real disposable clone dynaminds_gaps231_2026102[34]_NN (real routes through
 * Fastify injection with the actor the auth hook would set; the local fake KSeF on a random loopback
 * port, no MF host is ever called):
 * - the pinned native POST /api/local-invoices/previews/:id/issue, behind the app-level alias guard:
 *   an order with a FV-S (230) invoice or another 157 invoice is refused with 409 and no number is
 *   consumed in either series; a clean order is issued through the tax-issue handler, so the 226
 *   snapshot is written; the same request replays with 200;
 * - Base addInvoice, the external (Fakturownia) preview and the B2B FA(3) preview refuse a FV-S order;
 * - 231: a FV-S EUR B2B invoice is sent to KSeF (number + UPO stored, the exact FA(3) file), a FV-S
 *   NP II invoice goes offline on a KSeF 5xx and the queue sends it later; JPK_V7M rows carry NrKSeF;
 * - RODO 228: export, anonymisation preview and confirmation of a customer with a FV-S invoice keep
 *   the invoice buyer data (230 previews/documents, the KSeF file) for the tax retention;
 * - the nine guards and local_invoice_guards stay true.
 * The suite issues invoices; rerun = NEW clone. The /issue part needs only 230 (test-first run). */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localConfig, pool, tenantTx } from '../server/db';
import { Problem } from '../server/errors';
import { encrypt, tokenHash } from '../server/security';
import { createProduct } from '../server/catalog';
import { createOrder, orderSchema, productSchema, scan, shipDemo, type Actor } from '../server/domain';
import { advancePaid, confirmOutstanding } from '../server/payments';
import { transitionDirectLegacyOnReturnInTx } from '../server/legacy-return-on-command';
import { createLocalInvoiceSeries, previewLocalInvoice, localInvoiceRequestActor } from '../server/local-invoices';
import { registerLocalInvoiceRoutes } from '../server/local-invoice-routes';
import { registerLocalInvoiceIssueAlias } from '../server/local-invoice-issue-alias';
import { registerTax226Routes } from '../server/tax226-routes';
import { registerNbp227Routes } from '../server/nbp227-routes';
import { registerInvoice230Routes } from '../server/invoice230-routes';
import { registerFa3DocumentRoutes } from '../server/fa3-document-routes';
import { registerJpkRoutes } from '../server/jpk-routes';
import { registerKsef229Routes, ksef229Service } from '../server/ksef229-routes';
import { registerRodo228Routes } from '../server/rodo228-routes';
import { startFakeKsef, type FakeKsef } from '../server/ksef229-fake';
import { isKsefNumber } from '../server/ksef229-crypto';
import { createBaseWireInvoicesNative, frame } from '../server/base-wire-invoices-runtime';
import { previewInvoice } from '../server/invoices';
import { fa3DraftPreview, fa3DraftRequestActor } from '../server/fa3-drafts';
import { taxRetentionEnd } from '../server/rodo228-model';
import { jpkRecords } from './jpk-fixtures';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_gaps231_2026102[34]_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 30000;
const KEY_NAME = 'Isolated gaps 231 test';
const SESSION = 'dyna_session', TOKEN = 'lokalny-token-' + randomBytes(12).toString('hex');
const ALL = ['orders:read', 'orders:write', 'documents:read', 'documents:write', 'products:read', 'products:write'];
const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid', 'return_credit211_metadata_valid',
  'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards'];
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; keyId: string; actor: Actor; seller: string };
let app: FastifyInstance, fake: FakeKsef, a: Owner, series: { id: string; prefix: string }, sessionToken = '';

async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string; seller: string | null }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$7,$4,$5,$6,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), scopes, KEY_NAME]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, token, keyId: id, seller: row.seller ?? '5260250274',
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
function call(o: Owner, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) {
  const headers = { authorization: 'Bearer ' + o.token, 'x-test-as': JSON.stringify({ tenant: o.tenant, user: o.user, role: 'admin', key: o.keyId }) };
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
}
/** Administrator session of tenant a (KSeF settings and RODO need a session). */
const session = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-as': JSON.stringify({ tenant: a.tenant, user: a.user, role: 'admin', session: sessionToken }) }, ...(payload === undefined ? {} : { payload: payload as any }) });
const nativeActor = (o: Owner) => localInvoiceRequestActor({ actor: { tenantId: o.tenant, userId: o.user, role: 'admin', source: 'api', apiKeyId: o.keyId },
  apiKeyId: o.keyId, currentUser: { id: o.user, tenant_id: o.tenant }, headers: { authorization: 'Bearer ' + o.token }, cookies: {} }, SESSION);
const apiReq = (o: Owner) => ({ actor: { tenantId: o.tenant, userId: o.user, role: 'admin' as const, source: 'api' as const, apiKeyId: o.keyId }, apiKeyId: o.keyId,
  currentUser: { id: o.user, tenant_id: o.tenant }, headers: { authorization: 'Bearer ' + o.token }, cookies: {} });
const ok = (r: any, status = 200) => { assert.equal(r.statusCode, status, r.body); return r.json(); };
const refused = (r: any, status: number, pattern?: RegExp) => { assert.equal(r.statusCode, status, r.body); assert(!/SELECT |stack|dyna_api_/.test(r.body), r.body);
  if (pattern) assert.match(r.json().error ?? r.json().detail, pattern); return r.json(); };
const count = async (sql: string, params: unknown[] = []) => (await pool.query(`SELECT count(*)::int n FROM ${sql}`, params)).rows[0].n as number;
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
const utcToday = async () => (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d")).rows[0].d as string;
const counters = async () => ({
  fv157: Number((await pool.query('SELECT coalesce(sum(last_number),0)::int n FROM local_invoice_counters WHERE series_id=$1', [series.id])).rows[0].n),
  fvs: Number((await pool.query('SELECT coalesce(sum(last_number),0)::int n FROM invoice230_counters WHERE series_id=$1', [series.id])).rows[0].n),
  documents: await count("documents WHERE tenant_id=$1 AND kind='invoice'", [a.tenant]),
});

type Profile = { category: 'standard' | 'zw' | 'np' | 'oo'; np_kind?: 'np_ii' };
/** A product with its 226 profile and an order (PLN, or EUR through a price list) to `country`, paid, picked, packed and shipped. */
async function shipped(o: Owner, opts: { price: number; shipping?: number; country?: string; currency?: 'PLN' | 'EUR'; profile?: Profile; email?: string }) {
  const sku = 'G231-' + randomBytes(4).toString('hex');
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: opts.price, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 10 })));
  if (opts.profile) ok(await call(o, 'PUT', `/api/products/${p.id}/tax-profile`, { version: null, gtu: null, annex15: false, ...opts.profile }));
  let list: string | undefined;
  if (opts.currency === 'EUR') {
    list = randomUUID();
    await tenantTx(o.tenant, async c => {
      await c.query("INSERT INTO price_lists(id,tenant_id,name,currency) VALUES($1,$2,$3,'EUR')", [list, o.tenant, 'Cennik EUR 231 ' + sku]);
      await c.query('INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price) VALUES($1,$2,$3,$4)', [o.tenant, list, p.id, opts.price]);
    });
  }
  const country = opts.country ?? 'PL';
  const local = (await tenantTx(o.tenant, c => createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Nabywca 231', email: opts.email ?? 'gaps231@example.com', warehouse_id: o.warehouse,
    currency: opts.currency ?? 'PLN', ...(list ? { price_list_id: list } : {}), shipping_cost: opts.shipping ?? 0,
    address: { street: 'Prosta 1', city: country === 'PL' ? 'Warszawa' : 'Berlin', postal_code: country === 'PL' ? '00-001' : '10115', country, phone: '500600711' },
    items: [{ product_id: p.id, quantity: 1 }] })))).id as string;
  await tenantTx(o.tenant, async c => { await confirmOutstanding(c, o.actor, local); await advancePaid(c, o.actor, local); });
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  return local;
}
const addr = (country: string) => ({ street: country === 'PL' ? 'Długa 5' : 'Hauptstraße 5', postal_code: country === 'PL' ? '00-002' : '10115', city: country === 'PL' ? 'Warszawa' : 'Berlin', country });
const BUYERS = {
  plB2B: { kind: 'business', name: 'Hurtownia Polska Sp. z o.o.', address: addr('PL'), tax_id: '526-025-02-74', pl_vat_payer: true },
  deB2B: { kind: 'business', name: 'Muster GmbH', address: addr('DE'), tax_id: 'DE123456789' },
} as const;
async function issue230(o: Owner, local: string, buyer: unknown) {
  const req = { series_id: series.id, order_version: await tenantTx(o.tenant, c => version(c, local)), shipping_vat: 23 as const, buyer, sell_date: await utcToday() };
  const pv = ok(await call(o, 'POST', `/api/invoice230/orders/${local}/previews`, { client_key: randomUUID(), ...req }), 201);
  const r = ok(await call(o, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true, local_only: true }), 201);
  assert.equal(r.invoice230, true);
  return r;
}
/** A native 157 preview of the order (the pinned module's own preview). */
async function preview157(o: Owner, local: string) {
  const p = await previewLocalInvoice(nativeActor(o), local, { client_key: randomUUID(), series_id: series.id, order_version: await tenantTx(o.tenant, c => version(c, local)), shipping_vat: 23,
    buyer: { kind: 'consumer', name: 'Klient 157', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, sell_date: await utcToday(),
    tax_regime: 'ordinary_domestic', consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true } as any);
  return { id: p.preview.id as string, body: { client_key: randomUUID(), scope_hash: p.preview.scope_hash as string, confirmed: true, local_only: true } };
}
async function guards() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY'); await c.query('SET LOCAL search_path TO "$user",public'); await c.query("SET LOCAL statement_timeout='8s'");
    const out: Record<string, boolean> = {};
    for (const g of GUARDS) out[g] = (await c.query(`SELECT public.${g}() v`)).rows[0].v;
    await c.query('ROLLBACK'); return out;
  } finally { c.release(); }
}
const allTrue = Object.fromEntries(GUARDS.map(g => [g, true]));

before(async () => {
  for (const name of ['invoice230_documents', 'ksef229_submissions', 'rodo228_access_log', 'tax226_document_snapshots'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs 230: ' + name);
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY_NAME])).rows[0].n, 0, 'Fresh clone required; no rerun');
  assert.deepEqual(await guards(), allTrue, 'guards true before');
  const rows = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse,
    (SELECT coalesce(d.data#>>'{seller,tax_id}',d.data#>>'{fiscal_snapshot,seller,tax_id}') FROM documents d WHERE d.tenant_id=m.tenant_id AND d.mode IN ('local_invoice','b2b_invoice') LIMIT 1) seller
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE (SELECT currency FROM tenants t WHERE t.id=m.tenant_id)='PLN'
    AND NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND EXISTS(SELECT 1 FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)
    ORDER BY (SELECT plan FROM tenants t WHERE t.id=m.tenant_id)='enterprise' DESC,m.tenant_id LIMIT 1`)).rows;
  assert.equal(rows.length, 1);
  a = await key(rows[0], ALL);
  sessionToken = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at,account_version,mfa_verified_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',coalesce((SELECT version FROM account_security WHERE user_id=$2),0),clock_timestamp())`, [tokenHash(sessionToken), a.user, a.tenant]);
  fake = await startFakeKsef({ port: 0 });
  app = Fastify();
  app.decorateRequest('actor'); app.decorateRequest('currentUser'); app.decorateRequest('apiScopes'); app.decorateRequest('apiKeyId');
  app.addHook('onRequest', async (req: any) => {
    const as = JSON.parse(String(req.headers['x-test-as']));
    if (as.session) {
      req.actor = { tenantId: as.tenant, userId: as.user, role: as.role, source: 'session' };
      req.currentUser = { id: as.user, tenant_id: as.tenant, role: as.role }; req.cookies = { [SESSION]: as.session }; return;
    }
    req.actor = { tenantId: as.tenant, userId: as.user, role: as.role, apiKeyId: as.key, source: 'api' };
    req.currentUser = { id: as.user, tenant_id: as.tenant, role: as.role, api_key_id: as.key }; req.cookies = {};
    req.apiKeyId = as.key; req.apiScopes = (await pool.query('SELECT scopes FROM api_keys WHERE id=$1', [as.key])).rows[0].scopes;
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ error: err.message, detail: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
    process.stderr.write('gaps231 test 500: ' + (err?.code ?? '') + ' ' + String(err?.message ?? err).slice(0, 400) + '\n');
    return reply.code(500).send({ error: 'Błąd serwera' });
  });
  // The same order as buildApp: the alias guard before the pinned native routes.
  registerLocalInvoiceIssueAlias(app, { tax226Available: true, readOnly: false, sessionName: SESSION });
  registerLocalInvoiceRoutes(app, { readOnly: false, sessionName: SESSION });
  registerFa3DocumentRoutes(app, { sessionName: SESSION });
  registerJpkRoutes(app, { sessionName: SESSION });
  registerTax226Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerNbp227Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerRodo228Routes(app, { available: true, readOnly: false, pool, key: localConfig.encryptionKey });
  registerInvoice230Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerKsef229Routes(app, { available: true, readOnly: false, service: ksef229Service({ key: localConfig.encryptionKey, sessionName: SESSION, pollDelaysMs: [20, 40, 80, 160], timeoutMs: 5000 }) });
  await app.ready();
  const prefix = 'G' + randomBytes(3).toString('hex').toUpperCase();
  const created = await createLocalInvoiceSeries(nativeActor(a), { client_key: randomUUID(), name: 'Seria 231 ' + prefix, prefix,
    seller: { name: 'Sprzedawca 231', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: a.seller },
    payment_terms_days: 14, payment_instructions: 'Przelew na rachunek 00 1111 2222', notes: 'Dziękujemy', seller_vat_status: 'active_domestic' });
  series = { id: created.series.id as string, prefix };
  const y = new Date(Date.parse(await utcToday() + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
  ok(await call(a, 'PUT', '/api/nbp227/rates/manual', { currency: 'EUR', effective_date: y, table_no: `205/A/NBP/${y.slice(0, 4)}`, mid: '4.2563', covered_through: y }));
});
after(async () => { await app?.close(); await fake?.close(); await pool.end(); });

test('/issue: an order with a FV-S invoice → 409, no number in either series; a clean order gets the 226 snapshot; a second 157 invoice → 409; replay 200', async () => {
  const fvs = await issue230(a, await shipped(a, { price: 30000 }), BUYERS.plB2B);
  const blocked = await preview157(a, fvs.document.order_id), before = await counters();
  refused(await call(a, 'POST', `/api/local-invoices/previews/${blocked.id}/issue`, blocked.body), 409, /FV-S/);
  assert.deepEqual(await counters(), before, 'nothing numbered after the FV-S refusal');
  assert.equal(await count("documents WHERE order_id=$1 AND kind='invoice'", [fvs.document.order_id]), 1, 'the order keeps only its FV-S invoice');
  // A clean order: issued through the tax-issue handler, with the 226 snapshot of its own issue.
  const clean = await shipped(a, { price: 12300, shipping: 1000 }), first = await preview157(a, clean), second = await preview157(a, clean);
  const issued = ok(await call(a, 'POST', `/api/local-invoices/previews/${first.id}/issue`, first.body), 201);
  assert.match(issued.document.number, new RegExp(`^${series.prefix}/\\d{4}/\\d{6}$`));
  assert(issued.tax, 'the reply carries the 226 snapshot');
  assert.equal(await count('tax226_document_snapshots WHERE document_id=$1 AND captured_with_issue', [issued.document.id]), 1, '226 snapshot written with the issue');
  assert(await count('tax226_document_lines WHERE document_id=$1', [issued.document.id]) >= 2, 'one 226 line per invoice line');
  const replay = ok(await call(a, 'POST', `/api/local-invoices/previews/${first.id}/issue`, first.body), 200);
  assert.equal(replay.reused, true); assert.equal(replay.document.id, issued.document.id);
  const afterIssue = await counters();
  assert.deepEqual(afterIssue, { ...before, fv157: before.fv157 + 1, documents: before.documents + 1 }, 'exactly one 157 number for the clean order');
  refused(await call(a, 'POST', `/api/local-invoices/previews/${second.id}/issue`, second.body), 409, /ma już fakturę/);
  assert.deepEqual(await counters(), afterIssue, 'nothing numbered after the second-invoice refusal');
  assert.deepEqual(await guards(), allTrue);
});

test('Base addInvoice, the external Fakturownia preview and the B2B FA(3) preview refuse an order with a FV-S invoice', async () => {
  const fvs = await issue230(a, await shipped(a, { price: 25000 }), BUYERS.plB2B), order = fvs.document.order_id, before = await counters();
  // Base addInvoice: the native port of the Base invoices family.
  await assert.rejects(tenantTx(a.tenant, async c => {
    await frame(c, { ...a.actor, apiKeyId: a.keyId }, a.token, true);
    return createBaseWireInvoicesNative(c, { ...a.actor, apiKeyId: a.keyId }).issue(order, { series_id: series.id, order_version: await version(c, order), shipping_vat: 23,
      buyer: { kind: 'consumer', name: 'Klient Base', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, sell_date: await utcToday() } as any);
  }), (e: any) => e instanceof Problem && e.status === 409 && /fakturę 230 \(FV-S\)/.test(e.message));
  // External (Fakturownia) invoice plan.
  const channel = randomUUID();
  await tenantTx(a.tenant, c => c.query('INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [channel, a.tenant, 'fakturownia', 'Konto 231', 'live', encrypt({ api_token: 'fixture-token' }), JSON.stringify({ account_url: 'https://invoice-fixture.fakturownia.pl', simulation: true })]));
  const items = (await pool.query('SELECT id FROM order_items WHERE order_id=$1', [order])).rows;
  const today = await utcToday();
  await assert.rejects(previewInvoice(a.actor, order, { channel_id: channel, kind: 'invoice', correction_reason: 'Pełny zwrot zamówienia', payment_type: 'transfer',
    seller: { name: 'Sprzedawca 231', tax_no: '5252445767', street: 'Rynek 2', city: 'Kraków', postal_code: '30-001' },
    buyer: { name: 'Hurtownia', email: 'b2b231@example.com', street: 'Długa 5', city: 'Warszawa', postal_code: '00-002' },
    issue_date: today, sell_date: today, payment_to: today, item_vat: items.map(i => ({ item_id: i.id, vat: 23 })), shipping_vat: 23 } as any),
  (e: any) => e instanceof Problem && e.status === 409 && /fakturę 230 \(FV-S\)/.test(e.message));
  // B2B FA(3) project preview.
  const b2b = fa3DraftRequestActor(apiReq(a) as any, SESSION);
  await assert.rejects(fa3DraftPreview(b2b, order, { client_key: randomUUID(), order_id: order, order_version: await tenantTx(a.tenant, c => version(c, order)), seller_series_id: series.id,
    sale_date: today, buyer: { kind: 'ordinary_explicit', party: { kind: 'business', name: 'Hurtownia', tax_id: '5260250274', address: { country: 'PL', line1: 'Długa 5, 00-002 Warszawa' } }, confirmed: true },
    shipping_vat: 23, zero_basis: [], confirmed_ordinary_domestic_business_sale: true,
    ordinary_scope: { cash_method: false, self_billing: false, reverse_charge: false, split_payment: false, exemption: false, new_transport: false, triangular: false, margin: false, jst: false, vat_group: false, advance: false } }),
  (e: any) => e instanceof Problem && e.status === 409 && /fakturę 230 \(FV-S\)/.test(e.message));
  assert.deepEqual(await counters(), before, 'no path numbered anything');
  assert.equal(await count('fa3_draft_previews WHERE order_id=$1', [order]), 0);
  assert.equal(await count('invoice_plans WHERE order_id=$1', [order]), 0);
});

const sent: Record<string, any> = {};
test('231: a FV-S EUR B2B invoice is sent to the local fake KSeF (number, UPO, the exact FA(3) file); a FV-S NP II invoice goes offline and the queue sends it; JPK NrKSeF', async () => {
  assert.match((await pool.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='ksef229_submissions_document_kind_check'")).rows[0].d, /invoice230/, 'clone needs 231');
  ok(await session('PUT', '/api/ksef229/configs/' + a.seller, { environment: 'local_fake', base_url: fake.url, auth_method: 'token', token: TOKEN }));
  sent.eur = await issue230(a, await shipped(a, { price: 123000, shipping: 1230, currency: 'EUR', email: 'fvs231-eur@example.test' }), BUYERS.plB2B);
  const id = sent.eur.document.id, xml = await session('GET', `/api/fa3/documents/${id}/fa3.xml`);
  assert.equal(xml.statusCode, 200, xml.body); assert.match(xml.body, /<KodWaluty>EUR<\/KodWaluty>/);
  const before = fake.invoices().length;
  const r = ok(await session('POST', `/api/ksef229/documents/${id}/send`)), s = r.submission;
  assert.equal(s.state, 'accepted', r.body); assert(isKsefNumber(s.ksef_number), s.ksef_number); assert.equal(s.upo_available, true); assert.equal(s.document_kind, 'invoice230');
  assert.equal(s.document_number, sent.eur.document.number);
  assert.equal(fake.invoices().length, before + 1); assert.equal(fake.invoices().at(-1)!.xml, xml.body, 'the exact FA(3) file of the FV-S invoice was sent');
  const row = (await pool.query('SELECT document_kind,xml_sha256,ksef_number,upo_xml FROM ksef229_submissions WHERE document_id=$1', [id])).rows[0];
  assert.deepEqual([row.document_kind, row.ksef_number, row.xml_sha256], ['invoice230', s.ksef_number, createHash('sha256').update(xml.body).digest('hex')]);
  assert(row.upo_xml.includes(s.ksef_number));
  const upo = await session('GET', `/api/ksef229/documents/${id}/upo.xml`);
  assert.equal(upo.statusCode, 200); assert.match(upo.body, new RegExp(s.ksef_number));
  assert.equal(ok(await session('POST', `/api/ksef229/documents/${id}/send`)).replayed, true, 'a second send does not resend');
  assert.equal(fake.invoices().length, before + 1);
  // NP II to a DE business: KSeF 5xx → offline → "Kolejka KSeF".
  sent.np2 = await issue230(a, await shipped(a, { price: 80000, profile: { category: 'np', np_kind: 'np_ii' }, email: 'fvs231-np@example.test' }), BUYERS.deB2B);
  fake.setMode('unavailable');
  let off;
  try { off = ok(await session('POST', `/api/ksef229/documents/${sent.np2.document.id}/send`)).submission; } finally { fake.setMode('ok'); }
  assert.deepEqual([off.state, off.ksef_number, off.offline.mode, off.offline.kod1.label], ['queued', null, 'offline', 'OFFLINE']);
  const period = (await utcToday()).slice(0, 7), jpk = async () => {
    const v7 = await session('GET', `/api/jpk/v7m.xml?okres=${period}&kod_urzedu=1206&email=ksiegowosc%40sklep.test`);
    assert.equal(v7.statusCode, 200, v7.body); return jpkRecords(v7.body, 'SprzedazWiersz');
  };
  const rowOf = (rows: Record<string, string>[], r: any) => rows.find(x => x.DowodSprzedazy === r.document.number)!;
  const offRows = await jpk();
  assert.equal(rowOf(offRows, sent.np2).OFF, '1', 'an offline FV-S invoice still to be sent is OFF');
  assert.equal(rowOf(offRows, sent.eur).NrKSeF, s.ksef_number);
  const q = ok(await session('POST', '/api/ksef229/queue/send', {}));
  assert.deepEqual([q.attempted, q.accepted], [1, 1], JSON.stringify(q));
  const later = ok(await session('GET', `/api/ksef229/documents/${sent.np2.document.id}`)).submission;
  assert.equal(later.state, 'accepted'); assert(isKsefNumber(later.ksef_number));
  assert.equal(fake.invoices().find(i => i.ksefNumber === later.ksef_number)!.offlineMode, true);
  const rows = await jpk();
  assert.deepEqual([rowOf(rows, sent.eur).NrKSeF, rowOf(rows, sent.np2).NrKSeF], [s.ksef_number, later.ksef_number], 'JPK_V7M rows carry NrKSeF of the FV-S invoices');
  assert.equal(rowOf(rows, sent.np2).OFF, undefined);
  assert.deepEqual(await guards(), allTrue);
});

test('RODO: export, preview and anonymisation of a customer with a FV-S invoice keep the buyer data for the tax retention', async () => {
  const doc = sent.eur.document, order = doc.order_id, email = 'fvs231-eur@example.test';
  await tenantTx(a.tenant, async c => transitionDirectLegacyOnReturnInTx(c, a.actor, order, 'delivered', await version(c, order)));
  const zip = await session('GET', '/api/rodo228/export?email=' + encodeURIComponent(email));
  assert.equal(zip.statusCode, 200, zip.body); assert.equal(zip.headers['content-type'], 'application/zip');
  assert(zip.rawPayload.includes(Buffer.from(doc.number)), 'the FV-S invoice is in the export');
  assert(zip.rawPayload.includes(Buffer.from('5260250274')), 'with the buyer NIP');
  const pv = ok(await session('POST', '/api/rodo228/anonymisation/preview', { email }));
  const end = taxRetentionEnd(doc.data.sell_date), kept = (t: string) => pv.plan.keep.filter((k: any) => k.table === t);
  assert.equal(pv.plan.orders.find((o: any) => o.id === order).tax_retention_end, end);
  for (const t of ['documents', 'invoice230_documents', 'invoice230_previews', 'ksef229_submissions']) {
    const k = kept(t);
    assert.equal(k.length, 1, t + ': ' + JSON.stringify(pv.plan.keep.map((x: any) => x.table)));
    assert.deepEqual([k[0].basis, k[0].retention_end, k[0].order_id], ['tax_retention', end, order], t);
    assert.match(k[0].legal_basis, /art\. 112|Ordynacji/, t);
  }
  assert.equal(kept('invoice230_documents')[0].row, doc.id);
  assert.deepEqual(kept('invoice230_documents')[0].fields, ['buyer_tax_id', 'snapshot.buyer']);
  assert.deepEqual(kept('ksef229_submissions')[0].fields, ['xml', 'upo_xml']);
  assert.deepEqual(kept('orders')[0].fields.includes('customer_name'), true, 'the order keeps the buyer name');
  const before = (await pool.query('SELECT buyer_tax_id,snapshot FROM invoice230_documents WHERE document_id=$1', [doc.id])).rows[0];
  const done = ok(await session('POST', `/api/rodo228/anonymisation/${pv.request_id}/confirm`, { plan_sha256: pv.plan_sha256 }));
  assert.equal(done.state, 'completed');
  const o = (await pool.query('SELECT email,customer_name FROM orders WHERE id=$1', [order])).rows[0];
  assert.match(o.email, /@anonim\.invalid$/); assert.equal(o.customer_name, 'Nabywca 231');
  assert.deepEqual((await pool.query('SELECT buyer_tax_id,snapshot FROM invoice230_documents WHERE document_id=$1', [doc.id])).rows[0], before, 'the FV-S invoice is unchanged');
  const retained = (await pool.query("SELECT source_table,basis,to_char(retention_end,'YYYY-MM-DD') e FROM rodo228_retained WHERE request_id=$1 AND source_table LIKE ANY('{invoice230%,ksef229%}') ORDER BY 1", [pv.request_id])).rows;
  assert.deepEqual(retained, ['invoice230_documents', 'invoice230_previews', 'ksef229_submissions'].map(t => ({ source_table: t, basis: 'tax_retention', e: end })));
  assert.equal(ok(await session('GET', `/api/invoice230/documents/${doc.id}`)).document.number, doc.number, 'the FV-S invoice still reads');
  assert.deepEqual(await guards(), allTrue, 'guards true after the anonymisation');
});
