/** JPK_V7M, JPK_V7K (month without and with the declaration) and JPK_FA from the app's documents:
 * golden bytes, every rate category (23/8/5/0/zw/np/oo, OSS, EUR), GTU, MPP, corrections, empty
 * period, Ctrl sums recomputed from the rows, declaration rounding, refusals. Pure — no DB.
 * Every rendered file is also validated against the vendored official MF schema (last test).
 * Golden files: tests/jpk-golden/*.xml (JPK_GOLDEN_UPDATE=1 rewrites them). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderJpkV7, v7Declaration, v7Totals, type V7Rendered } from '../server/jpk-v7';
import { renderJpkFa, lineNet } from '../server/jpk-fa';
import { JpkError, jpkWholeZloty, resolveTaxpayer, jpkTaxpayerQuery, type JpkDocument } from '../server/jpk-model';
import { collectJpkDocuments, type JpkListed } from '../server/jpk-source';
import { jpkXsdValidator, type JpkSchema } from '../server/jpk-xsd';
import { xsdCollector } from './mf-xsd-collect';
import { localInvoiceFa3Model } from '../server/fa3-adapters';
import { consumerInvoice, taxSnapshot, untaxed } from './fa3-fixtures';
import { JPK_GENERATED_AT, taxpayer, address, fvA, fvB, fvC, fvEur, fvEurWithoutRate, fvOss, korA, korZero, fvNov, fvDec, b2b, jpkValues, jpkRecords, minorOf } from './jpk-fixtures';

const goldenDir = fileURLToPath(new URL('./jpk-golden/', import.meta.url));
function golden(name: string, xml: string) {
  const path = goldenDir + name + '.xml';
  if (process.env.JPK_GOLDEN_UPDATE === '1') { mkdirSync(goldenDir, { recursive: true }); writeFileSync(path, xml); }
  assert.equal(xml, readFileSync(path, 'utf8'), 'golden ' + name);
}
/** Every golden file against its official schema (vendored in schemas/mf). */
for (const [name, schema] of [['v7m-2026-10', 'JPK_V7M'], ['v7m-2026-09-empty', 'JPK_V7M'], ['v7k-2026-11', 'JPK_V7K'], ['v7k-2026-12', 'JPK_V7K'], ['fa-2026-10', 'JPK_FA']] as [string, JpkSchema][]) {
  test(`XSD ${schema}: ${name}.xml`, async () => {
    const xsd = jpkXsdValidator(schema);
    assert.equal(xsd.available, true, xsd.reason);
    assert.deepEqual(await xsd.validate(readFileSync(goldenDir + name + '.xml', 'utf8')), { status: 'valid' });
  });
}
const { keep, conformAll } = xsdCollector('JPK');
/** October documents; the JPK_V7 files take C without the `oo` line (no such field in JPK_V7(3)). */
const october = (oo = false) => [fvA().jpk, fvB(), fvC(oo), fvEur(), fvOss(), korA(), korZero()];
const v7 = (variant: 'M' | 'K', month: number, documents: JpkDocument[], extra: Partial<Parameters<typeof renderJpkV7>[0]> = {}) => {
  const r = renderJpkV7({ variant, year: 2026, month, taxpayer, generated_at: JPK_GENERATED_AT, documents, surplus_zloty: 0n, ...extra });
  keep(`JPK_V7${variant} ${month}/2026 (${documents.length} dok.)`, r.xml); return r;
};
const fa = (input: Parameters<typeof renderJpkFa>[0]) => { const r = renderJpkFa(input); keep(`JPK_FA ${input.from}..${input.to} (${input.documents.length} dok.)`, r.xml); return r; };
const K = ['K_10', 'K_11', 'K_12', 'K_13', 'K_15', 'K_16', 'K_17', 'K_18', 'K_19', 'K_20', 'K_21', 'K_22'];
/** Ctrl sums recomputed independently from the parsed rows. */
function checkV7Ctrl(r: V7Rendered) {
  const rows = jpkRecords(r.xml, 'SprzedazWiersz'), v = jpkValues(r.xml);
  assert.deepEqual(v.LiczbaWierszySprzedazy, [String(rows.length)]);
  assert.equal(rows.length, r.rows);
  const vat = rows.reduce((n, x) => n + minorOf(x.K_16) + minorOf(x.K_18) + minorOf(x.K_20), 0n);
  assert.deepEqual(v.PodatekNalezny, [(vat < 0n ? '-' : '') + (vat < 0n ? -vat : vat) / 100n + '.' + String((vat < 0n ? -vat : vat) % 100n).padStart(2, '0')]);
  assert.deepEqual(rows.map(x => x.LpSprzedazy), rows.map((_, i) => String(i + 1)));
  assert.deepEqual([v.LiczbaWierszyZakupow, v.PodatekNaliczony], [['0'], ['0.00']], 'purchase register not in scope');
  return rows;
}

test('229 KSeF markers: NrKSeF when a number is stored, OFF for an offline invoice not yet sent, BFK otherwise', () => {
  const number = '5260250274-20261020-0123456789AB-3F';
  const docs = [{ ...fvA().jpk, ksef: { number, offline: false } }, { ...fvB(), ksef: { number: null, offline: true } }, fvC(false)];
  const rows = jpkRecords(v7('M', 10, docs).xml, 'SprzedazWiersz');
  assert.deepEqual(rows.map(r => [r.NrKSeF, r.OFF, r.BFK]), [[number, undefined, undefined], [undefined, '1', undefined], [undefined, undefined, '1']]);
  // The marker sits where the schema's choice is: after DataSprzedazy/DataWystawienia, before GTU and K_.
  const xml = v7('M', 10, docs).xml;
  assert.match(xml, new RegExp('<DataSprzedazy>2026-10-18</DataSprzedazy><NrKSeF>' + number + '</NrKSeF><K_13>'));
});

test('JPK_V7M October: one row per document, every rate category, GTU, no MPP (not in JPK_V7(3)), WSTO_EE, EUR in PLN, correction negative, zero correction left out', () => {
  const r = v7('M', 10, october());
  golden('v7m-2026-10', r.xml);
  const rows = checkV7Ctrl(r), v = jpkValues(r.xml);
  assert.equal(r.filename, 'JPK_V7M-2026-10.xml');
  assert.deepEqual(rows.map(x => x.DowodSprzedazy), ['FV/LOK/2026/000042', 'FV/LOK/2026/000043', 'KOR/LOK/2026/000007', 'FV/LOK/2026/000044', 'FV/LOK/2026/000045', 'FV/LOK/2026/000046']);
  const [a, b, kor, c, eur, oss] = rows as [Record<string, string>, ...Record<string, string>[]];
  // A: 23/8/5 and domestic 0%; consumer buyer "brak"; sale date differs from the issue date.
  assert.deepEqual([a.NrKontrahenta, a.NazwaKontrahenta, a.DataWystawienia, a.DataSprzedazy, a.BFK], ['brak', 'Jan Kowalski', '2026-10-20', '2026-10-18', '1']);
  assert.deepEqual([a.K_13, a.K_15, a.K_16, a.K_17, a.K_18, a.K_19, a.K_20], ['10.00', '20.00', '1.00', '46.30', '3.70', '37.65', '8.66']);
  // B: zw → K_10, np I → K_11, GTU_06; the MPP of the invoice has no marker in JPK_V7(3); DataSprzedazy omitted (same day).
  assert.deepEqual([b!.K_10, b!.K_11, b!.K_12, b!.GTU_06, b!.MPP, b!.DataSprzedazy], ['21.00', '50.00', undefined, '1', undefined, undefined]);
  // C: np II → K_11 and K_12, np I → K_11, GTU_12.
  assert.deepEqual([c!.K_11, c!.K_12, c!.K_31, c!.GTU_12, c!.MPP], ['71.00', '50.00', undefined, '1', undefined]);
  // Correction of A in the period of the correction: signed differences.
  assert.deepEqual([kor!.DataWystawienia, kor!.K_19, kor!.K_20, kor!.K_17, kor!.K_18], ['2026-10-22', '-23.83', '-5.48', '-46.30', '-3.70']);
  // EUR: K amounts in PLN from the 227 record.
  assert.deepEqual([eur!.K_13, eur!.K_15, eur!.K_16, eur!.K_17, eur!.K_18, eur!.K_19, eur!.K_20], ['42.74', '85.47', '4.27', '197.86', '15.81', '160.90', '37.01']);
  // OSS: net outside Poland in K_11 with WSTO_EE, no Polish VAT for that line.
  assert.deepEqual([oss!.WSTO_EE, oss!.K_11, oss!.K_19, oss!.K_20], ['1', '28.58', '10.00', '2.30']);
  assert.deepEqual(v.KodFormularzaDekl, ['VAT-7']);
  assert.equal(v.Miesiac?.[0], '10');
});

test('JPK_V7M declaration: P_ fields are the rounded K_ sums, P_37/P_38 sums of rounded fields, P_51 to pay', () => {
  const docs = october(), r = v7('M', 10, docs), v = jpkValues(r.xml), rows = jpkRecords(r.xml, 'SprzedazWiersz');
  const sum = (f: string) => rows.reduce((n, x) => n + minorOf(x[f]), 0n);
  for (const f of K) {
    const expected = jpkWholeZloty(sum(f)), p = v['P_' + f.slice(2)];
    if (expected === 0n) assert.equal(p, undefined, f); else assert.deepEqual(p, [expected.toString()], f);
  }
  const P = (n: number) => BigInt(v['P_' + n]?.[0] ?? '0');
  assert.equal(P(37), [10, 11, 13, 15, 17, 19, 21, 22].reduce((n, i) => n + P(i), 0n));
  assert.equal(P(38), P(16) + P(18) + P(20));
  assert.deepEqual([v.P_48, v.P_51], [['0'], [P(38).toString()]]);
  assert.equal(v.P_53, undefined);
  assert.deepEqual(v.Pouczenia, ['1']);
  // Art. 63 § 1 OP rounding.
  assert.deepEqual([49n, 50n, 149n, 150n, -49n, -50n, -150n].map(jpkWholeZloty), [0n, 1n, 1n, 2n, 0n, -1n, -2n]);
  // Surplus from the previous declaration larger than the VAT due: nothing to pay, surplus carried.
  const d = v7Declaration(v7Totals([]), 120n);
  assert.deepEqual([d.P_38, d.P_39, d.P_48, d.P_51, d.P_53, d.P_62], [0n, 120n, 120n, 0n, 120n, 120n]);
});

test('JPK_V7K: month 11 without the declaration; month 12 with VAT-7K over the whole quarter (natural person, surplus)', () => {
  const nov = v7('K', 11, [fvNov()]);
  golden('v7k-2026-11', nov.xml);
  checkV7Ctrl(nov);
  assert.equal(nov.declaration, null); assert.equal(jpkValues(nov.xml).Deklaracja, undefined);
  const quarter = [...october(), fvNov(), fvDec()];
  const person = { ...taxpayer, person: { first_name: 'Anna', last_name: 'Nowak', birth_date: '1980-05-17' }, phone: '+48 600 100 200' };
  const dec = v7('K', 12, [fvDec()], { quarter_documents: quarter, taxpayer: person, surplus_zloty: 15n });
  golden('v7k-2026-12', dec.xml);
  const rows = checkV7Ctrl(dec), v = jpkValues(dec.xml);
  assert.deepEqual(rows.map(x => x.DowodSprzedazy), ['FV/LOK/2026/000060'], 'ewidencja of December only');
  assert.deepEqual([v.KodFormularzaDekl, v.ImiePierwsze, v.Nazwisko, v.DataUrodzenia, v.Telefon], [['VAT-7K'], ['Anna'], ['Nowak'], ['1980-05-17'], ['+48 600 100 200']]);
  const all = jpkRecords(v7('M', 10, october()).xml, 'SprzedazWiersz').concat(jpkRecords(nov.xml, 'SprzedazWiersz'), rows);
  const vat20 = all.reduce((n, x) => n + minorOf(x.K_20), 0n);
  assert.deepEqual(v.P_20, [jpkWholeZloty(vat20).toString()], 'declaration covers the three months');
  assert.deepEqual([v.P_39, v.P_48], [['15'], ['15']]);
  assert.deepEqual(v.P_51, [(BigInt(v.P_38![0]!) - 15n).toString()]);
  assert.throws(() => v7('K', 12, [fvDec()]), (e: unknown) => e instanceof JpkError && e.status === 422);
  assert.throws(() => v7('K', 12, [fvDec()], { quarter_documents: [fvDec(), { ...fvNov(), tax_date: '2026-09-30' }] }), /spoza kwartału/);
});

test('empty period: rows 0, Ctrl sums 0.00, declaration of zeros; NIP and name required from the request', () => {
  const r = v7('M', 9, []);
  golden('v7m-2026-09-empty', r.xml);
  const v = jpkValues(r.xml);
  assert.deepEqual([v.LiczbaWierszySprzedazy, v.PodatekNalezny, v.SprzedazWiersz], [['0'], ['0.00'], undefined]);
  assert.deepEqual([v.P_37, v.P_38, v.P_48, v.P_51], [['0'], ['0'], ['0'], ['0']]);
  const q = jpkTaxpayerQuery.parse({ kod_urzedu: '1206', email: 'a@b.pl' });
  assert.throws(() => resolveTaxpayer(q, []), /podaj NIP/);
  assert.deepEqual(resolveTaxpayer({ ...q, nip: '5260250274', nazwa: 'X' }, []).nip, '5260250274');
  // JPK_FA(4) requires at least one Faktura and one FakturaWiersz: an empty range or only 0 zł corrections refuse.
  assert.throws(() => renderJpkFa({ from: '2026-09-01', to: '2026-09-30', taxpayer, address, generated_at: JPK_GENERATED_AT, documents: [] }),
    (e: unknown) => e instanceof JpkError && e.status === 409 && /co najmniej jednej faktury/.test(e.message));
  assert.throws(() => renderJpkFa({ from: '2026-10-01', to: '2026-10-31', taxpayer, address, generated_at: JPK_GENERATED_AT, documents: [korZero()] }),
    (e: unknown) => e instanceof JpkError && e.status === 409 && /co najmniej jednego wiersza/.test(e.message));
});

test('JPK_FA (4) October: Faktura per document, lines, KOREKTA with its markings, Ctrl sums equal the documents', () => {
  const docs = october(true), r = fa({ from: '2026-10-01', to: '2026-10-31', taxpayer, address, generated_at: JPK_GENERATED_AT, documents: docs });
  golden('fa-2026-10', r.xml);
  const v = jpkValues(r.xml), invoices = jpkRecords(r.xml, 'Faktura'), lines = jpkRecords(r.xml, 'FakturaWiersz');
  assert.equal(r.filename, 'JPK_FA-2026-10-01_2026-10-31.xml');
  assert.deepEqual(v.LiczbaFaktur, [String(docs.length)]);
  assert.equal(minorOf(v.WartoscFaktur![0]), invoices.reduce((n, x) => n + minorOf(x.P_15), 0n));
  assert.equal(minorOf(v.WartoscFaktur![0]), docs.reduce((n, d) => n + d.model.total_gross_minor, 0n), 'P_15 sum = documents gross');
  assert.deepEqual(v.LiczbaWierszyFaktur, [String(lines.length)]);
  const netOfDocs = docs.reduce((n, d) => n + d.model.buckets.reduce((m, b) => m + b.net_minor, 0n), 0n);
  assert.equal(minorOf(v.WartoscWierszyFaktur![0]), lines.reduce((n, x) => n + minorOf(x.P_11), 0n));
  assert.equal(minorOf(v.WartoscWierszyFaktur![0]), netOfDocs, 'line nets = document nets');
  const kor = invoices.find(x => x.P_2A === 'KOR/LOK/2026/000007')!;
  assert.deepEqual([kor.RodzajFaktury, kor.NrFaKorygowanej, kor.PrzyczynaKorekty, kor.P_15], ['KOREKTA', 'FV/LOK/2026/000042', 'Zwrot towaru przez konsumenta', '-79.31']);
  assert.deepEqual(lines.filter(x => x.P_2B === 'KOR/LOK/2026/000007').map(x => [x.P_8B, x.P_11, x.P_11A, x.P_12]),
    [['-1', '-13.83', '-17.01', '23'], ['-1', '-46.30', '-50.00', '8'], ['0', '-10.00', '-12.30', '23']]);
  const zero = invoices.find(x => x.P_2A === 'KOR/LOK/2026/000008')!;
  assert.deepEqual([zero.RodzajFaktury, zero.P_15], ['KOREKTA', '0.00']);
  const b = invoices.find(x => x.P_2A === 'FV/LOK/2026/000043')!;
  // JPK_FA(4): np I, np II and OSS are P_13_5 (sale outside the country), oo is P_13_4 with P_14_4 = 0, the 0% kinds P_13_6.
  assert.deepEqual([b.P_18A, b.P_19, b.P_19A, b.P_13_7, b.P_13_5, b.P_13_6], ['true', 'true', 'art. 43 ust. 1 pkt 18 ustawy o VAT', '21.00', '50.00', '10.00']);
  const c = invoices.find(x => x.P_2A === 'FV/LOK/2026/000044')!;
  assert.deepEqual([c.P_18, c.P_13_5, c.P_13_4, c.P_14_4], ['true', '50.00', '21.00', '0.00']);
  const oss = invoices.find(x => x.P_2A === 'FV/LOK/2026/000046')!;
  assert.deepEqual([oss.P_13_5, oss.P_14_5], ['28.58', '5.43']);
  const eur = invoices.find(x => x.P_2A === 'FV/LOK/2026/000045')!;
  assert.deepEqual([eur.KodWaluty, eur.P_14_1, eur.P_14_1W], ['EUR', '8.66', '37.01']);
  assert.deepEqual(lines.filter(x => x.P_2B === 'FV/LOK/2026/000046').map(x => x.P_12_XII ?? x.P_12), ['19.00', '8', '5', '0', '23']);
  assert.deepEqual([v.NIP, v.PelnaNazwa, v.KodUrzedu, v.KodPocztowy], [['5260250274'], ['Sklep Testowy Sp. z o.o.'], ['1206'], ['30-001']]);
  assert.throws(() => renderJpkFa({ from: '2026-10-21', to: '2026-10-31', taxpayer, address, generated_at: JPK_GENERATED_AT, documents: [fvA().jpk] }), /spoza zakresu/);
});

test('B2B FV 159 and correction 160: buyer NIP in NrKontrahenta/P_5B, 0 KR in K_13, own seller', () => {
  const { fv, kor, nip } = b2b(), tp = { ...taxpayer, nip, name: 'Hurtownia S.A.' };
  const r = renderJpkV7({ variant: 'M', year: 2026, month: 10, taxpayer: tp, generated_at: JPK_GENERATED_AT, documents: [fv, kor], surplus_zloty: 0n });
  const rows = checkV7Ctrl(r);
  assert.deepEqual(rows.map(x => [x.NrKontrahenta, x.DowodSprzedazy, x.DataSprzedazy ?? '', x.K_13, x.K_19, x.K_20]), [
    ['5260250274', 'FV-B2B/HURT/2026/000003', '2026-10-09', '200.00', '1100.00', '253.00'],
    ['5260250274', 'KOR-B2B/HURT/2026/000001', '', '-100.00', '-300.00', '-69.00']]);
  keep('JPK_V7M B2B 159/160', r.xml);
  const f = fa({ from: '2026-10-01', to: '2026-10-31', taxpayer: tp, address, generated_at: JPK_GENERATED_AT, documents: [fv, kor] });
  const inv = jpkRecords(f.xml, 'Faktura');
  assert.deepEqual(inv.map(x => [x.P_4B, x.P_5B, x.P_13_1, x.P_13_6, x.RodzajFaktury]), [['8567346215', '5260250274', '1100.00', '200.00', 'VAT'], ['8567346215', '5260250274', '-300.00', '-100.00', 'KOREKTA']]);
  // Documents of another seller than the taxpayer NIP refuse with the list.
  assert.throws(() => resolveTaxpayer(jpkTaxpayerQuery.parse({ kod_urzedu: '1206', nip: '5260250274' }), [fv, fvA().jpk]),
    (e: unknown) => e instanceof JpkError && e.status === 409 && e.documents[0]!.number === 'FV-B2B/HURT/2026/000003');
});

test('refusals: EUR without the 227 record, mixed exemption bases, foreign/unsupported modes and increasing corrections list the documents (409)', async () => {
  assert.throws(() => v7('M', 10, [fvA().jpk, fvEurWithoutRate()]),
    (e: unknown) => e instanceof JpkError && e.status === 409 && e.documents.length === 1 && e.documents[0]!.number === 'FV/LOK/2026/000045');
  const mixed = consumerInvoice(); untaxed(mixed, 1); untaxed(mixed, 2);
  const tax = taxSnapshot(mixed);
  Object.assign(tax.lines[1], { category: 'zw', rate: null, rate_code: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'podstawa A' });
  Object.assign(tax.lines[2], { category: 'zw', rate: null, rate_code: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'podstawa B' });
  const eurDoc = consumerInvoice(); eurDoc.data.currency = 'EUR';
  const listed = (n: number, number: string, mode: string, kind = 'invoice'): JpkListed => ({ id: String(n), kind, mode, number, tax_date: '2026-10-20', issue_date: '2026-10-20' });
  const increase = korA(); increase.model = { ...increase.model, total_gross_minor: 100n };
  const facts = async (d: JpkListed) => {
    if (d.id === '1') return { model: localInvoiceFa3Model(mixed, tax, null), rate: null };
    if (d.id === '2') return { model: localInvoiceFa3Model(eurDoc, null, null), rate: null };
    if (d.id === '5') return { model: increase.model, rate: null };
    return { model: fvA().jpk.model, rate: null };
  };
  await assert.rejects(collectJpkDocuments([listed(1, 'FV/MIX/1', 'local_invoice'), listed(2, 'FV/EUR/1', 'local_invoice'), listed(3, 'DEMO/1', 'demo'),
    listed(4, 'FAKT/1', 'external'), listed(5, 'KOR/UP/1', 'local_consumer_credit', 'correction'), listed(6, 'FV/OK/1', 'local_invoice')], facts), (e: unknown) => {
    assert.ok(e instanceof JpkError); assert.equal(e.status, 409);
    assert.deepEqual(e.documents.map(d => d.number), ['FV/MIX/1', 'FV/EUR/1', 'FAKT/1', 'KOR/UP/1']);
    assert.match(e.documents[0]!.reason, /różne podstawy zwolnienia/); assert.match(e.documents[1]!.reason, /kursu NBP/);
    assert.match(e.documents[2]!.reason, /zewnętrzny system/); assert.match(e.documents[3]!.reason, /zwiększająca/);
    return true;
  });
  const ok = await collectJpkDocuments([listed(3, 'DEMO/1', 'demo'), listed(6, 'FV/OK/1', 'local_invoice')], facts);
  assert.deepEqual([ok.documents.length, ok.skipped], [1, 1], 'demo is not a VAT document: skipped');
  assert.throws(() => v7('M', 1, []), /od 2026-02/);
  assert.throws(() => v7('M', 10, [], { taxpayer: { ...taxpayer, email: null } }), /e-mail/);
  assert.throws(() => v7('M', 10, [fvNov()]), /spoza okresu/);
});

test('JPK_V7: the domestic reverse-charge (oo) amount has no field in JPK_V7(3) — the invoice keeps its row, the oo net is in no K_ and not in P_37', () => {
  const withOo = v7('M', 10, [fvA().jpk, fvC(true)]), without = v7('M', 10, [fvA().jpk, fvC(false)]);
  const c = jpkRecords(withOo.xml, 'SprzedazWiersz').find(x => x.DowodSprzedazy === 'FV/LOK/2026/000044')!;
  // np II 50.00 in K_11/K_12; the oo line (21.00) is not reported; no K_31/K_32 (art. 17 ust. 1 pkt 5, the buyer's fields).
  assert.deepEqual([c.K_11, c.K_12, c.K_31, c.K_32, c.BFK], ['50.00', '50.00', undefined, undefined, '1']);
  const P37 = (xml: string) => BigInt(jpkValues(xml).P_37![0]!);
  assert.equal(P37(without.xml) - P37(withOo.xml), 21n, 'only the np I line of the other variant adds to P_37');
  // An invoice with oo lines only: a row without any K_ field.
  const d = fvC(true), ooOnly = { ...d, model: { ...d.model, buckets: d.model.buckets.filter(b => b.code === 'oo') } };
  const row = jpkRecords(v7('M', 10, [ooOnly]).xml, 'SprzedazWiersz');
  assert.equal(row.length, 1); assert.deepEqual(Object.keys(row[0]!).filter(k => k.startsWith('K_')), []);
});

test('JPK_V7: a rate pair stays complete when one half is zero (net with VAT 0.00)', () => {
  const d = fvA().jpk;
  // 5% bucket of 0.05 zł net with VAT 0.00: K_16 must still follow K_15.
  const tiny = { ...d, model: { ...d.model, buckets: [{ ...d.model.buckets.find(b => b.code === '5')!, net_minor: 5n, vat_minor: 0n }] } };
  const r = v7('M', 10, [tiny]), row = jpkRecords(r.xml, 'SprzedazWiersz')[0]!, v = jpkValues(r.xml);
  assert.deepEqual([row.K_15, row.K_16], ['0.05', '0.00']);
  assert.deepEqual([v.P_15, v.P_16], [undefined, undefined], 'both halves round to 0 zł: the pair is left out');
});

test('line net by the gross-line method reproduces the stored nets (incl. negatives and OSS rate)', () => {
  assert.deepEqual([lineNet(3401n, '23', null), lineNet(5000n, '8', null), lineNet(-1701n, '23', null), lineNet(5000n, 'zw', null), lineNet(3401n, 'oss', '19.00')], [2765n, 4630n, -1383n, 5000n, 2858n]);
});

conformAll();
