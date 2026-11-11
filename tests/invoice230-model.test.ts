/** Pure 230 rules: buyer NIP / EU VAT ID, line math of every category, category totals, PLN conversion and MPP. No IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TAX_PROFILE, type OssState, type TaxProfile } from '../server/tax226-model';
import {
  buyerInput, checkEuVatId, grossLineAmounts, invoiceMath, mppInPln, nipValid, normalizeBuyer, normalizeNip, plnCategories, taxBuyerOf,
  type Buyer, type InvoiceSource, type SourceLine,
} from '../server/invoice230-model';

const addr = (country: string) => ({ street: 'ul. Prosta 1', postal_code: '00-001', city: 'Miasto', country });
const buyer = (b: unknown): Buyer => normalizeBuyer(buyerInput.parse(b));
const plB2B = buyer({ kind: 'business', name: 'Firma Sp. z o.o.', address: addr('PL'), tax_id: 'PL 526-025-02-74', pl_vat_payer: true });
const deB2B = buyer({ kind: 'business', name: 'GmbH', address: addr('DE'), tax_id: 'DE 123456789' });
const deConsumer = buyer({ kind: 'consumer', name: 'Hans Muster', address: addr('DE') });
const profile = (p: Partial<TaxProfile>): TaxProfile => ({ ...DEFAULT_TAX_PROFILE, version: 1, ...p });
const item = (gross: string, vat: number, p: Partial<TaxProfile> | null = null, sku = 'SKU-' + gross): SourceLine => ({ kind: 'item', sku, name: sku, vat_rate: vat, gross_minor: gross, profile: p ? profile(p) : null });
const ship = (gross: string, vat = 23): SourceLine => ({ kind: 'shipping', sku: '', name: 'Dostawa', vat_rate: vat, gross_minor: gross, profile: null });
const oss: OssState = { registered: true, registered_from: '2026-07-01', rates: [{ country: 'DE', rate_class: 'standard', rate: '19.00' }, { country: 'DE', rate_class: 'reduced_1', rate: '7.00' }, { country: 'FR', rate_class: 'reduced_1', rate: '5.50' }] };
const src = (b: Buyer, lines: SourceLine[], extra: Partial<InvoiceSource> = {}): InvoiceSource => ({ buyer: b, currency: 'PLN', sell_date: '2026-10-20', lines, oss, ...extra });
const ok = (s: InvoiceSource) => { const d = invoiceMath(s); assert.deepEqual(d.blockers, []); return d.math; };
const zw = { category: 'zw' as const, exemption_basis_kind: 'P_19A' as const, exemption_basis: 'art. 43 ust. 1 pkt 29 ustawy o VAT' };

test('NIP: checksum, separators and PL prefix; zero and wrong check digit refused', () => {
  assert.equal(nipValid('5260250274'), true);
  assert.equal(nipValid('1234563218'), true);
  for (const bad of ['5260250275', '0000000000', '526025027', '52602502744', 'abcdefghij']) assert.equal(nipValid(bad), false, bad);
  assert.equal(normalizeNip('PL 526-025-02-74'), '5260250274');
  assert.equal(normalizeNip('pl5260250274'), '5260250274');
  assert.equal(normalizeNip('526-025-02-75'), null);
});

test('EU VAT ID: country prefix (EL for Greece) and national format, no VIES call', () => {
  assert.deepEqual(checkEuVatId('DE', 'de 123 456 789'), { ok: true, value: 'DE123456789' });
  assert.deepEqual(checkEuVatId('AT', 'ATU12345678'), { ok: true, value: 'ATU12345678' });
  assert.deepEqual(checkEuVatId('GR', 'EL123456789'), { ok: true, value: 'EL123456789' });
  assert.deepEqual(checkEuVatId('NL', 'NL123456789B01'), { ok: true, value: 'NL123456789B01' });
  assert.deepEqual(checkEuVatId('FR', 'FRXX123456789'), { ok: true, value: 'FRXX123456789' });
  assert.equal(checkEuVatId('IE', 'IE1234567WA').ok, true);
  for (const [c, v, re] of [['DE', '12345678', /zaczyna się od DE/], ['DE', 'DE12345678', /formatu/], ['GR', 'GR123456789', /EL/], ['AT', 'AT12345678', /formatu/],
    ['NL', 'NL123456789', /formatu/], ['PL', 'PL5260250274', /NIP/], ['US', 'US123', /nie jest państwem UE/], ['FR', 'FRIO123456789', /formatu/]] as const) {
    const r = checkEuVatId(c, v);
    assert.equal(r.ok, false, c + v); if (!r.ok) assert.match(r.reason, re);
  }
});

test('buyer input: PL business needs a valid NIP, EU VAT ID optional but checked, none outside the EU; PL VAT payer only for PL', () => {
  assert.deepEqual({ ...plB2B, address: undefined }, { kind: 'business', name: 'Firma Sp. z o.o.', address: undefined, tax_id: '5260250274', tax_id_kind: 'nip', pl_vat_payer: true });
  assert.equal(deB2B.tax_id, 'DE123456789'); assert.equal(deB2B.tax_id_kind, 'eu_vat');
  const deNoId = buyer({ kind: 'business', name: 'GmbH', address: addr('DE') });
  assert.equal(deNoId.tax_id_kind, 'none');
  assert.equal(buyer({ kind: 'business', name: 'Inc.', address: addr('US') }).tax_id_kind, 'none');
  assert.equal(deConsumer.kind, 'consumer');
  for (const bad of [{ tax_id: '5260250275', address: addr('PL') }, { tax_id: '', address: addr('PL') }, { tax_id: 'DE12', address: addr('DE') },
    { tax_id: 'US-123', address: addr('US') }, { tax_id: 'DE123456789', address: addr('DE'), pl_vat_payer: true }, { address: { ...addr('PL'), country: 'Polska' }, tax_id: '5260250274' }])
    assert.equal(buyerInput.safeParse({ kind: 'business', name: 'X', ...bad }).success, false, JSON.stringify(bad));
  assert.equal(buyerInput.safeParse({ kind: 'business', name: '  ', address: addr('PL'), tax_id: '5260250274' }).success, false);
  assert.equal(buyerInput.safeParse({ kind: 'consumer', name: 'A', address: addr('PL'), tax_id: '5260250274' }).success, false);
  assert.deepEqual(taxBuyerOf(deB2B), { kind: 'business', country: 'DE', eu_vat_id: true, pl_vat_payer: false });
  assert.deepEqual(taxBuyerOf(plB2B), { kind: 'business', country: 'PL', eu_vat_id: false, pl_vat_payer: true });
});

test('line math: the 157 rule (from gross, per line, half up), fractional OSS rates, no VAT for ZW/NP/OO', () => {
  assert.deepEqual(grossLineAmounts(12300n, '23.00'), { net: 10000n, vat: 2300n });
  assert.deepEqual(grossLineAmounts(1n, '23.00'), { net: 1n, vat: 0n });
  assert.deepEqual(grossLineAmounts(7n, '23.00'), { net: 6n, vat: 1n }); // 7·23/123 = 1.309 → 1
  assert.deepEqual(grossLineAmounts(1053n, '5.50'), { net: 998n, vat: 55n }); // 1053·5.5/105.5 = 54.896 → 55
  assert.deepEqual(grossLineAmounts(10850n, '8.50'), { net: 10000n, vat: 850n });
  assert.deepEqual(grossLineAmounts(5000n, '0.00'), { net: 5000n, vat: 0n });
  assert.deepEqual(grossLineAmounts(5000n, null), { net: 5000n, vat: 0n });
  // half-up boundary: 123·x/123 exact halves round up like the SQL floor((2gv+(100+v))/(2(100+v)))
  for (let g = 0n; g < 400n; g++) {
    const v = (2n * g * 23n + 123n) / 246n;
    assert.equal(grossLineAmounts(g, '23').vat, v, String(g));
  }
  assert.throws(() => grossLineAmounts(-1n, '23.00'));
  assert.throws(() => grossLineAmounts(1n, '123.00'));
});

test('PL B2B 23% + 8% + 0 KR: totals per rate and P_13/P_14 fields', () => {
  const m = ok(src(plB2B, [item('12300', 23), item('10800', 8), item('5000', 0), ship('1599', 23)]));
  assert.deepEqual(m.categories.map(c => [c.key, c.fa3_net, c.fa3_vat, c.net_minor, c.vat_minor, c.gross_minor]),
    [['23', 'P_13_1', 'P_14_1', '11300', '2599', '13899'], ['8', 'P_13_2', 'P_14_2', '10000', '800', '10800'], ['0 KR', 'P_13_6_1', null, '5000', '0', '5000']]);
  assert.deepEqual(m.totals, { net_minor: '26300', vat_minor: '3399', gross_minor: '29699' });
  assert.equal(m.reverse_charge, false); assert.equal(m.exemption, null); assert.equal(m.procedure, 'domestic');
});

test('ZW: net = gross, VAT 0, one P_19 basis on the document; shipping follows the exempt goods; mixed bases refused', () => {
  const m = ok(src(plB2B, [item('20000', 23, zw), ship('1500')]));
  assert.deepEqual(m.categories.map(c => [c.rate_code, c.fa3_net, c.net_minor, c.vat_minor]), [['zw', 'P_13_7', '21500', '0']]);
  assert.deepEqual(m.exemption, { kind: 'P_19A', basis: 'art. 43 ust. 1 pkt 29 ustawy o VAT' });
  assert.equal(m.lines[1]!.rate_code, 'zw');
  const mixed = invoiceMath(src(plB2B, [item('100', 23, zw, 'A'), item('100', 23, { ...zw, exemption_basis: 'art. 113 ust. 1' }, 'B')]));
  assert.match(mixed.blockers.join(), /różne podstawy zwolnienia/);
  // ZW goods next to taxed goods: shipping stays an ordinary 23% line
  const two = ok(src(plB2B, [item('100', 23, zw, 'A'), item('12300', 23, null, 'B'), ship('123')]));
  assert.equal(two.lines[2]!.rate_code, '23');
});

test('NP II to an EU business with VAT ID: no VAT, P_18 (reverse charge); without VAT ID or for a consumer refused', () => {
  const np2 = { category: 'np' as const, np_kind: 'np_ii' as const };
  const m = ok(src(deB2B, [item('50000', 23, np2), ship('0')]));
  assert.deepEqual(m.categories.map(c => [c.rate_code, c.fa3_net, c.net_minor, c.vat_minor]), [['np II', 'P_13_9', '50000', '0']]);
  assert.equal(m.reverse_charge, true);
  assert.equal(m.lines.length, 2); // free shipping follows the service
  const noId = invoiceMath(src(buyer({ kind: 'business', name: 'GmbH', address: addr('DE') }), [item('50000', 23, np2)]));
  assert.match(noId.blockers.join(), /NP II .*numerem VAT UE/);
  assert.match(invoiceMath(src(deConsumer, [item('50000', 23, np2)])).blockers.join(), /NP II/);
  // paid shipping to a foreign business with taxable goods is not supported (WDT)
  assert.match(invoiceMath(src(deB2B, [item('100', 23)])).blockers.join(), /WDT/);
});

test('NP I outside PL: P_13_8; refused for a PL buyer', () => {
  const np1 = { category: 'np' as const, np_kind: 'np_i' as const };
  const us = buyer({ kind: 'business', name: 'Inc.', address: addr('US') });
  const m = ok(src(us, [item('7000', 23, np1), ship('500')]));
  assert.deepEqual(m.categories.map(c => [c.rate_code, c.fa3_net, c.net_minor]), [['np I', 'P_13_8', '7500']]);
  assert.equal(m.reverse_charge, false);
  assert.match(invoiceMath(src(plB2B, [item('7000', 23, np1)])).blockers.join(), /NP I/);
});

test('OO to a PL active VAT payer: VAT 0 on the invoice, P_13_10, P_18; refused for a non-payer or a consumer', () => {
  const m = ok(src(plB2B, [item('80000', 23, { category: 'oo' })]));
  assert.deepEqual(m.categories.map(c => [c.rate_code, c.fa3_net, c.net_minor, c.vat_minor]), [['oo', 'P_13_10', '80000', '0']]);
  assert.equal(m.reverse_charge, true);
  const nonPayer = buyer({ kind: 'business', name: 'Firma', address: addr('PL'), tax_id: '5260250274' });
  assert.match(invoiceMath(src(nonPayer, [item('80000', 23, { category: 'oo' })])).blockers.join(), /czynnym podatnikiem VAT/);
  assert.match(invoiceMath(src(normalizeBuyer({ kind: 'consumer', name: 'Jan', address: addr('PL') }), [item('80000', 23, { category: 'oo' })])).blockers.join(), /OO/);
});

test('OSS to a DE consumer: destination rates per class, shipping at the standard destination rate, P_13_5/P_14_5', () => {
  const m = ok(src(deConsumer, [item('11900', 23), item('10700', 5, { oss_rate_class: 'reduced_1' }), ship('1190')]));
  assert.deepEqual(m.categories.map(c => [c.key, c.label, c.fa3_net, c.fa3_vat, c.net_minor, c.vat_minor]),
    [['oss 19.00', 'OSS DE 19,00%', 'P_13_5', 'P_14_5', '11000', '2090'], ['oss 7.00', 'OSS DE 7,00%', 'P_13_5', 'P_14_5', '10000', '700']]);
  assert.equal(m.procedure, 'oss');
  const fr = buyer({ kind: 'consumer', name: 'Jean', address: addr('FR') });
  assert.equal(ok(src(fr, [item('1055', 5, { oss_rate_class: 'reduced_1' })])).lines[0]!.vat_minor, '55');
  assert.match(invoiceMath(src(deConsumer, [item('11900', 23)], { oss: { ...oss, registered: false, registered_from: null } })).blockers.join(), /rejestracji OSS/);
  assert.match(invoiceMath(src(deConsumer, [item('11900', 23)], { sell_date: '2026-06-30' })).blockers.join(), /rejestracji OSS/);
  assert.match(invoiceMath(src(fr, [item('11900', 23)])).blockers.join(), /Brak stawki OSS dla FR/);
  assert.match(invoiceMath(src(deConsumer, [item('11900', 23)], { currency: 'EUR' })).blockers.join(), /OSS w walucie obcej/);
});

test('EUR: PLN amounts per category with the 227 rule (net and VAT each rounded, gross their sum)', () => {
  const m = ok(src(deB2B, [item('100000', 23, { category: 'np', np_kind: 'np_ii' })], { currency: 'EUR' }));
  assert.deepEqual(plnCategories(m.categories, '4.2563').totals, { net_pln_minor: '425630', vat_pln_minor: '0', gross_pln_minor: '425630' });
  const pl = ok(src(plB2B, [item('12300', 23), item('333', 8)], { currency: 'EUR' }));
  const p = plnCategories(pl.categories, '4.3333');
  assert.deepEqual(p.rows.map(r => [r.key, r.net_pln_minor, r.vat_pln_minor]), [['23', '43333', '9967'], ['8', '1335', '108']]); // 308·4.3333 = 1334.66, 25·4.3333 = 108.33
  assert.deepEqual(p.totals, { net_pln_minor: '44668', vat_pln_minor: '10075', gross_pln_minor: '54743' });
});

test('MPP: B2B with annex 15 strictly over 15 000 zł; EUR compared after conversion; consumer and no annex 15 never', () => {
  const a15 = { annex15: true };
  const at = (gross: string, b = plB2B, cur: 'PLN' | 'EUR' = 'PLN', mid: string | null = null) => mppInPln(b, ok(src(b, [item(gross, 23, a15)], { currency: cur })), cur, mid);
  assert.equal(at('1500000').required, false); // exactly 15 000,00 zł
  assert.equal(at('1500001').required, true);
  assert.equal(at('1500001').gross_pln_minor, '1500001');
  // 3 529,41 EUR × 4,2500 = 14 999,99 zł (per-rate rounding); 3 529,42 EUR = 15 000,03 zł
  assert.deepEqual([at('352941', plB2B, 'EUR', '4.2500').required, at('352941', plB2B, 'EUR', '4.2500').gross_pln_minor], [false, '1499999']);
  assert.deepEqual([at('352942', plB2B, 'EUR', '4.2500').required, at('352942', plB2B, 'EUR', '4.2500').gross_pln_minor], [true, '1500003']);
  const noRate = at('352942', plB2B, 'EUR', null);
  assert.equal(noRate.required, false); assert.match(noRate.reason, /Brak kursu NBP/);
  assert.equal(mppInPln(plB2B, ok(src(plB2B, [item('2000000', 23)])), 'PLN', null).required, false);
  const consumer = normalizeBuyer({ kind: 'consumer', name: 'Jan', address: addr('PL') });
  assert.equal(mppInPln(consumer, ok(src(consumer, [item('2000000', 23, a15)])), 'PLN', null).required, false);
});

test('refusals: no lines, ZW without a basis', () => {
  assert.match(invoiceMath(src(plB2B, [])).blockers.join(), /nie ma pozycji/);
  assert.match(invoiceMath(src(plB2B, [item('100', 23, { category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: null })])).blockers.join(), /podstawy prawnej/);
});
