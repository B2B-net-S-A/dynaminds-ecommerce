import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { createGunzip } from 'node:zlib';

/** No application configuration, DB, automatic retries, redirects, or cookie jar. */
export const SUPPLIER_REMOTE_FETCH_LIMITS = Object.freeze({
  wire_bytes: 2 * 1024 * 1024,
  decoded_bytes: 2 * 1024 * 1024,
  header_bytes: 16 * 1024,
  deadline_ms: 30_000,
  connect_ms: 10_000,
  idle_ms: 10_000,
});

export type SupplierRemoteFetchErrorCode =
  | 'INVALID_URL' | 'INVALID_AUTH' | 'INVALID_CONDITIONAL'
  | 'DNS_FAILED' | 'DENIED_ADDRESS' | 'PEER_MISMATCH' | 'TLS_FAILED'
  | 'DEADLINE' | 'CONNECT_TIMEOUT' | 'IDLE_TIMEOUT' | 'ABORTED'
  | 'NETWORK_FAILED' | 'INCOMPLETE_RESPONSE' | 'HEADERS_TOO_LARGE'
  | 'REDIRECT' | 'HTTP_STATUS' | 'UNEXPECTED_NOT_MODIFIED'
  | 'HTML_RESPONSE'
  | 'UNSUPPORTED_ENCODING' | 'WIRE_TOO_LARGE' | 'DECODED_TOO_LARGE'
  | 'INVALID_COMPRESSION' | 'EMPTY_BODY' | 'INVALID_UTF8';

/** Fixed codes/messages only: never include upstream errors, URL/query or credentials. */
export class SupplierRemoteFetchError extends Error {
  readonly http_status?: number;
  constructor(public readonly code: SupplierRemoteFetchErrorCode, status?: number) {
    super(`Supplier feed transport: ${code}`);
    this.name = 'SupplierRemoteFetchError';
    if (Number.isInteger(status) && status! >= 100 && status! <= 599) this.http_status = status;
  }
}

export type SupplierRemoteFetchAuth =
  | { kind: 'none' }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'bearer'; token: string }
  | { kind: 'header'; name: string; value: string };
export type SupplierRemoteFetchInput = {
  url: string;
  auth?: SupplierRemoteFetchAuth;
  conditional?: { etag?: string; last_modified?: string };
  signal?: AbortSignal;
};
export type SupplierRemoteFeedResult =
  | { kind: 'downloaded'; status: 200; content: string; wire_bytes: number;
      decoded_bytes: number; wire_hash: string; raw_hash: string }
  | { kind: 'not_modified'; status: 304 };
export type SupplierRemoteFetchDependencies = {
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof httpsRequest;
  /** Tests/callers may tighten deadlines, never increase production bounds. */
  timeouts?: Partial<{ deadline_ms: number; connect_ms: number; idle_ms: number }>;
};

const error = (code: SupplierRemoteFetchErrorCode) => new SupplierRemoteFetchError(code);
const ipv4 = (s: string) => s.split('.').reduce((n, b) => (n << 8n) | BigInt(b), 0n);
const within = (n: bigint, base: bigint, bits: number, width: number) =>
  n >> BigInt(width - bits) === base >> BigInt(width - bits);
const denied4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  // Azure host/platform WireServer virtual address; not a supplier feed origin.
  ['168.63.129.16', 32],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];
function ipv6(s: string): bigint {
  const [left, right] = s.toLowerCase().split('::');
  const a = left ? left.split(':') : [];
  const b = right ? right.split(':') : [];
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  return words.reduce((n, word) => (n << 16n) | BigInt(`0x${word}`), 0n);
}

/** Conservative global-unicast allow policy. Transition/mapped IPv6 is denied. */
export function isPublicSupplierFeedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied4.some(([base, bits]) => within(ipv4(address), ipv4(base), bits, 32));
  if (family !== 6 || address.includes('%') || address.includes('.')) return false;
  const n = ipv6(address);
  return within(n, ipv6('2000::'), 3, 128)
    && !within(n, ipv6('2001::'), 23, 128)
    && !within(n, ipv6('2001:db8::'), 32, 128)
    && !within(n, ipv6('2002::'), 16, 128)
    && !within(n, ipv6('3fff::'), 20, 128);
}

function peerMatches(peer: string | undefined, pinned: string): boolean {
  if (!peer) return false;
  if (isIP(pinned) === 4) {
    // OS may represent an IPv4 socket as IPv4-mapped IPv6; input DNS/URLs cannot.
    if (peer.toLowerCase().startsWith('::ffff:') && isIP(peer.slice(7)) === 4) peer = peer.slice(7);
    return isIP(peer) === 4 && ipv4(peer) === ipv4(pinned);
  }
  return isIP(peer) === 6 && !peer.includes('.') && !peer.includes('%') && ipv6(peer) === ipv6(pinned);
}

export function supplierRemoteFeedUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw error('INVALID_URL'); }
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(value)
    || url.protocol !== 'https:' || url.username || url.password || url.hash
    || (url.port && url.port !== '443') || !url.hostname || Buffer.byteLength(url.href) > 8192) throw error('INVALID_URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicSupplierFeedAddress(host)) throw error('DENIED_ADDRESS');
  } else if (!host.includes('.') || host.endsWith('.') || !/^[a-z0-9.-]+$/i.test(host)
    || host.split('.').some((part) => !part || part.length > 63 || part.startsWith('-') || part.endsWith('-')))
    throw error('INVALID_URL');
  return url;
}

function safeHeader(value: unknown, code: 'INVALID_AUTH' | 'INVALID_CONDITIONAL'): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[^\x20-\x7e]/u.test(value)) throw error(code);
  return value;
}
function authHeaders(auth?: SupplierRemoteFetchAuth): Record<string, string> {
  if (!auth || auth.kind === 'none') return {};
  if (auth.kind === 'bearer') return { Authorization: `Bearer ${safeHeader(auth.token, 'INVALID_AUTH')}` };
  if (auth.kind === 'basic') {
    if (typeof auth.username !== 'string' || typeof auth.password !== 'string' || auth.username.includes(':')
      || auth.username.length + auth.password.length > 4096 || /[\u0000-\u001f\u007f]/u.test(auth.username + auth.password))
      throw error('INVALID_AUTH');
    return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}` };
  }
  // Single purpose API-key header only; cannot override transport/conditional headers.
  if (auth.kind === 'header' && /^x-[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(auth.name)
    && !/^x-(?:forwarded|real-ip|http-method|proxy|original|rewrite)(?:-|$)/i.test(auth.name))
    return { [auth.name]: safeHeader(auth.value, 'INVALID_AUTH') };
  throw error('INVALID_AUTH');
}

/**
 * One GET to one DNS-pinned address. TLS verifies the original host, not the IP.
 * req.end() is delayed until TLS authorization AND actual peer verification, so
 * auth/query are not sent before those checks. Node/OWASP references in contract.
 * 304 has no content; only the scheduler's immutable provenance may reuse raw.
 */
export async function fetchSupplierRemoteFeed(
  input: SupplierRemoteFetchInput, dependencies: SupplierRemoteFetchDependencies = {},
): Promise<SupplierRemoteFeedResult> {
  const url = supplierRemoteFeedUrl(input.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const headers: Record<string, string> = {
    Host: url.host, Accept: '*/*', 'Accept-Encoding': 'gzip, identity', Connection: 'close', ...authHeaders(input.auth),
  };
  if (input.conditional?.etag !== undefined) headers['If-None-Match'] = safeHeader(input.conditional.etag, 'INVALID_CONDITIONAL');
  if (input.conditional?.last_modified !== undefined)
    headers['If-Modified-Since'] = safeHeader(input.conditional.last_modified, 'INVALID_CONDITIONAL');
  if (Object.entries(headers).reduce((n, [key, value]) => n + Buffer.byteLength(key + value) + 4, 0)
    > SUPPLIER_REMOTE_FETCH_LIMITS.header_bytes) throw error('INVALID_AUTH');
  const time = (key: 'deadline_ms' | 'connect_ms' | 'idle_ms') => {
    const n = dependencies.timeouts?.[key] ?? SUPPLIER_REMOTE_FETCH_LIMITS[key];
    if (!Number.isInteger(n) || n <= 0 || n > SUPPLIER_REMOTE_FETCH_LIMITS[key]) throw error('INVALID_URL');
    return n;
  };
  const deadline = time('deadline_ms'), connect = time('connect_ms'), idle = time('idle_ms');
  const controller = new AbortController();
  const abort = () => controller.abort(error('ABORTED'));
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const deadlineTimer = setTimeout(() => controller.abort(error('DEADLINE')), deadline);
  const reason = () => controller.signal.reason instanceof SupplierRemoteFetchError ? controller.signal.reason : error('ABORTED');
  try {
    const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      if (controller.signal.aborted) { reject(reason()); return; }
      const onAbort = () => reject(reason());
      controller.signal.addEventListener('abort', onAbort, { once: true });
      const dns = isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }])
        : Promise.resolve().then(() => (dependencies.resolve ?? ((h) => lookup(h, { all: true, verbatim: true })))(host));
      dns.then(resolve, () => reject(error('DNS_FAILED'))).finally(() => controller.signal.removeEventListener('abort', onAbort));
    });
    if (!addresses.length || addresses.length > 64 || addresses.some((a) => a.family !== isIP(a.address)
      || !isPublicSupplierFeedAddress(a.address))) throw error('DENIED_ADDRESS');
    const pinned = addresses[0]!;
    if (controller.signal.aborted) throw reason();
    return await new Promise<SupplierRemoteFeedResult>((resolve, reject) => {
      let settled = false;
      let verified = false;
      let response: import('node:http').IncomingMessage | undefined;
      let decoder: ReturnType<typeof createGunzip> | undefined;
      let req: import('node:http').ClientRequest | undefined;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (err?: SupplierRemoteFetchError, result?: SupplierRemoteFeedResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        controller.signal.removeEventListener('abort', onAbort);
        if (err) { response?.destroy(); decoder?.destroy(); req?.destroy(); reject(err); }
        else { resolve(result!); }
      };
      const onAbort = () => finish(reason());
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) { onAbort(); return; }
      const options: RequestOptions = {
        protocol: 'https:', hostname: pinned.address, family: pinned.family, port: 443,
        method: 'GET', path: url.pathname + url.search, headers,
        agent: false, rejectUnauthorized: true, servername: isIP(host) ? '' : host,
        checkServerIdentity: (_hostname, cert) => checkServerIdentity(host, cert),
        maxHeaderSize: SUPPLIER_REMOTE_FETCH_LIMITS.header_bytes,
      };
      connectTimer = setTimeout(() => finish(error('CONNECT_TIMEOUT')), connect);
      try {
        req = (dependencies.request ?? httpsRequest)(options, (res) => {
          response = res;
          void (async () => {
            if (!verified) throw error('PEER_MISMATCH');
            const headerBytes = res.rawHeaders.reduce((n, h) => n + Buffer.byteLength(h) + 4, 0);
            if (headerBytes > SUPPLIER_REMOTE_FETCH_LIMITS.header_bytes) throw error('HEADERS_TOO_LARGE');
            const status = res.statusCode;
            if (status !== 304 && status !== 200) throw new SupplierRemoteFetchError(status && status >= 300 && status < 400 ? 'REDIRECT' : 'HTTP_STATUS', status);
            if (status === 304 && !headers['If-None-Match'] && !headers['If-Modified-Since']) throw error('UNEXPECTED_NOT_MODIFIED');
            const encoding = res.headers['content-encoding'] ?? 'identity';
            if (status === 200 && encoding !== 'identity' && encoding !== 'gzip') throw error('UNSUPPORTED_ENCODING');
            const contentType = res.headers['content-type'];
            if (status === 200 && typeof contentType === 'string'
              && /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(contentType)) throw error('HTML_RESPONSE');
            const length = res.headers['content-length'];
            if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length))) throw error('INCOMPLETE_RESPONSE');
            if (status === 200 && length !== undefined && BigInt(length) > BigInt(SUPPLIER_REMOTE_FETCH_LIMITS.wire_bytes)) throw error('WIRE_TOO_LARGE');
            let wire = 0, decoded = 0;
            const wireHash = createHash('sha256');
            const chunks: Buffer[] = [];
            const wireBound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
              wire += chunk.length;
              if (wire > SUPPLIER_REMOTE_FETCH_LIMITS.wire_bytes) { callback(error('WIRE_TOO_LARGE')); return; }
              wireHash.update(chunk); callback(null, chunk);
            } });
            const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
              decoded += chunk.length;
              if (decoded > SUPPLIER_REMOTE_FETCH_LIMITS.decoded_bytes) { callback(error('DECODED_TOO_LARGE')); return; }
              if (status === 304 && decoded) { callback(error('INCOMPLETE_RESPONSE')); return; }
              chunks.push(Buffer.from(chunk)); callback();
            } });
            if (encoding === 'gzip' && status !== 304) {
              decoder = createGunzip();
              await pipeline(res, wireBound, decoder, sink);
            } else await pipeline(res, wireBound, sink);
            // A 304 Content-Length describes the prior representation, not its body.
            if (!res.complete || (status === 200 && length !== undefined && BigInt(length) !== BigInt(wire))) throw error('INCOMPLETE_RESPONSE');
            if (status === 304) { finish(undefined, { kind: 'not_modified', status: 304 }); return; }
            if (!decoded) throw error('EMPTY_BODY');
            const bytes = Buffer.concat(chunks, decoded);
            let content: string;
            try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
            catch { throw error('INVALID_UTF8'); }
            if (!Buffer.from(content, 'utf8').equals(bytes)) throw error('INVALID_UTF8');
            // Known HTML error pages cannot be treated as a completed CSV/XML feed.
            // Other source-format/row validation remains the parser's responsibility.
            if (/^\ufeff?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!doctype\s+html\b|<(?:html|head|body)(?:\s|>))/i.test(content))
              throw error('HTML_RESPONSE');
            finish(undefined, { kind: 'downloaded', status: 200, content, wire_bytes: wire,
              decoded_bytes: decoded, wire_hash: wireHash.digest('hex'), raw_hash: createHash('sha256').update(bytes).digest('hex') });
          })().catch((err: unknown) => finish(err instanceof SupplierRemoteFetchError ? err
            : error(!res.complete ? 'INCOMPLETE_RESPONSE' : encodingFailure(res.headers['content-encoding']))));
        });
        req.on('error', () => finish(error('NETWORK_FAILED')));
        req.setTimeout(idle, () => finish(error('IDLE_TIMEOUT')));
        req.on('socket', (socket) => {
          const tls = socket as TLSSocket;
          const connected = () => {
            if (settled) return;
            if (!tls.encrypted || !tls.authorized) { finish(error('TLS_FAILED')); return; }
            if (!peerMatches(tls.remoteAddress, pinned.address)) { finish(error('PEER_MISMATCH')); return; }
            verified = true;
            clearTimeout(connectTimer);
            req!.end();
          };
          if (tls.encrypted && !tls.connecting && tls.authorized) connected();
          else tls.once('secureConnect', connected);
        });
      } catch { finish(error('NETWORK_FAILED')); }
    });
  } finally {
    clearTimeout(deadlineTimer);
    input.signal?.removeEventListener('abort', abort);
  }
}
function encodingFailure(encoding: string | string[] | undefined): SupplierRemoteFetchErrorCode {
  return encoding === 'gzip' ? 'INVALID_COMPRESSION' : 'NETWORK_FAILED';
}
