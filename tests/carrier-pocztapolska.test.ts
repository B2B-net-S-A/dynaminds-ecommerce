import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Problem } from '../server/errors';
import {
  PocztaPolska,
  PP_ENADAWCA_ENDPOINTS,
  PP_UNCERTAIN,
  assertPickupPoint,
  shipmentXml,
} from '../server/carrier-pocztapolska';
import {
  paczkaGabaryt,
  pocztaPolskaConnection,
  pocztaPolskaGuid,
  pocztaPolskaInput,
  pocztaPolskaPdf,
  pocztaPolskaShipment,
  pocztexFormat,
  polishNrb,
  splitStreet,
  type PocztaPolskaInput,
} from '../server/carrier-pocztapolska-values';
import { escapeXml, parseSoap } from '../server/carrier-pocztapolska-xml';
import { fakeLabelPdf, pocztaPolskaFake } from '../server/carrier-pocztapolska-fake';

// All provider responses are SYNTHETIC (server/carrier-pocztapolska-fake.ts and
// tests/fixtures/pocztapolska). No request leaves the process.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/pocztapolska/${name}`, import.meta.url), 'utf8');
const NRB = '61109010140000071219812874';
const noSleep = { sleep: async () => {} };
const address = (over: Record<string, unknown> = {}) => ({
  name: 'Jan Kowalski',
  address: 'Długa 5/3',
  city: 'Kraków',
  postalCode: '30-001',
  phone: '+48600100200',
  email: 'jan@example.test',
  ...over,
});
const input = (over: Record<string, unknown> = {}) =>
  pocztaPolskaInput.parse({
    channel_id: randomUUID(),
    service: 'pocztex_kurier',
    sender: address({ name: 'Sklep DYNA', address: 'Prosta 1', city: 'Warszawa', postalCode: '00-850' }),
    receiver: address(),
    weight: 1.25,
    dimensions: { length: 30, width: 20, height: 10 },
    content: 'Odzież',
    ...over,
  });
const issues = (over: Record<string, unknown>) => {
  const r = pocztaPolskaInput.safeParse({ ...input(), ...over });
  assert.equal(r.success, false);
  return r.error!.issues.map((i) => i.path.join('.') + ': ' + i.message);
};
function client(fake = pocztaPolskaFake(), mode = 'sandbox', options = {}) {
  return new PocztaPolska(mode, fake.settings, fake.credentials, fake.transport, { ...noSleep, ...options });
}
async function rejects(p: Promise<unknown>, status: number, re?: RegExp, code?: string) {
  await assert.rejects(p, (e: unknown) => {
    assert(e instanceof Problem, String(e));
    assert.equal(e.status, status, e.message);
    if (re) assert.match(e.message, re);
    if (code) assert.equal(e.code, code);
    return true;
  });
}

test('input: valid Pocztex parcel normalises postal codes, splits the street and builds the payload', () => {
  const id = randomUUID();
  const s = pocztaPolskaShipment(id, input({ cod: 12345, cod_account: 'PL ' + NRB, insurance: 20000 }));
  assert.equal(s.guid, id.replace(/-/g, '').toUpperCase());
  assert.equal(s.reference, 'DYNA-' + id);
  assert.equal(s.xsiType, 'pocztex2021KurierType');
  assert.deepEqual(
    [s.adres.ulica, s.adres.numerDomu, s.adres.numerLokalu, s.adres.kodPocztowy],
    ['Długa', '5', '3', '30001'],
  );
  assert.equal(s.masa, 1250);
  assert.equal(s.format, 'M');
  assert.deepEqual(s.pobranie, {
    sposobPobrania: 'RACHUNEK_BANKOWY',
    kwotaPobrania: 12345,
    nrb: NRB,
    tytulem: ('DYNA-' + id).slice(0, 50),
  });
});

test('input: address, weight, size and COD validation errors are Polish and field-scoped', () => {
  assert.match(issues({ receiver: address({ postalCode: '3000' }) }).join(), /receiver\.postalCode/);
  assert.match(issues({ receiver: address({ address: 'Rynek' }) }).join(), /receiver\.address: Podaj ulicę i numer domu/);
  assert.match(issues({ weight: 31 }).join(), /weight/);
  assert.match(issues({ service: 'paczka_pocztowa', weight: 25 }).join(), /Masa przekracza 20 kg/);
  assert.match(issues({ dimensions: { length: 150, width: 100, height: 100 } }).join(), /gabaryt/);
  assert.match(issues({ cod: 1000, insurance: 1000 }).join(), /cod_account: Pobranie wymaga prawidłowego numeru rachunku/);
  assert.match(issues({ cod: 1000, insurance: 1000, cod_account: NRB.slice(0, -1) + '5' }).join(), /NRB/);
  assert.match(issues({ cod: 1000, insurance: 500, cod_account: NRB }).join(), /Deklarowana wartość musi obejmować pobranie/);
  assert.match(issues({ cod: 600000, insurance: 600000, cod_account: NRB }).join(), /cod/);
  assert.match(issues({ cod: -1 }).join(), /cod/);
  assert.match(issues({ cod: 10.5, insurance: 100 }).join(), /cod/);
  assert.match(issues({ cod_account: NRB }).join(), /bez kwoty pobrania/);
  assert.match(
    issues({ service: 'paczka_pocztowa', cod: 1000, insurance: 1000, cod_account: NRB }).join(),
    /tylko w usługach Pocztex/,
  );
  assert.match(issues({ service: 'pocztex_punkt' }).join(), /wymaga wskazania punktu/);
  assert.match(issues({ pickup_point_id: '261234' }).join(), /tylko usługi doręczenia do punktu/);
});

test('values: NRB checksum, size classes, street split, guid and connection digest', () => {
  assert.equal(polishNrb('PL61 1090 1014 0000 0712 1981 2874'), NRB);
  assert.equal(polishNrb('1234'), null);
  assert.equal(pocztexFormat({ length: 65, width: 40, height: 9 }), 'S');
  assert.equal(pocztexFormat({ length: 150, width: 100, height: 40 }), '2XL');
  assert.equal(pocztexFormat({ length: 150, width: 100, height: 60 }), null);
  assert.equal(paczkaGabaryt({ length: 60, width: 50, height: 30 }), 'GABARYT_A');
  assert.equal(paczkaGabaryt({ length: 100, width: 40, height: 30 }), 'GABARYT_B');
  assert.equal(paczkaGabaryt({ length: 150, width: 40, height: 40 }), null);
  const base = address() as unknown as Parameters<typeof splitStreet>[0];
  assert.deepEqual(splitStreet({ ...base, address: 'Aleje Jerozolimskie 123A m. 4' }), {
    street: 'Aleje Jerozolimskie',
    house: '123A',
    apartment: '4',
  });
  assert.deepEqual(splitStreet({ ...base, address: 'Rynek Główny', houseNumber: '1' }), {
    street: 'Rynek Główny',
    house: '1',
    apartment: null,
  });
  assert.throws(() => pocztaPolskaGuid('not-a-uuid'), Problem);
  const ch = { provider: 'pocztapolska', mode: 'sandbox', settings: { urzad_nadania: '1' }, credentials: 'enc' };
  assert.match(pocztaPolskaConnection(ch), /^[a-f0-9]{64}$/);
  assert.notEqual(pocztaPolskaConnection(ch), pocztaPolskaConnection({ ...ch, credentials: 'other' }));
});

test('XML safety: values are escaped, control characters refused, DTD/entities rejected', () => {
  const s = pocztaPolskaShipment(randomUUID(), input({ receiver: address({ name: 'A&B <"x\'> Sp. z o.o.' }) }));
  const xml = shipmentXml(s);
  assert.match(xml, /<nazwa>A&amp;B &lt;&quot;x&apos;&gt; Sp\. z o\.o\.<\/nazwa>/);
  assert.throws(() => escapeXml('a\u0001b'), /znaki sterujące/);
  const invalid = (): never => {
    throw new Problem(502, 'invalid');
  };
  assert.throws(() => parseSoap(fixture('xxe-doctype.xml'), invalid, { maxBytes: 1e6 }), /invalid/);
  assert.throws(
    () => parseSoap('<a>&undefined;</a>', invalid, { maxBytes: 1e6 }),
    /invalid/,
  );
  assert.throws(() => parseSoap('<a/>'.padEnd(2000, ' '), invalid, { maxBytes: 100 }), /invalid/);
});

test('connection: hello + configured posting office, sandbox endpoint and Basic auth', async () => {
  const fake = pocztaPolskaFake();
  const seen: { url: string; headers: Headers }[] = [];
  const pp = new PocztaPolska('sandbox', fake.settings, fake.credentials, async (url, init) => {
    seen.push({ url, headers: new Headers(init.headers) });
    return fake.transport(url, init);
  });
  const r = await pp.test();
  assert.deepEqual(r, {
    environment: 'test',
    endpoint: 'en-testwebapi.poczta-polska.pl',
    office: { id: '123456', description: 'UP Warszawa 1 (syntetyczny)', name: 'UP Warszawa 1 (syntetyczny)' },
  });
  assert.deepEqual(fake.calls, ['hello', 'getUrzedyNadania']);
  assert(seen.every((s) => s.url === PP_ENADAWCA_ENDPOINTS.sandbox));
  assert.equal(seen[0].headers.get('soapaction'), '"http://e-nadawca.poczta-polska.pl/hello"');
  assert.match(seen[0].headers.get('authorization')!, /^Basic /);
  assert.equal(new PocztaPolska('live', fake.settings, fake.credentials).endpoint, PP_ENADAWCA_ENDPOINTS.live);
  // An office that does not belong to the account is refused.
  await rejects(
    new PocztaPolska('sandbox', { urzad_nadania: '999' }, fake.credentials, fake.transport, noSleep).test(),
    422,
    /Urząd nadania/,
  );
});

test('connection: configuration errors and auth failure', async () => {
  const fake = pocztaPolskaFake();
  assert.throws(() => new PocztaPolska('prod', fake.settings, fake.credentials), /środowisko/);
  assert.throws(() => new PocztaPolska('sandbox', {}, fake.credentials), /urzędu nadania/);
  assert.throws(() => new PocztaPolska('sandbox', fake.settings, { username: 'a:b', password: 'x' }), /login i hasło/);
  assert.throws(() => new PocztaPolska('sandbox', fake.settings, { username: 'a', password: 'x\ny' }), /login i hasło/);
  const wrong = new PocztaPolska('sandbox', fake.settings, { username: 'fixture-user', password: 'bad' }, fake.transport, noSleep);
  await rejects(wrong.test(), 401, /login lub hasło eNadawcy/, 'PROVIDER_HTTP_UNAUTHORIZED');
  fake.fail({ kind: 'status', status: 403 });
  await rejects(client(fake).offices(), 422, /uprawnień/, 'PP_FORBIDDEN');
});

test('shipment.create: one parcel, verified guid and posting number; COD and pickup point serialised', async () => {
  const fake = pocztaPolskaFake();
  const pp = client(fake);
  const s = pocztaPolskaShipment(randomUUID(), input({ cod: 5000, insurance: 5000, cod_account: NRB }));
  const r = await pp.create(s);
  assert.equal(r.guid, s.guid);
  assert.match(r.tracking_number, /^FAKEPP\d{10}$/);
  const stored = fake.buffer.get(s.guid)!.xml;
  assert.match(stored, /RACHUNEK_BANKOWY/);
  assert.match(stored, new RegExp(NRB));
  const point = pocztaPolskaShipment(
    randomUUID(),
    input({ service: 'pocztex_punkt', pickup_point_id: '261234' }),
  );
  assert.match(shipmentXml(point), /<odbiorWPunkcie>true<\/odbiorWPunkcie><idPunktuOdbioru>261234<\/idPunktuOdbioru>/);
  const paczka = pocztaPolskaShipment(randomUUID(), input({ service: 'paczka_pocztowa', category: 'PRIORYTETOWA' }));
  assert.match(shipmentXml(paczka), /xsi:type="en:paczkaPocztowaType".*<gabaryt>GABARYT_A<\/gabaryt><kategoria>PRIORYTETOWA<\/kategoria>/);
  assert.deepEqual(await pp.findShipment(s.guid), r);
});

test('shipment.create: provider validation errors and SOAP faults map to Polish problems', async () => {
  const fake = pocztaPolskaFake({ reject: () => ['Nieprawidłowy kod pocztowy adresata'] });
  const s = pocztaPolskaShipment(randomUUID(), input());
  await rejects(client(fake).create(s), 422, /Poczta Polska odrzuciła dane przesyłki: \[1000\] Nieprawidłowy kod pocztowy/, 'PP_REJECTED');
  assert.equal(fake.buffer.size, 0);

  const raw = pocztaPolskaFake();
  raw.fail({ kind: 'raw', status: 200, body: fixture('add-shipment-rejected.xml').replace('GUID_PLACEHOLDER', s.guid) });
  await rejects(client(raw).create(s), 422, /\[12010\] Nieprawidłowy kod pocztowy adresata; \[12020\] Brak numeru domu/);
  raw.fail({ kind: 'raw', status: 500, body: fixture('enadawca-fault-client.xml') });
  await rejects(client(raw).create(s), 422, /odrzuciła żądanie: Element 'masa'/, 'PP_SOAP_FAULT_CLIENT');
  raw.fail({ kind: 'raw', status: 500, body: fixture('enadawca-fault-server.xml') });
  await rejects(client(raw).offices(), 502, /Błąd usługi Poczty Polskiej/, 'PP_SOAP_FAULT_SERVER');
});

test('shipment.create: lost answer, timeout, 5xx and garbage are uncertain and never retried', async () => {
  for (const failure of [
    { kind: 'lose_answer' as const },
    { kind: 'network' as const },
    { kind: 'status' as const, status: 503 },
    { kind: 'raw' as const, status: 200, body: '<html>proxy</html>' },
    { kind: 'raw' as const, status: 500, body: 'PRIVATE_PROVIDER_ERROR' },
  ]) {
    const fake = pocztaPolskaFake();
    fake.fail(failure);
    await rejects(client(fake).create(pocztaPolskaShipment(randomUUID(), input())), 502, /uzgodnij wynik/, PP_UNCERTAIN);
    assert.deepEqual(fake.calls.filter((c) => c === 'addShipment').length, failure.kind === 'lose_answer' ? 1 : 0, failure.kind);
  }
  const fake = pocztaPolskaFake();
  fake.fail({ kind: 'hang' });
  const started = Date.now();
  await rejects(
    client(fake, 'sandbox', { timeoutMs: 50 }).create(pocztaPolskaShipment(randomUUID(), input())),
    504,
    /uzgodnij wynik/,
    PP_UNCERTAIN,
  );
  assert(Date.now() - started < 2000);
});

test('reads retry 429/5xx and timeouts with backoff; give up after 3 attempts', async () => {
  const waits: number[] = [];
  const fake = pocztaPolskaFake();
  fake.fail({ kind: 'status', status: 429 }, { kind: 'hang' });
  const pp = client(fake, 'sandbox', { timeoutMs: 30, sleep: async (ms: number) => void waits.push(ms) });
  assert.equal((await pp.offices()).length, 1);
  assert.deepEqual(waits, [200, 400]);
  fake.fail({ kind: 'status', status: 503 }, { kind: 'status', status: 503 }, { kind: 'status', status: 503 });
  await rejects(pp.offices(), 502, /HTTP 503/);
  fake.fail({ kind: 'hang' }, { kind: 'hang' }, { kind: 'hang' });
  await rejects(pp.offices(), 504, /nie odpowiedziała/, 'PP_TIMEOUT');
});

test('label.pdf: non-empty PDF bytes for the exact guid; missing parcel and bad PDF refused', async () => {
  const fake = pocztaPolskaFake();
  const pp = client(fake);
  const s = pocztaPolskaShipment(randomUUID(), input());
  await pp.create(s);
  const label = await pp.labels(s.guid);
  assert(label.pdf.length > 100);
  assert.equal(label.pdf.subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual(label.pdf, Buffer.from(label.label_base64, 'base64'));
  await rejects(pp.labels(pocztaPolskaGuid(randomUUID())), 404, /Brak etykiety/, 'PP_LABEL_MISSING');
  await assert.rejects(() => pp.labels('../etc'), /Nieprawidłowy identyfikator/);
  assert.throws(() => pocztaPolskaPdf(Buffer.from('not a pdf').toString('base64')), /Nieprawidłowa etykieta PDF/);
  assert.throws(() => pocztaPolskaPdf(''), /Nieprawidłowa etykieta PDF/);
  assert.equal(pocztaPolskaPdf(fakeLabelPdf().toString('base64')).subarray(0, 5).toString(), '%PDF-');
});

test('sendEnvelope hands the buffer over once; status readback; cancel removes only named guids', async () => {
  const fake = pocztaPolskaFake();
  const pp = client(fake);
  const a = pocztaPolskaShipment(randomUUID(), input()),
    b = pocztaPolskaShipment(randomUUID(), input());
  await pp.create(a);
  await pp.create(b);
  await pp.cancel([b.guid]);
  assert.deepEqual([...fake.buffer.keys()], [a.guid]);
  await rejects(pp.cancel([b.guid]), 422, /Brak przesyłki/);
  const sent = await pp.sendEnvelope();
  assert.equal(sent.status, 'WYSLANY');
  assert.deepEqual(fake.sent[0].guids, [a.guid]);
  assert.equal(await pp.envelopeStatus(sent.envelope_id), 'PRZYJETY');
  // The label stays printable after hand-over.
  assert((await pp.labels(a.guid)).pdf.length > 0);
  fake.fail({ kind: 'lose_answer' });
  await rejects(pp.sendEnvelope(), 502, /nie ponawiaj/, PP_UNCERTAIN);
  await rejects(pp.clearEnvelope('1', false), 422, /jawnego potwierdzenia/);
});

test('pickup_point: offices listed per voivodeship; only active pickup points accepted', async () => {
  const fake = pocztaPolskaFake();
  fake.setPoints('14', fixture('placowki-14.xml'));
  const points = await client(fake).points('14');
  assert.equal(points.length, 2);
  assert.deepEqual(points[0], {
    id: '261234',
    name: 'UP Warszawa 1',
    street: 'Świętokrzyska',
    house_number: '31/33',
    postal_code: '00001',
    city: 'Warszawa',
    hours: [
      { day: 'dniRobocze', hours: '08:00-20:00' },
      { day: 'soboty', hours: '09:00-14:00' },
    ],
    pickup: true,
  });
  assert.equal(assertPickupPoint(points, '261234').id, '261234');
  assert.throws(() => assertPickupPoint(points, '261235'), /nie wydaje przesyłek/);
  assert.throws(() => assertPickupPoint(points, '1'), /nie istnieje/);
  await rejects(client(fake).points('15'), 422, /województwa/);
});

test('input type is the parsed shape used by the payload builder', () => {
  const parsed: PocztaPolskaInput = input();
  assert.equal(parsed.receiver.postalCode, '30001');
  assert.equal(parsed.cod, 0);
});
