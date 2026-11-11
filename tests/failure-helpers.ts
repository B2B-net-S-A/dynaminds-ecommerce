/** Shared helpers of the S4 failure tests (restart, duplicate, timeout, lost ACK).
 * A "process restart" is simulated in-process: the old worker is abandoned mid-call (its promise is
 * never awaited, its transport never answers until the test releases it), the lease is aged past the
 * reaper threshold, and a new tick() plays the restarted process. Shared servers are never stopped. */
import assert from 'node:assert/strict';
import net from 'node:net';
import { pool } from '../server/db';

/** DB tests run only on a disposable PG04 clone of this lane. */
export function assertS4Clone(): void {
  assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
  const u = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
  assert.equal(u.hostname, '127.0.0.1');
  assert.equal(u.port, '57084');
  assert.match(u.pathname, /^\/dynaminds_s4_20261025_[0-9]{2}$/, 'S4 clone dynaminds_s4_20261025_NN required');
}

/** The shared PG04 runs several lanes at once and every write transaction of the restored copy runs
 * whole-database guards (e.g. pim_dictionary_valid()); the pool's 8 s statement/lock timeouts then cut
 * test setup, not the behaviour under test. Raised for this test process only. */
export function relaxPoolTimeouts(seconds = 90): void {
  pool.on('connect', (c) => {
    c.query(`SET statement_timeout='${seconds}s'; SET lock_timeout='${seconds}s'`).catch(() => undefined);
  });
}

/** Parks every other queued or running job of the clone, so tick() can only claim the jobs under test
 * (the restored copy carries hundreds of pending jobs of real channels). */
export async function quiesceJobs(keep: string[] = []): Promise<void> {
  await pool.query(
    "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE state IN ('pending','running') AND NOT (id=ANY($1::uuid[]))",
    [keep],
  );
}

/** The old worker "died": its lease is older than the 2-minute reaper threshold. */
export async function ageLease(jobId: string, minutes = 3): Promise<void> {
  await pool.query("UPDATE jobs SET locked_at=now()-make_interval(mins=>$2) WHERE id=$1 AND state='running'", [jobId, minutes]);
}

export async function jobRow(jobId: string) {
  return (await pool.query('SELECT *,extract(epoch FROM run_at-now())::float AS delay FROM jobs WHERE id=$1', [jobId])).rows[0];
}

export type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** Waits until `check` is true (polling), for in-flight work of an abandoned worker. */
export async function until(check: () => boolean | Promise<boolean>, ms = 120000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    assert(Date.now() < end, 'condition not reached in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A TCP proxy in front of the local fake fiscal printer that loses the printer's answer to one
 * command: the request is forwarded, the printer acts on it, and the connection to the app is
 * dropped before the answer line arrives (the app sees OFFLINE although the printer printed). */
export async function lostAnswerProxy(targetPort: number, loseAnswerTo: (line: string) => boolean) {
  const sockets = new Set<net.Socket>();
  let lost = 0;
  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.createConnection({ host: '127.0.0.1', port: targetPort });
    sockets.add(upstream);
    let pending = '',
      dropNext = false;
    client.on('data', (d) => {
      pending += d.toString('utf8');
      for (let i = pending.indexOf('\n'); i >= 0; i = pending.indexOf('\n')) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        if (loseAnswerTo(line)) dropNext = true;
        upstream.write(line + '\n');
      }
    });
    upstream.on('data', (d) => {
      if (dropNext) {
        lost++;
        client.destroy();
        upstream.destroy();
        return;
      }
      client.write(d);
    });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    lost: () => lost,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
