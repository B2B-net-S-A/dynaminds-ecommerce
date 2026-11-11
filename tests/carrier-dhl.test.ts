import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Problem } from '../server/errors';
import { Dhl, DHL_ENDPOINTS, dhlFaultProblem, memoryDhlStore, type DhlOptions } from '../server/carrier-dhl';
import { createDhlFake, DHL_FAKE_PASSWORD, DHL_FAKE_USER, type DhlFake } from '../server/carrier-dhl-fake';
import { parseXml } from '../server/carrier-dhl-xml';
import { NOW, dhlFixture, syntheticNrb, validInput } from './fixtures/dhl/inputs';
const settings = { sap_account: '1234567' };
const creds = { username: DHL_FAKE_USER, password: DHL_FAKE_PASSWORD };
function setup(options: DhlOptions = {}, fake: DhlFake = createDhlFake()) {
  const sleeps: number[] = [];
  const client = new Dhl('sandbox', settings, creds, fake.transport, {
    now: () => NOW,
    timeoutMs: 30,
    sleep: async (ms) => sleeps.push(ms),
    ...options,
  });
  return { client, fake, sleeps };
}
// Serves one authored fixture per call (status 200, or 500 for faults).
function fixtureClient(...files: string[]) {
  const calls: string[] = [];
  const client = new Dhl(
    'live',
    settings,
    creds,
    async (_url, init) => {
      calls.push(String(init.body));
      const name = files.shift()!;
      return new Response(dhlFixture(name), { status: name.startsWith('fault') ? 500 : 200 });
    },
    { now: () => NOW, sleep: async () => {} },
  );
  return { client, calls };
}
const problem = (status: number, code?: RegExp, message?: RegExp) => (e: unknown) =>
  e instanceof Problem && e.status === status && (!code || code.test(e.code ?? '')) && (!message || message.test(e.message));
const methods = (fake: DhlFake) => fake.calls.map((c) => c.method);
const op = (body: string) => parseXml(body).children[0].children[0];
const cod = (n = 12345) => ({ ...validInput, cod: n, insurance: n, cod_bank_account: syntheticNrb() });

test('configuration: environment, SAP number, credentials and official HTTPS host', () => {
  const t = createDhlFake().transport;
  assert.throws(() => new Dhl('prod', settings, creds, t), problem(422, undefined, /środowisko/));
  assert.throws(() => new Dhl('live', {}, creds, t), problem(422, undefined, /SAP/));
  assert.throws(() => new Dhl('live', { sap_account: '12a' }, creds, t), problem(422, undefined, /SAP/));
  assert.throws(() => new Dhl('live', settings, { username: 'u' }, t), problem(422, undefined, /login/));
  assert.throws(() => new Dhl('live', settings, { username: 'u\r\n', password: 'p' }, t), problem(422));
  for (const endpoint of ['http://dhl24.com.pl/webapi2', 'https://evil.example/webapi2', 'https://dhl24.com.pl.evil.example/x', 'https://sandbox.dhl24.com.pl/webapi2'])
    assert.throws(() => new Dhl('live', { ...settings, endpoint }, creds, t), problem(422, undefined, /HTTPS/), endpoint);
  assert.throws(() => new Dhl('sandbox', { ...settings, endpoint: DHL_ENDPOINTS.live }, creds, t), problem(422));
  assert.equal(new Dhl('live', settings, creds, t).endpoint, 'https://dhl24.com.pl/webapi2');
  assert.equal(new Dhl('sandbox', settings, creds, t).endpoint, 'https://sandbox.dhl24.com.pl/webapi2');
});

test('connection: authenticated postcode read returns SAP and environment', async () => {
  const { client, fake } = setup();
  const r = await client.test();
  assert.equal(r.sap_account, '1234567');
  assert.equal(r.mode, 'sandbox');
  assert.equal(r.services.from, '09:00');
  assert.deepEqual(methods(fake), ['getPostalCodeServices']);
  assert.equal(fake.calls[0].soapAction, '"https://dhl24.com.pl/webapi2/provider/service.html?ws=1#getPostalCodeServices"');
  const auth = op(fake.calls[0].body).children[0];
  assert.equal(auth.name, 'authData');
  assert.equal(auth.children[0].text, DHL_FAKE_USER);
});

test('auth failure maps to 401 without provider text and is not retried', async () => {
  const fake = createDhlFake({ password: 'other' });
  const { client } = setup({}, fake);
  await assert.rejects(client.test(), problem(401, /^DHL_AUTH:100$/, /login lub hasło/));
  assert.equal(fake.calls.length, 1);
  const { client: fx } = fixtureClient('fault-auth.xml');
  await assert.rejects(fx.test(), (e: unknown) => e instanceof Problem && e.status === 401 && !e.message.includes('PRIVATE'));
  const http = createDhlFake();
  http.fail({ kind: 'http', status: 401 });
  await assert.rejects(setup({}, http).client.test(), problem(401, /^DHL_AUTH:http$/));
});

test('SOAP fault mapping to Polish messages', () => {
  const cases: [string, string, number, RegExp][] = [
    ['103', 'Nieprawidłowy kod pocztowy odbiorcy', 422, /kod pocztowy/],
    ['105', 'Przekroczona waga paczki', 422, /wagę/],
    ['106', 'Nieprawidłowa kwota pobrania', 422, /pobranie/],
    ['107', 'Wartość ubezpieczenia za niska', 422, /ubezpieczenia/],
    ['301', 'Brak możliwości zamówienia kuriera w tym terminie', 422, /odbioru/],
    ['201', 'Nie znaleziono przesyłki', 404, /nie zna/],
    ['400', 'Brak uprawnień do numeru SAP', 403, /uprawnień/],
    ['999', 'Przekroczono limit zapytań', 429, /liczbę zapytań/],
    ['SOAP-ENV:Client', 'Element nieoczekiwany', 422, /odrzucił dane/],
    ['SOAP-ENV:Server', 'Internal', 502, /błąd usługi/],
  ];
  for (const [code, message, status, re] of cases) {
    const p = dhlFaultProblem({ code, message });
    assert.equal(p.status, status, message);
    assert.match(p.message, re, message);
    assert.doesNotMatch(p.message, new RegExp(message), message);
  }
  assert.equal(dhlFaultProblem({ code: '<script>', message: 'x' }).code, 'DHL_FAULT:unknown');
});

test('domestic shipment: exact SOAP payload, insurance, rounded weight, one create call', async () => {
  const { client, fake } = setup();
  const r = await client.create({ ...validInput, insurance: 50000, comment: 'A & <B>' }, 'order-1:shipment-1');
  assert.match(r.waybill, /^\d{11}$/);
  assert.equal(r.replayed, false);
  assert.equal(r.cod, null);
  assert.deepEqual(methods(fake), ['createShipments']);
  assert.match(fake.calls[0].body, /<comment>A &amp; &lt;B&gt;<\/comment>/);
  const s = fake.shipments.get(r.waybill)!.request;
  const get = (path: string[]) => path.reduce((n, name) => n.children.find((c) => c.name === name)!, s).text;
  assert.equal(get(['shipper', 'postalCode']), '00838');
  assert.equal(get(['shipper', 'street']), 'Prosta');
  assert.equal(get(['shipper', 'houseNumber']), '5');
  assert.equal(get(['shipper', 'apartmentNumber']), '12');
  assert.equal(get(['receiver', 'country']), 'PL');
  assert.equal(get(['pieceList', 'item', 'weight']), '3');
  assert.equal(get(['pieceList', 'item', 'nonStandard']), 'false');
  assert.equal(get(['payment', 'accountNumber']), '1234567');
  assert.equal(get(['service', 'product']), 'AH');
  assert.equal(get(['service', 'collectOnDelivery']), 'false');
  assert.equal(get(['service', 'insurance']), 'true');
  assert.equal(get(['service', 'insuranceValue']), '500.00');
  assert.equal(get(['shipmentDate']), '2026-10-26');
  assert.equal(get(['reference']), r.reference);
});

test('COD: amount in PLN, bank transfer form, reference and bank account kept for reconciliation', async () => {
  const { client, fake } = setup();
  const r = await client.create(cod(12345), 'order-2:shipment-1');
  assert.deepEqual(r.cod, { amount: 12345, currency: 'PLN', bank_account: syntheticNrb() });
  const service = fake.shipments.get(r.waybill)!.request.children.find((c) => c.name === 'service')!;
  const v = Object.fromEntries(service.children.map((c) => [c.name, c.text]));
  assert.equal(v.collectOnDelivery, 'true');
  assert.equal(v.collectOnDeliveryValue, '123.45');
  assert.equal(v.collectOnDeliveryForm, 'BANK_TRANSFER');
  assert.equal(v.collectOnDeliveryReference, r.reference);
  assert.equal(v.insuranceValue, '123.45');
});

test('validation errors (postcode, weight, COD amount) never reach DHL', async () => {
  const { client, fake } = setup();
  const bad = [
    { ...validInput, receiver: { ...validInput.receiver, postalCode: '3-1147' } },
    { ...validInput, weight: 32 },
    cod(1_100_001),
    { ...validInput, cod: 100, insurance: 100 },
    { ...validInput, receiver: { ...validInput.receiver, address: 'Rynek' } },
  ];
  for (const [i, b] of bad.entries())
    await assert.rejects(client.create(b, 'order-3:shipment-' + i), problem(422));
  assert.equal(fake.calls.length, 0);
});

test('duplicate creation is prevented: same key replays, other data with the same key is refused', async () => {
  const { client, fake } = setup();
  const first = await client.create(validInput, 'order-4:shipment-1');
  const again = await client.create(validInput, 'order-4:shipment-1');
  assert.equal(again.waybill, first.waybill);
  assert.equal(again.replayed, true);
  await assert.rejects(client.create({ ...validInput, weight: 3 }, 'order-4:shipment-1'), problem(409));
  assert.equal(fake.shipments.size, 1);
  assert.deepEqual(methods(fake), ['createShipments']);
});

test('ACK loss on create: no resend; reconciliation by reference finds the committed shipment', async () => {
  const store = memoryDhlStore();
  const { client, fake } = setup({ store });
  fake.fail({ kind: 'commit_then_hang' });
  await assert.rejects(client.create(validInput, 'order-5:shipment-1'), problem(504, /^DHL_UNCERTAIN$/, /niepewny/));
  assert.equal(fake.shipments.size, 1);
  const r = await client.create(validInput, 'order-5:shipment-1');
  assert.equal(r.waybill, [...fake.shipments.keys()][0]);
  assert.equal(r.replayed, true);
  assert.deepEqual(methods(fake), ['createShipments', 'getMyShipments']);
  assert.equal(fake.shipments.size, 1);
});

test('ACK loss without a committed shipment stays uncertain and is not created twice', async () => {
  const { client, fake } = setup();
  fake.fail({ kind: 'hang' });
  await assert.rejects(client.create(validInput, 'order-6:shipment-1'), problem(504, /^DHL_UNCERTAIN$/));
  await assert.rejects(client.create(validInput, 'order-6:shipment-1'), problem(409, undefined, /niepewny/));
  assert.deepEqual(methods(fake), ['createShipments', 'getMyShipments']);
  assert.equal(fake.shipments.size, 0);
  fake.fail({ kind: 'throw' });
  await assert.rejects(client.create(validInput, 'order-6:shipment-2'), problem(504, /^DHL_UNCERTAIN$/));
  fake.fail({ kind: 'http', status: 503 });
  await assert.rejects(client.create(validInput, 'order-6:shipment-3'), problem(504, /^DHL_UNCERTAIN$/));
  fake.fail({ kind: 'raw', status: 500, body: '<html>Internal error</html>' });
  await assert.rejects(client.create(validInput, 'order-6:shipment-4'), problem(504, /^DHL_UNCERTAIN$/));
  assert.equal(methods(fake).filter((m) => m === 'createShipments').length, 4);
});

test('definite rejection releases the key so corrected data can be sent', async () => {
  const { client, fake } = setup();
  fake.fail({ kind: 'fault', code: '103', message: 'Nieprawidłowy kod pocztowy odbiorcy' });
  await assert.rejects(client.create(validInput, 'order-7:shipment-1'), problem(422, /^DHL_VALIDATION:103$/, /kod pocztowy/));
  const r = await client.create({ ...validInput, weight: 1 }, 'order-7:shipment-1');
  assert.equal(r.replayed, false);
  assert.equal(fake.shipments.size, 1);
});

test('labels: BLP/LP PDF bytes are non-empty PDF, ZPL checked, foreign or unknown waybill refused', async () => {
  const { client, fake } = setup();
  const { waybill } = await client.create(validInput, 'order-8:shipment-1');
  for (const type of ['BLP', 'LP', 'LBLP'] as const) {
    const label = await client.labels(waybill, type);
    const bytes = Buffer.from(label.label_base64, 'base64');
    assert.ok(bytes.length > 20);
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal(label.waybill, waybill);
    assert.equal(label.mime, 'application/pdf');
  }
  const zpl = await client.labels(waybill, 'ZBLP');
  assert.match(Buffer.from(zpl.label_base64, 'base64').toString(), /^\^XA/);
  await assert.rejects(client.labels('90000000999'), problem(404, /^DHL_NOT_FOUND/));
  await assert.rejects(client.labels('12-34'), problem(422));
  await assert.rejects(client.labels(waybill, 'PNG' as never), problem(422));
  assert.equal(methods(fake).filter((m) => m === 'getLabels').length, 5);
  const { client: fx } = fixtureClient('get-labels-blp.xml', 'get-labels-blp.xml');
  assert.equal((await fx.labels('90000000123')).label_type, 'BLP');
  await assert.rejects(fx.labels('90000000124'), problem(502, undefined, /jednoznacznej etykiety/));
});

test('label that is not a PDF is refused', async () => {
  const fake = createDhlFake();
  const { client } = setup({}, fake);
  const { waybill } = await client.create(validInput, 'order-9:shipment-1');
  const html = Buffer.from('<html>login</html>').toString('base64');
  fake.fail({
    kind: 'raw',
    status: 200,
    body: dhlFixture('get-labels-blp.xml').replace('90000000123', waybill).replace(/<labelData>[^<]+/, '<labelData>' + html),
  });
  await assert.rejects(client.labels(waybill), problem(502, undefined, /PDF/));
});

test('tracking: normalized to the DPD result shape, unknown codes kept without status', async () => {
  const { client } = fixtureClient('track-delivered.xml');
  const t = await client.tracking({ tracking_number: '90000000123' });
  assert.equal(t.status, 'delivered');
  assert.equal(t.scope, 'external_api_verified');
  assert.equal(t.current_waybill, '90000000123');
  assert.deepEqual(t.lineage, [{ waybill: '90000000123', return_leg: false }]);
  assert.equal(t.return_leg, false);
  assert.equal(t.received_by, 'J. Kowalski');
  assert.deepEqual(
    t.tracking_details.map((e) => [e.code, e.status, e.datetime]),
    [
      ['PNO', 'confirmed', '2026-10-26T07:00:00.000Z'],
      ['SORT', 'in_transit', '2026-10-26T20:15:00.000Z'],
      ['XYZ', null, '2026-10-27T05:00:00.000Z'],
      ['DWP', 'out_for_delivery', '2026-10-27T06:30:00.000Z'],
      ['DOR', 'delivered', '2026-10-27T11:45:00.000Z'],
    ],
  );
  assert.equal(t.provider_updated_at, '2026-10-27T11:45:00.000Z');
  assert.deepEqual(Object.keys(t).sort(), [
    'current_waybill', 'empty_history', 'lineage', 'provider_created_at', 'provider_updated_at',
    'received_by', 'return_leg', 'scope', 'status', 'tracking_details', 'tracking_number',
  ]);
});

test('tracking: a foreign number in the answer is refused; previous history is merged', async () => {
  const { client } = fixtureClient('track-foreign-number.xml');
  await assert.rejects(client.tracking({ tracking_number: '90000000123' }), problem(502, /^DHL_INVALID_RESPONSE$/));
  const { client: c2, fake } = setup();
  const { waybill } = await c2.create(validInput, 'order-10:shipment-1');
  const first = await c2.tracking({ tracking_number: waybill });
  assert.equal(first.status, 'confirmed');
  assert.equal(first.scope, 'external_sandbox_verified');
  fake.setEvents(waybill, [{ status: 'DWP', timestamp: '2026-10-27 08:00:00' }]);
  const second = await c2.tracking({ tracking_number: waybill, tracking_data: first });
  assert.equal(second.status, 'out_for_delivery');
  assert.deepEqual(second.tracking_details.map((e) => e.code), ['PNO', 'DWP']);
  await assert.rejects(c2.tracking({ tracking_number: 'ABC' }), problem(422));
});

test('reads retry 429/5xx with backoff and Retry-After; mutations never retry', async () => {
  const { client, fake, sleeps } = setup();
  fake.fail({ kind: 'http', status: 503 }, { kind: 'http', status: 429, retryAfter: '2' });
  assert.equal((await client.test()).auth, 'verified');
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(sleeps, [250, 2000]);
  fake.fail({ kind: 'http', status: 502 }, { kind: 'http', status: 502 }, { kind: 'http', status: 502 });
  await assert.rejects(client.test(), problem(502, /^DHL_UNAVAILABLE$/));
  fake.fail({ kind: 'http', status: 400 });
  await assert.rejects(client.test(), problem(502, /^DHL_UNAVAILABLE$/));
  fake.fail({ kind: 'http', status: 302 });
  await assert.rejects(client.test(), problem(502, /^DHL_REDIRECT$/));
  const before = fake.calls.length;
  fake.fail({ kind: 'http', status: 429 });
  await assert.rejects(client.create(validInput, 'order-11:shipment-1'), problem(429));
  assert.equal(fake.calls.length, before + 1);
});

test('timeouts: reads retried then 504 DHL_TIMEOUT; network errors on reads retried', async () => {
  const { client, fake } = setup();
  fake.fail({ kind: 'hang' }, { kind: 'throw' });
  assert.equal((await client.points({ postcode: '00-838' })).length, 1);
  assert.equal(fake.calls.length, 3);
  fake.fail({ kind: 'hang' }, { kind: 'hang' }, { kind: 'hang' });
  await assert.rejects(client.test(), problem(504, /^DHL_TIMEOUT$/));
  assert.equal(fake.calls.length, 6);
});

test('pickup: booking window validated before any call, postcode hours checked, duplicates replayed', async () => {
  const { client, fake } = setup();
  const a = await client.create(validInput, 'order-12:shipment-1');
  const b = await client.create(validInput, 'order-12:shipment-2');
  const n = fake.calls.length;
  const base = { date: '2026-10-27', from: '10:00', to: '14:00', waybills: [b.waybill, a.waybill] };
  await assert.rejects(client.bookPickup({ ...base, from: '13:00' }, 'pickup-0001'), problem(422, undefined, /2 godziny/));
  await assert.rejects(client.bookPickup({ ...base, date: '2026-11-01' }, 'pickup-0001'), problem(422));
  await assert.rejects(client.bookPickup({ ...base, waybills: [] }, 'pickup-0001'), problem(422));
  await assert.rejects(client.bookPickup({ ...base, waybills: [a.waybill, a.waybill] }, 'pickup-0001'), problem(422));
  assert.equal(fake.calls.length, n);
  await assert.rejects(client.bookPickup({ ...base, from: '08:00', postcode: '00838' }, 'pickup-0002'), problem(422, undefined, /09:00–17:00/));
  assert.deepEqual(methods(fake).slice(n), ['getPostalCodeServices']);
  const booked = await client.bookPickup({ ...base, postcode: '00838' }, 'pickup-0003');
  assert.equal(booked.order_ids.length, 1);
  assert.deepEqual(booked.waybills, [a.waybill, b.waybill].sort());
  const replay = await client.bookPickup({ ...base, waybills: [a.waybill, b.waybill] }, 'pickup-0003');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.order_ids, booked.order_ids);
  assert.equal(methods(fake).filter((m) => m === 'bookCourier').length, 1);
  await assert.rejects(client.bookPickup({ ...base, to: '15:00' }, 'pickup-0003'), problem(409));
  const req = op(fake.calls.find((c) => c.method === 'bookCourier')!.body);
  assert.equal(req.children.find((c) => c.name === 'pickupTimeFrom')!.text, '10:00');
});

test('pickup: lost booking response stays uncertain; cancel once, second cancel refused', async () => {
  const { client, fake } = setup();
  const { waybill } = await client.create(validInput, 'order-13:shipment-1');
  fake.fail({ kind: 'commit_then_hang' });
  const base = { date: '2026-10-27', from: '10:00', to: '14:00', waybills: [waybill] };
  await assert.rejects(client.bookPickup(base, 'pickup-1001'), problem(504, /^DHL_UNCERTAIN$/));
  await assert.rejects(client.bookPickup(base, 'pickup-1001'), problem(409, undefined, /niepewny/));
  assert.equal(fake.bookings.size, 1);
  const [id] = [...fake.bookings.keys()];
  assert.deepEqual(await client.cancelPickup(id), { order_id: id, cancelled: true });
  await assert.rejects(client.cancelPickup(id), problem(409));
  await assert.rejects(client.cancelPickup('bad id'), problem(422));
  assert.equal(methods(fake).filter((m) => m === 'cancelCourierBooking').length, 2);
});

test('points: DHL POP / Parcelshop normalized; invalid query refused', async () => {
  const { client } = setup();
  const [p] = await client.points({ postcode: '00-838', city: 'Warszawa', radius: 3 });
  assert.equal(p.id, '100000838');
  assert.equal(p.type, 'POP');
  assert.deepEqual(p.address, { street: 'Marszałkowska 1', postalCode: '00838', city: 'Warszawa' });
  assert.deepEqual(p.location, { lat: 52.2297, lng: 21.0122 });
  assert.equal(p.hours.length, 2);
  await assert.rejects(client.points({ postcode: '0083' }), problem(422));
  await assert.rejects(client.points({ postcode: '00838', radius: 100 }), problem(422));
  const { client: fx } = fixtureClient('points-warsaw.xml');
  const points = await fx.points({ postcode: '00838' });
  assert.deepEqual(points.map((x) => [x.id, x.type, x.address.postalCode, x.location]), [
    ['1000001', 'POP', '00838', { lat: 52.2318, lng: 20.9897 }],
    ['1000002', 'PARCELSHOP', '00020', null],
  ]);
});
