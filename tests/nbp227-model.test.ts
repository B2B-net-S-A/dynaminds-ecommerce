/** Pure 227 rules: tax point, choice of the NBP table A rate (Friday, weekend, holidays, a
 * business day without a table, no table), coverage of range reads, grosz rounding,
 * manual-entry validation and the document line. No IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, chooseRate, coverRange, midScaled, nbpManualInput, nbpRateLine, plMoney, plnAmounts, taxPointOf, toPlnMinor, warsawDay, type NbpPublication, type StoredRate,
} from '../server/nbp227-model';
import { parseNbp227Reply } from '../server/nbp227-fetch';
import { RECORDED_RANGE_20261009_20261022, SYNTHETIC_CHRISTMAS_20251219_20251231, SYNTHETIC_NOVEMBER_20251107_20251114, SYNTHETIC_NO_TABLE_WEDNESDAY_20260302_20260306 } from './nbp227-fixtures';

/** The stored row a tax point would read (latest before it), as nbp227.ts selects it. */
function pick(rows: StoredRate[], taxPoint: string) {
  const before = rows.filter(r => r.effective_date < taxPoint).sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1))[0] ?? null;
  return chooseRate(before, taxPoint, 'EUR');
}
const rateOf = (rows: StoredRate[], t: string) => { const c = pick(rows, t); assert('rate' in c, JSON.stringify(c)); return c.rate.effective_date + ' ' + c.rate.table_no + ' ' + c.rate.mid; };
const covered = (text: string, start: string, end: string, today: string) => coverRange(parseNbp227Reply(text, 'EUR', start, end), start, end, today);

test('tax point: sell date, or the issue date of an invoice issued before the delivery (art. 31a ust. 2)', () => {
  assert.deepEqual(taxPointOf({ sell_date: '2026-10-20', issue_date: '2026-10-23' }), { date: '2026-10-20', basis: 'sell_date' });
  assert.deepEqual(taxPointOf({ sell_date: '2026-10-23', issue_date: '2026-10-23' }), { date: '2026-10-23', basis: 'sell_date' });
  assert.deepEqual(taxPointOf({ sell_date: '2026-10-30', issue_date: '2026-10-23' }), { date: '2026-10-23', basis: 'issue_date' });
  assert.throws(() => taxPointOf({ sell_date: '2026-02-30', issue_date: '2026-10-23' }), /daty sprzedaży/);
});

test('recorded October range: Friday uses Thursday, weekend and Monday use Friday, never the tax point day itself', () => {
  const rows = covered(RECORDED_RANGE_20261009_20261022, '2026-10-09', '2026-10-22', '2026-10-23');
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map(r => r.covered_through), ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
  assert.equal(rateOf(rows, '2026-10-16'), '2026-10-15 201/A/NBP/2026 4.3691', 'Friday → Thursday');
  for (const t of ['2026-10-17', '2026-10-18', '2026-10-19']) assert.equal(rateOf(rows, t), '2026-10-16 202/A/NBP/2026 4.3661', t + ' → Friday');
  assert.equal(rateOf(rows, '2026-10-20'), '2026-10-19 203/A/NBP/2026 4.3702', 'Tuesday → Monday, not its own table');
  assert.equal(rateOf(rows, '2026-10-23'), '2026-10-22 206/A/NBP/2026 4.3685', 'today → yesterday');
  assert.equal(rateOf(rows, '2026-10-12'), '2026-10-09 197/A/NBP/2026 4.3775');
  const none = pick(rows, '2026-10-09');
  assert('refusal' in none && /Brak kursu NBP.*09\.10\.2026.*ręcznie/.test(none.refusal), 'no table before the window');
  const late = pick(rows, '2026-10-24');
  assert('refusal' in late && /nie jest potwierdzony jako ostatni przed 24\.10\.2026/.test(late.refusal), 'today (23.10) not read yet: no guess');
});

test('holidays and a business day without a table walk back to the last published table, not by calendar', () => {
  const xmas = covered(SYNTHETIC_CHRISTMAS_20251219_20251231, '2025-12-19', '2025-12-31', '2026-01-05');
  for (const t of ['2025-12-24', '2025-12-25', '2025-12-26', '2025-12-27', '2025-12-28', '2025-12-29']) assert.equal(rateOf(xmas, t), '2025-12-23 247/A/NBP/2025 4.2312', t);
  assert.equal(rateOf(xmas, '2025-12-23'), '2025-12-22 246/A/NBP/2025 4.2250');
  assert.equal(rateOf(xmas, '2026-01-01'), '2025-12-31 250/A/NBP/2025 4.2200', 'New Year: last table of the previous year');
  assert.equal(rateOf(xmas, '2025-12-30'), '2025-12-29 248/A/NBP/2025 4.2105');
  const nov = covered(SYNTHETIC_NOVEMBER_20251107_20251114, '2025-11-07', '2025-11-14', '2025-11-20');
  assert.equal(rateOf(nov, '2025-11-11'), '2025-11-10 217/A/NBP/2025 4.2510');
  assert.equal(rateOf(nov, '2025-11-12'), '2025-11-10 217/A/NBP/2025 4.2510', 'day after the holiday → the table before it');
  assert.equal(rateOf(nov, '2025-11-10'), '2025-11-07 216/A/NBP/2025 4.2480', 'Monday → Friday');
  const gap = covered(SYNTHETIC_NO_TABLE_WEDNESDAY_20260302_20260306, '2026-03-02', '2026-03-06', '2026-03-10');
  assert.equal(rateOf(gap, '2026-03-05'), '2026-03-03 043/A/NBP/2026 4.3010', 'Thursday after a Wednesday without a table → Tuesday');
  assert.equal(rateOf(gap, '2026-03-04'), '2026-03-03 043/A/NBP/2026 4.3010');
});

test('coverage stops at yesterday in Warsaw; an unproven gap or a later table refuses instead of guessing', () => {
  const pubs: NbpPublication[] = [{ effective_date: '2026-10-21', table_no: '205/A/NBP/2026', mid: '4.3641' }, { effective_date: '2026-10-22', table_no: '206/A/NBP/2026', mid: '4.3685' }];
  assert.deepEqual(coverRange(pubs, '2026-10-20', '2026-10-23', '2026-10-23').map(r => r.covered_through), ['2026-10-21', '2026-10-22']);
  const todayPublished = [...pubs, { effective_date: '2026-10-23', table_no: '207/A/NBP/2026', mid: '4.3600' }];
  assert.equal(coverRange(todayPublished, '2026-10-20', '2026-10-23', '2026-10-23').at(-1)!.covered_through, '2026-10-23');
  assert.throws(() => coverRange(pubs, '2026-10-20', '2026-10-24', '2026-10-23'), /zakres/, 'future end');
  assert.throws(() => coverRange(pubs, '2026-09-01', '2026-10-23', '2026-10-23'), /zakres/, 'more than 31 days');
  assert.throws(() => coverRange([pubs[1]!, pubs[0]!], '2026-10-20', '2026-10-23', '2026-10-23'), /kolejności/);
  assert.throws(() => coverRange(pubs, '2026-10-22', '2026-10-23', '2026-10-23'), /spoza zakresu/);
  const manual: StoredRate = { effective_date: '2026-10-16', table_no: '202/A/NBP/2026', mid: '4.3661', covered_through: '2026-10-16', source: 'manual' };
  const short = chooseRate(manual, '2026-10-19', 'EUR');
  assert('refusal' in short && /16\.10\.2026 nie jest potwierdzony.*do 18\.10\.2026/.test(short.refusal));
  const declared = chooseRate({ ...manual, covered_through: '2026-10-18' }, '2026-10-19', 'EUR');
  assert('rate' in declared && declared.rate.source === 'manual');
  assert.throws(() => chooseRate({ ...manual, effective_date: '2026-10-19' }, '2026-10-19', 'EUR'), /sprzed daty/);
});

test('PLN conversion rounds half up to a grosz per VAT rate; totals are the sums', () => {
  const m = midScaled('4.3685');
  assert.equal(m, 43685n);
  assert.equal(toPlnMinor(2300n, m), 10048n, '23.00 EUR × 4.3685 = 100.4755 → 100.48');
  assert.equal(toPlnMinor(1n, m), 4n);
  assert.equal(toPlnMinor(2n, m), 9n, '0.087370 → 0.09');
  assert.equal(toPlnMinor(1n, midScaled('4.5')), 5n, 'exactly half → up');
  assert.equal(toPlnMinor(3n, midScaled('4.5')), 14n);
  assert.equal(toPlnMinor(0n, m), 0n);
  assert.throws(() => toPlnMinor(-1n, m), /nieujemne/);
  const p = plnAmounts([{ vat_rate: 23, net_minor: '10000', vat_minor: '2300', gross_minor: '12300' }, { vat_rate: 8, net_minor: '4630', vat_minor: '370', gross_minor: '5000' }], '4.3685');
  assert.deepEqual(p.rows, [
    { vat_rate: 23, net_minor: '10000', vat_minor: '2300', gross_minor: '12300', net_pln_minor: '43685', vat_pln_minor: '10048', gross_pln_minor: '53733' },
    { vat_rate: 8, net_minor: '4630', vat_minor: '370', gross_minor: '5000', net_pln_minor: '20226', vat_pln_minor: '1616', gross_pln_minor: '21842' }]);
  assert.deepEqual(p.totals, { net_minor: '14630', vat_minor: '2670', gross_minor: '17300', net_pln_minor: '63911', vat_pln_minor: '11664', gross_pln_minor: '75575' });
  assert.equal(toPlnMinor(17300n, m), 75575n);
  assert.throws(() => plnAmounts([{ vat_rate: 23, net_minor: '100', vat_minor: '23', gross_minor: '124' }], '4.3685'), /nie sumują/);
  assert.throws(() => plnAmounts([{ vat_rate: 7, net_minor: '100', vat_minor: '7', gross_minor: '107' }], '4.3685'), /stawek/);
  assert.throws(() => plnAmounts([], '4.3685'), /kwot VAT/);
});

test('mid rate precision, manual input and the document line', () => {
  for (const bad of ['4.36855', '-4.3', '0', '0.0000', '4,3685', '', '1e3']) assert.throws(() => midScaled(bad), /Kurs średni/, bad);
  assert.equal(midScaled('0.0001'), 1n);
  const ok = { currency: 'EUR', effective_date: '2026-10-16', table_no: '202/A/NBP/2026', mid: '4.3661', covered_through: '2026-10-18' };
  assert.deepEqual(nbpManualInput.parse(ok), ok);
  for (const [patch, pattern] of [[{ table_no: '202/A/NBP/2025' }, /Rok w numerze/], [{ covered_through: '2026-10-15' }, /31 dni/], [{ covered_through: '2026-11-17' }, /31 dni/],
    [{ mid: '4.36615' }, /4 miejscami/], [{ currency: 'USD' }, /EUR/], [{ table_no: '202/B/NBP/2026' }, /123\/A\/NBP/], [{ effective_date: '2026-02-30' }, /Niepoprawna data/]] as const) {
    const r = nbpManualInput.safeParse({ ...ok, ...patch });
    assert(!r.success && pattern.test(r.error.issues.map(i => i.message).join(' ')), JSON.stringify(patch));
  }
  assert.equal(nbpRateLine({ currency: 'EUR', rate_date: '2026-10-22', table_no: '206/A/NBP/2026', mid: '4.3685', vat_pln_minor: '1234567' }),
    'Kurs NBP z dnia 22.10.2026, tabela 206/A/NBP/2026, 1 EUR = 4,3685 PLN; VAT w PLN: 12 345,67 zł');
  assert.equal(plMoney('5'), '0,05');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(warsawDay(new Date('2026-10-22T22:30:00Z')), '2026-10-23', 'after midnight in Warsaw');
  assert.equal(warsawDay(new Date('2026-10-22T21:30:00Z')), '2026-10-22');
});
