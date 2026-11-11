import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { audit, type AuditActor } from './domain';
import { Problem, ensure } from './errors';
import { assertProductsNotDeletedInTx, productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import { warehouseInventoryPoliciesAvailable } from './warehouse-inventory-policies';
import { warehousePolicyMapSQL, warehousePolicySellableQuantitySQL } from './warehouse-sellability';

export const inventoryQuery = z.object({
  warehouse_id: z.uuid().optional(),
  product_id: z.uuid().optional(),
  search: z.string().trim().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: z.string().min(1).max(300).optional(),
});
export const inventorySnapshotQuery = z.object({
  warehouse_id: z.uuid(),
  product_ids: z
    .string()
    .min(1)
    .max(7400)
    .transform((value) => z.array(z.uuid()).min(1).max(200).parse(value.split(','))),
});
export const movementQuery = inventoryQuery.extend({ kind: z.string().trim().max(50).optional() });
export function decodePage<T>(value: string | undefined, schema: z.ZodType<T>): T | null {
  if (!value) return null;
  try {
    return schema.parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch {
    throw new Problem(422, 'Nieprawidłowy kursor');
  }
}
export const encodePage = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const stockFields = 's.*,p.name,p.sku,p.ean,w.name AS warehouse_name';
function policyFields() {
  return `,s.available AS physical_available,${warehousePolicySellableQuantitySQL('w.policy', 's.available')} AS sellable_available,
    w.policy->>'usage' AS inventory_usage,(w.policy->>'enabled')::boolean AS inventory_enabled,w.policy->>'version' AS inventory_policy_version`;
}
const stockJoins =
  'FROM stock s JOIN products p ON (p.tenant_id,p.id)=(s.tenant_id,s.product_id) JOIN warehouse_policy_map w ON (w.tenant_id,w.id)=(s.tenant_id,s.warehouse_id)';
export async function listInventory(c: PoolClient, q: z.infer<typeof inventoryQuery>) {
  const policiesAvailable = await warehouseInventoryPoliciesAvailable(c);
  const deletions = await productDeletionsAvailable(c);
  const cursor = decodePage(q.after, z.tuple([z.uuid(), z.uuid()]));
  const rows = (
    await c.query(
      `${warehousePolicyMapSQL(policiesAvailable, {warehouseParam: 1})} SELECT ${stockFields}${policyFields()} ${stockJoins}
    WHERE ($1::uuid IS NULL OR s.warehouse_id=$1) AND ($2::uuid IS NULL OR s.product_id=$2) AND ${productNotDeletedSQL(deletions)}
    AND ($3='' OR p.name ILIKE $4 OR p.sku ILIKE $4 OR coalesce(p.ean,'') ILIKE $4)
    AND ($5::uuid IS NULL OR (s.warehouse_id,s.product_id)>($5::uuid,$6::uuid))
    ORDER BY s.warehouse_id,s.product_id LIMIT $7`,
      [
        q.warehouse_id ?? null,
        q.product_id ?? null,
        q.search,
        '%' + q.search + '%',
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        q.limit + 1,
      ],
    )
  ).rows;
  const more = rows.length > q.limit,
    data = rows.slice(0, q.limit),
    last = data.at(-1);
  return {
    data,
    meta: {
      has_more: more,
      cursor: more ? encodePage([last.warehouse_id, last.product_id]) : null,
    },
  };
}
export async function inventorySnapshot(c: PoolClient, q: z.infer<typeof inventorySnapshotQuery>) {
  const policiesAvailable = await warehouseInventoryPoliciesAvailable(c);
  const deletions = await productDeletionsAvailable(c);
  const ids = [...new Set(q.product_ids)];
  const data = (
    await c.query(
      `${warehousePolicyMapSQL(policiesAvailable, {warehouseParam: 1})} SELECT ${stockFields}${policyFields()} ${stockJoins} WHERE s.warehouse_id=$1 AND s.product_id=ANY($2::uuid[]) AND ${productNotDeletedSQL(deletions)} ORDER BY s.product_id`,
      [q.warehouse_id, ids],
    )
  ).rows;
  return { data, meta: { requested: ids.length, found: data.length } };
}
export async function listMovements(c: PoolClient, q: z.infer<typeof movementQuery>) {
  const cursor = decodePage(q.after, z.tuple([z.iso.datetime(), z.uuid()]));
  const rows = (
    await c.query(
      `SELECT m.*,to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,p.sku,w.name AS warehouse_name,d.number AS warehouse_document_number
    FROM stock_movements m JOIN products p ON (p.tenant_id,p.id)=(m.tenant_id,m.product_id)
    JOIN warehouses w ON (w.tenant_id,w.id)=(m.tenant_id,m.warehouse_id)
    LEFT JOIN warehouse_documents d ON (d.tenant_id,d.id)=(m.tenant_id,m.warehouse_document_id)
    WHERE ($1::uuid IS NULL OR m.warehouse_id=$1) AND ($2::uuid IS NULL OR m.product_id=$2)
    AND ($3='' OR p.sku ILIKE $4 OR p.name ILIKE $4 OR m.note ILIKE $4 OR coalesce(d.number,'') ILIKE $4)
    AND ($5::text IS NULL OR m.kind=$5)
    AND ($6::timestamptz IS NULL OR (m.created_at,m.id)<($6::timestamptz,$7::uuid))
    ORDER BY m.created_at DESC,m.id DESC LIMIT $8`,
      [
        q.warehouse_id ?? null,
        q.product_id ?? null,
        q.search,
        '%' + q.search + '%',
        q.kind ?? null,
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        q.limit + 1,
      ],
    )
  ).rows;
  const more = rows.length > q.limit,
    data = rows.slice(0, q.limit),
    last = data.at(-1);
  const after = more ? encodePage([last.cursor_time, last.id]) : null;
  for (const row of data) delete row.cursor_time;
  return { data, meta: { has_more: more, cursor: after } };
}

/** The legacy delta writer behind POST /api/inventory/adjust (also used by the
 * Base wire). The caller has already enlisted its correction duty and refused
 * active WMS / strict catalogs; this only locks, checks and writes one cell. */
export async function adjustLegacyStockInTx(
  c: PoolClient,
  a: AuditActor & { tenantId: string },
  b: { product_id: string; warehouse_id: string; delta: number; note: string },
) {
  const s = (
    await c.query('SELECT * FROM stock WHERE product_id=$1 AND warehouse_id=$2 FOR UPDATE', [
      b.product_id,
      b.warehouse_id,
    ])
  ).rows[0];
  ensure(s, 404, 'Nie znaleziono stanu');
  await assertProductsNotDeletedInTx(c, [b.product_id]);
  ensure(
    s.on_hand + b.delta >= s.reserved,
    409,
    'Korekta narusza rezerwacje lub daje ujemny stan',
  );
  await c.query('UPDATE stock SET on_hand=on_hand+$1 WHERE product_id=$2 AND warehouse_id=$3', [
    b.delta,
    b.product_id,
    b.warehouse_id,
  ]);
  await c.query(
    'INSERT INTO stock_movements(id,tenant_id,product_id,warehouse_id,delta,kind,note) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), a.tenantId, b.product_id, b.warehouse_id, b.delta, 'adjustment', b.note],
  );
  await audit(c, a, 'stock.adjust', b.product_id, { delta: b.delta, note: b.note });
}
