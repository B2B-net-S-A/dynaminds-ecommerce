import type { PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { ensure } from './errors';

export type B2bExternalCommercialSnapshot = {
  total: number;
  currency: string;
  items: Array<{
    customer_item_id: string;
    product_id: string;
    quantity: number;
    price: number;
    vat: number;
    product_version: string;
    components: Array<{ product_id: string; quantity: number }>;
  }>;
};

/** An equality condition on normal server pricing, never a price override. */
export async function assertB2bExternalCommercialSnapshotInTx(
  c: PoolClient,
  actualOrder: Record<string, any>,
  expected?: B2bExternalCommercialSnapshot,
) {
  if (!expected) return;
  const items = actualOrder.items as Array<Record<string, any>>;
  const ids = [...new Set(items.map((item) => item.product_id as string))];
  // createOrder already holds catalog and product locks. Retain the same order.
  const roots = (
    await c.query(
      'SELECT id,version::text AS version FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [ids],
    )
  ).rows;
  ensure(roots.length === ids.length, 409, 'Produkty podglądu nie są już dostępne');
  const versions = new Map(roots.map((root) => [root.id, root.version]));
  const recipe = (components: Array<{ product_id: string; quantity: number }>) =>
    components
      .map(({ product_id, quantity }) => ({ product_id, quantity }))
      .sort((a, b) => a.product_id.localeCompare(b.product_id));
  const wanted = {
    total: expected.total,
    currency: expected.currency,
    items: expected.items
      .map((item) => ({ ...item, components: recipe(item.components) }))
      .sort((a, b) => a.customer_item_id.localeCompare(b.customer_item_id)),
  };
  const actual = {
    total: actualOrder.total,
    currency: actualOrder.currency,
    items: items
      .map((item) => ({
        customer_item_id: item.id,
        product_id: item.product_id,
        quantity: item.quantity,
        price: item.price,
        vat: item.vat,
        product_version: versions.get(item.product_id),
        components: recipe(item.components),
      }))
      .sort((a, b) => a.customer_item_id.localeCompare(b.customer_item_id)),
  };
  ensure(
    isDeepStrictEqual(actual, wanted),
    409,
    'Cena, VAT, receptura lub wersja produktu zmieniły się od podglądu. Odczytaj dane i zatwierdź nowy podgląd.',
  );
}
