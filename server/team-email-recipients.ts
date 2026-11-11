/**
 * E-mail addresses of the tenant's team (admins and operators) for automation e-mails to the team (v2 notify_team).
 * users and memberships are owner-only (051: REVOKE … FROM dyna_app), so this reads on the pool, like the membership
 * re-check of queueEmail/processEmail (server/email.ts); RLS does not apply there, the tenant is explicit in the SQL.
 */
import { pool } from './db';

/** user_id → lower-cased address, only for people who are admin or operator of this tenant now. */
export async function teamEmailAddresses(tenantId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const rows = (
    await pool.query(
      "SELECT u.id,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.role IN ('admin','operator')",
      [tenantId, [...userIds]],
    )
  ).rows;
  return new Map(rows.map((r) => [String(r.id), String(r.email).trim().toLowerCase()]));
}
