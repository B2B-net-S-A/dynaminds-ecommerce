/** JPK_V7M with cash-register sales on a real disposable clone with 233 (dynaminds_fisc233_20261025_NN):
 * receipts printed on the local fake fiscal printer for real shipped orders on two fiscal days, a daily
 * report per day, an FV-S invoice issued to one receipt, then GET /api/jpk/v7m.xml (real finance-admin
 * authorization, real loader) for the current month (the invoice is issued today) parses back with one RO row per daily report (K_ equal to
 * the stored printer totals per PTU), the FP row of the invoice, and SprzedazCtrl and the declaration
 * = RO + invoices − FP. Refusals on real data: printed receipts of a day without a daily report, and a
 * stored daily report "niezgodny". Root-only on a fresh clone; rerun = NEW clone. */
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
import { createLocalInvoiceSeries, localInvoiceRequestActor } from '../server/local-invoices';
import { registerTax226Routes } from '../server/tax226-routes';
import { registerInvoice230Routes } from '../server/invoice230-routes';
import { registerReceipt233Routes } from '../server/receipt233-routes';
import { registerFa3DocumentRoutes } from '../server/fa3-document-routes';
import { registerJpkRoutes } from '../server/jpk-routes';
import { jpkWholeZloty } from '../server/jpk-model';
import { startFakeFiscalPrinter, type FakePrinter } from '../server/receipt233-fake-printer';
import { jpkValues, jpkRecords, minorOf } from './jpk-fixtures';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_(fisc233_20261025|fix29_20261029|xsd30_20261030)_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 60000;
const KEY_NAME = 'Isolated JPK receipts 233 test';
const SESSION = 'dyna_session';
const UNIQUE = 'DYN23300060';
const ALL = ['orders:read', 'orders:write', 'documents:read', 'documents:write', 'products:read', 'products:write'];
const TP = 'kod_urzedu=1206&email=ksiegowosc%40sklep.test';
const K = ['K_10', 'K_13', 'K_15', 'K_16', 'K_17', 'K_18', 'K_19', 'K_20'];
const K_OF: Record<string, [string, string | null]> = { '23': ['K_19', 'K_20'], '8': ['K_17', 'K_18'], '5': ['K_15', 'K_16'], '0': ['K_13', null], 'zw': ['K_10', null] };
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; token: string; keyId: string; actor: Actor; seller: string };
let app: FastifyInstance, printer: FakePrinter, a: Owner, series: { id: string }, sessionToken = '';

function call(o: Owner, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) {
  const headers = { authorization: 'Bearer ' + o.token, 'x-test-as': JSON.stringify({ tenant: o.tenant, user: o.user, role: 'admin', key: o.keyId }) };
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
}
const session = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-as': JSON.stringify({ tenant: a.tenant, user: a.user, role: 'admin', session: sessionToken }) } });
const nativeActor = (o: Owner) => localInvoiceRequestActor({ actor: { tenantId: o.tenant, userId: o.user, role: 'admin', source: 'api', apiKeyId: o.keyId },
  apiKeyId: o.keyId, currentUser: { id: o.user, tenant_id: o.tenant }, headers: { authorization: 'Bearer ' + o.token }, cookies: {} }, SESSION);
const ok = (r: any, status = 200) => { assert.equal(r.statusCode, status, r.body); return r.json(); };
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
const utcToday = async () => (await pool.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d")).rows[0].d as string;

/** A paid, picked, packed and shipped PLN order of one product at `vat`. */
async function order(o: Owner, price: number, vat: 0 | 5 | 8 | 23, email: string, shipping = 0) {
  const sku = 'J233-' + randomBytes(4).toString('hex');
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Towar ' + sku, sku, price, vat, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 20 })));
  const local = (await tenantTx(o.tenant, c => createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Nabywca JPK 233', email, warehouse_id: o.warehouse,
    currency: 'PLN', shipping_cost: shipping, address: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600722' },
    items: [{ product_id: p.id, quantity: 1 }] })))).id as string;
  await tenantTx(o.tenant, async c => { await confirmOutstanding(c, o.actor, local); await advancePaid(c, o.actor, local); });
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  await tenantTx(o.tenant, c => scan(c, o.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(o.tenant, async c => transitionDirectLegacyOnReturnInTx(c, o.actor, local, 'packed', await version(c, local)));
  await tenantTx(o.tenant, c => shipDemo(c, o.actor, local));
  return local;
}
const print = async (local: string) => {
  const r = ok(await call(a, 'POST', `/api/receipt233/orders/${local}/receipts`, { client_key: randomUUID(), payment_form: 'przelew', confirmed: true }), 201).receipt;
  assert.equal(r.state, 'printed', JSON.stringify(r.error)); return r;
};
const daily = async () => ok(await call(a, 'POST', '/api/receipt233/daily-reports', { confirmed: true }), 201).report;

before(async () => {
  for (const name of ['receipt233_daily_reports', 'receipt233_invoice_links', 'invoice230_documents'])
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
  sessionToken = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at,account_version,mfa_verified_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',coalesce((SELECT version FROM account_security WHERE user_id=$2),0),clock_timestamp())`, [tokenHash(sessionToken), a.user, a.tenant]);
  printer = await startFakeFiscalPrinter({ unique_number: UNIQUE });
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
    process.stderr.write('jpk receipts233 test 500: ' + (err?.code ?? '') + ' ' + String(err?.message ?? err).slice(0, 400) + '\n');
    return reply.code(500).send({ error: 'Błąd serwera' });
  });
  registerFa3DocumentRoutes(app, { sessionName: SESSION });
  registerTax226Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerInvoice230Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerReceipt233Routes(app, { available: true, readOnly: false, sessionName: SESSION });
  registerJpkRoutes(app, { sessionName: SESSION });
  await app.ready();
  const prefix = 'J' + randomBytes(3).toString('hex').toUpperCase();
  const created = await createLocalInvoiceSeries(nativeActor(a), { client_key: randomUUID(), name: 'Seria JPK 233 ' + prefix, prefix,
    seller: { name: 'Sprzedawca 233', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: a.seller },
    payment_terms_days: 14, payment_instructions: 'Przelew na rachunek 00 1111 2222', notes: 'Dziękujemy', seller_vat_status: 'active_domestic' });
  series = { id: created.series.id as string };
  ok(await call(a, 'PUT', '/api/receipt233/printer', { name: 'Kasa JPK', model_family: 'posnet', host: '127.0.0.1', port: printer.port, unique_number: UNIQUE }));
});
after(async () => { await app?.close(); await printer?.close(); await pool.end(); });

test('JPK_V7M of the current month: RO per daily report, FP invoice, sums = RO + invoices − FP; unreported day and "niezgodny" refused', async () => {
  // The FV-S invoice is issued today, so the period is the current month and the fiscal days lie in it.
  const today = await utcToday(), month = today.slice(0, 7), day = (d: number) => `${month}-${d}`;
  // Day 1 (23rd): 23% with shipping and 8%; day 2 (24th): 5% and 0%.
  printer.setDate(day(23));
  const consumer = await order(a, 12300, 23, 'jpk233-a@example.test', 1500), r1 = await print(consumer);
  await print(await order(a, 10800, 8, 'jpk233-b@example.test'));
  const rep1 = await daily();
  printer.setDate(day(24));
  await print(await order(a, 2100, 5, 'jpk233-c@example.test'));
  await print(await order(a, 1000, 0, 'jpk233-d@example.test'));
  const rep2 = await daily();
  assert.deepEqual([rep1.report_number, rep1.matches, rep1.printer_receipts, rep2.report_number, rep2.matches, rep2.printer_receipts], ['0001', true, 2, '0002', true, 2]);

  // FV-S to the receipt of day 1 (issued today; its sale date cannot precede the order, created today): FP.
  const pv = ok(await call(a, 'POST', `/api/invoice230/orders/${consumer}/previews`, { client_key: randomUUID(), series_id: series.id,
    order_version: await tenantTx(a.tenant, c => version(c, consumer)), shipping_vat: 23,
    buyer: { kind: 'consumer', name: 'Jan Kowalski', address: { street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' } }, sell_date: today }), 201);
  const issued = ok(await call(a, 'POST', `/api/local-invoices/previews/${pv.preview.id}/tax-issue`, { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true, local_only: true }), 201);
  const inv = issued.document;
  assert.equal((await pool.query('SELECT receipt_id FROM receipt233_invoice_links WHERE document_id=$1', [inv.id])).rows[0].receipt_id, r1.id);

  // Day 3 (25th): a printed receipt without a daily report refuses the file.
  printer.setDate(day(25));
  await print(await order(a, 5000, 23, 'jpk233-e@example.test'));
  const open = await session(`/api/jpk/v7m.xml?okres=${month}&${TP}`);
  assert.equal(open.statusCode, 409, open.body);
  assert.deepEqual(open.json().documents.map((d: any) => d.number), [`Paragony z ${day(25)}, kasa ${UNIQUE}`]);
  assert.match(open.json().documents[0].reason, /1 wydrukowanych paragonów bez raportu dobowego/);
  const rep3 = await daily();
  assert.equal(rep3.matches, true);

  const res = await session(`/api/jpk/v7m.xml?okres=${month}&${TP}`);
  assert.equal(res.statusCode, 200, res.body);
  const v = jpkValues(res.body), rows = jpkRecords(res.body, 'SprzedazWiersz');
  assert.equal(res.headers['x-jpk-wiersze'], String(rows.length));
  const ro = rows.filter(x => x.TypDokumentu === 'RO'), fp = rows.filter(x => x.TypDokumentu === 'FP');
  assert.deepEqual(ro.map(x => [x.DowodSprzedazy, x.DataWystawienia, x.NrKontrahenta, x.NazwaKontrahenta, x.DI]), [
    [`RO/${UNIQUE}/0001`, day(23), 'brak', 'brak', '1'], [`RO/${UNIQUE}/0002`, day(24), 'brak', 'brak', '1'], [`RO/${UNIQUE}/0003`, day(25), 'brak', 'brak', '1']]);
  // Every RO equals the stored printer totals of its report (PTU letter → rate → K_).
  const stored = (await pool.query("SELECT report_number,printer_totals FROM receipt233_daily_reports WHERE tenant_id=$1 ORDER BY fiscal_date", [a.tenant])).rows;
  const table = (await pool.query('SELECT ptu FROM receipt233_printers WHERE tenant_id=$1', [a.tenant])).rows[0].ptu as Record<string, string>;
  const letters = new Set<string>();
  for (const [i, s] of stored.entries()) {
    const expected: Record<string, bigint> = {};
    for (const t of s.printer_totals as { ptu: string; gross_minor: string; vat_minor: string }[]) {
      letters.add(t.ptu);
      const [net, vat] = K_OF[table[t.ptu]!]!;
      expected[net] = (expected[net] ?? 0n) + BigInt(t.gross_minor) - BigInt(t.vat_minor);
      if (vat) expected[vat] = (expected[vat] ?? 0n) + BigInt(t.vat_minor);
    }
    for (const f of K) assert.equal(minorOf(ro[i]![f]), expected[f] ?? 0n, `${s.report_number} ${f}`);
  }
  assert.deepEqual([...letters].sort(), ['A', 'B', 'C', 'D'], '23/8/5/0 registered on the customary letters');
  const receiptsGross = BigInt((await pool.query("SELECT sum(gross_minor)::text s FROM receipt233_receipts WHERE tenant_id=$1 AND state='printed'", [a.tenant])).rows[0].s);
  assert.equal(ro.reduce((n, x) => n + K.reduce((m, f) => m + minorOf(x[f]), 0n), 0n), receiptsGross, 'RO net + VAT = gross of the printed receipts');

  // FP: the invoice listed with its own amounts (issue date = today), not in the sums.
  assert.deepEqual(fp.map(x => [x.DowodSprzedazy, x.DataWystawienia, x.BFK]), [[inv.number, today, '1']]);
  assert.equal(minorOf(fp[0]!.K_19) + minorOf(fp[0]!.K_20), BigInt(r1.gross_minor), 'FP gross = receipt gross');

  // Declaration and Ctrl = RO + invoices − FP (every other row of the month counted once).
  const counted = rows.filter(x => x.TypDokumentu !== 'FP');
  const sum = (set: Record<string, string>[], f: string) => set.reduce((n, x) => n + minorOf(x[f]), 0n);
  for (const f of K) {
    const e = jpkWholeZloty(sum(counted, f)), p = v['P_' + f.slice(2)];
    if (e === 0n) assert.equal(p, undefined, f); else assert.deepEqual(p, [e.toString()], f);
  }
  const vat = ['K_16', 'K_18', 'K_20'].reduce((n, f) => n + sum(counted, f), 0n);
  assert.equal(minorOf(v.PodatekNalezny![0]), vat, 'PodatekNalezny without FP');
  assert.equal(sum(rows, 'K_20') - sum(fp, 'K_20'), sum(counted, 'K_20'));
  assert.deepEqual(v.LiczbaWierszySprzedazy, [String(rows.length)]);
  const P = (n: number) => BigInt(v['P_' + n]?.[0] ?? '0');
  assert.equal(P(37), [10, 11, 13, 15, 17, 19, 21, 22, 31].reduce((n, i) => n + P(i), 0n));
  assert.equal(P(38), P(16) + P(18) + P(20));

  // A stored daily report "niezgodny" (the register and the app disagree) refuses the file.
  const p = (await pool.query('SELECT id FROM receipt233_printers WHERE tenant_id=$1', [a.tenant])).rows[0].id;
  await pool.query(`INSERT INTO receipt233_daily_reports(tenant_id,printer_id,printer_unique_number,fiscal_date,report_number,printer_receipts,printer_totals,app_receipts,app_totals,matches,actor_id)
    VALUES($1,$2,$3,$5::date,'0099',1,'[{"ptu":"A","gross_minor":"1230","vat_minor":"230"}]',0,'[]',false,$4)`, [a.tenant, p, UNIQUE, a.user, day(20)]);
  const bad = await session(`/api/jpk/v7m.xml?okres=${month}&${TP}`);
  assert.equal(bad.statusCode, 409, bad.body);
  assert.deepEqual(bad.json().documents, [{ number: `Raport dobowy 0099 z ${day(20)}, kasa ${UNIQUE}`, reason: 'Raport niezgodny z paragonami aplikacji (kasa: 1 paragonów, aplikacja: 0) — wyjaśnij różnicę przed złożeniem JPK_V7' }]);
});
