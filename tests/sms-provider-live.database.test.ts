/** COM-006: SMSAPI provider_live path on a real disposable clone (dynaminds_s5_<YYYYMMDD>_NN).
 * A fake transport stands in for api.smsapi.pl; nothing leaves the machine. Covered: endpoint setup
 * only for an MFA admin session, live preview/queue with explicit consent, job kind sms.send,
 * exactly one provider POST (also on a re-run and after a lost answer), provider rejection,
 * delivery callbacks from the documented SMSAPI peer only, and the status read by the UI. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { tokenHash } from '../server/security';
import { processSms } from '../server/sms';
import { SMSAPI_CALLBACK_IPS } from '../server/sms-delivery';
import { seed, DEMO_TENANT } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.match(selected.pathname, /^\/dynaminds_s5_2026[0-9]{4}_[0-9]{2}$/);
// PG04 is shared by many lanes; catalog-wide preflight reads can pass 8 s under that load.
// Only this test's own connections get a longer statement timeout; the app default is unchanged.
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

let app: FastifyInstance, plain: string, mfa: string, viewer: string, warehouse: string, product: string, adminId: string;
let endpoint: { id: string; channel_id: string; callback_url: string };
// notify_url = callback_url + '/' + secret token kept only in the channel's encrypted credentials.
let notifyPath = '';
type Call = { url: string; auth: string | null; body: URLSearchParams };
const calls: Call[] = [];
let reply: () => Promise<Response> = async () => new Response('{}');
const transport = async (url: string, init: RequestInit) => {
  calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: new URLSearchParams(String(init.body)) });
  return reply();
};
const req = (url: string, method: any = 'GET', payload?: any, cookie = mfa) =>
  app.inject({ url, method, payload, headers: { cookie, 'idempotency-key': randomUUID() } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = mfa) {
  const r = await req(url, method, payload, cookie);
  assert(r.statusCode < 300, url + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
const callback = (fields: Record<string, string>, peer = SMSAPI_CALLBACK_IPS[0], path = notifyPath) =>
  app.inject({
    url: path,
    method: 'POST',
    remoteAddress: peer,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
async function claim(jobId: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [jobId, randomUUID()],
    )
  ).rows[0];
}
async function liveMessage(phone = '500100200') {
  const o = await ok('/api/orders', 'POST', {
    customer_name: 'Kupujący SMS',
    email: 'sms-' + randomUUID().slice(0, 8) + '@example.test',
    warehouse_id: warehouse,
    address: { country: 'PL', phone },
    items: [{ product_id: product, quantity: 1 }],
  });
  const t = await ok('/api/sms/templates', 'POST', {
    name: 'Live ' + randomUUID().slice(0, 6),
    body: 'Zamówienie {{order_number}} przyjęte',
    max_parts: 1,
    client_key: randomUUID(),
  });
  const b = await ok('/api/sms/preview', 'POST', {
    template_id: t.id,
    template_version: t.version,
    order_ids: [o.id],
    mode: 'provider_live',
    channel_id: endpoint.channel_id,
    delivery_endpoint_id: endpoint.id,
    client_key: randomUUID(),
  });
  assert.equal(b.items[0].state, 'draft', b.items[0].error);
  return { o, b };
}
const accepted = (to: string, id: string) => async () =>
  new Response(JSON.stringify({ count: 1, list: [{ id, points: 0.16, number: to, date_sent: 1761400000, submitted_number: to, status: 'QUEUE' }] }), {
    headers: { 'content-type': 'application/json' },
  });

before(async () => {
  await migrate();
  await seed();
  // Park the clone's pending jobs of real channels; this test drives its own jobs only.
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE state IN ('pending','running')");
  app = await buildApp({ integrationTransport: transport, logging: process.env.S5_TEST_LOG === '1' });
  const login = async (email: string) =>
    (await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } })).headers['set-cookie']!
      .toString()
      .split(';')[0];
  plain = await login('admin@demo.local');
  viewer = await login('viewer@demo.local');
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  // MFA-verified admin session (the live path requires it even when the workspace does not).
  await pool.query(
    "INSERT INTO account_security(user_id,secret_encrypted,enabled_at) VALUES($1,'qa-totp-secret',now()) ON CONFLICT(user_id) DO UPDATE SET secret_encrypted=EXCLUDED.secret_encrypted,enabled_at=now()",
    [adminId],
  );
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at,account_version,mfa_verified_at)
     VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',(SELECT version FROM account_security WHERE user_id=$2),clock_timestamp())`,
    [tokenHash(token), adminId, DEMO_TENANT],
  );
  mfa = 'dyna_session=' + token;
  warehouse = (await ok('/api/warehouses')).data[0].id;
  product = (await ok('/api/products', 'POST', { sku: 'SMS-' + randomUUID(), name: 'Produkt SMS', price: 1000, quantity: 100, warehouse_id: warehouse })).id;
});
after(async () => {
  await app.close();
  await pool.end();
});

test('live endpoint setup and live sends require an MFA admin session and explicit consent', async () => {
  const setup = {
    name: 'SMSAPI QA',
    sender: 'DynaQA',
    access_token: 'qa-live-token',
    account_username: 'qa-account',
    callback_origin: 'https://callbacks.example.test/',
    confirm_external: true,
  };
  // An admin session without a recent MFA verification is refused.
  assert([401, 403].includes((await req('/api/sms/live-endpoints', 'POST', setup, plain)).statusCode));
  assert.equal((await req('/api/sms/live-endpoints', 'POST', setup, viewer)).statusCode, 403);
  assert.equal((await req('/api/sms/live-endpoints', 'POST', { ...setup, callback_origin: 'http://callbacks.example.test/' })).statusCode, 422);
  endpoint = await ok('/api/sms/live-endpoints', 'POST', setup);
  assert.equal(endpoint.callback_url, 'https://callbacks.example.test/callbacks/smsapi/' + endpoint.id);
  const listed = await ok('/api/sms/live-endpoints');
  assert(!JSON.stringify(listed).includes('qa-live-token'));
  const { b } = await liveMessage();
  const refused = await req('/api/sms/batches/' + b.id + '/queue', 'POST', { confirmed: true });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(calls.length, 0);
});

test('sms.send posts exactly once, records the receipt and the delivery report reaches the UI read', async () => {
  const { o, b } = await liveMessage();
  const queued = await ok('/api/sms/batches/' + b.id + '/queue', 'POST', { confirmed: true, confirm_external: true });
  const m = queued.items[0];
  const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [m.job_id])).rows[0];
  assert.equal(job.kind, 'sms.send');
  reply = accepted('48500100200', 'QA-PROVIDER-1');
  await processSms(await claim(job.id), { transport });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://api.smsapi.pl/sms.do');
  assert.equal(call.auth, 'Bearer qa-live-token');
  assert.equal(call.body.get('to'), '48500100200');
  assert.equal(call.body.get('from'), 'DynaQA');
  assert.equal(call.body.get('idx'), m.id.replaceAll('-', ''));
  assert.equal(call.body.get('check_idx'), '1');
  const notify = call.body.get('notify_url')!;
  assert.equal(notify.slice(0, endpoint.callback_url.length + 1), endpoint.callback_url + '/');
  assert.match(notify.slice(endpoint.callback_url.length + 1), /^[A-Za-z0-9_-]{43}$/);
  notifyPath = new URL(notify).pathname;
  assert.equal(call.body.get('test'), null, 'live send never carries test=1');
  let row = (await ok('/api/sms/messages?order_id=' + o.id)).data[0];
  assert.equal(row.state, 'submitted');
  assert.equal(row.result.provider_id, 'QA-PROVIDER-1');
  assert.deepEqual(row.delivery, { status_code: null, needs_reconciliation: false });

  // A re-run of the same job (lost lease, worker restart) never posts again.
  await pool.query("UPDATE jobs SET state='pending',lease_token=NULL WHERE id=$1", [job.id]);
  await processSms(await claim(job.id), { transport });
  assert.equal(calls.length, 1);

  const report = (code: string, done: string, extra: Record<string, string> = {}) => ({
    MsgId: 'QA-PROVIDER-1',
    status: code,
    sent_at: '1761400000',
    donedate: done,
    username: 'qa-account',
    to: '48500100200',
    idx: m.id.replaceAll('-', ''),
    ...extra,
  });
  assert.equal((await callback(report('404', '1761400100'), '127.0.0.1')).statusCode, 403, 'only the SMSAPI peer');
  assert.equal((await callback(report('404', '1761400100'), undefined, '/callbacks/smsapi/' + endpoint.id)).statusCode, 404, 'URL without the secret token');
  assert.equal((await callback(report('404', '1761400100'), undefined, notifyPath.replace(/[^/]+$/, randomBytes(32).toString('base64url')))).statusCode, 404, 'wrong token');
  assert.equal((await callback(report('404', '1761400100', { username: 'other-account' }))).statusCode, 404);
  assert.equal((await callback(report('404', '1761400100', { status_name: 'FAILED' }))).statusCode, 422);
  const sent = await callback(report('403', '1761400050'));
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.body, 'OK');
  row = (await ok('/api/sms/messages?order_id=' + o.id)).data[0];
  assert.deepEqual(row.delivery, { status_code: 403, needs_reconciliation: false });
  assert.equal((await callback(report('404', '1761400100'))).statusCode, 200);
  assert.equal((await callback(report('404', '1761400100'))).statusCode, 200, 'duplicate report is acknowledged');
  assert.equal((await callback(report('403', '1761400060'))).statusCode, 200, 'stale progress is acknowledged');
  row = (await ok('/api/sms/messages?order_id=' + o.id, 'GET', undefined, viewer)).data[0];
  assert.deepEqual(row.delivery, { status_code: 404, needs_reconciliation: false });
  const batch = await ok('/api/sms/batches/' + b.id);
  assert.equal(batch.items[0].delivery.status_code, 404);
  assert.equal(batch.state, 'done');
  assert.equal(calls.length, 1);
});

test('lost provider answer is uncertain without a second POST; a provider refusal is failed', async () => {
  const lost = await liveMessage('500100201');
  const q1 = (await ok('/api/sms/batches/' + lost.b.id + '/queue', 'POST', { confirmed: true, confirm_external: true })).items[0];
  const before = calls.length;
  reply = async () => {
    throw new TypeError('socket hang up');
  };
  await processSms(await claim(q1.job_id), { transport });
  assert.equal(calls.length, before + 1);
  let m = (await pool.query('SELECT state,error,attempted_at FROM sms_messages WHERE id=$1', [q1.id])).rows[0];
  assert.equal(m.state, 'uncertain');
  assert.match(m.error, /bez ponownej wysyłki/);
  await pool.query("UPDATE jobs SET state='pending',lease_token=NULL WHERE id=$1", [q1.job_id]);
  reply = accepted('48500100201', 'QA-PROVIDER-LATE');
  await processSms(await claim(q1.job_id), { transport });
  assert.equal(calls.length, before + 1, 'no second POST after an unknown outcome');

  const refused = await liveMessage('500100202');
  const q2 = (await ok('/api/sms/batches/' + refused.b.id + '/queue', 'POST', { confirmed: true, confirm_external: true })).items[0];
  reply = async () => new Response(JSON.stringify({ error: 101, message: 'Authorization failed' }), { headers: { 'content-type': 'application/json' } });
  await processSms(await claim(q2.job_id), { transport });
  m = (await pool.query('SELECT state,error FROM sms_messages WHERE id=$1', [q2.id])).rows[0];
  assert.equal(m.state, 'failed');
  assert.equal(m.error, 'SMSAPI odrzuciło wysyłkę: 101');
  assert.equal(calls.length, before + 2);
});
