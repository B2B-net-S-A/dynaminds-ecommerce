/** KOR-S corrections (232) on a real disposable clone through the actual session/API routes (Fastify
 * injection with the actor the auth hook would set) and the local fake KSeF:
 * - FV-S invoices: PL B2B 23% PLN, NP II EUR to a DE business, OSS to a DE consumer;
 * - corrections: from a received return (then the refund), a price decrease and an increase of the
 *   NP II EUR invoice (rate of the invoice), a cancellation of the OSS invoice; KOR-S numbers continuous,
 *   the 157 and 230 counters unchanged;
 * - refusals that number nothing: beyond the invoiced quantity, a viewer and a read-only key (403),
 *   an invalid reason (422), a second cancellation, a second correction of the same return;
 * - settlement report "zgodne" after the return correction and its refund, FA(3) KOR read back,
 *   KSeF send of the invoice and of its correction (accepted on the fake), JPK_V7M and JPK_FA rows,
 *   RODO keeping the corrections for the tax retention, the guards true before and after.
 * Root-only on a fresh clone dynaminds_kor232_20261025_NN with 232. Rerun = NEW clone. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localConfig, pool, tenantTx } from '../server/db';
import { Problem } from '../server/errors';
import { tokenHash } from '../server/security';
import { createProduct } from '../server/catalog';
import { createOrder, orderSchema, productSchema, scan, shipDemo, type Actor } from '../server/domain';
import { advancePaid, confirmOutstanding } from '../server/payments';
import { transitionDirectLegacyOnReturnInTx } from '../server/legacy-return-on-command';
import { getReturn, receiveReturn, recordRefund, requestReturn, returnInput } from '../server/returns';
import { createLocalInvoiceSeries, localInvoiceRequestActor } from '../server/local-invoices';
import { registerTax226Routes } from '../server/tax226-routes';
import { registerNbp227Routes } from '../server/nbp227-routes';
import { registerInvoice230Routes } from '../server/invoice230-routes';
import { registerInvoice232Routes } from '../server/invoice232-routes';
import { registerFa3DocumentRoutes } from '../server/fa3-document-routes';
import { registerJpkRoutes } from '../server/jpk-routes';
import { registerSettlementReportRoutes } from '../server/settlement-report-routes';
import { registerKsef229Routes, ksef229Service } from '../server/ksef229-routes';
import { registerRodo228Routes } from '../server/rodo228-routes';
import { startFakeKsef, type FakeKsef } from '../server/ksef229-fake';
import { isKsefNumber } from '../server/ksef229-crypto';
import { jpkRecords } from './jpk-fixtures';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_(kor232_2026102[45]|xsd30_20261030)_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 60000;
const KEY_NAME = 'Isolated corrections 232 test';
const SESSION = 'dyna_session', TOKEN = 'lokalny-token-' + randomBytes(12).toString('hex');
const ALL = ['orders:read', 'orders:write', 'documents:read', 'documents:write', 'products:read', 'products:write'];
const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid', 'return_credit211_metadata_valid',
  'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards'];
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; keyId: string; actor: Actor; seller: string };
let app: FastifyInstance, fake: FakeKsef, a: Owner, readKey: Owner, viewer: Owner, series: { id: string; prefix: string }, sessionToken = '';

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
const session = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-as': JSON.stringify({ tenant: a.tenant, user: a.user, role: 'admin', session: sessionToken }) }, ...(payload === undefined ? {} : { payload: payload as any }) });
const nativeActor = (o: Owner) => localInvoiceRequestActor({ actor: { tenantId: o.tenant, userId: o.user, role: 'admin', source: 'api', apiKeyId: o.keyId },
  apiKeyId: o.keyId, currentUser: { id: o.user, tenant_id: o.tenant }, headers: { authorization: 'Bearer ' + o.token }, cookies: {} }, SESSION);
const ok = (r: any, status = 200) => { assert.equal(r.statusCode, status, r.body); return r.json(); };
const refused = (r: any, status: number, pattern?: RegExp) => { assert.equal(r.statusCode, status, r.body); assert(!/SELECT |stack|dyna_api_/.test(r.body), r.body);
  if (pattern) assert.match(r.json().error ?? r.json().detail, pattern); return r.json(); };
const count = async (sql: string, params: unknown[] = []) => (await pool.query(`SELECT count(*)::int n FROM ${sql}`, params)).rows[0].n as number;
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
const utcToday = async () => (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d")).rows[0].d as string;
const xmlOf = (body: string, tagName: string) => [...body.matchAll(new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'g'))].map(m => m[1]);
const counters = async () => ({
  fv157: Number((await pool.query('SELECT coalesce(sum(last_number),0)::int n FROM local_invoice_counters WHERE series_id=$1', [series.id])).rows[0].n),
  fvs: Number((await pool.query('SELECT coalesce(sum(last_number),0)::int n FROM invoice230_counters WHERE series_id=$1', [series.id])).rows[0].n),
  kor: Number((await pool.query('SELECT coalesce(sum(last_number),0)::int n FROM invoice232_counters WHERE series_id=$1', [series.id])).rows[0].n),
  corrections: await count('invoice232_corrections WHERE tenant_id=$1', [a.tenant]),
});
async function guards() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY'); await c.query('SET LOCAL search_path TO "$user",public'); await c.query("SET LOCAL statement_timeout='120s'");
    const out: Record<string, boolean> = {};
    for (const g of GUARDS) out[g] = (await c.query(`SELECT public.${g}() v`)).rows[0].v;
    await c.query('ROLLBACK'); return out;
  } finally { c.release(); }
}
const allTrue = Object.fromEntries(GUARDS.map(g => [g, true]));

type Profile = { category: 'standard' | 'np'; np_kind?: 'np_ii' };
/** A product with its 226 profile and an order of `qty` units (PLN, or EUR through a price list), paid, picked, packed and shipped. */
async function shipped(o: Owner, opts: { price: number; qty?: number; shipping?: number; country?: string; currency?: 'PLN' | 'EUR'; profile?: Profile; email: string }) {
  const sku = 'K232-' + randomBytes(4).toString('hex'), qty = opts.qty ?? 1;
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: opts.price, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 20 })));
  if (opts.profile) ok(await call(o, 'PUT', `/api/products/${p.id}/tax-profile`, { version: null, gtu: null, annex15: false, ...opts.profile }));
  let list: string | undefined;
  if (opts.currency === 'EUR') {
    list = randomUUID();
    await tenantTx(o.tenant, async c => {
      await c.query("INSERT INTO price_lists(id,tenant_id,name,currency) VALUES($1,$2,$3,'EUR')", [list, o.tenant, 'Cennik EUR 232 ' + sku]);
      await c.query('INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price) VALUES($1,$2,$3,$4)', [o.tenant, list, p.id, opts.price]);
    });
  }
  const country = opts.country ?? 'PL';
  const local = (await tenantTx(o.tenant, c => createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Nabywca 232', email: opts.email, warehouse_id: o.warehouse,
    currency: opts.currency ?? 'PLN', ...(list ? { price_list_id: list } : {}), shipping_cost: opts.shipping ?? 0,
    address: { street: 'Prosta 1', city: country === 'PL' ? 'Warszawa' : 'Berlin', postal_code: country === 'PL' ? '00-001' : '10115', country, phone: '500600722' },
    items: [{ product_id: p.id, quantity: qty }] })))).id as string;
  await tenantTx(o.tenant, async c => { await confirmOutstanding(c, o.actor, local); await advancePaid(c, o.actor, local); });
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  for (let n = 0; n < qty; n++) await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  return local;
}
const addr = (country: string) => ({ street: country === 'PL' ? 'Długa 5' : 'Hauptstraße 5', postal_code: country === 'PL' ? '00-002' : '10115', city: country === 'PL' ? 'Warszawa' : 'Berlin', country });
const BUYERS = {
  plB2B: { kind: 'business', name: 'Hurtownia Polska Sp. z o.o.', address: addr('PL'), tax_id: '526-025-02-74', pl_vat_payer: true },
  deB2B: { kind: 'business', name: 'Muster GmbH', address: addr('DE'), tax_id: 'DE123456789' },
  deConsumer: { kind: 'consumer', name: 'Hans Muster', address: addr('DE') },
} as const;
async function issue230(o: Owner, local: string, buyer: unknown) {
  const req = { series_id: series.id, order_version: await tenantTx(o.tenant, c => version(c, local)), shipping_vat: 23 as const, buyer, sell_date: await utcToday() };
  const pv = ok(await call(o, 'POST', `/api/invoice230/orders/${local}/previews`, { client_key: randomUUID(), ...req }), 201);
  const r = ok(await call(o, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true, local_only: true }), 201);
  assert.equal(r.invoice230, true);
  return r.document;
}
/** calculate → preview → issue of a KOR-S correction (plus the issue replay); returns the issued correction. */
async function correct(o: Owner, invoiceId: string, correction: unknown) {
  const calc = ok(await call(o, 'POST', `/api/invoice232/invoices/${invoiceId}/calculate`, correction));
  assert.deepEqual(calc.blockers, [], JSON.stringify(calc.blockers));
  const pv = ok(await call(o, 'POST', `/api/invoice232/invoices/${invoiceId}/previews`, { client_key: randomUUID(), correction }), 201);
  assert.deepEqual(pv.preview.snapshot, calc.snapshot, 'the preview stores what calculate showed');
  const body = { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true };
  const r = ok(await call(o, 'POST', `/api/invoice232/previews/${pv.preview.id}/issue`, body), 201);
  const replay = ok(await call(o, 'POST', `/api/invoice232/previews/${pv.preview.id}/issue`, body), 200);
  assert.equal(replay.reused, true); assert.equal(replay.document.id, r.document.id);
  return r.document;
}

before(async () => {
  for (const name of ['invoice232_corrections', 'invoice232_categories', 'invoice232_counters', 'invoice232_previews', 'invoice230_documents', 'ksef229_submissions'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs 232: ' + name);
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
  a = await key(rows[0], ALL); readKey = await key(rows[0], ['documents:read', 'orders:read']);
  const v = (await pool.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='viewer' ORDER BY user_id LIMIT 1", [a.tenant])).rows[0];
  assert(v, 'seed needs a viewer in tenant a');
  viewer = await key({ ...rows[0], user_id: v.user_id }, ALL);
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
    process.stderr.write('corrections232 test 500: ' + (err?.code ?? '') + ' ' + String(err?.message ?? err).slice(0, 400) + '\n');
    return reply.code(500).send({ error: 'Błąd serwera' });
  });
  registerFa3DocumentRoutes(app, { sessionName: SESSION });
  registerJpkRoutes(app, { sessionName: SESSION });
  registerTax226Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerNbp227Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerRodo228Routes(app, { available: true, readOnly: false, pool, key: localConfig.encryptionKey });
  registerInvoice230Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerInvoice232Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerSettlementReportRoutes(app, { readOnly: false });
  registerKsef229Routes(app, { available: true, readOnly: false, service: ksef229Service({ key: localConfig.encryptionKey, sessionName: SESSION, pollDelaysMs: [20, 40, 80, 160], timeoutMs: 5000 }) });
  await app.ready();
  const prefix = 'K' + randomBytes(3).toString('hex').toUpperCase();
  const created = await createLocalInvoiceSeries(nativeActor(a), { client_key: randomUUID(), name: 'Seria 232 ' + prefix, prefix,
    seller: { name: 'Sprzedawca 232', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: a.seller },
    payment_terms_days: 14, payment_instructions: 'Przelew na rachunek 00 1111 2222', notes: 'Dziękujemy', seller_vat_status: 'active_domestic' });
  series = { id: created.series.id as string, prefix };
  ok(await call(a, 'PUT', '/api/tax/oss', { version: (ok(await call(a, 'GET', '/api/tax/oss')).settings.version), registered: true, registered_from: '2026-07-01',
    rates: [{ country: 'DE', rate_class: 'standard', rate: 19 }] }));
  const y = new Date(Date.parse(await utcToday() + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
  ok(await call(a, 'PUT', '/api/nbp227/rates/manual', { currency: 'EUR', effective_date: y, table_no: `205/A/NBP/${y.slice(0, 4)}`, mid: '4.2737', covered_through: y }));
  ok(await session('PUT', '/api/ksef229/configs/' + a.seller, { environment: 'local_fake', base_url: fake.url, auth_method: 'token', token: TOKEN }));
});
after(async () => { await app?.close(); await fake?.close(); await pool.end(); });

const inv: Record<string, any> = {}, kor: Record<string, any> = {};
let start: Awaited<ReturnType<typeof counters>>;
test('KOR-S: a return correction of a FV-S B2B 23% invoice sent to KSeF, then the refund: settlement "zgodne"; the correction goes to KSeF too', async () => {
  inv.b2b = await issue230(a, await shipped(a, { price: 12300, qty: 3, shipping: 1500, email: 'kor232-b2b@example.test' }), BUYERS.plB2B);
  inv.np2 = await issue230(a, await shipped(a, { price: 33333, qty: 3, currency: 'EUR', profile: { category: 'np', np_kind: 'np_ii' }, email: 'kor232-np@example.test' }), BUYERS.deB2B);
  inv.oss = await issue230(a, await shipped(a, { price: 11900, qty: 2, shipping: 1190, country: 'DE', email: 'kor232-oss@example.test' }), BUYERS.deConsumer);
  start = await counters();
  assert.deepEqual([start.fvs, start.kor, start.corrections], [3, 0, 0]);
  // The FV-S invoice is sent to KSeF first: the correction then names its KSeF number.
  const sent = ok(await session('POST', `/api/ksef229/documents/${inv.b2b.id}/send`)).submission;
  assert.equal(sent.state, 'accepted'); assert(isKsefNumber(sent.ksef_number));
  // A return of 1 unit, received; the editor lists it.
  const order = inv.b2b.order_id, item = (await pool.query('SELECT id FROM order_items WHERE order_id=$1', [order])).rows[0].id;
  const rc = await tenantTx(a.tenant, c => requestReturn(c, a.actor, order, returnInput.parse({ client_key: randomUUID(), reason: 'Zwrot 232', items: [{ item_id: item, quantity: 1 }] })));
  const early = ok(await call(a, 'POST', `/api/invoice232/invoices/${inv.b2b.id}/calculate`, { mode: 'return', return_id: rc.id }));
  assert.match(early.blockers.join(' '), /nie został przyjęty/, 'a return not yet received cannot be corrected');
  await tenantTx(a.tenant, async c => { const r = await getReturn(c, rc.id); await receiveReturn(c, a.actor, rc.id, { version: Number(r.version), shipping_refund: 0, note: 'Przyjęto zwrot 232', items: [{ item_id: item, accepted: 1, restocked: 1 }] }); });
  const state = ok(await call(a, 'GET', `/api/invoice232/invoices/${inv.b2b.id}`));
  assert.deepEqual(state.returns.map((r: any) => [r.id, r.received, r.corrected_by]), [[rc.id, true, null]]);
  kor.ret = await correct(a, inv.b2b.id, { mode: 'return', return_id: rc.id });
  const year = (await utcToday()).slice(0, 4);
  assert.equal(kor.ret.number, `KOR-S/${series.prefix}/${year}/000001`);
  assert.deepEqual([kor.ret.data.kind, kor.ret.data.reason, kor.ret.data.totals.delta.gross_minor, kor.ret.data.original.ksef_number], ['return', 'Zwrot towaru', '-12300', sent.ksef_number]);
  assert.deepEqual(kor.ret.data.categories.map((c: any) => [c.key, c.delta.net_minor, c.delta.vat_minor]), [['23', '-10000', '-2300']]);
  assert.equal(ok(await call(a, 'GET', `/api/invoice232/invoices/${inv.b2b.id}`)).returns[0].corrected_by, kor.ret.number);
  refused(await call(a, 'POST', `/api/invoice232/invoices/${inv.b2b.id}/previews`, { client_key: randomUUID(), correction: { mode: 'return', return_id: rc.id } }), 409, /ma już korektę/);
  // The refund of the return closes it; the settlement row is "zgodne".
  await tenantTx(a.tenant, async c => { const r = await getReturn(c, rc.id); await recordRefund(c, a.actor, rc.id, { version: Number(r.version), amount: r.settlement_amount, reference: 'Przelew zwrotu 232', confirmed: true }); });
  const day = await utcToday(), report = ok(await session('GET', `/api/settlement-report?from=${day}&to=${day}`));
  const row = report.rows.find((r: any) => r.order_id === order);
  assert(row, JSON.stringify(report).slice(0, 400));
  assert.deepEqual([row.status, row.invoice_count, row.correction_count, row.correction_numbers], ['zgodne', 1, 1, [kor.ret.number]], JSON.stringify(row));
  assert.equal(String(row.documented), String(row.amount_due));
  // FA(3) KOR read back and sent to KSeF.
  const x = await call(a, 'GET', `/api/fa3/documents/${kor.ret.id}/fa3.xml`);
  assert.equal(x.statusCode, 200, x.body);
  for (const part of ['<RodzajFaktury>KOR</RodzajFaktury>', '<TypKorekty>2</TypKorekty>', `<NrFaKorygowanej>${inv.b2b.number}</NrFaKorygowanej>`, `<NrKSeFFaKorygowanej>${sent.ksef_number}</NrKSeFFaKorygowanej>`,
    '<PrzyczynaKorekty>Zwrot towaru</PrzyczynaKorekty>', '<P_13_1>-100.00</P_13_1><P_14_1>-23.00</P_14_1>', '<P_15>-123.00</P_15>', '<StanPrzed>1</StanPrzed>', `<P_2>${kor.ret.number}</P_2>`])
    assert(x.body.includes(part), part + '\n' + x.body);
  const ks = ok(await session('POST', `/api/ksef229/documents/${kor.ret.id}/send`)).submission;
  assert.deepEqual([ks.state, ks.document_kind], ['accepted', 'invoice232_correction']); assert(isKsefNumber(ks.ksef_number));
  assert.equal(fake.invoices().at(-1)!.xml, x.body, 'the exact FA(3) KOR file was sent');
  assert.equal((await pool.query('SELECT xml_sha256 FROM ksef229_submissions WHERE document_id=$1', [kor.ret.id])).rows[0].xml_sha256, createHash('sha256').update(x.body).digest('hex'));
  const print = await call(a, 'GET', `/api/invoice232/corrections/${kor.ret.id}/print`);
  assert.equal(print.statusCode, 200); assert.match(print.body, /Faktura korygująca KOR-S/); assert.match(print.body, new RegExp(sent.ksef_number));
});

test('KOR-S of NP II EUR: price decrease and an increase at the invoice rate; OSS cancellation; refusals number nothing; counters', async () => {
  // Decrease: 3 × 333,33 EUR → 900,00 EUR.
  kor.np2 = await correct(a, inv.np2.id, { mode: 'manual', reason_code: 'obnizka_ceny', reason_note: 'Uzgodnienie z 24.10', lines: [{ line_no: 1, quantity: 3, gross_minor: '90000' }] });
  const d = kor.np2.data;
  assert.deepEqual([d.currency, d.nbp.mid, d.nbp.basis, d.kind, d.totals.delta.gross_minor], ['EUR', '4.2737', 'original_invoice', 'price', '-9999']);
  assert.equal(d.pln_totals.delta.net_pln_minor, String(Math.round(90000 * 4.2737) - Math.round(99999 * 4.2737)));
  assert.equal((await pool.query('SELECT mid::text m FROM invoice232_corrections WHERE id=$1', [kor.np2.id])).rows[0].m, inv.np2.data.nbp.mid);
  const x = (await call(a, 'GET', `/api/fa3/documents/${kor.np2.id}/fa3.xml`)).body;
  for (const part of ['<KodWaluty>EUR</KodWaluty>', '<KodUE>DE</KodUE><NrVatUE>123456789</NrVatUE>', '<P_13_9>-99.99</P_13_9>', '<P_18>1</P_18>', '<NrKSeFN>1</NrKSeFN>'])
    assert(x.includes(part), part + '\n' + x);
  assert.equal(xmlOf(x, 'KursWaluty').length, 2); assert(xmlOf(x, 'KursWaluty').every(v => v === '4.2737'));
  // Increase after the sale (chain position 2): back to 950,00 EUR.
  kor.np2up = await correct(a, inv.np2.id, { mode: 'manual', reason_code: 'podwyzka_ceny', lines: [{ line_no: 1, quantity: 3, gross_minor: '95000' }] });
  assert.deepEqual([kor.np2up.data.position, kor.np2up.data.direction, kor.np2up.data.totals.before.gross_minor, kor.np2up.data.totals.delta.gross_minor], [2, 'increase', '90000', '5000']);
  // OSS: cancellation to zero; a second one is refused.
  kor.oss = await correct(a, inv.oss.id, { mode: 'cancellation' });
  assert.deepEqual([kor.oss.data.kind, kor.oss.data.totals.after.gross_minor, kor.oss.data.categories[0].key], ['cancellation', '0', 'oss 19.00']);
  const before = await counters();
  refused(await call(a, 'POST', `/api/invoice232/invoices/${inv.oss.id}/previews`, { client_key: randomUUID(), correction: { mode: 'cancellation' } }), 409, /już skorygowana do zera/);
  refused(await call(a, 'POST', `/api/invoice232/invoices/${inv.b2b.id}/previews`, { client_key: randomUUID(), correction: { mode: 'manual', reason_code: 'podwyzka_ceny', lines: [{ line_no: 1, quantity: 5 }] } }), 409, /przekracza ilość zafakturowaną \(3\)/);
  refused(await call(a, 'POST', `/api/invoice232/invoices/${inv.b2b.id}/previews`, { client_key: randomUUID(), correction: { mode: 'manual', reason_code: 'kaprys', lines: [{ line_no: 1, quantity: 1 }] } }), 422);
  refused(await call(a, 'POST', `/api/invoice232/invoices/${inv.b2b.id}/previews`, { client_key: randomUUID(), correction: { mode: 'manual', reason_code: 'blad_ceny', lines: [{ line_no: 1, quantity: 2, gross_minor: '99999' }] } }), 409, /zwiększająca wymaga przyczyny/);
  for (const o of [viewer, readKey]) refused(await call(o, 'POST', `/api/invoice232/invoices/${inv.b2b.id}/previews`, { client_key: randomUUID(), correction: { mode: 'cancellation' } }), 403);
  assert.deepEqual(await counters(), before, 'refusals number nothing');
  // The old 230 path is now the KOR-S alias; the consumer paths name KOR-S.
  assert.equal((await call(a, 'POST', `/api/invoice230/documents/${inv.b2b.id}/corrections`, { client_key: randomUUID(), correction: { mode: 'manual', reason_code: 'zwrot', lines: [{ line_no: 9, quantity: 0 }] } })).statusCode, 409);
  const end = await counters(), year = (await utcToday()).slice(0, 4);
  assert.deepEqual([end.fv157, end.fvs, end.kor, end.corrections], [start.fv157, start.fvs, 4, 4], '157 and 230 counters unchanged; four KOR-S');
  assert.deepEqual([kor.ret, kor.np2, kor.np2up, kor.oss].map(k => k.number), [1, 2, 3, 4].map(n => `KOR-S/${series.prefix}/${year}/${String(n).padStart(6, '0')}`), 'continuous KOR-S');
  const reg = ok(await call(a, 'GET', '/api/invoice232/corrections')).data.map((k: any) => k.number);
  assert.deepEqual(new Set(reg), new Set([kor.ret, kor.np2, kor.np2up, kor.oss].map(k => k.number)));
  // The owner cannot alter the ledger.
  for (const sql of [`UPDATE invoice232_corrections SET reason='x' WHERE id='${kor.ret.id}'`, `DELETE FROM invoice232_categories WHERE correction_id='${kor.ret.id}'`, 'TRUNCATE invoice232_categories'])
    await assert.rejects(pool.query(sql), /232/);
});

test('JPK_V7M rows of the corrections in their period (K_ fields signed, NrKSeF/BFK), JPK_FA KOREKTA; RODO keeps them; guards true after', async () => {
  const period = (await utcToday()).slice(0, 7), day = await utcToday();
  const v7 = await session('GET', `/api/jpk/v7m.xml?okres=${period}&kod_urzedu=1206&email=ksiegowosc%40sklep.test`);
  assert.equal(v7.statusCode, 200, v7.body);
  const rows = jpkRecords(v7.body, 'SprzedazWiersz'), rowOf = (k: any) => rows.find(x => x.DowodSprzedazy === k.number)!;
  assert.deepEqual([rowOf(kor.ret).K_19, rowOf(kor.ret).K_20, rowOf(kor.ret).NrKSeF], ['-100.00', '-23.00', (await pool.query('SELECT ksef_number FROM ksef229_submissions WHERE document_id=$1', [kor.ret.id])).rows[0].ksef_number]);
  const np = rowOf(kor.np2), pln = (Math.round(90000 * 4.2737) - Math.round(99999 * 4.2737)) / 100;
  assert.deepEqual([Number(np.K_11), Number(np.K_12), np.KodKrajuNadaniaTIN, np.BFK], [pln, pln, 'DE', '1']);
  assert(Number(rowOf(kor.np2up).K_11) > 0, 'the increase is in the period of the correction');
  assert.equal(rowOf(kor.oss).WSTO_EE, '1'); assert(Number(rowOf(kor.oss).K_11) < 0);
  const fa = await session('GET', `/api/jpk/fa.xml?od=${day}&do=${day}&kod_urzedu=1206&email=ksiegowosc%40sklep.test&wojewodztwo=ma%C5%82opolskie&powiat=Krak%C3%B3w&gmina=Krak%C3%B3w&nr_domu=2&miejscowosc=Krak%C3%B3w&kod_pocztowy=30-001`);
  assert.equal(fa.statusCode, 200, fa.body);
  const faRows = jpkRecords(fa.body, 'Faktura'), korFa = faRows.find(x => x.P_2A === kor.ret.number)!;
  assert.deepEqual([korFa.RodzajFaktury, korFa.NrFaKorygowanej, korFa.P_15], ['KOREKTA', inv.b2b.number, '-123.00']);
  // RODO: the corrections stay with the tax retention.
  await tenantTx(a.tenant, async c => transitionDirectLegacyOnReturnInTx(c, a.actor, inv.np2.order_id, 'delivered', await version(c, inv.np2.order_id)));
  const pv = ok(await session('POST', '/api/rodo228/anonymisation/preview', { email: 'kor232-np@example.test' }));
  for (const t of ['invoice232_corrections', 'invoice232_previews']) {
    const k = pv.plan.keep.filter((x: any) => x.table === t);
    assert.equal(k.length, 2, t + ': ' + JSON.stringify(pv.plan.keep.map((x: any) => x.table)));
    assert(k.every((x: any) => x.basis === 'tax_retention' && x.order_id === inv.np2.order_id), t);
  }
  assert.deepEqual(await guards(), allTrue, 'guards true after');
});
