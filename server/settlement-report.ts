/** Settlement report (Stage 3 finance): per-order reconciliation of payments,
 * invoices, corrections and return credits, in integer minor units (grosze).
 * Pure arithmetic only — the database facts are loaded by settlement-report-data.ts.
 * The payment side mirrors the order card balance (order-merge-payments.ts balance()):
 * received = receipt + courier_collection, refunded = refund, reversals keep the kind
 * of the reversed entry, nominal = total − (return credit + cancelled credit), 0 when
 * the order is cancelled. Amounts in a currency other than the order currency are
 * never added to the order figures; they are reported separately per currency. */
import { z } from 'zod';
import { Problem } from './errors';

export const SETTLEMENT_LIMITS = { days: 366, orders: 2000 } as const;
export const settlementCurrencies = ['PLN', 'EUR', 'USD', 'GBP', 'CZK'] as const;

const calendarDate = z
  .string({ error: 'Podaj datę w formacie RRRR-MM-DD' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Podaj datę w formacie RRRR-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Niepoprawna data kalendarzowa');
const querySchema = z
  .strictObject({
    from: calendarDate,
    to: calendarDate,
    currency: z.enum(settlementCurrencies, { error: 'Nieobsługiwana waluta' }).optional(),
  })
  .refine((q) => q.from <= q.to, 'Data początkowa jest późniejsza niż końcowa')
  .refine(
    (q) => (Date.parse(q.to) - Date.parse(q.from)) / 86400000 + 1 <= SETTLEMENT_LIMITS.days,
    `Zakres może obejmować najwyżej ${SETTLEMENT_LIMITS.days} dni`,
  );
export type SettlementQuery = z.infer<typeof querySchema>;
/** Query validation with a Polish 400 (not the generic 422 of the app handler). */
export function parseSettlementQuery(input: unknown): SettlementQuery {
  const r = querySchema.safeParse(input ?? {});
  if (!r.success) {
    const unknownKey = r.error.issues.some((i) => i.code === 'unrecognized_keys');
    throw new Problem(
      400,
      unknownKey
        ? 'Nieobsługiwany parametr raportu'
        : [...new Set(r.error.issues.map((i) => i.message))].join('; '),
    );
  }
  return r.data;
}

export type PaymentKind = 'receipt' | 'courier_collection' | 'courier_remittance' | 'refund';
/** Sum of payment entries of one effective kind (reversal → kind of the reversed entry). */
export type PaymentFact = { kind: PaymentKind; currency: string; amount: bigint; fee: bigint };
export type DocumentFact = {
  kind: 'invoice' | 'correction';
  source: string;
  number: string;
  /** Signed gross: invoices ≥ 0, corrections usually < 0. null = unreadable amount. */
  gross: bigint | null;
  currency: string | null;
};
/** A fiscal receipt of the order (233): printed ones document the sale; others are still in print or failed. */
export type ReceiptFact = { number: string | null; state: string; gross: bigint; invoice_number: string | null };
export type OrderFacts = {
  order_id: string;
  number: string;
  customer: string;
  created_at: string;
  status: string;
  payment_mode: string;
  currency: string;
  total: bigint;
  /** 'source' rows were merged into another order; their money is settled on the target. */
  merge: { role: 'none' | 'target' | 'source'; target_number?: string; ledger_orders: number };
  payments: PaymentFact[];
  documents: DocumentFact[];
  return_credit: bigint;
  cancelled_credit: bigint;
  returns: number;
  receipts?: ReceiptFact[];
};

export const settlementStatuses = [
  'scalone',
  'inna_waluta',
  'niedoplata',
  'nadplata',
  'brak_faktury',
  'korekta_bez_faktury',
  'korekta_bez_zwrotu',
  'zwrot_bez_korekty',
  'faktura_niezgodna',
  'wiele_faktur',
  'dokument_nieczytelny',
  'paragon_niezgodny',
  'paragon_niewydrukowany',
  'zgodne',
] as const;
export type SettlementStatus = (typeof settlementStatuses)[number];
export const settlementStatusLabels: Record<SettlementStatus, string> = {
  scalone: 'Scalone — rozliczane w zamówieniu docelowym',
  inna_waluta: 'Kwoty w innej walucie',
  niedoplata: 'Niedopłata',
  nadplata: 'Nadpłata',
  brak_faktury: 'Brak faktury',
  korekta_bez_faktury: 'Korekta bez faktury',
  korekta_bez_zwrotu: 'Korekta bez zwrotu',
  zwrot_bez_korekty: 'Zwrot bez korekty',
  faktura_niezgodna: 'Faktura niezgodna z należnością',
  wiele_faktur: 'Więcej niż jedna faktura',
  dokument_nieczytelny: 'Nieczytelna kwota dokumentu',
  paragon_niezgodny: 'Paragon niezgodny z wpłatami',
  paragon_niewydrukowany: 'Paragon niewydrukowany (w kolejce lub błąd druku)',
  zgodne: 'Zgodne',
};

export type ForeignAmounts = {
  currency: string;
  received: bigint;
  refunded: bigint;
  invoiced: bigint;
  corrections: bigint;
};
export type SettlementRow = {
  order_id: string;
  number: string;
  customer: string;
  created_at: string;
  order_status: string;
  payment_mode: string;
  currency: string;
  order_total: bigint;
  return_credit: bigint;
  cancelled_credit: bigint;
  /** What the buyer owes after returns/cancellations (balance "nominal"). */
  amount_due: bigint;
  received: bigint;
  refunded: bigint;
  net_paid: bigint;
  /** net_paid − amount_due: < 0 niedopłata, > 0 nadpłata. */
  payment_difference: bigint;
  collected: bigint;
  remitted: bigint;
  courier_fees: bigint;
  courier_due: bigint;
  invoiced: bigint;
  corrections: bigint;
  documented: bigint;
  /** documented − amount_due. */
  document_difference: bigint;
  /** credit + corrections: > 0 zwrot bez korekty, < 0 korekta bez zwrotu. */
  credit_difference: bigint;
  invoice_count: number;
  correction_count: number;
  returns: number;
  invoice_numbers: string[];
  correction_numbers: string[];
  /** 233: gross of the printed fiscal receipts (PLN) and their numbers. */
  receipted: bigint;
  receipt_numbers: string[];
  /** receipted − net_paid (paid vs receipted), 0 without a receipt. */
  receipt_difference: bigint;
  foreign: ForeignAmounts[];
  merge_role: 'none' | 'target' | 'source';
  merge_target_number: string | null;
  in_totals: boolean;
  status: SettlementStatus;
  flags: SettlementStatus[];
};

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

export function reconcileOrder(f: OrderFacts): SettlementRow {
  const own = (cur: string | null) => cur === f.currency;
  const pay = (kind: PaymentKind, field: 'amount' | 'fee' = 'amount') =>
    sum(f.payments.filter((p) => p.kind === kind && own(p.currency)).map((p) => p[field]));
  const received = pay('receipt') + pay('courier_collection');
  const refunded = pay('refund');
  const collected = pay('courier_collection');
  const remitted = pay('courier_remittance');
  const fees = pay('courier_remittance', 'fee');
  const credit = f.return_credit + f.cancelled_credit;
  const amountDue = f.status === 'cancelled' ? 0n : f.total > credit ? f.total - credit : 0n;
  const netPaid = received - refunded;
  const readable = f.documents.filter((d) => d.gross !== null && own(d.currency));
  const invoices = f.documents.filter((d) => d.kind === 'invoice');
  const corrections = f.documents.filter((d) => d.kind === 'correction');
  const invoiced = sum(readable.filter((d) => d.kind === 'invoice').map((d) => d.gross!));
  const corrected = sum(readable.filter((d) => d.kind === 'correction').map((d) => d.gross!));
  const receipts = f.receipts ?? [], printed = receipts.filter((r) => r.state === 'printed');
  const receipted = sum(printed.map((r) => r.gross));
  // A printed receipt documents the sale; an invoice issued to it documents the same sale (not added twice).
  const documented = invoiced + corrected + (invoices.length ? 0n : receipted);
  const foreignCodes = [
    ...new Set([
      ...f.payments.filter((p) => !own(p.currency)).map((p) => p.currency),
      ...f.documents.filter((d) => d.currency !== null && !own(d.currency)).map((d) => d.currency!),
    ]),
  ].sort();
  const foreign = foreignCodes.map((currency) => {
    const p = (kinds: PaymentKind[]) =>
      sum(f.payments.filter((x) => x.currency === currency && kinds.includes(x.kind)).map((x) => x.amount));
    const d = (kind: DocumentFact['kind']) =>
      sum(f.documents.filter((x) => x.currency === currency && x.kind === kind && x.gross !== null).map((x) => x.gross!));
    return { currency, received: p(['receipt', 'courier_collection']), refunded: p(['refund']), invoiced: d('invoice'), corrections: d('correction') };
  });
  const paymentDifference = netPaid - amountDue;
  const documentDifference = documented - amountDue;
  const creditDifference = credit + corrected;
  const hasInvoice = invoices.length > 0;
  const receiptDifference = printed.length ? receipted - netPaid : 0n;
  const flags: SettlementStatus[] = [];
  if (f.merge.role === 'source') flags.push('scalone');
  if (foreign.length) flags.push('inna_waluta');
  if (paymentDifference < 0n) flags.push('niedoplata');
  if (paymentDifference > 0n) flags.push('nadplata');
  if (!hasInvoice && !printed.length && (amountDue > 0n || netPaid > 0n)) flags.push('brak_faktury');
  if (!hasInvoice && corrections.length) flags.push('korekta_bez_faktury');
  if (hasInvoice && creditDifference < 0n) flags.push('korekta_bez_zwrotu');
  if (hasInvoice && creditDifference > 0n) flags.push('zwrot_bez_korekty');
  if (hasInvoice && documentDifference !== 0n) flags.push('faktura_niezgodna');
  if (invoices.length > 1) flags.push('wiele_faktur');
  if (f.documents.some((d) => d.gross === null || d.currency === null)) flags.push('dokument_nieczytelny');
  if (receiptDifference !== 0n) flags.push('paragon_niezgodny');
  if (receipts.some((r) => r.state !== 'printed')) flags.push('paragon_niewydrukowany');
  return {
    order_id: f.order_id,
    number: f.number,
    customer: f.customer,
    created_at: f.created_at,
    order_status: f.status,
    payment_mode: f.payment_mode,
    currency: f.currency,
    order_total: f.total,
    return_credit: f.return_credit,
    cancelled_credit: f.cancelled_credit,
    amount_due: amountDue,
    received,
    refunded,
    net_paid: netPaid,
    payment_difference: paymentDifference,
    collected,
    remitted,
    courier_fees: fees,
    courier_due: collected - remitted - fees,
    invoiced,
    corrections: corrected,
    documented,
    document_difference: documentDifference,
    credit_difference: creditDifference,
    invoice_count: invoices.length,
    correction_count: corrections.length,
    returns: f.returns,
    invoice_numbers: invoices.map((d) => d.number),
    correction_numbers: corrections.map((d) => d.number),
    receipted,
    receipt_numbers: printed.map((r) => r.number!),
    receipt_difference: receiptDifference,
    foreign,
    merge_role: f.merge.role,
    merge_target_number: f.merge.target_number ?? null,
    in_totals: f.merge.role !== 'source',
    status: flags[0] ?? 'zgodne',
    flags: flags.length ? flags : ['zgodne'],
  };
}

export const totalFields = [
  'order_total',
  'return_credit',
  'cancelled_credit',
  'amount_due',
  'received',
  'refunded',
  'net_paid',
  'payment_difference',
  'collected',
  'remitted',
  'courier_fees',
  'courier_due',
  'invoiced',
  'corrections',
  'documented',
  'document_difference',
  'credit_difference',
] as const;
export type TotalField = (typeof totalFields)[number];
export type SettlementTotals = {
  currency: string;
  orders: number;
  statuses: Partial<Record<SettlementStatus, number>>;
  /** Amounts in this currency found on orders kept in another currency. */
  foreign_received: bigint;
  foreign_refunded: bigint;
  foreign_documented: bigint;
} & Record<TotalField, bigint>;

/** One totals row per currency; a currency's figures never mix with another's. */
export function settlementTotals(rows: SettlementRow[]): SettlementTotals[] {
  const by = new Map<string, SettlementTotals>();
  const get = (currency: string) => {
    let t = by.get(currency);
    if (!t) {
      t = { currency, orders: 0, statuses: {}, foreign_received: 0n, foreign_refunded: 0n, foreign_documented: 0n } as SettlementTotals;
      for (const k of totalFields) t[k] = 0n;
      by.set(currency, t);
    }
    return t;
  };
  for (const r of rows) {
    if (!r.in_totals) continue;
    const t = get(r.currency);
    t.orders += 1;
    t.statuses[r.status] = (t.statuses[r.status] ?? 0) + 1;
    for (const k of totalFields) t[k] += r[k];
    for (const x of r.foreign) {
      const ft = get(x.currency);
      ft.foreign_received += x.received;
      ft.foreign_refunded += x.refunded;
      ft.foreign_documented += x.invoiced + x.corrections;
    }
  }
  return [...by.values()].sort((a, b) => (a.currency === 'PLN' ? -1 : b.currency === 'PLN' ? 1 : a.currency.localeCompare(b.currency)));
}

const safe = (n: bigint) => {
  const v = Number(n);
  if (!Number.isSafeInteger(v)) throw new Problem(409, 'Kwota raportu przekracza obsługiwany zakres');
  return v;
};
/** JSON form: every minor-unit amount as a safe integer. */
export function serializeSettlement<T>(value: T): unknown {
  if (typeof value === 'bigint') return safe(value);
  if (Array.isArray(value)) return value.map(serializeSettlement);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeSettlement(v)]));
  return value;
}

const csvColumns = [
  'numer_zamowienia',
  'data_zamowienia',
  'klient',
  'status_zamowienia',
  'platnosc',
  'waluta',
  'wartosc_zamowienia_gr',
  'zwroty_uznane_gr',
  'anulowania_uznane_gr',
  'naleznosc_gr',
  'wplaty_gr',
  'zwroty_pieniedzy_gr',
  'zaplacono_netto_gr',
  'roznica_platnosci_gr',
  'pobrania_gr',
  'przekazane_przez_kuriera_gr',
  'prowizje_kuriera_gr',
  'pobrania_do_przekazania_gr',
  'zafakturowano_gr',
  'korekty_gr',
  'dokumenty_razem_gr',
  'roznica_dokumentow_gr',
  'zwroty_bez_korekty_gr',
  'faktury',
  'korekty',
  'inne_waluty',
  'w_sumach',
  'status',
  'oznaczenia',
  'paragony_gr',
  'paragony',
  'roznica_paragonow_gr',
] as const;
/** Text cells that could start a spreadsheet formula get an apostrophe. Numbers stay numeric. */
const cell = (v: string | bigint | number) => {
  let s = String(v);
  if (typeof v === 'string' && /^[\s]*[=+\-@\t\r]/u.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
export function settlementCsv(rows: SettlementRow[], totals: SettlementTotals[]): string {
  const line = (cells: (string | bigint | number)[]) => cells.map(cell).join(',') + '\r\n';
  let out = '﻿' + line([...csvColumns]);
  for (const r of rows)
    out += line([
      r.number,
      r.created_at,
      r.customer,
      r.order_status,
      r.payment_mode,
      r.currency,
      r.order_total,
      r.return_credit,
      r.cancelled_credit,
      r.amount_due,
      r.received,
      r.refunded,
      r.net_paid,
      r.payment_difference,
      r.collected,
      r.remitted,
      r.courier_fees,
      r.courier_due,
      r.invoiced,
      r.corrections,
      r.documented,
      r.document_difference,
      r.credit_difference,
      r.invoice_numbers.join(' | '),
      r.correction_numbers.join(' | '),
      r.foreign.map((x) => `${x.currency}: wpłaty ${x.received}, zwroty ${x.refunded}, dokumenty ${x.invoiced + x.corrections}`).join(' | '),
      r.in_totals ? 'tak' : 'nie',
      settlementStatusLabels[r.status],
      r.flags.map((s) => settlementStatusLabels[s]).join(' | '),
      r.receipted,
      r.receipt_numbers.join(' | '),
      r.receipt_difference,
    ]);
  for (const t of totals)
    out += line([
      'SUMA ' + t.currency,
      '',
      `${t.orders} zamówień`,
      '',
      '',
      t.currency,
      ...totalFields.map((k) => t[k]),
      '',
      '',
      t.foreign_received || t.foreign_refunded || t.foreign_documented
        ? `z zamówień w innej walucie: wpłaty ${t.foreign_received}, zwroty ${t.foreign_refunded}, dokumenty ${t.foreign_documented}`
        : '',
      '',
      '',
      Object.entries(t.statuses).map(([s, n]) => `${settlementStatusLabels[s as SettlementStatus]}: ${n}`).join(' | '),
      '',
      '',
      '',
    ]);
  return out;
}
