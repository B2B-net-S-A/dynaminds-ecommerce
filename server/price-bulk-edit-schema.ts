import { z } from 'zod';
const version = z.number().int().positive().max(2147483647);
const base = { product_id: z.uuid(), product_version: version };
export const priceBulkEditRow = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.literal('none') }),
  z.strictObject({ ...base, operation: z.literal('remove') }),
  z.strictObject({
    ...base,
    operation: z.literal('set'),
    basis: z.enum(['gross', 'net']),
    amount_minor: z.number().int().min(0).max(100000000),
  }),
]);
export const priceBulkEditPreviewInput = z
  .strictObject({
    client_key: z.uuid(),
    price_list_id: z.uuid(),
    list_version: version,
    rows: z.array(priceBulkEditRow).min(1).max(500),
  })
  .refine(
    (v) => new Set(v.rows.map((r) => r.product_id)).size === v.rows.length,
    'Powtórzony produkt',
  );
export const priceBulkEditExecuteInput = z.strictObject({
  client_key: z.uuid(),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  ack_missing_prices: z.boolean().default(false),
});
export const priceBulkEditMetadataQuery = z.strictObject({
  cursor: z.uuid().optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .refine(
      (v) => !v.includes('\0') && Buffer.from(v, 'utf8').toString('utf8') === v,
      'Niepoprawny Unicode',
    )
    .default(''),
});
export const priceBulkEditSelectionQuery = z.strictObject({
  price_list_id: z.uuid(),
  ids: z
    .string()
    .min(1)
    .max(2000)
    .transform((v) => v.split(','))
    .pipe(z.array(z.uuid()).min(1).max(50))
    .refine((v) => new Set(v).size === v.length, 'Powtórzony produkt'),
  cursor: z.string().max(300).optional(),
});
export const priceBulkEditRowsQuery = z.strictObject({
  cursor: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,2})$/)
    .optional(),
});
export const priceBulkEditHistoryQuery = z.strictObject({ cursor: z.string().max(300).optional() });
export type PriceBulkEditInput = z.infer<typeof priceBulkEditPreviewInput>;
export type PriceBulkEditExecute = z.infer<typeof priceBulkEditExecuteInput>;
