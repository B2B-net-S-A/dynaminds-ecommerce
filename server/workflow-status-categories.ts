/** Category of a custom status (Uwagi v3 §0, migration 267, shared/order-categories.ts). Stored next to
 * workflow_statuses in workflow_status267_categories; a status without a row (or a copy without 267) reads the
 * category of its stage. */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ORDER_CATEGORIES, type OrderCategory } from '../shared/order-categories';
import { ensure } from './errors';

/** A row read back from GET carries `category: null` (no row yet); sending it back keeps what the status has. */
export const workflowCategoryInput = z.object({
  category: z
    .enum(ORDER_CATEGORIES, { error: 'Wybierz kategorię statusu' })
    .nullish()
    .transform((v) => v ?? undefined),
});

export async function workflowCategoriesAvailable(c: PoolClient): Promise<boolean> {
  return (await c.query("SELECT to_regclass('public.workflow_status267_categories') IS NOT NULL ok")).rows[0]?.ok === true;
}

/** `SELECT w.*,category FROM workflow_statuses w` (category null without a row or without 267). */
export function workflowStatusSelectSql(available: boolean): string {
  return available
    ? 'SELECT w.*,k.category FROM workflow_statuses w LEFT JOIN workflow_status267_categories k ON (k.tenant_id,k.workflow_status_id)=(w.tenant_id,w.id)'
    : 'SELECT w.*,NULL::text AS category FROM workflow_statuses w';
}

/** Stores the chosen category of a custom status; undefined keeps what it had. */
export async function setWorkflowCategoryInTx(
  c: PoolClient,
  tenantId: string,
  workflowStatusId: string,
  category: OrderCategory | undefined,
): Promise<OrderCategory | null> {
  const available = await workflowCategoriesAvailable(c);
  if (category === undefined)
    return available
      ? ((await c.query('SELECT category FROM workflow_status267_categories WHERE workflow_status_id=$1', [workflowStatusId])).rows[0]?.category ?? null)
      : null;
  ensure(available, 409, 'Kategorie statusów wymagają aktualizacji bazy danych (migracja 267)');
  await c.query(
    `INSERT INTO workflow_status267_categories(tenant_id,workflow_status_id,category) VALUES($1,$2,$3)
     ON CONFLICT (tenant_id,workflow_status_id) DO UPDATE SET category=EXCLUDED.category`,
    [tenantId, workflowStatusId, category],
  );
  return category;
}
