/** Native product deletion command (225): refusals, active=false through the
 * native editor and the append-only product_deletions225 row in one transaction. */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { editProduct, editSchema } from './catalog';
import { productDeletionsAvailable, productDeletedInTx, productNotDeletedSQL } from './product-deletions';

export const productDeletionSchema = z.strictObject({
  version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ProductDeletionInput = z.infer<typeof productDeletionSchema>;

// Order states in which the line is still being fulfilled or returned.
const OPEN_ORDER_STATES = ['new', 'paid', 'picking', 'packed', 'return_initiated', 'return_received'];
const OPEN_PURCHASE_STATES = ['draft', 'ordered', 'partial'];
const OPEN_OFFER_PLAN_STATES = ['preview', 'queued'];
const OPEN_STOCKTAKE_STATES = ['counting', 'review'];

/** First native fact that blocks deleting the product, or null. */
async function deletionRefusalInTx(c: PoolClient, id: string): Promise<string | null> {
  const r = (
    await c.query(
      `SELECT
        EXISTS(SELECT 1 FROM stock s WHERE s.product_id=$1 AND (s.on_hand<>0 OR s.reserved<>0)) AS stock,
        EXISTS(SELECT 1 FROM reservations r WHERE r.product_id=$1 AND r.state='active') AS reservations,
        EXISTS(SELECT 1 FROM wms_layer_positions l WHERE l.product_id=$1 AND (l.quantity<>0 OR l.reserved<>0)) AS wms,
        EXISTS(SELECT 1 FROM order_items i JOIN orders o ON (o.tenant_id,o.id)=(i.tenant_id,i.order_id) WHERE i.product_id=$1 AND o.status=ANY($2::text[])) AS orders,
        EXISTS(SELECT 1 FROM purchase_order_lines pl JOIN purchase_orders po ON (po.tenant_id,po.id)=(pl.tenant_id,pl.order_id) WHERE pl.product_id=$1 AND po.state=ANY($3::text[])) AS purchases,
        EXISTS(SELECT 1 FROM products v WHERE v.parent_id=$1 AND ${productNotDeletedSQL(true, 'v')}) AS variants,
        EXISTS(SELECT 1 FROM bundle_components b JOIN products bp ON (bp.tenant_id,bp.id)=(b.tenant_id,b.bundle_id) WHERE b.product_id=$1 AND ${productNotDeletedSQL(true, 'bp')}) AS bundles,
        EXISTS(SELECT 1 FROM warehouse_document_lines dl JOIN warehouse_documents d ON (d.tenant_id,d.id)=(dl.tenant_id,dl.document_id) WHERE dl.product_id=$1 AND d.status='draft') AS documents,
        EXISTS(SELECT 1 FROM stocktake_lines sl JOIN stocktakes st ON (st.tenant_id,st.id)=(sl.tenant_id,sl.stocktake_id) WHERE sl.product_id=$1 AND st.state=ANY($5::text[]))
         OR EXISTS(SELECT 1 FROM wms_stocktake_lines wl JOIN wms_stocktakes ws ON (ws.tenant_id,ws.id)=(wl.tenant_id,wl.stocktake_id) WHERE wl.product_id=$1 AND ws.state=ANY($5::text[])) AS stocktakes,
        EXISTS(SELECT 1 FROM listings l WHERE l.product_id=$1) AS listings,
        EXISTS(SELECT 1 FROM offer_plans op WHERE op.product_id=$1 AND op.state=ANY($4::text[])) AS offer_plans`,
      [id, OPEN_ORDER_STATES, OPEN_PURCHASE_STATES, OPEN_OFFER_PLAN_STATES, OPEN_STOCKTAKE_STATES],
    )
  ).rows[0];
  if (r.stock || r.wms) return 'Produkt ma stan magazynowy lub rezerwacje. Wyzeruj stan przed usunięciem.';
  if (r.reservations) return 'Produkt ma aktywne rezerwacje zamówień.';
  if (r.orders) return 'Produkt jest w otwartych zamówieniach lub zwrotach.';
  if (r.purchases) return 'Produkt jest w otwartych zamówieniach zakupu.';
  if (r.documents) return 'Produkt jest w niezaksięgowanym dokumencie magazynowym.';
  if (r.stocktakes) return 'Produkt jest w otwartej inwentaryzacji.';
  if (r.variants) return 'Grupa ma warianty. Usuń najpierw warianty.';
  if (r.bundles) return 'Produkt jest składnikiem zestawu.';
  if (r.listings || r.offer_plans) return 'Produkt ma oferty w kanałach sprzedaży.';
  return null;
}

/** Deletes one product of the current tenant (caller checks the admin role). */
export async function deleteProductInTx(c: PoolClient, a: Actor, id: string, input: ProductDeletionInput) {
  ensure(await productDeletionsAvailable(c), 503, 'Kopia nie obsługuje usuwania produktów (migracja 225)');
  // Native lock order: exclusive catalogue lock, then the product row (editProduct re-enters both).
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${a.tenantId}`]);
  const p = (await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono produktu');
  ensure(!(await productDeletedInTx(c, id)), 409, 'Produkt został już usunięty');
  ensure(p.version === input.version, 409, 'Produkt zmieniono w innym oknie. Odśwież kartę.');
  // Stock rows of the product are locked so a concurrent stock write waits for this decision.
  await c.query('SELECT 1 FROM stock WHERE product_id=$1 ORDER BY warehouse_id FOR UPDATE', [id]);
  const refusal = await deletionRefusalInTx(c, id);
  ensure(refusal === null, 409, refusal ?? '');
  // Native editor: the same full body a PATCH /api/products/:id client sends, with active=false.
  const saved = await editProduct(
    c,
    a,
    id,
    editSchema.parse({
      name: p.name, ean: p.ean ?? '', price: p.price, vat: p.vat, category: p.category, description: p.description,
      attributes: p.attributes, images: p.images, active: false, version: p.version, components: [],
    }),
    { preserveComponents: true, deferProductRules: true },
  );
  const row = (
    await c.query(
      `INSERT INTO product_deletions225(tenant_id,product_id,actor_id,api_key_id,reason,product_version) VALUES($1,$2,$3,$4,$5,$6)
       RETURNING to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at`,
      [a.tenantId, id, a.userId, a.apiKeyId ?? null, input.reason ?? null, saved.version],
    )
  ).rows[0];
  await audit(c, a, 'product.delete', id, { sku: p.sku, version: saved.version, ...(input.reason ? { reason: input.reason } : {}) });
  return { id, sku: p.sku as string, deleted: true as const, deleted_at: row.deleted_at as string };
}
