import type { PoolClient } from 'pg';
import { ensure } from './errors';

// The fence follows only the revision written by a local financial operation.
// A later ordinary order mutation has its own established automation policy.
export async function localFinancialFencesAvailable(c: PoolClient) {
  return Boolean(
    (await c.query("SELECT to_regclass('public.order_local_financial_fences') present")).rows[0]
      .present,
  );
}

export async function stampLocalFinancialVersion(c: PoolClient, tenantId: string, orderId: string) {
  ensure(await localFinancialFencesAvailable(c), 503, 'Brak polityki lokalnych rozliczeń');
  await c.query(
    `INSERT INTO order_local_financial_fences(tenant_id,order_id,order_version)
     SELECT tenant_id,id,version FROM orders WHERE tenant_id=$1 AND id=$2
     ON CONFLICT(tenant_id,order_id) DO UPDATE
     SET order_version=excluded.order_version,updated_at=clock_timestamp()`,
    [tenantId, orderId],
  );
}

export async function isLocalFinancialVersion(c: PoolClient, orderId: string) {
  if (!(await localFinancialFencesAvailable(c))) return false;
  return Boolean(
    (
      await c.query(
        `SELECT 1 FROM order_local_financial_fences f JOIN orders o
         ON (o.tenant_id,o.id,o.version)=(f.tenant_id,f.order_id,f.order_version)
         WHERE o.id=$1`,
        [orderId],
      )
    ).rowCount,
  );
}

// Internal SQL, always using the fixed orders alias o; never interpolates user input.
export const LOCAL_FINANCIAL_SELECTION_SQL = `AND NOT EXISTS(
  SELECT 1 FROM order_local_financial_fences f
  WHERE (f.tenant_id,f.order_id,f.order_version)=(o.tenant_id,o.id,o.version))`;
