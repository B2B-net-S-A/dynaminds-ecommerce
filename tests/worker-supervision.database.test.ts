/** Real app process (server/index.ts) on a fresh PG04 clone dynaminds_s3_20261025_NN:
 * the global worker starts with the app without any manual step, a broken scheduler
 * (its table renamed on the clone) backs off while the other schedulers and the job tick
 * keep running, pause/resume works over the admin API, and both reapers follow one replay
 * rule (max_attempts is the only retry authority). Outgoing network of the child is limited
 * to PostgreSQL by tests/loopback-only-network.mjs. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pool } from '../server/db';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_(?:(s3b?|qd|sf4)_2026102[57]|m(?:25[123456789]|26[0123])_202610(?:2[89]|30))_[0-9]{2}$/);
const PORT = Number(process.env.S3_APP_PORT ?? 4193);
assert.ok(PORT !== 4100 && PORT !== 5173);
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO = '11111111-1111-4111-8111-111111111111';
const BROKEN_TABLE = 'ebay_fulfillment_configs';
let child: ChildProcess;
let stderr = '';
let admin = '',
  operator = '';
const scopedJob = randomUUID(),
  globalJob = randomUUID();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let last: T;
  do {
    last = await read();
    if (ok(last)) return last;
    await wait(250);
  } while (Date.now() < end);
  const v = last! as any;
  const brief = v?.runtime?.steps
    ? { cycles: v.runtime.cycles, steps: v.runtime.steps.map((s: any) => [s.name, s.state, s.runs, s.last_duration_ms, s.last_error?.code ?? null]) }
    : v;
  assert.fail(label + ': ' + JSON.stringify(brief).slice(0, 4000));
}
async function login(email: string) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'DynaDemo!2026' }),
  });
  assert.equal(r.status, 200, await r.text());
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
const call = (path: string, cookie: string, method = 'GET') =>
  fetch(BASE + path, {
    method,
    headers: { cookie, 'x-workspace-id': DEMO, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
const workers = async () => {
  const r = await call('/api/operations/workers', admin);
  assert.equal(r.status, 200);
  return r.json();
};
const stepOf = (v: any, name: string) => v.runtime.steps.find((s: any) => s.name === name);

before(async () => {
  assert.equal((await pool.query('SELECT to_regclass($1)::text t', ['public.' + BROKEN_TABLE])).rows[0].t, BROKEN_TABLE, 'Fresh clone required');
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE action LIKE 'worker.scheduler.%'")).rows[0].n, 0, 'Fresh clone required; no rerun');
  await pool.query(`ALTER TABLE ${BROKEN_TABLE} RENAME TO ${BROKEN_TABLE}_s3_broken`);
  // A lease of the scoped processor (max_attempts=1) and an ordinary global lease, both expired.
  await pool.query(
    `INSERT INTO jobs(id,tenant_id,kind,payload,state,attempts,max_attempts,run_at,locked_at,lease_token,dedup_key) VALUES
     ($1::uuid,$3::uuid,'automation.run','{}','running',1,1,now()-interval '10 minutes',now()-interval '10 minutes',gen_random_uuid(),'s3-scoped-'||$1::text),
     ($2::uuid,$3::uuid,'s3.unknown','{}','running',1,5,now()-interval '10 minutes',now()-interval '10 minutes',gen_random_uuid(),'s3-global-'||$2::text)`,
    [scopedJob, globalJob, DEMO],
  );
  // Pause/resume is the installation operator's (SR4-H1): the demo workspace is named as the operator here.
  const env = { ...process.env, PORT: String(PORT), DYNA_TEST_ALLOWED_PORTS: '57084', DYNA_WORKER_OPERATOR_TENANT: DEMO } as NodeJS.ProcessEnv;
  delete env.DYNA_WORKER_DISABLED;
  delete env.DYNA_TEST;
  child = spawn(process.execPath, ['--import', './tests/loopback-only-network.mjs', 'node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr!.on('data', (d) => (stderr += String(d)));
  await until(
    async () => {
      if (child.exitCode !== null) assert.fail('app exited: ' + stderr.slice(-3000));
      try {
        return (await fetch(BASE + '/api/health')).status;
      } catch {
        return 0;
      }
    },
    (s) => s === 200,
    'app did not start',
    180_000,
  );
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
  if (process.env.S3_CHILD_LOG) (await import('node:fs')).writeFileSync(process.env.S3_CHILD_LOG, stderr);
  await pool.query(`ALTER TABLE IF EXISTS ${BROKEN_TABLE}_s3_broken RENAME TO ${BROKEN_TABLE}`);
  await pool.end();
});

test('the global worker starts with the app, without any manual start', async () => {
  const health = await (await fetch(BASE + '/api/health')).json();
  assert.equal(health.background_workers_enabled, true);
  const main = (x: any) => x.runtime?.lanes.find((l: any) => l.lane === 'main');
  const v = await until(workers, (x) => x.runtime_state === 'RUNNING' && main(x)?.cycles >= 3, 'loop not cycling', 180_000);
  assert.equal(v.background_workers_enabled, true);
  assert.equal(v.runtime.steps.length, 19); // 245: + email.inbound_schedules; 251: + b2b.network.lifecycle; 252: + mirakl.operations
  assert.deepEqual(v.runtime.lanes.map((l: any) => l.lane), ['main', 'jobs']);
  assert.ok(Date.now() - Date.parse(main(v).heartbeat_at) < 30_000, 'fresh scheduler heartbeat');
  assert.ok(stepOf(v, 'jobs.tick').runs >= 1, 'job tick started by itself');
  assert.ok(Array.isArray(v.queue.kinds));
  assert.match(v.replay_rule, /max_attempts/);
});

test('a broken scheduler backs off while every other scheduler and the job tick keep running', async () => {
  const v = await until(
    workers,
    (x) => x.runtime && x.runtime.steps.every((s: any) => s.runs >= 2 || ['ebay.fulfillment', 'jobs.tick'].includes(s.name)),
    'other schedulers did not run twice',
    180_000,
  );
  const broken = stepOf(v, 'ebay.fulfillment');
  assert.equal(broken.state, 'backoff');
  assert.ok(broken.failures >= 1);
  assert.equal(broken.last_error.code, '42P01');
  assert.doesNotMatch(broken.last_error.message, /ebay_fulfillment_configs/, 'raw DB error stays in the server log');
  assert.ok(Date.parse(broken.next_run_at) > Date.parse(broken.last_finished_at), 'next run is delayed by backoff');
  for (const s of v.runtime.steps.filter((x: any) => !['ebay.fulfillment', 'jobs.tick'].includes(x.name))) {
    assert.equal(s.consecutive_failures, 0, s.name + ' ' + JSON.stringify(s.last_error));
    assert.ok(s.last_success_at, s.name);
  }
  // The tick has its own lane: it is running or finished without an error, whatever the backlog of the clone.
  const tick = stepOf(v, 'jobs.tick');
  assert.ok(['running', 'ok'].includes(tick.state), JSON.stringify(tick));
  assert.equal(tick.failures, 0);
  const log = stderr
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .find((e) => e.event === 'scheduler_failed' && e.scheduler === 'ebay.fulfillment');
  assert.ok(log, 'structured log line');
  assert.equal(log.component, 'worker');
  assert.match(log.error, /ebay_fulfillment_configs/);
  assert.ok(log.backoff_ms >= 2000);
});

test('one replay rule: the reaper replays an ordinary expired lease but never the scoped one (max_attempts=1)', async () => {
  const rows = await until(
    async () => (await pool.query('SELECT id,state,attempts FROM jobs WHERE id=ANY($1::uuid[])', [[scopedJob, globalJob]])).rows,
    (r) => r.find((x) => x.id === scopedJob)?.state === 'failed' && r.find((x) => x.id === globalJob)?.state !== 'running',
    'reaper did not run',
  );
  const scoped = rows.find((x) => x.id === scopedJob)!,
    global = rows.find((x) => x.id === globalJob)!;
  assert.deepEqual({ state: scoped.state, attempts: scoped.attempts }, { state: 'failed', attempts: 1 });
  assert.ok(global.state === 'pending' || global.attempts >= 2, JSON.stringify(global));
});

test('pause and resume per scheduler over the admin API, audited; operators are refused', async () => {
  assert.equal((await call('/api/operations/workers', operator)).status, 403);
  assert.equal((await call('/api/operations/workers/schedulers/b2b.network/pause', operator, 'POST')).status, 403);
  assert.equal((await call('/api/operations/workers/schedulers/nope.nope/pause', admin, 'POST')).status, 404);
  const paused = await call('/api/operations/workers/schedulers/b2b.network/pause', admin, 'POST');
  assert.equal(paused.status, 200, await paused.clone().text());
  assert.equal((await paused.json()).scheduler.state, 'paused');
  const at = await workers();
  const mainCycles = (x: any) => x.runtime.lanes.find((l: any) => l.lane === 'main').cycles;
  const runs = stepOf(at, 'b2b.network').runs,
    cycles = mainCycles(at);
  const later = await until(workers, (x) => mainCycles(x) >= cycles + 3, 'no cycles while paused');
  assert.equal(stepOf(later, 'b2b.network').runs, runs, 'paused scheduler did not run');
  assert.equal(stepOf(later, 'b2b.network').next_run_at, null);
  assert.ok(stepOf(later, 'offers.sync').runs > stepOf(at, 'offers.sync').runs, 'others keep running');
  assert.equal((await call('/api/operations/workers/schedulers/b2b.network/resume', admin, 'POST')).status, 200);
  await until(workers, (x) => stepOf(x, 'b2b.network').runs > runs && stepOf(x, 'b2b.network').state !== 'paused', 'not resumed');
  const audited = (
    await pool.query("SELECT action,detail->>'scheduler' s FROM audit_events WHERE action LIKE 'worker.scheduler.%' ORDER BY created_at")
  ).rows;
  assert.deepEqual(audited, [
    { action: 'worker.scheduler.pause', s: 'b2b.network' },
    { action: 'worker.scheduler.resume', s: 'b2b.network' },
  ]);
});
