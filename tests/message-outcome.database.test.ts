/** AUTO-04 on a fresh PG04 clone: an operator decision for an SMS or email whose send started and
 * returned no result. The uncertain state comes from the real worker path (attempt started, lease
 * lost, processSms/processEmail refuse to try again). The decision is admin/operator only, tenant
 * scoped, idempotent and refused unless the outcome is unknown; "not sent" allows exactly one new
 * send under a new message id (new provider idempotency key), never an automatic retry. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { processSms } from '../server/sms';
import { processEmail } from '../server/email';
import { seed } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_a4_20261027_\d{2}$/);
let app: FastifyInstance, warehouse: string, product: string;
const tenant = randomUUID(),
  foreign = randomUUID(),
  cookies: Record<string, string> = {};
type Kind = 'sms' | 'email';
const call = (path: string, method: 'GET' | 'POST' = 'GET', payload?: unknown, role = 'admin', workspace = tenant) =>
  app.inject({
    url: '/api' + path,
    method,
    ...(payload === undefined ? {} : { payload: payload as any }),
    headers: { cookie: cookies[role + ':' + workspace]!, 'x-workspace-id': workspace },
  });
async function ok(path: string, method: 'GET' | 'POST' = 'GET', payload?: unknown, role = 'admin') {
  const r = await call(path, method, payload, role);
  assert.ok(r.statusCode < 300, path + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
const decide = (kind: Kind, id: string, body: Record<string, unknown>, role = 'admin', workspace = tenant) =>
  call(`/operations/reconciliation-queue/${kind}/${id}/decision`, 'POST', { evidence: 'Sprawdzone w panelu dostawcy 27.10', confirmed: true, ...body }, role, workspace);
const retry = (kind: Kind, id: string, client_key: string, role = 'admin', workspace = tenant) =>
  call(`/operations/reconciliation-queue/${kind}/${id}/retry`, 'POST', { client_key }, role, workspace);
const table = (k: Kind) => (k === 'sms' ? 'sms_messages' : 'email_messages');
const message = async (k: Kind, id: string) => (await pool.query(`SELECT * FROM ${table(k)} WHERE id=$1`, [id])).rows[0];
async function lease(jobId: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [jobId, randomUUID()],
    )
  ).rows[0];
}
const run = (k: Kind, job: any) => (k === 'sms' ? processSms(job) : processEmail(job));
/** A local-mode message, queued through the API, whose attempt started and whose lease was lost:
 * the worker marks it uncertain and never tries again. */
async function uncertain(k: Kind) {
  const o = await ok('/orders', 'POST', {
    customer_name: 'QA Uzgodnienie',
    email: 'kupujacy@example.test',
    warehouse_id: warehouse,
    address: { country: 'PL', phone: '500600700' },
    items: [{ product_id: product, quantity: 1 }],
  });
  const t =
    k === 'sms'
      ? await ok('/sms/templates', 'POST', { name: 'QA SMS', body: 'Zamowienie {{order_number}}', max_parts: 1, client_key: randomUUID() })
      : await ok('/email/templates', 'POST', { name: 'QA Email', subject: 'Zamówienie {{order_number}}', body: 'Dzień dobry {{customer_name}}', client_key: randomUUID() });
  const b = await ok(`/${k}/preview`, 'POST', { template_id: t.id, template_version: t.version, order_ids: [o.id], mode: 'local', client_key: randomUUID() });
  const q = await ok(`/${k}/batches/${b.id}/queue`, 'POST', { confirmed: true });
  const m = q.items[0];
  await pool.query(`UPDATE ${table(k)} SET attempted_at=now() WHERE id=$1`, [m.id]);
  await run(k, await lease(m.job_id));
  const row = await message(k, m.id);
  assert.equal(row.state, 'uncertain', 'the worker leaves a started attempt uncertain');
  return { ...row, order: o };
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  for (const id of [tenant, foreign]) await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA decyzji','enterprise')", [id]);
  for (const id of [tenant, foreign])
    await pool.query(
      "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' WHEN 'operator@demo.local' THEN 'operator' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])",
      [id, ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local']],
    );
  for (const role of ['admin', 'operator', 'viewer'])
    for (const id of [tenant, foreign]) {
      // One session per workspace: a switch rotates the session it came from.
      const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: role + '@demo.local', password: 'DynaDemo!2026' } });
      assert.equal(r.statusCode, 200, r.body);
      const s = await app.inject({
        url: '/api/workspaces/switch',
        method: 'POST',
        payload: { tenant_id: id },
        headers: { cookie: r.headers['set-cookie']!.toString().split(';')[0]! },
      });
      assert.equal(s.statusCode, 200, s.body);
      cookies[role + ':' + id] = s.headers['set-cookie']!.toString().split(';')[0]!;
    }
  warehouse = randomUUID();
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'A4','A4')", [warehouse, tenant]);
  product = (await ok('/products', 'POST', { sku: 'A4-' + randomUUID(), name: 'A4', price: 1000, warehouse_id: warehouse, quantity: 1000 })).id;
});
after(async () => {
  await app.close();
  await pool.end();
});

for (const k of ['sms', 'email'] as const) {
  test(`${k}: the queue offers a decision; viewer 403, other workspace 404, operator decides "sent" once`, async () => {
    const m = await uncertain(k);
    const q = (await ok('/operations/reconciliation-queue')).items.find((i: any) => i.id === m.id);
    assert.equal(q?.resolve, 'decide', 'sms and email are decided in the queue itself');
    assert.equal((await decide(k, m.id, { outcome: 'sent' }, 'viewer')).statusCode, 403);
    assert.equal((await decide(k, m.id, { outcome: 'sent' }, 'admin', foreign)).statusCode, 404);
    assert.equal((await decide(k, m.id, { outcome: 'sent', confirmed: false })).statusCode, 422, 'validation is 422 in this app');
    assert.equal((await decide(k, m.id, { outcome: 'sent', evidence: 'krótko' })).statusCode, 422);
    assert.equal((await decide(k, m.id, { outcome: 'not_sent', provider_ref: 'X-1' })).statusCode, 422, 'a provider reference only belongs to "sent"');
    assert.equal((await message(k, m.id)).state, 'uncertain', 'refusals change nothing');
    const ref = k === 'sms' ? '1460969715572091219' : '<a4-27@example.test>';
    const first = await decide(k, m.id, { outcome: 'sent', provider_ref: ref }, 'operator');
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().replayed, false);
    const row = await message(k, m.id);
    assert.equal(row.state, 'simulated', 'local mode: the success state the worker would have written');
    assert.equal(row.error, null);
    assert.equal(row.result.scope, 'manual_confirmation');
    assert.equal(row.result.resolution, 'sent');
    assert.equal(row.result.provider_ref, ref);
    assert.equal(row.result.previous_error, m.error);
    assert.equal(String(row.attempted_at), String(m.attempted_at), 'the started attempt stays on record');
    const again = await decide(k, m.id, { outcome: 'sent', provider_ref: ref }, 'admin');
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().replayed, true, 'the same decision twice is a replay');
    assert.equal((await decide(k, m.id, { outcome: 'not_sent' })).statusCode, 409, 'a different second decision is refused');
    const audits = (await pool.query("SELECT action,detail FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action=$3", [tenant, m.id, k + '.outcome.manual'])).rows;
    assert.equal(audits.length, 1, 'one audit entry for one decision');
    assert.equal(audits[0].detail.outcome, 'sent');
    assert.equal((await ok('/operations/reconciliation-queue')).items.some((i: any) => i.id === m.id), false, 'decided rows leave the queue');
    assert.equal((await retry(k, m.id, randomUUID())).statusCode, 409, 'a sent message is never retried');
  });

  test(`${k}: a message whose outcome is known cannot be decided (409)`, async () => {
    const m = await uncertain(k);
    const known = (await ok(`/${k}/batches/${m.batch_id}`)).items[0];
    assert.equal(known.id, m.id);
    // A fresh message processed normally has a known outcome.
    const o = m.order;
    const t = (await pool.query(`SELECT template_id,template_version FROM ${k}_batches WHERE id=$1`, [m.batch_id])).rows[0];
    const b = await ok(`/${k}/preview`, 'POST', { template_id: t.template_id, template_version: t.template_version, order_ids: [o.id], mode: 'local', client_key: randomUUID() });
    const draft = b.items[0];
    assert.equal((await decide(k, draft.id, { outcome: 'not_sent' })).statusCode, 409, 'a draft was never attempted');
    const q = await ok(`/${k}/batches/${b.id}/queue`, 'POST', { confirmed: true });
    assert.equal((await decide(k, draft.id, { outcome: 'sent' })).statusCode, 409, 'a queued message is not unknown');
    await run(k, await lease(q.items[0].job_id));
    assert.equal((await message(k, draft.id)).state, 'simulated');
    assert.equal((await decide(k, draft.id, { outcome: 'not_sent' })).statusCode, 409, 'a settled message is not unknown');
    assert.equal((await decide(k, randomUUID(), { outcome: 'sent' })).statusCode, 404);
  });

  test(`${k}: "not sent" allows exactly one new send under a new id, never automatically`, async () => {
    const m = await uncertain(k);
    const jobs = async () => (await pool.query(`SELECT id,state FROM jobs WHERE tenant_id=$1 AND payload->>'message_id'=ANY($2::text[])`, [tenant, await ids()])).rows;
    const ids = async () => (await pool.query(`SELECT id::text FROM ${table(k)} WHERE tenant_id=$1 AND order_id=$2`, [tenant, m.order_id])).rows.map((r) => r.id);
    assert.equal((await retry(k, m.id, randomUUID())).statusCode, 409, 'no retry while the outcome is unknown');
    const d = await decide(k, m.id, { outcome: 'not_sent' }, 'operator');
    assert.equal(d.statusCode, 200, d.body);
    const failed = await message(k, m.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.result.resolution, 'not_sent');
    assert.match(failed.error, /nie wysłano/i);
    assert.deepEqual((await jobs()).map((j) => j.state), ['done'], 'the decision itself sends nothing and queues nothing');
    assert.equal((await retry(k, m.id, randomUUID(), 'viewer')).statusCode, 403);
    assert.equal((await retry(k, m.id, randomUUID(), 'admin', foreign)).statusCode, 404);
    const key = randomUUID();
    const r1 = await retry(k, m.id, key, 'operator');
    assert.equal(r1.statusCode, 200, r1.body);
    const batch = r1.json();
    assert.equal(batch.state, 'preview', 'the retry is a new preview; sending needs the usual approval');
    assert.equal(batch.items.length, 1);
    const fresh = batch.items[0];
    assert.notEqual(fresh.id, m.id, 'new message id = new provider idempotency key');
    assert.notEqual(batch.client_key, m.batch_id);
    assert.equal(fresh.order_id, m.order_id);
    assert.equal(fresh.state, 'draft');
    const r2 = await retry(k, m.id, key, 'operator');
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal(r2.json().id, batch.id, 'same key, same retry');
    assert.equal((await retry(k, m.id, randomUUID(), 'operator')).statusCode, 409, 'a second retry with another key is refused');
    assert.equal((await ids()).length, 2, 'exactly one new message');
    const queued = await ok(`/${k}/batches/${batch.id}/queue`, 'POST', { confirmed: true }, 'operator');
    assert.equal(queued.items[0].state, 'queued');
    const all = await jobs();
    assert.equal(all.length, 2, 'the original job and exactly one new job');
    const job = (await pool.query("SELECT * FROM jobs WHERE id=$1", [queued.items[0].job_id])).rows[0];
    assert.equal(job.dedup_key, k + ':' + fresh.id);
    await run(k, await lease(job.id));
    assert.equal((await message(k, fresh.id)).state, 'simulated');
    const original = await message(k, m.id);
    assert.equal(original.state, 'failed', 'the original stays decided');
    assert.equal(original.result.retry.batch_id, batch.id);
    assert.equal(original.result.retry.message_id, fresh.id);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action=$3", [tenant, m.id, k + '.outcome.retry'])).rows[0].n, 1);
  });
}

test('sms live: a provider receipt or delivery report makes the outcome known', async () => {
  const m = await uncertain('sms');
  // Fixture rows as the live path writes them (replica skips FKs only; CHECKs hold).
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role='replica'");
    await c.query("UPDATE sms_batches SET mode='provider_live',channel_id=$2,channel_hash=$3,delivery_endpoint_id=$4 WHERE id=$1", [m.batch_id, randomUUID(), 'a'.repeat(64), randomUUID()]);
    const b = (await c.query('SELECT channel_id,delivery_endpoint_id FROM sms_batches WHERE id=$1', [m.batch_id])).rows[0];
    await c.query('INSERT INTO sms_delivery_submissions(tenant_id,message_id,channel_id,endpoint_id,idx) VALUES($1,$2,$3,$4,$5)', [tenant, m.id, b.channel_id, b.delivery_endpoint_id, m.id.replaceAll('-', '')]);
    await c.query(
      "INSERT INTO sms_delivery_events(tenant_id,message_id,event_hash,provider_id,provider_sent_at,status_code,provider_done_at) VALUES($1,$2,$3,'99887766',1761550000,404,1761550100)",
      [tenant, m.id, 'b'.repeat(64)],
    );
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  const refused = await decide('sms', m.id, { outcome: 'not_sent' });
  assert.equal(refused.statusCode, 409, 'SMSAPI reported this idx; "not sent" would be false');
  await pool.query("UPDATE sms_delivery_submissions SET provider_id='99887766',provider_sent_at=1761550000,accepted_at=now() WHERE message_id=$1", [m.id]);
  assert.equal((await decide('sms', m.id, { outcome: 'sent' })).statusCode, 409, 'an accepted receipt is a known outcome');
  assert.equal((await message('sms', m.id)).state, 'uncertain');
});
