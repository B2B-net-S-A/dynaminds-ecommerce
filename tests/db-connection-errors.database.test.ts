/** A short database outage must not end the server (dry run -68, docs/scale/LOAD-DRIVER-PROFILE-COMPLIANCE-20261029.md §8:
 * the database container restarted, ~11 s recovery, and both release CLI processes exited on an unhandled pg 'error').
 *
 * Runs on a fresh PG04 clone dynaminds_pgerr30_YYYYMMDD_NN of the restored template (migrate() in the child):
 *   DYNA_TEST=true DYNA_LOCAL_CONFIG_PATH=<pg04-test-config.json> DATABASE_URL=postgres://postgres:…@127.0.0.1:57084/dynaminds_pgerr30_…
 *   node node_modules/tsx/dist/cli.mjs --test tests/db-connection-errors.database.test.ts
 * The child (tests/db-outage-server-fixture.ts) is buildApp + the real worker with no process-level error guard; it
 * reaches PostgreSQL through a TCP relay owned by this test. One read transaction is checked out between two
 * statements and one request waits on a lock when the outage hits:
 *  - terminate: pg_terminate_backend on every session of the clone (FATAL 57P01, as in a fast shutdown);
 *  - restart: the relay resets every connection (ECONNRESET, as in -68) and refuses new ones for 11 s.
 * Either way the process stays alive, the request in flight and requests during the outage get 503 with the Polish
 * detail, the transaction fails on its own promise, /api/health counts the lost connections, new requests succeed and
 * the worker's schedulers succeed again. Nothing is written, so a rerun can use the same clone; run no other test on
 * that clone at the same time (the terminate case ends every session of it). */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import { DB_UNAVAILABLE_DETAIL } from '../server/db-connection-errors';

assert.equal(process.env.DYNA_TEST, 'true');
const url = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(url.hostname, '127.0.0.1');
assert.match(url.pathname, /^\/dynaminds_pgerr30_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_pgerr30_YYYYMMDD_NN required');
const PORT = 47330, RELAY = 47331, DOWN_MS = 11_000;
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** TCP relay 127.0.0.1:RELAY -> the clone's server; restart() resets every connection and refuses new ones for a while. */
function relay() {
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined, finished = false;
  const listen = () => new Promise<void>((ok) => {
    if (finished) return ok(); // the test already ended (a failure during the outage): stay closed
    server = net.createServer((client) => {
      const upstream = net.connect(Number(url.port), '127.0.0.1');
      sockets.add(client); sockets.add(upstream);
      const drop = () => { sockets.delete(client); sockets.delete(upstream); client.destroy(); upstream.destroy(); };
      client.on('error', drop); upstream.on('error', drop); client.on('close', drop); upstream.on('close', drop);
      client.pipe(upstream); upstream.pipe(client);
    });
    server.listen(RELAY, '127.0.0.1', ok);
  });
  const close = (): Promise<void> => new Promise<void>((ok) => { if (!server) return ok(); server.close(() => ok()); for (const s of sockets) s.resetAndDestroy(); sockets.clear(); server = undefined; });
  const finish = () => { finished = true; return close(); };
  return { listen, finish, restart: async (ms: number) => { await close(); await sleep(ms); await listen(); } };
}

function start() {
  const through = new URL(url.href);
  through.port = String(RELAY);
  const env = { ...process.env, DATABASE_URL: through.href, PORT: String(PORT), DYNA_TEST_ALLOWED_PORTS: `${RELAY},${PORT}` } as NodeJS.ProcessEnv;
  const child = spawn(process.execPath, ['--import', './tests/loopback-only-network.mjs', 'node_modules/tsx/dist/cli.mjs', 'tests/db-outage-server-fixture.ts'],
    { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout!.on('data', (b) => { out += b; });
  child.stderr!.on('data', (b) => { err += b; });
  const lines = () => out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const send = (command: string) => { child.stdin!.write(command + '\n'); };
  return { child, lines, send, stderr: () => err };
}
async function until<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > end) assert.fail('timed out waiting for ' + what);
    await sleep(100);
  }
}
const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

async function outage(t: TestContext, kind: 'terminate' | 'restart') {
  const proxy = relay();
  await proxy.listen();
  t.after(() => proxy.finish());
  const server = start();
  t.after(() => { if (alive(server.child)) server.child.kill('SIGTERM'); });
  await until('LISTENING', () => server.lines().some((l) => l.status === 'LISTENING') || (!alive(server.child) && assert.fail('child exited: ' + server.stderr().slice(-4000))), 600_000);
  const first = await fetch(base + '/api/health');
  assert.equal(first.status, 200);
  const firstBody = await first.json();

  // The test's own session goes straight to the server, past the relay.
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'pgerr30-admin' });
  await admin.connect();
  t.after(() => admin.end().catch(() => {}));
  // A transaction checked out between two statements (no pg-pool listener while checked out).
  server.send('transaction');
  await until('the open transaction', () => server.lines().some((l) => l.status === 'TRANSACTION_OPEN') || undefined, 10_000);
  // One request in flight: it waits on the lock (well inside lock_timeout 8 s) when the outage hits.
  await admin.query('BEGIN');
  await admin.query('LOCK TABLE migrations IN ACCESS EXCLUSIVE MODE');
  const inFlight = fetch(base + '/api/health').then((r) => r, (e: unknown) => e as Error);
  // pg_stat_activity is a per-transaction snapshot: clear it before each look from inside the locking transaction.
  const count = async (sql: string) => { await admin.query('SELECT pg_stat_clear_snapshot()'); return (await admin.query(sql)).rows[0].n as number; };
  await until('the request waiting on the lock', async () => (await count(
    "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT name FROM migrations%'")) > 0 || undefined, 5000);
  const sessions = await count('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()');
  assert(sessions >= 2, `${sessions} sessions (at least the waiting request and the open transaction)`);
  const outageAt = new Date().toISOString();
  const duringOutage: Response[] = [];
  if (kind === 'terminate') {
    await count('SELECT count(*)::int n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) x');
  } else {
    let up = false;
    const restarted = proxy.restart(DOWN_MS).then(() => { up = true; });
    await sleep(500);
    while (!up) {
      const r = await fetch(base + '/api/health').then((x) => x, () => undefined);
      if (!r) break; // the server is gone: reported by the alive check below
      duringOutage.push(r);
      await sleep(1000);
    }
    await restarted;
  }
  await admin.query('ROLLBACK');

  const answer = await inFlight;
  await sleep(3000); // the transaction's statement and the worker's next cycles meet dead clients too
  assert(alive(server.child), 'the server outlived the outage: ' + server.stderr().slice(-4000));
  assert(!/Unhandled 'error' event/.test(server.stderr()));
  assert(answer instanceof Response, 'the in-flight request got an answer');
  const transaction = await until('the open transaction to end', () => server.lines().find((l) => String(l.status).startsWith('TRANSACTION_') && l.status !== 'TRANSACTION_OPEN'), 15_000);
  assert.equal(transaction.status, 'TRANSACTION_FAILED', 'the transaction whose session died fails on its own promise');
  for (const refused of [answer, ...duringOutage]) {
    assert.equal(refused.status, 503);
    const problem = await refused.json();
    assert.equal(problem.detail, DB_UNAVAILABLE_DETAIL);
    assert(!/terminat|ECONN|connect/i.test(JSON.stringify(problem)), 'no PostgreSQL or socket message in the response');
  }
  if (kind === 'restart') assert(duringOutage.length >= 5, `${duringOutage.length} requests while the database was unreachable`);

  const after = await until('a successful request after the outage', async () => {
    const r = await fetch(base + '/api/health');
    return r.status === 200 ? r.json() : undefined;
  }, 60_000);
  assert.equal(firstBody.db_connection_errors, 0);
  // The counter counts connection 'error' events (at least the checked-out transaction's client); a statement in
  // flight fails on its own promise instead (the 503 above) and pg-pool ends that client without an event.
  assert(after.db_connection_errors >= 1, `health counts the lost connections (${after.db_connection_errors})`);
  assert(after.db_connection_errors_by_source.pool >= 1);
  const lines = server.stderr().split('\n').filter((l) => l.includes('DATABASE_CONNECTION_ERROR')).map((l) => JSON.parse(l));
  assert.equal(lines.length, after.db_connection_errors, 'one structured line per counted connection');
  assert(lines.every((l) => Object.keys(l).sort().join() === 'code,event,source' && l.code !== 'UNCLASSIFIED'), 'code only, classified: ' + JSON.stringify(lines));

  // The worker keeps running: its schedulers succeed again after the outage.
  await until('a worker step succeeding after the outage', async () => {
    server.send('worker');
    await sleep(500);
    const snapshot = server.lines().filter((l) => l.status === 'WORKER').at(-1);
    const names = snapshot?.steps?.filter((s: { last_success_at: string | null }) => s.last_success_at && s.last_success_at > outageAt).map((s: { name: string }) => s.name);
    return names?.length ? names : undefined;
  }, 120_000);
  assert(alive(server.child));
  return { lines, duringOutage: duringOutage.length };
}

test('pg_terminate_backend on every session: process alive, in-flight 503, new requests and the worker recover', { timeout: 900_000 }, async (t) => {
  const { lines } = await outage(t, 'terminate');
  assert(lines.some((l) => l.code === '57P01'), 'the checked-out client saw admin shutdown 57P01');
});

test('restart (connections reset, refused for 11 s): process alive, 503 during the outage, the pool reconnects', { timeout: 900_000 }, async (t) => {
  const { lines } = await outage(t, 'restart');
  assert(lines.some((l) => l.code === 'ECONNRESET'), 'the checked-out client saw the reset socket (ECONNRESET, as in -68)');
});
