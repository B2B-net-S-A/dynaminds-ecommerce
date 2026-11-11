/** Fiscal receipts (233) on a real disposable clone through the actual session/API routes (Fastify
 * injection with the actor the auth hook would set) and the local fake fiscal printer:
 * - printer configuration (admin), connection test, a receipt printed for a real shipped order, the
 *   replay of the same request (no second print), a receipt with NIP ≤ 450 zł = simplified invoice;
 * - paper out → failed → retry → printed, offline → failed, the daily report stored with the app's sums;
 * - refusals: a viewer and a read-only key (403), an unpaid order, an invoiced order, a second receipt (409);
 * - invoice to a receipt: FV-S consumer invoice linked (FA(3) FP + DodatkowyOpis, print), FV-S B2B refused
 *   without the NIP on the receipt and issued with it, the 157 path refused for an order with a receipt;
 * - settlement report (paid vs receipted, the invoice to the receipt counted once), RODO keeping the
 *   receipts for the tax retention, the owner cannot alter a printed receipt, the guards true before and after.
 * Root-only on a fresh clone dynaminds_fisc233_20261025_NN with 233. Rerun = NEW clone. */
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
import { createLocalInvoiceSeries, localInvoiceRequestActor, previewLocalInvoice } from '../server/local-invoices';
import { registerTax226Routes } from '../server/tax226-routes';
import { registerInvoice230Routes } from '../server/invoice230-routes';
import { registerReceipt233Routes } from '../server/receipt233-routes';
import { registerFa3DocumentRoutes } from '../server/fa3-document-routes';
import { registerSettlementReportRoutes } from '../server/settlement-report-routes';
import { registerRodo228Routes } from '../server/rodo228-routes';
import { startFakeFiscalPrinter, type FakePrinter } from '../server/receipt233-fake-printer';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_fisc233_20261025_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 60000;
const KEY_NAME = 'Isolated receipts 233 test';
const SESSION = 'dyna_session';
const ALL = ['orders:read', 'orders:write', 'documents:read', 'documents:write', 'products:read', 'products:write'];
const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid', 'return_credit211_metadata_valid',
  'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards'];
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; keyId: string; actor: Actor; seller: string };
let app: FastifyInstance, printer: FakePrinter, a: Owner, readKey: Owner, viewer: Owner, series: { id: string; prefix: string }, sessionToken = '';

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
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
const utcToday = async () => (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d")).rows[0].d as string;
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

/** A product and a PLN order of `qty` units; paid, picked, packed and shipped unless `unpaid`. */
async function order(o: Owner, opts: { price: number; qty?: number; shipping?: number; email: string; unpaid?: boolean }) {
  const sku = 'P233-' + randomBytes(4).toString('hex'), qty = opts.qty ?? 1;
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Kubek ' + sku, sku, price: opts.price, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 20 })));
  const local = (await tenantTx(o.tenant, c => createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Nabywca 233', email: opts.email, warehouse_id: o.warehouse,
    currency: 'PLN', shipping_cost: opts.shipping ?? 0, address: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600722' },
    items: [{ product_id: p.id, quantity: qty }] })))).id as string;
  if (opts.unpaid) return local;
  await tenantTx(o.tenant, async c => { await confirmOutstanding(c, o.actor, local); await advancePaid(c, o.actor, local); });
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  for (let n = 0; n < qty; n++) await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  return local;
}
const print = (o: Owner, local: string, body: Record<string, unknown> = {}) =>
  call(o, 'POST', `/api/receipt233/orders/${local}/receipts`, { client_key: randomUUID(), payment_form: 'przelew', confirmed: true, ...body });
async function preview230(o: Owner, local: string, buyer: unknown) {
  return call(o, 'POST', `/api/invoice230/orders/${local}/previews`, { client_key: randomUUID(), series_id: series.id, order_version: await tenantTx(o.tenant, c => version(c, local)),
    shipping_vat: 23, buyer, sell_date: await utcToday() });
}
async function issue230(o: Owner, local: string, buyer: unknown) {
  const pv = ok(await preview230(o, local, buyer), 201);
  const r = ok(await call(o, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true, local_only: true }), 201);
  assert.equal(r.invoice230, true);
  return r.document;
}
async function issue157(o: Owner, local: string) {
  const p = await previewLocalInvoice(nativeActor(o), local, { client_key: randomUUID(), series_id: series.id, order_version: await tenantTx(o.tenant, c => version(c, local)), shipping_vat: 23,
    buyer: { kind: 'consumer', name: 'Klient 157', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, sell_date: await utcToday(),
    tax_regime: 'ordinary_domestic', consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true } as any);
  return call(o, 'POST', `/api/local-invoices/previews/${p.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: p.preview.scope_hash, confirmed: true, local_only: true });
}
const addrPL = { street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' };

before(async () => {
  for (const name of ['receipt233_printers', 'receipt233_receipts', 'receipt233_daily_reports', 'receipt233_invoice_links', 'invoice230_documents'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs 233: ' + name);
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
  printer = await startFakeFiscalPrinter({ unique_number: 'DYN23300001' });
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
    process.stderr.write('receipts233 test 500: ' + (err?.code ?? '') + ' ' + String(err?.message ?? err).slice(0, 400) + '\n');
    return reply.code(500).send({ error: 'Błąd serwera' });
  });
  registerFa3DocumentRoutes(app, { sessionName: SESSION });
  registerTax226Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerRodo228Routes(app, { available: true, readOnly: false, pool, key: localConfig.encryptionKey });
  registerInvoice230Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerReceipt233Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerSettlementReportRoutes(app, { readOnly: false });
  // The pinned 157 routes are needed for the 157 refusal (tax-issue lives in tax226 routes).
  await app.ready();
  const prefix = 'R' + randomBytes(3).toString('hex').toUpperCase();
  const created = await createLocalInvoiceSeries(nativeActor(a), { client_key: randomUUID(), name: 'Seria 233 ' + prefix, prefix,
    seller: { name: 'Sprzedawca 233', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: a.seller },
    payment_terms_days: 14, payment_instructions: 'Przelew na rachunek 00 1111 2222', notes: 'Dziękujemy', seller_vat_status: 'active_domestic' });
  series = { id: created.series.id as string, prefix };
});
after(async () => { await app?.close(); await printer?.close(); await pool.end(); });

const orders: Record<string, string> = {}, receipts: Record<string, any> = {};
test('printer configuration and a receipt printed for a real order; replay, NIP ≤ 450 zł, refusals', async () => {
  // Configuration: admin only; a read-only key or a viewer cannot change it.
  const cfg = { name: 'Kasa sklepu', model_family: 'posnet', host: '127.0.0.1', port: printer.port, unique_number: 'DYN23300001' };
  refused(await call(readKey, 'PUT', '/api/receipt233/printer', cfg), 403);
  refused(await call(viewer, 'PUT', '/api/receipt233/printer', cfg, 'viewer'), 403);
  refused(await call(a, 'PUT', '/api/receipt233/printer', { ...cfg, host: '10.0.0.5' }), 422, /lokalnym/);
  const saved = ok(await call(a, 'PUT', '/api/receipt233/printer', cfg));
  assert.deepEqual([saved.printer.version, saved.printer.active, saved.printer.ptu.A, saved.printer.ptu.E], [1, true, '23', 'zw']);
  const t = ok(await call(a, 'POST', '/api/receipt233/printer/test', {}));
  assert.deepEqual([t.ok, t.status.unique_number, t.problems], [true, 'DYN23300001', []]);
  // A draft (arbitrary loopback port) is tested only by the admin; a viewer or a read-only key gets the stored printer's status only.
  refused(await call(viewer, 'POST', '/api/receipt233/printer/test', { ...cfg, port: 2222 }, 'viewer'), 403);
  refused(await call(readKey, 'POST', '/api/receipt233/printer/test', cfg), 403);
  assert.equal(ok(await call(viewer, 'POST', '/api/receipt233/printer/test', {}, 'viewer')).ok, true);
  const wrong = ok(await call(a, 'POST', '/api/receipt233/printer/test', { ...cfg, unique_number: 'DYN99999999' }));
  assert.equal(wrong.ok, false); assert.match(wrong.problems.join(), /numer unikatowy DYN23300001/);

  // A shipped order (paid): receipt with NIP, 123,00 + 15,00 zł = 138,00 zł ≤ 450 zł → simplified invoice.
  orders.nip = await order(a, { price: 12300, shipping: 1500, email: 'par233-nip@example.test' });
  const st = ok(await call(a, 'GET', `/api/receipt233/orders/${orders.nip}`));
  assert.equal(st.receipt, null); assert.equal(st.calculation.printable, true, JSON.stringify(st.calculation.blockers));
  assert.deepEqual(st.calculation.snapshot.ptu_totals.map((x: any) => [x.ptu, x.gross_minor]), [['A', '13800']]);
  refused(await print(readKey, orders.nip), 403);
  refused(await print(viewer, orders.nip), 403);
  refused(await print(a, orders.nip, { buyer_nip: '5260250275' }), 422, /Niepoprawny NIP/);
  const key1 = randomUUID();
  const r1 = ok(await print(a, orders.nip, { client_key: key1, buyer_nip: 'PL 526-025-02-74', payment_form: 'karta' }), 201);
  assert.deepEqual([r1.receipt.state, r1.receipt.number, r1.receipt.buyer_nip, r1.receipt.simplified_invoice, r1.receipt.gross_minor, r1.receipt.attempts],
    ['printed', '000001', '5260250274', true, '13800', 1]);
  assert.equal(printer.receipts.length, 1); assert.equal(printer.receipts[0]!.nip, '5260250274'); assert.equal(printer.receipts[0]!.payment, 'karta 13800');
  const replay = ok(await print(a, orders.nip, { client_key: key1, buyer_nip: 'PL 526-025-02-74', payment_form: 'karta' }), 200);
  assert.equal(replay.reused, true); assert.equal(replay.receipt.id, r1.receipt.id); assert.equal(printer.receipts.length, 1, 'no second print');
  refused(await print(a, orders.nip, { client_key: key1, payment_form: 'gotowka' }), 409, /innymi danymi/);
  refused(await print(a, orders.nip), 409, /ma już paragon nr 000001/);
  receipts.nip = r1.receipt;

  // A consumer receipt above 450 zł with NIP is not a simplified invoice; without NIP neither.
  orders.consumer = await order(a, { price: 45000, shipping: 1500, email: 'par233-consumer@example.test' });
  receipts.consumer = ok(await print(a, orders.consumer, { payment_form: 'przelew' }), 201).receipt;
  assert.deepEqual([receipts.consumer.state, receipts.consumer.simplified_invoice, receipts.consumer.buyer_nip, receipts.consumer.number], ['printed', false, null, '000002']);

  // Refusals: an unpaid order; an order invoiced by 157.
  const unpaid = await order(a, { price: 1000, email: 'par233-unpaid@example.test', unpaid: true });
  refused(await print(a, unpaid), 409, /po otrzymaniu zapłaty/);
  orders.invoiced = await order(a, { price: 2000, email: 'par233-invoiced@example.test' });
  ok(await issue157(a, orders.invoiced), 201);
  refused(await print(a, orders.invoiced), 409, /ma już fakturę/);
  assert.equal(printer.receipts.length, 2);
});

test('paper out → failed → retry → printed; offline → failed; daily report with the app sums', async () => {
  orders.paper = await order(a, { price: 9999, qty: 2, shipping: 1500, email: 'par233-paper@example.test' });
  printer.setFault('paper_out');
  const f = ok(await print(a, orders.paper), 201).receipt;
  assert.deepEqual([f.state, f.error.code, f.attempts, f.number], ['failed', 'PAPER_OUT', 1, null]);
  assert.match(f.error.message, /Brak papieru/);
  refused(await call(viewer, 'POST', `/api/receipt233/receipts/${f.id}/retry`, { confirmed: true }, 'viewer'), 403);
  refused(await call(readKey, 'POST', `/api/receipt233/receipts/${f.id}/retry`, { confirmed: true }), 403);
  printer.setFault('offline');
  const off = ok(await call(a, 'POST', `/api/receipt233/receipts/${f.id}/retry`, { confirmed: true }));
  assert.deepEqual([off.receipt.state, off.receipt.error.code, off.receipt.attempts], ['failed', 'OFFLINE', 2]);
  printer.setFault(null);
  const done = ok(await call(a, 'POST', `/api/receipt233/receipts/${f.id}/retry`, { confirmed: true }));
  assert.deepEqual([done.receipt.state, done.receipt.number, done.receipt.attempts, done.receipt.error], ['printed', '000003', 3, null]);
  const again = ok(await call(a, 'POST', `/api/receipt233/receipts/${f.id}/retry`, { confirmed: true }));
  assert.deepEqual([again.receipt.state, again.receipt.attempts], ['printed', 3], 'a printed receipt is not printed again');
  assert.equal(printer.receipts.filter(r => r.job_id === f.id).length, 1);
  receipts.paper = done.receipt;
  // The audit trail records each attempt.
  assert.deepEqual((await pool.query("SELECT action FROM audit_events WHERE entity_id=$1 AND action LIKE 'receipt233.%' ORDER BY created_at", [f.id])).rows.map(r => r.action),
    ['receipt233.queue', 'receipt233.send', 'receipt233.failed', 'receipt233.send', 'receipt233.failed', 'receipt233.send', 'receipt233.printed']);

  // Daily report: printed and stored, gross per PTU agrees with the app's receipts.
  refused(await call(readKey, 'POST', '/api/receipt233/daily-reports', { confirmed: true }), 403);
  const rep = ok(await call(a, 'POST', '/api/receipt233/daily-reports', { confirmed: true }), 201).report;
  assert.deepEqual([rep.report_number, rep.printer_receipts, rep.app_receipts, rep.matches], ['0001', 3, 3, true]);
  assert.equal(rep.printer_totals[0].gross_minor, String(13800 + 46500 + 21498));
  const second = ok(await call(a, 'POST', '/api/receipt233/daily-reports', { confirmed: true }), 200);
  assert.equal(second.reused, true); assert.equal(second.report.id, rep.id);
  assert.equal(ok(await call(a, 'GET', '/api/receipt233/daily-reports')).data.length, 1);
});

test('invoice to a receipt (FV-S), the 157 refusal, settlement, RODO, immutability and the guards', async () => {
  // B2B FV-S to the receipt without NIP: refused at preview (art. 106b ust. 5); consumer FV-S is issued and linked.
  const plB2B = { kind: 'business', name: 'Hurtownia Polska Sp. z o.o.', address: addrPL, tax_id: '526-025-02-74', pl_vat_payer: true };
  refused(await preview230(a, orders.consumer, plB2B), 409, /nie zawiera NIP nabywcy.*106b ust\. 5/);
  refused(await issue157(a, orders.consumer), 409, /ma paragon fiskalny nr 000002.*FV-S/);
  const inv = await issue230(a, orders.consumer, { kind: 'consumer', name: 'Jan Kowalski', address: addrPL });
  const link = (await pool.query('SELECT receipt_id,document_mode FROM receipt233_invoice_links WHERE document_id=$1', [inv.id])).rows[0];
  assert.deepEqual(link, { receipt_id: receipts.consumer.id, document_mode: 'invoice230' });
  const xml = (await call(a, 'GET', `/api/fa3/documents/${inv.id}/fa3.xml`)).body;
  assert.match(xml, /<RodzajFaktury>VAT<\/RodzajFaktury><FP>1<\/FP><DodatkowyOpis><Klucz>Paragon fiskalny<\/Klucz><Wartosc>nr 000002 z dnia \d{4}-\d{2}-\d{2}, kasa DYN23300001<\/Wartosc><\/DodatkowyOpis>/);
  assert.match((await call(a, 'GET', `/api/invoice230/documents/${inv.id}/print`)).body, /Faktura do paragonu fiskalnego<\/span> nr 000002/);
  const st = ok(await call(a, 'GET', `/api/receipt233/orders/${orders.consumer}`));
  assert.equal(st.receipt.invoice.number, inv.number);
  assert.equal(ok(await call(a, 'POST', `/api/receipt233/receipts/${receipts.consumer.id}/retry`, { confirmed: true })).receipt.state, 'printed', 'a printed receipt is only returned');

  // B2B FV-S with the same NIP as the receipt: issued and linked; another NIP refused.
  refused(await preview230(a, orders.nip, { ...plB2B, tax_id: '7740001454' }), 409, /inny niż NIP na paragonie/);
  const b2b = await issue230(a, orders.nip, plB2B);
  assert.equal((await pool.query('SELECT receipt_id FROM receipt233_invoice_links WHERE document_id=$1', [b2b.id])).rows[0].receipt_id, receipts.nip.id);
  refused(await preview230(a, orders.nip, plB2B), 409, /ma już fakturę/);

  // Settlement: paid vs receipted; the invoice to the receipt is counted once.
  // The report filters by the Warsaw day of the order; a run across midnight spans two days.
  const days = (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'Europe/Warsaw')::date-1,'YYYY-MM-DD') f,to_char((clock_timestamp() AT TIME ZONE 'Europe/Warsaw')::date,'YYYY-MM-DD') t")).rows[0];
  const report = ok(await session('GET', `/api/settlement-report?from=${days.f}&to=${days.t}`));
  const row = (id: string) => report.rows.find((r: any) => r.order_id === id);
  assert.deepEqual([row(orders.paper).status, row(orders.paper).receipted, row(orders.paper).receipt_numbers], ['zgodne', 21498, ['000003']]);
  assert.deepEqual([row(orders.consumer).status, row(orders.consumer).documented, row(orders.consumer).receipted, row(orders.consumer).invoice_numbers], ['zgodne', 46500, 46500, [inv.number]]);
  assert.deepEqual([row(orders.nip).status, row(orders.nip).receipt_difference], ['zgodne', 0]);

  // The owner cannot alter or delete a printed receipt.
  for (const sql of ["UPDATE receipt233_receipts SET gross_minor=1 WHERE id=$1", "UPDATE receipt233_receipts SET state='queued',printer_receipt_number=NULL,fiscal_date=NULL,printed_at=NULL WHERE id=$1",
    'DELETE FROM receipt233_receipts WHERE id=$1'])
    await assert.rejects(pool.query(sql, [receipts.paper.id]), /Paragon 233|nienaruszalny/);
  await assert.rejects(pool.query('DELETE FROM receipt233_invoice_links WHERE document_id=$1', [inv.id]), /nienaruszalny/);

  // RODO: the receipt stays with the tax retention.
  await tenantTx(a.tenant, async c => transitionDirectLegacyOnReturnInTx(c, a.actor, orders.paper, 'delivered', await version(c, orders.paper)));
  const pv = ok(await session('POST', '/api/rodo228/anonymisation/preview', { email: 'par233-paper@example.test' }));
  const k = pv.plan.keep.filter((x: any) => x.table === 'receipt233_receipts');
  assert.equal(k.length, 1, JSON.stringify(pv.plan.keep.map((x: any) => x.table)));
  assert(k[0].basis === 'tax_retention' && k[0].order_id === orders.paper && k[0].retention_end >= '2031-12-31', JSON.stringify(k[0]));
  assert.deepEqual(await guards(), allTrue, 'guards true after');
});
