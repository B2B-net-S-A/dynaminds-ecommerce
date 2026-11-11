import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { ensure } from './errors';

/** Fresh SQL authority, bound to the client and principal. Its application
 * lifetime is explicit; this object does not identify a PostgreSQL transaction. */
export type BaseWireCrmAuthority = Readonly<{ writing: boolean }>;
const proofs = new WeakMap<object, { client: PoolClient; tenant: string; user: string; key: string; writing: boolean }>();
/** Low-level issuance for an already established tenant transaction. Manual
 * callers MUST revoke in finally before their transaction callback returns.
 * Application services use withBaseWireCrmAuthority instead. */
export async function authorizeBaseWireCrmInTx(c: PoolClient, actor: Actor, writing: boolean): Promise<BaseWireCrmAuthority> {
  ensure(actor.source === 'api' && !!actor.apiKeyId, 403, 'Wymagany klucz API CRM');
  const rows = (await c.query('SELECT public.base_wire218_authority($1::uuid,$2::uuid,$3::boolean) AS role', [actor.userId, actor.apiKeyId, writing])).rows;
  ensure(rows.length === 1 && ['admin', 'operator', 'viewer'].includes(rows[0].role), 403, 'Brak aktualnego dostępu API CRM');
  if (writing) ensure(rows[0].role === 'admin', 403, 'Wymagany aktualny administrator CRM');
  const proof = Object.freeze({ writing });
  proofs.set(proof, { client: c, tenant: actor.tenantId, user: actor.userId, key: actor.apiKeyId!, writing });
  return proof;
}
/** Idempotent invalidation also makes every port retaining this proof unusable. */
export function revokeBaseWireCrmAuthority(proof: BaseWireCrmAuthority): void {
  proofs.delete(proof);
}
/** Await the entire domain callback before invalidating, and invalidate before
 * returning to the transaction runner (including a subsequent lost COMMIT ACK).
 * The optional issuer keeps closed transaction ports injectable in tests. */
export async function withBaseWireCrmAuthority<T>(
  c: PoolClient,
  actor: Actor,
  writing: boolean,
  work: (proof: BaseWireCrmAuthority) => Promise<T>,
  authorize: typeof authorizeBaseWireCrmInTx = authorizeBaseWireCrmInTx,
): Promise<T> {
  const proof = await authorize(c, actor, writing);
  try {
    return await work(proof);
  } finally {
    revokeBaseWireCrmAuthority(proof);
  }
}
export function assertBaseWireCrmAuthority(c: PoolClient, actor: Actor, proof: BaseWireCrmAuthority, writing = false) {
  const p = proofs.get(proof);
  ensure(p && p.client === c && p.tenant === actor.tenantId && p.user === actor.userId && p.key === actor.apiKeyId && actor.source === 'api' && (!writing || p.writing), 403, 'Nieprawidłowy kontekst transakcji API CRM');
}
