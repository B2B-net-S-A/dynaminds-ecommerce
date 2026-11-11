import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { Problem } from '../server/errors';
import {
  orderFulfillmentKind,
  returnRemedy,
  assertSaleFinancialKind,
  assertRefundRemedy,
  readOrderFulfillmentKindInTx,
  assertSaleFinancialOrderInTx,
  assertRefundRemedyInTx,
} from '../server/order-fulfillment-kind';

const denied = (status: number) => (error: unknown) =>
  error instanceof Problem && error.status === status;

test('legacy missing discriminator retains sale/refund, including a genuine zero-value sale', () => {
  assert.equal(orderFulfillmentKind({ total: 0 }), 'sale');
  assert.equal(returnRemedy({ refund_amount: 0 }), 'refund');
  assert.doesNotThrow(() => assertSaleFinancialKind({ total: 0 }));
  assert.doesNotThrow(() => assertRefundRemedy({ refund_amount: 0 }));
});

test('explicit replacement/exchange is classified separately from zero-value sale/refund', () => {
  assert.equal(orderFulfillmentKind({ fulfillment_kind: 'replacement', total: 0 }), 'replacement');
  assert.equal(orderFulfillmentKind({ fulfillment_kind: 'sale', total: 0 }), 'sale');
  assert.equal(returnRemedy({ remedy: 'exchange', refund_amount: 0 }), 'exchange');
  assert.equal(returnRemedy({ remedy: 'refund', refund_amount: 0 }), 'refund');
});

test('present null, undefined, unknown and non-scalar discriminators do not use legacy fallback', () => {
  for (const invalid of [null, undefined, '', 'warranty', 0, ['sale'], { kind: 'sale' }]) {
    assert.throws(() => orderFulfillmentKind({ fulfillment_kind: invalid }), denied(409));
    assert.throws(() => returnRemedy({ remedy: invalid }), denied(409));
  }
});

test('money/document/merge purposes deny replacement and correction/refund purposes deny exchange', () => {
  assert.throws(() => assertSaleFinancialKind({ fulfillment_kind: 'replacement' }), denied(409));
  assert.throws(() => assertRefundRemedy({ remedy: 'exchange' }), denied(409));
  assert.doesNotThrow(() => assertSaleFinancialKind({ fulfillment_kind: 'sale' }));
  assert.doesNotThrow(() => assertRefundRemedy({ remedy: 'refund' }));
});

function scopedClient(own: Record<string, unknown> | undefined, table: 'orders' | 'return_cases') {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const c = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      // This is a query-boundary unit oracle, not PostgreSQL/RLS evidence.
      assert.match(sql, /to_jsonb\(/);
      assert.match(sql, new RegExp('FROM ' + table + ' '));
      assert.match(sql, /\.tenant_id=nullif\(current_setting\('app\.tenant_id',true\),''\)::uuid/);
      assert.match(sql, /\.id=\$1/);
      assert.doesNotMatch(sql, /SET\s|FOR\s+(UPDATE|SHARE)/i);
      return { rows: own ? [{ row: own }] : [] };
    },
  } as unknown as PoolClient;
  return { c, calls };
}

test('transaction query reads the complete own row without requiring new columns in old schemas', async () => {
  const { c, calls } = scopedClient({ id: 'own-order', total: 0 }, 'orders');
  assert.equal(await readOrderFulfillmentKindInTx(c, 'own-order'), 'sale');
  assert.deepEqual(calls[0].values, ['own-order']);
  await assertSaleFinancialOrderInTx(c, 'own-order');
});

test('transaction query denies foreign/missing scoped orders and return cases with404', async () => {
  await assert.rejects(
    readOrderFulfillmentKindInTx(scopedClient(undefined, 'orders').c, 'foreign-order'),
    denied(404),
  );
  await assert.rejects(
    assertRefundRemedyInTx(scopedClient(undefined, 'return_cases').c, 'foreign-return'),
    denied(404),
  );
});

test('transaction money guards classify the persisted row and deny replacement or exchange', async () => {
  await assert.rejects(
    assertSaleFinancialOrderInTx(
      scopedClient({ fulfillment_kind: 'replacement' }, 'orders').c,
      'own-order',
    ),
    denied(409),
  );
  await assert.rejects(
    assertSaleFinancialOrderInTx(scopedClient({ fulfillment_kind: null }, 'orders').c, 'own-order'),
    denied(409),
  );
  await assert.rejects(
    assertRefundRemedyInTx(scopedClient({ remedy: 'exchange' }, 'return_cases').c, 'own-return'),
    denied(409),
  );
  await assertRefundRemedyInTx(scopedClient({ refund_amount: 0 }, 'return_cases').c, 'own-return');
});
