import { z } from 'zod';

export const AUTOMATIC_WZ_LIMITS = { warehouses: 200, page: 50, previews: 2000, operations: 2000, tenant_bytes: 67108864, preview_ttl_seconds: 900 } as const;
export const automaticWzUuid = z.uuid().transform(v => v.toLowerCase());
export const automaticWzVersion = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) < 9223372036854775807n);
const label = z.string().trim().min(2).max(80).refine(v => !/[\p{Cc}\p{Cs}]/u.test(v), 'Niepoprawna nazwa serii');
export const automaticWzSettings = z.strictObject({ enabled: z.boolean(), moment: z.literal('physical_dispatch'), series_name: label, prefix: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,23}$/) });
export const automaticWzPreviewInput = z.strictObject({ client_key: automaticWzUuid, expected_version: automaticWzVersion, settings: automaticWzSettings });
export const automaticWzCommitInput = z.strictObject({ client_key: automaticWzUuid, scope_hash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) });
export const automaticWzPageQuery = z.strictObject({ cursor: automaticWzUuid.optional(), limit: z.coerce.number().int().min(1).max(50).default(50) });
export const automaticWzHistoryQuery = automaticWzPageQuery.extend({ warehouse_id: automaticWzUuid.optional(), kind: z.enum(['preview','operation']).default('operation') });
export type AutomaticWzActor = { tenantId: string; userId: string; role: 'admin'|'operator'|'viewer'; apiKeyId?: string };
export type AutomaticWzSettings = z.infer<typeof automaticWzSettings>;
export type AutomaticWzConfiguration = { warehouse_id: string; version: string; series_id: string|null; settings: AutomaticWzSettings|null };
export type AutomaticWzWarehouse = { id: string; name: string; code: string };
export type AutomaticWzSnapshot = { warehouse: AutomaticWzWarehouse; before: AutomaticWzConfiguration; after: AutomaticWzConfiguration };
export type AutomaticWzPreview = { id: string; warehouse_id: string; client_key: string; request: z.infer<typeof automaticWzPreviewInput>; scope_hash: string; snapshot: AutomaticWzSnapshot; ready: boolean; created_at: string; expires_at: string; operation_id: string|null; can_commit: boolean };
export type AutomaticWzOperation = { id: string; warehouse_id: string; preview_id: string; client_key: string; request: z.infer<typeof automaticWzCommitInput>; scope_hash: string; snapshot: AutomaticWzSnapshot; before: AutomaticWzConfiguration; after: AutomaticWzConfiguration; revision_id: string; created_at: string };
export type AutomaticWzFlags = { available: boolean; configuration_available: boolean; issuer_available: boolean; current_role: string; can_read: boolean; can_manage: boolean; read_only: boolean };
/** Foundation only: no physical issuer or stock mutation is exported here. */
