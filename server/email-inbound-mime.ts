import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MailParser, type AddressObject, type Headers, type AttachmentStream } from 'mailparser';
import { Splitter, type SplitterChunk } from '@zone-eu/mailsplit';

export const EMAIL_INBOUND_LIMITS = Object.freeze({
  message_bytes: 4 * 1024 * 1024,
  attachment_bytes: 2 * 1024 * 1024,
  attachment_total_bytes: 4 * 1024 * 1024,
  attachments: 10,
  text_chars: 20000,
  mime_parts: 50,
  mime_depth: 10,
  header_bytes: 32768,
  messages: 50,
  preview_bytes: 64 * 1024 * 1024,
  tenant_bytes: 128 * 1024 * 1024,
  deadline_ms: 60000,
  connect_ms: 12000,
  idle_ms: 12000,
});
export type EmailInboundErrorCode =
  | 'INVALID_CONFIG'
  | 'DENIED_ADDRESS'
  | 'FIXTURE_DISABLED'
  | 'TLS_FAILED'
  | 'TRANSPORT_FAILED'
  | 'DEADLINE'
  | 'UIDVALIDITY_CHANGED'
  | 'INVALID_UID'
  | 'MESSAGE_LIMIT'
  | 'BATCH_LIMIT'
  | 'TRUNCATED_MESSAGE'
  | 'MIME_INVALID'
  | 'MIME_LIMIT';
export class EmailInboundError extends Error {
  constructor(public readonly code: EmailInboundErrorCode) {
    super(`Inbound email: ${code}`);
    this.name = 'EmailInboundError';
  }
}
export const inboundSha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type InboundAddress = { name: string; address: string };
export type ParsedInboundMime = {
  raw: Buffer;
  raw_sha256: string;
  headers: {
    message_id: string | null;
    from: InboundAddress;
    reply_to: InboundAddress | null;
    to: InboundAddress[];
    subject: string;
    sent_at: string | null;
    in_reply_to: string | null;
    references: string[];
  };
  text: string;
  attachments: { filename: string; mime: string; bytes: Buffer; sha256: string }[];
};
function fail(code: EmailInboundErrorCode): never {
  throw new EmailInboundError(code);
}
function boundedText(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)
  )
    fail('MIME_INVALID');
  return value;
}
function headerText(headers: Headers, key: string, max: number): string | null {
  const value = headers.get(key);
  if (value === undefined) return null;
  const text = boundedText(value, max);
  if (/[\r\n]/.test(text)) fail('MIME_INVALID');
  return text;
}
function addresses(headers: Headers, key: string, max: number): InboundAddress[] {
  const value = headers.get(key);
  if (value === undefined) return [];
  const list = (value as AddressObject)?.value;
  if (!Array.isArray(list) || list.length > max) fail('MIME_INVALID');
  return list.map((v) => {
    if (v.group || typeof v.address !== 'string') fail('MIME_INVALID');
    const address = boundedText(v.address, 254),
      name = boundedText(v.name ?? '', 200);
    if (/[\r\n\s<>]/u.test(address) || !/^[^@]+@[^@]+$/.test(address) || /[\r\n]/u.test(name))
      fail('MIME_INVALID');
    return { name, address };
  });
}

// Structural resource admission uses the same maintained splitter as MailParser,
// independently before decoding. No filesystem/network access or archive expansion.
async function admitMimeStructure(raw: Buffer): Promise<void> {
  const splitter = new Splitter({
    maxHeadSize: EMAIL_INBOUND_LIMITS.header_bytes,
    maxChildNodes: EMAIL_INBOUND_LIMITS.mime_parts,
  });
  let parts = 0;
  const boundaries = new Set<string>();
  const sink = new Writable({
    objectMode: true,
    write(chunk: SplitterChunk, _encoding, done) {
      try {
        if (chunk.type === 'node') {
          if (++parts > EMAIL_INBOUND_LIMITS.mime_parts) fail('MIME_LIMIT');
          let depth = 1,
            parent = chunk.parentNode;
          while (parent) {
            if (++depth > EMAIL_INBOUND_LIMITS.mime_depth) fail('MIME_LIMIT');
            parent = parent.parentNode;
          }
          if (chunk.headers && chunk.headers.getList().length > 100) fail('MIME_LIMIT');
          if (
            chunk.encoding &&
            !['7bit', '8bit', 'binary', 'base64', 'quoted-printable'].includes(chunk.encoding)
          )
            fail('MIME_INVALID');
          if (chunk.multipart) {
            if (!chunk._boundary) fail('MIME_INVALID');
            const boundary = chunk._boundary.toString('latin1');
            if (!boundary || boundary.length > 74 || boundaries.has(boundary)) fail('MIME_INVALID');
            boundaries.add(boundary);
          }
        }
        done();
      } catch (e) {
        done(e as Error);
      }
    },
  });
  await pipeline(Readable.from([raw]), splitter, sink);
  // MIME parsers intentionally tolerate missing final boundaries; an import must
  // not certify a truncated multipart message. Match complete closing lines only.
  const closed = new Set<string>();
  for (const line of raw.toString('latin1').split(/\r?\n/)) {
    if (line.startsWith('--') && /--[ \t]*$/.test(line))
      closed.add(line.replace(/[ \t]+$/, '').slice(2, -2));
  }
  for (const boundary of boundaries) if (!closed.has(boundary)) fail('MIME_INVALID');
}

export async function parseInboundMime(raw: Buffer): Promise<ParsedInboundMime> {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > EMAIL_INBOUND_LIMITS.message_bytes)
    fail('MESSAGE_LIMIT');
  try {
    await admitMimeStructure(raw);
    const parser = new MailParser({
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipTextLinks: true,
      skipImageLinks: true,
      checksumAlgo: 'sha256',
      maxHtmlLengthToParse: EMAIL_INBOUND_LIMITS.message_bytes,
      maxHeadSize: EMAIL_INBOUND_LIMITS.header_bytes,
      maxChildNodes: EMAIL_INBOUND_LIMITS.mime_parts,
    } as ConstructorParameters<typeof MailParser>[0]);
    let headers: Headers | undefined,
      text = '',
      totalBytes = 0;
    const attachments: ParsedInboundMime['attachments'] = [];
    const active = new Set<Readable>();
    parser.on('headers', (value) => {
      headers = value;
    });
    const sink = new Writable({
      objectMode: true,
      write(
        part: AttachmentStream | { type: 'text'; text?: string; html?: string },
        _encoding,
        done,
      ) {
        if (part.type === 'text') {
          try {
            text = boundedText(part.text ?? '', EMAIL_INBOUND_LIMITS.text_chars);
            done();
          } catch (e) {
            done(e as Error);
          }
          return;
        }
        const stream = part.content as Readable;
        active.add(stream);
        const index = attachments.length;
        if (index >= EMAIL_INBOUND_LIMITS.attachments) {
          stream.destroy();
          part.release();
          done(new EmailInboundError('MIME_LIMIT'));
          return;
        }
        void (async () => {
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            const filename = boundedText(part.filename || `attachment-${index + 1}.bin`, 200);
            if (/[\\/\r\n:]/u.test(filename) || filename === '.' || filename === '..')
              fail('MIME_INVALID');
            const mime = boundedText(part.contentType.toLowerCase(), 127);
            if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) fail('MIME_INVALID');
            for await (const piece of stream) {
              const bytes = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
              size += bytes.length;
              totalBytes += bytes.length;
              if (
                size > EMAIL_INBOUND_LIMITS.attachment_bytes ||
                totalBytes > EMAIL_INBOUND_LIMITS.attachment_total_bytes
              )
                fail('MIME_LIMIT');
              chunks.push(bytes);
            }
            const bytes = Buffer.concat(chunks);
            attachments.push({ filename, mime, bytes, sha256: inboundSha256(bytes) });
            done();
          } catch (e) {
            done(e as Error);
          } finally {
            active.delete(stream);
            stream.destroy();
            part.release();
          }
        })();
      },
    });
    try {
      await pipeline(Readable.from([raw]), parser, sink);
    } finally {
      for (const stream of active) stream.destroy();
      parser.destroy();
      sink.destroy();
    }
    if (!headers) fail('MIME_INVALID');
    const from = addresses(headers, 'from', 1),
      reply = addresses(headers, 'reply-to', 1),
      to = addresses(headers, 'to', 100);
    // Bcc delivery need not expose any To header. The sender remains mandatory;
    // the mailbox envelope is never guessed from an absent destination header.
    if (from.length !== 1) fail('MIME_INVALID');
    const date = headers.get('date');
    if (date !== undefined && (!(date instanceof Date) || !Number.isFinite(date.getTime())))
      fail('MIME_INVALID');
    const refs = headers.get('references');
    const references = refs === undefined ? [] : typeof refs === 'string' ? [refs] : refs;
    if (!Array.isArray(references) || references.length > 100) fail('MIME_INVALID');
    return {
      raw,
      raw_sha256: inboundSha256(raw),
      headers: {
        from: from[0],
        reply_to: reply[0] ?? null,
        to,
        subject: headerText(headers, 'subject', 1000) ?? '',
        message_id: headerText(headers, 'message-id', 1000),
        sent_at: date instanceof Date ? date.toISOString() : null,
        in_reply_to: headerText(headers, 'in-reply-to', 1000),
        references: references.map((r) => boundedText(r, 1000)),
      },
      text,
      attachments,
    };
  } catch (e) {
    if (e instanceof EmailInboundError) throw e;
    // The maintained splitter tags its header/part resource bounds with EMAXLEN.
    // Preserve this classification without exposing its provider/parser message.
    if (e && typeof e === 'object' && 'code' in e && e.code === 'EMAXLEN')
      throw new EmailInboundError('MIME_LIMIT');
    throw new EmailInboundError('MIME_INVALID');
  }
}
