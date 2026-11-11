/** A second reply of one request must never kill the process.
 * Load run full-20261029-02 (docs/scale/LOAD-TEST-FULL-20261029-B.md §4.1): the release app died on an
 * unhandled ERR_HTTP_HEADERS_SENT. The callback-hook wrapper of the request lifetime moved done() of
 * onSend (@fastify/cookie) to a microtask, and the app error handler's Promise (runOrdinaryRequestError)
 * resolved to undefined while the error reply was still running (invoice-overflow230.ts adds an app-level
 * async preSerialization hook), so Fastify's wrap-thenable sent a second, empty reply; the throwing
 * writeHead then rejected a Promise nobody handled.
 * Real Fastify + cookie/rate-limit hooks, the release reply-warning sink and a real socket; no PostgreSQL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { createOrdinaryRequestLifetime, installOrdinaryRequestLifetime, inspectOrdinaryRequests,
  hasOrdinaryRequestAdmission, runOrdinaryRequestError, type OrdinaryRequestLifetime } from '../server/ordinary-request-lifetime';
import { createReplyWarningLog, type ReplyWarningLog } from '../server/reply-warning-log';
import { Problem } from '../server/errors';

const sleep = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
type Harness = { app: FastifyInstance; lifetime: OrdinaryRequestLifetime; port: number; warnings: ReplyWarningLog; lines: Array<Record<string, unknown>>;
  handlerRuns: () => number; release: () => void };

/** fixedErrorHandler: server/app.ts after this fix (the tracked Promise resolves to the reply); otherwise
 * the shape before it. slowPreSerialization: an async preSerialization hook that outlasts the handler. */
async function harness(o: { fixedErrorHandler: boolean; slowPreSerialization: boolean }): Promise<Harness> {
  const lifetime = createOrdinaryRequestLifetime();
  const lines: Array<Record<string, unknown>> = [];
  const warnings = createReplyWarningLog(line => { lines.push(JSON.parse(line)); });
  const app = Fastify({ loggerInstance: warnings.loggerInstance, childLoggerFactory: warnings.childLoggerFactory });
  installOrdinaryRequestLifetime(app, lifetime);
  await app.register(cookie);
  await app.register(rateLimit, { max: 100000, timeWindow: '1 minute' });
  app.setErrorHandler((err, req, reply) => {
    const respond = () => {
      const status = err instanceof Problem ? err.status : 500;
      reply.code(status).type('application/problem+json').send({ status, detail: (err as Error).message });
    };
    if (!hasOrdinaryRequestAdmission(lifetime, req)) return respond();
    return o.fixedErrorHandler ? runOrdinaryRequestError(lifetime, req, respond).then(() => reply) : runOrdinaryRequestError(lifetime, req, respond);
  });
  app.addHook('onRequest', async (_req, reply) => { reply.header('X-Content-Type-Options', 'nosniff'); });
  // Same shape as invoice-overflow230.ts: an app-level async preSerialization hook.
  app.addHook('preSerialization', async (_req, _reply, payload) => {
    if (o.slowPreSerialization) await new Promise<void>(yes => setImmediate(yes));
    return payload;
  });
  // Same shape as the invoice-overflow230.ts preHandler and the local-invoice /issue alias: an app-level
  // async preHandler that answers the request itself with return reply.send() in front of a native route.
  let gate!: () => void; let opened = new Promise<void>(yes => { gate = yes; }), runs = 0;
  const release = () => { gate(); opened = new Promise<void>(yes => { gate = yes; }); };
  app.addHook('preHandler', async (req, reply) => {
    if (req.routeOptions.url !== '/answered') return;
    await opened;
    reply.code(201);
    return reply.send({ answered: true });
  });
  app.post('/answered', async () => { runs++; return { native: true }; });
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.post('/refused', async () => { throw new Problem(409, 'Zamówienie ma już fakturę'); });
  app.get('/refused-sync', () => { throw new Problem(409, 'Zamówienie ma już fakturę'); });
  // A handler that replies twice itself (the "forgot return reply" footgun).
  app.get('/twice', async (_req, reply) => { reply.send({ first: true }); reply.send({ second: true }); });
  // A callback onSend hook that continues later: its done runs outside Fastify's call, so the second
  // reply's writeHead throws where no Fastify try/catch is.
  app.get('/twice-late', {
    onSend: (_req, _reply, payload, done) => { setImmediate(() => done(null, payload)); },
  }, (_req, reply) => { reply.send({ first: true }); reply.send({ second: true }); });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, lifetime, port: (app.server.address() as { port: number }).port, warnings, lines, handlerRuns: () => runs, release };
}

function call(port: number, method: string, path: string) {
  return new Promise<{ status: number; body: string }>((yes, no) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false }, res => {
      let body = ''; res.on('data', d => { body += d; }); res.on('end', () => yes({ status: res.statusCode!, body }));
    });
    req.on('error', no); req.end();
  });
}
async function settled(lifetime: OrdinaryRequestLifetime) {
  for (let i = 0; i < 50 && inspectOrdinaryRequests(lifetime).active_requests > 0; i++) await sleep(20);
  return inspectOrdinaryRequests(lifetime);
}
/** Collects process-level unhandled rejections while fn runs (Node 22 would end the process on them). */
async function unhandledDuring(fn: () => Promise<void>) {
  const seen: unknown[] = [];
  const spy = (reason: unknown) => { seen.push(reason); };
  const prior = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', spy);
  try { await fn(); await sleep(50); } finally {
    process.removeListener('unhandledRejection', spy);
    for (const l of prior) process.on('unhandledRejection', l as (...args: unknown[]) => void);
  }
  return seen.map(e => (e as { code?: string }).code ?? String(e));
}
const problems = (port: number, n: number) =>
  Promise.all(Array.from({ length: n }, (_, i) => call(port, i % 2 ? 'POST' : 'GET', i % 2 ? '/refused' : '/refused-sync')));

test('error replies of the pre-fix error handler shape leave no unhandled rejection and keep their body', { timeout: 15000 }, async () => {
  const h = await harness({ fixedErrorHandler: false, slowPreSerialization: false });
  try {
    let replies: Array<{ status: number; body: string }> = [];
    assert.deepEqual(await unhandledDuring(async () => { replies = await problems(h.port, 20); }), []);
    for (const r of replies) { assert.equal(r.status, 409); assert.equal(JSON.parse(r.body).detail, 'Zamówienie ma już fakturę'); }
    const after = await settled(h.lifetime);
    assert.equal(after.active_requests, 0);
    assert.equal(after.active_tasks, 0);
    assert.equal(after.late_hook_failures, 0);
    assert.equal((await call(h.port, 'GET', '/api/health')).status, 200);
  } finally { await h.app.close(); }
});

test('an error handler resolving to undefined during a slow preSerialization sends a second, empty reply; resolving to the reply does not', { timeout: 15000 }, async () => {
  for (const fixedErrorHandler of [false, true]) {
    const h = await harness({ fixedErrorHandler, slowPreSerialization: true });
    try {
      let replies: Array<{ status: number; body: string }> = [];
      assert.deepEqual(await unhandledDuring(async () => { replies = await problems(h.port, 10); }), []);
      const counts = h.warnings.counts();
      if (!fixedErrorHandler) {
        // The defect the error handler fix removes: wrap-thenable's second reply wins, the client gets no body.
        assert(replies.some(r => r.body === ''), JSON.stringify(replies));
        assert(counts.FST_ERR_REP_ALREADY_SENT + counts.ERR_HTTP_HEADERS_SENT > 0, JSON.stringify(counts));
      } else {
        for (const r of replies) { assert.equal(r.status, 409); assert.equal(JSON.parse(r.body).detail, 'Zamówienie ma już fakturę'); }
        assert.deepEqual(counts, { FST_ERR_REP_ALREADY_SENT: 0, ERR_HTTP_HEADERS_SENT: 0, FST_REPLY_SENT_PROMISE_ERROR: 0, ORDINARY_LATE_HOOK_FAILURE: 0 });
        assert.deepEqual(h.lines, []);
      }
      const after = await settled(h.lifetime);
      assert.equal(after.active_requests, 0);
      assert.equal(after.active_errors, 0);
      assert.equal((await call(h.port, 'GET', '/api/health')).status, 200);
    } finally { await h.app.close(); }
  }
});

test('a route that replies twice gets the first reply; the throwing writeHead goes to Fastify\'s error path and is logged without the query', { timeout: 15000 }, async () => {
  const h = await harness({ fixedErrorHandler: true, slowPreSerialization: false });
  try {
    let reply: { status: number; body: string } | undefined;
    assert.deepEqual(await unhandledDuring(async () => { reply = await call(h.port, 'GET', '/twice?token=sekret-zapytania'); }), []);
    assert.equal(reply!.status, 200);
    assert.deepEqual(JSON.parse(reply!.body), { first: true });
    // Both replies pass the async preSerialization hook; the second reaches writeHead (Fastify warns), its throw
    // reaches Fastify's try/catch around the onSend hook and the error reply is refused as already sent.
    assert.deepEqual(h.lines, [
      { status: 'ORDINARY_HTTP_REPLY_WARNING', code: 'ERR_HTTP_HEADERS_SENT', method: 'GET', path: '/twice' },
      { status: 'ORDINARY_HTTP_REPLY_WARNING', code: 'FST_ERR_REP_ALREADY_SENT', method: 'GET', path: '/twice' },
    ]);
    assert.equal(inspectOrdinaryRequests(h.lifetime).late_hook_failures, 0);
    const after = await settled(h.lifetime);
    assert.equal(after.active_requests, 0);
    assert.equal((await call(h.port, 'GET', '/api/health')).status, 200);
  } finally { await h.app.close(); }
});

test('a callback hook whose late done throws is counted and logged; the process keeps serving', { timeout: 15000 }, async () => {
  const h = await harness({ fixedErrorHandler: true, slowPreSerialization: false });
  try {
    let reply: { status: number; body: string } | undefined;
    assert.deepEqual(await unhandledDuring(async () => { reply = await call(h.port, 'GET', '/twice-late'); }), []);
    assert.equal(reply!.status, 200);
    assert.deepEqual(JSON.parse(reply!.body), { first: true });
    const after = await settled(h.lifetime);
    assert.equal(after.late_hook_failures, 1);
    assert.equal(after.active_requests, 0);
    assert.equal(after.active_tasks, 0);
    assert.equal(h.warnings.counts().ORDINARY_LATE_HOOK_FAILURE, 1);
    assert(h.lines.some(l => l.code === 'ORDINARY_LATE_HOOK_FAILURE' && l.cause === 'ERR_HTTP_HEADERS_SENT' && l.path === '/twice-late'), JSON.stringify(h.lines));
    assert.equal((await call(h.port, 'GET', '/api/health')).status, 200);
  } finally { await h.app.close(); }
});

test('a preHandler that answers the request itself replies once and the native route never runs, also after a client abort', { timeout: 15000 }, async () => {
  const h = await harness({ fixedErrorHandler: true, slowPreSerialization: true });
  try {
    let reply: { status: number; body: string } | undefined;
    const unhandled = await unhandledDuring(async () => {
      const answered = call(h.port, 'POST', '/answered');
      await sleep(30); h.release();
      reply = await answered;
      // The client gives up while the preHandler still works (the load driver's 10 s timeout).
      const req = http.request({ host: '127.0.0.1', port: h.port, path: '/answered', method: 'POST', agent: false });
      req.on('error', () => {}); req.end();
      await sleep(50); req.destroy(); await sleep(50);
      h.release();
      await settled(h.lifetime);
    });
    assert.deepEqual(unhandled, []);
    assert.equal(reply!.status, 201);
    assert.deepEqual(JSON.parse(reply!.body), { answered: true });
    assert.equal(h.handlerRuns(), 0, 'the native route ran behind a preHandler that had answered');
    const after = await settled(h.lifetime);
    assert.equal(after.active_requests, 0);
    assert.equal(after.active_tasks, 0);
    assert.equal(after.late_hook_failures, 0);
    assert.equal((await call(h.port, 'GET', '/api/health')).status, 200);
  } finally { await h.app.close(); }
});
