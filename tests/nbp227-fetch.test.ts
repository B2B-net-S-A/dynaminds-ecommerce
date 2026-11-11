/** 227 NBP day/range reads against recorded replies (no live network): URLs, schema,
 * exact decimal text, 404 = no table, timeout and refusals; the ordinary port exposes
 * the reads only when both exact routes are declared. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Nbp227FetchError, nbp227FetchProblem, nbp227ReadPolicy, nbp227Url, parseNbp227Reply, readNbp227TableA } from '../server/nbp227-fetch';
import { nbpLatestTableAReadPolicy } from '../server/nbp-exchange-rates';
import { prepareOrdinaryNbpRates } from '../server/ordinary-provider-reads';
import { RECORDED_DAY_20261016, RECORDED_RANGE_20261009_20261022, RECORDED_SATURDAY_404_BODY } from './nbp227-fixtures';

const json = (body: string, status = 200, type = 'application/json; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type } });
function transport(reply: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  return { calls, fn: async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply(); } };
}
const code = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return e instanceof Nbp227FetchError ? e.code : String(e); } };

test('day and range URLs and the declared routes', () => {
  assert.equal(nbp227Url('EUR', '2026-10-16'), 'https://api.nbp.pl/api/exchangerates/rates/a/eur/2026-10-16/?format=json');
  assert.equal(nbp227Url('EUR', '2026-10-09', '2026-10-22'), 'https://api.nbp.pl/api/exchangerates/rates/a/eur/2026-10-09/2026-10-22/?format=json');
  for (const bad of [() => nbp227Url('PLN', '2026-10-16'), () => nbp227Url('eur', '2026-10-16'), () => nbp227Url('EUR', '2026-10-22', '2026-10-09'), () => nbp227Url('EUR', '2026-01-01', '2026-06-01'), () => nbp227Url('EUR', '16.10.2026')])
    assert.throws(bad, (e: any) => e.code === 'REQUEST');
  assert.deepEqual(nbp227ReadPolicy('EUR').routes.map(r => r.path), ['/api/exchangerates/rates/a/eur/:date/', '/api/exchangerates/rates/a/eur/:start/:end/']);
});

test('recorded range and day replies keep the exact mid text; Saturday 404 means no table', async () => {
  const range = transport(() => json(RECORDED_RANGE_20261009_20261022));
  const pubs = await readNbp227TableA({ currency: 'EUR', start: '2026-10-09', end: '2026-10-22', transport: range.fn });
  assert.equal(range.calls[0]!.url, 'https://api.nbp.pl/api/exchangerates/rates/a/eur/2026-10-09/2026-10-22/?format=json');
  assert.equal(range.calls[0]!.init.method, 'GET');
  assert(range.calls[0]!.init.signal instanceof AbortSignal);
  assert.equal(pubs.length, 10);
  assert.deepEqual(pubs[0], { effective_date: '2026-10-09', table_no: '197/A/NBP/2026', mid: '4.3775' });
  assert.deepEqual(pubs.at(-1), { effective_date: '2026-10-22', table_no: '206/A/NBP/2026', mid: '4.3685' });
  const day = transport(() => json(RECORDED_DAY_20261016));
  assert.deepEqual(await readNbp227TableA({ currency: 'EUR', start: '2026-10-16', transport: day.fn }), [{ effective_date: '2026-10-16', table_no: '202/A/NBP/2026', mid: '4.3661' }]);
  const sat = transport(() => new Response(RECORDED_SATURDAY_404_BODY, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  assert.deepEqual(await readNbp227TableA({ currency: 'EUR', start: '2026-10-17', transport: sat.fn }), []);
  assert.equal(parseNbp227Reply('{"table":"A","currency":"euro","code":"EUR","rates":[{"no":"001/A/NBP/2026","effectiveDate":"2026-01-02","mid":4.2}]}', 'EUR', '2026-01-02', '2026-01-02')[0]!.mid, '4.2');
});

test('schema, precision, status and transport refusals', async () => {
  const base = JSON.parse(RECORDED_DAY_20261016);
  const cases: [string, string][] = [
    [JSON.stringify({ ...base, extra: 1 }), 'RESPONSE_SCHEMA'],
    [JSON.stringify({ ...base, table: 'B' }), 'RESPONSE_SCHEMA'],
    [JSON.stringify({ ...base, code: 'USD' }), 'RESPONSE_SCHEMA'],
    [JSON.stringify({ ...base, rates: [] }), 'RESPONSE_SCHEMA'],
    [JSON.stringify({ ...base, rates: [{ ...base.rates[0], effectiveDate: '2026-10-15' }] }), 'RESPONSE_SCHEMA'],
    [JSON.stringify({ ...base, rates: [{ ...base.rates[0], no: '202/A/NBP/2025' }] }), 'RESPONSE_SCHEMA'],
    [JSON.stringify({ ...base, rates: [{ ...base.rates[0], mid: '4.3661' }] }), 'RESPONSE_SCHEMA'],
    [JSON.stringify({ ...base, rates: [{ ...base.rates[0], bid: 4.3 }] }), 'RESPONSE_SCHEMA'],
    [RECORDED_DAY_20261016.replace('4.3661', '4.36612'), 'RATE_PRECISION'],
    [RECORDED_DAY_20261016.replace('4.3661', '-4.3661'), 'RATE_PRECISION'],
    ['not json', 'RESPONSE_SCHEMA'],
  ];
  for (const [body, want] of cases) assert.equal(await code(readNbp227TableA({ currency: 'EUR', start: '2026-10-16', transport: transport(() => json(body)).fn })), want, body);
  const twoDays = JSON.parse(RECORDED_RANGE_20261009_20261022);
  assert.equal(await code(readNbp227TableA({ currency: 'EUR', start: '2026-10-09', end: '2026-10-22', transport: transport(() => json(JSON.stringify({ ...twoDays, rates: [...twoDays.rates].reverse() }))).fn })), 'RESPONSE_SCHEMA', 'unordered');
  assert.equal(await code(readNbp227TableA({ currency: 'EUR', start: '2026-10-16', transport: transport(() => json(RECORDED_DAY_20261016, 200, 'text/html')).fn })), 'RESPONSE_SCHEMA');
  assert.equal(await code(readNbp227TableA({ currency: 'EUR', start: '2026-10-16', transport: transport(() => json('x'.repeat(70_000))).fn })), 'RESPONSE_LIMIT');
  assert.equal(await code(readNbp227TableA({ currency: 'EUR', start: '2026-10-16', transport: transport(() => json('busy', 429)).fn })), 'RATE_LIMITED');
  assert.equal(await code(readNbp227TableA({ currency: 'EUR', start: '2026-10-16', transport: transport(() => json('err', 500)).fn })), 'HTTP');
  assert.equal(await code(readNbp227TableA({ currency: 'EUR', start: '2026-10-16', transport: transport(() => { throw new Error('dns'); }).fn })), 'TRANSPORT');
  const hang = (_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
  // AbortSignal.timeout() is unref'd; a server keeps the loop alive, this test does it explicitly.
  const started = Date.now(), alive = setTimeout(() => undefined, 5000);
  assert.equal(await code(readNbp227TableA({ currency: 'EUR', start: '2026-10-16', transport: hang, timeoutMs: 50 })), 'TIMEOUT');
  clearTimeout(alive);
  assert(Date.now() - started < 2000);
  assert.equal(await code(readNbp227TableA({ currency: 'EUR', start: '2026-10-16', transport: hang, timeoutMs: 0 })), 'REQUEST');
  assert.deepEqual(nbp227FetchProblem(new Nbp227FetchError('TIMEOUT')).status, 504);
  assert.match(nbp227FetchProblem(new Nbp227FetchError('RESPONSE_SCHEMA')).message, /ręcznie/);
});

test('ordinary NBP port exposes day/range reads only with both exact routes declared', async () => {
  const t = transport(() => json(RECORDED_DAY_20261016)), configuration = { currencies: ['EUR'], maxAgeDays: 7 }, ctx = { readOnly: false, localWooFixture: false };
  const latestOnly = prepareOrdinaryNbpRates(configuration, nbpLatestTableAReadPolicy('EUR'), t.fn, ctx)!;
  assert.equal(latestOnly.readTableA, undefined);
  const oneRoute = prepareOrdinaryNbpRates(configuration, { routes: [...nbpLatestTableAReadPolicy('EUR').routes, nbp227ReadPolicy('EUR').routes[0]!] }, t.fn, ctx)!;
  assert.equal(oneRoute.readTableA, undefined);
  const full = prepareOrdinaryNbpRates(configuration, { routes: [...nbpLatestTableAReadPolicy('EUR').routes, ...nbp227ReadPolicy('EUR').routes] }, t.fn, ctx)!;
  assert.deepEqual(await full.readTableA!('EUR', '2026-10-16', undefined), [{ effective_date: '2026-10-16', table_no: '202/A/NBP/2026', mid: '4.3661' }]);
  assert.equal(t.calls[0]!.url, 'https://api.nbp.pl/api/exchangerates/rates/a/eur/2026-10-16/?format=json');
  assert.throws(() => full.readTableA!('USD', '2026-10-16', undefined), /selected-currency/);
});
