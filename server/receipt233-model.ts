/** Pure rules of fiscal receipts (233), no IO. A receipt documents a B2C sale registered on a fiscal
 * printer (kasa fiskalna online). Line amounts use the invoice math of 157/230 (per line from the gross
 * amount, VAT = gross × r / (100 + r) half up, net = gross − VAT, ZW with VAT 0); the PTU letter of a
 * line is the letter the printer's PTU table assigns to its rate. A receipt with the buyer's NIP and a
 * total of at most 450 zł is a simplified invoice (art. 106e ust. 5 pkt 3 ustawy o VAT); an invoice
 * to a receipt for a business requires the NIP on the receipt (art. 106b ust. 5).
 * Design: docs/parity/RECEIPTS233-20261025.md. */
import { z } from 'zod';
import { invoiceMath, nipValid, normalizeNip, type InvoiceMath, type SourceLine } from './invoice230-model';
import type { OssState } from './tax226-model';

export const PTU_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type PtuLetter = (typeof PTU_LETTERS)[number];
/** What a PTU letter is programmed to: a VAT rate in percent, 'zw' (sprzedaż zwolniona) or null (not used). */
export type PtuValue = '23' | '8' | '5' | '0' | 'zw' | null;
export type PtuTable = Readonly<Record<PtuLetter, PtuValue>>;
/** The customary programming of Polish fiscal printers: A 23%, B 8%, C 5%, D 0%, E zwolnione; F and G unused. */
export const DEFAULT_PTU_TABLE: PtuTable = Object.freeze({ A: '23', B: '8', C: '5', D: '0', E: 'zw', F: null, G: null });
/** Rate code of a 226/230 line → value of a PTU letter. NP I/NP II/OO/OSS have no PTU: they are not registered on a Polish cash register. */
export const PTU_VALUE_OF_RATE_CODE: Readonly<Record<string, Exclude<PtuValue, null>>> = Object.freeze({ '23': '23', '8': '8', '5': '5', '0 KR': '0', zw: 'zw' });

const ptuValue = z.enum(['23', '8', '5', '0', 'zw']).nullable();
export const ptuTableInput = z.strictObject({ A: ptuValue, B: ptuValue, C: ptuValue, D: ptuValue, E: ptuValue, F: ptuValue, G: ptuValue })
  .superRefine((t, ctx) => {
    const used = Object.values(t).filter(v => v !== null);
    if (new Set(used).size !== used.length) ctx.addIssue({ code: 'custom', message: 'Ta sama stawka PTU jest przypisana do dwóch liter' });
    if (!used.length) ctx.addIssue({ code: 'custom', message: 'Tabela PTU nie ma żadnej stawki' });
  });
/** Equal tables (the printer's programming against the configuration). */
export const samePtuTable = (a: PtuTable, b: PtuTable) => PTU_LETTERS.every(l => (a[l] ?? null) === (b[l] ?? null));
export function ptuLetterOf(table: PtuTable, rateCode: string): PtuLetter | null {
  const v = PTU_VALUE_OF_RATE_CODE[rateCode];
  if (!v) return null;
  return PTU_LETTERS.find(l => table[l] === v) ?? null;
}
export const ptuLabel = (v: PtuValue) => (v === null ? '—' : v === 'zw' ? 'zw' : `${v}%`);

/** Payment forms of a receipt (forma płatności printed on it). */
export const PAYMENT_FORMS = Object.freeze({
  gotowka: 'Gotówka', karta: 'Karta płatnicza', przelew: 'Przelew', mobilna: 'Płatność mobilna (BLIK)', pobranie: 'Pobranie u kuriera',
} as const);
export type PaymentForm = keyof typeof PAYMENT_FORMS;
export const PAYMENT_FORM_CODES = Object.keys(PAYMENT_FORMS) as [PaymentForm, ...PaymentForm[]];
/** The form proposed for an order: prepaid shop orders are paid by transfer, COD at the courier. */
export const defaultPaymentForm = (paymentMode: string): PaymentForm => (paymentMode === 'cod' ? 'pobranie' : 'przelew');

/** Art. 106e ust. 5 pkt 3: a receipt with the buyer's NIP up to 450 zł (or 100 EUR) is a simplified invoice. Receipts are PLN only. */
export const SIMPLIFIED_INVOICE_LIMIT_MINOR = 45_000n;
export const isSimplifiedInvoice = (buyerNip: string | null, grossMinor: bigint) => buyerNip !== null && grossMinor <= SIMPLIFIED_INVOICE_LIMIT_MINOR;
/** Optional buyer NIP given before the sale: '' or null = none; otherwise a valid NIP (PL prefix and dashes accepted). */
export const buyerNipInput = z.union([z.null(), z.string().max(20)]).transform((v, ctx) => {
  if (v === null || v.trim() === '') return null;
  const n = normalizeNip(v);
  if (!n) { ctx.addIssue({ code: 'custom', message: 'Niepoprawny NIP nabywcy' }); return z.NEVER; }
  return n;
});
export { nipValid };

const uuid = z.uuid().transform(v => v.toLowerCase());
export const receiptRequest = z.strictObject({
  client_key: uuid,
  payment_form: z.enum(PAYMENT_FORM_CODES, 'Wybierz formę płatności z listy'),
  buyer_nip: buyerNipInput.default(null),
  /** VAT of the shipping line when the goods do not decide it (as on the invoice). */
  shipping_vat: z.union([z.literal(0), z.literal(5), z.literal(8), z.literal(23)]).default(23),
  confirmed: z.literal(true, 'Potwierdź druk paragonu na drukarce fiskalnej'),
});
export type ReceiptRequest = z.infer<typeof receiptRequest>;

/** One receipt line: the order line, its quantity and unit price, the line value (gross after a discount)
 * with the invoice math, and its PTU letter. */
export type ReceiptLine = {
  line_no: number; kind: 'item' | 'shipping'; name: string; sku: string; quantity: number; unit_gross_minor: string; discount_gross_minor: string;
  gross_minor: string; net_minor: string; vat_minor: string; rate_code: string; ptu: PtuLetter;
};
export type PtuTotal = { ptu: PtuLetter; value: Exclude<PtuValue, null>; gross_minor: string; net_minor: string; vat_minor: string };
export type ReceiptMath = { lines: ReceiptLine[]; ptu_totals: PtuTotal[]; totals: { net_minor: string; vat_minor: string; gross_minor: string } };
/** Fiscal printers print a name of up to 40 characters; the same text is stored. */
export const RECEIPT_NAME_MAX = 40;
export function receiptName(name: string, sku: string): string {
  const base = (name.replace(/\s+/g, ' ').trim() || sku || 'Towar');
  return base.length <= RECEIPT_NAME_MAX ? base : base.slice(0, RECEIPT_NAME_MAX - 1).trimEnd() + '…';
}

export type ReceiptSourceLine = SourceLine & { quantity: number; unit_gross_minor: string };
/** Lines, PTU totals and the refusals of the receipt. The buyer is a Polish consumer (or a business that
 * gave a NIP): line categories are the 226 profiles seen from a PL buyer, the shipping follows the
 * goods as on the invoice. */
export function receiptMath(lines: readonly ReceiptSourceLine[], table: PtuTable, sellDate: string, oss: OssState | null): { math: ReceiptMath; blockers: string[] } {
  const buyer = { kind: 'consumer' as const, name: 'Paragon', address: { street: '-', postal_code: '00-000', city: '-', country: 'PL' }, tax_id: '', tax_id_kind: 'none' as const, pl_vat_payer: false };
  const d = invoiceMath({ buyer, currency: 'PLN', sell_date: sellDate, lines, oss });
  // A receipt has no P_19: several exemption bases on one receipt are allowed.
  const blockers = d.blockers.filter(b => !b.startsWith('Pozycje zwolnione mają różne podstawy'));
  return { ...ptuMath(d.math, lines, table, blockers), blockers };
}
function ptuMath(m: InvoiceMath, source: readonly ReceiptSourceLine[], table: PtuTable, blockers: string[]): { math: ReceiptMath } {
  const out: ReceiptLine[] = [], totals = new Map<PtuLetter, PtuTotal>();
  let net = 0n, vat = 0n;
  for (const l of m.lines) {
    const s = source[l.source_index]!, label = l.sku || l.name;
    if (!PTU_VALUE_OF_RATE_CODE[l.rate_code]) { blockers.push(`${label}: sprzedaż ${l.rate_code} nie jest ewidencjonowana na kasie fiskalnej (NP/OO/OSS)`); continue; }
    const ptu = ptuLetterOf(table, l.rate_code);
    if (!ptu) { blockers.push(`${label}: drukarka nie ma litery PTU dla stawki ${ptuLabel(PTU_VALUE_OF_RATE_CODE[l.rate_code]!)} — zaprogramuj ją w drukarce i w konfiguracji`); continue; }
    const q = BigInt(s.quantity), unit = BigInt(s.unit_gross_minor), gross = BigInt(l.gross_minor);
    out.push({ line_no: out.length + 1, kind: l.kind, name: receiptName(l.name, l.sku), sku: l.sku, quantity: s.quantity, unit_gross_minor: String(unit),
      discount_gross_minor: String(unit * q > gross ? unit * q - gross : 0n), gross_minor: l.gross_minor, net_minor: l.net_minor, vat_minor: l.vat_minor, rate_code: l.rate_code, ptu });
    const t = totals.get(ptu) ?? { ptu, value: table[ptu]!, gross_minor: '0', net_minor: '0', vat_minor: '0' };
    totals.set(ptu, { ...t, gross_minor: String(BigInt(t.gross_minor) + gross), net_minor: String(BigInt(t.net_minor) + BigInt(l.net_minor)), vat_minor: String(BigInt(t.vat_minor) + BigInt(l.vat_minor)) });
    net += BigInt(l.net_minor); vat += BigInt(l.vat_minor);
  }
  if (!out.length && !blockers.length) blockers.push('Paragon nie ma pozycji');
  return { math: { lines: out, ptu_totals: PTU_LETTERS.filter(l => totals.has(l)).map(l => totals.get(l)!), totals: { net_minor: String(net), vat_minor: String(vat), gross_minor: String(net + vat) } } };
}

/** Facts of the order that decide whether a receipt may be printed. */
export type ReceiptOrderFacts = {
  status: string; currency: string; fulfillment_kind: string; source: string; b2b: boolean; merged_into_other: boolean; delivery_country: string | null;
  invoices: string[]; total_minor: bigint;
};
export const RECEIPT_STATUSES = ['paid', 'picking', 'packed', 'shipped', 'delivered', 'completed'] as const;
/** Polish refusals (409); an order with refusals gets no receipt. */
export function receiptRefusals(f: ReceiptOrderFacts): string[] {
  const out: string[] = [];
  if (f.status === 'new') out.push('Paragon drukuje się po otrzymaniu zapłaty — zamówienie jest nieopłacone');
  else if (f.status === 'cancelled') out.push('Zamówienie jest anulowane');
  else if (!(RECEIPT_STATUSES as readonly string[]).includes(f.status)) out.push('Zamówienie ma zwrot — paragon do zamówienia ze zwrotem nie jest obsługiwany');
  if (f.fulfillment_kind !== 'sale') out.push('Zamówienie nie jest sprzedażą (np. wymiana lub wysyłka zastępcza)');
  if (f.merged_into_other) out.push('Zamówienie zostało scalone z innym — paragon drukuje się na zamówieniu docelowym');
  if (f.currency !== 'PLN') out.push(`Paragon fiskalny jest w PLN — zamówienie jest w ${f.currency}`);
  if (f.delivery_country !== null && f.delivery_country !== 'PL') out.push(`Sprzedaż wysyłkowa do konsumenta poza Polską (${f.delivery_country}) nie jest ewidencjonowana na kasie w tej wersji (OSS/eksport)`);
  if (f.b2b) out.push('Zamówienie B2B dokumentuje się fakturą, nie paragonem');
  if (f.invoices.length) out.push(`Zamówienie ma już fakturę ${f.invoices.join(', ')} — sprzedaż jest udokumentowana fakturą`);
  if (f.total_minor <= 0n) out.push('Zamówienie nie ma kwoty do zapłaty');
  return out;
}

/** Receipt job states: queued → sent → printed | failed; failed → queued on a retry. */
export const RECEIPT_STATES = ['queued', 'sent', 'printed', 'failed'] as const;
export type ReceiptState = (typeof RECEIPT_STATES)[number];
const TRANSITIONS: Readonly<Record<ReceiptState, readonly ReceiptState[]>> = Object.freeze({ queued: ['sent'], sent: ['printed', 'failed'], failed: ['queued'], printed: [] });
export const canTransition = (from: ReceiptState, to: ReceiptState) => TRANSITIONS[from].includes(to);
export function transition(from: ReceiptState, to: ReceiptState): ReceiptState {
  if (!canTransition(from, to)) throw new Error(`Niedozwolona zmiana stanu paragonu: ${from} → ${to}`);
  return to;
}
export const RECEIPT_STATE_LABELS: Readonly<Record<ReceiptState, string>> = Object.freeze({ queued: 'W kolejce', sent: 'Wysłany do drukarki', printed: 'Wydrukowany', failed: 'Błąd druku' });

/** Errors a fiscal printer driver reports; each has its Polish message and whether a retry may help. */
export const PRINTER_ERRORS = Object.freeze({
  PAPER_OUT: { message: 'Brak papieru w drukarce fiskalnej — włóż rolkę i ponów druk', retry: true },
  OFFLINE: { message: 'Drukarka fiskalna nie odpowiada (offline) — sprawdź zasilanie i połączenie, potem ponów druk', retry: true },
  PTU_MISMATCH: { message: 'Stawki PTU w drukarce nie zgadzają się z konfiguracją — popraw konfigurację albo programowanie drukarki', retry: true },
  TOTAL_MISMATCH: { message: 'Drukarka wyliczyła inną sumę paragonu — paragon anulowano', retry: true },
  PROTOCOL: { message: 'Drukarka odpowiada nieobsługiwanym protokołem', retry: false },
  PRINTER_ERROR: { message: 'Drukarka fiskalna zgłosiła błąd', retry: true },
} as const);
export type PrinterErrorCode = keyof typeof PRINTER_ERRORS;
export const PRINTER_ERROR_CODES = Object.keys(PRINTER_ERRORS) as [PrinterErrorCode, ...PrinterErrorCode[]];

/** Invoice to a receipt (faktura do paragonu): Polish refusals, empty when the invoice may be linked. */
export function invoiceToReceiptRefusals(receipt: { state: ReceiptState; number: string | null; buyer_nip: string | null; gross_minor: bigint },
  invoice: { buyer_kind: 'consumer' | 'business'; buyer_tax_id_kind: 'nip' | 'eu_vat' | 'none'; buyer_tax_id: string; gross_minor: bigint }): string[] {
  if (receipt.state === 'queued' || receipt.state === 'sent') return ['Paragon tego zamówienia jest w trakcie druku — poczekaj na wynik druku przed wystawieniem faktury'];
  if (receipt.state !== 'printed') return [];
  const out: string[] = [];
  if (invoice.buyer_kind === 'business') {
    if (receipt.buyer_nip === null) out.push(`Paragon ${receipt.number} nie zawiera NIP nabywcy — faktury dla firmy do tego paragonu nie można wystawić (art. 106b ust. 5 ustawy o VAT)`);
    else if (invoice.buyer_tax_id_kind !== 'nip' || invoice.buyer_tax_id !== receipt.buyer_nip) out.push(`NIP nabywcy faktury jest inny niż NIP na paragonie ${receipt.number} (${receipt.buyer_nip})`);
  }
  if (invoice.gross_minor !== receipt.gross_minor) out.push(`Kwota faktury różni się od kwoty paragonu ${receipt.number} — faktura do paragonu dokumentuje tę samą sprzedaż`);
  return out;
}
