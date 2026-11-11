/** Analytics reports (S7) without a database: Warsaw period buckets across both DST
 * changes, series folding, per-SKU aggregation, personal-data masking, Polish 422,
 * chart CSV = series totals, and the API-key refusal of the routes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Problem } from '../server/errors';
import { addDays, bucketStart, foldSeries, periodBuckets, warsawDay, warsawMidnightUtc } from '../server/reports-period';
import {
  aggregateSkuStats,
  customerQuery,
  employeeQuery,
  maskEmail,
  maskName,
  parseReportQuery,
  periodQuery,
  productQuery,
  SERIES_METRICS,
  seriesCsv,
  skuCsv,
  type SkuPriceRow,
} from '../server/reports-model';
import { registerReportAnalyticsRoutes } from '../server/reports-routes';

test('Warsaw midnight is 23:00 UTC in winter, 22:00 UTC in summer; DST days have 23 and 25 hours', () => {
  assert.equal(warsawMidnightUtc('2026-01-15'), '2026-01-14T23:00:00.000Z');
  assert.equal(warsawMidnightUtc('2026-07-01'), '2026-06-30T22:00:00.000Z');
  assert.equal(warsawMidnightUtc('2026-03-29'), '2026-03-28T23:00:00.000Z');
  assert.equal(warsawMidnightUtc('2026-03-30'), '2026-03-29T22:00:00.000Z');
  assert.equal(warsawMidnightUtc('2026-10-25'), '2026-10-24T22:00:00.000Z');
  assert.equal(warsawMidnightUtc('2026-10-26'), '2026-10-25T23:00:00.000Z');
  const spring = periodBuckets('2026-03-28', '2026-03-30', 'day');
  assert.deepEqual(spring.map((b) => b.hours), [24, 23, 24]);
  const autumn = periodBuckets('2026-10-24', '2026-10-26', 'day');
  assert.deepEqual(autumn.map((b) => b.hours), [24, 25, 24]);
  // Buckets tile the period without gaps or overlaps.
  for (const list of [spring, autumn, periodBuckets('2026-01-01', '2026-12-31', 'week'), periodBuckets('2026-01-01', '2026-12-31', 'month')])
    for (let i = 1; i < list.length; i++) assert.equal(list[i].from_at, list[i - 1].to_exclusive_at);
});

test('instants around the DST changes fall into the right Warsaw day', () => {
  // 2026-10-25 01:59:59 UTC = 02:59:59 CET (second pass), still 25 Oct; 22:59:59 UTC = 23:59:59 CET.
  assert.equal(warsawDay('2026-10-24T21:59:59.999Z'), '2026-10-24');
  assert.equal(warsawDay('2026-10-24T22:00:00.000Z'), '2026-10-25');
  assert.equal(warsawDay('2026-10-25T00:30:00.000Z'), '2026-10-25');
  assert.equal(warsawDay('2026-10-25T01:30:00.000Z'), '2026-10-25');
  assert.equal(warsawDay('2026-10-25T22:59:59.999Z'), '2026-10-25');
  assert.equal(warsawDay('2026-10-25T23:00:00.000Z'), '2026-10-26');
  assert.equal(warsawDay('2026-03-28T22:59:59.999Z'), '2026-03-28');
  assert.equal(warsawDay('2026-03-28T23:00:00.000Z'), '2026-03-29');
  assert.equal(warsawDay('2026-03-29T21:59:59.999Z'), '2026-03-29');
  assert.equal(warsawDay('2026-03-29T22:00:00.000Z'), '2026-03-30');
  // Each instant lies inside the bucket whose key is its Warsaw day.
  for (const iso of ['2026-10-24T22:00:00.000Z', '2026-10-25T22:59:59.999Z', '2026-03-29T21:59:59.999Z']) {
    const b = periodBuckets(warsawDay(iso), warsawDay(iso), 'day')[0];
    assert(b.from_at <= iso && iso < b.to_exclusive_at, iso);
  }
});

test('week buckets start on Monday, month buckets on the 1st, both clipped to the period', () => {
  assert.equal(bucketStart('2026-10-25', 'week'), '2026-10-19'); // Sunday → Monday before
  assert.equal(bucketStart('2026-10-26', 'week'), '2026-10-26');
  assert.equal(bucketStart('2026-10-25', 'month'), '2026-10-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  const weeks = periodBuckets('2026-10-22', '2026-11-03', 'week');
  assert.deepEqual(weeks.map((w) => [w.key, w.from, w.to]), [
    ['2026-10-19', '2026-10-22', '2026-10-25'],
    ['2026-10-26', '2026-10-26', '2026-11-01'],
    ['2026-11-02', '2026-11-02', '2026-11-03'],
  ]);
  assert.equal(weeks[0].hours, 4 * 24 + 1); // contains the 25-hour Sunday
  assert.deepEqual(weeks.map((w) => w.label), ['22.10–25.10.2026', '26.10–01.11.2026', '02.11–03.11.2026']);
  assert.equal(periodBuckets('2026-10-26', '2026-10-26', 'week')[0].label, '26.10.2026');
  const months = periodBuckets('2026-02-15', '2026-04-02', 'month');
  assert.deepEqual(months.map((m) => [m.key, m.from, m.to, m.label]), [
    ['2026-02-01', '2026-02-15', '2026-02-28', 'luty 2026'],
    ['2026-03-01', '2026-03-01', '2026-03-31', 'marzec 2026'],
    ['2026-04-01', '2026-04-01', '2026-04-02', 'kwiecień 2026'],
  ]);
  assert.equal(months[1].hours, 31 * 24 - 1);
  assert.equal(periodBuckets('2027-12-30', '2028-01-02', 'month').length, 2);
});

test('series folding: empty buckets are zero, totals = sum of points, exact bigint, foreign day refused', () => {
  const buckets = periodBuckets('2026-10-24', '2026-10-27', 'week');
  const rows = [
    { day: '2026-10-24', currency: 'PLN', orders: 1, total_gross_minor: '9007199254740993' },
    { day: '2026-10-25', currency: 'PLN', orders: 2, total_gross_minor: '7' },
    { day: '2026-10-26', currency: 'EUR', orders: 1, total_gross_minor: '100' },
  ];
  const s = foldSeries(rows, buckets, 'week', ['orders', 'total_gross_minor']);
  assert.deepEqual(s.map((x) => x.currency), ['EUR', 'PLN']);
  assert.deepEqual(s[1].points, [
    { key: '2026-10-19', orders: '3', total_gross_minor: '9007199254741000' },
    { key: '2026-10-26', orders: '0', total_gross_minor: '0' },
  ]);
  assert.deepEqual(s[1].totals, { orders: '3', total_gross_minor: '9007199254741000' });
  assert.deepEqual(s[0].points.map((p) => p.orders), ['0', '1']);
  assert.throws(() => foldSeries([{ day: '2026-11-30', currency: 'PLN', orders: 1 }], buckets, 'week', ['orders']), /spoza zakresu/);
});

test('chart CSV: the bucket rows sum to the total row and to the JSON totals; values hidden without permission', () => {
  const buckets = periodBuckets('2026-10-01', '2026-10-31', 'week');
  const rows = [
    { day: '2026-10-02', currency: 'PLN', orders: 2, commercial_quantity: 3, goods_gross_minor: '2000', goods_net_minor: '1626', delivery_gross_minor: '999', total_gross_minor: '2999' },
    { day: '2026-10-25', currency: 'PLN', orders: 1, commercial_quantity: 1, goods_gross_minor: '-0', goods_net_minor: '0', delivery_gross_minor: '0', total_gross_minor: '0' },
    { day: '2026-10-31', currency: 'EUR', orders: 1, commercial_quantity: 5, goods_gross_minor: '5000', goods_net_minor: '4065', delivery_gross_minor: '0', total_gross_minor: '5000' },
  ];
  const series = foldSeries(rows, buckets, 'week', SERIES_METRICS);
  const text = seriesCsv('2026-10-01', '2026-10-31', 'week', series, true, true);
  assert(text.startsWith('﻿"wiersz"'));
  const lines = text.slice(1).trim().split('\r\n').map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')));
  const header = lines[0];
  for (const s of series) {
    const mine = lines.filter((l) => l[1] === s.currency);
    const total = mine.find((l) => l[0] === 'razem')!;
    for (const m of SERIES_METRICS) {
      const i = header.indexOf(m);
      const sum = mine.filter((l) => l[0] === 'okres').reduce((a, l) => a + BigInt(l[i]), 0n);
      assert.equal(sum.toString(), total[i], s.currency + ' ' + m);
      assert.equal(total[i], s.totals[m], s.currency + ' ' + m + ' = JSON');
    }
  }
  const restricted = seriesCsv('2026-10-01', '2026-10-31', 'week', series, false, true);
  assert(!/_minor/.test(restricted) && /commercial_quantity/.test(restricted));
});

const line = (x: Partial<SkuPriceRow>): SkuPriceRow => ({
  sku: 'A',
  name: 'Kubek',
  currency: 'PLN',
  unit_price_minor: '1000',
  lines: 1,
  quantity: '1',
  gross_minor: '1000',
  net_minor: '813',
  returned_quantity: '0',
  returned_gross_minor: '0',
  returned_net_minor: '0',
  latest_at: '2026-10-01T10:00:00.000000Z',
  ...x,
});

test('per-SKU aggregation: quantity, value, returns negative, min/max/weighted average, price bands', () => {
  const stats = aggregateSkuStats([
    line({ unit_price_minor: '1000', quantity: '3', gross_minor: '3000', net_minor: '2439', lines: 2 }),
    line({ unit_price_minor: '1500', quantity: '1', gross_minor: '1500', net_minor: '1220', returned_quantity: '1', returned_gross_minor: '1500', returned_net_minor: '1220', name: 'Kubek nowy', latest_at: '2026-10-05T10:00:00.000000Z' }),
    line({ unit_price_minor: '60000', quantity: '1', gross_minor: '60000', net_minor: '48780' }),
    line({ sku: 'B', unit_price_minor: '333', quantity: '3', gross_minor: '1000', net_minor: '813' }),
    line({ sku: 'A', currency: 'EUR', unit_price_minor: '500', quantity: '2', gross_minor: '1000', net_minor: '813' }),
  ]);
  assert.deepEqual(stats.map((s) => [s.currency, s.sku]), [['EUR', 'A'], ['PLN', 'A'], ['PLN', 'B']]);
  const a = stats[1];
  assert.equal(a.name, 'Kubek nowy');
  assert.deepEqual([a.lines, a.quantity, a.returned_quantity, a.net_quantity], ['4', '5', '-1', '4']);
  assert.deepEqual([a.gross_minor, a.returned_gross_minor, a.gross_after_returns_minor, a.net_minor, a.returned_net_minor], ['64500', '-1500', '63000', '52439', '-1220']);
  assert.deepEqual([a.min_unit_price_minor, a.max_unit_price_minor, a.avg_unit_price_minor], ['1000', '60000', '12900']);
  assert.deepEqual(a.price_bands.map((b) => [b.from_minor, b.to_minor, b.quantity]), [
    ['0', '5000', '4'],
    ['5000', '10000', '0'],
    ['10000', '20000', '0'],
    ['20000', '50000', '0'],
    ['50000', null, '1'],
  ]);
  // Bands partition the quantity.
  for (const s of stats) assert.equal(s.price_bands.reduce((n, b) => n + BigInt(b.quantity), 0n).toString(), s.quantity);
  // Half-up rounding of the weighted average: 1000/3 = 333.33 → 333; 1000/6 → 167.
  assert.equal(stats[2].avg_unit_price_minor, '333');
  assert.equal(aggregateSkuStats([line({ quantity: '6', gross_minor: '1000' })])[0].avg_unit_price_minor, '167');
  // Custom edges; an edge equal to the price puts it into the upper band.
  const custom = aggregateSkuStats([line({ unit_price_minor: '1000' })], [1000n]);
  assert.deepEqual(custom[0].price_bands.map((b) => b.quantity), ['0', '1']);
  assert.throws(() => aggregateSkuStats([line({ quantity: '0' })]), /bez ilości/);
  assert.throws(() => aggregateSkuStats([line({ gross_minor: '1e3' })]), /dokładna liczba/);
});

test('SKU CSV: price columns only with value permission; formula-like cells neutralised', () => {
  const stats = aggregateSkuStats([line({ sku: '=HYPERLINK("x")', returned_quantity: '1', returned_gross_minor: '1000', returned_net_minor: '813' })]);
  const full = skuCsv(stats, [5000n], true, true);
  assert.match(full, /"band_0_5000_quantity","band_5000_up_quantity"/);
  assert.match(full, /"'=HYPERLINK\(""x""\)"/);
  assert.match(full, /"'-1000"/); // negative return value prefixed in spreadsheet-safe mode
  assert.match(skuCsv(stats, [5000n], true, false), /,"-1000",/);
  const limited = skuCsv(stats, [5000n], false, true);
  assert(!/_minor|band_/.test(limited));
});

test('personal data masking keeps no full local part, domain or surname', () => {
  assert.equal(maskEmail('jan.kowalski@gmail.com'), 'j***@g***.com');
  assert.equal(maskEmail('  Anna@firma.com.pl '), 'A***@f***.pl');
  assert.equal(maskEmail('x@localhost'), 'x***@l***');
  assert.equal(maskEmail('bez-malpy'), 'b***');
  assert.equal(maskEmail(''), '');
  assert.equal(maskName('Jan  Kowalski'), 'J. K.');
  assert.equal(maskName('łukasz żak'), 'Ł. Ż.');
  assert.equal(maskName(null), '');
  for (const v of ['jan.kowalski@gmail.com', 'Anna@firma.com.pl']) assert(!maskEmail(v).includes(v.split('@')[0].trim().slice(1)));
});

test('query validation: Polish 422 for bad dates, ranges, lists and unknown parameters', () => {
  const fail = (schema: any, input: unknown, pattern: RegExp) => {
    try {
      parseReportQuery(schema, input);
      assert.fail('expected refusal');
    } catch (e) {
      assert(e instanceof Problem);
      assert.equal(e.status, 422);
      assert.match(e.message, pattern);
    }
  };
  fail(periodQuery, { from: '2026-02-30', to: '2026-03-01' }, /Data od nie istnieje w kalendarzu/);
  fail(periodQuery, { from: '2026-03-02', to: '2026-03-01' }, /Zakres wymaga od 1 do 366 dni/);
  fail(periodQuery, { from: '2025-01-01', to: '2026-03-01' }, /366/);
  fail(periodQuery, { from: '2026-03-01', to: '2026-03-01', granularity: 'year' }, /Podział: day, week albo month/);
  fail(periodQuery, { from: '2026-03-01', to: '2026-03-01', statuses: 'cancelled' }, /Nieobsługiwana wartość: statusy/);
  fail(periodQuery, { from: '2026-03-01', to: '2026-03-01', sources: 'Manual;DROP' }, /Niepoprawna lista: źródła/);
  fail(periodQuery, { from: '2026-03-01', to: '2026-03-01', foo: '1' }, /Nieobsługiwany parametr raportu/);
  fail(productQuery, { from: '2026-03-01', to: '2026-03-01', price_edges: '500,100' }, /rosnące/);
  fail(employeeQuery, { from: '2026-03-01', to: '2026-03-01', currency: 'PLN' }, /Nieobsługiwany parametr/);
  fail(customerQuery, { to: '2026-03-01' }, /Podaj datę od/);
  const ok = parseReportQuery(periodQuery, { from: '2026-03-01', to: '2026-03-31', sources: 'manual,woocommerce,manual', statuses: 'paid,new' });
  assert.deepEqual([ok.granularity, ok.sources, ok.statuses], ['day', ['manual', 'woocommerce'], ['new', 'paid']]);
  assert.deepEqual(parseReportQuery(productQuery, { from: '2026-03-01', to: '2026-03-01', price_edges: '100,2000' }).price_edges, [100n, 2000n]);
});

test('routes refuse developer API keys before touching the database', async () => {
  const app = Fastify();
  app.decorateRequest('actor');
  app.decorateRequest('apiScopes');
  app.addHook('onRequest', async (req: any) => {
    req.actor = { tenantId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002', role: 'admin', apiKeyId: 'k' };
    req.apiScopes = ['orders:read', 'inventory:read', 'purchasing:read'];
  });
  app.setErrorHandler((err: any, _r, reply) => reply.code(err instanceof Problem ? err.status : 500).send({ detail: err.message }));
  registerReportAnalyticsRoutes(app, { readOnly: false });
  for (const url of ['/api/reports/sales/periods', '/api/reports/sales/periods/file', '/api/reports/products', '/api/reports/products/file', '/api/reports/customers', '/api/reports/employees']) {
    const r = await app.inject({ url: url + '?from=2026-10-01&to=2026-10-31' });
    assert.equal(r.statusCode, 403, url);
    assert.match(r.json().detail, /tylko w sesji użytkownika/);
  }
  await app.close();
});
