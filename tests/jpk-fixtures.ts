/** Deterministic documents for the JPK files, built from the FA(3) fixtures and the real adapters
 * (the same facts the server reads), plus a namespace-checked XML reader. */
import { SaxesParser } from 'saxes';
import { localInvoiceFa3Model, consumerCreditFa3Model, b2bCorrectionFa3Model, b2bInvoiceFa3Model, type Fa3DocumentRate } from '../server/fa3-adapters';
import type { LocalInvoiceDocument } from '../server/local-invoices';
import type { B2bInvoiceDocument } from '../server/b2b-invoice-values';
import type { JpkDocument, JpkTaxpayer, JpkAddress } from '../server/jpk-model';
import type { JpkReceiptSales } from '../server/jpk-receipts';
import { JPK_V7M_NAMESPACE, JPK_V7K_NAMESPACE, JPK_ETD_NAMESPACE } from '../server/jpk-v7';
import { JPK_FA_NAMESPACE, JPK_FA_ETD_NAMESPACE } from '../server/jpk-fa';
import { consumerInvoice, taxSnapshot, untaxed, consumerCredit, b2bPair } from './fa3-fixtures';

export const JPK_GENERATED_AT = '2026-11-05T08:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`;
export const taxpayer: JpkTaxpayer = { nip: '5260250274', name: 'Sklep Testowy Sp. z o.o.', office: '1206', email: 'ksiegowosc@sklep.test', phone: null, purpose: 1, person: null };
export const address: JpkAddress = { wojewodztwo: 'małopolskie', powiat: 'Kraków', gmina: 'Kraków', ulica: 'Rynek', nr_domu: '2', nr_lokalu: undefined, miejscowosc: 'Kraków', kod_pocztowy: '30-001' };

/** consumerInvoice() renumbered and redated. */
function invoice(n: number, number: string, sell: string, issue: string): LocalInvoiceDocument {
  const d = consumerInvoice();
  Object.assign(d, { id: id(n), number });
  Object.assign(d.data, { number, sell_date: sell, issue_date: issue, due_date: issue });
  return d;
}
const local = (d: LocalInvoiceDocument, tax: Parameters<typeof localInvoiceFa3Model>[1] = null, rate: Fa3DocumentRate | null = null): JpkDocument =>
  ({ id: d.id, model: localInvoiceFa3Model(d, tax, rate), rate, tax_date: d.data.sell_date });

/** A: 23/8/5/0 KR, sold 18.10, issued 20.10. */
export const fvA = () => { const d = invoice(1, 'FV/LOK/2026/000042', '2026-10-18', '2026-10-20'); return { doc: d, jpk: local(d) }; };
/** B: 226 snapshot — 23% line with GTU_06 and annex 15 (MPP), np I, zw (P_19A), 0 KR. */
export function fvB(): JpkDocument {
  const d = invoice(2, 'FV/LOK/2026/000043', '2026-10-21', '2026-10-21'); untaxed(d, 1); untaxed(d, 2);
  const tax = taxSnapshot(d); tax.mpp_required = true;
  Object.assign(tax.lines[0], { gtu: 'GTU_06', annex15: true });
  Object.assign(tax.lines[1], { category: 'np', rate: null, rate_code: 'np I' });
  Object.assign(tax.lines[2], { category: 'zw', rate: null, rate_code: 'zw', exemption_basis_kind: 'P_19A', exemption_basis: 'art. 43 ust. 1 pkt 18 ustawy o VAT' });
  return local(d, tax);
}
/** C: np II (art. 100 ust. 1 pkt 4) and oo lines, GTU_12 on shipping. `oo` has no field in JPK_V7(3)
 * (refused there), so the JPK_V7 files take C with an np I line instead (`oo = false`). */
export function fvC(oo = true): JpkDocument {
  const d = invoice(3, 'FV/LOK/2026/000044', '2026-10-25', '2026-10-25'); untaxed(d, 1); untaxed(d, 2);
  const tax = taxSnapshot(d);
  Object.assign(tax.lines[1], { category: 'np', rate: null, rate_code: 'np II' });
  Object.assign(tax.lines[2], oo ? { category: 'oo', rate: null, rate_code: 'oo' } : { category: 'np', rate: null, rate_code: 'np I' });
  Object.assign(tax.lines[4], { gtu: 'GTU_12' });
  return local(d, tax);
}
/** EUR invoice with its 227 record (VAT and net in PLN per rate). */
export function fvEur(): JpkDocument {
  const d = invoice(4, 'FV/LOK/2026/000045', '2026-10-28', '2026-10-28'); d.data.currency = 'EUR';
  const rate: Fa3DocumentRate = { currency: 'EUR', mid: '4.2735', vat: [
    { vat_rate: 0, net_minor: 1000n, vat_minor: 0n, vat_pln_minor: 0n, net_pln_minor: 4274n }, { vat_rate: 5, net_minor: 2000n, vat_minor: 100n, vat_pln_minor: 427n, net_pln_minor: 8547n },
    { vat_rate: 8, net_minor: 4630n, vat_minor: 370n, vat_pln_minor: 1581n, net_pln_minor: 19786n }, { vat_rate: 23, net_minor: 3765n, vat_minor: 866n, vat_pln_minor: 3701n, net_pln_minor: 16090n }] };
  return local(d, null, rate);
}
/** EUR invoice whose model was built with a rate, presented to JPK without it (refusal path). */
export const fvEurWithoutRate = (): JpkDocument => ({ ...fvEur(), rate: null });
/** OSS line at the destination rate 19% (gross line method at 19%). */
export function fvOss(): JpkDocument {
  const d = invoice(5, 'FV/LOK/2026/000046', '2026-10-29', '2026-10-29'), l = d.data.lines[0]!, t = d.data.totals;
  t.net_minor = String(BigInt(t.net_minor) - BigInt(l.net_minor) + 2858n); t.vat_minor = String(BigInt(t.vat_minor) - BigInt(l.vat_minor) + 543n);
  Object.assign(l, { net_minor: '2858', vat_minor: '543' });
  const tax = taxSnapshot(d); Object.assign(tax.lines[0], { rate: '19.00', rate_code: 'oss' });
  return local(d, tax);
}
/** 188 correction of A, issued 22.10 (negative). */
export const korA = (): JpkDocument => { const c = consumerCredit(fvA().doc); return { id: c.id, model: consumerCreditFa3Model(c, null), rate: null, tax_date: c.data.issue_date }; };
/** Correction of A with no changed position (0 zł): no SprzedazWiersz, a KOREKTA with P_15 0.00 in JPK_FA. */
export function korZero(): JpkDocument {
  const c = consumerCredit(fvA().doc);
  for (const r of c.data.calculation.rows) Object.assign(r, { affected: false, after: r.before, delta: { quantity: '0', gross_minor: '0', net_minor: '0', vat_minor: '0' } });
  c.data.calculation.totals.delta = { gross_minor: '0', net_minor: '0', vat_minor: '0' };
  Object.assign(c, { id: id(6), number: 'KOR/LOK/2026/000008' }); Object.assign(c.data, { number: 'KOR/LOK/2026/000008', issue_date: '2026-10-30' });
  return { id: c.id, model: consumerCreditFa3Model(c, null), rate: null, tax_date: '2026-10-30' };
}
/** Quarter months: same goods as A in November and December. */
export const fvNov = () => local(invoice(7, 'FV/LOK/2026/000050', '2026-11-10', '2026-11-10'));
export const fvDec = () => local(invoice(8, 'FV/LOK/2026/000060', '2026-12-03', '2026-12-04'));

/** B2B FV 159 (NIP buyer) and its 160 correction; seller Hurtownia S.A. */
export function b2b(): { fv: JpkDocument; kor: JpkDocument; nip: string } {
  const { original, credit } = b2bPair();
  const party = (name: string, nip: string, line1: string, line2: string) => ({ kind: 'business', name, tax_id: nip, address: { country: 'PL', line1, line2 } });
  const line = (ordinal: number, kind: 'item' | 'shipping', name: string, q: string, unit: string, gross: string, net: string, vat: string, code: string, basis: string | null) => ({
    ordinal, line_id: `00000000-0000-4000-8000-${String(40 + ordinal).padStart(12, '0')}`, kind, source_item_id: null, name, unit: kind === 'item' ? 'szt.' : 'usł.', quantity: q,
    unit_gross_minor: unit, discount_gross_minor: '0', rounding_gross_minor: '0', gross_minor: gross, net_minor: net, vat_minor: vat, vat_code: code, zero_domestic_basis: basis });
  const fv = { ...original, data: { number: original.number, issue_date: '2026-10-10', sale_date: '2026-10-09', due_date: '2026-10-24',
    series_definition: { notes: '', payment_instructions: 'Przelew 14 dni' },
    fiscal_snapshot: { currency: 'PLN', seller: party('Hurtownia S.A.', '8567346215', 'Przemysłowa 1', '00-950 Warszawa'), buyer: party('Odbiorca Sp. z o.o.', '5260250274', 'Handlowa 2', '31-000 Kraków'),
      lines: [line(1, 'item', 'Paleta A', '10', '12300', '123000', '100000', '23000', '23', null), line(2, 'item', 'Eksportowy zestaw', '2', '10000', '20000', '20000', '0', '0 KR', 'art. 83 ust. 1 pkt 1 ustawy o VAT'),
        line(3, 'shipping', 'Transport', '1', '12300', '12300', '10000', '2300', '23', null)],
      totals: { gross_minor: '155300', net_minor: '130000', vat_minor: '25300' } } } } as unknown as B2bInvoiceDocument;
  return { fv: { id: fv.id, model: b2bInvoiceFa3Model(fv), rate: null, tax_date: '2026-10-09' },
    kor: { id: credit.id, model: b2bCorrectionFa3Model(credit, fv), rate: null, tax_date: '2026-10-21' }, nip: '8567346215' };
}

const NAMESPACES = new Set([JPK_V7M_NAMESPACE, JPK_V7K_NAMESPACE, JPK_ETD_NAMESPACE, JPK_FA_NAMESPACE, JPK_FA_ETD_NAMESPACE]);
/** All element texts by local name; DTD and foreign namespaces refused. */
export function jpkValues(xml: string): Record<string, string[]> {
  const result: Record<string, string[]> = {}, stack: string[] = [], text: string[] = [];
  const p = new SaxesParser({ xmlns: true });
  p.on('doctype', () => { throw new Error('DTD forbidden in test parser'); });
  p.on('opentag', t => { if (!NAMESPACES.has(t.uri)) throw new Error('foreign namespace ' + t.uri); stack.push(t.local); text.push(''); });
  p.on('text', t => { text[text.length - 1] += t; });
  p.on('closetag', () => { const n = stack.pop()!, v = text.pop()!; (result[n] ??= []).push(v); });
  p.write(xml).close(); return result;
}
/** Rows (SprzedazWiersz / FakturaWiersz / Faktura) as maps of child texts. */
export function jpkRecords(xml: string, element: string): Record<string, string>[] {
  const out: Record<string, string>[] = [], p = new SaxesParser({ xmlns: true });
  let current: Record<string, string> | null = null, depth = 0, field = '', value = '';
  p.on('opentag', t => { if (t.local === element) { current = {}; depth = 0; } else if (current) { depth++; field = t.local; value = ''; } });
  p.on('text', t => { value += t; });
  p.on('closetag', t => { if (t.local === element && current) { out.push(current); current = null; } else if (current) { if (depth === 1) current[field] = value; depth--; } });
  p.write(xml).close(); return out;
}
/** Grosze from a JPK amount text. */
export const minorOf = (v: string | undefined) => {
  if (v === undefined) return 0n;
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(v); if (!m) throw new Error('amount ' + v);
  const n = BigInt(m[2]!) * 100n + BigInt(m[3]!); return m[1] ? -n : n;
};

/** 233: two daily reports of October (register DYN23300001) covering all five customary PTU letters. */
export const dailyReports = (): JpkReceiptSales => ({ unreported: [], reports: [
  { id: id(20), printer_unique_number: 'DYN23300001', fiscal_date: '2026-10-24', report_number: '0001', matches: true, printer_receipts: 3, app_receipts: 3, totals: [
    { ptu: 'A', value: '23', conflict: false, gross_minor: 24600n, vat_minor: 4600n }, { ptu: 'B', value: '8', conflict: false, gross_minor: 10800n, vat_minor: 800n },
    { ptu: 'E', value: 'zw', conflict: false, gross_minor: 5000n, vat_minor: 0n }] },
  { id: id(21), printer_unique_number: 'DYN23300001', fiscal_date: '2026-10-25', report_number: '0002', matches: true, printer_receipts: 2, app_receipts: 2, totals: [
    { ptu: 'A', value: '23', conflict: false, gross_minor: 12300n, vat_minor: 2300n }, { ptu: 'C', value: '5', conflict: false, gross_minor: 2100n, vat_minor: 100n },
    { ptu: 'D', value: '0', conflict: false, gross_minor: 1000n, vat_minor: 0n }] },
] });
/** Invoice issued on 26.10 to receipt 000002 of 24.10 (art. 106b ust. 1 pkt 4): FP in JPK_V7. */
export function fvFp(): JpkDocument {
  const d = local(invoice(9, 'FV-S/2026/000001', '2026-10-24', '2026-10-26'));
  return { ...d, tax_date: '2026-10-26', model: { ...d.model, receipt: { number: '000002', fiscal_date: '2026-10-24', printer_unique_number: 'DYN23300001' } } };
}
