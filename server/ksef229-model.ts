/** Pure rules of the 229 KSeF step: the settings input, FA(3) XML checks before a send,
 * business days and the offline send deadlines, the KOD I / KOD II QR links of an offline
 * invoice, the masked view of a setting and the submission state a reader sees.
 * Offline rules implemented (ustawa o VAT as amended for KSeF 2.0, MF "Podręcznik KSeF 2.0"):
 * - offline24 (art. 106nda): chosen by the taxpayer; send by the next business day after the issue date (P_1);
 * - offline (art. 106nh, KSeF unavailable): send by the next business day after the unavailability ends; the app
 *   cannot know the end, so it counts from the day the failure was detected (never later than the law);
 * - awaryjny (art. 106nf, emergency mode announced by MF): send within 7 business days after the announced end;
 *   without an end date the deadline stays open until it is given.
 * Business days: Monday–Friday except the public holidays of ustawa o dniach wolnych od pracy (24 December from 2025). */
import { z } from 'zod';
import { Problem } from './errors';
import { KSEF_LOCAL_FAKE_OFF, KSEF_QR_BASE, ksefLocalFakeAllowed, ksefLocalFakePathOk, type KsefEnvironment } from './ksef229-client';
import { sha256Base64Url, signCertificateQrPath } from './ksef229-crypto';
import type { KeyObject } from 'node:crypto';

export const KSEF229_FA3_NAMESPACE = 'http://crd.gov.pl/wzor/2025/06/25/13775/';
export const KSEF229_MAX_XML_BYTES = 3 * 1024 * 1024;
export type KsefIssueMode = 'online' | 'offline24' | 'offline' | 'awaryjny';
export type KsefState = 'queued' | 'sent' | 'accepted' | 'rejected';

/** Polish NIP with its checksum. */
export function validNip(nip: string): boolean {
  if (!/^[0-9]{10}$/.test(nip)) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7], sum = w.reduce((s, x, i) => s + x * Number(nip[i]), 0) % 11;
  return sum !== 10 && sum === Number(nip[9]);
}
const nip = z.string().trim().refine(validNip, 'Podaj poprawny NIP: 10 cyfr z prawidłową sumą kontrolną');
const pem = (label: string) => z.string().trim().max(20000).regex(/^-----BEGIN [A-Z0-9 ]+-----[\s\S]+-----END [A-Z0-9 ]+-----$/, `${label}: wklej treść w formacie PEM`);
const serial = z.string().trim().regex(/^[0-9A-Fa-f]{1,64}$/, 'Numer seryjny certyfikatu: cyfry szesnastkowe');
/** PUT body. A missing secret keeps the stored one; switching the method requires a new one. */
export const ksefConfigInput = z.strictObject({
  environment: z.enum(['local_fake', 'test', 'demo', 'prod'], 'Wybierz środowisko KSeF'),
  base_url: z.string().trim().max(200).optional(),
  auth_method: z.enum(['token', 'certificate'], 'Wybierz sposób uwierzytelnienia'),
  token: z.string().trim().min(8, 'Token KSeF jest za krótki').max(1000).optional(),
  certificate_pem: pem('Certyfikat').optional(),
  private_key_pem: pem('Klucz prywatny').optional(),
  certificate_serial: serial.optional(),
  offline_certificate_pem: pem('Certyfikat offline').optional(),
  offline_private_key_pem: pem('Klucz prywatny certyfikatu offline').optional(),
  offline_certificate_serial: serial.optional(),
  active: z.boolean().default(true),
}).superRefine((v, ctx) => {
  const local = v.environment === 'local_fake';
  if (local && !ksefLocalFakeAllowed()) ctx.addIssue({ code: 'custom', message: KSEF_LOCAL_FAKE_OFF });
  else if (local && v.base_url && !ksefLocalFakePathOk(v.base_url)) ctx.addIssue({ code: 'custom', message: 'Adres lokalnego serwera KSeF: ścieżka bez "..", "//" i znaków %' });
  if (local && !(v.base_url && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(v.base_url)))
    ctx.addIssue({ code: 'custom', message: 'Lokalny serwer KSeF musi mieć adres http://127.0.0.1:PORT/v2 (tylko ten komputer)' });
  if (!local && v.base_url) ctx.addIssue({ code: 'custom', message: 'Adres środowiska MF jest stały; nie podawaj go ręcznie' });
  if (v.auth_method === 'token' && (v.certificate_pem || v.private_key_pem)) ctx.addIssue({ code: 'custom', message: 'Przy tokenie nie podawaj certyfikatu' });
  if (v.auth_method === 'certificate' && v.token) ctx.addIssue({ code: 'custom', message: 'Przy certyfikacie nie podawaj tokenu' });
  if (Boolean(v.certificate_pem) !== Boolean(v.private_key_pem)) ctx.addIssue({ code: 'custom', message: 'Podaj certyfikat razem z kluczem prywatnym' });
  if (v.certificate_pem && !v.certificate_serial) ctx.addIssue({ code: 'custom', message: 'Podaj numer seryjny certyfikatu' });
  const off = [v.offline_certificate_pem, v.offline_private_key_pem, v.offline_certificate_serial].filter(Boolean).length;
  if (off !== 0 && off !== 3) ctx.addIssue({ code: 'custom', message: 'Certyfikat offline wymaga certyfikatu, klucza prywatnego i numeru seryjnego' });
});
export type KsefConfigInput = z.infer<typeof ksefConfigInput>;
export const ksefNipParam = z.strictObject({ nip });
export const ksefOfflineInput = z.strictObject({
  mode: z.enum(['offline24', 'awaryjny'], 'Wybierz tryb: offline24 albo awaryjny'),
  emergency_end: z.iso.date('Data zakończenia trybu awaryjnego: RRRR-MM-DD').optional(),
}).refine(v => v.mode === 'awaryjny' || v.emergency_end === undefined, 'Datę zakończenia podaje się tylko dla trybu awaryjnego');
export const ksefQueueInput = z.strictObject({ ids: z.array(z.uuid()).min(1).max(50).optional() });

/** Secret kept encrypted (security.ts encrypt). */
export type KsefSecret = { token?: string; certificate_pem?: string; private_key_pem?: string; offline_certificate_pem?: string; offline_private_key_pem?: string };

// ---------- FA(3) XML ----------
export type Fa3Facts = { sellerNip: string; number: string; issueDate: string };
/** Facts read from our own generated FA(3) file; refuses a file that is not FA(3). */
export function fa3XmlFacts(xml: string): Fa3Facts {
  const bytes = Buffer.byteLength(xml, 'utf8');
  const fail = (why: string): never => { throw new Problem(422, 'Plik nie jest poprawną fakturą FA(3): ' + why); };
  if (!bytes || bytes > KSEF229_MAX_XML_BYTES) fail('rozmiar pliku');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('niedozwolona deklaracja DTD');
  if (!/^(<\?xml[^>]*\?>\s*)?<Faktura xmlns="http:\/\/crd\.gov\.pl\/wzor\/2025\/06\/25\/13775\/">/.test(xml) || !/<\/Faktura>\s*$/.test(xml)) fail('brak elementu Faktura w przestrzeni FA(3)');
  if (!/<KodFormularza kodSystemowy="FA \(3\)" wersjaSchemy="1-0E">FA<\/KodFormularza>/.test(xml)) fail('kod formularza inny niż FA (3)');
  const seller = /<Podmiot1>(?:(?!<\/Podmiot1>).)*?<NIP>([0-9]{10})<\/NIP>/s.exec(xml)?.[1], number = /<P_2>([^<]{1,256})<\/P_2>/.exec(xml)?.[1], issue = /<P_1>([0-9]{4}-[0-9]{2}-[0-9]{2})<\/P_1>/.exec(xml)?.[1];
  if (!seller) fail('brak NIP sprzedawcy (Podmiot1)');
  if (!number) fail('brak numeru faktury (P_2)');
  if (!issue) fail('brak daty wystawienia (P_1)');
  return { sellerNip: seller!, number: unescapeXml(number!), issueDate: issue! };
}
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// ---------- business days ----------
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(s + 'T00:00:00Z');
const plus = (s: string, n: number) => { const d = day(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
function easter(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    month = Math.floor((h + l - 7 * m + 114) / 31), dd = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
/** Public holidays of a year (ustawa z 18.01.1951 o dniach wolnych od pracy). */
export function polishHolidays(y: number): Set<string> {
  const e = easter(y), fixed = ['01-01', '01-06', '05-01', '05-03', '08-15', '11-01', '11-11', '12-25', '12-26', ...(y >= 2025 ? ['12-24'] : [])];
  return new Set([...fixed.map(md => `${y}-${md}`), e, plus(e, 1), plus(e, 49), plus(e, 60)]);
}
export function isBusinessDay(s: string): boolean {
  const w = day(s).getUTCDay();
  return w !== 0 && w !== 6 && !polishHolidays(Number(s.slice(0, 4))).has(s);
}
/** The n-th business day after the day s (n ≥ 1). */
export function addBusinessDays(s: string, n: number): string {
  let d = s;
  for (let left = n; left > 0;) { d = plus(d, 1); if (isBusinessDay(d)) left--; }
  return d;
}
/** Warsaw calendar day of an instant. */
export const warsawDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
/** Send deadline of an offline invoice; null for an emergency without its end date. */
export function offlineDeadline(mode: Exclude<KsefIssueMode, 'online'>, o: { issueDate: string; detectedDay: string; emergencyEnd?: string | undefined }): string | null {
  if (mode === 'offline24') return addBusinessDays(o.issueDate, 1);
  if (mode === 'offline') return addBusinessDays(o.detectedDay > o.issueDate ? o.detectedDay : o.issueDate, 1);
  return o.emergencyEnd ? addBusinessDays(o.emergencyEnd, 7) : null;
}
export const OFFLINE_REASONS: Record<Exclude<KsefIssueMode, 'online'>, string> = {
  offline24: 'Tryb offline24 wybrany przez wystawcę (art. 106nda)',
  offline: 'KSeF niedostępny przy wysyłce (art. 106nh)',
  awaryjny: 'Tryb awaryjny ogłoszony przez MF (art. 106nf)',
};

// ---------- QR codes ----------
/** QR host of the environment; the local fake serves its own /qr pages. */
export function qrBase(environment: KsefEnvironment, baseUrl: string | null): string {
  if (environment === 'local_fake') return new URL(baseUrl!).origin + '/qr';
  return KSEF_QR_BASE[environment];
}
const plDay = (s: string) => `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}`;
/** KOD I: verification of the invoice, {base}/invoice/{seller NIP}/{P_1 DD-MM-YYYY}/{SHA-256 of the file, base64url}. */
export function kodIUrl(base: string, facts: Fa3Facts, xml: string): string {
  return `${base}/invoice/${facts.sellerNip}/${plDay(facts.issueDate)}/${sha256Base64Url(Buffer.from(xml, 'utf8'))}`;
}
/** KOD II: the issuer's offline certificate, {base}/certificate/Nip/{context NIP}/{seller NIP}/{serial}/{hash}/{signature of the URL without the scheme}. */
export function kodIIUrl(base: string, contextNip: string, facts: Fa3Facts, xml: string, cert: { serial: string; privateKey: KeyObject }): string {
  const path = `${base}/certificate/Nip/${contextNip}/${facts.sellerNip}/${cert.serial}/${sha256Base64Url(Buffer.from(xml, 'utf8'))}`;
  return path + '/' + signCertificateQrPath(path.replace(/^https?:\/\//, ''), cert.privateKey);
}

// ---------- views ----------
export type KsefConfigRow = { nip: string; environment: KsefEnvironment; base_url: string | null; auth_method: 'token' | 'certificate'; secret_fingerprint: string;
  certificate_serial: string | null; offline_certificate_serial: string | null; active: boolean; updated_at: unknown };
/** A setting as the API returns it: never the secret, only that it is stored and its fingerprint. */
export function maskedConfig(r: KsefConfigRow) {
  return { nip: r.nip, environment: r.environment, base_url: r.base_url, auth_method: r.auth_method, active: r.active,
    secret: { stored: true, masked: '••••••••', fingerprint: r.secret_fingerprint }, certificate_serial: r.certificate_serial,
    offline_certificate: r.offline_certificate_serial ? { serial: r.offline_certificate_serial } : null,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at };
}
export const STATE_LABELS: Record<KsefState, string> = { queued: 'Do wysłania', sent: 'Wysłana — przetwarzanie w KSeF', accepted: 'Przyjęta w KSeF', rejected: 'Odrzucona przez KSeF' };
/** Whether a deadline has passed on the Warsaw day `today`. */
export const overdue = (deadline: string | null, today: string) => Boolean(deadline && deadline < today);

// ---------- state machine (mirrors ksef229_submission_guard) ----------
/** What a send request does with the document's live submission. */
export type LiveDecision = 'create' | 'return' | 'send' | 'poll' | 'busy';
export function liveDecision(live: { state: KsefState; lease_until: Date | string | null } | null, now: Date): LiveDecision {
  if (!live) return 'create';
  if (live.lease_until && new Date(live.lease_until) > now) return 'busy';
  return live.state === 'accepted' ? 'return' : live.state === 'sent' ? 'poll' : 'send';
}
export type SendOutcome =
  | { kind: 'accepted' } | { kind: 'rejected' } | { kind: 'processing' }
  | { kind: 'unavailable'; referenced: boolean } | { kind: 'refused_before_send' }
  /** KSeF answered 440 "Duplikat" but the original could not be confirmed by its hash: never resent, never rejected. */
  | { kind: 'duplicate_unconfirmed' }
  /** A read-only reconciliation found no trace of the file in the session of the last send. */
  | { kind: 'not_found' };
/** State after one attempt; an online invoice that KSeF could not take becomes an offline one. */
export function afterAttempt(s: { state: KsefState; issue_mode: KsefIssueMode }, o: SendOutcome): { state: KsefState; goOffline: boolean } {
  if (s.state === 'accepted' || s.state === 'rejected') throw new Error('Wysyłka KSeF jest już zakończona');
  switch (o.kind) {
    case 'accepted': return { state: 'accepted', goOffline: false };
    case 'rejected': return { state: 'rejected', goOffline: false };
    case 'processing': return { state: 'sent', goOffline: false };
    case 'unavailable': return o.referenced || s.state === 'sent' ? { state: 'sent', goOffline: false } : { state: 'queued', goOffline: s.issue_mode === 'online' };
    case 'refused_before_send': case 'duplicate_unconfirmed': case 'not_found': return { state: s.state, goOffline: false };
  }
}

// ---------- uncertain sends (RES-04) ----------
/** A send whose outcome is unknown: the session was stored before sendInvoice, but no invoice
 * reference came back (lost answer, timeout, crash). Its next attempt must look for the file in
 * that session before anything is sent again. */
export function sendUncertain(s: { state: KsefState; session_id: string | null; reference_number: string | null }): boolean {
  return s.state === 'queued' && s.session_id !== null && s.reference_number === null;
}
const KSEF_NUMBER = /\b[0-9]{10}-[0-9]{8}-[0-9A-F]{12}-[0-9A-F]{2}\b/;
const SESSION_REF = /\b[0-9]{8}-SO-[0-9A-F]{10}-[0-9A-F]{10}-[0-9A-F]{2}\b/;
/** What a 440 "Duplikat faktury" status says about the original: its KSeF number and the session
 * it was accepted in, read from the description and details (the exact MF wording is unconfirmed). */
export function duplicateOf(st: { code: number; description: string; details: string[] }): { ksefNumber: string | null; sessionRef: string | null } | null {
  if (st.code !== 440) return null;
  const text = [st.description, ...st.details].join('\n');
  return { ksefNumber: KSEF_NUMBER.exec(text)?.[0] ?? null, sessionRef: SESSION_REF.exec(text)?.[0] ?? null };
}
/** Upper bound of one send attempt (every request and wait of the client); the send lease is longer,
 * so a second attempt cannot start while the first may still be talking to KSeF. */
export const KSEF_ATTEMPT_BUDGET_MS = 110_000;
export const KSEF_LEASE_SECONDS = 240;
