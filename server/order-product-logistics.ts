import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { productLogisticsAvailable } from './product-logistics';

const component = z.strictObject({
  product_id: z.uuid(),
  quantity: z.number().int().positive().max(100000),
});
const safeNumber = (v: bigint) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null);

/** Read current physical item data against the immutable composition of an order. */
export async function orderProductLogisticsInTx(c: PoolClient, orderId: string) {
  ensure(
    (await c.query('SELECT id FROM orders WHERE id=$1', [orderId])).rowCount,
    404,
    'Nie znaleziono zamówienia',
  );
  const lines = (
    await c.query(
      'SELECT product_id,quantity,components FROM order_items WHERE order_id=$1 ORDER BY id LIMIT 101',
      [orderId],
    )
  ).rows;
  ensure(lines.length <= 100, 422, 'Zakres przekracza 100 pozycji zamówienia');
  const quantities = new Map<string, bigint>();
  for (const line of lines) {
    const parts = z.array(component).max(100).parse(line.components);
    const physical = parts.length ? parts : [{ product_id: line.product_id, quantity: 1 }];
    for (const part of physical)
      quantities.set(
        part.product_id,
        (quantities.get(part.product_id) ?? 0n) + BigInt(line.quantity) * BigInt(part.quantity),
      );
  }
  const available = await productLogisticsAvailable(c);
  // A single statement reads both the version and its logistics values consistently.
  const products = (
    await c.query(
      `SELECT p.id,p.sku,p.name,p.version,${available ? 'l.weight_grams,l.length_mm,l.width_mm,l.height_mm,l.manufacturer' : 'NULL::integer AS weight_grams,NULL::integer AS length_mm,NULL::integer AS width_mm,NULL::integer AS height_mm,NULL::text AS manufacturer'} FROM products p ${available ? 'LEFT JOIN product_logistics l ON l.tenant_id=p.tenant_id AND l.product_id=p.id' : ''} WHERE p.id=ANY($1::uuid[]) ORDER BY p.id`,
      [[...quantities.keys()]],
    )
  ).rows;
  ensure(products.length === quantities.size, 409, 'Brak danych składnika zamówienia');
  let total = 0n;
  const missing: string[] = [];
  const items = products.map((p) => {
    const quantity = quantities.get(p.id)!;
    ensure(
      safeNumber(quantity) !== null,
      422,
      'Ilość składników przekracza zakres dokładnego pomiaru',
    );
    const known = p.weight_grams === null ? null : BigInt(p.weight_grams) * quantity;
    if (known === null) missing.push(p.id);
    else total += known;
    return {
      product_id: p.id,
      sku: p.sku,
      name: p.name,
      version: p.version,
      quantity: Number(quantity),
      weight_grams: p.weight_grams,
      length_mm: p.length_mm,
      width_mm: p.width_mm,
      height_mm: p.height_mm,
      manufacturer: p.manufacturer,
      known_weight_grams: known === null ? null : safeNumber(known),
    };
  });
  const weightOverflow = safeNumber(total) === null;
  return {
    available,
    basis: 'current_catalog' as const,
    total_known_weight_grams: safeNumber(total),
    weight_overflow: weightOverflow,
    complete: available && !missing.length && !weightOverflow,
    items,
    missing_weight_product_ids: missing,
  };
}

export function registerOrderProductLogisticsRoutes(app: FastifyInstance) {
  app.get('/api/orders/:id/product-logistics', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    ensure(
      !req.apiScopes ||
        (req.apiScopes.includes('orders:read') && req.apiScopes.includes('products:read')),
      403,
      'Wymagane scopes orders:read i products:read',
    );
    const id = z.strictObject({ id: z.uuid() }).parse(req.params).id;
    return tenantTx(req.actor.tenantId, (c) => orderProductLogisticsInTx(c, id));
  });
}
