/** Settlement report loader: corrections of consumer returns (KOR 206/207, table return_credit206_documents)
 * are corrections of the order, like KOR 188 and KOR-S 232. Found in the stage-3 rehearsal on the release
 * (docs/parity/STAGE3-REHEARSAL-20261027.md): an order with FV 4401, KOR 188 −1000 and KOR 206 −1700 and
 * 2700 refunded was shown as documented 3401 with zwrot_bez_korekty + faktura_niezgodna. No database: the
 * client answers the loader's queries by table name. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { settlementReportInTx } from '../server/settlement-report-data';

const TENANT = '00000000-0000-4000-8000-0000000000aa', ORDER = '00000000-0000-4000-8000-000000000001';
const TABLES = new Set(['local_consumer_credit_documents', 'return_credit206_documents']);
function client(): PoolClient {
  const query = async (sql: string, params: unknown[] = []) => {
    const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });
    if (sql.includes('to_regclass')) return rows([{ ok: TABLES.has(String(params[0]).replace('public.', '')) }]);
    if (sql.includes('FROM orders')) return rows([{ id: ORDER, number: 'ZAM-206', customer_name: 'Klient zwrotów', created_at: new Date('2026-10-27T10:00:00Z'),
      status: 'shipped', payment_mode: 'prepaid', currency: 'PLN', total: '4401' }]);
    if (sql.includes('FROM payment_entries')) return rows([{ order_id: ORDER, currency: 'PLN', kind: 'receipt', amount: '4401', fee: '0' },
      { order_id: ORDER, currency: 'PLN', kind: 'refund', amount: '2700', fee: '0' }]);
    if (sql.includes('FROM return_cases')) return rows([{ order_id: ORDER, credit: '2700', n: 2 }]);
    if (sql.includes('FROM documents d')) return rows([{ order_id: ORDER, kind: 'invoice', mode: 'local_invoice', number: 'S3B/2026/000001', gross: '4401', currency: 'PLN' }]);
    if (sql.includes('FROM local_consumer_credit_documents')) return rows([{ order_id: ORDER, number: 'KOR/S3B/2026/000001', gross: '-1000', currency: 'PLN' }]);
    if (sql.includes('FROM return_credit206_documents')) return rows([{ order_id: ORDER, number: 'KZ/2026/000001', gross: '-1700', currency: 'PLN' }]);
    throw new Error('unexpected query ' + sql.slice(0, 80));
  };
  return { query } as unknown as PoolClient;
}

test('KOR 206 is a correction of the order: 4401 − 1000 (188) − 1700 (206) = 1701 documented, zgodne', async () => {
  const r = await settlementReportInTx(client(), TENANT, { from: '2026-10-27', to: '2026-10-27' } as never);
  const row = r.rows[0]!;
  assert.deepEqual([row.invoiced, row.corrections, row.documented, row.amount_due, row.credit_difference, row.correction_count],
    [4401n, -2700n, 1701n, 1701n, 0n, 2]);
  assert.deepEqual(row.correction_numbers, ['KOR/S3B/2026/000001', 'KZ/2026/000001']);
  assert.deepEqual(row.flags, ['zgodne']);
});
