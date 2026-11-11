/** Lease expiry of automation jobs (server/automations.ts expireAutomationLeases) on a fresh PG04 clone
 * (dynaminds_fix29_20261029_NN, template + real migrate()). Load-test dry run 27.10: an `automation.run` job stayed
 * `running` with its lease and a `queued` run. A real order and its real run: the expired single-attempt lease ends
 * `failed` with the cause on the job and the run; a row locked by a transaction in flight, a fresh lease and a job
 * with attempts left are untouched; the processor holding the expired lease then applies nothing. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { dispatchAutomation, expireAutomationLeases, processAutomation } from '../server/automations';
import { seed, DEMO_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_fix29_20261029_\d{2}$/);
let app: FastifyInstance, cookie = '', warehouse = '', product = '';
async function ok(path: string, method: any = 'GET', payload?: any) {
  const r = await app.inject({ url: '/api' + path, method, payload, headers: { cookie, 'x-workspace-id': DEMO_TENANT } });
  assert.ok(r.statusCode < 300, path + ': ' + r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ scopedAutomationEnabled: true }); // processor available, never listens: nothing is claimed here
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  cookie = r.headers['set-cookie']!.toString().split(';')[0]!;
  warehouse = (await ok('/warehouses')).data[0].id;
  product = (await ok('/products', 'POST', { sku: 'LE-' + randomUUID().slice(0, 8), name: 'Dzierżawa', price: 1000, warehouse_id: warehouse, quantity: 1000 })).id;
});
after(async () => {
  await app.close();
  await pool.end();
});
const job = async (id: string) => (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
/** An order of the rule, its dispatch run through the native path: returns the pending `automation.run` job and its run. */
async function runOf(rule: string, k: number) {
  const order = (await ok('/orders', 'POST', { customer_name: 'Dzierżawa ' + k, email: `le-${k}@example.test`, warehouse_id: warehouse,
    address: { country: 'PL', city: 'Poznań' }, items: [{ product_id: product, quantity: 1 }] })).id as string;
  const lease = randomUUID();
  const d = (await pool.query(`UPDATE jobs SET state='running',attempts=1,locked_at=now(),lease_token=$3 WHERE tenant_id=$1 AND kind='automation'
    AND payload->>'orderId'=$2 AND state='pending' RETURNING *`, [DEMO_TENANT, order, lease])).rows[0];
  assert.ok(d, 'dispatch job of order ' + order);
  await dispatchAutomation(d);
  assert.equal((await job(d.id)).state, 'done');
  const run = (await pool.query('SELECT * FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND order_id=$3', [DEMO_TENANT, rule, order])).rows[0];
  assert.equal(run?.state, 'queued');
  return { order, run, job: await job(run.job_id) };
}
/** As the scoped processor claims: single attempt, its lease taken `age` ago. */
const claim = async (id: string, age: string, max = 1) => (await pool.query(`UPDATE jobs SET state='running',attempts=1,max_attempts=$3,
  locked_at=now()-$2::interval,lease_token=gen_random_uuid() WHERE id=$1 RETURNING *`, [id, age, max])).rows[0];

test('an expired automation.run lease ends failed with its cause; locked, fresh and retryable jobs are untouched; no late effect', { timeout: 1_800_000 }, async () => {
  const marker = 'le-note-' + randomUUID().slice(0, 8);
  const rule = await ok('/automations', 'POST', { name: 'Dzierżawa ' + marker, trigger: 'order.created', actions: [{ type: 'add_note', note: marker }] });
  const a = await runOf(rule.id, 1), b = await runOf(rule.id, 2);
  const lost = await claim(a.job.id, '1 hour');
  await claim(b.job.id, '1 hour');
  // B is locked by a transaction in flight: skipped, not waited for.
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [b.job.id]);
    assert.deepEqual(await expireAutomationLeases([DEMO_TENANT]), { jobs: 1, runs: 1 });
    assert.equal((await job(b.job.id)).state, 'running');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  const ja = await job(a.job.id), ra = (await pool.query('SELECT * FROM automation_runs WHERE id=$1', [a.run.id])).rows[0];
  assert.deepEqual([ja.state, ja.attempts, ja.lease_token, ja.locked_at], ['failed', 1, null, null]);
  assert.match(ja.error, /^Dzierżawa wykonania automatyzacji wygasła po 5 min bez zapisanego wyniku/);
  assert.deepEqual([ra.state, ra.error], ['failed', ja.error]);
  assert.ok(ra.finished_at);
  // Another workspace's scope does not touch it; a fresh lease and a job with attempts left are not expired.
  assert.deepEqual(await expireAutomationLeases([randomUUID()]), { jobs: 0, runs: 0 });
  await claim(b.job.id, '1 minute');
  assert.deepEqual(await expireAutomationLeases([DEMO_TENANT]), { jobs: 0, runs: 0 });
  await claim(b.job.id, '1 hour', 5);
  assert.deepEqual(await expireAutomationLeases([DEMO_TENANT]), { jobs: 0, runs: 0 });
  await claim(b.job.id, '1 hour');
  assert.deepEqual(await expireAutomationLeases(null), { jobs: 1, runs: 1 });
  // The processor that still holds A's expired lease finds no running job: nothing applied, the failure stays.
  await processAutomation(lost);
  const note = (await pool.query("SELECT coalesce(note,'') note FROM orders WHERE id=$1", [a.order])).rows[0].note as string;
  assert.ok(!note.includes(marker), 'no note after expiry');
  assert.equal((await pool.query('SELECT state FROM automation_runs WHERE id=$1', [a.run.id])).rows[0].state, 'failed');
  assert.equal((await pool.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='order.note_added'", [a.order])).rows[0].n, 0);
  await ok('/automations/' + rule.id, 'PATCH', { enabled: false });
});
