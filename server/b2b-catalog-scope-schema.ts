import { z } from 'zod';

/** Configuration tranche only. Publication/import and HTTP handlers are separate consumers. */
export const B2B_CATALOG_SCOPE_LIMITS = {
  selected_products: 500,
  page: 50,
  preview_ttl_seconds: 900,
  receipts: 5000,
  tenant_bytes: 67108864,
} as const;
const uuid = z.uuid().transform(value => value.toLowerCase());
const version = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(
  value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
  'Niepoprawna wersja',
);
const legacyVersion = version.refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 2147483647n, 'Niepoprawna wersja konta lub powiązania');
export const b2bCatalogScopeLanguage = z.string().max(40).regex(/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/);
export const b2bSupplierCatalogScopePreviewInput = z.strictObject({
  client_key: uuid,
  account_version: legacyVersion,
  catalog_id: uuid,
  catalog_version: version,
  warehouse_id: uuid,
  price_list_id: uuid,
  language: b2bCatalogScopeLanguage,
});
export const b2bBuyerCatalogScopePreviewInput = z.strictObject({
  client_key: uuid,
  link_version: legacyVersion,
  target_catalog_id: uuid,
  target_catalog_version: version,
});
export const b2bCatalogScopeCommitInput = z.strictObject({
  client_key: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
export const b2bCatalogBindInput = z.strictObject({
  client_key: uuid,
  version: z.number().int().min(1).max(2147483647),
  product_id: uuid,
  confirmed: z.literal(true),
});
export const b2bCatalogScopeListQuery = z.strictObject({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(B2B_CATALOG_SCOPE_LIMITS.page).default(B2B_CATALOG_SCOPE_LIMITS.page),
});
export const b2bCatalogScopeHistoryQuery = b2bCatalogScopeListQuery.extend({
  kind: z.enum(['preview', 'operation']).default('preview'),
});
/** Bound selection primitive for subsequent publication; no publication handler in this tranche. */
export const b2bCatalogScopeSelectedInput = z.array(uuid).min(1).max(B2B_CATALOG_SCOPE_LIMITS.selected_products)
  .refine(ids => new Set(ids).size === ids.length, 'Powtórzona oferta')
  .transform(ids => [...ids].sort());
export type B2BSupplierCatalogScopePreviewInput = z.infer<typeof b2bSupplierCatalogScopePreviewInput>;
export type B2BBuyerCatalogScopePreviewInput = z.infer<typeof b2bBuyerCatalogScopePreviewInput>;
export type B2BCatalogScopeCommitInput = z.infer<typeof b2bCatalogScopeCommitInput>;
export type B2BCatalogScopeActor = {
  tenantId: string; userId: string; role: 'admin' | 'operator' | 'viewer';
  apiKeyId?: string; source?: 'api' | 'manual' | 'system';
};
