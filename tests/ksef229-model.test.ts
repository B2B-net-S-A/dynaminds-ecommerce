/** 229 KSeF rules without a database: business days and offline deadlines, the submission state
 * machine and idempotency decision, FA(3) checks before a send (422), KOD I / KOD II links, the
 * settings input and the masked settings view (the secret is never part of it). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  addBusinessDays, afterAttempt, fa3XmlFacts, isBusinessDay, kodIIUrl, kodIUrl, ksefConfigInput, ksefOfflineInput, liveDecision, maskedConfig, offlineDeadline,
  polishHolidays, qrBase, validNip,
} from '../server/ksef229-model';
import { sha256Base64Url, verifyCertificateQrPath } from '../server/ksef229-crypto';
import { Problem } from '../server/errors';

const NIP = '5260250274';
export const fa3 = (o: { nip?: string; number?: string; issue?: string } = {}) => '<?xml version="1.0" encoding="UTF-8"?>\n<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"><Naglowek>' +
  '<KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>3</WariantFormularza></Naglowek>' +
  `<Podmiot1><DaneIdentyfikacyjne><NIP>${o.nip ?? NIP}</NIP><Nazwa>Sklep</Nazwa></DaneIdentyfikacyjne></Podmiot1><Podmiot2><DaneIdentyfikacyjne><NIP>1234563218</NIP></DaneIdentyfikacyjne></Podmiot2>` +
  `<Fa><KodWaluty>PLN</KodWaluty><P_1>${o.issue ?? '2026-10-23'}</P_1><P_2>${o.number ?? 'FV/LOK/2026/000042'}</P_2></Fa></Faktura>\n`;

test('Polish public holidays and business days: Easter-based days, 24 December from 2025, weekends', () => {
  const h = polishHolidays(2026);
  for (const d of ['2026-01-01', '2026-01-06', '2026-04-05', '2026-04-06', '2026-05-01', '2026-05-03', '2026-05-24', '2026-06-04', '2026-08-15', '2026-11-01', '2026-11-11', '2026-12-24', '2026-12-25', '2026-12-26'])
    assert(h.has(d), d);
  assert.equal(h.size, 14);
  assert(!polishHolidays(2024).has('2024-12-24'));
  assert.deepEqual(['2026-10-23', '2026-10-24', '2026-10-25', '2026-11-11', '2026-06-04', '2026-06-05'].map(isBusinessDay), [true, false, false, false, false, true]);
  assert.equal(addBusinessDays('2026-10-23', 1), '2026-10-26');
  assert.equal(addBusinessDays('2026-12-22', 7), '2027-01-05');
});

test('offline deadlines: offline24 from the issue date, offline from the detected failure, awaryjny 7 business days after its end', () => {
  assert.equal(offlineDeadline('offline24', { issueDate: '2026-10-30', detectedDay: '2026-10-30' }), '2026-11-02');
  assert.equal(offlineDeadline('offline24', { issueDate: '2026-11-10', detectedDay: '2026-11-10' }), '2026-11-12');
  // The failure is detected on a later day than the issue date: counted from that day.
  assert.equal(offlineDeadline('offline', { issueDate: '2026-10-20', detectedDay: '2026-10-23' }), '2026-10-26');
  assert.equal(offlineDeadline('offline', { issueDate: '2026-10-23', detectedDay: '2026-10-22' }), '2026-10-26');
  assert.equal(offlineDeadline('awaryjny', { issueDate: '2026-12-21', detectedDay: '2026-12-21', emergencyEnd: '2026-12-22' }), '2027-01-05');
  assert.equal(offlineDeadline('awaryjny', { issueDate: '2026-12-21', detectedDay: '2026-12-21' }), null);
  assert(ksefOfflineInput.safeParse({ mode: 'offline24' }).success);
  assert(!ksefOfflineInput.safeParse({ mode: 'offline24', emergency_end: '2026-10-24' }).success);
  assert(!ksefOfflineInput.safeParse({ mode: 'offline' }).success, 'the unavailability mode is set only by a failed send');
});

test('state machine: one live submission per document, accepted is returned without a send, a lease refuses a parallel send', () => {
  const now = new Date('2026-10-23T10:00:00Z');
  assert.equal(liveDecision(null, now), 'create');
  assert.equal(liveDecision({ state: 'accepted', lease_until: null }, now), 'return');
  assert.equal(liveDecision({ state: 'queued', lease_until: null }, now), 'send');
  assert.equal(liveDecision({ state: 'queued', lease_until: '2026-10-23T09:59:00Z' }, now), 'send');
  assert.equal(liveDecision({ state: 'queued', lease_until: '2026-10-23T10:01:00Z' }, now), 'busy');
  assert.equal(liveDecision({ state: 'sent', lease_until: null }, now), 'poll');
  const q = { state: 'queued' as const, issue_mode: 'online' as const };
  assert.deepEqual(afterAttempt(q, { kind: 'accepted' }), { state: 'accepted', goOffline: false });
  assert.deepEqual(afterAttempt(q, { kind: 'rejected' }), { state: 'rejected', goOffline: false });
  assert.deepEqual(afterAttempt(q, { kind: 'processing' }), { state: 'sent', goOffline: false });
  assert.deepEqual(afterAttempt(q, { kind: 'unavailable', referenced: false }), { state: 'queued', goOffline: true });
  assert.deepEqual(afterAttempt({ ...q, issue_mode: 'offline24' }, { kind: 'unavailable', referenced: false }), { state: 'queued', goOffline: false });
  assert.deepEqual(afterAttempt(q, { kind: 'unavailable', referenced: true }), { state: 'sent', goOffline: false }, 'handed over: only its status is missing');
  assert.deepEqual(afterAttempt({ state: 'sent', issue_mode: 'online' }, { kind: 'unavailable', referenced: false }), { state: 'sent', goOffline: false });
  assert.deepEqual(afterAttempt(q, { kind: 'refused_before_send' }), { state: 'queued', goOffline: false });
  for (const state of ['accepted', 'rejected'] as const) assert.throws(() => afterAttempt({ state, issue_mode: 'online' }, { kind: 'accepted' }), /zakończona/);
});

test('FA(3) checks before a send: seller NIP, number and issue date; anything else is 422', () => {
  assert.deepEqual(fa3XmlFacts(fa3()), { sellerNip: NIP, number: 'FV/LOK/2026/000042', issueDate: '2026-10-23' });
  assert.equal(fa3XmlFacts(fa3({ number: 'FV &amp; 1' })).number, 'FV & 1');
  const bad = ['<Faktura xmlns="http://crd.gov.pl/wzor/2023/06/29/12648/"><P_2>x</P_2></Faktura>', fa3().replace('FA (3)', 'FA (2)'), fa3().replace(/<NIP>5260250274<\/NIP>/, ''),
    fa3().replace(/<P_2>[^<]*<\/P_2>/, ''), fa3().replace(/<P_1>[^<]*<\/P_1>/, ''), '<!DOCTYPE x>' + fa3(), '', 'x'.repeat(3 * 1024 * 1024 + 1), '<html></html>'];
  for (const x of bad) assert.throws(() => fa3XmlFacts(x), (e: unknown) => e instanceof Problem && e.status === 422 && /FA\(3\)/.test(e.message));
});

test('KOD I and KOD II: environment hosts, DD-MM-YYYY issue date, base64url file hash, signature over the URL without the scheme', () => {
  assert.equal(qrBase('test', null), 'https://qr-test.ksef.mf.gov.pl');
  assert.equal(qrBase('prod', null), 'https://qr.ksef.mf.gov.pl');
  assert.equal(qrBase('local_fake', 'http://127.0.0.1:4239/v2'), 'http://127.0.0.1:4239/qr');
  const xml = fa3(), facts = fa3XmlFacts(xml), hash = sha256Base64Url(Buffer.from(xml, 'utf8'));
  assert.match(hash, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(kodIUrl('https://qr-test.ksef.mf.gov.pl', facts, xml), `https://qr-test.ksef.mf.gov.pl/invoice/${NIP}/23-10-2026/${hash}`);
  for (const pair of [generateKeyPairSync('ec', { namedCurve: 'P-256' }), generateKeyPairSync('rsa', { modulusLength: 2048 })]) {
    const url = kodIIUrl('https://qr-test.ksef.mf.gov.pl', NIP, facts, xml, { serial: '01F3A2', privateKey: pair.privateKey });
    const m = /^https:\/\/(qr-test\.ksef\.mf\.gov\.pl\/certificate\/Nip\/5260250274\/5260250274\/01F3A2\/[A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]+)$/.exec(url);
    assert(m, url);
    assert(verifyCertificateQrPath(m[1]!, m[2]!, pair.publicKey));
    assert(!verifyCertificateQrPath(m[1]!.replace('01F3A2', '01F3A3'), m[2]!, pair.publicKey));
  }
});

test('settings input: loopback-only local server, fixed MF hosts, method and secret consistency; masked view has no secret', () => {
  const ok = (v: unknown) => ksefConfigInput.safeParse(v).success;
  assert(ok({ environment: 'local_fake', base_url: 'http://127.0.0.1:4239/v2', auth_method: 'token', token: 'fake-token-123' }));
  assert(ok({ environment: 'test', auth_method: 'token' }), 'secret omitted: kept from the stored one');
  assert(!ok({ environment: 'local_fake', base_url: 'https://ksef-test.mf.gov.pl/v2', auth_method: 'token', token: 'fake-token-123' }));
  assert(!ok({ environment: 'local_fake', base_url: 'http://10.0.0.5:4239/v2', auth_method: 'token', token: 'fake-token-123' }));
  assert(!ok({ environment: 'test', base_url: 'http://127.0.0.1:1/v2', auth_method: 'token' }), 'MF hosts are not typed in');
  assert(!ok({ environment: 'test', auth_method: 'token', token: 'short' }));
  assert(!ok({ environment: 'test', auth_method: 'certificate', token: 'fake-token-123' }));
  assert(!ok({ environment: 'test', auth_method: 'certificate', certificate_pem: '-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----' }));
  assert(!ok({ environment: 'test', auth_method: 'token', offline_certificate_serial: '01' }));
  assert(!ok({ environment: 'test', auth_method: 'token', extra: 1 }));
  assert(validNip(NIP) && !validNip('5260250275') && !validNip('526025027'));
  const view = maskedConfig({ nip: NIP, environment: 'local_fake', base_url: 'http://127.0.0.1:4239/v2', auth_method: 'token', secret_fingerprint: '0123456789abcdef',
    certificate_serial: null, offline_certificate_serial: null, active: true, updated_at: new Date('2026-10-23T10:00:00Z'), secret_ciphertext: 'CIPHERTEXT', token: 'fake-token-123' } as never);
  const text = JSON.stringify(view);
  assert(!text.includes('CIPHERTEXT') && !text.includes('fake-token-123'));
  assert.deepEqual(view.secret, { stored: true, masked: '••••••••', fingerprint: '0123456789abcdef' });
});

test('RES-04: uncertain send, 440 duplicate reading, outcomes that never reject, lease > attempt budget', async () => {
  const { duplicateOf, sendUncertain, KSEF_ATTEMPT_BUDGET_MS, KSEF_LEASE_SECONDS } = await import('../server/ksef229-model');
  const { KSEF_RETRY_WAIT_MAX_MS } = await import('../server/ksef229-client');
  assert.equal(sendUncertain({ state: 'queued', session_id: 'x', reference_number: null }), true);
  assert.equal(sendUncertain({ state: 'queued', session_id: null, reference_number: null }), false);
  assert.equal(sendUncertain({ state: 'sent', session_id: 'x', reference_number: 'r' }), false);
  const nr = '5260250274-20261026-0A1B2C3D4E5F-7C', sref = '20261026-SO-2C3E6C8000-B675CF5D68-07';
  assert.deepEqual(duplicateOf({ code: 440, description: 'Duplikat faktury', details: [`Faktura o numerze KSeF ${nr} została już przyjęta w sesji ${sref}`] }), { ksefNumber: nr, sessionRef: sref });
  assert.deepEqual(duplicateOf({ code: 440, description: 'Duplikat faktury', details: [] }), { ksefNumber: null, sessionRef: null });
  assert.equal(duplicateOf({ code: 450, description: 'x', details: [nr] }), null);
  for (const kind of ['duplicate_unconfirmed', 'not_found'] as const) {
    assert.deepEqual(afterAttempt({ state: 'queued', issue_mode: 'online' }, { kind }), { state: 'queued', goOffline: false });
    assert.deepEqual(afterAttempt({ state: 'sent', issue_mode: 'online' }, { kind }), { state: 'sent', goOffline: false });
  }
  // Worst single request inside the budget: one timeout (15 s) + the 429/503 wait + its retry.
  assert(KSEF_ATTEMPT_BUDGET_MS >= 2 * 15_000 + KSEF_RETRY_WAIT_MAX_MS);
  assert(KSEF_LEASE_SECONDS * 1000 >= KSEF_ATTEMPT_BUDGET_MS + 60_000, 'lease outlasts the budget with a margin for the two transactions');
  assert(KSEF_ATTEMPT_BUDGET_MS < 120_000, 'shorter than the 2-minute job reaper of tick(), so a status job is never reaped mid-attempt');
});

test('SR4-M1: local_fake only with the installation setting (off by default, never in production); no ".." or "//" in its path', async () => {
  const { ksefBaseUrl, ksefLocalFakeAllowed } = await import('../server/ksef229-client');
  const keys = ['DYNA_TEST', 'DYNA_KSEF_FAKE', 'NODE_ENV'] as const, saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const env = (v: Partial<Record<(typeof keys)[number], string>>) => { for (const k of keys) { if (v[k] === undefined) delete process.env[k]; else process.env[k] = v[k]; } };
  const body = (base_url: string) => ({ environment: 'local_fake', base_url, auth_method: 'token', token: 'fake-token-123' });
  const ok = (v: unknown) => ksefConfigInput.safeParse(v).success;
  try {
    env({});
    assert.equal(ksefLocalFakeAllowed(), false, 'off by default');
    assert(!ok(body('http://127.0.0.1:4239/v2')), 'an org admin cannot aim the server at a loopback port');
    assert.match(ksefConfigInput.safeParse(body('http://127.0.0.1:4239/v2')).error!.issues[0]!.message, /DYNA_KSEF_FAKE=local/);
    assert.throws(() => ksefBaseUrl('local_fake', 'http://127.0.0.1:4239/v2'), /wyłączony/);
    env({ DYNA_KSEF_FAKE: 'local', NODE_ENV: 'production' });
    assert.equal(ksefLocalFakeAllowed(), false, 'never in a production build');
    env({ DYNA_TEST: 'true', NODE_ENV: 'production' });
    assert.equal(ksefLocalFakeAllowed(), false);
    env({ DYNA_KSEF_FAKE: 'local' });
    assert.equal(ksefLocalFakeAllowed(), true);
    assert(ok(body('http://127.0.0.1:4239/v2')));
    assert.equal(ksefBaseUrl('local_fake', 'http://127.0.0.1:4239/v2/'), 'http://127.0.0.1:4239/v2');
    for (const bad of ['http://127.0.0.1:4239/v2/../admin', 'http://127.0.0.1:4239/..', 'http://127.0.0.1:4239//v2', 'http://127.0.0.1:4239/v2//x', 'http://127.0.0.1:4239/v2/%2e%2e/x']) {
      assert(!ok(body(bad)), bad);
      assert.throws(() => ksefBaseUrl('local_fake', bad), /ścieżk|adres/i, bad);
    }
    env({ DYNA_TEST: 'true' });
    assert.equal(ksefLocalFakeAllowed(), true, 'isolated test mode keeps the loopback fake for the suites');
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
