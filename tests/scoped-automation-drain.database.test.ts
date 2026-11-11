/** Queue drain of the scoped rule processor on a fresh PG04 clone (dynaminds_qd_20261027_NN).
 * Jobs are queued through the ordinary API of a factory with the processor available but not
 * listening (as in tools/recovery/drill-app.mjs), then real loops of
 * server/scoped-automation-worker.ts drain them. Every order must end with one run, one note
 * marker and one note event; every job done with attempts=1. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { startScopedAutomationWorker } from '../server/scoped-automation-worker';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_(qd_20261027|fix29_20261029|p275_20261029|m2(?:59|6[0123])_202610(?:29|30))_\d{2}$/);
type Loop = ReturnType<typeof startScopedAutomationWorker>;
type Queued = { tenant: string; rule: string; marker: string; orders: string[] };
let app: FastifyInstance;
const cookies = new Map<string, string>(), stock = new Map<string, { warehouse: string; product: string }>();
const loops: Loop[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ok(tenant: string, path: string, method: any = 'GET', payload?: any) {
  const r = await app.inject({ url: '/api' + path, method, payload, headers: { cookie: cookies.get(tenant)!, 'x-workspace-id': tenant } });
  assert.ok(r.statusCode < 300, path + ': ' + r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ scopedAutomationEnabled: true }); // processor available, never listens: nothing is claimed here
  for (const [tenant, email] of [[DEMO_TENANT, 'admin@demo.local'], [SECOND_TENANT, 'other@demo.local']]) {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    cookies.set(tenant, r.headers['set-cookie']!.toString().split(';')[0]!);
    const warehouse = (await ok(tenant, '/warehouses')).data[0].id;
    const product = (await ok(tenant, '/products', 'POST', { sku: 'QD-' + randomUUID().slice(0, 8), name: 'Drenaż', price: 1000, warehouse_id: warehouse, quantity: 100000 })).id;
    stock.set(tenant, { warehouse, product });
  }
});
after(async () => {
  for (const l of loops) await l.close().catch(() => {});
  await app.close();
  await pool.end();
});
const start = () => {
  const l = startScopedAutomationWorker();
  loops.push(l);
  return l;
};
/** One owned rule order.created → add_note with its local worker on, then n orders = n pending `automation` jobs. */
async function queue(tenant: string, n: number): Promise<Queued> {
  const marker = 'qd-note-' + randomUUID().slice(0, 8);
  const rule = await ok(tenant, '/automations', 'POST', { name: 'Drenaż ' + marker, trigger: 'order.created', actions: [{ type: 'add_note', note: marker }] });
  await ok(tenant, '/automations/' + rule.id + '/local-worker', 'POST', { client_key: randomUUID(), version: String(rule.version), enabled: true });
  const { warehouse, product } = stock.get(tenant)!, orders: string[] = [];
  for (let k = 0; k < n; k++)
    orders.push((await ok(tenant, '/orders', 'POST', { customer_name: 'Drenaż ' + k, email: `qd-${k}@example.test`, warehouse_id: warehouse,
      address: { country: 'PL', city: 'Poznań' }, items: [{ product_id: product, quantity: 1 }] })).id);
  return { tenant, rule: rule.id, marker, orders };
}
/** A dispatch job lists every enabled rule of its trigger, and each opted-in rule of the workspace may claim
 * it, so a finished test switches its rule off before the next one counts jobs per rule. */
const retire = (q: Queued) => ok(q.tenant, '/automations/' + q.rule, 'PATCH', { enabled: false });
/** Both job kinds of the rule (dispatch `automation` per order, then its `automation.run`). */
async function jobs(q: Queued) {
  return (await pool.query(`SELECT j.id,j.kind,j.state,j.attempts::int,j.payload->>'orderId' order_id FROM jobs j
     WHERE j.tenant_id=$1 AND j.kind='automation' AND (j.payload->>'orderId')=ANY($2::text[])
    UNION ALL SELECT j.id,j.kind,j.state,j.attempts::int,r.order_id::text FROM automation_runs r JOIN jobs j ON(j.tenant_id,j.id)=(r.tenant_id,r.job_id)
     WHERE r.tenant_id=$1 AND r.rule_id=$3`, [q.tenant, q.orders, q.rule])).rows;
}
const done = async (q: Queued) => (await jobs(q)).filter((j) => j.state === 'done').length;
async function until(label: string, check: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) assert.fail(label + ' not reached in ' + ms + ' ms');
    await wait(100);
  }
}
/** Per order: runs, note markers and note events of this rule. */
async function effects(q: Queued) {
  return (await pool.query(`SELECT o.id,(length(coalesce(o.note,''))-length(replace(coalesce(o.note,''),$2,'')))/length($2) markers,
      (SELECT count(*)::int FROM order_events e WHERE e.tenant_id=o.tenant_id AND e.order_id=o.id AND e.kind='order.note_added') note_events,
      (SELECT count(*)::int FROM automation_runs r WHERE r.tenant_id=o.tenant_id AND r.rule_id=$3 AND r.order_id=o.id) runs
    FROM orders o WHERE o.tenant_id=$4 AND o.id=ANY($1::uuid[])`, [q.orders, q.marker, q.rule, q.tenant])).rows;
}
async function assertExactlyOnce(q: Queued, skip: string[] = []) {
  const js = (await jobs(q)).filter((j) => !skip.includes(j.order_id));
  assert.equal(js.length, 2 * (q.orders.length - skip.length));
  assert.deepEqual([...new Set(js.map((j) => j.state + '/' + j.attempts))], ['done/1']);
  for (const e of await effects(q))
    assert.deepEqual([Number(e.markers), e.note_events, e.runs], skip.includes(e.id) ? [0, 0, 0] : [1, 1, 1], 'order ' + e.id);
}

// Source mode runs the full schema validators in every tenantTx (server/db.ts preflightUngatedTenantSchema),
// ~10 s per order and ~25 s per job on this clone, so the queues here are small. The drain rate is measured
// in a packaged release (docs/parity/WORKERS-S3-20261025.md, "Drenaż kolejki procesora reguł").
const LONG = 900_000;

test('restart mid-drain, two processors at once and a lost lease: still exactly once, the lost lease failed with its cause', async () => {
  const q = await queue(DEMO_TENANT, 6);
  // A process claimed this dispatch and died: the lease is never reclaimed or repeated; the first pass fails it with a cause.
  const lost = q.orders[2]!;
  const r = await pool.query(`UPDATE jobs SET state='running',attempts=1,max_attempts=1,locked_at=now()-interval '1 hour',lease_token=$3
    WHERE tenant_id=$1 AND kind='automation' AND payload->>'orderId'=$2 AND state='pending' RETURNING id`, [DEMO_TENANT, lost, randomUUID()]);
  assert.equal(r.rowCount, 1);
  const first = start();
  await until('part of the queue', async () => (await done(q)) >= 3, LONG);
  await first.close(); // panel stop: drains the job in flight, claims nothing after
  const stopped = await done(q);
  assert.ok(stopped < 10, 'stopped mid-drain: ' + stopped);
  assert.equal((await jobs(q)).filter((j) => j.state === 'running' && j.order_id !== lost).length, 0, 'nothing in flight after close');
  await wait(3000);
  assert.equal(await done(q), stopped, 'nothing claimed while stopped');
  const a = start(), b = start();
  await until('rest of the queue', async () => (await done(q)) === 10, LONG);
  await wait(3000);
  await Promise.all([a.close(), b.close()]);
  assert.equal(BigInt(first.inspect().accepted) + BigInt(a.inspect().accepted) + BigInt(b.inspect().accepted), 10n, 'one claim per job across three loops');
  const held = (await jobs(q)).find((j) => j.order_id === lost)!;
  assert.deepEqual([held.state, held.attempts], ['failed', 1], 'the lost lease ends failed, not repeated');
  assert.match((await pool.query('SELECT error FROM jobs WHERE id=$1', [held.id])).rows[0].error, /^Dzierżawa wykonania automatyzacji wygasła/);
  await assertExactlyOnce(q, [lost]);
  await retire(q);
});

test("a busy rule does not starve another workspace's rule", async () => {
  const busy = await queue(DEMO_TENANT, 6), small = await queue(SECOND_TENANT, 2);
  const loop = start();
  await until('small rule drained', async () => (await done(small)) === 4, LONG);
  const busyDone = await done(busy);
  assert.ok(busyDone <= 5, 'busy rule took ' + busyDone + ' jobs while the other drained 4');
  await loop.close();
  await assertExactlyOnce(small);
  const rest = await jobs(busy);
  assert.ok(rest.every((j) => (j.state === 'done' && j.attempts === 1) || (j.state === 'pending' && j.attempts === 0)), JSON.stringify(rest));
});
