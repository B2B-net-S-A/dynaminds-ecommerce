import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Problem } from '../server/errors';
import {
  PP_TRACKING_ENDPOINT,
  PocztaPolskaTracking,
  parsePocztaPolskaEvents,
  pocztaPolskaEventTime,
  pocztaPolskaStatus,
} from '../server/carrier-pocztapolska-tracking';
import { BASE_WIRE_TRACKING_STATUS } from '../server/base-wire-fulfillment';
import { pocztaPolskaFake } from '../server/carrier-pocztapolska-fake';

// SYNTHETIC fixtures (tests/fixtures/pocztapolska); no network.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/pocztapolska/${name}`, import.meta.url), 'utf8');
const inner = (name: string) => fixture(name).match(/<ns:sprawdzPrzesylkeResponse>[\s\S]*<\/ns:sprawdzPrzesylkeResponse>/)![0];
const noSleep = { sleep: async () => {} };

test('time: Polish local event time → UTC ISO, DST gap rejected, overlap → later instant', () => {
  assert.equal(pocztaPolskaEventTime('2026-10-20 16:02'), '2026-10-20T14:02:00.000Z');
  assert.equal(pocztaPolskaEventTime('2026-01-15 08:00:30'), '2026-01-15T07:00:30.000Z');
  assert.equal(pocztaPolskaEventTime('2026-10-25 02:30'), '2026-10-25T01:30:00.000Z');
  assert.throws(() => pocztaPolskaEventTime('2026-03-29 02:30'), Problem);
  assert.throws(() => pocztaPolskaEventTime('2026-02-30 10:00'), Problem);
  assert.throws(() => pocztaPolskaEventTime('20.10.2026 10:00'), Problem);
});

test('status table maps only to statuses known to the app tracking model', () => {
  for (const code of ['P_NAD', 'P_WZL', 'P_WD', 'P_A', 'P_PWP', 'P_D', 'P_ND', 'P_ZWR']) {
    const s = pocztaPolskaStatus(code)!;
    assert(BASE_WIRE_TRACKING_STATUS.has(s), code + ' → ' + s);
  }
  assert.equal(pocztaPolskaStatus('P_D', true), 'returned_to_sender');
  assert.equal(pocztaPolskaStatus('P_WZL', true), 'return_in_transit');
  assert.equal(pocztaPolskaStatus('X_NOWY'), null);
});

test('parse: events sorted, unknown code kept without status, number echo checked', () => {
  const events = parsePocztaPolskaEvents(fixture('tracking-delivered.xml'), 'FAKEPP0000000001');
  assert.deepEqual(
    events.map((e) => [e.code, e.status, e.datetime]),
    [
      ['P_NAD', 'collected_from_sender', '2026-10-20T14:02:00.000Z'],
      ['P_WZL', 'in_transit', '2026-10-20T20:40:00.000Z'],
      ['X_NOWY', null, '2026-10-21T06:00:00.000Z'],
      ['P_WD', 'out_for_delivery', '2026-10-21T07:15:00.000Z'],
      ['P_D', 'delivered', '2026-10-21T11:47:00.000Z'],
    ],
  );
  assert.equal(events.at(-1)!.final, true);
  assert.equal(events[0].unit, 'UP Warszawa 1');
  assert(events.every((e) => /^[a-f0-9]{20}$/.test(e.object_id)));
  // A response for another number never updates this shipment.
  assert.throws(() => parsePocztaPolskaEvents(fixture('tracking-delivered.xml'), 'FAKEPP0000000999'), /Nieprawidłowa odpowiedź/);
});

test('parse: provider statuses -1/-2/1/-99, auth fault and XXE', () => {
  assert.deepEqual(parsePocztaPolskaEvents(fixture('tracking-not-found.xml'), 'FAKEPP0000000009'), []);
  assert.throws(() => parsePocztaPolskaEvents(fixture('tracking-bad-number.xml'), 'FAKEPP0000000009'), /numer przesyłki za nieprawidłowy/);
  assert.throws(() => parsePocztaPolskaEvents(fixture('tracking-ambiguous.xml'), 'FAKEPP0000000009'), /kilka przesyłek/);
  assert.throws(() => parsePocztaPolskaEvents(fixture('tracking-error.xml'), 'FAKEPP0000000009'), /zwróciła błąd/);
  assert.throws(
    () => parsePocztaPolskaEvents(fixture('tracking-auth-fault.xml'), 'FAKEPP0000000009'),
    (e: unknown) => e instanceof Problem && e.status === 401 && e.code === 'PROVIDER_HTTP_UNAUTHORIZED',
  );
  assert.throws(() => parsePocztaPolskaEvents(fixture('xxe-doctype.xml'), 'FAKEPP0000000009'), /Nieprawidłowa odpowiedź/);
});

test('tracking(): DpdInfo-shaped result, WS-Security header, merge with previous history', async () => {
  const fake = pocztaPolskaFake();
  fake.setTracking('FAKEPP0000000001', inner('tracking-delivered.xml'));
  const bodies: string[] = [];
  const tt = new PocztaPolskaTracking(fake.credentials, async (url, init) => {
    assert.equal(url, PP_TRACKING_ENDPOINT);
    bodies.push(String(init.body));
    return fake.transport(url, init);
  }, noSleep);
  const previous = {
    status: 'in_transit',
    tracking_details: parsePocztaPolskaEvents(fixture('tracking-delivered.xml'), 'FAKEPP0000000001').slice(0, 2),
  };
  const r = await tt.tracking({ tracking_number: 'FAKEPP0000000001', tracking_data: previous });
  assert.deepEqual(Object.keys(r).sort(), [
    'current_waybill', 'empty_history', 'lineage', 'provider_created_at', 'provider_updated_at',
    'return_leg', 'scope', 'status', 'tracking_details', 'tracking_number',
  ]);
  assert.equal(r.status, 'delivered');
  assert.equal(r.tracking_details.length, 5);
  assert.equal(r.provider_updated_at, '2026-10-21T11:47:00.000Z');
  assert.equal(r.scope, 'external_api_verified');
  assert.match(bodies[0], /<wsse:Username>fixture-tt<\/wsse:Username>/);
  assert.match(bodies[0], /PasswordText">fixture-tt-pass<\/wsse:Password>/);
  // Unknown yet: empty history keeps the previous status.
  const empty = await tt.tracking({ tracking_number: 'FAKEPP0000000003', tracking_data: { status: 'label_ready' } });
  assert.equal(empty.status, 'label_ready');
  assert.equal(empty.empty_history, true);
});

test('tracking(): return leg ends as returned_to_sender', async () => {
  const fake = pocztaPolskaFake();
  fake.setTracking('FAKEPP0000000002', inner('tracking-return.xml'));
  const r = await new PocztaPolskaTracking(fake.credentials, fake.transport, noSleep).tracking({
    tracking_number: 'FAKEPP0000000002',
  });
  assert.equal(r.return_leg, true);
  assert.equal(r.status, 'returned_to_sender');
  assert.deepEqual(r.tracking_details.map((e) => e.status), [
    'collected_from_sender', 'avizo', 'return_in_transit', 'return_in_transit', 'returned_to_sender',
  ]);
});

test('tracking(): auth failure, retry on 503/network, bad number refused before any request', async () => {
  const fake = pocztaPolskaFake();
  const bad = new PocztaPolskaTracking({ ...fake.credentials, tracking_password: 'zle' }, fake.transport, noSleep);
  await assert.rejects(bad.events('FAKEPP0000000001'), (e: unknown) => e instanceof Problem && e.status === 401);
  const waits: number[] = [];
  const tt = new PocztaPolskaTracking(fake.credentials, fake.transport, { sleep: async (ms: number) => void waits.push(ms) });
  fake.fail({ kind: 'status', status: 503 }, { kind: 'network' });
  assert.deepEqual(await tt.events('FAKEPP0000000001'), []);
  assert.deepEqual(waits, [200, 400]);
  fake.fail({ kind: 'status', status: 503 }, { kind: 'status', status: 503 }, { kind: 'status', status: 503 });
  await assert.rejects(tt.events('FAKEPP0000000001'), /HTTP 503/);
  const before = fake.calls.length;
  await assert.rejects(tt.events('<x>'), /Nieprawidłowy numer/);
  assert.equal(fake.calls.length, before);
  assert.throws(() => new PocztaPolskaTracking({}), /login i hasło usługi śledzenia/);
});
