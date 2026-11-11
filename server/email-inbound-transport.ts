import { lookup } from 'node:dns/promises';
import { lstat, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { Readable } from 'node:stream';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { isPublicSupplierFeedAddress } from './supplier-remote-fetch-transport';
import {
  EMAIL_INBOUND_LIMITS as L,
  EmailInboundError,
  parseInboundMime,
  type ParsedInboundMime,
} from './email-inbound-mime';
export { EMAIL_INBOUND_LIMITS, EmailInboundError } from './email-inbound-mime';
export type ParsedInboundMail = ParsedInboundMime & { uid: string };
export type InboundMailboxConfig = {
  host: string;
  port: 993 | 4112;
  transport: 'tls' | 'local_fixture';
  folder: string;
  username: string;
  password: string;
};
export type InboundMailboxRequest = {
  after_uid: string | null;
  limit: number;
  expected_uidvalidity: string | null;
};
export type InboundMailboxResult = {
  uidvalidity: string;
  uidnext: string;
  scanned_through_uid: string;
  messages: ParsedInboundMail[];
};
export type InboundMailboxHooks = {
  beforeAuth?: () => Promise<void>;
  afterFetch?: () => Promise<void>;
};
// Dependency injection is for bounded transport tests, never configured from a request.
export type InboundTransportDependencies = {
  resolve?: typeof lookupAddresses;
  createClient?: (options: ImapFlowOptions) => ImapFlow;
  deadline_ms?: number;
};
async function lookupAddresses(host: string) {
  return lookup(host, { all: true, verbatim: true });
}
function fail(code: ConstructorParameters<typeof EmailInboundError>[0]): never {
  throw new EmailInboundError(code);
}
function uid(value: unknown, zero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(value)) fail('INVALID_UID');
  const n = BigInt(value);
  if (n > 4294967295n || (!zero && n === 0n)) fail('INVALID_UID');
  return n;
}
function configCheck(c: InboundMailboxConfig) {
  if (
    !c ||
    !['tls', 'local_fixture'].includes(c.transport) ||
    typeof c.host !== 'string' ||
    typeof c.folder !== 'string' ||
    !c.folder.length ||
    c.folder.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(c.folder) ||
    typeof c.username !== 'string' ||
    !c.username.length ||
    c.username.length > 320 ||
    /[\u0000-\u001f\u007f]/.test(c.username) ||
    typeof c.password !== 'string' ||
    !c.password.length ||
    c.password.length > 4096 ||
    /[\u0000\r\n]/.test(c.password)
  )
    fail('INVALID_CONFIG');
  if (c.transport === 'local_fixture') {
    if (c.host !== '127.0.0.1' || c.port !== 4112) fail('INVALID_CONFIG');
  } else if (
    c.port !== 993 ||
    c.host.length > 253 ||
    !c.host.includes('.') ||
    !/^[a-z0-9.-]+$/i.test(c.host) ||
    c.host.endsWith('.') ||
    c.host.split('.').some((p) => !p || p.length > 63 || p.startsWith('-') || p.endsWith('-')) ||
    c.host.toLowerCase().endsWith('.local')
  )
    fail('INVALID_CONFIG');
}
export async function fetchInboundMailbox(
  config: InboundMailboxConfig,
  request: InboundMailboxRequest,
  hooks: InboundMailboxHooks = {},
  dependencies: InboundTransportDependencies = {},
): Promise<InboundMailboxResult> {
  configCheck(config);
  if (
    !request ||
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > L.messages
  )
    fail('INVALID_CONFIG');
  const after = request.after_uid === null ? 0n : uid(request.after_uid, true);
  const expected = request.expected_uidvalidity === null ? null : uid(request.expected_uidvalidity);
  if (expected === null && after !== 0n) fail('INVALID_CONFIG');
  const deadline = dependencies.deadline_ms ?? L.deadline_ms;
  if (!Number.isInteger(deadline) || deadline <= 0 || deadline > L.deadline_ms)
    fail('INVALID_CONFIG');
  let client: ImapFlow | undefined,
    stream: Readable | undefined,
    expired = false,
    callbackFailed = false,
    callbackError: unknown;
  const checkpoint = async (hook: (() => Promise<void>) | undefined) => {
    if (expired) fail('DEADLINE');
    try {
      await hook?.();
    } catch (e) {
      callbackFailed = true;
      callbackError = e;
      throw e;
    }
    if (expired) fail('DEADLINE');
  };
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      stream?.destroy();
      client?.close();
      reject(new EmailInboundError('DEADLINE'));
    }, deadline);
  });
  const work = async (): Promise<InboundMailboxResult> => {
    let address: string, ca: Buffer | undefined;
    if (config.transport === 'local_fixture') {
      if (process.env.DYNA_ALLOW_IMAP_FIXTURE !== 'true') fail('FIXTURE_DISABLED');
      const path = process.env.DYNA_IMAP_FIXTURE_CA_PATH;
      if (!path || !path.startsWith('/')) fail('FIXTURE_DISABLED');
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 32768 ||
        stat.size === 0
      )
        fail('FIXTURE_DISABLED');
      ca = await readFile(path);
      if (!ca.toString('ascii').includes('-----BEGIN CERTIFICATE-----')) fail('FIXTURE_DISABLED');
      address = '127.0.0.1';
    } else {
      const addresses = isIP(config.host)
        ? [{ address: config.host, family: isIP(config.host) }]
        : await (dependencies.resolve ?? lookupAddresses)(config.host);
      if (
        !addresses.length ||
        addresses.length > 32 ||
        addresses.some(
          (a) => !isPublicSupplierFeedAddress(a.address) || isIP(a.address) !== a.family,
        )
      )
        fail('DENIED_ADDRESS');
      address = addresses[0].address;
    }
    if (expired) fail('DEADLINE');
    // Public ImapFlow connects and authenticates together. This callback precedes
    // connect; the caller must also revalidate after the network and before commit.
    await checkpoint(hooks.beforeAuth);
    client = (dependencies.createClient ?? ((options) => new ImapFlow(options)))({
      host: address,
      port: config.port,
      secure: true,
      ...(isIP(config.host) ? {} : { servername: config.host }),
      auth: { user: config.username, pass: config.password },
      logger: false,
      logRaw: false,
      emitLogs: false,
      disableAutoIdle: true,
      disableCompression: true,
      disableBinary: true,
      disableAutoEnable: true,
      disableIMAP4rev2: true,
      connectionTimeout: L.connect_ms,
      greetingTimeout: L.connect_ms,
      socketTimeout: L.idle_ms,
      maxLineLength: 32768,
      maxLiteralSize: L.message_bytes + 1,
      maxResponseSize: L.message_bytes + 65536,
      tls: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        ...(isIP(config.host) ? {} : { servername: config.host }),
        ...(ca ? { ca } : {}),
        checkServerIdentity: (_host, cert) => checkServerIdentity(config.host, cert),
      },
    });
    client.on('error', () => {}); // Library/provider errors never reach logs or DTOs.
    await client.connect();
    if (expired) fail('DEADLINE');
    const lock = await client.getMailboxLock(config.folder, { readOnly: true });
    try {
      const box = client.mailbox;
      if (!box || !box.readOnly) fail('TRANSPORT_FAILED');
      const validity = uid(String(box.uidValidity)),
        next = uid(String(box.uidNext));
      if (expected !== null && validity !== expected) fail('UIDVALIDITY_CHANGED');
      if (after >= next) fail('INVALID_UID');
      const end = after + BigInt(request.limit) < next ? after + BigInt(request.limit) : next - 1n;
      const records: { uid: number; size: number }[] = [];
      if (end > after) {
        // Numeric UID windows are bounded even for sparse mailboxes. No SEARCH *,
        // no sequence-number cursor and no '*' reversal when start exceeds end.
        for await (const m of client.fetch(
          `${after + 1n}:${end}`,
          { uid: true, size: true },
          { uid: true },
        )) {
          const id = uid(String(m.uid));
          if (
            id <= after ||
            id > end ||
            !Number.isSafeInteger(m.size) ||
            m.size! < 1 ||
            m.size! > L.message_bytes ||
            records.some((r) => r.uid === m.uid) ||
            records.length >= request.limit
          )
            fail('MESSAGE_LIMIT');
          records.push({ uid: m.uid, size: m.size! });
        }
      }
      records.sort((a, b) => a.uid - b.uid);
      const messages: ParsedInboundMail[] = [];
      let bytesTotal = 0;
      for (const m of records) {
        const download = await client.download(m.uid, undefined, {
          uid: true,
          maxBytes: L.message_bytes + 1,
          chunkSize: 65536,
        });
        if (!download.content) fail('TRUNCATED_MESSAGE');
        stream = download.content;
        const chunks: Buffer[] = [];
        let length = 0;
        try {
          for await (const chunk of stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += bytes.length;
            if (length > L.message_bytes) fail('MESSAGE_LIMIT');
            chunks.push(bytes);
          }
        } finally {
          stream.destroy();
          stream = undefined;
        }
        if (
          length !== m.size ||
          (download.meta?.expectedSize !== undefined && download.meta.expectedSize !== length)
        )
          fail('TRUNCATED_MESSAGE');
        bytesTotal += length;
        if (bytesTotal > L.preview_bytes) fail('BATCH_LIMIT');
        const parsed = await parseInboundMime(Buffer.concat(chunks));
        bytesTotal +=
          Buffer.byteLength(parsed.text) +
          parsed.attachments.reduce((n, a) => n + a.bytes.length, 0);
        if (bytesTotal > L.preview_bytes) fail('BATCH_LIMIT');
        messages.push({ uid: String(m.uid), ...parsed });
      }
      await checkpoint(hooks.afterFetch);
      return {
        uidvalidity: String(validity),
        uidnext: String(next),
        scanned_through_uid: String(end),
        messages,
      };
    } finally {
      lock.release();
    }
  };
  try {
    return await Promise.race([work(), timeout]);
  } catch (e) {
    if (callbackFailed && e === callbackError) throw e;
    if (e instanceof EmailInboundError) throw e;
    throw new EmailInboundError('TRANSPORT_FAILED');
  } finally {
    clearTimeout(timer!);
    stream?.destroy();
    client?.close();
  }
}
