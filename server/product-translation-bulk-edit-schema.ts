import { z } from 'zod';
export const PRODUCT_TRANSLATION_BULK_LIMITS = {
  max_products: 500,
  max_locales: 6,
  max_rows: 3000,
  selection_products: 50,
  page: 50,
  request_bytes: 2097152,
  preview_bytes: 8388608,
  tenant_bytes: 134217728,
  max_previews: 2000,
  max_executions: 2000,
  name_chars: 200,
  description_chars: 10000,
} as const;
export const productTranslationLocale = z
  .string()
  .max(40)
  .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/i)
  .transform((v) => v.toLowerCase());
const version = z.number().int().positive().max(2147483647);
const locales = z
  .array(productTranslationLocale)
  .min(1)
  .max(6)
  .refine((v) => new Set(v).size === v.length, 'Powtórzony język');
const unicode = (v: string) => !v.includes('\0') && Buffer.from(v, 'utf8').toString('utf8') === v;
const plain = z
  .string()
  .refine(unicode, 'Wymagany poprawny Unicode bez NUL')
  .refine(
    (v) => !/[<>\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(v),
    'Wymagany zwykły tekst bez HTML i niedozwolonych znaków sterujących',
  );
export const productTranslationTexts = z.strictObject({
  name: plain.refine(
    (v) => [...v].length >= 2 && [...v].length <= 200 && v.trim().length > 0 && !/[\r\n]/.test(v),
    'Nazwa wymaga 2–200 znaków Unicode bez newline',
  ),
  description: plain.refine((v) => [...v].length <= 10000, 'Opis przekracza 10000 znaków Unicode'),
});
const base = {
  product_id: z.uuid().transform((v) => v.toLowerCase()),
  product_version: version,
  locale: productTranslationLocale,
  translation_version: version.nullable(),
};
export const productTranslationBulkEditRow = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.literal('none') }),
  z.strictObject({ ...base, operation: z.literal('remove') }),
  z.strictObject({
    ...base,
    operation: z.literal('set'),
    patch: z
      .strictObject({ name: z.string().optional(), description: z.string().optional() })
      .refine((v) => Object.keys(v).length > 0, 'Patch wymaga pola'),
  }),
]);
export const productTranslationBulkEditPreviewInput = z
  .strictObject({
    client_key: z.uuid().transform((v) => v.toLowerCase()),
    locales,
    rows: z.array(productTranslationBulkEditRow).min(1).max(3000),
  })
  .superRefine((b, ctx) => {
    const products = new Map<string, number>(),
      pairs = new Set<string>(),
      selected = new Set(b.locales);
    for (const r of b.rows) {
      const key = r.product_id + ':' + r.locale;
      if (pairs.has(key) || !selected.has(r.locale))
        ctx.addIssue({ code: 'custom', message: 'Powtórzona para lub język poza wyborem' });
      pairs.add(key);
      if (products.has(r.product_id) && products.get(r.product_id) !== r.product_version)
        ctx.addIssue({ code: 'custom', message: 'Niespójne wersje produktu' });
      products.set(r.product_id, r.product_version);
    }
    if (products.size > 500 || pairs.size !== products.size * b.locales.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Wymagana pełna macierz do500 produktów ×6 języków',
      });
  });
export const productTranslationBulkEditExecuteInput = z.strictObject({
  client_key: z.uuid().transform((v) => v.toLowerCase()),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  ack_missing_translations: z.boolean().default(false),
});
export const productTranslationBulkEditMetadataQuery = z.strictObject({
  cursor: productTranslationLocale.optional(),
});
export const productTranslationBulkEditSelectionQuery = z.strictObject({
  ids: z
    .string()
    .min(1)
    .max(2000)
    .transform((v) => v.split(','))
    .pipe(
      z
        .array(z.uuid().transform((v) => v.toLowerCase()))
        .min(1)
        .max(50),
    )
    .refine((v) => new Set(v).size === v.length, 'Powtórzony produkt'),
  locales: z
    .string()
    .min(1)
    .max(245)
    .transform((v) => v.split(','))
    .pipe(locales),
  cursor: z.string().max(300).optional(),
});
export const productTranslationBulkEditRowsQuery = z.strictObject({
  cursor: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,3})$/)
    .optional(),
});
export const productTranslationBulkEditHistoryQuery = z.strictObject({
  cursor: z.string().max(300).optional(),
});
export type ProductTranslationBulkEditInput = z.infer<
  typeof productTranslationBulkEditPreviewInput
>;
export type ProductTranslationBulkEditRow = z.infer<typeof productTranslationBulkEditRow>;
