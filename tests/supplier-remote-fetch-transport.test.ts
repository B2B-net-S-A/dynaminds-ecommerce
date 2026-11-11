import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions, request } from 'node:https';
import { Readable } from 'node:stream';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  fetchSupplierRemoteFeed, isPublicSupplierFeedAddress, supplierRemoteFeedUrl,
  SUPPLIER_REMOTE_FETCH_LIMITS, SupplierRemoteFetchError,
  type SupplierRemoteFetchDependencies, type SupplierRemoteFetchErrorCode,
} from '../server/supplier-remote-fetch-transport.js';

const publicIp = '8.8.8.8';
const url = 'https://supplier.example/feed.csv?signature=secret-query';
const code = (expected: SupplierRemoteFetchErrorCode) => (e: unknown) => {
  assert.ok(e instanceof SupplierRemoteFetchError);
  assert.equal(e.code, expected);
  assert.equal(e.message, `Supplier feed transport: ${expected}`);
  assert.equal('cause' in e, false);
  return true;
};
type MockOptions = {
  status?: number; body?: Buffer[]; headers?: Record<string, string>;
  remoteAddress?: string; authorized?: boolean; encrypted?: boolean;
  complete?: boolean; hangConnect?: boolean; hangBody?: boolean;
  premature?: boolean; networkError?: string; rawHeaders?: string[];
  trickle_ms?: number;
};
function mock(o: MockOptions = {}) {
  const seen: RequestOptions[] = [];
  let ended = 0, destroyed = 0, responseDestroyed = 0;
  const make = ((options: RequestOptions, callback: (r: IncomingMessage) => void) => {
    seen.push(options);
    const req = new EventEmitter() as EventEmitter & {
      end: () => void; destroy: () => void; setTimeout: (n: number, cb: () => void) => void;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleMs = 0;
    let idleCallback: (() => void) | undefined;
    const activity = () => {
      clearTimeout(timer);
      if (idleCallback) timer = setTimeout(idleCallback, idleMs);
    };
    req.destroy = () => { destroyed++; clearTimeout(timer); };
    req.setTimeout = (n, cb) => { idleMs = n; idleCallback = cb; activity(); };
    req.end = () => {
      ended++;
      queueMicrotask(() => {
        if (o.networkError) { req.emit('error', new Error(o.networkError)); return; }
        const body = o.body ?? [Buffer.from('sku;cost\r\nSYNTHETIC;10,00\r\n')];
        let trickleTimer: ReturnType<typeof setInterval> | undefined;
        const r = (o.trickle_ms ? new Readable({ read() {
          if (trickleTimer) return;
          let index = 0;
          trickleTimer = setInterval(() => {
            if (index < body.length) this.push(body[index++]);
            else { clearInterval(trickleTimer); this.push(null); }
          }, o.trickle_ms);
        } }) : o.hangBody || o.premature ? new Readable({ read() {
          if (o.premature) { this.push(body[0]); this.destroy(new Error('secret upstream premature failure')); }
        } }) : Readable.from(body)) as Readable & {
          statusCode: number; headers: Record<string, string>; rawHeaders: string[]; complete: boolean;
        };
        r.statusCode = o.status ?? 200;
        r.headers = o.headers ?? {};
        r.rawHeaders = o.rawHeaders ?? Object.entries(r.headers).flat();
        r.complete = o.complete ?? !o.premature;
        r.on('data', activity);
        r.on('close', () => { responseDestroyed++; clearTimeout(timer); clearInterval(trickleTimer); });
        r.on('end', () => { clearTimeout(timer); });
        callback(r as unknown as IncomingMessage);
      });
    };
    queueMicrotask(() => {
      const socket = Object.assign(new EventEmitter(), {
        encrypted: o.encrypted ?? true, authorized: o.authorized ?? true,
        connecting: true, remoteAddress: o.remoteAddress ?? publicIp,
      });
      req.emit('socket', socket);
      if (!o.hangConnect) { socket.connecting = false; socket.emit('secureConnect'); }
    });
    return req;
  }) as unknown as typeof request;
  const dependencies: SupplierRemoteFetchDependencies = {
    resolve: async () => [{ address: publicIp, family: 4 }], request: make,
  };
  return { dependencies, seen, counts: () => ({ ended, destroyed, responseDestroyed }) };
}

test('address policy denies private, reserved, mapped, zone and transition addresses', () => {
  for (const a of [
    '0.0.0.0', '0.8.8.8', '10.0.0.1', '100.64.0.1', '100.127.255.255',
    '127.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255', '168.63.129.16',
    '192.0.0.9', '192.0.2.2', '192.88.99.1', '192.168.1.1', '198.18.0.1',
    '198.19.255.255', '198.51.100.2', '203.0.113.2', '224.0.0.1', '239.255.255.255',
    '240.0.0.1', '255.255.255.255', '127.1', '2130706433', '0x7f000001',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:0808:0808',
    'fc00::1', 'fd12::2', 'fe80::1', 'fe80::1%en0', 'ff02::1',
    '64:ff9b::7f00:1', '2002:7f00:1::1', '2001::1', '2001:20::1',
    '2001:db8::1', '3fff::1', 'bad-ip',
  ]) assert.equal(isPublicSupplierFeedAddress(a), false, a);
  for (const a of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1',
    '172.15.255.255', '172.32.0.1', '198.20.0.1', '223.255.255.255',
    '2606:4700:4700::1111', '2001:4860:4860::8888'])
    assert.equal(isPublicSupplierFeedAddress(a), true, a);
});

test('URL normalization cannot bypass private IP policy; HTTPS origin is strict', () => {
  for (const u of ['https://127.1/feed', 'https://2130706433/feed', 'https://0x7f000001/feed',
    'https://0177.0.0.1/feed', 'https://%31%32%37.0.0.1/feed',
    'https://[::ffff:127.0.0.1]/feed', 'https://168.63.129.16/feed']) assert.throws(() => supplierRemoteFeedUrl(u), code('DENIED_ADDRESS'));
  for (const u of ['http://supplier.example/feed', 'https://user:password@supplier.example/feed',
    'https://supplier.example:8443/feed', 'https://supplier.example/feed#fragment',
    'https://localhost/feed', 'https://supplier.example./feed', 'https://supplier.example/\nsecret',
    'https://supplier.example\\@127.0.0.1/feed']) assert.throws(() => supplierRemoteFeedUrl(u), code('INVALID_URL'));
  assert.equal(supplierRemoteFeedUrl(url).search, '?signature=secret-query');
});

test('all DNS answers must be public; no connection on mixed, malformed or failed DNS', async () => {
  for (const addresses of [[{ address: publicIp, family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: publicIp, family: 4 }, { address: '168.63.129.16', family: 4 }],
    [{ address: publicIp, family: 6 }], [], [{ address: '::ffff:8.8.8.8', family: 6 }]]) {
    const m = mock(); m.dependencies.resolve = async () => addresses;
    await assert.rejects(fetchSupplierRemoteFeed({ url }, m.dependencies), code('DENIED_ADDRESS'));
    assert.equal(m.seen.length, 0);
  }
  const m = mock(); m.dependencies.resolve = async () => { throw new Error('secret DNS URL'); };
  await assert.rejects(fetchSupplierRemoteFeed({ url }, m.dependencies), code('DNS_FAILED'));
  assert.equal(m.seen.length, 0);
});

test('one pinned GET uses original Host/SNI/certificate identity and exact UTF8 bytes', async () => {
  const bytes = Buffer.from('\ufeffsku;name\r\nA;Łódź 🦊\r\n');
  const m = mock({ body: [bytes.subarray(0, 12), bytes.subarray(12, 18), bytes.subarray(18)],
    headers: { 'content-length': String(bytes.length) } });
  const result = await fetchSupplierRemoteFeed({ url, auth: { kind: 'bearer', token: 'private-token' } }, m.dependencies);
  assert.equal(result.kind, 'downloaded');
  if (result.kind !== 'downloaded') throw new Error('unexpected result');
  assert.equal(result.content, bytes.toString('utf8'));
  assert.equal(result.raw_hash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.wire_hash, result.raw_hash);
  assert.equal(result.wire_bytes, bytes.length);
  assert.equal(result.decoded_bytes, bytes.length);
  assert.equal(m.seen.length, 1); assert.equal(m.counts().ended, 1);
  const options = m.seen[0]!;
  assert.equal(options.hostname, publicIp); assert.equal(options.servername, 'supplier.example');
  assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
  assert.equal(options.maxHeaderSize, 16384);
  assert.equal(options.path, '/feed.csv?signature=secret-query');
  assert.deepEqual(options.headers, { Host: 'supplier.example', Accept: '*/*',
    'Accept-Encoding': 'gzip, identity', Connection: 'close', Authorization: 'Bearer private-token' });
  const valid = { subjectaltname: 'DNS:supplier.example' } as Parameters<NonNullable<RequestOptions['checkServerIdentity']>>[1];
  assert.equal(options.checkServerIdentity!('8.8.8.8', valid), undefined);
  assert.ok(options.checkServerIdentity!('8.8.8.8', { ...valid, subjectaltname: 'DNS:other.example' }));
});

test('peer and TLS failure happen before end/auth transmission, IPv6 comparison canonical', async () => {
  for (const o of [{ remoteAddress: '1.1.1.1' }, { remoteAddress: '127.0.0.1' },
    { authorized: false }, { encrypted: false }]) {
    const m = mock(o);
    await assert.rejects(fetchSupplierRemoteFeed({ url }, m.dependencies), code('remoteAddress' in o ? 'PEER_MISMATCH' : 'TLS_FAILED'));
    assert.equal(m.counts().ended, 0);
    assert.equal(m.counts().destroyed, 1);
  }
  const m = mock({ remoteAddress: '2606:4700:4700:0:0:0:0:1111' });
  m.dependencies.resolve = async () => [{ address: '2606:4700:4700::1111', family: 6 }];
  assert.equal((await fetchSupplierRemoteFeed({ url }, m.dependencies)).kind, 'downloaded');
  const mapped = mock({ remoteAddress: '::ffff:8.8.8.8' });
  assert.equal((await fetchSupplierRemoteFeed({ url }, mapped.dependencies)).kind, 'downloaded');
});

test('auth header allowlist and conditional inputs cannot override routing or inject lines', async () => {
  for (const auth of [
    { kind: 'header', name: 'Host', value: 'evil.example' },
    { kind: 'header', name: 'Cookie', value: 'secret' },
    { kind: 'header', name: 'X-Forwarded-Host', value: 'evil.example' },
    { kind: 'header', name: 'X-HTTP-Method-Override', value: 'POST' },
    { kind: 'bearer', token: 'secret\r\nHost: evil.example' },
    { kind: 'basic', username: 'user:another', password: 'secret' },
  ] as const) {
    const m = mock();
    await assert.rejects(fetchSupplierRemoteFeed({ url, auth }, m.dependencies), code('INVALID_AUTH'));
    assert.equal(m.seen.length, 0);
  }
  const m = mock();
  await assert.rejects(fetchSupplierRemoteFeed({ url, conditional: { etag: 'secret\nHost: evil' } }, m.dependencies), code('INVALID_CONDITIONAL'));
  assert.equal(m.seen.length, 0);
  const key = mock();
  await fetchSupplierRemoteFeed({ url, auth: { kind: 'header', name: 'X-Api-Key', value: 'secret' } }, key.dependencies);
  assert.equal((key.seen[0]!.headers as Record<string, string>)['X-Api-Key'], 'secret');
});

test('redirects and all non-feed statuses are rejected with no second request', async () => {
  for (const status of [301, 302, 303, 307, 308, 204, 206, 401, 403, 429, 500]) {
    const m = mock({ status, headers: { location: 'http://127.0.0.1/?secret' } });
    await assert.rejects(fetchSupplierRemoteFeed({ url, auth: { kind: 'basic', username: 'user', password: 'password' } }, m.dependencies),
      (e: unknown) => {
        assert(e instanceof SupplierRemoteFetchError);
        assert.equal(e.code, status >= 300 && status < 400 ? 'REDIRECT' : 'HTTP_STATUS');
        assert.equal(e.http_status, status);
        assert(!JSON.stringify(e).includes('secret'));
        return true;
      });
    assert.equal(m.seen.length, 1); assert.equal(m.counts().ended, 1);
  }
});

test('304 is typed no-body result requiring a conditional request; never a valid feed', async () => {
  const m = mock({ status: 304, body: [], headers: { 'content-length': String(SUPPLIER_REMOTE_FETCH_LIMITS.wire_bytes + 123) } });
  assert.deepEqual(await fetchSupplierRemoteFeed({ url, conditional: { etag: '"owned-prior"' } }, m.dependencies),
    { kind: 'not_modified', status: 304 });
  const unsolicited = mock({ status: 304, body: [] });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, unsolicited.dependencies), code('UNEXPECTED_NOT_MODIFIED'));
  const body = mock({ status: 304 });
  await assert.rejects(fetchSupplierRemoteFeed({ url, conditional: { etag: '"owned-prior"' } }, body.dependencies), code('INCOMPLETE_RESPONSE'));
});

test('identity stream exact limit accepted; encoded and declared overflow rejected', async () => {
  const limit = SUPPLIER_REMOTE_FETCH_LIMITS.wire_bytes;
  const exact = mock({ body: [Buffer.alloc(limit, 65)] });
  const result = await fetchSupplierRemoteFeed({ url }, exact.dependencies);
  assert.equal(result.kind === 'downloaded' && result.wire_bytes, limit);
  const over = mock({ body: [Buffer.alloc(limit, 65), Buffer.from('B')] });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, over.dependencies), code('WIRE_TOO_LARGE'));
  const declared = mock({ headers: { 'content-length': String(limit + 1) }, body: [] });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, declared.dependencies), code('WIRE_TOO_LARGE'));
});

test('gzip has independent wire/decoded hashes and decoded bomb cannot pass 2MiB', async () => {
  const plain = Buffer.from('id;name\n1;Zażółć\n'); const gzip = gzipSync(plain);
  const m = mock({ body: [gzip.subarray(0, 8), gzip.subarray(8)], headers: { 'content-encoding': 'gzip' } });
  const result = await fetchSupplierRemoteFeed({ url }, m.dependencies);
  assert.equal(result.kind, 'downloaded');
  if (result.kind !== 'downloaded') throw new Error('unexpected result');
  assert.equal(result.content, plain.toString()); assert.equal(result.wire_bytes, gzip.length);
  assert.equal(result.decoded_bytes, plain.length);
  assert.equal(result.raw_hash, createHash('sha256').update(plain).digest('hex'));
  assert.equal(result.wire_hash, createHash('sha256').update(gzip).digest('hex'));
  const bomb = mock({ body: [gzipSync(Buffer.alloc(SUPPLIER_REMOTE_FETCH_LIMITS.decoded_bytes + 1, 65))],
    headers: { 'content-encoding': 'gzip' } });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, bomb.dependencies), code('DECODED_TOO_LARGE'));
  const invalid = mock({ body: [Buffer.from('secret not gzip')], headers: { 'content-encoding': 'gzip' } });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, invalid.dependencies), code('INVALID_COMPRESSION'));
  const truncated = mock({ body: [gzip.subarray(0, gzip.length - 4)], headers: { 'content-encoding': 'gzip' } });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, truncated.dependencies), code('INVALID_COMPRESSION'));
  const corrupt = Buffer.from(gzip); corrupt[corrupt.length - 8] ^= 1;
  const crc = mock({ body: [corrupt], headers: { 'content-encoding': 'gzip' } });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, crc.dependencies), code('INVALID_COMPRESSION'));
  const joined = mock({ body: [Buffer.concat([gzip, gzipSync(Buffer.from('2;Second\n'))])], headers: { 'content-encoding': 'gzip' } });
  const joinedResult = await fetchSupplierRemoteFeed({ url }, joined.dependencies);
  assert.equal(joinedResult.kind === 'downloaded' && joinedResult.content, plain.toString() + '2;Second\n');
  const joinedBomb = mock({ body: [Buffer.concat([gzip,
    gzipSync(Buffer.alloc(SUPPLIER_REMOTE_FETCH_LIMITS.decoded_bytes, 65))])], headers: { 'content-encoding': 'gzip' } });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, joinedBomb.dependencies), code('DECODED_TOO_LARGE'));
});

test('declared or disguised HTML error responses cannot masquerade as successful feeds', async () => {
  for (const o of [{ headers: { 'content-type': 'text/html; charset=UTF-8' } },
    { headers: { 'content-type': 'application/xhtml+xml' } },
    { body: [Buffer.from('\ufeff\n<!DOCTYPE html><html>Access denied</html>')] },
    { body: [Buffer.from('<?xml version="1.0"?><html>Authentication error</html>')] }]) {
    const m = mock(o);
    await assert.rejects(fetchSupplierRemoteFeed({ url }, m.dependencies), code('HTML_RESPONSE'));
  }
});

test('encoding allowlist, header bound, premature close, length, empty and invalid UTF8 fail closed', async () => {
  for (const encoding of ['br', 'deflate', 'gzip, identity', 'unknown']) {
    const m = mock({ headers: { 'content-encoding': encoding } });
    await assert.rejects(fetchSupplierRemoteFeed({ url }, m.dependencies), code('UNSUPPORTED_ENCODING'));
  }
  const huge = mock({ rawHeaders: ['X-Anything', 'A'.repeat(16384)] });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, huge.dependencies), code('HEADERS_TOO_LARGE'));
  const premature = mock({ premature: true });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, premature.dependencies), code('INCOMPLETE_RESPONSE'));
  const incomplete = mock({ complete: false });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, incomplete.dependencies), code('INCOMPLETE_RESPONSE'));
  const length = mock({ body: [Buffer.from('abc')], headers: { 'content-length': '4' } });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, length.dependencies), code('INCOMPLETE_RESPONSE'));
  const empty = mock({ body: [] });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, empty.dependencies), code('EMPTY_BODY'));
  for (const bytes of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82])]) {
    const invalid = mock({ body: [bytes] });
    await assert.rejects(fetchSupplierRemoteFeed({ url }, invalid.dependencies), code('INVALID_UTF8'));
  }
});

test('deadline includes DNS, connect/idle timers abort resources, no retry after network failure', async () => {
  const dns = mock(); dns.dependencies.resolve = () => new Promise(() => {});
  dns.dependencies.timeouts = { deadline_ms: 20 };
  await assert.rejects(fetchSupplierRemoteFeed({ url }, dns.dependencies), code('DEADLINE'));
  assert.equal(dns.seen.length, 0);
  const connect = mock({ hangConnect: true }); connect.dependencies.timeouts = { connect_ms: 20 };
  await assert.rejects(fetchSupplierRemoteFeed({ url }, connect.dependencies), code('CONNECT_TIMEOUT'));
  assert.equal(connect.counts().destroyed, 1); assert.equal(connect.counts().ended, 0);
  const idle = mock({ hangBody: true }); idle.dependencies.timeouts = { idle_ms: 20 };
  await assert.rejects(fetchSupplierRemoteFeed({ url }, idle.dependencies), code('IDLE_TIMEOUT'));
  assert.equal(idle.counts().destroyed, 1);
  const failed = mock({ networkError: 'https://user:password@secret.example/?token=private-token' });
  await assert.rejects(fetchSupplierRemoteFeed({ url }, failed.dependencies), code('NETWORK_FAILED'));
  assert.equal(failed.seen.length, 1);
});

test('external abort before DNS or during body is sanitized and closes owned resources', async () => {
  const early = new AbortController(); early.abort(new Error('secret caller reason'));
  const m = mock();
  await assert.rejects(fetchSupplierRemoteFeed({ url, signal: early.signal }, m.dependencies), code('ABORTED'));
  assert.equal(m.seen.length, 0);
  const during = new AbortController(); const hanging = mock({ hangBody: true });
  const promise = fetchSupplierRemoteFeed({ url, signal: during.signal }, hanging.dependencies);
  setTimeout(() => during.abort(new Error('secret token')), 10);
  await assert.rejects(promise, code('ABORTED'));
  assert.equal(hanging.counts().destroyed, 1); assert.equal(hanging.counts().ended, 1);
});

test('active body trickle below idle threshold still stops at total deadline, without retry', async () => {
  const m = mock({ trickle_ms: 5, body: Array.from({ length: 100 }, () => Buffer.from('A')) });
  m.dependencies.timeouts = { idle_ms: 30, deadline_ms: 60 };
  await assert.rejects(fetchSupplierRemoteFeed({ url }, m.dependencies), code('DEADLINE'));
  // Complete cleanup is asynchronous when pipeline is destroyed by the deadline.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(m.seen.length, 1);
  assert.deepEqual(m.counts(), { ended: 1, destroyed: 1, responseDestroyed: 1 });
});
