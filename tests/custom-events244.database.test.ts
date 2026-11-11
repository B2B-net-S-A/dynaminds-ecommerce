/** AUTO-07 (DOM-AUTO-008) on migration 244: own events. Definitions (admin), a call from the UI route, from
 * the API (session and API key) and from a rule action; each call is one durable order event, one `automation` job
 * for the rules listening to `custom.<key>` and one history row with the rule runs it started. Same key = same call,
 * other content under the key = 409, inactive = 422, other tenant = 404, viewer = 403, rule loops stop.
 * Database test on a disposable clone; migrate() (before) applies 244 like every release migration:
 * dynaminds_m244_20261027_NN. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { tick } from '../server/worker';
import { seed, DEMO_TENANT } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:24[456789]|25[0123456789]|26[0123])_202610(?:27|28|29|30)_[0-9]{2}$/, 'fresh clone dynaminds_m244_20261027_NN (or m245/m246/m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 245/246/247/248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

let app: Awaited<ReturnType<typeof buildApp>>;
const cookies: Record<string, string> = {};
let warehouse = '', apiToken = '';
const api = (url: string, method: any = 'GET', payload?: any, who = 'admin') =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie: cookies[who], ...(url === '/orders' ? { 'idempotency-key': randomUUID() } : {}) } });
async function ok(url: string, method: any = 'GET', payload?: any, who = 'admin') {
  const r = await api(url, method, payload, who);
  assert(r.statusCode < 300, method + ' ' + url + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
async function drain() { for (let i = 0; i < 150; i++) if (!(await tick())) return; }
async function order() {
  const p = await ok('/products', 'POST', { name: 'Zdarzenie 244', sku: 'EV-' + randomUUID().slice(0, 8), price: 1000, quantity: 50, warehouse_id: warehouse });
  return ok('/orders', 'POST', { customer_name: 'Kupujący', email: 'kupujacy244@example.test', warehouse_id: warehouse, items: [{ product_id: p.id, quantity: 1 }], shipping_cost: 0 });
}
const key = () => 'ev_' + randomUUID().replaceAll('-', '').slice(0, 12);
async function definition(k = key(), extra: any = {}) { return ok('/custom-events', 'POST', { key: k, name: 'Zdarzenie ' + k, ...extra }); }
async function rule(trigger: string, actions: any[], name = 'Reguła ' + randomUUID().slice(0, 6)) {
  return ok('/automations', 'POST', { name, trigger, actions, match: 'all', conditions: [] });
}
const note = async (id: string) => (await pool.query('SELECT note FROM orders WHERE id=$1', [id])).rows[0].note as string;

before(async () => {
  await migrate();
  await seed();
  // Rules of other test files would listen to the same order events; this file owns its rules.
  await pool.query("UPDATE automation_rules SET enabled=false WHERE tenant_id=$1", [DEMO_TENANT]);
  // The template carries old pending jobs; drain() must only see this file's work (as tests/developer.test.ts).
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE state IN ('pending','running')");
  app = await buildApp();
  for (const who of ['admin', 'viewer', 'operator', 'other']) {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: who + '@demo.local', password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    cookies[who] = r.headers['set-cookie']!.toString().split(';')[0];
  }
  warehouse = (await ok('/warehouses')).data[0].id;
  const k = await app.inject({ url: '/api/developer/keys', method: 'POST', payload: { name: 'Zdarzenia 244', scopes: ['orders:read', 'orders:write'] }, headers: { cookie: cookies.admin } });
  assert.equal(k.statusCode, 201, k.body);
  apiToken = k.json().token;
});
after(async () => {
  await app.close();
  await pool.end();
});

test('only an administrator defines events; the key is unique per tenant and immutable; versions guard edits', async () => {
  const k = key();
  for (const who of ['viewer', 'operator']) assert.equal((await api('/custom-events', 'POST', { key: k, name: 'Nie wolno' }, who)).statusCode, 403, who);
  const d = await definition(k, { description: 'Opis' });
  assert.equal(d.key, k); assert.equal(d.active, true); assert.equal(d.version, '1');
  assert.equal((await api('/custom-events', 'POST', { key: k, name: 'Drugi raz' })).statusCode, 409, 'duplicate key');
  assert.equal((await api('/custom-events/' + d.id, 'PATCH', { name: 'Nowa', description: '', active: true, version: '7' })).statusCode, 409, 'stale version');
  assert.equal((await api('/custom-events/' + d.id, 'PATCH', { key: 'other_key', name: 'Nowa', description: '', active: true, version: '1' })).statusCode, 422, 'key is immutable');
  const u = await ok('/custom-events/' + d.id, 'PATCH', { name: 'Nowa nazwa', description: '', active: false, version: '1' });
  assert.equal(u.version, '2'); assert.equal(u.active, false); assert.equal(u.key, k);
  const list = await ok('/custom-events', 'GET', undefined, 'viewer');
  assert.equal(list.available, true);
  assert(list.data.some((x: any) => x.id === d.id && x.name === 'Nowa nazwa'));
  assert(!(await ok('/custom-events', 'GET', undefined, 'other')).data.some((x: any) => x.id === d.id), 'tenant isolation');
  const audit = (await pool.query("SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY created_at", [d.id])).rows.map((r) => r.action);
  assert.deepEqual(audit, ['custom_event.create', 'custom_event.update']);
});

test('a call from the API is one order event, one job for listening rules and one history row; the same key is the same call', async () => {
  const d = await definition(), o = await order();
  const r = await rule('custom.' + d.key, [{ type: 'add_note', note: 'Zdarzenie ' + d.key }]);
  const client_key = randomUUID();
  const first = await ok('/custom-events/' + d.key + '/raise', 'POST', { order_id: o.id, client_key }, 'operator');
  assert.equal(first.replayed, false);
  assert.equal(first.call.source, 'ui');
  const again = await ok('/custom-events/' + d.key + '/raise', 'POST', { order_id: o.id, client_key }, 'operator');
  assert.equal(again.replayed, true);
  assert.equal(again.call.id, first.call.id);
  const other = await order();
  assert.equal((await api('/custom-events/' + d.key + '/raise', 'POST', { order_id: other.id, client_key }, 'operator')).statusCode, 409, 'other content under the same key');
  const events = (await pool.query("SELECT id,kind,detail FROM order_events WHERE order_id=$1 AND kind LIKE 'custom.%'", [o.id])).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'custom.' + d.key);
  assert.equal(events[0].detail.call_id, first.call.id);
  const jobs = (await pool.query("SELECT payload FROM jobs WHERE kind='automation' AND payload->>'eventId'=$1", [events[0].id])).rows;
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].payload.rules.map((x: any) => x.id), [r.id]);
  await drain();
  assert.match(await note(o.id), new RegExp('Zdarzenie ' + d.key));
  const history = await ok('/custom-events/' + d.id + '/calls', 'GET', undefined, 'viewer');
  assert.equal(history.data.length, 1);
  assert.equal(history.data[0].id, first.call.id);
  assert.equal(history.data[0].order_number, o.number);
  assert.deepEqual(history.data[0].runs.map((x: any) => [x.rule_id, x.state]), [[r.id, 'done']]);
  // No outbound order.updated and no marketplace status signal: the order itself did not change.
  assert.equal((await pool.query("SELECT count(*)::int n FROM outbound_events WHERE payload->>'id'=$1 AND created_at>now()-interval '1 minute' AND event_type='order.updated'", [o.id])).rows[0].n, 0);
});

test('an API key with orders:write raises through /api/v1; the call is marked api and keeps the key id', async () => {
  const d = await definition(), o = await order(), client_key = randomUUID();
  const r = await app.inject({ url: '/api/v1/custom-events/' + d.key + '/raise', method: 'POST', payload: { order_id: o.id, client_key }, headers: { authorization: 'Bearer ' + apiToken } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().call.source, 'api');
  const row = (await pool.query('SELECT * FROM custom_event_calls WHERE id=$1', [r.json().call.id])).rows[0];
  assert.equal(row.client_key, 'api:' + client_key);
  assert(row.api_key_id);
  const list = await app.inject({ url: '/api/v1/custom-events', headers: { authorization: 'Bearer ' + apiToken } });
  assert.equal(list.statusCode, 200, list.body);
  assert(list.json().data.some((x: any) => x.key === d.key));
});

test('refusals: viewer 403, unknown key 404, other tenant order 404, inactive 422, no key 422; nothing is recorded', async () => {
  const d = await definition(), o = await order(), before = (await pool.query('SELECT count(*)::int n FROM custom_event_calls')).rows[0].n;
  assert.equal((await api('/custom-events/' + d.key + '/raise', 'POST', { order_id: o.id, client_key: randomUUID() }, 'viewer')).statusCode, 403);
  assert.equal((await api('/custom-events/no_such_event/raise', 'POST', { order_id: o.id, client_key: randomUUID() })).statusCode, 404);
  assert.equal((await api('/custom-events/' + d.key + '/raise', 'POST', { order_id: o.id, client_key: randomUUID() }, 'other')).statusCode, 404, 'other tenant has no such event');
  const theirs = await app.inject({ url: '/api/orders', method: 'GET', headers: { cookie: cookies.other } });
  const foreign = theirs.json().data?.[0]?.id ?? randomUUID();
  assert.equal((await api('/custom-events/' + d.key + '/raise', 'POST', { order_id: foreign, client_key: randomUUID() })).statusCode, 404, 'other tenant order');
  assert.equal((await api('/custom-events/' + d.key + '/raise', 'POST', { order_id: o.id })).statusCode, 422);
  await ok('/custom-events/' + d.id, 'PATCH', { name: d.name, description: '', active: false, version: '1' });
  assert.equal((await api('/custom-events/' + d.key + '/raise', 'POST', { order_id: o.id, client_key: randomUUID() })).statusCode, 422);
  assert.equal((await pool.query('SELECT count(*)::int n FROM custom_event_calls')).rows[0].n, before);
});

test('rules: a trigger or action naming an unknown event is refused; raise_event chains a second rule; loops stop', async () => {
  assert.equal((await api('/automations', 'POST', { name: 'Zła', trigger: 'custom.no_such_event', actions: [{ type: 'add_note', note: 'x' }] })).statusCode, 422);
  assert.equal((await api('/automations', 'POST', { name: 'Zła', trigger: 'order.created', actions: [{ type: 'raise_event', event_key: 'no_such_event' }] })).statusCode, 422);
  const a = await definition(), b = await definition(), o = await order();
  // a → note + raise b; b → note + raise a (a loop). The trace stops the second pass of the first rule.
  const ra = await rule('custom.' + a.key, [{ type: 'add_note', note: 'A-' + a.key }, { type: 'raise_event', event_key: b.key }]);
  const rb = await rule('custom.' + b.key, [{ type: 'add_note', note: 'B-' + b.key }, { type: 'raise_event', event_key: a.key }]);
  const preview = await ok('/automations/' + ra.id + '/preview', 'POST', { order_id: o.id });
  assert.equal(preview.allowed, true, JSON.stringify(preview));
  assert.deepEqual(preview.chain.actions[1].emits.map((e: any) => [e.trigger, e.rules.map((x: any) => x.id)]), [['custom.' + b.key, [rb.id]]]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM custom_event_calls WHERE order_id=$1', [o.id])).rows[0].n, 0, 'preview records no call');
  await ok('/custom-events/' + a.key + '/raise', 'POST', { order_id: o.id, client_key: randomUUID() });
  await drain();
  const n = await note(o.id);
  assert.equal(n.split('A-' + a.key).length - 1, 1, n);
  assert.equal(n.split('B-' + b.key).length - 1, 1, n);
  const calls = (await pool.query('SELECT source,event_key,operation_id FROM custom_event_calls WHERE order_id=$1 ORDER BY created_at', [o.id])).rows;
  assert.deepEqual(calls.map((c) => [c.source, c.event_key]), [['ui', a.key], ['rule', b.key], ['rule', a.key]]);
  const runs = (await pool.query("SELECT rule_id,state,result->>'reason' reason FROM automation_runs WHERE order_id=$1 ORDER BY created_at", [o.id])).rows;
  assert.deepEqual(runs.map((r) => [r.rule_id, r.state]), [[ra.id, 'done'], [rb.id, 'done'], [ra.id, 'skipped']]);
  assert.match(runs[2].reason, /powtarzającą się regułę/);
});

test('the order panel raises with its own key through /orders/:id/operations; a repeat of the key changes nothing', async () => {
  const d = await definition(), o = await order(), client_key = randomUUID();
  const r1 = await ok('/orders/' + o.id + '/operations', 'POST', { type: 'raise_event', event_key: d.key, client_key }, 'operator');
  assert.equal(r1.changed, true); assert.equal(r1.replayed, false);
  const r2 = await ok('/orders/' + o.id + '/operations', 'POST', { type: 'raise_event', event_key: d.key, client_key }, 'operator');
  assert.equal(r2.changed, false); assert.equal(r2.replayed, true); assert.equal(r2.call_id, r1.call_id);
  assert.equal((await api('/orders/' + o.id + '/operations', 'POST', { type: 'raise_event', event_key: d.key }, 'operator')).statusCode, 422, 'no key');
});
