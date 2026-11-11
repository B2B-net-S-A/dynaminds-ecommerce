import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Client } from 'pg';
import { z } from 'zod';
import { decrypt } from './security';
import { parseInboundMime } from './email-inbound-mime';
import { EMAIL_INBOUND_LIMITS as L } from './email-inbound-schema';

const credentials = z.strictObject({
  username: z
    .string()
    .min(1)
    .max(254)
    .refine((v) => !/[\x00\r\n]/.test(v)),
  password: z
    .string()
    .min(1)
    .max(1000)
    .refine((v) => !/[\x00\r\n]/.test(v)),
});
const attachment = z.strictObject({
  index: z
    .number()
    .int()
    .min(0)
    .max(L.max_attachments - 1),
  filename: z.string().min(1).max(200),
  mime: z.string().min(1).max(200),
  bytes: z.number().int().min(0).max(L.attachment_bytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content_base64: z.string().max(Math.ceil(L.attachment_bytes / 3) * 4),
});
const source = z.strictObject({
  raw_base64: z
    .string()
    .min(1)
    .max(Math.ceil(L.raw_bytes / 3) * 4),
  attachments: z.array(attachment).max(L.max_attachments),
});
function check(condition: unknown): asserts condition {
  if (!condition) throw new Error('Poczta przychodząca w kopii nie odpowiada szyfrowanej treści');
}
function bytes(value: string, size: number, sha: string) {
  const body = Buffer.from(value, 'base64');
  check(
    body.toString('base64') === value &&
      body.length === size &&
      createHash('sha256').update(body).digest('hex') === sha,
  );
  return body;
}
/** Owner-only validation. Every file is checked against both its metadata and raw MIME.
 * Fixed diagnostics never include credentials, customer text or attachment filenames. */
export async function validateRecoveredInboundSource(row: Record<string, any>, key: string) {
  try {
    const data = source.parse(decrypt(row.content_encrypted, key));
    check(Number.isInteger(row.raw_bytes) && row.raw_bytes > 0 && row.raw_bytes <= L.raw_bytes);
    const parsed = await parseInboundMime(bytes(data.raw_base64, row.raw_bytes, row.raw_sha256));
    check(isDeepStrictEqual(parsed.headers, row.headers) && parsed.text === row.text_body);
    const metadata = data.attachments.map(({ content_base64, ...file }) => file);
    check(isDeepStrictEqual(metadata, row.attachments));
    check(parsed.attachments.length === data.attachments.length);
    let total = 0;
    for (let index = 0; index < data.attachments.length; index++) {
      const saved = data.attachments[index],
        file = parsed.attachments[index];
      check(
        saved.index === index &&
          saved.filename === file.filename &&
          saved.mime === file.mime &&
          saved.bytes === file.bytes.length &&
          saved.sha256 === file.sha256,
      );
      check(bytes(saved.content_base64, saved.bytes, saved.sha256).equals(file.bytes));
      total += saved.bytes;
    }
    check(total <= L.attachment_total_bytes);
  } catch {
    throw new Error('Poczta przychodząca w kopii nie odpowiada szyfrowanej treści');
  }
}
export async function validateRecoveredInboundEmail(c: Pick<Client, 'query'>, key: string) {
  let count = 0;
  for (const table of ['email_inbound_accounts', 'email_inbound_sources']) {
    if (!(await c.query('SELECT to_regclass($1) present', ['public.' + table])).rows[0].present)
      continue;
    let cursor: string | null = null;
    while (true) {
      // A single source may contain 4 MiB of raw MIME plus decoded files.
      const page: Record<string, any>[] = (
        await c.query(
          `SELECT * FROM ${table} WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 1`,
          [cursor],
        )
      ).rows;
      if (!page.length) break;
      const row = page[0];
      if (table === 'email_inbound_accounts') {
        if (row.credentials_encrypted === null) check(row.enabled === false);
        else {
          try {
            credentials.parse(decrypt(row.credentials_encrypted, key));
          } catch {
            throw new Error('Niepoprawne zaszyfrowane dane konta pocztowego w kopii');
          }
          count++;
        }
      } else {
        await validateRecoveredInboundSource(row, key);
        count++;
      }
      cursor = row.id;
    }
  }
  return count;
}
