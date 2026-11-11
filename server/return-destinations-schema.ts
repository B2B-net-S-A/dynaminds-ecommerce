import { z } from 'zod';
import type { Actor } from './domain';
import { returnDestinationDraft } from './return-destinations-plan';

export type ReturnDestinationsActor = Actor & { apiKeyId?: string };
export const RETURN_DESTINATIONS_LIMITS = {
  parts: 200, lines: 100, physical_rows: 500, issue_fragments: 10000,
  preview_seconds: 900, previews: 2000, receipts: 2000,
  retained_bytes: 67108864, snapshot_bytes: 4194304, page: 50,
} as const;
export const returnDestinationsUuid = z.uuid().transform(value => value.toLowerCase());
export const returnDestinationsVersion = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const note = z.string().trim().min(3).max(2000)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u.test(value));

/** Flat, strict session custody. Tenant, actor, costs and admission are server facts. */
export const returnDestinationsPreviewInput = returnDestinationDraft.extend({
  client_key: returnDestinationsUuid,
  return_version: returnDestinationsVersion,
  session_id: returnDestinationsUuid,
  session_version: returnDestinationsVersion,
  lease_token: returnDestinationsUuid,
  note,
});
export const returnDestinationsReceiveInput = z.strictObject({
  client_key: returnDestinationsUuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  lease_token: returnDestinationsUuid,
});
export const returnDestinationsSourceQuery = z.strictObject({ session_id: returnDestinationsUuid });
export const returnDestinationsHistoryQuery = z.strictObject({
  session_id: returnDestinationsUuid,
  cursor: returnDestinationsUuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export type ReturnDestinationsPreviewInput = z.infer<typeof returnDestinationsPreviewInput>;
export type ReturnDestinationsReceiveInput = z.infer<typeof returnDestinationsReceiveInput>;

/** Keep the lease token private even inside historical public preview requests. */
export function publicReturnDestinationsRequest(input: ReturnDestinationsPreviewInput) {
  const { lease_token: _lease, ...request } = input;
  return request;
}
export function returnDestinationsPlannerDraft(input: ReturnDestinationsPreviewInput) {
  const { client_key: _key, return_version: _returnVersion, session_id: _session,
    session_version: _sessionVersion, lease_token: _lease, note: _note, ...draft } = input;
  return returnDestinationDraft.parse(draft);
}
