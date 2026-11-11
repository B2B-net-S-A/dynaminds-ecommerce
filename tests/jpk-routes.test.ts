/** JPK routes with injected authorization and loader (no DB): 403 without the finance-admin
 * permission or with an API key, Polish 400 for a bad period or parameters, 409 listing the
 * documents that cannot be expressed, 200 XML download headers, V7K quarter range. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { Problem } from '../server/errors';
import { registerJpkRoutes, type JpkRouteDeps } from '../server/jpk-routes';
import { JpkError } from '../server/jpk-model';
import { fvA, korA, fvNov, fvDec, jpkValues, jpkRecords, dailyReports } from './jpk-fixtures';
import type { JpkReceiptSales } from '../server/jpk-receipts';
import { jpkXsdValidator } from '../server/jpk-xsd';
import type { XsdResult } from '../server/mf-xsd';

let app: FastifyInstance;
const loads: [string, string, string][] = [];
let refuse = false, sales: JpkReceiptSales | undefined;
/** null: the real vendored-schema check; otherwise the forced verdict. */
let verdict: XsdResult | null = null;
const checked: string[] = [];
const deps: JpkRouteDeps = {
  authorize: async a => { if (a.role !== 'admin') throw new Problem(403, 'Wymagany aktualny administrator finansów'); },
  load: async (_req, from, to, by) => {
    loads.push([from, to, by]);
    if (refuse) throw new JpkError(409, 'Części dokumentów okresu nie da się ująć w pliku JPK', [{ number: 'FV/EUR/1', reason: 'Faktura w walucie EUR wymaga zapisanego kursu NBP dokumentu (migracja 227)' }]);
    const all = [fvA().jpk, korA(), fvNov(), fvDec()];
    return { documents: all.filter(d => (by === 'tax' ? d.tax_date : d.model.issue_date) >= from && (by === 'tax' ? d.tax_date : d.model.issue_date) <= to), skipped: 0,
      ...(sales && by === 'tax' ? { receipt_sales: sales } : {}) };
  },
  now: () => new Date('2026-11-05T08:00:00.000Z'),
  xsd: async (schema, xml) => { checked.push(schema); return verdict ?? jpkXsdValidator(schema).validate(xml); },
};
const TP = 'kod_urzedu=1206&email=ksiegowosc%40sklep.test';
const ADDR = 'wojewodztwo=ma%C5%82opolskie&powiat=Krak%C3%B3w&gmina=Krak%C3%B3w&nr_domu=2&miejscowosc=Krak%C3%B3w&kod_pocztowy=30-001';
const get = (url: string, role = 'admin', api = false) => app.inject({ url, headers: { 'x-test-as': JSON.stringify({ role, api }) } });

before(async () => {
  app = Fastify();
  app.decorateRequest('actor'); app.decorateRequest('apiScopes');
  app.addHook('onRequest', async (req: any) => {
    const w = JSON.parse(String(req.headers['x-test-as']));
    req.actor = { tenantId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002', role: w.role };
    if (w.api) req.apiScopes = ['documents:read'];
  });
  app.setErrorHandler((err: any, _req, reply) => err instanceof Problem
    ? reply.code(err.status).send({ detail: err.message }) : reply.code(500).send({ detail: 'Nieoczekiwany błąd serwera' }));
  registerJpkRoutes(app, { sessionName: 'dyna_session' }, deps);
  await app.ready();
});
after(async () => { await app.close(); });

test('V7M download: XML attachment, no-store, nosniff, row count header; NIP and name taken from the documents', async () => {
  const r = await get(`/api/jpk/v7m.xml?okres=2026-10&${TP}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['content-type'], 'application/xml; charset=utf-8');
  assert.equal(r.headers['content-disposition'], 'attachment; filename="JPK_V7M-2026-10.xml"');
  assert.deepEqual([r.headers['cache-control'], r.headers['x-content-type-options'], r.headers['x-jpk-wiersze']], ['no-store', 'nosniff', '2']);
  const v = jpkValues(r.body);
  assert.deepEqual([v.NIP, v.PelnaNazwa, v.KodUrzedu, v.DataWytworzeniaJPK], [['5260250274'], ['Sklep Testowy Sp. z o.o.'], ['1206'], ['2026-11-05T08:00:00.000Z']]);
  assert.deepEqual(loads.at(-1), ['2026-10-01', '2026-10-31', 'tax']);
  assert.deepEqual([r.headers['x-walidacja-xsd'], checked.at(-1)], ['zgodny', 'JPK_V7M'], 'checked against the official JPK_V7M(3) schema');
});

test('official-schema check before the download: a non-conforming file is 422 with the Polish reason, nothing is sent; a skipped check is marked', async () => {
  verdict = { status: 'invalid', errors: "Schemas validity error : Element 'P_37': This element is not expected. Expected is ( P_32 )." };
  try {
    for (const [url, schema] of [[`/api/jpk/v7m.xml?okres=2026-10&${TP}`, 'JPK_V7M'], [`/api/jpk/v7k.xml?okres=2026-12&${TP}`, 'JPK_V7K'],
      [`/api/jpk/fa.xml?od=2026-10-01&do=2026-10-31&${TP}&${ADDR}`, 'JPK_FA']] as const) {
      const r = await get(url);
      assert.equal(r.statusCode, 422, r.body);
      assert.equal(r.headers['content-disposition'], undefined, 'no file');
      assert.match(JSON.parse(r.body).detail, new RegExp(`^Plik ${schema}\\(\\d\\) nie jest zgodny ze schematem Ministerstwa Finansów: .*P_37`));
      assert.equal(checked.at(-1), schema);
    }
    verdict = { status: 'skipped', reason: 'Brak oficjalnego schematu JPK_V7M(3) w repozytorium' };
    const s = await get(`/api/jpk/v7m.xml?okres=2026-10&${TP}`);
    assert.equal(s.statusCode, 200); assert.equal(s.headers['x-walidacja-xsd'], 'pominieta');
  } finally { verdict = null; }
});

test('V7K: month 11 reads the month only and has no declaration; month 12 reads the whole quarter', async () => {
  const nov = await get(`/api/jpk/v7k.xml?okres=2026-11&${TP}`);
  assert.equal(nov.statusCode, 200, nov.body); assert.deepEqual(loads.at(-1), ['2026-11-01', '2026-11-30', 'tax']);
  assert.equal(jpkValues(nov.body).Deklaracja, undefined);
  const dec = await get(`/api/jpk/v7k.xml?okres=2026-12&${TP}&nadwyzka=10`);
  assert.equal(dec.statusCode, 200, dec.body); assert.deepEqual(loads.at(-1), ['2026-10-01', '2026-12-31', 'tax']);
  const v = jpkValues(dec.body);
  assert.deepEqual([v.KodFormularzaDekl, v.LiczbaWierszySprzedazy, v.P_39], [['VAT-7K'], ['1'], ['10']]);
});

test('JPK_FA download by issue date with the address', async () => {
  const r = await get(`/api/jpk/fa.xml?od=2026-10-01&do=2026-10-31&kod_urzedu=1206&${ADDR}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['content-disposition'], 'attachment; filename="JPK_FA-2026-10-01_2026-10-31.xml"');
  assert.deepEqual(loads.at(-1), ['2026-10-01', '2026-10-31', 'issue']);
  assert.deepEqual(jpkValues(r.body).LiczbaFaktur, ['2']);
});

test('403: no finance-admin permission, or an API key instead of a session; nothing is read', async () => {
  const before = loads.length;
  for (const [role, api] of [['operator', false], ['viewer', false], ['admin', true]] as const) {
    const r = await get(`/api/jpk/v7m.xml?okres=2026-10&${TP}`, role, api);
    assert.equal(r.statusCode, 403, r.body); assert.match(r.json().detail, /administrator finansów|sesji użytkownika/);
  }
  const fa = await get(`/api/jpk/fa.xml?od=2026-10-01&do=2026-10-31&kod_urzedu=1206&${ADDR}`, 'operator');
  assert.equal(fa.statusCode, 403);
  assert.equal(loads.length, before);
});

test('400 with a Polish reason: bad period, missing or malformed parameters, unknown parameter, range', async () => {
  const cases: [string, RegExp][] = [
    [`/api/jpk/v7m.xml?okres=2026-13&${TP}`, /„okres”: Okres w formacie RRRR-MM/],
    [`/api/jpk/v7m.xml?${TP}`, /„okres”/],
    [`/api/jpk/v7m.xml?okres=2026-01&${TP}`, /od 2026-02/],
    ['/api/jpk/v7m.xml?okres=2026-10&email=a%40b.pl', /„kod_urzedu”/],
    [`/api/jpk/v7m.xml?okres=2026-10&kod_urzedu=1206`, /e-mail/],
    [`/api/jpk/v7m.xml?okres=2026-10&${TP}&nip=1234567890`, /Niepoprawny NIP/],
    [`/api/jpk/v7m.xml?okres=2026-10&${TP}&osoba=fizyczna`, /imię, nazwisko i datę urodzenia/],
    [`/api/jpk/v7m.xml?okres=2026-10&${TP}&debug=1`, /Nieznany parametr: debug/],
    [`/api/jpk/fa.xml?od=2026-10-31&do=2026-10-01&kod_urzedu=1206&${ADDR}`, /późniejsza/],
    [`/api/jpk/fa.xml?od=2026-02-30&do=2026-10-01&kod_urzedu=1206&${ADDR}`, /„od”: Nie ma takiej daty/],
    [`/api/jpk/fa.xml?od=2025-01-01&do=2026-10-01&kod_urzedu=1206&${ADDR}`, /366 dni/],
    ['/api/jpk/fa.xml?od=2026-10-01&do=2026-10-31&kod_urzedu=1206', /„wojewodztwo”/],
  ];
  for (const [url, pattern] of cases) {
    const r = await get(url);
    assert.equal(r.statusCode, 400, url + ' ' + r.body);
    assert.match(r.json().detail, pattern, url);
    assert.doesNotMatch(r.body, /at .*\.ts|ZodError|Invalid/, 'no stack trace or raw validator text');
  }
});

test('409 lists the documents that cannot be expressed', async () => {
  refuse = true;
  try {
    for (const url of [`/api/jpk/v7m.xml?okres=2026-10&${TP}`, `/api/jpk/fa.xml?od=2026-10-01&do=2026-10-31&kod_urzedu=1206&${ADDR}`]) {
      const r = await get(url);
      assert.equal(r.statusCode, 409, r.body);
      assert.deepEqual(r.json(), { detail: 'Części dokumentów okresu nie da się ująć w pliku JPK',
        documents: [{ number: 'FV/EUR/1', reason: 'Faktura w walucie EUR wymaga zapisanego kursu NBP dokumentu (migracja 227)' }] });
    }
  } finally { refuse = false; }
});

test('233 daily reports from the loader: RO rows in V7M and V7K; a report "niezgodny" answers 409 with the list', async () => {
  sales = dailyReports();
  try {
    const r = await get(`/api/jpk/v7m.xml?okres=2026-10&${TP}`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['x-jpk-wiersze'], '4');
    assert.deepEqual(jpkRecords(r.body, 'SprzedazWiersz').filter(x => x.TypDokumentu === 'RO').map(x => x.DowodSprzedazy), ['RO/DYN23300001/0001', 'RO/DYN23300001/0002']);
    const k = await get(`/api/jpk/v7k.xml?okres=2026-12&${TP}`);
    assert.equal(k.statusCode, 200, k.body);
    assert.equal(jpkRecords(k.body, 'SprzedazWiersz').some(x => x.TypDokumentu === 'RO'), false, 'October RO not in the December ewidencja');
    assert.ok(BigInt(jpkValues(k.body).P_20![0]!) >= 69n, 'quarter declaration includes the October RO VAT (46 + 23 zł)');
    sales = { unreported: [], reports: [{ ...dailyReports().reports[0]!, matches: false, app_receipts: 2 }] };
    const bad = await get(`/api/jpk/v7m.xml?okres=2026-10&${TP}`);
    assert.equal(bad.statusCode, 409, bad.body);
    assert.deepEqual(bad.json().documents.map((d: any) => d.number), ['Raport dobowy 0001 z 2026-10-24, kasa DYN23300001']);
    assert.equal((await get(`/api/jpk/fa.xml?od=2026-10-01&do=2026-10-31&kod_urzedu=1206&${ADDR}`)).statusCode, 200, 'JPK_FA does not read the daily reports');
  } finally { sales = undefined; }
});
