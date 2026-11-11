import type { PoolClient } from 'pg';
import { ensure, Problem } from './errors';

export async function workspaceMfaAvailable(c: Pick<PoolClient, 'query'>) {
  return Boolean(
    (await c.query("SELECT to_regclass('public.workspace_security_policies') present")).rows[0]
      .present,
  );
}
export const mfaSessionJoins = 'LEFT JOIN workspace_security_policies p ON p.tenant_id=t.id';
const valid =
  "a.enabled_at IS NOT NULL AND s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at>now()-interval '8 hours'";
export const mfaSessionColumns = `,coalesce(p.require_mfa,false) AS organization_requires_mfa,
  coalesce(p.require_mfa,false) AND NOT (${valid}) AS mfa_required,
  coalesce(p.require_mfa,false) AND a.enabled_at IS NULL AS mfa_enrollment_required`;

export function requireWorkspaceMfa(user: any) {
  if (user.mfa_required)
    throw new Problem(
      403,
      'Firma wymaga MFA. Skonfiguruj lub potwierdź ochronę konta przed dostępem do danych.',
      'MFA_REQUIRED',
    );
}
export async function requiredMfaOrganizations(c: PoolClient, userId: string, lock = false) {
  if (!(await workspaceMfaAvailable(c))) return [];
  // Lock every membership's tenant, including those with no policy row yet, before a disable.
  if (lock)
    await c.query(
      `SELECT t.id FROM tenants t JOIN memberships m ON m.tenant_id=t.id
    WHERE m.user_id=$1 ORDER BY t.id FOR SHARE OF t`,
      [userId],
    );
  return (
    await c.query(
      `SELECT t.id,t.name FROM memberships m JOIN tenants t ON t.id=m.tenant_id
    JOIN workspace_security_policies p ON p.tenant_id=t.id WHERE m.user_id=$1 AND p.require_mfa ORDER BY t.name,t.id`,
      [userId],
    )
  ).rows;
}
export async function allowMfaDisable(c: PoolClient, userId: string) {
  ensure(
    !(await requiredMfaOrganizations(c, userId, true)).length,
    409,
    'MFA jest wymagane przez organizację, do której należysz. Administrator musi najpierw zmienić jej politykę.',
  );
}
