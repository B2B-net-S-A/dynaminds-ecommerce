import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { parseInboundMime } from '../server/email-inbound-mime';
import { validateRecoveredInboundSource } from '../server/email-inbound-recovery';
import { encrypt } from '../server/security';
import { localConfig, pool } from '../server/db';
after(() => pool.end());
const raw = Buffer.from(
  [
    'From: Klient <buyer@example.test>',
    'Reply-To: help@example.test',
    'To: orders@example.test',
    'Subject: Zwrot zamowienia',
    'Message-ID: <inbound-156@example.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="qa156"',
    '',
    '--qa156',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Prosze o odpowiedz.',
    '--qa156',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="receipt.bin"',
    'Content-Transfer-Encoding: base64',
    '',
    'AAECAwQ=',
    '--qa156--',
    '',
  ].join('\r\n'),
);
async function fixture() {
  const parsed = await parseInboundMime(raw);
  assert.equal(parsed.attachments.length, 1);
  const files = parsed.attachments.map((file, index) => ({
    index,
    filename: file.filename,
    mime: file.mime,
    bytes: file.bytes.length,
    sha256: file.sha256,
    content_base64: file.bytes.toString('base64'),
  }));
  const data = { raw_base64: raw.toString('base64'), attachments: files };
  const row = {
    raw_bytes: raw.length,
    raw_sha256: createHash('sha256').update(raw).digest('hex'),
    headers: parsed.headers,
    text_body: parsed.text,
    attachments: files.map(({ content_base64, ...file }) => file),
    content_encrypted: encrypt(data),
  };
  return { data, row };
}
test('recovery validates raw MIME and decoded binary files with the original encryption key', async () => {
  const { row } = await fixture();
  await validateRecoveredInboundSource(row, localConfig.encryptionKey);
  await assert.rejects(validateRecoveredInboundSource(row, randomBytes(32).toString('hex')));
});
test('recovery rejects valid ciphertext with altered source metadata, body or headers', async () => {
  const { row } = await fixture();
  for (const changed of [
    { ...row, raw_bytes: raw.length - 1 },
    { ...row, raw_sha256: '0'.repeat(64) },
    { ...row, text_body: row.text_body + ' injected' },
    { ...row, headers: { ...row.headers, subject: 'changed' } },
    { ...row, attachments: [] },
  ])
    await assert.rejects(validateRecoveredInboundSource(changed, localConfig.encryptionKey));
});
test('recovery rejects canonicality, decoded attachment substitution and reordered ordinals', async () => {
  const { row, data } = await fixture();
  for (const changed of [
    { ...data, raw_base64: data.raw_base64 + '\n' },
    { ...data, extra: 'not part of the immutable source' },
    { ...data, attachments: [{ ...data.attachments[0], content_base64: 'AQECAwQ=' }] },
    { ...data, attachments: [{ ...data.attachments[0], index: 1 }] },
    { ...data, attachments: [{ ...data.attachments[0], sha256: '0'.repeat(64) }] },
  ])
    await assert.rejects(
      validateRecoveredInboundSource(
        { ...row, content_encrypted: encrypt(changed) },
        localConfig.encryptionKey,
      ),
    );
});
