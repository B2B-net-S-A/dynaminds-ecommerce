/** Pure KOR-S document outputs: FA(3) KOR model and XML (TypKorekty 2, DaneFaKorygowanej with
 * NrKSeFFaKorygowanej, StanPrzed rows, signed P_13/P_14/P_15, P_18/P_18A/P_19, EUR KursWaluty and
 * P_14_xW), the print and the JPK_V7/JPK_FA rows of the correction. No IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TAX_PROFILE, type TaxProfile } from '../server/tax226-model';
import { buyerInput, invoiceMath, mppInPln, normalizeBuyer, plnCategories, type SourceLine } from '../server/invoice230-model';
import type { Invoice230Document, Invoice230Snapshot } from '../server/invoice230';
import { correctionSnapshotOf, type Invoice232Document, type Invoice232Record } from '../server/invoice232';
import { correctionMath, correctionOriginalOf, correctionRequest, originalState, type LineEdit } from '../server/invoice232-model';
import { invoice232Fa3Model, invoice232Rate } from '../server/invoice232-fa3';
import { invoice232PrintHtml } from '../server/invoice232-print';
import { renderFa3Document as renderFa3Raw } from '../server/fa3-render';
import { xsdCollector } from './mf-xsd-collect';
import { v7Row } from '../server/jpk-v7';
import { renderJpkFa } from '../server/jpk-fa';
import { nbpRateLine } from '../server/nbp227-model';

const addr = (country: string) => ({ street: 'ul. Prosta 1', postal_code: '00-001', city: 'Miasto', country });
const seller = { name: 'Sprzedawca', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL' as const, tax_id: '5260250274' };
const p = (x: Partial<TaxProfile>): TaxProfile => ({ ...DEFAULT_TAX_PROFILE, version: 1, ...x });
/** A FV-S invoice of one item line (quantity `qty`) and a shipping line. */
function fvs(buyerIn: unknown, gross: string, qty: number, opts: { currency?: 'PLN' | 'EUR'; mid?: string; shipping?: string; profile?: Partial<TaxProfile> } = {}): Invoice230Document {
  const buyer = normalizeBuyer(buyerInput.parse(buyerIn)), currency = opts.currency ?? 'PLN';
  const src: SourceLine[] = [{ kind: 'item', sku: 'SKU-1', name: 'Produkt 1', vat_rate: 23, gross_minor: gross, profile: opts.profile ? p(opts.profile) : null },
    { kind: 'shipping', sku: '', name: 'Dostawa', vat_rate: 23, gross_minor: opts.shipping ?? '0', profile: null }];
  const m = invoiceMath({ buyer, currency, sell_date: '2026-10-22', lines: src, oss: { registered: true, registered_from: '2026-07-01', rates: [{ country: 'DE', rate_class: 'standard', rate: '19.00' }] } });
  assert.deepEqual(m.blockers, []);
  const mid = opts.mid ?? null, pln = mid ? plnCategories(m.math.categories, mid) : null;
  const nbp = mid ? { currency: 'EUR' as const, tax_point: '2026-10-22', tax_point_basis: 'sell_date' as const, rate_date: '2026-10-21', table_no: '204/A/NBP/2026', mid, source: 'fetched' as const,
    categories: pln!.rows, totals: pln!.totals, line: nbpRateLine({ currency: 'EUR', rate_date: '2026-10-21', table_no: '204/A/NBP/2026', mid, vat_pln_minor: pln!.totals.vat_pln_minor }) } : null;
  const s: Invoice230Snapshot = {
    format: 'invoice230/v1', order: { id: 'o', number: 'ZAM-1', version: '3', status: 'shipped', currency, total_minor: m.math.totals.gross_minor, shipping_cost_minor: opts.shipping ?? '0', payment_mode: 'prepaid' },
    seller, buyer: { ...buyer, email: 'a@b.pl' }, series: { id: 's', name: 'S', prefix: 'FV', payment_terms_days: 14, payment_instructions: 'Przelew', notes: '' }, currency,
    lines: m.math.lines.map(({ source_index, ...l }) => ({ ...l, item_id: l.kind === 'item' ? 'i1' : null, product_id: null, quantity: l.kind === 'item' ? qty : 1, unit: l.kind === 'item' ? 'szt.' as const : 'usł.' as const,
      unit_gross_minor: l.gross_minor, discount_gross_minor: '0', rounding_gross_minor: '0', vat_rate: 23 })),
    categories: m.math.categories, totals: m.math.totals, annex15_gross_minor: m.math.annex15_gross_minor, procedure: m.math.procedure, reverse_charge: m.math.reverse_charge,
    exemption: m.math.exemption as Invoice230Snapshot['exemption'], mpp: mppInPln(buyer, m.math, currency, mid), nbp, rounding_method: 'gross_line_half_up',
    sell_date: '2026-10-22', issue_date: '2026-10-23', due_date: '2026-11-06', year: 2026, local_only: true, ksef_state: 'not_submitted', fiscalized: false };
  return { id: 'd', order_id: 'o', number: 'FV-S/FV/2026/000001', kind: 'invoice', mode: 'invoice230', data: { ...s, number: 'FV-S/FV/2026/000001', preview_id: 'p', scope_hash: 'h' }, created_at: '2026-10-23T10:00:00.000Z' };
}
/** The KOR-S document and its record as the issue stores them. */
function kor(doc: Invoice230Document, request: unknown, edits: LineEdit[] | null, ksef: string | null = null): { d: Invoice232Document; r: Invoice232Record } {
  const req = correctionRequest.parse(request), o = correctionOriginalOf(doc.data), state = originalState(o);
  const e = edits ?? state.map(s => ({ line_no: s.line_no, quantity: 0, gross_minor: '0' }));
  const m = correctionMath(o, state, req.mode, req.reason_code, e);
  assert.deepEqual(m.blockers, []);
  const s = correctionSnapshotOf({ doc, ksef_number: ksef, ret: null, req, math: m.math, position: 1, issue_date: '2026-10-24' });
  const d: Invoice232Document = { id: 'k', order_id: 'o', original_document_id: 'd', return_id: null, number: 'KOR-S/FV/2026/000001', kind: 'correction', mode: 'invoice232_correction',
    data: { ...s, number: 'KOR-S/FV/2026/000001', preview_id: 'kp', scope_hash: 'kh' }, created_at: '2026-10-24T09:00:00.000Z' };
  const r: Invoice232Record = { position: 1, series_id: 's', year: 2026, sequence: 1, currency: s.currency, mid: s.nbp?.mid ?? null,
    categories: s.categories.map(c => ({ key: c.key, rate_code: c.rate_code, net_delta_minor: c.delta.net_minor, vat_delta_minor: c.delta.vat_minor,
      net_pln_delta_minor: c.pln?.delta.net_pln_minor ?? null, vat_pln_delta_minor: c.pln?.delta.vat_pln_minor ?? null })) };
  return { d, r };
}
const { keep, conformAll } = xsdCollector('KOR-S 232');
let rendered = 0;
/** Keeps every FA(3) file rendered here for the official-schema test (last test). */
const renderFa3Document = (...args: Parameters<typeof renderFa3Raw>) => { const r = renderFa3Raw(...args); keep(`${r.number} #${++rendered}`, r.xml); return r; };
const xml = (x: { d: Invoice232Document; r: Invoice232Record }) => renderFa3Document(invoice232Fa3Model(x.d, x.r), x.d.created_at).xml;
const has = (s: string, ...parts: string[]) => { for (const v of parts) assert(s.includes(v), v + '\n' + s); };
const plB2B = { kind: 'business', name: 'Firma', address: addr('PL'), tax_id: '5260250274', pl_vat_payer: true };
const taxpayer = { nip: '5260250274', name: 'Sprzedawca', office: '1206', email: null, phone: null, purpose: 1 as const, person: null };

test('PL B2B 23% with MPP: KOR, TypKorekty 2, DaneFaKorygowanej with the KSeF number, StanPrzed rows, signed P_13_1/P_14_1/P_15, P_18A', () => {
  const x = kor(fvs(plB2B, '2460000', 2, { profile: { annex15: true } }), { mode: 'manual', reason_code: 'zwrot', reason_note: 'RMA-7', lines: [{ line_no: 1, quantity: 1 }] }, [{ line_no: 1, quantity: 1 }],
    '5260250274-20261023-0123456789AB-CD');
  const s = xml(x);
  has(s, '<RodzajFaktury>KOR</RodzajFaktury><PrzyczynaKorekty>Zwrot towaru — RMA-7</PrzyczynaKorekty><TypKorekty>2</TypKorekty>',
    '<DaneFaKorygowanej><DataWystFaKorygowanej>2026-10-23</DataWystFaKorygowanej><NrFaKorygowanej>FV-S/FV/2026/000001</NrFaKorygowanej><NrKSeF>1</NrKSeF><NrKSeFFaKorygowanej>5260250274-20261023-0123456789AB-CD</NrKSeFFaKorygowanej></DaneFaKorygowanej>',
    '<P_13_1>-10000.00</P_13_1><P_14_1>-2300.00</P_14_1><P_15>-12300.00</P_15>', '<P_18A>1</P_18A>', '<P_8B>2</P_8B>', '<StanPrzed>1</StanPrzed>', '<P_12_Zal_15>1</P_12_Zal_15>');
  assert.equal(s.match(/<FaWiersz>/g)!.length, 2, 'only the changed line, before and after');
  const html = invoice232PrintHtml(x.d);
  has(html, 'Faktura korygująca KOR-S/FV/2026/000001', 'Do faktury <strong>FV-S/FV/2026/000001</strong>', 'mechanizm podzielonej płatności', 'przed korektą', 'po korekcie', 'Do zwrotu: 12\u00a0300,00 PLN', 'Art. 29a ust. 13');
  const row = v7Row({ id: 'k', model: invoice232Fa3Model(x.d, x.r), rate: null, tax_date: '2026-10-24', ksef: { number: null, offline: false } })!;
  // MPP stays in FA(3) (P_18A); JPK_V7(3) has no MPP marker in the ewidencja sprzedaży.
  assert.deepEqual([row.k.K_19, row.k.K_20, 'mpp' in row, row.ksef], [-1000000n, -230000n, false, 'BFK']);
});

test('without a KSeF number: NrKSeFN=1; cancellation to zero', () => {
  const x = kor(fvs(plB2B, '12300', 1, { shipping: '1230' }), { mode: 'cancellation' }, null);
  const s = xml(x);
  has(s, '<NrKSeFN>1</NrKSeFN>', '<PrzyczynaKorekty>Anulowanie transakcji — korekta do zera</PrzyczynaKorekty>', '<P_15>-135.30</P_15>', '<P_8B>0</P_8B>');
  assert.equal(s.match(/<StanPrzed>1<\/StanPrzed>/g)!.length, 2);
});

test('NP II EUR to a DE business: KodUE/NrVatUE, KursWaluty = mid of the invoice on every row, P_13_9, P_18=1; JPK K_11/K_12 signed in PLN', () => {
  const inv = fvs({ kind: 'business', name: 'GmbH', address: addr('DE'), tax_id: 'DE123456789' }, '33333', 3, { currency: 'EUR', mid: '4.2737', profile: { category: 'np', np_kind: 'np_ii' } });
  const x = kor(inv, { mode: 'manual', reason_code: 'obnizka_ceny', lines: [{ line_no: 1, quantity: 3, gross_minor: '30000' }] }, [{ line_no: 1, quantity: 3, gross_minor: '30000' }]);
  const s = xml(x);
  has(s, '<KodWaluty>EUR</KodWaluty>', '<KodUE>DE</KodUE><NrVatUE>123456789</NrVatUE>', '<P_13_9>-33.33</P_13_9>', '<P_15>-33.33</P_15>', '<P_18>1</P_18>', '<P_12>np II</P_12>');
  assert.equal(s.match(/<KursWaluty>4.2737<\/KursWaluty>/g)!.length, 2);
  // PLN difference = round(30000 × 4.2737) − round(33333 × 4.2737) = 128211 − 142455.
  assert.equal(x.d.data.pln_totals!.delta.net_pln_minor, '-14244');
  const row = v7Row({ id: 'k', model: invoice232Fa3Model(x.d, x.r), rate: invoice232Rate(x.d, x.r), tax_date: '2026-10-24', ksef: { number: 'KSEF-1', offline: false } })!;
  assert.deepEqual([row.k.K_11, row.k.K_12, row.buyer_tin_country, row.ksef], [-14244n, -14244n, 'DE', { number: 'KSEF-1' }]);
  has(invoice232PrintHtml(x.d), 'Kurs NBP faktury korygowanej z dnia 2026-10-21, tabela 204/A/NBP/2026, 1 EUR = 4,2737 PLN', 'netto -142,44 PLN');
});

test('EUR 23%: P_14_1W from the stored PLN VAT difference; JPK_FA KOREKTA with NrFaKorygowanej and signed lines', () => {
  const x = kor(fvs(plB2B, '123000', 1, { currency: 'EUR', mid: '4.2563' }), { mode: 'manual', reason_code: 'rabat', lines: [{ line_no: 1, quantity: 1, gross_minor: '61500' }] },
    [{ line_no: 1, quantity: 1, gross_minor: '61500' }]);
  const c = x.d.data.categories[0]!;
  has(xml(x), '<P_13_1>-500.00</P_13_1><P_14_1>-115.00</P_14_1><P_14_1W>' + (Number(c.pln!.delta.vat_pln_minor) / 100).toFixed(2) + '</P_14_1W>');
  const fa = renderJpkFa({ from: '2026-10-01', to: '2026-10-31', taxpayer, address: { wojewodztwo: 'małopolskie', powiat: 'Kraków', gmina: 'Kraków', ulica: 'Rynek', nr_domu: '2', miejscowosc: 'Kraków', kod_pocztowy: '30-001' },
    generated_at: '2026-10-24T10:00:00Z', documents: [{ id: 'k', model: invoice232Fa3Model(x.d, x.r), rate: invoice232Rate(x.d, x.r), tax_date: '2026-10-24' }] });
  has(fa.xml, '<RodzajFaktury>KOREKTA</RodzajFaktury><PrzyczynaKorekty>Rabat udzielony po sprzedaży</PrzyczynaKorekty><NrFaKorygowanej>FV-S/FV/2026/000001</NrFaKorygowanej>', '<P_11>-500.00</P_11><P_11A>-615.00</P_11A>');
});

test('ZW keeps P_19 with its basis; OO keeps P_18; increase is a positive KOR in the period of the correction (art. 29a ust. 17)', () => {
  const zw = kor(fvs(plB2B, '50000', 2, { profile: { category: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'art. 43 ust. 1 pkt 29' } }),
    { mode: 'manual', reason_code: 'zwrot', lines: [{ line_no: 1, quantity: 1 }] }, [{ line_no: 1, quantity: 1 }]);
  has(xml(zw), '<P_13_7>-250.00</P_13_7>', '<P_19>1</P_19><P_19A>art. 43 ust. 1 pkt 29</P_19A>');
  const oo = kor(fvs(plB2B, '60000', 1, { profile: { category: 'oo' } }), { mode: 'manual', reason_code: 'podwyzka_ceny', lines: [{ line_no: 1, quantity: 1, gross_minor: '66000' }] },
    [{ line_no: 1, quantity: 1, gross_minor: '66000' }]);
  has(xml(oo), '<P_13_10>60.00</P_13_10>', '<P_15>60.00</P_15>', '<P_18>1</P_18>');
  has(invoice232PrintHtml(oo.d), 'Do dopłaty: 60,00 PLN', 'Art. 29a ust. 17');
});

test('refusals: inconsistent record, wrong mode, EUR without the rate', () => {
  const x = kor(fvs(plB2B, '12300', 1), { mode: 'manual', reason_code: 'zwrot', lines: [{ line_no: 1, quantity: 0 }] }, [{ line_no: 1, quantity: 0 }]);
  assert.throws(() => invoice232Fa3Model(x.d, { ...x.r, categories: x.r.categories.map(c => ({ ...c, net_delta_minor: '1' })) }), /Podsumowanie kategorii/);
  assert.throws(() => invoice232Fa3Model({ ...x.d, mode: 'b2b_correction' as never }, x.r), /Niepełne dane korekty/);
  assert.throws(() => invoice232Fa3Model({ ...x.d, data: { ...x.d.data, currency: 'EUR' } }, x.r), /wymaga kursu NBP/);
  assert.throws(() => invoice232PrintHtml({ ...x.d, number: 'X' }), /Niepoprawne pochodzenie/);
});

conformAll();
