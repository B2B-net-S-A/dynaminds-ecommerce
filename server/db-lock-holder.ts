/** Session advisory locks held on a dedicated pg Client fail closed when that connection is lost.
 *
 * A job (or a request) takes `pg_advisory_lock` on its own lock client and writes through other connections
 * (tenantTx). If the lock connection dies (database restart, terminated backend, reset socket), PostgreSQL drops the
 * session lock and a second worker can take it; before db-connection-errors.ts the process crashed, after it the job
 * would have kept going unprotected. Here:
 *  - lockDbClient(client, source) watches the client like watchDbClient and also marks the lock lost on its 'error';
 *    it tracks pg_advisory_lock / pg_try_advisory_lock / pg_advisory_unlock sent on that client (acquired count);
 *  - holdingDbLock(client, fn) runs fn with the lock in its async context (AsyncLocalStorage);
 *  - assertDbLocksHeldInTx(c), called by tenantTx and the local tx runners right before COMMIT, refuses the commit
 *    when a lock of the context is marked lost or — closing the window before pg delivers the 'error' — when an
 *    acquired lock is no longer granted to the lock client's backend in pg_locks.
 * The refusal is LockConnectionLostError (Problem 503, code LOCK_CONNECTION_LOST): the transaction rolls back and the
 * job ends in its existing retryable/failed state with that cause. Nothing is retried here. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Client, ClientBase, QueryResult } from 'pg';
import { Problem } from './errors';
import { watchDbClient } from './db-connection-errors';

export class LockConnectionLostError extends Problem {
  constructor() {
    super(503, 'Utracono połączenie blokady zadania (lock_connection_lost); zmiany wycofano, zadanie zostanie ponowione', 'LOCK_CONNECTION_LOST');
  }
}

// closed: the holder called end() itself, so the protected work is over; a task it left running is not refused.
type HeldLock = { readonly client: ClientBase; readonly source: string; lost: boolean; closed: boolean; acquired: number };
const locks = new WeakMap<ClientBase, HeldLock>();
const context = new AsyncLocalStorage<readonly HeldLock[]>();

const lose = (lock: HeldLock, reason: 'connection_error' | 'not_granted'): void => {
  if (lock.lost) return;
  lock.lost = true;
  try {
    process.stderr.write(JSON.stringify({ event: 'DATABASE_LOCK_LOST', source: lock.source, reason }) + '\n');
  } catch {
    // stderr failed; the lock stays marked lost and every later commit is refused.
  }
};

const ADVISORY = /\bpg_(try_)?advisory_(un)?lock\s*\(/;
/** First column of the only row (pg_try_advisory_lock / pg_advisory_unlock answer), whatever its alias. */
const answer = (result: QueryResult): unknown => {
  const row = result?.rows?.[0];
  return row && typeof row === 'object' ? Object.values(row)[0] : undefined;
};
function track(lock: HeldLock, sql: string, result: QueryResult): void {
  const m = ADVISORY.exec(sql);
  if (!m) return;
  const tryLock = m[1] !== undefined, unlock = m[2] !== undefined;
  if (unlock) { if (answer(result) === true && lock.acquired > 0) lock.acquired--; return; }
  if (!tryLock || answer(result) === true) lock.acquired++;
}

/** A dedicated client whose session advisory locks protect work done on other connections. */
export function lockDbClient<C extends Client>(client: C, source: string): C {
  const lock: HeldLock = { client, source, lost: false, closed: false, acquired: 0 };
  locks.set(client, lock);
  watchDbClient(client, source);
  client.on('error', () => lose(lock, 'connection_error'));
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  (client as { query: unknown }).query = (...args: unknown[]) => {
    const first = args[0], sql = typeof first === 'string' ? first : (first as { text?: unknown } | null)?.text;
    const out = query(...args);
    if (typeof sql === 'string' && ADVISORY.test(sql) && out && typeof (out as Promise<QueryResult>).then === 'function')
      return (out as Promise<QueryResult>).then((result) => { track(lock, sql, result); return result; });
    return out;
  };
  const end = client.end.bind(client) as (...args: unknown[]) => unknown;
  (client as { end: unknown }).end = (...args: unknown[]) => { lock.closed = true; return end(...args); };
  return client;
}

/** Runs fn with the lock client's lock in its async context; commits inside it check the lock first. */
export function holdingDbLock<T>(client: ClientBase, fn: () => Promise<T>): Promise<T> {
  const lock = locks.get(client);
  if (!lock) throw new Error('holdingDbLock needs a client created by lockDbClient');
  return context.run([...(context.getStore() ?? []), lock], fn);
}

/** Throws LockConnectionLostError when a lock of the current context lost its connection. */
export function assertDbLocksHeld(): void {
  if ((context.getStore() ?? []).some((lock) => lock.lost && !lock.closed)) throw new LockConnectionLostError();
}

/** Before COMMIT on c: every lock of the context is still connected and every acquired one still granted. */
export async function assertDbLocksHeldInTx(c: ClientBase): Promise<void> {
  const held = context.getStore();
  if (!held?.length) return;
  assertDbLocksHeld();
  const acquired = held.filter((lock) => lock.acquired > 0 && !lock.closed);
  const pids = acquired.map((lock) => (lock.client as { processID?: unknown }).processID);
  if (!pids.length) return;
  if (!pids.every((pid) => Number.isSafeInteger(pid))) { for (const lock of acquired) lose(lock, 'not_granted'); throw new LockConnectionLostError(); }
  const granted = new Set((await c.query(
    "SELECT DISTINCT pid FROM pg_catalog.pg_locks WHERE locktype='advisory' AND granted AND pid = ANY($1::int[])", [pids])).rows.map((r) => r.pid as number));
  const missing = acquired.filter((lock, i) => !granted.has(pids[i] as number));
  if (missing.length) { for (const lock of missing) lose(lock, 'not_granted'); throw new LockConnectionLostError(); }
}
