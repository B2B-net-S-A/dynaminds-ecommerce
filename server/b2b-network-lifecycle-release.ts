/** Migration 251 (B2B-002/003/004-X/005): whether the lifecycle tables exist. A restored copy older than 251 keeps the
 * previous behaviour everywhere (no state, no overlay, no decision, no copy). Only a database read. */
import type { PoolClient } from 'pg';

type Querier = Pick<PoolClient, 'query'>;
let installed = false;
/** Once installed it never goes away, so only a negative answer is asked again. */
export async function networkLifecycleInstalled(c: Querier): Promise<boolean> {
  if (!installed)
    installed = (await c.query(`SELECT to_regclass('public.b2b258_link_states') IS NOT NULL AND to_regclass('public.b2b258_mappings') IS NOT NULL
      AND to_regclass('public.b2b258_order_decisions') IS NOT NULL AND to_regclass('public.b2b258_tracking_copies') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  return installed;
}
export const networkLifecycleSetScope = (c: Querier, tenantId: string) => c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
