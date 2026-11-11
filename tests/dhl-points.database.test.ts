/** DHL points.search route GET /api/integrations/:id/dhl-points on a disposable clone (real migrate(),
 * buildApp, the local DHL fake as the only transport): exact request to the fake, bounded answer,
 * viewer 403, another tenant 404, local simulation without HTTP, malformed answer 502, bad query 422.
 * Root-only on a fresh clone dynaminds_m254_YYYYMMDD_NN (HEAD with 254). Rerun = NEW clone. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { createDhlFake, DHL_FAKE_USER, DHL_FAKE_PASSWORD } from '../server/carrier-dhl-fake';
import { parseXml } from '../server/carrier-dhl-xml';
import { relaxPoolTimeouts } from './failure-helpers';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_m(?:25[456789]|26[0123])_202610(?:29|30)_[0-9]{2}$/);
relaxPoolTimeouts(900);
const dhl = createDhlFake();
const network: string[] = [];
const transport = async (url: string, init: RequestInit) => {
  network.push(url);
  if (url.startsWith('https://sandbox.dhl24.com.pl/')) return dhl.transport(url, init);
  throw new Error('unexpected network ' + url);
};
let app: Awaited<ReturnType<typeof buildApp>>;
const cookies: Record<string, string> = {};
const login = async (email: string) =>
  (await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } })).headers['set-cookie']!
    .toString()
    .split(';')[0];
const as = (who: string, url: string, method: any = 'GET', payload?: any) =>
  app.inject({ url, method, payload, headers: { cookie: cookies[who] } });
let dhlChannel = '',
  localChannel = '';
const points = (ch: string, q: string, who = 'admin') => as(who, '/api/integrations/' + ch + '/dhl-points?' + q);
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  for (const who of ['admin', 'operator', 'viewer', 'other']) cookies[who] = await login(who + '@demo.local');
  const created = await as('admin', '/api/integrations', 'POST', {
    provider: 'dhl', name: 'DHL punkty', mode: 'sandbox', credentials: { username: DHL_FAKE_USER, password: DHL_FAKE_PASSWORD },
    settings: { sap_account: '1234567' },
  });
  assert.ok(created.statusCode < 300, created.body);
  dhlChannel = created.json().id;
  const example = await as('admin', '/api/dhl-shipping/example', 'POST', {});
  assert.ok(example.statusCode < 300, example.body);
  localChannel = example.json().channel_id;
});
after(async () => {
  await app.close();
  await pool.end();
});

test('admin and operator: exact getNearestServicepoints request to the fake, bounded parsed answer', async () => {
  network.length = 0;
  dhl.calls.length = 0;
  const r = await points(dhlChannel, 'postcode=00-838&city=Warszawa&radius=3', 'operator');
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(network, ['https://sandbox.dhl24.com.pl/webapi2']);
  assert.equal(dhl.calls.length, 1);
  assert.equal(dhl.calls[0].method, 'getNearestServicepoints');
  const op = parseXml(dhl.calls[0].body).children[0].children[0];
  assert.deepEqual(op.children[1].children.map((c) => [c.name, c.text]), [['postcode', '00838'], ['city', 'Warszawa'], ['radius', '3']]);
  const body = r.json();
  assert.deepEqual(Object.keys(body).sort(), ['channel_id', 'count', 'data', 'scope']);
  assert.equal(body.channel_id, dhlChannel);
  assert.equal(body.scope, 'external_sandbox');
  assert.equal(body.count, 1);
  assert.deepEqual(body.data[0], {
    id: '100000838', name: 'DHL POP Kiosk (syntetyczny)', type: 'POP',
    address: { street: 'Marszałkowska 1', postalCode: '00838', city: 'Warszawa' },
    location: { lat: 52.2297, lng: 21.0122 },
    hours: [{ day: 'MON', open: '08:00', close: '20:00' }, { day: 'SAT', open: '09:00', close: '14:00' }],
    description: 'Punkt syntetyczny',
  });
  assert.doesNotMatch(r.body, new RegExp(DHL_FAKE_PASSWORD));
  assert.equal((await points(dhlChannel, 'postcode=00838')).statusCode, 200, 'admin');
});

test('viewer 403 and another tenant 404, both without HTTP', async () => {
  network.length = 0;
  const viewer = await points(dhlChannel, 'postcode=00838', 'viewer');
  assert.equal(viewer.statusCode, 403, viewer.body);
  const other = await points(dhlChannel, 'postcode=00838', 'other');
  assert.equal(other.statusCode, 404, other.body);
  assert.equal((await points('00000000-0000-4000-8000-000000000000', 'postcode=00838')).statusCode, 404);
  assert.equal((await points('not-a-uuid', 'postcode=00838')).statusCode, 422);
  const nonDhl = (await pool.query("SELECT id FROM channels WHERE provider<>'dhl' AND tenant_id=(SELECT tenant_id FROM channels WHERE id=$1) LIMIT 1", [dhlChannel])).rows[0];
  if (nonDhl) assert.equal((await points(nonDhl.id, 'postcode=00838')).statusCode, 404, 'not a DHL account');
  assert.deepEqual(network, []);
});

test('local simulation: fixed local list, scope local_simulation, no HTTP', async () => {
  network.length = 0;
  const r = await points(localChannel, 'postcode=01-354');
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.scope, 'local_simulation');
  assert.ok(body.count >= 1 && body.count <= 3);
  assert.ok(body.data.every((p: any) => /^DEMO-/.test(p.id) && p.address.postalCode === '01354'));
  assert.deepEqual(network, []);
});

test('malformed provider answer → 502 without data; invalid query → 422 without HTTP', async () => {
  dhl.fail({ kind: 'raw', status: 200, body: '<garbage' });
  const bad = await points(dhlChannel, 'postcode=00838');
  assert.equal(bad.statusCode, 502, bad.body);
  assert.equal(bad.json().data, undefined);
  assert.doesNotMatch(bad.body, /garbage/);
  network.length = 0;
  for (const q of ['', 'postcode=0083', 'postcode=00838&radius=0', 'postcode=00838&radius=99', 'postcode=00838&extra=1'])
    assert.equal((await points(dhlChannel, q)).statusCode, 422, q);
  assert.deepEqual(network, []);
});
