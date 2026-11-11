/** KSeF purchase-side client against the local purchase fake (127.0.0.1, random port; no MF host):
 * paging with overlaps and same-date groups, duplicates, malformed/tampered files refused but not
 * blocking, KOR linking, token expiry and 401 in the middle of paging, 429 backoff and rescheduling,
 * crash + restart from the stored checkpoint, the encrypted export package, MF switched off, and a 229
 * send still working through the purchase fake. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { KsefClient, KsefUnavailableError } from '../server/ksef229-client';
import { startFakeKsefPurchase, type FakeKsefPurchase } from '../server/ksef229-fake-purchase';
import { KsefPurchaseClient, KsefRateLimitedError, checkedEntry, syncPurchaseInvoices, type FetchedPurchaseInvoice, type PurchaseReject, type PurchaseStore } from '../server/ksef-purchase-client';
import { advanceAfterExport, initialPurchaseCheckpoint, linkCorrection, parsePurchaseCheckpoint, startPurchaseWindow, type PurchaseCheckpoint } from '../server/ksef-purchase-model';
import { BUYER, SELLER, receivedFa3 } from './ksef-purchase-fixtures';

const TOKEN = 'lokalny-token-zakupowy-0001';
type Env = { fake: FakeKsefPurchase; clock: { ms: number }; sleeps: number[]; client: (extra?: Record<string, unknown>) => KsefPurchaseClient };
async function withFake(fn: (e: Env) => Promise<void>) {
  const clock = { ms: Date.parse('2026-10-26T10:00:00.000Z') }, sleeps: number[] = [];
  const fake = await startFakeKsefPurchase({ now: () => new Date(clock.ms) });
  const sleep = async (ms: number) => { sleeps.push(ms); clock.ms += ms; };
  const client = (extra = {}) => new KsefPurchaseClient({ environment: 'local_fake', baseUrl: fake.url, nip: BUYER, credentials: { method: 'token', token: TOKEN }, sleep, now: () => clock.ms, random: () => 1, exportPollDelaysMs: [10, 10, 10], ...extra });
  try { await fn({ fake, clock, sleeps, client }); } finally { await fake.close(); }
}
/** In-memory stand-in for the future tables: UNIQUE KSeF number, rejects, checkpoint (as JSON). */
function memoryStore(o: { failOnCall?: number } = {}) {
  const invoices = new Map<string, FetchedPurchaseInvoice>(), rejects = new Map<string, PurchaseReject>();
  let saved: string | null = null, calls = 0;
  const store: PurchaseStore = async b => {
    if (++calls === o.failOnCall) throw new Error('awaria procesu przed zapisem');
    let duplicates = 0;
    for (const i of b.invoices) { if (invoices.has(i.meta.ksefNumber)) duplicates++; else invoices.set(i.meta.ksefNumber, i); }
    for (const r of b.rejects) rejects.set(r.ksefNumber, r);
    saved = JSON.stringify(b.checkpoint);
    return { duplicates };
  };
  return { store, invoices, rejects, checkpoint: (): PurchaseCheckpoint | null => saved ? parsePurchaseCheckpoint(JSON.parse(saved)) : null };
}
const START = '2026-10-01T00:00:00.000Z';
const at = (iso: string) => new Date(iso);
function addMany(fake: FakeKsefPurchase, dates: string[]) {
  return dates.map((d, i) => fake.addReceivedInvoice({ xml: receivedFa3({ number: `FZ/${i + 1}/10/2026`, date: d.slice(0, 10) }), permanentStorageDate: at(d), invoicingDate: at(d) }));
}

test('paging: a same-date group across the page boundary, an invoice inserted between pages and a listed duplicate; every invoice stored once', () => withFake(async ({ fake, client }) => {
  const dates = [...Array.from({ length: 6 }, (_, i) => `2026-10-0${i + 2}T08:00:00.000Z`), ...Array.from({ length: 12 }, () => '2026-10-10T12:00:00.000Z'), ...Array.from({ length: 7 }, (_, i) => `2026-10-2${i}T08:00:00.000Z`)];
  const added = addMany(fake, dates);
  fake.addReceivedInvoice({ xml: added[3]!.xml, ksefNumber: added[3]!.ksefNumber, permanentStorageDate: at(dates[3]!) }); // KSeF lists one number twice
  fake.onQuery((_q, n) => { if (n === 2) added.push(fake.addReceivedInvoice({ xml: receivedFa3({ number: 'FZ/late' }), permanentStorageDate: at('2026-10-10T12:00:00.000Z') })); });
  const m = memoryStore(), c = client();
  const r = await syncPurchaseInvoices({ client: c, checkpoint: initialPurchaseCheckpoint(BUYER, START), store: m.store, pageSize: 10 });
  assert.equal(r.done, true);
  assert.deepEqual([...m.invoices.keys()].sort(), [...new Set(added.map(a => a.ksefNumber))].sort(), 'nothing skipped, nothing twice');
  assert.equal(m.invoices.size, 26); assert.equal(r.stored, 26); assert.equal(r.rejected, 0);
  assert.ok(r.overlap >= 2, `boundary re-reads were filtered (${r.overlap})`);
  const qs = fake.queries();
  assert.ok(qs.every(q => q.body.subjectType === 'Subject2' && q.body.dateRange.dateType === 'PermanentStorage' && q.body.dateRange.restrictToPermanentStorageHwmDate === true && q.sortOrder === 'Asc'));
  assert.ok(qs.some(q => q.body.dateRange.from === '2026-10-10T12:00:00.000Z'), 'a later page starts at the boundary date, inclusive');
  assert.equal(m.checkpoint()!.window, null); assert.equal(m.checkpoint()!.completedUpTo, '2026-10-26T10:00:00.000Z');
  assert.equal(fake.stats()['invoices/download'], 26);
  assert.equal(c.counters.logins, 1);
  // Running again from the start: every invoice is a duplicate for the store, no new rows.
  const again = await syncPurchaseInvoices({ client: c, checkpoint: initialPurchaseCheckpoint(BUYER, START), store: m.store, pageSize: 10 });
  assert.equal(again.stored, 0); assert.equal(again.duplicates, 26); assert.equal(m.invoices.size, 26);
}));

test('malformed, hostile, tampered or foreign files are refused as rejects and do not block the checkpoint; KOR linked to its original', () => withFake(async ({ fake, client }) => {
  const d = (x: string) => at(`2026-10-${x}T09:00:00.000Z`);
  const orig = fake.addReceivedInvoice({ xml: receivedFa3({ number: 'FZ/7/10/2026', date: '2026-10-05' }), permanentStorageDate: d('05') });
  const dtd = fake.addReceivedInvoice({ xml: `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${receivedFa3({ number: 'FZ/8' }).toString().replace('<?xml version="1.0" encoding="UTF-8"?>', '')}`, invoiceNumber: 'FZ/8', sellerNip: SELLER, buyerNip: BUYER, permanentStorageDate: d('06') });
  const cut = fake.addReceivedInvoice({ xml: receivedFa3({ number: 'FZ/9' }).subarray(0, 400), invoiceNumber: 'FZ/9', issueDate: '2026-10-20', sellerNip: SELLER, buyerNip: BUYER, permanentStorageDate: d('07') });
  const foreign = fake.addReceivedInvoice({ xml: receivedFa3({ number: 'FZ/10', buyer: '7740001454' }), buyerNip: BUYER, permanentStorageDate: d('08') });
  const tampered = fake.addReceivedInvoice({ xml: receivedFa3({ number: 'FZ/11' }), permanentStorageDate: d('09') });
  fake.tamperDownload(tampered.ksefNumber, receivedFa3({ number: 'FZ/11', gross: '1.00' }));
  const kor = fake.addReceivedInvoice({ xml: receivedFa3({ kind: 'KOR', number: 'FZK/1/10/2026', date: '2026-10-12', korRefs: [{ number: 'FZ/7/10/2026', date: '2026-10-05', ksef: orig.ksefNumber }] }), permanentStorageDate: d('12') });
  const m = memoryStore();
  const r = await syncPurchaseInvoices({ client: client(), checkpoint: initialPurchaseCheckpoint(BUYER, START), store: m.store });
  assert.equal(r.done, true);
  assert.deepEqual([...m.invoices.keys()].sort(), [orig.ksefNumber, kor.ksefNumber].sort());
  assert.deepEqual(Object.fromEntries([...m.rejects.values()].map(x => [x.ksefNumber, x.code])), { [dtd.ksefNumber]: 'xml_dtd', [cut.ksefNumber]: 'xml_syntax', [foreign.ksefNumber]: 'buyer_mismatch', [tampered.ksefNumber]: 'hash_mismatch' });
  assert.ok([...m.rejects.values()].every(x => !/passwd|<\?xml/.test(x.reason)), 'a reject reason carries no file content');
  const known = [...m.invoices.values()].map(i => ({ ksefNumber: i.meta.ksefNumber, sellerNip: i.parsed.seller.nip, invoiceNumber: i.parsed.invoiceNumber, issueDate: i.parsed.issueDate }));
  const k = m.invoices.get(kor.ksefNumber)!;
  assert.equal(k.parsed.kind, 'KOR');
  assert.deepEqual(linkCorrection({ sellerNip: k.parsed.seller.nip, parsed: k.parsed }, known).map(l => [l.resolvedKsefNumber, l.by]), [[orig.ksefNumber, 'ksef_number']]);
  assert.equal(m.checkpoint()!.completedUpTo, '2026-10-26T10:00:00.000Z');
}));

test('token expiry in the middle of paging: refreshed with the refresh token (no second login); a server-side 401 renews once and repeats the page', () => withFake(async ({ fake, clock, client }) => {
  addMany(fake, Array.from({ length: 35 }, (_, i) => new Date(Date.parse('2026-10-02T00:00:00.000Z') + i * 3600_000).toISOString()));
  fake.onQuery((_q, n) => { if (n === 2) clock.ms += 20 * 60_000; if (n === 3) fake.expireAccessTokens(); });
  const m = memoryStore(), c = client();
  const r = await syncPurchaseInvoices({ client: c, checkpoint: initialPurchaseCheckpoint(BUYER, START), store: m.store, pageSize: 10 });
  assert.equal(r.done, true); assert.equal(m.invoices.size, 35);
  assert.equal(c.counters.logins, 1, 'one full login only');
  assert.ok(c.counters.refreshes >= 2, `refreshed after expiry and after the 401 (${c.counters.refreshes})`);
  assert.equal(c.counters.renewedAfter401, 1);
  assert.ok(fake.stats()['auth/token/refresh']! >= 2);
}));

test('429: Retry-After honoured with backoff; a long Retry-After ends the run as KsefRateLimitedError without moving the checkpoint; 5xx retried then unavailable', () => withFake(async ({ fake, sleeps, client }) => {
  addMany(fake, ['2026-10-03T08:00:00.000Z', '2026-10-04T08:00:00.000Z']);
  fake.failNext('invoices/query/metadata', 429, 2, '2');
  const m = memoryStore(), c = client();
  const r = await syncPurchaseInvoices({ client: c, checkpoint: initialPurchaseCheckpoint(BUYER, START), store: m.store });
  assert.equal(m.invoices.size, 2); assert.equal(r.done, true);
  assert.equal(sleeps.filter(s => s === 2000).length, 2); assert.equal(c.counters.retries, 2);
  assert.equal(fake.stats()['invoices/query/metadata:429'], 2);

  const before = m.checkpoint()!;
  fake.addReceivedInvoice({ xml: receivedFa3({ number: 'FZ/n' }) });
  fake.failNext('invoices/query/metadata', 429, 1, '120');
  const e = await syncPurchaseInvoices({ client: c, checkpoint: before, store: m.store }).catch(x => x);
  assert.ok(e instanceof KsefRateLimitedError, String(e)); assert.equal(e.retryAfterMs, 120_000); assert.ok(!String(e.message).includes(TOKEN));
  assert.deepEqual(m.checkpoint(), before, 'nothing stored, the job reschedules');

  fake.failNext('invoices/download', 503, 9, '1');
  const u = await syncPurchaseInvoices({ client: c, checkpoint: before, store: m.store }).catch(x => x);
  assert.ok(u instanceof KsefUnavailableError && !(u instanceof KsefRateLimitedError)); assert.equal(u.status, 503);
  assert.equal(fake.stats()['invoices/download:503'], 5, 'maxAttempts reads, then unavailable');
  assert.deepEqual(m.checkpoint(), before);
}));

test('crash between pages: the restarted process resumes from the stored checkpoint JSON and re-reads the unsaved page; nothing skipped', () => withFake(async ({ fake, client }) => {
  const added = addMany(fake, Array.from({ length: 30 }, (_, i) => new Date(Date.parse('2026-10-02T00:00:00.000Z') + Math.floor(i / 4) * 3600_000).toISOString()));
  const m = memoryStore({ failOnCall: 2 });
  await assert.rejects(syncPurchaseInvoices({ client: client(), checkpoint: initialPurchaseCheckpoint(BUYER, START), store: m.store, pageSize: 10 }), /awaria procesu/);
  const saved = m.checkpoint()!;
  assert.ok(saved.window, 'stopped inside the window'); assert.equal(m.invoices.size, 10);
  const r = await syncPurchaseInvoices({ client: client(), checkpoint: saved, store: m.store, pageSize: 10 });
  assert.equal(r.done, true);
  assert.deepEqual([...m.invoices.keys()].sort(), added.map(a => a.ksefNumber).sort());
  // maxPages stops early with done=false and a resumable checkpoint
  const n = memoryStore();
  const part = await syncPurchaseInvoices({ client: client(), checkpoint: initialPurchaseCheckpoint(BUYER, START), store: n.store, pageSize: 10, maxPages: 1 });
  assert.equal(part.done, false); assert.equal(n.invoices.size, 10);
  await syncPurchaseInvoices({ client: client(), checkpoint: n.checkpoint()!, store: n.store, pageSize: 10 });
  assert.equal(n.invoices.size, 30);
}));

test('export package: AES key under the MF key, status polled, parts fetched without the token, hashes checked, decrypted, unzipped; truncation moves the window', () => withFake(async ({ fake, client }) => {
  const added = addMany(fake, ['2026-10-03T08:00:00.000Z', '2026-10-04T08:00:00.000Z', '2026-10-05T08:00:00.000Z', '2026-10-06T08:00:00.000Z', '2026-10-07T08:00:00.000Z']);
  fake.setExportPartSize(1000); fake.setExportPolls(2);
  const c = client(), cp = startPurchaseWindow(initialPurchaseCheckpoint(BUYER, START), '2026-10-26T10:00:00.000Z')!;
  const filters = { subjectType: 'Subject2' as const, dateRange: { dateType: 'PermanentStorage' as const, from: cp.window!.from, to: cp.window!.to, restrictToPermanentStorageHwmDate: true } };
  const h = await c.startExport(filters), st = await c.waitForExport(h.referenceNumber);
  assert.ok(st.package!.parts.length > 3, `several parts (${st.package!.parts.length})`); assert.equal(st.package!.invoiceCount, 5);
  const entries = await c.downloadExportPackage(h, st);
  assert.deepEqual(entries.map(e => e.meta.ksefNumber).sort(), added.map(a => a.ksefNumber).sort());
  for (const e of entries) assert.equal(checkedEntry(BUYER, e.meta, e.xml).parsed.buyer.nip, BUYER);
  assert.equal(fake.stats()['invoices/exports/status'], 3);

  fake.setTruncateAt(3);
  const h2 = await c.startExport(filters), st2 = await c.waitForExport(h2.referenceNumber), e2 = await c.downloadExportPackage(h2, st2);
  assert.equal(st2.package!.isTruncated, true); assert.equal(e2.length, 3);
  const adv = advanceAfterExport(cp, { isTruncated: true, lastDate: st2.package!.lastPermanentStorageDate, hwm: st2.package!.permanentStorageHwmDate, invoices: e2.map(e => e.meta) });
  assert.equal(adv.checkpoint.window!.cursorFrom, '2026-10-05T08:00:00.000Z');
  // a wrong key cannot read the package
  await assert.rejects(c.downloadExportPackage({ ...h2, key: Buffer.alloc(32, 7) }, st2), /odszyfrować|Skrót/);
}));

test('MF environments stay switched off; local fake only on loopback; a 229 send still works through the purchase fake', () => withFake(async ({ fake, client }) => {
  for (const environment of ['test', 'demo', 'prod'] as const)
    assert.throws(() => new KsefPurchaseClient({ environment, nip: BUYER, credentials: { method: 'token', token: TOKEN } }), /wyłączone w tej lokalnej wersji/);
  assert.throws(() => client({ baseUrl: 'http://10.0.0.5:4239/v2' }), /127\.0\.0\.1/);
  const sender = new KsefClient({ environment: 'local_fake', baseUrl: fake.url, nip: BUYER, credentials: { method: 'token', token: TOKEN }, sleep: async () => {} });
  const s = await sender.openOnlineSession(), sent = await sender.sendInvoice(s, receivedFa3({ seller: BUYER, buyer: SELLER, number: 'FV/229' }));
  const st = await sender.pollInvoice(s.referenceNumber, sent.referenceNumber);
  assert.equal(st.code, 200); assert.ok(st.ksefNumber);
  assert.equal(fake.inner.invoices().length, 1);
}));
