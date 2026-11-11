import { z } from 'zod';

export const RETURN_DESTINATION_STATUS_LIMITS = {
  active_statuses: 100,
  revisions: 2000,
  previews: 2000,
  operations: 2000,
  retained_bytes: 67108864,
  preview_seconds: 900,
  page: 50,
} as const;

export const returnDestinationStatusUuid = z.uuid().transform(value => value.toLowerCase());
export const returnDestinationStatusVersion = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n, 'Nieprawidłowa wersja');
const safeText = (value: string) => !/[\u0000-\u001f\u007f\p{Cs}]/u.test(value);
const location = z.string().trim().min(1).max(80).refine(safeText, 'Nieprawidłowa lokalizacja');
const policyVersion = z.union([z.literal('0'), returnDestinationStatusVersion]);

export const returnDestinationStatusSettings = z.strictObject({
  name: z.string().trim().min(2).max(120).refine(safeText, 'Nieprawidłowa nazwa'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).transform(value => value.toLowerCase()),
  active: z.boolean(),
  decision: z.enum(['accept', 'reject']),
  inventory_effect: z.enum(['sale', 'custody', 'none']),
  warehouse_id: returnDestinationStatusUuid.nullable(),
  warehouse_policy_version: policyVersion.nullable(),
  default_location: location.nullable(),
}).refine(value => value.decision === 'reject'
  ? value.inventory_effect === 'none' && value.warehouse_id === null
    && value.warehouse_policy_version === null && value.default_location === null
  : ['sale', 'custody'].includes(value.inventory_effect) && value.warehouse_id !== null
    && value.warehouse_policy_version !== null && value.default_location !== null,
'Przyjęcie wymaga zgodnego magazynu i lokalizacji; odrzucenie nie może przyjmować zapasu');

export const returnDestinationStatusPreviewInput = z.discriminatedUnion('kind', [
  z.strictObject({ client_key: returnDestinationStatusUuid, kind: z.literal('create'), settings: returnDestinationStatusSettings }),
  z.strictObject({ client_key: returnDestinationStatusUuid, kind: z.literal('update'),
    status_id: returnDestinationStatusUuid, version: returnDestinationStatusVersion,
    settings: returnDestinationStatusSettings }),
]);
export const returnDestinationStatusCommitInput = z.strictObject({
  client_key: returnDestinationStatusUuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
export const returnDestinationStatusListQuery = z.strictObject({
  cursor: returnDestinationStatusUuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export const returnDestinationStatusHistoryQuery = returnDestinationStatusListQuery;

export type ReturnDestinationStatusSettings = z.infer<typeof returnDestinationStatusSettings>;
export type ReturnDestinationStatusActor = {
  tenantId: string;
  userId: string;
  role: 'admin' | 'operator' | 'viewer';
  apiKeyId?: string;
  source?: 'manual' | 'api' | 'system';
};
