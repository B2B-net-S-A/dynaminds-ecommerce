import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { ensure } from './errors';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import type { OrderMergeTransferInput } from './order-merge-payments';

export async function orderMergeCustodySnapshotInTx(c: PoolClient, orderIds: string[]) {
  ensure(
    orderIds.length > 0 && orderIds.length <= 101 && new Set(orderIds).size === orderIds.length,
    422,
    'Nieprawidłowy zakres odpowiedzialności za towar',
  );
  ensure(
    (
      await c.query(
        "SELECT to_regprocedure('public.order_merge_custody_snapshot(uuid[])') IS NOT NULL AS available",
      )
    ).rows[0].available,
    503,
    'Ta kopia nie obsługuje przeniesienia rezerwacji',
  );
  return (await c.query('SELECT order_merge_custody_snapshot($1::uuid[]) AS snapshot', [orderIds]))
    .rows[0].snapshot;
}

/** Caller admits the tenant and locks all selected orders before deriving the target. */
export async function transferOrderMergeCustodyInTx(
  c: PoolClient,
  a: Actor,
  input: OrderMergeTransferInput,
) {
  const ids = [...new Set(input.source_order_ids)].sort();
  ensure(ids.length >= 2 && ids.length <= 100, 422, 'Nieprawidłowy zakres scalania');
  const scope = (await c.query("SELECT nullif(current_setting('app.tenant_id',true),'') AS tenant"))
    .rows[0].tenant;
  ensure(scope === a.tenantId, 403, 'Inna firma');
  const e = (
    await c.query('SELECT * FROM order_merge_executions WHERE tenant_id=$1 AND id=$2', [
      a.tenantId,
      input.execution_id,
    ])
  ).rows[0];
  ensure(
    e &&
      e.actor_id === a.userId &&
      e.target_order_id === input.target_order_id &&
      e.merge_mode === input.merge_mode &&
      JSON.stringify([...e.source_ids].sort()) === JSON.stringify(ids),
    409,
    'Brak własnego dowodu scalania',
  );
  ensure(
    (await c.query('SELECT order_merge_current_role($1,false) role', [a.userId])).rows[0].role === 'admin',
    403,
    'Przeniesienie rezerwacji wymaga aktualnego administratora',
  );
  enlistWmsActorInTx(c, a, { adminOnly: true, orders: true });
  await c.query('SELECT order_merge_transfer_custody($1)', [input.execution_id]);
}
