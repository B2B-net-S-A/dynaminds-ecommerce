/** Migration 243 (docs/parity/KSEF-PURCHASE243-20261027.md) on a disposable clone migrated to HEAD
 * (dynaminds_m243_20261027_NN), against the local purchase fake (127.0.0.1, random port; no MF host is called).
 * Real routes and service with the actor injected; the 229 settings of the NIP come from the real 229 service.
 * - settings: administrator only, KSeF settings of the NIP required, the job queued, nothing secret stored;
 * - fetch: a same-date group split across pages, a listed duplicate, a refused file kept without content, KOR
 *   linked when the original arrives later, the DB-checked file hashes; a second run stores nothing new;
 * - failure modes: a lost page (KSeF 503 after the first page), a duplicate page (a run repeated from an older
 *   checkpoint), the access token expiring mid-fetch, a crash after a stored page and a restart, a stale lease of a
 *   dead worker, a lease taken over mid-run (the old run never writes the checkpoint), 429 with Retry-After
 *   rescheduling the job — every time no gap and no duplicate;
 * - access: viewer reads only, the other tenant gets 404 and RLS shows it nothing, dyna_app cannot change KSeF
 *   data, delete or truncate; the owner cannot either; the purge deletes only past retention without a hold;
 * - workflow and the accountant's package; RODO export and anonymisation registry; the guards stay true. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localConfig, pool } from '../server/db';
import { Problem } from '../server/errors';
import { ksef229Service } from '../server/ksef229-routes';
import { ksefConfigInput } from '../server/ksef229-model';
import { startFakeKsefPurchase, type FakeKsefPurchase, type FakeReceivedInvoice } from '../server/ksef229-fake-purchase';
import { registerKsef243Routes, ksef243Service } from '../server/ksef243-routes';
import { runPurchaseFetch, type Ksef243Options } from '../server/ksef243';
import { processKsefPurchaseFetchJob } from '../server/ksef243-jobs';
import { exportCustomer, previewAnonymisation } from '../server/rodo228';
import { DEMO_TENANT, SECOND_TENANT, seed } from './fixtures';
import { BUYER, OTHER_SELLER, SELLER, receivedFa3 } from './ksef-purchase-fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:24[3456789]|25[0123456789]|26[0123])_202610(?:27|28|29|30)_[0-9]{2}$/, 'fresh clone dynaminds_m243_20261027_NN (or m244/m245/m246/m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 244/245/246/247/248/249/250/251/252/253/254/255/256/257/258/259/260/261/262) required');
// The ungated local preflight reads every guard (several seconds); same allowance as the 242 DB test.
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');
pool.options.query_timeout = 90000;

const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid', 'return_credit211_metadata_valid',
  'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards', 'warehouse_wz_issuer_guards'];
const TOKEN = 'lokalny-token-zakupowy-' + randomBytes(10).toString('hex');
type Who = { tenantId: string; userId: string; role: 'admin' | 'operator' | 'viewer' };
const who: Record<string, Who> = {};
let app: FastifyInstance, fake: FakeKsefPurchase;
const net = { sleep: async () => {}, minIntervalMs: 0, random: () => 1 };
// Every page transaction pays the ungated preflight here (seconds under load), so the run budget is widened; a
// budget stop ('partial', the next run continues) is still tolerated by the duplicate-page loop.
const opts = (extra: Partial<Ksef243Options> = {}): Ksef243Options => ({ net, pageSize: 10, budgetMs: 300_000, ...extra });
const call = (w: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, headers: { 'x-test-as': JSON.stringify(w) }, ...(payload ? { payload } : {}) });
async function ok(w: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) {
  const r = await call(w, method, url, payload);
  assert(r.statusCode < 300, method + ' ' + url + ' ' + r.statusCode + ' ' + r.body);
  return r.headers['content-type']?.toString().startsWith('application/json') ? r.json() : r;
}
async function guards() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY'); await c.query('SET LOCAL search_path TO "$user",public'); await c.query("SET LOCAL statement_timeout='60s'");
    const o: Record<string, boolean> = {};
    for (const g of GUARDS) o[g] = (await c.query(`SELECT public.${g}() v`)).rows[0].v;
    await c.query('ROLLBACK'); return o;
  } finally { c.release(); }
}
/** dyna_app inside one tenant, as the application runs. */
async function asApp<T>(tenant: string, fn: (c: import('pg').PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE dyna_app'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    return await fn(c);
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}
async function member(tenant: string, role: Who['role']): Promise<Who> {
  const user = (await pool.query('SELECT user_id FROM memberships WHERE tenant_id=$1 AND role=$2 ORDER BY user_id LIMIT 1', [tenant, role])).rows[0]?.user_id as string;
  assert(user, `seed needs ${role} in ${tenant}`);
  return { tenantId: tenant, userId: user, role };
}
const stored = async () => (await pool.query('SELECT ksef_number FROM ksef243_purchase_invoices WHERE tenant_id=$1 ORDER BY 1', [DEMO_TENANT])).rows.map(r => r.ksef_number as string);
const sync = async () => (await pool.query('SELECT * FROM ksef243_purchase_sync WHERE tenant_id=$1 AND nip=$2', [DEMO_TENANT, BUYER])).rows[0];
const at = (iso: string) => new Date(iso);
let counter = 0;
function add(date: string, o: Parameters<typeof receivedFa3>[0] = {}): FakeReceivedInvoice {
  counter++;
  return fake.addReceivedInvoice({ xml: receivedFa3({ number: `FZ/${counter}/10/2026`, date: date.slice(0, 10), ...o }), permanentStorageDate: at(date), invoicingDate: at(date) });
}
const run = (extra: Partial<Ksef243Options> = {}) => runPurchaseFetch(who.admin!, BUYER, opts(extra));
/** Starts the NIP over from 1.10.2026 so each scenario reads its own invoices from a known point. */
async function restartFrom(iso = '2026-10-01T00:00:00Z') {
  await ok(who.admin!, 'PUT', '/api/ksef243/sync/' + BUYER, { enabled: true, date_type: 'PermanentStorage', start_from: iso, restart: true });
}

before(async () => {
  await seed();
  for (const role of ['admin', 'operator', 'viewer'] as const) who[role] = await member(DEMO_TENANT, role);
  who.other = await member(SECOND_TENANT, 'admin');
  fake = await startFakeKsefPurchase({ port: 0 });
  app = Fastify();
  app.decorateRequest('actor'); app.decorateRequest('apiScopes');
  app.addHook('onRequest', async (req: any) => { req.actor = { ...JSON.parse(String(req.headers['x-test-as'])), source: 'session' }; });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ detail: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ detail: err.issues.map(i => i.message).join('; ') });
    return reply.code(500).send({ detail: String(err?.message) });
  });
  registerKsef243Routes(app, { available: true, readOnly: false, service: ksef243Service(opts()) });
  await app.ready();
});
after(async () => { await app?.close(); await fake?.close(); await pool.end(); });

test('settings: administrator only, KSeF settings of the NIP required, the fetch job queued, no secret anywhere', async () => {
  const body = { enabled: true, date_type: 'PermanentStorage', start_from: '2026-10-01T00:00:00Z' };
  for (const w of [who.operator!, who.viewer!]) assert.equal((await call(w, 'PUT', '/api/ksef243/sync/' + BUYER, body)).statusCode, 403);
  const none = await call(who.admin!, 'PUT', '/api/ksef243/sync/' + BUYER, body);
  assert.equal(none.statusCode, 409, none.body);
  assert.match(none.json().detail, /Ustawienia → KSeF/);
  await ksef229Service({ key: localConfig.encryptionKey, sessionName: 'dyna_session' }).saveConfig(who.admin!, BUYER,
    ksefConfigInput.parse({ environment: 'local_fake', base_url: fake.url, auth_method: 'token', token: TOKEN }));
  const saved = await ok(who.admin!, 'PUT', '/api/ksef243/sync/' + BUYER, body);
  assert.equal(saved.nip, BUYER); assert.equal(saved.enabled, true); assert.equal(saved.completed_up_to, '2026-10-01T00:00:00.000Z');
  const s = await sync();
  assert.deepEqual(s.checkpoint, { version: 1, nip: BUYER, dateType: 'PermanentStorage', completedUpTo: '2026-10-01T00:00:00.000Z', window: null });
  const jobs = (await pool.query("SELECT state,payload FROM jobs WHERE tenant_id=$1 AND kind='ksef.purchase.fetch' AND payload->>'nip'=$2", [DEMO_TENANT, BUYER])).rows;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'pending');
  // Saving again does not queue a second job.
  await ok(who.admin!, 'PUT', '/api/ksef243/sync/' + BUYER, body);
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind='ksef.purchase.fetch' AND state='pending'", [DEMO_TENANT])).rows[0].n, 1);
  const dump = JSON.stringify([...(await pool.query('SELECT * FROM ksef243_purchase_sync')).rows, ...(await pool.query('SELECT * FROM ksef243_purchase_events')).rows]);
  assert.equal(dump.includes(TOKEN), false, 'the KSeF token is never stored by 243');
  const status = await ok(who.viewer!, 'GET', '/api/ksef243/status');
  assert.equal(status.can_configure, false); assert.equal(status.can_fetch, false);
  assert.equal(status.syncs[0].nip, BUYER);
});

test('fetch: a same-date group across pages, a listed duplicate, a refused file and a KOR before its original; a second run stores nothing new', async () => {
  const group = Array.from({ length: 12 }, () => add('2026-10-10T12:00:00.000Z'));
  const early = Array.from({ length: 5 }, (_, i) => add(`2026-10-0${i + 2}T08:00:00.000Z`));
  const late = Array.from({ length: 6 }, (_, i) => add(`2026-10-2${i}T08:00:00.000Z`));
  fake.addReceivedInvoice({ xml: early[1]!.xml, ksefNumber: early[1]!.ksefNumber, permanentStorageDate: at('2026-10-03T08:00:00.000Z') }); // listed twice
  const bad = add('2026-10-11T09:00:00.000Z');
  fake.tamperDownload(bad.ksefNumber, receivedFa3({ number: 'INNA' }));
  const kor = add('2026-10-12T09:00:00.000Z', { kind: 'KOR', gross: '-123.00', korRefs: [{ number: 'FZ/ORYG/9/2026', date: '2026-09-30' }] });
  const r = await run();
  assert.equal(r.outcome, 'ok', JSON.stringify(r)); assert.equal(r.done, true);
  const expected = [...group, ...early, ...late, kor].map(x => x.ksefNumber).sort();
  assert.deepEqual(await stored(), expected, 'every listed invoice once, the refused one not');
  assert.equal(r.stored, 24); assert.equal(r.rejected, 1);
  const rej = (await pool.query('SELECT * FROM ksef243_purchase_rejects WHERE ksef_number=$1', [bad.ksefNumber])).rows[0];
  assert.equal(rej.code, 'hash_mismatch'); assert.equal(rej.resolved_at, null);
  assert.equal(JSON.stringify(rej).includes('INNA'), false, 'no content of the refused file');
  // The stored file is KSeF's bytes: the DB recomputes both digests.
  const row = (await pool.query("SELECT *,encode(sha256(xml),'base64') AS h,to_char(retain_until,'YYYY-MM-DD') retain FROM ksef243_purchase_invoices WHERE ksef_number=$1", [early[0]!.ksefNumber])).rows[0];
  assert.equal(row.h, early[0]!.hash); assert.equal(Buffer.compare(row.xml, early[0]!.xml), 0);
  assert.equal(row.retain, '2032-12-31');
  assert.equal(row.gross_total, '138854'); assert.equal(row.split_payment, true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ksef243_purchase_rates WHERE invoice_id=$1', [row.id])).rows[0].n, 3);
  const open = (await pool.query('SELECT c.* FROM ksef243_purchase_corrections c JOIN ksef243_purchase_invoices i ON i.id=c.correction_id WHERE i.ksef_number=$1', [kor.ksefNumber])).rows;
  assert.equal(open.length, 1); assert.equal(open[0].resolved_invoice_id, null, 'the original has not arrived yet');
  const cp = (await sync()).checkpoint;
  assert.equal(cp.window, null);
  // Again: nothing new, nothing twice.
  const again = await run();
  assert.equal(again.stored, 0); assert.deepEqual(await stored(), expected);
  // The original arrives later; its KOR reference resolves both ways.
  const orig = fake.addReceivedInvoice({ xml: receivedFa3({ number: 'FZ/ORYG/9/2026', date: '2026-09-30' }), permanentStorageDate: new Date(Date.now() - 1000), invoicingDate: new Date(Date.now() - 1000) });
  assert.equal((await run()).stored, 1);
  const link = (await pool.query('SELECT c.resolved_by,o.ksef_number FROM ksef243_purchase_corrections c JOIN ksef243_purchase_invoices o ON o.id=c.resolved_invoice_id WHERE c.correction_id=$1', [open[0].correction_id])).rows[0];
  assert.deepEqual(link, { resolved_by: 'invoice_number', ksef_number: orig.ksefNumber });
  const origId = (await pool.query('SELECT id FROM ksef243_purchase_invoices WHERE ksef_number=$1', [orig.ksefNumber])).rows[0].id;
  const detail = await ok(who.viewer!, 'GET', '/api/ksef243/invoices/' + origId);
  assert.equal(detail.corrected_by[0].ksef_number, kor.ksefNumber);
  // A refused file served correctly later: "Pobierz ponownie" stores it and resolves the reject.
  fake.tamperDownload(bad.ksefNumber, null);
  assert.equal((await call(who.viewer!, 'POST', `/api/ksef243/rejects/${bad.ksefNumber}/retry`, {})).statusCode, 403);
  const retried = await ok(who.operator!, 'POST', `/api/ksef243/rejects/${bad.ksefNumber}/retry`, {});
  assert.equal(retried.stored, true);
  assert.notEqual((await pool.query('SELECT resolved_at FROM ksef243_purchase_rejects WHERE ksef_number=$1', [bad.ksefNumber])).rows[0].resolved_at, null);
});

test('lost page: KSeF fails after the first page; the next run continues from the stored checkpoint without a gap', async () => {
  await restartFrom('2026-10-26T00:00:00Z');
  const fresh = Array.from({ length: 25 }, (_, i) => add(`2026-10-26T${String(10 + Math.floor(i / 3)).padStart(2, '0')}:0${i % 3}:00.000Z`));
  const before = fake.queries().length;
  fake.onQuery((_q, n) => { if (n === before + 1) fake.failNext('invoices/query/metadata', 503, 5); });
  const r = await run();
  fake.onQuery(null);
  assert.equal(r.outcome, 'unavailable', JSON.stringify(r));
  const s = await sync();
  assert.equal(s.lease_token, null, 'the lease is released'); assert.match(s.last_error, /niedostępny/);
  assert.equal(r.stored, 10);
  assert.ok(fake.queries().length > before);
  const r2 = await run();
  assert.equal(r2.outcome, 'ok');
  const all = await stored();
  for (const f of fresh) assert.ok(all.includes(f.ksefNumber), 'no gap');
  assert.equal(new Set(all).size, all.length);
});

test('a file whose date the table cannot hold is a reject of that invoice; its neighbours on the page are stored (review B1)', async () => {
  await restartFrom('2026-10-26T00:00:00Z');
  const before = add('2026-10-26T20:00:00.000Z'), odd = add('2026-10-26T20:01:00.000Z', { date: '0000-01-01' }), after = add('2026-10-26T20:02:00.000Z');
  const r = await run();
  assert.equal(r.outcome, 'ok', JSON.stringify(r));
  const all = await stored();
  assert.ok(all.includes(before.ksefNumber) && all.includes(after.ksefNumber), 'the good invoices of the page are stored');
  assert.equal(all.includes(odd.ksefNumber), false);
  const rej = (await pool.query('SELECT code,reason FROM ksef243_purchase_rejects WHERE ksef_number=$1', [odd.ksefNumber])).rows[0];
  assert.equal(rej.code, 'unstorable'); assert.match(rej.reason, /data/i);
});

test('a listing entry the parser refuses is a reject of that invoice; its neighbours on the page are stored (review M1)', async () => {
  const poison = [{ gross: '1000000000000000.00' }, { gross: '5000000000000000.00' }, { number: '😀'.repeat(200) }, { sellerName: '😀'.repeat(300) }];
  let minute = 30;
  for (const o of poison) {
    await restartFrom('2026-10-26T21:00:00Z'); // each page is read from a point before it
    const t = () => `2026-10-26T21:${String(minute++).padStart(2, '0')}:00.000Z`;
    const good1 = add(t()), odd = add(t(), o), good2 = add(t());
    const r = await run();
    assert.ok(['ok', 'partial'].includes(r.outcome), JSON.stringify(o) + ' ' + JSON.stringify(r));
    const all = await stored();
    assert.ok(all.includes(good1.ksefNumber) && all.includes(good2.ksefNumber), 'neighbours stored: ' + JSON.stringify(o).slice(0, 40));
    const rej = (await pool.query('SELECT code FROM ksef243_purchase_rejects WHERE ksef_number=$1', [odd.ksefNumber])).rows[0];
    assert.ok(all.includes(odd.ksefNumber) || rej, 'the odd one is stored or a reject');
  }
  // P_13_1 of 8e15: the metadata net amount is beyond a safe double; the invoice itself is FA(3)-valid.
  await restartFrom('2026-10-26T21:00:00Z');
  const g1 = add(`2026-10-26T21:${minute++}:00.000Z`), big = fake.addReceivedInvoice({ xml: Buffer.from(receivedFa3({ number: 'FZ/DUZA' }).toString('utf8').replace('<P_13_1>1000.00', '<P_13_1>8000000000000000.00'), 'utf8'),
    permanentStorageDate: at(`2026-10-26T21:${minute}:00.000Z`), invoicingDate: at(`2026-10-26T21:${minute++}:00.000Z`) }), g2 = add(`2026-10-26T21:${minute++}:00.000Z`);
  const r = await run();
  assert.ok(['ok', 'partial'].includes(r.outcome), JSON.stringify(r));
  const all = await stored();
  assert.ok(all.includes(g1.ksefNumber) && all.includes(g2.ksefNumber));
  assert.ok(all.includes(big.ksefNumber) || (await pool.query('SELECT 1 FROM ksef243_purchase_rejects WHERE ksef_number=$1', [big.ksefNumber])).rowCount);
});

test('duplicate page: a run repeated from an older checkpoint re-reads the same pages and stores nothing twice', async () => {
  await restartFrom('2026-10-26T00:00:00Z');
  const before = await stored();
  // On a slow machine the run may stop at its budget ('partial'); the next one continues from the stored checkpoint.
  let stored0 = 0, duplicates = 0;
  for (let i = 0; i < 5; i++) {
    const r = await run();
    assert.ok(['ok', 'partial'].includes(r.outcome), JSON.stringify(r));
    stored0 += r.stored; duplicates += r.duplicates;
    if (r.outcome === 'ok') break;
  }
  assert.equal(stored0, 0); assert.ok(duplicates >= 25, String(duplicates));
  assert.deepEqual(await stored(), before);
});

test('token expiry mid-fetch: the access token is refreshed and the run completes with nothing lost', async () => {
  await restartFrom('2026-10-27T00:00:00Z');
  const fresh = Array.from({ length: 22 }, (_, i) => add(`2026-10-27T0${Math.floor(i / 10)}:${String(i).padStart(2, '0')}:00.000Z`));
  const refreshes = fake.stats()['auth/token/refresh'] ?? 0;
  const q0 = fake.queries().length;
  fake.onQuery((_q, n) => { if (n === q0 + 1) fake.expireAccessTokens(); });
  const r = await run();
  fake.onQuery(null);
  assert.equal(r.outcome, 'ok', JSON.stringify(r));
  assert.ok((fake.stats()['auth/token/refresh'] ?? 0) > refreshes || r.renewed > 0, 'renewed mid-fetch');
  const all = await stored();
  for (const f of fresh) assert.ok(all.includes(f.ksefNumber));
});

test('restart mid-fetch: a crash after the first stored page, then a run from the checkpoint; a dead worker\'s lease waits for expiry', async () => {
  await restartFrom('2026-10-27T04:00:00Z');
  const base = await stored();
  const fresh = Array.from({ length: 21 }, (_, i) => add(`2026-10-27T05:${String(i).padStart(2, '0')}:00.000Z`));
  const crash = await run({ afterStore: n => { if (n === 1) throw new Error('awaria procesu po zapisie strony'); } });
  assert.equal(crash.outcome, 'error');
  const afterCrash = await stored();
  assert.equal(afterCrash.length, base.length + 10, 'the first page committed, the rest not');
  // A worker that died holding the lease: the next run waits; after the lease expires it continues.
  await pool.query("UPDATE ksef243_purchase_sync SET lease_token=$3,leased_until=clock_timestamp()+interval '1 minute' WHERE tenant_id=$1 AND nip=$2", [DEMO_TENANT, BUYER, randomUUID()]);
  assert.equal((await run()).outcome, 'busy');
  await pool.query("UPDATE ksef243_purchase_sync SET leased_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND nip=$2", [DEMO_TENANT, BUYER]);
  const r = await run();
  assert.equal(r.outcome, 'ok', JSON.stringify(r));
  const all = await stored();
  for (const f of fresh) assert.ok(all.includes(f.ksefNumber), 'no gap after the restart');
  assert.equal(new Set(all).size, all.length, 'no duplicate after the restart');
});

test('a lease taken over mid-run: the old run never writes the checkpoint again', async () => {
  await restartFrom('2026-10-27T00:00:00Z');
  add('2026-10-27T07:00:00.000Z');
  let stolen = '';
  const r = await run({ afterStore: async n => { if (n === 1) { stolen = randomUUID(); await pool.query('UPDATE ksef243_purchase_sync SET lease_token=$3 WHERE tenant_id=$1 AND nip=$2', [DEMO_TENANT, BUYER, stolen]); } } });
  assert.equal(r.outcome, 'busy', JSON.stringify(r));
  assert.equal((await sync()).lease_token, stolen, 'the new holder keeps its lease');
  await pool.query('UPDATE ksef243_purchase_sync SET lease_token=NULL,leased_until=NULL WHERE tenant_id=$1 AND nip=$2', [DEMO_TENANT, BUYER]);
});

test('429 with Retry-After: the job is rescheduled at Retry-After and the checkpoint is unchanged', async () => {
  await restartFrom('2026-10-27T00:00:00Z');
  const cp = (await sync()).checkpoint;
  fake.failNext('invoices/query/metadata', 429, 1, '120');
  const jobId = randomUUID(), lease = randomUUID();
  await pool.query("DELETE FROM jobs WHERE tenant_id=$1 AND kind='ksef.purchase.fetch' AND state='pending'", [DEMO_TENANT]);
  await pool.query(`INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,state,attempts,locked_at,lease_token) VALUES($1,$2,'ksef.purchase.fetch',$3,$4,'running',1,now(),$5)`,
    [jobId, DEMO_TENANT, JSON.stringify({ nip: BUYER, actor_id: who.admin!.userId, failures: 0 }), 'ksef.purchase.fetch:' + jobId, lease]);
  await processKsefPurchaseFetchJob({ id: jobId, tenant_id: DEMO_TENANT, payload: { nip: BUYER, actor_id: who.admin!.userId, failures: 0 }, lease_token: lease }, opts());
  assert.equal((await pool.query('SELECT state FROM jobs WHERE id=$1', [jobId])).rows[0].state, 'done');
  const next = (await pool.query(`SELECT extract(epoch FROM run_at-now())::int s FROM jobs WHERE tenant_id=$1 AND kind='ksef.purchase.fetch' AND state='pending'`, [DEMO_TENANT])).rows;
  assert.equal(next.length, 1); assert.ok(next[0].s >= 100 && next[0].s <= 130, 'next run at Retry-After: ' + next[0].s);
  const s = await sync();
  assert.deepEqual(s.checkpoint, cp); assert.notEqual(s.rate_limited_until, null);
  // The manual run respects the limit and says when to try again.
  const manual = await ok(who.operator!, 'POST', '/api/ksef243/sync/' + BUYER + '/run', {});
  assert.equal(manual.outcome, 'rate_limited');
  await pool.query('UPDATE ksef243_purchase_sync SET rate_limited_until=NULL WHERE tenant_id=$1 AND nip=$2', [DEMO_TENANT, BUYER]);
});

test('access: viewer reads only; the other tenant gets 404 and RLS shows it nothing', async () => {
  const id = (await pool.query('SELECT id FROM ksef243_purchase_invoices WHERE tenant_id=$1 ORDER BY issue_date LIMIT 1', [DEMO_TENANT])).rows[0].id;
  const list = await ok(who.viewer!, 'GET', '/api/ksef243/invoices?limit=5');
  assert.equal(list.items.length, 5); assert.ok(list.next);
  assert.equal(list.items[0].xml, undefined, 'the list carries no file');
  const page2 = await ok(who.viewer!, 'GET', '/api/ksef243/invoices?limit=5&before=' + encodeURIComponent(list.next));
  assert.equal(page2.items.some((x: any) => list.items.some((y: any) => y.id === x.id)), false, 'keyset pages do not overlap');
  const x = await call(who.viewer!, 'GET', `/api/ksef243/invoices/${id}/fa3.xml`);
  assert.equal(x.statusCode, 200); assert.match(x.body, /<Faktura xmlns=/);
  assert.equal((await call(who.viewer!, 'PATCH', '/api/ksef243/invoices/' + id, { version: 1, status: 'accepted' })).statusCode, 403);
  assert.equal((await call(who.viewer!, 'POST', '/api/ksef243/sync/' + BUYER + '/run', {})).statusCode, 403);
  assert.equal((await call(who.viewer!, 'GET', '/api/ksef243/export.zip')).statusCode, 403);
  for (const url of [`/api/ksef243/invoices/${id}`, `/api/ksef243/invoices/${id}/fa3.xml`]) assert.equal((await call(who.other!, 'GET', url)).statusCode, 404, url);
  assert.equal((await call(who.other!, 'PATCH', '/api/ksef243/invoices/' + id, { version: 1, status: 'accepted' })).statusCode, 404);
  assert.equal((await ok(who.other!, 'GET', '/api/ksef243/invoices')).items.length, 0);
  assert.equal((await call(who.other!, 'POST', '/api/ksef243/sync/' + BUYER + '/run', {})).statusCode, 404, 'no fetch state of that NIP in the other tenant');
  const seen = await asApp(SECOND_TENANT, async c => (await c.query('SELECT (SELECT count(*) FROM ksef243_purchase_invoices)::int i,(SELECT count(*) FROM ksef243_purchase_sync)::int s,(SELECT count(*) FROM ksef243_purchase_rejects)::int r')).rows[0]);
  assert.deepEqual(seen, { i: 0, s: 0, r: 0 });
  // Writing into the other tenant through the policy is refused.
  await assert.rejects(asApp(SECOND_TENANT, c => c.query(`INSERT INTO ksef243_purchase_events(tenant_id,nip,kind,message) VALUES($1,$2,'run','x')`, [DEMO_TENANT, BUYER])), /row-level security/);
});

test('KSeF data is immutable: dyna_app cannot change, delete or truncate; the owner cannot either; the purge deletes only past retention without a hold', async () => {
  const id = (await pool.query('SELECT id FROM ksef243_purchase_invoices WHERE tenant_id=$1 LIMIT 1', [DEMO_TENANT])).rows[0].id;
  for (const sql of ['UPDATE ksef243_purchase_invoices SET seller_name=$1', 'UPDATE ksef243_purchase_invoices SET xml=$1::bytea', 'DELETE FROM ksef243_purchase_invoices WHERE id::text<>$1', 'DELETE FROM ksef243_purchase_events WHERE id::text<>$1'])
    await assert.rejects(asApp(DEMO_TENANT, c => c.query(sql, ['x'])), /permission denied/, sql);
  await assert.rejects(asApp(DEMO_TENANT, c => c.query('TRUNCATE ksef243_purchase_rates')), /permission denied/);
  // The purge flag set by the application role itself opens nothing (review N1).
  await assert.rejects(asApp(DEMO_TENANT, async c => { await c.query("SELECT set_config('ksef243.purge',$1,true)", [DEMO_TENANT]);
    return c.query('UPDATE ksef243_purchase_corrections SET resolved_invoice_id=NULL,resolved_by=NULL,resolved_at=NULL WHERE resolved_invoice_id IS NOT NULL'); }), /ustala się raz/);
  await assert.rejects(pool.query('UPDATE ksef243_purchase_invoices SET seller_name=$2 WHERE id=$1', [id, 'Podmieniony']), /nienaruszalna/);
  await assert.rejects(pool.query('UPDATE ksef243_purchase_invoices SET retain_until=$2 WHERE id=$1', [id, '2032-12-30']), /CHECK|nienaruszalna|violates/);
  await assert.rejects(pool.query('DELETE FROM ksef243_purchase_invoices WHERE id=$1', [id]), /przechowywana do/);
  await assert.rejects(pool.query('TRUNCATE ksef243_purchase_events'), /nienaruszalny/);
  await assert.rejects(pool.query('DELETE FROM ksef243_purchase_sync'), /nienaruszalny/);
  // Two invoices from 2018 (retention ended 31.12.2024), one under a legal hold, inserted by the owner.
  const old = async (hold: boolean) => {
    const xml = receivedFa3({ number: 'FZ/STARA/' + randomUUID().slice(0, 4), date: '2018-03-01' }), ks = `${SELLER}-20180301-${randomBytes(6).toString('hex').toUpperCase()}-00`;
    return (await pool.query(`INSERT INTO ksef243_purchase_invoices(tenant_id,buyer_nip,ksef_number,seller_nip,seller_name,invoice_number,invoice_type,fa3_kind,issue_date,invoicing_date,currency,
      net_total,vat_total,gross_total,split_payment,cash_method,self_invoicing,reverse_charge,has_attachment,xml,xml_bytes,xml_sha256,invoice_hash,source,retain_until,legal_hold)
      VALUES($1,$2,$3,$4,'Stara hurtownia','FZ/STARA','Vat','VAT','2018-03-01','2018-03-01T10:00:00Z','PLN',100,23,123,false,false,false,false,false,$5::bytea,octet_length($5::bytea),encode(sha256($5::bytea),'hex'),encode(sha256($5::bytea),'base64'),'query','2024-12-31',$6) RETURNING id`,
    [DEMO_TENANT, BUYER, ks, SELLER, xml, hold])).rows[0].id as string;
  };
  const gone = await old(false), held = await old(true);
  await pool.query(`INSERT INTO ksef243_purchase_rates(tenant_id,invoice_id,rate_code,net,vat) VALUES($1,$2,'23',100,23)`, [DEMO_TENANT, gone]);
  const purged = await asApp(DEMO_TENANT, async c => { const r = (await c.query('SELECT ksef243_purchase_purge() p')).rows[0].p; await c.query('COMMIT'); return r; });
  assert.equal(purged.invoices, 1);
  assert.deepEqual((await pool.query('SELECT id FROM ksef243_purchase_invoices WHERE id=ANY($1::uuid[])', [[gone, held]])).rows.map(r => r.id), [held], 'the held one stays');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ksef243_purchase_rates WHERE invoice_id=$1', [gone])).rows[0].n, 0);
  assert.ok((await stored()).length > 50, 'current invoices are kept');
  // The purge of one tenant never touches another; without a tenant it refuses.
  await assert.rejects(pool.query('SELECT ksef243_purchase_purge()'), /Tenant scope required/);
});

test('workflow: operator accepts and books, only the administrator reopens a booked invoice or sets a legal hold; a stale form is refused', async () => {
  const inv = (await ok(who.operator!, 'GET', '/api/ksef243/invoices?status=new&kind=VAT&limit=1')).items[0];
  const a = await ok(who.operator!, 'PATCH', '/api/ksef243/invoices/' + inv.id, { version: inv.version, status: 'accepted' });
  assert.equal(a.status, 'accepted');
  assert.equal((await call(who.operator!, 'PATCH', '/api/ksef243/invoices/' + inv.id, { version: inv.version, status: 'booked' })).statusCode, 409, 'stale version');
  assert.equal((await call(who.operator!, 'PATCH', '/api/ksef243/invoices/' + inv.id, { version: a.version, note: 'a\u0000b' })).statusCode, 422, 'NUL in a note (review M1-a)');
  const b = await ok(who.operator!, 'PATCH', '/api/ksef243/invoices/' + inv.id, { version: a.version, status: 'booked', accounting_ref: 'KS/10/2026/17' });
  assert.equal(b.status, 'booked'); assert.equal(b.accounting_ref, 'KS/10/2026/17');
  assert.equal((await call(who.operator!, 'PATCH', '/api/ksef243/invoices/' + inv.id, { version: b.version, status: 'accepted' })).statusCode, 403);
  assert.equal((await call(who.operator!, 'PATCH', '/api/ksef243/invoices/' + inv.id, { version: b.version, legal_hold: true })).statusCode, 403);
  const h = await ok(who.admin!, 'PATCH', '/api/ksef243/invoices/' + inv.id, { version: b.version, legal_hold: true });
  assert.equal(h.legal_hold, true);
  const audit = (await pool.query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND action LIKE 'ksef.purchase.%'", [DEMO_TENANT])).rows[0].n;
  assert.ok(audit >= 3, 'workflow changes are audited');
  const booked = await ok(who.viewer!, 'GET', '/api/ksef243/invoices?status=booked');
  assert.deepEqual(booked.items.map((x: any) => x.id), [inv.id]);
});

test('the accountant\'s package: CSV and the exact FA(3) files of the filtered invoices; the export is logged', async () => {
  const r = await call(who.operator!, 'GET', '/api/ksef243/export.zip?from=2026-10-01&to=2026-10-12');
  assert.equal(r.statusCode, 200, r.body);
  const zip = r.rawPayload, list = (await ok(who.operator!, 'GET', '/api/ksef243/invoices?from=2026-10-01&to=2026-10-12&limit=200')).items;
  assert.ok(list.length >= 10);
  const text = zip.toString('latin1');
  assert.match(text, /zestawienie\.csv/);
  for (const i of list) assert.ok(text.includes(`faktury/${i.ksef_number}.xml`), i.ksef_number);
  const one = (await pool.query('SELECT xml FROM ksef243_purchase_invoices WHERE id=$1', [list[0].id])).rows[0].xml as Buffer;
  assert.ok(zip.includes(one), 'the file inside the package is byte-equal');
  const ev = (await pool.query("SELECT detail FROM ksef243_purchase_events WHERE tenant_id=$1 AND kind='export' ORDER BY at DESC LIMIT 1", [DEMO_TENANT])).rows[0];
  assert.equal(ev.detail.count, list.length); assert.equal(ev.detail.actor_role, 'operator');
});

test('RODO: a seller who is a CRM client gets the purchase invoices in the export; anonymisation keeps them until retain_until', async () => {
  const xml = receivedFa3({ seller: OTHER_SELLER, sellerName: 'Jan Kowalski Usługi', number: 'FZ/JDG/1', date: '2026-10-20' });
  const inv = fake.addReceivedInvoice({ xml, permanentStorageDate: at('2026-10-27T08:30:00.000Z') });
  await restartFrom('2026-10-27T08:00:00Z');
  assert.equal((await run()).outcome, 'ok');
  const status = (await pool.query('SELECT id FROM crm_statuses WHERE tenant_id=$1 ORDER BY 1 LIMIT 1', [DEMO_TENANT])).rows[0].id;
  const client = (await pool.query(`INSERT INTO crm_clients(tenant_id,status_id,profile) VALUES($1,$2,$3) RETURNING id`,
    [DEMO_TENANT, status, JSON.stringify({ email: 'jan.kowalski.243@example.test', invoice_tax_id: 'PL' + OTHER_SELLER, invoice_fullname: 'Jan Kowalski' })])).rows[0].id;
  const e = await exportCustomer(who.admin!, { crm_client_id: client }, 'Wniosek art. 15', { key: localConfig.encryptionKey });
  const text = e.archive.toString('utf8');
  assert.match(text, /faktury_zakupowe_ksef/); assert.ok(text.includes(inv.ksefNumber));
  const p = await previewAnonymisation(who.admin!, { crm_client_id: client }, { key: localConfig.encryptionKey });
  const kept = p.plan.keep.filter((k: any) => k.table === 'ksef243_purchase_invoices');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].basis, 'tax_retention'); assert.equal(kept[0].retention_end, '2032-12-31'); assert.equal(kept[0].due_on, '2033-01-01');
  assert.equal(p.plan.anonymise.some((x: any) => x.table === 'ksef243_purchase_invoices'), false);
  const after = (await pool.query("SELECT seller_name,encode(sha256(xml),'base64') h FROM ksef243_purchase_invoices WHERE ksef_number=$1", [inv.ksefNumber])).rows[0];
  assert.deepEqual(after, { seller_name: 'Jan Kowalski Usługi', h: inv.hash });
});

test('the ten guards and warehouse_wz_issuer_guards stay true', async () => {
  const g = await guards();
  assert.deepEqual(Object.entries(g).filter(([, v]) => v !== true), []);
  assert.equal(createHash('sha256').update('243').digest('hex').length, 64);
});
