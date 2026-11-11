import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { ensure } from './errors';
import { productSkuSchema } from './product-sku-schema';
export { productSkuSchema } from './product-sku-schema';

export async function productSkuAvailable(c: PoolClient): Promise<boolean> {
  return Boolean(
    (await c.query("SELECT to_regclass('public.product_sku_aliases') present")).rows[0].present,
  );
}
export async function assertProductSkuAvailable(c: PoolClient): Promise<void> {
  ensure(await productSkuAvailable(c), 503, 'Kopia nie zawiera bezpiecznej zmiany SKU');
}
export async function attachProductSkuCapability<T>(
  c: PoolClient,
  products: T[],
): Promise<Array<T & { product_sku_edit_available: boolean }>> {
  const available = await productSkuAvailable(c);
  return products.map((p) => ({ ...p, product_sku_edit_available: available }));
}
/** Exact own current or historic codes; caller holds shared/exclusive catalogue admission. */
export async function resolveProductSkus(
  c: PoolClient,
  skus: string[],
): Promise<Array<{ matched_sku: string; [key: string]: any }>> {
  if (!skus.length) return [];
  const codes = [...new Set(skus)];
  return (
    await c.query(
      (await productSkuAvailable(c))
        ? 'SELECT p.*,a.sku AS matched_sku FROM product_sku_aliases a JOIN products p ON (p.tenant_id,p.id)=(a.tenant_id,a.product_id) WHERE a.sku=ANY($1::text[]) ORDER BY a.sku,p.id'
        : 'SELECT p.*,p.sku AS matched_sku FROM products p WHERE p.sku=ANY($1::text[]) ORDER BY p.sku,p.id',
      [codes],
    )
  ).rows;
}
/** Caller has already frozen/validated and locked ALL products, before any membership/key lock. */
export async function productSkuReserveInTx(
  c: PoolClient,
  assignments: Array<{ product_id: string; sku: string }>,
) {
  if (!assignments.length) return;
  await assertProductSkuAvailable(c);
  const sorted = assignments
    .map((x) => ({ ...x, sku: productSkuSchema.parse(x.sku) }))
    .sort((a, b) =>
      a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.product_id.localeCompare(b.product_id),
    );
  for (const assignment of sorted)
    await c.query('SELECT product_sku_reserve($1,$2)', [assignment.product_id, assignment.sku]);
}
/** All product/profile/component/alias waits precede this late, server-derived authorization. */
export async function requireProductSkuAdminInTx(c: PoolClient, a: Actor & { apiKeyId?: string }) {
  const role = (await c.query('SELECT catalog_bulk_edit_current_role($1) role', [a.userId])).rows[0]
    ?.role;
  ensure(role === 'admin', 403, 'Wymagany aktualny administrator zmiany SKU');
  if (a.apiKeyId) {
    const grant = (
      await c.query('SELECT catalog_bulk_edit_key_grant($1,$2) AS grant_result', [
        a.userId,
        a.apiKeyId,
      ])
    ).rows[0]?.grant_result;
    ensure(grant !== 'invalid', 401, 'Klucz API został cofnięty lub wygasł');
    ensure(
      grant === 'ok',
      403,
      'Klucz API nie ma aktualnych scopes products:read i products:write',
    );
  }
}
