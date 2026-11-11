import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPayuSettlement, type PayuSettlementSession } from '../server/payment-payu-reconcile';
// SYNTHETIC settlement rows; the real PayU report columns are a sandbox question.
const sessions: PayuSettlementSession[] = [
  { sessionId: 's1', orderId: 'ORDER0000001', extOrderId: 'sess-1', amount: 10000, currency: 'PLN', status: 'COMPLETED', settled: false },
  { sessionId: 's2', orderId: 'ORDER0000002', extOrderId: 'sess-2', amount: 5000, currency: 'EUR', status: 'COMPLETED', settled: false },
  { sessionId: 's3', orderId: 'ORDER0000003', extOrderId: 'sess-3', amount: 700, currency: 'PLN', status: 'PENDING', settled: false },
  { sessionId: 's4', orderId: 'ORDER0000004', extOrderId: 'sess-4', amount: 900, currency: 'PLN', status: 'COMPLETED', settled: true },
  { sessionId: 's5', orderId: 'ORDER0000005', extOrderId: 'dup', amount: 100, currency: 'PLN', status: 'COMPLETED', settled: false },
  { sessionId: 's6', orderId: 'ORDER0000006', extOrderId: 'dup', amount: 100, currency: 'PLN', status: 'COMPLETED', settled: false },
];

test('payout.reconcile: exactly one COMPLETED session with equal amount and currency is ready', () => {
  const rows = [
    { position: 0, reference: 'ORDER0000001', amount: 10000, fee: 190, currency: 'PLN' as const },
    { position: 1, reference: 'sess-2', amount: 5000, fee: 0, currency: 'EUR' as const },
    { position: 2, reference: 'sess-1', amount: 10000, fee: 190, currency: 'PLN' as const },
    { position: 3, reference: 'nope', amount: 1, fee: 0, currency: 'PLN' as const },
    { position: 4, reference: 'dup', amount: 100, fee: 0, currency: 'PLN' as const },
    { position: 5, reference: 'sess-3', amount: 700, fee: 0, currency: 'PLN' as const },
    { position: 6, reference: 'sess-4', amount: 900, fee: 0, currency: 'PLN' as const },
    { position: 7, reference: 'ORDER0000002', amount: 5000, fee: 0, currency: 'PLN' as const },
    { position: 8, reference: 'ORDER0000001', amount: 100, fee: 200, currency: 'PLN' as const },
  ];
  const out = matchPayuSettlement(rows, sessions);
  assert.deepEqual(
    out.map((m) => [m.position, m.classification, m.sessionId, m.net]),
    [
      [0, 'ready', 's1', 9810],
      [1, 'ready', 's2', 5000],
      [2, 'duplicate', 's1', null],
      [3, 'unmatched', null, null],
      [4, 'ambiguous', null, null],
      [5, 'conflict', 's3', null],
      [6, 'duplicate', 's4', null],
      [7, 'duplicate', 's2', null],
      [8, 'invalid', null, null],
    ],
  );
  const mismatch = matchPayuSettlement([{ position: 0, reference: 'sess-1', amount: 9999, fee: 0, currency: 'PLN' }], sessions);
  assert.equal(mismatch[0].classification, 'conflict');
  assert.match(mismatch[0].issue!, /Kwota lub waluta/);
});
