/** JPK_V7 with cash-register sales (233): one RO row per daily report (PTU letter → K_ by the rate the
 * printer had), the invoice issued to a receipt marked FP and left out of SprzedazCtrl and the
 * declaration (it is already in RO), refusals for a daily report "niezgodny", receipts without a daily
 * report and a letter with two rates. Pure — no DB. Golden: tests/jpk-golden/v7m-2026-10-receipts.xml. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderJpkV7, v7Row, v7Totals } from '../server/jpk-v7';
import { JpkError, jpkWholeZloty } from '../server/jpk-model';
import { checkedReceiptSales, type JpkDailyReport, type JpkReceiptSales } from '../server/jpk-receipts';
import { jpkXsdValidator } from '../server/jpk-xsd';
import { xsdCollector } from './mf-xsd-collect';
import { JPK_GENERATED_AT, taxpayer, fvA, fvDec, dailyReports, fvFp, jpkValues, jpkRecords, minorOf } from './jpk-fixtures';

const goldenPath = fileURLToPath(new URL('./jpk-golden/v7m-2026-10-receipts.xml', import.meta.url));
const { keep, conformAll } = xsdCollector('JPK_V7 z RO/FP');
const v7 = (extra: Partial<Parameters<typeof renderJpkV7>[0]> = {}) => {
  const r = renderJpkV7({ variant: 'M', year: 2026, month: 10, taxpayer, generated_at: JPK_GENERATED_AT, documents: [fvA().jpk, fvFp()], receipt_sales: dailyReports(), surplus_zloty: 0n, ...extra });
  keep('JPK_V7M 10/2026 RO+FP', r.xml); return r;
};
const VAT = ['K_16', 'K_18', 'K_20'];
const K = ['K_10', 'K_13', 'K_15', 'K_16', 'K_17', 'K_18', 'K_19', 'K_20'];
const money = (v: bigint) => (v < 0n ? '-' : '') + (v < 0n ? -v : v) / 100n + '.' + String((v < 0n ? -v : v) % 100n).padStart(2, '0');
const report = (over: Partial<JpkDailyReport>): JpkDailyReport => ({ ...dailyReports().reports[0]!, ...over });

test('XSD JPK_V7M: v7m-2026-10-receipts.xml', async () => {
  const xsd = jpkXsdValidator('JPK_V7M');
  assert.equal(xsd.available, true, xsd.reason);
  assert.deepEqual(await xsd.validate(readFileSync(goldenPath, 'utf8')), { status: 'valid' });
});

test('JPK_V7M October with 2 daily reports and an FP invoice: RO rows per report, FP marker, golden bytes', () => {
  const r = v7();
  if (process.env.JPK_GOLDEN_UPDATE === '1') writeFileSync(goldenPath, r.xml);
  assert.equal(r.xml, readFileSync(goldenPath, 'utf8'), 'golden v7m-2026-10-receipts');
  const rows = jpkRecords(r.xml, 'SprzedazWiersz');
  assert.deepEqual(rows.map(x => [x.LpSprzedazy, x.DowodSprzedazy, x.DataWystawienia, x.TypDokumentu ?? '']), [
    ['1', 'FV/LOK/2026/000042', '2026-10-20', ''],
    ['2', 'RO/DYN23300001/0001', '2026-10-24', 'RO'],
    ['3', 'RO/DYN23300001/0002', '2026-10-25', 'RO'],
    ['4', 'FV-S/2026/000001', '2026-10-26', 'FP']]);
  const [, ro1, ro2, fp] = rows as Record<string, string>[];
  // RO: buyer "brak", no sale date, DI (a sales document other than an invoice), no GTU/MPP; K_ by PTU letter.
  assert.deepEqual([ro1!.NrKontrahenta, ro1!.NazwaKontrahenta, ro1!.DataSprzedazy, ro1!.DI, ro1!.BFK, ro1!.MPP], ['brak', 'brak', undefined, '1', undefined, undefined]);
  // A 23% → K_19/K_20, B 8% → K_17/K_18, E zw → K_10 (net = gross − VAT of the PTU total).
  assert.deepEqual([ro1!.K_19, ro1!.K_20, ro1!.K_17, ro1!.K_18, ro1!.K_10, ro1!.K_13], ['200.00', '46.00', '100.00', '8.00', '50.00', undefined]);
  // C 5% → K_15/K_16, D 0% → K_13.
  assert.deepEqual([ro2!.K_19, ro2!.K_20, ro2!.K_15, ro2!.K_16, ro2!.K_13, ro2!.K_10], ['100.00', '23.00', '20.00', '1.00', '10.00', undefined]);
  // FP: the invoice keeps its own amounts and BFK in the ewidencja.
  assert.deepEqual([fp!.TypDokumentu, fp!.BFK, fp!.NrKontrahenta, fp!.DataSprzedazy, fp!.K_19, fp!.K_20], ['FP', '1', 'brak', '2026-10-24', '37.65', '8.66']);
  // Element order: the KSeF choice, then TypDokumentu, then the K_ fields.
  assert.match(r.xml, /<DataWystawienia>2026-10-24<\/DataWystawienia><DI>1<\/DI><TypDokumentu>RO<\/TypDokumentu><K_10>/);
  assert.match(r.xml, /<DataSprzedazy>2026-10-24<\/DataSprzedazy><BFK>1<\/BFK><TypDokumentu>FP<\/TypDokumentu><K_13>/);
  assert.equal(r.rows, 4);
});

test('declaration and SprzedazCtrl = RO + invoices − FP; the FP row is counted in LiczbaWierszySprzedazy only', () => {
  const r = v7(), v = jpkValues(r.xml), rows = jpkRecords(r.xml, 'SprzedazWiersz');
  const counted = rows.filter(x => x.TypDokumentu !== 'FP'), fp = rows.filter(x => x.TypDokumentu === 'FP');
  assert.equal(fp.length, 1);
  const sum = (set: Record<string, string>[], f: string) => set.reduce((n, x) => n + minorOf(x[f]), 0n);
  for (const f of K) {
    const all = sum(rows, f), expected = all - sum(fp, f);
    assert.equal(expected, sum(counted, f), f);
    const p = v['P_' + f.slice(2)];
    if (jpkWholeZloty(expected) === 0n) assert.equal(p, undefined, f); else assert.deepEqual(p, [jpkWholeZloty(expected).toString()], f + ' = RO + invoices − FP');
  }
  const vat = VAT.reduce((n, f) => n + sum(counted, f), 0n);
  assert.deepEqual([v.LiczbaWierszySprzedazy, v.PodatekNalezny], [['4'], [money(vat)]]);
  assert.equal(vat, 9136n, 'RO 54,00 + 24,00 + FV 13,36; the FP 13,36 left out');
  assert.equal(r.output_vat_minor, vat);
  const P = (n: number) => BigInt(v['P_' + n]?.[0] ?? '0');
  assert.deepEqual([P(10), P(13), P(15), P(16), P(17), P(18), P(19), P(20)], [50n, 20n, 40n, 2n, 146n, 12n, 338n, 78n]);
  assert.equal(P(37), [10, 11, 13, 15, 17, 19, 21, 22, 31].reduce((n, i) => n + P(i), 0n));
  assert.deepEqual([P(37), P(38), P(51)], [594n, 92n, 92n]);
  // Totals of the rows exclude FP; the same invoice without the marker would be counted twice.
  const plain = v7Row(fvA().jpk)!, marked = v7Row(fvFp())!;
  assert.deepEqual([plain.document_type, marked.document_type], [undefined, 'FP']);
  assert.equal(v7Totals([plain, marked]).K_20, plain.k.K_20);
  // Same nets with and without the FP invoice in the file.
  const without = jpkValues(v7({ documents: [fvA().jpk] }).xml);
  assert.deepEqual([without.P_37, without.P_38, without.PodatekNalezny, without.LiczbaWierszySprzedazy], [v.P_37, v.P_38, v.PodatekNalezny, ['3']]);
});

test('a PTU letter follows the rate the register had (A = 8%); a report of another month is not in the file', () => {
  const sales: JpkReceiptSales = { unreported: [], reports: [
    report({ report_number: '0007', totals: [{ ptu: 'A', value: '8', conflict: false, gross_minor: 10800n, vat_minor: 800n }] }),
    report({ id: 'x', report_number: '0099', fiscal_date: '2026-11-02' })] };
  const rows = jpkRecords(v7({ documents: [], receipt_sales: sales }).xml, 'SprzedazWiersz');
  assert.deepEqual(rows.map(x => [x.DowodSprzedazy, x.K_17, x.K_18, x.K_19]), [['RO/DYN23300001/0007', '100.00', '8.00', undefined]]);
  // A report with no sales (0 receipts, no totals) has no row.
  assert.equal(v7({ documents: [], receipt_sales: { unreported: [], reports: [report({ printer_receipts: 0, app_receipts: 0, totals: [] })] } }).rows, 0);
});

test('refusals (409 with the list): daily report "niezgodny", printed receipts without a daily report, a letter with two rates, no rate', () => {
  const refuse = (sales: JpkReceiptSales, pattern: RegExp) => assert.throws(() => v7({ receipt_sales: sales }), (e: unknown) => {
    assert.ok(e instanceof JpkError); assert.equal(e.status, 409);
    assert.match(e.documents.map(d => d.number + ': ' + d.reason).join('\n'), pattern); return true;
  });
  refuse({ unreported: [], reports: [report({ matches: false, app_receipts: 2 })] }, /Raport dobowy 0001 z 2026-10-24, kasa DYN23300001: Raport niezgodny z paragonami aplikacji \(kasa: 3 paragonów, aplikacja: 2\)/);
  refuse({ reports: [], unreported: [{ printer_unique_number: 'DYN23300001', fiscal_date: '2026-10-27', receipts: 2 }] }, /Paragony z 2026-10-27, kasa DYN23300001: 2 wydrukowanych paragonów bez raportu dobowego/);
  refuse({ unreported: [], reports: [report({ totals: [{ ptu: 'A', value: null, conflict: true, gross_minor: 100n, vat_minor: 19n }] })] }, /Litera PTU A miała tego dnia dwie różne stawki/);
  refuse({ unreported: [], reports: [report({ totals: [{ ptu: 'F', value: null, conflict: false, gross_minor: 100n, vat_minor: 0n }] })] }, /Litera PTU F nie ma stawki/);
  refuse({ unreported: [], reports: [report({ totals: [{ ptu: 'E', value: 'zw', conflict: false, gross_minor: 100n, vat_minor: 5n }] })] }, /Niepoprawne sumy PTU E/);
  // Outside the file's months nothing is refused.
  assert.deepEqual(checkedReceiptSales({ unreported: [{ printer_unique_number: 'DYN23300001', fiscal_date: '2026-11-03', receipts: 1 }], reports: [report({ matches: false, fiscal_date: '2026-09-30' })] }, ['2026-10']), []);
});

test('JPK_V7K December: RO of December in the ewidencja, the VAT-7K declaration covers the RO of the whole quarter minus FP', () => {
  const dec = report({ id: 'd', fiscal_date: '2026-12-05', report_number: '0040', totals: [{ ptu: 'A', value: '23', conflict: false, gross_minor: 1230n, vat_minor: 230n }] });
  const sales: JpkReceiptSales = { unreported: [], reports: [...dailyReports().reports, dec] };
  const r = renderJpkV7({ variant: 'K', year: 2026, month: 12, taxpayer, generated_at: JPK_GENERATED_AT, documents: [fvDec()], quarter_documents: [fvA().jpk, fvFp(), fvDec()],
    receipt_sales: sales, surplus_zloty: 0n });
  keep('JPK_V7K 12/2026 RO kwartału', r.xml);
  const rows = jpkRecords(r.xml, 'SprzedazWiersz'), v = jpkValues(r.xml);
  assert.deepEqual(rows.map(x => x.DowodSprzedazy), ['FV/LOK/2026/000060', 'RO/DYN23300001/0040'], 'date order: FV sold 03.12, RO of 05.12');
  // K_20: RO Oct 46,00 + 23,00, RO Dec 2,30, FV A 8,66, FV Dec 8,66; FP 8,66 left out.
  assert.deepEqual(v.P_20, [jpkWholeZloty(4600n + 2300n + 230n + 866n + 866n).toString()]);
  // November of V7K (no declaration) with an unsettled October report: the October report is not in this month.
  assert.equal(renderJpkV7({ variant: 'K', year: 2026, month: 11, taxpayer, generated_at: JPK_GENERATED_AT, documents: [],
    receipt_sales: { unreported: [], reports: [report({ matches: false })] }, surplus_zloty: 0n }).rows, 0);
  // The December declaration reads the whole quarter: an unsettled October report refuses it.
  assert.throws(() => renderJpkV7({ variant: 'K', year: 2026, month: 12, taxpayer, generated_at: JPK_GENERATED_AT, documents: [fvDec()], quarter_documents: [fvDec()],
    receipt_sales: { unreported: [], reports: [report({ matches: false })] }, surplus_zloty: 0n }), (e: unknown) => e instanceof JpkError && e.status === 409);
});

conformAll();
