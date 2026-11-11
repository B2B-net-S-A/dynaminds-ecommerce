/** Settlement report arithmetic (grosze, bigint) and the route refusal paths,
 * without a database: the loader and the authorizer are injected. */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Problem } from '../server/errors';
import {
  parseSettlementQuery,
  reconcileOrder,
  serializeSettlement,
  settlementCsv,
  settlementTotals,
  type DocumentFact,
  type OrderFacts,
  type PaymentFact,
} from '../server/settlement-report';
import { registerSettlementReportRoutes, type SettlementReportDeps } from '../server/settlement-report-routes';

const pay = (kind: PaymentFact['kind'], amount: bigint, currency = 'PLN', fee = 0n): PaymentFact => ({ kind, amount, fee, currency });
const doc = (kind: DocumentFact['kind'], gross: bigint | null, number = kind === 'invoice' ? 'FV/1' : 'KOR/1', currency: string | null = 'PLN'): DocumentFact =>
  ({ kind, gross, number, currency, source: 'local_invoice' });
const order = (o: Partial<OrderFacts> = {}): OrderFacts => ({
  order_id: '00000000-0000-4000-8000-000000000001', number: 'ZAM-1', customer: 'Jan Kowalski', created_at: '2026-10-10T10:00:00.000Z',
  status: 'shipped', payment_mode: 'prepaid', currency: 'PLN', total: 12345n, merge: { role: 'none', ledger_orders: 1 },
  payments: [], documents: [], return_credit: 0n, cancelled_credit: 0n, returns: 0, ...o,
});

test('fully paid and invoiced order is zgodne to the grosz', () => {
  const r = reconcileOrder(order({ payments: [pay('receipt', 12345n)], documents: [doc('invoice', 12345n)] }));
  assert.equal(r.status, 'zgodne');
  assert.deepEqual(r.flags, ['zgodne']);
  assert.equal(r.amount_due, 12345n);
  assert.equal(r.net_paid, 12345n);
  assert.equal(r.payment_difference, 0n);
  assert.equal(r.document_difference, 0n);
});

test('partial payments sum exactly and leave a niedopłata', () => {
  const r = reconcileOrder(order({ payments: [pay('receipt', 5000n), pay('receipt', 2345n), pay('receipt', 4999n)], documents: [doc('invoice', 12345n)] }));
  assert.equal(r.received, 12344n);
  assert.equal(r.payment_difference, -1n);
  assert.equal(r.status, 'niedoplata');
});

test('overpayment is nadpłata; a refund brings it back to zgodne', () => {
  const over = reconcileOrder(order({ payments: [pay('receipt', 12400n)], documents: [doc('invoice', 12345n)] }));
  assert.equal(over.payment_difference, 55n);
  assert.equal(over.status, 'nadplata');
  const refunded = reconcileOrder(order({ payments: [pay('receipt', 12400n), pay('refund', 55n)], documents: [doc('invoice', 12345n)] }));
  assert.equal(refunded.refunded, 55n);
  assert.equal(refunded.net_paid, 12345n);
  assert.equal(refunded.status, 'zgodne');
});

test('reversal facts arrive as negative amounts of the reversed kind', () => {
  const r = reconcileOrder(order({ payments: [pay('receipt', 12345n), pay('receipt', -12345n)], documents: [doc('invoice', 12345n)] }));
  assert.equal(r.received, 0n);
  assert.equal(r.status, 'niedoplata');
});

test('full return with refund and correction settles to zero', () => {
  const r = reconcileOrder(order({ status: 'return_completed', total: 26100n, return_credit: 26100n, returns: 1,
    payments: [pay('receipt', 26100n), pay('refund', 26100n)], documents: [doc('invoice', 26100n), doc('correction', -26100n)] }));
  assert.equal(r.amount_due, 0n);
  assert.equal(r.documented, 0n);
  assert.equal(r.credit_difference, 0n);
  assert.equal(r.status, 'zgodne');
});

test('multi-correction: two partial corrections cover two accepted returns', () => {
  const r = reconcileOrder(order({ total: 4401n, return_credit: 2700n, returns: 2, payments: [pay('receipt', 4401n), pay('refund', 2700n)],
    documents: [doc('invoice', 4401n), doc('correction', -1000n, 'KOR/1'), doc('correction', -1700n, 'KOR/2')] }));
  assert.equal(r.corrections, -2700n);
  assert.equal(r.correction_count, 2);
  assert.deepEqual(r.correction_numbers, ['KOR/1', 'KOR/2']);
  assert.equal(r.documented, 1701n);
  assert.equal(r.amount_due, 1701n);
  assert.equal(r.status, 'zgodne');
});

test('accepted return without refund and with a partial correction (seeded 04f60574 shape)', () => {
  const r = reconcileOrder(order({ total: 4401n, return_credit: 2700n, returns: 3, payments: [pay('receipt', 4401n)],
    documents: [doc('invoice', 4401n), doc('correction', -1000n)] }));
  assert.equal(r.amount_due, 1701n);
  assert.equal(r.payment_difference, 2700n);
  assert.equal(r.credit_difference, 1700n);
  assert.equal(r.document_difference, 1700n);
  assert.equal(r.status, 'nadplata');
  assert.deepEqual(r.flags, ['nadplata', 'zwrot_bez_korekty', 'faktura_niezgodna']);
});

test('correction without return and correction without invoice', () => {
  const noReturn = reconcileOrder(order({ payments: [pay('receipt', 12345n)], documents: [doc('invoice', 12345n), doc('correction', -345n)] }));
  assert.equal(noReturn.credit_difference, -345n);
  assert.equal(noReturn.status, 'korekta_bez_zwrotu');
  const noInvoice = reconcileOrder(order({ payments: [pay('receipt', 12345n)], documents: [doc('correction', -345n)] }));
  assert.deepEqual(noInvoice.flags, ['brak_faktury', 'korekta_bez_faktury']);
});

test('paid order without invoice is brak faktury; two invoices are flagged', () => {
  assert.equal(reconcileOrder(order({ payments: [pay('receipt', 12345n)] })).status, 'brak_faktury');
  const two = reconcileOrder(order({ payments: [pay('receipt', 12345n)], documents: [doc('invoice', 12345n, 'FV/1'), doc('invoice', 12345n, 'FV/2')] }));
  assert.equal(two.invoiced, 24690n);
  assert.deepEqual(two.flags, ['faktura_niezgodna', 'wiele_faktur']);
});

test('zero-value orders: unpaid zero order and cancelled refunded order are zgodne', () => {
  assert.equal(reconcileOrder(order({ total: 0n })).status, 'zgodne');
  const cancelled = reconcileOrder(order({ status: 'cancelled', payments: [pay('receipt', 12345n), pay('refund', 12345n)] }));
  assert.equal(cancelled.amount_due, 0n);
  assert.equal(cancelled.status, 'zgodne');
  const cancelledPaid = reconcileOrder(order({ status: 'cancelled', payments: [pay('receipt', 12345n)] }));
  assert.equal(cancelledPaid.payment_difference, 12345n);
  assert.equal(cancelledPaid.status, 'nadplata');
});

test('credit larger than the total never makes a negative amount due', () => {
  const r = reconcileOrder(order({ total: 1000n, return_credit: 800n, cancelled_credit: 400n }));
  assert.equal(r.amount_due, 0n);
});

test('COD: courier collection counts as received; remittance and fee only as courier balance', () => {
  const r = reconcileOrder(order({ payment_mode: 'cod', payments: [pay('courier_collection', 12345n), pay('courier_remittance', 12000n, 'PLN', 345n)], documents: [doc('invoice', 12345n)] }));
  assert.equal(r.received, 12345n);
  assert.equal(r.collected, 12345n);
  assert.equal(r.remitted, 12000n);
  assert.equal(r.courier_fees, 345n);
  assert.equal(r.courier_due, 0n);
  assert.equal(r.status, 'zgodne');
});

test('foreign currency is kept separate from the order currency and in totals', () => {
  const pln = reconcileOrder(order({ payments: [pay('receipt', 12345n), pay('receipt', 999n, 'EUR')], documents: [doc('invoice', 12345n), doc('invoice', 500n, 'FV/E', 'EUR')] }));
  assert.equal(pln.received, 12345n);
  assert.equal(pln.invoiced, 12345n);
  assert.deepEqual(pln.foreign, [{ currency: 'EUR', received: 999n, refunded: 0n, invoiced: 500n, corrections: 0n }]);
  assert.equal(pln.status, 'inna_waluta');
  const eur = reconcileOrder(order({ order_id: 'e', currency: 'EUR', total: 2000n, payments: [pay('receipt', 2000n, 'EUR')], documents: [doc('invoice', 2000n, 'FV/E2', 'EUR')] }));
  const totals = settlementTotals([pln, eur]);
  assert.deepEqual(totals.map((t) => t.currency), ['PLN', 'EUR']);
  assert.equal(totals[0].received, 12345n);
  assert.equal(totals[0].orders, 1);
  assert.equal(totals[1].received, 2000n);
  assert.equal(totals[1].orders, 1);
  assert.equal(totals[1].foreign_received, 999n);
  assert.equal(totals[1].foreign_documented, 500n);
});

test('unreadable document amount is flagged and not summed', () => {
  const r = reconcileOrder(order({ payments: [pay('receipt', 12345n)], documents: [doc('invoice', 12345n), doc('correction', null)] }));
  assert.equal(r.corrections, 0n);
  assert(r.flags.includes('dokument_nieczytelny'));
});

test('merged source rows are shown but excluded from totals', () => {
  const src = reconcileOrder(order({ order_id: 's', merge: { role: 'source', target_number: 'ZAM-2', ledger_orders: 1 } }));
  assert.equal(src.status, 'scalone');
  assert.equal(src.in_totals, false);
  const tgt = reconcileOrder(order({ order_id: 't', total: 246n, merge: { role: 'target', ledger_orders: 2 } }));
  const t = settlementTotals([src, tgt]);
  assert.equal(t[0].orders, 1);
  assert.equal(t[0].order_total, 246n);
});

test('totals equal the sum of rows for every field', () => {
  const rows = [
    reconcileOrder(order({ order_id: 'a', payments: [pay('receipt', 1n)] })),
    reconcileOrder(order({ order_id: 'b', total: 99n, payments: [pay('receipt', 100n)], documents: [doc('invoice', 99n)] })),
  ];
  const [t] = settlementTotals(rows);
  assert.equal(t.amount_due, 12345n + 99n);
  assert.equal(t.payment_difference, -12344n + 1n);
  assert.deepEqual(t.statuses, { niedoplata: 1, nadplata: 1 });
});

test('serialization keeps safe integers and refuses unsafe ones', () => {
  assert.deepEqual(serializeSettlement({ a: 5n, b: [1n, { c: -2n }] }), { a: 5, b: [1, { c: -2 }] });
  assert.throws(() => serializeSettlement({ a: 2n ** 60n }), (e: unknown) => e instanceof Problem && e.status === 409);
});

test('CSV: BOM, header, integer grosze, formula-safe text, totals row', () => {
  const r = reconcileOrder(order({ customer: '=HYPERLINK("x")', payments: [pay('receipt', 12300n)], documents: [doc('invoice', 12345n)] }));
  const csv = settlementCsv([r], settlementTotals([r]));
  assert(csv.startsWith('﻿"numer_zamowienia"'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /"'=HYPERLINK\(""x""\)"/);
  assert.match(lines[1], /"-45"/);
  assert.match(lines[2], /^"SUMA PLN"/);
});

test('query validation: Polish 400 messages for bad dates and unknown params', () => {
  assert.deepEqual(parseSettlementQuery({ from: '2026-10-01', to: '2026-10-31' }), { from: '2026-10-01', to: '2026-10-31' });
  const bad = (q: unknown, re: RegExp) => assert.throws(() => parseSettlementQuery(q), (e: unknown) => e instanceof Problem && e.status === 400 && re.test(e.message));
  bad({ from: '2026-02-30', to: '2026-03-01' }, /Niepoprawna data/);
  bad({ from: '01.10.2026', to: '2026-10-31' }, /RRRR-MM-DD/);
  bad({ from: '2026-10-31', to: '2026-10-01' }, /późniejsza/);
  bad({ from: '2025-01-01', to: '2026-10-31' }, /366 dni/);
  bad({ to: '2026-10-31' }, /RRRR-MM-DD/);
  bad({ from: '2026-10-01', to: '2026-10-31', currency: 'BTC' }, /waluta/);
  bad({ from: '2026-10-01', to: '2026-10-31', tenant_id: 'x' }, /parametr/);
});

async function routeApp(deps: SettlementReportDeps, role = 'admin', apiScopes?: string[]) {
  const app = Fastify();
  app.decorateRequest('actor');
  app.decorateRequest('apiScopes');
  app.addHook('onRequest', async (req: any) => {
    req.actor = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role };
    req.apiScopes = apiScopes;
  });
  app.setErrorHandler((err: any, _req, reply) =>
    err instanceof Problem ? reply.code(err.status).send({ detail: err.message }) : reply.code(500).send({ detail: 'Nieoczekiwany błąd serwera' }));
  registerSettlementReportRoutes(app, { readOnly: false }, deps);
  await app.ready();
  return app;
}
const sample = (tenantId: string) => {
  const rows = [reconcileOrder(order({ payments: [pay('receipt', 12345n)], documents: [doc('invoice', 12345n)] }))];
  return { from: '2026-10-01', to: '2026-10-31', currency: null, generated_at: '2026-10-23T00:00:00.000Z', rows, totals: settlementTotals(rows), tenantId };
};

test('route: no permission → 403 and the loader never runs', async () => {
  let loaded = 0;
  const app = await routeApp({
    authorize: async () => { throw new Problem(403, 'Wymagany aktualny administrator finansów'); },
    load: async (t) => { loaded++; return sample(t); },
  }, 'viewer');
  for (const url of ['/api/settlement-report?from=2026-10-01&to=2026-10-31', '/api/settlement-report/file?from=2026-10-01&to=2026-10-31']) {
    const r = await app.inject({ url });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().detail, 'Wymagany aktualny administrator finansów');
  }
  assert.equal(loaded, 0);
  await app.close();
});

test('route: API key is refused; bad dates → 400 without stack', async () => {
  const deps: SettlementReportDeps = { authorize: async () => {}, load: async (t) => sample(t) };
  const key = await routeApp(deps, 'admin', ['orders:read', 'documents:read']);
  assert.equal((await key.inject({ url: '/api/settlement-report?from=2026-10-01&to=2026-10-31' })).statusCode, 403);
  await key.close();
  const app = await routeApp(deps);
  const r = await app.inject({ url: '/api/settlement-report?from=2026-13-01&to=2026-10-31' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().detail, /data/i);
  assert(!/at |stack|Error/.test(r.body), r.body);
  await app.close();
});

test('route: admin gets JSON numbers and a CSV attachment', async () => {
  const app = await routeApp({ authorize: async () => {}, load: async (t) => sample(t) });
  const j = await app.inject({ url: '/api/settlement-report?from=2026-10-01&to=2026-10-31' });
  assert.equal(j.statusCode, 200);
  assert.equal(j.headers['cache-control'], 'no-store');
  assert.equal(j.json().rows[0].amount_due, 12345);
  assert.equal(j.json().totals[0].received, 12345);
  const f = await app.inject({ url: '/api/settlement-report/file?from=2026-10-01&to=2026-10-31' });
  assert.equal(f.statusCode, 200);
  assert.match(String(f.headers['content-type']), /text\/csv/);
  assert.match(String(f.headers['content-disposition']), /rozliczenie-2026-10-01-2026-10-31\.csv/);
  assert(f.body.includes('"SUMA PLN"'));
  await app.close();
});
