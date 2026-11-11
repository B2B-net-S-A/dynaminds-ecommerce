/** KSeF 229 on a real disposable clone (dynaminds_ksef229_20261023_NN) against the local fake KSeF
 * 2.0 server (127.0.0.1, random port; no MF host is ever called). Real routes, real service, real
 * FA(3) generator with the native detail reads of a session identity:
 * - refusals: viewer 403, no settings 409, a file that is not FA(3) 422;
 * - settings: the token is stored encrypted and never returned, logged in events or audit;
 * - happy path: send → status 200 → UPO → KSeF number stored; a second send does not resend;
 *   the correction of that invoice then carries NrKSeFFaKorygowanej and is accepted too;
 * - KSeF 5xx → the invoice becomes offline (reason, KOD I, deadline) → "Kolejka KSeF" sends it later;
 * - offline24 by choice; the guards of 229 and the nine core guards stay true.
 * Root-only on a fresh clone; sessions rows and the 229 rows are added. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { localConfig, pool } from '../server/db';
import { Problem } from '../server/errors';
import { decrypt, tokenHash } from '../server/security';
import { registerKsef229Routes, ksef229Service } from '../server/ksef229-routes';
import { registerFa3DocumentRoutes } from '../server/fa3-document-routes';
import { fa3DocumentXml } from '../server/fa3-documents';
import { startFakeKsef, type FakeKsef } from '../server/ksef229-fake';
import { isKsefNumber, sha256Base64Url } from '../server/ksef229-crypto';
import { addBusinessDays, warsawDay } from '../server/ksef229-model';
import { z } from 'zod';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_(ksef229_20261023|l1a_20261026|xsd30_20261030)_[0-9]{2}$/);
pool.options.query_timeout = 30000;
const SESSION = 'dyna_session', NIP = '5260250274', TOKEN = 'lokalny-token-' + randomBytes(12).toString('hex');
const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid', 'return_credit211_metadata_valid',
  'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards'];
type Who = { tenant: string; user: string; role: string; token: string };
let app: FastifyInstance, fake: FakeKsef, xmlOverride: string | null = null;
/** Changes the real generated FA(3) file (same number) — used to send a file the official schema rejects. */
let xmlTransform: ((xml: string) => string) | null = null;

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
async function guards() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY'); await c.query('SET LOCAL search_path TO "$user",public'); await c.query("SET LOCAL statement_timeout='8s'");
    const o: Record<string, boolean> = {};
    for (const g of GUARDS) o[g] = (await c.query(`SELECT public.${g}() v`)).rows[0].v;
    await c.query('ROLLBACK'); return o;
  } finally { c.release(); }
}
const invoiceOf = async (tenant: string) => (await pool.query("SELECT id,number FROM documents WHERE tenant_id=$1 AND mode='local_invoice' ORDER BY created_at LIMIT 1", [tenant])).rows[0] as { id: string; number: string };
const saveConfig = (w: Who) => call(w, 'PUT', '/api/ksef229/configs/' + NIP, { environment: 'local_fake', base_url: fake.url, auth_method: 'token', token: TOKEN });

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
  const service = ksef229Service({ key: localConfig.encryptionKey, sessionName: SESSION, pollDelaysMs: [20, 40, 80, 160], timeoutMs: 5000,
    xml: async (req, id) => {
      if (xmlOverride !== null) return { xml: xmlOverride, number: 'X', document_kind: 'local_invoice' };
      const x = await fa3DocumentXml(req, id, SESSION);
      return xmlTransform ? { ...x, xml: xmlTransform(x.xml) } : x;
    } });
  registerKsef229Routes(app, { available: true, readOnly: false, service });
  registerFa3DocumentRoutes(app, { sessionName: SESSION });
  await app.ready();
});
after(async () => { await app?.close(); await fake?.close(); await pool.end(); });

const A = 'eefc1d42-b27f-42cd-99f7-470d58f1913f', B = '68235cac-e7f0-4901-b04d-adac68f319c0', C = 'cbd4fe72-4f67-4443-8544-a128d48adc02', KOR = '093db35a-fc73-445a-81ed-05db996a1825';

test('guards before; refusals on real data: viewer 403, no settings 409, a file that is not FA(3) 422', async () => {
  const g = await guards();
  assert(Object.values(g).every(v => v === true), JSON.stringify(g));
  const inv = await invoiceOf(C), admin = await member(C, 'admin');
  const viewer = (await pool.query("SELECT 1 FROM memberships WHERE tenant_id=$1 AND role='viewer'", [C])).rowCount ? await member(C, 'viewer') : { ...admin, role: 'viewer' };
  const v = await call(viewer, 'POST', `/api/ksef229/documents/${inv.id}/send`);
  assert.equal(v.statusCode, 403, v.body);
  const n = await call(admin, 'POST', `/api/ksef229/documents/${inv.id}/send`);
  assert.equal(n.statusCode, 409, n.body); assert.match(n.json().detail, /Brak aktywnych ustawień KSeF dla NIP 5260250274/);
  assert.equal((await saveConfig(admin)).statusCode, 200);
  xmlOverride = '<Faktura xmlns="urn:inna"><P_2>X</P_2></Faktura>';
  try {
    const x = await call(admin, 'POST', `/api/ksef229/documents/${inv.id}/send`);
    assert.equal(x.statusCode, 422, x.body); assert.match(x.json().detail, /nie jest poprawną fakturą FA\(3\)/);
  } finally { xmlOverride = null; }
  assert.equal((await pool.query('SELECT count(*)::int n FROM ksef229_submissions WHERE tenant_id=$1', [C])).rows[0].n, 0, 'refusals write nothing');
});

test('official FA(3) schema before KSeF: a file that does not conform is refused 422 for send and offline, nothing stored or sent; the real file is "zgodny"', async () => {
  const inv = await invoiceOf(C), admin = await member(C, 'admin'), sent = fake.invoices().length;
  xmlTransform = xml => xml.replace(/<P_15>[^<]*<\/P_15>/, '');
  try {
    for (const [path, body] of [['send', undefined], ['offline', { mode: 'offline24' }]] as const) {
      const r = await call(admin, 'POST', `/api/ksef229/documents/${inv.id}/${path}`, body);
      assert.equal(r.statusCode, 422, r.body);
      // libxml2 names the element where the missing P_15 was expected (Adnotacje), without its namespace.
      assert.match(r.json().detail, new RegExp(`^Plik FA\\(3\\) ${inv.number.replace(/\//g, '\\/')} nie jest zgodny ze schematem FA\\(3\\) Ministerstwa Finansów: Element 'Adnotacje': .*P_13_.* — nie wysłano do KSeF$`));
    }
  } finally { xmlTransform = null; }
  assert.equal((await pool.query('SELECT count(*)::int n FROM ksef229_submissions WHERE tenant_id=$1', [C])).rows[0].n, 0, 'nothing stored');
  assert.equal(fake.invoices().length, sent, 'nothing sent');
  const file = await call(admin, 'GET', `/api/fa3/documents/${inv.id}/fa3.xml`);
  assert.equal(file.statusCode, 200, file.body); assert.equal(file.headers['x-walidacja-xsd'], 'zgodny');
});

test('settings: the token is encrypted at rest, never returned, never in events or audit; check against the fake succeeds', async () => {
  const admin = await member(A, 'admin');
  const r = await saveConfig(admin);
  assert.equal(r.statusCode, 200, r.body); assert(!r.body.includes(TOKEN));
  assert.equal(r.json().config.secret.masked, '••••••••');
  const list = await call(admin, 'GET', '/api/ksef229/configs');
  assert(!list.body.includes(TOKEN)); assert.equal(list.json().configs.length, 1);
  const row = (await pool.query('SELECT secret_ciphertext,secret_fingerprint FROM ksef229_configs WHERE tenant_id=$1 AND nip=$2', [A, NIP])).rows[0];
  assert(!row.secret_ciphertext.includes(TOKEN)); assert.deepEqual(decrypt(row.secret_ciphertext), { token: TOKEN });
  // Saving again without a token keeps the stored one.
  assert.equal((await call(admin, 'PUT', '/api/ksef229/configs/' + NIP, { environment: 'local_fake', base_url: fake.url, auth_method: 'token' })).statusCode, 200);
  assert.deepEqual(decrypt((await pool.query('SELECT secret_ciphertext FROM ksef229_configs WHERE tenant_id=$1', [A])).rows[0].secret_ciphertext), { token: TOKEN });
  const check = await call(admin, 'POST', `/api/ksef229/configs/${NIP}/check`);
  assert.equal(check.statusCode, 200, check.body); assert.equal(check.json().ok, true, check.body); assert(!check.body.includes(TOKEN));
  // MF environments are refused before any network call.
  assert.equal((await call(admin, 'PUT', '/api/ksef229/configs/1234563218', { environment: 'test', auth_method: 'token', token: TOKEN })).statusCode, 200);
  const mf = await call(admin, 'POST', '/api/ksef229/configs/1234563218/check');
  assert.equal(mf.statusCode, 409); assert.match(mf.json().detail, /wyłączone w tej lokalnej wersji/);
  const other = await member(B, 'admin');
  assert.equal((await call(other, 'GET', '/api/ksef229/configs')).json().configs.length, 0, 'another tenant sees nothing');
  for (const [table, col] of [['ksef229_events', 'message'], ['audit_events', 'detail::text']])
    assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE ${col} LIKE $1`, ['%' + TOKEN + '%'])).rows[0].n, 0, table);
});

test('happy path: send → 200 → UPO → number stored; a second send does not resend; the correction then refers to NrKSeF and is accepted', async () => {
  const admin = await member(A, 'admin'), inv = (await pool.query("SELECT id,number FROM documents WHERE id='fdd4e6c3-98c4-418a-aa65-0942febe4ef2'")).rows[0];
  const before = fake.invoices().length;
  const r = await call(admin, 'POST', `/api/ksef229/documents/${inv.id}/send`);
  assert.equal(r.statusCode, 200, r.body);
  const s = r.json().submission;
  assert.equal(s.state, 'accepted', r.body); assert(isKsefNumber(s.ksef_number), s.ksef_number); assert.equal(s.upo_available, true); assert.equal(s.status.code, 200);
  assert.equal(fake.invoices().length, before + 1);
  const db = (await pool.query('SELECT xml,xml_sha256,ksef_number,upo_xml,session_id,reference_number FROM ksef229_submissions WHERE document_id=$1', [inv.id])).rows[0];
  assert.equal(db.ksef_number, s.ksef_number); assert(db.upo_xml.includes(s.ksef_number)); assert(db.session_id && db.reference_number);
  const generated = await call(admin, 'GET', `/api/fa3/documents/${inv.id}/fa3.xml`);
  assert.equal(generated.statusCode, 200);
  assert.equal(createHash('sha256').update(generated.body).digest('hex'), db.xml_sha256, 'the exact FA(3) file of the document was sent');
  assert.equal(fake.invoices().at(-1)!.xml, generated.body);
  assert.equal((await pool.query("SELECT state FROM ksef229_sessions WHERE id=$1", [db.session_id])).rows[0].state, 'closed');
  const again = await call(admin, 'POST', `/api/ksef229/documents/${inv.id}/send`);
  assert.equal(again.statusCode, 200); assert.equal(again.json().replayed, true); assert.equal(again.json().submission.ksef_number, s.ksef_number);
  assert.equal(fake.invoices().length, before + 1, 'idempotent: nothing resent');
  const upo = await call(admin, 'GET', `/api/ksef229/documents/${inv.id}/upo.xml`);
  assert.equal(upo.statusCode, 200); assert.match(upo.headers['content-disposition'] as string, new RegExp(`UPO-${s.ksef_number}\\.xml`)); assert.match(upo.body, /Potwierdzenie/);
  // The correction of this FV now names it by its KSeF number.
  const kor = await call(admin, 'GET', `/api/fa3/documents/${KOR}/fa3.xml`);
  assert.equal(kor.statusCode, 200, kor.body);
  assert.match(kor.body, new RegExp(`<NrKSeF>1</NrKSeF><NrKSeFFaKorygowanej>${s.ksef_number}</NrKSeFFaKorygowanej>`)); assert(!kor.body.includes('<NrKSeFN>'));
  const k = await call(admin, 'POST', `/api/ksef229/documents/${KOR}/send`);
  assert.equal(k.statusCode, 200, k.body); assert.equal(k.json().submission.state, 'accepted'); assert.equal(k.json().submission.document_kind, 'local_consumer_credit');
  const events = (await pool.query('SELECT kind FROM ksef229_events WHERE tenant_id=$1 ORDER BY at', [A])).rows.map(r => r.kind);
  for (const kind of ['config', 'check', 'session_open', 'session_close', 'status']) assert(events.includes(kind), kind);
});

test('KSeF 5xx → offline with reason, KOD I and deadline → "Kolejka KSeF" sends it later with the KSeF number', async () => {
  const admin = await member(B, 'admin'), inv = await invoiceOf(B);
  assert.equal((await saveConfig(admin)).statusCode, 200);
  fake.setMode('unavailable');
  let r;
  try { r = await call(admin, 'POST', `/api/ksef229/documents/${inv.id}/send`); } finally { fake.setMode('ok'); }
  assert.equal(r.statusCode, 200, r.body);
  const s = r.json().submission, today = warsawDay(new Date());
  assert.equal(s.state, 'queued'); assert.equal(s.ksef_number, null); assert.equal(s.offline.mode, 'offline');
  assert.match(s.offline.reason, /niedostępny/); assert.match(s.last_error, /KSeF/);
  const row = (await pool.query("SELECT xml,to_char(issue_date,'YYYY-MM-DD') d FROM ksef229_submissions WHERE document_id=$1", [inv.id])).rows[0];
  assert.equal(s.offline.deadline, addBusinessDays(today > row.d ? today : row.d, 1));
  assert.equal(s.offline.kod1.url, `${new URL(fake.url).origin}/qr/invoice/${NIP}/${row.d.slice(8, 10)}-${row.d.slice(5, 7)}-${row.d.slice(0, 4)}/${sha256Base64Url(Buffer.from(row.xml, 'utf8'))}`);
  assert.equal(s.offline.kod1.label, 'OFFLINE'); assert(s.offline.kod1.svg.startsWith('<svg')); assert.equal(s.offline.kod2, null);
  const q = await call(admin, 'GET', '/api/ksef229/queue');
  assert.deepEqual(q.json().items.map((i: any) => [i.document_id, i.state, i.issue_mode]), [[inv.id, 'queued', 'offline']]);
  const send = await call(admin, 'POST', '/api/ksef229/queue/send', {});
  assert.equal(send.statusCode, 200, send.body); assert.deepEqual([send.json().attempted, send.json().accepted], [1, 1]);
  const after = (await call(admin, 'GET', `/api/ksef229/documents/${inv.id}`)).json().submission;
  assert.equal(after.state, 'accepted'); assert(isKsefNumber(after.ksef_number)); assert.equal(after.offline.mode, 'offline'); assert.equal(after.offline.kod1.label, after.ksef_number);
  const sent = fake.invoices().find(i => i.ksefNumber === after.ksef_number)!;
  assert.equal(sent.offlineMode, true); assert.equal(sent.xml, row.xml, 'the stored offline file, the one the QR code hashes, was sent');
  assert.equal((await call(admin, 'GET', '/api/ksef229/queue')).json().items.length, 0);
});

test('offline24 by choice: deadline the next business day after the issue date; sent later; guards after; owner cannot alter a submission', async () => {
  const admin = await member(C, 'admin'), inv = await invoiceOf(C);
  const r = await call(admin, 'POST', `/api/ksef229/documents/${inv.id}/offline`, { mode: 'offline24' });
  assert.equal(r.statusCode, 200, r.body);
  const s = r.json().submission, d = (await pool.query("SELECT to_char(issue_date,'YYYY-MM-DD') d FROM ksef229_submissions WHERE document_id=$1", [inv.id])).rows[0].d;
  assert.equal(s.offline.mode, 'offline24'); assert.equal(s.offline.deadline, addBusinessDays(d, 1)); assert.equal(s.state, 'queued');
  assert.equal((await call(admin, 'POST', `/api/ksef229/documents/${inv.id}/offline`, { mode: 'awaryjny' })).statusCode, 409, 'mode is fixed once set');
  const sent = await call(admin, 'POST', `/api/ksef229/documents/${inv.id}/send`);
  assert.equal(sent.json().submission.state, 'accepted', sent.body);
  await assert.rejects(pool.query("UPDATE ksef229_submissions SET ksef_number=NULL,state='queued' WHERE document_id=$1", [inv.id]), /nienaruszalna|niedozwolona|numer/);
  await assert.rejects(pool.query('DELETE FROM ksef229_submissions WHERE document_id=$1', [inv.id]), /nienaruszalna/);
  await assert.rejects(pool.query('TRUNCATE ksef229_events'), /nienaruszalny/);
  const g = await guards();
  assert(Object.values(g).every(v => v === true), JSON.stringify(g));
});
