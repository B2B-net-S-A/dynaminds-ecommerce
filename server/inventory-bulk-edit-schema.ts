import { z } from 'zod';
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine(
      (v) => v.length <= max && !v.includes('\0') && Buffer.from(v, 'utf8').toString('utf8') === v,
      'Niepoprawny Unicode lub długość',
    );
const version = z
  .string()
  .max(19)
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine(
    (v) => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n,
    'Wersja przekracza bigint',
  )
  .nullable();
const base = {
  product_id: z.uuid(),
  product_version: z.number().int().positive().max(2147483647),
  location: text(80),
  stock_version: version,
};
export const inventoryBulkEditRow = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.literal('none') }),
  z.strictObject({
    ...base,
    operation: z.literal('count'),
    quantity: z.number().int().min(0).max(1000000),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('move'),
    quantity: z.number().int().min(1).max(1000000),
    destination: text(80),
  }),
]);
export const inventoryBulkEditPreviewInput = z
  .strictObject({
    client_key: z.uuid(),
    warehouse_id: z.uuid(),
    note: text(500).refine((v) => v.length >= 3),
    rows: z.array(inventoryBulkEditRow).min(1).max(500),
  })
  .superRefine((v, c) => {
    const seen = new Set<string>(),
      versions = new Map<string, string | null>();
    for (const r of v.rows) {
      const key = r.product_id + '\0' + r.location;
      if (seen.has(key)) c.addIssue({ code: 'custom', message: 'Powtórzony produkt/lokalizacja' });
      seen.add(key);
      if (versions.has(r.product_id) && versions.get(r.product_id) !== r.stock_version)
        c.addIssue({ code: 'custom', message: 'Sprzeczne wersje stock produktu' });
      versions.set(r.product_id, r.stock_version);
    }
  });
export const inventoryBulkEditExecuteInput = z.strictObject({
  client_key: z.uuid(),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
export const inventoryBulkEditSelectionQuery = z.strictObject({
  warehouse_id: z.uuid(),
  ids: z
    .string()
    .min(1)
    .max(2000)
    .transform((v) => v.split(','))
    .pipe(z.array(z.uuid()).min(1).max(50))
    .refine((v) => new Set(v).size === v.length, 'Powtórzony produkt'),
  cursor: z.string().max(300).optional(),
});
export const inventoryBulkEditRowsQuery = z.strictObject({
  cursor: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,2})$/)
    .optional(),
});
export const inventoryBulkEditHistoryQuery = z.strictObject({
  cursor: z.string().max(300).optional(),
});
export type InventoryBulkEditInput = z.infer<typeof inventoryBulkEditPreviewInput>;
export type InventoryBulkEditExecute = z.infer<typeof inventoryBulkEditExecuteInput>;
