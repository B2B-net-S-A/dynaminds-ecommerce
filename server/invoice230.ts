/** Invoices 230: preview and issue of the invoices the 157 local invoice cannot express
 * (B2B buyer, ZW/NP I/NP II/OO/OSS lines, EUR with the NBP rate of the tax point). Rules are
 * pure (invoice230-model.ts); this module reads the order, the 157 series definition, the 226
 * tax profiles and OSS settings and the 227 stored rates, and writes only the own 230 tables
 * plus the documents row. Numbering: own sub-series FV-S/<prefix>/<year>/<sequence> per 157
 * series, continuous within itself; the 157 counter is never touched.
 * Design: docs/parity/INVOICES230-20261023.md. */
import { automationOnlyEvent } from './automation-v2-triggers';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { assertNoFa3DraftProjectInTx, fa3DraftOwnerInTx } from './fa3-draft-access';
import { assertNoPartialCommercialInvoiceInTx } from './commercial-sale-scope';
import type { LocalInvoiceActor } from './local-invoice-values';
import { DEFAULT_TAX_PROFILE, type OssState, type TaxProfile } from './tax226-model';
import { ossSettingsInTx } from './tax226';
import { captureDocumentNbpRateInTx, nbp227Available, rateForTaxPointInTx } from './nbp227';
import { nbpRateLine, taxPointOf } from './nbp227-model';
import { lockOrderReceipt, linkInvoiceToReceiptInTx, receiptForInvoiceInTx, type ReceiptLinkPlan } from './receipt233';
import {
  buyerInput, invoiceMath, mppInPln, normalizeBuyer, plnCategories,
  type Buyer, type CategoryTotal, type InvoiceLine, type PlnCategory, type SourceLine,
} from './invoice230-model';

export const INVOICE230_MODE = 'invoice230';
const PREVIEW_MINUTES = 15;
export async function invoice230Available(c: Pool | PoolClient): Promise<boolean> {
  return Boolean((await c.query(`SELECT to_regclass('public.invoice230_documents') IS NOT NULL AND to_regclass('public.invoice230_categories') IS NOT NULL
    AND to_regclass('public.invoice230_counters') IS NOT NULL AND to_regclass('public.invoice230_previews') IS NOT NULL
    AND to_regprocedure('public.invoice230_document_guard()') IS NOT NULL AS available`)).rows[0]?.available);
}
export async function requireInvoice230(c: PoolClient): Promise<void> {
  ensure(await invoice230Available(c), 503, 'Faktury szczególne (migracja 230) są niedostępne w tej kopii');
}

const uuid = z.uuid().transform(v => v.toLowerCase());
export const invoice230PreviewInput = z.strictObject({
  client_key: uuid,
  series_id: uuid,
  order_version: z.string().regex(/^[1-9][0-9]{0,18}$/, 'Wersja zamówienia'),
  shipping_vat: z.union([z.literal(0), z.literal(5), z.literal(8), z.literal(23)]),
  buyer: buyerInput,
  sell_date: z.iso.date(),
});
export type Invoice230PreviewInput = z.infer<typeof invoice230PreviewInput>;
export const invoice230CalculateInput = invoice230PreviewInput.omit({ client_key: true });

export type Invoice230Line = Omit<InvoiceLine, 'source_index'> & { item_id: string | null; product_id: string | null; quantity: number; unit: 'szt.' | 'usł.';
  unit_gross_minor: string; discount_gross_minor: string; rounding_gross_minor: string; vat_rate: number };
export type Invoice230Nbp = { currency: 'EUR'; tax_point: string; tax_point_basis: 'sell_date' | 'issue_date'; rate_date: string; table_no: string; mid: string;
  source: 'fetched' | 'manual'; categories: PlnCategory[]; totals: { net_pln_minor: string; vat_pln_minor: string; gross_pln_minor: string }; line: string };
/** documents.data of a 230 invoice (the preview snapshot plus number, preview_id and scope_hash). */
export type Invoice230Snapshot = {
  format: 'invoice230/v1';
  order: { id: string; number: string; version: string; status: string; currency: string; total_minor: string; shipping_cost_minor: string; payment_mode: string };
  seller: { name: string; street: string; postal_code: string; city: string; country: 'PL'; tax_id: string };
  buyer: Buyer & { email: string };
  series: { id: string; name: string; prefix: string; payment_terms_days: number; payment_instructions: string; notes: string };
  currency: 'PLN' | 'EUR';
  lines: Invoice230Line[];
  categories: CategoryTotal[];
  totals: { net_minor: string; vat_minor: string; gross_minor: string };
  annex15_gross_minor: string; procedure: 'domestic' | 'oss'; reverse_charge: boolean;
  exemption: { kind: 'P_19A' | 'P_19B' | 'P_19C'; basis: string } | null;
  mpp: { required: boolean; reason: string; gross_pln_minor: string | null };
  nbp: Invoice230Nbp | null;
  rounding_method: 'gross_line_half_up';
  sell_date: string; issue_date: string; due_date: string; year: number;
  local_only: true; ksef_state: 'not_submitted'; fiscalized: false;
};
export type Invoice230Data = Invoice230Snapshot & { number: string; preview_id: string; scope_hash: string };
export type Invoice230Document = { id: string; order_id: string; number: string; kind: 'invoice'; mode: 'invoice230'; data: Invoice230Data; created_at: string };

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
const today = async (c: PoolClient) => (await c.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d")).rows[0].d as string;
const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const profileOf = (r: any): TaxProfile => ({ version: r.version, category: r.category, exemption_basis_kind: r.exemption_basis_kind, exemption_basis: r.exemption_basis,
  np_kind: r.np_kind, gtu: r.gtu, annex15: r.annex15, oss_rate_class: r.oss_rate_class });
const exists = async (c: PoolClient, sql: string, values: unknown[]) => Boolean((await c.query(sql, values)).rowCount);

/** Reasons the order cannot get a 230 invoice at all (same scope rules as the 157 frame, plus no other invoice). */
async function orderRefusals(c: PoolClient, o: any): Promise<string[]> {
  const out: string[] = [], id = o.id;
  if (!['shipped', 'delivered'].includes(o.status)) out.push('Fakturę wystawisz po wysłaniu lub dostarczeniu zamówienia');
  if (o.fulfillment_kind !== 'sale') out.push('Zamówienie nie jest sprzedażą (np. wymiana lub wysyłka zastępcza)');
  if (await exists(c, 'SELECT 1 FROM order_merge_claims WHERE source_order_id=$1', [id])) out.push('Zamówienie zostało scalone z innym — fakturę wystawia się na zamówieniu docelowym');
  if (await exists(c, 'SELECT 1 FROM return_cases WHERE order_id=$1', [id])) out.push('Zamówienie ma zwrot — faktura 230 przed zwrotem nie jest obsługiwana');
  if (await exists(c, "SELECT 1 FROM documents WHERE order_id=$1 AND kind='correction'", [id])) out.push('Zamówienie ma korektę — faktura 230 nie jest obsługiwana');
  if (await exists(c, "SELECT 1 FROM documents WHERE order_id=$1 AND kind='invoice' AND mode NOT IN ('demo','simulation','provider_test')", [id]))
    out.push('Zamówienie ma już fakturę');
  if (await exists(c, "SELECT 1 FROM invoice_plans WHERE order_id=$1 AND kind='invoice' AND mode='external' AND state NOT IN ('preview','cancelled')", [id])
    || await exists(c, "SELECT 1 FROM odoo_invoice_exports WHERE order_id=$1 AND mode='external' AND state NOT IN ('preview','cancelled')", [id]))
    out.push('Zamówienie ma zatwierdzony plan faktury zewnętrznej');
  if (o.source === 'b2b' || await exists(c, 'SELECT 1 FROM b2b_dropship_orders WHERE customer_order_id=$1', [id])) out.push('Zamówienie sieci B2B fakturuje się jako FV B2B');
  if (!['PLN', 'EUR'].includes(o.currency)) out.push(`Waluta ${o.currency} nie jest obsługiwana — faktura 230 obsługuje PLN i EUR`);
  if (o.shipping_cost < 0 || o.total < 0) out.push('Zamówienie ma ujemne kwoty');
  return out;
}

/** `snapshot` is complete only when `blockers` is empty; otherwise it shows what could be computed. */
/** `receipt`: the printed fiscal receipt (233) the invoice would be issued to (faktura do paragonu), or null. */
export type Invoice230Calculation = { order_id: string; order_version: string; snapshot: Invoice230Snapshot; blockers: string[]; receipt: ReceiptLinkPlan };
/** The snapshot the issue would store now, or the reasons it cannot be issued. Reads only. */
export async function invoice230SnapshotInTx(c: PoolClient, orderId: string, input: z.infer<typeof invoice230CalculateInput>, lock: boolean): Promise<Invoice230Calculation> {
  await requireInvoice230(c);
  const o = (await c.query(`SELECT * FROM orders WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [orderId])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  ensure(String(o.version) === input.order_version, 409, 'Zamówienie zmieniło się. Odśwież zamówienie i przelicz fakturę.');
  const s = (await c.query(`SELECT * FROM local_invoice_series WHERE id=$1`, [input.series_id])).rows[0];
  ensure(s, 404, 'Nie znaleziono serii faktur');
  const blockers = await orderRefusals(c, o);
  const items = (await c.query(`SELECT * FROM order_items WHERE order_id=$1 ORDER BY id${lock ? ' FOR SHARE' : ''}`, [orderId])).rows;
  if (items.length < 1 || items.length > 100) blockers.push('Faktura obejmuje od 1 do 100 pozycji zamówienia');
  const issue = await today(c), buyer = normalizeBuyer(input.buyer);
  const created = iso(o.created_at).slice(0, 10);
  if (input.sell_date > issue || input.sell_date < created) blockers.push('Data sprzedaży musi być między datą zamówienia a dniem wystawienia');
  if (buyer.kind === 'consumer' && o.address?.country !== buyer.address.country)
    blockers.push(`Konsument: kraj nabywcy (${buyer.address.country}) musi być krajem dostawy zamówienia (${o.address?.country ?? 'brak'})`);
  const ids = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  const profiles = new Map((await c.query('SELECT * FROM tax226_product_profiles WHERE product_id=ANY($1::uuid[])', [ids])).rows.map(r => [r.product_id as string, profileOf(r)]));
  const ossView = await ossSettingsInTx(c), oss: OssState = { registered: ossView.settings.registered, registered_from: ossView.settings.registered_from, rates: ossView.rates };
  const extra = new Map<string, Pick<Invoice230Line, 'item_id' | 'product_id' | 'quantity' | 'unit' | 'unit_gross_minor' | 'discount_gross_minor' | 'rounding_gross_minor' | 'vat_rate'>>();
  const source: SourceLine[] = [];
  let sum = 0n;
  for (const i of items) {
    const gross = BigInt(i.line_total ?? -1), price = BigInt(i.price), q = BigInt(i.quantity);
    if (i.quantity <= 0 || i.price < 0 || ![0, 5, 8, 23].includes(i.vat) || gross < 0n || gross - price * q >= q) { blockers.push(`${i.sku || i.name}: pozycja ma niespójne kwoty`); continue; }
    const key = 'item:' + source.length;
    source.push({ kind: 'item', sku: i.sku ?? '', name: i.name, vat_rate: i.vat, gross_minor: String(gross), profile: (i.product_id && profiles.get(i.product_id)) || DEFAULT_TAX_PROFILE });
    extra.set(key, { item_id: i.id, product_id: i.product_id, quantity: i.quantity, unit: 'szt.', unit_gross_minor: String(price),
      discount_gross_minor: String(price * q > gross ? price * q - gross : 0n), rounding_gross_minor: String(gross > price * q ? gross - price * q : 0n), vat_rate: i.vat });
    sum += gross;
  }
  const shipping = BigInt(o.shipping_cost);
  source.push({ kind: 'shipping', sku: '', name: 'Dostawa', vat_rate: input.shipping_vat, gross_minor: String(shipping), profile: null });
  if (sum + shipping !== BigInt(o.total)) blockers.push('Pozycje faktury nie sumują się do zamówienia');
  const currency = o.currency === 'EUR' ? 'EUR' as const : 'PLN' as const;
  const d = invoiceMath({ buyer, currency, sell_date: input.sell_date, lines: source, oss });
  blockers.push(...d.blockers);
  // 233: an order with a printed receipt gets an invoice to that receipt (B2B only with its NIP on the receipt).
  const receipt = await receiptForInvoiceInTx(c, orderId, { buyer_kind: buyer.kind, buyer_tax_id_kind: buyer.tax_id_kind, buyer_tax_id: buyer.tax_id, gross_minor: d.math.totals.gross_minor }, false);
  blockers.push(...receipt.blockers);
  // Each stored line carries the order item it documents (source_index is only used here).
  const lines: Invoice230Line[] = d.math.lines.map(({ source_index, ...l }) => l.kind === 'shipping'
    ? { ...l, item_id: null, product_id: null, quantity: 1, unit: 'usł.' as const, unit_gross_minor: l.gross_minor, discount_gross_minor: '0', rounding_gross_minor: '0', vat_rate: input.shipping_vat }
    : { ...l, ...extra.get('item:' + source_index)! });
  let nbp: Invoice230Nbp | null = null;
  if (currency === 'EUR') {
    if (!(await nbp227Available(c))) blockers.push('Kursy NBP (migracja 227) są niedostępne — faktura w EUR wymaga kursu');
    else {
      const point = taxPointOf({ sell_date: input.sell_date, issue_date: issue }), choice = await rateForTaxPointInTx(c, 'EUR', point.date);
      if ('refusal' in choice) blockers.push(choice.refusal);
      else if (d.math.categories.length) {
        const r = choice.rate, p = plnCategories(d.math.categories, r.mid);
        nbp = { currency: 'EUR', tax_point: point.date, tax_point_basis: point.basis, rate_date: r.effective_date, table_no: r.table_no, mid: r.mid, source: r.source,
          categories: p.rows, totals: p.totals, line: nbpRateLine({ currency: 'EUR', rate_date: r.effective_date, table_no: r.table_no, mid: r.mid, vat_pln_minor: p.totals.vat_pln_minor }) };
      }
    }
  }
  const mpp = mppInPln(buyer, d.math, currency, nbp?.mid ?? null);
  const def = s.definition, terms = Number(def.payment_terms_days);
  const snapshot: Invoice230Snapshot = {
    format: 'invoice230/v1',
    order: { id: o.id, number: o.number, version: String(o.version), status: o.status, currency: o.currency, total_minor: String(o.total), shipping_cost_minor: String(o.shipping_cost), payment_mode: o.payment_mode },
    seller: def.seller, buyer: { ...buyer, email: o.email ?? '' },
    series: { id: s.id, name: s.name, prefix: s.prefix, payment_terms_days: terms, payment_instructions: def.payment_instructions ?? '', notes: def.notes ?? '' },
    currency, lines, categories: d.math.categories, totals: d.math.totals, annex15_gross_minor: d.math.annex15_gross_minor,
    procedure: d.math.procedure, reverse_charge: d.math.reverse_charge, exemption: d.math.exemption as Invoice230Snapshot['exemption'], mpp, nbp,
    rounding_method: 'gross_line_half_up', sell_date: input.sell_date, issue_date: issue, due_date: addDays(issue, terms), year: Number(issue.slice(0, 4)),
    local_only: true, ksef_state: 'not_submitted', fiscalized: false,
  };
  return { order_id: o.id, order_version: String(o.version), snapshot, blockers, receipt: receipt.plan };
}

/** Takes the native invoice lock (shared with 157) and refuses an order with a B2B FA(3) project or a partial commercial scope. */
async function invoiceLocksInTx(c: PoolClient, orderId: string) {
  await fa3DraftOwnerInTx(c, () => c.query('SELECT public.local_invoice_locks()'));
  await assertNoFa3DraftProjectInTx(c, orderId);
  await assertNoPartialCommercialInvoiceInTx(c, orderId);
}

export type Invoice230PreviewView = { id: string; order_id: string; series_id: string; order_version: string; scope_hash: string; snapshot: Invoice230Snapshot; expires_at: string; created_at: string };
const previewView = (p: any): Invoice230PreviewView => ({ id: p.id, order_id: p.order_id, series_id: p.series_id, order_version: String(p.order_version), scope_hash: p.scope_hash,
  snapshot: p.snapshot, expires_at: iso(p.expires_at), created_at: iso(p.created_at) });

/** Stores the preview the user confirms; an invoice that cannot be issued is refused with its reasons (409). */
export async function storeInvoice230PreviewInTx(c: PoolClient, a: LocalInvoiceActor, orderId: string, b: Invoice230PreviewInput): Promise<{ preview: Invoice230PreviewView; reused: boolean }> {
  await requireInvoice230(c);
  const { client_key, ...request } = b, stored = { client_key, ...request };
  const old = (await c.query('SELECT * FROM invoice230_previews WHERE client_key=$1', [client_key])).rows[0];
  if (old) {
    ensure(old.order_id === orderId && old.actor_id === a.userId && (old.api_key_id ?? null) === (a.apiKeyId ?? null) && isDeepStrictEqual(old.request, JSON.parse(JSON.stringify(stored))),
      409, 'Klucz podglądu użyty z innymi danymi');
    return { preview: previewView(old), reused: true };
  }
  await invoiceLocksInTx(c, orderId);
  const calc = await invoice230SnapshotInTx(c, orderId, request, true);
  ensure(!calc.blockers.length, 409, calc.blockers.join(' · '));
  const p = (await c.query(`INSERT INTO invoice230_previews(tenant_id,order_id,order_version,series_id,actor_id,api_key_id,client_key,request,snapshot,scope_hash,created_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,encode(sha256(convert_to($9::jsonb::text,'UTF8')),'hex'),now,now+make_interval(mins=>$10) FROM (SELECT clock_timestamp() now) t RETURNING *`,
  [a.tenantId, orderId, calc.order_version, request.series_id, a.userId, a.apiKeyId ?? null, client_key, JSON.stringify(stored), JSON.stringify(calc.snapshot), PREVIEW_MINUTES])).rows[0];
  await audit(c, a, 'invoice230.preview', p.id, { order_id: orderId, series_id: request.series_id, scope_hash: p.scope_hash });
  return { preview: previewView(p), reused: false };
}

export async function invoice230PreviewExistsInTx(c: PoolClient, id: string): Promise<boolean> {
  if (!(await invoice230Available(c))) return false;
  return exists(c, 'SELECT 1 FROM invoice230_previews WHERE id=$1', [id]);
}

/** Issues a stored preview: recomputes it, takes the next number of the sub-series, writes the document,
 * the 230 header and categories, and for EUR also the 227 rate record when every category is a 227 VAT rate;
 * deferred checks run at the end (SET CONSTRAINTS ALL IMMEDIATE). */
export async function issueInvoice230InTx(c: PoolClient, a: LocalInvoiceActor, previewId: string, b: { client_key: string; scope_hash: string }): Promise<{ document_id: string; reused: boolean }> {
  await requireInvoice230(c);
  const p = (await c.query('SELECT * FROM invoice230_previews WHERE id=$1', [previewId])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu faktury');
  const done = (await c.query('SELECT document_id,preview_id,actor_id,api_key_id,scope_hash FROM invoice230_documents WHERE client_key=$1', [b.client_key])).rows[0];
  if (done) {
    ensure(done.preview_id === previewId && done.actor_id === a.userId && (done.api_key_id ?? null) === (a.apiKeyId ?? null) && done.scope_hash === b.scope_hash, 409, 'Klucz wystawienia użyty z innymi danymi');
    return { document_id: done.document_id, reused: true };
  }
  ensure(p.actor_id === a.userId && (p.api_key_id ?? null) === (a.apiKeyId ?? null), 409, 'Podgląd przygotował inny użytkownik — przygotuj własny podgląd');
  ensure(p.scope_hash === b.scope_hash, 409, 'Potwierdzenie dotyczy innego podglądu faktury');
  ensure(new Date(p.expires_at).getTime() > Date.now(), 409, 'Podgląd faktury wygasł — przygotuj nowy');
  await invoiceLocksInTx(c, p.order_id);
  await lockOrderReceipt(c, p.order_id);
  const calc = await invoice230SnapshotInTx(c, p.order_id, p.request, true);
  ensure(!calc.blockers.length, 409, calc.blockers.join(' · '));
  ensure((await c.query('SELECT $1::jsonb=$2::jsonb AS same', [JSON.stringify(calc.snapshot), JSON.stringify(p.snapshot)])).rows[0].same, 409,
    'Zamówienie, dane podatkowe lub kurs zmieniły się po podglądzie faktury — przygotuj nowy podgląd');
  const s: Invoice230Snapshot = p.snapshot, year = s.year;
  const last = (await c.query('SELECT last_number FROM invoice230_counters WHERE series_id=$1 AND year=$2 FOR UPDATE', [s.series.id, year])).rows[0];
  const seq = (last?.last_number ?? 0) + 1;
  ensure(seq <= 999_999, 409, 'Roczna numeracja serii jest wyczerpana');
  if (last) await c.query('UPDATE invoice230_counters SET last_number=$3 WHERE series_id=$1 AND year=$2', [s.series.id, year, seq]);
  else await c.query('INSERT INTO invoice230_counters(tenant_id,series_id,year,last_number) VALUES($1,$2,$3,1)', [a.tenantId, s.series.id, year]);
  const number = `FV-S/${s.series.prefix}/${year}/${String(seq).padStart(6, '0')}`, id = randomUUID();
  const data: Invoice230Data = { ...s, number, preview_id: previewId, scope_hash: p.scope_hash };
  await automationOnlyEvent(c, a.tenantId, p.order_id, 'document.issued', { document_id: id, kind: 'invoice' });
  await c.query("INSERT INTO documents(id,tenant_id,order_id,number,kind,mode,data) VALUES($1,$2,$3,$4,'invoice',$5,$6::jsonb)", [id, a.tenantId, p.order_id, number, INVOICE230_MODE, JSON.stringify(data)]);
  const n = s.nbp;
  await c.query(`INSERT INTO invoice230_documents(document_id,tenant_id,preview_id,order_id,series_id,year,sequence,number,buyer_kind,buyer_country,buyer_tax_id_kind,buyer_tax_id,pl_vat_payer,
      currency,procedure,net_minor,vat_minor,gross_minor,annex15_gross_minor,mpp_required,reverse_charge,exemption_kind,exemption_basis,
      tax_point,tax_point_basis,rate_date,table_no,mid,rate_source,net_pln_minor,vat_pln_minor,gross_pln_minor,snapshot,scope_hash,actor_id,api_key_id,client_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33::jsonb,$34,$35,$36,$37)`,
  [id, a.tenantId, previewId, p.order_id, s.series.id, year, seq, number, s.buyer.kind, s.buyer.address.country, s.buyer.tax_id_kind, s.buyer.tax_id, s.buyer.pl_vat_payer,
    s.currency, s.procedure, s.totals.net_minor, s.totals.vat_minor, s.totals.gross_minor, s.annex15_gross_minor, s.mpp.required, s.reverse_charge, s.exemption?.kind ?? null, s.exemption?.basis ?? null,
    n?.tax_point ?? null, n?.tax_point_basis ?? null, n?.rate_date ?? null, n?.table_no ?? null, n?.mid ?? null, n?.source ?? null,
    n?.totals.net_pln_minor ?? null, n?.totals.vat_pln_minor ?? null, n?.totals.gross_pln_minor ?? null, JSON.stringify(data), p.scope_hash, a.userId, a.apiKeyId ?? null, b.client_key]);
  for (const cat of s.categories) {
    const pln = n?.categories.find(x => x.key === cat.key);
    await c.query(`INSERT INTO invoice230_categories(tenant_id,document_id,key,rate_code,rate,net_minor,vat_minor,gross_minor,mid,net_pln_minor,vat_pln_minor,gross_pln_minor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [a.tenantId, id, cat.key, cat.rate_code, cat.rate, cat.net_minor, cat.vat_minor, cat.gross_minor, n?.mid ?? null, pln?.net_pln_minor ?? null, pln?.vat_pln_minor ?? null, pln?.gross_pln_minor ?? null]);
  }
  // 227: the rate record of the document when every category is one of its VAT rates (0/5/8/23).
  // ZW/NP/OO categories have no 227 bucket (CHECK vat_rate IN (0,5,8,23)); their PLN amounts live in 230 only.
  if (n && s.categories.every(x => ['23', '8', '5', '0 KR'].includes(x.rate_code)))
    await captureDocumentNbpRateInTx(c, a, id, { currency: s.currency, sell_date: s.sell_date, issue_date: s.issue_date,
      vat_totals: s.categories.map(x => ({ vat_rate: x.rate_code === '0 KR' ? 0 : Number(x.rate_code), net_minor: x.net_minor, vat_minor: x.vat_minor, gross_minor: x.gross_minor })) }, true);
  if (calc.receipt) await linkInvoiceToReceiptInTx(c, a, calc.receipt, id, 'invoice230');
  await audit(c, a, 'invoice230.issue', id, { order_id: p.order_id, preview_id: previewId, number, scope_hash: p.scope_hash, currency: s.currency, categories: s.categories.map(x => x.key) });
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  return { document_id: id, reused: false };
}

export type Invoice230Header = { series_id: string; year: number; sequence: number; currency: string; mid: string | null; rate_date: string | null; table_no: string | null;
  categories: { key: string; rate_code: string; rate: string | null; net_minor: string; vat_minor: string; gross_minor: string; net_pln_minor: string | null; vat_pln_minor: string | null }[] };
/** The issued document with its 230 record; 503 when documents.data no longer equals the stored snapshot. */
export async function invoice230DocumentInTx(c: PoolClient, id: string): Promise<{ document: Invoice230Document; record: Invoice230Header }> {
  await requireInvoice230(c);
  const d = (await c.query("SELECT * FROM documents WHERE id=$1 AND kind='invoice' AND mode=$2", [id, INVOICE230_MODE])).rows[0];
  ensure(d, 404, 'Nie znaleziono faktury');
  const h = (await c.query("SELECT *,mid::text mid,to_char(rate_date,'YYYY-MM-DD') rate_date FROM invoice230_documents WHERE document_id=$1", [id])).rows[0];
  ensure(h && h.order_id === d.order_id && h.number === d.number && isDeepStrictEqual(h.snapshot, d.data), 503, 'Faktura nie odpowiada swojemu trwałemu zapisowi 230');
  const cats = (await c.query('SELECT key,rate_code,rate::text rate,net_minor::text,vat_minor::text,gross_minor::text,net_pln_minor::text,vat_pln_minor::text FROM invoice230_categories WHERE document_id=$1', [id])).rows;
  ensure(cats.length === d.data.categories.length, 503, 'Podsumowanie kategorii faktury jest niepełne');
  return { document: { id: d.id, order_id: d.order_id, number: d.number, kind: 'invoice', mode: 'invoice230', data: d.data, created_at: iso(d.created_at) },
    record: { series_id: h.series_id, year: h.year, sequence: h.sequence, currency: h.currency, mid: h.mid, rate_date: h.rate_date, table_no: h.table_no, categories: cats } };
}
export async function invoice230RegisterInTx(c: PoolClient, orderId: string | null): Promise<Invoice230Document[]> {
  await requireInvoice230(c);
  const rows = (await c.query('SELECT document_id FROM invoice230_documents WHERE ($1::uuid IS NULL OR order_id=$1) ORDER BY created_at DESC,document_id DESC LIMIT 50', [orderId])).rows;
  const out: Invoice230Document[] = [];
  for (const r of rows) out.push((await invoice230DocumentInTx(c, r.document_id)).document);
  return out;
}
/** Refusal used by the other issuing paths (157 tax-issue, Base addInvoice, external, B2B) when the order has a 230 invoice. */
export async function assertNoInvoice230InTx(c: PoolClient, orderId: string): Promise<void> {
  if (!(await invoice230Available(c))) return;
  ensure(!(await exists(c, 'SELECT 1 FROM invoice230_documents WHERE order_id=$1', [orderId])), 409, 'Zamówienie ma już fakturę 230 (FV-S); drugi dokument wymaga korekty tej faktury');
}
export const invoice230Problem = (status: number, message: string) => new Problem(status, message);
