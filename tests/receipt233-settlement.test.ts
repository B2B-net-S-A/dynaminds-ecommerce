/** Fiscal receipts (233) in the settlement report: a printed receipt documents the sale (paid vs
 * receipted), an invoice to the receipt is not counted twice, a receipt not printed is flagged. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileOrder, settlementCsv, settlementTotals, type OrderFacts, type ReceiptFact } from '../server/settlement-report';

const order = (o: Partial<OrderFacts> = {}): OrderFacts => ({
  order_id: '00000000-0000-4000-8000-000000000001', number: 'ZAM-1', customer: 'Jan Kowalski', created_at: '2026-10-10T10:00:00.000Z',
  status: 'shipped', payment_mode: 'prepaid', currency: 'PLN', total: 12345n, merge: { role: 'none', ledger_orders: 1 },
  payments: [{ kind: 'receipt', amount: 12345n, fee: 0n, currency: 'PLN' }], documents: [], return_credit: 0n, cancelled_credit: 0n, returns: 0, ...o,
});
const receipt = (r: Partial<ReceiptFact> = {}): ReceiptFact => ({ number: '000017', state: 'printed', gross: 12345n, invoice_number: null, ...r });

test('a printed receipt equal to the payment is zgodne and documents the sale', () => {
  const r = reconcileOrder(order({ receipts: [receipt()] }));
  assert.deepEqual([r.status, r.receipted, r.receipt_difference, r.documented, r.receipt_numbers], ['zgodne', 12345n, 0n, 12345n, ['000017']]);
  assert.deepEqual(reconcileOrder(order()).flags, ['brak_faktury']);
});
test('paid vs receipted: a difference is flagged', () => {
  const r = reconcileOrder(order({ receipts: [receipt({ gross: 12000n })] }));
  assert.deepEqual(r.flags, ['paragon_niezgodny']);
  assert.equal(r.receipt_difference, -345n);
});
test('an invoice to the receipt documents the same sale once', () => {
  const r = reconcileOrder(order({ receipts: [receipt({ invoice_number: 'FV-S/A/2026/000001' })], documents: [{ kind: 'invoice', source: 'invoice230', number: 'FV-S/A/2026/000001', gross: 12345n, currency: 'PLN' }] }));
  assert.deepEqual([r.status, r.documented, r.invoiced, r.receipted], ['zgodne', 12345n, 12345n, 12345n]);
});
test('a failed or queued receipt is not a document and is flagged', () => {
  const r = reconcileOrder(order({ receipts: [receipt({ state: 'failed', number: null })] }));
  assert.deepEqual(r.flags, ['brak_faktury', 'paragon_niewydrukowany']);
  assert.equal(r.receipted, 0n);
  const csv = settlementCsv([reconcileOrder(order({ receipts: [receipt()] }))], settlementTotals([r]));
  const [head, row] = csv.replace('﻿', '').split('\r\n');
  const cols = head!.split(',').map(x => JSON.parse(x)), cells = row!.split(',').map(x => JSON.parse(x));
  assert.deepEqual(cols.slice(-3), ['paragony_gr', 'paragony', 'roznica_paragonow_gr']);
  assert.deepEqual(cells.slice(-3), ['12345', '000017', '0']);
});
