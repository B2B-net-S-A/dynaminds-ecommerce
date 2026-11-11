/** Migration 245_s5_comm (prepared as placeholder 253; object names keep that prefix) on a disposable PG04 clone
 * dynaminds_m245_<YYYYMMDD>_NN: the real migrate() applies it after 244. Real routes, real SQL, RLS as dyna_app.
 * - COM-001: the order history of email_messages / sms_messages can use the per-order indexes;
 * - COM-PORTAL-4: the tenant's default link validity reaches new orders, rotation and (on request) existing links;
 *   the portal refuses an expired default link; only the administrator changes it; another tenant is untouched;
 * - COM-005: the IMAP schedule runs as the administrator who enabled it, binds a reply to our own Message-ID or an
 *   order number from the buyer's own address, leaves ambiguous and unknown mail for a person, runs once under a
 *   lease, and stops when that person loses access;
 * - COM-008: connections, idempotent connector port, threads without an order, channel filter, assignment CAS,
 *   linking an order, pending reply intents, private notes, tenant isolation. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { tick } from '../server/worker';
import { seed } from './fixtures';
import { emailInboundFixture, normalizedInboundPreview } from './email-inbound-fixture';
import { importInboundEmail } from '../server/email-inbound';
import { runInboundSchedule, scheduleInboundPollsDue } from '../server/inbound-auto253';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_m(?:24[56789]|25[0123456789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m245_YYYYMMDD_NN (or m246/m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 246/247/248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');
// PG04 is shared; catalogue-wide preflight reads can pass 8 s under load (as in tests/messages-s5.database.test.ts).
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

let app: FastifyInstance, admin: string, operator: string, viewer: string, other: string, warehouse: string, product: string;
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie, 'idempotency-key': randomUUID() } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert(r.statusCode < 300, method + ' ' + url + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
async function status(url: string, code: number, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.equal(r.statusCode, code, method + ' ' + url + ' ' + r.body);
  return r.json();
}
const pub = (token: string, path = '') => app.inject({ url: '/api/public/orders/' + token + path, remoteAddress: '127.0.0.53' });
async function order(email = 'p253-' + randomUUID().slice(0, 8) + '@example.test') {
  return ok('/orders', 'POST', {
    customer_name: 'Kupujący 253',
    email,
    warehouse_id: warehouse,
    address: { street: 'ul. Testowa 1', city: 'Warszawa', postal_code: '00-950', country: 'PL', phone: '500100200' },
    items: [{ product_id: product, quantity: 1 }],
  });
}
async function drain() {
  for (let i = 0; i < 200; i++) if (!(await tick())) return;
  throw new Error('Worker did not drain');
}
const days = (d: string | Date) => (new Date(d).getTime() - Date.now()) / 86400000;

before(async () => {
  await migrate();
  assert((await pool.query("SELECT EXISTS(SELECT FROM migrations WHERE name='245_s5_comm') ok")).rows[0].ok, 'migrate() applied 245');
  await seed();
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE state IN ('pending','running')");
  app = await buildApp({ logging: process.env.P253_TEST_LOG === '1' });
  const login = async (email: string) =>
    (await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } })).headers['set-cookie']!
      .toString()
      .split(';')[0];
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  product = (await ok('/products', 'POST', { sku: 'P253-' + randomUUID(), name: 'Kubek 253', price: 4900, quantity: 500, warehouse_id: warehouse })).id;
});
after(async () => {
  await app?.close();
  await pool.end();
});

test('COM-001: the order history of email and SMS has valid per-order indexes (tenant, order, newest first)', async () => {
  const o = await order();
  // Which index the planner takes depends on the data volume (an almost empty clone ties with the per-tenant page
  // index); the shape and validity are what the migration owns.
  const rows = (
    await pool.query(
      `SELECT c.relname,pg_get_indexdef(i.indexrelid) def,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
       WHERE c.relname IN ('comm253_email_order','comm253_sms_order') ORDER BY c.relname`,
    )
  ).rows;
  assert.deepEqual(rows.map((r) => [r.relname, r.indisvalid, r.indisready]), [['comm253_email_order', true, true], ['comm253_sms_order', true, true]]);
  assert.match(rows[0].def, /ON public\.email_messages USING btree \(tenant_id, order_id, created_at DESC, id DESC\)$/);
  assert.match(rows[1].def, /ON public\.sms_messages USING btree \(tenant_id, order_id, created_at DESC, id DESC\)$/);
  // With sequential scans off the per-order history reads through an index under RLS as dyna_app.
  const plan = await tenantTx((await ok('/orders/' + o.id)).tenant_id, async (c) => {
    await c.query('SET LOCAL enable_seqscan=off');
    return JSON.stringify((await c.query("EXPLAIN (FORMAT JSON) SELECT id FROM email_messages WHERE order_id=$1 ORDER BY created_at DESC,id DESC", [o.id])).rows[0]['QUERY PLAN']);
  });
  assert.match(plan, /"Node Type":"Index (Only )?Scan"/);
  // The existing timeline route still answers through them.
  assert.deepEqual((await ok('/orders/' + o.id + '/communication')).data, []);
});

test('COM-PORTAL-4: default validity reaches new orders and rotation; only the administrator sets it', async () => {
  const before253 = await ok('/orders/' + (await order()).id);
  assert.equal(before253.portal_expires_at, null, 'no policy: as before 245');
  const policy = await ok('/portal/link-policy');
  assert.equal(policy.available, true);
  assert.equal(policy.default_days, null);
  assert(policy.links_without_expiry >= 1);
  await status('/portal/link-policy', 403, 'PUT', { default_days: 30, version: policy.version }, operator);
  await status('/portal/link-policy', 403, 'GET', undefined, viewer);
  await status('/portal/link-policy', 422, 'PUT', { default_days: 0, version: policy.version });
  const saved = await ok('/portal/link-policy', 'PUT', { default_days: 30, version: policy.version });
  assert.equal(saved.default_days, 30);
  await status('/portal/link-policy', 409, 'PUT', { default_days: 31, version: policy.version }, admin);
  const fresh = await ok('/orders/' + (await order()).id);
  assert(Math.abs(days(fresh.portal_expires_at) - 30) < 0.01, fresh.portal_expires_at);
  assert.equal((await pub(fresh.portal_token, '/data')).statusCode, 200);
  // Rotation without explicit days takes the policy; explicit days still win.
  const rotated = await ok('/orders/' + fresh.id + '/portal', 'POST', { action: 'rotate' });
  assert(Math.abs(days(rotated.portal_expires_at) - 30) < 0.01);
  const explicit = await ok('/orders/' + fresh.id + '/portal', 'POST', { action: 'rotate', days: 7 });
  assert(Math.abs(days(explicit.portal_expires_at) - 7) < 0.01);
  // Another tenant keeps links without a date.
  const otherPolicy = await ok('/portal/link-policy', 'GET', undefined, other);
  assert.equal(otherPolicy.default_days, null);
  // Policy back to none: new links without a date again.
  await ok('/portal/link-policy', 'PUT', { default_days: null, version: saved.version });
  assert.equal((await ok('/orders/' + (await order()).id)).portal_expires_at, null);
});

test('COM-PORTAL-4: existing links without a date get one only on request; disabled and dated links are untouched; expired = 404', async () => {
  const open = await ok('/orders/' + (await order()).id), disabled = await order(), dated = await order();
  await ok('/orders/' + disabled.id + '/portal', 'POST', { action: 'disable' });
  const datedRow = await ok('/orders/' + dated.id + '/portal', 'POST', { action: 'rotate', days: 3 });
  let p = await ok('/portal/link-policy');
  await status('/portal/link-policy/apply', 409, 'POST', { confirmed: true, limit: 1000 }, admin); // no default yet
  p = await ok('/portal/link-policy', 'PUT', { default_days: 14, version: p.version });
  await status('/portal/link-policy/apply', 403, 'POST', { confirmed: true, limit: 1000 }, operator);
  await status('/portal/link-policy/apply', 422, 'POST', { limit: 1000 });
  const otherBefore = (await pool.query("SELECT count(*)::int n FROM orders WHERE tenant_id<>$1 AND portal_expires_at IS NULL", [open.tenant_id])).rows[0].n;
  let total = 0, r: any;
  do {
    r = await ok('/portal/link-policy/apply', 'POST', { confirmed: true, limit: 1000 });
    total += r.updated;
  } while (r.remaining > 0);
  assert(total >= 1);
  assert.equal((await ok('/portal/link-policy')).links_without_expiry, 0);
  const after = await ok('/orders/' + open.id);
  assert(Math.abs(days(after.portal_expires_at) - 14) < 0.01);
  assert.equal((await ok('/orders/' + disabled.id)).portal_expires_at, null, 'a disabled link is not revived or dated');
  assert.equal((await ok('/orders/' + dated.id)).portal_expires_at, datedRow.portal_expires_at, 'a dated link keeps its date');
  assert.equal((await pool.query("SELECT count(*)::int n FROM orders WHERE tenant_id<>$1 AND portal_expires_at IS NULL", [open.tenant_id])).rows[0].n, otherBefore);
  assert(
    (await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='portal.link_policy.apply' AND tenant_id=$1", [open.tenant_id])).rows[0].n >= 1,
  );
  // A default link that ran out is refused by the portal like any expired link.
  await pool.query("UPDATE orders SET portal_expires_at=now()-interval '1 minute' WHERE id=$1", [open.id]);
  assert.equal((await pub(after.portal_token, '/data')).statusCode, 404);
  await ok('/portal/link-policy', 'PUT', { default_days: null, version: (await ok('/portal/link-policy')).version });
});

// ---------------- COM-005 ----------------
const raw = (h: { from: string; subject: string; inReplyTo?: string; references?: string; id?: string }) =>
  Buffer.from(
    `From: Kupujący <${h.from}>\r\nTo: Sklep <orders@example.test>\r\nMessage-ID: <${h.id ?? randomUUID()}@example.test>\r\nSubject: ${h.subject}\r\n` +
      (h.inReplyTo ? `In-Reply-To: ${h.inReplyTo}\r\n` : '') +
      (h.references ? `References: ${h.references}\r\n` : '') +
      'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nDzień dobry, pytanie o zamówienie.',
  );

test('COM-005: the schedule binds our own Message-ID and an order number from the buyer, leaves the rest, and runs once', async () => {
  const f = await emailInboundFixture(app);
  // An email we sent for f.order (Message-ID <email_messages.id@dynaminds.local>), delivered by the local worker.
  const t = await f.ok('/email/templates', 'POST', { name: 'P253 ' + randomUUID().slice(0, 6), subject: 'Zamówienie {{order_number}}', body: 'Dziękujemy', html: '', client_key: randomUUID() });
  const b = await f.ok('/email/preview', 'POST', { template_id: t.id, template_version: t.version, order_ids: [f.order.id], mode: 'local', client_key: randomUUID() });
  await f.ok('/email/batches/' + b.id + '/queue', 'POST', { confirmed: true });
  await drain();
  const sent = b.items[0].id;
  const second = await f.ok('/orders/' + (await f.ok('/orders', 'POST', { customer_name: 'Drugi kupujący', email: 'order-buyer@example.test', warehouse_id: f.warehouse, items: [{ product_id: f.product.id, quantity: 1 }] }, 201)).id);

  // Only the administrator schedules; the account must be this tenant's.
  await status('/email-inbound/schedules/' + f.account.id, 404, 'PUT', { enabled: true, interval_minutes: 15, auto_bind: true, version: 0 }, admin);
  const s = await f.ok('/email-inbound/schedules/' + f.account.id, 'PUT', { enabled: true, interval_minutes: 15, auto_bind: true, version: 0 });
  assert.equal(s.schedule.enabled, true);
  assert.equal(s.schedule.actor_id, f.user);

  const mails = [
    raw({ from: 'Order-Buyer@example.test', subject: 'Re: Zamówienie', inReplyTo: `<${sent}@dynaminds.local>` }), // bound: in_reply_to from the recipient
    // none: our id only in References of a forwarded thread, answered by a third party (no binding to someone else's order)
    raw({ from: 'third@example.test', subject: 'Fwd: Zamówienie', inReplyTo: '<fwd-1@example.test>', references: `<fwd-1@example.test> <${sent}@dynaminds.local>` }),
    raw({ from: 'ORDER-BUYER@example.test', subject: 'Pytanie ' + second.number }), // bound: subject + buyer address
    raw({ from: 'stranger@example.test', subject: 'Pytanie ' + second.number }), // none: not the buyer's address
    raw({ from: 'order-buyer@example.test', subject: `Dwa: ${f.order.number} i ${second.number}` }), // ambiguous
    raw({ from: 'order-buyer@example.test', subject: 'Pytanie bez numeru', inReplyTo: '<foreign@example.test>' }), // none
  ];
  let calls = 0, uid = 0;
  const acquire = async (a: any) => {
    calls++;
    const ids: string[] = [];
    for (const m of mails) {
      uid++;
      // Every import moves the account cursor and version; the fixture fetch must name the current version.
      f.account = (await f.ok('/email-inbound/accounts')).data.find((x: any) => x.id === f.account.id);
      const p = await normalizedInboundPreview(f, 'x', { raw: m, uid: String(uid), after_uid: uid === 1 ? null : String(uid - 1) });
      const imp = await importInboundEmail(a, p.id, { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true });
      ids.push(...(imp as any).import.message_ids);
    }
    return ids;
  };
  await pool.query('UPDATE inbound253_schedules SET next_run_at=now()-interval \'1 second\' WHERE account_id=$1', [f.account.id]);
  // Two workers at once: the lease lets exactly one run.
  const results = await Promise.all([runInboundSchedule(f.tenant, f.account.id, { acquire }), runInboundSchedule(f.tenant, f.account.id, { acquire })]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((r) => r.ran).sort(), [false, true]);
  const matches = (await pool.query('SELECT outcome,method,order_id,actor_id,candidates FROM inbound253_matches WHERE tenant_id=$1 ORDER BY created_at,message_id', [f.tenant])).rows;
  const byOutcome = (o: string) => matches.filter((m) => m.outcome === o);
  assert.equal(matches.length, 6);
  assert.deepEqual(byOutcome('bound').map((m) => [m.method, m.order_id]).sort(), [['in_reply_to', f.order.id], ['subject_number', second.id]].sort());
  assert.equal(byOutcome('ambiguous').length, 1);
  assert.equal(byOutcome('ambiguous')[0].candidates, 2);
  assert.equal(byOutcome('none').length, 3);
  assert(matches.every((m) => m.actor_id === f.user));
  const msgs = (await f.ok('/email-inbound/messages')).data;
  assert.equal(msgs.filter((m: any) => m.state === 'bound').length, 2);
  assert.equal(msgs.filter((m: any) => m.state === 'unassigned').length, 4, 'the rest waits for a person');
  const core = (await pool.query("SELECT order_id,actor_id FROM customer_messages WHERE tenant_id=$1 AND kind='email'", [f.tenant])).rows;
  assert.deepEqual(core.map((r) => r.order_id).sort(), [f.order.id, second.id].sort());
  const sched = (await f.ok('/email-inbound/schedules')).data.find((x: any) => x.account_id === f.account.id);
  assert.equal(sched.last_outcome, 'fetched');
  assert.equal(sched.last_fetched, 6);
  assert.equal(sched.last_bound, 2);
  assert.equal((Date.parse(sched.next_run_at) - Date.parse(sched.last_run_at)) / 60000, 15, "next run = end of this run + interval");
  assert.equal(sched.lease_until, null);
  assert.equal((await f.ok('/email-inbound/matches')).data.length, 6);
  // Not due: the global scheduler does nothing for this account.
  calls = 0;
  await scheduleInboundPollsDue({ acquire });
  assert.equal(calls, 0);
});

test('COM-005: a schedule stops when its administrator loses access; viewer cannot read schedules', async () => {
  const f = await emailInboundFixture(app);
  await f.ok('/email-inbound/schedules/' + f.account.id, 'PUT', { enabled: true, interval_minutes: 5, auto_bind: false, version: 0 });
  await pool.query("UPDATE inbound253_schedules SET next_run_at=now()-interval '1 second' WHERE account_id=$1", [f.account.id]);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  let calls = 0;
  const r = await runInboundSchedule(f.tenant, f.account.id, { acquire: async () => (calls++, []) });
  assert.equal(r.ran, true);
  assert.equal(calls, 0);
  const row = (await pool.query('SELECT enabled,last_outcome,last_error FROM inbound253_schedules WHERE account_id=$1', [f.account.id])).rows[0];
  assert.deepEqual([row.enabled, row.last_outcome], [false, 'refused']);
  assert.match(row.last_error, /uprawnie/);
  assert.equal((await f.request('/email-inbound/schedules')).statusCode, 403);
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
});

// ---------------- COM-008 ----------------
test('COM-008: connector port, threads without an order, filters, assignment, order link, replies and notes', async () => {
  await status('/channel-inbox/connections', 403, 'POST', { channel: 'allegro', name: 'Allegro 253' }, operator);
  const conn = (await ok('/channel-inbox/connections', 'POST', { channel: 'allegro', name: 'Allegro ' + randomUUID().slice(0, 6) }, admin)).connection;
  const help = (await ok('/channel-inbox/connections', 'POST', { channel: 'helpdesk', name: 'Helpdesk ' + randomUUID().slice(0, 6) })).connection;
  const o = await ok('/orders/' + (await order()).id);
  const T = 'T-' + randomUUID();
  const batch = {
    messages: [
      { external_thread_id: T, external_message_id: 'M1', subject: 'Pytanie o rozmiar', buyer_ref: 'kupujacy_253', body: 'Czy jest rozmiar L?' },
      { external_thread_id: T, external_message_id: 'M2', body: 'Pilne, proszę o odpowiedź' },
      { external_thread_id: 'O-' + randomUUID(), external_message_id: 'M1', subject: 'Zamówienie', buyer_ref: o.email.toUpperCase(), body: 'Gdzie paczka?', order_number: o.number },
      // Someone else's order number from another buyer: the thread stays without an order (a person decides).
      { external_thread_id: 'X-' + randomUUID(), external_message_id: 'M1', subject: 'Cudze zamówienie', buyer_ref: 'intruz@example.test', body: 'To moje zamówienie', order_number: o.number },
    ],
  };
  const first = await ok('/channel-inbox/connections/' + conn.id + '/messages', 'POST', batch);
  assert.deepEqual([first.created, first.duplicates, first.threads], [4, 0, 3]);
  const again = await ok('/channel-inbox/connections/' + conn.id + '/messages', 'POST', batch);
  assert.deepEqual([again.created, again.duplicates], [0, 4], 'the connector may repeat a page');
  await ok('/channel-inbox/connections/' + help.id + '/messages', 'POST', { messages: [{ external_thread_id: 'H-1', external_message_id: 'H-1-1', body: 'Zgłoszenie z helpdesku' }] });
  await status('/channel-inbox/connections/' + conn.id + '/messages', 404, 'POST', batch, other);

  const all = (await ok('/channel-inbox/threads?unlinked=1')).data;
  const pre = all.find((t: any) => t.subject === 'Pytanie o rozmiar');
  assert(pre, 'a question before a purchase is listed');
  assert.equal(pre.order_id, null);
  assert.equal(pre.channel, 'allegro');
  assert.equal(pre.message_count, 2);
  const linked = (await ok('/channel-inbox/threads?channel=allegro')).data.find((t: any) => t.order_id === o.id);
  assert.equal(linked.order_number, o.number, 'order number from the connector links the order');
  const foreign = (await ok('/channel-inbox/threads?unlinked=1')).data.find((t: any) => t.subject === 'Cudze zamówienie');
  assert(foreign, 'an order number from another buyer does not link the order');
  assert.equal((await ok('/orders/' + o.id + '/channel-threads')).data.some((t: any) => t.id === foreign.id), false);
  assert((await ok('/channel-inbox/threads?channel=helpdesk')).data.every((t: any) => t.channel === 'helpdesk'));
  assert.deepEqual((await ok('/channel-inbox/threads', 'GET', undefined, other)).data.filter((t: any) => t.id === pre.id), []);
  await status('/channel-inbox/threads/' + pre.id, 404, 'GET', undefined, other);

  // Assignment and order link with CAS; only admin/operator; assignee must be an eligible member.
  const opId = (await pool.query("SELECT id FROM users WHERE email='operator@demo.local'")).rows[0].id;
  const viewerId = (await pool.query("SELECT id FROM users WHERE email='viewer@demo.local'")).rows[0].id;
  await status('/channel-inbox/threads/' + pre.id, 403, 'PATCH', { version: pre.version, assigned_user_id: opId }, viewer);
  await status('/channel-inbox/threads/' + pre.id, 422, 'PATCH', { version: pre.version, assigned_user_id: viewerId });
  const assigned = (await ok('/channel-inbox/threads/' + pre.id, 'PATCH', { version: pre.version, assigned_user_id: opId }, operator)).thread;
  assert.equal(assigned.assigned_user_id, opId);
  await status('/channel-inbox/threads/' + pre.id, 409, 'PATCH', { version: pre.version, status: 'closed' });
  await status('/channel-inbox/threads/' + pre.id, 404, 'PATCH', { version: assigned.version, order_number: 'NIE-ISTNIEJE-1' });
  const toOrder = (await ok('/channel-inbox/threads/' + pre.id, 'PATCH', { version: assigned.version, order_number: o.number })).thread;
  assert.equal(toOrder.order_id, o.id);
  assert.equal((await ok('/channel-inbox/threads?unlinked=1')).data.some((t: any) => t.id === pre.id), false);
  assert.equal((await ok('/channel-inbox/threads?assigned=me', 'GET', undefined, operator)).data.some((t: any) => t.id === pre.id), true);

  // Reply = pending intent (no connector sends it); note is private; viewer reads without notes and cannot write.
  const key = randomUUID();
  const reply = await ok('/channel-inbox/threads/' + pre.id + '/messages', 'POST', { kind: 'reply', body: 'Tak, rozmiar L jest dostępny.', client_key: key }, operator);
  assert.equal(reply.message.state, 'pending');
  assert.equal((await ok('/channel-inbox/threads/' + pre.id + '/messages', 'POST', { kind: 'reply', body: 'Tak, rozmiar L jest dostępny.', client_key: key }, operator)).message.id, reply.message.id);
  await ok('/channel-inbox/threads/' + pre.id + '/messages', 'POST', { kind: 'note', body: 'Sprawdzić stan magazynu', client_key: randomUUID() });
  await status('/channel-inbox/threads/' + pre.id + '/messages', 403, 'POST', { kind: 'note', body: 'x', client_key: randomUUID() }, viewer);
  const full = await ok('/channel-inbox/threads/' + pre.id);
  assert.deepEqual(full.messages.map((m: any) => m.kind), ['inbound', 'inbound', 'reply', 'note']);
  assert.equal(full.thread.pending_replies, 1);
  const seen = await ok('/channel-inbox/threads/' + pre.id, 'GET', undefined, viewer);
  assert.deepEqual(seen.messages.map((m: any) => m.kind), ['inbound', 'inbound', 'reply']);
  // Closing needs the current version (a new inbound message from the connector reopens the thread).
  const closed = (await ok('/channel-inbox/threads/' + pre.id, 'PATCH', { version: full.thread.version, status: 'closed' })).thread;
  assert.equal(closed.status, 'closed');
  assert.equal((await pool.query('SELECT count(*)::int n FROM channel253_messages WHERE thread_id=$1', [pre.id])).rows[0].n, 4);
  // The order card shows the channel thread.
  assert((await ok('/orders/' + o.id + '/channel-threads')).data.some((t: any) => t.id === pre.id));
});

test('COM-008: paging keeps every thread of one connector page (same microsecond) exactly once', async () => {
  const conn = (await ok('/channel-inbox/connections', 'POST', { channel: 'ebay', name: 'eBay ' + randomUUID().slice(0, 6) })).connection;
  const run = randomUUID().slice(0, 8);
  const messages = Array.from({ length: 51 }, (_, i) => ({ external_thread_id: run + '-' + i, external_message_id: 'm', body: 'Pytanie ' + i }));
  assert.equal((await ok('/channel-inbox/connections/' + conn.id + '/messages', 'POST', { messages: messages.slice(0, 50) })).created, 50);
  assert.equal((await ok('/channel-inbox/connections/' + conn.id + '/messages', 'POST', { messages: messages.slice(50) })).created, 1);
  // All threads share one microsecond timestamp; the page break falls inside that group.
  await pool.query('UPDATE channel253_threads SET last_message_at=$2 WHERE connection_id=$1', [conn.id, '2026-10-27T10:00:00.123456Z']);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i++) {
    const page: any = await ok('/channel-inbox/threads?channel=ebay' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    seen.push(...page.data.filter((t: any) => t.connection_id === conn.id).map((t: any) => t.id));
    cursor = page.meta.cursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 51);
  assert.equal(new Set(seen).size, 51);
});
