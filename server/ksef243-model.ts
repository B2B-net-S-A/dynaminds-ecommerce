/** Pure rules of migration 243 (purchase invoices received in KSeF; docs/parity/KSEF-PURCHASE243-20261027.md):
 * the retention end, when the fetch job runs next, the inputs of the settings, the list and the workflow with
 * their refusals, the parametrised list filter with its keyset cursor, KOR re-linking and the accountant's CSV.
 * No database, no network. */
import { z } from 'zod';
import { validNip } from './ksef229-model';
import { linkCorrection, type CorrectedInvoiceRef, type KnownPurchaseInvoice, type ParsedPurchaseInvoice, type PurchaseDateType, type PurchaseMetadata } from './ksef-purchase-model';

export const KSEF_PURCHASE_FETCH_JOB = 'ksef.purchase.fetch';
/** KSeF 2.0 (and its API) starts on 1.02.2026; nothing older is fetched. */
export const KSEF20_START = '2026-02-01T00:00:00.000Z';
/** A complete run is followed by the next one after this period. */
export const PURCHASE_PERIOD_MS = 30 * 60_000;
/** One run: its KSeF budget stays well below the 2-minute reaper of running jobs; the lease outlasts it. */
export const PURCHASE_RUN = { budgetMs: 90_000, leaseSeconds: 150, maxPages: 20, manualBudgetMs: 60_000, manualMaxPages: 10 } as const;
/** The accountant's package: at most this many invoices and this many bytes of FA(3) files. */
export const PURCHASE_EXPORT_LIMITS = { maxInvoices: 500, maxBytes: 64 * 1024 * 1024 } as const;

export type PurchaseStatus = 'new' | 'accepted' | 'booked' | 'ignored';
export const PURCHASE_STATUSES: readonly PurchaseStatus[] = ['new', 'accepted', 'booked', 'ignored'];
export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = { new: 'Nowa', accepted: 'Zaakceptowana', booked: 'Zaksięgowana', ignored: 'Pominięta' };
export const FA3_KINDS = ['VAT', 'KOR', 'ZAL', 'ROZ', 'UPR', 'KOR_ZAL', 'KOR_ROZ'] as const;
export type PurchaseRunOutcome = 'ok' | 'partial' | 'rate_limited' | 'unavailable' | 'refused' | 'error' | 'busy' | 'disabled';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string) => ISO_DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().startsWith(v);
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** 31.12 of (issue year + 6): the VAT liability of a December invoice lapses at the end of the fifth year after the
 * year of its payment deadline (January), so +6 covers every invoice of the year (art. 112 VAT, art. 70 § 1 OP). */
export function purchaseRetainUntil(issueDate: string): string {
  if (!isDay(issueDate)) throw new Error('Nieprawidłowa data wystawienia faktury');
  return `${Number(issueDate.slice(0, 4)) + 6}-12-31`;
}

/** Delay before the next fetch of a NIP after a run with this outcome; null = do not reschedule. */
export function nextPurchaseRunDelayMs(r: { outcome: PurchaseRunOutcome; retryAfterMs?: number | null; failures: number }): number | null {
  switch (r.outcome) {
    case 'disabled': return null;
    case 'ok': return PURCHASE_PERIOD_MS;
    case 'partial': return 5_000;
    case 'busy': return 60_000;
    case 'rate_limited': return Math.min(PURCHASE_PERIOD_MS * 4, Math.max(10_000, r.retryAfterMs ?? 60_000));
    default: return Math.min(PURCHASE_PERIOD_MS, 60_000 * 2 ** Math.min(Math.max(0, r.failures), 20));
  }
}

export const purchaseNipParam = z.strictObject({ nip: z.string().regex(/^[0-9]{10}$/, 'NIP ma 10 cyfr').refine(validNip, 'Nieprawidłowy NIP') });
export const purchaseIdParam = z.strictObject({ id: z.uuid().transform(v => v.toLowerCase()) });
export const purchaseKsefParam = z.strictObject({ ksef: z.string().regex(/^[0-9]{10}-[0-9]{8}-[0-9A-F]{12}-[0-9A-F]{2}$/, 'Nieprawidłowy numer KSeF') });
export const purchaseRunInput = z.strictObject({});

/** PUT settings of one NIP. The start may not precede KSeF 2.0 nor lie in the future. */
export const purchaseSyncInput = (now: Date) => z.strictObject({
  enabled: z.boolean(),
  date_type: z.enum(['PermanentStorage', 'Invoicing', 'Issue'] as const satisfies readonly PurchaseDateType[]),
  start_from: z.string().max(40).regex(ISO_DATE_TIME, 'Data początkowa musi być datą i czasem ISO 8601').transform(v => new Date(v).toISOString())
    .refine(v => v >= KSEF20_START, 'Faktury z KSeF 2.0 są dostępne od 1.02.2026')
    .refine(v => Date.parse(v) <= now.getTime(), 'Data początkowa nie może być z przyszłości'),
  /** Read again from the start even when the start and the axis are unchanged. */
  restart: z.boolean().optional(),
});
export type PurchaseSyncInput = z.infer<ReturnType<typeof purchaseSyncInput>>;

const optText = (max: number, label: string) => z.string().trim().min(1, `${label} nie może być puste`).max(max, `${label}: najwyżej ${max} znaków`)
  .refine(v => !v.includes('\u0000') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v), `${label}: niedozwolony znak`).nullable().optional();
export const purchaseInvoicePatch = z.strictObject({
  version: z.number().int().positive(),
  status: z.enum(PURCHASE_STATUSES as [PurchaseStatus, ...PurchaseStatus[]]).optional(),
  accounting_ref: optText(120, 'Numer księgowy'),
  note: optText(2000, 'Notatka'),
  legal_hold: z.boolean().optional(),
}).refine(v => v.status !== undefined || v.accounting_ref !== undefined || v.note !== undefined || v.legal_hold !== undefined, 'Nie podano zmiany');
export type PurchaseInvoicePatch = z.infer<typeof purchaseInvoicePatch>;

/** Why this status change is refused (Polish), or null. Reopening a booked invoice is the administrator's. */
export function purchaseStatusChange(from: PurchaseStatus, to: PurchaseStatus, role: string): string | null {
  if (from === to) return `Faktura ma już status „${PURCHASE_STATUS_LABELS[to]}”`;
  if (from === 'booked' && role !== 'admin') return 'Cofnięcie zaksięgowania wymaga roli administratora';
  return null;
}

const CURSOR = /^(\d{4}-\d{2}-\d{2})~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const encodePurchaseCursor = (issueDate: string, id: string) => `${issueDate}~${id}`;
export function decodePurchaseCursor(v: string): { issueDate: string; id: string } {
  const m = CURSOR.exec(v);
  if (!m || !isDay(m[1]!)) throw new Error('Nieprawidłowy kursor listy');
  return { issueDate: m[1]!, id: m[2]! };
}
const day = z.string().refine(isDay, 'Data musi mieć postać RRRR-MM-DD');
const noNul = (v: string) => !/\u0000/.test(v);
export const purchaseListQuery = z.strictObject({
  nip: z.string().regex(/^[0-9]{10}$/, 'NIP ma 10 cyfr').optional(),
  seller: z.string().trim().min(1).max(100, 'Sprzedawca: najwyżej 100 znaków').refine(noNul, 'Niedozwolony znak').optional(),
  status: z.enum(PURCHASE_STATUSES as [PurchaseStatus, ...PurchaseStatus[]]).optional(),
  kind: z.enum(FA3_KINDS).optional(),
  from: day.optional(),
  to: day.optional(),
  q: z.string().trim().min(1).max(100).refine(noNul, 'Niedozwolony znak').optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().regex(CURSOR, 'Nieprawidłowy kursor listy').optional(),
}).refine(v => !v.from || !v.to || v.from <= v.to, 'Data „od” jest późniejsza niż „do”');
export type PurchaseListQuery = z.infer<typeof purchaseListQuery>;
/** The package takes the same filters, without paging. */
export const purchaseExportQuery = z.strictObject({
  nip: z.string().regex(/^[0-9]{10}$/).optional(), seller: z.string().trim().min(1).max(100).refine(noNul).optional(),
  status: z.enum(PURCHASE_STATUSES as [PurchaseStatus, ...PurchaseStatus[]]).optional(), kind: z.enum(FA3_KINDS).optional(),
  from: day.optional(), to: day.optional(), q: z.string().trim().min(1).max(100).refine(noNul).optional(),
}).refine(v => !v.from || !v.to || v.from <= v.to, 'Data „od” jest późniejsza niż „do”');

const like = (v: string) => '%' + v.replace(/[\\%_]/g, m => '\\' + m) + '%';
/** WHERE clause of the list (and the package); every value is a positional parameter, never spliced. */
export function purchaseListWhere(q: Partial<PurchaseListQuery>): { sql: string; params: unknown[] } {
  const params: unknown[] = [], where: string[] = [];
  const p = (v: unknown) => { params.push(v); return '$' + params.length; };
  if (q.before) { const c = decodePurchaseCursor(q.before); where.push(`(issue_date,id)<(${p(c.issueDate)}::date,${p(c.id)}::uuid)`); }
  if (q.seller) { const v = p(like(q.seller)); where.push(`(seller_name ILIKE ${v} OR seller_nip LIKE ${v})`); }
  if (q.nip) where.push(`buyer_nip=${p(q.nip)}`);
  if (q.status) where.push(`status=${p(q.status)}`);
  if (q.kind) where.push(`fa3_kind=${p(q.kind)}`);
  if (q.from) where.push(`issue_date>=${p(q.from)}::date`);
  if (q.to) where.push(`issue_date<=${p(q.to)}::date`);
  if (q.q) { const v = p(like(q.q)); where.push(`(invoice_number ILIKE ${v} OR ksef_number ILIKE ${v})`); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

export type OpenCorrection = { id: string; sellerNip: string; refs: (CorrectedInvoiceRef & { ordinal: number })[] };
export type KnownWithId = KnownPurchaseInvoice & { id: string };
export type CorrectionResolution = { correctionId: string; ordinal: number; resolvedInvoiceId: string | null; by: 'ksef_number' | 'invoice_number' | null; problem: 'seller_mismatch' | 'ambiguous' | null };
/** Links the open references of these corrections against the known invoices (linkCorrection's rules). Only a
 * found invoice or a problem is returned: an unresolved reference without a problem stays as it is. */
export function relinkPurchaseCorrections(corrections: readonly OpenCorrection[], known: readonly KnownWithId[]): CorrectionResolution[] {
  const out: CorrectionResolution[] = [];
  for (const k of corrections) {
    const parsed = { correction: { reason: null, type: null, corrected: k.refs.map(({ ordinal: _o, ...r }) => r) } } as unknown as ParsedPurchaseInvoice;
    linkCorrection({ sellerNip: k.sellerNip, parsed }, known).forEach((l, i) => {
      const id = l.resolvedKsefNumber ? known.find(x => x.ksefNumber === l.resolvedKsefNumber)?.id ?? null : null;
      if (id || l.problem) out.push({ correctionId: k.id, ordinal: k.refs[i]!.ordinal, resolvedInvoiceId: id, by: id ? l.by : null, problem: id ? null : l.problem });
    });
  }
  return out;
}

export type PurchaseCsvRow = { ksef_number: string; invoice_number: string; fa3_kind: string; issue_date: string; sale_date: string | null; seller_nip: string; seller_name: string;
  buyer_nip: string; currency: string; net_total: number | string; vat_total: number | string; gross_total: number | string; payment_due_date: string | null; split_payment: boolean;
  status: PurchaseStatus; accounting_ref: string | null; retain_until: string };
/** Minor units → "1234,56" (decimal comma), sign kept. */
export function amountText(minor: number | string): string {
  const v = BigInt(minor), neg = v < 0n, a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')}`;
}
const textCell = (v: string | null) => {
  if (v === null) return '';
  const s = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
/** The accountant's list: UTF-8 with BOM, ";" separators (Excel PL), formula cells neutralised. */
export function purchaseCsv(rows: readonly PurchaseCsvRow[]): string {
  const head = ['Numer KSeF', 'Numer faktury', 'Rodzaj', 'Data wystawienia', 'Data sprzedaży', 'NIP sprzedawcy', 'Sprzedawca', 'NIP nabywcy', 'Waluta', 'Netto', 'VAT', 'Brutto',
    'Termin płatności', 'MPP', 'Status', 'Numer księgowy', 'Przechowywać do'];
  const lines = rows.map(r => [textCell(r.ksef_number), textCell(r.invoice_number), textCell(r.fa3_kind), r.issue_date, r.sale_date ?? '', r.seller_nip, textCell(r.seller_name), r.buyer_nip,
    r.currency, amountText(r.net_total), amountText(r.vat_total), amountText(r.gross_total), r.payment_due_date ?? '', r.split_payment ? 'tak' : 'nie', PURCHASE_STATUS_LABELS[r.status],
    textCell(r.accounting_ref), r.retain_until].join(';'));
  return '﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
}

/** NIPs of a RODO subject: the CRM invoice data (invoice_tax_id), valid Polish NIPs only. */
export function subjectNips(clients: readonly { profile?: Record<string, unknown> | null }[]): string[] {
  const out = new Set<string>();
  for (const c of clients) {
    const raw = c.profile?.invoice_tax_id;
    if (typeof raw !== 'string') continue;
    const digits = raw.replace(/^\s*PL/i, '').replace(/[\s-]/g, '');
    if (/^\d{10}$/.test(digits) && validNip(digits)) out.add(digits);
  }
  return [...out].sort();
}

/** The listing entry of a refused file as KSeF sent it (parsePurchaseMetadata reads it back for "Pobierz ponownie").
 * Long texts are cut so the entry stays far below the 16 KiB of the table (they are KSeF's, not ours). */
export function storedPurchaseMeta(m: PurchaseMetadata): Record<string, unknown> {
  // Code points, never a split surrogate; NUL removed (jsonb cannot hold it).
  const clean = (v: string, n: number) => [...v.replace(/\u0000/g, '')].slice(0, n).join('');
  const cut = (v: string | null) => (v === null ? undefined : clean(v, 512));
  return { ksefNumber: m.ksefNumber, invoiceNumber: clean(m.invoiceNumber, 256), issueDate: m.issueDate, invoicingDate: m.invoicingDate, acquisitionDate: m.acquisitionDate ?? undefined,
    permanentStorageDate: m.permanentStorageDate ?? undefined, seller: { nip: m.sellerNip, name: cut(m.sellerName) },
    buyer: { identifier: m.buyerIdentifier ? { type: clean(m.buyerIdentifier.type, 64), value: clean(m.buyerIdentifier.value, 64) } : undefined, name: cut(m.buyerName) },
    netAmount: m.netAmount ?? undefined, vatAmount: m.vatAmount ?? undefined, grossAmount: m.grossAmount ?? undefined, currency: m.currency, invoiceType: m.invoiceType,
    invoicingMode: m.invoicingMode ?? undefined, hasAttachment: m.hasAttachment, isSelfInvoicing: m.isSelfInvoicing, invoiceHash: m.invoiceHash,
    ...(m.problem ? { problem: { code: m.problem.code, reason: clean(m.problem.reason, 500) } } : {}) };
}
