/** Deterministic snapshot fixtures for FA(3) documents (shapes as stored by 157/188/206/159/160). */
import { SaxesParser } from 'saxes';
import type { LocalInvoiceDocument } from '../server/local-invoices';
import type { ConsumerCreditDocument } from '../server/local-consumer-credit-values';
import type { B2bCreditDocument } from '../server/b2b-credit-values';
import type { B2bInvoiceDocument } from '../server/b2b-invoice-values';
import type { Fa3TaxSnapshot } from '../server/fa3-adapters';

export const GENERATED_AT = '2026-10-20T09:15:00.123456Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Line = LocalInvoiceDocument['data']['lines'][number];
const line = (n: number, kind: 'item' | 'shipping', name: string, quantity: number, unit: string, discount: string, rounding: string, vat_rate: number, gross: string, net: string, vat: string): Line => ({
  item_id: kind === 'item' ? id(100 + n) : null, product_id: kind === 'item' ? id(200 + n) : null, kind, sku: kind === 'item' ? 'SKU-' + n : '', name, quantity,
  unit: kind === 'item' ? 'szt.' : 'usł.', unit_gross_minor: unit, discount_gross_minor: discount, rounding_gross_minor: rounding, vat_rate, gross_minor: gross, net_minor: net, vat_minor: vat,
});

/** Consumer FV: 23% with a rounding remainder, 8% with a discount, 5%, 0% and 23% shipping. */
export function consumerInvoice(): LocalInvoiceDocument {
  const lines = [
    line(1, 'item', 'Kubek & <spodek>', 2, '1700', '0', '1', 23, '3401', '2765', '636'),
    line(2, 'item', 'Książka', 1, '5400', '400', '0', 8, '5000', '4630', '370'),
    line(3, 'item', 'Gazeta', 3, '700', '0', '0', 5, '2100', '2000', '100'),
    line(4, 'item', 'Bon', 1, '1000', '0', '0', 0, '1000', '1000', '0'),
    line(5, 'shipping', 'Dostawa', 1, '1230', '0', '0', 23, '1230', '1000', '230'),
  ];
  const number = 'FV/LOK/2026/000042';
  return { id: id(1), order_id: id(2), number, kind: 'invoice', mode: 'local_invoice', created_at: '2026-10-20T09:15:00.123456Z', data: {
    order: { id: id(2), number: 'ZAM-42', version: '6', status: 'shipped', currency: 'PLN', total_minor: '12731', shipping_cost_minor: '1230', payment_mode: 'prepaid' },
    seller: { name: 'Sklep Testowy Sp. z o.o.', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: '5260250274' },
    buyer: { kind: 'consumer', tax_id: '', name: 'Jan Kowalski', email: 'jan@example.test', address: { street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' } },
    series: { id: id(3), name: 'Konsumenci', prefix: 'LOK', payment_terms_days: 7, payment_instructions: 'Przelew na rachunek sklepu', notes: 'Dziękujemy za zakupy' },
    currency: 'PLN', lines, totals: { gross_minor: '12731', net_minor: '11395', vat_minor: '1336' },
    vat_totals: [], rounding_method: 'gross_line_half_up', tax_regime: 'ordinary_domestic', consumer_sale_confirmed: true,
    no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true, sell_date: '2026-10-18', issue_date: '2026-10-20', due_date: '2026-10-27', year: 2026,
    number, preview_id: id(4), scope_hash: 'a'.repeat(64), local_only: true, ksef_state: 'not_submitted', fiscalized: false,
  } };
}
/** 226 snapshot for consumerInvoice() lines, ordinary rates; callers override single lines. */
export function taxSnapshot(doc: LocalInvoiceDocument): Fa3TaxSnapshot {
  return { mpp_required: false, lines: doc.data.lines.map((l, i) => ({ line_no: i + 1, kind: l.kind, item_id: l.item_id, category: 'standard' as const,
    rate: l.vat_rate.toFixed(2), rate_code: l.vat_rate === 0 ? '0 KR' : String(l.vat_rate), exemption_basis_kind: null, exemption_basis: null, gtu: null, annex15: false })) };
}
/** Make line i untaxed (zero VAT on the stored line, as a 226-aware issue would store it). */
export function untaxed(doc: LocalInvoiceDocument, i: number) {
  const l = doc.data.lines[i], t = doc.data.totals;
  t.net_minor = String(BigInt(t.net_minor) + BigInt(l.vat_minor)); t.vat_minor = String(BigInt(t.vat_minor) - BigInt(l.vat_minor));
  Object.assign(l, { vat_rate: 0, net_minor: l.gross_minor, vat_minor: '0' });
}

type Row = ConsumerCreditDocument['data']['calculation']['rows'][number];
const m = (q: string, g: string, n: string, v: string) => ({ quantity: q, gross_minor: g, net_minor: n, vat_minor: v });
/** 188 correction of consumerInvoice(): one of two mugs (23%), the book fully (8%), shipping refunded (23%). */
export function consumerCredit(original = consumerInvoice()): ConsumerCreditDocument {
  const o = original.data.lines;
  const rows: Row[] = o.map((l, i) => ({ ordinal: i, kind: l.kind, item_id: l.item_id, product_id: l.product_id, name: l.name, sku: l.sku, unit: l.unit, vat_rate: l.vat_rate,
    before: m(String(l.quantity), l.gross_minor, l.net_minor, l.vat_minor), after: m(String(l.quantity), l.gross_minor, l.net_minor, l.vat_minor), delta: m('0', '0', '0', '0'), affected: false }));
  const set = (i: number, after: ReturnType<typeof m>) => { const r = rows[i], b = r.before;
    rows[i] = { ...r, after, affected: true, delta: m(String(BigInt(after.quantity) - BigInt(b.quantity)), String(BigInt(after.gross_minor) - BigInt(b.gross_minor)),
      String(BigInt(after.net_minor) - BigInt(b.net_minor)), String(BigInt(after.vat_minor) - BigInt(b.vat_minor))) }; };
  set(0, m('1', '1700', '1382', '318')); set(1, m('0', '0', '0', '0')); set(4, m('1', '0', '0', '0'));
  const sum = (k: 'before' | 'after' | 'delta') => ({ gross_minor: String(rows.reduce((n, r) => n + BigInt(r[k].gross_minor), 0n)),
    net_minor: String(rows.reduce((n, r) => n + BigInt(r[k].net_minor), 0n)), vat_minor: String(rows.reduce((n, r) => n + BigInt(r[k].vat_minor), 0n)) });
  const number = 'KOR/LOK/2026/000007';
  return { id: id(10), order_id: original.order_id, original_document_id: original.id, return_id: id(11), kind: 'correction', mode: 'local_consumer_credit', number,
    created_at: '2026-10-22T08:00:00.000Z', data: { schema: 'local-consumer-credit/v1', original_document: original, reason: 'Zwrot towaru przez konsumenta', return_version: '3',
      issue_date: '2026-10-22', local_only: true, ksef_state: 'not_submitted', fiscalized: false, number, preview_id: id(12), scope_hash: 'b'.repeat(64), year: 2026, sequence: 7,
      calculation: { schema: 'local-consumer-credit-calculation/v1', currency: 'PLN', tax_method: 'gross_line_half_up', original_document_id: original.id, original_receipt_id: id(13),
        original_number: original.number, original_scope_hash: 'a'.repeat(64), return_id: id(11), return_receipt_id: id(14), receipt_sequence: 1, financial_hash: 'c'.repeat(64),
        previous_chain_hash: 'd'.repeat(64), rows, totals: { before: sum('before'), after: sum('after'), delta: sum('delta') }, vat_totals: [] } } };
}

/** 159 B2B FV (only the fields the correction export reads) and its 160 correction. */
export function b2bPair(): { original: B2bInvoiceDocument; credit: B2bCreditDocument } {
  const original = { id: id(30), order_id: id(31), kind: 'invoice', mode: 'b2b_invoice', number: 'FV-B2B/HURT/2026/000003', created_at: '2026-10-10T10:00:00.000Z',
    data: { issue_date: '2026-10-10' } } as unknown as B2bInvoiceDocument;
  const party = (name: string, nip: string, line1: string, line2: string) => ({ kind: 'business' as const, name, tax_id: nip, address: { country: 'PL' as const, line1, line2 } });
  const row = (ordinal: number, kind: 'item' | 'shipping', name: string, vat_code: '23' | '0 KR', basis: string | null, before: ReturnType<typeof m>, after: ReturnType<typeof m>) => ({
    ordinal, line_id: id(40 + ordinal), source_item_id: kind === 'item' ? id(50 + ordinal) : null, kind, name, unit: kind === 'item' ? 'szt.' : 'usł.', vat_code, zero_domestic_basis: basis,
    affected: before.gross_minor !== after.gross_minor || before.quantity !== after.quantity, before, after,
    delta: m(String(BigInt(after.quantity) - BigInt(before.quantity)), String(BigInt(after.gross_minor) - BigInt(before.gross_minor)),
      String(BigInt(after.net_minor) - BigInt(before.net_minor)), String(BigInt(after.vat_minor) - BigInt(before.vat_minor))) });
  const rows = [row(1, 'item', 'Paleta A', '23', null, m('10', '123000', '100000', '23000'), m('7', '86100', '70000', '16100')),
    row(2, 'item', 'Eksportowy zestaw', '0 KR', 'art. 83 ust. 1 pkt 1 ustawy o VAT', m('2', '20000', '20000', '0'), m('1', '10000', '10000', '0')),
    row(3, 'shipping', 'Transport', '23', null, m('1', '12300', '10000', '2300'), m('1', '12300', '10000', '2300'))];
  const total = (k: 'before' | 'after' | 'delta') => ({ net_minor: String(rows.reduce((n, r) => n + BigInt(r[k].net_minor), 0n)),
    vat_minor: String(rows.reduce((n, r) => n + BigInt(r[k].vat_minor), 0n)), gross_minor: String(rows.reduce((n, r) => n + BigInt(r[k].gross_minor), 0n)) });
  const number = 'KOR-B2B/HURT/2026/000001';
  const credit = { id: id(60), order_id: id(31), return_id: id(61), kind: 'correction', mode: 'b2b_correction', number, created_at: '2026-10-21T12:00:00.000000Z',
    data: { schema: 'b2b-local-correction/v1', original_document_id: original.id, issue_date: '2026-10-21', reason: 'Zwrot części dostawy', number,
      calculation: { currency: 'PLN', original: { document_id: original.id, number: original.number },
        fiscal_snapshot: { seller: party('Hurtownia S.A.', '8567346215', 'Przemysłowa 1', '00-950 Warszawa'), buyer: party('Odbiorca Sp. z o.o.', '5260250274', 'Handlowa 2', '31-000 Kraków') },
        rows, totals: { before: total('before'), after: total('after'), delta: total('delta') } } } } as unknown as B2bCreditDocument;
  return { original, credit };
}

/** All element texts by local name (DTD forbidden). */
export function xmlValues(xml: string): Record<string, string[]> {
  const result: Record<string, string[]> = {}, stack: string[] = [], text: string[] = [];
  const p = new SaxesParser({ xmlns: true });
  p.on('doctype', () => { throw new Error('DTD forbidden in test parser'); });
  p.on('opentag', t => { if (t.uri !== 'http://crd.gov.pl/wzor/2025/06/25/13775/') throw new Error('foreign namespace ' + t.uri); stack.push(t.local); text.push(''); });
  p.on('text', t => { text[text.length - 1] += t; });
  p.on('closetag', () => { const n = stack.pop()!, v = text.pop()!; (result[n] ??= []).push(v); });
  p.write(xml).close(); return result;
}
