/** 228 RODO in the database: the access register, the customer's data export (art. 15/20)
 * and anonymisation (art. 17) with its preview, the fields kept by law and their due date.
 * Core rows are changed only by ordinary UPDATEs (and the DELETE of CRM extra values) as
 * the application role, each inside its own savepoint: a row whose guard refuses the
 * change (immutable evidence) is kept and recorded instead. Nothing is attached to core tables. */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { tenantAppendTx, tenantTx } from './db';
import { Problem, ensure } from './errors';
import type { Actor } from './domain';
import { paymentBalance } from './payments';
import { effectiveDeliveryInTx } from './buyer-address';
import {
  ANON_NAME, ANON_POSTAL, ANON_STREET, CLOSED_ORDER_STATUSES, HISTORY_VALUE_KINDS, anonymiseHistoryDetail, CRM_PERSONAL_KEYS, LEGAL_BASIS, OPEN_RETURN_STATES, anonEmail, assertAnonymisable, canonical,
  classifyOrderFields, containsNeedle, documentTaxPoint, dueOn, evidenceRetentionEnd, exportCsv, isAnonEmail, maxDay, needlesOf, normalEmail, normalPhone, scrubJson,
  subjectHash, taxRetentionEnd, warsawDay, zipStore, type Blockers, type KeepBasis, type SubjectInput,
} from './rodo228-model';
import { purchaseInvoicesOfSellersInTx } from './ksef243-rodo';
import { subjectNips } from './ksef243-model';

type Row = Record<string, any>;
export type RodoActor = Actor & { apiKeyId?: string };
export type AccessEntry = { action: 'read' | 'list' | 'export' | 'anonymisation_preview' | 'anonymisation'; purpose: string; resource: string;
  crm_client_id?: string | null; subject_hash?: string | null; order_count?: number; detail?: Record<string, unknown> };

let available: Promise<boolean> | undefined;
/** Whether 228 is installed; read once per process. */
export function rodo228Available(pool: Pool): Promise<boolean> {
  return (available ??= pool.query("SELECT to_regclass('public.rodo228_access_log') IS NOT NULL AS present").then(r => r.rows[0]?.present === true));
}

export async function logAccessInTx(c: PoolClient, a: RodoActor, entries: AccessEntry[]) {
  if (!entries.length) return 0;
  const r = await c.query(`INSERT INTO rodo228_access_log(tenant_id,actor_id,api_key_id,channel,action,purpose,resource,crm_client_id,subject_hash,order_count,detail)
    SELECT $1,$2,$3,$4,x.action,x.purpose,x.resource,x.crm_client_id,x.subject_hash,x.order_count,x.detail
    FROM jsonb_to_recordset($5::jsonb) AS x(action text,purpose text,resource text,crm_client_id uuid,subject_hash text,order_count integer,detail jsonb)`,
  [a.tenantId, a.userId, a.apiKeyId ?? null, a.apiKeyId ? 'api' : 'session', JSON.stringify(entries.map(e => ({ action: e.action, purpose: e.purpose.slice(0, 200), resource: e.resource.slice(0, 120),
    crm_client_id: e.crm_client_id ?? null, subject_hash: e.subject_hash ?? null, order_count: e.order_count ?? 0, detail: e.detail ?? {} })))]);
  return r.rowCount ?? 0;
}
/** Read hooks (customer card, CRM wire): one register row per customer whose data left the
 * database; written after the read in its own transaction. Without 228 nothing is written. */
export async function logPersonalDataAccess(pool: Pool, a: RodoActor, key: string, entries: (Omit<AccessEntry, 'subject_hash'> & { email?: unknown; phone?: unknown })[]) {
  if (!entries.length || !(await rodo228Available(pool))) return;
  await tenantAppendTx(a.tenantId, async c => {
    // Reads that return only a CRM id (orders, attachment) carry the hash of the profile's e-mail or phone too.
    const ids = entries.filter(e => e.crm_client_id && e.email === undefined && e.phone === undefined).map(e => e.crm_client_id!);
    const profiles = new Map(ids.length ? (await c.query('SELECT id::text,profile FROM crm_clients WHERE id=ANY($1::uuid[])', [ids])).rows.map(r => [r.id as string, r.profile as Row]) : []);
    return logAccessInTx(c, a, entries.map(({ email, phone, ...e }) => {
      const p = e.crm_client_id ? profiles.get(e.crm_client_id) : undefined;
      return { ...e, subject_hash: identifierHash(key, a.tenantId, email ?? p?.email, phone ?? p?.phone) };
    }));
  });
}
/** Ids per list row: 100 UUIDs fit the 4096-byte detail limit of 228. */
const LIST_IDS_PER_ROW = 100;
/** List reads (CRM list page, connector.php getCrmClients): ONE register row per request
 * instead of one per client, so the reader cannot choose the register's write volume
 * (SEC-013). detail names every listed CRM client by id (never an e-mail or phone); the
 * export and the register filters match those ids. crm_client_id is the first listed id. */
export function listAccessEntries(base: Pick<AccessEntry, 'purpose' | 'resource'>, ids: string[]): AccessEntry[] {
  const unique = [...new Set(ids)], out: AccessEntry[] = [];
  for (let i = 0; i < unique.length; i += LIST_IDS_PER_ROW) {
    const part = unique.slice(i, i + LIST_IDS_PER_ROW);
    out.push({ ...base, action: 'list', crm_client_id: part[0], detail: { count: part.length, crm_client_ids: part } });
  }
  return out;
}
export async function logListAccess(pool: Pool, a: RodoActor, base: Pick<AccessEntry, 'purpose' | 'resource'>, ids: string[]) {
  const entries = listAccessEntries(base, ids);
  if (!entries.length || !(await rodo228Available(pool))) return;
  await tenantAppendTx(a.tenantId, c => logAccessInTx(c, a, entries));
}
function identifierHash(key: string, tenant: string, email: unknown, phone: unknown) {
  const e = normalEmail(email), p = normalPhone(phone);
  return e ? subjectHash(key, tenant, 'email', e) : p.length >= 6 ? subjectHash(key, tenant, 'phone', p) : null;
}

// ---------- who the customer is ----------
export type Subject = { clients: Row[]; orders: Row[]; emails: string[]; phones: string[]; hash: string; hashes: string[] };
const PHONE_SQL = (col: string) => `right(regexp_replace(coalesce(${col},''),'\\D','','g'),9)`;

/** Customer by CRM id, e-mail or phone: matching CRM profiles, the orders with that e-mail or
 * phone and the orders linked to the profiles. 404 when nothing matches. */
export async function resolveSubjectInTx(c: PoolClient, a: RodoActor, input: SubjectInput, key: string): Promise<Subject> {
  let clients: Row[];
  if ('crm_client_id' in input) clients = (await c.query('SELECT * FROM crm_clients WHERE id=$1', [input.crm_client_id])).rows;
  else if ('email' in input) clients = (await c.query("SELECT * FROM crm_clients WHERE lower(trim(profile->>'email'))=$1 ORDER BY created_at,id", [input.email])).rows;
  else clients = (await c.query(`SELECT * FROM crm_clients WHERE ${PHONE_SQL("profile->>'phone'")}=$1 ORDER BY created_at,id`, [input.phone])).rows;
  ensure('crm_client_id' in input ? clients.length === 1 : true, 404, 'Nie znaleziono klienta CRM');
  const emails = new Set<string>(), phones = new Set<string>();
  if ('email' in input) emails.add(input.email);
  if ('phone' in input) phones.add(input.phone);
  for (const cl of clients) { const e = normalEmail(cl.profile?.email), p = normalPhone(cl.profile?.phone); if (e) emails.add(e); if (p.length >= 6) phones.add(p); }
  const orders = (await c.query(`SELECT o.* FROM orders o WHERE (lower(trim(o.email))=ANY($1::text[]) OR ${PHONE_SQL("o.address->>'phone'")}=ANY($2::text[])
      OR o.id IN (SELECT order_id FROM crm_order_links WHERE client_id=ANY($3::uuid[]))) ORDER BY o.created_at,o.id`,
    [[...emails], [...phones], clients.map(x => x.id)])).rows;
  ensure(clients.length || orders.length, 404, 'Nie znaleziono klienta o podanych danych');
  return subjectOf(a, key, clients, orders, emails, phones, input);
}
/** The same customer again from the ids stored with an anonymisation request. */
export async function subjectFromIdsInTx(c: PoolClient, a: RodoActor, key: string, hash: string, clientIds: string[], orderIds: string[]): Promise<Subject> {
  const clients = (await c.query('SELECT * FROM crm_clients WHERE id=ANY($1::uuid[]) ORDER BY created_at,id', [clientIds])).rows;
  const orders = (await c.query('SELECT * FROM orders WHERE id=ANY($1::uuid[]) ORDER BY created_at,id', [orderIds])).rows;
  ensure(clients.length === clientIds.length && orders.length === orderIds.length, 409, 'Dane wniosku RODO nie odpowiadają już kartotece — wygeneruj podgląd ponownie');
  const emails = new Set<string>(), phones = new Set<string>();
  for (const x of [...clients.map(cl => cl.profile ?? {}), ...orders.map(o => ({ email: o.email, phone: o.address?.phone }))]) {
    const e = normalEmail(x.email), p = normalPhone(x.phone); if (e && !isAnonEmail(e)) emails.add(e); if (p.length >= 6) phones.add(p);
  }
  const s = subjectOf(a, key, clients, orders, emails, phones, null);
  return { ...s, hash };
}
function subjectOf(a: RodoActor, key: string, clients: Row[], orders: Row[], emails: Set<string>, phones: Set<string>, input: SubjectInput | null): Subject {
  const hashes = [...[...emails].map(e => subjectHash(key, a.tenantId, 'email', e)), ...[...phones].map(p => subjectHash(key, a.tenantId, 'phone', p)), ...clients.map(cl => subjectHash(key, a.tenantId, 'crm', cl.id))];
  const first = input && 'email' in input ? subjectHash(key, a.tenantId, 'email', input.email) : input && 'phone' in input ? subjectHash(key, a.tenantId, 'phone', input.phone) : hashes[0]!;
  return { clients, orders, emails: [...emails], phones: [...phones], hash: first, hashes: [...new Set(hashes)] };
}
const registerEntries = (s: Subject, action: AccessEntry['action'], purpose: string, resource: string, detail: Record<string, unknown> = {}): AccessEntry[] =>
  s.clients.length
    ? s.clients.map(cl => ({ action, purpose, resource, crm_client_id: cl.id, subject_hash: s.hash, order_count: s.orders.length, detail }))
    : [{ action, purpose, resource, subject_hash: s.hash, order_count: s.orders.length, detail }];

// ---------- export (art. 15 and 20) ----------
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? null);
/** Everything the shop keeps about the customer, as data. */
export async function exportBundleInTx(c: PoolClient, a: RodoActor, s: Subject, key: string, now: Date) {
  const ids = s.orders.map(o => o.id), clientIds = s.clients.map(x => x.id), q = async (sql: string, p: unknown[]) => (await c.query(sql, p)).rows;
  const values = await q(`SELECT v.client_id,f.name,v.editor_type,v.value FROM crm_values v JOIN crm_extra_fields f ON (f.tenant_id,f.id)=(v.tenant_id,v.field_id) WHERE v.client_id=ANY($1::uuid[]) ORDER BY f.position,f.id`, [clientIds]);
  const files = await q('SELECT client_id,title,mime_type,byte_count,created_at FROM crm_files WHERE client_id=ANY($1::uuid[]) ORDER BY created_at,id', [clientIds]);
  const items = await q('SELECT order_id,name,sku,quantity,price,vat,line_total FROM order_items WHERE order_id=ANY($1::uuid[]) ORDER BY order_id,id', [ids]);
  const shipments = await q('SELECT order_id,carrier,tracking_number,status,created_at,dispatched_at FROM shipments WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id', [ids]);
  const documents = await q(`SELECT 'documents' AS source,id,order_id,kind,mode,number,data,created_at FROM documents WHERE order_id=ANY($1::uuid[])
    UNION ALL SELECT 'return_credit206_documents',id,order_id,kind,mode,number,data,created_at FROM return_credit206_documents WHERE order_id=ANY($1::uuid[])
    UNION ALL SELECT 'local_consumer_credit_documents',id,order_id,kind,mode,number,data,created_at FROM local_consumer_credit_documents WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id`, [ids]);
  const returns = await q('SELECT id,order_id,number,kind,state,remedy,reason,decision_note,refund_amount,created_at,received_at,refunded_at FROM return_cases WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id', [ids]);
  const returnItems = await q('SELECT return_id,sku,name,requested,accepted,refund_amount FROM return_items WHERE order_id=ANY($1::uuid[]) ORDER BY return_id,sku', [ids]);
  const messages = await q('SELECT order_id,kind,body,created_at FROM customer_messages WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id', [ids]);
  // A team e-mail of an automation (snapshot.team_user_id) went to staff: its content is about the customer, the address is not.
  const emails = await q(`SELECT order_id,CASE WHEN snapshot ? 'team_user_id' THEN 'zespół sprzedawcy' ELSE payload->>'recipient' END AS recipient,payload->>'subject' AS subject,payload->>'text' AS text,state,created_at FROM email_messages WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id`, [ids]);
  const sms = await q('SELECT order_id,recipient,payload AS text,state,created_at FROM sms_messages WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id', [ids]);
  const payments = await q('SELECT order_id,kind,amount,currency,method,reference,note,created_at FROM payment_entries WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id', [ids]);
  // Uwagi v3 §6: history of section edits with the values before and after (and the invoice data kept there).
  const history = await q('SELECT order_id,kind,detail,created_at FROM order_events WHERE order_id=ANY($1::uuid[]) AND kind=ANY($2::text[]) ORDER BY created_at,id', [ids, HISTORY_VALUE_KINDS]);
  // 243: purchase invoices where the customer (a CRM invoice NIP) is the seller.
  const purchases = await purchaseInvoicesOfSellersInTx(c, subjectNips(s.clients));
  const register = await q(`SELECT accessed_at,action,purpose,channel FROM rodo228_access_log WHERE subject_hash=ANY($1::text[]) OR crm_client_id=ANY($2::uuid[])
    OR (action='list' AND detail->'crm_client_ids' ?| $2::text[]) ORDER BY accessed_at DESC,id LIMIT 500`, [s.hashes, clientIds]);
  const number = new Map(s.orders.map(o => [o.id, o.number]));
  const delivery = new Map<string, unknown>();
  for (const o of s.orders) { const e: any = await effectiveDeliveryInTx(c, a.tenantId, o.id, key); if (e?.origin === 'override' && e.delivery) delivery.set(o.id, e.delivery); }
  const addresses = new Map<string, Row>();
  const addAddress = (source: string, v: Row | null | undefined) => { if (!v) return; const k = canonical(v); if (!addresses.has(k)) addresses.set(k, { source, ...v }); };
  for (const o of s.orders) { addAddress('zamówienie ' + o.number, { name: o.customer_name, ...o.address }); addAddress('adres dostawy zamówienia ' + o.number, delivery.get(o.id) as Row | undefined); }
  for (const cl of s.clients) {
    const p = cl.profile ?? {};
    if (p.invoice_address || p.invoice_city) addAddress('CRM — dane do faktury', { name: p.invoice_fullname, company: p.invoice_company, street: p.invoice_address, postal_code: p.invoice_postcode, city: p.invoice_city, country: p.invoice_country_code, tax_id: p.invoice_tax_id });
    if (p.delivery_address || p.delivery_city) addAddress('CRM — dane dostawy', { name: p.delivery_fullname, company: p.delivery_company, street: p.delivery_address, postal_code: p.delivery_postcode, city: p.delivery_city, country: p.delivery_country_code });
  }
  const consentField = (n: string) => /zgod|consent/i.test(n);
  return {
    informacje: { wygenerowano: now.toISOString(), podstawa: 'art. 15 i art. 20 RODO', administrator_kopii: 'DYNAMINDS (instalacja lokalna)', klienci_crm: s.clients.length, zamowienia: s.orders.length,
      uwagi: 'Faktury podano jako dane (bez plików). Załączniki CRM podano jako opis pliku; treść wydaje administrator na żądanie.' },
    klienci_crm: s.clients.map(cl => ({ id: cl.id, utworzono: day(cl.created_at), usunieto: day(cl.deleted_at), profil: cl.profile,
      dodatkowe_pola: values.filter(v => v.client_id === cl.id).map(v => ({ pole: v.name, typ: v.editor_type, wartosc: v.value })),
      zalaczniki: files.filter(f => f.client_id === cl.id).map(f => ({ nazwa: f.title, typ: f.mime_type, bajty: f.byte_count, dodano: day(f.created_at) })) })),
    zgody: values.filter(v => consentField(v.name)).map(v => ({ id: v.client_id, pole: v.name, wartosc: v.value })),
    zamowienia: s.orders.map(o => ({ id: o.id, numer: o.number, zrodlo: o.source, status: o.status, utworzono: day(o.created_at), klient: o.customer_name, email: o.email, adres: o.address,
      adres_dostawy: delivery.get(o.id) ?? null, uwagi: o.note, waluta: o.currency, wartosc_grosze: o.total, wysylka_grosze: o.shipping_cost, platnosc: o.payment_mode,
      pozycje: items.filter(i => i.order_id === o.id).map(({ order_id, ...i }) => i),
      dane_do_faktury: history.filter(h => h.order_id === o.id && h.detail?.section === 'invoice' && h.detail?.values).at(-1)?.detail.values ?? null,
      historia_zmian: history.filter(h => h.order_id === o.id && Array.isArray(h.detail?.changes)).flatMap(h => h.detail.changes.map((x: Row) => ({
        data: day(h.created_at), sekcja: h.detail.section ?? 'customer', pole: x.label ?? x.field, przed: x.before, po: x.after, autor: h.detail.actor_name ?? null }))),
      przesylki: shipments.filter(x => x.order_id === o.id).map(({ order_id, ...x }) => ({ ...x, created_at: day(x.created_at), dispatched_at: day(x.dispatched_at) })) })),
    adresy: [...addresses.values()],
    faktury: documents.map(d => ({ id: d.id, zamowienie: number.get(d.order_id) ?? null, rodzaj: d.kind, tryb: d.mode, numer: d.number, utworzono: day(d.created_at),
      data_wystawienia: d.data?.issue_date ?? null, data_sprzedazy: d.data?.sell_date ?? d.data?.sale_date ?? null,
      nabywca: d.data?.buyer ?? d.data?.fiscal_snapshot?.buyer ?? d.data?.original_document?.data?.buyer ?? { nazwa: d.data?.customer ?? null, email: d.data?.email ?? null, adres: d.data?.address ?? null },
      sumy: d.data?.totals ?? (d.data?.total !== undefined ? { brutto_grosze: d.data.total } : null), waluta: d.data?.currency ?? null })),
    zwroty: returns.map(r => ({ ...r, zamowienie: number.get(r.order_id) ?? null, created_at: day(r.created_at), received_at: day(r.received_at), refunded_at: day(r.refunded_at),
      pozycje: returnItems.filter(i => i.return_id === r.id).map(({ return_id, ...i }) => i) })),
    wiadomosci: [...messages.map(m => ({ kanal: 'portal', zamowienie: number.get(m.order_id) ?? null, rodzaj: m.kind, tresc: m.body, data: day(m.created_at) })),
      ...emails.map(m => ({ kanal: 'email', zamowienie: number.get(m.order_id) ?? null, odbiorca: m.recipient, temat: m.subject, tresc: m.text, stan: m.state, data: day(m.created_at) })),
      ...sms.map(m => ({ kanal: 'sms', zamowienie: number.get(m.order_id) ?? null, odbiorca: m.recipient, tresc: m.text, stan: m.state, data: day(m.created_at) }))],
    platnosci: payments.map(p => ({ ...p, zamowienie: number.get(p.order_id) ?? null, order_id: undefined, created_at: day(p.created_at) })),
    rejestr_dostepu: register.map(r => ({ data: day(r.accessed_at), czynnosc: r.action, cel: r.purpose, kanal: r.channel })),
    ...(purchases.length ? { faktury_zakupowe_ksef: purchases.map(p => ({ numer_ksef: p.ksef_number, numer: p.invoice_number, rodzaj: p.fa3_kind, data_wystawienia: p.issue_date,
      sprzedawca_nip: p.seller_nip, sprzedawca: p.seller_name, nabywca_nip: p.buyer_nip, waluta: p.currency, brutto_grosze: p.gross_total, przechowywana_do: p.retain_until })) } : {}),
  };
}
export function exportArchive(bundle: Record<string, unknown>, now: Date) {
  const json = Buffer.from(JSON.stringify(bundle, null, 2) + '\n', 'utf8'), csv = Buffer.from(exportCsv(bundle), 'utf8');
  return zipStore([{ name: 'dane-klienta.json', data: json }, { name: 'dane-klienta.csv', data: csv }], now);
}

// ---------- anonymisation (art. 17) ----------
export type PlanItem = { table: string; row: string; order_id?: string; fields: string[] };
export type KeptItem = PlanItem & { basis: KeepBasis; legal_basis: string; retention_end: string; due_on: string; reason: string };
export type Plan = { today: string; crm_client_ids: string[]; orders: { id: string; number: string; tax_retention_end: string | null }[]; anonymise: PlanItem[]; keep: KeptItem[] };

/** Read-only checks for open business: unfinished orders, open returns, money not settled. */
export async function blockersInTx(c: PoolClient, s: Subject): Promise<Blockers> {
  const ids = s.orders.map(o => o.id);
  const openOrders = s.orders.filter(o => !(CLOSED_ORDER_STATUSES as readonly string[]).includes(o.status)).map(o => ({ number: o.number, status: o.status }));
  const openReturns = (await c.query('SELECT number,state FROM return_cases WHERE order_id=ANY($1::uuid[]) AND state=ANY($2::text[]) ORDER BY created_at,id', [ids, OPEN_RETURN_STATES])).rows;
  const unsettled: Blockers['unsettled'] = [];
  for (const o of s.orders) {
    const b: Row = await paymentBalance(c, o.id);
    if (Number(b.amount_due) > 0 || Number(b.overpayment) > 0 || Number(b.courier_due) !== 0)
      unsettled.push({ number: o.number, amount_due: String(b.amount_due), overpayment: String(b.overpayment), courier_due: String(b.courier_due) });
  }
  return { openOrders, openReturns, unsettled };
}

/** Tables whose rows of an order cannot be changed by the application (append-only evidence,
 * receipts, immutable messages), with what personal data they hold. */
const EVIDENCE: { table: string; fields: string[] }[] = [
  { table: 'buyer_address_state', fields: ['delivery_override_encrypted'] },
  { table: 'buyer_address_receipts', fields: ['before_state', 'after_state', 'evidence_encrypted'] },
  { table: 'buyer_address_previews', fields: ['before_state', 'after_state', 'evidence_encrypted'] },
  { table: 'operative_delivery_evidence', fields: ['evidence_encrypted'] },
  { table: 'order_merge_origins', fields: ['header'] },
  { table: 'wms_operations', fields: ['result'] },
  { table: 'shopify_dispatch_evidence', fields: ['receiver'] },
  { table: 'return_destination_admissions', fields: ['before_snapshot'] },
  { table: 'warehouse_wz_issuer_admissions', fields: ['frame', 'source'] },
  { table: 'return_assistant_sessions', fields: ['source'] },
  { table: 'customer_messages', fields: ['body'] },
  { table: 'email_messages', fields: ['payload', 'snapshot'] },
  { table: 'sms_messages', fields: ['recipient', 'payload', 'snapshot'] },
  { table: 'payment_entries', fields: ['reference', 'note', 'request'] },
];
/** Tax documents of an order and the immutable records of their issue (`ref`: the key column when it is not `id`). */
const TAX: { table: string; fields: string[]; ref?: string }[] = [
  { table: 'documents', fields: ['data (nabywca, adres, e-mail)'] },
  { table: 'local_invoice_previews', fields: ['snapshot.buyer'] }, { table: 'local_invoice_receipts', fields: ['snapshot.buyer', 'request'] },
  { table: 'b2b_invoice_previews', fields: ['snapshot'] }, { table: 'b2b_invoice_receipts', fields: ['snapshot', 'request'] },
  { table: 'b2b_credit_previews', fields: ['snapshot'] }, { table: 'b2b_credit_receipts', fields: ['snapshot', 'request'] },
  { table: 'return_credit206_documents', fields: ['data.original_document.data.buyer'] }, { table: 'return_credit206_previews', fields: ['snapshot'] }, { table: 'return_credit206_receipts', fields: ['snapshot'] },
  { table: 'local_consumer_credit_documents', fields: ['data.original_document.data.buyer'] }, { table: 'local_consumer_credit_previews', fields: ['snapshot'] }, { table: 'local_consumer_credit_receipts', fields: ['snapshot'] },
  { table: 'fa3_draft_projects', fields: ['draft.buyer'] }, { table: 'fa3_draft_previews', fields: ['draft.buyer'] },
  { table: 'invoice_plans', fields: ['order_snapshot', 'payload'] },
  // 230 (FV-S): the confirmed preview and the issued record hold the buyer's name, address and NIP / EU VAT ID.
  { table: 'invoice230_previews', fields: ['snapshot.buyer', 'request'] }, { table: 'invoice230_documents', fields: ['buyer_tax_id', 'snapshot.buyer'], ref: 'document_id' },
  // 232 (KOR-S): the confirmed preview and the issued correction repeat the FV-S buyer.
  { table: 'invoice232_previews', fields: ['snapshot.buyer'] }, { table: 'invoice232_corrections', fields: ['data.buyer'] },
  // 233: a fiscal receipt documents the sale (tax point = fiscal date) and may hold the buyer's NIP.
  { table: 'receipt233_receipts', fields: ['buyer_nip', 'snapshot.buyer_nip'] },
];
/** Files of an order's tax documents sent to KSeF (229): the FA(3) XML and the UPO hold the buyer data. */
const KSEF_FILES = { table: 'ksef229_submissions', fields: ['xml', 'upo_xml'] };
const GUARD_CODES = new Set(['P0001', '55000', '42501', '23514', '22023']);
/** One UPDATE in its own savepoint; a guard refusal leaves the row unchanged and returns its message. */
async function guarded(c: PoolClient, sql: string, params: unknown[]): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
  await c.query('SAVEPOINT rodo228');
  try { const r = await c.query(sql, params); await c.query('RELEASE SAVEPOINT rodo228'); return { ok: true, count: r.rowCount ?? 0 }; }
  catch (e: any) {
    await c.query('ROLLBACK TO SAVEPOINT rodo228'); await c.query('RELEASE SAVEPOINT rodo228');
    // Guards are triggers (PL/pgSQL) or a missing grant; a CHECK constraint of the table itself is a bug here.
    const trigger = typeof e?.where === 'string' && e.where.includes('PL/pgSQL function');
    if (!(e?.code === '42501' || (trigger && GUARD_CODES.has(e?.code)))) throw e;
    return { ok: false, reason: String(e.message ?? 'zapis chroniony').slice(0, 300) };
  }
}
const present = async (c: PoolClient, tables: string[]) => {
  const r = await c.query(`SELECT t FROM unnest($1::text[]) t WHERE EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='order_id')`, [tables]);
  return new Set(r.rows.map(x => x.t as string));
};

/** Anonymises the customer in the caller's transaction and returns what was changed and what
 * was kept. The preview runs the same function in a transaction that is rolled back. */
export async function anonymiseInTx(c: PoolClient, s: Subject, today: string): Promise<Plan> {
  assertAnonymisable(await blockersInTx(c, s));
  const ids = s.orders.map(o => o.id);
  const needles = needlesOf([...s.emails, ...s.phones, ...s.orders.flatMap(o => [o.customer_name, o.email, o.address?.street, o.address?.phone, o.note]),
    ...s.clients.flatMap(cl => CRM_PERSONAL_KEYS.map(k => cl.profile?.[k]))]);
  const contactNeedles = needlesOf([...s.emails, ...s.orders.map(o => o.email), ...s.clients.map(cl => cl.profile?.email)]);
  const anonymise: PlanItem[] = [], keep: KeptItem[] = [];
  const kept = (item: PlanItem, basis: KeepBasis, end: string, reason: string) => keep.push({ ...item, basis, legal_basis: LEGAL_BASIS[basis], retention_end: end, due_on: dueOn(end), reason });
  // Tax documents of each order and the end of their retention.
  const taxTables = await present(c, TAX.map(t => t.table)), evidenceTables = await present(c, EVIDENCE.map(t => t.table));
  const ksefPresent = Boolean((await c.query(`SELECT to_regclass('public.${KSEF_FILES.table}') IS NOT NULL AS p`)).rows[0]?.p);
  const docs = (await c.query(`SELECT id,order_id,data,created_at FROM documents WHERE order_id=ANY($1::uuid[]) AND kind IN ('invoice','correction')
    UNION ALL SELECT id,order_id,data,created_at FROM return_credit206_documents WHERE order_id=ANY($1::uuid[])
    UNION ALL SELECT id,order_id,data,created_at FROM local_consumer_credit_documents WHERE order_id=ANY($1::uuid[])`, [ids])).rows;
  if ((await c.query("SELECT to_regclass('public.invoice232_corrections') IS NOT NULL AS p")).rows[0]?.p)
    docs.push(...(await c.query('SELECT id,order_id,data,created_at FROM invoice232_corrections WHERE order_id=ANY($1::uuid[])', [ids])).rows);
  if ((await c.query("SELECT to_regclass('public.receipt233_receipts') IS NOT NULL AS p")).rows[0]?.p)
    docs.push(...(await c.query(`SELECT id,order_id,jsonb_build_object('sell_date',coalesce(to_char(fiscal_date,'YYYY-MM-DD'),snapshot->>'sell_date')) data,created_at FROM receipt233_receipts WHERE order_id=ANY($1::uuid[])`, [ids])).rows);
  const taxEnd = new Map<string, string | null>(s.orders.map(o => [o.id, maxDay(docs.filter(d => d.order_id === o.id).map(d => taxRetentionEnd(documentTaxPoint(d.data, d.created_at))))]));
  const evidenceEnd = (o: Row) => maxDay([taxEnd.get(o.id), evidenceRetentionEnd(warsawDay(new Date(o.created_at)))])!;
  for (const o of s.orders) {
    const end = taxEnd.get(o.id) ?? null, cls = classifyOrderFields(end, today);
    // The order itself.
    const address = { ...(o.address ?? {}) } as Row;
    if (address.phone !== undefined) address.phone = '';
    if (!cls.retained) Object.assign(address, { street: ANON_STREET, city: ANON_STREET, postal_code: ANON_POSTAL });
    const next = { customer_name: cls.retained ? o.customer_name : ANON_NAME, email: anonEmail(o.id), note: '', address,
      source_snapshot: o.source_snapshot === null ? null : scrubJson(o.source_snapshot, needles).value, b2b_snapshot: o.b2b_snapshot === null ? null : scrubJson(o.b2b_snapshot, needles).value };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter(k => canonical(next[k]) !== canonical(o[k]));
    if (changed.length) {
      const r = await guarded(c, 'UPDATE orders SET customer_name=$2,email=$3,note=$4,address=$5::jsonb,source_snapshot=$6::jsonb,b2b_snapshot=$7::jsonb,updated_at=clock_timestamp() WHERE id=$1',
        [o.id, next.customer_name, next.email, next.note, JSON.stringify(next.address), next.source_snapshot === null ? null : JSON.stringify(next.source_snapshot), next.b2b_snapshot === null ? null : JSON.stringify(next.b2b_snapshot)]);
      if (r.ok) anonymise.push({ table: 'orders', row: o.id, order_id: o.id, fields: changed.flatMap(k => k === 'address' ? cls.anonymise.filter(f => f.startsWith('address.')) : [k]) });
      else kept({ table: 'orders', row: o.id, order_id: o.id, fields: [...cls.anonymise, ...cls.keep] }, 'immutable_evidence', evidenceEnd(o), 'Zamówienie jest chronione: ' + r.reason);
    }
    if (cls.retained) kept({ table: 'orders', row: o.id, order_id: o.id, fields: cls.keep }, 'tax_retention', end!, 'Dane nabywcy zamówienia z fakturą w okresie przechowywania');
    // Order snapshots kept by mutable plans and imports; free JSON scrubbed of known values.
    const json: { table: string; cols: string[]; skip?: boolean }[] = [
      { table: 'shipping_plans', cols: ['order_snapshot', 'input', 'payload', 'result'] },
      { table: 'invoice_plans', cols: ['order_snapshot', 'input', 'payload', 'result'], skip: cls.retained },
      { table: 'inbound_orders', cols: ['raw', 'normalized'] },
      { table: 'shipments', cols: ['tracking_data'] },
      { table: 'order_events', cols: ['detail'] },
      { table: 'return_cases', cols: ['request', 'receipt'] },
    ];
    for (const t of json) {
      if (t.skip) continue;
      for (const row of (await c.query(`SELECT id,${t.cols.join(',')}${t.table === 'return_cases' ? ',reason,decision_note' : ''}${t.table === 'order_events' ? ',kind' : ''} FROM ${t.table} WHERE order_id=$1 ORDER BY id`, [o.id])).rows) {
        const set: string[] = [], params: unknown[] = [row.id], fields: string[] = [];
        // Uwagi v3 §6: section edits keep earlier values (an old e-mail is no longer a needle); they are replaced field by field.
        const history = t.table === 'order_events' ? anonymiseHistoryDetail(row.kind, row.detail) : { value: undefined, changed: false };
        if (history.changed) row.detail = history.value;
        for (const col of t.cols) { if (row[col] === null) continue; const v = scrubJson(row[col], needles); if (v.changed || (col === 'detail' && history.changed)) { params.push(JSON.stringify(v.value)); set.push(`${col}=$${params.length}::jsonb`); fields.push(col); } }
        if (t.table === 'return_cases') for (const col of ['reason', 'decision_note']) { const v = scrubJson(row[col], needles); if (v.changed) { params.push(v.value); set.push(`${col}=$${params.length}`); fields.push(col); } }
        if (!set.length) continue;
        const r = await guarded(c, `UPDATE ${t.table} SET ${set.join(',')} WHERE id=$1`, params);
        if (r.ok) anonymise.push({ table: t.table, row: row.id, order_id: o.id, fields });
        else kept({ table: t.table, row: row.id, order_id: o.id, fields }, 'immutable_evidence', evidenceEnd(o), 'Zapis jest chroniony: ' + r.reason);
      }
    }
    // Tax documents and their issue records stay with the buyer data.
    for (const t of TAX) {
      if (!taxTables.has(t.table) || (t.table === 'invoice_plans' && !cls.retained)) continue;
      const rows = (await c.query(`SELECT ${t.ref ?? 'id'}::text AS ref FROM ${t.table} WHERE order_id=$1 ORDER BY 1`, [o.id])).rows;
      for (const r of rows) {
        const own = docs.find(d => d.id === r.ref), docEnd = own ? taxRetentionEnd(documentTaxPoint(own.data, own.created_at)) : end;
        if (docEnd && docEnd >= today) kept({ table: t.table, row: r.ref, order_id: o.id, fields: t.fields }, 'tax_retention', docEnd, 'Dokument podatkowy w okresie przechowywania');
        else kept({ table: t.table, row: r.ref, order_id: o.id, fields: t.fields }, 'immutable_evidence', evidenceEnd(o), 'Niezmienny zapis wystawienia dokumentu');
      }
    }
    if (ksefPresent) {
      const own = docs.filter(d => d.order_id === o.id);
      for (const r of (await c.query(`SELECT id::text AS ref,document_id::text AS doc FROM ${KSEF_FILES.table} WHERE document_id=ANY($1::uuid[]) ORDER BY 1`, [own.map(d => d.id)])).rows) {
        const d = own.find(x => x.id === r.doc)!, docEnd = taxRetentionEnd(documentTaxPoint(d.data, d.created_at));
        if (docEnd >= today) kept({ table: KSEF_FILES.table, row: r.ref, order_id: o.id, fields: KSEF_FILES.fields }, 'tax_retention', docEnd, 'Plik faktury wysłany do KSeF w okresie przechowywania');
        else kept({ table: KSEF_FILES.table, row: r.ref, order_id: o.id, fields: KSEF_FILES.fields }, 'immutable_evidence', evidenceEnd(o), 'Niezmienny zapis wysyłki do KSeF');
      }
    }
    // Immutable evidence of the order.
    for (const t of EVIDENCE) {
      if (!evidenceTables.has(t.table)) continue;
      const keyCol = t.table === 'buyer_address_state' ? 'order_id' : t.table === 'order_merge_origins' ? 'order_id' : t.table === 'shopify_dispatch_evidence' ? 'shipment_id' : t.table === 'return_destination_admissions' ? 'receipt_id' : 'id';
      const extra = t.table === 'buyer_address_state' ? ' AND delivery_override_encrypted IS NOT NULL' : '';
      const cols = t.table === 'payment_entries' ? ',jsonb_build_array(note,reference,request) AS v' : '';
      for (const r of (await c.query(`SELECT ${keyCol}::text AS ref${cols} FROM ${t.table} WHERE order_id=$1${extra} ORDER BY 1`, [o.id])).rows)
        if (t.table !== 'payment_entries' || containsNeedle(r.v, needles)) kept({ table: t.table, row: r.ref, order_id: o.id, fields: t.fields }, 'immutable_evidence', evidenceEnd(o), 'Niezmienny zapis dowodowy — aplikacja nie może go zmienić');
    }
  }
  // Tenant-wide JSON that repeats the customer's order: matched only by e-mail (unique), then scrubbed of all known values.
  if (contactNeedles.length) {
    const patterns = contactNeedles.map(n => '%' + n.replace(/[\\%_]/g, '\\$&') + '%');
    for (const t of [{ table: 'idempotency_keys', key: 'key', col: 'response' }, { table: 'webhook_deliveries', key: 'id', col: 'payload' }, { table: 'audit_events', key: 'id', col: 'detail' }]) {
      for (const row of (await c.query(`SELECT ${t.key}::text AS ref,${t.col} AS v FROM ${t.table} WHERE ${t.col}::text ILIKE ANY($1::text[]) ORDER BY 1`, [patterns])).rows) {
        const v = scrubJson(row.v, needles); if (!v.changed) continue;
        const r = await guarded(c, `UPDATE ${t.table} SET ${t.col}=$2::jsonb WHERE ${t.key}::text=$1`, [row.ref, JSON.stringify(v.value)]);
        if (r.ok) anonymise.push({ table: t.table, row: row.ref, fields: [t.col] });
        else kept({ table: t.table, row: row.ref, fields: [t.col] }, 'immutable_evidence', evidenceRetentionEnd(today), 'Zapis jest chroniony: ' + r.reason);
      }
    }
  }
  // 243: purchase invoices where the customer is the seller stay for the tax retention; the purge removes them after it.
  for (const p of await purchaseInvoicesOfSellersInTx(c, subjectNips(s.clients)))
    kept({ table: 'ksef243_purchase_invoices', row: p.id, fields: ['seller_name', 'xml'] }, 'tax_retention', p.retain_until,
      p.legal_hold ? 'Faktura zakupowa z KSeF objęta wstrzymaniem usunięcia' : 'Faktura zakupowa z KSeF (klient jako sprzedawca) w okresie przechowywania; usuwana automatycznie po terminie');
  // CRM: the profile, its extra values (consents, notes, attachments' links); journal and files stay.
  for (const cl of s.clients) {
    const profile = { ...(cl.profile ?? {}) } as Row, fields = CRM_PERSONAL_KEYS.filter(k => typeof profile[k] === 'string' && profile[k] !== '');
    for (const k of fields) profile[k] = '';
    if (fields.length) {
      await c.query('UPDATE crm_clients SET profile=$2::jsonb,version=version+1,updated_at=clock_timestamp() WHERE id=$1', [cl.id, JSON.stringify(profile)]);
      anonymise.push({ table: 'crm_clients', row: cl.id, fields: fields.map(f => 'profile.' + f) });
    }
    const values = (await c.query('DELETE FROM crm_values WHERE client_id=$1 RETURNING field_id::text f', [cl.id])).rows.map(r => r.f as string).sort();
    if (values.length) anonymise.push({ table: 'crm_values', row: cl.id, fields: values.map(f => 'field:' + f) });
    const end = evidenceRetentionEnd(warsawDay(new Date(cl.updated_at ?? cl.created_at)));
    for (const f of (await c.query('SELECT id::text ref FROM crm_files WHERE client_id=$1 ORDER BY id', [cl.id])).rows)
      kept({ table: 'crm_files', row: f.ref, fields: ['title', 'encrypted_bytes'] }, 'immutable_evidence', end, 'Plik CRM jest niezmienny; po anonimizacji nie jest już dostępny z karty klienta');
    for (const j of (await c.query(`SELECT client_key::text ref FROM crm_commands WHERE request->>'path' LIKE $1 OR response->'data'->>'id'=$2 ORDER BY 1`, ['%/' + cl.id + '%', cl.id])).rows)
      kept({ table: 'crm_commands', row: j.ref, fields: ['request', 'response'] }, 'immutable_evidence', end, 'Dziennik poleceń CRM jest niezmienny (potwierdzenia powtórzeń)');
  }
  return { today, crm_client_ids: s.clients.map(x => x.id), orders: s.orders.map(o => ({ id: o.id, number: o.number, tax_retention_end: taxEnd.get(o.id) ?? null })), anonymise, keep };
}
export const planSha = (p: Plan) => createHash('sha256').update(canonical(p)).digest('hex');

class DryRun extends Error { constructor(public plan: Plan) { super('dry run'); } }
export type RodoOptions = { key: string; now?: () => Date };
const todayOf = (o: RodoOptions) => warsawDay((o.now ?? (() => new Date()))());

export async function exportCustomer(a: RodoActor, input: SubjectInput, purpose: string, o: RodoOptions) {
  const now = (o.now ?? (() => new Date()))();
  return tenantTx(a.tenantId, async c => {
    const s = await resolveSubjectInTx(c, a, input, o.key), bundle = await exportBundleInTx(c, a, s, o.key, now);
    await logAccessInTx(c, a, registerEntries(s, 'export', purpose, 'GET /api/rodo228/export', { format: 'zip(json,csv)' }));
    return { archive: exportArchive(bundle, now), orders: s.orders.length, clients: s.clients.length };
  });
}
export async function previewAnonymisation(a: RodoActor, input: SubjectInput, o: RodoOptions) {
  const today = todayOf(o);
  let subject: Subject | undefined, plan: Plan | undefined;
  try { await tenantTx(a.tenantId, async c => { subject = await resolveSubjectInTx(c, a, input, o.key); throw new DryRun(await anonymiseInTx(c, subject, today)); }); }
  catch (e) { if (e instanceof DryRun) plan = e.plan; else { if (e instanceof Problem && e.status === 409 && subject) await refusal(a, subject); throw e; } }
  const id = randomUUID(), sha = planSha(plan!), s = subject!;
  await tenantTx(a.tenantId, async c => {
    await c.query(`INSERT INTO rodo228_requests(id,tenant_id,subject_hash,crm_client_ids,order_ids,state,plan,plan_sha256,requested_by) VALUES($1,$2,$3,$4,$5,'previewed',$6::jsonb,$7,$8)`,
      [id, a.tenantId, s.hash, s.clients.map(x => x.id), s.orders.map(x => x.id), JSON.stringify(plan), sha, a.userId]);
    await logAccessInTx(c, a, registerEntries(s, 'anonymisation_preview', 'Podgląd anonimizacji (art. 17 RODO)', 'POST /api/rodo228/anonymisation/preview', { request_id: id }));
  });
  return { request_id: id, state: 'previewed' as const, plan_sha256: sha, plan: plan! };
}
async function refusal(a: RodoActor, s: Subject) {
  await tenantTx(a.tenantId, c => logAccessInTx(c, a, registerEntries(s, 'anonymisation_preview', 'Odmowa anonimizacji — otwarte sprawy klienta', 'POST /api/rodo228/anonymisation/preview', { refused: true })));
}
export async function confirmAnonymisation(a: RodoActor, requestId: string, sha: string, o: RodoOptions) {
  return tenantTx(a.tenantId, async c => {
    const r = (await c.query('SELECT * FROM rodo228_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0];
    ensure(r, 404, 'Nie znaleziono wniosku o anonimizację');
    ensure(r.plan_sha256 === sha, 409, 'Potwierdzenie dotyczy innego podglądu — wygeneruj podgląd ponownie');
    if (r.state === 'completed') return { request_id: r.id, state: 'completed' as const, replayed: true, result: r.result };
    const s = await subjectFromIdsInTx(c, a, o.key, r.subject_hash, r.crm_client_ids, r.order_ids);
    const plan = await anonymiseInTx(c, s, todayOf(o));
    ensure(planSha(plan) === r.plan_sha256, 409, 'Dane klienta zmieniły się od podglądu — wygeneruj podgląd ponownie');
    const result = { anonymised: plan.anonymise.length, kept: plan.keep.length, completed_on: plan.today };
    let n = 0;
    for (const k of plan.keep)
      await c.query(`INSERT INTO rodo228_retained(tenant_id,request_id,item_no,source_table,row_ref,order_id,fields,basis,legal_basis,retention_end,due_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [a.tenantId, r.id, ++n, k.table, k.row, k.order_id ?? null, k.fields, k.basis, k.legal_basis, k.retention_end, k.due_on]);
    await c.query("UPDATE rodo228_requests SET state='completed',result=$2::jsonb,completed_by=$3,completed_at=clock_timestamp() WHERE id=$1", [r.id, JSON.stringify(result), a.userId]);
    await logAccessInTx(c, a, registerEntries(s, 'anonymisation', 'Anonimizacja danych klienta (art. 17 RODO)', 'POST /api/rodo228/anonymisation/:id/confirm', { request_id: r.id, ...result }));
    return { request_id: r.id, state: 'completed' as const, replayed: false, result };
  });
}

// ---------- register, requests, kept fields, settings ----------
export const accessQuery = z.strictObject({
  crm_client_id: z.uuid().optional(), email: z.string().trim().toLowerCase().pipe(z.email('Nieprawidłowy adres e-mail')).optional(),
  phone: z.string().trim().max(40).optional(), action: z.enum(['read', 'list', 'export', 'anonymisation_preview', 'anonymisation']).optional(),
  actor_id: z.uuid().optional(), from: z.iso.date().optional(), to: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/).optional(),
});
export async function listAccessLogInTx(c: PoolClient, a: RodoActor, raw: unknown, key: string) {
  const q = accessQuery.parse(raw), p: unknown[] = [], w: string[] = [];
  const add = (cond: string, v: unknown) => { p.push(v); w.push(cond.replaceAll('$?', '$' + p.length)); };
  // List rows name their clients in detail.crm_client_ids; an e-mail or phone reaches them through the CRM profiles that carry it.
  const listed = (ids: string) => `(l.action='list' AND l.detail->'crm_client_ids' ?| ${ids})`;
  const subject = (hash: string, profileSql: string, value: string) => {
    p.push(hash, value); w.push(`(l.subject_hash=$${p.length - 1} OR ${listed(`ARRAY(SELECT id::text FROM crm_clients WHERE ${profileSql}=$${p.length})`)})`);
  };
  if (q.crm_client_id) add(`(l.crm_client_id=$?::uuid OR ${listed('ARRAY[$?::text]')})`, q.crm_client_id);
  if (q.email) subject(subjectHash(key, a.tenantId, 'email', q.email), "lower(trim(profile->>'email'))", q.email);
  if (q.phone) { const n = normalPhone(q.phone); ensure(n.length >= 6, 422, 'Nieprawidłowy numer telefonu'); subject(subjectHash(key, a.tenantId, 'phone', n), PHONE_SQL("profile->>'phone'"), n); }
  if (q.action) add('l.action=$?', q.action);
  if (q.actor_id) add('l.actor_id=$?', q.actor_id);
  if (q.from) add("l.accessed_at>=($?::date::timestamp AT TIME ZONE 'Europe/Warsaw')", q.from);
  if (q.to) add("l.accessed_at<(($?::date+1)::timestamp AT TIME ZONE 'Europe/Warsaw')", q.to);
  if (q.before) { const [t, id] = q.before.split('|'); p.push(t, id); w.push(`(l.accessed_at,l.id)<($${p.length - 1}::timestamptz,$${p.length}::uuid)`); }
  p.push(q.limit + 1);
  const rows = (await c.query(`SELECT l.id,l.accessed_at,to_char(l.accessed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time,l.actor_id,l.api_key_id,l.channel,l.action,l.purpose,l.resource,l.crm_client_id,l.order_count,l.detail
    FROM rodo228_access_log l ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY l.accessed_at DESC,l.id DESC LIMIT $${p.length}`, p)).rows;
  const page = rows.slice(0, q.limit), last = page.at(-1);
  return { data: page.map(({ cursor_time, ...r }) => r), next: rows.length > q.limit && last ? last.cursor_time + '|' + last.id : null };
}
/** Names of the people and keys in a register page (users are outside tenant scope). */
export async function actorNames(pool: Pool, tenantId: string, userIds: string[], keyIds: string[]) {
  const users = (await pool.query('SELECT u.id,u.email,u.name FROM users u JOIN memberships m ON m.user_id=u.id AND m.tenant_id=$1 WHERE u.id=ANY($2::uuid[])', [tenantId, userIds])).rows;
  const keys = (await pool.query('SELECT id,name,prefix FROM api_keys WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [tenantId, keyIds])).rows;
  return { users: Object.fromEntries(users.map(u => [u.id, u.name || u.email])), keys: Object.fromEntries(keys.map(k => [k.id, k.name + ' (' + k.prefix + '…)'])) };
}
export async function listRequestsInTx(c: PoolClient) {
  return (await c.query(`SELECT id,state,crm_client_ids,cardinality(order_ids) orders,plan_sha256,result,requested_by,requested_at,completed_by,completed_at,
    jsonb_array_length(plan->'anonymise') anonymise_count,jsonb_array_length(plan->'keep') keep_count FROM rodo228_requests ORDER BY requested_at DESC,id DESC LIMIT 100`)).rows;
}
export async function listRetainedInTx(c: PoolClient, today: string, onlyDue: boolean) {
  const rows = (await c.query(`SELECT r.request_id,r.item_no,r.source_table,r.row_ref,r.order_id,o.number order_number,r.fields,r.basis,r.legal_basis,
    to_char(r.retention_end,'YYYY-MM-DD') retention_end,to_char(r.due_on,'YYYY-MM-DD') due_on,r.completed_at
    FROM rodo228_retained r LEFT JOIN orders o ON o.id=r.order_id WHERE r.completed_at IS NULL AND ($1::boolean IS FALSE OR r.due_on<=$2::date)
    ORDER BY r.due_on,r.request_id,r.item_no LIMIT 500`, [onlyDue, today])).rows;
  return rows.map(r => ({ ...r, overdue: r.due_on <= today }));
}
export const settingsInput = z.strictObject({ access_log_retention_days: z.number().int().min(180, 'Najkrótsza retencja rejestru to 180 dni').max(3650, 'Najdłuższa retencja rejestru to 3650 dni') });
export async function settingsInTx(c: PoolClient) {
  return { access_log_retention_days: Number((await c.query('SELECT access_log_retention_days d FROM rodo228_settings')).rows[0]?.d ?? 1825) };
}
export async function saveSettingsInTx(c: PoolClient, a: RodoActor, raw: unknown) {
  const b = settingsInput.parse(raw);
  await c.query(`INSERT INTO rodo228_settings(tenant_id,access_log_retention_days,actor_id) VALUES($1,$2,$3)
    ON CONFLICT(tenant_id) DO UPDATE SET access_log_retention_days=EXCLUDED.access_log_retention_days,actor_id=EXCLUDED.actor_id,updated_at=clock_timestamp()`, [a.tenantId, b.access_log_retention_days, a.userId]);
  return settingsInTx(c);
}
export async function purgeAccessLogInTx(c: PoolClient) {
  return Number((await c.query('SELECT public.rodo228_purge_access_log() n')).rows[0].n);
}
