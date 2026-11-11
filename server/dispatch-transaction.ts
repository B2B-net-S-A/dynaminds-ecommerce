import { drainPublicConstraintsInTx } from './public-constraint-drain';
import type { PoolClient } from 'pg';
import { ensure } from './errors';

type DispatchActor = { tenantId: string; userId: string; apiKeyId?: string };
type Grant = DispatchActor & { scopes: Set<string> };
const grants = new WeakMap<PoolClient, Map<string, Grant>>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasDispatchTransactionDuty(c:PoolClient){return Boolean(grants.get(c)?.size);}
const terminalFrozen = new WeakSet<PoolClient>();

export function beginDispatchTransaction(c: PoolClient) { grants.set(c, new Map()); terminalFrozen.delete(c); }
export function endDispatchTransaction(c: PoolClient) { grants.delete(c); terminalFrozen.delete(c); }

/** The authenticated server principal, independent of whether lot accounting is enabled. */
export function enlistDispatchActorInTx<T extends DispatchActor>(
  c: PoolClient, actor: T, scopes: readonly string[] = ['orders:write'],
): T {
  const actors = grants.get(c);
  ensure(!terminalFrozen.has(c), 500, 'Nie można dodać aktora po końcowej kontroli wydania');
  ensure(actors, 500, 'Wydanie wymaga zarządzanej transakcji firmy');
  const key = JSON.stringify([actor.tenantId, actor.userId, actor.apiKeyId ?? null]);
  const prior = actors.get(key);
  actors.set(key, { ...actor, scopes: new Set([...(prior?.scopes ?? []), ...scopes]) });
  return actor;
}

/** Returns immutable requirements, never the mutable registry or its Sets. */
export function freezeDispatchActorsForCountInTx(c: PoolClient) {
  terminalFrozen.add(c);
  return Object.freeze([...(grants.get(c)?.values() ?? [])]
    .map(a => Object.freeze({ tenantId: a.tenantId, userId: a.userId, apiKeyId: a.apiKeyId,
      scopes: Object.freeze([...a.scopes]) })));
}

/** Called after hydration and other sibling finalizers; the final COUNT gate precedes COMMIT. */
export async function finalizeDispatchActorsInTx(c: PoolClient) {
  const actors = [...(grants.get(c)?.values() ?? [])];
  if (!actors.length) return;
  await drainPublicConstraintsInTx(c);
  const context = (await c.query(`SELECT current_user role,session_user owner,
    current_setting('app.tenant_id',true) tenant`)).rows[0];
  ensure(context.owner === 'postgres' && ['dyna_app', context.owner].includes(context.role),
    403, 'Nieprawidłowy kontekst wydania');
  ensure(actors.every(a => a.tenantId === context.tenant), 403, 'Zakres firmy wydania zmienił się');
  // The connection owner bridge is trusted infrastructure; it does not claim to
  // restrict arbitrary SQL submitted by the application's database principal.
  if (context.role === 'dyna_app') await c.query('RESET ROLE');
  for (const a of actors.sort((x, y) =>
    JSON.stringify([x.userId, x.apiKeyId]).localeCompare(JSON.stringify([y.userId, y.apiKeyId])),
  )) {
    const membership = (await c.query(
      'SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',
      [a.tenantId, a.userId],
    )).rows[0];
    ensure(membership && ['admin', 'operator'].includes(membership.role),
      403, 'Bieżąca rola nie pozwala wydać towaru');
    if (a.apiKeyId) {
      const key = (await c.query(`SELECT user_id,revoked_at,expires_at,scopes FROM api_keys
        WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [a.tenantId, a.apiKeyId])).rows[0];
      ensure(key && key.user_id === a.userId && !key.revoked_at,
        401, 'Klucz API został odwołany lub wygasł');
      // Evaluate the database clock after any blocking membership/key lock.
      const alive = (await c.query(
        'SELECT $1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp() alive',
        [key.expires_at],
      )).rows[0].alive;
      ensure(alive, 401, 'Klucz API został odwołany lub wygasł');
      ensure([...a.scopes].every(scope => key.scopes.includes(scope)),
        403, 'Klucz API nie ma bieżących zakresów wydania');
    }
  }
}
