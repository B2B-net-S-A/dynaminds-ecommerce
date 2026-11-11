/** B2B-005 (251): the supplier's parcel numbers of a dropshipping order are copied to the seller's customer
 * order, one row per supplier parcel (b2b258_tracking_copies), and each new copy raises the customer order event
 * order.dropship_tracking, which automations and webhooks of the shop or marketplace channel use.
 *
 * Decision (see INTEGRATION.md): a mapping table, not a new b2b_dropship_actions kind (that CHECK and trigger family
 * is sealed) and not a local shipments row (that would invent a local parcel, its dispatch evidence and its stock
 * issue). The copy never changes the customer order status; reconciliation stays the explicit existing action. */
import type { PoolClient } from 'pg';
import { event } from './domain';
import { networkLifecycleInstalled, networkLifecycleSetScope as scope } from './b2b-network-lifecycle-release';
import { trackingToCopy } from './b2b-network-lifecycle-model';

interface DropRow { id: string; tenant_id: string; customer_order_id: string; supplier_tenant_id: string; supplier_order_id: string }

/** Seller scope on entry and return. Returns the number of new copies; the same parcels again add nothing. */
export async function copyDropshipTrackingInTx(c: PoolClient, d: DropRow): Promise<number> {
  if (!(await networkLifecycleInstalled(c))) return 0;
  await scope(c, d.supplier_tenant_id);
  const parcels = (await c.query('SELECT id,carrier,tracking_number,dispatched_at FROM shipments WHERE order_id=$1 ORDER BY id LIMIT 100', [d.supplier_order_id])).rows;
  await scope(c, d.tenant_id);
  const copied = new Set((await c.query('SELECT source_shipment_id FROM b2b258_tracking_copies WHERE tenant_id=$1 AND dropship_order_id=$2', [d.tenant_id, d.id])).rows.map((r) => r.source_shipment_id as string));
  let added = 0;
  for (const p of trackingToCopy(parcels, copied)) {
    const row = (await c.query(
      `INSERT INTO b2b258_tracking_copies(tenant_id,dropship_order_id,customer_order_id,supplier_tenant_id,supplier_order_id,source_shipment_id,carrier,tracking_number,dispatched_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING source_shipment_id`,
      [d.tenant_id, d.id, d.customer_order_id, d.supplier_tenant_id, d.supplier_order_id, p.id, p.carrier, p.tracking_number, p.dispatched_at],
    )).rows[0];
    if (!row) continue;
    added++;
    await event(c, d.tenant_id, d.customer_order_id, 'order.dropship_tracking', {
      carrier: p.carrier, tracking_number: p.tracking_number, dispatched_at: p.dispatched_at, dropship_order_id: d.id,
    });
  }
  return added;
}
/** Seller scope: the copies of one dropshipping order, oldest first (empty before 251). */
export async function dropshipTrackingInTx(c: PoolClient, d: { id: string; tenant_id: string }) {
  if (!(await networkLifecycleInstalled(c))) return [];
  return (await c.query(
    'SELECT carrier,tracking_number,dispatched_at,created_at copied_at FROM b2b258_tracking_copies WHERE tenant_id=$1 AND dropship_order_id=$2 ORDER BY dispatched_at,source_shipment_id',
    [d.tenant_id, d.id],
  )).rows;
}
