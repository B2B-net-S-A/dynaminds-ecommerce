import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { ensure } from './errors';
import {
  PRODUCT_LOGISTICS_FIELDS,
  productLogisticsPatchSchema,
  unknownProductLogistics,
  type ProductLogisticsValues,
  type ProductLogisticsPatch,
} from './product-logistics-schema';
export {
  PRODUCT_LOGISTICS_FIELDS,
  productLogisticsFields,
  productLogisticsPatchSchema,
} from './product-logistics-schema';
export type { ProductLogisticsValues, ProductLogisticsPatch } from './product-logistics-schema';

export function productLogisticsRequestActor(req: any): Actor & { apiKeyId?: string } {
  const apiKeyId = req.currentUser?.api_key_id;
  ensure(
    !req.apiScopes || typeof apiKeyId === 'string',
    401,
    'Brak aktualnego kontekstu klucza API',
  );
  return { ...req.actor, ...(req.apiScopes ? { apiKeyId } : {}) };
}
export async function productLogisticsAvailable(c: PoolClient): Promise<boolean> {
  return Boolean(
    (await c.query("SELECT to_regclass('public.product_logistics') present")).rows[0].present,
  );
}
export function hasProductLogisticsWrite(input: unknown): boolean {
  return (
    !!input &&
    typeof input === 'object' &&
    PRODUCT_LOGISTICS_FIELDS.some((k) => (input as any)[k] !== undefined)
  );
}
export async function ensureProductLogisticsWriteAvailable(c: PoolClient, input: unknown) {
  if (hasProductLogisticsWrite(input))
    ensure(
      await productLogisticsAvailable(c),
      503,
      'Kopia nie zawiera profilu logistycznego produktów',
    );
}
export async function attachProductLogistics<T extends { id: string }>(
  c: PoolClient,
  products: T[],
): Promise<Array<T & ProductLogisticsValues & { product_logistics_available: boolean }>> {
  const available = await productLogisticsAvailable(c);
  const profiles =
    available && products.length
      ? (
          await c.query(
            'SELECT product_id,weight_grams,length_mm,width_mm,height_mm,manufacturer FROM product_logistics WHERE product_id=ANY($1::uuid[])',
            [products.map((p) => p.id)],
          )
        ).rows
      : [];
  const byId = new Map(profiles.map((p) => [p.product_id, p]));
  return products.map((p) => {
    const profile = byId.get(p.id);
    return {
      ...p,
      ...(Object.fromEntries(
        PRODUCT_LOGISTICS_FIELDS.map((k) => [k, profile?.[k] ?? null]),
      ) as ProductLogisticsValues),
      product_logistics_available: available,
    };
  });
}
/** Caller holds catalogue admission and the product row; there is no independent profile version. */
export async function writeProductLogisticsInTx(
  c: PoolClient,
  a: Actor & { apiKeyId?: string },
  productId: string,
  input: ProductLogisticsPatch,
): Promise<{ changed: boolean }> {
  if (!hasProductLogisticsWrite(input)) return { changed: false };
  await ensureProductLogisticsWriteAvailable(c, input);
  const patch = productLogisticsPatchSchema.parse(
    Object.fromEntries(
      PRODUCT_LOGISTICS_FIELDS.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]),
    ),
  );
  const profile = (
    await c.query(
      'SELECT weight_grams,length_mm,width_mm,height_mm,manufacturer FROM product_logistics WHERE product_id=$1 FOR UPDATE',
      [productId],
    )
  ).rows[0];
  // All product/profile waits precede membership pinning, including a profile-only edit with no enabled rules.
  const role = (await c.query('SELECT product_logistics_current_role($1) role', [a.userId])).rows[0]
    ?.role;
  ensure(role === 'admin', 403, 'Wymagany aktualny administrator profilu produktu');
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
  const before: ProductLogisticsValues = profile ?? unknownProductLogistics();
  const after = { ...before, ...patch };
  const changed = PRODUCT_LOGISTICS_FIELDS.some((k) => before[k] !== after[k]);
  if (changed)
    await c.query(
      `INSERT INTO product_logistics(tenant_id,product_id,weight_grams,length_mm,width_mm,height_mm,manufacturer)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,product_id) DO UPDATE SET
    weight_grams=excluded.weight_grams,length_mm=excluded.length_mm,width_mm=excluded.width_mm,
    height_mm=excluded.height_mm,manufacturer=excluded.manufacturer,updated_at=now()`,
      [
        a.tenantId,
        productId,
        after.weight_grams,
        after.length_mm,
        after.width_mm,
        after.height_mm,
        after.manufacturer,
      ],
    );
  return { changed };
}

export async function lockProductLogisticsInTx(c: PoolClient, ids: string[]) {
  if (await productLogisticsAvailable(c))
    await c.query(
      'SELECT product_id FROM product_logistics WHERE product_id=ANY($1::uuid[]) ORDER BY product_id FOR UPDATE',
      [ids],
    );
}
