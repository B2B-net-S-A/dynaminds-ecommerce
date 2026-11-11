/** Local invoice issue with the 226 tax snapshot. local-invoices.ts is source-pinned
 * (scripts/full-base-scale-http-ports.mjs) and its transaction is private, so, like
 * the Base invoices family, this port runs the same SQL contract in the same order
 * inside ONE transaction: identity frame, locks, local_invoice_issue, audit, then the
 * per-line tax snapshot, immediate constraints. Numbering stays the 157 counter. */
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { audit } from './domain';
import { ensure } from './errors';
import { tokenHash } from './security';
import { assertNoFa3DraftProjectInTx, fa3DraftOwnerInTx } from './fa3-draft-access';
import { localInvoicesAvailable, localInvoiceRequestActor } from './local-invoices';
import { localInvoiceIssueInput, type LocalInvoiceActor } from './local-invoice-values';
import { frame, nativeProblem } from './base-wire-invoices-runtime';
import { captureLocalInvoiceTaxInTx, documentTaxSnapshotInTx, localInvoiceTaxFactsInTx, requireTax226 } from './tax226';
import { captureDocumentNbpRateInTx, documentNbpRateInTx, nbp227Available, nbpRateBeforeNumberingInTx } from './nbp227';
import { assertNoInvoice230InTx, invoice230DocumentInTx, invoice230PreviewExistsInTx, issueInvoice230InTx } from './invoice230';
import { assertNoReceiptFor157InTx } from './receipt233';

type Req = Parameters<typeof localInvoiceRequestActor>[0];
const credentials = new WeakMap<LocalInvoiceActor, string>();
/** Native request actor plus the same credential the native FV frame hashes. */
export function taxInvoiceActor(req: Req, sessionName: string): LocalInvoiceActor {
  const actor = localInvoiceRequestActor(req, sessionName), key = req.apiKeyId ?? (req.actor as LocalInvoiceActor).apiKeyId;
  const raw = key ? req.headers.authorization?.replace(/^Bearer /, '') : req.cookies[sessionName] ?? req.headers.authorization?.replace(/^Bearer /, '');
  ensure(raw, 401, 'Brak sesji lub klucza FV');
  credentials.set(actor, raw);
  return actor;
}
/** Identity frame of the native FV (role, key, MFA) and the 226 check, around one tenant transaction; also used by 230. */
export async function taxInvoiceTransaction<T>(a: LocalInvoiceActor, writing: boolean, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const raw = credentials.get(a);
  ensure(raw, 401, 'Brak zaufanego kontekstu żądania FV');
  ensure(await localInvoicesAvailable(pool), 503, 'Lokalne faktury nie są dostępne');
  try { return await tenantTx(a.tenantId, async c => { await frame(c, a, raw, writing); await requireTax226(c); return fn(c); }); }
  catch (error) { throw nativeProblem(error); }
}
/** Native flags() of local-invoices.ts: current role and write grant after the last identity lock. */
export async function taxInvoiceFlags(c: PoolClient, a: LocalInvoiceActor, writing: boolean) {
  const h = tokenHash(credentials.get(a)!);
  await c.query('SELECT public.local_invoice_identity($1,$2,$3,$4,true)', [a.userId, a.apiKeyId ?? null, h, writing]);
  await localInvoicesAvailable(c);
  const g = (await c.query('SELECT local_invoice_access($1,$2,$3,false) g', [a.userId, a.apiKeyId ?? null, writing])).rows[0].g;
  ensure(g.key_valid, 401, 'Klucz faktury jest wycofany lub wygasł');
  ensure(g.allowed, 403, 'Brak aktualnych uprawnień do faktury');
  const w = (await c.query('SELECT local_invoice_access($1,$2,true,false) g', [a.userId, a.apiKeyId ?? null])).rows[0].g;
  await c.query('SELECT public.local_invoice_identity($1,$2,$3,$4,false)', [a.userId, a.apiKeyId ?? null, h, writing]);
  return { available: true, read_only: false, current_role: g.role, can_read: true, can_write: Boolean(w.allowed), can_create_series: Boolean(w.allowed && g.role === 'admin') };
}
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
/** Native documentView(): the document must equal its immutable receipt. */
async function documentView(c: PoolClient, id: string) {
  const d = (await c.query("SELECT * FROM documents WHERE id=$1 AND kind='invoice' AND mode='local_invoice'", [id])).rows[0];
  ensure(d, 404, 'Nie znaleziono własnej faktury');
  const r = (await c.query('SELECT * FROM local_invoice_receipts WHERE document_id=$1', [id])).rows[0];
  ensure(r && r.order_id === d.order_id && r.number === d.number && d.data.preview_id === r.preview_id && d.data.scope_hash === r.scope_hash
    && isDeepStrictEqual(d.data, { ...r.snapshot, number: r.number, preview_id: r.preview_id, scope_hash: r.scope_hash, local_only: true, ksef_state: 'not_submitted', fiscalized: false }),
  503, 'Niepełny trwały dowód faktury');
  return {
    document: { id: d.id, order_id: d.order_id, number: d.number, kind: 'invoice' as const, mode: 'local_invoice' as const, data: d.data, created_at: iso(d.created_at) },
    receipt: { id: r.id, document_id: r.document_id, preview_id: r.preview_id, series_id: r.series_id, year: r.year, sequence: r.sequence, number: r.number, scope_hash: r.scope_hash, created_at: iso(r.created_at) },
  };
}
async function previewSnapshot(c: PoolClient, id: string) {
  const p = (await c.query('SELECT order_id,snapshot FROM local_invoice_previews WHERE id=$1', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu faktury');
  return p as { order_id: string; snapshot: any };
}

/** Tax facts the issue of this preview would snapshot now, with the reasons it would be refused. */
export async function localInvoicePreviewTax(a: LocalInvoiceActor, previewId: string) {
  return taxInvoiceTransaction(a, false, async c => {
    const p = await previewSnapshot(c, previewId), t = await localInvoiceTaxFactsInTx(c, p.snapshot);
    return { ...(await taxInvoiceFlags(c, a, false)), preview_id: previewId, facts: t.facts, blockers: t.blockers };
  });
}
/** issueLocalInvoice() of local-invoices.ts plus the 226 snapshot, in one transaction. */
export async function issueLocalInvoiceWithTax(a: LocalInvoiceActor, previewId: string, input: unknown) {
  const b = localInvoiceIssueInput.parse(input);
  return taxInvoiceTransaction(a, true, async c => {
    // 230: a preview of an invoice the 157 math cannot express is issued in its own sub-series.
    if (await invoice230PreviewExistsInTx(c, previewId)) {
      const r = await issueInvoice230InTx(c, a, previewId, b);
      return { ...(await taxInvoiceFlags(c, a, true)), ...(await invoice230DocumentInTx(c, r.document_id)), invoice230: true, reused: r.reused };
    }
    await fa3DraftOwnerInTx(c, () => c.query('SELECT public.local_invoice_locks()'));
    const p = await previewSnapshot(c, previewId);
    await assertNoFa3DraftProjectInTx(c, p.order_id);
    await assertNoInvoice230InTx(c, p.order_id);
    // 233: the 157 preview confirms the invoice is not issued to a fiscal receipt.
    await assertNoReceiptFor157InTx(c, p.order_id);
    const done = (await c.query("SELECT 1 FROM documents WHERE order_id=$1 AND kind='invoice' AND mode='local_invoice'", [p.order_id])).rowCount;
    if (!done) { const t = await localInvoiceTaxFactsInTx(c, p.snapshot); ensure(!t.blockers.length, 409, t.blockers.join(' · ')); }
    // 227: a foreign-currency invoice needs a stored NBP rate for its tax point before numbering.
    if (!done) await nbpRateBeforeNumberingInTx(c, p.snapshot);
    const r = (await c.query('SELECT local_invoice_issue($1,$2::jsonb,$3,$4) r', [previewId, JSON.stringify(b), a.userId, a.apiKeyId ?? null])).rows[0].r;
    if (!r.reused) await audit(c, a, 'local_invoice.issue', r.document_id, { order_id: r.order_id, preview_id: previewId, number: r.number, scope_hash: r.scope_hash });
    // A replay keeps the snapshot of its own issue; an invoice issued elsewhere gets no late snapshot.
    if (!r.reused) await captureLocalInvoiceTaxInTx(c, a, r.document_id, (await c.query('SELECT data FROM documents WHERE id=$1', [r.document_id])).rows[0].data, true);
    if (!r.reused) await captureDocumentNbpRateInTx(c, a, r.document_id, (await c.query('SELECT data FROM documents WHERE id=$1', [r.document_id])).rows[0].data, true);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const result = await documentView(c, r.document_id);
    return { ...(await taxInvoiceFlags(c, a, true)), ...result, tax: await documentTaxSnapshotInTx(c, r.document_id, result.document.data), reused: Boolean(r.reused) };
  });
}
/** Stored tax snapshot of an issued local invoice (null when issued without it). */
export async function localInvoiceDocumentTax(a: LocalInvoiceActor, documentId: string) {
  return taxInvoiceTransaction(a, false, async c => {
    const v = await documentView(c, documentId), tax = await documentTaxSnapshotInTx(c, documentId, v.document.data);
    return { ...(await taxInvoiceFlags(c, a, false)), document_id: documentId, tax,
      note: tax ? null : 'Faktura wystawiona bez migawki podatkowej 226 (inna ścieżka wystawienia lub przed migracją).' };
  });
}
/** NBP rate record of an issued local invoice: none for a PLN invoice, the stored record otherwise. */
export async function localInvoiceDocumentNbp(a: LocalInvoiceActor, documentId: string) {
  return taxInvoiceTransaction(a, false, async c => {
    const v = await documentView(c, documentId), currency = String(v.document.data.currency);
    const nbp = currency !== 'PLN' && await nbp227Available(c) ? await documentNbpRateInTx(c, documentId) : null;
    return { ...(await taxInvoiceFlags(c, a, false)), document_id: documentId, currency, nbp,
      note: currency === 'PLN' ? 'Faktura w PLN — przeliczenie kursem NBP nie dotyczy.' : nbp ? null : 'Faktura w walucie obcej bez zapisu kursu NBP (wystawiona przed migracją 227 lub inną ścieżką).' };
  });
}
