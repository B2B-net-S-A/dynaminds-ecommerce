/** Lost PostgreSQL connections (database restart, pg_terminate_backend, dropped socket).
 * pg emits 'error' on a Client whose socket died; an EventEmitter 'error' without a listener is thrown
 * synchronously as an uncaught exception. pg-pool listens only while a client is idle and removes that
 * listener on checkout, so a checked-out client (a transaction between two queries, a request awaiting
 * a query) had none: in dry run -68 the database restarted and both release CLI processes exited on
 * "Unhandled 'error' event ... Emitted 'error' event on Client instance".
 *
 * Every pg Pool and dedicated Client in server/ is passed through watchDbPool / watchDbClient
 * (tests/db-connection-errors.test.ts checks the sources). The listener writes one line per lost
 * connection — source and a classified code only, because message, stack and client may carry
 * credentials — and counts it for /api/health (db_connection_errors). It does not retry anything:
 * the query or transaction in flight still rejects on its own promise (the HTTP error handler answers
 * 503 with DB_UNAVAILABLE_DETAIL), the pool drops the dead client and the next checkout connects anew. */
import type { ClientBase, Pool, PoolClient } from 'pg';

/** Admin/crash shutdown, cannot connect now, connection exception class 08, socket-level failures. */
const CONNECTION_CODES = new Set([
  '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006',
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
]);
/** Errors pg raises without a code when the socket ends or the pool cannot connect. */
const CONNECTION_MESSAGES = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'Client has encountered a connection error and is not queryable',
  'timeout exceeded when trying to connect',
]);
export const DB_UNAVAILABLE_DETAIL = 'Baza danych jest chwilowo niedostępna. Spróbuj ponownie za chwilę.';

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};
const messageOf = (error: unknown): string | undefined => {
  const message = error instanceof Error ? error.message : undefined;
  return typeof message === 'string' ? message : undefined;
};

/** True for an error caused by the database connection being lost or refused (not by the statement). */
export function isDbConnectionLoss(error: unknown): boolean {
  try {
    const code = codeOf(error), message = messageOf(error);
    return (code !== undefined && CONNECTION_CODES.has(code)) || (message !== undefined && CONNECTION_MESSAGES.has(message));
  } catch {
    return false;
  }
}

const classify = (error: unknown): string => {
  const code = codeOf(error);
  if (code !== undefined && CONNECTION_CODES.has(code)) return code;
  return isDbConnectionLoss(error) ? 'CONNECTION_TERMINATED' : 'UNCLASSIFIED';
};

let total = 0;
const bySource = new Map<string, number>();
/** One dead connection emits up to two errors (socket error, then "terminated unexpectedly"); count it once. */
const lost = new WeakSet<object>();

/** Logs and counts one lost connection. `connection` dedupes repeated errors of the same client. */
export function recordDbConnectionError(error: unknown, source: string, connection?: object): void {
  if (connection) {
    if (lost.has(connection)) return;
    lost.add(connection);
  }
  total++;
  bySource.set(source, (bySource.get(source) ?? 0) + 1);
  try {
    process.stderr.write(JSON.stringify({ event: 'DATABASE_CONNECTION_ERROR', source, code: classify(error) }) + '\n');
  } catch {
    // stderr itself failed; the counter still records the loss for /api/health.
  }
}

/** A dedicated Client (session advisory lock, owner, migration): its 'error' is logged instead of thrown. */
export function watchDbClient<C extends ClientBase>(client: C, source: string): C {
  client.on('error', (error: Error) => recordDbConnectionError(error, source, client));
  return client;
}

/** A Pool: idle-client errors (pool 'error') and errors of checked-out clients (a listener per client). */
export function watchDbPool<P extends Pool>(pool: P, source: string): P {
  pool.on('error', (error: Error, client: PoolClient) => recordDbConnectionError(error, source, client));
  pool.on('connect', (client: PoolClient) => {
    client.on('error', (error: Error) => recordDbConnectionError(error, source, client));
  });
  return pool;
}

/** Lost connections since the process started, for /api/health. */
export function dbConnectionErrors(): { total: number; by_source: Record<string, number> } {
  return { total, by_source: Object.fromEntries([...bySource].sort(([a], [b]) => a.localeCompare(b))) };
}
