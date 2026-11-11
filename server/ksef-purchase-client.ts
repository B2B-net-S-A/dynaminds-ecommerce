/** KSeF 2.0 purchase-side client (no DB): invoices received by the context NIP (subject type
 * Subject2). Not wired to routes or the worker yet; see docs/parity/KSEF-PURCHASE-20261026.md.
 * - POST /invoices/query/metadata (pageOffset/pageSize/sortOrder=Asc, date range by PermanentStorage,
 *   Invoicing or Issue date), GET /invoices/ksef/{ksefNumber} (the FA(3) file), and the export package:
 *   POST /invoices/exports (AES-256 key RSA-OAEP-encrypted with the MF SymmetricKeyEncryption key) →
 *   GET /invoices/exports/{ref} polled → parts downloaded without the bearer token, each part's
 *   encrypted and plain SHA-256/size checked, AES-256-CBC decrypted, joined, unzipped with limits.
 * - Login reuses the 229 client (`KsefClient.authenticate()`: challenge, MF keys, KSeF token or XAdES,
 *   redeem). The access token is cached until validUntil − 60 s, renewed with POST /auth/token/refresh,
 *   and a 401 in the middle of paging renews once and repeats the same request.
 * - Reads are idempotent: 429 and 5xx are retried with Retry-After or exponential backoff
 *   (KSEF_PURCHASE_RETRY); a Retry-After longer than maxWaitMs ends the attempt with
 *   KsefRateLimitedError so a worker can reschedule instead of sleeping. Requests are paced
 *   (minIntervalMs) and every answer is read with a byte limit.
 * - Same base-URL rule as 229: test/demo/prod are refused while KSEF_REAL_ENABLED is false.
 * `syncPurchaseInvoices` is the loop a future worker job runs: checkpoint → page → files → store. */
import type { KeyObject } from 'node:crypto';
import { KsefClient, KsefRefusedError, KsefUnavailableError, ksefBaseUrl, type KsefClientOptions, type KsefCredentials, type KsefEnvironment } from './ksef229-client';
import { decryptInvoice, mfPublicKeyFrom, newSessionKey, rsaOaepEncrypt, sha256Base64 } from './ksef229-crypto';
import {
  KSEF_PURCHASE_RETRY, KSEF_PURCHASE_XML_LIMITS, KSEF_PURCHASE_ZIP_LIMITS, KsefPurchaseDataError, advancePurchaseCheckpoint, checkReceivedAgainstMetadata,
  parsePurchaseMetadataPage, parsePurchasePackage, parseReceivedFa3, purchaseQuery, purchaseRetryDelayMs, readPurchaseZip, startPurchaseWindow,
  type ParsedPurchaseInvoice, type PurchaseCheckpoint, type PurchaseMetadata, type PurchaseMetadataPage, type PurchasePackageEntry, type PurchaseQuery, type PurchaseRetryPolicy,
} from './ksef-purchase-model';

/** KSeF asked to wait longer than this attempt may (Retry-After beyond maxWaitMs, or retries used up). */
export class KsefRateLimitedError extends KsefUnavailableError {
  constructor(public readonly retryAfterMs: number | null, message: string) { super('server', 429, message); this.name = 'KsefRateLimitedError'; }
}
export type KsefPurchaseClientOptions = KsefClientOptions & {
  retry?: Partial<PurchaseRetryPolicy>;
  /** Minimum spacing between two purchase API requests (sandbox question: the MF per-endpoint limits). */
  minIntervalMs?: number;
  random?: () => number;
  /** Delays between export status reads. */ exportPollDelaysMs?: number[];
};
export type PurchaseExportFilters = Omit<PurchaseQuery, 'pageOffset' | 'pageSize' | 'sortOrder'>;
export type PurchaseExportHandle = { referenceNumber: string; key: Buffer; iv: Buffer };
export type PurchaseExportPart = { ordinalNumber: number; url: string; partSize: number; partHash: string; encryptedPartSize: number; encryptedPartHash: string };
export type PurchaseExportStatus = {
  code: number; description: string;
  package: null | { invoiceCount: number; parts: PurchaseExportPart[]; isTruncated: boolean; lastPermanentStorageDate: string | null; lastInvoicingDate: string | null; lastIssueDate: string | null; permanentStorageHwmDate: string | null };
};
export type FetchedPurchaseInvoice = { meta: PurchaseMetadata; xml: Buffer; parsed: ParsedPurchaseInvoice };

export const KSEF_PURCHASE_MAX_JSON_BYTES = 10 * 1024 * 1024;
export const KSEF_PURCHASE_MAX_PART_BYTES = 128 * 1024 * 1024;
const MAX_PARTS = 100;
type Json = Record<string, unknown>;
type Req = { method: 'GET' | 'POST'; path?: string; url?: string; bearer: boolean; json?: unknown; accept?: string; maxBytes: number };
const seg = encodeURIComponent;
const bad = () => new KsefUnavailableError('server', null, 'KSeF zwrócił odpowiedź w nieoczekiwanym formacie');
const optStr = (v: unknown): string | null => typeof v === 'string' && v ? v : null;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

async function readBounded(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel().catch(() => {}); throw new KsefPurchaseDataError('too_large', `Odpowiedź KSeF jest za duża (${declared} B)`); }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader(), chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new KsefPurchaseDataError('too_large', `Odpowiedź KSeF jest za duża (ponad ${max} B)`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export class KsefPurchaseClient {
  readonly environment: KsefEnvironment;
  readonly nip: string;
  readonly #base: string;
  readonly #login: KsefClient;
  readonly #credentials: KsefCredentials;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #deadline: number;
  readonly #retry: PurchaseRetryPolicy;
  readonly #minInterval: number;
  readonly #random: () => number;
  readonly #exportPolls: number[];
  #access: { token: string; expiresAt: number; refresh: string | null } | null = null;
  #symKey: KeyObject | null = null;
  #lastAt = -Infinity;
  /** Counters for tests and the future job log: logins, refreshes, 401 renewals, retries. */
  readonly counters = { logins: 0, refreshes: 0, renewedAfter401: 0, retries: 0 };

  constructor(o: KsefPurchaseClientOptions) {
    this.#login = new KsefClient(o); // validates the NIP, credentials, timeout and the base URL rule
    this.#base = ksefBaseUrl(o.environment, o.baseUrl);
    this.environment = o.environment; this.nip = o.nip; this.#credentials = o.credentials;
    this.#fetch = o.fetch ?? fetch; this.#timeoutMs = o.timeoutMs ?? 15_000;
    this.#sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms))); this.#now = o.now ?? Date.now; this.#deadline = o.deadline ?? Infinity;
    this.#retry = { ...KSEF_PURCHASE_RETRY, ...o.retry }; this.#minInterval = o.minIntervalMs ?? 125; this.#random = o.random ?? Math.random;
    this.#exportPolls = [...(o.exportPollDelaysMs ?? [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000])];
    if (!Number.isSafeInteger(this.#retry.maxAttempts) || this.#retry.maxAttempts < 1 || this.#retry.maxAttempts > 10) throw new Error('Nieprawidłowa liczba prób odczytu KSeF');
  }
  /** The client's clock (ms); the sync loop uses it by default. */
  now(): number { return this.#now(); }
  #left(): number {
    const left = this.#deadline - this.#now();
    if (left <= 0) throw new KsefUnavailableError('timeout', null, 'Przekroczono łączny czas próby połączenia z KSeF');
    return left;
  }
  async #wait(ms: number) { if (ms > 0) await this.#sleep(Math.min(ms, this.#left())); }
  #redact(text: string): string {
    const c = this.#credentials, secrets = [this.#access?.token, this.#access?.refresh, c.method === 'token' ? c.token : c.privateKeyPem];
    let t = text; for (const s of secrets) if (s) t = t.split(s).join('***');
    return t;
  }

  async #accessToken(): Promise<string> {
    const a = this.#access, now = this.#now();
    if (a && now < a.expiresAt) return a.token;
    if (a?.refresh) {
      try {
        const v = await this.#plainJson({ method: 'POST', path: '/auth/token/refresh', bearer: false, maxBytes: 64 * 1024 }, a.refresh);
        const t = v.accessToken as Json | undefined, token = optStr(t?.token), until = Date.parse(optStr(t?.validUntil) ?? '');
        if (!token) throw bad();
        this.#access = { ...a, token, expiresAt: Number.isNaN(until) ? 0 : until - 60_000 };
        this.counters.refreshes++;
        return token;
      } catch (e) { if (!(e instanceof KsefRefusedError)) throw e; this.#access = null; }
    }
    const r = await this.#login.authenticate(), until = Date.parse(r.accessValidUntil ?? '');
    this.#access = { token: r.accessToken, refresh: r.refreshToken, expiresAt: Number.isNaN(until) ? 0 : until - 60_000 };
    this.counters.logins++;
    return r.accessToken;
  }
  /** One request with a fixed bearer (refresh), no retry loop: used only by the token refresh. */
  async #plainJson(r: Req, bearer: string): Promise<Json> {
    const res = await this.#once(r, bearer);
    if (res.status === 401 || (res.status >= 400 && res.status < 500 && res.status !== 429)) throw this.#refused(res.status, res.body.toString('utf8'));
    if (res.status < 200 || res.status >= 300) throw new KsefUnavailableError('server', res.status, `KSeF jest chwilowo niedostępny (HTTP ${res.status})`);
    return this.#parseJson(res.body);
  }
  async #once(r: Req, bearer: string | null): Promise<{ status: number; body: Buffer; retryAfter: string | null }> {
    const gap = this.#lastAt + this.#minInterval - this.#now();
    if (gap > 0) await this.#wait(gap);
    this.#lastAt = this.#now();
    const left = this.#left(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), Math.min(this.#timeoutMs, left));
    const headers: Record<string, string> = { Accept: r.accept ?? 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let body: string | undefined;
    if (r.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(r.json); }
    try {
      const res = await this.#fetch(r.url ?? this.#base + r.path, { method: r.method, headers, body, signal: ctl.signal, redirect: 'error' });
      const status = res.status, retryAfter = res.headers.get('retry-after');
      // Error bodies are small; a success body may be up to the limit of the call.
      return { status, body: await readBounded(res, status >= 200 && status < 300 ? r.maxBytes : 256 * 1024), retryAfter };
    } catch (e) {
      if (e instanceof KsefPurchaseDataError) throw e;
      if (ctl.signal.aborted) throw new KsefUnavailableError('timeout', null, 'KSeF nie odpowiedział w wyznaczonym czasie');
      throw new KsefUnavailableError('network', null, 'Brak połączenia z KSeF');
    } finally { clearTimeout(timer); }
  }
  /** Idempotent read (or the export start): 401 renews the token once; 429/5xx back off and retry. */
  async #request(r: Req): Promise<Buffer> {
    let renewed = false;
    for (let attempt = 1; ; ) {
      const bearer = r.bearer ? await this.#accessToken() : null;
      const res = await this.#once(r, bearer);
      if (res.status >= 200 && res.status < 300) return res.body;
      if (res.status === 401 && r.bearer && !renewed) {
        renewed = true; this.counters.renewedAfter401++;
        if (this.#access) this.#access = { ...this.#access, expiresAt: 0 };
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const delay = purchaseRetryDelayMs(attempt, res.retryAfter, this.#now(), this.#retry, this.#random);
        if (attempt >= this.#retry.maxAttempts || delay > this.#retry.maxWaitMs) {
          if (res.status === 429) throw new KsefRateLimitedError(res.retryAfter === null ? null : delay, `KSeF ogranicza liczbę zapytań (HTTP 429); ponów później`);
          throw new KsefUnavailableError('server', res.status, `KSeF jest chwilowo niedostępny (HTTP ${res.status})`);
        }
        this.counters.retries++; attempt++;
        await this.#wait(delay);
        continue;
      }
      throw this.#refused(res.status, res.body.toString('utf8'));
    }
  }
  #refused(status: number, text: string): KsefRefusedError {
    let code: number | null = null, description = `Żądanie odrzucone (HTTP ${status})`, details: string[] = [];
    try {
      const v = JSON.parse(text) as { exception?: { exceptionDetailList?: { exceptionCode?: unknown; exceptionDescription?: unknown; details?: unknown }[] } };
      const first = Array.isArray(v?.exception?.exceptionDetailList) ? v.exception.exceptionDetailList[0] : undefined;
      if (first) {
        code = typeof first.exceptionCode === 'number' ? first.exceptionCode : null;
        if (typeof first.exceptionDescription === 'string' && first.exceptionDescription) description = first.exceptionDescription;
        details = strings(first.details);
      }
    } catch { /* not a KSeF exception body */ }
    return new KsefRefusedError(status, code, this.#redact(description), details.map(d => this.#redact(d)));
  }
  #parseJson(body: Buffer): Json {
    try { const v = JSON.parse(body.toString('utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json; } catch { /* fall through */ }
    throw bad();
  }
  async #json(r: Req): Promise<Json> { return this.#parseJson(await this.#request(r)); }

  /** One page of invoices received by the context NIP. */
  async queryMetadata(q: PurchaseQuery): Promise<PurchaseMetadataPage> {
    const { pageOffset, pageSize, sortOrder, ...filters } = q;
    const v = await this.#json({ method: 'POST', path: `/invoices/query/metadata?pageOffset=${pageOffset}&pageSize=${pageSize}&sortOrder=${sortOrder}`, bearer: true, json: filters, maxBytes: KSEF_PURCHASE_MAX_JSON_BYTES });
    return parsePurchaseMetadataPage(v);
  }
  /** The FA(3) file of one invoice, by its KSeF number (bytes as stored by KSeF). */
  async downloadInvoice(ksefNumber: string): Promise<Buffer> {
    return this.#request({ method: 'GET', path: `/invoices/ksef/${seg(ksefNumber)}`, bearer: true, accept: 'application/xml', maxBytes: KSEF_PURCHASE_XML_LIMITS.maxBytes });
  }
  /** Download + hash/metadata/buyer check + strict FA(3) parse; a bad file throws KsefPurchaseDataError. */
  async fetchInvoice(meta: PurchaseMetadata): Promise<FetchedPurchaseInvoice> {
    const xml = await this.downloadInvoice(meta.ksefNumber);
    return checkedEntry(this.nip, meta, xml);
  }

  async #symmetricKey(): Promise<KeyObject> {
    if (this.#symKey) return this.#symKey;
    const body = await this.#request({ method: 'GET', path: '/security/public-key-certificates', bearer: false, maxBytes: 1024 * 1024 });
    let list: unknown;
    try { list = JSON.parse(body.toString('utf8')); } catch { throw bad(); }
    if (!Array.isArray(list)) throw bad();
    const now = this.#now(), e = list.find((k: Json) => strings(k?.usage).includes('SymmetricKeyEncryption') && !(Date.parse(String(k?.validFrom)) > now) && !(Date.parse(String(k?.validTo)) < now)) as Json | undefined;
    if (!e || typeof e.certificate !== 'string') throw new KsefUnavailableError('server', null, 'KSeF nie udostępnia ważnego klucza publicznego do szyfrowania');
    try { this.#symKey = mfPublicKeyFrom(e.certificate); } catch { throw bad(); }
    return this.#symKey;
  }
  /** Starts an asynchronous export; the returned key must be kept (encrypted at rest) until the package is read. */
  async startExport(filters: PurchaseExportFilters): Promise<PurchaseExportHandle> {
    const { key, iv } = newSessionKey(), pub = await this.#symmetricKey();
    const v = await this.#json({ method: 'POST', path: '/invoices/exports', bearer: true, maxBytes: 64 * 1024,
      json: { encryption: { encryptedSymmetricKey: rsaOaepEncrypt(key, pub), initializationVector: iv.toString('base64') }, filters } });
    const referenceNumber = optStr(v.referenceNumber);
    if (!referenceNumber) throw bad();
    return { referenceNumber, key, iv };
  }
  async exportStatus(referenceNumber: string): Promise<PurchaseExportStatus> {
    const v = await this.#json({ method: 'GET', path: `/invoices/exports/${seg(referenceNumber)}`, bearer: true, maxBytes: KSEF_PURCHASE_MAX_JSON_BYTES });
    const st = v.status as Json | undefined;
    if (typeof st?.code !== 'number') throw bad();
    const p = v.package as Json | undefined | null;
    let pkg: PurchaseExportStatus['package'] = null;
    if (p) {
      if (!Array.isArray(p.parts) || p.parts.length > MAX_PARTS || typeof p.invoiceCount !== 'number') throw bad();
      const parts = p.parts.map((x: Json) => {
        const n = (k: string) => { const v = x?.[k]; if (!Number.isSafeInteger(v) || (v as number) < 0) throw bad(); return v as number; };
        const s = (k: string) => { const v = x?.[k]; if (typeof v !== 'string' || !v) throw bad(); return v; };
        return { ordinalNumber: n('ordinalNumber'), url: s('url'), partSize: n('partSize'), partHash: s('partHash'), encryptedPartSize: n('encryptedPartSize'), encryptedPartHash: s('encryptedPartHash') };
      }).sort((a, b) => a.ordinalNumber - b.ordinalNumber);
      if (parts.some((x, i) => x.ordinalNumber !== i + 1)) throw bad();
      pkg = { invoiceCount: p.invoiceCount, parts, isTruncated: p.isTruncated === true, lastPermanentStorageDate: optStr(p.lastPermanentStorageDate),
        lastInvoicingDate: optStr(p.lastInvoicingDate), lastIssueDate: optStr(p.lastIssueDate), permanentStorageHwmDate: optStr(p.permanentStorageHwmDate) };
    }
    return { code: st.code, description: typeof st.description === 'string' ? st.description : '', package: pkg };
  }
  /** Polls until the package is ready (200) or KSeF reports a failure (≥ 400). */
  async waitForExport(referenceNumber: string): Promise<PurchaseExportStatus> {
    let s = await this.exportStatus(referenceNumber);
    for (const d of this.#exportPolls) {
      if (s.code !== 100) break;
      await this.#wait(d); s = await this.exportStatus(referenceNumber);
    }
    if (s.code === 100) throw new KsefUnavailableError('timeout', null, 'KSeF nie przygotował paczki eksportu w oczekiwanym czasie');
    if (s.code !== 200 || !s.package) throw new KsefRefusedError(200, s.code, this.#redact(s.description || 'Eksport faktur zakończony niepowodzeniem'), []);
    return s;
  }
  /** A part URL is a pre-signed storage link: no bearer token goes there. For the local fake it must be
   * the fake's own origin; for MF only https without credentials (sandbox question: the storage host). */
  #partUrl(url: string): string {
    let u: URL;
    try { u = new URL(url, this.#base); } catch { throw bad(); }
    const base = new URL(this.#base);
    if (u.username || u.password) throw bad();
    if (this.environment === 'local_fake' ? u.origin !== base.origin : u.protocol !== 'https:') throw new KsefPurchaseDataError('part_url', 'Adres części paczki eksportu jest niedozwolony');
    return u.href;
  }
  /** Downloads, verifies and decrypts every part, then reads the ZIP. */
  async downloadExportPackage(handle: PurchaseExportHandle, status: PurchaseExportStatus): Promise<PurchasePackageEntry[]> {
    if (!status.package) throw bad();
    const plain: Buffer[] = [];
    let total = 0;
    for (const part of status.package.parts) {
      if (part.encryptedPartSize > KSEF_PURCHASE_MAX_PART_BYTES) throw new KsefPurchaseDataError('too_large', 'Część paczki eksportu jest za duża');
      const enc = await this.#request({ method: 'GET', url: this.#partUrl(part.url), bearer: false, accept: 'application/octet-stream', maxBytes: part.encryptedPartSize });
      if (enc.length !== part.encryptedPartSize || sha256Base64(enc) !== part.encryptedPartHash) throw new KsefPurchaseDataError('hash_mismatch', `Skrót zaszyfrowanej części ${part.ordinalNumber} paczki eksportu się nie zgadza`);
      let dec: Buffer;
      try { dec = decryptInvoice(enc, handle.key, handle.iv); } catch { throw new KsefPurchaseDataError('decrypt', `Nie można odszyfrować części ${part.ordinalNumber} paczki eksportu`); }
      if (dec.length !== part.partSize || sha256Base64(dec) !== part.partHash) throw new KsefPurchaseDataError('hash_mismatch', `Skrót części ${part.ordinalNumber} paczki eksportu się nie zgadza`);
      total += dec.length;
      if (total > KSEF_PURCHASE_ZIP_LIMITS.maxTotalBytes) throw new KsefPurchaseDataError('too_large', 'Paczka eksportu jest za duża');
      plain.push(dec);
    }
    return parsePurchasePackage(readPurchaseZip(Buffer.concat(plain)));
  }
}

/** Hash/metadata/buyer check and strict parse of one file (also used for export package entries). */
export function checkedEntry(nip: string, meta: PurchaseMetadata, xml: Buffer): FetchedPurchaseInvoice {
  const parsed = parseReceivedFa3(xml);
  checkReceivedAgainstMetadata(nip, meta, xml, parsed);
  return { meta, xml, parsed };
}

/** A refused file: no content, only the listing entry (kept so the file can be downloaded again) and why. */
export type PurchaseReject = { ksefNumber: string; invoiceHash: string; code: string; reason: string; meta: PurchaseMetadata };
/** What the caller persists atomically: new invoices, refused files and the checkpoint after them. The
 * store answers how many invoices it already had (dedup by KSeF number, e.g. ON CONFLICT DO NOTHING). */
export type PurchaseStore = (batch: { invoices: FetchedPurchaseInvoice[]; rejects: PurchaseReject[]; checkpoint: PurchaseCheckpoint }) => Promise<{ duplicates: number }>;
export type PurchaseSyncResult = { checkpoint: PurchaseCheckpoint; pages: number; stored: number; duplicates: number; overlap: number; rejected: number; done: boolean };

/** Runs the incremental download from `checkpoint` for up to `maxPages` pages. The checkpoint passed to
 * `store` is the only progress; when anything throws (KSeF unavailable, rate limit, store failure) the
 * last stored checkpoint stays, and the next run repeats the page. A refused file (malformed XML,
 * hash or buyer mismatch) is stored as a reject so one bad invoice never blocks the rest. */
export async function syncPurchaseInvoices(o: { client: KsefPurchaseClient; checkpoint: PurchaseCheckpoint; store: PurchaseStore; now?: () => number; maxPages?: number; pageSize?: number; lookbackMs?: number; maxWindowMs?: number; settleMs?: number }): Promise<PurchaseSyncResult> {
  const now = o.now ?? (() => o.client.now()), maxPages = o.maxPages ?? 50;
  if (o.checkpoint.nip !== o.client.nip) throw new Error('Punkt kontrolny dotyczy innego NIP niż klient KSeF');
  let cp = o.checkpoint;
  // A run catches up to the moment it started; later invoices are the next run's.
  const until = new Date(now()).toISOString(), r = { pages: 0, stored: 0, duplicates: 0, overlap: 0, rejected: 0 };
  while (r.pages < maxPages) {
    const open = startPurchaseWindow(cp, until, o);
    if (!open) return { checkpoint: cp, ...r, done: true };
    const q = purchaseQuery(open, o.pageSize), page = await o.client.queryMetadata(q), adv = advancePurchaseCheckpoint(open, q, page);
    const invoices: FetchedPurchaseInvoice[] = [], rejects: PurchaseReject[] = [];
    for (const meta of adv.fresh) {
      // A malformed but identifiable listing entry is a reject of that invoice; the file is not fetched.
      if (meta.problem) { rejects.push({ ksefNumber: meta.ksefNumber, invoiceHash: meta.invoiceHash, code: meta.problem.code, reason: meta.problem.reason, meta }); continue; }
      try { invoices.push(await o.client.fetchInvoice(meta)); }
      catch (e) {
        if (!(e instanceof KsefPurchaseDataError)) throw e;
        rejects.push({ ksefNumber: meta.ksefNumber, invoiceHash: meta.invoiceHash, code: e.code, reason: e.message, meta });
      }
    }
    const { duplicates } = await o.store({ invoices, rejects, checkpoint: adv.checkpoint });
    cp = adv.checkpoint; r.pages++; r.stored += invoices.length - duplicates; r.duplicates += duplicates; r.overlap += adv.overlap; r.rejected += rejects.length;
    if (adv.windowDone && Date.parse(cp.completedUpTo) <= Date.parse(open.completedUpTo)) return { checkpoint: cp, ...r, done: true };
  }
  return { checkpoint: cp, ...r, done: false };
}
