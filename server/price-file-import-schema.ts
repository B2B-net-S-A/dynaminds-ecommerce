import { z } from 'zod';
export const PRICE_FILE_IMPORT_LIMITS = {
  file_bytes: 2097152,
  request_bytes: 3145728,
  rows: 500,
  page: 50,
  preview_bytes: 8388608,
  history_per_tenant: 2000,
  history_bytes: 134217728,
  profiles: 100,
} as const;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !v.includes('\0') && Buffer.from(v).toString('utf8') === v, 'Niepoprawny tekst');
const version = z.number().int().positive().max(2147483647);
export const priceFileImportDefinition = z
  .strictObject({
    format: z.enum(['csv', 'xml']),
    delimiter: z.enum([';', ',', '\t']),
    identity: z.enum(['uuid', 'sku', 'historical_sku', 'ean', 'name']),
    mapping: z.strictObject({
      identity: text(80),
      price: text(80),
      operation: text(80).optional(),
      currency: text(80).optional(),
    }),
    amount_mode: z.enum(['minor', 'decimal']),
    decimal_separator: z.enum(['.', ',']),
    basis: z.enum(['gross', 'net']),
    empty_policy: z.enum(['skip', 'remove']),
    spreadsheet_safe: z.boolean(),
    native_price_mode: z.enum(['mapped', 'own_entries']),
  })
  .refine(
    (v) => new Set(Object.values(v.mapping)).size === Object.values(v.mapping).length,
    'Powtórzone pole mapowania',
  )
  .refine(
    (v) =>
      v.native_price_mode !== 'own_entries' ||
      (v.format === 'xml' && v.mapping.price === 'prices_json'),
    'Własne wpisy wymagają natywnego XML',
  );
export const priceFileImportPreviewInput = z.strictObject({
  client_key: z.uuid(),
  price_list_id: z.uuid(),
  list_version: version,
  file_name: text(120),
  content: text(PRICE_FILE_IMPORT_LIMITS.file_bytes),
  definition: priceFileImportDefinition,
});
export const priceFileImportExecuteInput = z.strictObject({
  client_key: z.uuid(),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  ack_missing_prices: z.boolean().default(false),
});
export const priceFileImportProfileInput = z.strictObject({
  client_key: z.uuid(),
  name: text(120),
  definition: priceFileImportDefinition,
  price_list_id: z.uuid().nullable().optional(),
});
export const priceFileImportProfileUpdateInput = priceFileImportProfileInput.extend({ version });
export const priceFileImportOptionsQuery = z.strictObject({
  cursor: z.uuid().optional(),
  search: z.string().max(100).default(''),
});
export const priceFileImportPageQuery = z.strictObject({ cursor: z.uuid().optional() });
export const priceFileImportRowsQuery = z.strictObject({
  cursor: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,2})$/)
    .optional(),
});
export type PriceFileImportDefinition = z.infer<typeof priceFileImportDefinition>;
export type PriceFileImportInput = z.infer<typeof priceFileImportPreviewInput>;
export type PriceFileImportActor = import('./price-bulk-edit').PriceBulkEditActor;
export type PriceFileImportRow = {
  index: number;
  raw_cells: Record<string, unknown>;
  resolution: { identity: string; value: string | null; matched_historical_sku: boolean };
  product_id: string | null;
  sku: string | null;
  name: string | null;
  input: import('./price-bulk-edit-schema').PriceBulkEditInput['rows'][number] | null;
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict';
  before: unknown | null;
  after: unknown | null;
  errors: string[];
  skipped_price_groups: number;
};
