import { z } from 'zod';
const literal = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (v) => new TextDecoder().decode(new TextEncoder().encode(v)) === v && !v.includes('\0'),
      'Niepoprawny UTF8',
    );
export const orderFieldMappingSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('woo_customer_note') }),
  z.strictObject({ kind: z.literal('woo_meta'), key: literal(160) }),
  z.strictObject({ kind: z.literal('allegro_message_to_seller') }),
  z.strictObject({ kind: z.literal('allegro_buyer_login') }),
  z.strictObject({ kind: z.literal('allegro_delivery_method_name') }),
  z.strictObject({ kind: z.literal('shopify_note') }),
  z.strictObject({ kind: z.literal('shopify_name') }),
]);
const type = z.enum(['text', 'number', 'date', 'select', 'radio', 'multi_select']);
export const orderFieldMappingSchema = z
  .strictObject({
    source: orderFieldMappingSourceSchema,
    field_id: z.uuid(),
    definition_version: z.number().int().positive(),
    type,
    conversion: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('direct') }),
      z.strictObject({
        kind: z.literal('option_map'),
        input: z.enum(['scalar', 'array']),
        codes: z
          .array(z.strictObject({ code: literal(120), option_id: z.uuid() }))
          .min(1)
          .max(100),
      }),
    ]),
    on_missing: z.enum(['skip', 'error']),
  })
  .superRefine((m, ctx) => {
    const options = ['select', 'radio', 'multi_select'].includes(m.type);
    if (options !== (m.conversion.kind === 'option_map'))
      ctx.addIssue({ code: 'custom', message: 'Typ wymaga zgodnego jawnego konwertera' });
    if (m.conversion.kind === 'option_map') {
      if (m.type !== 'multi_select' && m.conversion.input !== 'scalar')
        ctx.addIssue({ code: 'custom', message: 'Lista źródłowa jest tylko dla multi_select' });
      if (new Set(m.conversion.codes.map((c) => c.code)).size !== m.conversion.codes.length)
        ctx.addIssue({ code: 'custom', message: 'Powtórzony kod słownika' });
    }
  });
const mappings = z
  .array(orderFieldMappingSchema)
  .min(1)
  .max(20)
  .refine((v) => new Set(v.map((m) => m.field_id)).size === v.length, 'Powtórzone pola');
export const orderFieldMappingProfileSchema = z.strictObject({
  client_key: z.uuid(),
  channel_id: z.uuid(),
  label: literal(120),
  enabled: z.boolean(),
  mappings,
});
export const orderFieldMappingProfilePatchSchema = z.strictObject({
  client_key: z.uuid(),
  version: z.number().int().positive(),
  label: literal(120),
  enabled: z.boolean(),
  mappings,
});
const sourceHash = z.string().regex(/^[a-f0-9]{64}$/);
export const orderFieldMappingPreviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    client_key: z.uuid(),
    kind: z.literal('initial'),
    profile_id: z.uuid(),
    profile_version: z.number().int().positive(),
    inbound_id: z.uuid(),
    observation_id: z.uuid(),
    source_hash: sourceHash,
    warehouse_id: z.uuid(),
  }),
  z.strictObject({
    client_key: z.uuid(),
    kind: z.literal('reconcile'),
    profile_id: z.uuid(),
    profile_version: z.number().int().positive(),
    policy: z.enum(['fill_unset', 'replace']),
    orders: z
      .array(
        z.strictObject({
          inbound_id: z.uuid(),
          observation_id: z.uuid(),
          source_hash: sourceHash,
          order_id: z.uuid(),
          order_version: z.number().int().positive(),
        }),
      )
      .min(1)
      .max(100),
  }),
]);
export const orderFieldMappingImportSchema = z.strictObject({
  client_key: z.uuid(),
  consent: z.strictObject({ scope_hash: sourceHash, local_only: z.literal(true) }),
});
export const orderFieldMappingQueueSchema = z.strictObject({
  client_key: z.uuid(),
  selected_rows: z.array(z.uuid()).min(1).max(100),
  consent: z.strictObject({
    scope_hash: sourceHash,
    selected_count: z.number().int().min(1).max(100),
    policy: z.enum(['fill_unset', 'replace']),
    local_only: z.literal(true),
  }),
});
export const orderFieldMappingHistorySchema = z.strictObject({
  cursor: z.string().max(300).optional(),
});
export const orderFieldMappingSourcesQuerySchema = z.strictObject({
  channel_id: z.uuid(),
  cursor: z.string().max(300).optional(),
});
export const orderFieldMappingCancelSchema = z.strictObject({});
export type OrderFieldMapping = z.infer<typeof orderFieldMappingSchema>;
export type OrderFieldMappingPreviewInput = z.infer<typeof orderFieldMappingPreviewSchema>;
export type MappedInitialConsent = {
  preview_id: string;
  scope_hash: string;
  client_key: string;
  origin: 'manual' | 'api';
};
