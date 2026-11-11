// Egress allow-list for the 234 carriers (DHL24 WebAPI2, Poczta Polska eNadawca and Sledzenie): fixed
// endpoints, POST only, the SOAP operation parsed from the body and equal to SOAPAction, mutations only
// with write access. Request bodies come from the real clients; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConnectorPolicyError,
  validateOrdinaryConnectorAccess,
  validateOrdinaryConnectorRequest,
} from '../server/ordinary-connector-policy';
import { Dhl } from '../server/carrier-dhl';
import { PocztaPolska } from '../server/carrier-pocztapolska';
import { PocztaPolskaTracking } from '../server/carrier-pocztapolska-tracking';

type Captured = { url: string; init: RequestInit };
async function capture(run: (t: (url: string, init: RequestInit) => Promise<Response>) => Promise<unknown>) {
  const seen: Captured[] = [];
  await run(async (url, init) => {
    seen.push({ url, init });
    throw new TypeError('captured');
  }).catch(() => undefined);
  return seen[0];
}
const dhl = (t: any) => new Dhl('sandbox', { sap_account: '1234567' }, { username: 'u', password: 'p' }, t, { sleep: async () => undefined });
const pp = (mode: string, t: any) => new PocztaPolska(mode, { urzad_nadania: '123456' }, { username: 'u', password: 'p' }, t, { sleep: async () => undefined });
const policy = (provider: 'dhl' | 'pocztapolska', mode: 'sandbox' | 'live', access: 'read' | 'write') =>
  validateOrdinaryConnectorAccess({ providers: [{ provider, mode, access }] });
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    assert(e instanceof ConnectorPolicyError, String(e));
    return e.code;
  }
};
const check = (c: Captured, p: ReturnType<typeof policy>) => code(() => validateOrdinaryConnectorRequest(new URL(c.url), c.init, p));

test('DHL: reads with read access, createShipments and bookCourier only with write access', async () => {
  const labels = await capture((t) => dhl(t).labels('12345678'));
  assert.equal(labels.url, 'https://sandbox.dhl24.com.pl/webapi2');
  assert.equal(check(labels, policy('dhl', 'sandbox', 'read')), 'OK');
  const create = await capture((t) =>
    dhl(t).create(
      {
        channel_id: '00000000-0000-4000-8000-000000000000',
        sender: { name: 'Nadawca', address: 'Testowa 1', city: 'Warszawa', postalCode: '01-354', phone: '500600700', email: 'a@example.test' },
        receiver: { name: 'Odbiorca', address: 'Prosta 5', city: 'Kraków', postalCode: '30-001', phone: '500600701', email: 'b@example.test' },
        weight: 1,
        dimensions: { length: 10, width: 10, height: 10 },
        content: 'Towar',
      },
      'plan-key-0001',
    ),
  );
  assert.equal(check(create, policy('dhl', 'sandbox', 'read')), 'ROUTE');
  assert.equal(check(create, policy('dhl', 'sandbox', 'write')), 'OK');
  assert.equal(check(create, policy('dhl', 'live', 'write')), 'ROUTE', 'a live capability never reaches the sandbox host');
});

test('DHL: SOAPAction must name the body operation; DOCTYPE, GET, other paths and headers refuse', async () => {
  const labels = await capture((t) => dhl(t).labels('12345678'));
  const p = policy('dhl', 'sandbox', 'write');
  const headers = new Headers(labels.init.headers);
  headers.set('SOAPAction', '"https://dhl24.com.pl/webapi2/provider/service.html?ws=1#createShipments"');
  assert.equal(check({ ...labels, init: { ...labels.init, headers } }, p), 'HEADERS', 'smuggled operation');
  assert.equal(check({ ...labels, init: { ...labels.init, body: '<!DOCTYPE x [<!ENTITY a "b">]>' + labels.init.body } }, p), 'BODY');
  assert.equal(check({ ...labels, init: { ...labels.init, method: 'GET', body: undefined } }, p), 'METHOD');
  assert.equal(check({ ...labels, url: 'https://sandbox.dhl24.com.pl/webapi2/other' }, p), 'ROUTE');
  const extra = new Headers(labels.init.headers);
  extra.set('Cookie', 'x=1');
  assert.equal(check({ ...labels, init: { ...labels.init, headers: extra } }, p), 'HEADERS');
});

test('Poczta Polska: eNadawca needs Basic auth, addShipment needs write; tracking only with a live capability', async () => {
  const buffer = await capture((t) => pp('sandbox', t).buffer());
  assert.equal(buffer.url, 'https://en-testwebapi.poczta-polska.pl/websrv/en.php');
  assert.equal(check(buffer, policy('pocztapolska', 'sandbox', 'read')), 'OK');
  const noAuth = new Headers(buffer.init.headers);
  noAuth.delete('Authorization');
  assert.equal(check({ ...buffer, init: { ...buffer.init, headers: noAuth } }, policy('pocztapolska', 'sandbox', 'read')), 'HEADERS');
  const send = await capture((t) => pp('sandbox', t).sendEnvelope());
  assert.equal(check(send, policy('pocztapolska', 'sandbox', 'read')), 'ROUTE');
  assert.equal(check(send, policy('pocztapolska', 'sandbox', 'write')), 'OK');
  const track = await capture((t) => new PocztaPolskaTracking({ tracking_login: 'l', tracking_password: 'p' }, t, { sleep: async () => undefined }).events('FAKEPP0000000001'));
  assert.equal(check(track, policy('pocztapolska', 'sandbox', 'read')), 'ROUTE');
  assert.equal(check(track, policy('pocztapolska', 'live', 'read')), 'OK');
});

test('capabilities: one entry per provider and mode; unknown keys refuse', () => {
  assert.throws(() => validateOrdinaryConnectorAccess({ providers: [{ provider: 'dhl', mode: 'sandbox', access: 'read' }, { provider: 'dhl', mode: 'sandbox', access: 'write' }] } as any), /POLICY/);
  assert.throws(() => validateOrdinaryConnectorAccess({ providers: [{ provider: 'dhl', mode: 'sandbox', access: 'read', endpoint: 'x' }] } as any), /POLICY/);
  assert.equal(validateOrdinaryConnectorAccess({ providers: [{ provider: 'pocztapolska', mode: 'live', access: 'write' }] }).providers.length, 1);
});
