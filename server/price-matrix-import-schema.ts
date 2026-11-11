import { z } from 'zod';
import { priceFileImportDefinition, type PriceFileImportRow } from './price-file-import-schema';
export const PRICE_MATRIX_IMPORT_LIMITS = {
  file_bytes: 2097152,
  request_bytes: 3145728,
  products: 500,
  lists: 8,
  cells: 4000,
  page: 50,
  preview_bytes: 33554432,
  history_per_tenant: 2000,
  history_bytes: 268435456,
  profiles: 100,
} as const;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !v.includes('\0') && Buffer.from(v).toString('utf8') === v, 'Niepoprawny tekst');
const version = z.number().int().positive().max(2147483647);
export const priceMatrixImportDefinition = priceFileImportDefinition;
const target = z.strictObject({ price_list_id: z.uuid(), definition: priceFileImportDefinition });
const sameIdentity = (targets: Array<z.infer<typeof target>>) => {
  const d = targets[0].definition;
  return targets.every(
    ({ definition: x }) =>
      x.format === d.format &&
      x.delimiter === d.delimiter &&
      x.identity === d.identity &&
      x.mapping.identity === d.mapping.identity &&
      x.spreadsheet_safe === d.spreadsheet_safe,
  );
};
const targets = z
  .array(target)
  .min(2)
  .max(8)
  .refine((t) => new Set(t.map((x) => x.price_list_id)).size === t.length, 'Powtórzony cennik')
  .refine(sameIdentity, 'Wspólne mapowanie tożsamości musi być identyczne')
  .transform((t) => t.sort((a, b) => a.price_list_id.localeCompare(b.price_list_id)));
const previewTargets = z
  .array(target.extend({ list_version: version }))
  .min(2)
  .max(8)
  .refine((t) => new Set(t.map((x) => x.price_list_id)).size === t.length, 'Powtórzony cennik')
  .refine(sameIdentity, 'Wspólne mapowanie tożsamości musi być identyczne')
  .transform((t) => t.sort((a, b) => a.price_list_id.localeCompare(b.price_list_id)));
export const priceMatrixImportPreviewInput = z.strictObject({
  client_key: z.uuid(),
  file_name: text(120),
  content: text(PRICE_MATRIX_IMPORT_LIMITS.file_bytes),
  targets: previewTargets,
});
export const priceMatrixImportExecuteInput = z.strictObject({
  client_key: z.uuid(),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  ack_missing_price_list_ids: z
    .array(z.uuid())
    .max(8)
    .default([])
    .refine((t) => new Set(t).size === t.length, 'Powtórzone potwierdzenie')
    .transform((t) => t.sort()),
});
export const priceMatrixImportProfileInput = z.strictObject({
  client_key: z.uuid(),
  name: text(120),
  targets,
});
export const priceMatrixImportProfileUpdateInput = priceMatrixImportProfileInput.extend({
  version,
});
export const priceMatrixImportOptionsQuery = z.strictObject({
  cursor: z.uuid().optional(),
  search: z.string().max(100).default(''),
});
export const priceMatrixImportPageQuery = z.strictObject({ cursor: z.uuid().optional() });
export const priceMatrixImportRowsQuery = z.strictObject({
  cursor: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,2})$/)
    .optional(),
});
export type PriceMatrixImportInput = z.infer<typeof priceMatrixImportPreviewInput>;
export type PriceMatrixImportActor = import('./price-bulk-edit').PriceBulkEditActor;
export type PriceMatrixImportCell = Pick<
  PriceFileImportRow,
  'input' | 'status' | 'before' | 'after' | 'errors' | 'skipped_price_groups'
> & { price_list_id: string };
export type PriceMatrixImportRow = Pick<
  PriceFileImportRow,
  'index' | 'raw_cells' | 'resolution' | 'product_id' | 'sku' | 'name' | 'errors'
> & { cells: PriceMatrixImportCell[] };
