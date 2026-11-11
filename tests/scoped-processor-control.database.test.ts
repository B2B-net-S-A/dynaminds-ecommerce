/** AUTO-08 on a fresh PG04 clone: in the ordinary runtime shape (no global worker, no
 * --scoped-automation) a workspace admin starts the scoped rule processor from the API used
 * by the "Nadzór workerów" panel. The start is runtime-only, audited and limited to that
 * workspace; an opted-in rule then runs for a new event; stop drains it again. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_(s3b|qd|sf4)_20261027_\d{2}$/);
let app: FastifyInstance, global: FastifyInstance, admin = '', operator = '', other = '', warehouse = '', product = '';
const call = (path: string, method: any = 'GET', payload?: any, cookie = admin, tenant = DEMO_TENANT, target = app) =>
  target.inject({ url: '/api' + path, method, payload, headers: { cookie, 'x-workspace-id': tenant } });
async function ok(path: string, method: any = 'GET', payload?: any) {
  const r = await call(path, method, payload);
  assert.ok(r.statusCode < 300, path + ': ' + r.body);
  return r.json();
}
async function login(email: string, target = app) {
  const r = await target.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie']!.toString().split(';')[0]!;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, label: string, ms = 90_000) {
  const end = Date.now() + ms;
  let v: T;
  do {
    v = await read();
    if (done(v)) return v;
    await wait(250);
  } while (Date.now() < end);
  assert.fail(label + ': ' + JSON.stringify(v!).slice(0, 2000));
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  other = await login('other@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  product = (await ok('/products', 'POST', { sku: 'SCOPED-' + randomUUID().slice(0, 8), name: 'Procesor', price: 1000, warehouse_id: warehouse, quantity: 50 })).id;
});
after(async () => {
  await ok('/operations/workers/scoped-processor/stop', 'POST', {}).catch(() => {});
  await app.close();
  await global?.close();
  await pool.end();
});
const workers = async (cookie = admin, tenant = DEMO_TENANT) => (await call('/operations/workers', 'GET', undefined, cookie, tenant)).json();
const audits = async (action: string) =>
  (await pool.query('SELECT user_id,detail FROM audit_events WHERE tenant_id=$1 AND action=$2', [DEMO_TENANT, action])).rows;

test('admin starts the scoped processor for its workspace from the panel API; the rule runs; stop drains it', async () => {
  let w = await workers();
  assert.equal(w.scoped_processor.mode, 'WORKSPACE');
  assert.equal(w.scoped_processor.running, false);
  assert.equal(w.scoped_processor.can_control, true);
  const tag = 'z-procesora-' + randomUUID().slice(0, 6);
  const rule = await ok('/automations', 'POST', { name: 'Procesor z panelu', trigger: 'order.created', actions: [{ type: 'add_tag', tag }] });
  const refused = await call('/automations/' + rule.id + '/local-worker', 'POST', { client_key: randomUUID(), version: String(rule.version), enabled: true });
  assert.equal(refused.statusCode, 409, 'stopped processor still refuses opt-in');
  assert.match(refused.json().detail, /Nadzór workerów/);

  assert.equal((await call('/operations/workers/scoped-processor/start', 'POST', {}, operator)).statusCode, 403);
  const started = await ok('/operations/workers/scoped-processor/start', 'POST', {});
  assert.equal(started.scoped_processor.running, true);
  assert.equal(started.scoped_processor.scope, 'THIS_WORKSPACE_RUNTIME_ONLY');
  assert.equal((await audits('worker.scoped_processor.start')).length, 1);
  assert.equal((await workers()).scoped_processor.running, true);
  assert.equal((await workers(other, SECOND_TENANT)).scoped_processor.running, false, 'another workspace is not started');
  assert.equal((await ok('/automations/local-effects/options')).processor_running, true);

  const enabled = await ok('/automations/' + rule.id + '/local-worker', 'POST', { client_key: randomUUID(), version: String(rule.version), enabled: true });
  assert.equal(enabled.status, 'AUTOMATIC_RULE_CONFIGURATION_ACKNOWLEDGED');
  const order = await ok('/orders', 'POST', {
    customer_name: 'QA procesor',
    email: 'scoped@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: product, quantity: 1 }],
    address: { country: 'PL', city: 'Warszawa' },
  });
  await until(() => ok('/orders/' + order.id), (o: any) => (o.tags ?? []).includes(tag), 'rule effect by the started processor');
  const status = await ok('/automations/' + rule.id + '/local-worker');
  assert.equal(status.state, 'ENABLED');
  assert.equal(status.runtime.state, 'RUNNING');

  const stopped = await ok('/operations/workers/scoped-processor/stop', 'POST', {});
  assert.equal(stopped.scoped_processor.running, false);
  assert.equal((await audits('worker.scoped_processor.stop')).length, 1);
  assert.equal((await ok('/automations/' + rule.id + '/local-worker')).state, 'PROCESSOR_STOPPED');
  const later = await ok('/orders', 'POST', {
    customer_name: 'QA procesor 2',
    email: 'scoped2@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: product, quantity: 1 }],
    address: { country: 'PL', city: 'Warszawa' },
  });
  await wait(3000);
  assert.ok(!((await ok('/orders/' + later.id)).tags ?? []).includes(tag), 'stopped processor runs nothing');
  const job = (
    await pool.query("SELECT state,attempts FROM jobs WHERE tenant_id=$1 AND kind='automation' AND payload->>'orderId'=$2", [DEMO_TENANT, later.id])
  ).rows;
  assert.deepEqual(job.map((j) => [j.state, j.attempts]), [['pending', 0]], 'the event waits unattempted for the next start');
});

test('a process with the global worker loop refuses the start', async () => {
  global = await buildApp({ backgroundWorkersEnabled: true });
  const cookie = await login('admin@demo.local', global);
  const w = (await call('/operations/workers', 'GET', undefined, cookie, DEMO_TENANT, global)).json();
  assert.equal(w.scoped_processor.mode, 'UNAVAILABLE');
  assert.equal(w.scoped_processor.can_control, false);
  const r = await call('/operations/workers/scoped-processor/start', 'POST', {}, cookie, DEMO_TENANT, global);
  assert.equal(r.statusCode, 409, r.body);
});
