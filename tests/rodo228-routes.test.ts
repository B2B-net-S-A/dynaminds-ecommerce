/** 228 RODO routes without a database: administrator-only access (403 for other roles and
 * API keys), 503 without 228, 423 in a read-only copy, 404 for an unknown customer (the real
 * resolver over an empty client), 409 for open business, the export headers and the confirm
 * body. The service is a recording stand-in. */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { z } from 'zod';
import { Problem } from '../server/errors';
import { registerRodo228Routes, type Rodo228Service } from '../server/rodo228-routes';
import { resolveSubjectInTx } from '../server/rodo228';
import { assertAnonymisable } from '../server/rodo228-model';

const T = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const calls: string[] = [];
const emptyClient = { query: async () => ({ rows: [], rowCount: 0 }) } as any;
const service: Rodo228Service = {
  exportCustomer: async (_a, input) => { calls.push('export:' + JSON.stringify(input)); if ('email' in input && input.email === 'nikt@example.com') await resolveSubjectInTx(emptyClient, _a, input, 'k'); return { archive: Buffer.from('PK'), orders: 1, clients: 0 }; },
  previewAnonymisation: async (a, input) => {
    calls.push('preview');
    if ('email' in input && input.email === 'otwarte@example.com') assertAnonymisable({ openOrders: [{ number: 'ZAM-7', status: 'new' }], openReturns: [], unsettled: [] });
    await resolveSubjectInTx(emptyClient, a, input, 'k');
    throw new Error('unreachable');
  },
  confirmAnonymisation: async (_a, id, sha) => { calls.push('confirm:' + id + ':' + sha.slice(0, 4)); return { request_id: id, state: 'completed', replayed: false, result: {} }; },
  accessLog: async () => ({ data: [{ id: 'x', actor_id: U, api_key_id: null }], next: null }),
  names: async () => ({ users: { [U]: 'Anna Admin' }, keys: {} }),
  requests: async () => [], retained: async () => [], settings: async () => ({ access_log_retention_days: 1825 }),
  saveSettings: async () => ({}), purge: async () => 0,
};
async function app(opts: { available?: boolean; readOnly?: boolean } = {}) {
  const a = Fastify();
  a.decorateRequest('actor'); a.decorateRequest('apiScopes');
  a.addHook('onRequest', async (req: any) => {
    const as = JSON.parse(String(req.headers['x-test-as'] ?? '{}'));
    req.actor = { tenantId: T, userId: U, role: as.role ?? 'admin', ...(as.key ? { apiKeyId: C, source: 'api' } : {}) };
    req.apiScopes = as.key ? ['orders:read'] : undefined;
  });
  a.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
    return reply.code(500).send({ error: String(err?.message) });
  });
  registerRodo228Routes(a, { available: opts.available ?? true, readOnly: opts.readOnly ?? false, pool: {} as any, key: 'k', service, now: () => new Date('2026-10-23T10:00:00Z') });
  await a.ready();
  return a;
}
const as = (role: string, key = false) => ({ 'x-test-as': JSON.stringify({ role, key }) });

test('every route refuses operators, viewers and API keys with 403 before the service', async () => {
  const a = await app(), before = calls.length;
  const routes: [string, string, unknown?][] = [['GET', '/api/rodo228/status'], ['GET', '/api/rodo228/export?crm_client_id=' + C], ['POST', '/api/rodo228/anonymisation/preview', { crm_client_id: C }],
    ['POST', '/api/rodo228/anonymisation/' + C + '/confirm', { plan_sha256: 'a'.repeat(64) }], ['GET', '/api/rodo228/access-log'], ['POST', '/api/rodo228/access-log/purge'],
    ['GET', '/api/rodo228/requests'], ['GET', '/api/rodo228/retained'], ['PUT', '/api/rodo228/settings', { access_log_retention_days: 400 }]];
  for (const [method, url, payload] of routes) for (const h of [as('operator'), as('viewer'), as('admin', true)]) {
    const r = await a.inject({ method: method as any, url, headers: h, ...(payload ? { payload: payload as any } : {}) });
    assert.equal(r.statusCode, 403, method + ' ' + url + ' ' + r.body);
    assert.match(r.json().error, /administrator/);
  }
  assert.equal(calls.length, before);
});
test('without 228 every route is 503; a read-only copy refuses export and anonymisation with 423', async () => {
  const off = await app({ available: false });
  assert.equal((await off.inject({ method: 'GET', url: '/api/rodo228/status', headers: as('admin') })).statusCode, 503);
  const ro = await app({ readOnly: true });
  for (const [method, url, payload] of [['GET', '/api/rodo228/export?email=a@example.com'], ['POST', '/api/rodo228/anonymisation/preview', { email: 'a@example.com' }]] as const) {
    const r = await ro.inject({ method, url, headers: as('admin'), ...(payload ? { payload } : {}) });
    assert.equal(r.statusCode, 423, r.body); assert.match(r.json().error, /tylko do odczytu/);
  }
  assert.equal((await ro.inject({ method: 'GET', url: '/api/rodo228/access-log', headers: as('admin') })).statusCode, 200);
});
test('unknown customer is 404; an e-mail with open business is 409 with the Polish reason', async () => {
  const a = await app();
  let r = await a.inject({ method: 'POST', url: '/api/rodo228/anonymisation/preview', headers: as('admin'), payload: { email: 'nikt@example.com' } });
  assert.equal(r.statusCode, 404); assert.equal(r.json().error, 'Nie znaleziono klienta o podanych danych');
  r = await a.inject({ method: 'POST', url: '/api/rodo228/anonymisation/preview', headers: as('admin'), payload: { crm_client_id: C } });
  assert.equal(r.statusCode, 404); assert.equal(r.json().error, 'Nie znaleziono klienta CRM');
  r = await a.inject({ method: 'GET', url: '/api/rodo228/export?email=nikt@example.com', headers: as('admin') });
  assert.equal(r.statusCode, 404);
  r = await a.inject({ method: 'POST', url: '/api/rodo228/anonymisation/preview', headers: as('admin'), payload: { email: 'otwarte@example.com' } });
  assert.equal(r.statusCode, 409); assert.match(r.json().error, /^Nie można zanonimizować danych klienta — otwarte zamówienia: ZAM-7 \(czeka na wpłatę\)/);
});
test('input validation: one identifier, known export parameters, a plan digest on confirm', async () => {
  const a = await app();
  for (const payload of [{}, { email: 'a@example.com', phone: '500600700' }, { email: 'zły' }])
    assert.equal((await a.inject({ method: 'POST', url: '/api/rodo228/anonymisation/preview', headers: as('admin'), payload })).statusCode, 422);
  assert.equal((await a.inject({ method: 'GET', url: '/api/rodo228/export?email=a@example.com&format=xml', headers: as('admin') })).statusCode, 422);
  assert.equal((await a.inject({ method: 'POST', url: '/api/rodo228/anonymisation/' + C + '/confirm', headers: as('admin'), payload: {} })).statusCode, 422);
  assert.equal((await a.inject({ method: 'PUT', url: '/api/rodo228/settings', headers: as('admin'), payload: { access_log_retention_days: 400 } })).statusCode, 200);
  const r = await a.inject({ method: 'POST', url: '/api/rodo228/anonymisation/' + C.toUpperCase() + '/confirm', headers: as('admin'), payload: { plan_sha256: 'b'.repeat(64) } });
  assert.equal(r.statusCode, 200); assert.equal(r.json().request_id, C);
});
test('export is a private ZIP download; the register page names the actor', async () => {
  const a = await app();
  const r = await a.inject({ method: 'GET', url: '/api/rodo228/export?phone=%2B48%20500%20600%20700', headers: as('admin') });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'application/zip');
  assert.equal(r.headers['content-disposition'], 'attachment; filename="dane-klienta-2026-10-23.zip"');
  assert.equal(r.headers['cache-control'], 'private, no-store');
  assert(calls.includes('export:{"phone":"500600700"}'));
  const log = await a.inject({ method: 'GET', url: '/api/rodo228/access-log', headers: as('admin') });
  assert.equal(log.json().data[0].actor, 'Anna Admin');
});
