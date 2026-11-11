/** Pure mapping of the app's issued documents onto the normalized FA(3) model:
 * consumer FV (157), consumer corrections (188 and 206/207) and B2B corrections (160).
 * The B2B FV (159) keeps its own exporter in fa3-xml.ts. Input documents are the
 * immutable snapshots returned by the native detail reads; nothing is recomputed
 * except sums that are cross-checked against the stored totals. */
import type { LocalInvoiceDocument } from './local-invoices';
import type { ConsumerCreditDocument, ConsumerCreditRow } from './local-consumer-credit-values';
import type { ReturnCredit206Document } from './return-credit206-values';
import type { B2bCreditDocument } from './b2b-credit-values';
import type { B2bInvoiceDocument } from './b2b-invoice-values';
import {
  FA3_UNTAXED, fa3Buckets, fa3Invalid, fa3Minor, fa3Refuse,
  type Fa3Bucket, type Fa3Document, type Fa3Line, type Fa3Party, type Fa3RateCode,
} from './fa3-render';

/** Per-line tax facts of migration 226 (tax226_document_lines), in document line order. */
export type Fa3TaxSnapshot = {
  mpp_required: boolean;
  lines: { line_no: number; kind: 'item' | 'shipping'; item_id: string | null; category: 'standard' | 'zw' | 'np' | 'oo'; rate: string | null;
    rate_code: string; exemption_basis_kind: 'P_19A' | 'P_19B' | 'P_19C' | null; exemption_basis: string | null; gtu: string | null; annex15: boolean }[];
};
/** NBP rate record of a foreign-currency document (migration 227, nbp227_document_rates/_vat). */
export type Fa3DocumentRate = { currency: string; mid: string; vat: { vat_rate: number; net_minor: bigint; vat_minor: bigint; vat_pln_minor: bigint; net_pln_minor?: bigint }[];
  /** Stored PLN net of untaxed codes (KOR-S 232: signed differences at the corrected invoice's mid). */ untaxed_pln?: { code: string; net_pln_minor: bigint }[] };
export const FA3_SYSTEM_INFO = 'DYNAMINDS lokalny eksport FA(3)';
/** Corrections of returned goods reduce the tax base in the period of the correction (art. 29a ust. 13). */
const RETURN_CORRECTION_TYPE = 2;

type TaxLine = { code: Fa3RateCode; oss_rate: string | null; gtu: string | null; annex15: boolean; exemption: { kind: 'P_19A' | 'P_19B' | 'P_19C'; text: string } | null };
const ordinaryCode = (rate: number): Fa3RateCode => {
  if (![0, 5, 8, 23].includes(rate)) fa3Refuse(`Stawka VAT ${rate}% nie ma kodu FA(3) w tej aplikacji`);
  return rate === 0 ? '0 KR' : (String(rate) as Fa3RateCode);
};
/** Tax facts of one original line: the 226 snapshot when present, else the ordinary rate of the line. */
function lineTax(tax: Fa3TaxSnapshot | null, index: number, line: { kind: string; item_id: string | null; vat_rate: number }): TaxLine {
  if (!tax) return { code: ordinaryCode(line.vat_rate), oss_rate: null, gtu: null, annex15: false, exemption: null };
  const t = tax.lines[index];
  if (!t || t.line_no !== index + 1 || t.kind !== line.kind || t.item_id !== line.item_id) fa3Invalid('Migawka podatkowa 226 nie odpowiada pozycjom dokumentu');
  if (t.category === 'standard') {
    if (t.rate_code === 'oss') return { code: 'oss', oss_rate: t.rate!, gtu: t.gtu, annex15: t.annex15, exemption: null };
    if (t.rate !== Number(line.vat_rate).toFixed(2) || t.rate_code !== ordinaryCode(line.vat_rate)) fa3Invalid('Stawka z migawki 226 różni się od stawki pozycji');
    return { code: t.rate_code as Fa3RateCode, oss_rate: null, gtu: t.gtu, annex15: t.annex15, exemption: null };
  }
  if (!['zw', 'np I', 'np II', 'oo'].includes(t.rate_code)) fa3Invalid('Nieznany kod stawki w migawce 226');
  const exemption = t.category === 'zw' ? { kind: t.exemption_basis_kind ?? fa3Invalid('ZW bez rodzaju podstawy'), text: t.exemption_basis ?? fa3Invalid('ZW bez podstawy prawnej') } : null;
  return { code: t.rate_code as Fa3RateCode, oss_rate: null, gtu: t.gtu, annex15: t.annex15, exemption };
}
/** One FA(3) document carries one exemption basis (P_19A, P_19B or P_19C). */
function exemptionOf(lines: readonly TaxLine[]) {
  const all = lines.map(l => l.exemption).filter((e): e is NonNullable<TaxLine['exemption']> => e !== null);
  if (new Set(all.map(e => e.kind + '\u0000' + e.text)).size > 1)
    fa3Refuse('Pozycje zwolnione mają różne podstawy zwolnienia; FA(3) przyjmuje jedną podstawę na fakturę');
  return all[0] ?? null;
}
const reverseCharge = (codes: readonly Fa3RateCode[]) => codes.some(c => c === 'oo' || c === 'np II');
function untaxedHasNoVat(code: Fa3RateCode, vat: bigint) {
  if (FA3_UNTAXED.has(code) && vat !== 0n) fa3Invalid(`Pozycja ${code} ma naliczony VAT — niespójna migawka dokumentu`);
}
const consumerParty = (b: LocalInvoiceDocument['data']['buyer']): Fa3Party =>
  ({ nip: null, name: b.name, address: { country: b.address.country, line1: b.address.street, line2: `${b.address.postal_code} ${b.address.city}` } });
const sellerParty = (s: LocalInvoiceDocument['data']['seller']): Fa3Party =>
  ({ nip: s.tax_id, name: s.name, address: { country: s.country, line1: s.street, line2: `${s.postal_code} ${s.city}` } });
const blankLine = { uu_id: null, fx_rate: null, before: false, note: null, unit_gross_minor: null, discount_gross_minor: null } as const;

function checkLocalInvoice(doc: LocalInvoiceDocument) {
  const d = doc?.data;
  if (!d || doc.kind !== 'invoice' || doc.mode !== 'local_invoice' || d.number !== doc.number || d.buyer?.kind !== 'consumer' || !Array.isArray(d.lines) || !d.lines.length)
    fa3Invalid('Niepełna migawka lokalnej faktury');
  return d;
}

/** Consumer FV (157). `tax` = its 226 snapshot or null, `rate` = its 227 NBP record or null. */
export function localInvoiceFa3Model(doc: LocalInvoiceDocument, tax: Fa3TaxSnapshot | null, rate: Fa3DocumentRate | null): Fa3Document {
  const d = checkLocalInvoice(doc), foreign = d.currency !== 'PLN';
  if (foreign && !rate) fa3Refuse(`Faktura w walucie ${d.currency} wymaga zapisanego kursu NBP dokumentu (migracja 227)`);
  if (rate && rate.currency !== d.currency) fa3Invalid('Kurs NBP dokumentu dotyczy innej waluty');
  if (tax && tax.lines.length !== d.lines.length) fa3Invalid('Migawka podatkowa 226 nie odpowiada pozycjom dokumentu');
  let gross = 0n, net = 0n, vat = 0n;
  const taxes = d.lines.map((l, i) => lineTax(tax, i, l));
  const rows = d.lines.map((l, i) => {
    const t = taxes[i], g = fa3Minor(l.gross_minor, 'brutto'), n = fa3Minor(l.net_minor, 'netto'), v = fa3Minor(l.vat_minor, 'VAT');
    if (n + v !== g) fa3Invalid('Kwoty pozycji nie sumują się');
    untaxedHasNoVat(t.code, v);
    gross += g; net += n; vat += v;
    const unit = fa3Minor(l.unit_gross_minor, 'cena'), discount = fa3Minor(l.discount_gross_minor, 'rabat');
    // A rounding remainder makes quantity × price − discount differ from the line value:
    // the price fields are then left out rather than stating a price the line does not have.
    const exact = unit * BigInt(l.quantity) - discount === g;
    const line: Fa3Line = { ...blankLine, name: l.name, unit: l.unit, quantity: String(l.quantity), gross_minor: g, code: t.code, oss_rate: t.oss_rate,
      gtu: t.gtu, annex15: t.annex15, fx_rate: rate ? rate.mid : null, unit_gross_minor: exact ? unit : null, discount_gross_minor: exact ? discount : null };
    return { line, code: t.code, net_minor: n, vat_minor: v };
  });
  if (gross !== fa3Minor(d.totals.gross_minor, 'suma') || net !== fa3Minor(d.totals.net_minor, 'suma') || vat !== fa3Minor(d.totals.vat_minor, 'suma'))
    fa3Invalid('Pozycje nie sumują się do zapisanych sum faktury');
  let buckets: Fa3Bucket[] = fa3Buckets(rows);
  if (rate) buckets = buckets.map(b => {
    if (!['23', '8', '5'].includes(b.code)) return b;
    const r = rate.vat.find(x => String(x.vat_rate) === b.code);
    if (!r || r.net_minor !== b.net_minor || r.vat_minor !== b.vat_minor) fa3Invalid('Rekord kursu NBP nie odpowiada kwotom stawki ' + b.code);
    return { ...b, vat_pln_minor: r!.vat_pln_minor };
  });
  const footer = [d.series.notes, d.series.payment_instructions].filter(v => typeof v === 'string' && v.length > 0);
  return { kind: 'VAT', number: doc.number, issue_date: d.issue_date, sale_date: d.sell_date, currency: d.currency,
    seller: sellerParty(d.seller), buyer: consumerParty(d.buyer), buckets, total_gross_minor: gross,
    reverse_charge: reverseCharge(taxes.map(t => t.code)), split_payment: Boolean(tax?.mpp_required), exemption: exemptionOf(taxes),
    correction: null, lines: rows.map(r => r.line), due_date: d.due_date, footer, system_info: FA3_SYSTEM_INFO };
}

type CorrectionRow = { code: Fa3RateCode; before: { quantity: string; gross_minor: bigint }; after: { quantity: string; gross_minor: bigint };
  delta: { net_minor: bigint; vat_minor: bigint; gross_minor: bigint }; name: string; unit: string; uu_id: string | null; tax: TaxLine; note: Fa3Line['note'] };
/** Before/after rows of the affected positions; P_13/P_14 and P_15 are the signed differences. */
function correctionModel(input: { number: string; issue_date: string; reason: string; seller: Fa3Party; buyer: Fa3Party; split_payment: boolean;
  original: { number: string; issue_date: string; ksef_number: string | null }; rows: CorrectionRow[]; total_delta: { net_minor: bigint; vat_minor: bigint; gross_minor: bigint } }): Fa3Document {
  const affected = input.rows;
  const sum = (k: 'net_minor' | 'vat_minor' | 'gross_minor') => affected.reduce((n, r) => n + r.delta[k], 0n);
  if (sum('net_minor') !== input.total_delta.net_minor || sum('vat_minor') !== input.total_delta.vat_minor || sum('gross_minor') !== input.total_delta.gross_minor)
    fa3Invalid('Różnice pozycji nie sumują się do różnicy korekty');
  for (const r of affected) { if (r.delta.net_minor + r.delta.vat_minor !== r.delta.gross_minor) fa3Invalid('Różnica pozycji nie sumuje się'); untaxedHasNoVat(r.code, r.delta.vat_minor); }
  const lines: Fa3Line[] = affected.flatMap(r => {
    const common = { ...blankLine, name: r.name, unit: r.unit, code: r.code, oss_rate: r.tax.oss_rate, uu_id: r.uu_id, gtu: r.tax.gtu, annex15: r.tax.annex15 };
    return [{ ...common, quantity: r.before.quantity, gross_minor: r.before.gross_minor, before: true },
      { ...common, quantity: r.after.quantity, gross_minor: r.after.gross_minor, note: r.note }];
  });
  return { kind: 'KOR', number: input.number, issue_date: input.issue_date, sale_date: null, currency: 'PLN', seller: input.seller, buyer: input.buyer,
    buckets: fa3Buckets(affected.map(r => ({ code: r.code, net_minor: r.delta.net_minor, vat_minor: r.delta.vat_minor }))),
    total_gross_minor: input.total_delta.gross_minor, reverse_charge: reverseCharge(affected.map(r => r.code)), split_payment: input.split_payment,
    exemption: exemptionOf(affected.map(r => r.tax)), correction: { reason: input.reason, type: RETURN_CORRECTION_TYPE, original: input.original },
    lines, due_date: null, footer: [], system_info: FA3_SYSTEM_INFO };
}
const qty = (v: unknown) => { if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) fa3Invalid('Niepoprawna ilość w korekcie'); return v as string; };

/** Consumer correction: 188 (local_consumer_credit) or 206/207 (consumer_return_credit).
 * `originalTax` is the 226 snapshot of the corrected FV, when it has one; `originalKsef` its 229 KSeF number. */
export function consumerCreditFa3Model(doc: ConsumerCreditDocument | ReturnCredit206Document, originalTax: Fa3TaxSnapshot | null, originalKsef: string | null = null): Fa3Document {
  const s = doc?.data, c = s?.calculation, original = s?.original_document;
  if (!s || doc.kind !== 'correction' || !['local_consumer_credit', 'consumer_return_credit'].includes(doc.mode) || s.number !== doc.number || !c || !original ||
      original.id !== doc.original_document_id || c.original_document_id !== original.id || c.original_number !== original.number || !Array.isArray(c.rows))
    fa3Invalid('Niepełna migawka korekty konsumenckiej');
  if (c.currency !== 'PLN') fa3Refuse('Korekta konsumencka poza PLN nie jest obsługiwana');
  const o = checkLocalInvoice(original);
  if (o.currency !== 'PLN') fa3Refuse('Korekta faktury w walucie obcej nie jest obsługiwana');
  const rows = (c.rows as ConsumerCreditRow[]).filter(r => r.affected).map(r => {
    const line = o.lines[r.ordinal];
    if (!line || line.kind !== r.kind || line.item_id !== r.item_id || line.vat_rate !== r.vat_rate) fa3Invalid('Pozycja korekty nie odpowiada pozycji faktury');
    const tax = lineTax(originalTax, r.ordinal, line);
    return { code: tax.code, tax, name: line.name, unit: line.unit, uu_id: null, note: null,
      before: { quantity: qty(r.before.quantity), gross_minor: fa3Minor(r.before.gross_minor, 'przed') },
      after: { quantity: qty(r.after.quantity), gross_minor: fa3Minor(r.after.gross_minor, 'po') },
      delta: { net_minor: fa3Minor(r.delta.net_minor, 'różnica'), vat_minor: fa3Minor(r.delta.vat_minor, 'różnica'), gross_minor: fa3Minor(r.delta.gross_minor, 'różnica') } };
  });
  const t = c.totals.delta;
  return correctionModel({ number: doc.number, issue_date: s.issue_date, reason: s.reason, seller: sellerParty(o.seller), buyer: consumerParty(o.buyer),
    split_payment: Boolean(originalTax?.mpp_required), original: { number: original.number, issue_date: o.issue_date, ksef_number: originalKsef }, rows,
    total_delta: { net_minor: fa3Minor(t.net_minor, 'suma'), vat_minor: fa3Minor(t.vat_minor, 'suma'), gross_minor: fa3Minor(t.gross_minor, 'suma') } });
}

/** B2B correction (160) of a B2B FV (159); the original document gives the corrected issue date, `originalKsef` its 229 KSeF number. */
export function b2bCorrectionFa3Model(doc: B2bCreditDocument, original: B2bInvoiceDocument, originalKsef: string | null = null): Fa3Document {
  const s = doc?.data, c = s?.calculation;
  if (!s || doc.kind !== 'correction' || doc.mode !== 'b2b_correction' || s.number !== doc.number || !c || !Array.isArray(c.rows))
    fa3Invalid('Niepełna migawka korekty B2B');
  if (!original || original.id !== c.original.document_id || original.number !== c.original.number || original.mode !== 'b2b_invoice')
    fa3Invalid('Korekta B2B nie wskazuje tej faktury źródłowej');
  if (c.currency !== 'PLN') fa3Refuse('Korekta B2B poza PLN nie jest obsługiwana');
  const f = c.fiscal_snapshot, party = (p: typeof f.seller): Fa3Party => ({ nip: p.tax_id, name: p.name, address: { country: p.address.country, line1: p.address.line1, line2: p.address.line2 ?? null } });
  const rows = c.rows.filter(r => r.affected).map(r => {
    const code = r.vat_code as Fa3RateCode, tax: TaxLine = { code, oss_rate: null, gtu: null, annex15: false, exemption: null };
    return { code, tax, name: r.name, unit: r.unit, uu_id: r.line_id,
      note: r.zero_domestic_basis === null ? null : { key: 'Podstawa krajowej stawki 0%', value: r.zero_domestic_basis },
      before: { quantity: qty(r.before.quantity), gross_minor: fa3Minor(r.before.gross_minor, 'przed') },
      after: { quantity: qty(r.after.quantity), gross_minor: fa3Minor(r.after.gross_minor, 'po') },
      delta: { net_minor: fa3Minor(r.delta.net_minor, 'różnica'), vat_minor: fa3Minor(r.delta.vat_minor, 'różnica'), gross_minor: fa3Minor(r.delta.gross_minor, 'różnica') } };
  });
  const t = c.totals.delta;
  return correctionModel({ number: doc.number, issue_date: s.issue_date, reason: s.reason, seller: party(f.seller), buyer: party(f.buyer), split_payment: false,
    original: { number: original.number, issue_date: original.data.issue_date, ksef_number: originalKsef }, rows,
    total_delta: { net_minor: fa3Minor(t.net_minor, 'suma'), vat_minor: fa3Minor(t.vat_minor, 'suma'), gross_minor: fa3Minor(t.gross_minor, 'suma') } });
}

/** B2B FV (159) as normalized facts. Its XML keeps the own exporter in fa3-xml.ts; these facts
 * feed the JPK files. The native snapshot is PLN, ordinary domestic rates only (23/8/5/0 KR). */
export function b2bInvoiceFa3Model(doc: B2bInvoiceDocument): Fa3Document {
  const s = doc?.data, f = s?.fiscal_snapshot;
  if (!s || doc.kind !== 'invoice' || doc.mode !== 'b2b_invoice' || s.number !== doc.number || !f || !Array.isArray(f.lines) || !f.lines.length)
    fa3Invalid('Niepełna migawka faktury B2B');
  if (f.currency !== 'PLN') fa3Refuse('Faktura B2B poza PLN nie jest obsługiwana');
  const party = (p: typeof f.seller): Fa3Party => ({ nip: p.tax_id, name: p.name, address: { country: p.address.country, line1: p.address.line1, line2: p.address.line2 ?? null } });
  let gross = 0n;
  const rows = f.lines.map(l => {
    const code = l.vat_code as Fa3RateCode, g = fa3Minor(l.gross_minor, 'brutto'), n = fa3Minor(l.net_minor, 'netto'), v = fa3Minor(l.vat_minor, 'VAT');
    if (!['23', '8', '5', '0 KR'].includes(code)) fa3Invalid('Nieznana stawka faktury B2B');
    if (n + v !== g) fa3Invalid('Kwoty pozycji nie sumują się');
    untaxedHasNoVat(code, v);
    gross += g;
    const unit = fa3Minor(l.unit_gross_minor, 'cena'), discount = fa3Minor(l.discount_gross_minor, 'rabat'), exact = l.rounding_gross_minor === '0';
    const line: Fa3Line = { ...blankLine, name: l.name, unit: l.unit, quantity: l.quantity, gross_minor: g, code, oss_rate: null, gtu: null, annex15: false,
      uu_id: l.line_id, unit_gross_minor: exact ? unit : null, discount_gross_minor: exact ? discount : null,
      note: l.zero_domestic_basis === null ? null : { key: 'Podstawa krajowej stawki 0%', value: l.zero_domestic_basis } };
    return { line, code, net_minor: n, vat_minor: v };
  });
  if (gross !== fa3Minor(f.totals.gross_minor, 'suma')) fa3Invalid('Pozycje nie sumują się do zapisanych sum faktury');
  const footer = [s.series_definition.notes, s.series_definition.payment_instructions].filter(v => typeof v === 'string' && v.length > 0);
  return { kind: 'VAT', number: doc.number, issue_date: s.issue_date, sale_date: s.sale_date, currency: 'PLN', seller: party(f.seller), buyer: party(f.buyer),
    buckets: fa3Buckets(rows), total_gross_minor: gross, reverse_charge: false, split_payment: false, exemption: null, correction: null,
    lines: rows.map(r => r.line), due_date: s.due_date, footer, system_info: FA3_SYSTEM_INFO };
}
