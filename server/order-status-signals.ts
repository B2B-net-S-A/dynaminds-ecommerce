import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isLocalFinancialVersion } from './local-financial-policy';
// Event signals coalesce per channel. Periodic catch-up also covers events arriving behind the cursor.
export async function signalStatus(c: PoolClient, tenantId: string, orderId: string) {
  if (await isLocalFinancialVersion(c, orderId)) return;
  const o = (await c.query('SELECT channel_id,status,payment_mode FROM orders WHERE id=$1', [orderId])).rows[0];
  if (
    !o?.channel_id ||
    !['paid', 'picking', 'packed', 'shipped', 'delivered', 'completed', 'cancelled'].includes(
      o.status,
    ) ||
    // Cash on delivery in paid ("Nowe") is not paid; the channel is told nothing until picking.
    (o.status === 'paid' && o.payment_mode === 'cod')
  )
    return;
  const cfg = (
    await c.query('SELECT * FROM order_status_configs WHERE channel_id=$1 AND enabled', [
      o.channel_id,
    ])
  ).rows[0];
  if (cfg) await insertStatusScan(c, cfg);
}
export async function insertStatusScan(c: PoolClient, cfg: any) {
  const id = randomUUID();
  const result = await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'order.status.scan',$3,$4) ON CONFLICT DO NOTHING RETURNING id",
    [
      id,
      cfg.tenant_id,
      JSON.stringify({
        channel_id: cfg.channel_id,
        actor_id: cfg.actor_id,
        version: cfg.version,
        after: null,
        stats: { checked: 0, queued: 0, skipped: 0, errors: 0 },
      }),
      'order.status.scan:' + id,
    ],
  );
  return { id: result.rows[0]?.id ?? null, reused: !result.rowCount };
}
