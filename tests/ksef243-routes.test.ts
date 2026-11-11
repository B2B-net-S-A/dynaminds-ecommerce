/** 243 purchase-invoice routes without a database: who may do what (403 before the service), 503 without 243,
 * 423 for writes in a read-only copy, input validation (422), the XML and package download headers. The service
 * is a recording stand-in. */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { z } from 'zod';
import { Problem } from '../server/errors';
import { registerKsef243Routes, type Ksef243Service } from '../server/ksef243-routes';

const T = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222', ID = '33333333-3333-4333-8333-333333333333', NIP = '1234563218';
const KSEF = '5260250995-20261020-0123456789AB-07';
const calls: string[] = [];
const service: Ksef243Service = {
  status: async () => { calls.push('status'); return { syncs: [] }; },
  saveSync: async (_a, nip) => { calls.push('saveSync:' + nip); return { nip }; },
  run: async (_a, nip) => { calls.push('run:' + nip); return { outcome: 'ok' }; },
  list: async (_a, q) => { calls.push('list:' + JSON.stringify(q)); return { items: [], next: null }; },
  detail: async (_a, id) => { calls.push('detail:' + id); return { id }; },
  xml: async () => { calls.push('xml'); return { body: Buffer.from('<?xml version="1.0"?><Faktura/>'), filename: KSEF + '.xml' }; },
  patch: async (_a, id) => { calls.push('patch:' + id); return { id }; },
  rejects: async () => { calls.push('rejects'); return { items: [] }; },
  retry: async (_a, k) => { calls.push('retry:' + k); return { ok: true }; },
  exportPackage: async () => { calls.push('export'); return { body: Buffer.from('PK'), filename: 'faktury-zakupowe-ksef.zip', count: 0 }; },
};
async function app(o: { available?: boolean; readOnly?: boolean } = {}) {
  const a = Fastify();
  a.decorateRequest('actor'); a.decorateRequest('apiScopes');
  a.addHook('onRequest', async (req: any) => {
    const as = JSON.parse(String(req.headers['x-test-as'] ?? '{}'));
    if (as.none) return;
    req.actor = { tenantId: T, userId: U, role: as.role ?? 'admin', ...(as.scopes ? { apiKeyId: ID, source: 'api' } : {}) };
    req.apiScopes = as.scopes;
  });
  a.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ detail: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ detail: err.issues.map(i => i.message).join('; ') });
    return reply.code(500).send({ detail: String(err?.message) });
  });
  registerKsef243Routes(a, { available: o.available ?? true, readOnly: o.readOnly ?? false, service });
  await a.ready();
  return a;
}
const as = (role: string, scopes?: string[]) => ({ 'x-test-as': JSON.stringify({ role, scopes }) });
const sync = { enabled: true, date_type: 'PermanentStorage', start_from: '2026-10-01T00:00:00Z' };
const WRITES = [['PUT', '/api/ksef243/sync/' + NIP, sync], ['POST', '/api/ksef243/sync/' + NIP + '/run', {}], ['PATCH', '/api/ksef243/invoices/' + ID, { version: 1, status: 'accepted' }],
  ['POST', '/api/ksef243/rejects/' + KSEF + '/retry', {}]] as const;
const READS = ['/api/ksef243/status', '/api/ksef243/invoices', '/api/ksef243/invoices/' + ID, '/api/ksef243/invoices/' + ID + '/fa3.xml', '/api/ksef243/rejects'];

test('no session: 401; without 243: 503 — before the service', async () => {
  const a = await app(), b = await app({ available: false }), before = calls.length;
  assert.equal((await a.inject({ url: READS[0]!, headers: { 'x-test-as': JSON.stringify({ none: true }) } })).statusCode, 401);
  for (const url of READS) assert.equal((await b.inject({ url, headers: as('admin') })).statusCode, 503, url);
  assert.equal(calls.length, before);
});

test('viewer reads the list, detail and file but changes nothing and gets no package', async () => {
  const a = await app();
  for (const url of READS) assert.equal((await a.inject({ url, headers: as('viewer') })).statusCode, 200, url);
  const before = calls.length;
  for (const [method, url, payload] of WRITES) assert.equal((await a.inject({ method, url, payload, headers: as('viewer') })).statusCode, 403, method + url);
  assert.equal((await a.inject({ url: '/api/ksef243/export.zip', headers: as('viewer') })).statusCode, 403, 'bulk package: administrator or operator');
  assert.equal(calls.length, before);
});

test('settings: administrator session only; fetch, workflow and retry: administrator or operator; API key needs documents:write', async () => {
  const a = await app(), before = calls.length;
  for (const h of [as('operator'), as('admin', ['documents:write', 'documents:read'])])
    assert.equal((await a.inject({ method: 'PUT', url: WRITES[0][1], payload: sync, headers: h })).statusCode, 403);
  assert.equal(calls.length, before);
  for (const [method, url, payload] of WRITES.slice(1)) {
    assert.equal((await a.inject({ method, url, payload, headers: as('operator', ['documents:read']) })).statusCode, 403, 'read scope only');
    assert.equal((await a.inject({ method, url, payload, headers: as('operator') })).statusCode, 200, method + url);
    assert.equal((await a.inject({ method, url, payload, headers: as('operator', ['documents:write']) })).statusCode, 200, 'API key with write scope');
  }
  assert.equal((await a.inject({ url: READS[1]!, headers: as('viewer', ['orders:read']) })).statusCode, 403, 'API key without documents:read');
  assert.equal((await a.inject({ method: 'PUT', url: WRITES[0][1], payload: sync, headers: as('admin') })).statusCode, 200);
});

test('a read-only copy refuses every write with 423, and the package (its export is logged); reading still works', async () => {
  const a = await app({ readOnly: true }), before = calls.length;
  for (const [method, url, payload] of WRITES) assert.equal((await a.inject({ method, url, payload, headers: as('admin') })).statusCode, 423, method + url);
  assert.equal(calls.length, before);
  assert.equal((await a.inject({ url: READS[1]!, headers: as('admin') })).statusCode, 200);
  assert.equal((await a.inject({ url: '/api/ksef243/export.zip', headers: as('operator') })).statusCode, 423);
});

test('validation: NIP, id, KSeF number, filters and bodies are checked before the service', async () => {
  const a = await app(), before = calls.length;
  for (const [method, url, payload] of [
    ['PUT', '/api/ksef243/sync/123', sync], ['PUT', '/api/ksef243/sync/' + NIP, { ...sync, token: 'x' }], ['POST', '/api/ksef243/sync/' + NIP + '/run', { maxPages: 999 }],
    ['GET', '/api/ksef243/invoices?limit=5000'], ['GET', '/api/ksef243/invoices?seller=' + 'x'.repeat(101)], ['GET', '/api/ksef243/invoices/not-a-uuid'],
    ['PATCH', '/api/ksef243/invoices/' + ID, { version: 1, xml: '<x/>' }], ['POST', '/api/ksef243/rejects/../../etc/retry', {}], ['POST', '/api/ksef243/rejects/NOTANUMBER/retry', {}],
    ['GET', '/api/ksef243/export.zip?from=2026-13-01'],
  ] as const) {
    const r = await a.inject({ method, url, ...(payload ? { payload } : {}), headers: as('admin') });
    assert.ok([400, 404, 422].includes(r.statusCode), method + url + ' ' + r.statusCode);
  }
  assert.equal(calls.length, before);
});

test('the FA(3) file and the package download privately with a safe name', async () => {
  const a = await app();
  const x = await a.inject({ url: '/api/ksef243/invoices/' + ID + '/fa3.xml', headers: as('viewer') });
  assert.equal(x.headers['content-type'], 'application/xml; charset=utf-8');
  assert.equal(x.headers['cache-control'], 'private, no-store');
  assert.equal(x.headers['x-content-type-options'], 'nosniff');
  assert.equal(x.headers['content-disposition'], `attachment; filename="${KSEF}.xml"`);
  const z = await a.inject({ url: '/api/ksef243/export.zip?status=booked', headers: as('admin') });
  assert.equal(z.headers['content-type'], 'application/zip');
  assert.equal(z.headers['content-disposition'], 'attachment; filename="faktury-zakupowe-ksef.zip"');
  assert.equal(z.headers['cache-control'], 'private, no-store');
});
