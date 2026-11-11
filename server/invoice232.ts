/** KOR-S (232): preview and issue of value corrections of FV-S invoices (230). Rules are pure
 * (invoice232-model.ts); this module reads the corrected invoice (through its 230 record), its earlier
 * corrections, its 229 KSeF number and, for a return correction, the received return case, and writes
 * only the own 232 tables. Numbering: own sub-series KOR-S/<prefix>/<year>/<sequence> of the 157 series
 * of the corrected invoice, continuous within itself; the 157 and 230 counters are never touched.
 * Design: docs/parity/CORRECTIONS232-20261025.md. */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { audit } from './domain';
import { ensure } from './errors';
import type { LocalInvoiceActor } from './local-invoice-values';
import { invoice230DocumentInTx, requireInvoice230, type Invoice230Data, type Invoice230Document } from './invoice230';
import {
  cancellationEdits, correctionMath, correctionOriginalOf, correctionRequest, originalState, reasonText, returnEdits,
  type CorrectionCategory, type CorrectionMath, type CorrectionReason, type CorrectionRequest, type CorrectionRow, type LineEdit, type StateLine,
} from './invoice232-model';

export const INVOICE232_MODE = 'invoice232_correction';
const PREVIEW_MINUTES = 15;
export async function invoice232Available(c: Pool | PoolClient): Promise<boolean> {
  return Boolean((await c.query(`SELECT to_regclass('public.invoice232_corrections') IS NOT NULL AND to_regclass('public.invoice232_categories') IS NOT NULL
    AND to_regclass('public.invoice232_counters') IS NOT NULL AND to_regclass('public.invoice232_previews') IS NOT NULL
    AND to_regprocedure('public.invoice232_correction_guard()') IS NOT NULL AS available`)).rows[0]?.available);
}
export async function requireInvoice232(c: PoolClient): Promise<void> {
  await requireInvoice230(c);
  ensure(await invoice232Available(c), 503, 'Korekty faktur FV-S (migracja 232) są niedostępne w tej kopii');
}

const uuid = z.uuid().transform(v => v.toLowerCase());
export const invoice232PreviewInput = z.strictObject({ client_key: uuid, correction: correctionRequest });
export const invoice232IssueInput = z.strictObject({ client_key: uuid, scope_hash: z.string().regex(/^[0-9a-f]{64}$/), confirmed: z.literal(true) });

/** data of a KOR-S correction (the preview snapshot plus number, preview_id and scope_hash). */
export type Invoice232Snapshot = {
  format: 'invoice232/v1';
  original: { document_id: string; number: string; issue_date: string; sell_date: string; currency: 'PLN' | 'EUR'; ksef_number: string | null; mpp_required: boolean;
    series: { id: string; name: string; prefix: string }; scope_hash: string };
  order: { id: string; number: string };
  return: { id: string; number: string } | null;
  seller: Invoice230Data['seller']; buyer: Invoice230Data['buyer'];
  currency: 'PLN' | 'EUR';
  /** EUR: the NBP rate of the corrected invoice (the correction changes the value of that transaction). */
  nbp: { mid: string; rate_date: string; table_no: string; basis: 'original_invoice' } | null;
  reason_code: CorrectionReason; reason: string; kind: CorrectionMath['kind']; direction: CorrectionMath['direction']; position: number;
  rows: CorrectionRow[]; categories: CorrectionCategory[]; totals: CorrectionMath['totals']; pln_totals: CorrectionMath['pln_totals']; state_after: StateLine[];
  mpp: { required: boolean }; reverse_charge: boolean; exemption: Invoice230Data['exemption'];
  rounding_method: 'gross_line_half_up';
  issue_date: string; year: number; tax_period: string; period_basis: string;
  local_only: true; ksef_state: 'not_submitted'; fiscalized: false;
};
export type Invoice232Data = Invoice232Snapshot & { number: string; preview_id: string; scope_hash: string };
export type Invoice232Document = { id: string; order_id: string; original_document_id: string; return_id: string | null; number: string; kind: 'correction'; mode: 'invoice232_correction';
  data: Invoice232Data; created_at: string };

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
const today = async (c: PoolClient) => (await c.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d")).rows[0].d as string;
/** Corrections of one invoice are serialized (the chain position and the state before). */
const lockInvoice = (c: PoolClient, documentId: string) => c.query("SELECT pg_advisory_xact_lock(hashtextextended('invoice232:'||$1::text,0))", [documentId]);

async function chainInTx(c: PoolClient, originalId: string): Promise<{ position: number; data: Invoice232Data }[]> {
  return (await c.query('SELECT position,data FROM invoice232_corrections WHERE original_document_id=$1 ORDER BY position', [originalId])).rows;
}
/** The state the next correction starts from: the invoice, or the state after its last correction. */
async function currentStateInTx(c: PoolClient, doc: Invoice230Document) {
  const chain = await chainInTx(c, doc.id), last = chain.at(-1);
  return { chain, position: (last?.position ?? 0) + 1, state: last ? last.data.state_after : originalState(correctionOriginalOf(doc.data)) };
}
/** Return cases of the order, with what is still to be corrected. */
export async function returnSourcesInTx(c: PoolClient, orderId: string) {
  const rows = (await c.query(`SELECT r.id,r.number,r.state,r.received_at,r.refunded_shipping,r.refund_amount,
      (SELECT x.number FROM invoice232_corrections x WHERE x.return_id=r.id) corrected_by
    FROM return_cases r WHERE r.order_id=$1 ORDER BY r.created_at,r.id`, [orderId])).rows;
  return rows.map(r => ({ id: r.id as string, number: r.number as string, state: r.state as string, received: r.received_at !== null && ['refund_pending', 'closed'].includes(r.state),
    refund_amount_minor: String(r.refund_amount), refunded_shipping_minor: String(r.refunded_shipping), corrected_by: (r.corrected_by ?? null) as string | null }));
}

/** The data a correction stores (pure): the corrected invoice, parties, rate, reason, rows, categories, totals and the tax period. */
export function correctionSnapshotOf(x: { doc: Invoice230Document; ksef_number: string | null; ret: Invoice232Snapshot['return']; req: CorrectionRequest; math: CorrectionMath; position: number; issue_date: string }): Invoice232Snapshot {
  const { doc, req, math: m, issue_date: issue } = x, s = doc.data, n = s.nbp;
  const reason = reasonText(req.reason_code, req.reason_note);
  return {
    format: 'invoice232/v1',
    original: { document_id: doc.id, number: doc.number, issue_date: s.issue_date, sell_date: s.sell_date, currency: s.currency, ksef_number: x.ksef_number,
      mpp_required: s.mpp.required, series: { id: s.series.id, name: s.series.name, prefix: s.series.prefix }, scope_hash: s.scope_hash },
    order: { id: s.order.id, number: s.order.number }, return: x.ret, seller: s.seller, buyer: s.buyer, currency: s.currency,
    nbp: n ? { mid: n.mid, rate_date: n.rate_date, table_no: n.table_no, basis: 'original_invoice' } : null,
    reason_code: req.reason_code, reason, kind: m.kind, direction: m.direction, position: x.position,
    rows: m.rows, categories: m.categories, totals: m.totals, pln_totals: m.pln_totals, state_after: m.state_after,
    mpp: { required: s.mpp.required }, reverse_charge: s.reverse_charge, exemption: s.exemption, rounding_method: 'gross_line_half_up',
    issue_date: issue, year: Number(issue.slice(0, 4)), tax_period: issue.slice(0, 7),
    period_basis: m.direction === 'decrease'
      ? 'Art. 29a ust. 13 ustawy o VAT — obniżenie podstawy w okresie wystawienia korekty'
      : 'Art. 29a ust. 17 ustawy o VAT — przyczyna powstała po sprzedaży, podwyższenie w okresie wystawienia korekty',
    local_only: true, ksef_state: 'not_submitted', fiscalized: false,
  };
}

export type Invoice232Calculation = { original_document_id: string; snapshot: Invoice232Snapshot; blockers: string[] };
/** The correction the issue would store now, or the reasons it cannot be issued. Reads only. */
export async function invoice232SnapshotInTx(c: PoolClient, originalId: string, req: CorrectionRequest): Promise<Invoice232Calculation> {
  await requireInvoice232(c);
  const { document: doc, record } = await invoice230DocumentInTx(c, originalId);
  const s = doc.data, o = correctionOriginalOf(s), blockers: string[] = [];
  const { position, state } = await currentStateInTx(c, doc);
  const ksef = (await c.query("SELECT ksef_number,state FROM ksef229_submissions WHERE document_id=$1 AND state<>'rejected'", [originalId])).rows[0];
  if (ksef && !ksef.ksef_number) blockers.push('Faktura korygowana czeka na numer KSeF (wysyłka w toku lub offline) — wystaw korektę po nadaniu numeru');
  let edits: LineEdit[] = [], ret: Invoice232Snapshot['return'] = null;
  if (req.mode === 'manual') edits = req.lines;
  else if (req.mode === 'cancellation') edits = cancellationEdits(state);
  else {
    const r = (await c.query('SELECT id,order_id,number,state,received_at,refunded_shipping FROM return_cases WHERE id=$1', [req.return_id])).rows[0];
    ensure(r && r.order_id === doc.order_id, 404, 'Nie znaleziono zwrotu tego zamówienia');
    ret = { id: r.id, number: r.number };
    if (r.received_at === null || !['refund_pending', 'closed'].includes(r.state)) blockers.push(`Zwrot ${r.number} nie został przyjęty — korektę wystawisz po przyjęciu zwrotu`);
    const done = (await c.query('SELECT number FROM invoice232_corrections WHERE return_id=$1', [r.id])).rows[0];
    if (done) blockers.push(`Zwrot ${r.number} ma już korektę ${done.number}`);
    const items = (await c.query('SELECT item_id,sku,accepted,refund_amount FROM return_items WHERE return_id=$1 ORDER BY item_id', [r.id])).rows;
    const x = returnEdits(o, state, items, Number(r.refunded_shipping));
    edits = x.edits; blockers.push(...x.blockers);
  }
  const d = correctionMath(o, state, req.mode, req.reason_code, edits);
  blockers.push(...d.blockers);
  const issue = await today(c);
  if (issue < s.issue_date) blockers.push('Data korekty nie może poprzedzać daty faktury');
  const reason = reasonText(req.reason_code, req.reason_note);
  if (reason.length > 256) blockers.push('Przyczyna korekty: najwyżej 256 znaków');
  const n = s.nbp;
  if (n && record.mid !== n.mid) blockers.push('Kurs zapisany z fakturą nie odpowiada jej migawce');
  const snapshot = correctionSnapshotOf({ doc, ksef_number: ksef?.ksef_number ?? null, ret, req, math: d.math, position, issue_date: issue });
  return { original_document_id: doc.id, snapshot, blockers };
}

export type Invoice232PreviewView = { id: string; original_document_id: string; order_id: string; return_id: string | null; scope_hash: string; snapshot: Invoice232Snapshot; expires_at: string; created_at: string };
const previewView = (p: any): Invoice232PreviewView => ({ id: p.id, original_document_id: p.original_document_id, order_id: p.order_id, return_id: p.return_id, scope_hash: p.scope_hash,
  snapshot: p.snapshot, expires_at: iso(p.expires_at), created_at: iso(p.created_at) });

/** Stores the preview the user confirms; a correction that cannot be issued is refused with its reasons (409). */
export async function storeInvoice232PreviewInTx(c: PoolClient, a: LocalInvoiceActor, originalId: string, input: unknown): Promise<{ preview: Invoice232PreviewView; reused: boolean }> {
  await requireInvoice232(c);
  const b = invoice232PreviewInput.parse(input), stored = JSON.parse(JSON.stringify(b));
  const old = (await c.query('SELECT * FROM invoice232_previews WHERE client_key=$1', [b.client_key])).rows[0];
  if (old) {
    ensure(old.original_document_id === originalId && old.actor_id === a.userId && (old.api_key_id ?? null) === (a.apiKeyId ?? null) && isDeepStrictEqual(old.request, stored),
      409, 'Klucz podglądu korekty użyty z innymi danymi');
    return { preview: previewView(old), reused: true };
  }
  await lockInvoice(c, originalId);
  const calc = await invoice232SnapshotInTx(c, originalId, b.correction);
  ensure(!calc.blockers.length, 409, calc.blockers.join(' · '));
  const s = calc.snapshot;
  const p = (await c.query(`INSERT INTO invoice232_previews(tenant_id,original_document_id,order_id,return_id,actor_id,api_key_id,client_key,request,snapshot,scope_hash,created_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,encode(sha256(convert_to($9::jsonb::text,'UTF8')),'hex'),now,now+make_interval(mins=>$10) FROM (SELECT clock_timestamp() now) t RETURNING *`,
  [a.tenantId, originalId, s.order.id, s.return?.id ?? null, a.userId, a.apiKeyId ?? null, b.client_key, JSON.stringify(stored), JSON.stringify(s), PREVIEW_MINUTES])).rows[0];
  await audit(c, a, 'invoice232.preview', p.id, { original_document_id: originalId, return_id: s.return?.id ?? null, scope_hash: p.scope_hash, delta_gross_minor: s.totals.delta.gross_minor });
  return { preview: previewView(p), reused: false };
}

/** Issues a stored preview: recomputes it, takes the next KOR-S number, writes the correction and its
 * categories; deferred checks run at the end (SET CONSTRAINTS ALL IMMEDIATE). */
export async function issueInvoice232InTx(c: PoolClient, a: LocalInvoiceActor, previewId: string, input: unknown): Promise<{ id: string; reused: boolean }> {
  await requireInvoice232(c);
  const b = invoice232IssueInput.parse(input);
  const p = (await c.query('SELECT * FROM invoice232_previews WHERE id=$1', [previewId])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu korekty');
  const done = (await c.query('SELECT id,preview_id,actor_id,api_key_id,scope_hash FROM invoice232_corrections WHERE client_key=$1', [b.client_key])).rows[0];
  if (done) {
    ensure(done.preview_id === previewId && done.actor_id === a.userId && (done.api_key_id ?? null) === (a.apiKeyId ?? null) && done.scope_hash === b.scope_hash, 409, 'Klucz wystawienia korekty użyty z innymi danymi');
    return { id: done.id, reused: true };
  }
  ensure(p.actor_id === a.userId && (p.api_key_id ?? null) === (a.apiKeyId ?? null), 409, 'Podgląd korekty przygotował inny użytkownik — przygotuj własny podgląd');
  ensure(p.scope_hash === b.scope_hash, 409, 'Potwierdzenie dotyczy innego podglądu korekty');
  ensure(new Date(p.expires_at).getTime() > Date.now(), 409, 'Podgląd korekty wygasł — przygotuj nowy');
  ensure(!(await c.query('SELECT 1 FROM invoice232_corrections WHERE preview_id=$1', [previewId])).rowCount, 409, 'Ten podgląd został już wystawiony innym kluczem');
  await lockInvoice(c, p.original_document_id);
  const calc = await invoice232SnapshotInTx(c, p.original_document_id, invoice232PreviewInput.parse(p.request).correction);
  ensure(!calc.blockers.length, 409, calc.blockers.join(' · '));
  ensure((await c.query('SELECT $1::jsonb=$2::jsonb AS same', [JSON.stringify(calc.snapshot), JSON.stringify(p.snapshot)])).rows[0].same, 409,
    'Faktura, jej korekty, zwrot lub numer KSeF zmieniły się po podglądzie korekty — przygotuj nowy podgląd');
  const s: Invoice232Snapshot = p.snapshot, year = s.year, series = s.original.series;
  const last = (await c.query('SELECT last_number FROM invoice232_counters WHERE series_id=$1 AND year=$2 FOR UPDATE', [series.id, year])).rows[0];
  const seq = (last?.last_number ?? 0) + 1;
  ensure(seq <= 999_999, 409, 'Roczna numeracja korekt serii jest wyczerpana');
  if (last) await c.query('UPDATE invoice232_counters SET last_number=$3 WHERE series_id=$1 AND year=$2', [series.id, year, seq]);
  else await c.query('INSERT INTO invoice232_counters(tenant_id,series_id,year,last_number) VALUES($1,$2,$3,1)', [a.tenantId, series.id, year]);
  const number = `KOR-S/${series.prefix}/${year}/${String(seq).padStart(6, '0')}`, id = randomUUID();
  const data: Invoice232Data = { ...s, number, preview_id: previewId, scope_hash: p.scope_hash };
  const t = s.totals, pl = s.pln_totals;
  await c.query(`INSERT INTO invoice232_corrections(id,tenant_id,kind,mode,preview_id,original_document_id,order_id,return_id,position,series_id,year,sequence,number,
      correction_kind,direction,reason_code,reason,currency,mid,mpp_required,gross_before_minor,net_delta_minor,vat_delta_minor,gross_delta_minor,gross_after_minor,
      net_pln_delta_minor,vat_pln_delta_minor,gross_pln_delta_minor,data,scope_hash,actor_id,api_key_id,client_key)
    VALUES($1,$2,'correction',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29,$30,$31,$32)`,
  [id, a.tenantId, INVOICE232_MODE, previewId, p.original_document_id, s.order.id, s.return?.id ?? null, s.position, series.id, year, seq, number,
    s.kind, s.direction, s.reason_code, s.reason, s.currency, s.nbp?.mid ?? null, s.mpp.required, t.before.gross_minor, t.delta.net_minor, t.delta.vat_minor, t.delta.gross_minor, t.after.gross_minor,
    pl?.delta.net_pln_minor ?? null, pl?.delta.vat_pln_minor ?? null, pl?.delta.gross_pln_minor ?? null, JSON.stringify(data), p.scope_hash, a.userId, a.apiKeyId ?? null, b.client_key]);
  for (const k of s.categories)
    await c.query(`INSERT INTO invoice232_categories(tenant_id,correction_id,key,rate_code,net_before_minor,vat_before_minor,net_after_minor,vat_after_minor,net_delta_minor,vat_delta_minor,gross_delta_minor,
        mid,net_pln_before_minor,vat_pln_before_minor,net_pln_after_minor,vat_pln_after_minor,net_pln_delta_minor,vat_pln_delta_minor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [a.tenantId, id, k.key, k.rate_code, k.before.net_minor, k.before.vat_minor, k.after.net_minor, k.after.vat_minor, k.delta.net_minor, k.delta.vat_minor, k.delta.gross_minor,
      s.nbp?.mid ?? null, k.pln?.before.net_pln_minor ?? null, k.pln?.before.vat_pln_minor ?? null, k.pln?.after.net_pln_minor ?? null, k.pln?.after.vat_pln_minor ?? null,
      k.pln?.delta.net_pln_minor ?? null, k.pln?.delta.vat_pln_minor ?? null]);
  await audit(c, a, 'invoice232.issue', id, { original_document_id: p.original_document_id, preview_id: previewId, number, scope_hash: p.scope_hash, delta_gross_minor: t.delta.gross_minor });
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  return { id, reused: false };
}

export type Invoice232Record = { position: number; series_id: string; year: number; sequence: number; currency: string; mid: string | null;
  categories: { key: string; rate_code: string; net_delta_minor: string; vat_delta_minor: string; net_pln_delta_minor: string | null; vat_pln_delta_minor: string | null }[] };
/** The issued correction with its record; 503 when the stored data no longer matches its categories. */
export async function invoice232DocumentInTx(c: PoolClient, id: string): Promise<{ document: Invoice232Document; record: Invoice232Record }> {
  await requireInvoice232(c);
  const d = (await c.query('SELECT *,mid::text mid FROM invoice232_corrections WHERE id=$1', [id])).rows[0];
  ensure(d, 404, 'Nie znaleziono korekty');
  const cats = (await c.query('SELECT key,rate_code,net_delta_minor::text,vat_delta_minor::text,net_pln_delta_minor::text,vat_pln_delta_minor::text FROM invoice232_categories WHERE correction_id=$1 ORDER BY key', [id])).rows;
  ensure(d.data.number === d.number && cats.length === d.data.categories.length && cats.every((k: any) => {
    const s = d.data.categories.find((x: CorrectionCategory) => x.key === k.key);
    return s && s.delta.net_minor === k.net_delta_minor && s.delta.vat_minor === k.vat_delta_minor && (s.pln?.delta.net_pln_minor ?? null) === k.net_pln_delta_minor;
  }), 503, 'Korekta nie odpowiada swojemu trwałemu zapisowi 232');
  return { document: { id: d.id, order_id: d.order_id, original_document_id: d.original_document_id, return_id: d.return_id, number: d.number, kind: 'correction', mode: INVOICE232_MODE,
    data: d.data, created_at: iso(d.created_at) },
  record: { position: d.position, series_id: d.series_id, year: d.year, sequence: d.sequence, currency: d.currency, mid: d.mid, categories: cats } };
}
export async function invoice232RegisterInTx(c: PoolClient, filter: { order_id?: string; original_document_id?: string }): Promise<Invoice232Document[]> {
  await requireInvoice232(c);
  const rows = (await c.query(`SELECT id FROM invoice232_corrections WHERE ($1::uuid IS NULL OR order_id=$1) AND ($2::uuid IS NULL OR original_document_id=$2)
    ORDER BY created_at DESC,id DESC LIMIT 100`, [filter.order_id ?? null, filter.original_document_id ?? null])).rows;
  const out: Invoice232Document[] = [];
  for (const r of rows) out.push((await invoice232DocumentInTx(c, r.id)).document);
  return out;
}
/** What the correction editor needs: the invoice, its corrections, the current state of every line and the order's returns. */
export async function invoice232StateInTx(c: PoolClient, originalId: string) {
  await requireInvoice232(c);
  const { document: doc } = await invoice230DocumentInTx(c, originalId);
  const { chain, position, state } = await currentStateInTx(c, doc);
  const o = correctionOriginalOf(doc.data);
  const total = state.reduce((s, l) => s + BigInt(l.gross_minor), 0n);
  return { original: { id: doc.id, number: doc.number, order_id: doc.order_id, currency: doc.data.currency, issue_date: doc.data.issue_date, mpp_required: doc.data.mpp.required,
      nbp: doc.data.nbp ? { mid: doc.data.nbp.mid, rate_date: doc.data.nbp.rate_date, table_no: doc.data.nbp.table_no } : null },
    lines: o.lines.map(l => ({ ...l, current: state.find(s => s.line_no === l.line_no)! })), current_gross_minor: String(total), next_position: position,
    corrections: chain.map(x => ({ position: x.position, number: x.data.number, kind: x.data.kind, reason: x.data.reason, delta_gross_minor: x.data.totals.delta.gross_minor, issue_date: x.data.issue_date })),
    returns: await returnSourcesInTx(c, doc.order_id) };
}
