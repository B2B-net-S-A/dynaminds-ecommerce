import { z } from 'zod';

export const catalogExportCatalogId = z.uuid().transform(v => v.toLowerCase());
export const catalogExportCatalogVersion = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(v => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n, 'Niepoprawna wersja katalogu');
export const catalogExportCatalogFields = { catalog_id: catalogExportCatalogId.optional() };
export const catalogExportCatalogScopeFields = {
  ...catalogExportCatalogFields,
  catalog_version: catalogExportCatalogVersion.optional(),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
};
export function validCatalogExportScope(v: { catalog_id?: string; catalog_version?: string; scope_hash?: string }, ctx: z.RefinementCtx) {
  if (!v.catalog_id && (v.catalog_version !== undefined || v.scope_hash !== undefined))
    ctx.addIssue({ code: 'custom', path: ['catalog_id'], message: 'Wersja i zakres wymagają jawnego katalogu' });
  if ((v.catalog_version !== undefined) !== (v.scope_hash !== undefined))
    ctx.addIssue({ code: 'custom', path: ['scope_hash'], message: 'Wersja i hash zakresu muszą występować razem' });
}
