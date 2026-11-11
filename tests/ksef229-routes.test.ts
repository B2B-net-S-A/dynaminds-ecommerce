/** 229 KSeF routes without a database: who may do what (403 before the service), 503 without 229,
 * 423 in a read-only copy, input validation (422), download headers and that the settings reply
 * never carries the secret that was sent. The service is a recording stand-in. */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { z } from 'zod';
import { Problem } from '../server/errors';
import { registerKsef229Routes, type Ksef229Service } from '../server/ksef229-routes';
import { maskedConfig } from '../server/ksef229-model';

const T = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222', D = '33333333-3333-4333-8333-333333333333', NIP = '5260250274';
const TOKEN = 'fake-token-' + 'x'.repeat(20), KEY = '-----BEGIN PRIVATE KEY-----\nFAKEKEYMATERIAL\n-----END PRIVATE KEY-----';
const calls: string[] = [];
const view = () => maskedConfig({ nip: NIP, environment: 'local_fake', base_url: 'http://127.0.0.1:4239/v2', auth_method: 'token', secret_fingerprint: '0123456789abcdef',
  certificate_serial: null, offline_certificate_serial: null, active: true, updated_at: '2026-10-23T10:00:00.000Z' });
const service: Ksef229Service = {
  configs: async () => { calls.push('configs'); return [view()]; },
  saveConfig: async (_a, nip) => { calls.push('save:' + nip); return view(); },
  check: async () => { calls.push('check'); return { ok: true }; },
  document: async (_a, id) => { calls.push('document'); return { document_id: id, submission: null, rejected: [] }; },
  send: async (_r, _a, id) => { calls.push('send'); if (id === D.replace('3333-4333', '4444-4444')) throw new Problem(409, `Brak aktywnych ustawień KSeF dla NIP ${NIP}. Dodaj je w Ustawienia → KSeF.`); return { ok: true }; },
  offline: async (_r, _a, _id, b) => { calls.push('offline:' + b.mode); return { ok: true }; },
  refresh: async () => { calls.push('refresh'); return { ok: true }; },
  download: async (_a, _id, what) => { calls.push('download:' + what); return { body: '<Potwierdzenie/>', filename: 'UPO-5260250274-20261023-0123456789AB-3F.xml' }; },
  queue: async () => { calls.push('queue'); return []; },
  sendQueue: async () => { calls.push('sendQueue'); return { attempted: 0, accepted: 0, results: [] }; },
};
async function app(o: { available?: boolean; readOnly?: boolean } = {}) {
  const a = Fastify();
  a.decorateRequest('actor'); a.decorateRequest('apiScopes');
  a.addHook('onRequest', async (req: any) => {
    const as = JSON.parse(String(req.headers['x-test-as'] ?? '{}'));
    req.actor = { tenantId: T, userId: U, role: as.role ?? 'admin', ...(as.scopes ? { apiKeyId: D, source: 'api' } : {}) };
    req.apiScopes = as.scopes;
  });
  a.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ detail: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ detail: err.issues.map(i => i.message).join('; ') });
    return reply.code(500).send({ detail: String(err?.message) });
  });
  registerKsef229Routes(a, { available: o.available ?? true, readOnly: o.readOnly ?? false, service });
  await a.ready();
  return a;
}
const as = (role: string, scopes?: string[]) => ({ 'x-test-as': JSON.stringify({ role, scopes }) });
const cfgBody = { environment: 'local_fake', base_url: 'http://127.0.0.1:4239/v2', auth_method: 'token', token: TOKEN };

test('settings: administrator session only — operator, viewer and API keys get 403 before the service', async () => {
  const a = await app(), before = calls.length;
  for (const [method, url, payload] of [['GET', '/api/ksef229/configs'], ['PUT', '/api/ksef229/configs/' + NIP, cfgBody], ['POST', '/api/ksef229/configs/' + NIP + '/check']] as const)
    for (const h of [as('operator'), as('viewer'), as('admin', ['documents:write', 'documents:read'])]) {
      const r = await a.inject({ method, url, headers: h, ...(payload ? { payload } : {}) });
      assert.equal(r.statusCode, 403, method + url + r.body);
    }
  assert.equal(calls.length, before);
});

test('sending, offline issue, status refresh and the queue: administrator or operator; viewer 403; API key needs documents:write', async () => {
  const a = await app(), before = calls.length;
  const writes: [string, string, unknown?][] = [['POST', `/api/ksef229/documents/${D}/send`], ['POST', `/api/ksef229/documents/${D}/offline`, { mode: 'offline24' }],
    ['POST', `/api/ksef229/documents/${D}/refresh`], ['POST', '/api/ksef229/queue/send', {}]];
  for (const [method, url, payload] of writes) {
    for (const h of [as('viewer'), as('admin', ['documents:read'])]) {
      const r = await a.inject({ method: method as 'POST', url, headers: h, ...(payload ? { payload: payload as object } : {}) });
      assert.equal(r.statusCode, 403, url + r.body);
    }
  }
  assert.equal(calls.length, before);
  for (const [method, url, payload] of writes) for (const h of [as('operator'), as('admin'), as('operator', ['documents:write'])]) {
    const r = await a.inject({ method: method as 'POST', url, headers: h, ...(payload ? { payload: payload as object } : {}) });
    assert.equal(r.statusCode, 200, url + r.body);
  }
  // Reading is open to every role and to documents:read.
  for (const url of [`/api/ksef229/documents/${D}`, '/api/ksef229/queue', '/api/ksef229/status']) for (const h of [as('viewer'), as('admin', ['documents:read'])])
    assert.equal((await a.inject({ url, headers: h })).statusCode, 200, url);
  assert.equal((await a.inject({ url: '/api/ksef229/queue', headers: as('admin', ['orders:read']) })).statusCode, 403);
});

test('503 without 229, 423 for writes in a read-only copy, reads still allowed there', async () => {
  const off = await app({ available: false });
  for (const url of ['/api/ksef229/status', '/api/ksef229/configs', `/api/ksef229/documents/${D}`]) {
    const r = await off.inject({ url, headers: as('admin') });
    assert.equal(r.statusCode, 503); assert.match(r.json().detail, /migracja 229/);
  }
  const ro = await app({ readOnly: true });
  for (const [method, url, payload] of [['PUT', '/api/ksef229/configs/' + NIP, cfgBody], ['POST', `/api/ksef229/documents/${D}/send`], ['POST', '/api/ksef229/queue/send', {}]] as const) {
    const r = await ro.inject({ method, url, headers: as('admin'), ...(payload ? { payload } : {}) });
    assert.equal(r.statusCode, 423, url);
  }
  const st = await ro.inject({ url: '/api/ksef229/status', headers: as('admin') });
  assert.equal(st.statusCode, 200); assert.equal(st.json().can_send, false); assert.equal(st.json().real_mf_enabled, false);
});

test('validation 422 and the refusal of the service as 409; the reply to a save never carries the secret', async () => {
  const a = await app();
  for (const [url, payload] of [['/api/ksef229/configs/5260250275', cfgBody], ['/api/ksef229/configs/' + NIP, { ...cfgBody, base_url: 'https://api-test.ksef.mf.gov.pl/v2' }],
    ['/api/ksef229/configs/' + NIP, { ...cfgBody, environment: 'prod' }], ['/api/ksef229/configs/' + NIP, { ...cfgBody, unknown: true }]] as const) {
    const r = await a.inject({ method: 'PUT', url, headers: as('admin'), payload });
    assert.equal(r.statusCode, 422, url + r.body);
    assert(!r.body.includes(TOKEN), 'a validation message never echoes the token');
  }
  assert.equal((await a.inject({ method: 'POST', url: `/api/ksef229/documents/${D}/offline`, headers: as('admin'), payload: { mode: 'offline' } })).statusCode, 422);
  assert.equal((await a.inject({ method: 'POST', url: '/api/ksef229/documents/not-a-uuid/send', headers: as('admin') })).statusCode, 422);
  const c = await a.inject({ method: 'POST', url: `/api/ksef229/documents/${D.replace('3333-4333', '4444-4444')}/send`, headers: as('admin') });
  assert.equal(c.statusCode, 409); assert.match(c.json().detail, /Brak aktywnych ustawień KSeF/);
  for (const payload of [cfgBody, { environment: 'test', auth_method: 'certificate', certificate_pem: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----', private_key_pem: KEY, certificate_serial: '01AB' }]) {
    const r = await a.inject({ method: 'PUT', url: '/api/ksef229/configs/' + NIP, headers: as('admin'), payload });
    assert.equal(r.statusCode, 200, r.body);
    assert(!r.body.includes(TOKEN) && !r.body.includes('FAKEKEYMATERIAL'));
    assert.equal(r.headers['cache-control'], 'private, no-store');
  }
  const list = await a.inject({ url: '/api/ksef229/configs', headers: as('admin') });
  assert.equal(list.json().configs[0].secret.masked, '••••••••');
  const d = await a.inject({ url: `/api/ksef229/documents/${D}/upo.xml`, headers: as('viewer') });
  assert.equal(d.headers['content-type'], 'application/xml; charset=utf-8');
  assert.equal(d.headers['content-disposition'], 'attachment; filename="UPO-5260250274-20261023-0123456789AB-3F.xml"');
  assert.equal(d.headers['x-content-type-options'], 'nosniff');
});
