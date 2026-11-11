/** JPK files read their month in ONE read-only snapshot (fa3-document-batch.ts) on a real disposable clone
 * (dynaminds_fin_20261027_NN): for tenants with FV 157, KOR 188, KOR 206/207, B2B FV 159 (template rows)
 * and for a tenant seeded here with FV-S 230 (consumer, B2B, one sent to the local fake KSeF), KOR-S 232,
 * a fiscal receipt with its daily report and an FV-S to it (FP), the V7M, V7K and JPK_FA files of the new
 * loader are byte-identical to the per-document loader they replace (reimplemented below exactly as it
 * was), with the same generation time; the new loader borrows one pool client for every batched document
 * (B2B 159/160 keep their native read), the old one at least two per document. Refusals: an unknown session
 * is 401 before any document is read. Root-only on a fresh clone; rerun = NEW clone. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localConfig, pool, tenantReadTx, tenantTx } from '../server/db';
import { Problem } from '../server/errors';
import { tokenHash } from '../server/security';
import { createProduct } from '../server/catalog';
import { createOrder, orderSchema, productSchema, scan, shipDemo, type Actor } from '../server/domain';
import { advancePaid, confirmOutstanding } from '../server/payments';
import { transitionDirectLegacyOnReturnInTx } from '../server/legacy-return-on-command';
import { createLocalInvoiceSeries, localInvoiceRequestActor } from '../server/local-invoices';
import { paymentImportAdmin } from '../server/payment-imports';
import { registerTax226Routes } from '../server/tax226-routes';
import { registerInvoice230Routes } from '../server/invoice230-routes';
import { registerInvoice232Routes } from '../server/invoice232-routes';
import { registerReceipt233Routes } from '../server/receipt233-routes';
import { registerKsef229Routes, ksef229Service } from '../server/ksef229-routes';
import { registerJpkRoutes } from '../server/jpk-routes';
import { startFakeKsef, type FakeKsef } from '../server/ksef229-fake';
import { startFakeFiscalPrinter, type FakePrinter } from '../server/receipt233-fake-printer';
import { fa3DocumentFacts, type Fa3Request } from '../server/fa3-documents';
import { documentKsefInTx } from '../server/ksef229-numbers';
import { collectJpkDocuments, listJpkDocumentsInTx, loadJpkDocuments, type JpkLoaded } from '../server/jpk-source';
import { listJpkReceiptSalesInTx } from '../server/jpk-receipts';
import { jpkRecords } from './jpk-fixtures';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_fin_20261027_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 120000;
const KEY_NAME = 'Isolated JPK batch test';
const SESSION = 'dyna_session', UNIQUE = 'DYN23300091', TOKEN = 'lokalny-token-' + randomBytes(12).toString('hex');
const ALL = ['orders:read', 'orders:write', 'documents:read', 'documents:write', 'products:read', 'products:write'];
const NOW = new Date('2026-10-27T10:00:00.000Z');
const TP = 'kod_urzedu=1206&email=ksiegowosc%40sklep.test';
const ADDR = 'wojewodztwo=mazowieckie&powiat=Warszawa&gmina=Warszawa&nr_domu=1&miejscowosc=Warszawa&kod_pocztowy=00-001';
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; keyId: string; actor: Actor; seller: string };
type Who = { tenant: string; user: string; token: string };
let app: FastifyInstance, printer: FakePrinter, fake: FakeKsef, a: Owner, series = '';
let acquires = 0;
pool.on('acquire', () => { acquires++; });
const loads: { loader: string; acquires: number; documents: number }[] = [];

/** The loader as it was before the batch: every document through its native detail read, then its KSeF number. */
async function perDocumentLoad(req: Fa3Request, from: string, to: string, by: 'tax' | 'issue'): Promise<JpkLoaded> {
  const { listed, sales } = await tenantReadTx(req.actor.tenantId, async c => ({
    listed: await listJpkDocumentsInTx(c, req.actor.tenantId, from, to, by),
    sales: by === 'tax' ? await listJpkReceiptSalesInTx(c, req.actor.tenantId, from, to) : null,
  }));
  const loaded = await collectJpkDocuments(listed, async d => {
    const f = await fa3DocumentFacts(req, d.id, SESSION, { kind: d.kind, mode: d.mode });
    return { ...f, ksef: await tenantReadTx(req.actor.tenantId, c => documentKsefInTx(c, d.id)) };
  });
  return sales ? { ...loaded, receipt_sales: sales } : loaded;
}

async function member(tenant: string): Promise<Who> {
  const user = (await pool.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='admin' ORDER BY user_id LIMIT 1", [tenant])).rows[0].user_id as string;
  const token = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at,account_version,mfa_verified_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',coalesce((SELECT version FROM account_security WHERE user_id=$2),0),clock_timestamp())`, [tokenHash(token), user, tenant]);
  return { tenant, user, token };
}
const jpk = (w: Who, loader: 'old' | 'new', url: string) => app.inject({ url, headers: { 'x-test-as': JSON.stringify({ tenant: w.tenant, user: w.user, role: 'admin', session: w.token }), 'x-loader': loader } });
function call(o: Owner, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) {
  const headers = { authorization: 'Bearer ' + o.token, 'x-test-as': JSON.stringify({ tenant: o.tenant, user: o.user, role: 'admin', key: o.keyId }) };
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
}
const ok = (r: any, status = 200) => { assert.equal(r.statusCode, status, r.body); return r.json(); };
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
const today = async () => (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'Europe/Warsaw')::date,'YYYY-MM-DD') d")).rows[0].d as string;

/** A paid, picked, packed and shipped PLN order of one product (as in tests/jpk-receipts233.database.test.ts). */
async function shipped(o: Owner, price: number, vat: 0 | 5 | 8 | 23, email: string) {
  const sku = 'JB-' + randomBytes(4).toString('hex');
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Towar ' + sku, sku, price, vat, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 20 })));
  const local = (await tenantTx(o.tenant, c => createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Nabywca JPK batch', email, warehouse_id: o.warehouse, currency: 'PLN', shipping_cost: 1500,
    address: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600722' }, items: [{ product_id: p.id, quantity: 2 }] })))).id as string;
  await tenantTx(o.tenant, async c => { await confirmOutstanding(c, o.actor, local); await advancePaid(c, o.actor, local); });
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  await tenantTx(o.tenant, async c => { for (let n = 0; n < 2; n++) await scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }); });
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  return local;
}
const ADDRESS = { street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' };
async function fvs(local: string, buyer: unknown) {
  const pv = ok(await call(a, 'POST', `/api/invoice230/orders/${local}/previews`, { client_key: randomUUID(), series_id: series,
    order_version: await tenantTx(a.tenant, c => version(c, local)), shipping_vat: 23, buyer, sell_date: await today() }), 201);
  return ok(await call(a, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true, local_only: true }), 201).document;
}

before(async () => {
  for (const name of ['invoice232_corrections', 'receipt233_daily_reports', 'invoice230_documents', 'ksef229_submissions'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs 233: ' + name);
  assert.equal((await pool.query('SELECT count(*)::int n FROM receipt233_printers')).rows[0].n, 0, 'Fresh clone required; no rerun');
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
  assert(row, 'a PLN tenant');
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), keyId = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at) VALUES($1,$2,$3,$7,$4,$5,$6,clock_timestamp()+interval '1 day')`,
    [keyId, row.tenant_id, row.user_id, tokenHash(token), token.slice(0, 16), ALL, KEY_NAME]);
  a = { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, token, keyId, seller: row.seller ?? '5260250274',
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
  printer = await startFakeFiscalPrinter({ unique_number: UNIQUE });
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
    if (err instanceof Problem) return reply.code(err.status).send({ detail: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ detail: err.issues.map(i => i.message).join('; ') });
    process.stderr.write('jpk batch test 500: ' + (err?.code ?? '') + ' ' + String(err?.message ?? err).slice(0, 400) + '\n');
    return reply.code(500).send({ detail: 'Błąd serwera' });
  });
  registerTax226Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerInvoice230Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerInvoice232Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerReceipt233Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerKsef229Routes(app, { available: true, readOnly: false, service: ksef229Service({ key: localConfig.encryptionKey, sessionName: SESSION, pollDelaysMs: [20, 40, 80, 160], timeoutMs: 5000 }) });
  registerJpkRoutes(app, { sessionName: SESSION }, {
    authorize: actor => tenantTx(actor.tenantId, c => paymentImportAdmin(c, actor)),
    load: async (req, from, to, by) => {
      const loader = String((req as any).headers['x-loader']), before = acquires;
      const r = loader === 'old' ? await perDocumentLoad(req, from, to, by) : await loadJpkDocuments(req, SESSION, from, to, by);
      loads.push({ loader, acquires: acquires - before, documents: r.documents.length });
      return r;
    },
    now: () => NOW,
  });
  await app.ready();
  const prefix = 'B' + randomBytes(3).toString('hex').toUpperCase();
  series = (await createLocalInvoiceSeries(localInvoiceRequestActor({ actor: { ...a.actor, source: 'api', apiKeyId: a.keyId } as Actor, apiKeyId: a.keyId,
    currentUser: { id: a.user, tenant_id: a.tenant }, headers: { authorization: 'Bearer ' + a.token }, cookies: {} }, SESSION), { client_key: randomUUID(), name: 'Seria JPK batch ' + prefix, prefix,
    seller: { name: 'Sprzedawca JPK batch', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: a.seller },
    payment_terms_days: 14, payment_instructions: 'Przelew na rachunek 00 1111 2222', notes: 'Dziękujemy', seller_vat_status: 'active_domestic' })).series.id as string;
  ok(await call(a, 'PUT', '/api/receipt233/printer', { name: 'Kasa JPK batch', model_family: 'posnet', host: '127.0.0.1', port: printer.port, unique_number: UNIQUE }));
});
after(async () => { await app?.close(); await printer?.close(); await fake?.close(); await pool.end(); });

/** V7M, V7K and JPK_FA of one tenant's month through both loaders: same bytes; transactions of each load. */
async function compare(w: Who, month: string) {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  for (const url of [`/api/jpk/v7m.xml?okres=${month}&${TP}`, `/api/jpk/v7k.xml?okres=${month}&${TP}`, `/api/jpk/fa.xml?od=${month}-01&do=${month}-${last}&${TP}&${ADDR}`]) {
    loads.length = 0;
    const old = await jpk(w, 'old', url), now = await jpk(w, 'new', url);
    assert.equal(old.statusCode, 200, url + ' ' + old.body);
    assert.equal(now.statusCode, old.statusCode, url + ' ' + now.body);
    assert.equal(now.body, old.body, url + ': byte-identical file');
    assert.deepEqual(now.headers['x-jpk-wiersze'], old.headers['x-jpk-wiersze']);
    const [o, n] = loads;
    assert.equal(loads.length, 2);
    assert.equal(n!.documents, o!.documents);
    assert.ok(o!.acquires >= 1 + 2 * o!.documents, `${url}: old ${o!.acquires} transactions for ${o!.documents} documents`);
    loadsSeen.push({ url: url.slice(5, 18), tenant: w.tenant, old: o!.acquires, new: n!.acquires, documents: n!.documents });
  }
}
const loadsSeen: { url: string; tenant: string; old: number; new: number; documents: number }[] = [];
const batchedOf = async (tenant: string, month: string) => (await pool.query(`SELECT
   (SELECT count(*) FROM documents WHERE tenant_id=$1 AND mode IN ('local_invoice','invoice230') AND to_char(created_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM')=$2)
 + (SELECT count(*) FROM local_consumer_credit_documents WHERE tenant_id=$1 AND to_char(created_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM')=$2)
 + (SELECT count(*) FROM return_credit206_documents WHERE tenant_id=$1 AND to_char(created_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM')=$2)
 + (SELECT count(*) FROM invoice232_corrections WHERE tenant_id=$1 AND to_char(created_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM')=$2) n,
   (SELECT count(*)::int FROM documents WHERE tenant_id=$1 AND mode IN ('b2b_invoice','b2b_correction')) b2b`, [tenant, month])).rows[0];

test('template tenants (FV 157, KOR 188, KOR 206/207, B2B 159): byte-identical V7M/V7K/JPK_FA, one transaction for the batched documents', async () => {
  const pick = async (sql: string) => (await pool.query(sql)).rows[0].tenant_id as string;
  const tenants = [...new Set([
    await pick("SELECT c.tenant_id FROM local_consumer_credit_documents c WHERE EXISTS(SELECT FROM return_credit206_documents r WHERE r.tenant_id=c.tenant_id) ORDER BY 1 LIMIT 1"),
    await pick("SELECT r.tenant_id FROM return_credit206_documents r WHERE NOT EXISTS(SELECT FROM local_consumer_credit_documents c WHERE c.tenant_id=r.tenant_id) ORDER BY 1 LIMIT 1"),
    await pick("SELECT tenant_id FROM documents WHERE mode='b2b_invoice' ORDER BY 1 LIMIT 1"),
  ])];
  assert.equal(tenants.length, 3);
  for (const t of tenants) {
    const n = await batchedOf(t, '2026-10');
    assert.ok(Number(n.n) > 0 || n.b2b > 0, t + ' has documents');
    const w = await member(t);
    await compare(w, '2026-10');
    assert.ok(loadsSeen.filter(x => x.tenant === t).some(l => l.documents > 0), t + ' some file has documents');
    for (const l of loadsSeen.filter(x => x.tenant === t)) {
      if (n.b2b === 0) assert.equal(l.new, 1, `${t} ${l.url}: list + every document in one tenantReadTx`);
      else assert.ok(l.new <= l.old && (Number(n.n) === 0 || l.documents === 0 || l.new < l.old), `${t} ${l.url}: B2B keeps its native read, the rest is batched (${l.new} vs ${l.old})`);
    }
  }
});

test('seeded tenant (FV-S 230 consumer/B2B, one in KSeF, KOR-S 232, receipt + daily report + FP): byte-identical, one transaction; unknown session 401', async () => {
  const day = await today(), month = day.slice(0, 7);
  const consumer = await fvs(await shipped(a, 12300, 23, 'jb-a@example.test'), { kind: 'consumer', name: 'Jan Kowalski', address: ADDRESS });
  const b2b = await fvs(await shipped(a, 5400, 8, 'jb-b@example.test'), { kind: 'business', name: 'Hurtownia Polska Sp. z o.o.', address: ADDRESS, tax_id: '526-025-02-74', pl_vat_payer: true });
  const cancelled = await fvs(await shipped(a, 2100, 5, 'jb-c@example.test'), { kind: 'consumer', name: 'Anna Nowak', address: ADDRESS });
  // B2B FV-S accepted by the local fake KSeF: its JPK row carries the KSeF number.
  const session = await member(a.tenant);
  const asSession = (method: 'PUT' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-as': JSON.stringify({ tenant: a.tenant, user: session.user, role: 'admin', session: session.token }) }, ...(payload === undefined ? {} : { payload: payload as any }) });
  ok(await asSession('PUT', '/api/ksef229/configs/' + a.seller, { environment: 'local_fake', base_url: fake.url, auth_method: 'token', token: TOKEN }));
  const sent = ok(await asSession('POST', `/api/ksef229/documents/${b2b.id}/send`)).submission;
  assert.equal(sent.state, 'accepted');
  // KOR-S cancellation of a consumer FV-S.
  const pv = ok(await call(a, 'POST', `/api/invoice232/invoices/${cancelled.id}/previews`, { client_key: randomUUID(), correction: { mode: 'cancellation' } }), 201);
  ok(await call(a, 'POST', `/api/invoice232/previews/${pv.preview.id}/issue`, { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true }), 201);
  // Receipt today, the daily report, then an FV-S to that receipt (FP).
  printer.setDate(day);
  const receiptOrder = await shipped(a, 1000, 0, 'jb-d@example.test');
  assert.equal(ok(await call(a, 'POST', `/api/receipt233/orders/${receiptOrder}/receipts`, { client_key: randomUUID(), payment_form: 'przelew', confirmed: true }), 201).receipt.state, 'printed');
  assert.equal(ok(await call(a, 'POST', '/api/receipt233/daily-reports', { confirmed: true }), 201).report.matches, true);
  const fp = await fvs(receiptOrder, { kind: 'consumer', name: 'Piotr Paragonowy', address: ADDRESS });
  assert.ok(consumer.id && fp.id);

  const n = await batchedOf(a.tenant, month);
  assert.equal(n.b2b, 0, 'the seeded tenant has no B2B 159/160 documents');
  assert.ok(Number(n.n) >= 5, 'FV-S ×4 + KOR-S');
  await compare(session, month);
  for (const l of loadsSeen.filter(x => x.tenant === a.tenant)) assert.equal(l.new, 1, `${l.url}: list + receipts + every document in one tenantReadTx (old: ${l.old})`);
  const v7 = await jpk(session, 'new', `/api/jpk/v7m.xml?okres=${month}&${TP}`);
  const rows = jpkRecords(v7.body, 'SprzedazWiersz');
  assert.deepEqual(rows.filter(r => r.TypDokumentu === 'RO').length, 1, 'RO of the daily report');
  assert.deepEqual(rows.filter(r => r.TypDokumentu === 'FP').map(r => r.DowodSprzedazy), [fp.number]);
  assert.deepEqual(rows.filter(r => r.DowodSprzedazy === b2b.number).map(r => r.NrKSeF), [sent.ksef_number]);
  assert.ok(rows.some(r => r.DowodSprzedazy.startsWith('KOR-S/')), 'KOR-S row');

  // Refusal: a session that does not exist is refused by the identity frame before any document is read.
  const stranger = { ...session, token: randomBytes(32).toString('hex') };
  const req = { actor: { tenantId: a.tenant, userId: session.user, role: 'admin', source: 'session' }, currentUser: { id: session.user, tenant_id: a.tenant }, headers: {}, cookies: { [SESSION]: stranger.token } } as unknown as Fa3Request;
  await assert.rejects(loadJpkDocuments(req, SESSION, `${month}-01`, day, 'tax'), (e: any) => e instanceof Problem && e.status === 401);
  await assert.rejects(perDocumentLoad(req, `${month}-01`, day, 'tax'), (e: any) => e instanceof Problem && e.status === 401);
  // Another tenant's identity cannot read this tenant: the frame refuses a request whose user is not the session's.
  const forged = { ...req, currentUser: { id: randomUUID(), tenant_id: a.tenant } } as unknown as Fa3Request;
  await assert.rejects(loadJpkDocuments(forged, SESSION, `${month}-01`, day, 'tax'), (e: any) => e instanceof Problem && e.status === 401);
  process.stdout.write('# loads ' + JSON.stringify(loadsSeen) + '\n');
});
