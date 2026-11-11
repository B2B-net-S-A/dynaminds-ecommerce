/** Invoices 230 on a real disposable clone: the actual session routes (Fastify injection with the
 * request actor the auth hook would set) issue, through POST …/tax-issue, a PL B2B 23% invoice
 * with MPP, ZW with its basis, NP II to a DE business, OO to a PL VAT payer, OSS to a DE consumer
 * and EUR invoices with the stored NBP rate; 157 invoices before and after keep their own sequence.
 * FA(3) XML, print, JPK_V7M and the settlement report are read back for them; refusals write
 * nothing. Root-only on a fresh clone dynaminds_inv230_20261023_NN with 230 installed.
 * The suite issues invoices; rerun = NEW clone. */
import test, { before, after } from 'node:test';
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
import { createLocalInvoiceSeries, previewLocalInvoice, localInvoiceRequestActor } from '../server/local-invoices';
import { registerTax226Routes } from '../server/tax226-routes';
import { registerNbp227Routes } from '../server/nbp227-routes';
import { registerInvoice230Routes } from '../server/invoice230-routes';
import { registerFa3DocumentRoutes } from '../server/fa3-document-routes';
import { registerJpkRoutes } from '../server/jpk-routes';
import { registerSettlementReportRoutes } from '../server/settlement-report-routes';
import { registerLocalConsumerCreditRoutes } from '../server/local-consumer-credit-routes';
import { jpkRecords, jpkValues, minorOf } from './jpk-fixtures';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_(inv230_20261023|xsd30_20261030|relxsd_20261030)_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 30000;
const KEY_NAME = 'Isolated invoices 230 test';
const SESSION = 'dyna_session';
const ALL = ['orders:read', 'orders:write', 'documents:read', 'documents:write', 'products:read', 'products:write'];
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; keyId: string; actor: Actor; seller: string };
let app: FastifyInstance, a: Owner, b: Owner, readKey: Owner, viewer: Owner, series: { id: string; prefix: string }, seriesB: { id: string; prefix: string };
let sessionToken = '';

async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string; seller: string | null }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$7,$4,$5,$6,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), scopes, KEY_NAME]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, token, keyId: id, seller: row.seller ?? '5260250274',
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
function call(o: Owner, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown, role: Actor['role'] = 'admin') {
  const headers = { authorization: 'Bearer ' + o.token, 'x-test-as': JSON.stringify({ tenant: o.tenant, user: o.user, role, key: o.keyId }) };
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
}
const sessionGet = (url: string) => app.inject({ url, headers: { 'x-test-as': JSON.stringify({ tenant: a.tenant, user: a.user, role: 'admin', session: sessionToken }) } });
const nativeActor = (o: Owner) => localInvoiceRequestActor({ actor: { tenantId: o.tenant, userId: o.user, role: 'admin', source: 'api', apiKeyId: o.keyId },
  apiKeyId: o.keyId, currentUser: { id: o.user, tenant_id: o.tenant }, headers: { authorization: 'Bearer ' + o.token }, cookies: {} }, SESSION);
const ok = (r: any, status = 200) => { assert.equal(r.statusCode, status, r.body); return r.json(); };
const refused = (r: any, status: number, pattern?: RegExp) => { assert.equal(r.statusCode, status, r.body); assert(!/SELECT |stack|dyna_api_/.test(r.body), r.body);
  if (pattern) assert.match(r.json().error, pattern); return r.json(); };
const count = async (sql: string, params: unknown[]) => (await pool.query(`SELECT count(*)::int n FROM ${sql}`, params)).rows[0].n as number;
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
const utcToday = async () => (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d")).rows[0].d as string;
const xmlOf = (body: string, tagName: string) => [...body.matchAll(new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'g'))].map(m => m[1]);

type Profile = { category: 'standard' | 'zw' | 'np' | 'oo'; exemption_basis_kind?: 'P_19A'; exemption_basis?: string; np_kind?: 'np_ii' | 'np_i'; annex15?: boolean };
/** A product with its 226 profile, an order of `qty` units (PLN, or EUR through a price list) to `country`, paid, picked, packed and shipped. */
async function shipped(o: Owner, opts: { price: number; qty?: number; shipping?: number; country?: string; currency?: 'PLN' | 'EUR'; profile?: Profile }) {
  const sku = 'I230-' + randomBytes(4).toString('hex'), qty = opts.qty ?? 1;
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: opts.price, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 10 })));
  if (opts.profile) ok(await call(o, 'PUT', `/api/products/${p.id}/tax-profile`, { version: null, gtu: null, annex15: false, ...opts.profile }));
  let list: string | undefined;
  if (opts.currency === 'EUR') {
    list = randomUUID();
    await tenantTx(o.tenant, async c => {
      await c.query("INSERT INTO price_lists(id,tenant_id,name,currency) VALUES($1,$2,$3,'EUR')", [list, o.tenant, 'Cennik EUR 230 ' + sku]);
      await c.query('INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price) VALUES($1,$2,$3,$4)', [o.tenant, list, p.id, opts.price]);
    });
  }
  const country = opts.country ?? 'PL';
  const local = (await tenantTx(o.tenant, c => createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Nabywca 230', email: 'inv230@example.com', warehouse_id: o.warehouse,
    currency: opts.currency ?? 'PLN', ...(list ? { price_list_id: list } : {}), shipping_cost: opts.shipping ?? 0,
    address: { street: 'Prosta 1', city: country === 'PL' ? 'Warszawa' : 'Berlin', postal_code: country === 'PL' ? '00-001' : '10115', country, phone: '500600700' },
    items: [{ product_id: p.id, quantity: qty }] })))).id as string;
  await tenantTx(o.tenant, async c => { await confirmOutstanding(c, o.actor, local); await advancePaid(c, o.actor, local); });
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  for (let n = 0; n < qty; n++) await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  return { local, sku, product: p.id as string };
}
const addr = (country: string) => ({ street: country === 'PL' ? 'Długa 5' : 'Hauptstraße 5', postal_code: country === 'PL' ? '00-002' : '10115', city: country === 'PL' ? 'Warszawa' : 'Berlin', country });
const BUYERS = {
  plB2B: { kind: 'business', name: 'Hurtownia Polska Sp. z o.o.', address: addr('PL'), tax_id: '526-025-02-74', pl_vat_payer: true },
  deB2B: { kind: 'business', name: 'Muster GmbH', address: addr('DE'), tax_id: 'DE123456789' },
  deB2BnoId: { kind: 'business', name: 'Muster GmbH', address: addr('DE') },
  deConsumer: { kind: 'consumer', name: 'Hans Muster', address: addr('DE') },
} as const;
async function body(o: Owner, local: string, buyer: unknown, s = series) {
  return { series_id: s.id, order_version: await tenantTx(o.tenant, c => version(c, local)), shipping_vat: 23 as const, buyer, sell_date: await utcToday() };
}
/** calculate → preview → tax-issue; returns the issue reply. */
async function issue230(o: Owner, local: string, buyer: unknown) {
  const req = await body(o, local, buyer), calc = ok(await call(o, 'POST', `/api/invoice230/orders/${local}/calculate`, req));
  assert.deepEqual(calc.blockers, [], JSON.stringify(calc.blockers));
  const pv = ok(await call(o, 'POST', `/api/invoice230/orders/${local}/previews`, { client_key: randomUUID(), ...req }), 201);
  assert.deepEqual(pv.preview.snapshot, calc.snapshot, 'the preview stores what calculate showed');
  const issueBody = { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true, local_only: true };
  const r = ok(await call(o, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, issueBody), 201);
  assert.equal(r.invoice230, true);
  const replay = ok(await call(o, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, issueBody), 200);
  assert.equal(replay.reused, true); assert.equal(replay.document.id, r.document.id);
  return r;
}
async function issue157(o: Owner, local: string) {
  const p = await previewLocalInvoice(nativeActor(o), local, { client_key: randomUUID(), series_id: series.id, order_version: await tenantTx(o.tenant, c => version(c, local)), shipping_vat: 23,
    buyer: { kind: 'consumer', name: 'Klient 157', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, sell_date: await utcToday(),
    tax_regime: 'ordinary_domestic', consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true } as any);
  return call(o, 'POST', `/api/local-invoices/previews/${p.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: p.preview.scope_hash, confirmed: true, local_only: true });
}
const guards = async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY'); await c.query('SET LOCAL search_path TO "$user",public'); await c.query("SET LOCAL statement_timeout='8s'");
    const out: Record<string, boolean> = {};
    for (const g of ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid', 'return_credit211_metadata_valid',
      'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards']) out[g] = (await c.query(`SELECT public.${g}() v`)).rows[0].v;
    await c.query('ROLLBACK'); return out;
  } finally { c.release(); }
};

before(async () => {
  for (const name of ['invoice230_documents', 'invoice230_categories', 'invoice230_counters', 'invoice230_previews', 'nbp227_document_rates', 'tax226_document_lines'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs 230: ' + name);
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY_NAME])).rows[0].n, 0, 'Fresh clone required; no rerun');
  assert(Object.values(await guards()).every(Boolean), 'guards true before');
  const rows = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse,
    (SELECT coalesce(d.data#>>'{seller,tax_id}',d.data#>>'{fiscal_snapshot,seller,tax_id}') FROM documents d WHERE d.tenant_id=m.tenant_id AND d.mode IN ('local_invoice','b2b_invoice') LIMIT 1) seller
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE (SELECT currency FROM tenants t WHERE t.id=m.tenant_id)='PLN'
    AND NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND EXISTS(SELECT 1 FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)
    ORDER BY (SELECT plan FROM tenants t WHERE t.id=m.tenant_id)='enterprise' DESC,m.tenant_id LIMIT 2`)).rows;
  assert.equal(rows.length, 2);
  a = await key(rows[0], ALL); b = await key(rows[1], ALL); readKey = await key(rows[0], ['documents:read', 'orders:read']);
  // The native identity reads the membership role from the database: a real viewer of tenant a.
  const v = (await pool.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='viewer' ORDER BY user_id LIMIT 1", [a.tenant])).rows[0];
  assert(v, 'seed needs a viewer in tenant a');
  viewer = await key({ ...rows[0], user_id: v.user_id }, ALL);
  sessionToken = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at,account_version,mfa_verified_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',coalesce((SELECT version FROM account_security WHERE user_id=$2),0),clock_timestamp())`, [tokenHash(sessionToken), a.user, a.tenant]);
  app = Fastify();
  app.decorateRequest('actor'); app.decorateRequest('currentUser'); app.decorateRequest('apiScopes'); app.decorateRequest('apiKeyId');
  app.addHook('onRequest', async (req: any) => {
    const as = JSON.parse(String(req.headers['x-test-as']));
    if (as.session) {
      req.actor = { tenantId: as.tenant, userId: as.user, role: as.role, source: 'session' };
      req.currentUser = { id: as.user, tenant_id: as.tenant, role: as.role }; req.cookies = { [SESSION]: as.session }; return;
    }
    const k = [a, b, readKey, viewer].find(o => o.keyId === as.key)!;
    req.actor = { tenantId: as.tenant, userId: as.user, role: as.role, apiKeyId: as.key, source: 'api' };
    req.currentUser = { id: as.user, tenant_id: as.tenant, role: as.role, api_key_id: as.key }; req.cookies = {};
    req.apiKeyId = as.key; req.apiScopes = (await pool.query('SELECT scopes FROM api_keys WHERE id=$1', [k.keyId])).rows[0].scopes;
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ error: err.message, detail: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
    process.stderr.write('invoice230 test 500: ' + (err?.code ?? '') + ' ' + String(err?.message ?? err).slice(0, 400) + '\n');
    return reply.code(500).send({ error: 'Błąd serwera' });
  });
  registerTax226Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerNbp227Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerInvoice230Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerFa3DocumentRoutes(app, { sessionName: SESSION });
  registerJpkRoutes(app, { sessionName: SESSION });
  registerSettlementReportRoutes(app, { readOnly: false });
  registerLocalConsumerCreditRoutes(app, { readOnly: false, sessionName: SESSION });
  await app.ready();
  const mk = async (o: Owner) => {
    const prefix = 'S' + randomBytes(3).toString('hex').toUpperCase();
    const created = await createLocalInvoiceSeries(nativeActor(o), { client_key: randomUUID(), name: 'Seria 230 ' + prefix, prefix,
      seller: { name: 'Sprzedawca 230', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: o.seller },
      payment_terms_days: 14, payment_instructions: 'Przelew na rachunek 00 1111 2222', notes: 'Dziękujemy', seller_vat_status: 'active_domestic' });
    return { id: created.series.id as string, prefix };
  };
  series = await mk(a); seriesB = await mk(b);
  ok(await call(a, 'PUT', '/api/tax/oss', { version: (ok(await call(a, 'GET', '/api/tax/oss')).settings.version), registered: true, registered_from: '2026-07-01',
    rates: [{ country: 'DE', rate_class: 'standard', rate: 19 }] }));
  // NBP table A of the day before today (the tax point is today's sell date).
  const y = new Date(Date.parse(await utcToday() + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
  ok(await call(a, 'PUT', '/api/nbp227/rates/manual', { currency: 'EUR', effective_date: y, table_no: `205/A/NBP/${y.slice(0, 4)}`, mid: '4.2563', covered_through: y }));
});
after(async () => { await app?.close(); await pool.end(); });

const issued: Record<string, any> = {};
test('230 invoices of every category are issued in the FV-S sub-series; 157 keeps its own sequence before and after', async () => {
  const first157 = ok(await issue157(a, (await shipped(a, { price: 12300, shipping: 1000 })).local), 201);
  assert.match(first157.document.number, new RegExp(`^${series.prefix}/\\d{4}/000001$`));
  // PL B2B 23% with an annex-15 product over 15 000 zł: MPP.
  const mpp = await shipped(a, { price: 1_700_000, profile: { category: 'standard', annex15: true } });
  issued.b2b = await issue230(a, mpp.local, BUYERS.plB2B);
  // ZW with its basis, NP II to a DE business, OO to a PL VAT payer, OSS to a DE consumer.
  issued.zw = await issue230(a, (await shipped(a, { price: 50000, shipping: 1500, profile: { category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'art. 43 ust. 1 pkt 29 lit. a ustawy o VAT' } })).local, BUYERS.plB2B);
  issued.np2 = await issue230(a, (await shipped(a, { price: 80000, profile: { category: 'np', np_kind: 'np_ii' } })).local, BUYERS.deB2B);
  issued.oo = await issue230(a, (await shipped(a, { price: 60000, profile: { category: 'oo' } })).local, BUYERS.plB2B);
  issued.oss = await issue230(a, (await shipped(a, { price: 11900, qty: 2, shipping: 1190, country: 'DE' })).local, BUYERS.deConsumer);
  // EUR: B2B PL 23% (227 record too) and NP II to a DE business (PLN amounts in 230 only).
  issued.eur = await issue230(a, (await shipped(a, { price: 123000, shipping: 1230, currency: 'EUR' })).local, BUYERS.plB2B);
  issued.eurNp = await issue230(a, (await shipped(a, { price: 40000, currency: 'EUR', profile: { category: 'np', np_kind: 'np_ii' } })).local, BUYERS.deB2B);
  const second157 = ok(await issue157(a, (await shipped(a, { price: 4900, shipping: 1000 })).local), 201);
  assert.match(second157.document.number, new RegExp(`^${series.prefix}/\\d{4}/000002$`), '157 sequence continues after the 230 issues');
  const year = (await utcToday()).slice(0, 4), numbers = Object.values(issued).map((r: any) => r.document.number);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7].map(n => `FV-S/${series.prefix}/${year}/${String(n).padStart(6, '0')}`), 'continuous 230 sub-series');
  assert.equal((await pool.query('SELECT last_number FROM local_invoice_counters WHERE series_id=$1', [series.id])).rows[0].last_number, 2);
  assert.equal((await pool.query('SELECT last_number FROM invoice230_counters WHERE series_id=$1', [series.id])).rows[0].last_number, 7);
  // Stored categories and annotations.
  const cats = (r: any) => r.document.data.categories.map((c: any) => [c.key, c.net_minor, c.vat_minor]);
  assert.deepEqual(cats(issued.b2b), [['23', '1382114', '317886']]);
  assert.equal(issued.b2b.document.data.mpp.required, true);
  assert.deepEqual(cats(issued.zw), [['zw', '51500', '0']]);
  assert.deepEqual(issued.zw.document.data.exemption, { kind: 'P_19A', basis: 'art. 43 ust. 1 pkt 29 lit. a ustawy o VAT' });
  assert.deepEqual(cats(issued.np2), [['np II', '80000', '0']]);
  assert.equal(issued.np2.document.data.buyer.tax_id, 'DE123456789');
  assert.deepEqual(cats(issued.oo), [['oo', '60000', '0']]);
  assert.deepEqual(cats(issued.oss), [['oss 19.00', '21000', '3990']]);
  assert.equal(issued.oss.document.data.procedure, 'oss');
  const eur = issued.eur.document.data;
  assert.equal(eur.currency, 'EUR'); assert.equal(eur.nbp.mid, '4.2563'); assert.match(eur.nbp.line, /^Kurs NBP z dnia \d\d\.\d\d\.\d{4}, tabela 205\/A\/NBP\/\d{4}, 1 EUR = 4,2563 PLN; VAT w PLN: /);
  assert.deepEqual(cats(issued.eur), [['23', '101000', '23230']]);
  assert.deepEqual(eur.nbp.categories.map((c: any) => [c.key, c.net_pln_minor, c.vat_pln_minor]), [['23', '429886', '98874']]); // 1010,00 × 4,2563 = 4298,86; 232,30 × 4,2563 = 988,74
  const r227 = (await pool.query('SELECT mid::text mid,vat_pln_minor::text v,net_pln_minor::text n FROM nbp227_document_rates WHERE document_id=$1', [issued.eur.document.id])).rows[0];
  assert.deepEqual(r227, { mid: '4.2563', v: '98874', n: '429886' }, '227 rate record written in the same transaction');
  assert.equal(await count('nbp227_document_rates WHERE document_id=$1', [issued.eurNp.document.id]), 0, 'NP II has no 227 VAT bucket');
  assert.deepEqual(issued.eurNp.document.data.nbp.categories.map((c: any) => [c.key, c.net_pln_minor]), [['np II', '170252']]);
  assert.equal(await count('invoice230_categories WHERE document_id=$1 AND mid=4.2563', [issued.eurNp.document.id]), 1);
  // A 157 issue of an order that already has a 230 invoice is refused; so is a second 230 invoice.
  refused(await issue157(a, issued.b2b.document.order_id), 409, /fakturę 230/);
  refused(await call(a, 'POST', `/api/invoice230/orders/${issued.b2b.document.order_id}/previews`, { client_key: randomUUID(), ...(await body(a, issued.b2b.document.order_id, BUYERS.plB2B)) }), 409, /ma już fakturę/);
  assert(Object.values(await guards()).every(Boolean), 'guards true after the issues');
});

test('refusals: NP II without EU VAT ID, OSS without registration, EUR without rate, viewer and read-only key 403 — nothing numbered', async () => {
  const before230 = await count('invoice230_documents', []), beforePreviews = await count('invoice230_previews', []);
  const np = await shipped(a, { price: 30000, profile: { category: 'np', np_kind: 'np_ii' } });
  const calc = ok(await call(a, 'POST', `/api/invoice230/orders/${np.local}/calculate`, await body(a, np.local, BUYERS.deB2BnoId)));
  assert.match(calc.blockers.join(), /NP II .*numerem VAT UE/); assert.equal(calc.issuable, false);
  refused(await call(a, 'POST', `/api/invoice230/orders/${np.local}/previews`, { client_key: randomUUID(), ...(await body(a, np.local, BUYERS.deB2BnoId)) }), 409, /NP II/);
  refused(await call(a, 'POST', `/api/invoice230/orders/${np.local}/previews`, { client_key: randomUUID(), ...(await body(a, np.local, { ...BUYERS.plB2B, tax_id: '5260250275' })) }), 422, /NIP/);
  refused(await call(a, 'POST', `/api/invoice230/orders/${np.local}/previews`, { client_key: randomUUID(), ...(await body(a, np.local, { ...BUYERS.deB2B, tax_id: 'DE12345' })) }), 422, /formatu numeru VAT DE/);
  refused(await call(a, 'PUT', `/api/products/${np.product}/tax-profile`, { version: 1, gtu: null, annex15: false, category: 'zw', exemption_basis_kind: 'P_19A' }), 422, /podstawy prawnej/);
  const ossB = await shipped(b, { price: 11900, country: 'DE' });
  refused(await call(b, 'POST', `/api/invoice230/orders/${ossB.local}/previews`, { client_key: randomUUID(), ...(await body(b, ossB.local, BUYERS.deConsumer, seriesB)) }), 409, /rejestracji OSS/);
  const eurB = await shipped(b, { price: 10000, currency: 'EUR' });
  refused(await call(b, 'POST', `/api/invoice230/orders/${eurB.local}/previews`, { client_key: randomUUID(), ...(await body(b, eurB.local, BUYERS.plB2B, seriesB)) }), 409, /kurs|tabel/i);
  const plain = await shipped(a, { price: 20000 });
  refused(await call(viewer, 'POST', `/api/invoice230/orders/${plain.local}/previews`, { client_key: randomUUID(), ...(await body(viewer, plain.local, BUYERS.plB2B)) }, 'viewer'), 403);
  refused(await call(readKey, 'POST', `/api/invoice230/orders/${plain.local}/previews`, { client_key: randomUUID(), ...(await body(readKey, plain.local, BUYERS.plB2B)) }), 403);
  assert.equal(ok(await call(readKey, 'POST', `/api/invoice230/orders/${plain.local}/calculate`, await body(readKey, plain.local, BUYERS.plB2B))).issuable, true, 'a reader may calculate');
  const pv = ok(await call(a, 'POST', `/api/invoice230/orders/${plain.local}/previews`, { client_key: randomUUID(), ...(await body(a, plain.local, BUYERS.plB2B)) }), 201);
  refused(await call(a, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: '0'.repeat(64), confirmed: true, local_only: true }), 409, /innego podglądu/);
  refused(await call(viewer, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true, local_only: true }, 'viewer'), 403);
  assert.equal(await count('invoice230_documents', []), before230, 'no document from a refusal');
  assert.equal(await count('invoice230_previews', []), beforePreviews + 1, 'only the accepted preview is stored');
  // Since cbb245b this route is the alias of the KOR-S preview (232), reached in corrections232.database.test.ts with a valid
  // body: an empty body is the 422 of the body validation and writes nothing. The older correction paths keep their refusal.
  const previews232 = await count('invoice232_previews', []);
  refused(await call(a, 'POST', `/api/invoice230/documents/${issued.b2b.document.id}/corrections`, {}), 422);
  assert.equal(await count('invoice232_previews', []), previews232, 'no KOR-S preview from a refused body');
  refused(await call(a, 'GET', `/api/local-consumer-credits/orders/${issued.oss.document.order_id}/source`), 409, /Korekta faktury FV-S/);
  const owner = await pool.connect();
  try {
    for (const sql of ['UPDATE invoice230_documents SET mpp_required=false', 'DELETE FROM invoice230_categories', 'UPDATE invoice230_counters SET last_number=last_number+5', 'TRUNCATE invoice230_previews CASCADE'])
      await assert.rejects(owner.query(sql), /nienaruszalny|przesuwa się tylko o jeden|nie można usunąć/, sql);
  } finally { owner.release(); }
});

test('FA(3) XML, print, JPK_V7M and the settlement report carry the 230 invoices', async () => {
  const xml = async (r: any) => { const x = await call(a, 'GET', `/api/fa3/documents/${r.document.id}/fa3.xml`); assert.equal(x.statusCode, 200, x.body); return x.body as string; };
  const b2b = await xml(issued.b2b);
  assert.deepEqual([xmlOf(b2b, 'NIP')[1], xmlOf(b2b, 'P_12')[0], xmlOf(b2b, 'P_13_1')[0], xmlOf(b2b, 'P_14_1')[0], xmlOf(b2b, 'P_18A')[0], xmlOf(b2b, 'P_15')[0]],
    ['5260250274', '23', '13821.14', '3178.86', '1', '17000.00']);
  const zw = await xml(issued.zw);
  assert.deepEqual([xmlOf(zw, 'P_12')[0], xmlOf(zw, 'P_13_7')[0], xmlOf(zw, 'P_19')[0], xmlOf(zw, 'P_19A')[0]], ['zw', '515.00', '1', 'art. 43 ust. 1 pkt 29 lit. a ustawy o VAT']);
  const np2 = await xml(issued.np2);
  assert.deepEqual([xmlOf(np2, 'KodUE')[0], xmlOf(np2, 'NrVatUE')[0], xmlOf(np2, 'P_12')[0], xmlOf(np2, 'P_13_9')[0], xmlOf(np2, 'P_18')[0]], ['DE', '123456789', 'np II', '800.00', '1']);
  const oo = await xml(issued.oo);
  assert.deepEqual([xmlOf(oo, 'P_12')[0], xmlOf(oo, 'P_13_10')[0], xmlOf(oo, 'P_18')[0], xmlOf(oo, 'P_18A')[0]], ['oo', '600.00', '1', '2']);
  const oss = await xml(issued.oss);
  assert.deepEqual([xmlOf(oss, 'BrakID')[0], xmlOf(oss, 'P_12_XII')[0], xmlOf(oss, 'P_13_5')[0], xmlOf(oss, 'P_14_5')[0]], ['1', '19.00', '210.00', '39.90']);
  const eur = await xml(issued.eur);
  assert.deepEqual([xmlOf(eur, 'KodWaluty')[0], xmlOf(eur, 'KursWaluty')[0], xmlOf(eur, 'P_13_1')[0], xmlOf(eur, 'P_14_1')[0], xmlOf(eur, 'P_14_1W')[0]], ['EUR', '4.2563', '1010.00', '232.30', '988.74']);
  assert.equal(xmlOf(eur, 'KursWaluty').length, 2, 'KursWaluty on every line');
  const eurNp = await xml(issued.eurNp);
  assert.deepEqual([xmlOf(eurNp, 'KodWaluty')[0], xmlOf(eurNp, 'KursWaluty')[0], xmlOf(eurNp, 'P_13_9')[0]], ['EUR', '4.2563', '400.00']);
  const print = async (r: any) => { const p = await call(a, 'GET', `/api/invoice230/documents/${r.document.id}/print`); assert.equal(p.statusCode, 200, p.body); return p.body as string; };
  assert.match(await print(issued.b2b), /mechanizm podzielonej płatności[\s\S]*NIP: 5260250274/);
  assert.match(await print(issued.np2), /odwrotne obciążenie[\s\S]*Numer VAT UE: DE123456789/);
  assert.match(await print(issued.zw), /Zwolnienie z VAT: art\. 43 ust\. 1 pkt 29 lit\. a ustawy o VAT/);
  assert.match(await print(issued.oss), /Procedura szczególna OSS/);
  assert.match(await print(issued.eur), /Kurs NBP z dnia [\s\S]*VAT w PLN/);
  const period = (await utcToday()).slice(0, 7);
  const v7 = await sessionGet(`/api/jpk/v7m.xml?okres=${period}&kod_urzedu=1206&email=ksiegowosc%40sklep.test`);
  assert.equal(v7.statusCode, 200, v7.body);
  const rows = jpkRecords(v7.body, 'SprzedazWiersz'), row = (r: any) => rows.find(x => x.DowodSprzedazy === r.document.number)!;
  // JPK_V7(3) has no MPP marker in the ewidencja (MPP stays in FA(3) P_18A).
  assert.deepEqual([row(issued.b2b).K_19, row(issued.b2b).K_20, row(issued.b2b).MPP, row(issued.b2b).NrKontrahenta], ['13821.14', '3178.86', undefined, '5260250274']);
  assert.equal(row(issued.zw).K_10, '515.00');
  assert.deepEqual([row(issued.np2).K_11, row(issued.np2).K_12, row(issued.np2).KodKrajuNadaniaTIN, row(issued.np2).NrKontrahenta], ['800.00', '800.00', 'DE', '123456789']);
  // oo has no seller field in JPK_V7(3) (K_31/K_32 are art. 17 ust. 1 pkt 5): the invoice is listed without K_.
  assert.deepEqual([row(issued.oo).K_31, Object.keys(row(issued.oo)).filter(k => k.startsWith('K_'))], [undefined, []]);
  assert.deepEqual([row(issued.oss).K_11, row(issued.oss).WSTO_EE], ['210.00', '1']);
  assert.deepEqual([row(issued.eur).K_19, row(issued.eur).K_20], ['4298.86', '988.74']);
  assert.deepEqual([row(issued.eurNp).K_11, row(issued.eurNp).K_12], ['1702.52', '1702.52']);
  assert(jpkValues(v7.body).PodatekNalezny, 'declaration totals present');
  assert(minorOf(row(issued.b2b).K_20) > 0n);
  const settlement = await sessionGet(`/api/settlement-report?from=${await utcToday()}&to=${await utcToday()}`);
  assert.equal(settlement.statusCode, 200, settlement.body);
  const s = settlement.json(), line = (r: any) => s.rows.find((x: any) => x.order_id === r.document.order_id || x.order?.id === r.document.order_id);
  assert(line(issued.b2b), 'the 230 invoice order is in the settlement report');
  assert.match(JSON.stringify(line(issued.b2b)), new RegExp(issued.b2b.document.number.replace(/\//g, '\\/')));
  assert(Object.values(await guards()).every(Boolean), 'guards true after the reads');
});
