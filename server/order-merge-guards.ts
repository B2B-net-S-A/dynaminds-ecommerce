import type { PoolClient } from 'pg';
import { ensure } from './errors';

export async function orderMergeClaimInTx(c: PoolClient, id: string) {
  const available = (
    await c.query("SELECT to_regclass('public.order_merge_claims') IS NOT NULL AS available")
  ).rows[0].available;
  if (!available) return null;
  return (
    (
      await c.query(
        'SELECT source_order_id,target_order_id,execution_id,merge_mode FROM order_merge_claims WHERE source_order_id=$1',
        [id],
      )
    ).rows[0] ?? null
  );
}

/** Call after locking the order, so merge and operational admission are atomic. */
export async function assertOrderMergeActiveInTx(c: PoolClient, id: string) {
  ensure(
    !(await orderMergeClaimInTx(c, id)),
    409,
    'Realizacja tego zamówienia została przeniesiona przez łączenie. Otwórz zamówienie wynikowe.',
  );
}

export async function orderMergeOriginInTx(c: PoolClient, id: string) {
  const available = (
    await c.query("SELECT to_regclass('public.order_merge_origins') IS NOT NULL AS available")
  ).rows[0].available;
  if (!available) return null;
  return (
    (await c.query('SELECT header,items FROM order_merge_origins WHERE order_id=$1', [id]))
      .rows[0] ?? null
  );
}
