/** Pure parts of the JPK batch read (server/fa3-document-batch.ts): the request frame and the replay of
 * batch results in list order, so collectJpkDocuments refuses and fails exactly as with per-document reads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Problem } from '../server/errors';
import { Fa3DocumentError, type Fa3Document } from '../server/fa3-render';
import { FA3_BATCH_MODES, batchFacts, creditModuleCheckInTx, fa3BatchFrame, type Fa3BatchFacts, type Fa3BatchResult } from '../server/fa3-document-batch';
import { collectJpkDocuments, type JpkListed } from '../server/jpk-source';

const T = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222', K = '33333333-3333-4333-8333-333333333333';
const req = (o: Record<string, unknown> = {}) => ({ actor: { tenantId: T, userId: U, role: 'admin', source: 'session' }, currentUser: { id: U, tenant_id: T }, headers: {}, cookies: { dyna_session: 'sesja' }, ...o }) as never;
const listed = (id: string, mode: string, kind = mode.includes('credit') || mode.includes('correction') ? 'correction' : 'invoice'): JpkListed =>
  ({ id, kind, mode, number: 'N/' + id, tax_date: '2026-10-27', issue_date: '2026-10-27' });
const model = (n: string, gross = 1000n) => ({ kind: 'VAT', number: n, total_gross_minor: gross }) as unknown as Fa3Document;

test('frame: session cookie, API key bearer token; foreign identity and no credential are 401', () => {
  const s = fa3BatchFrame(req(), 'dyna_session');
  assert.deepEqual([s.credential, s.actor.tenantId, s.actor.userId, 'apiKeyId' in s.actor], ['sesja', T, U, false]);
  const k = fa3BatchFrame(req({ apiKeyId: K, headers: { authorization: 'Bearer dyna_api_x' }, cookies: { dyna_session: 'inna' } }), 'dyna_session');
  assert.deepEqual([k.credential, k.actor.apiKeyId], ['dyna_api_x', K], 'a key request uses its bearer token, never the cookie');
  assert.ok(Object.isFrozen(k.actor));
  for (const bad of [req({ currentUser: { id: K, tenant_id: T } }), req({ currentUser: { id: U, tenant_id: K } }), req({ currentUser: undefined }), req({ cookies: {} }),
    req({ apiKeyId: K, headers: {} })])
    assert.throws(() => fa3BatchFrame(bad, 'dyna_session'), (e: unknown) => e instanceof Problem && e.status === 401);
});

test('batched modes: every JPK mode but the B2B 159/160 native reads', () => {
  assert.deepEqual([...FA3_BATCH_MODES].sort(), ['consumer_return_credit', 'invoice230', 'invoice232_correction', 'local_consumer_credit', 'local_invoice']);
});

test('replay: batch facts in list order, refusals listed, native read only for documents outside the batch', async () => {
  const batch: Fa3BatchResult = new Map<string, any>([
    ['a', { facts: { model: model('A'), rate: null, ksef: { number: null, offline: false } } }],
    ['b', { error: new Fa3DocumentError(409, 'Waluta obca bez kursu') }],
    ['d', { facts: { model: model('D'), rate: null, ksef: { number: 'KS', offline: false } } }],
  ]);
  const native: string[] = [];
  const facts = batchFacts(batch, async (d: JpkListed) => { native.push(d.id); return { model: model('C'), rate: null, ksef: { number: null, offline: false } } as Fa3BatchFacts; }, f => f);
  await assert.rejects(collectJpkDocuments([listed('a', 'local_invoice'), listed('b', 'invoice230'), listed('c', 'b2b_invoice'), listed('d', 'invoice232_correction')], facts),
    (e: any) => e.status === 409 && JSON.stringify(e.documents) === JSON.stringify([{ number: 'N/b', reason: 'Waluta obca bez kursu' }]));
  assert.deepEqual(native, ['c'], 'only the B2B document goes to its native read');
  const ok = await collectJpkDocuments([listed('a', 'local_invoice'), listed('d', 'invoice232_correction')], facts);
  assert.deepEqual(ok.documents.map(d => [d.id, d.ksef]), [['a', { number: null, offline: false }], ['d', { number: 'KS', offline: false }]]);
});

test('replay: a Problem of a native read stops the file at its position, as before', async () => {
  const batch: Fa3BatchResult = new Map<string, any>([['a', { error: new Problem(503, 'Niepełny trwały dowód faktury') }], ['b', { error: new Fa3DocumentError(409, 'x') }]]);
  const facts = batchFacts(batch, async () => assert.fail('no native read'), f => f);
  await assert.rejects(collectJpkDocuments([listed('a', 'local_invoice'), listed('b', 'invoice230')], facts), (e: any) => e instanceof Problem && e.status === 503);
  // Demo and simulation documents are skipped before any read; unsupported modes are refused without a read.
  const none = await collectJpkDocuments([listed('x', 'demo'), listed('y', 'simulation')], facts);
  assert.deepEqual([none.documents.length, none.skipped], [0, 2]);
});

/** Stub client: the context query answers as a tenantReadTx would; `fail` rejects the guard, then the aborted transaction rejects everything. */
function stub(tenant: string, fail?: { code: string }) {
  const seen: string[] = []; let aborted = false;
  return { seen, query: async (sql: string) => {
    seen.push(sql.split(' ').slice(0, 3).join(' '));
    if (aborted) throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
    if (sql.startsWith('SELECT session_user')) return { rows: [{ owner: 'postgres', role: 'dyna_app', tenant }] };
    if (fail && sql.includes('_require(')) { aborted = true; throw Object.assign(new Error('Niepełny profil188'), fail); }
    return { rows: [] };
  } } as never as { seen: string[]; query: (sql: string) => Promise<{ rows: any[] }> };
}
test('188/206 module check as owner: role restored; a failed guard keeps its own error (503, 401, 409), never the aborted-transaction 25P02', async () => {
  const ok = stub(T);
  await creditModuleCheckInTx(ok as never, T, 'SELECT public.local_consumer_credit_require($1,$2,false,false)', [U, null]);
  assert.deepEqual(ok.seen, ['SELECT session_user owner,current_user', 'RESET ROLE', 'SELECT public.local_consumer_credit_require($1,$2,false,false)', 'SET LOCAL ROLE']);
  for (const [code, status] of [['55000', 503], ['28000', 401], ['42501', 403], ['40001', 409], ['XX000', 503]] as const)
    await assert.rejects(creditModuleCheckInTx(stub(T, { code }) as never, T, 'SELECT public.return_credit206_require($1,$2,false,false)', [U, null]),
      (e: unknown) => e instanceof Problem && e.status === status, code);
  await assert.rejects(creditModuleCheckInTx(stub(K) as never, T, 'SELECT 1', []), (e: unknown) => e instanceof Problem && e.status === 403, 'another tenant context');
});
