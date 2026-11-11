/** RES-04 on a real disposable clone (dynaminds_l1a_20261026_NN) against the local fake KSeF 2.0
 * (127.0.0.1, random port; no MF host is ever called): a send whose answer is lost is never sent
 * again blindly and never recorded as rejected. Before sendInvoice the session is stored with the
 * submission (durable marker); an uncertain outcome is resolved by looking the file up by its hash
 * in that session (GET /sessions/{ref}/invoices), and a 440 "Duplikat" by the session it names.
 * - lost answer of sendInvoice: the file is found in the session at once, accepted with number + UPO;
 * - lost answer and KSeF unreachable for the check: offline + marker; the next attempt only reads;
 * - crash between sendInvoice and storing its result: the marker survives, the retry only reads;
 * - 440 for a file that reached KSeF outside the app's records: reconciled, not rejected;
 * - background status job (ksef.status): a processed invoice and an uncertain one are settled by
 *   reads only; the lease outlasts the attempt budget.
 * Uses tenants other than tests/ksef229.database.test.ts, so both can run on one clone. */
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { localConfig, pool } from '../server/db';
import { Problem } from '../server/errors';
import { tokenHash } from '../server/security';
import { registerKsef229Routes, ksef229Service } from '../server/ksef229-routes';
import { registerFa3DocumentRoutes } from '../server/fa3-document-routes';
import { startFakeKsef, type FakeKsef } from '../server/ksef229-fake';
import { KsefClient } from '../server/ksef229-client';
import { isKsefNumber } from '../server/ksef229-crypto';
import { fa3XmlFacts } from '../server/ksef229-model';
import { fa3DocumentXml } from '../server/fa3-documents';
import { z } from 'zod';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_l1a_20261026_[0-9]{2}$/);
pool.options.query_timeout = 30000;
const SESSION = 'dyna_session', TOKEN = 'lokalny-token-' + randomBytes(12).toString('hex');
type Who = { tenant: string; user: string; role: string; token: string };
let app: FastifyInstance, fake: FakeKsef;
/** Test hooks of the service's network: after every fetch, and instead of every sleep. */
let afterFetch: ((url: string, init: RequestInit | undefined, failed: boolean) => void) | null = null;
let onSleep: (() => void) | null = null;
/** Files of documents that exist only for this test (a submission has no foreign key to a ledger). */
const synthetic = new Map<string, string>();

async function member(tenant: string, role: string): Promise<Who> {
  const user = (await pool.query('SELECT user_id FROM memberships WHERE tenant_id=$1 AND role=$2 ORDER BY user_id LIMIT 1', [tenant, role])).rows[0]?.user_id as string;
  assert(user, `seed needs ${role} in ${tenant}`);
  const token = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at,account_version,mfa_verified_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',coalesce((SELECT version FROM account_security WHERE user_id=$2),0),clock_timestamp())`, [tokenHash(token), user, tenant]);
  return { tenant, user, role, token };
}
const call = (w: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: { 'x-test-as': JSON.stringify(w) }, ...(payload ? { payload } : {}) });
/** Setup calls only (not the call under test): the shared PG04 can hit the 8 s statement timeout in the preflights. */
async function setupCall(w: Who, method: 'GET' | 'PUT', url: string, payload?: object) {
  for (let i = 0; ; i++) {
    const r = await call(w, method, url, payload);
    if (r.statusCode !== 500 || !/statement timeout/.test(r.body) || i === 3) return r;
  }
}
/** The tenant's local invoice, its exact FA(3) file and seller NIP; settings for that NIP saved. */
async function setup(tenant: string) {
  const admin = await member(tenant, 'admin');
  const id = (await pool.query("SELECT id FROM documents WHERE tenant_id=$1 AND mode='local_invoice' ORDER BY created_at LIMIT 1", [tenant])).rows[0]?.id as string;
  assert(id, 'seed needs a local invoice in ' + tenant);
  const got = await setupCall(admin, 'GET', `/api/fa3/documents/${id}/fa3.xml`);
  assert.equal(got.statusCode, 200, got.body);
  const xml = got.body, nip = fa3XmlFacts(xml).sellerNip;
  const saved = await setupCall(admin, 'PUT', '/api/ksef229/configs/' + nip, { environment: 'local_fake', base_url: fake.url, auth_method: 'token', token: TOKEN });
  assert.equal(saved.statusCode, 200, saved.body);
  return { admin, id, xml, nip };
}
const sends = () => fake.stats()['sessions/invoices/send'] ?? 0;
const rows = async (id: string) => (await pool.query(`SELECT state,issue_mode,session_id,reference_number,ksef_number,upo_xml IS NOT NULL upo,status_code,last_error
  FROM ksef229_submissions WHERE document_id=$1 ORDER BY created_at`, [id])).rows;
const inFake = (xml: string) => fake.invoices().filter(i => i.xml === xml);

before(async () => {
  fake = await startFakeKsef({ port: 0 });
  app = Fastify();
  app.decorateRequest('actor'); app.decorateRequest('currentUser'); app.decorateRequest('apiScopes'); app.decorateRequest('apiKeyId');
  app.addHook('onRequest', async (req: any) => {
    const w = JSON.parse(String(req.headers['x-test-as'])) as Who;
    req.actor = { tenantId: w.tenant, userId: w.user, role: w.role, source: 'session' };
    req.currentUser = { id: w.user, tenant_id: w.tenant, role: w.role };
    req.cookies = { [SESSION]: w.token };
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ detail: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ detail: err.issues.map(i => i.message).join('; ') });
    return reply.code(500).send({ detail: 'Nieoczekiwany błąd serwera: ' + err.message });
  });
  const hooked: typeof fetch = async (input, init) => {
    const url = String(input);
    try { const r = await fetch(input, init); afterFetch?.(url, init, false); return r; }
    catch (e) { afterFetch?.(url, init, true); throw e; }
  };
  const service = ksef229Service({ key: localConfig.encryptionKey, sessionName: SESSION, pollDelaysMs: [20, 40, 80, 160], timeoutMs: 3000, fetch: hooked,
    xml: async (req, id) => synthetic.has(id) ? { xml: synthetic.get(id)!, number: fa3XmlFacts(synthetic.get(id)!).number, document_kind: 'local_invoice' } : fa3DocumentXml(req, id, SESSION),
    sleep: async ms => { const s = onSleep; onSleep = null; s?.(); await new Promise(r => setTimeout(r, ms)); } });
  registerKsef229Routes(app, { available: true, readOnly: false, service });
  registerFa3DocumentRoutes(app, { sessionName: SESSION });
  await app.ready();
});
afterEach(() => { fake.loseNextResponse('sessions/invoices/send', null); afterFetch = null; onSleep = null; fake.setMode('ok'); });
after(async () => { await app?.close(); await fake?.close(); await pool.end(); });

const T1 = '270d6daf-34ea-4939-a30a-b486e5c31bd8', T2 = '3dc9b3fb-e9e9-43f6-b1ee-cbf431f1332b', T3 = '7a38e3a3-4bd5-441f-ad76-a2925a8a2a46',
  T4 = 'aaaffbf5-82ce-4b17-b99b-b473cfaa4d9e', T5 = 'ccf57de0-1553-4a2f-8978-9dd71a20e959';

test('lost answer of sendInvoice: the file is found in the stored session and accepted with its number and UPO; nothing is sent twice', async () => {
  const { admin, id, xml } = await setup(T1), before = sends();
  fake.loseNextResponse('sessions/invoices/send', 'drop');
  let r = await call(admin, 'POST', `/api/ksef229/documents/${id}/send`);
  assert.equal(r.statusCode, 200, r.body);
  if (r.json().submission?.state !== 'accepted') r = await call(admin, 'POST', '/api/ksef229/queue/send', {}); // the retry an operator would do
  const all = await rows(id), live = all.at(-1);
  assert.deepEqual(all.map(x => x.state), ['accepted'], 'one submission, accepted, none rejected: ' + JSON.stringify(all));
  assert.equal(sends() - before, 1, 'sendInvoice called once');
  assert.equal(inFake(xml).length, 1); assert.equal(live.ksef_number, inFake(xml)[0]!.ksefNumber); assert(isKsefNumber(live.ksef_number));
  assert.equal(live.upo, true); assert.equal(live.issue_mode, 'online', 'found at once, so it never became an offline invoice');
  const ev = (await pool.query('SELECT kind,message FROM ksef229_events WHERE submission_id=(SELECT id FROM ksef229_submissions WHERE document_id=$1) ORDER BY at', [id])).rows;
  assert.equal(ev[0].kind, 'send', 'the marker event precedes every result: ' + JSON.stringify(ev));
  assert(ev.some(e => /uzgodniono|odnaleziono/i.test(e.message)), JSON.stringify(ev));
});

test('lost answer and KSeF unreachable for the check: offline with the marker kept; the next attempt reads, finds and accepts it without resending', async () => {
  const { admin, id, xml } = await setup(T2), before = sends();
  fake.loseNextResponse('sessions/invoices/send', 'drop');
  afterFetch = (url, init, failed) => { if (failed && init?.method === 'POST' && /\/invoices$/.test(url)) { afterFetch = null; fake.setMode('unavailable'); } };
  let first;
  try { first = await call(admin, 'POST', `/api/ksef229/documents/${id}/send`); } finally { afterFetch = null; fake.setMode('ok'); }
  assert.equal(first.statusCode, 200, first.body);
  const mid = (await rows(id)).at(-1);
  assert.equal(mid.state, 'queued'); assert.equal(mid.issue_mode, 'offline'); assert(mid.session_id, 'the session of the uncertain send is kept');
  assert.equal(mid.reference_number, null);
  const again = await call(admin, 'POST', '/api/ksef229/queue/send', {});
  assert.equal(again.statusCode, 200, again.body);
  const all = await rows(id);
  assert.deepEqual(all.map(x => x.state), ['accepted'], JSON.stringify(all));
  assert.equal(sends() - before, 1, 'never resent'); assert.equal(inFake(xml).length, 1);
  assert.equal(all[0].ksef_number, inFake(xml)[0]!.ksefNumber); assert.equal(all[0].upo, true); assert.equal(all[0].session_id, mid.session_id);
});

test('crash between sendInvoice and storing its result: the stored session survives; the retry only reads and accepts', async () => {
  const { admin, id, xml } = await setup(T3), before = sends();
  fake.setMode('slow', { slowPolls: 1 });
  // The process dies at the first wait after KSeF took the file (the status poll), before anything is stored.
  afterFetch = (url, init, failed) => {
    if (!failed && init?.method === 'POST' && /\/invoices$/.test(url)) { afterFetch = null; onSleep = () => { throw new Error('proces przerwany (symulacja awarii po wysłaniu)'); }; }
  };
  let crashed;
  try { crashed = await call(admin, 'POST', `/api/ksef229/documents/${id}/send`); } finally { afterFetch = null; onSleep = null; fake.setMode('ok'); }
  assert.equal(crashed.statusCode, 500, crashed.body); assert.match(crashed.body, /proces przerwany/);
  const mid = (await rows(id)).at(-1);
  assert.equal(mid.state, 'queued'); assert(mid.session_id, 'marker: the session was stored before sendInvoice'); assert.equal(sends() - before, 1);
  const retry = await call(admin, 'POST', `/api/ksef229/documents/${id}/send`);
  assert.equal(retry.statusCode, 200, retry.body);
  const all = await rows(id);
  assert.deepEqual(all.map(x => x.state), ['accepted'], JSON.stringify(all));
  assert.equal(sends() - before, 1, 'the retry did not send'); assert.equal(all[0].ksef_number, inFake(xml)[0]!.ksefNumber); assert.equal(all[0].upo, true);
  assert.equal((await pool.query('SELECT state FROM ksef229_sessions WHERE id=$1', [all[0].session_id])).rows[0].state, 'closed');
});

test('440 "Duplikat" for a file already in KSeF (no record in the app): reconciled to accepted with the original number and UPO, not rejected', async () => {
  const { admin, id, xml, nip } = await setup(T4);
  const direct = new KsefClient({ environment: 'local_fake', baseUrl: fake.url, nip, credentials: { method: 'token', token: TOKEN }, sleep: async () => {} });
  const s = await direct.openOnlineSession(), sent = await direct.sendInvoice(s, Buffer.from(xml, 'utf8'));
  const original = await direct.pollInvoice(s.referenceNumber, sent.referenceNumber);
  await direct.closeSession(s.referenceNumber);
  assert.equal(original.code, 200);
  const r = await call(admin, 'POST', `/api/ksef229/documents/${id}/send`);
  assert.equal(r.statusCode, 200, r.body);
  const all = await rows(id);
  assert.deepEqual(all.map(x => x.state), ['accepted'], JSON.stringify(all));
  assert.equal(all[0].ksef_number, original.ksefNumber); assert.equal(all[0].reference_number, sent.referenceNumber); assert.equal(all[0].upo, true);
  assert.equal(inFake(xml).length, 1);
  const sess = (await pool.query('SELECT reference_number FROM ksef229_sessions WHERE id=$1', [all[0].session_id])).rows[0];
  assert.equal(sess.reference_number, s.referenceNumber, 'bound to the session KSeF accepted it in');
  const ev = (await pool.query("SELECT code FROM ksef229_events WHERE submission_id=(SELECT id FROM ksef229_submissions WHERE document_id=$1) AND kind='refused'", [id])).rows;
  assert.equal(ev.length, 0, 'not recorded as a refusal');
});

test('background status job (ksef.status): a processed invoice and an uncertain send are settled by reads only; lease > attempt budget', async () => {
  const { processKsefStatusJob, KSEF_STATUS_JOB } = await import('../server/ksef229-jobs');
  const { KSEF_ATTEMPT_BUDGET_MS, KSEF_LEASE_SECONDS } = await import('../server/ksef229-model');
  assert(KSEF_LEASE_SECONDS * 1000 > KSEF_ATTEMPT_BUDGET_MS + 60_000, 'the lease outlasts the longest attempt with a margin for the two transactions');
  const run = async (submissionId: string) => {
    const job = (await pool.query(`UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE kind=$3 AND state='pending' AND payload->>'submission_id'=$1 RETURNING *`,
      [submissionId, randomUUID(), KSEF_STATUS_JOB])).rows[0];
    assert(job, 'a pending ksef.status job for ' + submissionId);
    await processKsefStatusJob(job, { pollDelaysMs: [1, 1, 1, 1], timeoutMs: 3000 });
    return (await pool.query('SELECT state,error FROM jobs WHERE id=$1', [job.id])).rows[0];
  };
  // 1. Still processed by KSeF when the polls run out: "sent", and a status job is queued.
  const a = await setup(T5);
  fake.setMode('slow', { slowPolls: 6 });
  let r;
  try { r = await call(a.admin, 'POST', `/api/ksef229/documents/${a.id}/send`); } finally { fake.setMode('ok'); }
  assert.equal(r.json().submission.state, 'sent', r.body);
  const before = sends(), sub = (await pool.query('SELECT id FROM ksef229_submissions WHERE document_id=$1', [a.id])).rows[0].id as string;
  const done = await run(sub);
  assert.equal(done.state, 'done', JSON.stringify(done));
  const after1 = (await rows(a.id)).at(-1);
  assert.equal(after1.state, 'accepted'); assert.equal(after1.upo, true); assert.equal(sends() - before, 0, 'the job only reads');
  // 2. An uncertain send (lost answer, KSeF unreachable for the check), settled by the job instead of the queue.
  const doc = { id: randomUUID() }, number = 'FV/RES04/' + randomBytes(3).toString('hex');
  synthetic.set(doc.id, a.xml.replace(/<P_2>[^<]*<\/P_2>/, `<P_2>${number}</P_2>`));
  {
    const t = a.admin, before2 = sends();
    fake.loseNextResponse('sessions/invoices/send', 'drop');
    afterFetch = (url, init, failed) => { if (failed && init?.method === 'POST' && /\/invoices$/.test(url)) { afterFetch = null; fake.setMode('unavailable'); } };
    try { await call(t, 'POST', `/api/ksef229/documents/${doc.id}/send`); } finally { afterFetch = null; fake.setMode('ok'); }
    const s2 = (await pool.query('SELECT id,state,session_id FROM ksef229_submissions WHERE document_id=$1', [doc.id])).rows[0];
    assert.equal(s2.state, 'queued'); assert(s2.session_id);
    assert.equal((await run(s2.id)).state, 'done');
    assert.equal((await rows(doc.id)).at(-1).state, 'accepted'); assert.equal(sends() - before2, 1, 'sent once, reconciled by the job');
  }
  // 3. A queued invoice that was never handed over gets no job: the poller never sends.
  assert.equal((await pool.query(`SELECT count(*)::int n FROM jobs j JOIN ksef229_submissions s ON s.id::text=j.payload->>'submission_id'
    WHERE j.kind=$1 AND j.state IN ('pending','running') AND s.state='queued' AND s.session_id IS NULL`, [KSEF_STATUS_JOB])).rows[0].n, 0);
});
