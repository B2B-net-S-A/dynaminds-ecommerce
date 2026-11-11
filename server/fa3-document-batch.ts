/** FA(3) facts of many issued documents in ONE read-only tenant snapshot (tenantReadTx), for the JPK
 * files: the same reads as each module's native detail (documents row equal to its immutable receipt,
 * 230 header and categories, 232 record, 188/206 ledger row equal to its receipt, 226 tax snapshot,
 * 227 rate, 233 receipt link, 229 KSeF number), with the request's identity frame checked once at the
 * start of the snapshot instead of once per document. The native per-document read takes the FOR SHARE
 * identity pin (local_invoice_identity(..., pin=true)), which a READ ONLY transaction cannot take; the
 * batch uses the same unpinned check the base-wire reads use (frame(): session/key, MFA, role, grant),
 * plus the module guards of 188/206 once. B2B 159/160 documents keep their native managed read. */
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { ensure, Problem } from './errors';
import { frame, nativeProblem } from './base-wire-invoices-runtime';
import { requireTax226 } from './tax226';
import { documentKsefInTx, type DocumentKsef } from './ksef229-numbers';
import { invoice230DocumentInTx } from './invoice230';
import { invoice230Fa3Model, invoice230Rate } from './invoice230-fa3';
import { invoice232DocumentInTx } from './invoice232';
import { invoice232Fa3Model, invoice232Rate } from './invoice232-fa3';
import { receiptOfInvoiceInTx } from './receipt233';
import { consumerCreditHash } from './local-consumer-credit-arithmetic';
import { consumerCreditFa3Model, localInvoiceFa3Model, type Fa3DocumentRate } from './fa3-adapters';
import { documentRateInTx, taxSnapshotInTx, type Fa3Request } from './fa3-documents';
import { Fa3DocumentError, type Fa3Document } from './fa3-render';
import type { LocalInvoiceActor } from './local-invoice-values';
import type { LocalInvoiceDocument } from './local-invoices';

/** Modes read in the batch; the rest (B2B 159/160) keep their native per-document read. */
export const FA3_BATCH_MODES = new Set(['local_invoice', 'invoice230', 'invoice232_correction', 'local_consumer_credit', 'consumer_return_credit']);
export type Fa3BatchFacts = { model: Fa3Document; rate: Fa3DocumentRate | null; ksef: DocumentKsef };
/** Per document: its facts, or the error its native read would have thrown (replayed in list order). */
export type Fa3BatchResult = Map<string, { facts: Fa3BatchFacts } | { error: unknown }>;
export type Fa3BatchFrame = { actor: LocalInvoiceActor; credential: string };

/** Identity of the request as the native FV actors take it (session cookie, or the API key's bearer token). */
export function fa3BatchFrame(req: Fa3Request, sessionName: string): Fa3BatchFrame {
  ensure(req.currentUser?.id === req.actor.userId && req.currentUser.tenant_id === req.actor.tenantId, 401, 'Brak natywnej tożsamości żądania FV');
  const key = req.apiKeyId ?? (req.actor as LocalInvoiceActor).apiKeyId;
  const credential = key ? req.headers.authorization?.replace(/^Bearer /, '') : req.cookies[sessionName] ?? req.headers.authorization?.replace(/^Bearer /, '');
  ensure(credential, 401, 'Brak sesji lub klucza FV');
  return { actor: Object.freeze({ ...req.actor, ...(key ? { apiKeyId: key } : {}) }) as LocalInvoiceActor, credential };
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
/** Native documentView() of 157: the document must equal its immutable receipt. */
async function localInvoiceInTx(c: PoolClient, id: string): Promise<LocalInvoiceDocument> {
  const d = (await c.query("SELECT * FROM documents WHERE id=$1 AND kind='invoice' AND mode='local_invoice'", [id])).rows[0];
  ensure(d, 404, 'Nie znaleziono własnej faktury');
  const r = (await c.query('SELECT * FROM local_invoice_receipts WHERE document_id=$1', [id])).rows[0];
  ensure(r && r.order_id === d.order_id && r.number === d.number && d.data.preview_id === r.preview_id && d.data.scope_hash === r.scope_hash &&
    isDeepStrictEqual(d.data, { ...r.snapshot, number: r.number, preview_id: r.preview_id, scope_hash: r.scope_hash, local_only: true, ksef_state: 'not_submitted', fiscalized: false }),
  503, 'Niepełny trwały dowód faktury');
  return { id: d.id, order_id: d.order_id, number: d.number, kind: 'invoice', mode: 'local_invoice', data: d.data, created_at: iso(d.created_at) };
}
/** Native detail() of 188 / 206: the ledger row must equal its immutable receipt. */
async function creditInTx(c: PoolClient, id: string, mode: 'local_consumer_credit' | 'consumer_return_credit') {
  const [documents, receipts, missing, broken] = mode === 'local_consumer_credit'
    ? ['local_consumer_credit_documents', 'local_consumer_credit_receipts', 'Brak własnej korekty188', 'Niepełny trwały dokument188']
    : ['return_credit206_documents', 'return_credit206_receipts', 'Brak własnej korekty', 'Niepełny trwały dokument'];
  const d = (await c.query(`SELECT * FROM ${documents} WHERE id=$1`, [id])).rows[0], r = (await c.query(`SELECT * FROM ${receipts} WHERE document_id=$1`, [id])).rows[0];
  ensure(d && r, 404, missing);
  ensure(d.kind === 'correction' && d.mode === mode && isDeepStrictEqual(d.data, { ...r.snapshot, number: r.number, year: r.year, sequence: r.sequence, preview_id: r.preview_id, scope_hash: r.scope_hash }) &&
    d.original_document_id === r.original_document_id && d.return_id === r.return_id && r.calculation_hash === consumerCreditHash(r.snapshot.calculation), 503, broken);
  return { id: d.id, order_id: d.order_id, original_document_id: d.original_document_id, return_id: d.return_id, kind: d.kind, mode: d.mode, number: d.number, data: d.data, created_at: d.created_at.toISOString() };
}
/** SQLSTATE mapping of the 188/206 modules (their mapped()): every other error is 503. */
export function creditProblem(error: unknown): Problem {
  if (error instanceof Problem) return error;
  const code = (error as { code?: string })?.code;
  if (code === '28000') return new Problem(401, 'Sesja dokumentu wygasła');
  if (code === '42501') return new Problem(403, 'Brak aktualnych praw dokumentu');
  if (code === 'P0002') return new Problem(404, 'Nie znaleziono własnego źródła korekty');
  if (['23514', '23505', '40001', '40P01'].includes(code ?? '')) return new Problem(409, 'Dane dokumentu, zwrotu lub numeracji zmieniły się; odczytaj oryginalny wynik');
  if (code === '22023') return new Problem(422, 'Niepełny obsługiwany zakres korekty');
  if (code === '54000') return new Problem(413, 'Całe źródło korekty przekracza limit');
  return new Problem(503, 'Niekompletny moduł lub niedostępny odczyt korekty');
}
/** Module check of 188/206 as owner, like their owner(): the guard functions are not granted to dyna_app.
 * The first error wins (a failed guard aborts the transaction, so restoring the role fails too). */
export async function creditModuleCheckInTx(c: Pick<PoolClient, 'query'>, tenantId: string, sql: string, params: unknown[]): Promise<void> {
  const r = (await c.query("SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(r.owner === 'postgres' && r.role === 'dyna_app' && r.tenant === tenantId, 403, 'Nieprawidłowy własny kontekst');
  await c.query('RESET ROLE');
  let first: unknown, failed = false;
  try { await c.query(sql, params); } catch (e) { failed = true; first = e; }
  try { await c.query('SET LOCAL ROLE dyna_app'); } catch (e) { if (!failed) { failed = true; first = e; } }
  if (failed) throw creditProblem(first);
}

async function factsInTx(c: PoolClient, id: string, mode: string): Promise<Fa3BatchFacts> {
  if (mode === 'local_invoice') {
    const document = await localInvoiceInTx(c, id);
    const tax = await taxSnapshotInTx(c, id, document.data), rate = await documentRateInTx(c, id), ksef = await documentKsefInTx(c, id);
    return { model: localInvoiceFa3Model(document, tax, rate), rate, ksef };
  }
  if (mode === 'invoice230') {
    const { document, record } = await invoice230DocumentInTx(c, id), receipt = await receiptOfInvoiceInTx(c, id), ksef = await documentKsefInTx(c, id);
    return { model: { ...invoice230Fa3Model(document, record), receipt }, rate: invoice230Rate(document, record), ksef };
  }
  if (mode === 'invoice232_correction') {
    const { document, record } = await invoice232DocumentInTx(c, id), ksef = await documentKsefInTx(c, id);
    return { model: invoice232Fa3Model(document, record), rate: invoice232Rate(document, record), ksef };
  }
  const document = await creditInTx(c, id, mode as 'local_consumer_credit' | 'consumer_return_credit');
  const original = document.data.original_document;
  const tax = await taxSnapshotInTx(c, original.id, original.data), originalKsef = await documentKsefInTx(c, original.id), ksef = await documentKsefInTx(c, id);
  return { model: consumerCreditFa3Model(document as never, tax, originalKsef.number), rate: null, ksef };
}

/** Facts of `listed` documents of FA3_BATCH_MODES inside the caller's tenantReadTx. A document its module
 * cannot express (Fa3DocumentError) or whose native read refuses (Problem) is recorded and replayed by the
 * caller at its position in the list, as the per-document reads did; any other error ends the snapshot. */
export async function fa3DocumentFactsBatchInTx(c: PoolClient, f: Fa3BatchFrame, listed: readonly { id: string; mode: string }[]): Promise<Fa3BatchResult> {
  const out: Fa3BatchResult = new Map(), todo = listed.filter(d => FA3_BATCH_MODES.has(d.mode));
  if (!todo.length) return out;
  const modes = new Set(todo.map(d => d.mode));
  try {
    await frame(c, f.actor, f.credential, false);
    if (modes.has('invoice230') || modes.has('invoice232_correction')) await requireTax226(c);
  } catch (e) { throw nativeProblem(e); }
  if (modes.has('local_consumer_credit')) await creditModuleCheckInTx(c, f.actor.tenantId, 'SELECT public.local_consumer_credit_require($1,$2,false,false)', [f.actor.userId, f.actor.apiKeyId ?? null]);
  if (modes.has('consumer_return_credit')) await creditModuleCheckInTx(c, f.actor.tenantId, 'SELECT public.return_credit206_require($1,$2,false,false)', [f.actor.userId, f.actor.apiKeyId ?? null]);
  for (const d of todo) {
    try { out.set(d.id, { facts: await factsInTx(c, d.id, d.mode) }); }
    catch (e) {
      if (e instanceof Fa3DocumentError || e instanceof Problem) out.set(d.id, { error: e });
      else throw nativeProblem(e);
    }
  }
  return out;
}

/** The facts callback of collectJpkDocuments: batch result first (error replayed), else the native read. */
export function batchFacts<D extends { id: string }, F>(batch: Fa3BatchResult, native: (d: D) => Promise<F>, toFacts: (f: Fa3BatchFacts) => F): (d: D) => Promise<F> {
  return async d => {
    const hit = batch.get(d.id);
    if (!hit) return native(d);
    if ('error' in hit) throw hit.error;
    return toFacts(hit.facts);
  };
}
