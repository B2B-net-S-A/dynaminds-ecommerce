import { z } from 'zod';
import { catalogXmlPathValid } from '../shared/catalog-xml-path';

export const SUPPLIER_FILE_SOURCE_LIMITS = {
  rows: 500,
  file_bytes: 2097152,
  xml_depth: 16,
  xml_nodes: 100000,
} as const;
export const SUPPLIER_FILE_SOURCE_FIELDS = [
  'remote_id',
  'remote_variant_id',
  'sku',
  'name',
  'ean',
  'description',
  'cost_minor',
  'quantity',
  'handling_days',
] as const;
export const supplierFileCurrency = z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']);
const validUnicode = (v: string) => Buffer.from(v, 'utf8').toString('utf8') === v;
const text = (max: number) =>
  z
    .string()
    .refine(
      (v) => validUnicode(v) && !/[\u0000-\u001f\u007f-\u009f]/u.test(v),
      'Nieprawidłowy tekst',
    )
    .trim()
    .min(1)
    .max(max);
const field = z.strictObject({
  path: z.string().min(1).max(1024),
  value_type: z.enum(['text', 'integer', 'decimal_money']).default('text'),
});
export const supplierFileSourceConfig = z
  .strictObject({
    format: z.enum(['csv', 'xml']),
    delimiter: z.enum([';', ',', '\t', '|']).default(';'),
    record_path: z.string().min(1).max(1024).optional(),
    fields: z.strictObject({
      remote_id: field,
      name: field,
      cost_minor: field,
      quantity: field,
      remote_variant_id: field.optional(),
      sku: field.optional(),
      ean: field.optional(),
      description: field.optional(),
      handling_days: field.optional(),
    }),
  })
  .superRefine((v, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (v.format === 'xml') {
      if (!v.record_path || !catalogXmlPathValid(v.record_path, true, 16))
        issue(['record_path'], 'XML wymaga jawnej absolutnej ścieżki rekordów');
    } else if (v.record_path !== undefined)
      issue(['record_path'], 'Ścieżka rekordów jest dostępna tylko dla XML');
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(v.fields)) {
      if (!value) continue;
      const allowed =
        key === 'cost_minor'
          ? ['integer', 'decimal_money']
          : ['quantity', 'handling_days'].includes(key)
            ? ['integer']
            : ['text'];
      if (!allowed.includes(value.value_type))
        issue(['fields', key, 'value_type'], 'Pole wymaga właściwego typu tekstu lub liczby');
      const valid =
        v.format === 'xml'
          ? catalogXmlPathValid(value.path, false, 16)
          : value.path.length <= 80 &&
            value.path.trim() === value.path &&
            validUnicode(value.path) &&
            !/[\u0000-\u001f\u007f-\u009f]/u.test(value.path) &&
            !['__proto__', 'prototype', 'constructor'].includes(value.path);
      if (!valid) issue(['fields', key, 'path'], 'Nieprawidłowa ścieżka lub nazwa kolumny');
      const identity = v.format === 'csv' ? value.path.toLowerCase() : value.path;
      if (seen.has(identity)) issue(['fields', key, 'path'], 'Powtórzone pole źródła');
      seen.add(identity);
    }
  });
export const sourceCreateInput = z.strictObject({
  client_key: z.uuid(),
  supplier_id: z.uuid(),
  name: text(120),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .default('pl'),
  currency: supplierFileCurrency,
  max_handling_days: z.number().int().min(0).max(365).default(2),
  config: supplierFileSourceConfig,
});
export const configUpdateInput = z.strictObject({
  client_key: z.uuid(),
  version: z.number().int().positive(),
  name: text(120),
  config: supplierFileSourceConfig,
});
export const previewInput = z.strictObject({
  client_key: z.uuid(),
  version: z.number().int().positive(),
  filename: z
    .string()
    .max(200)
    .refine((v) => validUnicode(v) && !/[\u0000-\u001f\u007f-\u009f]/u.test(v))
    .default(''),
  content: z.string().min(1).max(SUPPLIER_FILE_SOURCE_LIMITS.file_bytes),
  scope: z.enum(['delta', 'full']).default('delta'),
});
export const applyInput = z.strictObject({
  client_key: z.uuid(),
  confirm_rows: z.number().int().min(1).max(500),
  confirm_missing: z.boolean().default(false),
});
export const pageInput = z.strictObject({
  source_id: z.uuid().optional(),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type SupplierFileSourceConfig = z.infer<typeof supplierFileSourceConfig>;
export type SupplierFileSourceCreateInput = z.infer<typeof sourceCreateInput>;
export type SupplierFileSourceConfigUpdateInput = z.infer<typeof configUpdateInput>;
export type SupplierFileSourcePreviewInput = z.infer<typeof previewInput>;
export type SupplierFileSourceApplyInput = z.infer<typeof applyInput>;
export type SupplierFileSourcePageInput = z.infer<typeof pageInput>;
