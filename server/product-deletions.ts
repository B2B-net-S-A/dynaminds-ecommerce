/** Native "deleted" state of a product (migration 225, variant A).
 * Deleting keeps the products row (immutable SKU alias, order/document history)
 * and, in one transaction, sets active=false through the native editor and
 * appends a product_deletions225 row. Ordinary reads hide a deleted product with
 * productNotDeletedSQL; history (orders, documents, movements) keeps showing
 * its snapshot. Classification of every module reading products:
 * docs/parity/PRODUCT-DELETION225-20261023.md. */
import type { PoolClient } from 'pg';
import { ensure } from './errors';

export async function productDeletionsAvailable(c: PoolClient): Promise<boolean> {
  return Boolean((await c.query("SELECT to_regclass('public.product_deletions225') present")).rows[0].present);
}
/** SQL condition "the product row `alias` is not deleted"; `true` on a copy without 225. */
export function productNotDeletedSQL(available: boolean, alias = 'p'): string {
  return available
    ? `NOT EXISTS(SELECT 1 FROM product_deletions225 pd225 WHERE (pd225.tenant_id,pd225.product_id)=(${alias}.tenant_id,${alias}.id))`
    : 'true';
}
/** Same condition for a product id column (`product_id`) next to its `tenant_id`. */
export function productIdNotDeletedSQL(available: boolean, tenantColumn: string, productColumn: string): string {
  return available
    ? `NOT EXISTS(SELECT 1 FROM product_deletions225 pd225 WHERE (pd225.tenant_id,pd225.product_id)=(${tenantColumn},${productColumn}))`
    : 'true';
}
/** Current tenant's deleted product ids among `ids` (empty without 225). */
export async function deletedProductIdsInTx(c: PoolClient, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length || !(await productDeletionsAvailable(c))) return new Set();
  const rows = (await c.query('SELECT product_id FROM product_deletions225 WHERE product_id=ANY($1::uuid[])', [[...ids]])).rows;
  return new Set(rows.map((r) => r.product_id as string));
}
export async function productDeletedInTx(c: PoolClient, id: string): Promise<boolean> {
  return (await deletedProductIdsInTx(c, [id])).has(id);
}
/** Writers refuse a deleted product (409). */
export async function assertProductsNotDeletedInTx(c: PoolClient, ids: readonly string[]): Promise<void> {
  ensure((await deletedProductIdsInTx(c, ids)).size === 0, 409, 'Produkt został usunięty');
}
