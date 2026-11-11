import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { amazonFulfillmentLocal } from '../server/amazon-fulfillment';
import { fulfillmentLocal } from '../server/ebay-fulfillment';
import { Problem } from '../server/errors';

// Executes the actual whole-order local admission functions with a query-boundary
// oracle. No PostgreSQL/RLS, transport, provider ACK or scheduler paging proof.
const orderId = '11111111-1111-4111-8111-111111111111';
const channelId = '22222222-2222-4222-8222-222222222222';
const single = {
  id: '33333333-3333-4333-8333-333333333333',
  carrier: 'QA carrier', tracking_number: 'QA150TRACK1', mode: 'sandbox',
  dispatched_at: new Date(Date.now() - 60000).toISOString(),
};
const other = { ...single, id: '44444444-4444-4444-8444-444444444444', tracking_number: 'QA150TRACK2' };
const originalRead = new Error('Single shipment reached original import validation');
function client(provider: 'amazon' | 'ebay', shipments: typeof single[]) {
  const calls: string[] = [];
  const c = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (/^SELECT \* FROM orders WHERE id=\$1/.test(sql)) {
        assert.deepEqual(values, [orderId]);
        return { rows: [{ id: orderId, source: provider, channel_id: channelId, external_id: 'QA150-original', status: 'shipped', source_snapshot: provider === 'amazon' ? { amazon: { version: '2026-01-01' } } : { ebay: { field_groups: 'TAX_BREAKDOWN' } } }] };
      }
      if (sql.includes("to_regclass('public.b2b_external_order_intents')")) return { rows: [{ head: false, revisions: false, proofs: false, created_orders: false, installed_probe: false }] };
      if (sql.includes("to_regclass('public.b2b_dropship_lines')")) return { rows: [{ lines: false, orders: false, installed_probe: false }] };
      if (/^SELECT \* FROM channels WHERE id=\$1/.test(sql)) {
        assert.deepEqual(values, [channelId]);
        return { rows: [{ id: channelId, provider, mode: 'sandbox', settings: {} }] };
      }
      if (/^SELECT \* FROM shipments WHERE order_id=\$1/.test(sql)) {
        assert.deepEqual(values, [orderId]);
        return { rows: shipments };
      }
      if (sql.includes('FROM inbound_orders')) throw originalRead;
      throw Error('Unexpected local admission query');
    },
  } as unknown as PoolClient;
  return { c, calls };
}

for (const [provider, local] of [['amazon', amazonFulfillmentLocal], ['ebay', fulfillmentLocal]] as const) {
  test(`${provider} rejects absent or ambiguous shipments before original data/provider confirmation`, async () => {
    for (const lock of [false, true]) {
      for (const rows of [[], [single, other], [other, single]]) {
        const { c, calls } = client(provider, rows);
        await assert.rejects(local(c, orderId, lock), (e: unknown) => e instanceof Problem && e.status === 409 && e.message.includes('dokładnie jednej przesyłki'));
        assert.equal(calls.some(sql => sql.includes('FROM inbound_orders')), false);
        assert.equal(calls.some(sql => /\b(?:INSERT|UPDATE|DELETE)\b/.test(sql)), false);
        const shipmentRead = calls.find(sql => sql.includes('FROM shipments'))!;
        assert.equal(shipmentRead.endsWith(' FOR SHARE'), lock);
      }
    }
  });
  test(`${provider} retains the single-shipment path to original import validation`, async () => {
    const { c, calls } = client(provider, [single]);
    await assert.rejects(local(c, orderId, true), e => e === originalRead);
    assert.equal(calls.filter(sql => sql.includes('FROM inbound_orders')).length, 1);
    assert.equal(calls.some(sql => /\b(?:INSERT|UPDATE|DELETE)\b/.test(sql)), false);
  });
}
