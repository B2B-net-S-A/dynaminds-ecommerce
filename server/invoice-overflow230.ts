/** Invoices beyond the lifetime budget of the sealed 157 local invoice go to the 230 FV-S sub-series
 * (owner decision 29.10.2026, docs/parity/INVOICE-157-OVERFLOW-230-20261029.md).
 *
 * local_invoice_budget (157_local_invoices.sql:137, also run by the deferred local_invoice_complete
 * trigger) refuses a company's 2001st preview or receipt and any history over 64 MiB, for every plan
 * and for life (23514 "Limit historii faktur"). local-invoices.ts, local-invoice-routes.ts and
 * local-invoice-values.ts are hash-pinned and the 157 SQL is sealed, so the routing lives here:
 * - an app-level preHandler of the pinned POST /api/local-invoices/orders/:id/previews answers the
 *   request itself (as the /issue alias does for its route): a replay of a stored 157 preview and a
 *   company under the limit get the native previewLocalInvoice() exactly as the route would; a company
 *   at the limit (bounded index counts) or one the native preview refuses with the budget error gets a
 *   230 preview of the same consumer sale, with a Polish note naming the FV-S series;
 * - the issue stays POST …/previews/:id/tax-issue (or the native /issue alias), which already issues a
 *   230 preview in FV-S/<prefix>/<year>/<seq>; a preSerialization hook adds the series note;
 * - Base addInvoice uses overflowIssueInTx() inside its own transaction (base-wire-invoices-runtime.ts).
 * The routed invoice must be one the 157 form describes: the user confirmed a PLN consumer sale in
 * Poland, ordinary domestic VAT, no special procedure and no fiscal receipt — anything else is refused
 * with the reason instead of being issued differently. */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantReadTx } from './db';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { localInvoiceRequestActor, previewLocalInvoice } from './local-invoices';
import { localInvoicePreviewInput, type LocalInvoiceActor, type LocalInvoicePreviewInput } from './local-invoice-values';
import { taxInvoiceActor, taxInvoiceFlags, taxInvoiceTransaction } from './tax226-local-invoices';
import { tax226Available } from './tax226';
import { invoice230Available, invoice230SnapshotInTx, issueInvoice230InTx, storeInvoice230PreviewInTx, type Invoice230Snapshot } from './invoice230';

/** Lifetime counters of local_invoice_budget (157:138): more than this many previews or receipts is refused. */
export const LOCAL_INVOICE_HISTORY_LIMIT = 2000;
/** RAISE text of local_invoice_budget; the native transaction maps its 23514 to a 409 with this message. */
export const LOCAL_INVOICE_HISTORY_REFUSAL = 'Limit historii faktur';
export const OVERFLOW_PREVIEW_ROUTE = '/api/local-invoices/orders/:id/previews';
const ISSUE_ROUTES = new Set(['/api/local-invoices/previews/:id/tax-issue', '/api/local-invoices/previews/:id/issue']);
/** VAT rate codes of a domestic 230 invoice that the 157 math also expresses (23/8/5/0%). */
const DOMESTIC_RATE_CODES = new Set(['23', '8', '5', '0 KR']);

export type OverflowReason = 'previews' | 'receipts' | 'history';
export type LocalInvoiceBudget = { previews: number; receipts: number; full: boolean; reason: OverflowReason | null };

/** The two lifetime counters, each counted only up to the limit through the (tenant_id, id) unique index. */
export async function localInvoiceBudgetInTx(c: PoolClient, tenantId: string): Promise<LocalInvoiceBudget> {
  const r = (await c.query(`SELECT (SELECT count(*) FROM (SELECT 1 FROM local_invoice_previews WHERE tenant_id=$1 LIMIT $2) p)::int previews,
    (SELECT count(*) FROM (SELECT 1 FROM local_invoice_receipts WHERE tenant_id=$1 LIMIT $2) r)::int receipts`, [tenantId, LOCAL_INVOICE_HISTORY_LIMIT])).rows[0];
  // The next preview (and its receipt) would be the 2001st: local_invoice_budget refuses it.
  const reason: OverflowReason | null = r.previews >= LOCAL_INVOICE_HISTORY_LIMIT ? 'previews' : r.receipts >= LOCAL_INVOICE_HISTORY_LIMIT ? 'receipts' : null;
  return { previews: r.previews, receipts: r.receipts, full: reason !== null, reason };
}
/** The budget refusal of the native 157 preview/issue (Problem from local-invoices.ts, or the raw 23514 inside a shared transaction). */
export function isLocalInvoiceHistoryRefusal(error: unknown): boolean {
  if (error instanceof Problem) return error.status === 409 && error.message === LOCAL_INVOICE_HISTORY_REFUSAL;
  const e = error as { code?: string; message?: string } | null;
  return e?.code === '23514' && e.message === LOCAL_INVOICE_HISTORY_REFUSAL;
}

export function overflowSeriesNote(prefix: string, year: number, reason: OverflowReason): string {
  const why = reason === 'history'
    ? `historia faktur lokalnych tej firmy przekroczyła limit 64 MiB`
    : `firma ma już ${LOCAL_INVOICE_HISTORY_LIMIT} ${reason === 'previews' ? 'podglądów' : 'wystawionych'} faktur lokalnych`;
  return `Limit faktur lokalnych B2C jest wyczerpany (${why}; limit obowiązuje dożywotnio w każdym planie). `
    + `Ta faktura zostanie wystawiona w podserii FV-S: numer FV-S/${prefix}/${year}/…, a nie ${prefix}/${year}/…. `
    + 'Treść faktury jest taka sama; korekta, KSeF i JPK obsługują ją jak każdą fakturę FV-S.';
}
export const issuedSeriesNote = (number: string) => `Faktura wystawiona w podserii FV-S (numeracja 230): ${number}.`;

/** The 230 request of a 157 preview body: the same consumer, order version, series, delivery VAT and sale date. */
export function invoice230RequestOf(b: Pick<LocalInvoicePreviewInput, 'series_id' | 'order_version' | 'shipping_vat' | 'buyer' | 'sell_date'>) {
  const { street, postal_code, city, country } = b.buyer;
  return { series_id: b.series_id, order_version: b.order_version, shipping_vat: b.shipping_vat, sell_date: b.sell_date,
    buyer: { kind: 'consumer' as const, name: b.buyer.name, address: { street, postal_code, city, country } } };
}
/** Why a computed 230 invoice is not the sale the 157 form confirmed (empty: it is). */
export function overflowScopeRefusals(s: Invoice230Snapshot, receipt: unknown): string[] {
  const out: string[] = [];
  if (s.currency !== 'PLN' || s.order.currency !== 'PLN') out.push('Faktura lokalna B2C obsługuje wyłącznie PLN — fakturę w innej walucie wystaw w panelu „Faktura VAT: B2B, EUR, ZW/NP/OO/OSS”');
  if (s.buyer.kind !== 'consumer' || s.buyer.address.country !== 'PL') out.push('Faktura lokalna B2C obsługuje wyłącznie konsumenta z Polski');
  if (s.procedure !== 'domestic' || s.reverse_charge || s.exemption || s.mpp.required || s.categories.some(x => !DOMESTIC_RATE_CODES.has(x.rate_code)))
    out.push('Zamówienie ma pozycje ze stawką ZW/NP/OO/OSS lub procedurą szczególną — fakturę wystaw w panelu „Faktura VAT: B2B, EUR, ZW/NP/OO/OSS”');
  if (receipt) out.push('Zamówienie ma paragon fiskalny — fakturę do paragonu wystaw w panelu „Faktura VAT: B2B, EUR, ZW/NP/OO/OSS”');
  return out;
}

/** Stores the 230 preview of a 157 request inside the caller's transaction (FV-S sub-series, own counter). */
async function overflowPreviewInTx(c: PoolClient, a: LocalInvoiceActor, orderId: string, b: LocalInvoicePreviewInput, reason: OverflowReason) {
  const request = invoice230RequestOf(b);
  // A stored 230 preview of this key is a replay (storeInvoice230PreviewInTx checks it is the same request).
  if (!(await c.query('SELECT 1 FROM invoice230_previews WHERE client_key=$1', [b.client_key])).rowCount) {
    const calc = await invoice230SnapshotInTx(c, orderId, request, false);
    const scope = overflowScopeRefusals(calc.snapshot, calc.receipt);
    ensure(!scope.length, 409, scope.join(' · '));
  }
  const r = await storeInvoice230PreviewInTx(c, a, orderId, { client_key: b.client_key, ...request });
  const stored = overflowScopeRefusals(r.preview.snapshot, null); // the locked recomputation that was stored
  ensure(!stored.length, 409, stored.join(' · '));
  if (!r.reused) await audit(c, a, 'local_invoice.overflow230', r.preview.id, { order_id: orderId, reason, client_key: b.client_key, limit: LOCAL_INVOICE_HISTORY_LIMIT });
  return r;
}

/** POST /api/local-invoices/orders/:id/previews at the 157 limit: the 230 preview, its flags and the note. */
export async function overflowPreview(a: LocalInvoiceActor, orderId: string, b: LocalInvoicePreviewInput, reason: OverflowReason) {
  return taxInvoiceTransaction(a, true, async c => {
    const r = await overflowPreviewInTx(c, a, orderId, b, reason);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const s = r.preview.snapshot;
    return { ...(await taxInvoiceFlags(c, a, true)), ...r, invoice230: true as const, series: 'FV-S' as const,
      series_note: overflowSeriesNote(s.series.prefix, s.year, reason), overflow: { reason, limit: LOCAL_INVOICE_HISTORY_LIMIT },
      issue_path: `/local-invoices/previews/${r.preview.id}/tax-issue` };
  });
}

/** Base addInvoice at the 157 limit: 230 preview + issue in the caller's (Base) transaction; returns the document id. */
export type OverflowIssueInput = { client_key: string; series_id: string; order_version: string; shipping_vat: number; sell_date: string;
  buyer: { kind: 'consumer'; name: string; street: string; postal_code: string; city: string; country: 'PL' } };
export async function overflowIssueInTx(c: PoolClient, a: LocalInvoiceActor, orderId: string, input: OverflowIssueInput, reason: OverflowReason): Promise<string> {
  // The body the 157 preview would have taken (same validation), then the 230 preview and issue.
  const b = localInvoicePreviewInput.parse({ ...input, tax_regime: 'ordinary_domestic', consumer_sale_confirmed: true, no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true });
  const p = await overflowPreviewInTx(c, a, orderId, b, reason);
  const r = await issueInvoice230InTx(c, a, p.preview.id, { client_key: randomUUID(), scope_hash: p.preview.scope_hash });
  return r.document_id;
}
/** Whether this copy can route to 230 at all (230 and the 226 tax-issue it uses are installed). */
export async function overflowAvailableInTx(c: PoolClient): Promise<boolean> {
  return (await invoice230Available(c)) && (await tax226Available(c));
}

/** Native project() of local-invoice-routes.ts (the write routes run only when the copy is writable). */
function projectNative(v: any, readOnly: boolean) {
  return { ...v, read_only: readOnly, ...(typeof v.can_write === 'boolean' ? { can_write: !readOnly && v.can_write, can_create_series: !readOnly && v.can_create_series } : {}),
    ...(v.preview ? { preview: { ...v.preview, can_issue: !readOnly && v.preview.can_issue } } : {}) };
}

/** Registered by registerInvoice230Routes when 230 is installed (app.ts unchanged). */
export function registerLocalInvoiceOverflow(app: FastifyInstance, opts: { readOnly: boolean; sessionName: string }): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (opts.readOnly || req.method !== 'POST' || req.routeOptions.url !== OVERFLOW_PREVIEW_ROUTE) return;
    const query = z.strictObject({}).safeParse(req.query), params = z.strictObject({ id: z.uuid().transform(v => v.toLowerCase()) }).safeParse(req.params);
    const body = localInvoicePreviewInput.safeParse(req.body);
    if (!query.success || !params.success || !body.success) return; // the native route answers the invalid request
    const actor = taxInvoiceActor(req as never, opts.sessionName), orderId = params.data.id, b = body.data;
    const state = await tenantReadTx(actor.tenantId, async c => {
      if (!(await overflowAvailableInTx(c))) return null;
      // A stored 157 preview of this key is replayed natively, whatever the budget is now.
      const replay = Boolean((await c.query('SELECT 1 FROM local_invoice_previews WHERE tenant_id=$1 AND client_key=$2', [actor.tenantId, b.client_key])).rowCount);
      return { replay, budget: await localInvoiceBudgetInTx(c, actor.tenantId) };
    });
    if (!state) return; // without 230/226 the native route answers as before
    let reason = state.budget.reason;
    if (state.replay || !reason) {
      try {
        const v = await previewLocalInvoice(localInvoiceRequestActor(req as never, opts.sessionName), orderId, b);
        reply.code(v.reused ? 200 : 201);
        return reply.send(projectNative(v, opts.readOnly));
      } catch (error) {
        // 64 MiB history, or a concurrent preview took the last place: the same request goes to 230.
        if (state.replay || !isLocalInvoiceHistoryRefusal(error)) throw error;
        reason = 'history';
      }
    }
    const v = await overflowPreview(actor, orderId, b, reason);
    reply.code(v.reused ? 200 : 201);
    return reply.send({ ...v, read_only: opts.readOnly });
  });
  // The issue of a 230 preview (tax-issue or the native /issue alias) names the series it used.
  app.addHook('preSerialization', async (req: FastifyRequest, _reply: FastifyReply, payload: any) => {
    if (req.method !== 'POST' || !ISSUE_ROUTES.has(req.routeOptions.url ?? '') || !payload || typeof payload !== 'object') return payload;
    const d = payload.document;
    if (payload.invoice230 !== true || d?.mode !== 'invoice230' || typeof d.number !== 'string') return payload;
    return { ...payload, series: 'FV-S', series_note: issuedSeriesNote(d.number) };
  });
}
