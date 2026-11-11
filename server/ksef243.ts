/** Migration 243: purchase invoices received in KSeF by the company's NIP (docs/parity/KSEF-PURCHASE243-20261027.md).
 * - Settings per NIP (administrator): on/off, the date axis and the start; the NIP's 229 KSeF settings are required
 *   and reused (the secret is decrypted only for a run and never stored by 243).
 * - A fetch run (job `ksef.purchase.fetch` or "Pobierz teraz") claims the NIP's lease, calls KSeF outside any
 *   transaction (syncPurchaseInvoices) and stores every page in one transaction: invoices (ON CONFLICT on the KSeF
 *   number), rates, KOR references and their links both ways, refused files without content, the checkpoint —
 *   written only under the exact lease, which is renewed on each page — and an event. A crash leaves the last
 *   stored checkpoint, so the next run repeats the page: no gap, no duplicate. The run is bounded by a budget below
 *   the 2-minute reaper of running jobs; an unfinished run is continued by the next job.
 * - The list with filters, the detail (rates, KOR chain), the FA(3) file, the workflow (status, accounting number,
 *   note, legal hold) and the accountant's package (CSV + files), refused files and their retry. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { tenantAppendTx, tenantReadTx, tenantTx } from './db';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { decrypt } from './security';
import { KsefRefusedError, KsefUnavailableError, type KsefCredentials, type KsefEnvironment } from './ksef229-client';
import type { KsefSecret } from './ksef229-model';
import type { KsefActor } from './ksef229';
import { KsefPurchaseClient, KsefRateLimitedError, syncPurchaseInvoices, type FetchedPurchaseInvoice, type KsefPurchaseClientOptions, type PurchaseReject } from './ksef-purchase-client';
import { KsefPurchaseDataError, initialPurchaseCheckpoint, parsePurchaseCheckpoint, parsePurchaseMetadata, type PurchaseCheckpoint } from './ksef-purchase-model';
import { zipStore } from './rodo228-model';
import {
  KSEF_PURCHASE_FETCH_JOB, PURCHASE_EXPORT_LIMITS, PURCHASE_RUN, PURCHASE_STATUS_LABELS, encodePurchaseCursor, purchaseCsv, purchaseListWhere, purchaseRetainUntil,
  purchaseStatusChange, relinkPurchaseCorrections, storedPurchaseMeta, type OpenCorrection, type PurchaseCsvRow, type PurchaseInvoicePatch, type PurchaseListQuery, type PurchaseRunOutcome,
  type PurchaseStatus, type PurchaseSyncInput,
} from './ksef243-model';

export type PurchaseNetOptions = Pick<KsefPurchaseClientOptions, 'fetch' | 'sleep' | 'timeoutMs' | 'retry' | 'minIntervalMs' | 'random' | 'now'>;
export type Ksef243Options = {
  net?: PurchaseNetOptions; now?: () => Date; budgetMs?: number; maxPages?: number; pageSize?: number;
  /** Called after each committed page (tests simulate a crash or a lease take-over here). */ afterStore?: (n: number) => void | Promise<void>;
};
export type PurchaseRunResult = { nip: string; outcome: PurchaseRunOutcome; pages: number; stored: number; duplicates: number; rejected: number; done: boolean;
  completed_up_to: string | null; retry_after_ms: number | null; renewed: number; message: string | null };
type Row = Record<string, any>;

export async function ksef243Available(c: Pool | PoolClient): Promise<boolean> {
  return Boolean((await c.query(`SELECT to_regclass('public.ksef243_purchase_invoices') IS NOT NULL AND to_regclass('public.ksef243_purchase_sync') IS NOT NULL
    AND to_regprocedure('public.ksef243_purchase_purge()') IS NOT NULL AS available`)).rows[0]?.available);
}
const short = (s: string, n = 2000) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? null);
const nowOf = (o: Ksef243Options) => (o.now ?? (() => new Date()))();
class LeaseLost extends Error { constructor() { super('Pobieranie faktur zakupowych przejął inny proces'); } }
class BudgetReached extends Error {}

async function event(c: PoolClient, nip: string, kind: string, message: string, detail: Record<string, unknown> = {}, actor: string | null = null) {
  await c.query(`INSERT INTO ksef243_purchase_events(tenant_id,nip,kind,message,detail,actor_id) VALUES(nullif(current_setting('app.tenant_id',true),'')::uuid,$1,$2,$3,$4::jsonb,$5)`,
    [nip, kind, short(message), JSON.stringify(detail), actor]);
}

// ---------- KSeF settings of the NIP (229) ----------
type Cfg = { nip: string; environment: KsefEnvironment; base_url: string | null; auth_method: 'token' | 'certificate'; secret_ciphertext: string; active: boolean };
const noConfig = (nip: string) => `Brak aktywnych ustawień KSeF dla NIP ${nip}. Dodaj je w Ustawienia → KSeF.`;
async function configInTx(c: PoolClient, nip: string): Promise<Cfg | null> {
  return (await c.query('SELECT nip,environment,base_url,auth_method,secret_ciphertext,active FROM ksef229_configs WHERE nip=$1', [nip])).rows[0] ?? null;
}
function credentialsOf(cfg: Cfg): KsefCredentials {
  const s: KsefSecret = decrypt(cfg.secret_ciphertext);
  if (cfg.auth_method === 'token') { ensure(s.token, 409, 'Ustawienia KSeF nie mają tokenu'); return { method: 'token', token: s.token }; }
  ensure(s.certificate_pem && s.private_key_pem, 409, 'Ustawienia KSeF nie mają certyfikatu');
  return { method: 'certificate', certificatePem: s.certificate_pem, privateKeyPem: s.private_key_pem };
}
function clientOf(cfg: Cfg, o: Ksef243Options, deadline: number): KsefPurchaseClient {
  try {
    return new KsefPurchaseClient({ environment: cfg.environment, ...(cfg.base_url ? { baseUrl: cfg.base_url } : {}), nip: cfg.nip, credentials: credentialsOf(cfg), deadline, ...o.net });
  } catch (e) { if (e instanceof Problem) throw e; throw new Problem(409, (e as Error).message); }
}

// ---------- settings ----------
const SYNC_VIEW = `s.nip,s.enabled,s.date_type,s.start_from,s.checkpoint,s.lease_token IS NOT NULL AND s.leased_until>clock_timestamp() AS running,s.last_run_at,s.last_ok_at,s.last_error,
  s.rate_limited_until,s.runs,s.updated_at,
  (SELECT count(*)::int FROM ksef243_purchase_invoices i WHERE i.buyer_nip=s.nip) AS invoices,
  (SELECT count(*)::int FROM ksef243_purchase_invoices i WHERE i.buyer_nip=s.nip AND i.status='new') AS new_invoices,
  (SELECT count(*)::int FROM ksef243_purchase_rejects r WHERE r.buyer_nip=s.nip AND r.resolved_at IS NULL) AS open_rejects,
  (SELECT min(j.run_at) FROM jobs j WHERE j.kind='${KSEF_PURCHASE_FETCH_JOB}' AND j.state='pending' AND j.payload->>'nip'=s.nip) AS next_run_at`;
function syncView(r: Row) {
  const cp = r.checkpoint as PurchaseCheckpoint;
  return { nip: r.nip as string, enabled: r.enabled as boolean, date_type: r.date_type as string, start_from: iso(r.start_from), completed_up_to: cp?.completedUpTo ?? null,
    window_open: Boolean(cp?.window), running: Boolean(r.running), last_run_at: iso(r.last_run_at), last_ok_at: iso(r.last_ok_at), last_error: r.last_error ?? null,
    rate_limited_until: iso(r.rate_limited_until), runs: r.runs as number, invoices: r.invoices as number, new_invoices: r.new_invoices as number, open_rejects: r.open_rejects as number,
    next_run_at: iso(r.next_run_at), updated_at: iso(r.updated_at) };
}
async function syncInTx(c: PoolClient, nip: string) {
  const r = (await c.query(`SELECT ${SYNC_VIEW} FROM ksef243_purchase_sync s WHERE s.nip=$1`, [nip])).rows[0];
  return r ? syncView(r) : null;
}
export async function statusInTx(c: PoolClient) {
  const configs = (await c.query('SELECT nip,environment,active FROM ksef229_configs ORDER BY nip')).rows;
  const syncs = (await c.query(`SELECT ${SYNC_VIEW} FROM ksef243_purchase_sync s ORDER BY s.nip`)).rows.map(syncView);
  const events = (await c.query(`SELECT nip,at,kind,message FROM (SELECT e.*,row_number() OVER (PARTITION BY nip ORDER BY at DESC,id) n FROM ksef243_purchase_events e) x WHERE n<=10 ORDER BY nip,at DESC`)).rows;
  return {
    configs: configs.map(r => ({ nip: r.nip as string, environment: r.environment as string, active: r.active as boolean })),
    syncs: syncs.map(s => ({ ...s, events: events.filter(e => e.nip === s.nip).map(e => ({ at: iso(e.at), kind: e.kind, message: e.message })) })),
  };
}
/** Queues the next fetch of the NIP unless one is pending or running already. */
export async function ensureFetchJobInTx(c: PoolClient, tenantId: string, actorId: string, nip: string, delayMs: number, failures = 0): Promise<boolean> {
  if ((await c.query(`SELECT 1 FROM jobs WHERE kind=$1 AND state IN ('pending','running') AND payload->>'nip'=$2 LIMIT 1`, [KSEF_PURCHASE_FETCH_JOB, nip])).rowCount) return false;
  const id = randomUUID();
  await c.query(`INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,run_at,priority) VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(secs=>$6::double precision),90)`,
    [id, tenantId, KSEF_PURCHASE_FETCH_JOB, JSON.stringify({ nip, actor_id: actorId, failures }), KSEF_PURCHASE_FETCH_JOB + ':' + id, Math.max(0, delayMs) / 1000]);
  return true;
}
/** PUT settings: a new NIP, a changed date axis or start, or an explicit restart start the checkpoint at the start
 * (re-reading is safe: the KSeF number is the dedup key). Refused while a run holds the lease. */
export async function saveSyncInTx(c: PoolClient, a: KsefActor, nip: string, b: PurchaseSyncInput) {
  ensure(await configInTx(c, nip), 409, noConfig(nip));
  const old = (await c.query('SELECT *,lease_token IS NOT NULL AND leased_until>clock_timestamp() AS running FROM ksef243_purchase_sync WHERE nip=$1 FOR UPDATE', [nip])).rows[0] as Row | undefined;
  ensure(!old?.running, 409, 'Pobieranie faktur zakupowych właśnie trwa — zapisz ustawienia za chwilę');
  const reset = !old || b.restart === true || old.date_type !== b.date_type || iso(old.start_from) !== b.start_from;
  const checkpoint = reset ? initialPurchaseCheckpoint(nip, b.start_from, b.date_type) : old!.checkpoint;
  if (old) await c.query(`UPDATE ksef243_purchase_sync SET enabled=$2,date_type=$3,start_from=$4,checkpoint=$5::jsonb,updated_by=$6,updated_at=clock_timestamp() WHERE nip=$1`,
    [nip, b.enabled, b.date_type, b.start_from, JSON.stringify(checkpoint), a.userId]);
  else await c.query(`INSERT INTO ksef243_purchase_sync(tenant_id,nip,enabled,date_type,start_from,checkpoint,created_by,updated_by)
    VALUES(nullif(current_setting('app.tenant_id',true),'')::uuid,$1,$2,$3,$4,$5::jsonb,$6,$6)`, [nip, b.enabled, b.date_type, b.start_from, JSON.stringify(checkpoint), a.userId]);
  await event(c, nip, 'config', `Zapisano ustawienia pobierania faktur zakupowych (${b.enabled ? 'włączone' : 'wyłączone'}, ${b.date_type}, od ${b.start_from})${reset ? '; pobieranie od daty początkowej' : ''}`, {}, a.userId);
  await audit(c, a, 'ksef.purchase.sync_save', null, { nip, enabled: b.enabled, date_type: b.date_type, start_from: b.start_from, restart: reset });
  if (b.enabled) await ensureFetchJobInTx(c, a.tenantId, a.userId, nip, 0);
  return (await syncInTx(c, nip))!;
}

// ---------- storing ----------
const KOR_KINDS = new Set(['KOR', 'KOR_ZAL', 'KOR_ROZ']);
/** Values the table refuses are a reject of that one invoice, never a failed page. */
const saneDay = (d: string | null | undefined) => !d || (d >= '1990-01-01' && d <= '2099-12-31');
function unstorable(inv: FetchedPurchaseInvoice): string | null {
  const p = inv.parsed;
  if (![p.issueDate, p.saleDate, p.salePeriod?.from, p.salePeriod?.to, p.paymentDueDate, ...(p.correction?.corrected.map(r => r.issueDate) ?? [])].every(saneDay))
    return 'Data w pliku faktury jest spoza zakresu 1990–2099';
  if ([...p.seller.name].length > 512) return 'Nazwa sprzedawcy w pliku faktury jest dłuższa niż 512 znaków';
  if ([...(p.correction?.reason ?? '')].length > 1000) return 'Przyczyna korekty jest dłuższa niż 1000 znaków';
  if ((p.correction?.corrected.length ?? 0) > 10000) return 'Korekta wskazuje zbyt wiele faktur korygowanych';
  if (p.correction?.corrected.some(r => [...r.invoiceNumber].length > 256)) return 'Numer faktury korygowanej jest dłuższy niż 256 znaków';
  if (!KOR_KINDS.has(p.kind) && p.correction) return 'Faktura, która nie jest korektą, wskazuje fakturę korygowaną';
  if (inv.xml.length > 3145728) return 'Plik faktury jest większy niż 3 MiB';
  return null;
}
/** Inserts the new invoices with their rates and KOR references and links references both ways. Answers the ids
 * of the new ones, the number already stored and the invoices the table could not take. */
async function persistInTx(c: PoolClient, nip: string, invoices: FetchedPurchaseInvoice[], source: 'query' | 'retry') {
  const fresh: { id: string; inv: FetchedPurchaseInvoice }[] = [], refused: PurchaseReject[] = [];
  let duplicates = 0;
  for (const inv of invoices) {
    const why = unstorable(inv);
    if (why) { refused.push({ ksefNumber: inv.meta.ksefNumber, invoiceHash: inv.meta.invoiceHash, code: 'unstorable', reason: why, meta: inv.meta }); continue; }
    const m = inv.meta, p = inv.parsed;
    const r = await c.query(`INSERT INTO ksef243_purchase_invoices(tenant_id,buyer_nip,ksef_number,seller_nip,seller_name,invoice_number,invoice_type,fa3_kind,issue_date,sale_date,
      sale_period_from,sale_period_to,invoicing_date,acquisition_date,permanent_storage_date,currency,net_total,vat_total,gross_total,split_payment,cash_method,self_invoicing,reverse_charge,
      has_attachment,invoicing_mode,payment_due_date,correction_reason,correction_type,xml,xml_bytes,xml_sha256,invoice_hash,source,retain_until)
      VALUES(nullif(current_setting('app.tenant_id',true),'')::uuid,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
      octet_length($28::bytea),encode(sha256($28::bytea),'hex'),$29,$30,$31) ON CONFLICT (tenant_id,ksef_number) DO NOTHING RETURNING id`,
      [nip, m.ksefNumber, p.seller.nip, p.seller.name, p.invoiceNumber, m.invoiceType, p.kind, p.issueDate, p.saleDate, p.salePeriod?.from ?? null, p.salePeriod?.to ?? null,
        m.invoicingDate, m.acquisitionDate, m.permanentStorageDate, p.currency, p.netTotal, p.vatTotal, p.grossTotal, p.splitPayment, p.cashMethod, p.selfInvoicing || m.isSelfInvoicing,
        p.reverseCharge, m.hasAttachment, m.invoicingMode, p.paymentDueDate, p.correction?.reason ?? null, p.correction?.type ?? null, inv.xml, m.invoiceHash, source, purchaseRetainUntil(p.issueDate)]);
    if (!r.rowCount) { duplicates++; continue; }
    const id = r.rows[0].id as string;
    fresh.push({ id, inv });
    for (const rate of p.rates) await c.query(`INSERT INTO ksef243_purchase_rates(tenant_id,invoice_id,rate_code,net,vat,vat_pln) VALUES(nullif(current_setting('app.tenant_id',true),'')::uuid,$1,$2,$3,$4,$5)`,
      [id, rate.code, rate.net, rate.vat, rate.vatPln]);
    const refs = p.correction?.corrected ?? [];
    if (refs.length) await c.query(`INSERT INTO ksef243_purchase_corrections(tenant_id,correction_id,ordinal,ref_invoice_number,ref_issue_date,ref_ksef_number)
      SELECT nullif(current_setting('app.tenant_id',true),'')::uuid,$1,r.n,r.num,r.day,r.ksef FROM unnest($2::text[],$3::date[],$4::text[]) WITH ORDINALITY AS r(num,day,ksef,n)`,
    [id, refs.map(r => r.invoiceNumber), refs.map(r => r.issueDate), refs.map(r => r.ksefNumber)]);
  }
  if (fresh.length) {
    const ids = fresh.map(f => f.id), numbers = fresh.map(f => f.inv.meta.ksefNumber);
    await c.query('UPDATE ksef243_purchase_rejects SET resolved_at=clock_timestamp() WHERE ksef_number=ANY($1::text[]) AND resolved_at IS NULL', [numbers]);
    await relinkInTx(c, nip, ids, fresh.map(f => f.inv));
  }
  return { fresh, duplicates, refused };
}
/** Open references of the new corrections, and open references elsewhere that point at a new invoice. */
async function relinkInTx(c: PoolClient, nip: string, ids: string[], invoices: FetchedPurchaseInvoice[]) {
  const open = (await c.query(`SELECT c.correction_id,c.ordinal,c.ref_invoice_number,to_char(c.ref_issue_date,'YYYY-MM-DD') ref_issue_date,c.ref_ksef_number,i.seller_nip
    FROM ksef243_purchase_corrections c JOIN ksef243_purchase_invoices i ON i.id=c.correction_id
    WHERE c.resolved_invoice_id IS NULL AND i.buyer_nip=$1 AND (c.correction_id=ANY($2::uuid[]) OR c.ref_ksef_number=ANY($3::text[])
      OR (c.ref_invoice_number,c.ref_issue_date) IN (SELECT * FROM unnest($4::text[],$5::date[])))
    ORDER BY c.correction_id,c.ordinal`, [nip, ids, invoices.map(i => i.meta.ksefNumber), invoices.map(i => i.parsed.invoiceNumber), invoices.map(i => i.parsed.issueDate)])).rows;
  if (!open.length) return;
  const groups = new Map<string, OpenCorrection>();
  for (const r of open) {
    const g: OpenCorrection = groups.get(r.correction_id) ?? { id: r.correction_id, sellerNip: r.seller_nip, refs: [] };
    g.refs.push({ ordinal: r.ordinal, invoiceNumber: r.ref_invoice_number, issueDate: r.ref_issue_date, ksefNumber: r.ref_ksef_number });
    groups.set(r.correction_id, g);
  }
  const known = (await c.query(`SELECT id,ksef_number,seller_nip,invoice_number,to_char(issue_date,'YYYY-MM-DD') issue_date FROM ksef243_purchase_invoices
    WHERE buyer_nip=$1 AND (ksef_number=ANY($2::text[]) OR invoice_number=ANY($3::text[]))`,
  [nip, open.map(r => r.ref_ksef_number).filter(Boolean), open.map(r => r.ref_invoice_number)])).rows
    .map(r => ({ id: r.id, ksefNumber: r.ksef_number, sellerNip: r.seller_nip, invoiceNumber: r.invoice_number, issueDate: r.issue_date }));
  for (const x of relinkPurchaseCorrections([...groups.values()], known))
    await c.query(`UPDATE ksef243_purchase_corrections SET resolved_invoice_id=$3,resolved_by=$4,problem=$5,resolved_at=CASE WHEN $3::uuid IS NULL THEN NULL ELSE clock_timestamp() END
      WHERE correction_id=$1 AND ordinal=$2 AND resolved_invoice_id IS NULL`, [x.correctionId, x.ordinal, x.resolvedInvoiceId, x.by, x.problem]);
}
async function rejectInTx(c: PoolClient, nip: string, r: PurchaseReject) {
  await c.query(`INSERT INTO ksef243_purchase_rejects(tenant_id,ksef_number,buyer_nip,invoice_hash,meta,code,reason)
    SELECT nullif(current_setting('app.tenant_id',true),'')::uuid,$1,$2,$3,$4::jsonb,$5,$6 WHERE NOT EXISTS(SELECT FROM ksef243_purchase_invoices WHERE ksef_number=$1)
    ON CONFLICT (tenant_id,ksef_number) DO UPDATE SET invoice_hash=EXCLUDED.invoice_hash,meta=EXCLUDED.meta,code=EXCLUDED.code,reason=EXCLUDED.reason,
      attempts=least(ksef243_purchase_rejects.attempts+1,100000),last_seen_at=clock_timestamp(),resolved_at=NULL`,
  [r.ksefNumber, nip, r.invoiceHash, JSON.stringify(storedPurchaseMeta(r.meta)), /^[a-z0-9_]{1,40}$/.test(r.code) ? r.code : 'invalid', short(r.reason, 1000)]);
}
/** One page in one transaction, fenced by the lease (renewed here): invoices, rejects, the checkpoint, an event. */
async function storePageInTx(c: PoolClient, nip: string, lease: string, b: { invoices: FetchedPurchaseInvoice[]; rejects: PurchaseReject[]; checkpoint: PurchaseCheckpoint }) {
  const fence = await c.query(`UPDATE ksef243_purchase_sync SET leased_until=clock_timestamp()+make_interval(secs=>$3) WHERE nip=$1 AND lease_token=$2 AND leased_until>clock_timestamp() RETURNING nip`,
    [nip, lease, PURCHASE_RUN.leaseSeconds]);
  if (!fence.rowCount) throw new LeaseLost();
  const { fresh, duplicates, refused } = await persistInTx(c, nip, b.invoices, 'query');
  const rejects = [...b.rejects, ...refused];
  for (const r of rejects) await rejectInTx(c, nip, r);
  const cp = await c.query(`UPDATE ksef243_purchase_sync SET checkpoint=$3::jsonb,leased_until=clock_timestamp()+make_interval(secs=>$4),updated_at=clock_timestamp()
    WHERE nip=$1 AND lease_token=$2 AND leased_until>clock_timestamp()`, [nip, lease, JSON.stringify(b.checkpoint), PURCHASE_RUN.leaseSeconds]);
  if (cp.rowCount !== 1) throw new LeaseLost();
  await event(c, nip, rejects.length ? 'rejected' : 'page', `Strona: ${fresh.length} nowych, ${duplicates} już zapisanych, ${rejects.length} odrzuconych`,
    { stored: fresh.length, duplicates, rejected: rejects.slice(0, 50).map(r => r.ksefNumber), completed_up_to: b.checkpoint.completedUpTo, window: b.checkpoint.window ? b.checkpoint.window.cursorFrom : null });
  return { stored: fresh.length, duplicates, rejected: rejects.length };
}

// ---------- the run ----------
const OUTCOME_EVENT: Record<PurchaseRunOutcome, string> = { ok: 'run', partial: 'run', busy: 'run', disabled: 'run', rate_limited: 'rate_limited', unavailable: 'unavailable', refused: 'refused', error: 'error' };
/** One bounded fetch of a NIP; never throws for KSeF or lease problems (the outcome says what happened). */
export async function runPurchaseFetch(a: KsefActor, nip: string, o: Ksef243Options = {}): Promise<PurchaseRunResult> {
  const started = Date.now(), budget = o.budgetMs ?? PURCHASE_RUN.budgetMs;
  const r: PurchaseRunResult = { nip, outcome: 'ok', pages: 0, stored: 0, duplicates: 0, rejected: 0, done: false, completed_up_to: null, retry_after_ms: null, renewed: 0, message: null };
  const pre = await tenantReadTx(a.tenantId, async c => ({
    s: (await c.query(`SELECT enabled,checkpoint,greatest(0,extract(epoch FROM rate_limited_until-clock_timestamp())*1000)::bigint AS wait FROM ksef243_purchase_sync WHERE nip=$1`, [nip])).rows[0] as Row | undefined,
    cfg: await configInTx(c, nip),
  }));
  ensure(pre.s, 404, 'Pobieranie faktur zakupowych dla tego NIP nie jest skonfigurowane');
  r.completed_up_to = (pre.s.checkpoint as PurchaseCheckpoint).completedUpTo;
  if (!pre.s.enabled) return { ...r, outcome: 'disabled', message: 'Pobieranie faktur zakupowych dla tego NIP jest wyłączone' };
  if (Number(pre.s.wait) > 0) return { ...r, outcome: 'rate_limited', retry_after_ms: Number(pre.s.wait), message: 'KSeF ogranicza liczbę zapytań; pobieranie zostanie wznowione później' };
  const lease = randomUUID();
  const claimed = await tenantTx(a.tenantId, async c => (await c.query(`UPDATE ksef243_purchase_sync SET lease_token=$2,leased_until=clock_timestamp()+make_interval(secs=>$3),
    last_run_at=clock_timestamp(),runs=runs+1,updated_at=clock_timestamp() WHERE nip=$1 AND enabled AND (lease_token IS NULL OR leased_until<clock_timestamp()) RETURNING checkpoint`,
  [nip, lease, PURCHASE_RUN.leaseSeconds])).rows[0] as Row | undefined);
  if (!claimed) return { ...r, outcome: 'busy', message: 'Pobieranie faktur zakupowych dla tego NIP już trwa' };
  let owned = true, client: KsefPurchaseClient | null = null;
  try {
    ensure(pre.cfg?.active, 409, noConfig(nip));
    const checkpoint = parsePurchaseCheckpoint(claimed.checkpoint);
    client = clientOf(pre.cfg!, o, started + budget);
    const res = await syncPurchaseInvoices({ client, checkpoint, maxPages: o.maxPages ?? PURCHASE_RUN.maxPages, pageSize: o.pageSize,
      store: async b => {
        const s = await tenantTx(a.tenantId, c => storePageInTx(c, nip, lease, b));
        r.pages++; r.stored += s.stored; r.duplicates += s.duplicates; r.rejected += s.rejected; r.completed_up_to = b.checkpoint.completedUpTo;
        await o.afterStore?.(r.pages);
        if (Date.now() - started > budget * 0.75) throw new BudgetReached();
        return { duplicates: s.duplicates };
      } });
    r.done = res.done; r.completed_up_to = res.checkpoint.completedUpTo;
    r.outcome = res.done ? 'ok' : 'partial';
  } catch (e) {
    if (e instanceof BudgetReached) r.outcome = 'partial';
    else if (e instanceof LeaseLost) { owned = false; r.outcome = 'busy'; r.message = e.message; }
    else if (e instanceof KsefRateLimitedError) { r.outcome = 'rate_limited'; r.retry_after_ms = e.retryAfterMs ?? 60_000; r.message = e.message; }
    else if (e instanceof KsefUnavailableError) { r.outcome = 'unavailable'; r.message = e.message; }
    else if (e instanceof KsefRefusedError || e instanceof Problem) { r.outcome = 'refused'; r.message = e.message; }
    else if (e instanceof KsefPurchaseDataError) { r.outcome = 'error'; r.message = e.message; }
    else { r.outcome = 'error'; r.message = 'Błąd pobierania faktur zakupowych: ' + short(String((e as Error)?.message ?? e), 300); }
  }
  if (client) r.renewed = client.counters.refreshes + client.counters.renewedAfter401;
  const failed = !['ok', 'partial'].includes(r.outcome);
  await tenantTx(a.tenantId, async c => {
    if (owned) await c.query(`UPDATE ksef243_purchase_sync SET lease_token=NULL,leased_until=NULL,last_ok_at=CASE WHEN $3 THEN clock_timestamp() ELSE last_ok_at END,last_error=$4,
      rate_limited_until=CASE WHEN $5::bigint IS NULL THEN NULL ELSE clock_timestamp()+make_interval(secs=>$5::bigint/1000.0) END,updated_at=clock_timestamp() WHERE nip=$1 AND lease_token=$2`,
    [nip, lease, !failed, failed ? short(r.message ?? r.outcome) : null, r.outcome === 'rate_limited' ? r.retry_after_ms : null]);
    await event(c, nip, OUTCOME_EVENT[r.outcome], failed ? `Pobieranie przerwane: ${r.message ?? r.outcome}` : `Pobrano ${r.stored} nowych faktur (stron ${r.pages}${r.done ? '' : ', ciąg dalszy w następnym przebiegu'})`,
      { outcome: r.outcome, pages: r.pages, stored: r.stored, duplicates: r.duplicates, rejected: r.rejected, completed_up_to: r.completed_up_to, renewed: r.renewed }, a.userId);
    const purged = (await c.query('SELECT ksef243_purchase_purge() AS p')).rows[0].p as { invoices: number; rejects: number; events: number };
    if (purged.invoices || purged.rejects || purged.events) await event(c, nip, 'purge', `Usunięto po terminie przechowywania: ${purged.invoices} faktur, ${purged.rejects} odrzuceń, ${purged.events} wpisów`, purged);
  });
  return r;
}

// ---------- list, detail, file, workflow ----------
const LIST_COLUMNS = `i.id,i.buyer_nip,i.ksef_number,i.seller_nip,i.seller_name,i.invoice_number,i.invoice_type,i.fa3_kind,to_char(i.issue_date,'YYYY-MM-DD') issue_date,
  to_char(i.sale_date,'YYYY-MM-DD') sale_date,i.currency,i.net_total::text,i.vat_total::text,i.gross_total::text,i.split_payment,i.reverse_charge,i.cash_method,i.self_invoicing,
  to_char(i.payment_due_date,'YYYY-MM-DD') payment_due_date,i.status,i.accounting_ref,i.version,i.legal_hold,to_char(i.retain_until,'YYYY-MM-DD') retain_until,i.permanent_storage_date,i.fetched_at`;
function listView(r: Row): Row {
  return { ...r, status_label: PURCHASE_STATUS_LABELS[r.status as PurchaseStatus], permanent_storage_date: iso(r.permanent_storage_date), fetched_at: iso(r.fetched_at) };
}
export async function listInvoicesInTx(c: PoolClient, q: PurchaseListQuery) {
  const w = purchaseListWhere(q);
  const rows = (await c.query(`SELECT ${LIST_COLUMNS},EXISTS(SELECT FROM ksef243_purchase_corrections k WHERE k.resolved_invoice_id=i.id) AS corrected
    FROM ksef243_purchase_invoices i ${w.sql} ORDER BY i.issue_date DESC,i.id DESC LIMIT $${w.params.length + 1}::integer`, [...w.params, q.limit + 1])).rows;
  const more = rows.length > q.limit, items = rows.slice(0, q.limit).map(listView);
  return { items, next: more ? encodePurchaseCursor(items.at(-1)!.issue_date, items.at(-1)!.id) : null };
}
export async function invoiceDetailInTx(c: PoolClient, id: string) {
  const r = (await c.query(`SELECT ${LIST_COLUMNS},to_char(i.sale_period_from,'YYYY-MM-DD') sale_period_from,to_char(i.sale_period_to,'YYYY-MM-DD') sale_period_to,i.invoicing_date,
    i.acquisition_date,i.has_attachment,i.invoicing_mode,i.correction_reason,i.correction_type,i.xml_bytes,i.xml_sha256,i.invoice_hash,i.source,i.status_at,i.note
    FROM ksef243_purchase_invoices i WHERE i.id=$1`, [id])).rows[0];
  ensure(r, 404, 'Nie znaleziono faktury zakupowej');
  const rates = (await c.query('SELECT rate_code,net::text,vat::text,vat_pln::text FROM ksef243_purchase_rates WHERE invoice_id=$1 ORDER BY rate_code', [id])).rows;
  const corrects = (await c.query(`SELECT k.ordinal,k.ref_invoice_number,to_char(k.ref_issue_date,'YYYY-MM-DD') ref_issue_date,k.ref_ksef_number,k.resolved_by,k.problem,
    o.id AS invoice_id,o.ksef_number,o.invoice_number FROM ksef243_purchase_corrections k LEFT JOIN ksef243_purchase_invoices o ON o.id=k.resolved_invoice_id WHERE k.correction_id=$1 ORDER BY k.ordinal`, [id])).rows;
  const correctedBy = (await c.query(`SELECT k.correction_id AS invoice_id,i.ksef_number,i.invoice_number,to_char(i.issue_date,'YYYY-MM-DD') issue_date,i.gross_total::text
    FROM ksef243_purchase_corrections k JOIN ksef243_purchase_invoices i ON i.id=k.correction_id WHERE k.resolved_invoice_id=$1 ORDER BY i.issue_date,i.id`, [id])).rows;
  return { ...listView(r), invoicing_date: iso(r.invoicing_date), acquisition_date: iso(r.acquisition_date), status_at: iso(r.status_at), rates, corrects, corrected_by: correctedBy };
}
export async function invoiceXmlInTx(c: PoolClient, id: string) {
  const r = (await c.query('SELECT ksef_number,xml FROM ksef243_purchase_invoices WHERE id=$1', [id])).rows[0];
  ensure(r, 404, 'Nie znaleziono faktury zakupowej');
  return { body: r.xml as Buffer, filename: `${r.ksef_number}.xml` };
}
export async function patchInvoiceInTx(c: PoolClient, a: KsefActor, id: string, b: PurchaseInvoicePatch) {
  const old = (await c.query('SELECT buyer_nip,ksef_number,status,version,legal_hold,accounting_ref,note FROM ksef243_purchase_invoices WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(old, 404, 'Nie znaleziono faktury zakupowej');
  ensure(old.version === b.version, 409, 'Faktura została zmieniona w międzyczasie — odśwież widok');
  if (b.status !== undefined) { const why = purchaseStatusChange(old.status, b.status, a.role); if (why) throw new Problem(/administratora/.test(why) ? 403 : 409, why); }
  ensure(b.legal_hold === undefined || a.role === 'admin', 403, 'Wstrzymanie usunięcia faktury ustawia administrator');
  ensure(old.status !== 'booked' || b.status !== undefined || a.role === 'admin' || (b.accounting_ref === undefined && b.note === undefined), 403, 'Zaksięgowaną fakturę zmienia administrator');
  const status = b.status ?? old.status;
  await c.query(`UPDATE ksef243_purchase_invoices SET status=$2,status_by=CASE WHEN $3 THEN $4::uuid ELSE status_by END,status_at=CASE WHEN $3 THEN clock_timestamp() ELSE status_at END,
    accounting_ref=$5,note=$6,legal_hold=$7,version=version+1 WHERE id=$1`,
  [id, status, b.status !== undefined, a.userId, b.accounting_ref === undefined ? old.accounting_ref : b.accounting_ref, b.note === undefined ? old.note : b.note, b.legal_hold ?? old.legal_hold]);
  const detail = { ksef_number: old.ksef_number, from: old.status, to: status, ...(b.legal_hold !== undefined ? { legal_hold: b.legal_hold } : {}), ...(b.accounting_ref !== undefined ? { accounting_ref: b.accounting_ref } : {}) };
  await event(c, old.buyer_nip, 'status', `Faktura ${old.ksef_number}: ${PURCHASE_STATUS_LABELS[old.status as PurchaseStatus]} → ${PURCHASE_STATUS_LABELS[status as PurchaseStatus]}${b.legal_hold !== undefined ? (b.legal_hold ? ', wstrzymano usunięcie' : ', zdjęto wstrzymanie usunięcia') : ''}`, detail, a.userId);
  await audit(c, a, 'ksef.purchase.invoice_update', id, detail);
  return invoiceDetailInTx(c, id);
}

// ---------- refused files ----------
export async function rejectsInTx(c: PoolClient) {
  return { items: (await c.query(`SELECT ksef_number,buyer_nip,code,reason,attempts,first_seen_at,last_seen_at,meta->>'invoiceNumber' invoice_number,meta->>'sellerNip' seller_nip,
    meta->>'sellerName' seller_name,meta->>'issueDate' issue_date FROM ksef243_purchase_rejects WHERE resolved_at IS NULL ORDER BY last_seen_at DESC LIMIT 200`)).rows
    .map(r => ({ ...r, first_seen_at: iso(r.first_seen_at), last_seen_at: iso(r.last_seen_at) })) };
}
/** "Pobierz ponownie": downloads the refused file again by its listing entry; stored when it now passes. */
export async function retryReject(a: KsefActor, ksefNumber: string, o: Ksef243Options = {}) {
  const pre = await tenantReadTx(a.tenantId, async c => {
    const rej = (await c.query('SELECT buyer_nip,meta,resolved_at FROM ksef243_purchase_rejects WHERE ksef_number=$1', [ksefNumber])).rows[0];
    return { rej, cfg: rej ? await configInTx(c, rej.buyer_nip) : null };
  });
  ensure(pre.rej, 404, 'Nie ma takiej odrzuconej faktury');
  ensure(!pre.rej.resolved_at, 409, 'Ta faktura została już pobrana');
  ensure(pre.cfg?.active, 409, noConfig(pre.rej.buyer_nip));
  ensure(!pre.rej.meta?.problem, 409, 'Wpis tej faktury na liście KSeF jest nieprawidłowy — sprawdź ją w aplikacji MF');
  const nip = pre.rej.buyer_nip as string, meta = parsePurchaseMetadata(pre.rej.meta), client = clientOf(pre.cfg!, o, Date.now() + 30_000);
  let inv: FetchedPurchaseInvoice;
  try { inv = await client.fetchInvoice(meta); }
  catch (e) {
    if (e instanceof KsefPurchaseDataError) {
      await tenantTx(a.tenantId, async c => { await rejectInTx(c, nip, { ksefNumber, invoiceHash: meta.invoiceHash, code: e.code, reason: e.message, meta }); await event(c, nip, 'retry', `Ponowne pobranie ${ksefNumber}: nadal odrzucona`, { ksef_number: ksefNumber, code: e.code }, a.userId); });
      throw new Problem(409, 'Plik faktury nadal jest odrzucany: ' + e.message);
    }
    if (e instanceof KsefUnavailableError || e instanceof KsefRefusedError) throw new Problem(409, 'Nie udało się pobrać faktury z KSeF: ' + e.message);
    throw e;
  }
  const done = await tenantTx(a.tenantId, async c => {
    const { fresh, refused } = await persistInTx(c, nip, [inv], 'retry');
    for (const r of refused) await rejectInTx(c, nip, r);
    if (!refused.length) await c.query('UPDATE ksef243_purchase_rejects SET resolved_at=clock_timestamp() WHERE ksef_number=$1 AND resolved_at IS NULL', [ksefNumber]);
    await event(c, nip, 'retry', `Ponowne pobranie ${ksefNumber}: ${fresh.length ? 'zapisana' : refused.length ? 'nadal odrzucona' : 'była już zapisana'}`, { ksef_number: ksefNumber }, a.userId);
    await audit(c, a, 'ksef.purchase.reject_retry', null, { ksef_number: ksefNumber, stored: fresh.length > 0 });
    return { ksef_number: ksefNumber, stored: fresh.length > 0, invoice_id: fresh[0]?.id ?? null, refused: refused[0]?.reason ?? null };
  });
  // Thrown after the commit, so the reject, the event and the audit entry stay.
  if (done.refused) throw new Problem(409, 'Plik faktury nadal jest odrzucany: ' + done.refused);
  const { refused: _r, ...view } = done;
  return view;
}

// ---------- the accountant's package ----------
/** CSV + the exact FA(3) files of the filtered invoices; the export (who, how many) is logged. */
export async function exportPackage(a: KsefActor, q: Partial<PurchaseListQuery>, o: Ksef243Options = {}) {
  const w = purchaseListWhere({ ...q, before: undefined });
  const rows = await tenantReadTx(a.tenantId, async c => {
    const head = (await c.query(`SELECT i.id,i.ksef_number,i.invoice_number,i.fa3_kind,to_char(i.issue_date,'YYYY-MM-DD') issue_date,to_char(i.sale_date,'YYYY-MM-DD') sale_date,i.seller_nip,
      i.seller_name,i.buyer_nip,i.currency,i.net_total::text,i.vat_total::text,i.gross_total::text,to_char(i.payment_due_date,'YYYY-MM-DD') payment_due_date,i.split_payment,i.status,
      i.accounting_ref,to_char(i.retain_until,'YYYY-MM-DD') retain_until,i.xml_bytes FROM ksef243_purchase_invoices i ${w.sql} ORDER BY i.issue_date,i.id LIMIT ${PURCHASE_EXPORT_LIMITS.maxInvoices + 1}`, w.params)).rows;
    ensure(head.length <= PURCHASE_EXPORT_LIMITS.maxInvoices, 422, `Paczka obejmuje najwyżej ${PURCHASE_EXPORT_LIMITS.maxInvoices} faktur — zawęź filtr`);
    ensure(head.reduce((s, r) => s + Number(r.xml_bytes), 0) <= PURCHASE_EXPORT_LIMITS.maxBytes, 422, 'Pliki faktur przekraczają 64 MiB — zawęź filtr');
    const files = new Map((await c.query('SELECT id,xml FROM ksef243_purchase_invoices WHERE id=ANY($1::uuid[])', [head.map(r => r.id)])).rows.map(r => [r.id as string, r.xml as Buffer]));
    return head.map(r => ({ ...r, xml: files.get(r.id)! }));
  });
  const now = nowOf(o);
  const body = zipStore([{ name: 'zestawienie.csv', data: Buffer.from(purchaseCsv(rows as unknown as PurchaseCsvRow[]), 'utf8') },
    ...rows.map(r => ({ name: `faktury/${r.ksef_number}.xml`, data: r.xml }))], now);
  const nips = [...new Set(rows.map(r => r.buyer_nip as string))];
  await tenantAppendTx(a.tenantId, async c => {
    for (const nip of nips.length ? nips : (q.nip ? [q.nip] : [])) await event(c, nip, 'export', `Pobrano paczkę faktur zakupowych (${rows.filter(r => r.buyer_nip === nip).length})`,
      { count: rows.filter(r => r.buyer_nip === nip).length, bytes: body.length, actor_role: a.role, filters: { ...q, before: undefined } }, a.userId);
  });
  return { body, filename: 'faktury-zakupowe-ksef.zip', count: rows.length };
}
