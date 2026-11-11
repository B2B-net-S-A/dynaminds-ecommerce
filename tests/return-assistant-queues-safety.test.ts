import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { returnAssistantFixture } from './return-assistant-fixture';
import { returnAssistantQueueFixture } from './return-assistant-queues-fixture';

// Authoring only: root runs these cases against its disposable native database.
// These tests do not claim the separately proposed raw SQL final-PIN protocol.
assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
let ownIp = 0;
before(async () => {
  await migrate(); await seed();
  app = await buildApp({ integrationTransport: async () => { throw Error('Queue safety cannot invoke a provider'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

async function fixture(on = false) {
  if (!on) return returnAssistantQueueFixture(app);
  const f = await returnAssistantFixture(app, on);
  const expensive = f.order.items.find((i: Row) => i.line_total === 3401);
  assert(expensive);
  const second = await f.ok('/orders/' + f.order.id + '/returns', 'POST', {
    client_key: randomUUID(), reason: 'Own second actual issued commercial return', shipping_refund: 0,
    items: [{ item_id: expensive.id, quantity: 2 }],
  }, 201);
  return { ...f, return_ids: [f.rma.id, second.id] };
}
async function facts(tenant: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY 1")).rows;
    const rows: Record<string, Row[]> = {};
    for (const { table_name: name } of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      rows[name] = (await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE tenant_id=$1 ORDER BY 1`, [tenant])).rows;
    }
    await c.query('COMMIT'); return rows;
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
function unchangedBusiness(beforeRows: Record<string, Row[]>, afterRows: Record<string, Row[]>) {
  const allowed = new Set(['return_assistant_settings', 'return_assistant_queues', 'return_assistant_queue_items', 'return_assistant_queue_operations', 'return_assistant_queue_admissions', 'audit_events']);
  assert.deepEqual(Object.keys(afterRows), Object.keys(beforeRows));
  for (const table of Object.keys(beforeRows)) if (!allowed.has(table)) assert.deepEqual(afterRows[table], beforeRows[table], table);
}
async function req(f: Row, path: string, method: any = 'GET', payload?: any, key?: Row, cookie = f.cookie) {
  return app.inject({ url: '/api' + (key ? '/v1' : '') + '/return-assistant' + path, method, payload,
    headers: key ? { authorization: 'Bearer ' + key.token } : { cookie }, remoteAddress: '127.140.1.1' });
}
async function ok(f: Row, path: string, method: any = 'GET', payload?: any, status = 200, key?: Row, cookie?: string) {
  const r = await req(f, path, method, payload, key, cookie); assert.equal(r.statusCode, status, `${method} ${path}`); return r.json() as Row;
}
const queueInput = (f: Row) => ({ client_key: randomUUID(), return_ids: [...f.return_ids], navigation: { auto_next: false, hide_accepted: false } });
const patchInput = (q: Row) => ({ client_key: randomUUID(), version: String(q.version), position: 1,
  skipped_return_ids: [], navigation: { auto_next: true, hide_accepted: true } });
async function key(f: Row, scopes: string[]) {
  return f.ok('/developer/keys', 'POST', { name: 'Own assistant queue scoped key', scopes }, 201);
}
async function heldQueue(f: Row, id: string) {
  const c = await pool.connect(); await c.query('BEGIN');
  assert.equal((await c.query('SELECT id FROM return_assistant_queues WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.tenant, id])).rowCount, 1);
  return c;
}
async function waitOn(held: PoolClient) {
  const pid = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid, until = Date.now() + 5000;
  while (Date.now() < until) {
    const waiting = (await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))", [pid])).rows;
    // Match the actual SD outer queue query, and tie the wait to our held row.
    if (waiting.some(r => /return_assistant_queue/i.test(r.query))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Queue mutation must really wait on the held own queue row');
}
async function change(sql: string, args: unknown[]) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout='1500ms'"); await c.query(sql, args); await c.query('COMMIT'); }
  finally { await c.query('ROLLBACK'); c.release(); }
}

test('OFF and ON queues retain ordered real RMAs, exact retries and personal settings without goods or financial effects', async () => {
  for (const on of [false, true]) {
    const f = await fixture(on), beforeRows = await facts(f.tenant), settings = await ok(f, '/settings');
    const settingsBody = { client_key: randomUUID(), version: String(settings.settings.version), values: {
      ...settings.settings.values, auto_next: true, hide_accepted: true, name_source: 'historical', product_sort: 'sku', thumbnail_size: 'none',
    } };
    const saved = await ok(f, '/settings', 'PATCH', settingsBody);
    const afterSettings = await facts(f.tenant);
    const savedReplay = await ok(f, '/settings', 'PATCH', settingsBody);
    assert.equal(savedReplay.reused, true); assert.deepEqual(savedReplay.settings, saved.settings);
    assert.deepEqual(await facts(f.tenant), afterSettings);
    const body = queueInput(f), created = await ok(f, '/queues', 'POST', body, 201);
    assert.equal(created.reused, false); assert.equal(String(created.queue.version), '1');
    const q = created.queue, afterCreate = await facts(f.tenant);
    const replay = await ok(f, '/queues', 'POST', body);
    assert.equal(replay.reused, true); assert.deepEqual(replay.queue, q); assert.deepEqual(await facts(f.tenant), afterCreate);
    const detail = await ok(f, '/queues/' + q.id), items = await ok(f, '/queues/' + q.id + '/items');
    assert.equal(detail.queue.id, q.id); assert.deepEqual(items.data.map((r: Row) => r.return_id), f.return_ids); assert.equal(items.next_cursor, null);
    const update = patchInput(q), moved = await ok(f, '/queues/' + q.id, 'PATCH', update);
    assert.equal(String(moved.queue.version), '2'); assert.equal(moved.queue.position, 1);
    const afterMove = await facts(f.tenant), again = await ok(f, '/queues/' + q.id, 'PATCH', update);
    assert.equal(again.reused, true); assert.deepEqual(again.queue, moved.queue); assert.deepEqual(await facts(f.tenant), afterMove);
    assert.equal((await req(f, '/queues/' + q.id, 'PATCH', { ...update, navigation: { auto_next: false, hide_accepted: true } })).statusCode, 409);
    assert.deepEqual(await facts(f.tenant), afterMove); unchangedBusiness(beforeRows, afterMove);
    assert.equal(afterMove.return_assistant_sessions.length, 0); assert.equal(afterMove.return_assistant_receipts.length, 0);
  }
});

test('foreign RMA rejects the whole manifest and foreign queue IDs expose no detail or mutation', async () => {
  const a = await fixture(), b = await fixture(), beforeA = await facts(a.tenant), beforeB = await facts(b.tenant);
  assert.equal((await req(a, '/queues', 'POST', { ...queueInput(a), return_ids: [a.rma.id, b.rma.id] })).statusCode, 404);
  assert.deepEqual(await facts(a.tenant), beforeA); assert.deepEqual(await facts(b.tenant), beforeB);
  const q = (await ok(a, '/queues', 'POST', queueInput(a), 201)).queue, madeA = await facts(a.tenant);
  for (const path of ['/queues/' + q.id, '/queues/' + q.id + '/items']) {
    const r = await req(b, path); assert.equal(r.statusCode, 404); assert(!r.body.includes(a.rma.number));
  }
  assert.equal((await req(b, '/queues/' + q.id, 'PATCH', patchInput(q))).statusCode, 404);
  assert.deepEqual(await facts(a.tenant), madeA); assert.deepEqual(await facts(b.tenant), beforeB);
});

test('a new same-tenant admin cannot impersonate the queue owner or read their personal settings', async () => {
  const f = await fixture(), q = (await ok(f, '/queues', 'POST', queueInput(f), 201)).queue;
  const ip = '127.140.2.' + ++ownIp;
  const signup = await app.inject({ url: '/api/auth/signup', method: 'POST', remoteAddress: ip,
    payload: { email: 'own-queue-' + randomUUID() + '@example.test', name: 'Own separate queue operator', password: 'OwnQueue!140Safe', organization: { name: 'Own queue operator origin' } } });
  assert.equal(signup.statusCode, 201); const user = signup.json().user.id;
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [f.tenant, user]);
  const sw = await app.inject({ url: '/api/workspaces/switch', method: 'POST', remoteAddress: ip, headers: { cookie: String(signup.headers['set-cookie']).split(';')[0] }, payload: { tenant_id: f.tenant } });
  assert.equal(sw.statusCode, 200); const cookie = String(sw.headers['set-cookie']).split(';')[0], beforeRows = await facts(f.tenant);
  const history = await ok(f, '/queues', 'GET', undefined, 200, undefined, cookie); assert(!history.data.some((r: Row) => r.id === q.id));
  const ownSettings = await ok(f, '/settings', 'GET', undefined, 200, undefined, cookie); assert.equal(String(ownSettings.settings.version), '0');
  for (const path of ['/queues/' + q.id, '/queues/' + q.id + '/items']) assert.equal((await req(f, path, 'GET', undefined, undefined, cookie)).statusCode, 404);
  assert.equal((await req(f, '/queues/' + q.id, 'PATCH', patchInput(q), undefined, cookie)).statusCode, 404);
  assert.deepEqual(await facts(f.tenant), beforeRows);
});

test('two genuine waiting CAS updates produce one version and one durable operation; exact retry cannot reapply', async () => {
  const f = await fixture(), q = (await ok(f, '/queues', 'POST', queueInput(f), 201)).queue, held = await heldQueue(f, q.id);
  const a = patchInput(q), b = { ...patchInput(q), position: 0 }; let first: ReturnType<typeof req> | undefined, second: ReturnType<typeof req> | undefined;
  try {
    first = req(f, '/queues/' + q.id, 'PATCH', a); await waitOn(held);
    second = req(f, '/queues/' + q.id, 'PATCH', b); await held.query('ROLLBACK');
    const results = await Promise.all([first, second]); assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
    const winner = results[0].statusCode === 200 ? a : b, accepted = results.find(r => r.statusCode === 200)!.json();
    assert.equal(String(accepted.queue.version), '2'); const beforeRetry = await facts(f.tenant);
    const replay = await ok(f, '/queues/' + q.id, 'PATCH', winner); assert.equal(replay.reused, true); assert.deepEqual(replay.queue, accepted.queue);
    assert.deepEqual(await facts(f.tenant), beforeRetry);
    assert.equal(beforeRetry.return_assistant_queue_operations.filter(r => r.row.client_key === a.client_key || r.row.client_key === b.client_key).length, 1);
  } finally { await held.query('ROLLBACK'); held.release(); await first?.catch(() => undefined); await second?.catch(() => undefined); }
});

for (const revokeKey of [false, true]) test(`queue PATCH revalidates ${revokeKey ? 'the actual API key' : 'membership'} after its real held-row wait`, async () => {
  const f = await fixture(), k = revokeKey ? await key(f, ['orders:read', 'orders:write']) : undefined;
  const q = (await ok(f, '/queues', 'POST', queueInput(f), 201, k)).queue;
  assert.equal((await req(f, '/queues/' + q.id, 'GET', undefined, k)).statusCode, 200);
  const beforeRows = await facts(f.tenant), held = await heldQueue(f, q.id); let pending: ReturnType<typeof req> | undefined, revoked = false;
  try {
    pending = req(f, '/queues/' + q.id, 'PATCH', patchInput(q), k); await waitOn(held);
    if (k) await change('UPDATE api_keys SET revoked_at=now() WHERE tenant_id=$1 AND id=$2', [f.tenant, k.id]);
    else await change("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    revoked = true; await held.query('ROLLBACK'); assert.equal((await pending).statusCode, k ? 401 : 403);
  } finally {
    await held.query('ROLLBACK'); held.release(); await pending?.catch(() => undefined);
    if (revoked) { if (k) await change('UPDATE api_keys SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2', [f.tenant, k.id]); else await change("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); }
  }
  assert.deepEqual(await facts(f.tenant), beforeRows);
});

test('orders read key is metadata-only, and a different live write key cannot replay another key command', async () => {
  const f = await fixture(), read = await key(f, ['orders:read']), writer = await key(f, ['orders:read', 'orders:write']), other = await key(f, ['orders:read', 'orders:write']);
  const settings = await ok(f, '/settings', 'GET', undefined, 200, read); assert.equal(settings.can_write, false);
  const body = queueInput(f), beforeRows = await facts(f.tenant);
  assert.equal((await req(f, '/queues', 'POST', body, read)).statusCode, 403); assert.deepEqual(await facts(f.tenant), beforeRows);
  const created = await ok(f, '/queues', 'POST', body, 201, writer), afterRows = await facts(f.tenant);
  assert.equal((await req(f, '/queues', 'POST', body, other)).statusCode, 409); assert.deepEqual(await facts(f.tenant), afterRows);
  const detail = await ok(f, '/queues/' + created.queue.id, 'GET', undefined, 200, read); assert.equal(detail.queue.id, created.queue.id);
  for (const forbidden of ['lease_token', 'lease_token_hash', 'content_base64', 'content_encrypted', 'private_scope_nonce', 'unit_cost_minor']) assert(!JSON.stringify(detail).includes('"' + forbidden + '"'));
});

test('app cannot raw read or mutate personal queue tables; FORCE RLS and owner-bound typed reads retain the actual graph', async () => {
  const f = await fixture(), q = (await ok(f, '/queues', 'POST', queueInput(f), 201)).queue, beforeRows = await facts(f.tenant);
  const tables = ['return_assistant_settings', 'return_assistant_queues', 'return_assistant_queue_items', 'return_assistant_queue_operations', 'return_assistant_queue_admissions'];
  for (const table of tables) for (const sql of [`INSERT INTO ${table} DEFAULT VALUES`, `UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1`, `DELETE FROM ${table} WHERE tenant_id=$1`]) {
    await assert.rejects(tenantTx(f.tenant, c => c.query(sql, sql.includes('$1') ? [f.tenant] : [])), (e: any) => e.code === '42501');
  }
  for (const table of tables) {
    await assert.rejects(tenantTx(f.tenant, c => c.query(`SELECT * FROM ${table}`)), (e: any) => e.code === '42501');
    const policy = (await pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [table])).rows[0];
    assert.equal(policy.relrowsecurity, true); assert.equal(policy.relforcerowsecurity, true);
  }
  assert.equal((await ok(f, '/queues/' + q.id)).queue.id, q.id); assert.deepEqual(await facts(f.tenant), beforeRows);
});

test('restore denies malformed settings and queue writes before parsing on both aliases, while own metadata stays readable', async () => {
  const f = await fixture(), q = (await ok(f, '/queues', 'POST', queueInput(f), 201)).queue, beforeRows = await facts(f.tenant);
  const copy = await buildApp({ readOnly: true, integrationTransport: async () => { throw Error('Read-only queue test cannot call a provider'); } });
  try {
    // A restored app uses its own preview-session cookie namespace. Authenticate
    // in that app and explicitly select the same own tenant before reading.
    const originalSession = await copy.inject({ url: '/api/return-assistant/settings', headers: { cookie: f.cookie } });
    assert.equal(originalSession.statusCode, 401);
    const login = await copy.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' }, remoteAddress: '127.140.2.1' });
    assert.equal(login.statusCode, 200);
    const switched = await copy.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: f.tenant }, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, remoteAddress: '127.140.2.1' });
    assert.equal(switched.statusCode, 200);
    const copyCookie = String(switched.headers['set-cookie']).split(';')[0];
    const me = await copy.inject({ url: '/api/auth/me', headers: { cookie: copyCookie } });
    assert.equal(me.statusCode, 200); assert.equal(me.json().user.tenant_id, f.tenant); assert.equal(me.json().user.id, f.user);
    for (const prefix of ['/api', '/api/v1']) for (const [path, method] of [['/settings', 'PATCH'], ['/queues', 'POST'], ['/queues/' + q.id, 'PATCH']] as const) {
      const r = await copy.inject({ url: prefix + '/return-assistant' + path, method, headers: { cookie: copyCookie, 'Content-Type': 'application/json' }, payload: '{' });
      assert.equal(r.statusCode, 423);
    }
    for (const path of ['/settings', '/queues/' + q.id, '/queues/' + q.id + '/items']) {
      const r = await copy.inject({ url: '/api/return-assistant' + path, headers: { cookie: copyCookie } }); assert.equal(r.statusCode, 200);
      const b = r.json(); assert.equal(b.read_only, true); assert.equal(b.can_write, false);
    }
  } finally { await copy.close(); }
  assert.deepEqual(await facts(f.tenant), beforeRows);
});

test('valid typed SQL writer fails closed on a missing row/deferred guard, and NULL operation cannot fall through to update', async () => {
  const f = await fixture(), beforeRows = await facts(f.tenant);
  const targets = [
    ['return_assistant_queue_items', 'return_assistant_queue_guard'],
    ['return_assistant_queue_admissions', 'return_assistant_queue_complete'],
  ] as const;
  for (const [table, trigger] of targets) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // Owner DDL is confined to this aborted disposable-test transaction. The
      // denial must come from the real app-executable SD writer, not Node caps.
      await c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await c.query('SET LOCAL ROLE dyna_app'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
      await assert.rejects(c.query("SELECT return_assistant_queue_write($1,$2,NULL,'create',$3,$4::jsonb)",
        [randomUUID(), f.user, randomUUID(), queueInput(f)]),
      (e: any) => e.code === '55000' && e.message === 'Niekompletna kolejka asystenta');
    } finally { await c.query('ROLLBACK'); c.release(); }
    assert.deepEqual(await facts(f.tenant), beforeRows);
  }
  await assert.rejects(tenantTx(f.tenant, c => c.query('SELECT return_assistant_queue_write($1,$2,NULL,NULL,$3,$4::jsonb)',
    [randomUUID(), f.user, randomUUID(), queueInput(f)])),
  (e: any) => e.code === '23514' && e.message === 'Nieprawidłowa operacja kolejki');
  assert.deepEqual(await facts(f.tenant), beforeRows);
});
