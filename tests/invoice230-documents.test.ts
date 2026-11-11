/** Pure 230 document outputs: FA(3) model and XML (Podmiot2 NIP / KodUE+NrVatUE / BrakID, P_12, P_13/P_14, P_18, P_18A,
 * P_19, KodWaluty/KursWaluty/P_14_1W), the print annotations and the JPK_V7 row (KodKrajuNadaniaTIN). No IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TAX_PROFILE, type TaxProfile } from '../server/tax226-model';
import { buyerInput, invoiceMath, mppInPln, normalizeBuyer, plnCategories, type SourceLine } from '../server/invoice230-model';
import type { Invoice230Document, Invoice230Header, Invoice230Snapshot } from '../server/invoice230';
import { invoice230Fa3Model, invoice230Rate } from '../server/invoice230-fa3';
import { renderFa3Document as renderFa3Raw } from '../server/fa3-render';
import { xsdCollector } from './mf-xsd-collect';
import { invoice230Annotations, invoice230PrintHtml } from '../server/invoice230-print';
import { v7Row } from '../server/jpk-v7';
import { nbpRateLine } from '../server/nbp227-model';

const addr = (country: string) => ({ street: 'ul. Prosta 1', postal_code: '00-001', city: 'Miasto', country });
const seller = { name: 'Sprzedawca', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL' as const, tax_id: '5260250274' };
const p = (x: Partial<TaxProfile>): TaxProfile => ({ ...DEFAULT_TAX_PROFILE, version: 1, ...x });
function doc(buyerIn: unknown, items: { gross: string; profile?: Partial<TaxProfile> }[], opts: { currency?: 'PLN' | 'EUR'; mid?: string; shipping?: string } = {}): { d: Invoice230Document; r: Invoice230Header } {
  const buyer = normalizeBuyer(buyerInput.parse(buyerIn)), currency = opts.currency ?? 'PLN';
  const src: SourceLine[] = [...items.map((x, i) => ({ kind: 'item' as const, sku: 'SKU-' + i, name: 'Produkt ' + i, vat_rate: 23, gross_minor: x.gross, profile: x.profile ? p(x.profile) : null })),
    { kind: 'shipping', sku: '', name: 'Dostawa', vat_rate: 23, gross_minor: opts.shipping ?? '0', profile: null }];
  const m = invoiceMath({ buyer, currency, sell_date: '2026-10-22', lines: src, oss: { registered: true, registered_from: '2026-07-01', rates: [{ country: 'DE', rate_class: 'standard', rate: '19.00' }] } });
  assert.deepEqual(m.blockers, []);
  const mid = opts.mid ?? null, pln = mid ? plnCategories(m.math.categories, mid) : null;
  const nbp = mid ? { currency: 'EUR' as const, tax_point: '2026-10-22', tax_point_basis: 'sell_date' as const, rate_date: '2026-10-21', table_no: '204/A/NBP/2026', mid, source: 'fetched' as const,
    categories: pln!.rows, totals: pln!.totals, line: nbpRateLine({ currency: 'EUR', rate_date: '2026-10-21', table_no: '204/A/NBP/2026', mid, vat_pln_minor: pln!.totals.vat_pln_minor }) } : null;
  const s: Invoice230Snapshot = {
    format: 'invoice230/v1', order: { id: 'o', number: 'ZAM-1', version: '3', status: 'shipped', currency, total_minor: m.math.totals.gross_minor, shipping_cost_minor: opts.shipping ?? '0', payment_mode: 'prepaid' },
    seller, buyer: { ...buyer, email: 'a@b.pl' }, series: { id: 's', name: 'S', prefix: 'FV', payment_terms_days: 14, payment_instructions: 'Przelew', notes: '' }, currency,
    lines: m.math.lines.map(({ source_index, ...l }) => ({ ...l, item_id: null, product_id: null, quantity: 1, unit: l.kind === 'item' ? 'szt.' : 'usł.', unit_gross_minor: l.gross_minor, discount_gross_minor: '0', rounding_gross_minor: '0', vat_rate: 23 })),
    categories: m.math.categories, totals: m.math.totals, annex15_gross_minor: m.math.annex15_gross_minor, procedure: m.math.procedure, reverse_charge: m.math.reverse_charge,
    exemption: m.math.exemption as Invoice230Snapshot['exemption'], mpp: mppInPln(buyer, m.math, currency, mid), nbp, rounding_method: 'gross_line_half_up',
    sell_date: '2026-10-22', issue_date: '2026-10-23', due_date: '2026-11-06', year: 2026, local_only: true, ksef_state: 'not_submitted', fiscalized: false };
  const d: Invoice230Document = { id: 'd', order_id: 'o', number: 'FV-S/FV/2026/000001', kind: 'invoice', mode: 'invoice230', data: { ...s, number: 'FV-S/FV/2026/000001', preview_id: 'p', scope_hash: 'h' }, created_at: '2026-10-23T10:00:00.000Z' };
  const r: Invoice230Header = { series_id: 's', year: 2026, sequence: 1, currency, mid, rate_date: nbp?.rate_date ?? null, table_no: nbp?.table_no ?? null,
    categories: m.math.categories.map(c => { const x = pln?.rows.find(y => y.key === c.key); return { key: c.key, rate_code: c.rate_code, rate: c.rate, net_minor: c.net_minor, vat_minor: c.vat_minor, gross_minor: c.gross_minor, net_pln_minor: x?.net_pln_minor ?? null, vat_pln_minor: x?.vat_pln_minor ?? null }; }) };
  return { d, r };
}
const { keep, conformAll } = xsdCollector('FV-S 230');
let rendered = 0;
/** Keeps every FA(3) file rendered here for the official-schema test (last test). */
const renderFa3Document = (...args: Parameters<typeof renderFa3Raw>) => { const r = renderFa3Raw(...args); keep(`${r.number} #${++rendered}`, r.xml); return r; };
const xml = (x: { d: Invoice230Document; r: Invoice230Header }) => renderFa3Document(invoice230Fa3Model(x.d, x.r), '2026-10-23T10:00:00.000Z').xml;
const has = (s: string, ...parts: string[]) => { for (const v of parts) assert(s.includes(v), v + '\n' + s); };

test('PL B2B with MPP: NIP of the buyer, P_13_1/P_14_1, P_18A=1, print marks MPP', () => {
  const x = doc({ kind: 'business', name: 'Firma', address: addr('PL'), tax_id: 'PL5260250274', pl_vat_payer: true }, [{ gross: '1700000', profile: { annex15: true } }]);
  has(xml(x), '<Podmiot2><DaneIdentyfikacyjne><NIP>5260250274</NIP>', '<P_13_1>13821.14</P_13_1><P_14_1>3178.86</P_14_1>', '<P_18>2</P_18><P_18A>1</P_18A>', '<P_12_Zal_15>1</P_12_Zal_15>');
  has(invoice230PrintHtml(x.d), 'mechanizm podzielonej płatności', 'NIP: 5260250274');
});
test('NP II to a DE business: KodUE + NrVatUE, P_12 np II, P_13_9, P_18=1; JPK row with KodKrajuNadaniaTIN and K_11/K_12', () => {
  const x = doc({ kind: 'business', name: 'GmbH', address: addr('DE'), tax_id: 'DE123456789' }, [{ gross: '80000', profile: { category: 'np', np_kind: 'np_ii' } }]);
  const s = xml(x);
  has(s, '<KodUE>DE</KodUE><NrVatUE>123456789</NrVatUE>', '<P_12>np II</P_12>', '<P_13_9>800.00</P_13_9>', '<P_18>1</P_18>');
  assert(!s.includes('<NIP>123456789'));
  assert.deepEqual(invoice230Annotations(x.d.data).slice(0, 1), ['odwrotne obciążenie']);
  const row = v7Row({ id: 'd', model: invoice230Fa3Model(x.d, x.r), rate: null, tax_date: '2026-10-22' })!;
  assert.deepEqual([row.buyer_tin_country, row.buyer_nip, row.k.K_11, row.k.K_12], ['DE', '123456789', 80000n, 80000n]);
  // Greece: VAT prefix EL in FA(3) KodUE, ISO GR in JPK KodKrajuNadaniaTIN.
  const gr = doc({ kind: 'business', name: 'AE', address: addr('GR'), tax_id: 'EL123456789' }, [{ gross: '100', profile: { category: 'np', np_kind: 'np_ii' } }]);
  has(xml(gr), '<KodUE>EL</KodUE><NrVatUE>123456789</NrVatUE>');
  assert.equal(v7Row({ id: 'd', model: invoice230Fa3Model(gr.d, gr.r), rate: null, tax_date: '2026-10-22' })!.buyer_tin_country, 'GR');
});
test('ZW: P_13_7, P_19=1 with P_19A; OO: P_13_10, P_18=1; OSS: BrakID, P_12_XII, P_13_5/P_14_5', () => {
  const zw = doc({ kind: 'business', name: 'Firma', address: addr('PL'), tax_id: '5260250274' }, [{ gross: '50000', profile: { category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'art. 43 ust. 1 pkt 29' } }], { shipping: '1500' });
  has(xml(zw), '<P_12>zw</P_12>', '<P_13_7>515.00</P_13_7>', '<Zwolnienie><P_19>1</P_19><P_19A>art. 43 ust. 1 pkt 29</P_19A></Zwolnienie>');
  has(invoice230PrintHtml(zw.d), 'Zwolnienie z VAT: art. 43 ust. 1 pkt 29');
  const oo = doc({ kind: 'business', name: 'Firma', address: addr('PL'), tax_id: '5260250274', pl_vat_payer: true }, [{ gross: '60000', profile: { category: 'oo' } }]);
  has(xml(oo), '<P_12>oo</P_12>', '<P_13_10>600.00</P_13_10>', '<P_18>1</P_18>');
  const oss = doc({ kind: 'consumer', name: 'Hans', address: addr('DE') }, [{ gross: '23800' }], { shipping: '1190' });
  has(xml(oss), '<BrakID>1</BrakID>', '<P_12_XII>19.00</P_12_XII>', '<P_13_5>210.00</P_13_5><P_14_5>39.90</P_14_5>');
  has(invoice230PrintHtml(oss.d), 'Procedura szczególna OSS');
});
test('EUR: KodWaluty, KursWaluty on every line, P_14_1W from the stored PLN; JPK in PLN; print shows the NBP line', () => {
  const x = doc({ kind: 'business', name: 'Firma', address: addr('PL'), tax_id: '5260250274' }, [{ gross: '123000' }], { currency: 'EUR', mid: '4.2563', shipping: '1230' });
  const s = xml(x);
  has(s, '<KodWaluty>EUR</KodWaluty>', '<P_13_1>1010.00</P_13_1><P_14_1>232.30</P_14_1><P_14_1W>988.74</P_14_1W>');
  assert.equal(s.match(/<KursWaluty>4.2563<\/KursWaluty>/g)!.length, 2);
  const row = v7Row({ id: 'd', model: invoice230Fa3Model(x.d, x.r), rate: invoice230Rate(x.d, x.r), tax_date: '2026-10-22' })!;
  assert.deepEqual([row.k.K_19, row.k.K_20], [429886n, 98874n]);
  has(invoice230PrintHtml(x.d), 'Kurs NBP z dnia 21.10.2026, tabela 204/A/NBP/2026, 1 EUR = 4,2563 PLN; VAT w PLN: 988,74 zł', 'VAT w PLN');
  // A stored record that disagrees with the snapshot is refused (422), not exported.
  assert.throws(() => invoice230Fa3Model(x.d, { ...x.r, mid: '4.0000' }), /Kurs zapisany/);
  assert.throws(() => invoice230Fa3Model(x.d, { ...x.r, categories: x.r.categories.map(c => ({ ...c, net_minor: '1' })) }), /Podsumowanie kategorii/);
  assert.throws(() => invoice230Fa3Model({ ...x.d, data: { ...x.d.data, nbp: null } }, x.r), /kursu NBP/);
});

test('233: an invoice to a fiscal receipt has FA(3) FP=1 with the receipt in DodatkowyOpis, and the print names the receipt', () => {
  const x = doc({ kind: 'business', name: 'Firma', address: addr('PL'), tax_id: '5260250274', pl_vat_payer: true }, [{ gross: '12300' }]);
  const receipt = { number: '000017', fiscal_date: '2026-10-22', printer_unique_number: 'DYN12345678' };
  const out = renderFa3Document({ ...invoice230Fa3Model(x.d, x.r), receipt }, '2026-10-23T10:00:00.000Z').xml;
  has(out, '<RodzajFaktury>VAT</RodzajFaktury><FP>1</FP><DodatkowyOpis><Klucz>Paragon fiskalny</Klucz><Wartosc>nr 000017 z dnia 2026-10-22, kasa DYN12345678</Wartosc></DodatkowyOpis><FaWiersz>');
  assert(!xml(x).includes('<FP>'));
  has(invoice230PrintHtml(x.d, receipt), 'Faktura do paragonu fiskalnego</span> nr 000017 z dnia 2026-10-22, kasa DYN12345678');
  assert(!invoice230PrintHtml(x.d).includes('paragonu'));
  assert.throws(() => renderFa3Document({ ...invoice230Fa3Model(x.d, x.r), kind: 'KOR', receipt }, '2026-10-23T10:00:00.000Z'), /FP/);
});

conformAll();
