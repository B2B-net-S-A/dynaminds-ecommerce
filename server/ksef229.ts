/** Native 229 KSeF: per-NIP settings with the encrypted secret, sending the FA(3) file of an
 * issued document (the single FA(3) entry point of fa3-documents.ts), status polling, UPO,
 * the KSeF number on the document, and offline invoices with their QR codes and deadline.
 * KSeF is called outside any database transaction: one short transaction takes the
 * submission (idempotent per document, with a lease), the network flow runs, a second
 * transaction stores its result. Secrets are decrypted only for the call and never leave
 * this module; tokens are kept only in memory of one request.
 * RES-04 (no double send, no false rejection): the session is stored with the submission before
 * sendInvoice (durable marker: queued + session_id, no reference). A send whose answer is lost
 * (timeout, connection, 5xx, crash) is resolved by looking the file up by its SHA-256 in that
 * session; a 440 "Duplikat" by the session KSeF names. Nothing is sent again while the file may
 * be in KSeF. One attempt is bounded by KSEF_ATTEMPT_BUDGET_MS and the lease outlasts it. */
import { createHmac, createPrivateKey, randomUUID } from 'node:crypto';
import { sha256Base64 } from './ksef229-crypto';
import type { Pool, PoolClient } from 'pg';
import QRCode from 'qrcode';
import { tenantAppendTx, tenantReadTx, tenantTx } from './db';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { decrypt, encrypt } from './security';
import { fa3DocumentXml, type Fa3Request } from './fa3-documents';
import { ensureFa3Conforms } from './fa3-xsd';
import type { XsdResult } from './mf-xsd';
import { KsefClient, KsefRefusedError, KsefUnavailableError, type KsefCredentials, type KsefEnvironment, type KsefInvoiceStatus, type KsefSession, type KsefSessionInvoice } from './ksef229-client';
import {
  KSEF_ATTEMPT_BUDGET_MS, KSEF_LEASE_SECONDS, OFFLINE_REASONS, afterAttempt, duplicateOf, fa3XmlFacts, sendUncertain, kodIIUrl, kodIUrl, liveDecision, maskedConfig, offlineDeadline, overdue, qrBase, warsawDay,
  STATE_LABELS, type Fa3Facts, type KsefConfigInput, type KsefConfigRow, type KsefIssueMode, type KsefSecret, type KsefState, type SendOutcome,
} from './ksef229-model';

export type KsefActor = { tenantId: string; userId: string; role: 'admin' | 'operator' | 'viewer'; apiKeyId?: string };
export type KsefXml = { xml: string; number: string; document_kind: string };
/** Clock and network knobs (tests); all a read-only reconciliation needs. */
export type KsefNetOptions = { now?: () => Date; fetch?: typeof fetch; timeoutMs?: number; pollDelaysMs?: number[]; sleep?: (ms: number) => Promise<void> };
export type Ksef229Options = KsefNetOptions & {
  key: string; sessionName: string;
  /** FA(3) source; defaults to GET /api/fa3/documents/:id/fa3.xml's generator. */ xml?: (req: Fa3Request, id: string) => Promise<KsefXml>;
  /** Official FA(3) schema check (tests); defaults to the vendored MF schema (server/fa3-xsd.ts). */ xsd?: (xml: string) => Promise<XsdResult>;
};

export async function ksef229Available(c: Pool | PoolClient): Promise<boolean> {
  return Boolean((await c.query(`SELECT to_regclass('public.ksef229_submissions') IS NOT NULL AND to_regclass('public.ksef229_events') IS NOT NULL
    AND to_regprocedure('public.ksef229_submission_guard()') IS NOT NULL AS available`)).rows[0]?.available);
}
/** Whether 231 is installed: the 229 submission CHECK admits the FV-S invoice (230). */
/** 232 installed: the 229 document-kind CHECK lists the KOR-S correction. */
export async function ksefAcceptsInvoice232(c: Pool | PoolClient): Promise<boolean> {
  return Boolean((await c.query(`SELECT EXISTS(SELECT FROM pg_constraint WHERE conrelid=to_regclass('public.ksef229_submissions') AND conname='ksef229_submissions_document_kind_check'
    AND pg_get_constraintdef(oid) LIKE '%''invoice232_correction''%') AS accepts`)).rows[0]?.accepts);
}
export async function ksefAcceptsInvoice230(c: Pool | PoolClient): Promise<boolean> {
  return Boolean((await c.query(`SELECT EXISTS(SELECT FROM pg_constraint WHERE conrelid=to_regclass('public.ksef229_submissions') AND conname='ksef229_submissions_document_kind_check'
    AND pg_get_constraintdef(oid) LIKE '%''invoice230''%') AS accepts`)).rows[0]?.accepts);
}
const LEASE = `clock_timestamp()+interval '${KSEF_LEASE_SECONDS} seconds'`;
const now = (o: KsefNetOptions) => (o.now ?? (() => new Date()))();
const fingerprint = (key: string, secret: KsefSecret) => createHmac('sha256', Buffer.from(key, 'hex')).update('ksef229:' + JSON.stringify(secret)).digest('hex').slice(0, 16);
const short = (s: string, n = 2000) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- settings ----------
const CONFIG_COLUMNS = 'nip,environment,base_url,auth_method,secret_fingerprint,certificate_serial,offline_certificate_serial,active,updated_at';
export async function listConfigsInTx(c: PoolClient) {
  return (await c.query(`SELECT ${CONFIG_COLUMNS} FROM ksef229_configs ORDER BY nip`)).rows.map(r => maskedConfig(r as KsefConfigRow));
}
type StoredConfig = KsefConfigRow & { secret_ciphertext: string };
async function configInTx(c: PoolClient, nip: string): Promise<StoredConfig | null> {
  return (await c.query(`SELECT ${CONFIG_COLUMNS},secret_ciphertext FROM ksef229_configs WHERE nip=$1`, [nip])).rows[0] ?? null;
}
/** Insert or update one NIP. The new secret is merged with the stored one (omitted parts are kept). */
export async function saveConfigInTx(c: PoolClient, a: KsefActor, nip: string, b: KsefConfigInput, key: string) {
  const old = (await c.query(`SELECT ${CONFIG_COLUMNS},secret_ciphertext FROM ksef229_configs WHERE nip=$1 FOR UPDATE`, [nip])).rows[0] as StoredConfig | undefined;
  const prior: KsefSecret = old ? decrypt(old.secret_ciphertext) : {};
  const sameMethod = old?.auth_method === b.auth_method;
  const secret: KsefSecret = b.auth_method === 'token'
    ? { token: b.token ?? (sameMethod ? prior.token : undefined) }
    : { certificate_pem: b.certificate_pem ?? (sameMethod ? prior.certificate_pem : undefined), private_key_pem: b.private_key_pem ?? (sameMethod ? prior.private_key_pem : undefined) };
  if (b.offline_certificate_pem) Object.assign(secret, { offline_certificate_pem: b.offline_certificate_pem, offline_private_key_pem: b.offline_private_key_pem });
  else if (prior.offline_certificate_pem) Object.assign(secret, { offline_certificate_pem: prior.offline_certificate_pem, offline_private_key_pem: prior.offline_private_key_pem });
  ensure(b.auth_method === 'token' ? secret.token : secret.certificate_pem && secret.private_key_pem, 422,
    b.auth_method === 'token' ? 'Podaj token KSeF' : 'Podaj certyfikat KSeF i jego klucz prywatny');
  if (secret.private_key_pem) privateKey(secret.private_key_pem, 'Klucz prywatny certyfikatu');
  if (secret.offline_private_key_pem) privateKey(secret.offline_private_key_pem, 'Klucz prywatny certyfikatu offline');
  const certSerial = b.auth_method === 'certificate' ? (b.certificate_serial ?? (sameMethod ? old?.certificate_serial : null) ?? null) : null;
  ensure(b.auth_method === 'token' || certSerial, 422, 'Podaj numer seryjny certyfikatu');
  const offlineSerial = b.offline_certificate_serial ?? old?.offline_certificate_serial ?? null;
  const values = [nip, b.environment, b.environment === 'local_fake' ? b.base_url : null, b.auth_method, encrypt(secret), fingerprint(key, secret), certSerial, offlineSerial, b.active, a.userId];
  if (old) await c.query(`UPDATE ksef229_configs SET environment=$2,base_url=$3,auth_method=$4,secret_ciphertext=$5,secret_fingerprint=$6,certificate_serial=$7,
    offline_certificate_serial=$8,active=$9,updated_by=$10,updated_at=clock_timestamp() WHERE nip=$1`, values);
  else await c.query(`INSERT INTO ksef229_configs(tenant_id,nip,environment,base_url,auth_method,secret_ciphertext,secret_fingerprint,certificate_serial,offline_certificate_serial,active,created_by,updated_by)
    VALUES(nullif(current_setting('app.tenant_id',true),'')::uuid,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`, values);
  await event(c, { nip, kind: 'config', message: `Zapisano ustawienia KSeF (${b.environment}, ${b.auth_method === 'token' ? 'token' : 'certyfikat'}${b.active ? '' : ', wyłączone'})`, actor: a.userId });
  await audit(c, a, 'ksef.config_save', null, { nip, environment: b.environment, auth_method: b.auth_method, active: b.active, secret_changed: !old || fingerprint(key, prior) !== values[5] });
  return maskedConfig((await c.query(`SELECT ${CONFIG_COLUMNS} FROM ksef229_configs WHERE nip=$1`, [nip])).rows[0]);
}
function privateKey(pem: string, label: string) {
  try { return createPrivateKey(pem); } catch { throw new Problem(422, `${label} nie jest poprawnym kluczem PEM`); }
}
type Ev = { nip: string; kind: string; message: string; code?: number | null; submission?: string | null; session?: string | null; actor?: string | null };
async function event(c: PoolClient, e: Ev) {
  await c.query(`INSERT INTO ksef229_events(tenant_id,submission_id,session_id,nip,kind,code,message,actor_id) VALUES(nullif(current_setting('app.tenant_id',true),'')::uuid,$1,$2,$3,$4,$5,$6,$7)`,
    [e.submission ?? null, e.session ?? null, e.nip, e.kind, e.code != null && e.code >= 100 && e.code <= 999 ? e.code : null, short(e.message), e.actor ?? null]);
}
function credentialsOf(cfg: StoredConfig): { credentials: KsefCredentials; secret: KsefSecret } {
  const secret: KsefSecret = decrypt(cfg.secret_ciphertext);
  if (cfg.auth_method === 'token') { ensure(secret.token, 409, 'Ustawienia KSeF nie mają tokenu'); return { credentials: { method: 'token', token: secret.token }, secret }; }
  ensure(secret.certificate_pem && secret.private_key_pem, 409, 'Ustawienia KSeF nie mają certyfikatu');
  return { credentials: { method: 'certificate', certificatePem: secret.certificate_pem, privateKeyPem: secret.private_key_pem }, secret };
}
function clientOf(cfg: StoredConfig, o: KsefNetOptions, deadline?: number): KsefClient {
  const { credentials } = credentialsOf(cfg);
  try {
    return new KsefClient({ environment: cfg.environment, ...(cfg.base_url ? { baseUrl: cfg.base_url } : {}), nip: cfg.nip, credentials, ...(deadline ? { deadline } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.pollDelaysMs ? { pollDelaysMs: o.pollDelaysMs } : {}), ...(o.sleep ? { sleep: o.sleep } : {}) });
  } catch (e) { throw new Problem(409, (e as Error).message); }
}

/** "Sprawdź połączenie": challenge, MF keys, authentication and token redeem against the configured server. */
export async function checkConnection(a: KsefActor, nip: string, o: Ksef229Options) {
  const cfg = await tenantReadTx(a.tenantId, c => configInTx(c, nip));
  ensure(cfg, 404, 'Brak ustawień KSeF dla tego NIP');
  const client = clientOf(cfg, o), started = Date.now();
  const r = await client.checkConnection();
  const ok = r.problem === null;
  await tenantAppendTx(a.tenantId, c => event(c, { nip, kind: 'check', message: ok ? `Połączenie z KSeF działa (${cfg.environment})` : 'Połączenie z KSeF nie działa: ' + r.problem, actor: a.userId }));
  return { nip, environment: cfg.environment, ok, problem: r.problem, steps: r.steps, access_valid_until: r.accessValidUntil, ms: Date.now() - started };
}

// ---------- submissions ----------
const SUB_COLUMNS = `id,document_id,document_kind,document_number,nip,environment,to_char(issue_date,'YYYY-MM-DD') issue_date,xml_sha256,xml_bytes,issue_mode,offline_reason,offline_at,
  to_char(send_deadline,'YYYY-MM-DD') send_deadline,qr_invoice_url,qr_certificate_url,state,session_id,reference_number,status_code,status_description,status_details,ksef_number,
  acquisition_at,upo_sha256,upo_at,attempts,last_error,last_attempt_at,lease_until,created_at,updated_at`;
type Sub = { id: string; document_id: string; document_kind: string; document_number: string; nip: string; environment: KsefEnvironment; issue_date: string; xml_sha256: string;
  issue_mode: KsefIssueMode; offline_reason: string | null; send_deadline: string | null; qr_invoice_url: string | null; qr_certificate_url: string | null; state: KsefState;
  session_id: string | null; reference_number: string | null; status_code: number | null; status_description: string | null; ksef_number: string | null; upo_sha256: string | null;
  lease_until: Date | null; attempts: number; last_error: string | null; [k: string]: unknown };
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? null);
async function liveInTx(c: PoolClient, documentId: string): Promise<Sub | null> {
  return (await c.query(`SELECT ${SUB_COLUMNS} FROM ksef229_submissions WHERE document_id=$1 AND state<>'rejected'`, [documentId])).rows[0] ?? null;
}
async function qr(url: string) { return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }); }
/** What a reader sees of one submission (never the secret; the XML and UPO are separate downloads). */
export async function submissionView(s: Sub, today: string) {
  return {
    id: s.id, document_id: s.document_id, document_kind: s.document_kind, document_number: s.document_number, nip: s.nip, environment: s.environment,
    state: s.state, state_label: STATE_LABELS[s.state], ksef_number: s.ksef_number, acquisition_at: iso(s.acquisition_at), reference_number: s.reference_number,
    status: s.status_code === null ? null : { code: s.status_code, description: s.status_description, details: s.status_details ?? [] },
    xml_sha256: s.xml_sha256, upo_available: s.upo_sha256 !== null, upo_at: iso(s.upo_at), attempts: s.attempts, last_error: s.last_error, last_attempt_at: iso(s.last_attempt_at),
    offline: s.issue_mode === 'online' ? null : {
      mode: s.issue_mode, reason: s.offline_reason, since: iso(s.offline_at), deadline: s.send_deadline, overdue: s.state === 'queued' && overdue(s.send_deadline, today),
      kod1: { url: s.qr_invoice_url, label: s.ksef_number ?? 'OFFLINE', svg: await qr(s.qr_invoice_url!) },
      kod2: s.qr_certificate_url ? { url: s.qr_certificate_url, label: 'CERTYFIKAT', svg: await qr(s.qr_certificate_url) } : null,
      kod2_note: s.qr_certificate_url ? null : 'Brak certyfikatu KSeF typu Offline w ustawieniach — KOD II nie został wygenerowany',
    },
    created_at: iso(s.created_at), updated_at: iso(s.updated_at),
  };
}
export async function documentKsef(a: KsefActor, documentId: string, o: KsefNetOptions) {
  const today = warsawDay(now(o));
  const { live, history } = await tenantReadTx(a.tenantId, async c => ({
    live: await liveInTx(c, documentId),
    history: (await c.query(`SELECT ${SUB_COLUMNS} FROM ksef229_submissions WHERE document_id=$1 AND state='rejected' ORDER BY created_at DESC LIMIT 10`, [documentId])).rows as Sub[],
  }));
  return { document_id: documentId, submission: live ? await submissionView(live, today) : null, rejected: await Promise.all(history.map(h => submissionView(h, today))) };
}
async function xmlOf(req: Fa3Request, id: string, o: Ksef229Options): Promise<KsefXml> {
  return o.xml ? o.xml(req, id) : fa3DocumentXml(req, id, o.sessionName);
}
async function activeConfig(c: PoolClient, nip: string): Promise<StoredConfig> {
  const cfg = await configInTx(c, nip);
  ensure(cfg?.active, 409, `Brak aktywnych ustawień KSeF dla NIP ${nip}. Dodaj je w Ustawienia → KSeF.`);
  return cfg;
}
type Prepared = { xml: string; facts: Fa3Facts; kind: string };
async function prepare(req: Fa3Request, id: string, o: Ksef229Options): Promise<Prepared> {
  const x = await xmlOf(req, id, o), facts = fa3XmlFacts(x.xml);
  ensure(facts.number === x.number, 422, 'Plik FA(3) nie odpowiada numerowi dokumentu');
  // Before anything is stored or sent (online and offline): a file KSeF would reject by its schema is refused here.
  await ensureFa3Conforms(x.xml, x.number, o.xsd, ' — nie wysłano do KSeF');
  // The 229_ksef CHECK lists the document kinds it stores; 231 widens it by the FV-S invoice (230).
  if (x.document_kind === 'invoice230')
    ensure(await tenantReadTx(req.actor.tenantId, c => ksefAcceptsInvoice230(c)), 409, 'Wysyłka faktury FV-S do KSeF wymaga migracji 231 — pobierz XML FA(3) i wyślij go poza aplikacją');
  // 232 widens the same CHECK by the KOR-S correction of a FV-S invoice.
  if (x.document_kind === 'invoice232_correction')
    ensure(await tenantReadTx(req.actor.tenantId, c => ksefAcceptsInvoice232(c)), 409, 'Wysyłka korekty KOR-S do KSeF wymaga migracji 232 — pobierz XML FA(3) i wyślij go poza aplikacją');
  return { xml: x.xml, facts, kind: x.document_kind };
}
/** Offline columns of a submission: reason, QR links and deadline. */
function offlineColumns(cfg: StoredConfig, mode: Exclude<KsefIssueMode, 'online'>, facts: Fa3Facts, xml: string, at: Date, emergencyEnd?: string) {
  const base = qrBase(cfg.environment, cfg.base_url), secret: KsefSecret = decrypt(cfg.secret_ciphertext);
  const kod2 = secret.offline_private_key_pem && cfg.offline_certificate_serial
    ? kodIIUrl(base, cfg.nip, facts, xml, { serial: cfg.offline_certificate_serial, privateKey: privateKey(secret.offline_private_key_pem, 'Klucz certyfikatu offline') }) : null;
  return { mode, reason: OFFLINE_REASONS[mode], kod1: kodIUrl(base, facts, xml), kod2,
    deadline: offlineDeadline(mode, { issueDate: facts.issueDate, detectedDay: warsawDay(at), emergencyEnd }) };
}
const INSERT = `INSERT INTO ksef229_submissions(tenant_id,document_id,document_kind,document_number,nip,environment,issue_date,xml,xml_sha256,xml_bytes,issue_mode,offline_reason,offline_at,
  send_deadline,qr_invoice_url,qr_certificate_url,state,created_by)
  VALUES(nullif(current_setting('app.tenant_id',true),'')::uuid,$1,$2,$3,$4,$5,$6,$7,encode(sha256(convert_to($7,'UTF8')),'hex'),octet_length(convert_to($7,'UTF8')),$8,$9,$10,$11,$12,$13,'queued',$14)
  ON CONFLICT (tenant_id,document_id) WHERE state<>'rejected' DO NOTHING RETURNING id`;

/** Offline issue by the user's choice (offline24 or the announced emergency mode): the file, its
 * QR codes and deadline are fixed now; "Kolejka KSeF" sends it later. */
export async function markOffline(req: Fa3Request, a: KsefActor, id: string, mode: 'offline24' | 'awaryjny', emergencyEnd: string | undefined, o: Ksef229Options) {
  const existing = await tenantReadTx(a.tenantId, c => liveInTx(c, id));
  if (existing) {
    ensure(existing.state === 'queued', 409, existing.state === 'accepted' ? 'Faktura ma już numer KSeF' : 'Faktura została już wysłana do KSeF');
    ensure(existing.issue_mode === 'online' || existing.issue_mode === mode, 409, 'Faktura jest już w trybie ' + existing.issue_mode);
  }
  const p = await prepare(req, id, o), at = now(o);
  await tenantTx(a.tenantId, async c => {
    const cfg = await activeConfig(c, p.facts.sellerNip), off = offlineColumns(cfg, mode, p.facts, p.xml, at, emergencyEnd);
    const live = await liveInTx(c, id);
    if (!live) {
      const r = await c.query(INSERT, [id, p.kind, p.facts.number, cfg.nip, cfg.environment, p.facts.issueDate, p.xml, mode, off.reason, at, off.deadline, off.kod1, off.kod2, a.userId]);
      ensure(r.rowCount, 409, 'Faktura jest właśnie zapisywana w kolejce KSeF');
      await event(c, { nip: cfg.nip, kind: 'offline', submission: r.rows[0].id, message: `${off.reason}; termin wysyłki ${off.deadline ?? 'po zakończeniu trybu awaryjnego'}`, actor: a.userId });
      return;
    }
    ensure(live.state === 'queued', 409, 'Faktura została już wysłana do KSeF');
    if (live.issue_mode === 'online') {
      // The stored file stays: its hash is what the QR code shows.
      const stored = (await c.query('SELECT xml FROM ksef229_submissions WHERE id=$1', [live.id])).rows[0].xml as string;
      const o2 = offlineColumns(cfg, mode, fa3XmlFacts(stored), stored, at, emergencyEnd);
      await c.query(`UPDATE ksef229_submissions SET issue_mode=$2,offline_reason=$3,offline_at=$4,send_deadline=$5,qr_invoice_url=$6,qr_certificate_url=$7,updated_at=clock_timestamp() WHERE id=$1`,
        [live.id, mode, o2.reason, at, o2.deadline, o2.kod1, o2.kod2]);
      await event(c, { nip: cfg.nip, kind: 'offline', submission: live.id, message: `${o2.reason}; termin wysyłki ${o2.deadline ?? 'po zakończeniu trybu awaryjnego'}`, actor: a.userId });
    } else if (live.send_deadline === null && off.deadline) {
      await c.query('UPDATE ksef229_submissions SET send_deadline=$2,updated_at=clock_timestamp() WHERE id=$1', [live.id, off.deadline]);
      await event(c, { nip: cfg.nip, kind: 'offline', submission: live.id, message: `Termin wysyłki po trybie awaryjnym: ${off.deadline}`, actor: a.userId });
    }
  });
  return documentKsef(a, id, o);
}

type Where = { id: string | null; ref: string };
type Attempt = { outcome: SendOutcome; /** session opened by this attempt (stored before sendInvoice) */ session?: { id: string; ref: string; closedAt: Date | null; error: string | null };
  invoiceRef?: string | null; /** session the invoice reference belongs to */ invoiceSession?: Where | null;
  status?: KsefInvoiceStatus | null; upo?: string | null; error?: string | null; /** how an uncertain send was settled */ note?: string | null };
type Taken = { sub: Sub; xml: string; cfg: StoredConfig; sessionRef: string | null; lease: string };
/** Stores the opened session with the submission before sendInvoice; returns the session id. */
type Marker = (s: KsefSession) => Promise<string>;
const refused404 = (e: unknown) => e instanceof KsefRefusedError && e.status === 404;
/** The network part of one attempt (no transaction open). `read` never sends: it only polls a
 * handed-over invoice or looks for the file of an uncertain send. */
async function attempt(client: KsefClient, t: Taken, mark: Marker, mode: 'send' | 'read'): Promise<Attempt> {
  const { sub, xml } = t, hash = sha256Base64(Buffer.from(xml, 'utf8'));
  const r: Attempt = { outcome: { kind: 'refused_before_send' } };
  let session: KsefSession | null = null;
  try {
    if (sub.state === 'sent') {
      // Already handed over: only its status and UPO are read.
      const status = await client.pollInvoice(t.sessionRef!, sub.reference_number!);
      return await settle(client, { id: sub.session_id, ref: t.sessionRef! }, status, hash, r);
    }
    if (sendUncertain(sub) && t.sessionRef) {
      // The last send may have reached KSeF: look for this file in its session before anything else.
      let found: KsefSessionInvoice | null;
      try { found = await client.findInvoiceByHash(t.sessionRef, hash); } catch (e) { if (!refused404(e)) throw e; found = null; }
      if (found) {
        r.note = `Odnaleziono plik w sesji ${t.sessionRef} ostatniej wysyłki (odpowiedź KSeF zaginęła); nie wysłano go ponownie`;
        return await fromFound(client, { id: sub.session_id, ref: t.sessionRef }, found, hash, r);
      }
      if (mode === 'read') { r.outcome = { kind: 'not_found' }; r.note = `Pliku nie ma w sesji ${t.sessionRef} ostatniej wysyłki — KSeF go nie otrzymał`; return r; }
    } else if (mode === 'read') { r.outcome = { kind: 'not_found' }; r.note = 'Faktura nie była przekazana do KSeF; odczyt niczego nie wysyła'; return r; }
    await client.authenticate();
    session = await client.openOnlineSession();
    const sid = await mark(session);
    r.session = { id: sid, ref: session.referenceNumber, closedAt: null, error: null };
    let sent: { referenceNumber: string };
    try { sent = await client.sendInvoice(session, Buffer.from(xml, 'utf8'), { offlineMode: sub.issue_mode !== 'online' }); }
    catch (e) {
      if (!(e instanceof KsefUnavailableError)) throw e;
      // The answer is lost, not necessarily the invoice: look for the file in this session first.
      let found: KsefSessionInvoice | null;
      try { found = await client.findInvoiceByHash(session.referenceNumber, hash); }
      catch (e2) { if (e2 instanceof KsefUnavailableError || e2 instanceof KsefRefusedError) throw e; throw e2; }
      if (!found) throw e;
      r.note = `Odpowiedź KSeF na wysyłkę zaginęła (${e.message}); plik odnaleziono w sesji ${session.referenceNumber}`;
      return await fromFound(client, { id: sid, ref: session.referenceNumber }, found, hash, r);
    }
    r.invoiceRef = sent.referenceNumber; r.invoiceSession = { id: sid, ref: session.referenceNumber };
    const status = await client.pollInvoice(session.referenceNumber, sent.referenceNumber);
    return await settle(client, r.invoiceSession, status, hash, r);
  } catch (e) {
    if (e instanceof KsefUnavailableError) { r.outcome = { kind: 'unavailable', referenced: Boolean(r.invoiceRef) }; r.error = e.message; return r; }
    if (e instanceof KsefRefusedError) {
      r.error = e.message;
      if (r.invoiceRef || !r.session) { r.outcome = r.invoiceRef ? { kind: 'unavailable', referenced: true } : { kind: 'refused_before_send' }; return r; }
      // The send itself was refused (hash, size, decryption): final for this file.
      r.outcome = { kind: 'rejected' };
      r.status = { code: e.status, description: e.description, details: e.details, ksefNumber: null, acquisitionDate: null, invoiceNumber: null, referenceNumber: '', upoAvailable: false };
      return r;
    }
    throw e;
  } finally {
    if (session && r.session) {
      try { await client.closeSession(session.referenceNumber); r.session.closedAt = new Date(); }
      catch (e) { r.session.error = 'Nie udało się zamknąć sesji: ' + (e as Error).message; r.session.closedAt = new Date(); }
    }
  }
}
/** An invoice found in a session listing: polled while KSeF still processes it, then settled. */
async function fromFound(client: KsefClient, where: Where, found: KsefSessionInvoice, hash: string, r: Attempt): Promise<Attempt> {
  r.invoiceRef = found.referenceNumber; r.invoiceSession = where;
  const status = found.code === 100 || found.code === 150 ? await client.pollInvoice(where.ref, found.referenceNumber) : found;
  return settle(client, where, status, hash, r);
}
/** A final or interim status; 440 "Duplikat" is reconciled with the original instead of rejected. */
async function settle(client: KsefClient, where: Where, status: KsefInvoiceStatus, hash: string, r: Attempt): Promise<Attempt> {
  const dup = duplicateOf(status);
  if (!dup) return finish(client, where.ref, status, r);
  let original: KsefSessionInvoice | null = null;
  if (dup.sessionRef) {
    try { original = await client.findInvoiceByHash(dup.sessionRef, hash); } catch (e) { if (!refused404(e)) throw e; }
  }
  if (original && original.code === 200 && original.ksefNumber && (!dup.ksefNumber || dup.ksefNumber === original.ksefNumber)) {
    r.invoiceRef = original.referenceNumber; r.invoiceSession = { id: null, ref: dup.sessionRef! };
    r.note = `KSeF zgłosił duplikat (440); ten sam plik przyjęto wcześniej w sesji ${dup.sessionRef} — uzgodniono numer KSeF bez ponownej wysyłki`;
    return finish(client, dup.sessionRef!, original, r);
  }
  r.status = status; r.invoiceRef = null; r.invoiceSession = null; r.outcome = { kind: 'duplicate_unconfirmed' };
  r.error = 'KSeF zgłosił duplikat faktury (440), ale nie udało się potwierdzić numeru KSeF tego pliku' + (dup.ksefNumber ? ` (KSeF podaje ${dup.ksefNumber})` : '') +
    '. Faktura nie zostanie wysłana ponownie — sprawdź ją w aplikacji KSeF.';
  return r;
}
async function finish(client: KsefClient, sessionRef: string, status: KsefInvoiceStatus, r: Attempt): Promise<Attempt> {
  r.status = status;
  if (status.code === 200 && status.ksefNumber) {
    r.outcome = { kind: 'accepted' };
    try { r.upo = await client.fetchUpo(sessionRef, status.ksefNumber); } catch (e) { r.error = 'UPO jeszcze niedostępne: ' + (e as Error).message; }
  } else r.outcome = status.code === 100 || status.code === 150 ? { kind: 'processing' } : { kind: 'rejected' };
  return r;
}

/** Sends (or for an already handed-over invoice: re-reads) one document. Idempotent: one live
 * submission per document; an accepted one is returned without any call to KSeF; an uncertain
 * send is looked up in KSeF before anything is sent again. */
export async function sendDocument(req: Fa3Request, a: KsefActor, id: string, o: Ksef229Options) {
  return runDocument(a, id, o, 'send', () => prepare(req, id, o));
}
/** Read-only reconciliation (background status job, "Sprawdź status"): polls a handed-over invoice
 * or looks for the file of an uncertain send. Never sends. */
export async function reconcileDocument(a: KsefActor, id: string, o: KsefNetOptions) {
  return runDocument(a, id, o, 'read', null);
}
async function runDocument(a: KsefActor, id: string, o: KsefNetOptions, mode: 'send' | 'read', prep: (() => Promise<Prepared>) | null) {
  const at = now(o);
  const live = await tenantReadTx(a.tenantId, c => liveInTx(c, id));
  const decision = liveDecision(live, at);
  if (decision === 'return') return { ...(await documentKsef(a, id, o)), replayed: true };
  ensure(decision !== 'busy', 409, 'Wysyłka tej faktury do KSeF już trwa. Odśwież widok za chwilę.');
  // A read never takes a submission that was not handed over (nothing to ask KSeF about).
  if (!prep && (decision === 'create' || (live!.state === 'queued' && !sendUncertain(live!)))) return { ...(await documentKsef(a, id, o)), replayed: false };
  const p = decision === 'create' ? await prep!() : null;
  // Take the submission: create it, or lease the existing one.
  const taken = await tenantTx(a.tenantId, async c => {
    if (p) {
      const cfg = await activeConfig(c, p.facts.sellerNip);
      await c.query(INSERT, [id, p.kind, p.facts.number, cfg.nip, cfg.environment, p.facts.issueDate, p.xml, 'online', null, null, null, null, null, a.userId]);
    }
    const r = (await c.query(`UPDATE ksef229_submissions SET lease_until=${LEASE},attempts=attempts+1,last_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE document_id=$1 AND state IN ('queued','sent') AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING id,lease_until::text lease`, [id])).rows[0];
    const sub = await liveInTx(c, id);
    if (!r) return { sub, leased: false as const };
    const cfg = await activeConfig(c, sub!.nip);
    const xml = (await c.query('SELECT xml FROM ksef229_submissions WHERE id=$1', [sub!.id])).rows[0].xml as string;
    const sessionRef = sub!.session_id ? (await c.query('SELECT reference_number FROM ksef229_sessions WHERE id=$1', [sub!.session_id])).rows[0]?.reference_number ?? null : null;
    return { sub, leased: true as const, t: { sub: sub!, xml, cfg, sessionRef, lease: r.lease as string } satisfies Taken };
  });
  if (!taken.leased) {
    if (taken.sub?.state === 'accepted') return { ...(await documentKsef(a, id, o)), replayed: true };
    throw new Problem(409, 'Wysyłka tej faktury do KSeF już trwa. Odśwież widok za chwilę.');
  }
  const t = taken.t, { sub, cfg } = t;
  const mark: Marker = s => tenantTx(a.tenantId, async c => {
    const sid = randomUUID();
    await c.query(`INSERT INTO ksef229_sessions(id,tenant_id,nip,environment,kind,state,reference_number,valid_until,created_by,opened_at)
      VALUES($1,nullif(current_setting('app.tenant_id',true),'')::uuid,$2,$3,'online','open',$4,$5,$6,clock_timestamp())`, [sid, cfg.nip, cfg.environment, s.referenceNumber, s.validUntil, a.userId]);
    const own = await c.query(`UPDATE ksef229_submissions SET session_id=$2,updated_at=clock_timestamp() WHERE id=$1 AND state='queued' AND lease_until=$3::timestamptz AND lease_until>clock_timestamp()`,
      [sub.id, sid, t.lease]);
    if (!own.rowCount) throw new Problem(409, 'Dzierżawa wysyłki KSeF wygasła przed wysłaniem pliku; nic nie wysłano. Spróbuj ponownie.');
    await event(c, { nip: cfg.nip, kind: 'session_open', session: sid, message: 'Otwarto sesję interaktywną ' + s.referenceNumber, actor: a.userId });
    await event(c, { nip: cfg.nip, kind: 'send', submission: sub.id, session: sid, message: `Wysyłanie pliku (SHA-256 ${sha256Base64(Buffer.from(t.xml, 'utf8'))}) w sesji ${s.referenceNumber}; jeśli odpowiedź zaginie, wynik zostanie uzgodniony odczytem z KSeF` , actor: a.userId });
    return sid;
  });
  let result: Attempt;
  try { result = await attempt(clientOf(cfg, o, Date.now() + KSEF_ATTEMPT_BUDGET_MS), t, mark, mode); }
  catch (e) {
    await tenantTx(a.tenantId, c => c.query('UPDATE ksef229_submissions SET lease_until=NULL,last_error=$2,updated_at=clock_timestamp() WHERE id=$1 AND lease_until=$3::timestamptz',
      [sub.id, short('Błąd wysyłki: ' + (e as Error).message), t.lease]));
    throw e;
  }
  await storeAttempt(a, t, result, o);
  const view = await documentKsef(a, id, o);
  if (result.outcome.kind === 'refused_before_send') throw new Problem(409, 'KSeF odmówił obsługi: ' + (result.error ?? 'nieznany powód'));
  return { ...view, replayed: false };
}

async function storeAttempt(a: KsefActor, t: Taken, r: Attempt, o: KsefNetOptions) {
  const { sub, cfg, xml } = t, next = afterAttempt(sub, r.outcome), at = now(o);
  await tenantTx(a.tenantId, async c => {
    // Fenced by the lease of this attempt: a stale worker never overwrites a newer attempt.
    const own = await c.query('SELECT 1 FROM ksef229_submissions WHERE id=$1 AND lease_until=$2::timestamptz FOR UPDATE', [sub.id, t.lease]);
    ensure(own.rowCount, 409, 'Dzierżawa wysyłki KSeF wygasła przed zapisem wyniku; następna próba uzgodni wynik odczytem z KSeF.');
    if (r.session) {
      const failed = r.session.error !== null;
      await c.query(`UPDATE ksef229_sessions SET state=$2,closed_at=$3,error=$4 WHERE id=$1 AND state='open'`,
        [r.session.id, failed ? 'failed' : r.session.closedAt ? 'closed' : 'open', r.session.closedAt, r.session.error]);
      if (r.session.closedAt) await event(c, { nip: cfg.nip, kind: 'session_close', session: r.session.id, message: failed ? r.session.error! : 'Zamknięto sesję ' + r.session.ref, actor: a.userId });
    }
    // The session of an earlier uncertain send, left open by a crash, is closed once settled.
    if (sendUncertain(sub) && sub.session_id !== r.session?.id && next.state !== 'queued')
      await c.query(`UPDATE ksef229_sessions SET state='closed',closed_at=clock_timestamp() WHERE id=$1 AND state='open'`, [sub.session_id]);
    let invoiceSessionId = r.invoiceSession?.id ?? null;
    if (r.invoiceRef && r.invoiceSession && !invoiceSessionId) {
      // A session KSeF named (440 duplicate): known to the app, or recorded now.
      invoiceSessionId = (await c.query('SELECT id FROM ksef229_sessions WHERE nip=$1 AND reference_number=$2 ORDER BY created_at LIMIT 1', [cfg.nip, r.invoiceSession.ref])).rows[0]?.id ?? null;
      if (!invoiceSessionId) {
        invoiceSessionId = randomUUID();
        await c.query(`INSERT INTO ksef229_sessions(id,tenant_id,nip,environment,kind,state,reference_number,created_by,closed_at)
          VALUES($1,nullif(current_setting('app.tenant_id',true),'')::uuid,$2,$3,'online','closed',$4,$5,clock_timestamp())`, [invoiceSessionId, cfg.nip, cfg.environment, r.invoiceSession.ref, a.userId]);
        await event(c, { nip: cfg.nip, kind: 'session_open', session: invoiceSessionId, message: `Sesja ${r.invoiceSession.ref}, w której KSeF przyjął wcześniej ten plik (zgłoszony duplikat)`, actor: a.userId });
      }
    }
    const s = r.status;
    const sets: string[] = ['state=$2', 'lease_until=NULL', 'updated_at=clock_timestamp()', 'last_error=$3'], v: unknown[] = [sub.id, next.state, r.error ? short(r.error) : null];
    const add = (col: string, value: unknown) => { v.push(value); sets.push(`${col}=$${v.length}`); };
    // The reference and its session are set once (a handed-over invoice keeps its own).
    if (r.invoiceRef && invoiceSessionId && sub.reference_number === null) { add('reference_number', r.invoiceRef); add('session_id', invoiceSessionId); }
    if (s) { add('status_code', s.code); add('status_description', short(s.description, 1000)); add('status_details', JSON.stringify(s.details.slice(0, 20))); }
    if (next.state === 'accepted') { add('ksef_number', s!.ksefNumber); add('acquisition_at', s!.acquisitionDate ?? at.toISOString()); }
    if (next.state === 'accepted' && r.upo) { add('upo_xml', r.upo); sets.push(`upo_sha256=encode(sha256(convert_to($${v.length},'UTF8')),'hex')`, 'upo_at=clock_timestamp()'); }
    if (next.goOffline) {
      const off = offlineColumns(cfg, 'offline', fa3XmlFacts(xml), xml, at);
      add('issue_mode', 'offline'); add('offline_reason', off.reason); add('offline_at', at); add('send_deadline', off.deadline); add('qr_invoice_url', off.kod1); add('qr_certificate_url', off.kod2);
    }
    await c.query(`UPDATE ksef229_submissions SET ${sets.join(',')} WHERE id=$1`, v);
    const kind = next.state === 'rejected' ? 'refused' : r.outcome.kind === 'unavailable' ? 'unavailable' : r.outcome.kind === 'refused_before_send' ? 'error' : 'status';
    const note = r.note ? r.note + '. ' : '';
    const message = next.state === 'accepted' ? `${note}Nadano numer KSeF ${s!.ksefNumber}${r.upo ? '; pobrano UPO' : ''}`
      : r.outcome.kind === 'not_found' ? r.note!
      : r.outcome.kind === 'duplicate_unconfirmed' ? r.error!
      : next.goOffline ? `KSeF niedostępny (${r.error}); faktura przeszła w tryb offline, termin wysyłki ${warsawDay(at)} + 1 dzień roboczy`
      : s ? `${note}Status KSeF ${s.code}: ${s.description}` : (r.error ?? 'Brak odpowiedzi KSeF');
    await event(c, { nip: cfg.nip, kind, code: s?.code ?? null, submission: sub.id, session: invoiceSessionId ?? r.session?.id ?? sub.session_id, message, actor: a.userId });
    if (next.state === 'accepted') await audit(c, a, 'ksef.accepted', sub.document_id, { ksef_number: s!.ksefNumber, xml_sha256: sub.xml_sha256, ...(r.note ? { reconciled: true } : {}) });
    // Still open in KSeF (processing, or an uncertain send it could not be asked about): the
    // background status job reads it again; it never sends.
    const uncertain = next.state === 'queued' && r.outcome.kind === 'unavailable' && (r.session !== undefined || sendUncertain(sub));
    if (next.state === 'sent' || uncertain) await enqueueStatusJob(c, a, sub);
  });
}
async function enqueueStatusJob(c: PoolClient, a: KsefActor, sub: Sub) {
  const queued = (await c.query(`SELECT 1 FROM jobs WHERE kind='ksef.status' AND state IN ('pending','running') AND payload->>'submission_id'=$1 LIMIT 1`, [sub.id])).rowCount;
  if (queued) return;
  const jobId = randomUUID();
  await c.query(`INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,run_at,priority) VALUES($1,$2,'ksef.status',$3,$4,clock_timestamp()+interval '1 minute',90)`,
    [jobId, a.tenantId, JSON.stringify({ submission_id: sub.id, document_id: sub.document_id, actor_id: a.userId }), 'ksef.status:' + jobId]);
}

/** "Sprawdź status" of a handed-over or uncertain invoice, or the missing UPO of an accepted one. */
export async function refreshDocument(req: Fa3Request, a: KsefActor, id: string, o: Ksef229Options) {
  const live = await tenantReadTx(a.tenantId, c => liveInTx(c, id));
  ensure(live, 404, 'Ta faktura nie była wysyłana do KSeF');
  if (live.state === 'accepted' && !live.upo_sha256) {
    const { cfg, sessionRef } = await tenantReadTx(a.tenantId, async c => ({ cfg: await activeConfig(c, live.nip),
      sessionRef: (await c.query('SELECT reference_number FROM ksef229_sessions WHERE id=$1', [live.session_id])).rows[0]?.reference_number as string }));
    const client = clientOf(cfg, o, Date.now() + KSEF_ATTEMPT_BUDGET_MS);
    let upo: string;
    try { await client.authenticate(); upo = await client.fetchUpo(sessionRef, live.ksef_number!); }
    catch (e) { if (e instanceof KsefUnavailableError || e instanceof KsefRefusedError) throw new Problem(409, 'Nie udało się pobrać UPO: ' + e.message); throw e; }
    await tenantTx(a.tenantId, async c => {
      await c.query(`UPDATE ksef229_submissions SET upo_xml=$2,upo_sha256=encode(sha256(convert_to($2,'UTF8')),'hex'),upo_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND upo_xml IS NULL`, [live.id, upo]);
      await event(c, { nip: live.nip, kind: 'upo', submission: live.id, message: 'Pobrano UPO', actor: a.userId });
    });
    return documentKsef(a, id, o);
  }
  if (sendUncertain(live)) return reconcileDocument(a, id, o);
  ensure(live.state === 'sent', 409, live.state === 'accepted' ? 'Faktura ma już numer KSeF i UPO' : 'Faktura czeka na wysyłkę — użyj „Wyślij do KSeF”');
  return sendDocument(req, a, id, o);
}

export async function downloadOf(a: KsefActor, id: string, what: 'upo' | 'xml') {
  const r = (await tenantReadTx(a.tenantId, c => c.query(`SELECT document_number,ksef_number,upo_xml,xml FROM ksef229_submissions WHERE document_id=$1 AND state<>'rejected'`, [id]))).rows[0];
  ensure(r, 404, 'Ta faktura nie była wysyłana do KSeF');
  const base = String(r.document_number).replace(/[^A-Za-z0-9._-]/g, '_');
  if (what === 'upo') { ensure(r.upo_xml, 404, 'UPO nie zostało jeszcze pobrane'); return { body: r.upo_xml as string, filename: `UPO-${r.ksef_number}.xml` }; }
  return { body: r.xml as string, filename: `${base}.ksef.xml` };
}

/** "Kolejka KSeF": invoices to send or still processed, and rejected ones without a newer submission. */
export async function queueInTx(c: PoolClient, today: string) {
  const rows = (await c.query(`SELECT ${SUB_COLUMNS} FROM ksef229_submissions s WHERE state IN ('queued','sent')
    OR state='rejected' AND NOT EXISTS(SELECT FROM ksef229_submissions n WHERE n.document_id=s.document_id AND n.created_at>s.created_at)
    ORDER BY CASE state WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END,send_deadline NULLS LAST,created_at LIMIT 200`)).rows as Sub[];
  return rows.map(s => ({ id: s.id, document_id: s.document_id, document_number: s.document_number, document_kind: s.document_kind, nip: s.nip, state: s.state, state_label: STATE_LABELS[s.state],
    issue_mode: s.issue_mode, offline_reason: s.offline_reason, deadline: s.send_deadline, overdue: s.state === 'queued' && overdue(s.send_deadline, today),
    attempts: s.attempts, last_error: s.last_error, status: s.status_code === null ? null : { code: s.status_code, description: s.status_description }, created_at: iso(s.created_at) }));
}
/** Retry of queued and processed invoices (oldest deadline first), one after another. */
export async function sendQueue(req: Fa3Request, a: KsefActor, ids: string[] | undefined, o: Ksef229Options) {
  const docs = (await tenantReadTx(a.tenantId, c => c.query(`SELECT document_id FROM ksef229_submissions WHERE state IN ('queued','sent') ${ids ? 'AND id=ANY($1::uuid[])' : ''}
    ORDER BY send_deadline NULLS LAST,created_at LIMIT 50`, ids ? [ids] : []))).rows.map(r => r.document_id as string);
  const results: { document_id: string; ok: boolean; state: string | null; ksef_number: string | null; message: string | null }[] = [];
  for (const d of docs) {
    try { const v = await sendDocument(req, a, d, o); results.push({ document_id: d, ok: v.submission?.state === 'accepted', state: v.submission?.state ?? null, ksef_number: v.submission?.ksef_number ?? null, message: v.submission?.last_error ?? null }); }
    catch (e) { if (!(e instanceof Problem)) throw e; results.push({ document_id: d, ok: false, state: null, ksef_number: null, message: e.message }); }
  }
  return { attempted: docs.length, accepted: results.filter(r => r.ok).length, results };
}
