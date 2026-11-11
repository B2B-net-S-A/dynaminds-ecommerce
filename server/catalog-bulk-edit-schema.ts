import { PRODUCT_LOGISTICS_FIELDS } from './product-logistics-schema';
import { z } from 'zod';
import { catalogFields } from './domain';
import { productSkuSchema } from './product-sku-schema';

export const CATALOG_BULK_EDIT_FIELDS = [
  'name',
  'ean',
  'price',
  'vat',
  'category',
  'description',
  'active',
  'attributes',
  'images',
  ...PRODUCT_LOGISTICS_FIELDS,
  'sku',
] as const;
export const catalogBulkEditChanges = z.strictObject({
  name: z.unknown().optional(),
  ean: z.unknown().optional(),
  price: z.unknown().optional(),
  vat: z.unknown().optional(),
  category: z.unknown().optional(),
  description: z.unknown().optional(),
  active: z.unknown().optional(),
  attributes: z.unknown().optional(),
  images: z.unknown().optional(),
  weight_grams: z.unknown().optional(),
  length_mm: z.unknown().optional(),
  width_mm: z.unknown().optional(),
  height_mm: z.unknown().optional(),
  manufacturer: z.unknown().optional(),
  sku: z.unknown().optional(),
});
export const catalogBulkEditValues = catalogFields
  .extend({ sku: productSkuSchema.optional() })
  .strict();
export const catalogBulkEditPreviewInput = z
  .strictObject({
    client_key: z.uuid(),
    rows: z
      .array(
        z.strictObject({
          product_id: z.uuid(),
          version: z.number().int().positive().max(2147483647),
          changes: catalogBulkEditChanges,
        }),
      )
      .min(1)
      .max(500),
  })
  .refine(
    (v) => new Set(v.rows.map((r) => r.product_id)).size === v.rows.length,
    'Wybór zawiera powtórzony produkt',
  );
export const catalogBulkEditExecuteInput = z.strictObject({
  client_key: z.uuid(),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
export const catalogBulkEditSelectionQuery = z.strictObject({
  ids: z
    .string()
    .min(1)
    .max(2000)
    .transform((v) => v.split(','))
    .pipe(z.array(z.uuid()).min(1).max(50))
    .refine((v) => new Set(v).size === v.length, 'Powtórzony produkt'),
});
export const catalogBulkEditRowsQuery = z.strictObject({
  cursor: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,2})$/)
    .optional(),
});
export const catalogBulkEditHistoryQuery = z.strictObject({
  cursor: z.string().max(300).optional(),
});
export type CatalogBulkEditInput = z.infer<typeof catalogBulkEditPreviewInput>;
export type CatalogBulkEditExecute = z.infer<typeof catalogBulkEditExecuteInput>;
export type CatalogBulkEditValues = z.infer<typeof catalogBulkEditValues>;
