/** "Zmień magazyn" (order card) and the rule effect "Przypisz magazyn": one path for both.
 * The order is admitted exactly like a reservation edit (sale before picking, not from a split/merge, without
 * documents, shipping, scans, returns or external custody), the products' catalogs must sell from the new warehouse,
 * and WMS lots must be off. The move itself is the owner function order_warehouse269_transfer (migration 269):
 * in one transaction it gives the old warehouse its reserved stock and location rows back, changes
 * orders.warehouse_id and reserves the same quantities in the new warehouse as createOrder does; it refuses in
 * Polish (not enough stock, a picked or shipped order, another company's or the same warehouse) and then nothing
 * changes. The move is logged in order_warehouse269_transfers and the order history (order.warehouse_changed). */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure, Problem } from './errors';
import { audit, event, lockedOrder, type Actor } from './domain';
import { ORDER_LINE_EDIT_STATUSES, LINE_BLOCKERS, blockers } from './order-edit';
import { wmsLotsPolicyInTx } from './wms-lots';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { orderFulfillmentKind } from './order-fulfillment-kind';
import { lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';
import { productCatalogsAvailable, resolveProductCatalogInTx, assertProductCatalogWarehouseInTx } from './product-catalogs';

export const orderWarehouseInput = z.strictObject({
  warehouse_id: z.uuid('Wybierz magazyn'),
  expected_version: z.string().regex(/^\d+$/).max(30).optional(),
});
export type OrderWarehouseSource = 'manual' | 'api' | 'automation';
export type OrderWarehouseTransfer = {
  transfer_id: string;
  order_id: string;
  from_warehouse_id: string;
  from_warehouse_name: string;
  to_warehouse_id: string;
  to_warehouse_name: string;
  lines: Array<{ product_id: string; sku: string; quantity: number; from_locations: unknown[]; to_locations: unknown[] }>;
};

/** Moves the order and its reservations to another warehouse of the same company, or refuses with nothing changed. */
export async function transferOrderWarehouseInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  warehouseId: string,
  source: OrderWarehouseSource,
  expectedVersion?: string,
): Promise<OrderWarehouseTransfer> {
  ensure(a.role === 'admin' || a.role === 'operator', 403, 'Brak uprawnień do zmiany magazynu zamówienia');
  enlistWmsActorInTx(c, a, { orders: true });
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`catalog:${a.tenantId}`]);
  const o = await lockedOrder(c, id);
  ensure(expectedVersion === undefined || String(o.version) === expectedVersion, 409, 'Zamówienie zmieniło się w międzyczasie. Odśwież kartę zamówienia.');
  const target = (await c.query('SELECT id,name FROM warehouses WHERE id=$1', [warehouseId])).rows[0];
  ensure(target, 404, 'Magazyn nie należy do tej firmy');
  ensure(o.warehouse_id !== warehouseId, 409, `Zamówienie jest już przypisane do magazynu „${target.name}”`);
  ensure(orderFulfillmentKind(o) === 'sale', 409, 'Magazynu wymiany reklamacyjnej nie można zmienić');
  ensure(ORDER_LINE_EDIT_STATUSES.includes(o.status), 409, 'Magazyn można zmienić tylko przed rozpoczęciem kompletacji');
  ensure(
    !['order_split', 'order_merge'].includes(o.source),
    409,
    'Magazynu zamówienia powstałego z podziału lub łączenia nie można zmienić',
  );
  ensure(!(await wmsLotsPolicyInTx(c)).enabled, 409, 'Przy partiach WMS magazynu zamówienia nie można zmienić');
  await lockWarehouseInventoryPoliciesInTx(c, [o.warehouse_id, warehouseId], { sellable: true });
  const reasons = await blockers(c, id, LINE_BLOCKERS);
  ensure(!reasons.length, 409, 'Nie można zmienić magazynu, bo zamówienie ma ' + reasons.join(', '));
  if (await productCatalogsAvailable(c)) {
    const catalogs = (
      await c.query(
        'SELECT DISTINCT p.catalog_id FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=$1 ORDER BY 1',
        [id],
      )
    ).rows;
    for (const { catalog_id } of catalogs) {
      await resolveProductCatalogInTx(c, catalog_id);
      await assertProductCatalogWarehouseInTx(c, catalog_id, warehouseId);
    }
  }
  let moved: OrderWarehouseTransfer;
  try {
    moved = (await c.query('SELECT order_warehouse269_transfer($1,$2,$3,$4) moved', [id, warehouseId, a.userId, source])).rows[0].moved;
  } catch (e: any) {
    // The function's own refusals (P0001/P0002) carry the Polish reason; the caller's transaction (or the rule's
    // savepoint) rolls the whole move back. Anything else is not ours to rephrase.
    if (e?.code === 'P0001') throw new Problem(409, e.message);
    if (e?.code === 'P0002') throw new Problem(404, e.message);
    if (e?.code === '42501') throw new Problem(403, e.message);
    // Another move or order holding the same stock rows: nothing was written; the caller may try again.
    if (e?.code === '40P01' || e?.code === '40001') throw new Problem(409, 'Stan magazynu zmienił się w trakcie przenoszenia. Spróbuj ponownie.');
    throw e;
  }
  const detail = {
    from: moved.from_warehouse_id,
    to: moved.to_warehouse_id,
    from_name: moved.from_warehouse_name,
    to_name: moved.to_warehouse_name,
    products: moved.lines.length,
    source,
  };
  await event(c, a.tenantId, id, 'order.warehouse_changed', detail);
  await audit(c, a, 'order.warehouse_change', id, { ...detail, transfer_id: moved.transfer_id });
  return moved;
}
