/** 229 KSeF 2.0 client against the local fake (127.0.0.1, random port; no MF host is ever
 * contacted): token and certificate login, online session with an FA (3) invoice, polling,
 * UPO, QR pages, refusals (450/430/440), unavailable/timeout/refused connection, the MF
 * environments switched off, loopback-only base URLs and no secret in any error. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { KsefClient, KsefRefusedError, KsefUnavailableError, ksefBaseUrl, type KsefClientOptions, type KsefCredentials } from '../server/ksef229-client';
import { startFakeKsef, type FakeKsef } from '../server/ksef229-fake';
import { isKsefNumber, sha256Base64, sha256Base64Url, signCertificateQrPath } from '../server/ksef229-crypto';

const NIP = '1234563218', TOKEN = 'lokalny-token-testowy-0001';
const fa3 = (nip = NIP, number = 'FV/1/10/2026', seller = nip) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"><Naglowek><KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>3</WariantFormularza><DataWytworzeniaFa>2026-10-23T09:00:00Z</DataWytworzeniaFa><SystemInfo>DYNAMINDS lokalnie</SystemInfo></Naglowek><Podmiot1><DaneIdentyfikacyjne><NIP>${seller}</NIP><Nazwa>Sprzedawca Testowy sp. z o.o.</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>ul. Testowa 1</AdresL1><AdresL2>00-001 Warszawa</AdresL2></Adres></Podmiot1><Podmiot2><DaneIdentyfikacyjne><NIP>5260250995</NIP><Nazwa>Nabywca Testowy S.A.</Nazwa></DaneIdentyfikacyjne><JST>2</JST><GV>2</GV></Podmiot2><Fa><KodWaluty>PLN</KodWaluty><P_1>2026-10-23</P_1><P_2>${number}</P_2><P_13_1>100.00</P_13_1><P_14_1>23.00</P_14_1><P_15>123.00</P_15><Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A><Zwolnienie><P_19N>1</P_19N></Zwolnienie><NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu><P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje><RodzajFaktury>VAT</RodzajFaktury><FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Usługa testowa</P_7><P_8A>szt.</P_8A><P_8B>1</P_8B><P_9A>100.00</P_9A><P_11>100.00</P_11><P_12>23</P_12></FaWiersz></Fa></Faktura>`, 'utf8');

async function withFake(fn: (fake: FakeKsef) => Promise<void>) {
  const fake = await startFakeKsef({ port: 0 });
  try { await fn(fake); } finally { await fake.close(); }
}
const client = (fake: FakeKsef, credentials: KsefCredentials = { method: 'token', token: TOKEN }, extra: Partial<KsefClientOptions> = {}) =>
  new KsefClient({ environment: 'local_fake', baseUrl: fake.url, nip: NIP, credentials, sleep: async () => {}, ...extra });
async function caught(p: Promise<unknown>): Promise<Error> { try { await p; } catch (e) { return e as Error; } assert.fail('expected a rejection'); }
const noSecret = (e: unknown, ...secrets: string[]) => { for (const s of secrets) { assert.ok(!String(e).includes(s), 'secret in message'); assert.ok(!JSON.stringify(e).includes(s), 'secret in JSON'); assert.ok(!String((e as Error).stack).includes(s), 'secret in stack'); } };

test('token login: challenge, public keys, RSA-OAEP token, status poll, redeem; connection check timings', () => withFake(async fake => {
  const c = client(fake), a = await c.authenticate();
  assert.ok(a.accessToken.length > 20 && a.refreshToken && a.referenceNumber);
  assert.ok(Date.parse(a.accessValidUntil!) > Date.now());
  const check = await c.checkConnection();
  assert.deepEqual(check.steps.map(s => [s.name, s.ok]), [['auth/challenge', true], ['security/public-key-certificates', true], ['auth', true], ['auth/token/redeem', true]]);
  assert.equal(check.problem, null); assert.ok(check.accessValidUntil);
  assert.equal(fake.stats()['auth/ksef-token'], 2); assert.equal(fake.stats()['auth/status'], 4);
}));

test('bad or unregistered token: Polish auth failure 450, no token in the error', () => withFake(async fake => {
  const bad = 'zly-token-lokalny-123', e = await caught(client(fake, { method: 'token', token: bad }).authenticate());
  assert.ok(e instanceof KsefRefusedError);
  assert.equal(e.code, 450);
  assert.equal(e.description, 'Uwierzytelnianie zakończone niepowodzeniem z powodu błędnego tokenu');
  noSecret(e, bad);
  fake.acceptToken(NIP, 'zarejestrowany-token-01');
  assert.ok((await client(fake, { method: 'token', token: 'zarejestrowany-token-01' }).authenticate()).accessToken);
  const other = await caught(client(fake).authenticate());
  assert.ok(other instanceof KsefRefusedError && other.code === 450); noSecret(other, TOKEN);
  const check = await client(fake, { method: 'token', token: bad }).checkConnection();
  assert.deepEqual(check.steps.map(s => s.ok), [true, true, false]);
  assert.match(check.problem!, /błędnego tokenu/); assert.ok(!check.problem!.includes(bad));
}));

test('certificate login (simplified XAdES) with generated RSA and EC P-256 keys; wrong key refused', () => withFake(async fake => {
  for (const kp of [generateKeyPairSync('rsa', { modulusLength: 2048 }), generateKeyPairSync('ec', { namedCurve: 'prime256v1' })]) {
    const credentials: KsefCredentials = { method: 'certificate', certificatePem: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKeyPem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    assert.ok((await client(fake, credentials).authenticate()).accessToken);
  }
  assert.equal(fake.stats()['auth/xades-signature'], 2);
  const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const e = await caught(client(fake, { method: 'certificate', certificatePem: other.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKeyPem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }).authenticate());
  assert.match(e.message, /nie pasuje/); noSecret(e, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
}));

test('online session: FA (3) sent encrypted, status 200 with a valid KSeF number, UPO, QR pages, close', () => withFake(async fake => {
  const c = client(fake), s = await c.openOnlineSession(), xml = fa3();
  assert.ok(s.referenceNumber && s.validUntil); assert.equal(s.key.length, 32);
  const sent = await c.sendInvoice(s, xml);
  assert.equal(sent.invoiceHash, sha256Base64(xml));
  const st = await c.pollInvoice(s.referenceNumber, sent.referenceNumber);
  assert.equal(st.code, 200); assert.equal(st.description, 'Sukces'); assert.equal(st.invoiceNumber, 'FV/1/10/2026'); assert.equal(st.upoAvailable, true);
  assert.ok(st.ksefNumber && isKsefNumber(st.ksefNumber) && st.ksefNumber.startsWith(`${NIP}-`)); assert.ok(st.acquisitionDate);
  const upo = await c.fetchUpo(s.referenceNumber, st.ksefNumber!);
  assert.match(upo, /<Potwierdzenie xmlns="http:\/\/upo\.schematy\.mf\.gov\.pl\/KSeF\/v4-3">/);
  assert.ok(upo.includes(`<NumerKSeFDokumentu>${st.ksefNumber}</NumerKSeFDokumentu>`) && upo.includes('bez mocy prawnej') && upo.includes(`<SkrotDokumentu>${sent.invoiceHash}</SkrotDokumentu>`));
  assert.deepEqual(fake.invoices(), [{ nip: NIP, ksefNumber: st.ksefNumber, invoiceHash: sent.invoiceHash, xml: xml.toString('utf8'), offlineMode: false }]);

  const hash = sha256Base64Url(xml), kod1 = await (await fetch(`${fake.origin}/qr/invoice/${NIP}/23-10-2026/${hash}`)).text();
  assert.ok(kod1.includes(st.ksefNumber!));
  assert.ok((await (await fetch(`${fake.origin}/qr/invoice/${NIP}/23-10-2026/${sha256Base64Url(fa3(NIP, 'FV/9/10/2026'))}`)).text()).includes('Faktura offline — jeszcze nieprzesłana'));
  const cert = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fake.registerOfflineCertificate('01F20A5D352AE590', cert.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const path = `/qr/certificate/Nip/${NIP}/${NIP}/01F20A5D352AE590/${hash}`, host = fake.origin.replace('http://', '');
  const kod2 = await (await fetch(`${fake.origin}${path}/${signCertificateQrPath(host + path, cert.privateKey)}`)).text();
  assert.ok(kod2.includes('Podpis KOD II prawidłowy') && kod2.includes(st.ksefNumber!));
  assert.ok((await (await fetch(`${fake.origin}${path}/${signCertificateQrPath(host + path + 'x', cert.privateKey)}`)).text()).includes('Podpis KOD II nieprawidłowy'));

  await c.closeSession(s.referenceNumber);
  const e = await caught(c.sendInvoice(s, fa3(NIP, 'FV/2/10/2026')));
  assert.ok(e instanceof KsefRefusedError && e.status === 400 && /zamknięta/.test(e.description));
  assert.equal(fake.stats()['auth/token/redeem'], 1); // the access token is cached across calls
}));

test("'slow' mode: 150 for the first polls, then 200; still 150 when the delays run out", () => withFake(async fake => {
  const slept: number[] = [], c = client(fake, undefined, { sleep: async ms => { slept.push(ms); } });
  fake.setMode('slow', { slowPolls: 3 });
  const s = await c.openOnlineSession(), sent = await c.sendInvoice(s, fa3());
  slept.length = 0;
  const st = await c.pollInvoice(s.referenceNumber, sent.referenceNumber);
  assert.equal(st.code, 200); assert.ok(isKsefNumber(st.ksefNumber!)); assert.deepEqual(slept, [500, 1000, 2000]);
  fake.setMode('slow', { slowPolls: 10 });
  const short = client(fake, undefined, { pollDelaysMs: [1, 1] }), s2 = await short.openOnlineSession(), sent2 = await short.sendInvoice(s2, fa3(NIP, 'FV/3/10/2026'));
  const last = await short.pollInvoice(s2.referenceNumber, sent2.referenceNumber);
  assert.equal(last.code, 150); assert.equal(last.description, 'Trwa przetwarzanie'); assert.equal(last.ksefNumber, null); assert.equal(last.upoAvailable, false);
  assert.ok((await caught(short.fetchUpo(s2.referenceNumber, st.ksefNumber!))) instanceof KsefRefusedError);
}));

test("'reject' mode, wrong seller NIP and a non-FA (3) document: 450 / 450 / 430", () => withFake(async fake => {
  const c = client(fake), s = await c.openOnlineSession();
  const status = async (xml: Buffer) => c.pollInvoice(s.referenceNumber, (await c.sendInvoice(s, xml)).referenceNumber);
  const wrongSeller = await status(fa3(NIP, 'FV/4/10/2026', '5260250995'));
  assert.equal(wrongSeller.code, 450); assert.equal(wrongSeller.description, 'Błąd weryfikacji semantyki dokumentu faktury'); assert.match(wrongSeller.details[0]!, /5260250995/);
  const notFa3 = await status(Buffer.from('<Faktura xmlns="http://crd.gov.pl/wzor/2023/06/29/12648/"><Fa><P_2>FV/5</P_2></Fa></Faktura>'));
  assert.equal(notFa3.code, 430); assert.equal(notFa3.description, 'Błąd weryfikacji pliku faktury');
  fake.setMode('reject');
  const rejected = await status(fa3(NIP, 'FV/6/10/2026'));
  assert.equal(rejected.code, 450); assert.equal(rejected.ksefNumber, null); assert.equal(rejected.upoAvailable, false);
  assert.deepEqual(fake.invoices(), []);
}));

test('duplicate invoice (same hash, same NIP): 440 with the original KSeF number', () => withFake(async fake => {
  const c = client(fake), s = await c.openOnlineSession(), xml = fa3();
  const first = await c.pollInvoice(s.referenceNumber, (await c.sendInvoice(s, xml)).referenceNumber);
  const s2 = await c.openOnlineSession(), dup = await c.pollInvoice(s2.referenceNumber, (await c.sendInvoice(s2, xml)).referenceNumber);
  assert.equal(dup.code, 440); assert.equal(dup.description, 'Duplikat faktury'); assert.ok(dup.details.some(d => d.includes(first.ksefNumber!)));
  assert.equal(fake.invoices().length, 1);
}));

test("'unavailable': 503 retried once, then KsefUnavailableError 'server'", () => withFake(async fake => {
  fake.setMode('unavailable');
  const e = await caught(client(fake).authenticate());
  assert.ok(e instanceof KsefUnavailableError); assert.equal(e.kind, 'server'); assert.equal(e.status, 503);
  assert.equal(fake.stats().unavailable, 2); noSecret(e, TOKEN);
  const check = await client(fake).checkConnection();
  assert.deepEqual(check.steps.map(s => s.ok), [false]); assert.match(check.problem!, /niedostępny/);
}));

test("'timeout': no answer within timeoutMs → KsefUnavailableError 'timeout'", () => withFake(async fake => {
  const access = (await client(fake).authenticate()).accessToken;
  fake.setMode('timeout');
  const slow = client(fake, undefined, { timeoutMs: 200 }), t0 = Date.now(), e = await caught(slow.authenticate());
  assert.ok(e instanceof KsefUnavailableError); assert.equal(e.kind, 'timeout'); assert.equal(e.status, null);
  assert.ok(Date.now() - t0 < 2000); noSecret(e, TOKEN, access);
  const viaSession = await caught(new KsefClient({ environment: 'local_fake', baseUrl: fake.url, nip: NIP, credentials: { method: 'token', token: TOKEN }, timeoutMs: 200 }).openOnlineSession());
  assert.ok(viaSession instanceof KsefUnavailableError && viaSession.kind === 'timeout');
  const modeSwitch = await fetch(`${fake.origin}/__fake/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'ok' }) });
  assert.equal(modeSwitch.status, 204);
  assert.ok((await client(fake).authenticate()).accessToken);
}));

test("closed fake (connection refused) → KsefUnavailableError 'network'", async () => {
  const fake = await startFakeKsef({ port: 0 }), url = fake.url;
  await fake.close();
  const e = await caught(new KsefClient({ environment: 'local_fake', baseUrl: url, nip: NIP, credentials: { method: 'token', token: TOKEN }, timeoutMs: 2000 }).authenticate());
  assert.ok(e instanceof KsefUnavailableError); assert.equal(e.kind, 'network'); assert.equal(e.status, null); noSecret(e, TOKEN);
});

test('MF environments are switched off: no fetch is ever made', async () => {
  const neverFetch = (async () => { assert.fail('fetch must not be called for an MF environment'); }) as unknown as typeof fetch;
  for (const env of ['test', 'demo', 'prod'] as const) {
    assert.throws(() => ksefBaseUrl(env), { message: 'Połączenie z KSeF Ministerstwa Finansów jest wyłączone w tej lokalnej wersji' });
    assert.throws(() => ksefBaseUrl(env, 'http://127.0.0.1:4239/v2'), /wyłączone/);
    assert.throws(() => new KsefClient({ environment: env, nip: NIP, credentials: { method: 'token', token: TOKEN }, fetch: neverFetch }), /wyłączone/);
  }
});

test('local_fake accepts loopback base URLs only; constructor validates NIP and credentials', () => {
  for (const ok of ['http://127.0.0.1:4239/v2', 'http://localhost:4239/v2/', 'http://[::1]:4239/v2', 'https://127.0.0.1/v2'])
    assert.match(ksefBaseUrl('local_fake', ok), /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/v2$/);
  for (const bad of [undefined, '', 'http://example.com/v2', 'http://10.0.0.1:4239/v2', 'http://127.0.0.1.nip.io/v2', 'ftp://127.0.0.1/v2', 'http://user:pw@127.0.0.1/v2', 'http://127.0.0.1/v2?x=1', 'https://api-test.ksef.mf.gov.pl/v2'])
    assert.throws(() => ksefBaseUrl('local_fake', bad), /Lokalny KSeF|nieprawidłowy/);
  assert.throws(() => new KsefClient({ environment: 'local_fake', baseUrl: 'http://127.0.0.1:1/v2', nip: '123', credentials: { method: 'token', token: TOKEN } }), /NIP/);
  assert.throws(() => new KsefClient({ environment: 'local_fake', baseUrl: 'http://127.0.0.1:1/v2', nip: NIP, credentials: { method: 'token', token: '' } }), /uwierzytelniających/);
});

test('RES-04 lost answer: the fake stores and numbers the invoice, then drops the connection; the session listing finds it by hash', () => withFake(async fake => {
  const c = client(fake), s = await c.openOnlineSession(), xml = fa3(NIP, 'FV/7/10/2026');
  fake.loseNextResponse('sessions/invoices/send', 'drop');
  const lost = await caught(c.sendInvoice(s, xml));
  assert.ok(lost instanceof KsefUnavailableError && lost.kind === 'network', String(lost));
  assert.equal(fake.invoices().length, 1, 'the request took effect');
  const found = await c.findInvoiceByHash(s.referenceNumber, sha256Base64(xml));
  assert.ok(found); assert.equal(found.code, 200); assert.equal(found.ksefNumber, fake.invoices()[0]!.ksefNumber); assert.equal(found.invoiceHash, sha256Base64(xml));
  assert.equal(await c.findInvoiceByHash(s.referenceNumber, sha256Base64(fa3(NIP, 'FV/8/10/2026'))), null);
  // 'hang': the answer never comes; the client gives up at its timeout.
  const short = client(fake, undefined, { timeoutMs: 200 });
  fake.loseNextResponse('sessions/online', 'hang');
  const hung = await caught(short.openOnlineSession());
  assert.ok(hung instanceof KsefUnavailableError && hung.kind === 'timeout');
  assert.equal(fake.stats().lost, 2);
}));

test('session listing pages by x-continuation-token; a 440 copy never hides the accepted one', () => withFake(async fake => {
  const c = client(fake), s = await c.openOnlineSession(), xml = fa3(NIP, 'FV/9/10/2026');
  for (let i = 0; i < 104; i++) await c.sendInvoice(s, fa3(NIP, `FV/P${i}/10/2026`));
  await c.sendInvoice(s, xml); await c.sendInvoice(s, xml); // the second copy is a 440 duplicate
  const all = await c.sessionInvoices(s.referenceNumber);
  assert.equal(all.length, 106); assert.equal(fake.stats()['sessions/invoices/list'], 2);
  const hits = all.filter(i => i.invoiceHash === sha256Base64(xml));
  assert.deepEqual(hits.map(i => i.code), [200, 440]);
  const found = await c.findInvoiceByHash(s.referenceNumber, sha256Base64(xml));
  assert.equal(found!.code, 200); assert.ok(isKsefNumber(found!.ksefNumber!));
}));

test('expired access token: renewed with /auth/token/refresh, a full login only when the refresh is refused', async () => {
  let t = Date.now();
  const fake = await startFakeKsef({ port: 0, now: () => new Date(t) });
  try {
    const c = client(fake, undefined, { now: () => t });
    await c.openOnlineSession();
    t += 16 * 60_000; // past the 15-minute access token
    await c.openOnlineSession();
    assert.equal(fake.stats()['auth/token/refresh'], 1); assert.equal(fake.stats()['auth/challenge'], 1, 'no second login');
    t += 8 * 24 * 3600_000; // past the refresh token too (7 days): the client logs in again
    const fresh = client(fake, undefined, { now: () => t });
    await fresh.openOnlineSession();
    t += 16 * 60_000;
    await fresh.openOnlineSession();
    assert.equal(fake.stats()['auth/token/refresh'], 2);
  } finally { await fake.close(); }
});

test('overall deadline: a hanging request is cut at the deadline, later requests do not start', () => withFake(async fake => {
  const t0 = Date.now(), c = client(fake, undefined, { timeoutMs: 10_000, deadline: t0 + 300 });
  fake.setMode('timeout');
  const e = await caught(c.authenticate());
  assert.ok(e instanceof KsefUnavailableError && e.kind === 'timeout'); assert.ok(Date.now() - t0 < 2000, 'cut at the deadline, not at timeoutMs');
  fake.setMode('ok');
  const after = await caught(c.authenticate());
  assert.ok(after instanceof KsefUnavailableError); assert.match(after.message, /łączny czas/);
}));
