import type { PoolClient } from 'pg';
import { ensure } from './errors';

const admitted = new WeakMap<PoolClient, Set<string>>();
const stockAdmitted = new WeakMap<PoolClient, Set<string>>();

export function beginPurchasingTransaction(c: PoolClient) {
  admitted.set(c, new Set());
  stockAdmitted.set(c, new Set());
}

export function endPurchasingTransaction(c: PoolClient) {
  admitted.delete(c);
  stockAdmitted.delete(c);
}

/** Shared source scope for ordinary transactions keeps concurrent stock writes
 * possible while an exclusive plan freezes even an absent stock row. */
export async function purchasingStockAdmissionInTx(c: PoolClient, a: { tenantId: string }) {
  const scopes = stockAdmitted.get(c);
  ensure(scopes, 500, 'Zapas wymaga zarządzanej transakcji firmy');
  if (scopes.has(a.tenantId) || admitted.get(c)?.has(a.tenantId)) return;
  const scope = (await c.query("SELECT current_setting('app.tenant_id',true) tenant_id")).rows[0]
    .tenant_id;
  ensure(scope === a.tenantId, 409, 'Zakres zapasu nie odpowiada bieżącej firmie');
  const exists = (
    await c.query("SELECT to_regprocedure('public.purchasing_stock_admit()') IS NOT NULL available")
  ).rows[0].available;
  if (exists) await c.query('SELECT purchasing_stock_admit()');
  scopes.add(a.tenantId);
}

/** Acquire every source gate before any PO, supplier, product or stock row lock.
 * SQL triggers additionally protect raw writers and invalidate source epochs.
 * Legacy copies have no new gate; their existing purchasing routes still work. */
export async function purchasingSourceAdmissionInTx(c: PoolClient, a: { tenantId: string }) {
  const scopes = admitted.get(c);
  ensure(scopes, 500, 'Zakup wymaga zarządzanej transakcji firmy');
  if (scopes.has(a.tenantId)) return;
  ensure(
    !stockAdmitted.get(c)?.has(a.tenantId),
    409,
    'Silniejszą blokadę zakupów należy wybrać przed rozpoczęciem transakcji',
  );
  const scope = (await c.query("SELECT current_setting('app.tenant_id',true) tenant_id")).rows[0]
    .tenant_id;
  ensure(scope === a.tenantId, 409, 'Zakres źródeł zakupowych nie odpowiada bieżącej firmie');
  const exists = (
    await c.query(
      "SELECT to_regprocedure('public.purchasing_source_admit()') IS NOT NULL available",
    )
  ).rows[0].available;
  if (exists) await c.query('SELECT purchasing_source_admit()');
  scopes.add(a.tenantId);
}

export function assertPurchasingSourceAdmission(c: PoolClient, a: { tenantId: string }) {
  ensure(
    admitted.get(c)?.has(a.tenantId),
    409,
    'Blokadę źródeł zakupów należy uzyskać przed rozpoczęciem operacji',
  );
}
