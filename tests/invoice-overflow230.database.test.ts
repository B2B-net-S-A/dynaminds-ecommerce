/** 157 overflow to 230 on a real disposable clone dynaminds_inv29_20261029_NN (real routes through Fastify
 * injection with the actor the auth hook would set; the local fake KSeF on a loopback port, no MF host):
 * - the company is planted at the lifetime limit of the sealed 157 budget (local_invoice_budget, 157:137):
 *   2000 real previews through the native previewLocalInvoice() (committed on this dedicated clone);
 * - before: the pinned native POST /api/local-invoices/orders/:id/previews answers the 2001st preview with
 *   the 23514 "Limit historii faktur" (409) — the error a user saw;
 * - after (invoice-overflow230.ts, registered by registerInvoice230Routes): the same request is a 230
 *   preview with the Polish series note; tax-issue and the native /issue alias issue FV-S/<prefix>/<year>/<seq>
 *   with a note; the 157 counter does not move; a replay of the preview answers 200;
 * - the FV-S invoice is in JPK_V7M of the period and in the settlement report, the fake KSeF accepts it,
 *   a KOR-S correction of it is issued;
 * - Base addInvoice at the limit issues FV-S with invoice_number/local_note; getInvoices and getInvoiceFile read it;
 * - an order outside the 157 scope (ZW product) is refused with the reason and numbers nothing; guards stay true.
 * The suite plants and issues; rerun = NEW clone. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localConfig, pool, tenantTx } from '../server/db';
import { Problem } from '../server/errors';
import { tokenHash } from '../server/security';
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
import { registerInvoice232Routes } from '../server/invoice232-routes';
import { registerFa3DocumentRoutes } from '../server/fa3-document-routes';
import { registerJpkRoutes } from '../server/jpk-routes';
import { registerSettlementReportRoutes } from '../server/settlement-report-routes';
import { registerKsef229Routes, ksef229Service } from '../server/ksef229-routes';
import { startFakeKsef, type FakeKsef } from '../server/ksef229-fake';
import { isKsefNumber } from '../server/ksef229-crypto';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireInvoicesFamily } from '../server/base-wire-invoices';
import { createDefaultBaseWireInvoicesService, frame } from '../server/base-wire-invoices-runtime';
import { jpkRecords } from './jpk-fixtures';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_(?:inv29|m262)_20261029_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 60000;
const KEY_NAME = 'Isolated 157 overflow test', LIMIT = 2000;
const SESSION = 'dyna_session', TOKEN = 'lokalny-token-' + randomBytes(12).toString('hex');
const ALL = ['orders:read', 'orders:write', 'documents:read', 'documents:write', 'products:read', 'products:write'];
const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid', 'return_credit211_metadata_valid',
  'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards'];
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; keyId: string; actor: Actor; seller: string };
let app: FastifyInstance, bare: FastifyInstance, wireApp: FastifyInstance, fake: FakeKsef, a: Owner, series: { id: string; prefix: string }, sessionToken = '';

async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string; seller: string | null }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$7,$4,$5,$6,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), scopes, KEY_NAME]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, token, keyId: id, seller: row.seller ?? '5260250274',
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
const headers = (o: Owner) => ({ authorization: 'Bearer ' + o.token, 'x-test-as': JSON.stringify({ tenant: o.tenant, user: o.user, role: 'admin', key: o.keyId }) });
const call = (o: Owner, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown, on: FastifyInstance = app) =>
  on.inject({ method, url, headers: headers(o), ...(payload === undefined ? {} : { payload: payload as any }) });
const session = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-as': JSON.stringify({ tenant: a.tenant, user: a.user, role: 'admin', session: sessionToken }) }, ...(payload === undefined ? {} : { payload: payload as any }) });
const wire = (o: Owner, method: string, parameters: unknown) => wireApp.inject({ method: 'POST', url: '/connector.php',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': o.token }, payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
const nativeActor = (o: Owner) => localInvoiceRequestActor({ actor: { tenantId: o.tenant, userId: o.user, role: 'admin', source: 'api', apiKeyId: o.keyId },
  apiKeyId: o.keyId, currentUser: { id: o.user, tenant_id: o.tenant }, headers: { authorization: 'Bearer ' + o.token }, cookies: {} }, SESSION);
const ok = (r: any, status = 200) => { assert.equal(r.statusCode, status, r.body); return r.json(); };
const refused = (r: any, status: number, pattern?: RegExp) => { assert.equal(r.statusCode, status, r.body); assert(!/SELECT |stack|dyna_api_/.test(r.body), r.body);
  if (pattern) assert.match(r.json().error, pattern); return r.json(); };
const count = async (sql: string, params: unknown[]) => (await pool.query(`SELECT count(*)::int n FROM ${sql}`, params)).rows[0].n as number;
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
const utcToday = async () => (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d")).rows[0].d as string;
const counter157 = async () => Number((await pool.query('SELECT coalesce(max(last_number),0)::int n FROM local_invoice_counters WHERE series_id=$1', [series.id])).rows[0].n);
const counter230 = async () => Number((await pool.query('SELECT coalesce(max(last_number),0)::int n FROM invoice230_counters WHERE series_id=$1', [series.id])).rows[0].n);
async function guards() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY'); await c.query('SET LOCAL search_path TO "$user",public'); await c.query("SET LOCAL statement_timeout='20s'");
    const out: Record<string, boolean> = {};
    for (const g of GUARDS) out[g] = (await c.query(`SELECT public.${g}() v`)).rows[0].v;
    await c.query('ROLLBACK'); return out;
  } finally { c.release(); }
}
const allTrue = Object.fromEntries(GUARDS.map(g => [g, true]));

/** A PLN order of one product to PL, paid, picked, packed and shipped (optional 226 profile). */
async function shipped(o: Owner, opts: { price: number; shipping?: number; profile?: Record<string, unknown> } = { price: 12300 }) {
  const sku = 'OV-' + randomBytes(4).toString('hex');
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: opts.price, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 10 })));
  if (opts.profile) ok(await call(o, 'PUT', `/api/products/${p.id}/tax-profile`, { version: null, gtu: null, annex15: false, ...opts.profile }));
  const local = (await tenantTx(o.tenant, c => createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Klient Limit', email: 'overflow157@example.test', warehouse_id: o.warehouse,
    currency: 'PLN', shipping_cost: opts.shipping ?? 1000, address: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' },
    items: [{ product_id: p.id, quantity: 1 }] })))).id as string;
  await tenantTx(o.tenant, async c => { await confirmOutstanding(c, o.actor, local); await advancePaid(c, o.actor, local); });
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  return local;
}
/** The exact body the 157 panel (web/local-invoices.tsx) sends. */
async function body157(o: Owner, local: string, clientKey = randomUUID()) {
  return { client_key: clientKey, series_id: series.id, order_version: await version(pool, local), shipping_vat: 23,
    buyer: { kind: 'consumer', name: 'Klient Limit', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, sell_date: await utcToday(),
    tax_regime: 'ordinary_domestic', consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true };
}
function errorHandler(label: string) {
  return (err: any, _req: any, reply: any) => {
    if (err instanceof Problem) return reply.code(err.status).send({ error: err.message, detail: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
    process.stderr.write(label + ' 500: ' + (err?.code ?? '') + ' ' + String(err?.message ?? err).slice(0, 400) + '\n');
    return reply.code(500).send({ error: 'Błąd serwera' });
  };
}
async function testApp(full: boolean) {
  const f = Fastify();
  f.decorateRequest('actor'); f.decorateRequest('currentUser'); f.decorateRequest('apiScopes'); f.decorateRequest('apiKeyId');
  f.addHook('onRequest', async (req: any) => {
    const as = JSON.parse(String(req.headers['x-test-as']));
    if (as.session) {
      req.actor = { tenantId: as.tenant, userId: as.user, role: as.role, source: 'session' };
      req.currentUser = { id: as.user, tenant_id: as.tenant, role: as.role }; req.cookies = { [SESSION]: as.session }; return;
    }
    req.actor = { tenantId: as.tenant, userId: as.user, role: as.role, apiKeyId: as.key, source: 'api' };
    req.currentUser = { id: as.user, tenant_id: as.tenant, role: as.role, api_key_id: as.key }; req.cookies = {};
    req.apiKeyId = as.key; req.apiScopes = (await pool.query('SELECT scopes FROM api_keys WHERE id=$1', [as.key])).rows[0].scopes;
  });
  f.setErrorHandler(errorHandler(full ? 'overflow' : 'bare'));
  // The same order as buildApp: the alias guard, the pinned native routes, then 226/230/232.
  registerLocalInvoiceIssueAlias(f, { tax226Available: true, readOnly: false, sessionName: SESSION });
  registerLocalInvoiceRoutes(f, { readOnly: false, sessionName: SESSION });
  registerTax226Routes(f, { available: true, readOnly: false, sessionName: SESSION });
  if (full) {
    registerFa3DocumentRoutes(f, { sessionName: SESSION });
    registerJpkRoutes(f, { sessionName: SESSION });
    registerNbp227Routes(f, { available: true, readOnly: false, sessionName: SESSION });
    registerInvoice230Routes(f, { available: true, readOnly: false, sessionName: SESSION });
    registerInvoice232Routes(f, { available: true, readOnly: false, sessionName: SESSION });
    registerSettlementReportRoutes(f, { readOnly: false });
    registerKsef229Routes(f, { available: true, readOnly: false, service: ksef229Service({ key: localConfig.encryptionKey, sessionName: SESSION, pollDelaysMs: [20, 40, 80, 160], timeoutMs: 5000 }) });
  }
  await f.ready();
  return f;
}

before(async () => {
  for (const name of ['invoice230_documents', 'invoice232_corrections', 'ksef229_submissions', 'base_wire220_invoice_ids', 'tax226_document_snapshots'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs 230/232/229/220: ' + name);
  assert.equal(await count('api_keys WHERE name=$1', [KEY_NAME]), 0, 'Fresh clone required; no rerun');
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
  bare = await testApp(false);
  app = await testApp(true);
  wireApp = Fastify();
  registerBaseWireRoutes(wireApp, { readOnly: false, families: [createBaseWireInvoicesFamily({ available: true, service: createDefaultBaseWireInvoicesService({ readOnly: false }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await wireApp.ready();
  const prefix = 'OV' + randomBytes(3).toString('hex').toUpperCase();
  const created = await createLocalInvoiceSeries(nativeActor(a), { client_key: randomUUID(), name: 'Seria limitu ' + prefix, prefix,
    seller: { name: 'Sprzedawca limitu', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: a.seller },
    payment_terms_days: 14, payment_instructions: 'Przelew na rachunek 00 1111 2222', notes: 'Dziękujemy', seller_vat_status: 'active_domestic' });
  series = { id: created.series.id, prefix };
  // Plant the company at the 157 limit: real previews of one shipped order until it has exactly 2000, through the
  // sealed SQL contract (local_invoice_store_preview inside the key's native identity frame) in ONE tenant transaction —
  // the same functions, triggers and budget checks as the native route, without 2000 transaction lifecycles.
  // IMMEDIATE: each preview's deferred local_invoice_complete check runs at its own statement, not all at COMMIT.
  const plant = await shipped(a), started = Date.now(), planted = await count('local_invoice_previews WHERE tenant_id=$1', [a.tenant]);
  const template = await body157(a, plant);
  for (let n = planted; n < LIMIT;) {
    const upto = Math.min(LIMIT, n + 100); // 100 per transaction: a failure shows early, a transaction stays short
    await tenantTx(a.tenant, async c => {
      await frame(c, { ...a.actor, source: 'api', apiKeyId: a.keyId }, a.token, true);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      for (let k = n; k < upto; k++)
        await c.query('SELECT local_invoice_store_preview($1,$2::jsonb,$3,$4)', [plant, JSON.stringify({ ...template, client_key: randomUUID() }), a.user, a.keyId]);
    });
    n = upto;
  }
  assert.equal(await count('local_invoice_previews WHERE tenant_id=$1', [a.tenant]), LIMIT);
  process.stderr.write(`planted ${LIMIT - planted} previews in ${Date.now() - started} ms\n`);
});
after(async () => { await app?.close(); await bare?.close(); await wireApp?.close(); await fake?.close(); await pool.end(); });

const fvs: Record<string, any> = {};
test('before: at the limit the pinned native 157 preview answers 23514 "Limit historii faktur" (409) and stores nothing', async () => {
  const order = await shipped(a), b = await body157(a, order);
  refused(await call(a, 'POST', `/api/local-invoices/orders/${order}/previews`, b, bare), 409, /^Limit historii faktur$/);
  await assert.rejects(previewLocalInvoice(nativeActor(a), order, b as any), (e: any) => e instanceof Problem && e.status === 409 && e.message === 'Limit historii faktur');
  assert.equal(await count('local_invoice_previews WHERE tenant_id=$1', [a.tenant]), LIMIT, 'the refused preview is not stored');
  assert.equal(await count('invoice230_previews WHERE order_id=$1', [order]), 0);
  fvs.order = order;
});

test('after: the same request is a FV-S (230) preview with the note; tax-issue and the /issue alias issue FV-S; 157 counter unchanged', async () => {
  const c157 = await counter157(), c230 = await counter230(), b = await body157(a, fvs.order);
  const pv = ok(await call(a, 'POST', `/api/local-invoices/orders/${fvs.order}/previews`, b), 201);
  const year = Number((await utcToday()).slice(0, 4));
  assert.equal(pv.invoice230, true); assert.equal(pv.series, 'FV-S'); assert.deepEqual(pv.overflow, { reason: 'previews', limit: LIMIT });
  assert.match(pv.series_note, new RegExp(`Limit faktur lokalnych B2C jest wyczerpany .*FV-S/${series.prefix}/${year}/…, a nie ${series.prefix}/${year}/…`));
  assert.equal(pv.issue_path, `/local-invoices/previews/${pv.preview.id}/tax-issue`);
  assert.deepEqual([pv.preview.snapshot.currency, pv.preview.snapshot.buyer.kind, pv.preview.snapshot.procedure, pv.preview.snapshot.series.prefix], ['PLN', 'consumer', 'domestic', series.prefix]);
  assert.deepEqual(pv.preview.snapshot.buyer.address, { street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' });
  assert.equal(pv.preview.snapshot.totals.gross_minor, '13300');
  assert.equal(await count("audit_events WHERE entity_id=$1 AND action='local_invoice.overflow230'", [pv.preview.id]), 1);
  // Lost answer: the same 157 request replays the same 230 preview.
  const replay = ok(await call(a, 'POST', `/api/local-invoices/orders/${fvs.order}/previews`, b), 200);
  assert.equal(replay.reused, true); assert.equal(replay.preview.id, pv.preview.id);
  assert.equal(await count('local_invoice_previews WHERE tenant_id=$1', [a.tenant]), LIMIT, 'no 157 preview is added');
  const issueBody = { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true, local_only: true };
  const r = ok(await call(a, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, issueBody), 201);
  assert.equal(r.invoice230, true); assert.equal(r.document.mode, 'invoice230');
  assert.equal(r.document.number, `FV-S/${series.prefix}/${year}/${String(c230 + 1).padStart(6, '0')}`);
  assert.equal(r.series, 'FV-S'); assert.equal(r.series_note, `Faktura wystawiona w podserii FV-S (numeracja 230): ${r.document.number}.`);
  assert.equal(ok(await call(a, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, issueBody), 200).document.id, r.document.id, 'issue replay');
  fvs.invoice = r.document;
  // A second order through the native /issue alias (the measured route of the load profile).
  const second = await shipped(a, { price: 4900 });
  const pv2 = ok(await call(a, 'POST', `/api/local-invoices/orders/${second}/previews`, await body157(a, second)), 201);
  const r2 = ok(await call(a, 'POST', `/api/local-invoices/previews/${pv2.preview.id}/issue`, { client_key: randomUUID(), scope_hash: pv2.preview.scope_hash, confirmed: true, local_only: true }), 201);
  assert.equal(r2.document.number, `FV-S/${series.prefix}/${year}/${String(c230 + 2).padStart(6, '0')}`); assert.match(r2.series_note, /podserii FV-S/);
  assert.equal(await counter157(), c157, 'the 157 counter does not move');
  assert.equal(await counter230(), c230 + 2);
  // The order now has an invoice: another preview is refused with the 230 reason, nothing numbered.
  refused(await call(a, 'POST', `/api/local-invoices/orders/${fvs.order}/previews`, await body157(a, fvs.order)), 409, /ma już fakturę/);
});

test('the FV-S invoice is in JPK_V7M of the period and in the settlement report; the fake KSeF accepts it; a KOR-S correction is issued', async () => {
  const d = fvs.invoice, period = (await utcToday()).slice(0, 7);
  const v7 = await session('GET', `/api/jpk/v7m.xml?okres=${period}&kod_urzedu=1206&email=ksiegowosc%40sklep.test`);
  assert.equal(v7.statusCode, 200, v7.body);
  const row = jpkRecords(v7.body, 'SprzedazWiersz').find(x => x.DowodSprzedazy === d.number);
  assert(row, 'JPK_V7M has the FV-S invoice');
  assert.deepEqual([row.K_19, row.K_20], ['108.13', '24.87']); // 133,00 zł gross at 23%
  const s = ok(await session('GET', `/api/settlement-report?from=${await utcToday()}&to=${await utcToday()}`));
  const line = s.rows.find((x: any) => x.order_id === d.order_id || x.order?.id === d.order_id);
  assert(line, 'the order is in the settlement report'); assert.match(JSON.stringify(line), new RegExp(d.number.replace(/\//g, '\\/')));
  ok(await session('PUT', '/api/ksef229/configs/' + a.seller, { environment: 'local_fake', base_url: fake.url, auth_method: 'token', token: TOKEN }));
  const sent = ok(await session('POST', `/api/ksef229/documents/${d.id}/send`)).submission;
  assert.deepEqual([sent.state, sent.document_kind, sent.document_number], ['accepted', 'invoice230', d.number]); assert(isKsefNumber(sent.ksef_number));
  const correction = { mode: 'cancellation' };
  const calc = ok(await call(a, 'POST', `/api/invoice232/invoices/${d.id}/calculate`, correction));
  assert.deepEqual(calc.blockers, []);
  const kp = ok(await call(a, 'POST', `/api/invoice232/invoices/${d.id}/previews`, { client_key: randomUUID(), correction }), 201);
  const kor = ok(await call(a, 'POST', `/api/invoice232/previews/${kp.preview.id}/issue`, { client_key: randomUUID(), scope_hash: kp.preview.scope_hash, confirmed: true }), 201).document;
  assert.match(kor.number, new RegExp(`^KOR-S/${series.prefix}/\\d{4}/\\d{6}$`));
  assert.equal(kor.data.totals.after.gross_minor, '0');
  // The consumer correction paths of 157 point to KOR-S for this order.
  refused(await call(a, 'GET', `/api/local-consumer-credits/orders/${d.order_id}/source`), 409, /KOR-S/);
});

test('Base addInvoice at the limit issues FV-S with invoice_number and local_note; getInvoices and getInvoiceFile read it', async () => {
  const order = await shipped(a, { price: 2500 }), c157 = await counter157(), c230 = await counter230();
  const listed = await wire(a, 'getInvoices', {}); assert.equal(listed.statusCode, 200, listed.body); // allocates the order's Base id
  const publicOrder = Number((await pool.query('SELECT public_id::text p FROM base_wire220_order_ids WHERE tenant_id=$1 AND local_id=$2', [a.tenant, order])).rows[0].p);
  assert.equal((await wire(a, 'getSeries', {})).statusCode, 200); // allocates the series' Base id
  const publicSeries = Number((await pool.query('SELECT public_id::text p FROM base_wire220_invoice_series_ids WHERE tenant_id=$1 AND local_id=$2', [a.tenant, series.id])).rows[0].p);
  const r = await wire(a, 'addInvoice', { order_id: publicOrder, series_id: publicSeries });
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json(); assert.equal(v.status, 'SUCCESS', r.body);
  const year = (await utcToday()).slice(0, 4);
  assert.equal(v.invoice_number, `FV-S/${series.prefix}/${year}/${String(c230 + 1).padStart(6, '0')}`);
  assert.match(v.local_note, /podserii FV-S .*Limit faktur lokalnych B2C \(157\) tej firmy jest wyczerpany/);
  assert.equal(await counter157(), c157); assert.equal(await counter230(), c230 + 1);
  const got = await wire(a, 'getInvoices', { invoice_id: v.invoice_id }); assert.equal(got.statusCode, 200, got.body);
  const inv = got.json().invoices; assert.equal(inv.length, 1);
  assert.deepEqual([inv[0].number, inv[0].order_id, inv[0].series_id, inv[0].currency, inv[0].total_price_brutto], [v.invoice_number, publicOrder, publicSeries, 'PLN', 35]);
  const file = await wire(a, 'getInvoiceFile', { invoice_id: v.invoice_id }); assert.equal(file.statusCode, 200, file.body);
  assert.equal(file.json().invoice_number, v.invoice_number);
  assert.match(Buffer.from(file.json().invoice.replace(/^data:/, ''), 'base64').toString('utf8'), new RegExp(v.invoice_number.replace(/\//g, '\\/')));
});

test('an order outside the 157 scope (ZW product) is refused with the reason; nothing stored or numbered; guards stay true', async () => {
  const order = await shipped(a, { price: 30000, profile: { category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'art. 43 ust. 1 pkt 29 lit. a ustawy o VAT' } });
  const c230 = await counter230(), previews230 = await count('invoice230_previews WHERE order_id=$1', [order]);
  refused(await call(a, 'POST', `/api/local-invoices/orders/${order}/previews`, await body157(a, order)), 409, /ZW\/NP\/OO\/OSS/);
  assert.equal(await count('invoice230_previews WHERE order_id=$1', [order]), previews230);
  assert.equal(await counter230(), c230);
  assert.deepEqual(await guards(), allTrue, 'guards true after');
});
