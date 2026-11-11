/** Local fake of the KSeF 2.0 purchase side (test infrastructure; 127.0.0.1 only, in memory, never
 * talks to any MF host). It is a front server around an unchanged `startFakeKsef()` (229): every
 * request it does not serve itself is forwarded there, so challenge, MF keys, KSeF token/XAdES login,
 * redeem, refresh, sessions and QR pages behave exactly as in 229. The front learns the access tokens
 * from the login answers it forwards (redeem, refresh) and checks them, with the same clock, on its own
 * routes. It publishes its own SymmetricKeyEncryption key and re-encrypts a session key for the 229
 * fake on POST /sessions/online, so a 229 send through the front still works. The key list it passes on
 * is valid 2000–2100, because the 229 client checks key validity by the wall clock and tests use their own.
 * Own routes: POST /v2/invoices/query/metadata, GET /v2/invoices/ksef/{nr}, POST /v2/invoices/exports,
 * GET /v2/invoices/exports/{ref}, and the pre-signed part links GET /__fake/exports/{ref}/parts/{n}
 * (no bearer, as a storage link). Controls: addReceivedInvoice, setHwm, setTruncateAt,
 * setExportPartSize, setExportPolls, failNext (429/5xx with Retry-After), tamperDownload,
 * expireAccessTokens, onQuery (a hook called before a page is answered, e.g. to insert invoices
 * between pages), queries (the log of received queries). Exception codes 214xx are this fake's own. */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { encryptInvoice, makeKsefNumber, mfPublicKeyFrom, rsaOaepDecrypt, rsaOaepEncrypt, sha256Base64 } from './ksef229-crypto';
import { startFakeKsef, type FakeKsef } from './ksef229-fake';
import { zipStore } from './rodo228-model';

export type FakeReceivedInvoice = {
  ksefNumber: string; sellerNip: string; sellerName: string; buyerNip: string; invoiceNumber: string; issueDate: string; currency: string;
  invoiceType: string; net: number; vat: number; gross: number; invoicingDate: Date; acquisitionDate: Date; permanentStorageDate: Date; xml: Buffer; hash: string;
};
export type FakeQueryLog = { pageOffset: number; pageSize: number; sortOrder: string; body: Record<string, any> };
export type FakeKsefPurchase = {
  url: string; origin: string; inner: FakeKsef;
  addReceivedInvoice(o: { xml: string | Buffer; buyerNip?: string; sellerNip?: string; invoiceNumber?: string; issueDate?: string; invoicingDate?: Date; permanentStorageDate?: Date; ksefNumber?: string }): FakeReceivedInvoice;
  received(): FakeReceivedInvoice[];
  /** null = the current time. */ setHwm(d: Date | null): void;
  setTruncateAt(n: number): void;
  setExportPartSize(bytes: number): void;
  setExportPolls(n: number): void;
  /** The next `times` requests of `route` answer `status` (with Retry-After when given). */
  failNext(route: string, status: number, times?: number, retryAfter?: string): void;
  /** Serve other bytes for this KSeF number (hash no longer matches); null restores. */
  tamperDownload(ksefNumber: string, xml: Buffer | null): void;
  expireAccessTokens(): void;
  onQuery(fn: ((q: FakeQueryLog, n: number) => void) | null): void;
  queries(): FakeQueryLog[];
  stats(): Record<string, number>;
  close(): Promise<void>;
};

const DAY = 24 * 3600_000, MAX_BODY = 1024 * 1024, MAX_RANGE_MS = 90 * DAY;
class Fail { constructor(readonly status: number, readonly code: number, readonly description: string, readonly details: string[] = []) {} }
const invalid = (...d: string[]) => new Fail(400, 21405, 'Błąd walidacji danych wejściowych.', d);
const unauthorized = () => new Fail(401, 21401, 'Brak uwierzytelnienia albo nieważny token dostępowy.');
const hex = (n: number) => randomBytes(n).toString('hex').toUpperCase();
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const tag = (xml: string, name: string, scope?: string) => {
  const s = scope ? new RegExp(`<${scope}>[\\s\\S]*?</${scope}>`).exec(xml)?.[0] ?? '' : xml;
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(s)?.[1] ?? null;
};
const num = (v: string | null) => (v === null || Number.isNaN(Number(v)) ? 0 : Number(v));
const TYPES: Record<string, string> = { VAT: 'Vat', KOR: 'Kor', ZAL: 'Zal', ROZ: 'Roz', UPR: 'Upr', KOR_ZAL: 'KorZal', KOR_ROZ: 'KorRoz' };

/** Starts the purchase fake (and its inner 229 fake) on 127.0.0.1. */
export async function startFakeKsefPurchase(o: { port?: number; now?: () => Date } = {}): Promise<FakeKsefPurchase> {
  const now = o.now ?? (() => new Date());
  const inner = await startFakeKsef({ port: 0, now });
  const innerUrl = new URL(inner.origin);
  const sym = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let innerSym: KeyObject | null = null;
  const authNip = new Map<string, string>(), refreshNip = new Map<string, string>(), access = new Map<string, { nip: string; validUntil: number }>();
  const store: FakeReceivedInvoice[] = [], tampered = new Map<string, Buffer>(), failing = new Map<string, { status: number; times: number; retryAfter?: string }>();
  const exportsMap = new Map<string, { nip: string; key: Buffer; iv: Buffer; reads: number; polls: number; parts: Buffer[]; status: Record<string, unknown> }>();
  const counters: Record<string, number> = {}, log: FakeQueryLog[] = [];
  let hwm: Date | null = null, truncateAt = 10_000, partSize = 1024 * 1024, exportPolls = 1, queryHook: ((q: FakeQueryLog, n: number) => void) | null = null;
  const count = (k: string) => { counters[k] = (counters[k] ?? 0) + 1; };

  const send = (res: ServerResponse, status: number, body?: unknown, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) => {
    if (body === undefined) { res.writeHead(status, extra).end(); return; }
    const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    res.writeHead(status, { 'content-type': type, 'content-length': data.length, ...extra }).end(data);
  };
  const exception = (res: ServerResponse, f: Fail, extra: Record<string, string> = {}) =>
    send(res, f.status, { exception: { exceptionDetailList: [{ exceptionCode: f.code, exceptionDescription: f.description, details: f.details }], timestamp: now().toISOString() } }, 'application/json; charset=utf-8', extra);
  const readBody = (req: IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 10 * MAX_BODY) { reject(new Fail(413, 21413, 'Żądanie jest zbyt duże.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
  const parseJson = (b: Buffer): Record<string, any> => {
    try { const v = JSON.parse(b.toString('utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* below */ }
    throw invalid('Treść żądania nie jest obiektem JSON');
  };
  const bearer = (req: IncomingMessage) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
  const accessOf = (req: IncomingMessage) => { const t = bearer(req), a = t ? access.get(t) : undefined; if (!a || a.validUntil < now().getTime()) throw unauthorized(); return a; };
  const hwmNow = () => hwm ?? now();

  const metaOf = (i: FakeReceivedInvoice) => ({
    ksefNumber: i.ksefNumber, invoiceNumber: i.invoiceNumber, issueDate: i.issueDate, invoicingDate: i.invoicingDate.toISOString(), acquisitionDate: i.acquisitionDate.toISOString(),
    permanentStorageDate: i.permanentStorageDate.toISOString(), seller: { nip: i.sellerNip, name: i.sellerName }, buyer: { identifier: { type: 'Nip', value: i.buyerNip }, name: 'Nabywca' },
    netAmount: i.net, grossAmount: i.gross, vatAmount: i.vat, currency: i.currency, invoicingMode: 'Online', invoiceType: i.invoiceType,
    formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' }, isSelfInvoicing: false, hasAttachment: false, invoiceHash: i.hash,
  });
  const dateOf = (i: FakeReceivedInvoice, t: string) => t === 'Issue' ? Date.parse(`${i.issueDate}T00:00:00Z`) : t === 'Invoicing' ? i.invoicingDate.getTime() : i.permanentStorageDate.getTime();
  /** Filters of a query or export → the matching invoices, sorted by (date, KSeF number). */
  const select = (nip: string, f: Record<string, any>, sortOrder = 'Asc') => {
    if (!['Subject1', 'Subject2', 'Subject3', 'SubjectAuthorized'].includes(f.subjectType)) throw invalid('Nieprawidłowy subjectType');
    const r = f.dateRange;
    if (!r || typeof r !== 'object' || !['Issue', 'Invoicing', 'PermanentStorage'].includes(r.dateType)) throw invalid('Nieprawidłowy dateRange.dateType');
    const from = Date.parse(r.from), to0 = r.to === undefined ? now().getTime() : Date.parse(r.to);
    if (Number.isNaN(from) || Number.isNaN(to0) || to0 < from) throw invalid('Nieprawidłowy zakres dat');
    if (to0 - from > MAX_RANGE_MS) throw invalid('Zakres dat nie może przekraczać 90 dni');
    const to = r.dateType === 'PermanentStorage' && r.restrictToPermanentStorageHwmDate === true ? Math.min(to0, hwmNow().getTime()) : to0;
    const mine = (i: FakeReceivedInvoice) => f.subjectType === 'Subject1' ? i.sellerNip === nip : f.subjectType === 'Subject2' ? i.buyerNip === nip : false;
    const list = store.filter(i => mine(i) && dateOf(i, r.dateType) >= from && dateOf(i, r.dateType) <= to && (r.dateType !== 'PermanentStorage' || i.permanentStorageDate <= now()));
    list.sort((a, b) => dateOf(a, r.dateType) - dateOf(b, r.dateType) || (a.ksefNumber < b.ksefNumber ? -1 : a.ksefNumber > b.ksefNumber ? 1 : 0));
    if (sortOrder === 'Desc') list.reverse();
    return { list, dateType: r.dateType as string };
  };

  type Route = [string, RegExp, string, (req: IncomingMessage, res: ServerResponse, m: string[], q: URLSearchParams) => Promise<void> | void];
  const routes: Route[] = [
    ['POST', /^\/v2\/invoices\/query\/metadata$/, 'invoices/query/metadata', async (req, res, _m, q) => {
      const a = accessOf(req), body = parseJson(await readBody(req));
      const pageOffset = Number(q.get('pageOffset') ?? 0), pageSize = Number(q.get('pageSize') ?? 10), sortOrder = q.get('sortOrder') ?? 'Asc';
      if (!Number.isSafeInteger(pageOffset) || pageOffset < 0 || !Number.isSafeInteger(pageSize) || pageSize < 10 || pageSize > 250 || !['Asc', 'Desc'].includes(sortOrder)) throw invalid('Nieprawidłowe parametry stronicowania');
      const entry = { pageOffset, pageSize, sortOrder, body };
      log.push(entry); queryHook?.(entry, log.length);
      const { list } = select(a.nip, body, sortOrder), capped = list.slice(0, truncateAt), page = capped.slice(pageOffset, pageOffset + pageSize);
      send(res, 200, { hasMore: pageOffset + pageSize < capped.length, isTruncated: list.length > truncateAt && pageOffset + pageSize >= truncateAt, permanentStorageHwmDate: hwmNow().toISOString(), invoices: page.map(metaOf) });
    }],
    ['GET', /^\/v2\/invoices\/ksef\/([^/]+)$/, 'invoices/download', (req, res, m) => {
      const a = accessOf(req), i = store.find(x => x.ksefNumber === m[1] && (x.buyerNip === a.nip || x.sellerNip === a.nip));
      if (!i) throw new Fail(404, 21404, 'Nie znaleziono: faktura.');
      send(res, 200, tampered.get(i.ksefNumber) ?? i.xml, 'application/xml; charset=utf-8');
    }],
    ['POST', /^\/v2\/invoices\/exports$/, 'invoices/exports', async (req, res) => {
      const a = accessOf(req), body = parseJson(await readBody(req)), e = body.encryption ?? {};
      let key: Buffer, iv: Buffer;
      try { key = rsaOaepDecrypt(String(e.encryptedSymmetricKey), sym.privateKey); iv = Buffer.from(String(e.initializationVector), 'base64'); } catch { throw invalid('Nie można odszyfrować klucza symetrycznego'); }
      if (key.length !== 32 || iv.length !== 16) throw invalid('Klucz symetryczny musi mieć 32 bajty, a IV 16 bajtów');
      const { list, dateType } = select(a.nip, body.filters ?? {}), taken = list.slice(0, truncateAt), last = taken.at(-1);
      const zip = zipStore([...taken.map(i => ({ name: `${i.ksefNumber}.xml`, data: tampered.get(i.ksefNumber) ?? i.xml })), { name: '_metadata.json', data: Buffer.from(JSON.stringify({ invoices: taken.map(metaOf) }), 'utf8') }], now());
      const parts: Buffer[] = [];
      for (let p = 0; p < zip.length; p += partSize) parts.push(zip.subarray(p, p + partSize));
      const ref = `${ymd(now())}-EX-${hex(5)}-${hex(5)}-${hex(1)}`;
      const lastDate = (t: string) => last && dateType === t ? new Date(dateOf(last, t)).toISOString() : null;
      exportsMap.set(ref, { nip: a.nip, key, iv, reads: 0, polls: exportPolls, parts, status: {
        invoiceCount: taken.length, size: zip.length, isTruncated: list.length > truncateAt, permanentStorageHwmDate: hwmNow().toISOString(),
        lastPermanentStorageDate: lastDate('PermanentStorage'), lastInvoicingDate: lastDate('Invoicing'), lastIssueDate: last && dateType === 'Issue' ? last.issueDate : null } });
      send(res, 202, { referenceNumber: ref });
    }],
    ['GET', /^\/v2\/invoices\/exports\/([^/]+)$/, 'invoices/exports/status', (req, res, m) => {
      const a = accessOf(req), x = exportsMap.get(m[1]!);
      if (!x || x.nip !== a.nip) throw new Fail(404, 21404, 'Nie znaleziono: eksport.');
      if (x.reads++ < x.polls) { send(res, 200, { status: { code: 100, description: 'Eksport w toku' } }); return; }
      const parts = x.parts.map((p, i) => { const enc = encryptInvoice(p, x.key, x.iv); return { ordinalNumber: i + 1, partName: `${m[1]}-${i + 1}.zip.aes`, method: 'GET', url: `${origin}/__fake/exports/${m[1]}/parts/${i + 1}`,
        partSize: p.length, partHash: sha256Base64(p), encryptedPartSize: enc.length, encryptedPartHash: sha256Base64(enc), expirationDate: new Date(now().getTime() + DAY).toISOString() }; });
      send(res, 200, { status: { code: 200, description: 'Eksport zakończony' }, completedDate: now().toISOString(), package: { ...x.status, parts } });
    }],
    ['GET', /^\/__fake\/exports\/([^/]+)\/parts\/(\d+)$/, 'invoices/exports/part', (req, res, m) => {
      if (req.headers.authorization) throw invalid('Link części paczki nie przyjmuje nagłówka Authorization');
      const x = exportsMap.get(m[1]!), p = x?.parts[Number(m[2]) - 1];
      if (!x || !p) throw new Fail(404, 21404, 'Nie znaleziono: część paczki.');
      send(res, 200, encryptInvoice(p, x.key, x.iv), 'application/octet-stream');
    }],
  ];

  /** Forwards to the inner 229 fake, learning tokens from login answers and re-keying session opens. */
  const forward = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    let body = await readBody(req);
    const method = req.method ?? 'GET', b = bearer(req);
    if (method === 'POST' && path === '/v2/sessions/online') {
      try {
        const j = parseJson(body);
        if (!innerSym) throw new Error('no key');
        j.encryption = { ...j.encryption, encryptedSymmetricKey: rsaOaepEncrypt(rsaOaepDecrypt(String(j.encryption?.encryptedSymmetricKey), sym.privateKey), innerSym) };
        body = Buffer.from(JSON.stringify(j), 'utf8');
      } catch { /* the inner fake answers the bad request itself */ }
    }
    const headers = { ...req.headers, host: innerUrl.host, 'content-length': String(body.length) };
    await new Promise<void>(resolve => {
      const r = httpRequest({ host: innerUrl.hostname, port: innerUrl.port, method, path: req.url, headers }, up => {
        const chunks: Buffer[] = [];
        up.on('data', (c: Buffer) => chunks.push(c));
        up.on('error', () => { res.destroy(); resolve(); });
        up.on('end', () => {
          let out = Buffer.concat(chunks);
          const ok = (up.statusCode ?? 500) < 300;
          try {
            if (ok && path === '/v2/auth/ksef-token') { const t = JSON.parse(out.toString()).authenticationToken?.token; if (t) authNip.set(t, parseJson(body).contextIdentifier?.value); }
            if (ok && path === '/v2/auth/xades-signature') { const t = JSON.parse(out.toString()).authenticationToken?.token, nip = /<Nip>(\d{10})<\/Nip>/.exec(body.toString())?.[1]; if (t && nip) authNip.set(t, nip); }
            if (ok && path === '/v2/auth/token/redeem' && b) { const j = JSON.parse(out.toString()), nip = authNip.get(b); if (nip) { access.set(j.accessToken.token, { nip, validUntil: Date.parse(j.accessToken.validUntil) }); refreshNip.set(j.refreshToken.token, nip); } }
            if (ok && path === '/v2/auth/token/refresh' && b) { const j = JSON.parse(out.toString()), nip = refreshNip.get(b); if (nip) access.set(j.accessToken.token, { nip, validUntil: Date.parse(j.accessToken.validUntil) }); }
            if (ok && path === '/v2/security/public-key-certificates') {
              const list = JSON.parse(out.toString()) as { certificate: string; usage: string[]; validFrom: string; validTo: string }[];
              for (const k of list) {
                if (k.usage.includes('SymmetricKeyEncryption')) { innerSym = mfPublicKeyFrom(k.certificate); k.certificate = sym.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'); }
                // The 229 client checks key validity against the wall clock; tests run this fake on their own clock.
                k.validFrom = '2000-01-01T00:00:00.000Z'; k.validTo = '2100-01-01T00:00:00.000Z';
              }
              out = Buffer.from(JSON.stringify(list), 'utf8');
            }
          } catch { /* pass the answer through unchanged */ }
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(up.headers)) if (typeof v === 'string' && k !== 'content-length' && k !== 'connection' && k !== 'transfer-encoding') h[k] = v;
          res.writeHead(up.statusCode ?? 502, { ...h, 'content-length': String(out.length) }).end(out);
          resolve();
        });
      });
      r.on('error', () => { res.destroy(); resolve(); });
      res.on('close', () => r.destroy());
      r.end(body);
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1'), method = req.method ?? 'GET';
    for (const [m, re, name, fn] of routes) {
      const match = method === m ? re.exec(u.pathname) : null;
      if (!match) continue;
      count(name);
      const f = failing.get(name);
      if (f && f.times > 0) {
        if (--f.times === 0) failing.delete(name);
        count(`${name}:${f.status}`);
        exception(res, new Fail(f.status, 21000 + f.status, f.status === 429 ? 'Przekroczono limit zapytań.' : 'Usługa KSeF chwilowo niedostępna.'), f.retryAfter ? { 'retry-after': f.retryAfter } : {});
        return;
      }
      await fn(req, res, match.map(s => { try { return decodeURIComponent(s); } catch { throw invalid('Nieprawidłowy adres zasobu'); } }), u.searchParams);
      return;
    }
    await forward(req, res, u.pathname);
  };
  const server = createServer((req, res) => {
    handle(req, res).catch(e => {
      if (res.headersSent) { res.destroy(); return; }
      exception(res, e instanceof Fail ? e : new Fail(500, 21500, 'Wewnętrzny błąd lokalnego fake KSeF.'));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(o.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: `${origin}/v2`, origin, inner,
    addReceivedInvoice(x) {
      const xml = Buffer.isBuffer(x.xml) ? x.xml : Buffer.from(x.xml, 'utf8'), s = xml.toString('utf8');
      const sellerNip = x.sellerNip ?? tag(s, 'NIP', 'Podmiot1') ?? '5260250995', buyerNip = x.buyerNip ?? tag(s, 'NIP', 'Podmiot2') ?? '';
      const invoicingDate = x.invoicingDate ?? now(), p = (n: string) => num(tag(s, n));
      const inv: FakeReceivedInvoice = {
        ksefNumber: x.ksefNumber ?? makeKsefNumber(sellerNip, ymd(invoicingDate), hex(6)), sellerNip, sellerName: tag(s, 'Nazwa', 'Podmiot1') ?? 'Sprzedawca', buyerNip,
        invoiceNumber: x.invoiceNumber ?? tag(s, 'P_2') ?? 'BRAK', issueDate: x.issueDate ?? tag(s, 'P_1') ?? invoicingDate.toISOString().slice(0, 10), currency: tag(s, 'KodWaluty') ?? 'PLN',
        invoiceType: TYPES[tag(s, 'RodzajFaktury') ?? 'VAT'] ?? 'Vat',
        net: ['P_13_1', 'P_13_2', 'P_13_3', 'P_13_4', 'P_13_5', 'P_13_6_1', 'P_13_6_2', 'P_13_6_3', 'P_13_7', 'P_13_8', 'P_13_9', 'P_13_10', 'P_13_11'].reduce((t, n) => t + p(n), 0),
        vat: ['P_14_1', 'P_14_2', 'P_14_3', 'P_14_4', 'P_14_5'].reduce((t, n) => t + p(n), 0), gross: p('P_15'),
        invoicingDate, acquisitionDate: invoicingDate, permanentStorageDate: x.permanentStorageDate ?? invoicingDate, xml, hash: sha256Base64(xml),
      };
      store.push(inv);
      return inv;
    },
    received: () => [...store],
    setHwm(d) { hwm = d; },
    setTruncateAt(n) { if (!Number.isSafeInteger(n) || n < 1) throw new Error('truncateAt musi być dodatnią liczbą całkowitą'); truncateAt = n; },
    setExportPartSize(n) { if (!Number.isSafeInteger(n) || n < 16) throw new Error('Rozmiar części musi mieć co najmniej 16 B'); partSize = n; },
    setExportPolls(n) { exportPolls = n; },
    failNext(route, status, times = 1, retryAfter) { failing.set(route, { status, times, retryAfter }); },
    tamperDownload(nr, xml) { if (xml) tampered.set(nr, xml); else tampered.delete(nr); },
    expireAccessTokens() { for (const a of access.values()) a.validUntil = 0; },
    onQuery(fn) { queryHook = fn; },
    queries: () => log.map(q => ({ ...q })),
    stats: () => ({ ...inner.stats(), ...counters }),
    close: async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await inner.close(); },
  };
}
