/** FA(3) XML of every document type the app issues: golden bytes per type, edge
 * cases of the 226 tax snapshot and 227 NBP rate, and refusal paths. Pure — no DB.
 * Every rendered file is validated against the vendored official FA(3) schema (last test).
 * Golden files: tests/fa3-golden/*.xml (FA3_GOLDEN_UPDATE=1 rewrites them). */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderFa3Document, fa3Money, Fa3DocumentError, fa3UnsupportedReason, fa3GenerationTimeOf } from '../server/fa3-render';
import { localInvoiceFa3Model, consumerCreditFa3Model, b2bCorrectionFa3Model, type Fa3DocumentRate } from '../server/fa3-adapters';
import { xsdCollector } from './mf-xsd-collect';
import { GENERATED_AT, consumerInvoice, taxSnapshot, untaxed, consumerCredit, b2bPair, xmlValues } from './fa3-fixtures';

const { keep, conformAll } = xsdCollector('FA(3)');
let rendered = 0;
/** renderFa3Document that keeps every file it renders for the schema test. */
const render = (...args: Parameters<typeof renderFa3Document>) => {
  const r = renderFa3Document(...args); keep(`${r.number} #${++rendered}`, r.xml); return r;
};
const goldenDir = fileURLToPath(new URL('./fa3-golden/', import.meta.url));
function golden(t: TestContext, name: string, xml: string) {
  const path = goldenDir + name + '.xml';
  if (process.env.FA3_GOLDEN_UPDATE === '1') { mkdirSync(goldenDir, { recursive: true }); writeFileSync(path, xml); }
  assert.equal(xml, readFileSync(path, 'utf8'), 'golden ' + name);
  t.diagnostic('golden ' + name + ' — schema check in the last test');
}
const refused = (fn: () => unknown, status: number, pattern: RegExp) =>
  assert.throws(fn, (e: unknown) => { assert.ok(e instanceof Fa3DocumentError, String(e)); assert.equal(e.status, status); assert.match(e.message, pattern); return true; });

test('consumer FV without 226 snapshot: BrakID buyer, four rate buckets, rounding line without price fields, golden bytes', t => {
  const doc = consumerInvoice(), before = structuredClone(doc);
  const r = render(localInvoiceFa3Model(doc, null, null), GENERATED_AT), v = xmlValues(r.xml);
  golden(t, 'fv-consumer', r.xml);
  assert.deepEqual(doc, before, 'source not mutated');
  assert.deepEqual(v.BrakID, ['1']); assert.deepEqual(v.NIP, ['5260250274']); assert.deepEqual(v.Nazwa, ['Sklep Testowy Sp. z o.o.', 'Jan Kowalski']);
  assert.deepEqual([v.JST, v.GV], [['2'], ['2']]); assert.deepEqual(v.RodzajFaktury, ['VAT']); assert.deepEqual(v.KodWaluty, ['PLN']);
  assert.deepEqual([v.P_1, v.P_2, v.P_6], [['2026-10-20'], ['FV/LOK/2026/000042'], ['2026-10-18']]);
  assert.deepEqual([v.P_13_1, v.P_14_1, v.P_13_2, v.P_14_2, v.P_13_3, v.P_14_3, v.P_13_6_1], [['37.65'], ['8.66'], ['46.30'], ['3.70'], ['20.00'], ['1.00'], ['10.00']]);
  assert.deepEqual(v.P_15, ['127.31']); assert.deepEqual(v.P_12, ['23', '8', '5', '0 KR', '23']);
  assert.deepEqual(v.P_9B, ['54.00', '7.00', '10.00', '12.30'], 'rounding line (2 × 17.00 + 0.01) has no unit price');
  assert.deepEqual(v.P_10, ['4.00']); assert.deepEqual(v.P_11A, ['34.01', '50.00', '21.00', '10.00', '12.30']);
  assert.deepEqual([v.P_18, v.P_18A, v.P_19N], [['2'], ['2'], ['1']]); assert.deepEqual(v.Termin, ['2026-10-27']);
  assert.deepEqual(v.StopkaFaktury, ['Dziękujemy za zakupy', 'Przelew na rachunek sklepu']);
  assert.equal(v.P_7[0], 'Kubek & <spodek>'); assert.equal(v.StanPrzed, undefined); assert.equal(v.KursWaluty, undefined);
  assert.equal(r.xml, render(localInvoiceFa3Model(structuredClone(doc), null, null), GENERATED_AT).xml, 'deterministic');
});

test('consumer FV with 226 snapshot: ZW with P_19A, GTU, annex 15, MPP flag and the snapshot rate codes', t => {
  const doc = consumerInvoice(); untaxed(doc, 2);
  const tax = taxSnapshot(doc);
  Object.assign(tax.lines[2], { category: 'zw', rate: null, rate_code: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'art. 43 ust. 1 pkt 18 ustawy o VAT' });
  Object.assign(tax.lines[0], { gtu: 'GTU_06', annex15: true }); tax.mpp_required = true;
  const r = render(localInvoiceFa3Model(doc, tax, null), GENERATED_AT), v = xmlValues(r.xml);
  golden(t, 'fv-consumer-tax226', r.xml);
  assert.deepEqual(v.P_12, ['23', '8', 'zw', '0 KR', '23']); assert.deepEqual(v.P_13_7, ['21.00']); assert.equal(v.P_13_3, undefined);
  assert.deepEqual([v.P_19, v.P_19A, v.P_19N], [['1'], ['art. 43 ust. 1 pkt 18 ustawy o VAT'], undefined]);
  assert.deepEqual(v.GTU, ['GTU_06']); assert.deepEqual(v.P_12_Zal_15, ['1']); assert.deepEqual(v.P_18A, ['1']);
  assert.deepEqual(v.P_15, ['127.31']);
});

test('NP I, NP II and OO lines map to P_13_8, P_13_9 and P_13_10; NP II and OO set P_18 (reverse charge)', () => {
  for (const [code, field, p18] of [['np I', 'P_13_8', '2'], ['np II', 'P_13_9', '1'], ['oo', 'P_13_10', '1']] as const) {
    const doc = consumerInvoice(); untaxed(doc, 1);
    const tax = taxSnapshot(doc); Object.assign(tax.lines[1], { category: code === 'oo' ? 'oo' : 'np', rate: null, rate_code: code });
    const v = xmlValues(render(localInvoiceFa3Model(doc, tax, null), GENERATED_AT).xml);
    assert.deepEqual(v[field], ['50.00'], code); assert.equal(v.P_12[1], code); assert.deepEqual(v.P_18, [p18], code);
    assert.equal(v.P_14_2, undefined); assert.deepEqual(v.P_19N, ['1']);
  }
});

test('OSS line: P_12_XII with the destination rate and P_13_5/P_14_5 instead of P_12', () => {
  const doc = consumerInvoice(), tax = taxSnapshot(doc);
  Object.assign(tax.lines[0], { rate: '19.00', rate_code: 'oss' });
  const v = xmlValues(render(localInvoiceFa3Model(doc, tax, null), GENERATED_AT).xml);
  assert.deepEqual([v.P_12_XII, v.P_13_5, v.P_14_5], [['19.00'], ['27.65'], ['6.36']]); assert.deepEqual(v.P_12, ['8', '5', '0 KR', '23']);
});

test('foreign currency FV: KodWaluty, KursWaluty on every line and P_14_xW in PLN from the 227 rate record', t => {
  const doc = consumerInvoice(); doc.data.currency = 'EUR';
  const rate: Fa3DocumentRate = { currency: 'EUR', mid: '4.2735', vat: [
    { vat_rate: 0, net_minor: 1000n, vat_minor: 0n, vat_pln_minor: 0n }, { vat_rate: 5, net_minor: 2000n, vat_minor: 100n, vat_pln_minor: 427n },
    { vat_rate: 8, net_minor: 4630n, vat_minor: 370n, vat_pln_minor: 1581n }, { vat_rate: 23, net_minor: 3765n, vat_minor: 866n, vat_pln_minor: 3701n }] };
  const r = render(localInvoiceFa3Model(doc, null, rate), GENERATED_AT), v = xmlValues(r.xml);
  golden(t, 'fv-consumer-eur', r.xml);
  assert.deepEqual(v.KodWaluty, ['EUR']); assert.deepEqual(v.KursWaluty, Array(5).fill('4.2735'));
  assert.deepEqual([v.P_14_1W, v.P_14_2W, v.P_14_3W], [['37.01'], ['15.81'], ['4.27']]); assert.deepEqual(v.P_14_1, ['8.66']);
  refused(() => localInvoiceFa3Model(doc, null, null), 409, /walucie EUR wymaga zapisanego kursu NBP/);
  refused(() => localInvoiceFa3Model(doc, null, { ...rate, currency: 'USD' }), 422, /innej waluty/);
  refused(() => localInvoiceFa3Model(doc, null, { ...rate, vat: rate.vat.filter(x => x.vat_rate !== 8) }), 422, /stawki 8/);
});

test('consumer correction 188: KOR, DaneFaKorygowanej without KSeF, StanPrzed/StanPo rows, multi-rate negative differences', t => {
  const credit = consumerCredit();
  const r = render(consumerCreditFa3Model(credit, null), GENERATED_AT.replace('20T', '22T')), v = xmlValues(r.xml);
  golden(t, 'kor-consumer-188', r.xml);
  assert.deepEqual(v.RodzajFaktury, ['KOR']); assert.deepEqual(v.TypKorekty, ['2']); assert.deepEqual(v.PrzyczynaKorekty, ['Zwrot towaru przez konsumenta']);
  assert.deepEqual([v.DataWystFaKorygowanej, v.NrFaKorygowanej, v.NrKSeFN, v.NrKSeF], [['2026-10-20'], ['FV/LOK/2026/000042'], ['1'], undefined]);
  assert.deepEqual(v.BrakID, ['1']); assert.deepEqual(v.P_2, ['KOR/LOK/2026/000007']); assert.deepEqual(v.P_1, ['2026-10-22']);
  // Three affected positions: each as a before row (StanPrzed=1) followed by its after row.
  assert.deepEqual(v.P_7, ['Kubek & <spodek>', 'Kubek & <spodek>', 'Książka', 'Książka', 'Dostawa', 'Dostawa']);
  assert.deepEqual(v.P_8B, ['2', '1', '1', '0', '1', '1']); assert.deepEqual(v.P_11A, ['34.01', '17.00', '50.00', '0.00', '12.30', '0.00']);
  assert.deepEqual(v.StanPrzed, ['1', '1', '1']); assert.equal(v.P_9B, undefined);
  assert.deepEqual([v.P_13_1, v.P_14_1, v.P_13_2, v.P_14_2], [['-23.83'], ['-5.48'], ['-46.30'], ['-3.70']]);
  assert.deepEqual(v.P_15, ['-79.31']); assert.equal(v.P_13_3, undefined, 'unaffected rate has no bucket'); assert.equal(v.Platnosc, undefined);
});

test('229 KSeF number of the corrected FV: NrKSeF=1 with NrKSeFFaKorygowanej instead of NrKSeFN, for 188 and B2B 160', () => {
  const number = '5260250274-20261020-0123456789AB-3F';
  const v = xmlValues(render(consumerCreditFa3Model(consumerCredit(), null, number), GENERATED_AT.replace('20T', '22T')).xml);
  assert.deepEqual([v.NrKSeF, v.NrKSeFFaKorygowanej, v.NrKSeFN, v.NrFaKorygowanej], [['1'], [number], undefined, ['FV/LOK/2026/000042']]);
  const { original, credit } = b2bPair();
  const b = xmlValues(render(b2bCorrectionFa3Model(credit, original, number), '2026-10-21T12:00:00.000000Z').xml);
  assert.deepEqual([b.NrKSeF, b.NrKSeFFaKorygowanej, b.NrKSeFN], [['1'], [number], undefined]);
  // Without a stored number the KOR keeps NrKSeFN (the golden files above).
  assert.deepEqual(xmlValues(render(b2bCorrectionFa3Model(credit, original), '2026-10-21T12:00:00.000000Z').xml).NrKSeFN, ['1']);
});

test('consumer correction 206/207 (consumer_return_credit) uses the same mapping; 226 facts of the original FV reach the rows', () => {
  const credit = consumerCredit() as any; credit.mode = 'consumer_return_credit'; credit.data.schema = 'consumer-return-credit/v2';
  const tax = taxSnapshot(credit.data.original_document); Object.assign(tax.lines[1], { gtu: 'GTU_12' });
  const v = xmlValues(render(consumerCreditFa3Model(credit, tax), '2026-10-22T08:00:00Z').xml);
  assert.deepEqual(v.RodzajFaktury, ['KOR']); assert.deepEqual(v.GTU, ['GTU_12', 'GTU_12']); assert.deepEqual(v.P_15, ['-79.31']);
});

test('correction of a ZW line keeps the exemption basis; zero-value correction has no rows and P_15 0.00', () => {
  const original = consumerInvoice(); untaxed(original, 1);
  const credit = consumerCredit(original), tax = taxSnapshot(original);
  Object.assign(tax.lines[1], { category: 'zw', rate: null, rate_code: 'zw', exemption_basis_kind: 'P_19B', exemption_basis: 'art. 113 ust. 1' });
  assert.deepEqual(credit.data.calculation.rows[1].delta, { quantity: '-1', gross_minor: '-5000', net_minor: '-5000', vat_minor: '0' }, 'ZW row differs by net only');
  const v = xmlValues(render(consumerCreditFa3Model(credit, tax), '2026-10-22T08:00:00Z').xml);
  assert.deepEqual([v.P_13_7, v.P_19B], [['-50.00'], ['art. 113 ust. 1']]); assert.deepEqual(v.P_12, ['23', '23', 'zw', 'zw', '23', '23']);
  const zero = consumerCredit(); for (const r of zero.data.calculation.rows) Object.assign(r, { affected: false, after: r.before, delta: { quantity: '0', gross_minor: '0', net_minor: '0', vat_minor: '0' } });
  zero.data.calculation.totals.delta = { gross_minor: '0', net_minor: '0', vat_minor: '0' };
  const z = xmlValues(render(consumerCreditFa3Model(zero, null), '2026-10-22T08:00:00Z').xml);
  assert.deepEqual([z.P_15, z.FaWiersz, z.RodzajFaktury], [['0.00'], undefined, ['KOR']]);
});

test('B2B correction 160: NIP buyer, UU_ID of the original line, 0 KR basis note, before/after rows, golden bytes', t => {
  const { original, credit } = b2bPair();
  const r = render(b2bCorrectionFa3Model(credit, original), '2026-10-21T12:00:00.000000Z'), v = xmlValues(r.xml);
  golden(t, 'kor-b2b-160', r.xml);
  assert.deepEqual(v.NIP, ['8567346215', '5260250274']); assert.equal(v.BrakID, undefined);
  assert.deepEqual([v.NrFaKorygowanej, v.DataWystFaKorygowanej], [['FV-B2B/HURT/2026/000003'], ['2026-10-10']]);
  assert.deepEqual(v.UU_ID, ['00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000042']);
  assert.deepEqual([v.P_13_1, v.P_14_1, v.P_13_6_1, v.P_15], [['-300.00'], ['-69.00'], ['-100.00'], ['-469.00']]);
  assert.deepEqual([v.NrWiersza, v.Wartosc], [['4'], ['art. 83 ust. 1 pkt 1 ustawy o VAT']]);
  assert.deepEqual(v.P_8B, ['10', '7', '2', '1']); assert.deepEqual(v.StanPrzed, ['1', '1']);
});

test('refusals: mixed exemption bases, VAT on an untaxed line, snapshot mismatch, long reason, foreign correction, wrong original, bad NIP', () => {
  const doc = consumerInvoice(); untaxed(doc, 1); untaxed(doc, 2);
  const tax = taxSnapshot(doc);
  Object.assign(tax.lines[1], { category: 'zw', rate: null, rate_code: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'podstawa A' });
  Object.assign(tax.lines[2], { category: 'zw', rate: null, rate_code: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'podstawa B' });
  refused(() => localInvoiceFa3Model(doc, tax, null), 409, /różne podstawy zwolnienia/);
  const taxed = consumerInvoice(), zw = taxSnapshot(taxed);
  Object.assign(zw.lines[1], { category: 'zw', rate: null, rate_code: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'x' });
  refused(() => localInvoiceFa3Model(taxed, zw, null), 422, /naliczony VAT/);
  refused(() => localInvoiceFa3Model(taxed, { ...zw, lines: zw.lines.slice(1) }, null), 422, /nie odpowiada pozycjom/);
  const wrongRate = taxSnapshot(taxed); wrongRate.lines[0].rate = '8.00';
  refused(() => localInvoiceFa3Model(taxed, wrongRate, null), 422, /różni się od stawki/);
  const broken = consumerInvoice(); broken.data.totals.gross_minor = '12732';
  refused(() => localInvoiceFa3Model(broken, null, null), 422, /nie sumują się/);
  const long = consumerCredit(); long.data.reason = 'x'.repeat(257);
  refused(() => render(consumerCreditFa3Model(long, null), GENERATED_AT.replace('20T', '22T')), 409, /Przyczyna korekty/);
  const eur = consumerCredit(); (eur.data.calculation as any).currency = 'EUR';
  refused(() => consumerCreditFa3Model(eur, null), 409, /poza PLN/);
  const { original, credit } = b2bPair();
  refused(() => b2bCorrectionFa3Model(credit, { ...original, id: '00000000-0000-4000-8000-000000000099' }), 422, /nie wskazuje tej faktury/);
  const nip = consumerInvoice(); nip.data.seller.tax_id = '0123456789';
  refused(() => render(localInvoiceFa3Model(nip, null, null), GENERATED_AT), 409, /NIP poza oficjalnym formatem/);
  refused(() => render(localInvoiceFa3Model(consumerInvoice(), null, null), '2026-10-19T23:59:59Z'), 422, /poprzedza datę wystawienia/);
  refused(() => localInvoiceFa3Model({ ...consumerInvoice(), mode: 'demo' } as any, null, null), 422, /Niepełna migawka/);
});

test('documents FA(3) cannot express get a Polish reason (route answers 409); generation time of old documents', () => {
  assert.match(fa3UnsupportedReason('proforma', 'local'), /pro forma nie jest fakturą VAT/);
  assert.match(fa3UnsupportedReason('invoice', 'external'), /zewnętrzny system/);
  assert.match(fa3UnsupportedReason('invoice', 'demo'), /demonstracyjny/);
  assert.match(fa3UnsupportedReason('correction', 'other'), /nie ma odwzorowania/);
  assert.equal(fa3GenerationTimeOf('2026-10-08T10:00:00.123456+00:00'), '2026-10-08T10:00:00.123456Z');
  assert.equal(fa3GenerationTimeOf(new Date('2026-10-08T10:00:00.120Z')), '2026-10-08T10:00:00.120Z');
  const now = new Date('2026-10-23T07:00:00.000Z');
  assert.equal(fa3GenerationTimeOf('2025-06-01T10:00:00Z', now), '2026-10-23T07:00:00.000Z', 'before the FA(3) range: time of export');
  assert.throws(() => fa3GenerationTimeOf('yesterday'), /czas dokumentu/);
});

test('money: exactly two decimals from integer grosze, signed, range-checked', () => {
  assert.deepEqual([0n, 5n, -5n, -100n, 12345n, -999999999999999999n].map(fa3Money), ['0.00', '0.05', '-0.05', '-1.00', '123.45', '-9999999999999999.99']);
  refused(() => fa3Money(1000000000000000000n), 409, /zakres/);
});

conformAll();
