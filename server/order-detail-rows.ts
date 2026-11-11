import assert from 'node:assert/strict';
import { escapeLiteral, type PoolClient, type QueryResult } from 'pg';

/** Keep the original rowsets and pg type parsers, but avoid six round trips
 * while createOrder still holds its stock locks. All reads use the same client,
 * transaction, role and RLS context. This does not move any read past COMMIT. */
export async function orderDetailRows(c: PoolClient, id: string) {
  // Simple-query batching cannot bind parameters. Use pg's SQL literal encoder
  // and an explicit UUID cast; never interpolate an unquoted request value.
  const key = `${escapeLiteral(id)}::uuid`;
  const results = await c.query(`
SELECT * FROM orders WHERE id=${key};
SELECT * FROM order_items WHERE order_id=${key} ORDER BY sku;
SELECT * FROM order_pick_items WHERE order_id=${key} ORDER BY sku;
SELECT a.*,r.state FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE a.order_id=${key} AND (NULL::uuid IS NULL OR a.product_id=NULL::uuid) ORDER BY a.product_id,a.location;
SELECT * FROM order_events WHERE order_id=${key} ORDER BY created_at,id;
SELECT * FROM shipments WHERE order_id=${key};
SELECT * FROM documents WHERE order_id=${key} ORDER BY created_at;
`) as unknown as QueryResult[];
  // pg returns an array only for multi-statement results. Refuse a changed or
  // partial client result instead of publishing an incomplete order response.
  assert(Array.isArray(results) && results.length === 7 &&
    results.every(r => r?.command === 'SELECT' && Array.isArray(r.rows)),
  'order-detail-complete-rowsets');
  const [orders, items, picking, bins, events, shipments, documents] = results;
  return { orders, items, picking, bins, events, shipments, documents };
}
