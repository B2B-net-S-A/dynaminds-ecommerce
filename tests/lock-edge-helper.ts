import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';

/**
 * Bound for an injected request to reach its tenant lock. Without the startup schema gate
 * (source, dev, tests) every tenantTx first runs the schema validators in their own READ ONLY
 * transaction with a 120 s budget (server/db.ts, preflightUngatedTenantSchema); on a loaded PG04
 * that took 10–18 s per tenantTx. This is the validators' budget plus a margin, not an expected
 * duration: the wait returns as soon as the edge exists and fails at once if the request ends first.
 */
export const LOCK_EDGE_BOUND_MS = 130_000;

export type LockEdge = {
  /** Backend that must appear in pg_blocking_pids of the waiter. */
  blocker: number;
  /** The waiting statement. */
  query: RegExp;
  /** The ungranted lock is this transaction-scoped advisory key; otherwise the blocker's row lock (its xid). */
  advisoryKey?: string;
  /** Only these backends may count as the waiter. */
  among?: number[];
};
type Pending = Promise<{ statusCode: number; body: string }>;

export async function backendPid(c: PoolClient): Promise<number> {
  return Number((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);
}

/**
 * Waits until `count` distinct backends wait on exactly the given lock edge and returns their pids.
 * Every pending request must still be in flight while waiting: one that settles first failed to
 * reach the edge (for example its own 8 s lock_timeout), and that is reported with its response.
 */
export async function waitForLockEdge(
  pool: Pool,
  edge: LockEdge,
  pending: Pending[],
  count = 1,
): Promise<number[]> {
  const settled: Array<{ statusCode: number; body: string } | undefined> = pending.map(() => undefined);
  pending.forEach((p, i) =>
    p.then(
      (r) => (settled[i] = r),
      (e) => (settled[i] = { statusCode: -1, body: String(e) }),
    ),
  );
  const started = Date.now();
  while (Date.now() - started < LOCK_EDGE_BOUND_MS) {
    const rows = (
      await pool.query(
        `SELECT a.pid, a.query, pg_blocking_pids(a.pid) blockers, l.locktype,
           l.transactionid::text xid, b.backend_xid::text blocker_xid,
           l.locktype='advisory' AND ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended($2,0) advisory_match
         FROM pg_stat_activity a
         JOIN pg_locks l ON l.pid=a.pid AND NOT l.granted
         LEFT JOIN pg_stat_activity b ON b.pid=$1
         WHERE a.datname=current_database() AND a.wait_event_type='Lock'`,
        [edge.blocker, edge.advisoryKey ?? ''],
      )
    ).rows;
    const pids = new Set<number>();
    for (const r of rows) {
      const pid = Number(r.pid);
      if (edge.among && !edge.among.includes(pid)) continue;
      if (!r.blockers.map(Number).includes(edge.blocker) || !edge.query.test(r.query)) continue;
      const lock = edge.advisoryKey
        ? r.advisory_match === true
        : r.locktype === 'transactionid' && r.xid !== null && r.xid === r.blocker_xid;
      if (lock) pids.add(pid);
    }
    if (pids.size >= count) return [...pids].slice(0, count);
    const done = settled.findIndex((r) => r !== undefined);
    if (done >= 0)
      assert.fail(
        `Request ${done} settled with HTTP ${settled[done]!.statusCode} after ${Date.now() - started} ms ` +
          `before ${count} backend(s) waited on ${edge.query} behind ${edge.blocker}: ` +
          settled[done]!.body.slice(0, 300),
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No ${count} backend(s) waited on ${edge.query} behind ${edge.blocker} within ${LOCK_EDGE_BOUND_MS} ms`);
}
