/** Stage 4 security review fixes on a disposable PG04 clone dynaminds_sf4_<YYYYMMDD>_NN (real routes and SQL):
 * - SR4-H1: two organisations from open signup; their admins cannot pause or resume the process-wide
 *   schedulers and do not see the schedulers' last errors; only an admin of the workspace named by
 *   DYNA_WORKER_OPERATOR_TENANT (unset = nobody) can. The workspace-scoped processor (AUTO-08) stays theirs;
 * - SR4-M4: the buyer view of the order timeline gives a viewer the other orders' metadata without bodies
 *   and addresses; admin/operator get the content and each such read writes one RODO access-register row;
 * - SR4-M5: the session cookie is Secure when the installation's public origin is https, not on local http. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { Problem } from '../server/errors';
import { createWorkerSupervisor, registerWorkerRuntime } from '../server/worker-supervisor';
import { seed, DEMO_TENANT } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_sf4_2026[0-9]{4}_[0-9]{2}$/);
// PG04 is shared by many lanes; preflight reads of the clone can pass 8 s. Only this test's pool waits longer.
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

let app: FastifyInstance, unregister: () => void;
let demoAdmin = '', viewer = '', operator = '';
const orgs: { cookie: string; tenant: string }[] = [];
const SECRET_ERROR = 'Zamówienie ORG-A-' + randomUUID().slice(0, 8) + ' odrzucone przez kanał';
const runtime = createWorkerSupervisor(
  [
    { name: 'jobs.tick', label: 'Kolejka zadań', run: async () => undefined },
    { name: 'orders.statuses', label: 'Statusy zamówień', run: async () => { throw new Problem(502, SECRET_ERROR); } },
  ],
  { log: () => undefined },
);
const call = (path: string, cookie: string, method: any = 'GET', payload?: any, tenant?: string) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie, ...(tenant ? { 'x-workspace-id': tenant } : {}) } });
async function login(email: string) {
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie']!.toString().split(';')[0]!;
}
async function signup(label: string) {
  const r = await app.inject({
    url: '/api/auth/signup', method: 'POST', remoteAddress: '127.0.0.' + (60 + orgs.length),
    payload: { name: 'Admin ' + label, email: `sf4-${label}-${randomUUID().slice(0, 8)}@example.test`, password: 'Stage4Signup!2026', organization: { name: 'SF4 ' + label + ' ' + randomUUID().slice(0, 6) } },
  });
  assert.equal(r.statusCode, 201, r.body);
  const cookie = r.headers['set-cookie']!.toString().split(';')[0]!;
  const ws = await call('/workspaces', cookie);
  const tenant = ws.json().active?.id ?? ws.json().data?.[0]?.id ?? ws.json().workspaces?.[0]?.id;
  assert.ok(tenant, ws.body);
  return { cookie, tenant: String(tenant) };
}
const stepOf = (v: any, name: string) => v.runtime.steps.find((s: any) => s.name === name);

before(async () => {
  await migrate();
  await seed();
  delete process.env.DYNA_WORKER_OPERATOR_TENANT;
  delete process.env.DYNA_PUBLIC_ORIGIN;
  app = await buildApp();
  unregister = registerWorkerRuntime(runtime);
  await runtime.runCycle();
  demoAdmin = await login('admin@demo.local');
  viewer = await login('viewer@demo.local');
  operator = await login('operator@demo.local');
  orgs.push(await signup('a'), await signup('b'));
});
after(async () => {
  delete process.env.DYNA_WORKER_OPERATOR_TENANT;
  delete process.env.DYNA_PUBLIC_ORIGIN;
  unregister?.();
  await app.close();
  await pool.end();
});

test('SR4-H1: a self-registered org admin cannot pause or resume the installation schedulers and sees no scheduler errors', async () => {
  const [, b] = orgs;
  const before = runtime.snapshot();
  assert.equal(before.steps.find((s) => s.name === 'orders.statuses')!.last_error?.message, SECRET_ERROR, 'the step really failed');
  for (const action of ['pause', 'resume'])
    for (const name of ['jobs.tick', 'orders.statuses']) {
      const r = await call(`/operations/workers/schedulers/${name}/${action}`, b.cookie, 'POST', {}, b.tenant);
      assert.equal(r.statusCode, 403, `${action} ${name}: ${r.body}`);
      assert.match(r.json().detail, /operator instalacji/);
    }
  assert.deepEqual(runtime.snapshot().steps.map((s) => [s.name, s.paused]), [['jobs.tick', false], ['orders.statuses', false]], 'scheduler state unchanged');
  const seen = await call('/operations/workers', b.cookie, 'GET', undefined, b.tenant);
  assert.equal(seen.statusCode, 200, seen.body);
  const v = seen.json();
  assert.equal(v.installation_operator, false);
  assert.equal(v.scheduler_control, false);
  assert.ok(!seen.body.includes(SECRET_ERROR), 'no last_error from the work of another workspace');
  assert.equal(stepOf(v, 'orders.statuses').last_error, null);
  assert.equal(stepOf(v, 'orders.statuses').state, 'backoff', 'the loop state itself stays visible');
  const audited = (await pool.query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND action LIKE 'worker.scheduler.%'", [b.tenant])).rows[0].n;
  assert.equal(audited, 0, 'a refused pause writes nothing');
});

test('SR4-H1: off by default — without DYNA_WORKER_OPERATOR_TENANT even the demo admin is refused', async () => {
  const r = await call('/operations/workers/schedulers/jobs.tick/pause', demoAdmin, 'POST', {}, DEMO_TENANT);
  assert.equal(r.statusCode, 403, r.body);
  assert.equal(runtime.snapshot().steps[0]!.paused, false);
  assert.ok(!(await call('/operations/workers', demoAdmin, 'GET', undefined, DEMO_TENANT)).body.includes(SECRET_ERROR));
});

test('SR4-H1: the installation operator workspace pauses, resumes and sees errors; other admins still refused', async () => {
  process.env.DYNA_WORKER_OPERATOR_TENANT = DEMO_TENANT;
  try {
    const [a, b] = orgs;
    assert.equal((await call('/operations/workers/schedulers/jobs.tick/pause', a.cookie, 'POST', {}, a.tenant)).statusCode, 403);
    assert.equal((await call('/operations/workers/schedulers/jobs.tick/pause', b.cookie, 'POST', {}, b.tenant)).statusCode, 403);
    assert.equal((await call('/operations/workers/schedulers/jobs.tick/pause', operator, 'POST', {}, DEMO_TENANT)).statusCode, 403, 'operator role is not admin');
    const v = (await call('/operations/workers', demoAdmin, 'GET', undefined, DEMO_TENANT)).json();
    assert.equal(v.installation_operator, true);
    assert.equal(v.scheduler_control, true);
    assert.equal(stepOf(v, 'orders.statuses').last_error.message, SECRET_ERROR);
    const paused = await call('/operations/workers/schedulers/jobs.tick/pause', demoAdmin, 'POST', {}, DEMO_TENANT);
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(paused.json().scheduler.paused, true);
    const resumed = await call('/operations/workers/schedulers/jobs.tick/resume', demoAdmin, 'POST', {}, DEMO_TENANT);
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(runtime.snapshot().steps[0]!.paused, false);
  } finally {
    delete process.env.DYNA_WORKER_OPERATOR_TENANT;
  }
});

test('SR4-H1: AUTO-08 scoped processor start/stop stays available to the org admin, for its own workspace', async () => {
  const [, b] = orgs;
  const started = await call('/operations/workers/scoped-processor/start', b.cookie, 'POST', {}, b.tenant);
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(started.json().scoped_processor.running, true);
  assert.equal(started.json().scoped_processor.scope, 'THIS_WORKSPACE_RUNTIME_ONLY');
  assert.equal((await call('/operations/workers', demoAdmin, 'GET', undefined, DEMO_TENANT)).json().scoped_processor.running, false, 'other workspace untouched');
  const stopped = await call('/operations/workers/scoped-processor/stop', b.cookie, 'POST', {}, b.tenant);
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.equal(stopped.json().scoped_processor.running, false);
});

test('SR4-M4: buyer scope — viewer gets metadata only for other orders; admin/operator content with one register row per read', async () => {
  const warehouse = (await call('/warehouses', demoAdmin)).json().data[0].id;
  const product = (await call('/products', demoAdmin, 'POST', { sku: 'SF4-' + randomUUID(), name: 'Kubek SF4', price: 4900, quantity: 100, warehouse_id: warehouse })).json().id;
  const buyer = 'sf4-buyer-' + randomUUID().slice(0, 8) + '@example.test';
  const order = async () => {
    const r = await call('/orders', demoAdmin, 'POST', {
      customer_name: 'Anna Kupująca', email: buyer, warehouse_id: warehouse,
      address: { street: 'ul. Testowa 1', city: 'Warszawa', postal_code: '00-950', country: 'PL', phone: '500100200' },
      items: [{ product_id: product, quantity: 1 }],
    });
    assert.ok(r.statusCode < 300, r.body);
    return r.json();
  };
  const A = await order(), B = await order();
  const secret = 'Mój adres to ul. Prywatna ' + randomUUID().slice(0, 6);
  const posted = await app.inject({ url: '/api/public/orders/' + B.portal_token + '/messages', method: 'POST', payload: { client_key: randomUUID(), body: secret }, remoteAddress: '127.0.0.77' });
  assert.equal(posted.statusCode, 201, posted.body);
  const register = async () =>
    (await pool.query("SELECT action,resource,order_count,detail,subject_hash FROM rodo228_access_log WHERE tenant_id=$1 AND resource LIKE 'GET /api/orders/:id/communication%' ORDER BY accessed_at", [DEMO_TENANT])).rows;
  const url = '/orders/' + A.id + '/communication?scope=customer';

  const seen = await call(url, viewer);
  assert.equal(seen.statusCode, 200, seen.body);
  const other = seen.json().data.filter((e: any) => e.order_id === B.id);
  assert.ok(other.length >= 1, 'metadata of the other order stays: ' + seen.body);
  assert.ok(!seen.body.includes(secret), 'no body of the other order for a viewer');
  for (const e of other) assert.deepEqual([e.body, e.party, e.title], [null, null, null]);
  assert.equal(seen.json().content_hidden, true);
  assert.equal((await register()).length, 0, 'metadata read writes no register row');

  for (const [cookie, n] of [[demoAdmin, 1], [operator, 2]] as const) {
    const full = await call(url, cookie);
    assert.equal(full.statusCode, 200, full.body);
    assert.ok(full.body.includes(secret), 'admin/operator read the content');
    assert.equal(full.json().content_hidden, false);
    const rows = await register();
    assert.equal(rows.length, n, 'one register row per request');
    const last = rows[n - 1];
    assert.equal(last.action, 'read');
    assert.equal(last.order_count, 2);
    assert.ok(last.subject_hash, 'the buyer is identified by the hash of the e-mail');
    assert.ok(!JSON.stringify(last).includes(buyer), 'no plain e-mail in the register');
    assert.deepEqual(new Set(last.detail.order_ids), new Set([A.id, B.id]));
  }
  await call('/orders/' + A.id + '/communication', demoAdmin);
  assert.equal((await register()).length, 2, 'the own-order view is not a buyer read');
});

test('SR4-M5: session cookie is Secure only when the public origin is https; local http keeps working', async () => {
  const cookieOf = async (email: string) => {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' }, headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString();
  };
  const local = await cookieOf('admin@demo.local');
  assert.doesNotMatch(local, /;\s*Secure/i, 'plain local http: a spoofed X-Forwarded-Proto is not trusted');
  assert.match(local, /HttpOnly/i);
  process.env.DYNA_PUBLIC_ORIGIN = 'https://sklep.example.test';
  try {
    const secure = await cookieOf('admin@demo.local');
    assert.match(secure, /;\s*Secure/i);
    assert.match(secure, /SameSite=Lax/i);
    const r = await app.inject({ url: '/api/auth/signup', method: 'POST', remoteAddress: '127.0.0.90',
      payload: { name: 'Admin c', email: `sf4-c-${randomUUID().slice(0, 8)}@example.test`, password: 'Stage4Signup!2026', organization: { name: 'SF4 c ' + randomUUID().slice(0, 6) } } });
    assert.equal(r.statusCode, 201, r.body);
    assert.match(r.headers['set-cookie']!.toString(), /;\s*Secure/i, 'signup sets the same cookie');
  } finally {
    delete process.env.DYNA_PUBLIC_ORIGIN;
  }
  process.env.DYNA_PUBLIC_ORIGIN = 'http://127.0.0.1:4100';
  try {
    assert.doesNotMatch(await cookieOf('admin@demo.local'), /;\s*Secure/i);
  } finally {
    delete process.env.DYNA_PUBLIC_ORIGIN;
  }
});
