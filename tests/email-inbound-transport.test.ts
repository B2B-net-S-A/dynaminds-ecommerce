import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ImapFlow, ImapFlowOptions } from 'imapflow';
import {
  fetchInboundMailbox,
  EmailInboundError,
  EMAIL_INBOUND_LIMITS as L,
  type InboundMailboxConfig,
} from '../server/email-inbound-transport';

const config: InboundMailboxConfig = {
  host: 'mail.example.test',
  port: 993,
  transport: 'tls',
  folder: 'INBOX',
  username: 'private-user',
  password: 'private-password',
};
const raw = Buffer.from(
  'From: sender@example.test\r\nTo: receiver@example.test\r\nSubject: Test\r\n\r\nHello\r\n',
);
const request = { after_uid: null, limit: 3, expected_uidvalidity: null };
class FakeClient extends EventEmitter {
  mailbox = { readOnly: true, uidValidity: 156n, uidNext: 10 };
  connected = 0;
  closed = 0;
  released = 0;
  ranges: string[] = [];
  downloaded: number[] = [];
  downloads: Readable[] = [];
  records = [
    { uid: 3, size: raw.length },
    { uid: 1, size: raw.length },
  ];
  bytes = raw;
  expectedSize = raw.length;
  connectTask: (() => Promise<void>) | undefined;
  async connect() {
    this.connected++;
    await this.connectTask?.();
  }
  close() {
    this.closed++;
  }
  async getMailboxLock(folder: string, options: { readOnly: boolean }) {
    assert.equal(folder, 'INBOX');
    assert.equal(options.readOnly, true);
    return {
      release: () => {
        this.released++;
      },
    };
  }
  async *fetch(range: string, query: unknown, options: unknown) {
    assert.deepEqual(query, { uid: true, size: true });
    assert.deepEqual(options, { uid: true });
    this.ranges.push(range);
    yield* this.records;
  }
  async download(id: number, part: unknown, options: unknown) {
    assert.equal(part, undefined);
    assert.deepEqual(options, { uid: true, maxBytes: L.message_bytes + 1, chunkSize: 65536 });
    this.downloaded.push(id);
    const content = Readable.from([this.bytes]);
    this.downloads.push(content);
    return { content, meta: { expectedSize: this.expectedSize } };
  }
}
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
const fixture = (client = new FakeClient(), capture?: (o: ImapFlowOptions) => void) => ({
  resolve: publicDns,
  createClient: (o: ImapFlowOptions) => {
    capture?.(o);
    return client as unknown as ImapFlow;
  },
});
const code = (expected: string) => (e: unknown) =>
  e instanceof EmailInboundError && e.code === expected;

test('pins resolved public IP while retaining verified hostname TLS, bounded literals and no logger', async () => {
  const c = new FakeClient();
  let options: ImapFlowOptions | undefined;
  const result = await fetchInboundMailbox(
    config,
    request,
    {},
    fixture(c, (o) => {
      options = o;
    }),
  );
  assert.equal(options!.host, '8.8.8.8');
  assert.equal(options!.servername, config.host);
  assert.equal(options!.secure, true);
  assert.equal(options!.tls!.rejectUnauthorized, true);
  assert.equal(options!.tls!.minVersion, 'TLSv1.2');
  assert.equal(options!.logger, false);
  assert.equal(options!.logRaw, false);
  assert.equal(options!.maxLiteralSize, L.message_bytes + 1);
  assert.equal(options!.maxResponseSize, L.message_bytes + 65536);
  assert.equal(result.uidvalidity, '156');
  assert.equal(result.uidnext, '10');
  assert.equal(result.scanned_through_uid, '3');
  assert.deepEqual(
    result.messages.map((m) => m.uid),
    ['1', '3'],
  );
  assert.deepEqual(c.ranges, ['1:3']);
  assert.deepEqual(c.downloaded, [1, 3]);
  assert.equal(c.released, 1);
  assert(c.closed > 0);
  assert(c.downloads.every((s) => s.destroyed));
});
test('mixed public/private DNS and metadata IPv6 are denied before authentication', async () => {
  for (const addresses of [
    [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    [{ address: '::1', family: 6 }],
    [{ address: '169.254.169.254', family: 4 }],
  ]) {
    const c = new FakeClient();
    let before = 0;
    await assert.rejects(
      fetchInboundMailbox(
        config,
        request,
        {
          beforeAuth: async () => {
            before++;
          },
        },
        { ...fixture(c), resolve: async () => addresses },
      ),
      code('DENIED_ADDRESS'),
    );
    assert.equal(before, 0);
    assert.equal(c.connected, 0);
  }
});
test('sparse UID windows advance only their bounded numeric range, including empty windows', async () => {
  const c = new FakeClient();
  c.records = [];
  const result = await fetchInboundMailbox(
    config,
    { after_uid: '3', expected_uidvalidity: '156', limit: 2 },
    {},
    fixture(c),
  );
  assert.deepEqual(result.messages, []);
  assert.equal(result.scanned_through_uid, '5');
  assert.deepEqual(c.ranges, ['4:5']);
  const end = await fetchInboundMailbox(
    config,
    { after_uid: '9', expected_uidvalidity: '156', limit: 2 },
    {},
    fixture(c),
  );
  assert.equal(end.scanned_through_uid, '9');
  assert.deepEqual(c.ranges, ['4:5']);
});
test('UID namespace reset and noncanonical cursors fail without downloading or silently restarting', async () => {
  const c = new FakeClient();
  await assert.rejects(
    fetchInboundMailbox(config, { ...request, expected_uidvalidity: '155' }, {}, fixture(c)),
    code('UIDVALIDITY_CHANGED'),
  );
  assert.deepEqual(c.downloaded, []);
  assert.equal(c.released, 1);
  for (const after of ['01', '-1', '4294967296'])
    await assert.rejects(
      fetchInboundMailbox(config, { ...request, after_uid: after }, {}, fixture()),
      code('INVALID_UID'),
    );
  await assert.rejects(
    fetchInboundMailbox(config, { ...request, after_uid: '1' }, {}, fixture()),
    code('INVALID_CONFIG'),
  );
});
test('RFC822 size lies, truncated literal and hard-size sentinel are rejected without partial mail', async () => {
  const short = new FakeClient();
  short.bytes = raw.subarray(0, raw.length - 1);
  await assert.rejects(
    fetchInboundMailbox(config, request, {}, fixture(short)),
    code('TRUNCATED_MESSAGE'),
  );
  assert(short.downloads.every((s) => s.destroyed));
  const large = new FakeClient();
  large.records = [{ uid: 1, size: L.message_bytes + 1 }];
  await assert.rejects(
    fetchInboundMailbox(config, request, {}, fixture(large)),
    code('MESSAGE_LIMIT'),
  );
  assert.deepEqual(large.downloaded, []);
  const liar = new FakeClient();
  liar.records = [{ uid: 1, size: raw.length }];
  liar.bytes = Buffer.alloc(L.message_bytes + 1, 65);
  await assert.rejects(
    fetchInboundMailbox(config, request, {}, fixture(liar)),
    code('MESSAGE_LIMIT'),
  );
  assert(liar.downloads[0].destroyed);
});
test('duplicate and out-of-window UIDs are denied before any body download', async () => {
  for (const records of [
    [
      { uid: 1, size: raw.length },
      { uid: 1, size: raw.length },
    ],
    [{ uid: 4, size: raw.length }],
  ]) {
    const c = new FakeClient();
    c.records = records;
    await assert.rejects(
      fetchInboundMailbox(config, request, {}, fixture(c)),
      code('MESSAGE_LIMIT'),
    );
    assert.deepEqual(c.downloaded, []);
  }
});
test('fresh actor callbacks run before connect and after complete fetch; revocation is preserved', async () => {
  const denied = new Error('trusted permission denied');
  const c = new FakeClient();
  await assert.rejects(
    fetchInboundMailbox(
      config,
      request,
      {
        beforeAuth: async () => {
          throw denied;
        },
      },
      fixture(c),
    ),
    (e) => e === denied,
  );
  assert.equal(c.connected, 0);
  const events: string[] = [];
  const late = new FakeClient();
  late.connectTask = async () => {
    events.push('connect');
  };
  await assert.rejects(
    fetchInboundMailbox(
      config,
      request,
      {
        beforeAuth: async () => {
          events.push('before');
        },
        afterFetch: async () => {
          events.push('after');
          throw denied;
        },
      },
      fixture(late),
    ),
    (e) => e === denied,
  );
  assert.deepEqual(events, ['before', 'connect', 'after']);
  assert.deepEqual(late.downloaded, [1, 3]);
  assert.equal(late.released, 1);
  assert(late.closed > 0);
});
test('absolute deadline closes an authenticated transport and provider error text stays private', async () => {
  const c = new FakeClient();
  c.connectTask = () => new Promise(() => {});
  await assert.rejects(
    fetchInboundMailbox(config, request, {}, { ...fixture(c), deadline_ms: 15 }),
    code('DEADLINE'),
  );
  assert(c.closed > 0);
  const bad = new FakeClient();
  bad.connectTask = async () => {
    throw new Error('private-password upstream body');
  };
  await assert.rejects(
    fetchInboundMailbox(config, request, {}, fixture(bad)),
    (e) =>
      e instanceof EmailInboundError &&
      e.code === 'TRANSPORT_FAILED' &&
      !e.message.includes(config.password),
  );
});
test('local fixture is opt-in, exact address/port only and cannot disable TLS verification', async () => {
  await assert.rejects(
    fetchInboundMailbox(
      { ...config, transport: 'local_fixture', host: 'localhost', port: 4112 },
      request,
      {},
      fixture(),
    ),
    code('INVALID_CONFIG'),
  );
  await assert.rejects(
    fetchInboundMailbox({ ...config, port: 4112 }, request, {}, fixture()),
    code('INVALID_CONFIG'),
  );
  // No fixture environment is changed by this test: the invalid endpoint is
  // rejected independently of any root-owned real TLS fixture configuration.
});
