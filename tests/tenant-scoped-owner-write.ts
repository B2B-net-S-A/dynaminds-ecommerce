import type { QueryResult } from 'pg';
import { pool } from '../server/db';
/** Owner-side fixture write in an explicit tenant scope. Native stock journals
 * (152_catalog_stock_control) accept a row birth only inside its own
 * app.tenant_id, so raw stock/journal fixtures declare the tenant they write. */
export async function tenantScopedOwnerQuery(
  tenant: string,
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
