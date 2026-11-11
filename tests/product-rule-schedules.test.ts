/** Product rule schedules on a fresh PG04 clone: two schedulers and a restart never
 * duplicate one due time (AUTO-02, AUTO-09); pause stops the schedule and resume is a
 * fresh preview of the same scope approved again (AUTO-03). */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { scheduleProductRuleOccurrencesDue } from '../server/product-rule-schedules';
assert.equal(process.env.DYNA_TEST, 'true', 'Isolated test database required');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_s3b_20261027_\d{2}$/);
let app: FastifyInstance, admin: string, operator: string, tenant: string, warehouse: string, p1: string;
const request = (url: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({ url, method, payload, headers: { cookie, 'x-workspace-id': tenant } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await request(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, url + ': ' + r.body);
  return r.json();
}
async function login(email: string) {
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie']!.toString().split(';')[0]!;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
});
beforeEach(async () => {
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA rule schedules','enterprise')", [tenant]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' ELSE 'operator' END FROM users WHERE email=ANY($2::text[])",
    [tenant, ['admin@demo.local', 'operator@demo.local']],
  );
  for (const role of ['admin', 'operator']) {
    const r = await app.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: tenant },
      headers: { cookie: role === 'admin' ? admin : operator },
    });
    assert.equal(r.statusCode, 200, r.body);
    const changed = r.headers['set-cookie']!.toString().split(';')[0]!;
    if (role === 'admin') admin = changed;
    else operator = changed;
  }
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA','SCHED')", [warehouse, tenant]);
  p1 = (await ok('/api/products', 'POST', { sku: 'SCHED-1', name: 'Produkt harmonogramu', price: 1000, warehouse_id: warehouse, quantity: 3 })).id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function schedule() {
  const rule = await ok('/api/product-rules', 'POST', {
    client_key: randomUUID(),
    definition: {
      name: 'Kategoria z harmonogramu',
      event: 'product.updated',
      enabled: true,
      priority: 50,
      conditions: [],
      actions: [{ type: 'set_category', category: 'Z harmonogramu' }],
    },
    confirm_future_changes: true,
  });
  const version = (await pool.query('SELECT version FROM products WHERE id=$1', [p1])).rows[0].version;
  const p = await ok('/api/product-rule-schedules/previews', 'POST', {
    client_key: randomUUID(),
    name: 'Co godzinę',
    interval_minutes: 60,
    event: 'product.updated',
    rule_ids: [rule.id],
    items: [{ product_id: p1, version }],
    expected_version: 0,
  });
  return ok('/api/product-rule-schedules/previews/' + p.id + '/commit', 'POST', { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true });
}
const due = (id: string) => pool.query("UPDATE product_rule_schedules SET next_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [id]);
const row = async (id: string) => (await pool.query('SELECT * FROM product_rule_schedules WHERE id=$1', [id])).rows[0];
const occurrences = async (id: string) =>
  (await pool.query('SELECT due_at FROM product_rule_schedule_occurrences WHERE schedule_id=$1 ORDER BY created_at', [id])).rows;

test('two schedulers on the same due time and a restart queue exactly one occurrence', async () => {
  const s = await schedule();
  await due(s.id);
  const dueAt = (await row(s.id)).next_at;
  const [a, b] = await Promise.all([scheduleProductRuleOccurrencesDue(), scheduleProductRuleOccurrencesDue()]);
  assert.equal(a.queued + b.queued, 1, 'one of the two schedulers queues it');
  // A restarted process runs the scheduler again for the same (already passed) term.
  assert.equal((await scheduleProductRuleOccurrencesDue()).queued, 0);
  const after = await row(s.id);
  assert.equal(after.enabled, true);
  assert.equal(after.error, null);
  assert.ok(new Date(after.next_at) > new Date(), 'next term moved into the future');
  const o = await occurrences(s.id);
  assert.equal(o.length, 1);
  assert.equal(new Date(o[0].due_at).toISOString(), new Date(dueAt).toISOString());
  await assert.rejects(
    pool.query(
      'INSERT INTO product_rule_schedule_occurrences(id,tenant_id,schedule_id,schedule_version,approved_by,client_key,due_at,run_id,settings,rules,scope_hash) SELECT $1,tenant_id,schedule_id,schedule_version,approved_by,$2,due_at,$3,settings,rules,scope_hash FROM product_rule_schedule_occurrences WHERE schedule_id=$4',
      [randomUUID(), randomUUID(), randomUUID(), s.id],
    ),
    (e: any) => ['23505', '23503'].includes(e.code),
    'the database refuses a second occurrence of the same term',
  );
});

test('pause stops the schedule; resume previews the same scope again and needs a fresh approval', async () => {
  const s = await schedule();
  const paused = await ok('/api/product-rule-schedules/' + s.id + '/pause', 'POST', { version: s.version, confirmed: true });
  assert.equal(paused.enabled, false);
  assert.equal(paused.next_at, null);
  assert.equal((await scheduleProductRuleOccurrencesDue()).queued, 0, 'paused schedule is not run');
  assert.equal((await occurrences(s.id)).length, 0);
  assert.equal(
    (await request('/api/product-rule-schedules/' + s.id + '/resume-preview', 'POST', { client_key: randomUUID(), version: paused.version }, operator)).statusCode,
    403,
  );
  assert.equal(
    (await request('/api/product-rule-schedules/' + s.id + '/resume-preview', 'POST', { client_key: randomUUID(), version: s.version })).statusCode,
    409,
    'stale version',
  );
  const preview = await ok('/api/product-rule-schedules/' + s.id + '/resume-preview', 'POST', { client_key: randomUUID(), version: paused.version });
  assert.equal(preview.schedule_id, s.id);
  assert.equal(preview.expected_version, paused.version);
  assert.deepEqual(preview.settings, (await row(s.id)).settings);
  assert.equal(preview.run.items.length, 1);
  assert.equal((await row(s.id)).enabled, false, 'preview alone does not resume');
  const resumed = await ok('/api/product-rule-schedules/previews/' + preview.id + '/commit', 'POST', { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true });
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.version, paused.version + 1);
  assert.ok(new Date(resumed.next_at) > new Date());
  assert.equal(
    (await request('/api/product-rule-schedules/' + s.id + '/resume-preview', 'POST', { client_key: randomUUID(), version: resumed.version })).statusCode,
    409,
    'an enabled schedule has nothing to resume',
  );
  await due(s.id);
  assert.equal((await scheduleProductRuleOccurrencesDue()).queued, 1);
  const audit = (await pool.query("SELECT action FROM audit_events WHERE tenant_id=$1 AND action LIKE 'product.rules.schedule.%' ORDER BY created_at", [tenant])).rows.map((r) => r.action);
  assert.deepEqual(audit, ['product.rules.schedule.approve', 'product.rules.schedule.pause', 'product.rules.schedule.approve', 'product.rules.schedule.queue']);
});
