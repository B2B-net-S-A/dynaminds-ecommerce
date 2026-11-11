/** Single FA(3) XML entry point by document id. The kind of the document is looked up
 * in the tenant's own rows; its content is then read only through the native detail
 * read of that module (own identity, role, RLS and receipt checks). No numbering,
 * writes or KSeF submission. Documents FA(3) cannot express are refused with 409. */
import type { PoolClient } from 'pg';
import { tenantReadTx } from './db';
import { Problem } from './errors';
import { localInvoiceDetail, localInvoiceRequestActor } from './local-invoices';
import { consumerCreditDetail, localConsumerCreditRequestActor } from './local-consumer-credits';
import { b2bInvoiceDetail, b2bInvoiceRequestActor } from './b2b-invoices';
import { b2bCreditDetail, b2bCreditRequestActor } from './b2b-credits';
import { documentTaxSnapshotInTx, tax226Available } from './tax226';
import { documentKsefInTx } from './ksef229-numbers';
import { Fa3XmlError, renderNativeB2bInvoiceFa3 } from './fa3-xml';
import { Fa3DocumentError, fa3GenerationTimeOf, fa3UnsupportedReason, renderFa3Document, type Fa3Document } from './fa3-render';
import { invoice230Detail } from './invoice230-service';
import { taxInvoiceActor } from './tax226-local-invoices';
import { invoice230Fa3Model, invoice230Rate } from './invoice230-fa3';
import { invoice232Detail } from './invoice232-service';
import { invoice232Fa3Model, invoice232Rate } from './invoice232-fa3';
import { b2bCorrectionFa3Model, b2bInvoiceFa3Model, consumerCreditFa3Model, localInvoiceFa3Model, type Fa3DocumentRate, type Fa3TaxSnapshot } from './fa3-adapters';

export type Fa3Request = Parameters<typeof localInvoiceRequestActor>[0];
export type Fa3DocumentKind = 'local_invoice' | 'invoice230' | 'b2b_invoice' | 'local_consumer_credit' | 'consumer_return_credit' | 'b2b_correction' | 'invoice232_correction';
export type Fa3DocumentXml = { xml: string; filename: string; number: string; document_kind: Fa3DocumentKind };

type Located = { kind: string; mode: string } | null;
export async function locate(c: PoolClient, id: string): Promise<Located> {
  const d = (await c.query('SELECT kind,mode FROM documents WHERE id=$1', [id])).rows[0];
  if (d) return d;
  // Consumer corrections live in their own append-only ledgers (188, 206/207), KOR-S corrections of FV-S in 232.
  for (const table of ['local_consumer_credit_documents', 'return_credit206_documents', 'invoice232_corrections']) {
    if (!(await c.query('SELECT to_regclass($1) IS NOT NULL AS present', ['public.' + table])).rows[0].present) continue;
    const r = (await c.query(`SELECT kind,mode FROM ${table} WHERE id=$1`, [id])).rows[0];
    if (r) return r;
  }
  return null;
}
/** 226 tax snapshot of a document (null without 226); also read by the JPK batch (fa3-document-batch.ts). */
export async function taxSnapshotInTx(c: PoolClient, id: string, data: Parameters<typeof documentTaxSnapshotInTx>[2]): Promise<Fa3TaxSnapshot | null> {
  if (!(await tax226Available(c))) return null;
  return documentTaxSnapshotInTx(c, id, data);
}
/** 227 rate record of a document (null without 227 or without a record). */
export async function documentRateInTx(c: PoolClient, id: string): Promise<Fa3DocumentRate | null> {
  if (!(await c.query("SELECT to_regclass('public.nbp227_document_rates') IS NOT NULL AND to_regclass('public.nbp227_document_rate_vat') IS NOT NULL AS present")).rows[0].present) return null;
  const r = (await c.query('SELECT currency,mid::text mid FROM nbp227_document_rates WHERE document_id=$1', [id])).rows[0];
  if (!r) return null;
  const vat = (await c.query('SELECT vat_rate,net_minor::text n,vat_minor::text v,vat_pln_minor::text p,net_pln_minor::text np FROM nbp227_document_rate_vat WHERE document_id=$1 ORDER BY vat_rate', [id])).rows;
  return { currency: r.currency, mid: r.mid, vat: vat.map(x => ({ vat_rate: x.vat_rate, net_minor: BigInt(x.n), vat_minor: BigInt(x.v), vat_pln_minor: BigInt(x.p), net_pln_minor: BigInt(x.np) })) };
}
const filename = (number: string) => number.replace(/\//g, '-').replace(/[^A-Za-z0-9._-]/g, '_') + '.fa3.xml';

/** Normalized FA(3) facts of one issued document; JPK files are built from the same facts. */
export type Fa3DocumentFacts = { document_id: string; document_kind: Fa3DocumentKind; model: Fa3Document; rate: Fa3DocumentRate | null; created_at: unknown };

/** Facts of one issued document of the request's tenant through the native detail read of its module.
 * Throws Fa3DocumentError (409/422) for a document FA(3) cannot express, Problem for access. */
export async function fa3DocumentFacts(req: Fa3Request, id: string, sessionName: string, found?: { kind: string; mode: string }): Promise<Fa3DocumentFacts> {
  const tenant = req.actor.tenantId;
  const located = found ?? await tenantReadTx(tenant, c => locate(c, id));
  if (!located) throw new Problem(404, 'Nie znaleziono dokumentu');
  if (located.kind === 'invoice' && located.mode === 'b2b_invoice') {
    const { document } = await b2bInvoiceDetail(b2bInvoiceRequestActor(req, sessionName), id);
    return { document_id: id, document_kind: 'b2b_invoice', model: b2bInvoiceFa3Model(document), rate: null, created_at: document.created_at };
  }
  if (located.kind === 'invoice' && located.mode === 'local_invoice') {
    const { document } = await localInvoiceDetail(localInvoiceRequestActor(req, sessionName), id);
    const [tax, rate] = await tenantReadTx(tenant, async c => [await taxSnapshotInTx(c, id, document.data), await documentRateInTx(c, id)] as const);
    return { document_id: id, document_kind: 'local_invoice', model: localInvoiceFa3Model(document, tax, rate), rate, created_at: document.created_at };
  }
  if (located.kind === 'invoice' && located.mode === 'invoice230') {
    const { document, record, receipt } = await invoice230Detail(taxInvoiceActor(req as never, sessionName), id);
    return { document_id: id, document_kind: 'invoice230', model: { ...invoice230Fa3Model(document, record), receipt }, rate: invoice230Rate(document, record), created_at: document.created_at };
  }
  if (located.kind === 'correction' && (located.mode === 'local_consumer_credit' || located.mode === 'consumer_return_credit')) {
    // 206 is loaded lazily, as registerReturnCredit206Routes does in app.ts.
    const returns = located.mode === 'consumer_return_credit' ? await import('./return-credit206-service') : null;
    const document = returns
      ? (await returns.returnCredit206Detail(returns.returnCredit206RequestActor(req, sessionName), id)).document
      : (await consumerCreditDetail(localConsumerCreditRequestActor(req, sessionName), id)).document;
    const original = document.data.original_document;
    const [tax, ksef] = await tenantReadTx(tenant, async c => [await taxSnapshotInTx(c, original.id, original.data), await documentKsefInTx(c, original.id)] as const);
    return { document_id: id, document_kind: located.mode, model: consumerCreditFa3Model(document, tax, ksef.number), rate: null, created_at: document.created_at };
  }
  if (located.kind === 'correction' && located.mode === 'invoice232_correction') {
    const { document, record } = await invoice232Detail(taxInvoiceActor(req as never, sessionName), id);
    return { document_id: id, document_kind: 'invoice232_correction', model: invoice232Fa3Model(document, record), rate: invoice232Rate(document, record), created_at: document.created_at };
  }
  if (located.kind === 'correction' && located.mode === 'b2b_correction') {
    const { document } = await b2bCreditDetail(b2bCreditRequestActor(req, sessionName), id);
    const { document: original } = await b2bInvoiceDetail(b2bInvoiceRequestActor(req, sessionName), document.data.original_document_id);
    const ksef = await tenantReadTx(tenant, c => documentKsefInTx(c, original.id));
    return { document_id: id, document_kind: 'b2b_correction', model: b2bCorrectionFa3Model(document, original, ksef.number), rate: null, created_at: document.created_at };
  }
  throw new Fa3DocumentError(409, fa3UnsupportedReason(located.kind, located.mode));
}

/** XML of one issued document of the request's tenant, or a Problem with the Polish reason. */
export async function fa3DocumentXml(req: Fa3Request, id: string, sessionName: string): Promise<Fa3DocumentXml> {
  const tenant = req.actor.tenantId;
  const found = await tenantReadTx(tenant, c => locate(c, id));
  if (!found) throw new Problem(404, 'Nie znaleziono dokumentu');
  try {
    if (found.kind === 'invoice' && found.mode === 'b2b_invoice') {
      // The B2B FV keeps its own exporter (same bytes as before).
      const { document } = await b2bInvoiceDetail(b2bInvoiceRequestActor(req, sessionName), id);
      const r = renderNativeB2bInvoiceFa3(document, { generated_at: fa3GenerationTimeOf(document.created_at) });
      return { xml: r.xml, number: r.number, filename: filename(r.number), document_kind: 'b2b_invoice' };
    }
    const f = await fa3DocumentFacts(req, id, sessionName, found);
    const r = renderFa3Document(f.model, fa3GenerationTimeOf(f.created_at));
    return { xml: r.xml, number: r.number, filename: filename(r.number), document_kind: f.document_kind };
  } catch (error) {
    if (error instanceof Fa3DocumentError) throw new Problem(error.status, error.message);
    if (error instanceof Fa3XmlError)
      throw new Problem(error.code === 'XML_BYTES_EXCEEDED' ? 413 : error.code === 'UNSUPPORTED_SCOPE' ? 409 : 422, 'Niepełna lub nieobsługiwana migawka faktury FA(3)');
    throw error;
  }
}
