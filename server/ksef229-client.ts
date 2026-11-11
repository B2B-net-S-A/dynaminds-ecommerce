/** KSeF 2.0 HTTP client (no DB): challenge → public key certificates → KSeF token (RSA-OAEP)
 * or XAdES login → auth status poll → token redeem; online session (AES key under RSA-OAEP),
 * encrypted FA (3) send, status poll, UPO, close. This local build talks only to the loopback
 * fake: test/demo/prod are refused while KSEF_REAL_ENABLED is false. Secrets (KSeF token,
 * private key, authentication/access/refresh tokens) live in private fields and are redacted
 * from every Error. Every request has a timeout; 429/503 get one quick retry. An optional overall
 * deadline bounds a whole attempt (every request and wait), so a caller's lease can outlast it.
 * An expired access token is renewed with /auth/token/refresh; a full login only when that fails. */
import type { KeyObject } from 'node:crypto';
import { encryptInvoice, encryptKsefToken, mfPublicKeyFrom, newSessionKey, rsaOaepEncrypt, sha256Base64, signAuthTokenRequest } from './ksef229-crypto';

export type KsefEnvironment = 'local_fake' | 'test' | 'demo' | 'prod';
export const KSEF_BASE_URLS: Record<'test' | 'demo' | 'prod', string> = { test: 'https://api-test.ksef.mf.gov.pl/v2', demo: 'https://api-demo.ksef.mf.gov.pl/v2', prod: 'https://api.ksef.mf.gov.pl/v2' };
export const KSEF_QR_BASE: Record<'test' | 'demo' | 'prod', string> = { test: 'https://qr-test.ksef.mf.gov.pl', demo: 'https://qr-demo.ksef.mf.gov.pl', prod: 'https://qr.ksef.mf.gov.pl' };
/** This local build never connects to MF. */
export const KSEF_REAL_ENABLED: boolean = false;
/** The loopback fake server (local_fake) points this server at a port of its own machine, so an org
 * admin must not choose it unless the installation allows it (SR4-M1): DYNA_KSEF_FAKE=local, or the
 * isolated test mode DYNA_TEST=true; never with NODE_ENV=production. Off by default. */
export function ksefLocalFakeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' && (env.DYNA_KSEF_FAKE === 'local' || env.DYNA_TEST === 'true');
}
export const KSEF_LOCAL_FAKE_OFF = 'Lokalny serwer KSeF jest wyłączony w tej instalacji (włącza go operator: DYNA_KSEF_FAKE=local)';
/** Path of a local_fake address as typed: no "..", no "//", no percent-escapes (the URL parser would resolve them). */
const LOCAL_FAKE_PATH = /^(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)*\/?$/;
export function ksefLocalFakePathOk(raw: string): boolean {
  const m = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?(.*)$/i.exec(raw);
  return Boolean(m && LOCAL_FAKE_PATH.test(m[1]!));
}

export type KsefCredentials = { method: 'token'; token: string } | { method: 'certificate'; certificatePem: string; privateKeyPem: string };
/** KSeF cannot be reached right now: 5xx, 429 after the retry, timeout or connection error. */
export class KsefUnavailableError extends Error {
  constructor(public readonly kind: 'timeout' | 'network' | 'server', public readonly status: number | null, message: string) { super(message); this.name = 'KsefUnavailableError'; }
}
/** KSeF refused the request (HTTP 4xx with an exception body) or the authentication (status
 * code ≥ 300 of GET /auth/{ref}; then `status` is that response's HTTP status and `code` the
 * KSeF auth status code). */
export class KsefRefusedError extends Error {
  constructor(public readonly status: number, public readonly code: number | null, public readonly description: string, public readonly details: string[]) {
    super(`KSeF odrzucił żądanie${code === null ? '' : ` (kod ${code})`}: ${description}`); this.name = 'KsefRefusedError';
  }
}
export type KsefInvoiceStatus = { code: number; description: string; details: string[]; ksefNumber: string | null; acquisitionDate: string | null; invoiceNumber: string | null; referenceNumber: string; upoAvailable: boolean };
/** One invoice of a session listing, with the base64 SHA-256 of its file. */
export type KsefSessionInvoice = KsefInvoiceStatus & { invoiceHash: string | null };
export type KsefSession = { referenceNumber: string; validUntil: string | null; key: Buffer; iv: Buffer };
export type KsefClientOptions = {
  environment: KsefEnvironment; /** required for local_fake: http(s)://127.0.0.1|localhost|[::1] */ baseUrl?: string; nip: string; credentials: KsefCredentials;
  fetch?: typeof fetch; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; pollDelaysMs?: number[];
  /** Clock for token expiry and the deadline (tests). */ now?: () => number;
  /** Absolute time (ms, same clock) after which no request starts and running ones are aborted. */ deadline?: number;
};
export type KsefAuthResult = { accessToken: string; accessValidUntil: string | null; refreshToken: string | null; referenceNumber: string };
export type KsefConnectionCheck = { steps: { name: string; ok: boolean; ms: number }[]; accessValidUntil: string | null; /** Polish reason of the failed step */ problem: string | null };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Longest single wait of the 429/503 retry. */
export const KSEF_RETRY_WAIT_MAX_MS = 2000;
const LIST_PAGE_SIZE = 100, LIST_MAX_PAGES = 50;
/** API base URL; test/demo/prod throw while KSEF_REAL_ENABLED is false, local_fake must be loopback. */
export function ksefBaseUrl(environment: KsefEnvironment, baseUrl?: string): string {
  if (environment === 'local_fake') {
    if (!ksefLocalFakeAllowed()) throw new Error(KSEF_LOCAL_FAKE_OFF);
    let u: URL;
    try { u = new URL(baseUrl ?? ''); } catch { throw new Error('Adres lokalnego KSeF jest nieprawidłowy'); }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK.has(u.hostname) || u.username || u.password || u.search || u.hash)
      throw new Error('Lokalny KSeF musi działać pod adresem 127.0.0.1, localhost albo [::1]');
    if (!ksefLocalFakePathOk(baseUrl!)) throw new Error('Adres lokalnego KSeF: ścieżka bez "..", "//" i znaków %');
    return (u.origin + u.pathname).replace(/\/+$/, '');
  }
  if (!Object.hasOwn(KSEF_BASE_URLS, environment)) throw new Error('Nieznane środowisko KSeF');
  if (!KSEF_REAL_ENABLED) throw new Error('Połączenie z KSeF Ministerstwa Finansów jest wyłączone w tej lokalnej wersji');
  return KSEF_BASE_URLS[environment];
}

const FORM_CODE = { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' };
const AUTH_NS = 'http://ksef.mf.gov.pl/auth/token/2.0';
const xmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const seg = encodeURIComponent;
type Json = Record<string, unknown>;
type Req = { method: 'GET' | 'POST'; path: string; bearer?: string; json?: unknown; xml?: string; accept?: string; headers?: Record<string, string> };
type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
type PublicKeyEntry = { key: KeyObject; usage: string[]; validFrom: number; validTo: number };
const bad = (status: number | null) => new KsefUnavailableError('server', status, 'KSeF zwrócił odpowiedź w nieoczekiwanym formacie');
const str = (v: unknown, status: number): string => { if (typeof v !== 'string' || !v) throw bad(status); return v; };
const optStr = (v: unknown): string | null => typeof v === 'string' && v ? v : null;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
/** An invoice status object of KSeF (single status read or one element of a session listing). */
function invoiceOf(v: Json, fallbackRef: string): KsefSessionInvoice {
  const st = v.status as Json | undefined;
  if (typeof st?.code !== 'number') throw bad(200);
  const ksefNumber = optStr(v.ksefNumber), referenceNumber = optStr(v.referenceNumber) ?? fallbackRef;
  if (!referenceNumber) throw bad(200);
  return { code: st.code, description: typeof st.description === 'string' ? st.description : '', details: strings(st.details), ksefNumber, acquisitionDate: optStr(v.acquisitionDate),
    invoiceNumber: optStr(v.invoiceNumber), referenceNumber, upoAvailable: st.code === 200 && ksefNumber !== null, invoiceHash: optStr(v.invoiceHash) };
}

export class KsefClient {
  readonly environment: KsefEnvironment;
  readonly nip: string;
  readonly #base: string;
  readonly #credentials: KsefCredentials;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pollDelays: number[];
  readonly #now: () => number;
  readonly #deadline: number;
  #access: { token: string; refresh: string | null; expiresAt: number; refreshExpiresAt: number } | null = null;
  #authToken: string | null = null;
  #keys: PublicKeyEntry[] | null = null;

  constructor(o: KsefClientOptions) {
    this.#base = ksefBaseUrl(o.environment, o.baseUrl);
    if (typeof o.nip !== 'string' || !/^\d{10}$/.test(o.nip)) throw new Error('Nieprawidłowy NIP kontekstu KSeF');
    const c = o.credentials;
    if (!c || (c.method === 'token' ? typeof c.token !== 'string' || !c.token : c.method !== 'certificate' || !c.certificatePem || !c.privateKeyPem)) throw new Error('Brak danych uwierzytelniających KSeF');
    const timeout = o.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error('Nieprawidłowy limit czasu połączenia z KSeF');
    this.environment = o.environment; this.nip = o.nip; this.#credentials = c; this.#fetch = o.fetch ?? fetch; this.#timeoutMs = timeout;
    this.#sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms))); this.#pollDelays = [...(o.pollDelaysMs ?? [500, 1000, 2000, 4000, 8000])];
    this.#now = o.now ?? Date.now; this.#deadline = o.deadline ?? Infinity;
  }
  /** Time left before the deadline; throws once it has passed. */
  #left(): number {
    const left = this.#deadline - this.#now();
    if (left <= 0) throw new KsefUnavailableError('timeout', null, 'Przekroczono łączny czas próby połączenia z KSeF');
    return left;
  }
  async #wait(ms: number) { await this.#sleep(Math.min(ms, this.#left())); }

  #secrets(): string[] {
    const c = this.#credentials, s = [this.#access?.token, this.#access?.refresh, this.#authToken, c.method === 'token' ? c.token : c.privateKeyPem];
    return s.filter((x): x is string => typeof x === 'string' && x.length > 0);
  }
  #redact(text: string): string { let t = text; for (const s of this.#secrets()) t = t.split(s).join('***'); return t; }

  async #once(r: Req): Promise<{ status: number; text: string; retryAfter: string | null }> {
    const left = this.#left(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), Math.min(this.#timeoutMs, left));
    const headers: Record<string, string> = { Accept: r.accept ?? 'application/json', ...r.headers };
    if (r.bearer) headers.Authorization = `Bearer ${r.bearer}`;
    let body: string | undefined;
    if (r.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(r.json); }
    else if (r.xml !== undefined) { headers['Content-Type'] = 'application/xml'; body = r.xml; }
    try {
      const res = await this.#fetch(this.#base + r.path, { method: r.method, headers, body, signal: ctl.signal, redirect: 'error' });
      return { status: res.status, text: await res.text(), retryAfter: res.headers.get('retry-after') };
    } catch {
      if (ctl.signal.aborted) throw new KsefUnavailableError('timeout', null, 'KSeF nie odpowiedział w wyznaczonym czasie');
      throw new KsefUnavailableError('network', null, 'Brak połączenia z KSeF');
    } finally { clearTimeout(timer); }
  }
  async #request(r: Req): Promise<{ status: number; text: string }> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.#once(r);
      if ((res.status === 429 || res.status === 503) && attempt === 0) {
        const after = Number(res.retryAfter); await this.#wait(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, KSEF_RETRY_WAIT_MAX_MS) : 300); continue;
      }
      if (res.status >= 200 && res.status < 300) return res;
      if (res.status >= 500 || res.status === 429) throw new KsefUnavailableError('server', res.status, `KSeF jest chwilowo niedostępny (HTTP ${res.status})`);
      throw this.#refused(res.status, res.text);
    }
  }
  #refused(status: number, text: string): KsefRefusedError {
    let code: number | null = null, description = `Żądanie odrzucone (HTTP ${status})`, details: string[] = [];
    try {
      const v = JSON.parse(text) as { exception?: { exceptionDetailList?: { exceptionCode?: unknown; exceptionDescription?: unknown; details?: unknown }[] }; title?: unknown; detail?: unknown };
      const list = Array.isArray(v?.exception?.exceptionDetailList) ? v.exception.exceptionDetailList : [];
      if (list[0]) {
        code = typeof list[0].exceptionCode === 'number' ? list[0].exceptionCode : null;
        if (typeof list[0].exceptionDescription === 'string' && list[0].exceptionDescription) description = list[0].exceptionDescription;
        details = list.flatMap((e, i) => [...(i > 0 && typeof e.exceptionDescription === 'string' ? [e.exceptionDescription] : []), ...strings(e.details)]);
      } else if (typeof v?.title === 'string') { description = v.title; if (typeof v.detail === 'string') details = [v.detail]; }
    } catch { /* not a KSeF exception body; keep the HTTP status text */ }
    return new KsefRefusedError(status, code, this.#redact(description), details.map(d => this.#redact(d)));
  }
  async #json(r: Req): Promise<Json> {
    const res = await this.#request(r);
    try { const v = JSON.parse(res.text); if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json; } catch { /* fall through */ }
    throw bad(res.status);
  }

  async #publicKeys(): Promise<PublicKeyEntry[]> {
    if (this.#keys) return this.#keys;
    const res = await this.#request({ method: 'GET', path: '/security/public-key-certificates' });
    let list: unknown;
    try { list = JSON.parse(res.text); } catch { throw bad(res.status); }
    if (!Array.isArray(list)) throw bad(res.status);
    const keys = list.map((e: Json) => {
      const from = Date.parse(String(e?.validFrom ?? '')), to = Date.parse(String(e?.validTo ?? ''));
      let key: KeyObject;
      try { key = mfPublicKeyFrom(str(e?.certificate, res.status)); } catch { throw bad(res.status); }
      return { key, usage: strings(e?.usage), validFrom: Number.isNaN(from) ? -Infinity : from, validTo: Number.isNaN(to) ? Infinity : to };
    });
    this.#keys = keys;
    return keys;
  }
  #key(keys: PublicKeyEntry[], usage: 'KsefTokenEncryption' | 'SymmetricKeyEncryption'): KeyObject {
    const now = Date.now(), k = keys.find(e => e.usage.includes(usage) && e.validFrom <= now && now <= e.validTo);
    if (!k) throw new KsefUnavailableError('server', null, 'KSeF nie udostępnia ważnego klucza publicznego do szyfrowania');
    return k.key;
  }

  async #auth(step: Step): Promise<KsefAuthResult> {
    const ch = await step('auth/challenge', async () => {
      const v = await this.#json({ method: 'POST', path: '/auth/challenge', json: {} });
      const ms = typeof v.timestampMs === 'number' ? v.timestampMs : Date.parse(String(v.timestamp));
      if (!Number.isSafeInteger(ms)) throw bad(200);
      return { challenge: str(v.challenge, 200), timestampMs: ms };
    });
    const keys = await step('security/public-key-certificates', () => this.#publicKeys());
    const started = await step('auth', async () => {
      const c = this.#credentials;
      const v = c.method === 'token'
        ? await this.#json({ method: 'POST', path: '/auth/ksef-token', json: { challenge: ch.challenge, contextIdentifier: { type: 'Nip', value: this.nip }, encryptedToken: encryptKsefToken(c.token, ch.timestampMs, this.#key(keys, 'KsefTokenEncryption')) } })
        : await this.#json({ method: 'POST', path: '/auth/xades-signature', xml: signAuthTokenRequest(`<?xml version="1.0" encoding="utf-8"?><AuthTokenRequest xmlns="${AUTH_NS}"><Challenge>${xmlText(ch.challenge)}</Challenge><ContextIdentifier><Nip>${this.nip}</Nip></ContextIdentifier><SubjectIdentifierType>certificateSubject</SubjectIdentifierType></AuthTokenRequest>`, c.certificatePem, c.privateKeyPem) });
      const at = v.authenticationToken as Json | undefined, ref = str(v.referenceNumber, 200);
      this.#authToken = str(at?.token, 200);
      for (let i = 0; ; i++) {
        const s = await this.#json({ method: 'GET', path: `/auth/${seg(ref)}`, bearer: this.#authToken });
        const st = s.status as Json | undefined, code = st?.code;
        if (typeof code !== 'number') throw bad(200);
        if (code === 200) return ref;
        if (code !== 100) throw new KsefRefusedError(200, code, this.#redact(typeof st?.description === 'string' ? st.description : 'Uwierzytelnianie zakończone niepowodzeniem'), strings(st?.details).map(d => this.#redact(d)));
        if (i >= this.#pollDelays.length) throw new KsefUnavailableError('timeout', null, 'KSeF nie zakończył uwierzytelniania w oczekiwanym czasie');
        await this.#wait(this.#pollDelays[i]!);
      }
    });
    return step('auth/token/redeem', async () => {
      const v = await this.#json({ method: 'POST', path: '/auth/token/redeem', bearer: this.#authToken! });
      const a = v.accessToken as Json | undefined, r = v.refreshToken as Json | undefined;
      const token = str(a?.token, 200), validUntil = optStr(a?.validUntil), refresh = optStr(r?.token), until = validUntil ? Date.parse(validUntil) : NaN;
      const refreshUntil = Date.parse(optStr(r?.validUntil) ?? '');
      this.#access = { token, refresh, expiresAt: Number.isNaN(until) ? 0 : until - 60_000, refreshExpiresAt: Number.isNaN(refreshUntil) ? 0 : refreshUntil - 60_000 };
      this.#authToken = null;
      return { accessToken: token, accessValidUntil: validUntil, refreshToken: refresh, referenceNumber: started };
    });
  }
  /** Full login; the access token is cached until validUntil − 60 s. */
  authenticate(): Promise<KsefAuthResult> { return this.#auth((_, fn) => fn()); }
  /** A valid access token: the cached one, a refreshed one (POST /auth/token/refresh with the
   * refresh token), or — when there is none or KSeF refuses the refresh — a full login. */
  async #accessToken(): Promise<string> {
    const a = this.#access, now = this.#now();
    if (a && now < a.expiresAt) return a.token;
    if (a?.refresh && now < a.refreshExpiresAt) {
      try {
        const v = await this.#json({ method: 'POST', path: '/auth/token/refresh', bearer: a.refresh });
        const t = v.accessToken as Json | undefined, token = str(t?.token, 200), until = Date.parse(optStr(t?.validUntil) ?? '');
        this.#access = { ...a, token, expiresAt: Number.isNaN(until) ? 0 : until - 60_000 };
        return token;
      } catch (e) { if (!(e instanceof KsefRefusedError)) throw e; this.#access = null; }
    }
    return (await this.authenticate()).accessToken;
  }

  async openOnlineSession(): Promise<KsefSession> {
    const bearer = await this.#accessToken(), keys = await this.#publicKeys(), { key, iv } = newSessionKey();
    const v = await this.#json({ method: 'POST', path: '/sessions/online', bearer, json: { formCode: FORM_CODE, encryption: { encryptedSymmetricKey: rsaOaepEncrypt(key, this.#key(keys, 'SymmetricKeyEncryption')), initializationVector: iv.toString('base64') } } });
    return { referenceNumber: str(v.referenceNumber, 201), validUntil: optStr(v.validUntil), key, iv };
  }
  /** Encrypts and sends one invoice XML; returns the invoice reference and its base64 SHA-256. */
  async sendInvoice(s: KsefSession, xml: Buffer, opts: { offlineMode?: boolean; hashOfCorrectedInvoice?: string } = {}): Promise<{ referenceNumber: string; invoiceHash: string }> {
    const bearer = await this.#accessToken(), enc = encryptInvoice(xml, s.key, s.iv), invoiceHash = sha256Base64(xml);
    const json: Json = { invoiceHash, invoiceSize: xml.length, encryptedInvoiceHash: sha256Base64(enc), encryptedInvoiceSize: enc.length, encryptedInvoiceContent: enc.toString('base64'), offlineMode: opts.offlineMode ?? false };
    if (opts.hashOfCorrectedInvoice) json.hashOfCorrectedInvoice = opts.hashOfCorrectedInvoice;
    const v = await this.#json({ method: 'POST', path: `/sessions/online/${seg(s.referenceNumber)}/invoices`, bearer, json });
    return { referenceNumber: str(v.referenceNumber, 202), invoiceHash };
  }
  async invoiceStatus(sessionRef: string, invoiceRef: string): Promise<KsefInvoiceStatus> {
    const v = await this.#json({ method: 'GET', path: `/sessions/${seg(sessionRef)}/invoices/${seg(invoiceRef)}`, bearer: await this.#accessToken() });
    const { invoiceHash: _hash, ...status } = invoiceOf(v, invoiceRef);
    return status;
  }
  /** All invoices of a session (GET /sessions/{ref}/invoices, paged by x-continuation-token). */
  async sessionInvoices(sessionRef: string): Promise<KsefSessionInvoice[]> {
    const out: KsefSessionInvoice[] = [];
    let next: string | null = null;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const v = await this.#json({ method: 'GET', path: `/sessions/${seg(sessionRef)}/invoices?pageSize=${LIST_PAGE_SIZE}`, bearer: await this.#accessToken(), ...(next ? { headers: { 'x-continuation-token': next } } : {}) });
      if (!Array.isArray(v.invoices)) throw bad(200);
      for (const i of v.invoices) out.push(invoiceOf(i && typeof i === 'object' ? i as Json : {}, ''));
      next = optStr(v.continuationToken);
      if (!next) return out;
    }
    throw new KsefUnavailableError('server', null, 'Lista faktur sesji KSeF jest dłuższa niż oczekiwano');
  }
  /** The invoice with this file hash (base64 SHA-256) in a session, or null when the session has none:
   * how a sender learns afterwards whether a file it is unsure about reached KSeF. */
  async findInvoiceByHash(sessionRef: string, invoiceHash: string): Promise<KsefSessionInvoice | null> {
    const found = (await this.sessionInvoices(sessionRef)).filter(i => i.invoiceHash === invoiceHash);
    // A file can be in a session twice only when the second copy was refused (440): the accepted one wins.
    return found.find(i => i.code === 200) ?? found.find(i => i.code === 100 || i.code === 150) ?? found[0] ?? null;
  }
  /** Status reads while 100/150, sleeping pollDelaysMs between them; the last status may still be 150. */
  async pollInvoice(sessionRef: string, invoiceRef: string): Promise<KsefInvoiceStatus> {
    let s = await this.invoiceStatus(sessionRef, invoiceRef);
    for (const d of this.#pollDelays) {
      if (s.code !== 100 && s.code !== 150) return s;
      await this.#wait(d); s = await this.invoiceStatus(sessionRef, invoiceRef);
    }
    return s;
  }
  /** UPO XML of one invoice. */
  async fetchUpo(sessionRef: string, ksefNumber: string): Promise<string> {
    return (await this.#request({ method: 'GET', path: `/sessions/${seg(sessionRef)}/invoices/ksef/${seg(ksefNumber)}/upo`, bearer: await this.#accessToken(), accept: 'application/xml' })).text;
  }
  async closeSession(sessionRef: string): Promise<void> {
    await this.#request({ method: 'POST', path: `/sessions/online/${seg(sessionRef)}/close`, bearer: await this.#accessToken() });
  }
  /** Challenge, public keys, login and redeem with per-step timings; a failed step ends the check. */
  async checkConnection(): Promise<KsefConnectionCheck> {
    const steps: KsefConnectionCheck['steps'] = [];
    const step: Step = async (name, fn) => {
      const t0 = performance.now();
      try { const v = await fn(); steps.push({ name, ok: true, ms: Math.round(performance.now() - t0) }); return v; }
      catch (e) { steps.push({ name, ok: false, ms: Math.round(performance.now() - t0) }); throw e; }
    };
    this.#keys = null;
    try { return { steps, accessValidUntil: (await this.#auth(step)).accessValidUntil, problem: null }; }
    catch (e) { if (e instanceof KsefUnavailableError || e instanceof KsefRefusedError) return { steps, accessValidUntil: null, problem: e.message }; throw e; }
  }
}
