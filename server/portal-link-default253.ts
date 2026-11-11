/** COM-PORTAL-4 (migration 245): the tenant's default validity of the buyer portal link.
 * Kept free of domain imports because order creation (server/domain.ts) reads it. */
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<PoolClient | Pool, 'query'>;

export async function portal253Available(c: Queryable): Promise<boolean> {
  return (await c.query("SELECT to_regclass('public.portal253_link_policies') IS NOT NULL ok")).rows[0]?.ok === true;
}
/** Days of validity for a new link in the current tenant transaction; null = no end date (also on a copy older than 245). */
export async function portalDefaultDaysInTx(c: Queryable): Promise<number | null> {
  if (!(await portal253Available(c))) return null;
  const row = (await c.query('SELECT default_days FROM portal253_link_policies')).rows[0];
  return row?.default_days ?? null;
}
export function portalExpiry(now: Date, days: number | null): Date | null {
  return days === null ? null : new Date(now.getTime() + days * 86400000);
}
