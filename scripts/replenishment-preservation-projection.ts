import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';

export const REPLENISHMENT_PO_COLUMNS = ['replenishment_execution_id', 'replenishment_group_index'];

/** Only two additive NULL fields may be projected from an earlier PO. No
 * business value, row, identity, checkpoint or baseline may be rebased. */
export async function earlierPurchaseProjection(
  c: PoolClient,
  table: string,
  enabled: boolean,
  where: string,
  args: unknown[],
) {
  if (!enabled || table !== 'purchase_orders') return 'to_jsonb(t)';
  const columns = (
    await c.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='purchase_orders' AND column_name=ANY($1::text[])",
      [REPLENISHMENT_PO_COLUMNS],
    )
  ).rows;
  if (!columns.length) return 'to_jsonb(t)';
  assert.equal(columns.length, 2, 'Partial replenishment PO linkage schema');
  const count = (
    await c.query(
      `SELECT count(*)::int n FROM purchase_orders t ${where} ${where ? 'AND' : 'WHERE'} (t.replenishment_execution_id IS NOT NULL OR t.replenishment_group_index IS NOT NULL)`,
      args,
    )
  ).rows[0].n;
  assert.equal(count, 0, 'Earlier PO has a new replenishment identity');
  return "to_jsonb(t)-ARRAY['replenishment_execution_id','replenishment_group_index']";
}
