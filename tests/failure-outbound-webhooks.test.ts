/** S4 failure tests of outbound webhooks (RES-13) and of the worker restart path (RES-21), through the
 * real tick(): claim, reaper and fencing. Delivery is at-least-once with a stable X-Dyna-Delivery-ID, so
 * "zero double effects" means: the receiver sees the same delivery id, event id and body on every retry
 * (each with a fresh valid signature), deduplicates it to one effect, and a stale worker never overwrites
 * the state written by the restarted one.
 * Run on a fresh clone dynaminds_s4_20261025_NN (tests/failure-helpers.ts). */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { tick } from '../server/worker';
import { verifyWebhook } from '../server/outbound-webhooks';
import type { Transport } from '../server/integrations';
import { assertS4Clone, quiesceJobs, ageLease, jobRow, deferred, until, relaxPoolTimeouts } from './failure-helpers';

assertS4Clone();
relaxPoolTimeouts();
// A local-mode delivery without a test transport would go to 127.0.0.1:$PORT; never let that be Main (4100).
process.env.PORT = '59997';
let app: Awaited<ReturnType<typeof buildApp>>;
const password = 'ResilienceS4!2026';
const req = (url: string, method: any = 'GET', payload?: any, cookie?: string) =>
  app.inject({ url, method, payload, headers: cookie ? { cookie } : {} });
const cookieOf = (r: any) => r.headers['set-cookie'].toString().split(';')[0];
type Owner = { cookie: string; user: { tenant_id: string } };

before(async () => {
  app = await buildApp();
  await quiesceJobs();
});
beforeEach(async () => {
  await quiesceJobs();
});
after(async () => {
  await app.close();
  await pool.end();
});

async function owner(): Promise<Owner> {
  const r = await req('/api/auth/signup', 'POST', {
    name: 'QA S4',
    email: randomUUID() + '@example.test',
    password,
    organization: { name: 'QA S4 ' + randomUUID() },
  });
  assert.equal(r.statusCode, 201, r.body);
  return { cookie: cookieOf(r), user: r.json().user };
}
async function hook(a: Owner, mode: 'local' | 'https' = 'local') {
  const r = await req(
    '/api/developer/webhooks',
    'POST',
    { name: 'S4 webhook', events: ['order.created'], mode, ...(mode === 'https' ? { url: 'https://example.org/s4-callback' } : {}) },
    a.cookie,
  );
  assert.equal(r.statusCode, 201, r.body);
  const s = r.json();
  const e = await req('/api/developer/webhooks/' + s.id + '/enable', 'POST', { confirm_destination: mode === 'local' ? 'local' : s.url }, a.cookie);
  assert.equal(e.statusCode, 200, e.body);
  return s as { id: string; secret: string; url: string | null };
}
/** One order.created event → one outbound delivery with its job. */
async function deliveryFor(a: Owner) {
  const w = (await req('/api/warehouses', 'GET', undefined, a.cookie)).json().data[0].id;
  const p = await req('/api/products', 'POST', { name: 'S4 produkt', sku: 'S4-' + randomUUID(), price: 100, warehouse_id: w, quantity: 10 }, a.cookie);
  assert.equal(p.statusCode, 201, p.body);
  const o = await req('/api/orders', 'POST', { customer_name: 'S4 Kupujący', email: 'buyer@example.test', warehouse_id: w, items: [{ product_id: p.json().id, quantity: 1 }] }, a.cookie);
  assert.equal(o.statusCode, 201, o.body);
  const rows = (await pool.query('SELECT d.* FROM outbound_deliveries d WHERE d.tenant_id=$1 ORDER BY d.created_at DESC', [a.user.tenant_id])).rows;
  assert.equal(rows.length, 1);
  await quiesceJobs([rows[0].job_id]);
  return rows[0] as { id: string; job_id: string; event_id: string };
}
const delivery = async (id: string) => (await pool.query('SELECT * FROM outbound_deliveries WHERE id=$1', [id])).rows[0];
const inbox = async (id: string) => Number((await pool.query('SELECT count(*) n FROM local_webhook_inbox WHERE delivery_id=$1', [id])).rows[0].n);
type Call = { url: string; headers: Record<string, string>; body: string };
const recorded = (init: RequestInit): Call => ({ url: '', headers: init.headers as Record<string, string>, body: String(init.body) });
/** The app's own local receiver (POST /api/local-webhooks/:id) through injection. */
const localReceiver: Transport = async (url, init) => {
  const r = await app.inject({ method: 'POST', url: new URL(url).pathname, payload: String(init.body), headers: init.headers as any });
  return new Response(r.body, { status: r.statusCode });
};
const tickWith = (transport: Transport) => tick({ transport });

test('restart w trakcie HTTP: odbiorca przyjął, ACK utracony; po wygaśnięciu dzierżawy jedna dostawa, stary worker niczego nie nadpisuje', async () => {
  const a = await owner(),
    s = await hook(a),
    d = await deliveryFor(a);
  const calls: Call[] = [],
    oldAnswer = deferred<Response>();
  // Old process: the receiver accepts, then the process dies before the answer is read.
  const oldWorker = tickWith(async (url, init) => {
    assert.equal((await localReceiver(url, init)).status, 202);
    calls.push({ ...recorded(init), url });
    return oldAnswer.promise;
  });
  await until(() => calls.length === 1);
  assert.equal(await inbox(d.id), 1);
  const held = await jobRow(d.job_id);
  assert.deepEqual([held.state, held.attempts], ['running', 1]);
  // A live lease (< 2 min) is not taken over: no second process sends while the first may still answer.
  let early = 0;
  assert.equal(await tickWith(async () => { early++; return new Response(null, { status: 200 }); }), false);
  assert.equal(early, 0);
  // Restart: the lease is older than the reaper threshold; the new process sends the same delivery again.
  await ageLease(d.job_id);
  assert.equal(await tickWith(async (url, init) => { calls.push({ ...recorded(init), url }); return localReceiver(url, init); }), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.headers['X-Dyna-Delivery-ID'], d.id);
  assert.equal(calls[1]!.headers['X-Dyna-Event-ID'], calls[0]!.headers['X-Dyna-Event-ID']);
  assert.equal(calls[1]!.body, calls[0]!.body);
  for (const c of calls) verifyWebhook(s.secret, Buffer.from(c.body), c.headers['X-Dyna-Timestamp']!, c.headers['X-Dyna-Signature']!);
  assert.equal(await inbox(d.id), 1, 'the receiver keeps one effect');
  assert.equal((await delivery(d.id)).state, 'delivered');
  const done = await jobRow(d.job_id);
  assert.deepEqual([done.state, done.attempts, done.lease_token], ['done', 2, null]);
  // The old process "wakes up" with its 200: its lease is gone, nothing is written, nothing is sent.
  oldAnswer.resolve(new Response(null, { status: 200 }));
  assert.equal(await oldWorker, true);
  assert.equal((await delivery(d.id)).state, 'delivered');
  assert.equal((await jobRow(d.job_id)).state, 'done');
  assert.equal(calls.length, 2);
  // Nothing is left to claim.
  assert.equal(await tickWith(async () => assert.fail('no further send')), false);
});

test('stary worker kończy błędem po przejęciu: fence blokuje failOutbound, stan nowego workera zostaje', async () => {
  const a = await owner();
  await hook(a);
  const d = await deliveryFor(a);
  const oldAnswer = deferred<Response>();
  let sent = 0;
  const oldWorker = tickWith(async () => { sent++; return oldAnswer.promise; });
  await until(() => sent === 1);
  await ageLease(d.job_id);
  assert.equal(await tickWith(localReceiver), true);
  assert.equal((await delivery(d.id)).state, 'delivered');
  oldAnswer.reject(new Error('socket hang up'));
  assert.equal(await oldWorker, true);
  const j = await jobRow(d.job_id);
  assert.deepEqual([j.state, j.error, (await delivery(d.id)).state], ['done', null, 'delivered']);
});

test('timeout zewnętrznego odbiorcy po przyjęciu: retry z tym samym Delivery-ID, nowym ważnym podpisem, backoff 30 s; jeden skutek u odbiorcy', async () => {
  const a = await owner(),
    s = await hook(a, 'https'),
    d = await deliveryFor(a);
  // External receiver that deduplicates by X-Dyna-Delivery-ID, as the contract asks of every receiver.
  const effects = new Map<string, number>(),
    seen: Call[] = [];
  let timeoutAfterAccept = true;
  const external: Transport = async (url, init) => {
    assert.equal(url, 'https://example.org/s4-callback');
    const c = { ...recorded(init), url };
    verifyWebhook(s.secret, Buffer.from(c.body), c.headers['X-Dyna-Timestamp']!, c.headers['X-Dyna-Signature']!);
    seen.push(c);
    const id = c.headers['X-Dyna-Delivery-ID']!;
    if (!effects.has(id)) effects.set(id, 1);
    if (timeoutAfterAccept) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response(null, { status: 204 });
  };
  assert.equal(await tickWith(external), true);
  let j = await jobRow(d.job_id);
  assert.deepEqual([j.state, j.attempts, (await delivery(d.id)).state], ['pending', 1, 'queued']);
  assert(j.delay > 25 && j.delay <= 30, 'first retry after 30 s, got ' + j.delay);
  assert.match(j.error, /Brak odpowiedzi odbiorcy webhooka/);
  // Not due yet: no early resend.
  assert.equal(await tickWith(external), false);
  assert.equal(seen.length, 1);
  await pool.query('UPDATE jobs SET run_at=now() WHERE id=$1', [d.job_id]);
  await new Promise((r) => setTimeout(r, 1100)); // the retry carries a new timestamp, so a new signature
  timeoutAfterAccept = false;
  assert.equal(await tickWith(external), true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.headers['X-Dyna-Delivery-ID'], seen[1]!.headers['X-Dyna-Delivery-ID']);
  assert.equal(seen[0]!.body, seen[1]!.body);
  assert.notEqual(seen[0]!.headers['X-Dyna-Signature'], seen[1]!.headers['X-Dyna-Signature']);
  assert.equal(effects.size, 1);
  j = await jobRow(d.job_id);
  assert.deepEqual([j.state, j.attempts, (await delivery(d.id)).state, (await delivery(d.id)).response_status], ['done', 2, 'delivered', 204]);
});

test('backoff 30·2^(n-1) albo Retry-After, wyczerpanie 8 prób kończy dostawę bez dalszych wysyłek', async () => {
  const a = await owner();
  await hook(a);
  const d = await deliveryFor(a);
  let sent = 0;
  const failing: Transport = async () => { sent++; return new Response('upstream secret', { status: 503 }); };
  for (const expected of [30, 60, 120]) {
    assert.equal(await tickWith(failing), true);
    const j = await jobRow(d.job_id);
    assert.equal(j.state, 'pending');
    assert(j.delay > expected - 5 && j.delay <= expected, `attempt ${j.attempts}: delay ${j.delay}, expected ${expected}`);
    await pool.query('UPDATE jobs SET run_at=now() WHERE id=$1', [d.job_id]);
  }
  // Retry-After longer than the backoff wins.
  assert.equal(await tickWith(async () => { sent++; return new Response(null, { status: 429, headers: { 'retry-after': '900' } }); }), true);
  assert((await jobRow(d.job_id)).delay > 890);
  assert.equal((await delivery(d.id)).response_status, 429);
  assert(!JSON.stringify(await delivery(d.id)).includes('upstream secret'));
  // Last attempt (8 of 8) fails → failed, no further send.
  await pool.query('UPDATE jobs SET attempts=7,run_at=now() WHERE id=$1', [d.job_id]);
  assert.equal(await tickWith(failing), true);
  const j = await jobRow(d.job_id);
  assert.deepEqual([j.state, j.attempts, (await delivery(d.id)).state], ['failed', 8, 'failed']);
  assert.equal(await tickWith(failing), false);
  assert.equal(sent, 5);
});

test('reaper: wygasła dzierżawa ostatniej próby oznacza dostawę jako failed w tym samym cyklu, bez wysyłki', async () => {
  const a = await owner();
  await hook(a);
  const d = await deliveryFor(a);
  await pool.query("UPDATE jobs SET state='running',attempts=max_attempts,lease_token=$2,locked_at=now()-interval '3 minutes' WHERE id=$1", [d.job_id, randomUUID()]);
  assert.equal(await tickWith(async () => assert.fail('no send after the last attempt')), false);
  const j = await jobRow(d.job_id),
    row = await delivery(d.id);
  assert.deepEqual([j.state, j.lease_token, row.state], ['failed', null, 'failed']);
  assert.match(row.error, /Dzierżawa dostawy wygasła/);
});

test('dwa procesy naraz (dwa tick równolegle): zadanie przejęte raz, jedna wysyłka', async () => {
  const a = await owner();
  await hook(a);
  const d = await deliveryFor(a);
  let sent = 0;
  const slow: Transport = async (url, init) => {
    sent++;
    await new Promise((r) => setTimeout(r, 200));
    return localReceiver(url, init);
  };
  const results = await Promise.all([tickWith(slow), tickWith(slow), tickWith(slow)]);
  assert.deepEqual(results.filter(Boolean).length, 1);
  assert.equal(sent, 1);
  assert.equal(await inbox(d.id), 1);
  assert.deepEqual([(await jobRow(d.job_id)).attempts, (await delivery(d.id)).state], [1, 'delivered']);
});

test('restart po COMMIT przejęcia, przed wysyłką: po wygaśnięciu dzierżawy dokładnie jedna wysyłka', async () => {
  const a = await owner();
  await hook(a);
  const d = await deliveryFor(a);
  // The claim committed (state running, attempt 1) and the process died before any HTTP.
  await pool.query("UPDATE jobs SET state='running',attempts=1,lease_token=$2,locked_at=now()-interval '3 minutes' WHERE id=$1", [d.job_id, randomUUID()]);
  let sent = 0;
  assert.equal(await tickWith(async (u, i) => { sent++; return localReceiver(u, i); }), true);
  assert.equal(sent, 1);
  assert.equal(await inbox(d.id), 1);
  assert.deepEqual([(await jobRow(d.job_id)).attempts, (await delivery(d.id)).state], [2, 'delivered']);
});
