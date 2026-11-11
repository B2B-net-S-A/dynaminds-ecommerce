import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  parseInboundMime,
  EmailInboundError,
  EMAIL_INBOUND_LIMITS as L,
} from '../server/email-inbound-mime';
const base =
  'From: =?UTF-8?B?xbvDs8WCxIc=?= <sender@example.test>\r\nTo: receiver@example.test\r\nMessage-ID: <same@example.test>\r\nSubject: =?UTF-8?Q?Zwrot_=C5=82=C4=85czony?=\r\nDate: Tue, 06 Oct 2026 12:00:00 +0200\r\nMIME-Version: 1.0\r\n';
const raw = (body: string) => Buffer.from(base + body);
const rejects = (body: Buffer, code: string) =>
  assert.rejects(parseInboundMime(body), (e) => e instanceof EmailInboundError && e.code === code);
function multipart(parts: string[], boundary = 'qa-boundary') {
  return raw(
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
      parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('') +
      `--${boundary}--\r\n`,
  );
}

test('decodes Polish headers and quoted printable text while hashing exact CRLF bytes', async () => {
  const bytes = raw(
    'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nZa=C5=BC=C3=B3=C5=82=C4=87\r\n',
  );
  const parsed = await parseInboundMime(bytes);
  assert.equal(parsed.headers.from.address, 'sender@example.test');
  assert.equal(parsed.headers.from.name, 'Żółć');
  assert.equal(parsed.headers.subject, 'Zwrot łączony');
  assert.equal(parsed.headers.sent_at, '2026-10-06T10:00:00.000Z');
  assert.match(parsed.text, /Zażółć/);
  assert(parsed.raw.equals(bytes));
  assert.equal(parsed.raw_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(parsed.attachments, []);
});
test('preserves duplicate attachment names, RFC2231 filename and distinct bytes by position', async () => {
  const bytes = multipart([
    'Content-Type: text/plain; charset=utf-8\r\n\r\nDwa pliki',
    ...['first', 'second'].map(
      (s) =>
        `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename*=UTF-8''za%C5%82%C4%85cznik.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(s).toString('base64')}`,
    ),
  ]);
  const p = await parseInboundMime(bytes);
  assert.equal(p.attachments.length, 2);
  assert.deepEqual(
    p.attachments.map((a) => a.filename),
    ['załącznik.bin', 'załącznik.bin'],
  );
  assert.deepEqual(
    p.attachments.map((a) => a.bytes.toString()),
    ['first', 'second'],
  );
  assert.notEqual(p.attachments[0].sha256, p.attachments[1].sha256);
});
test('HTML-only becomes inert text without HTML DTO or loading remote images', async () => {
  const p = await parseInboundMime(
    raw(
      'Content-Type: text/html; charset=utf-8\r\n\r\n<p>Zwrot żółty</p><script>SECRET_SCRIPT</script><img src="https://invalid.example/no-fetch"><iframe src="https://invalid.example/no-fetch"></iframe>',
    ),
  );
  assert.match(p.text, /Zwrot żółty/);
  assert(!p.text.includes('SECRET_SCRIPT'));
  assert(!Object.hasOwn(p, 'html'));
  assert.deepEqual(p.attachments, []);
});
test('legal Bcc-only delivery preserves an absent To as an empty array without inventing an envelope', async () => {
  const p = await parseInboundMime(
    Buffer.from(
      'From: sender@example.test\r\nMessage-ID: <bcc@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nWiadomość Bcc bez jawnego odbiorcy.',
    ),
  );
  assert.deepEqual(p.headers.to, []);
  assert.equal(p.headers.from.address, 'sender@example.test');
  assert.equal(p.text, 'Wiadomość Bcc bez jawnego odbiorcy.');
  await rejects(Buffer.from('To: receiver@example.test\r\n\r\nNo sender'), 'MIME_INVALID');
});
test('inline attachment counts toward limits and bytes remain inert rather than parsed as XML/HTML', async () => {
  const payload = Buffer.from(
    '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///secret">]><x>&secret;</x>',
  );
  const p = await parseInboundMime(
    multipart([
      'Content-Type: text/plain\r\n\r\nMessage',
      `Content-Type: application/xml\r\nContent-Disposition: inline; filename="data.xml"\r\nContent-Transfer-Encoding: base64\r\n\r\n${payload.toString('base64')}`,
    ]),
  );
  assert.equal(p.attachments.length, 1);
  assert(p.attachments[0].bytes.equals(payload));
});
test('refuses missing multipart close and path-bearing filenames without partial result', async () => {
  await rejects(
    raw(
      'Content-Type: multipart/mixed; boundary="open"\r\n\r\n--open\r\nContent-Type: text/plain\r\n\r\ntruncated',
    ),
    'MIME_INVALID',
  );
  await rejects(
    multipart([
      'Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="../secret"\r\n\r\ndata',
    ]),
    'MIME_INVALID',
  );
});
test('rejects oversized raw data, decoded text and decoded attachment rather than truncating', async () => {
  await rejects(Buffer.alloc(L.message_bytes + 1, 65), 'MESSAGE_LIMIT');
  await rejects(
    raw('Content-Type: text/plain; charset=utf-8\r\n\r\n' + 'x'.repeat(L.text_chars + 1)),
    'MIME_INVALID',
  );
  await rejects(
    multipart([
      `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="big.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.alloc(L.attachment_bytes + 1, 65).toString('base64')}`,
    ]),
    'MIME_LIMIT',
  );
});
test('enforces ten attachments, total MIME parts and recursive depth including multipart containers', async () => {
  await rejects(
    multipart(
      Array.from(
        { length: 11 },
        (_, i) =>
          `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${i}.bin"\r\n\r\nx`,
      ),
    ),
    'MIME_LIMIT',
  );
  await rejects(
    multipart(Array.from({ length: 51 }, () => 'Content-Type: text/plain\r\n\r\nx')),
    'MIME_LIMIT',
  );
  let nested = 'Content-Type: text/plain\r\n\r\nx';
  for (let i = 0; i < 11; i++)
    nested = `Content-Type: multipart/mixed; boundary="depth-${i}"\r\n\r\n--depth-${i}\r\n${nested}\r\n--depth-${i}--\r\n`;
  await rejects(raw(nested), 'MIME_LIMIT');
});
test('ambiguous senders and oversized headers fail with a fixed redacted error', async () => {
  await rejects(
    Buffer.from('From: one@example.test, two@example.test\r\nTo: to@example.test\r\n\r\nHello'),
    'MIME_INVALID',
  );
  const bytes = Buffer.from(
    'From: secret@example.test\r\nTo: to@example.test\r\nX-Private: ' +
      'PASSWORD'.repeat(6000) +
      '\r\n\r\nx',
  );
  await assert.rejects(
    parseInboundMime(bytes),
    (e) =>
      e instanceof EmailInboundError &&
      !e.message.includes('PASSWORD') &&
      !e.message.includes('secret@example'),
  );
});
