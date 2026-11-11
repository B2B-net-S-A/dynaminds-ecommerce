import { z } from 'zod';
import type { Actor } from './domain';
export type EmailInboundActor = Actor & { apiKeyId?: string };
export const EMAIL_INBOUND_LIMITS = Object.freeze({
  max_rows: 50,
  raw_bytes: 4194304,
  attachment_bytes: 2097152,
  attachment_total_bytes: 4194304,
  max_attachments: 10,
  text_characters: 20000,
  mime_parts: 50,
  mime_depth: 10,
  preview_bytes: 67108864,
  storage_bytes: 134217728,
  max_accounts: 20,
  max_messages: 2000,
  max_acquisitions: 2000,
  max_previews: 1000,
  max_replies: 2000,
  preview_ttl_seconds: 900,
});
const clean = (n: number) =>
  z
    .string()
    .trim()
    .max(n)
    .refine(
      (v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(v),
      'Niedozwolony znak',
    );
const single = (n: number) => clean(n).refine((v) => !/[\r\n]/.test(v), 'Wymagany jeden wiersz');
export const inboundVersion = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
export const inboundUid = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/)
  .refine((v) => /^[1-9][0-9]{0,9}$/.test(v) && BigInt(v) <= 4294967295n);
export const inboundHash = z.string().regex(/^[a-f0-9]{64}$/);
export const inboundAddress = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const inboundAccountFields = z.strictObject({
  name: single(120).min(2),
  host: single(253)
    .min(1)
    .transform((v) => v.toLowerCase()),
  port: z.union([z.literal(993), z.literal(4112)]),
  transport: z.enum(['tls', 'local_fixture']),
  folder: single(200).min(1),
  smtp_channel_id: z.uuid(),
  enabled: z.boolean(),
});
const credentials = z.strictObject({
  username: single(254).min(1),
  password: z
    .string()
    .min(1)
    .max(1000)
    .refine((v) => !/[\u0000\r\n]/.test(v)),
});
function addressPolicy(v: { transport: string; host: string; port: number }, ctx: z.RefinementCtx) {
  if (
    v.transport === 'local_fixture'
      ? v.host !== '127.0.0.1' || v.port !== 4112
      : v.port !== 993 ||
        !v.host.includes('.') ||
        !/[a-z]/.test(v.host) ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(v.host) ||
        v.host.endsWith('.local')
  )
    ctx.addIssue({
      code: 'custom',
      message: 'TLS993 z publicznym DNS lub lokalny fixture127.0.0.1:4112',
    });
}
export const inboundAccountCreateInput = inboundAccountFields
  .extend({ client_key: z.uuid(), credentials })
  .superRefine(addressPolicy);
export const inboundAccountUpdateInput = inboundAccountFields
  .extend({
    client_key: z.uuid(),
    version: inboundVersion,
    credentials: z.discriminatedUnion('action', [
      z.strictObject({ action: z.literal('keep') }),
      z.strictObject({ action: z.literal('replace'), ...credentials.shape }),
      z.strictObject({ action: z.literal('clear') }),
    ]),
  })
  .superRefine((v, c) => {
    addressPolicy(v, c);
    if (v.credentials.action === 'clear' && v.enabled)
      c.addIssue({ code: 'custom', message: 'Wyczyszczone konto musi być wyłączone' });
  });
export const inboundFetchInput = z
  .strictObject({
    client_key: z.uuid(),
    account_version: inboundVersion,
    after_uid: inboundUid.nullable(),
    expected_uidvalidity: inboundUid.nullable(),
    limit: z.number().int().min(1).max(50),
    confirmed_read: z.literal(true),
  })
  .refine(
    (v) => v.expected_uidvalidity !== null || v.after_uid === null,
    'Nowa przestrzeń UID wymaga odczytu od początku',
  );
export const inboundImportInput = z.strictObject({
  client_key: z.uuid(),
  scope_hash: inboundHash,
  confirmed: z.literal(true),
});
export const inboundReconcileInput = z.strictObject({
  client_key: z.uuid(),
  confirmed_abandon: z.literal(true),
});
export const inboundBindInput = z.strictObject({
  client_key: z.uuid(),
  version: inboundVersion,
  order_id: z.uuid(),
  order_version: inboundVersion,
  confirmed: z.literal(true),
});
export const inboundReplyPreviewInput = z.strictObject({
  client_key: z.uuid(),
  version: inboundVersion,
  order_version: inboundVersion,
  smtp_channel_id: z.uuid(),
  recipient: inboundAddress,
  subject: single(200).min(1),
  text: clean(20000).min(1),
});
export const inboundReplyQueueInput = inboundImportInput.extend({ confirm_external: z.boolean() });
export const inboundListInput = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  state: z.enum(['unassigned', 'bound']).optional(),
  account_id: z.uuid().optional(),
});
export const inboundHistoryInput = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  account_id: z.uuid().optional(),
});
export const inboundRepliesInput = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  message_id: z.uuid().optional(),
});
export const inboundContentQuery = z.strictObject({ workspace_id: z.uuid() });
export const inboundRfcId = single(998).regex(/^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/);
