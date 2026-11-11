/** Native port of the Base invoices family: 220 sidecars + the native local
 * invoices (157). local-invoices.ts is source-pinned and its transaction is
 * private, so this port calls the same SQL contract in the same order inside ONE
 * transaction: identity frame, local_invoice_store_preview, local_invoice_issue,
 * audit, immediate constraints. Numbering stays local_invoice_issue's counter. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { tenantTx, tenantReadTx } from './db';
import { tokenHash } from './security';
import { parseBaseWireId, type BaseWireJson } from './base-wire-codec';
import { localInvoicesAvailable, type LocalInvoiceDocument } from './local-invoices';
import { localInvoicePrintHtml } from './local-invoice-print';
import { assertNoFa3DraftProjectInTx, fa3DraftOwnerInTx } from './fa3-draft-access';
import { createBaseWireInvoicesService, type BaseWireInvoice, type BaseWireInvoicesNative } from './base-wire-invoices';
import { assertNoReceiptFor157InTx } from './receipt233';
import { captureLocalInvoiceTaxInTx, localInvoiceTaxFactsInTx, tax226Available } from './tax226';
import { assertNoInvoice230InTx, invoice230Available, type Invoice230Document } from './invoice230';
import { invoice230PrintHtml } from './invoice230-print';
import { issuedSeriesNote, isLocalInvoiceHistoryRefusal, localInvoiceBudgetInTx, overflowAvailableInTx, overflowIssueInTx } from './invoice-overflow230';
import { captureDocumentNbpRateInTx, nbpRateBeforeNumberingInTx } from './nbp227';

function publicNumber(raw: unknown): number {
  ensure(typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) && BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER), 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220');
  return parseBaseWireId(Number(raw), false);
}
const idempotencyKey = (clientKey: string) => 'base_wire220:' + clientKey;

/** The native local-invoice gate (local-invoices.ts transaction()): module check,
 * request identity hash of this key, current membership/key/scope/MFA. */
export async function frame(c: PoolClient, actor: Actor, credential: string, writing: boolean) {
  ensure(await localInvoicesAvailable(c), 503, 'Lokalne faktury nie są dostępne');
  const h = tokenHash(credential);
  await c.query("SELECT set_config('local_invoice.identity_hash',$1,true)", [h]);
  await c.query('SELECT public.local_invoice_identity($1,$2,$3,$4,false)', [actor.userId, actor.apiKeyId ?? null, h, writing]);
  const g = (await c.query('SELECT local_invoice_access($1,$2,$3,false) g', [actor.userId, actor.apiKeyId ?? null, writing])).rows[0].g;
  ensure(g.key_valid, 401, 'Klucz faktury jest wycofany lub wygasł');
  ensure(g.allowed, 403, 'Brak aktualnych uprawnień do faktury');
}
/** Same SQLSTATE mapping as the native local-invoice transaction. */
export function nativeProblem(error: unknown): unknown {
  if (error instanceof Problem) return error;
  const e = error as { code?: string; message?: string };
  if (e.code === '23514' && e.message === 'Klucz faktury jest wycofany lub wygasł') return new Problem(401, e.message);
  if (e.code === '23514' && ['Brak aktualnych uprawnień do faktury', 'Serią faktur zarządza administrator'].includes(e.message ?? '')) return new Problem(403, e.message!);
  if (e.code === '55000') return new Problem(503, 'Niekompletny moduł lokalnej FV');
  if (e.code === '28000') return new Problem(401, 'Sesja lub klucz FV wygasły');
  if (e.code === '42501') return new Problem(403, 'Brak dostępu do FV');
  if (e.code === '22023') return new Problem(422, 'Niepoprawne dane FV');
  if (e.code === 'P0002') return new Problem(404, 'Nie znaleziono faktury');
  if (e.code === '23514') return new Problem(409, 'Zakres faktury zmienił się');
  if (e.code === '23505') return new Problem(409, 'Seria, numer lub faktura zamówienia już istnieje');
  return error;
}
const DOCUMENT_SQL = `SELECT s.public_id::text AS public_id,os.public_id::text AS order_public_id,ss.public_id::text AS series_public_id,d.id,d.order_id,d.number,d.kind,d.mode,d.data,
    d.created_at,floor(extract(epoch FROM d.created_at))::bigint::text AS created,r.order_id AS receipt_order_id,r.number AS receipt_number,r.preview_id,r.scope_hash,r.snapshot,r.year,r.sequence
  FROM base_wire220_invoice_ids s JOIN documents d ON(d.tenant_id,d.id)=(s.tenant_id,s.local_id)
  LEFT JOIN local_invoice_receipts r ON(r.tenant_id,r.document_id)=(d.tenant_id,d.id)
  LEFT JOIN base_wire220_order_ids os ON(os.tenant_id,os.local_id)=(d.tenant_id,d.order_id)
  LEFT JOIN base_wire220_invoice_series_ids ss ON(ss.tenant_id,ss.local_id)=(r.tenant_id,r.series_id)
  WHERE s.tenant_id=$1 AND d.kind='invoice' AND d.mode='local_invoice'`;
/** Native documentView evidence check: the document equals its immutable receipt. */
function evidence(r: Record<string, any>) {
  ensure(r.preview_id && r.receipt_order_id === r.order_id && r.receipt_number === r.number && r.data?.preview_id === r.preview_id && r.data?.scope_hash === r.scope_hash
    && isDeepStrictEqual(r.data, { ...r.snapshot, number: r.receipt_number, preview_id: r.preview_id, scope_hash: r.scope_hash, local_only: true, ksef_state: 'not_submitted', fiscalized: false }),
  503, 'Niepełny trwały dowód faktury');
}
function invoice(r: Record<string, any>): BaseWireInvoice {
  evidence(r);
  const d = r.data, seller = d.seller, buyer = d.buyer;
  return { public_id: publicNumber(r.public_id), order_public_id: publicNumber(r.order_public_id), series_public_id: publicNumber(r.series_public_id),
    number: r.number, year: r.year, sequence: r.sequence, created: Number(r.created), sell_date: d.sell_date, due_date: d.due_date, currency: d.currency,
    gross_minor: d.totals.gross_minor, net_minor: d.totals.net_minor, notes: d.series.notes,
    seller: { name: seller.name, street: seller.street, postal_code: seller.postal_code, city: seller.city, tax_id: seller.tax_id },
    buyer: { name: buyer.name, street: buyer.address.street, postal_code: buyer.address.postal_code, city: buyer.address.city, country: buyer.address.country },
    lines: d.lines.map((l: Record<string, any>) => ({ kind: l.kind, name: l.name, sku: l.sku, quantity: l.quantity, vat_rate: l.vat_rate, gross_minor: l.gross_minor, net_minor: l.net_minor })) };
}

/** FV-S (230) invoices with their 230 record; base230() keeps those the Base invoice DTO describes. */
const DOCUMENT230_SQL = `SELECT s.public_id::text AS public_id,os.public_id::text AS order_public_id,ss.public_id::text AS series_public_id,d.id,d.order_id,d.number,d.data,
    d.created_at,floor(extract(epoch FROM d.created_at))::bigint::text AS created,h.number AS record_number,h.order_id AS record_order_id,h.snapshot,h.year,h.sequence
  FROM base_wire220_invoice_ids s JOIN documents d ON(d.tenant_id,d.id)=(s.tenant_id,s.local_id)
  JOIN invoice230_documents h ON(h.tenant_id,h.document_id)=(d.tenant_id,d.id)
  LEFT JOIN base_wire220_order_ids os ON(os.tenant_id,os.local_id)=(d.tenant_id,d.order_id)
  LEFT JOIN base_wire220_invoice_series_ids ss ON(ss.tenant_id,ss.local_id)=(h.tenant_id,h.series_id)
  WHERE s.tenant_id=$1 AND d.kind='invoice' AND d.mode='invoice230'`;
const DOMESTIC_230 = ['23', '8', '5', '0 KR'];
/** A PLN consumer sale in Poland at domestic rates: the content the Base invoice DTO (and the 157 form) has. */
const base230 = (r: Record<string, any>) => r.data?.currency === 'PLN' && r.data.buyer?.kind === 'consumer' && r.data.buyer.address?.country === 'PL'
  && r.data.procedure === 'domestic' && !r.data.reverse_charge && !r.data.exemption && Array.isArray(r.data.categories) && r.data.categories.every((x: any) => DOMESTIC_230.includes(x.rate_code));
/** invoice230DocumentInTx evidence: the document equals its 230 record. */
function invoice230(r: Record<string, any>): BaseWireInvoice {
  ensure(r.record_order_id === r.order_id && r.record_number === r.number && isDeepStrictEqual(r.snapshot, r.data), 503, 'Faktura nie odpowiada swojemu trwałemu zapisowi 230');
  const d = r.data, seller = d.seller, buyer = d.buyer;
  return { public_id: publicNumber(r.public_id), order_public_id: publicNumber(r.order_public_id), series_public_id: publicNumber(r.series_public_id),
    number: r.number, year: r.year, sequence: r.sequence, created: Number(r.created), sell_date: d.sell_date, due_date: d.due_date, currency: d.currency,
    gross_minor: d.totals.gross_minor, net_minor: d.totals.net_minor, notes: d.series.notes,
    seller: { name: seller.name, street: seller.street, postal_code: seller.postal_code, city: seller.city, tax_id: seller.tax_id },
    buyer: { name: buyer.name, street: buyer.address.street, postal_code: buyer.address.postal_code, city: buyer.address.city, country: buyer.address.country },
    lines: d.lines.map((l: Record<string, any>) => ({ kind: l.kind, name: l.name, sku: l.sku, quantity: l.quantity, vat_rate: l.vat_rate, gross_minor: l.gross_minor, net_minor: l.net_minor })) };
}
const document230 = (r: Record<string, any>): Invoice230Document => ({ id: r.id, order_id: r.order_id, number: r.number, kind: 'invoice', mode: 'invoice230', data: r.data,
  created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at });

export function createBaseWireInvoicesNative(c: PoolClient, actor: Actor): BaseWireInvoicesNative {
  const uid = actor.userId, kid = actor.apiKeyId ?? null;
  return {
    async allocate(kind) { await c.query('SELECT public.base_wire220_allocate_pending($1)', [kind]); },
    async series() {
      const rows = (await c.query(`SELECT l.id,l.name,l.prefix,s.public_id::text AS public_id FROM local_invoice_series l
        LEFT JOIN base_wire220_invoice_series_ids s ON(s.tenant_id,s.local_id)=(l.tenant_id,l.id) WHERE l.tenant_id=$1 ORDER BY s.public_id,l.id`, [actor.tenantId])).rows;
      return rows.map(r => ({ id: r.id, public_id: publicNumber(r.public_id), name: r.name, prefix: r.prefix }));
    },
    async order(publicId) {
      const rows = (await c.query('SELECT local_id FROM base_wire220_order_ids WHERE tenant_id=$1 AND public_id=$2::bigint AND local_id IS NOT NULL', [actor.tenantId, publicId])).rows;
      ensure(rows.length <= 1, 503, 'Niespójna mapa zamówień Base');
      return rows[0]?.local_id ?? null;
    },
    async orderFacts(orderId) {
      const o = (await c.query(`SELECT o.version::text AS version,o.customer_name,o.address,o.shipping_cost,
          coalesce((SELECT array_agg(DISTINCT i.vat ORDER BY i.vat) FROM order_items i WHERE(i.tenant_id,i.order_id)=(o.tenant_id,o.id)),'{}') AS vats,
          (SELECT to_char(min(e.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD') FROM order_events e WHERE(e.tenant_id,e.order_id)=(o.tenant_id,o.id) AND e.kind='order.shipped') AS shipped_on
        FROM orders o WHERE o.tenant_id=$1 AND o.id=$2`, [actor.tenantId, orderId])).rows[0];
      ensure(o, 404, 'Nie znaleziono zamówienia');
      return { version: o.version, customer_name: o.customer_name, address: o.address && typeof o.address === 'object' ? o.address : {},
        shipping_cost: o.shipping_cost, vats: o.vats, shipped_on: o.shipped_on };
    },
    async issue(orderId, input) {
      // 157 lifetime budget (local_invoice_budget, 157:137): a company at the limit gets the FV-S (230)
      // invoice of the same consumer sale in this transaction (invoice-overflow230.ts).
      const overflow = await overflowAvailableInTx(c);
      if (overflow) {
        const budget = await localInvoiceBudgetInTx(c, actor.tenantId);
        if (budget.reason) return overflowIssueInTx(c, actor, orderId, { client_key: randomUUID(), ...input }, budget.reason);
        await c.query('SAVEPOINT base_wire_overflow157');
      }
      try {
      // previewLocalInvoice + issueLocalInvoice bodies, same order of locks and checks.
      const preview = { client_key: randomUUID(), ...input, tax_regime: 'ordinary_domestic', consumer_sale_confirmed: true,
        no_special_tax_procedure_confirmed: true, not_fiscal_receipt_confirmed: true };
      await fa3DraftOwnerInTx(c, () => c.query('SELECT public.local_invoice_locks()'));
      await assertNoFa3DraftProjectInTx(c, orderId);
      await assertNoInvoice230InTx(c, orderId);
      await assertNoReceiptFor157InTx(c, orderId);
      const p = (await c.query('SELECT local_invoice_store_preview($1,$2::jsonb,$3,$4) p', [orderId, JSON.stringify(preview), uid, kid])).rows[0].p;
      if (!p.reused) await audit(c, actor, 'local_invoice.preview', p.id, { order_id: orderId, series_id: input.series_id, scope_hash: p.scope_hash });
      // No SET CONSTRAINTS here (unlike the separate native preview transaction): the
      // issue's admission->receipt FK is deferred within this transaction. The preview's
      // deferred checks run with the issue's at the IMMEDIATE below, before COMMIT.
      // 226: tax facts refuse an issue the local math cannot document (ZW/NP/OO, MPP) before numbering.
      const tax = await tax226Available(c), snapshot = (await c.query('SELECT snapshot FROM local_invoice_previews WHERE id=$1', [p.id])).rows[0].snapshot;
      if (tax) {
        const blockers = (await localInvoiceTaxFactsInTx(c, snapshot)).blockers;
        ensure(!blockers.length, 409, blockers.join(' · '));
      }
      // 227: a foreign-currency invoice needs a stored NBP rate for its tax point before numbering.
      await nbpRateBeforeNumberingInTx(c, snapshot);
      await fa3DraftOwnerInTx(c, () => c.query('SELECT public.local_invoice_locks()'));
      await assertNoFa3DraftProjectInTx(c, orderId);
      const r = (await c.query('SELECT local_invoice_issue($1,$2::jsonb,$3,$4) r', [p.id,
        JSON.stringify({ client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true, local_only: true }), uid, kid])).rows[0].r;
      if (!r.reused) await audit(c, actor, 'local_invoice.issue', r.document_id, { order_id: r.order_id, preview_id: p.id, number: r.number, scope_hash: r.scope_hash });
      // 226: per-line tax snapshot in the issuing transaction.
      if (tax && !r.reused) await captureLocalInvoiceTaxInTx(c, actor, r.document_id, (await c.query('SELECT data FROM documents WHERE id=$1', [r.document_id])).rows[0].data, true);
      // 227: NBP rate record of a foreign-currency invoice in the issuing transaction (PLN: none).
      if (!r.reused) await captureDocumentNbpRateInTx(c, actor, r.document_id, (await c.query('SELECT data FROM documents WHERE id=$1', [r.document_id])).rows[0].data, true);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      if (overflow) await c.query('RELEASE SAVEPOINT base_wire_overflow157');
      return r.document_id as string;
      } catch (error) {
        // 64 MiB history, or a concurrent issue took the last place: the same sale goes to FV-S.
        if (!overflow || !isLocalInvoiceHistoryRefusal(error)) throw error;
        await c.query('ROLLBACK TO SAVEPOINT base_wire_overflow157');
        return overflowIssueInTx(c, actor, orderId, { client_key: randomUUID(), ...input }, 'history');
      }
    },
    async issuedNote(documentId) {
      const d = (await c.query("SELECT number FROM documents WHERE id=$1 AND kind='invoice' AND mode='invoice230'", [documentId])).rows[0];
      return d ? { invoice_number: d.number as string, local_note: issuedSeriesNote(d.number) + ' Limit faktur lokalnych B2C (157) tej firmy jest wyczerpany.' } : null;
    },
    async invoicePublicId(documentId) {
      const rows = (await c.query('SELECT public_id::text AS public_id FROM base_wire220_invoice_ids WHERE tenant_id=$1 AND local_id=$2', [actor.tenantId, documentId])).rows;
      ensure(rows.length === 1, 503, 'Brak trwałej tożsamości Base faktury');
      return publicNumber(rows[0].public_id);
    },
    async invoices(f) {
      // Deterministic LOCAL order: invoice_id ascending; id_from is inclusive.
      const filter = `AND ($2::bigint IS NULL OR s.public_id=$2) AND ($3::bigint IS NULL OR os.public_id=$3)
          AND ($4::bigint IS NULL OR ss.public_id=$4) AND ($5::bigint IS NULL OR d.created_at>=to_timestamp($5)) AND ($6::bigint IS NULL OR s.public_id>=$6)
        ORDER BY s.public_id LIMIT $7`;
      const values = [actor.tenantId, f.public_id ?? null, f.order_public_id ?? null, f.series_public_id ?? null, f.date_from ?? null, f.id_from ?? null, f.limit];
      const rows = (await c.query(`${DOCUMENT_SQL} ${filter}`, values)).rows.map(invoice);
      // FV-S invoices of a consumer sale (the 157 overflow, also from addInvoice) are Base invoices too.
      if (await invoice230Available(c)) rows.push(...(await c.query(`${DOCUMENT230_SQL} ${filter}`, values)).rows.filter(base230).map(invoice230));
      return rows.sort((x, y) => x.public_id - y.public_id).slice(0, f.limit);
    },
    async file(publicId) {
      if (await invoice230Available(c)) {
        const h = (await c.query(`${DOCUMENT230_SQL} AND s.public_id=$2`, [actor.tenantId, publicId])).rows.find(base230);
        if (h) { invoice230(h); return { number: h.number, content: invoice230PrintHtml(document230(h)) }; }
      }
      const r = (await c.query(`${DOCUMENT_SQL} AND s.public_id=$2`, [actor.tenantId, publicId])).rows[0];
      if (!r) return null;
      evidence(r);
      const document: LocalInvoiceDocument = { id: r.id, order_id: r.order_id, number: r.number, kind: 'invoice', mode: 'local_invoice', data: r.data,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at };
      return { number: r.number, content: localInvoicePrintHtml(document) };
    },
    async replay(clientKey, requestHash) {
      await c.query('INSERT INTO idempotency_keys(tenant_id,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [actor.tenantId, idempotencyKey(clientKey), requestHash]);
      const prior = (await c.query('SELECT request_hash,response FROM idempotency_keys WHERE tenant_id=$1 AND key=$2 FOR UPDATE', [actor.tenantId, idempotencyKey(clientKey)])).rows[0];
      ensure(prior?.request_hash === requestHash, 409, 'Klucz polecenia wskazuje inną treść lub klucz API');
      return (prior.response ?? null) as Record<string, BaseWireJson> | null;
    },
    async remember(clientKey, response) {
      await c.query('UPDATE idempotency_keys SET response=$3 WHERE tenant_id=$1 AND key=$2', [actor.tenantId, idempotencyKey(clientKey), JSON.stringify(response)]);
    },
  };
}
export function createDefaultBaseWireInvoicesService(opts: { readOnly: boolean }) {
  return createBaseWireInvoicesService({
    transaction: async (actor, mode, credential, work) => {
      try { return await (mode === 'read' ? tenantReadTx : tenantTx)(actor.tenantId, async c => { await frame(c, actor, credential, mode === 'write'); return work(c); }); }
      catch (error) { throw nativeProblem(error); }
    },
    native: createBaseWireInvoicesNative,
    allocateOnRead: opts.readOnly !== true,
  });
}
