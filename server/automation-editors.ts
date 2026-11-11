/** "Automatyzacje: edycja" (Uwagi v3 §0, migration 267): who may create and change automation rules v2.
 * The administrator always may. An operator may with a grant row in automation267_editors; a grant on any other role
 * grants nothing (memberships keeps its CHECK, as in 266). API keys never get the right from a grant.
 * Grants are read and written by the owner connection (like memberships and accountant266_memberships). */
import type { Pool, PoolClient } from 'pg';
import { ensure } from './errors';

/** 267 is absent in a restored older copy; then only administrators edit automations. */
export async function automationEditorsAvailable(c: Pool | PoolClient): Promise<boolean> {
  return (await c.query("SELECT to_regclass('public.automation267_editors') IS NOT NULL ok")).rows[0]?.ok === true;
}

/** Extra select column `automation_editor` for a query with memberships aliased `m` (empty without 267). */
export function automationEditorColumn(available: boolean): string {
  return available
    ? ",(m.role='operator' AND EXISTS(SELECT 1 FROM automation267_editors e WHERE (e.tenant_id,e.user_id)=(m.tenant_id,m.user_id))) AS automation_editor"
    : '';
}

/** Whether the actor may create and change automation rules: an administrator, or a session operator with the grant. */
export function canEditAutomations(actor: { role: string; automationEditor?: boolean }): boolean {
  return actor.role === 'admin' || (actor.role === 'operator' && actor.automationEditor === true);
}

export function ensureAutomationEditor(actor: { role: string; automationEditor?: boolean }): void {
  ensure(canEditAutomations(actor), 403, 'Brak uprawnienia „Automatyzacje: edycja”. Nadaje je administrator w ustawieniach zespołu.');
}

/** Sets or removes the grant of an existing membership (owner connection, in the caller's transaction).
 * Only an operator can hold it: the administrator has the right anyway, a viewer cannot edit anything. */
export async function setAutomationEditorInTx(
  c: PoolClient,
  tenantId: string,
  userId: string,
  editor: boolean,
  grantedBy: string,
): Promise<void> {
  if (!editor) {
    if (await automationEditorsAvailable(c))
      await c.query('DELETE FROM automation267_editors WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId]);
    return;
  }
  ensure(await automationEditorsAvailable(c), 409, 'Uprawnienie „Automatyzacje: edycja” wymaga aktualizacji bazy danych (migracja 267)');
  const role = (await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId])).rows[0]?.role;
  ensure(role === 'operator', 422, 'Uprawnienie „Automatyzacje: edycja” można nadać tylko magazynierowi (administrator ma je zawsze)');
  await c.query(
    'INSERT INTO automation267_editors(tenant_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT (tenant_id,user_id) DO NOTHING',
    [tenantId, userId, grantedBy],
  );
}
