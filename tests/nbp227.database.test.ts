/** Native 227 NBP rates on a real disposable clone: the actual session routes (Fastify
 * injection with the request actor the auth hook would set) for stored rates, a read from
 * NBP through the ordinary port over recorded table A replies (no live network), manual
 * rates, the rate for a tax point; the PLN tax-issue and Base addInvoice (no record); and
 * the record of a foreign-currency document written by the issue-path functions in one
 * transaction (EUR invoices cannot be issued by 157 yet: shown here). Every expectation is
 * read back from the native rows. Root-only on a fresh clone dynaminds_nbp227_20261023_NN
 * migrated by real migrate() 218–227. The suite issues invoices; rerun = NEW clone. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tenantReadTx, tenantTx } from '../server/db';
import { Problem } from '../server/errors';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireOrdersFamily } from '../server/base-wire-orders';
import { createDefaultBaseWireOrdersService } from '../server/base-wire-orders-runtime';
import { createBaseWireInvoicesFamily } from '../server/base-wire-invoices';
import { createDefaultBaseWireInvoicesService } from '../server/base-wire-invoices-runtime';
import { createProduct } from '../server/catalog';
import { createOrder, issueDocument, orderSchema, productSchema, scan, shipDemo, type Actor } from '../server/domain';
import { advancePaid, confirmOutstanding } from '../server/payments';
import { transitionDirectLegacyOnReturnInTx } from '../server/legacy-return-on-command';
import { createLocalInvoiceSeries, previewLocalInvoice, localInvoiceRequestActor } from '../server/local-invoices';
import { localInvoiceLineAmounts } from '../server/local-invoice-values';
import { registerTax226Routes } from '../server/tax226-routes';
import { registerNbp227Routes } from '../server/nbp227-routes';
import { captureDocumentNbpRateInTx, documentNbpRateInTx, nbpRateForIssueInTx } from '../server/nbp227';
import { nbpLatestTableAReadPolicy } from '../server/nbp-exchange-rates';
import { nbp227ReadPolicy } from '../server/nbp227-fetch';
import { prepareOrdinaryNbpRates } from '../server/ordinary-provider-reads';
import { RECORDED_RANGE_20261009_20261022 } from './nbp227-fixtures';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_nbp227_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 20000;
const KEY_NAME = 'Isolated NBP rates 227 test';
const ALL = ['orders:read', 'orders:write', 'documents:read', 'documents:write', 'products:read', 'products:write'];
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; keyId: string; actor: Actor };
let session: FastifyInstance, offline: FastifyInstance, wire: FastifyInstance, a: Owner, b: Owner, readKey: Owner, series: { id: string; public: number };

/** Recorded NBP replies served by date: a range or day request gets the recorded tables in
 * those dates, or the recorded 404 "Brak danych". */
const recorded = JSON.parse(RECORDED_RANGE_20261009_20261022) as { rates: { no: string; effectiveDate: string; mid: number }[] };
const recordedText = (no: string) => RECORDED_RANGE_20261009_20261022.slice(RECORDED_RANGE_20261009_20261022.indexOf(`"no":"${no}"`) - 1).match(/^\{[^}]*\}/)![0];
let nbpCalls: string[] = [], nbpBroken = false;
async function nbpFixture(url: string) {
  nbpCalls.push(url);
  if (nbpBroken) return new Response('upstream error', { status: 500, headers: { 'content-type': 'text/plain' } });
  const m = /^https:\/\/api\.nbp\.pl\/api\/exchangerates\/rates\/a\/eur\/(\d{4}-\d{2}-\d{2})\/(?:(\d{4}-\d{2}-\d{2})\/)?\?format=json$/.exec(url);
  assert(m, url);
  const rows = recorded.rates.filter(r => r.effectiveDate >= m[1]! && r.effectiveDate <= (m[2] ?? m[1]!));
  if (!rows.length) return new Response('404 NotFound - Not Found - Brak danych', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(`{"table":"A","currency":"euro","code":"EUR","rates":[${rows.map(r => recordedText(r.no)).join(',')}]}`, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
const port = prepareOrdinaryNbpRates({ currencies: ['EUR'], maxAgeDays: 7 }, { routes: [...nbpLatestTableAReadPolicy('EUR').routes, ...nbp227ReadPolicy('EUR').routes] }, nbpFixture, { readOnly: false, localWooFixture: false })!;
const NOW = () => new Date('2026-10-23T10:00:00Z');

async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$7,$4,$5,$6,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), scopes, KEY_NAME]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, token, keyId: id,
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
function call(o: Owner, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown, role: Actor['role'] = 'admin', app = session) {
  const headers = { authorization: 'Bearer ' + o.token, 'x-test-as': JSON.stringify({ tenant: o.tenant, user: o.user, role, key: o.keyId }) };
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
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
const lastNumber = async () => Number((await pool.query('SELECT coalesce(max(last_number),0)::int n FROM local_invoice_counters WHERE series_id=$1', [series.id])).rows[0].n);
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
const stored = async (tenant: string) => (await pool.query(`SELECT to_char(effective_date,'YYYY-MM-DD') d,table_no,mid::text mid,to_char(covered_through,'YYYY-MM-DD') through,source
  FROM nbp227_rates WHERE tenant_id=$1 ORDER BY effective_date`, [tenant])).rows;

/** Base addOrder (paid) of 2 units, then picking, scans, packed and a demo shipment. */
async function shippedOrder(o: Owner) {
  const sku = 'NBP-' + randomBytes(4).toString('hex');
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 10 })));
  const pid = await publicId('base_wire220_product_ids', o.tenant, p.id), wid = await publicId('base_wire220_warehouse_ids', o.tenant, o.warehouse);
  const order = baseOk(await wire.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': o.token },
    payload: new URLSearchParams({ method: 'addOrder', parameters: JSON.stringify({ delivery_fullname: 'Jan Kurs', email: 'nbp@example.com', phone: '500600700', delivery_address: 'Prosta 1',
      delivery_postcode: '00-001', delivery_city: 'Warszawa', delivery_country_code: 'PL', currency: 'PLN', paid: 1, delivery_price: 10,
      products: [{ storage: 'db', product_id: String(pid), warehouse_id: wid, price_brutto: 25.5, tax_rate: 23, quantity: 2 }] }) }).toString() })).order_id as number;
  const local = (await pool.query('SELECT local_id FROM base_wire220_order_ids WHERE tenant_id=$1 AND public_id=$2', [o.tenant, order])).rows[0].local_id as string;
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  for (let n = 0; n < 2; n++) await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  return { order, local, sku };
}
/** An EUR order (EUR price list), paid, picked, packed and shipped by the native functions. */
async function shippedEurOrder(o: Owner) {
  const sku = 'NBPE-' + randomBytes(4).toString('hex');
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 10 })));
  const list = randomUUID();
  await tenantTx(o.tenant, async c => {
    await c.query("INSERT INTO price_lists(id,tenant_id,name,currency) VALUES($1,$2,'Cennik EUR 227','EUR')", [list, o.tenant]);
    await c.query('INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price) VALUES($1,$2,$3,2550)', [o.tenant, list, p.id]);
  });
  const local = (await tenantTx(o.tenant, c => createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Jan Kurs', email: 'nbp@example.com', warehouse_id: o.warehouse, currency: 'EUR',
    price_list_id: list, shipping_cost: 1000, address: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' }, items: [{ product_id: p.id, quantity: 2 }] })))).id as string;
  await tenantTx(o.tenant, async c => { await confirmOutstanding(c, o.actor, local); await advancePaid(c, o.actor, local); });
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  for (let n = 0; n < 2; n++) await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  return { local, sku };
}
const previewBody = async (o: Owner, local: string) => ({ client_key: randomUUID(), series_id: series.id, order_version: await tenantTx(o.tenant, c => version(c, local)), shipping_vat: 23 as const,
  buyer: { kind: 'consumer' as const, name: 'Klient kursowy', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' as const },
  sell_date: new Date().toISOString().slice(0, 10), tax_regime: 'ordinary_domestic' as const, consumer_sale_confirmed: true as const, no_special_tax_procedure_confirmed: true as const, not_fiscal_receipt_confirmed: true as const });

before(async () => {
  for (const name of ['nbp227_rates', 'nbp227_document_rates', 'nbp227_document_rate_vat', 'tax226_document_lines'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 227: ' + name);
  assert.equal((await pool.query("SELECT count(*)::int n FROM migrations WHERE name='227_nbp_rates'")).rows[0].n, 1);
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
  a = await key(rows[0], ALL); b = await key(rows[1], ALL); readKey = await key(rows[0], ['documents:read', 'orders:read']);
  const make = async (withPort: boolean) => {
    const app = Fastify();
    app.decorateRequest('actor'); app.decorateRequest('currentUser'); app.decorateRequest('apiScopes'); app.decorateRequest('apiKeyId');
    app.addHook('onRequest', async (req: any) => {
      const as = JSON.parse(String(req.headers['x-test-as'])), k = [a, b, readKey].find(o => o.keyId === as.key)!;
      req.actor = { tenantId: as.tenant, userId: as.user, role: as.role, apiKeyId: as.key, source: 'api' };
      req.currentUser = { id: as.user, tenant_id: as.tenant, role: as.role, api_key_id: as.key };
      req.apiKeyId = as.key; req.apiScopes = (await pool.query('SELECT scopes FROM api_keys WHERE id=$1', [k.keyId])).rows[0].scopes;
    });
    app.setErrorHandler((err: any, _req, reply) => {
      if (err instanceof Problem) return reply.code(err.status).send({ error: err.message });
      if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
      process.stderr.write('nbp227 test 500: ' + (err?.code ?? '') + ' ' + String(err?.message ?? err).slice(0, 300) + '\n');
      return reply.code(500).send({ error: 'Błąd serwera' });
    });
    registerTax226Routes(app, { available: true, readOnly: false, sessionName: 'dyna_session' });
    registerNbp227Routes(app, { available: true, readOnly: false, sessionName: 'dyna_session', ...(withPort ? { port } : {}), now: NOW });
    await app.ready();
    return app;
  };
  session = await make(true); offline = await make(false);
  wire = Fastify();
  registerBaseWireRoutes(wire, { readOnly: false, families: [
    createBaseWireOrdersFamily({ available: true, service: createDefaultBaseWireOrdersService({ readOnly: false, mergeClaims: true }) }),
    createBaseWireInvoicesFamily({ available: true, service: createDefaultBaseWireInvoicesService({ readOnly: false }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await wire.ready();
  const prefix = 'KN' + randomBytes(3).toString('hex').toUpperCase();
  const created = await createLocalInvoiceSeries(nativeActor(a), { client_key: randomUUID(), name: 'Seria 227 ' + prefix, prefix,
    seller: { name: 'Sprzedawca testowy', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: '5260250274' },
    payment_terms_days: 14, payment_instructions: 'Przelew', notes: 'Dziękujemy', seller_vat_status: 'active_domestic' });
  baseOk(await wire.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': a.token },
    payload: new URLSearchParams({ method: 'getSeries', parameters: '{}' }).toString() }));
  series = { id: created.series.id, public: await publicId('base_wire220_invoice_series_ids', a.tenant, created.series.id) };
});
after(async () => { await session?.close(); await offline?.close(); await wire?.close(); await pool.end(); });

test('NBP range read is cached with proven coverage; tax points over a weekend use Friday; refusals write nothing', async () => {
  assert.deepEqual(ok(await call(a, 'GET', '/api/nbp227/rates?currency=EUR')), { currency: 'EUR', read_only: false, can_fetch: true, can_manual: true, today: '2026-10-23', rates: [] });
  assert.equal(ok(await call(a, 'GET', '/api/nbp227/rates?currency=EUR', undefined, 'operator', offline)).can_fetch, false);
  refused(await call(a, 'POST', '/api/nbp227/rates/fetch', { currency: 'EUR', start: '2026-10-09', end: '2026-10-22' }, 'admin', offline), 503, /nie został włączony/);
  refused(await call(readKey, 'POST', '/api/nbp227/rates/fetch', { currency: 'EUR', start: '2026-10-09', end: '2026-10-22' }), 403, /documents:write/);
  refused(await call(a, 'POST', '/api/nbp227/rates/fetch', { currency: 'EUR', start: '2026-10-09', end: '2026-10-22' }, 'viewer'), 403);
  refused(await call(a, 'POST', '/api/nbp227/rates/fetch', { currency: 'EUR', start: '2026-10-20', end: '2026-10-24' }), 422, /przyszłości/);
  refused(await call(a, 'POST', '/api/nbp227/rates/fetch', { currency: 'USD', start: '2026-10-09', end: '2026-10-22' }), 422, /EUR/);
  nbpBroken = true;
  refused(await call(a, 'POST', '/api/nbp227/rates/fetch', { currency: 'EUR', start: '2026-10-09', end: '2026-10-22' }), 502, /Wpisz kurs ręcznie/);
  nbpBroken = false;
  assert.deepEqual(await stored(a.tenant), [], 'refusals and a failed read store nothing');
  nbpCalls = [];
  const f = ok(await call(a, 'POST', '/api/nbp227/rates/fetch', { currency: 'EUR', start: '2026-10-09', end: '2026-10-22' }, 'operator'));
  assert.deepEqual(nbpCalls, ['https://api.nbp.pl/api/exchangerates/rates/a/eur/2026-10-09/2026-10-22/?format=json']);
  assert.equal(f.publications, 10);
  const rows = await stored(a.tenant);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.find(r => r.d === '2026-10-16'), { d: '2026-10-16', table_no: '202/A/NBP/2026', mid: '4.3661', through: '2026-10-18', source: 'fetched' });
  assert.deepEqual(rows.at(-1), { d: '2026-10-22', table_no: '206/A/NBP/2026', mid: '4.3685', through: '2026-10-22', source: 'fetched' });
  // Same read again: same rows, no duplicates; a fetch for a tax point reads the 14 days before it.
  ok(await call(a, 'POST', '/api/nbp227/rates/fetch', { currency: 'EUR', start: '2026-10-09', end: '2026-10-22' }));
  nbpCalls = [];
  ok(await call(a, 'POST', '/api/nbp227/rates/fetch', { currency: 'EUR', tax_point: '2026-10-23' }));
  assert.deepEqual(nbpCalls, ['https://api.nbp.pl/api/exchangerates/rates/a/eur/2026-10-09/2026-10-22/?format=json']);
  assert.deepEqual(await stored(a.tenant), rows);
  for (const [tp, table, mid] of [['2026-10-19', '202/A/NBP/2026', '4.3661'], ['2026-10-17', '202/A/NBP/2026', '4.3661'], ['2026-10-16', '201/A/NBP/2026', '4.3691'], ['2026-10-23', '206/A/NBP/2026', '4.3685']]) {
    const r = ok(await call(readKey, 'GET', `/api/nbp227/rate-for?currency=EUR&tax_point=${tp}&vat_minor=2300`));
    assert.deepEqual([r.rate.table_no, r.rate.mid, r.refusal], [table, mid, null], tp);
  }
  const monday = ok(await call(a, 'GET', '/api/nbp227/rate-for?currency=EUR&tax_point=2026-10-19&vat_minor=2300'));
  assert.equal(monday.vat_pln_minor, '10042');
  assert.equal(monday.line, 'Kurs NBP z dnia 16.10.2026, tabela 202/A/NBP/2026, 1 EUR = 4,3661 PLN; VAT w PLN: 100,42 zł');
  const none = ok(await call(a, 'GET', '/api/nbp227/rate-for?currency=EUR&tax_point=2026-10-09'));
  assert.equal(none.rate, null); assert.match(none.refusal, /Brak kursu NBP.*09\.10\.2026/);
  const unproven = ok(await call(a, 'GET', '/api/nbp227/rate-for?currency=EUR&tax_point=2026-10-24'));
  assert.equal(unproven.rate, null); assert.match(unproven.refusal, /nie jest potwierdzony/);
  assert.deepEqual(ok(await call(b, 'GET', '/api/nbp227/rates?currency=EUR')).rates, [], 'other tenant sees nothing');
  assert.equal(await count("audit_events WHERE tenant_id=$1 AND action='nbp.rates_fetch'", [a.tenant]), 3);
});

test('manual rate: admin only, never over NBP data or into a proven gap; it serves the tax points it declares', async () => {
  const manual = { currency: 'EUR', effective_date: '2026-10-08', table_no: '196/A/NBP/2026', mid: '4,3800'.replace(',', '.'), covered_through: '2026-10-08' };
  refused(await call(a, 'PUT', '/api/nbp227/rates/manual', manual, 'operator'), 403, /administrator/);
  refused(await call(a, 'PUT', '/api/nbp227/rates/manual', { ...manual, mid: '4.38001' }), 422, /4 miejscami/);
  refused(await call(a, 'PUT', '/api/nbp227/rates/manual', { ...manual, covered_through: '2026-10-10' }), 409, /197\/A\/NBP\/2026 z dnia 09\.10\.2026/);
  refused(await call(a, 'PUT', '/api/nbp227/rates/manual', { ...manual, effective_date: '2026-10-16', table_no: '202/A/NBP/2026', covered_through: '2026-10-16' }), 409, /pobrany z NBP/);
  refused(await call(a, 'PUT', '/api/nbp227/rates/manual', { ...manual, effective_date: '2026-10-17', table_no: '777/A/NBP/2026', covered_through: '2026-10-17' }), 409, /nie było tabeli/);
  refused(await call(a, 'PUT', '/api/nbp227/rates/manual', { ...manual, table_no: '201/A/NBP/2026' }), 409, /innego dnia/);
  refused(await call(a, 'PUT', '/api/nbp227/rates/manual', { ...manual, effective_date: '2026-10-24', covered_through: '2026-10-24' }), 422, /opublikowanej/);
  assert.equal((await stored(a.tenant)).length, 10, 'refusals store nothing');
  const saved = ok(await call(a, 'PUT', '/api/nbp227/rates/manual', manual)).rate;
  assert.deepEqual([saved.effective_date, saved.mid, saved.source, saved.covered_through], ['2026-10-08', '4.3800', 'manual', '2026-10-08']);
  const r = ok(await call(a, 'GET', '/api/nbp227/rate-for?currency=EUR&tax_point=2026-10-09&vat_minor=100'));
  assert.deepEqual([r.rate.table_no, r.rate.source, r.vat_pln_minor], ['196/A/NBP/2026', 'manual', '438']);
  assert.equal(ok(await call(a, 'GET', '/api/nbp227/rate-for?currency=EUR&tax_point=2026-10-08')).rate, null, 'never the tax point day itself');
  assert.equal(await count("audit_events WHERE tenant_id=$1 AND action='nbp.rate_manual'", [a.tenant]), 1);
});

test('PLN tax-issue and Base addInvoice store no NBP record; the detail says the rate does not apply', async () => {
  const x = await shippedOrder(a), before = await lastNumber();
  const p = (await previewLocalInvoice(nativeActor(a), x.local, await previewBody(a, x.local))).preview;
  const issued = ok(await call(a, 'POST', `/api/local-invoices/previews/${p.id}/tax-issue`, { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true, local_only: true }), 201);
  assert.equal(issued.receipt.sequence, before + 1);
  assert.equal(issued.document.data.currency, 'PLN');
  assert.equal(await count('nbp227_document_rates WHERE document_id=$1', [issued.document.id]), 0);
  const v = ok(await call(a, 'GET', `/api/local-invoices/documents/${issued.document.id}/nbp`));
  assert.deepEqual([v.currency, v.nbp, v.note], ['PLN', null, 'Faktura w PLN — przeliczenie kursem NBP nie dotyczy.']);
  refused(await call(b, 'GET', `/api/local-invoices/documents/${issued.document.id}/nbp`), 404);
  const y = await shippedOrder(a);
  baseOk(await wire.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': a.token },
    payload: new URLSearchParams({ method: 'addInvoice', parameters: JSON.stringify({ order_id: y.order, series_id: series.public }) }).toString() }));
  const doc = (await pool.query("SELECT id FROM documents WHERE order_id=$1 AND mode='local_invoice'", [y.local])).rows[0].id;
  assert.equal(await count('nbp227_document_rates WHERE document_id=$1', [doc]), 0);
  assert.equal(await lastNumber(), before + 2);
});

test('foreign-currency record: refused without a rate (no row), stored with the issue in one transaction, permanent and identical on re-read', async () => {
  const x = await shippedEurOrder(a);
  // 157 refuses a local invoice for an EUR order today; the 227 issue hooks are reached only by a future foreign-currency issue.
  await assert.rejects(previewLocalInvoice(nativeActor(a), x.local, await previewBody(a, x.local)), /pieniądze faktury/);
  // A real EUR document row (DEMO path) is the target of the record written by the issue-path functions.
  const d = await tenantTx(a.tenant, c => issueDocument(c, a.actor, x.local, 'invoice'));
  assert.equal(d.data.currency, 'EUR');
  const items = (await pool.query('SELECT line_total::text g FROM order_items WHERE order_id=$1', [x.local])).rows.map(r => localInvoiceLineAmounts(r.g, 23));
  const ship = localInvoiceLineAmounts(String((await pool.query('SELECT shipping_cost::text s FROM orders WHERE id=$1', [x.local])).rows[0].s), 23);
  const sum = (k: 'net_minor' | 'vat_minor' | 'gross_minor') => [...items, ship].reduce((n, l) => n + BigInt(l[k]), 0n).toString();
  const source = (sell: string) => ({ currency: 'EUR', sell_date: sell, issue_date: '2026-10-23', vat_totals: [{ vat_rate: 23, net_minor: sum('net_minor'), vat_minor: sum('vat_minor'), gross_minor: sum('gross_minor') }] });
  await assert.rejects(tenantTx(a.tenant, async c => { await nbpRateForIssueInTx(c, source('2026-10-05')); await captureDocumentNbpRateInTx(c, a.actor, d.id, source('2026-10-05'), true); }),
    (e: any) => e instanceof Problem && e.status === 409 && /Brak kursu NBP \(tabela A, EUR\) sprzed daty obowiązku podatkowego 05\.10\.2026/.test(e.message));
  assert.equal(await count('nbp227_document_rates WHERE document_id=$1', [d.id]), 0, 'refusal stores no record');
  await tenantTx(a.tenant, async c => { const chosen = await nbpRateForIssueInTx(c, source('2026-10-19')); assert.equal(chosen!.rate.table_no, '202/A/NBP/2026');
    await captureDocumentNbpRateInTx(c, a.actor, d.id, source('2026-10-19'), true); });
  const head = (await pool.query('SELECT *,mid::text mid,to_char(rate_date,\'YYYY-MM-DD\') rd,to_char(tax_point,\'YYYY-MM-DD\') tp FROM nbp227_document_rates WHERE document_id=$1', [d.id])).rows[0];
  const vat = BigInt(sum('vat_minor')), net = BigInt(sum('net_minor'));
  assert.deepEqual([head.currency, head.tp, head.tax_point_basis, head.rd, head.table_no, head.mid, head.rate_source, head.captured_with_issue, head.api_key_id ?? null],
    ['EUR', '2026-10-19', 'sell_date', '2026-10-16', '202/A/NBP/2026', '4.3661', 'fetched', true, null]);
  assert.equal(String(head.vat_pln_minor), ((vat * 43661n + 5000n) / 10000n).toString());
  assert.equal(String(head.net_pln_minor), ((net * 43661n + 5000n) / 10000n).toString());
  assert.equal(String(head.gross_minor), sum('gross_minor'));
  const first = await tenantReadTx(a.tenant, c => documentNbpRateInTx(c, d.id));
  assert.equal(first!.line, `Kurs NBP z dnia 16.10.2026, tabela 202/A/NBP/2026, 1 EUR = 4,3661 PLN; VAT w PLN: ${(Number(head.vat_pln_minor) / 100).toFixed(2).replace('.', ',')} zł`);
  // Replay of the capture adds nothing; later rates do not change the record; the record is permanent.
  await tenantTx(a.tenant, c => captureDocumentNbpRateInTx(c, a.actor, d.id, source('2026-10-23'), true));
  ok(await call(a, 'PUT', '/api/nbp227/rates/manual', { currency: 'EUR', effective_date: '2026-10-07', table_no: '195/A/NBP/2026', mid: '4.4000', covered_through: '2026-10-07' }));
  assert.deepEqual(await tenantReadTx(a.tenant, c => documentNbpRateInTx(c, d.id)), first, 'same rate on re-read');
  assert.equal(await count('nbp227_document_rate_vat WHERE document_id=$1', [d.id]), 1);
  await assert.rejects(pool.query('UPDATE nbp227_document_rates SET mid=4 WHERE document_id=$1', [d.id]), /permanent/);
  await assert.rejects(pool.query('DELETE FROM nbp227_document_rate_vat WHERE document_id=$1', [d.id]), /permanent/);
  assert.equal(await tenantReadTx(b.tenant, c => documentNbpRateInTx(c, d.id)), null, 'RLS: other tenant sees no record');
  assert.equal(await count("audit_events WHERE entity_id=$1 AND action='document.nbp_rate'", [d.id]), 1);
});
