/** The accountant role "Księgowa" (Uwagi v3, decision of 10.11.2026; migration 266).
 * In the database an accountant is a viewer membership plus a row in accountant266_memberships, so every reader
 * and every sealed guard keeps treating them as a viewer. Only the order card's payment section and payment
 * imports (Przelewy i pobrania) accept the accountant; API keys of an accountant stay read-only.
 * Grants are read and written by the owner connection (like memberships). */
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';

export const WORKSPACE_ROLES = ['admin', 'operator', 'viewer', 'accountant'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export const workspaceRole = z.enum(WORKSPACE_ROLES);

/** The memberships.role stored for a workspace role (the accountant is a viewer membership). */
export function membershipRole(role: WorkspaceRole): 'admin' | 'operator' | 'viewer' {
  return role === 'accountant' ? 'viewer' : role;
}
/** The workspace role shown to people: a viewer membership with a grant is the accountant. */
export function displayRole(role: string, accountant: unknown): string {
  return role === 'viewer' && accountant === true ? 'accountant' : role;
}

/** 266 is absent in a restored older copy; then nobody is an accountant. */
export async function accountantAvailable(c: Pool | PoolClient): Promise<boolean> {
  return (
    await c.query("SELECT to_regclass('public.accountant266_memberships') IS NOT NULL AND to_regclass('public.accountant266_invitations') IS NOT NULL ok")
  ).rows[0]?.ok === true;
}
/** Extra select column `accountant` for a query with memberships aliased `m` (empty without 266). */
export function accountantColumn(available: boolean): string {
  return available
    ? ",(m.role='viewer' AND EXISTS(SELECT 1 FROM accountant266_memberships g WHERE (g.tenant_id,g.user_id)=(m.tenant_id,m.user_id))) AS accountant"
    : '';
}

/** Sets or removes the accountant grant of an existing membership (owner connection, in the caller's transaction). */
export async function setAccountantGrantInTx(
  c: PoolClient,
  tenantId: string,
  userId: string,
  accountant: boolean,
  grantedBy: string,
): Promise<void> {
  if (!accountant) {
    if (await accountantAvailable(c))
      await c.query('DELETE FROM accountant266_memberships WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId]);
    return;
  }
  ensure(await accountantAvailable(c), 409, 'Rola Księgowa wymaga aktualizacji bazy danych (migracja 266)');
  await c.query(
    'INSERT INTO accountant266_memberships(tenant_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT (tenant_id,user_id) DO NOTHING',
    [tenantId, userId, grantedBy],
  );
}

