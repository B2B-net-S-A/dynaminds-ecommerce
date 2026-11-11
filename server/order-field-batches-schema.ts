import { z } from 'zod';
import { orderFieldChangeSchema } from './order-fields-schema';
const policy = z.enum(['fill_unset', 'replace']);
const column = z.number().int().min(0).max(99);
export const orderFieldBatchCsvConfigSchema = z
  .strictObject({
    encoding: z.enum(['utf-8', 'windows-1250']),
    delimiter: z.enum([',', ';', '\t', '|']),
    header: z.literal(true),
    identity: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('order_id'), column }),
      z.strictObject({ kind: z.literal('external_order_id'), channel_id: z.uuid(), column }),
    ]),
    order_version_column: column,
    fields: z
      .array(
        z.strictObject({
          column,
          field_id: z.uuid(),
          definition_version: z.number().int().positive(),
        }),
      )
      .min(1)
      .max(20),
  })
  .refine(
    (v) =>
      new Set([v.identity.column, v.order_version_column, ...v.fields.map((f) => f.column)])
        .size ===
      v.fields.length + 2,
    'Kolumny muszą być unikalne',
  )
  .refine(
    (v) => new Set(v.fields.map((f) => f.field_id)).size === v.fields.length,
    'Pola muszą być unikalne',
  );
export const orderFieldBatchPreviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    client_key: z.uuid(),
    kind: z.literal('bulk'),
    policy,
    orders: z
      .array(z.strictObject({ order_id: z.uuid(), order_version: z.number().int().positive() }))
      .min(1)
      .max(100),
    changes: z.array(orderFieldChangeSchema).min(1).max(20),
  }),
  z.strictObject({
    client_key: z.uuid(),
    kind: z.literal('csv'),
    policy,
    filename: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\/\\\u0000-\u001f\u007f]*$/),
    content_base64: z.string().min(4).max(6990508),
    config: orderFieldBatchCsvConfigSchema,
  }),
]);
export const orderFieldBatchQueueSchema = z.strictObject({
  client_key: z.uuid(),
  selected_rows: z.array(z.uuid()).min(1).max(100),
  consent: z.strictObject({
    scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
    selected_count: z.number().int().min(1).max(100),
    policy,
    local_only: z.literal(true),
  }),
});
export const orderFieldBatchCancelSchema = z.strictObject({});
export const orderFieldBatchHistorySchema = z.strictObject({
  cursor: z.string().max(300).optional(),
});
export const orderFieldBatchRowsPageSchema = orderFieldBatchHistorySchema;
export const orderFieldBatchExportSchema = z.strictObject({
  field_ids: z.string().max(1500),
  order_ids: z.string().max(5000).optional(),
  mode: z.enum(['csv_exact', 'csv_sheet', 'json']).default('csv_exact'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(300).optional(),
});
export type OrderFieldBatchPreviewInput = z.infer<typeof orderFieldBatchPreviewSchema>;
