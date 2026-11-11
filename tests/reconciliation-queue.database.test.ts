/** AUTO-04 on a fresh PG04 clone: one read-only "Do uzgodnienia" queue lists side effects
 * whose outcome is unknown in SMS, email, DPD pickups, shipping, invoices, channel statuses and
 * offers. Fixture rows are inserted directly (session_replication_role=replica skips FK and
 * guard triggers, CHECKs still hold); the route reads them as dyna_app under RLS. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_(s3b|a4)_20261027_\d{2}$/);
let app: FastifyInstance;
const tenant = randomUUID(),
  foreign = randomUUID(),
  cookies: Record<string, string> = {};
const call = (path: string, role = 'admin') =>
  app.inject({ url: '/api' + path, headers: { cookie: cookies[role]!, 'x-workspace-id': tenant } });
const u = () => randomUUID();
async function insert(t: string, rows: Record<string, unknown>[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role='replica'");
    for (const r of rows) {
      const k = Object.keys(r);
      await c.query(`INSERT INTO ${t}(${k.join(',')}) VALUES(${k.map((_, i) => '$' + (i + 1)).join(',')})`, Object.values(r).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)));
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
const expected = new Map<string, string>();
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  for (const id of [tenant, foreign]) await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA uzgodnienia','enterprise')", [id]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' WHEN 'operator@demo.local' THEN 'operator' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])",
    [tenant, ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local']],
  );
  for (const role of ['admin', 'operator', 'viewer']) {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: role + '@demo.local', password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    const s = await app.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: tenant },
      headers: { cookie: r.headers['set-cookie']!.toString().split(';')[0]! },
    });
    assert.equal(s.statusCode, 200, s.body);
    cookies[role] = s.headers['set-cookie']!.toString().split(';')[0]!;
  }
  const order = u(),
    actor = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  const msg = (t: string, state: string, extra = {}) => ({ id: u(), tenant_id: t, batch_id: u(), order_id: order, number: 'R-1', snapshot: {}, state, error: 'Brak odpowiedzi dostawcy', attempted_at: new Date().toISOString(), ...extra });
  const keep = (domain: string, row: any) => (expected.set(row.id, domain), row);
  await insert('sms_messages', [keep('sms', msg(tenant, 'uncertain')), msg(tenant, 'queued'), msg(foreign, 'uncertain')]);
  await insert('email_messages', [keep('email', msg(tenant, 'uncertain')), msg(tenant, 'smtp_accepted')]);
  const dpd = (state: string, phase: string) => ({ id: u(), tenant_id: tenant, channel_id: u(), actor_id: actor, kind: 'pickup', client_key: u(), fingerprint: 'f', input: {}, payload: {}, connection_hash: 'h', requested_number: 'P-' + u(), state, phase });
  await insert('dpd_collections', [keep('dpd_collection', dpd('uncertain', 'create_started')), dpd('failed', 'protocol_started')]);
  const plan = (extra: any) => ({ id: u(), tenant_id: tenant, order_id: u(), channel_id: u(), actor_id: actor, input: { provider: 'dpd' }, payload: {}, order_snapshot: {}, ...extra });
  await insert('shipping_plans', [keep('shipping', plan({ state: 'failed', phase: 'create_started' })), plan({ state: 'failed', phase: 'ready' })]);
  await insert('invoice_plans', [
    keep('invoice', plan({ kind: 'invoice', mode: 'external', state: 'failed', phase: 'create_started' })),
    plan({ kind: 'invoice', mode: 'external', state: 'failed', phase: 'ready' }),
  ]);
  const status = (extra: any) => ({ id: u(), tenant_id: tenant, order_id: u(), channel_id: u(), actor_id: actor, local_version: 1, local_status: 'paid', target: 'paid', connection_hash: 'h', remote: {}, ...extra });
  await insert('order_status_plans', [keep('order_status', status({ state: 'failed', phase: 'write_started' })), status({ state: 'conflict', phase: 'ready' })]);
  const offer = (extra: any) => ({ id: u(), tenant_id: tenant, channel_id: u(), product_id: u(), actor_id: actor, warehouse_id: u(), operation: 'sync', input: {}, local_snapshot: {}, payload: {}, ...extra });
  await insert('offer_plans', [keep('offer', offer({ state: 'failed', phase: 'verify' })), offer({ state: 'failed', phase: 'ready' })]);
});
after(async () => {
  await app.close();
  await pool.end();
});

test('one queue lists every unknown outcome of this workspace, with where to resolve it', async () => {
  const r = await call('/operations/reconciliation-queue');
  assert.equal(r.statusCode, 200, r.body);
  const q = r.json();
  assert.deepEqual(new Map(q.items.map((i: any) => [i.id, i.domain])), expected, 'exactly the uncertain rows, none of the settled or foreign ones');
  assert.deepEqual(q.counts, { sms: 1, email: 1, dpd_collection: 1, shipping: 1, invoice: 1, order_status: 1, offer: 1 });
  assert.equal(q.truncated, false);
  const by = Object.fromEntries(q.items.map((i: any) => [i.domain, i]));
  assert.equal(by.sms.resolve, 'decide');
  assert.equal(by.email.resolve, 'decide');
  assert.equal(by.dpd_collection.resolve, 'dpd_collections');
  assert.equal(by.offer.resolve, 'offers');
  for (const d of ['shipping', 'invoice', 'order_status']) assert.equal(by[d].resolve, 'order_detail', d);
  assert.equal(by.shipping.label, 'Przesyłka dpd');
  assert.equal(by.sms.error, 'Brak odpowiedzi dostawcy');
  assert.ok(by.sms.order_id && by.offer.order_id === null);
  assert.ok(q.items.every((i: any) => Number.isFinite(Date.parse(i.at))));
  assert.match(q.fulfillment_note, /Problemy operacji/);
});

test('operators read it; viewers do not', async () => {
  assert.equal((await call('/operations/reconciliation-queue', 'operator')).statusCode, 200);
  assert.equal((await call('/operations/reconciliation-queue', 'viewer')).statusCode, 403);
});
