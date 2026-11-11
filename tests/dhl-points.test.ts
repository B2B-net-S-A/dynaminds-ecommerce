// DHL points.search (getNearestServicepoints) wiring without a database: query schema, the exact
// request to the local fake, the bounded public answer, the local simulation list and a malformed answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { Problem } from '../server/errors';
import { Dhl } from '../server/carrier-dhl';
import { createDhlFake, DHL_FAKE_PASSWORD, DHL_FAKE_USER } from '../server/carrier-dhl-fake';
import { soapResponse } from '../server/carrier-dhl-fake';
import { parseXml } from '../server/carrier-dhl-xml';
import { DHL_POINTS_LIMIT, dhlPointsQuery, publicDhlPoints, readDhlPoints, simulatedDhlPoints } from '../server/dhl-points';

const client = (transport = createDhlFake().transport) =>
  new Dhl('sandbox', { sap_account: '1234567' }, { username: DHL_FAKE_USER, password: DHL_FAKE_PASSWORD }, transport, {
    sleep: async () => undefined,
  });
const POINT_KEYS = ['address', 'description', 'hours', 'id', 'location', 'name', 'type'];

test('query: Polish postcode normalized, radius 1–50 (default 5), optional city; anything else refused', () => {
  assert.deepEqual(dhlPointsQuery.parse({ postcode: '00-838' }), { postcode: '00838', radius: 5 });
  assert.deepEqual(dhlPointsQuery.parse({ postcode: ' 00838 ', city: ' Warszawa ', radius: '3' }), {
    postcode: '00838',
    city: 'Warszawa',
    radius: 3,
  });
  for (const bad of [
    {},
    { postcode: '0083' },
    { postcode: '00-8388' },
    { postcode: 'AB-123' },
    { postcode: '00838', radius: '0' },
    { postcode: '00838', radius: '51' },
    { postcode: '00838', radius: '2.5' },
    { postcode: '00838', city: 'x'.repeat(51) },
    { postcode: '00838', city: 'War\nszawa' },
    { postcode: '00838', sap: '1' },
  ])
    assert.throws(() => dhlPointsQuery.parse(bad), ZodError, JSON.stringify(bad));
});

test('search on the fake: exact getNearestServicepoints request and the bounded public point', async () => {
  const fake = createDhlFake();
  const out = await readDhlPoints(client(fake.transport), { postcode: '00838', city: 'Warszawa', radius: 3 });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].method, 'getNearestServicepoints');
  assert.equal(fake.calls[0].soapAction, '"https://dhl24.com.pl/webapi2/provider/service.html?ws=1#getNearestServicepoints"');
  const op = parseXml(fake.calls[0].body).children[0].children[0];
  assert.deepEqual(
    op.children.map((c) => c.name),
    ['authData', 'structure'],
  );
  const structure = op.children[1].children.map((c) => [c.name, c.text]);
  assert.deepEqual(structure, [
    ['postcode', '00838'],
    ['city', 'Warszawa'],
    ['radius', '3'],
  ]);
  assert.deepEqual(out, [
    {
      id: '100000838',
      name: 'DHL POP Kiosk (syntetyczny)',
      type: 'POP',
      address: { street: 'Marszałkowska 1', postalCode: '00838', city: 'Warszawa' },
      location: { lat: 52.2297, lng: 21.0122 },
      hours: [
        { day: 'MON', open: '08:00', close: '20:00' },
        { day: 'SAT', open: '09:00', close: '14:00' },
      ],
      description: 'Punkt syntetyczny',
    },
  ]);
});

test('public answer: at most DHL_POINTS_LIMIT points, 7 hour rows, only known fields', () => {
  const raw = Array.from({ length: DHL_POINTS_LIMIT + 10 }, (_, i) => ({
    id: String(1000 + i),
    name: 'P' + i,
    type: 'PARCELSHOP',
    address: { street: 'Ulica 1', postalCode: '00838', city: 'Warszawa', raw_extra: 'x' },
    location: null,
    hours: Array.from({ length: 9 }, () => ({ day: 'MON', open: '08:00', close: '16:00', provider_code: 'x' })),
    description: '',
    sap_internal: 'leak',
  }));
  const out = publicDhlPoints(raw as any);
  assert.equal(out.length, DHL_POINTS_LIMIT);
  assert.ok(DHL_POINTS_LIMIT <= 50);
  for (const p of out) {
    assert.deepEqual(Object.keys(p).sort(), POINT_KEYS);
    assert.deepEqual(Object.keys(p.address).sort(), ['city', 'postalCode', 'street']);
    assert.equal(p.hours.length, 7);
    assert.deepEqual(Object.keys(p.hours[0]).sort(), ['close', 'day', 'open']);
  }
  assert.doesNotMatch(JSON.stringify(out), /leak|raw_extra|provider_code/);
});

test('local simulation: small fixed list for the asked postcode, no transport', () => {
  const points = simulatedDhlPoints({ postcode: '01354', radius: 5 });
  assert.ok(points.length >= 1 && points.length <= 3);
  for (const p of points) {
    assert.deepEqual(Object.keys(p).sort(), POINT_KEYS);
    assert.match(p.id, /^DEMO-/);
    assert.equal(p.address.postalCode, '01354');
  }
  assert.deepEqual(simulatedDhlPoints({ postcode: '01354', radius: 5 }), points, 'fixed');
});

test('malformed provider answer → 502 DHL_INVALID_RESPONSE, nothing returned', async () => {
  const bad = [
    '<not-xml',
    soapResponse('getNearestServicepoints', { points: [{ sap: 'bad id!', name: 'x', address: { postcode: '00838', city: 'W' } }] }),
    soapResponse('getNearestServicepoints', { points: [{ sap: '1', name: 'x', address: { postcode: 'xx', city: 'W' } }] }),
    soapResponse('getPostalCodeServices', { points: [] }),
  ];
  for (const body of bad) {
    const fake = createDhlFake();
    fake.fail({ kind: 'raw', status: 200, body });
    await assert.rejects(
      readDhlPoints(client(fake.transport), { postcode: '00838', radius: 5 }),
      (e) => e instanceof Problem && e.status === 502 && e.code === 'DHL_INVALID_RESPONSE',
      body.slice(0, 60),
    );
    assert.equal(fake.calls.length, 1, 'a malformed read is not retried');
  }
});
