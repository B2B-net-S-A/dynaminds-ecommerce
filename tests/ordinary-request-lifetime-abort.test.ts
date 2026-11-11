/** Client abort / timeout must not keep an ordinary request slot after its work ended.
 * Load run full-20261028-01: clients gave up after 10 s, each abandoned request kept
 * its slot forever and after ~128 of them every response (also /api/health) was 503.
 * Real Fastify + cookie/rate-limit hooks and a real socket; no PostgreSQL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { createOrdinaryRequestLifetime, installOrdinaryRequestLifetime, inspectOrdinaryRequests,
  hasOrdinaryRequestAdmission, runOrdinaryRequestError, beginOrdinaryShutdown, drainOrdinaryRequests,
  type OrdinaryRequestLifetime } from '../server/ordinary-request-lifetime';
import { Problem } from '../server/errors';

const sleep = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
type Harness = { app: FastifyInstance; lifetime: OrdinaryRequestLifetime; port: number; release: () => void };

async function harness(): Promise<Harness> {
  const lifetime = createOrdinaryRequestLifetime();
  const app = Fastify({ logger: false });
  installOrdinaryRequestLifetime(app, lifetime);
  await app.register(cookie);
  await app.register(rateLimit, { max: 100000, timeWindow: '1 minute' });
  // Same shape as server/app.ts setErrorHandler.
  app.setErrorHandler((err, req, reply) => {
    const respond = () => {
      const status = err instanceof Problem ? err.status : 500;
      reply.code(status).type('application/problem+json').send({ status, detail: (err as Error).message,
        ...(err instanceof Problem && err.code ? { code: err.code } : {}) });
    };
    return hasOrdinaryRequestAdmission(lifetime, req) ? runOrdinaryRequestError(lifetime, req, respond) : respond();
  });
  app.addHook('onRequest', async (_req, reply) => { reply.header('X-Content-Type-Options', 'nosniff'); });
  app.addHook('onSend', async (_req, _reply, payload) => payload);
  let gate!: () => void; let opened = new Promise<void>(yes => { gate = yes; });
  const release = () => { gate(); opened = new Promise<void>(yes => { gate = yes; }); };
  app.get('/api/health', async () => ({ status: 'ok' }));
  // Stand-ins for a slow transaction that commits, or ends with statement timeout (code-less Error -> 500).
  app.get('/slow-ok', async () => { await opened; return { ok: true }; });
  app.get('/slow-fail', async () => { await opened; throw new Error('canceling statement due to statement timeout'); });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, lifetime, port: (app.server.address() as { port: number }).port, release };
}

/** Client gives up like the load driver after its timeout: destroys the socket. */
function abandoned(port: number, path: string, afterMs: number) {
  return new Promise<void>(yes => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false });
    req.on('error', () => {});
    // The server sees the close well before the handler ends (10 s client timeout vs. a later commit/timeout).
    setTimeout(() => { req.destroy(); setTimeout(yes, 50); }, afterMs);
  });
}
function get(port: number, path: string) {
  return new Promise<{ status: number; body: string }>((yes, no) => {
    http.get({ host: '127.0.0.1', port, path, agent: false }, res => {
      let body = ''; res.on('data', d => { body += d; }); res.on('end', () => yes({ status: res.statusCode!, body }));
    }).on('error', no);
  });
}
async function settled(lifetime: OrdinaryRequestLifetime) {
  for (let i = 0; i < 50 && inspectOrdinaryRequests(lifetime).active_requests > 0; i++) await sleep(20);
  return inspectOrdinaryRequests(lifetime);
}

for (const path of ['/slow-ok', '/slow-fail']) {
  test(`abandoned ${path} keeps its slot while work runs and frees it when work ends`, { timeout: 15000 }, async () => {
    const h = await harness();
    try {
      await Promise.all(Array.from({ length: 5 }, () => abandoned(h.port, path, 100)));
      // A socket event alone cannot finish active work: the slot stays until the handler ends.
      assert.equal(inspectOrdinaryRequests(h.lifetime).active_requests, 5);
      h.release();
      const after = await settled(h.lifetime);
      assert.equal(after.active_requests, 0, 'abandoned request kept its slot after its work ended');
      assert.equal(after.active_tasks, 0);
      assert.equal(after.active_errors, 0);
    } finally { h.release(); await h.app.close(); }
  });
}

test('abandoned requests do not accumulate into a 503 collapse of /api/health', { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    // More abandoned requests over time than ACTIVE_REQUESTS=128, never more than 10 at once.
    for (let round = 0; round < 14; round++) {
      await Promise.all(Array.from({ length: 10 }, () => abandoned(h.port, round % 2 ? '/slow-fail' : '/slow-ok', 100)));
      assert.equal(inspectOrdinaryRequests(h.lifetime).active_requests, 10);
      h.release();
      await settled(h.lifetime);
    }
    const counters = inspectOrdinaryRequests(h.lifetime);
    assert.equal(counters.active_requests, 0);
    assert.equal(counters.refused_admissions, 0);
    assert.equal(counters.active_requests_limit, 128);
    const health = await get(h.port, '/api/health');
    assert.equal(health.status, 200, health.body);
  } finally { h.release(); await h.app.close(); }
});

test('shutdown drain still waits for abandoned work and then seals', { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    await abandoned(h.port, '/slow-fail', 100);
    beginOrdinaryShutdown(h.lifetime);
    let drained = false;
    const drain = drainOrdinaryRequests(h.lifetime).then(state => { drained = true; return state; });
    await sleep(50);
    assert.equal(drained, false, 'drain finished while the abandoned handler was still running');
    h.release();
    const state = await drain;
    assert.equal(state.sealed, true);
    assert.equal(state.active_requests, 0);
  } finally { h.release(); await h.app.close(); }
});
