import { drainPublicConstraintsInTx } from './public-constraint-drain';
import type { PoolClient } from 'pg';
import { ensure } from './errors';
import { settleWmsEvidenceUsageInTx } from './wms-lots-limits';

/** shared: ordinary writer, shares the tenant operations fence; its stock, layer-position and
 * reservation-layer row locks (sorted) and the operation-key lock decide between writers.
 * serial: tenant-wide procedure (opening preview, stocktakes), exclusive operations lock.
 * activation: also the exclusive policy lock. read: policy fence only. */
export type WmsAdmission = 'shared' | 'serial' | 'activation' | 'read';
const admissionRank: Record<WmsAdmission, number> = { read: 0, shared: 1, serial: 2, activation: 3 };
type Principal = {
  tenantId: string;
  userId: string | null;
  apiKeyId?: string;
  source?: 'manual' | 'api' | 'system';
};
type Grant = Principal & { cost: boolean; adminOnly: boolean; orders: boolean };
const grants = new WeakMap<PoolClient, Map<string, Grant>>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasWmsTransactionDuty(c:PoolClient){return Boolean(grants.get(c)?.size);}
const admitted = new WeakMap<PoolClient, Set<string>>();
const admissionModes = new WeakMap<PoolClient, Map<string, WmsAdmission>>();
const active = new WeakMap<PoolClient, boolean>();
const terminalFrozen = new WeakSet<PoolClient>();

export function beginWmsTransaction(c: PoolClient) {
  terminalFrozen.delete(c);
  grants.set(c, new Map());
  admitted.set(c, new Set());
  admissionModes.set(c, new Map());
  active.set(c, false);
}
export function endWmsTransaction(c: PoolClient) {
  terminalFrozen.delete(c);
  grants.delete(c);
  admitted.delete(c);
  admissionModes.delete(c);
  active.delete(c);
}
export const wmsTransactionActive = (c: PoolClient) => active.get(c) === true;

/** All admissions precede the callback's owner/catalog/stock locks. */
export async function wmsLotsAdmissionInTx(
  c: PoolClient,
  a: { tenantId: string },
  mode: WmsAdmission = 'shared',
) {
  const prior = admissionModes.get(c)?.get(a.tenantId);
  if (prior) {
    ensure(
      admissionRank[prior] >= admissionRank[mode],
      409,
      'Silniejszą blokadę WMS należy wybrać przed rozpoczęciem transakcji',
    );
    return;
  }
  const exists = (await c.query("SELECT to_regclass('public.wms_policies') IS NOT NULL available"))
    .rows[0].available;
  if (!exists) {
    admitted.get(c)?.add(a.tenantId);
    admissionModes.get(c)?.set(a.tenantId, mode);
    return;
  }
  await c.query(
    `SELECT pg_advisory_xact_lock${mode === 'activation' ? '' : '_shared'}(hashtextextended($1,0))`,
    ['wms.policy:' + a.tenantId],
  );
  const enabled = Boolean(
    (await c.query('SELECT enabled FROM wms_policies WHERE tenant_id=$1', [a.tenantId])).rows[0]
      ?.enabled,
  );
  if (enabled || mode === 'activation') active.set(c, true);
  if (mode !== 'read' && (mode === 'activation' || enabled))
    await c.query(
      `SELECT pg_advisory_xact_lock${mode === 'shared' ? '_shared' : ''}(hashtextextended($1,0))`,
      ['wms.operations:' + a.tenantId],
    );
  admitted.get(c)?.add(a.tenantId);
  admissionModes.get(c)?.set(a.tenantId, mode);
}

/** Tenant-wide procedures (stocktakes) run only under the exclusive operations lock chosen at admission. */
export function assertWmsSerialAdmissionInTx(c: PoolClient, a: { tenantId: string }) {
  const mode = admissionModes.get(c)?.get(a.tenantId);
  ensure(
    mode === 'serial' || mode === 'activation',
    409,
    'Silniejszą blokadę WMS należy wybrać przed rozpoczęciem transakcji',
  );
}

/** Called only with the server's authenticated actor, never a body-supplied principal. */
export function enlistWmsActorInTx<T extends Principal>(
  c: PoolClient,
  a: T,
  options: { cost?: boolean; adminOnly?: boolean; orders?: boolean } = {},
): T {
  const actor = { ...a, source: a.source ?? (a.userId === null ? 'system' : 'manual') } as T;
  const actors = grants.get(c);
  ensure(!terminalFrozen.has(c), 500, 'Nie można dodać aktora po końcowej kontroli WMS');
  ensure(actors, 500, 'Operacja WMS wymaga zarządzanej transakcji firmy');
  ensure(
    admitted.get(c)?.has(a.tenantId),
    409,
    'Zakres firm zmienił się. Ponów operację przed blokadą zamówień i zapasu',
  );
  const key = JSON.stringify([a.tenantId, a.userId, a.apiKeyId ?? null]);
  const prior = actors.get(key);
  actors.set(key, {
    ...actor,
    cost: Boolean(prior?.cost || options.cost),
    adminOnly: Boolean(prior?.adminOnly || options.adminOnly),
    orders: Boolean(prior?.orders || options.orders),
  });
  return actor;
}

/** Immutable managed snapshot for the final COUNT gate, after sibling waits. */
export function freezeWmsActorsForCountInTx(c: PoolClient): readonly Readonly<Grant>[] {
  terminalFrozen.add(c);
  return Object.freeze((wmsTransactionActive(c) ? [...(grants.get(c)?.values() ?? [])] : [])
    .map(a => Object.freeze({ ...a })));
}

/** COMMIT gate: every writer and deferred FK has completed before grants are pinned. */
export async function finalizeWmsActorsInTx(c: PoolClient) {
  const actors = [...(grants.get(c)?.values() ?? [])];
  if (!actors.length || !wmsTransactionActive(c)) return;
  const exists = (await c.query("SELECT to_regclass('public.wms_policies') IS NOT NULL available"))
    .rows[0].available;
  if (!exists) return;
  const originalScope = (await c.query("SELECT current_setting('app.tenant_id',true) tenant_id"))
    .rows[0].tenant_id;
  for (const a of actors.sort((x, y) =>
    JSON.stringify([x.userId, x.apiKeyId]).localeCompare(JSON.stringify([y.userId, y.apiKeyId])),
  )) {
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    await drainPublicConstraintsInTx(c);
    await settleWmsEvidenceUsageInTx(c);
    // Existing trusted B2B/system callers use AuditActor without a staff user. Their
    // source-specific authorization remains in the enclosing server workflow.
    if (a.userId === null) {
      ensure(
        a.source === 'system' && !a.apiKeyId && !a.cost && !a.adminOnly,
        403,
        'Operacja kosztowa wymaga bieżącego administratora',
      );
      continue;
    }
    const role = (await c.query('SELECT wms_current_role($1,true) role', [a.userId])).rows[0].role;
    ensure(
      role === 'admin' || (!a.adminOnly && !a.cost && role === 'operator'),
      403,
      'Bieżąca rola nie pozwala zapisać operacji WMS',
    );
    if (a.apiKeyId) {
      const result = (
        await c.query('SELECT wms_key_grant($1,$2,$3) grant_result', [a.userId, a.apiKeyId, a.cost])
      ).rows[0].grant_result;
      ensure(result !== 'invalid', 401, 'Klucz API został odwołany lub wygasł');
      ensure(result === 'ok', 403, 'Klucz API nie ma bieżących zakresów WMS');
      if (a.orders) {
        const orderGrant = (
          await c.query('SELECT wms_key_order_grant($1,$2) grant_result', [a.userId, a.apiKeyId])
        ).rows[0].grant_result;
        ensure(orderGrant !== 'invalid', 401, 'Klucz API został odwołany lub wygasł');
        ensure(orderGrant === 'ok', 403, 'Klucz API nie ma bieżących zakresów zamówień WMS');
      }
    }
  }
  await c.query("SELECT set_config('app.tenant_id',$1,true)", [originalScope ?? '']);
}
