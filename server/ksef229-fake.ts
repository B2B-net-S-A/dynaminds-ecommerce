/** Local fake KSeF 2.0 (node:http, 127.0.0.1 only, in memory) for tests and local runs. It
 * checks what a real KSeF would and we can: challenge freshness and single use, the
 * RSA-OAEP token with the challenge `|timestampMs`, the simplified XAdES signature, Bearer
 * tokens, session state, AES decryption, hashes and sizes, FA (3) namespace/P_2/seller NIP,
 * duplicates per NIP. KSeF numbers and UPO it issues have no legal force; the exception
 * codes (214xx) are this fake's own. Never talks to any MF host.
 * Routes: /v2/... (API), /qr/invoice/{nip}/{DD-MM-YYYY}/{hash} (KOD I page),
 * /qr/certificate/{ctxType}/{ctxValue}/{sellerNip}/{serial}/{hash}/{signature} (KOD II page;
 * the signed text is `{Host header}/qr/certificate/...{hash}`, the MF rule of "URL without
 * https:// and without the signature"), POST /__fake/mode {mode, slowPolls?}.
 * Lost answers (RES-04): `loseNextResponse(route, how)` lets the next request of that route take
 * full effect (an invoice is stored and numbered) and then drops the connection ('drop') or never
 * answers ('hang'), as a lost ACK does. GET /sessions/{ref}/invoices lists a session's invoices
 * (paged by x-continuation-token) with their hashes, which is how a sender finds out afterwards
 * whether a file it is unsure about reached KSeF. POST /auth/token/refresh renews the access token.
 * CLI: `node node_modules/tsx/dist/cli.mjs server/ksef229-fake.ts --port 4239`. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { decryptInvoice, decryptKsefToken, makeKsefNumber, publicKeyFromPem, rsaOaepDecrypt, sha256Base64, verifyAuthTokenRequest, verifyCertificateQrPath } from './ksef229-crypto';

export type FakeKsefMode = 'ok' | 'unavailable' | 'timeout' | 'reject' | 'slow';
export type FakeKsefInvoice = { nip: string; ksefNumber: string; invoiceHash: string; xml: string; offlineMode: boolean };
export type FakeKsef = {
  url: string; origin: string;
  setMode(m: FakeKsefMode, opts?: { slowPolls?: number }): void;
  /** The next request of `route` (a stats() name) is processed in full, then its answer is lost; null disarms. */
  loseNextResponse(route: string, how?: 'drop' | 'hang' | null): void;
  acceptToken(nip: string, token: string): void;
  registerOfflineCertificate(serial: string, publicKeyPem: string): void;
  invoices(): FakeKsefInvoice[];
  stats(): Record<string, number>;
  close(): Promise<void>;
};

const MODES: FakeKsefMode[] = ['ok', 'unavailable', 'timeout', 'reject', 'slow'];
const FA3_NS = 'http://crd.gov.pl/wzor/2025/06/25/13775/', AUTH_NS = 'http://ksef.mf.gov.pl/auth/token/2.0';
const CHALLENGE_TTL_MS = 10 * 60_000, AUTH_TTL_MS = 15 * 60_000, ACCESS_TTL_MS = 15 * 60_000, REFRESH_TTL_MS = 7 * 24 * 3600_000, SESSION_TTL_MS = 12 * 3600_000, MAX_BODY = 10 * 1024 * 1024;
type Status = { code: number; description: string; details?: string[] };
const AUTH_IN_PROGRESS: Status = { code: 100, description: 'Uwierzytelnianie w toku' };
const AUTH_OK: Status = { code: 200, description: 'Uwierzytelnianie zakończone sukcesem' };
const BAD_TOKEN: Status = { code: 450, description: 'Uwierzytelnianie zakończone niepowodzeniem z powodu błędnego tokenu' };
const BAD_SIGNATURE: Status = { code: 460, description: 'Uwierzytelnianie zakończone niepowodzeniem z powodu błędu certyfikatu' };
const INV_PROCESSING: Status = { code: 150, description: 'Trwa przetwarzanie' };
const INV_OK: Status = { code: 200, description: 'Sukces' };

class Fail { constructor(readonly status: number, readonly code: number, readonly description: string, readonly details: string[] = []) {} }
const invalid = (...details: string[]) => new Fail(400, 21405, 'Błąd walidacji danych wejściowych.', details);
const unauthorized = () => new Fail(401, 21401, 'Brak uwierzytelnienia albo nieważny token dostępowy.');
const notFound = (what: string) => new Fail(404, 21404, `Nie znaleziono: ${what}.`);
const hex = (n: number) => randomBytes(n).toString('hex').toUpperCase();
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const ref = (d: Date, kind: string) => `${ymd(d)}-${kind}-${hex(5)}-${hex(5)}-${hex(1)}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? null;
const segment = (s: string) => { try { return decodeURIComponent(s); } catch { throw invalid('Nieprawidłowy adres zasobu'); } };
const obj = (v: unknown): Record<string, any> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('Treść żądania nie jest obiektem JSON'); return v as Record<string, any>; };

type AuthOp = { ref: string; nip: string; token: string; validUntil: number; final: Status; reads: number; redeemed: boolean; method: string; started: Date };
type Session = { ref: string; nip: string; key: Buffer; iv: Buffer; open: boolean; validUntil: number; invoices: Inv[] };
type Inv = { ref: string; ordinal: number; session: Session; nip: string; hash: string; xml: string; offline: boolean; invoiceNumber: string | null; issueDate: string | null;
  received: Date; final: Status; ksefNumber: string | null; acquired: Date | null; reads: number; slowPolls: number };

/** Starts the fake on 127.0.0.1 (port 0 = random). */
export async function startFakeKsef(o: { port?: number; host?: '127.0.0.1'; now?: () => Date } = {}): Promise<FakeKsef> {
  const now = o.now ?? (() => new Date());
  const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tokenKeys = rsa(), symKeys = rsa(), keysFrom = now();
  let mode: FakeKsefMode = 'ok', slowPolls = 3;
  const challenges = new Map<string, { timestampMs: number; used: boolean }>(), accepted = new Map<string, Set<string>>();
  const auths = new Map<string, AuthOp>(), access = new Map<string, { nip: string; validUntil: number }>(), refresh = new Map<string, { nip: string; validUntil: number }>();
  const sessions = new Map<string, Session>(), byHash = new Map<string, Inv>(), accepted200: Inv[] = [], offlineCerts = new Map<string, KeyObject>();
  const counters: Record<string, number> = {}, hanging = new Set<ServerResponse>();
  const lose = new Map<string, 'drop' | 'hang'>(), losing = new WeakMap<ServerResponse, 'drop' | 'hang'>();
  const count = (k: string) => { counters[k] = (counters[k] ?? 0) + 1; };

  const send = (res: ServerResponse, status: number, body?: unknown, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) => {
    const lost = losing.get(res);
    if (lost === 'drop') { count('lost'); res.destroy(); return; }
    if (lost === 'hang') { count('lost'); hanging.add(res); res.on('close', () => hanging.delete(res)); return; }
    if (body === undefined) { res.writeHead(status, extra).end(); return; }
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text), ...extra }).end(text);
  };
  const exception = (res: ServerResponse, f: Fail, extra: Record<string, string> = {}) =>
    send(res, f.status, { exception: { exceptionDetailList: [{ exceptionCode: f.code, exceptionDescription: f.description, details: f.details }], referenceNumber: ref(now(), 'EX'), timestamp: now().toISOString() } }, 'application/json; charset=utf-8', extra);
  const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new Fail(413, 21413, 'Żądanie jest zbyt duże.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });
  const readJson = async (req: IncomingMessage) => { const t = await readBody(req); try { return obj(JSON.parse(t)); } catch (e) { throw e instanceof Fail ? e : invalid('Treść żądania nie jest poprawnym JSON'); } };
  const bearer = (req: IncomingMessage) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
  const accessOf = (req: IncomingMessage) => { const t = bearer(req), a = t ? access.get(t) : undefined; if (!a || a.validUntil < now().getTime()) throw unauthorized(); return a; };
  const authOf = (req: IncomingMessage) => { const t = bearer(req), op = [...auths.values()].find(a => a.token === t); if (!t || !op || op.validUntil < now().getTime()) throw unauthorized(); return op; };
  const sessionOf = (req: IncomingMessage, sref: string) => { const a = accessOf(req), s = sessions.get(sref); if (!s || s.nip !== a.nip) throw notFound('sesja'); return s; };

  const takeChallenge = (challenge: unknown) => {
    const c = typeof challenge === 'string' ? challenges.get(challenge) : undefined;
    if (!c || c.used || now().getTime() - c.timestampMs > CHALLENGE_TTL_MS) throw invalid('Nieprawidłowe, wykorzystane albo przeterminowane wyzwanie autoryzacyjne');
    c.used = true; return c;
  };
  const startAuth = (nip: string, final: Status, method: string) => {
    const t = now(), op: AuthOp = { ref: ref(t, 'AU'), nip, token: randomBytes(32).toString('base64url'), validUntil: t.getTime() + AUTH_TTL_MS, final, reads: 0, redeemed: false, method, started: t };
    auths.set(op.ref, op);
    return { referenceNumber: op.ref, authenticationToken: { token: op.token, validUntil: new Date(op.validUntil).toISOString() } };
  };
  const tokenOk = (nip: string, token: string) => !token.startsWith('zly') && (accepted.has(nip) ? accepted.get(nip)!.has(token) : token.length >= 8);

  const judge = (xml: string, nip: string): Status => {
    if (!new RegExp(`<Faktura\\b[^>]*\\bxmlns="${FA3_NS.replace(/[./]/g, '\\$&')}"`).test(xml) || !tag(xml, 'P_2'))
      return { code: 430, description: 'Błąd weryfikacji pliku faktury', details: ['Dokument nie jest fakturą FA (3) albo nie ma numeru faktury (P_2)'] };
    const seller = /<Podmiot1>[\s\S]*?<NIP>(\d{10})<\/NIP>[\s\S]*?<\/Podmiot1>/.exec(xml)?.[1] ?? null;
    if (seller !== nip) return { code: 450, description: 'Błąd weryfikacji semantyki dokumentu faktury', details: [`NIP sprzedawcy (Podmiot1) ${seller ?? 'brak'} różni się od NIP kontekstu ${nip}`] };
    if (mode === 'reject') return { code: 450, description: 'Błąd weryfikacji semantyki dokumentu faktury', details: ['Lokalny fake KSeF w trybie odrzucania faktur'] };
    return INV_OK;
  };
  const upo = (i: Inv) => `<?xml version="1.0" encoding="UTF-8"?>\n<Potwierdzenie xmlns="http://upo.schematy.mf.gov.pl/KSeF/v4-3"><NazwaPodmiotuPrzyjmujacego>LOKALNY FAKE KSeF — dokument bez mocy prawnej</NazwaPodmiotuPrzyjmujacego><NumerReferencyjnySesji>${esc(i.session.ref)}</NumerReferencyjnySesji><Dokument><NipSprzedawcy>${i.nip}</NipSprzedawcy><NumerKSeFDokumentu>${i.ksefNumber}</NumerKSeFDokumentu><NumerFaktury>${esc(i.invoiceNumber ?? '')}</NumerFaktury><DataWystawieniaFaktury>${esc(i.issueDate ?? '')}</DataWystawieniaFaktury><DataPrzeslaniaDokumentu>${i.received.toISOString()}</DataPrzeslaniaDokumentu><DataNadaniaNumeruKSeF>${i.acquired!.toISOString()}</DataNadaniaNumeruKSeF><SkrotDokumentu>${i.hash}</SkrotDokumentu></Dokument></Potwierdzenie>`;
  const page = (title: string, lines: string[]) => `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Lokalny fake KSeF — weryfikacja</title></head><body><h1>${esc(title)}</h1>${lines.map(l => `<p>${esc(l)}</p>`).join('')}<p>Lokalny fake KSeF — dokument bez mocy prawnej.</p></body></html>`;
  const findInvoice = (nip: string, hashB64Url: string, issueDate?: string) => accepted200.find(i => i.nip === nip && Buffer.from(i.hash, 'base64').toString('base64url') === hashB64Url && (issueDate === undefined || i.issueDate === issueDate));
  /** One invoice of a session as GET /sessions/{ref}/invoices[/{ref}] shows it; every read counts towards 'slow'. */
  const invoiceView = (s: Session, i: Inv) => {
    const done = ++i.reads > i.slowPolls, st = done ? i.final : INV_PROCESSING, ok = done && i.final.code === 200;
    return { ordinalNumber: i.ordinal, referenceNumber: i.ref, invoiceHash: i.hash, invoiceNumber: i.invoiceNumber, ksefNumber: ok ? i.ksefNumber : null,
      acquisitionDate: ok ? i.acquired!.toISOString() : null, invoicingDate: i.received.toISOString(), invoicingMode: i.offline ? 'Offline' : 'Online',
      ...(ok ? { upoDownloadUrl: `/v2/sessions/${s.ref}/invoices/ksef/${i.ksefNumber}/upo` } : {}), status: st };
  };
  const invoiceLine = (i: Inv | undefined) => i ? `Faktura jest w KSeF. Numer KSeF: ${i.ksefNumber}` : 'Faktura offline — jeszcze nieprzesłana';

  type Route = [string, RegExp, string, (req: IncomingMessage, res: ServerResponse, m: string[], host: string, query: URLSearchParams) => Promise<void> | void];
  const routes: Route[] = [
    ['POST', /^\/v2\/auth\/challenge$/, 'auth/challenge', (_q, res) => {
      const t = now(), challenge = `${ymd(t)}-CR-${hex(5)}-${hex(5)}-${hex(1)}`;
      challenges.set(challenge, { timestampMs: t.getTime(), used: false });
      send(res, 200, { challenge, timestamp: t.toISOString(), timestampMs: t.getTime() });
    }],
    ['GET', /^\/v2\/security\/public-key-certificates$/, 'security/public-key-certificates', (_q, res) => {
      const from = keysFrom.toISOString(), to = new Date(keysFrom.getTime() + 365 * 24 * 3600_000).toISOString();
      const der = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
      send(res, 200, [{ certificate: der(tokenKeys.publicKey), validFrom: from, validTo: to, usage: ['KsefTokenEncryption'] }, { certificate: der(symKeys.publicKey), validFrom: from, validTo: to, usage: ['SymmetricKeyEncryption'] }]);
    }],
    ['POST', /^\/v2\/auth\/ksef-token$/, 'auth/ksef-token', async (req, res) => {
      const b = await readJson(req), ctx = obj(b.contextIdentifier);
      if (ctx.type !== 'Nip' || typeof ctx.value !== 'string' || !/^\d{10}$/.test(ctx.value) || typeof b.encryptedToken !== 'string') throw invalid('Brak kontekstu NIP albo zaszyfrowanego tokenu');
      const c = takeChallenge(b.challenge);
      let final = BAD_TOKEN;
      try { const t = decryptKsefToken(b.encryptedToken, tokenKeys.privateKey); if (t.timestampMs === c.timestampMs && tokenOk(ctx.value, t.token)) final = AUTH_OK; } catch { /* undecryptable token = bad token */ }
      send(res, 202, startAuth(ctx.value, final, 'Token'));
    }],
    ['POST', /^\/v2\/auth\/xades-signature$/, 'auth/xades-signature', async (req, res) => {
      if (!/^application\/xml\b/i.test(req.headers['content-type'] ?? '')) throw new Fail(415, 21415, 'Wymagany Content-Type: application/xml.');
      const v = verifyAuthTokenRequest(await readBody(req)), nip = tag(v.body, 'Nip');
      if (!v.body.includes(`<AuthTokenRequest xmlns="${AUTH_NS}">`) || !nip || !/^\d{10}$/.test(nip) || tag(v.body, 'SubjectIdentifierType') !== 'certificateSubject') throw invalid('Nieprawidłowy dokument AuthTokenRequest');
      takeChallenge(tag(v.body, 'Challenge'));
      send(res, 202, startAuth(nip, v.ok ? AUTH_OK : BAD_SIGNATURE, 'QualifiedSignature'));
    }],
    ['POST', /^\/v2\/auth\/token\/redeem$/, 'auth/token/redeem', (req, res) => {
      const op = authOf(req);
      if (op.redeemed || op.final.code !== 200 || op.reads < 2) throw invalid('Uwierzytelnianie nie zakończyło się sukcesem albo token został już odebrany');
      op.redeemed = true;
      const t = now().getTime(), a = randomBytes(32).toString('base64url'), r = randomBytes(32).toString('base64url');
      access.set(a, { nip: op.nip, validUntil: t + ACCESS_TTL_MS }); refresh.set(r, { nip: op.nip, validUntil: t + REFRESH_TTL_MS });
      send(res, 200, { accessToken: { token: a, validUntil: new Date(t + ACCESS_TTL_MS).toISOString() }, refreshToken: { token: r, validUntil: new Date(t + REFRESH_TTL_MS).toISOString() } });
    }],
    ['POST', /^\/v2\/auth\/token\/refresh$/, 'auth/token/refresh', (req, res) => {
      const t = bearer(req), r = t ? refresh.get(t) : undefined;
      if (!r || r.validUntil < now().getTime()) throw unauthorized();
      const at = now().getTime(), a = randomBytes(32).toString('base64url');
      access.set(a, { nip: r.nip, validUntil: at + ACCESS_TTL_MS });
      send(res, 200, { accessToken: { token: a, validUntil: new Date(at + ACCESS_TTL_MS).toISOString() } });
    }],
    ['GET', /^\/v2\/auth\/([^/]+)$/, 'auth/status', (req, res, m) => {
      const op = authOf(req);
      if (op.ref !== m[1]) throw unauthorized();
      const status = op.reads++ === 0 ? AUTH_IN_PROGRESS : op.final;
      send(res, 200, { startDate: op.started.toISOString(), authenticationMethod: op.method, status });
    }],
    ['POST', /^\/v2\/sessions\/online$/, 'sessions/online', async (req, res) => {
      const a = accessOf(req), b = await readJson(req), f = obj(b.formCode), e = obj(b.encryption);
      if (f.systemCode !== 'FA (3)' || f.schemaVersion !== '1-0E' || f.value !== 'FA') throw invalid('Nieobsługiwany kod formularza (wymagany FA (3), 1-0E)');
      let key: Buffer, iv: Buffer;
      try { key = rsaOaepDecrypt(String(e.encryptedSymmetricKey), symKeys.privateKey); iv = Buffer.from(String(e.initializationVector), 'base64'); } catch { throw invalid('Nie można odszyfrować klucza symetrycznego'); }
      if (key.length !== 32 || iv.length !== 16) throw invalid('Klucz symetryczny musi mieć 32 bajty, a IV 16 bajtów');
      const t = now(), s: Session = { ref: ref(t, 'SO'), nip: a.nip, key, iv, open: true, validUntil: t.getTime() + SESSION_TTL_MS, invoices: [] };
      sessions.set(s.ref, s);
      send(res, 201, { referenceNumber: s.ref, validUntil: new Date(s.validUntil).toISOString() });
    }],
    ['POST', /^\/v2\/sessions\/online\/([^/]+)\/invoices$/, 'sessions/invoices/send', async (req, res, m) => {
      const s = sessionOf(req, m[1]!), b = await readJson(req);
      if (!s.open || s.validUntil < now().getTime()) throw new Fail(400, 21180, 'Sesja interaktywna jest zamknięta albo wygasła.');
      const enc = Buffer.from(String(b.encryptedInvoiceContent ?? ''), 'base64');
      if (!enc.length || b.encryptedInvoiceSize !== enc.length || b.encryptedInvoiceHash !== sha256Base64(enc)) throw invalid('Skrót albo rozmiar zaszyfrowanej faktury się nie zgadza');
      let plain: Buffer;
      try { plain = decryptInvoice(enc, s.key, s.iv); } catch { throw invalid('Nie można odszyfrować faktury kluczem sesji'); }
      if (b.invoiceSize !== plain.length || b.invoiceHash !== sha256Base64(plain)) throw invalid('Skrót albo rozmiar faktury się nie zgadza');
      if (typeof b.offlineMode !== 'boolean' && b.offlineMode !== undefined) throw invalid('offlineMode musi być wartością logiczną');
      const xml = plain.toString('utf8'), t = now();
      let final = judge(xml, s.nip);
      const dup = byHash.get(`${s.nip}|${b.invoiceHash}`);
      if (final.code === 200 && dup) final = { code: 440, description: 'Duplikat faktury', details: [`Faktura o numerze KSeF ${dup.ksefNumber} została już przyjęta w sesji ${dup.session.ref}`] };
      const inv: Inv = { ref: ref(t, 'EE'), ordinal: s.invoices.length + 1, session: s, nip: s.nip, hash: b.invoiceHash, xml, offline: b.offlineMode === true, invoiceNumber: tag(xml, 'P_2'), issueDate: tag(xml, 'P_1'),
        received: t, final, ksefNumber: null, acquired: null, reads: 0, slowPolls: mode === 'slow' ? slowPolls : 0 };
      if (final.code === 200) { inv.acquired = t; inv.ksefNumber = makeKsefNumber(s.nip, ymd(t), hex(6)); byHash.set(`${s.nip}|${inv.hash}`, inv); accepted200.push(inv); }
      s.invoices.push(inv);
      send(res, 202, { referenceNumber: inv.ref });
    }],
    ['GET', /^\/v2\/sessions\/([^/]+)\/invoices\/ksef\/([^/]+)\/upo$/, 'sessions/invoices/upo', (req, res, m) => {
      const s = sessionOf(req, m[1]!), i = s.invoices.find(x => x.ksefNumber === m[2]);
      if (!i || i.reads <= i.slowPolls) throw notFound('UPO faktury');
      send(res, 200, upo(i), 'application/xml; charset=utf-8');
    }],
    ['GET', /^\/v2\/sessions\/([^/]+)\/invoices$/, 'sessions/invoices/list', (req, res, m, _h, q) => {
      const s = sessionOf(req, m[1]!), size = Number(q.get('pageSize') ?? 10), from = Number(req.headers['x-continuation-token'] ?? 0);
      if (!Number.isSafeInteger(size) || size < 10 || size > 1000 || !Number.isSafeInteger(from) || from < 0) throw invalid('Nieprawidłowy rozmiar strony albo token kontynuacji');
      const page = s.invoices.slice(from, from + size), next = from + size < s.invoices.length ? String(from + size) : null;
      send(res, 200, { ...(next ? { continuationToken: next } : {}), invoices: page.map(i => invoiceView(s, i)) });
    }],
    ['GET', /^\/v2\/sessions\/([^/]+)\/invoices\/([^/]+)$/, 'sessions/invoices/status', (req, res, m) => {
      const s = sessionOf(req, m[1]!), i = s.invoices.find(x => x.ref === m[2]);
      if (!i) throw notFound('faktura');
      send(res, 200, invoiceView(s, i));
    }],
    ['POST', /^\/v2\/sessions\/online\/([^/]+)\/close$/, 'sessions/online/close', (req, res, m) => {
      const s = sessionOf(req, m[1]!);
      if (!s.open) throw new Fail(400, 21180, 'Sesja interaktywna jest już zamknięta.');
      s.open = false; send(res, 204);
    }],
    ['GET', /^\/qr\/invoice\/(\d{10})\/(\d{2})-(\d{2})-(\d{4})\/([A-Za-z0-9_-]{43})$/, 'qr/invoice', (_q, res, m) => {
      const i = findInvoice(m[1]!, m[5]!, `${m[4]}-${m[3]}-${m[2]}`);
      send(res, 200, page('Weryfikacja faktury (KOD I)', [`NIP sprzedawcy: ${m[1]}`, invoiceLine(i)]), 'text/html; charset=utf-8');
    }],
    ['GET', /^(\/qr\/certificate\/([A-Za-z]+)\/([^/]+)\/(\d{10})\/([0-9A-Fa-f]+)\/([A-Za-z0-9_-]{43}))\/([A-Za-z0-9_-]+)$/, 'qr/certificate', (_q, res, m, host) => {
      const key = offlineCerts.get(m[5]!.toUpperCase()), valid = key ? verifyCertificateQrPath(`${host}${m[1]}`, m[7]!, key) : false;
      const head = !key ? 'Nieznany certyfikat KSeF' : valid ? 'Podpis KOD II prawidłowy' : 'Podpis KOD II nieprawidłowy';
      send(res, 200, page(`Weryfikacja wystawcy (KOD II): ${head}`, [`Certyfikat: ${m[5]}`, `NIP sprzedawcy: ${m[4]}`, ...(valid ? [invoiceLine(findInvoice(m[4]!, m[6]!))] : [])]), 'text/html; charset=utf-8');
    }],
  ];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1'), method = req.method ?? 'GET';
    if (method === 'POST' && u.pathname === '/__fake/mode') {
      const b = await readJson(req);
      if (!MODES.includes(b.mode)) throw invalid('Nieznany tryb fake KSeF');
      fake.setMode(b.mode, { slowPolls: b.slowPolls }); send(res, 204); return;
    }
    if (mode === 'timeout') { count('timeout'); hanging.add(res); res.on('close', () => hanging.delete(res)); return; }
    if (mode === 'unavailable') { count('unavailable'); exception(res, new Fail(503, 21503, 'Usługa KSeF chwilowo niedostępna.'), { 'retry-after': '1' }); return; }
    for (const [m, re, name, fn] of routes) {
      const match = method === m ? re.exec(u.pathname) : null;
      if (match) {
        count(name);
        const lost = lose.get(name);
        if (lost) { lose.delete(name); losing.set(res, lost); }
        await fn(req, res, match.map(segment), String(req.headers.host ?? ''), u.searchParams); return;
      }
    }
    throw notFound('zasób');
  };
  const server = createServer((req, res) => {
    handle(req, res).catch(e => {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof Fail) exception(res, e); else exception(res, new Fail(500, 21500, 'Wewnętrzny błąd lokalnego fake KSeF.'));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(o.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const fake: FakeKsef = {
    url: `${origin}/v2`, origin,
    setMode(m, opts) {
      if (!MODES.includes(m)) throw new Error('Nieznany tryb fake KSeF');
      mode = m;
      if (opts?.slowPolls !== undefined) { if (!Number.isSafeInteger(opts.slowPolls) || opts.slowPolls < 0) throw new Error('slowPolls musi być nieujemną liczbą całkowitą'); slowPolls = opts.slowPolls; }
    },
    loseNextResponse(route, how = 'drop') { if (how === null) lose.delete(route); else lose.set(route, how); },
    acceptToken(nip, token) { if (!accepted.has(nip)) accepted.set(nip, new Set()); accepted.get(nip)!.add(token); },
    registerOfflineCertificate(serial, publicKeyPem) { offlineCerts.set(serial.toUpperCase(), publicKeyFromPem(publicKeyPem)); },
    invoices: () => accepted200.map(i => ({ nip: i.nip, ksefNumber: i.ksefNumber!, invoiceHash: i.hash, xml: i.xml, offlineMode: i.offline })),
    stats: () => ({ ...counters }),
    close: () => new Promise<void>(resolve => { for (const r of hanging) r.destroy(); server.close(() => resolve()); server.closeAllConnections(); }),
  };
  return fake;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port'), port = i > 0 ? Number(process.argv[i + 1]) : 4239;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) { process.stderr.write('Nieprawidłowy numer portu\n'); process.exit(2); }
  const fake = await startFakeKsef({ port });
  process.stdout.write(`Lokalny fake KSeF 2.0: ${fake.url}\n`);
  const stop = () => { void fake.close().then(() => process.exit(0)); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
