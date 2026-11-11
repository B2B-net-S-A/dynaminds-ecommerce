/** The release app (buildApp with the ordinary request lifetime, logging:false) on a disposable clone
 * dynaminds_crash29_20261029_NN migrated to HEAD, over a real socket: an error response of an admitted request
 * (404/400 Problem through setErrorHandler, as the 409 of POST /api/invoice230/orders/:id/previews before the
 * crash of load run full-20261029-02) is sent once, with its JSON body, and leaves no unhandled rejection;
 * /api/health reports zero second replies. With 230 installed invoice-overflow230.ts adds an app-level async
 * preSerialization hook, so the error reply is still running when the error handler's Promise resolves. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { createOrdinaryRequestLifetime, inspectOrdinaryRequests } from '../server/ordinary-request-lifetime';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_crash29_20261029_[0-9]{2}$/);
const sleep = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
const lifetime = createOrdinaryRequestLifetime();
let app: Awaited<ReturnType<typeof buildApp>>, origin = '';
const unhandled: unknown[] = [];
const spy = (reason: unknown) => { unhandled.push(reason); };

before(async () => {
  await migrate();
  process.on('unhandledRejection', spy);
  app = await buildApp({ ordinaryRequestLifetime: lifetime });
  await app.listen({ host: '127.0.0.1', port: 0 });
  origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
after(async () => {
  process.removeListener('unhandledRejection', spy);
  await app?.close();
  await pool.end();
});

test('error replies of admitted requests are sent once with their body; nothing is left unhandled', { timeout: 60000 }, async () => {
  assert.equal((await pool.query("SELECT to_regclass('public.invoice230_previews') IS NOT NULL ok")).rows[0].ok, true, '230 installed on the clone');
  const signup = await fetch(origin + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: randomUUID() + '@example.test', name: 'QA crash29', password: 'Crash29!20261029', organization: { name: 'QA crash29 ' + randomUUID().slice(0, 8) } }) });
  assert.equal(signup.status, 201, await signup.clone().text());
  const cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
  const calls = Array.from({ length: 24 }, (_, i) => i % 3 === 0
    ? fetch(`${origin}/api/orders/${randomUUID()}`, { headers: { cookie } })
    : fetch(`${origin}/api/invoice230/orders/${randomUUID()}/previews`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }));
  const replies = await Promise.all(calls.map(async p => { const r = await p; return { status: r.status, body: await r.text() }; }));
  await sleep(100);
  assert.deepEqual(unhandled.map(e => (e as { code?: string }).code ?? String(e)), []);
  for (const r of replies) {
    assert(r.status >= 400 && r.status < 500, `${r.status} ${r.body}`);
    const problem = JSON.parse(r.body);
    assert.equal(problem.status, r.status, r.body);
    assert.equal(typeof problem.detail, 'string');
  }
  for (let i = 0; i < 50 && inspectOrdinaryRequests(lifetime).active_requests > 0; i++) await sleep(20);
  const health = await (await fetch(origin + '/api/health')).json();
  assert.equal(health.ordinary_requests.late_hook_failures, 0);
  assert.deepEqual(health.reply_warnings, { FST_ERR_REP_ALREADY_SENT: 0, ERR_HTTP_HEADERS_SENT: 0, FST_REPLY_SENT_PROMISE_ERROR: 0, ORDINARY_LATE_HOOK_FAILURE: 0 });
});
