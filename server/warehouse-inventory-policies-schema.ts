import { z } from 'zod';

export const WAREHOUSE_INVENTORY_POLICY_LIMITS = { page: 50, previews: 2000, operations: 2000, tenant_bytes: 67108864, preview_ttl_seconds: 900 } as const;
const uuid = z.uuid().transform(v => v.toLowerCase());
export const warehouseInventoryPolicyVersion = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) < 9223372036854775807n, 'Niepoprawna wersja polityki');
export const warehouseInventoryPolicyPreviewInput = z.strictObject({
  client_key: uuid, version: warehouseInventoryPolicyVersion,
  usage: z.enum(['sale', 'custody']), enabled: z.boolean(),
});
export const warehouseInventoryPolicyCommitInput = z.strictObject({
  client_key: uuid, scope_hash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true),
});
export const warehouseInventoryPolicyHistoryQuery = z.strictObject({
  kind: z.enum(['preview', 'operation']).default('preview'), cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(WAREHOUSE_INVENTORY_POLICY_LIMITS.page).default(50),
});
export type WarehouseInventoryPolicyActor = { tenantId: string; userId: string; role: 'admin' | 'operator' | 'viewer'; apiKeyId?: string };
export type WarehouseInventoryPolicy = { usage: 'sale' | 'custody'; enabled: boolean; version: string };
export type WarehouseInventoryPolicyPreview = {
  id: string; warehouse_id: string; client_key: string; request: z.infer<typeof warehouseInventoryPolicyPreviewInput>;
  scope_hash: string; snapshot: { warehouse: { id: string; name: string; code: string }; before: WarehouseInventoryPolicy; after: Omit<WarehouseInventoryPolicy, 'version'>; blockers: string[] };
  ready: boolean; created_at: string; expires_at: string;
};
export type WarehouseInventoryPolicyOperation = {
  id: string; warehouse_id: string; preview_id: string; client_key: string; scope_hash: string;
  before: WarehouseInventoryPolicy; after: WarehouseInventoryPolicy; revision_id: string; created_at: string;
};
