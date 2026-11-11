/** The app-level alias guard of the pinned native POST /api/local-invoices/previews/:id/issue: which
 * requests it takes over (no database; the DB behaviour is in tests/gaps231.database.test.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Problem } from '../server/errors';
import { NATIVE_ISSUE_ROUTE, registerLocalInvoiceIssueAlias } from '../server/local-invoice-issue-alias';

const ID = '00000000-0000-4000-8000-000000000001';
async function app(opts: { tax226Available: boolean; readOnly: boolean }) {
  const a = Fastify(), native: string[] = [];
  a.setErrorHandler((err: any, _req, reply) => reply.code(err instanceof Problem ? err.status : 500).send({ detail: err.message }));
  registerLocalInvoiceIssueAlias(a, { ...opts, sessionName: 'dyna_session' });
  // Stand-ins for the pinned native routes.
  a.post(NATIVE_ISSUE_ROUTE, async req => { native.push('issue ' + (req.params as any).id); return { native: true }; });
  a.get(NATIVE_ISSUE_ROUTE, async () => ({ native: 'get' }));
  a.post('/api/local-invoices/previews/:id/other', async () => ({ native: 'other' }));
  await a.ready();
  return { a, native };
}

test('without 226 the native /issue answers as before', async () => {
  const { a, native } = await app({ tax226Available: false, readOnly: false });
  const r = await a.inject({ method: 'POST', url: `/api/local-invoices/previews/${ID}/issue`, payload: {} });
  assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { native: true }); assert.deepEqual(native, ['issue ' + ID]);
  await a.close();
});
test('with 226 the guard takes over POST /issue only: the native handler is never reached', async () => {
  const { a, native } = await app({ tax226Available: true, readOnly: true });
  const r = await a.inject({ method: 'POST', url: `/api/local-invoices/previews/${ID}/issue`, payload: {} });
  assert.equal(r.statusCode, 423); assert.match(r.json().detail, /tylko do odczytu/);
  assert.deepEqual((await a.inject({ method: 'GET', url: `/api/local-invoices/previews/${ID}/issue` })).json(), { native: 'get' });
  assert.deepEqual((await a.inject({ method: 'POST', url: `/api/local-invoices/previews/${ID}/other`, payload: {} })).json(), { native: 'other' });
  assert.deepEqual(native, []);
  await a.close();
  const w = await app({ tax226Available: true, readOnly: false });
  const bad = await w.a.inject({ method: 'POST', url: '/api/local-invoices/previews/not-a-uuid/issue', payload: {} });
  assert.equal(bad.statusCode, 500, 'an invalid id is refused by the guard (ZodError), never issued natively'); assert.deepEqual(w.native, []);
  const anon = await w.a.inject({ method: 'POST', url: `/api/local-invoices/previews/${ID}/issue`, payload: {} });
  assert.notEqual(anon.statusCode, 200, 'without an actor the guard refuses'); assert.deepEqual(w.native, []);
  await w.a.close();
});
