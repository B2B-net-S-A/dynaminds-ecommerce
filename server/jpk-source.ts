/** Issued documents of a period for the JPK files. The list comes from the tenant's own rows (RLS,
 * explicit tenant filter); the content of every document is then read through the same FA(3)
 * facts path as its FA(3) XML (native detail read with identity, role and receipt checks).
 * Read-only; nothing is stored. */
import type { PoolClient } from 'pg';
import { tenantReadTx } from './db';
import { fa3DocumentFacts, type Fa3Request } from './fa3-documents';
import { Fa3DocumentError, fa3UnsupportedReason } from './fa3-render';
import { JPK_MAX_DOCUMENTS, JpkError, type JpkDocument, type JpkRefusal } from './jpk-model';
import { documentKsefInTx, type DocumentKsef } from './ksef229-numbers';
import { listJpkReceiptSalesInTx, type JpkReceiptSales } from './jpk-receipts';
import { batchFacts, fa3BatchFrame, fa3DocumentFactsBatchInTx } from './fa3-document-batch';

/** Issue/sale date that places a document in a JPK_V7 period, and its issue date (JPK_FA). */
export type JpkListed = { id: string; kind: string; mode: string; number: string; tax_date: string; issue_date: string };
/** Not VAT documents of the taxpayer: never part of a JPK file. */
const NOT_VAT = new Set(['demo', 'simulation', 'provider_test']);
const JPK_MODES = new Set(['local_invoice', 'b2b_invoice', 'b2b_correction', 'local_consumer_credit', 'consumer_return_credit', 'invoice230', 'invoice232_correction']);

const DAY = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
const warsawDay = `to_char(created_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM-DD')`;
const dated = (expr: string) => `CASE WHEN (${expr}) ~ ${DAY} THEN (${expr}) ELSE ${warsawDay} END`;
/** Invoices: sale date (delivery, art. 19a ust. 1), else issue date. Corrections: issue date of
 * the correction (art. 29a ust. 13 and 15 pkt 4 — decrease in the period of the correction).
 * An invoice issued to a fiscal receipt (233 link, FP): its issue date — the sale is already in the RO
 * of the receipt's daily report, the FP row only lists the invoice in the period it was issued. */
const documentsSql = (receiptLinks: boolean) => `SELECT id,kind,mode,number,
  ${dated(`CASE WHEN kind='correction' THEN data->>'issue_date' WHEN mode='b2b_invoice' THEN coalesce(data->>'sale_date',data->>'issue_date')${receiptLinks
    ? ` WHEN EXISTS(SELECT 1 FROM receipt233_invoice_links l WHERE l.tenant_id=documents.tenant_id AND l.document_id=documents.id) THEN data->>'issue_date'` : ''}
    ELSE coalesce(data->>'sell_date',data->>'issue_date') END`)} tax_date,
  ${dated(`data->>'issue_date'`)} issue_date
 FROM documents WHERE tenant_id=$1 AND kind IN ('invoice','correction')`;
const LEDGER = (table: string) => `SELECT id,kind,mode,number,${dated(`data->>'issue_date'`)} tax_date,${dated(`data->>'issue_date'`)} issue_date FROM ${table} WHERE tenant_id=$1`;

/** Documents whose tax date (`by: 'tax'`) or issue date (`by: 'issue'`) is within [from, to]. */
export async function listJpkDocumentsInTx(c: PoolClient, tenantId: string, from: string, to: string, by: 'tax' | 'issue'): Promise<JpkListed[]> {
  const links = (await c.query("SELECT to_regclass('public.receipt233_invoice_links') IS NOT NULL AS present")).rows[0].present as boolean;
  const parts = [documentsSql(links)];
  for (const t of ['local_consumer_credit_documents', 'return_credit206_documents', 'invoice232_corrections'])
    if ((await c.query('SELECT to_regclass($1) IS NOT NULL AS present', ['public.' + t])).rows[0].present) parts.push(LEDGER(t));
  const column = by === 'tax' ? 'tax_date' : 'issue_date';
  const rows = (await c.query(`SELECT * FROM (${parts.join(' UNION ALL ')}) d WHERE ${column} BETWEEN $2 AND $3 ORDER BY ${column},number,id LIMIT $4`,
    [tenantId, from, to, JPK_MAX_DOCUMENTS + 1])).rows as JpkListed[];
  if (rows.length > JPK_MAX_DOCUMENTS) throw new JpkError(422, `Okres obejmuje ponad ${JPK_MAX_DOCUMENTS} dokumentów. Zawęź zakres dat.`);
  return rows;
}

/** `receipt_sales`: the 233 daily reports of the range (JPK_V7 only; absent for JPK_FA and without 233). */
export type JpkLoaded = { documents: JpkDocument[]; skipped: number; receipt_sales?: JpkReceiptSales };
type Facts = (d: JpkListed) => Promise<{ model: JpkDocument['model']; rate: JpkDocument['rate']; ksef?: DocumentKsef }>;
/** FA(3) facts of every listed document; any document that cannot be expressed refuses the whole
 * file (409 with the list). Demo/simulation/test documents are not VAT documents and are skipped. */
export async function collectJpkDocuments(listed: readonly JpkListed[], facts: Facts): Promise<JpkLoaded> {
  const documents: JpkDocument[] = [], refusals: JpkRefusal[] = [];
  let skipped = 0;
  for (const d of listed) {
    if (NOT_VAT.has(d.mode)) { skipped++; continue; }
    if (!JPK_MODES.has(d.mode)) { refusals.push({ number: d.number, reason: fa3UnsupportedReason(d.kind, d.mode) }); continue; }
    try {
      const f = await facts(d);
      // A KOR-S increase (232) is accepted only for a cause after the sale: it belongs to the period of the correction (art. 29a ust. 17).
      if (f.model.kind === 'KOR' && f.model.total_gross_minor > 0n && d.mode !== 'invoice232_correction')
        refusals.push({ number: d.number, reason: 'Korekta zwiększająca — ujęcie w okresie faktury pierwotnej nie jest obsługiwane' });
      else documents.push({ id: d.id, model: f.model, rate: f.rate, tax_date: d.tax_date, ...(f.ksef ? { ksef: f.ksef } : {}) });
    } catch (e) {
      if (e instanceof Fa3DocumentError) refusals.push({ number: d.number, reason: e.message });
      else throw e;
    }
  }
  if (refusals.length) throw new JpkError(409, 'Części dokumentów okresu nie da się ująć w pliku JPK', refusals);
  return { documents, skipped };
}

/** Documents of the request's tenant in the range: the list, the 233 daily reports and the FA(3) facts of
 * every 157/230/232/188/206 document in ONE read-only snapshot (fa3-document-batch.ts, identity frame once);
 * B2B 159/160 documents keep their native per-document read. */
export async function loadJpkDocuments(req: Fa3Request, sessionName: string, from: string, to: string, by: 'tax' | 'issue'): Promise<JpkLoaded> {
  const frame = fa3BatchFrame(req, sessionName);
  const { listed, sales, batch } = await tenantReadTx(req.actor.tenantId, async c => {
    const listed = await listJpkDocumentsInTx(c, req.actor.tenantId, from, to, by);
    return {
      listed,
      sales: by === 'tax' ? await listJpkReceiptSalesInTx(c, req.actor.tenantId, from, to) : null,
      batch: await fa3DocumentFactsBatchInTx(c, frame, listed.filter(d => !NOT_VAT.has(d.mode))),
    };
  });
  const loaded = await collectJpkDocuments(listed, batchFacts(batch, async (d: JpkListed) => {
    const f = await fa3DocumentFacts(req, d.id, sessionName, { kind: d.kind, mode: d.mode });
    return { ...f, ksef: await tenantReadTx(req.actor.tenantId, c => documentKsefInTx(c, d.id)) };
  }, f => f));
  return sales ? { ...loaded, receipt_sales: sales } : loaded;
}
