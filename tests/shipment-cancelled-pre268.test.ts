// replacedLabelsInTx (order card, hydrateOrder) on a database before migration 268: a restored older copy and the
// migration tests that seed on a partly migrated database have no shipment268_replaced_labels, so no replaced labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replacedLabelsInTx } from '../server/shipment-cancelled';

const client = (present: boolean, rows: unknown[] = []) => {
  const sql: string[] = [];
  return {
    sql,
    c: {
      query: async (text: string) => {
        sql.push(text);
        if (text.includes('to_regclass')) return { rows: [{ present }] };
        if (!present) throw new Error('relation "shipment268_replaced_labels" does not exist');
        return { rows };
      },
    } as never,
  };
};

test('before 268: no replaced labels, and the missing table is never read', async () => {
  const { c, sql } = client(false);
  assert.deepEqual(await replacedLabelsInTx(c, 'order'), []);
  assert.equal(sql.filter((s) => s.includes('FROM shipment268_replaced_labels')).length, 0);
});

test('after 268: the replaced labels of the order', async () => {
  const row = { carrier: 'demo', tracking_number: 'T1', label_created_at: new Date(0), replaced_at: new Date(1), replaced_by: 'T2' };
  const { c, sql } = client(true, [row]);
  assert.deepEqual(await replacedLabelsInTx(c, 'order'), [row]);
  assert.equal(sql.filter((s) => s.includes('FROM shipment268_replaced_labels')).length, 1);
});
