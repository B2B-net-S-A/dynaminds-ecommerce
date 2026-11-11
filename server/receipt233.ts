/** Fiscal receipts (233): the printer configuration, receipt jobs of orders, daily reports and the
 * invoice-to-receipt link, inside one tenant transaction each. Rules are pure (receipt233-model.ts);
 * printer I/O happens between transactions (receipt233-service.ts). Writes go only to the own 233 tables.
 * Design: docs/parity/RECEIPTS233-20261025.md. */
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from './domain';
import { ensure } from './errors';
import type { LocalInvoiceActor } from './local-invoice-values';
import { DEFAULT_TAX_PROFILE, type OssState, type TaxProfile } from './tax226-model';
import {
  DEFAULT_PTU_TABLE, PAYMENT_FORMS, PRINTER_ERRORS, PTU_LETTERS, RECEIPT_STATE_LABELS, defaultPaymentForm, invoiceToReceiptRefusals, isSimplifiedInvoice,
  ptuTableInput, receiptMath, receiptRefusals, type PaymentForm, type PrinterErrorCode, type PtuTable, type ReceiptLine, type ReceiptMath, type ReceiptRequest,
  type ReceiptSourceLine, type ReceiptState, type PtuTotal,
} from './receipt233-model';
import { LOOPBACK_HOSTS, MODEL_FAMILIES, type DailyReportResult, type ModelFamily, type PrintJob, type PrintOutcome } from './receipt233-printer';

export async function receipt233Available(c: Pool | PoolClient): Promise<boolean> {
  return Boolean((await c.query(`SELECT to_regclass('public.receipt233_printers') IS NOT NULL AND to_regclass('public.receipt233_receipts') IS NOT NULL
    AND to_regclass('public.receipt233_daily_reports') IS NOT NULL AND to_regclass('public.receipt233_invoice_links') IS NOT NULL
    AND to_regprocedure('public.receipt233_receipt_guard()') IS NOT NULL AS available`)).rows[0]?.available);
}
export async function requireReceipt233(c: PoolClient): Promise<void> {
  ensure(await receipt233Available(c), 503, 'Paragony fiskalne (migracja 233) są niedostępne w tej kopii');
}
const iso = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v.toISOString() : v);
const day = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
/** Receipts and invoices of one order are serialized (no receipt while an invoice is issued and the reverse). */
export const lockOrderReceipt = (c: PoolClient, orderId: string) => c.query("SELECT pg_advisory_xact_lock(hashtextextended('receipt233:'||$1::text,0))", [orderId]);

// ── printer configuration ────────────────────────────────────────────────────────────────────────
export const printerInput = z.strictObject({
  version: z.number().int().min(1).nullable().default(null),
  name: z.string().trim().min(1, 'Podaj nazwę drukarki').max(80),
  model_family: z.enum(Object.keys(MODEL_FAMILIES) as [ModelFamily, ...ModelFamily[]], 'Wybierz rodzinę drukarki'),
  host: z.enum(LOOPBACK_HOSTS, 'Drukarka musi być pod adresem lokalnym: 127.0.0.1, ::1 lub localhost'),
  port: z.number({ error: 'Port to liczba 1024–65535' }).int().min(1024, 'Port to liczba 1024–65535').max(65535, 'Port to liczba 1024–65535'),
  unique_number: z.string().trim().toUpperCase().regex(/^[A-Z]{3}[0-9]{8}$/, 'Numer unikatowy kasy: 3 litery i 8 cyfr, np. ABC12345678'),
  ptu: ptuTableInput.default(DEFAULT_PTU_TABLE),
  active: z.boolean().default(true),
});
export type PrinterInput = z.infer<typeof printerInput>;
export type PrinterView = { id: string; name: string; model_family: ModelFamily; model_label: string; host: string; port: number; unique_number: string; ptu: PtuTable;
  active: boolean; version: number; updated_at: string };
const printerView = (r: any): PrinterView => ({ id: r.id, name: r.name, model_family: r.model_family, model_label: MODEL_FAMILIES[r.model_family as ModelFamily], host: r.host,
  port: r.port, unique_number: r.unique_number, ptu: r.ptu, active: r.active, version: r.version, updated_at: iso(r.updated_at)! });
export async function activePrinterInTx(c: PoolClient, lock = false): Promise<PrinterView | null> {
  const r = (await c.query(`SELECT * FROM receipt233_printers WHERE active${lock ? ' FOR UPDATE' : ''}`)).rows[0];
  return r ? printerView(r) : null;
}
export async function printersInTx(c: PoolClient): Promise<PrinterView[]> {
  return (await c.query('SELECT * FROM receipt233_printers ORDER BY active DESC,updated_at DESC LIMIT 20')).rows.map(printerView);
}
/** Saves the configuration: the same device (unique number) gets a new version; another device becomes the
 * active printer and the previous one is deactivated (it stays, its receipts point to it). */
export async function savePrinterInTx(c: PoolClient, a: LocalInvoiceActor, input: unknown): Promise<PrinterView> {
  await requireReceipt233(c);
  const b = printerInput.parse(input), cur = await activePrinterInTx(c, true);
  const same = (await c.query('SELECT * FROM receipt233_printers WHERE unique_number=$1 FOR UPDATE', [b.unique_number])).rows[0];
  if (same) {
    ensure(b.version === same.version, 409, 'Konfiguracja drukarki zmieniła się w międzyczasie — odśwież ją i zapisz ponownie');
    if (b.active && cur && cur.id !== same.id) await c.query('UPDATE receipt233_printers SET active=false,version=version+1,actor_id=$2,updated_at=clock_timestamp() WHERE id=$1', [cur.id, a.userId]);
    const r = (await c.query(`UPDATE receipt233_printers SET name=$2,model_family=$3,host=$4,port=$5,ptu=$6::jsonb,active=$7,version=version+1,actor_id=$8,updated_at=clock_timestamp()
      WHERE id=$1 RETURNING *`, [same.id, b.name, b.model_family, b.host, b.port, JSON.stringify(b.ptu), b.active, a.userId])).rows[0];
    await audit(c, a, 'receipt233.printer.update', r.id, { version: r.version, active: r.active, model_family: r.model_family, port: r.port, ptu: b.ptu });
    return printerView(r);
  }
  ensure(b.version === null, 409, 'Nowa drukarka (inny numer unikatowy) nie ma jeszcze wersji konfiguracji');
  if (b.active && cur) await c.query('UPDATE receipt233_printers SET active=false,version=version+1,actor_id=$2,updated_at=clock_timestamp() WHERE id=$1', [cur.id, a.userId]);
  const r = (await c.query(`INSERT INTO receipt233_printers(tenant_id,name,model_family,host,port,unique_number,ptu,active,version,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,1,$9) RETURNING *`,
    [a.tenantId, b.name, b.model_family, b.host, b.port, b.unique_number, JSON.stringify(b.ptu), b.active, a.userId])).rows[0];
  await audit(c, a, 'receipt233.printer.create', r.id, { unique_number: r.unique_number, model_family: r.model_family, port: r.port, ptu: b.ptu });
  return printerView(r);
}

// ── receipts ─────────────────────────────────────────────────────────────────────────────────────
export type Receipt233Snapshot = {
  format: 'receipt233/v1'; order_id: string; order: { id: string; number: string; version: string; payment_mode: string; total_minor: string };
  printer: { id: string; name: string; model_family: ModelFamily; unique_number: string }; ptu_table: PtuTable;
  payment_form: PaymentForm; payment_label: string; buyer_nip: string | null; simplified_invoice: boolean; shipping_vat: number; sell_date: string;
  lines: ReceiptLine[]; ptu_totals: PtuTotal[]; totals: ReceiptMath['totals']; rounding_method: 'gross_line_half_up';
};
export type Receipt233View = {
  id: string; order_id: string; state: ReceiptState; state_label: string; attempts: number; payment_form: PaymentForm; buyer_nip: string | null; simplified_invoice: boolean;
  gross_minor: string; printer_unique_number: string; number: string | null; fiscal_date: string | null; error: { code: PrinterErrorCode; message: string; retry: boolean } | null;
  snapshot: Receipt233Snapshot; created_at: string; sent_at: string | null; printed_at: string | null;
  invoice: { document_id: string; number: string; mode: string } | null;
};
const RECEIPT_SQL = `SELECT r.*,to_char(r.fiscal_date,'YYYY-MM-DD') fiscal_day,l.document_id link_document_id,l.document_mode link_mode,d.number link_number
  FROM receipt233_receipts r LEFT JOIN receipt233_invoice_links l ON (l.tenant_id,l.receipt_id)=(r.tenant_id,r.id) LEFT JOIN documents d ON (d.tenant_id,d.id)=(l.tenant_id,l.document_id)`;
const receiptView = (r: any): Receipt233View => ({
  id: r.id, order_id: r.order_id, state: r.state, state_label: RECEIPT_STATE_LABELS[r.state as ReceiptState], attempts: r.attempts, payment_form: r.payment_form,
  buyer_nip: r.buyer_nip, simplified_invoice: r.simplified_invoice, gross_minor: String(r.gross_minor), printer_unique_number: r.printer_unique_number,
  number: r.printer_receipt_number, fiscal_date: r.fiscal_day ?? null,
  error: r.error_code ? { code: r.error_code, message: r.error_message, retry: PRINTER_ERRORS[r.error_code as PrinterErrorCode].retry } : null,
  snapshot: r.snapshot, created_at: iso(r.created_at)!, sent_at: iso(r.sent_at), printed_at: iso(r.printed_at),
  invoice: r.link_document_id ? { document_id: r.link_document_id, number: r.link_number, mode: r.link_mode } : null,
});
export async function receiptInTx(c: PoolClient, id: string, lock = false): Promise<Receipt233View> {
  const r = (await c.query(RECEIPT_SQL + ` WHERE r.id=$1${lock ? ' FOR UPDATE OF r' : ''}`, [id])).rows[0];
  ensure(r, 404, 'Nie znaleziono paragonu');
  return receiptView(r);
}
export async function orderReceiptInTx(c: PoolClient, orderId: string): Promise<Receipt233View | null> {
  const r = (await c.query(RECEIPT_SQL + ' WHERE r.order_id=$1', [orderId])).rows[0];
  return r ? receiptView(r) : null;
}
export async function receiptRegisterInTx(c: PoolClient, f: { order_id?: string; fiscal_date?: string }): Promise<Receipt233View[]> {
  return (await c.query(RECEIPT_SQL + ` WHERE ($1::uuid IS NULL OR r.order_id=$1) AND ($2::date IS NULL OR r.fiscal_date=$2) ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,
    [f.order_id ?? null, f.fiscal_date ?? null])).rows.map(receiptView);
}

const profileOf = (r: any): TaxProfile => ({ version: r.version, category: r.category, exemption_basis_kind: r.exemption_basis_kind, exemption_basis: r.exemption_basis,
  np_kind: r.np_kind, gtu: r.gtu, annex15: r.annex15, oss_rate_class: r.oss_rate_class });
const has = async (c: PoolClient, sql: string, v: unknown[]) => Boolean((await c.query(sql, v)).rowCount);
const tableExists = async (c: PoolClient, t: string) => Boolean((await c.query('SELECT to_regclass($1) IS NOT NULL AS p', ['public.' + t])).rows[0].p);
/** Invoice documents of the order (any path: 157, 230, B2B, Base) and approved external invoice plans. */
async function orderInvoicesInTx(c: PoolClient, orderId: string): Promise<string[]> {
  const out = (await c.query("SELECT number FROM documents WHERE order_id=$1 AND kind='invoice' AND mode NOT IN ('demo','simulation','provider_test') ORDER BY created_at", [orderId])).rows.map(r => r.number as string);
  if (await has(c, "SELECT 1 FROM invoice_plans WHERE order_id=$1 AND kind='invoice' AND mode='external' AND state NOT IN ('preview','cancelled')", [orderId])) out.push('(plan faktury zewnętrznej)');
  return out;
}
export type ReceiptCalculation = { order: any; snapshot: Receipt233Snapshot | null; blockers: string[] };
/** What a receipt of the order would contain now, with its refusals. Reads only. */
export async function receiptCalculationInTx(c: PoolClient, orderId: string, b: { payment_form?: PaymentForm; buyer_nip?: string | null; shipping_vat?: number }, lock = false): Promise<ReceiptCalculation> {
  await requireReceipt233(c);
  const o = (await c.query(`SELECT * FROM orders WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [orderId])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  const printer = await activePrinterInTx(c);
  const merged = await has(c, 'SELECT 1 FROM order_merge_claims WHERE source_order_id=$1', [orderId]);
  const b2b = o.source === 'b2b' || o.b2b_account_id !== null || await has(c, 'SELECT 1 FROM b2b_dropship_orders WHERE customer_order_id=$1', [orderId]);
  const blockers = receiptRefusals({ status: o.status, currency: o.currency, fulfillment_kind: o.fulfillment_kind, source: o.source, b2b, merged_into_other: merged,
    delivery_country: o.address?.country ?? null, invoices: await orderInvoicesInTx(c, orderId), total_minor: BigInt(o.total) });
  if (!printer) blockers.unshift('Brak aktywnej drukarki fiskalnej — skonfiguruj ją w Ustawieniach → Drukarka fiskalna');
  const items = (await c.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [orderId])).rows;
  if (items.length < 1 || items.length > 100) blockers.push('Paragon obejmuje od 1 do 100 pozycji zamówienia');
  const ids = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  const profiles = await tableExists(c, 'tax226_product_profiles')
    ? new Map((await c.query('SELECT * FROM tax226_product_profiles WHERE product_id=ANY($1::uuid[])', [ids])).rows.map(r => [r.product_id as string, profileOf(r)])) : new Map<string, TaxProfile>();
  const source: ReceiptSourceLine[] = [];
  let sum = 0n;
  for (const i of items) {
    const gross = BigInt(i.line_total ?? -1), price = BigInt(i.price), q = BigInt(i.quantity);
    if (i.quantity <= 0 || i.price < 0 || ![0, 5, 8, 23].includes(i.vat) || gross < 0n || gross - price * q >= q) { blockers.push(`${i.sku || i.name}: pozycja ma niespójne kwoty`); continue; }
    source.push({ kind: 'item', sku: i.sku ?? '', name: i.name, vat_rate: i.vat, gross_minor: String(gross), profile: (i.product_id && profiles.get(i.product_id)) || DEFAULT_TAX_PROFILE,
      quantity: i.quantity, unit_gross_minor: String(price) });
    sum += gross;
  }
  const shipping = BigInt(o.shipping_cost), shippingVat = b.shipping_vat ?? 23;
  if (shipping > 0n) source.push({ kind: 'shipping', sku: '', name: 'Dostawa', vat_rate: shippingVat, gross_minor: String(shipping), profile: null, quantity: 1, unit_gross_minor: String(shipping) });
  if (sum + shipping !== BigInt(o.total)) blockers.push('Pozycje paragonu nie sumują się do zamówienia');
  const sellDate = (await c.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'Europe/Warsaw')::date,'YYYY-MM-DD') d")).rows[0].d as string;
  const oss: OssState | null = null;
  const m = receiptMath(source, printer?.ptu ?? DEFAULT_PTU_TABLE, sellDate, oss);
  blockers.push(...m.blockers);
  if (!printer) return { order: o, snapshot: null, blockers };
  const form = b.payment_form ?? defaultPaymentForm(o.payment_mode), nip = b.buyer_nip ?? null;
  const snapshot: Receipt233Snapshot = {
    format: 'receipt233/v1', order_id: o.id, order: { id: o.id, number: o.number, version: String(o.version), payment_mode: o.payment_mode, total_minor: String(o.total) },
    printer: { id: printer.id, name: printer.name, model_family: printer.model_family, unique_number: printer.unique_number }, ptu_table: printer.ptu,
    payment_form: form, payment_label: PAYMENT_FORMS[form], buyer_nip: nip, simplified_invoice: isSimplifiedInvoice(nip, BigInt(m.math.totals.gross_minor)),
    shipping_vat: shippingVat, sell_date: sellDate, lines: m.math.lines, ptu_totals: m.math.ptu_totals, totals: m.math.totals, rounding_method: 'gross_line_half_up',
  };
  return { order: o, snapshot, blockers };
}
/** Stores the confirmed receipt job (queued). The same client_key replays its own job. */
export async function storeReceiptInTx(c: PoolClient, a: LocalInvoiceActor, orderId: string, b: ReceiptRequest): Promise<{ id: string; reused: boolean }> {
  await requireReceipt233(c);
  const old = (await c.query('SELECT id,order_id,actor_id,api_key_id,payment_form,buyer_nip,snapshot FROM receipt233_receipts WHERE client_key=$1', [b.client_key])).rows[0];
  if (old) {
    ensure(old.order_id === orderId && old.actor_id === a.userId && (old.api_key_id ?? null) === (a.apiKeyId ?? null) && old.payment_form === b.payment_form
      && (old.buyer_nip ?? null) === b.buyer_nip && old.snapshot.shipping_vat === b.shipping_vat, 409, 'Klucz paragonu użyty z innymi danymi');
    return { id: old.id, reused: true };
  }
  await lockOrderReceipt(c, orderId);
  const existing = await orderReceiptInTx(c, orderId);
  ensure(!existing, 409, existing?.state === 'printed' ? `Zamówienie ma już paragon nr ${existing.number} z ${existing.fiscal_date}` : 'Zamówienie ma już paragon w kolejce druku — ponów jego druk zamiast drukować nowy');
  const calc = await receiptCalculationInTx(c, orderId, b, true);
  ensure(!calc.blockers.length && calc.snapshot, 409, calc.blockers.join(' · '));
  const s = calc.snapshot, id = randomUUID();
  await c.query(`INSERT INTO receipt233_receipts(id,tenant_id,order_id,printer_id,printer_unique_number,client_key,actor_id,api_key_id,state,payment_form,buyer_nip,simplified_invoice,
      net_minor,vat_minor,gross_minor,snapshot,scope_hash,attempts)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12,$13,$14,$15::jsonb,encode(sha256(convert_to($15::jsonb::text,'UTF8')),'hex'),0)`,
  [id, a.tenantId, orderId, s.printer.id, s.printer.unique_number, b.client_key, a.userId, a.apiKeyId ?? null, s.payment_form, s.buyer_nip, s.simplified_invoice,
    s.totals.net_minor, s.totals.vat_minor, s.totals.gross_minor, JSON.stringify(s)]);
  await audit(c, a, 'receipt233.queue', id, { order_id: orderId, gross_minor: s.totals.gross_minor, buyer_nip: s.buyer_nip !== null, simplified_invoice: s.simplified_invoice });
  return { id, reused: false };
}
/** Takes the job for one print attempt: queued → sent, or on a retry failed → queued → sent. A job left
 * in `sent` (the answer was lost) is attempted again without a new state: the driver asks the printer
 * first, so a printed job is never printed twice. Returns null when nothing is to be printed. */
export async function claimReceiptInTx(c: PoolClient, a: LocalInvoiceActor, id: string, retry: boolean): Promise<{ job: PrintJob; printer: { host: string; port: number; model_family: ModelFamily; id: string } } | null> {
  await requireReceipt233(c);
  const r = await receiptInTx(c, id, true);
  if (r.state === 'printed') return null;
  ensure(retry || r.state === 'queued', 409, 'Paragon jest już w druku — użyj „Ponów druk”');
  if (r.state !== 'queued') {
    await lockOrderReceipt(c, r.order_id);
    const inv = await orderInvoicesInTx(c, r.order_id);
    ensure(!inv.length, 409, `Zamówienie ma już fakturę ${inv.join(', ')} — paragonu nie drukuje się ponownie`);
  }
  const p = (await c.query('SELECT * FROM receipt233_printers WHERE id=$1', [r.snapshot.printer.id])).rows[0];
  ensure(p?.active, 409, 'Drukarka paragonu nie jest już aktywna — paragon drukuje się na drukarce, na której go zlecono');
  if (r.state === 'failed') await c.query("UPDATE receipt233_receipts SET state='queued',error_code=NULL,error_message=NULL,updated_at=clock_timestamp() WHERE id=$1", [id]);
  if (r.state !== 'sent') await c.query("UPDATE receipt233_receipts SET state='sent',attempts=attempts+1,sent_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [id]);
  await audit(c, a, 'receipt233.send', id, { attempt: r.state === 'sent' ? r.attempts : r.attempts + 1, recovery: r.state === 'sent' });
  const s = r.snapshot;
  return {
    printer: { id: p.id, host: p.host, port: p.port, model_family: p.model_family },
    job: { job_id: id, buyer_nip: s.buyer_nip, ptu: s.ptu_table, total_minor: s.totals.gross_minor,
      lines: s.lines.map(l => ({ ptu: l.ptu, quantity: l.quantity, unit_gross_minor: l.unit_gross_minor, gross_minor: l.gross_minor, name: l.name })),
      payment: { form: s.payment_form, amount_minor: s.totals.gross_minor } },
  };
}
/** Records the printer's answer: sent → printed (number, fiscal date) or sent → failed (error). An uncertain
 * fault (the answer was lost after OPEN: the printer may have printed) keeps `sent`, which refuses invoices
 * for the sale; "Sprawdź i ponów druk" asks the printer (QUERY) before it prints. */
export async function recordReceiptOutcomeInTx(c: PoolClient, a: LocalInvoiceActor, id: string, o: PrintOutcome): Promise<void> {
  const r = await receiptInTx(c, id, true);
  ensure(r.state === 'sent', 409, 'Stan paragonu zmienił się w trakcie druku — odśwież zamówienie');
  if (o.ok) {
    await c.query("UPDATE receipt233_receipts SET state='printed',printer_receipt_number=$2,fiscal_date=$3,printed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",
      [id, o.receipt.number, o.receipt.fiscal_date]);
    await audit(c, a, 'receipt233.printed', id, { number: o.receipt.number, fiscal_date: o.receipt.fiscal_date, already_printed: o.receipt.already_printed, attempts: r.attempts });
  } else if (o.uncertain) {
    await audit(c, a, 'receipt233.uncertain', id, { code: o.code, attempts: r.attempts });
  } else {
    await c.query("UPDATE receipt233_receipts SET state='failed',error_code=$2,error_message=$3,updated_at=clock_timestamp() WHERE id=$1", [id, o.code, o.message.slice(0, 300)]);
    await audit(c, a, 'receipt233.failed', id, { code: o.code, attempts: r.attempts });
  }
}

// ── daily report ─────────────────────────────────────────────────────────────────────────────────
export type DailyReportView = { id: string; printer_unique_number: string; fiscal_date: string; report_number: string; printer_receipts: number; app_receipts: number;
  printer_totals: DailyReportResult['totals']; app_totals: { ptu: string; gross_minor: string; vat_minor: string }[]; matches: boolean; created_at: string };
const reportView = (r: any): DailyReportView => ({ id: r.id, printer_unique_number: r.printer_unique_number, fiscal_date: r.fiscal_day ?? day(r.fiscal_date)!, report_number: r.report_number,
  printer_receipts: r.printer_receipts, app_receipts: r.app_receipts, printer_totals: r.printer_totals, app_totals: r.app_totals, matches: r.matches, created_at: iso(r.created_at)! });
export async function dailyReportsInTx(c: PoolClient): Promise<DailyReportView[]> {
  return (await c.query("SELECT *,to_char(fiscal_date,'YYYY-MM-DD') fiscal_day FROM receipt233_daily_reports ORDER BY fiscal_date DESC,created_at DESC LIMIT 60")).rows.map(reportView);
}
export async function dailyReportOfInTx(c: PoolClient, printerId: string, fiscalDate: string): Promise<DailyReportView | null> {
  const r = (await c.query("SELECT *,to_char(fiscal_date,'YYYY-MM-DD') fiscal_day FROM receipt233_daily_reports WHERE printer_id=$1 AND fiscal_date=$2", [printerId, fiscalDate])).rows[0];
  return r ? reportView(r) : null;
}
/** Stores the printer's daily report with the app's sums of the receipts printed on that printer that day
 * (gross per PTU must agree; VAT is computed by the printer per PTU total and may differ by a grosz). */
export async function storeDailyReportInTx(c: PoolClient, a: LocalInvoiceActor, printer: PrinterView, rep: DailyReportResult): Promise<DailyReportView> {
  const rows = (await c.query("SELECT snapshot FROM receipt233_receipts WHERE printer_id=$1 AND state='printed' AND fiscal_date=$2", [printer.id, rep.fiscal_date])).rows;
  const sums = new Map<string, { gross: bigint; vat: bigint }>();
  for (const r of rows) for (const t of (r.snapshot as Receipt233Snapshot).ptu_totals) {
    const s = sums.get(t.ptu) ?? { gross: 0n, vat: 0n };
    sums.set(t.ptu, { gross: s.gross + BigInt(t.gross_minor), vat: s.vat + BigInt(t.vat_minor) });
  }
  const app = PTU_LETTERS.filter(l => sums.has(l)).map(l => ({ ptu: l, gross_minor: String(sums.get(l)!.gross), vat_minor: String(sums.get(l)!.vat) }));
  const matches = rows.length === rep.receipts && app.length === rep.totals.length && app.every((x, i) => x.ptu === rep.totals[i]!.ptu && x.gross_minor === rep.totals[i]!.gross_minor);
  const r = (await c.query(`INSERT INTO receipt233_daily_reports(tenant_id,printer_id,printer_unique_number,fiscal_date,report_number,printer_receipts,printer_totals,app_receipts,app_totals,matches,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11) RETURNING *,to_char(fiscal_date,'YYYY-MM-DD') fiscal_day`,
  [a.tenantId, printer.id, printer.unique_number, rep.fiscal_date, rep.number, rep.receipts, JSON.stringify(rep.totals), rows.length, JSON.stringify(app), matches, a.userId])).rows[0];
  await audit(c, a, 'receipt233.daily_report', r.id, { fiscal_date: rep.fiscal_date, number: rep.number, matches });
  return reportView(r);
}

// ── invoice to a receipt (used by the 157 and 230 issue paths) ───────────────────────────────────
/** 157: its pinned preview confirms "the invoice is not issued to a fiscal receipt", so an order with a
 * receipt (printed or in print) cannot get a 157 invoice; the invoice to the receipt is a FV-S (230). */
export async function assertNoReceiptFor157InTx(c: PoolClient, orderId: string): Promise<void> {
  if (!(await receipt233Available(c))) return;
  await lockOrderReceipt(c, orderId);
  const r = await orderReceiptInTx(c, orderId);
  if (!r || r.state === 'failed') return;
  ensure(r.state === 'printed', 409, 'Paragon tego zamówienia jest w trakcie druku — poczekaj na wynik druku przed wystawieniem faktury');
  ensure(false, 409, `Zamówienie ma paragon fiskalny nr ${r.number} z ${r.fiscal_date}. Lokalna faktura B2C potwierdza, że nie jest wystawiana do paragonu — fakturę do paragonu wystaw jako FV-S (panel „Faktura VAT: B2B, EUR, ZW/NP/OO/OSS”).`);
}
export type ReceiptLinkPlan = { receipt_id: string; number: string; fiscal_date: string; printer_unique_number: string } | null;
/** 230: refusals of an invoice for this order and buyer against its receipt; the receipt to link when printed. */
export async function receiptForInvoiceInTx(c: PoolClient, orderId: string, inv: { buyer_kind: 'consumer' | 'business'; buyer_tax_id_kind: 'nip' | 'eu_vat' | 'none'; buyer_tax_id: string; gross_minor: string }, lock: boolean): Promise<{ plan: ReceiptLinkPlan; blockers: string[] }> {
  if (!(await receipt233Available(c))) return { plan: null, blockers: [] };
  if (lock) await lockOrderReceipt(c, orderId);
  const r = await orderReceiptInTx(c, orderId);
  if (!r) return { plan: null, blockers: [] };
  const blockers = invoiceToReceiptRefusals({ state: r.state, number: r.number, buyer_nip: r.buyer_nip, gross_minor: BigInt(r.gross_minor) }, { ...inv, gross_minor: BigInt(inv.gross_minor) });
  if (r.invoice) blockers.push(`Paragon ${r.number} ma już fakturę ${r.invoice.number}`);
  return { plan: r.state === 'printed' ? { receipt_id: r.id, number: r.number!, fiscal_date: r.fiscal_date!, printer_unique_number: r.printer_unique_number } : null, blockers };
}
export async function linkInvoiceToReceiptInTx(c: PoolClient, a: LocalInvoiceActor, plan: NonNullable<ReceiptLinkPlan>, documentId: string, mode: 'local_invoice' | 'invoice230'): Promise<void> {
  await c.query('INSERT INTO receipt233_invoice_links(tenant_id,receipt_id,document_id,document_mode,actor_id) VALUES($1,$2,$3,$4,$5)', [a.tenantId, plan.receipt_id, documentId, mode, a.userId]);
  await audit(c, a, 'receipt233.invoice_link', plan.receipt_id, { document_id: documentId, mode, receipt_number: plan.number });
}
/** The receipt an issued invoice was issued to (print, FA(3) FP and DodatkowyOpis). */
export async function receiptOfInvoiceInTx(c: PoolClient, documentId: string): Promise<{ number: string; fiscal_date: string; printer_unique_number: string; buyer_nip: string | null } | null> {
  if (!(await receipt233Available(c))) return null;
  const r = (await c.query(`SELECT r.printer_receipt_number number,to_char(r.fiscal_date,'YYYY-MM-DD') fiscal_date,r.printer_unique_number,r.buyer_nip
    FROM receipt233_invoice_links l JOIN receipt233_receipts r ON (r.tenant_id,r.id)=(l.tenant_id,l.receipt_id) WHERE l.document_id=$1`, [documentId])).rows[0];
  return r ?? null;
}
