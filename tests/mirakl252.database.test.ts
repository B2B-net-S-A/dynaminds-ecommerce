/** Migration 252_mirakl_operations (integration track L4 Mirakl; prepared as 262) on a fresh disposable clone
 * dynaminds_m252_YYYYMMDD_NN of the restored template; the real migrate() applies 252 and its ledger row. Mirakl is the local stateful fake
 * (server/mirakl262-fake.ts) behind the existing channel reader with its shared A01/OR11/OF21 budget; the budget
 * repository is the in-process simulation one, its clock is the test clock. No network, no operator account.
 * orders.schedule: durable checkpoint, pages, shared OR11 budget deferral, stop on revoked admin.
 * offers.write / fulfillment.write: outbox, idempotent replay, refusals, lost ACK reconciled by readback.
 * webhooks.receive: secret path token, idempotent event id, rate limit, tenant isolation. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed } from './fixtures';
import { createMiraklFake, MIRAKL262_FAKE_KEY, MIRAKL262_FAKE_ORIGIN, type MiraklFake } from '../server/mirakl262-fake';
import { configureMirakl262Runtime, createMirakl262SimulatedReadRepository, processMirakl262Job, failMirakl262Job, sweepMirakl262Due } from '../server/mirakl262';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:25[23456789]|26[0123])_202610(?:28|29|30)_[0-9]{2}$/, 'fresh clone dynaminds_m252_YYYYMMDD_NN (or m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 253/254/255/256/257/258/259/260/261/262) of the restored template');
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

let app: any, admin = '', viewer = '', other = '', warehouse = '';
let clock = Date.parse('2026-10-28T09:00:00Z');
const now = () => clock;
let fake: MiraklFake;
let ip = 1;
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({ url: path, method, payload, headers: { cookie }, remoteAddress: '127.0.62.' + ((ip++ % 250) + 1) });
async function api(path: string, method: any = 'GET', body?: any, cookie = admin) {
  const r = await req(path, method, body, cookie);
  assert(r.statusCode < 300, method + ' ' + path + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
const loginAs = async (email: string) => {
  const r = await req('/api/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie'].toString().split(';')[0];
};
function freshRuntime(o: { writes?: boolean; pageSize?: number; importReadsUntilComplete?: number; offerReplayDelaySeconds?: number } = {}) {
  fake = createMiraklFake({ now, importReadsUntilComplete: o.importReadsUntilComplete });
  configureMirakl262Runtime({ transport: fake.transport, readRepository: createMirakl262SimulatedReadRepository(), writes: o.writes ?? true, simulation: true, now, pageSize: o.pageSize ?? 50, timeoutMs: 200, offerReplayDelaySeconds: o.offerReplayDelaySeconds ?? 900 });
}
before(async () => {
  await migrate();
  assert.equal((await pool.query("SELECT count(*)::int n FROM migrations WHERE name='252_mirakl_operations'")).rows[0].n, 1, 'migrate() applied 252');
  assert.equal((await pool.query("SELECT to_regclass('public.mirakl262_operations') IS NOT NULL ok")).rows[0].ok, true, '252 tables present');
  await seed();
  app = await buildApp();
  admin = await loginAs('admin@demo.local');
  viewer = await loginAs('viewer@demo.local');
  other = await loginAs('other@demo.local');
  warehouse = (await api('/api/warehouses')).data[0].id;
});
after(async () => {
  await app?.close();
  await pool.end();
});

const channel = async (cookie = admin) => (await api('/api/integrations', 'POST', { provider: 'mirakl', name: 'Mirakl 262 ' + randomUUID().slice(0, 6), mode: 'live',
  credentials: { api_key: MIRAKL262_FAKE_KEY }, settings: { instance_url: MIRAKL262_FAKE_ORIGIN, shop_id: '2000', currency: 'PLN' } }, cookie)).id;
const base = (ch: string) => '/api/integrations/' + ch + '/mirakl262';
async function claim(jobId: string) {
  const j = (await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 AND state='pending' RETURNING *", [jobId, randomUUID()])).rows[0];
  assert(j, 'job ' + jobId + ' is pending');
  return j;
}
async function runJob(jobId: string) {
  const j = await claim(jobId);
  try { return await processMirakl262Job(j); } catch (e) { await failMirakl262Job(j, e); throw e; }
}
const schedule = async (ch: string) => (await pool.query('SELECT * FROM mirakl262_schedules WHERE channel_id=$1', [ch])).rows[0];
const op = async (id: string) => (await pool.query('SELECT * FROM mirakl262_operations WHERE id=$1', [id])).rows[0];
const jobOf = async (id: string) => (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
const staged = async (ch: string) => (await pool.query('SELECT external_id,state FROM inbound_orders WHERE channel_id=$1 ORDER BY external_id', [ch])).rows;
async function scheduledRun(ch: string) {
  await sweepMirakl262Due();
  const s = await schedule(ch);
  assert.equal(s.state, 'queued', JSON.stringify(s));
  return s.job_id as string;
}
/** A channel whose schedule already staged the fake's orders (one WAITING_ACCEPTANCE, one SHIPPING). */
async function stagedChannel() {
  const ch = await channel();
  fake.addOrder({ order_id: 'MO-A-' + ch.slice(0, 8), state: 'WAITING_ACCEPTANCE', lines: [{ sku: 'S-A', quantity: 1, price: 19.99 }] });
  fake.addOrder({ order_id: 'MO-S-' + ch.slice(0, 8), state: 'SHIPPING', lines: [{ sku: 'S-B', quantity: 2, price: 5 }] });
  clock += 60_000;
  await api(base(ch) + '/schedule', 'PUT', { enabled: true, interval_minutes: 15, start_from: new Date(clock - 3600_000).toISOString() });
  const r = await runJob(await scheduledRun(ch));
  assert.equal(r.status, 'complete', JSON.stringify(r));
  clock += 15 * 60_000 + 1000; // the shared OR11 budget of the instance
  return { ch, accept: 'MO-A-' + ch.slice(0, 8), ship: 'MO-S-' + ch.slice(0, 8) };
}

// ---- orders.schedule ---------------------------------------------------------------------------------------
test('orders.schedule: refusals, then one sweep stages the window into the import queue and plans the next run', async () => {
  freshRuntime();
  const ch = await channel();
  assert.equal((await req(base(ch) + '/schedule', 'PUT', { enabled: true, interval_minutes: 15 }, viewer)).statusCode, 403, 'viewer');
  assert.equal((await req(base(ch) + '/schedule', 'PUT', { enabled: true, interval_minutes: 15 }, other)).statusCode, 404, 'another company');
  assert.equal((await req(base(ch) + '/schedule', 'PUT', { enabled: true, interval_minutes: 5 })).statusCode, 422, 'interval below the OR11 budget');
  assert.equal((await req(base(randomUUID()) + '/schedule', 'PUT', { enabled: true, interval_minutes: 15 })).statusCode, 404);
  fake.addOrder({ order_id: 'MO-1', lines: [{ sku: 'SKU-1', quantity: 1, price: 10 }] });
  fake.addOrder({ order_id: 'MO-2', state: 'WAITING_ACCEPTANCE', lines: [{ sku: 'SKU-2', quantity: 3, price: 2.5 }] });
  clock += 60_000;
  const saved = await api(base(ch) + '/schedule', 'PUT', { enabled: true, interval_minutes: 30, start_from: new Date(clock - 7200_000).toISOString() });
  assert.equal(saved.schedule.enabled, true);
  assert.equal((await req(base(ch) + '/schedule', 'PUT', { enabled: true, interval_minutes: 30, version: saved.schedule.version + 3 })).statusCode, 409, 'stale version');
  const jobId = await scheduledRun(ch);
  await sweepMirakl262Due();
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='mirakl262.orders' AND payload->>'channel_id'=$1", [ch])).rows[0].n, 1, 'one job per window');
  assert.deepEqual(await runJob(jobId), { status: 'complete', staged: 2 });
  assert.deepEqual((await staged(ch)).map((r: any) => r.external_id), ['MO-1', 'MO-2']);
  const s = await schedule(ch);
  assert.equal(s.state, 'idle');
  assert.equal(s.checkpoint, null);
  assert.equal(s.staged, 2);
  assert.equal(new Date(s.watermark).getTime(), clock);
  assert.equal(new Date(s.window_start).getTime(), clock);
  assert(new Date(s.next_run_at).getTime() > Date.now() + 25 * 60_000, 'next run after the interval');
  assert.equal((await jobOf(jobId)).state, 'done');
  await sweepMirakl262Due();
  assert.equal((await schedule(ch)).state, 'idle', 'not due yet');
  const view = await api(base(ch));
  assert.equal(view.schedule.staged, 2);
  assert.equal((await req(base(ch), 'GET', undefined, other)).statusCode, 404, 'tenant isolation of the view');
});

test('orders.schedule: pages keep a durable checkpoint; the shared OR11 budget defers the next page, a revoked admin stops it', async () => {
  freshRuntime({ pageSize: 1 });
  const ch = await channel();
  fake.addOrder({ order_id: 'P-1', lines: [{ sku: 'A', quantity: 1, price: 1 }] });
  fake.addOrder({ order_id: 'P-2', lines: [{ sku: 'B', quantity: 1, price: 2 }] });
  clock += 60_000;
  await api(base(ch) + '/schedule', 'PUT', { enabled: true, interval_minutes: 15, start_from: new Date(clock - 600_000).toISOString() });
  const jobId = await scheduledRun(ch);
  assert.deepEqual(await runJob(jobId), { status: 'page_committed', staged: 1 });
  let s = await schedule(ch);
  assert.equal(s.checkpoint.offset, 1);
  assert.equal(s.checkpoint.revision, 1);
  assert.equal((await jobOf(jobId)).state, 'pending', 'the same job continues');
  const r = await runJob(jobId);
  assert.equal(r.status, 'deferred', 'OR11 budget of the instance (15 min) not yet free');
  s = await schedule(ch);
  assert.equal(s.state, 'deferred');
  assert.equal(s.checkpoint.offset, 1, 'checkpoint kept');
  assert.equal((await staged(ch)).length, 1);
  clock += 15 * 60_000 + 1000;
  assert.deepEqual(await runJob(jobId), { status: 'complete', staged: 1 });
  assert.deepEqual((await staged(ch)).map((x: any) => x.external_id), ['P-1', 'P-2']);
  // A new window started by an administrator who later lost the role stages nothing.
  fake.addOrder({ order_id: 'P-3', lines: [{ sku: 'C', quantity: 1, price: 3 }] });
  clock += 15 * 60_000 + 1000;
  const viewerId = (await pool.query("SELECT id FROM users WHERE email='viewer@demo.local'")).rows[0].id;
  await pool.query("UPDATE mirakl262_schedules SET actor_id=$2,next_run_at=now() WHERE channel_id=$1", [ch, viewerId]);
  const again = await scheduledRun(ch);
  assert.equal((await runJob(again)).status, 'stopped');
  s = await schedule(ch);
  assert.equal(s.state, 'failed');
  assert.match(s.reason, /administrator/i);
  assert.equal((await staged(ch)).length, 2, 'nothing staged after the revocation');
  // Saving the schedule again (current admin) resumes it.
  const resumed = await api(base(ch) + '/schedule', 'PUT', { enabled: true, interval_minutes: 15, version: s.version });
  assert.equal(resumed.schedule.state, 'idle');
});

// ---- offers.write ------------------------------------------------------------------------------------------
const product = async (sku: string, price: number, quantity: number) =>
  api('/api/products', 'POST', { sku, name: 'Mirakl ' + sku, price, vat: 23, warehouse_id: warehouse, quantity });

test('offers.write: OF24 from local price and stock, OF02/OF03 readback, idempotent replay and refusals', async () => {
  freshRuntime();
  const ch = await channel();
  const a = await product('M262-' + randomUUID().slice(0, 8), 12345, 7);
  const b = await product('M262-' + randomUUID().slice(0, 8), 500, 0);
  fake.addOffer({ shop_sku: a.sku, price: 1, quantity: 0 });
  const body = { client_key: randomUUID(), product_ids: [a.id, b.id] };
  assert.equal((await req(base(ch) + '/offers', 'POST', body, viewer)).statusCode, 403);
  assert.equal((await req(base(ch) + '/offers', 'POST', body, other)).statusCode, 404);
  assert.equal((await req(base(ch) + '/offers', 'POST', { ...body, product_ids: [randomUUID()] })).statusCode, 404, 'unknown product');
  const created = await req(base(ch) + '/offers', 'POST', body);
  assert.equal(created.statusCode, 201, created.body);
  const o = created.json().operation;
  assert.equal(o.state, 'queued');
  const replay = await req(base(ch) + '/offers', 'POST', body);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().operation.id, o.id);
  assert.equal((await req(base(ch) + '/offers', 'POST', { ...body, product_ids: [a.id] })).statusCode, 409, 'same key, another body');
  assert.equal((await req(base(ch) + '/offers', 'POST', { client_key: randomUUID(), product_ids: [a.id] })).statusCode, 409, 'one open offer write per channel');
  const jobId = (await op(o.id)).job_id;
  await runJob(jobId);
  let row = await op(o.id);
  assert.equal(row.state, 'sent');
  assert.match(row.import_id, /^\d+$/);
  assert.deepEqual(JSON.parse(fake.calls.find(c => c.method === 'POST')!.body!).offers.map((x: any) => [x.shop_sku, x.price, x.quantity]), [[a.sku, 123.45, 7], [b.sku, 5, 0]]);
  await runJob(jobId);
  row = await op(o.id);
  assert.equal(row.state, 'partial', 'one SKU unknown on Mirakl');
  assert.equal(row.outcome, 'import_report');
  assert.deepEqual(row.result.errors.map((e: any) => e.shop_sku), [b.sku]);
  assert.equal(row.result.lines_in_success, 1);
  assert.equal(fake.offers.get(a.sku)!.price, 123.45);
  assert.equal(fake.offers.get(a.sku)!.quantity, 7);
  assert.equal((await jobOf(jobId)).state, 'done');
  // Writes stay off without the simulation (no operator contract for writes).
  configureMirakl262Runtime({ writes: false });
  assert.equal((await req(base(ch) + '/offers', 'POST', { client_key: randomUUID(), product_ids: [a.id] })).statusCode, 503);
});

test('offers.write: a lost OF24 answer is reconciled by OF21 readback — applied, or sent again when Mirakl has nothing', async () => {
  freshRuntime({ importReadsUntilComplete: 0 });
  const ch = await channel();
  const a = await product('M262-' + randomUUID().slice(0, 8), 2500, 3);
  fake.addOffer({ shop_sku: a.sku, price: 1, quantity: 0 });
  fake.fail({ kind: 'commit_then_500' }, 'POST /api/offers');
  const o = (await api(base(ch) + '/offers', 'POST', { client_key: randomUUID(), product_ids: [a.id] })).operation;
  const jobId = (await op(o.id)).job_id;
  await runJob(jobId);
  let row = await op(o.id);
  assert.equal(row.state, 'uncertain');
  assert.equal(row.import_id, null);
  await runJob(jobId);
  row = await op(o.id);
  assert.equal(row.state, 'applied');
  assert.equal(row.outcome, 'reconciled');
  assert.equal(fake.calls.filter(c => c.method === 'POST').length, 1, 'no second OF24');
  // 503 before the change: readback shows the old values, so the same lines are sent once more.
  fake.fail({ kind: 'http', status: 503 }, 'POST /api/offers');
  await pool.query('UPDATE products SET price=2600 WHERE id=$1', [a.id]);
  const o2 = (await api(base(ch) + '/offers', 'POST', { client_key: randomUUID(), product_ids: [a.id] })).operation;
  const job2 = (await op(o2.id)).job_id;
  await runJob(job2);
  assert.equal((await op(o2.id)).state, 'uncertain');
  // OF24 is asynchronous: old values right after the lost answer may mean the first import still runs — no resend yet.
  await runJob(job2);
  row = await op(o2.id);
  assert.equal(row.state, 'uncertain');
  assert.match(row.reason, /może jeszcze trwać/);
  assert.equal(fake.calls.filter(c => c.method === 'POST').length, 2, 'no OF24 before the replay delay');
  await pool.query("UPDATE mirakl262_operations SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [o2.id]);
  await runJob(job2);
  row = await op(o2.id);
  assert.equal(row.state, 'queued');
  assert.equal(row.outcome, 'replayed');
  await runJob(job2);
  row = await op(o2.id);
  assert.equal(row.state, 'sent');
  await runJob(job2);
  assert.equal((await op(o2.id)).state, 'applied');
  assert.equal(fake.offers.get(a.sku)!.price, 26);
});

// ---- fulfillment.write ---------------------------------------------------------------------------------------
test('fulfillment.write: OR21 accept, OR23 tracking and OR24 ship of staged orders; refusals keep Mirakl unchanged', async () => {
  freshRuntime();
  const f = await stagedChannel();
  const post = (body: any, cookie = admin) => req(base(f.ch) + '/fulfillment', 'POST', { client_key: randomUUID(), ...body }, cookie);
  assert.equal((await post({ action: 'accept', order_id: f.accept }, viewer)).statusCode, 403);
  assert.equal((await post({ action: 'accept', order_id: f.accept }, other)).statusCode, 404);
  assert.equal((await post({ action: 'accept', order_id: 'NOT-STAGED' })).statusCode, 404, 'only orders of this channel');
  assert.equal((await post({ action: 'accept', order_id: f.ship })).statusCode, 409, 'not waiting for acceptance');
  assert.equal((await post({ action: 'tracking', order_id: f.ship, tracking: { tracking_number: 'X1' } })).statusCode, 422, 'carrier required');
  const acc = await post({ action: 'accept', order_id: f.accept });
  assert.equal(acc.statusCode, 201, acc.body);
  await runJob((await op(acc.json().operation.id)).job_id);
  let row = await op(acc.json().operation.id);
  assert.deepEqual([row.state, row.outcome], ['applied', 'acknowledged']);
  assert.equal(fake.orders.get(f.accept)!.order_state, 'SHIPPING');
  const tr = await post({ action: 'tracking', order_id: f.ship, tracking: { carrier_code: 'DPD', carrier_name: 'DPD Polska', tracking_number: '0000123456789' } });
  await runJob((await op(tr.json().operation.id)).job_id);
  assert.equal((await op(tr.json().operation.id)).state, 'applied');
  assert.equal(fake.orders.get(f.ship)!.tracking!.tracking_number, '0000123456789');
  const sh = await post({ action: 'ship', order_id: f.ship });
  await runJob((await op(sh.json().operation.id)).job_id);
  assert.equal((await op(sh.json().operation.id)).state, 'applied');
  assert.equal(fake.orders.get(f.ship)!.order_state, 'SHIPPED');
  // The provider refuses a second shipment: failed with a fixed message, no provider text.
  const again = await post({ action: 'ship', order_id: f.ship });
  await runJob((await op(again.json().operation.id)).job_id);
  row = await op(again.json().operation.id);
  assert.deepEqual([row.state, row.outcome], ['failed', 'refused']);
  assert(!/SYNTHETIC/.test(row.reason));
  const list = await api(base(f.ch));
  assert.equal(list.operations.length, 4);
});

test('fulfillment.write: a lost OR24 answer is reconciled by OR11 readback under the shared budget, never shipped twice', async () => {
  freshRuntime();
  const f = await stagedChannel();
  fake.fail({ kind: 'commit_then_hang' }, 'PUT /api/orders/');
  const sh = (await api(base(f.ch) + '/fulfillment', 'POST', { client_key: randomUUID(), action: 'ship', order_id: f.ship })).operation;
  const jobId = (await op(sh.id)).job_id;
  await runJob(jobId);
  assert.equal((await op(sh.id)).state, 'uncertain');
  assert.equal(fake.orders.get(f.ship)!.order_state, 'SHIPPED', 'the fake applied it');
  // The readback is an OR11 read: the instance budget was used by the schedule less than 15 minutes ago.
  const ships = () => fake.calls.filter(c => c.method === 'PUT' && c.path.endsWith('/ship')).length;
  await pool.query("UPDATE mirakl262_schedules SET next_run_at=now() WHERE channel_id=$1", [f.ch]);
  clock -= 15 * 60_000; // back inside the OR11 window used by stagedChannel()
  await runJob(jobId);
  assert.equal((await op(sh.id)).state, 'uncertain', 'deferred by the shared budget');
  clock += 15 * 60_000 + 2000;
  await runJob(jobId);
  const row = await op(sh.id);
  assert.deepEqual([row.state, row.outcome], ['applied', 'reconciled']);
  assert.equal(ships(), 1, 'one OR24 call');
  // A manual reconcile of a settled operation is refused.
  assert.equal((await req(base(f.ch) + '/operations/' + sh.id + '/reconcile', 'POST', {})).statusCode, 409);
});

// ---- webhooks.receive ------------------------------------------------------------------------------------------
test('webhooks.receive: secret path token, idempotent event id, bounded body, rate limit and tenant isolation', async () => {
  freshRuntime();
  const ch = await channel();
  await api(base(ch) + '/schedule', 'PUT', { enabled: true, interval_minutes: 60 });
  await pool.query("UPDATE mirakl262_schedules SET next_run_at=now()+interval '1 hour' WHERE channel_id=$1", [ch]);
  assert.equal((await req(base(ch) + '/webhook', 'POST', {}, viewer)).statusCode, 403);
  const hook = await api(base(ch) + '/webhook', 'POST', {});
  assert.match(hook.path, /^\/callbacks\/mirakl\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{43}$/);
  const stored = (await pool.query('SELECT * FROM mirakl262_webhook_endpoints WHERE id=$1', [hook.id])).rows[0];
  assert(!JSON.stringify(stored).includes(hook.path.split('/').at(-1)), 'only the token hash is stored');
  const send = (path: string, body: any, type = 'application/json') =>
    app.inject({ url: path, method: 'POST', payload: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': type } });
  const event = { id: 'EVT-' + randomUUID(), type: 'ORDER_UPDATED', payload: { order_id: 'MO-1' } };
  const wrong = hook.path.replace(/[^/]+$/, 'A'.repeat(43));
  assert.equal((await send(wrong, event)).statusCode, 404, 'wrong token');
  assert.equal((await send(hook.path, event, 'text/plain')).statusCode, 415);
  assert.equal((await send(hook.path, '{not json')).statusCode, 400);
  assert.equal((await send(hook.path, { type: 'ORDER_UPDATED' })).statusCode, 400, 'event id required');
  assert.equal((await send(hook.path, { ...event, pad: 'x'.repeat(70000) })).statusCode, 413);
  assert.equal((await pool.query('SELECT count(*)::int n FROM mirakl262_webhook_events WHERE endpoint_id=$1', [hook.id])).rows[0].n, 0);
  assert.equal((await send(hook.path, event)).statusCode, 200);
  assert.equal((await send(hook.path, event)).statusCode, 200, 'replay acknowledged');
  const events = (await pool.query('SELECT event_id,event_type,outcome FROM mirakl262_webhook_events WHERE endpoint_id=$1', [hook.id])).rows;
  assert.deepEqual(events, [{ event_id: event.id, event_type: 'ORDER_UPDATED', outcome: 'sync_requested' }]);
  assert(new Date((await schedule(ch)).next_run_at).getTime() <= Date.now() + 1000, 'the event only brings the OR11 poll forward');
  // Another company's endpoint never accepts this channel's token, and the rotated token replaces the old one.
  const otherCh = await channel(other);
  const otherHook = await api(base(otherCh) + '/webhook', 'POST', {}, other);
  assert.equal((await send(otherHook.path.replace(/[^/]+$/, hook.path.split('/').at(-1)), { ...event, id: 'X' })).statusCode, 404);
  const rotated = await api(base(ch) + '/webhook', 'POST', {});
  assert.equal((await send(hook.path, { ...event, id: 'OLD' })).statusCode, 404, 'old token revoked');
  assert.equal((await send(rotated.path, { ...event, id: 'NEW', type: 'OFFER_UPDATED' })).statusCode, 200);
  // 120 events per endpoint and minute.
  const tenant = stored.tenant_id;
  await pool.query("INSERT INTO mirakl262_webhook_events(id,tenant_id,endpoint_id,event_id,event_type,body_sha256,outcome) SELECT gen_random_uuid(),$1,$2,'BULK-'||g,'X',repeat('0',64),'recorded' FROM generate_series(1,120) g", [tenant, hook.id]);
  assert.equal((await send(rotated.path, { ...event, id: 'OVER' })).statusCode, 429);
});

test('writes that cannot be settled end as failed/conflict and free the target: changed connection, unresolved for 24 h', async () => {
  freshRuntime();
  const f = await stagedChannel();
  fake.fail({ kind: 'http', status: 503 }, 'PUT /api/orders/');
  const sh = (await api(base(f.ch) + '/fulfillment', 'POST', { client_key: randomUUID(), action: 'ship', order_id: f.ship })).operation;
  await runJob((await op(sh.id)).job_id);
  assert.equal((await op(sh.id)).state, 'uncertain');
  // A different shop on the channel: the uncertain write stops for good, with the uncertainty spelled out.
  await pool.query(`UPDATE channels SET settings=jsonb_set(settings,'{shop_id}','"2001"') WHERE id=$1`, [f.ch]);
  await runJob((await op(sh.id)).job_id);
  let row = await op(sh.id);
  assert.deepEqual([row.state, row.outcome], ['failed', 'conflict']);
  assert.match(row.reason, /niepewny/);
  await sweepMirakl262Due();
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='mirakl262.write' AND payload->>'operation_id'=$1", [sh.id])).rows[0].n, 1, 'no new job for a settled write');
  // An answer lost for an order the operator no longer returns: after 24 h it is failed, not read forever.
  const g = await stagedChannel();
  fake.fail({ kind: 'http', status: 503 }, 'PUT /api/orders/');
  const acc = (await api(base(g.ch) + '/fulfillment', 'POST', { client_key: randomUUID(), action: 'accept', order_id: g.accept })).operation;
  const job = (await op(acc.id)).job_id;
  await runJob(job);
  assert.equal((await op(acc.id)).state, 'uncertain');
  fake.orders.delete(g.accept);
  await runJob(job);
  row = await op(acc.id);
  assert.equal(row.state, 'uncertain', 'unknown within 24 h: read again later');
  await pool.query("UPDATE mirakl262_operations SET created_at=now()-interval '25 hours' WHERE id=$1", [acc.id]);
  clock += 15 * 60_000 + 1000;
  await runJob(job);
  row = await op(acc.id);
  assert.deepEqual([row.state, row.outcome], ['failed', 'conflict']);
  const again = await req(base(g.ch) + '/fulfillment', 'POST', { client_key: randomUUID(), action: 'ship', order_id: g.accept });
  assert.notEqual(again.statusCode, 409, 'the target is free again');
});
