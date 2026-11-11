import { z } from 'zod';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const quantity = z.number().int().min(1).max(100000);
const key = { client_key: uuid };
export const B2B_DROPSHIP_LIMITS = {
  items: 100,
  products: 100,
  quantity: 100000,
  page_rows: 100,
  quotes: 2000,
  orders: 2000,
  proof_bytes: 134217728,
} as const;
export const b2bDropshipQuoteInput = z
  .strictObject({
    ...key,
    customer_order_id: uuid,
    fulfillment_basis: z.literal('external_intent').optional(),
    intent_version: z.number().int().positive().optional(),
    items: z
      .array(
        z.strictObject({
          customer_item_id: uuid,
          quantity,
          mappings: z
            .array(z.strictObject({ product_id: uuid, catalog_item_id: uuid }))
            .min(1)
            .max(100),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((v, c) => {
    if (Boolean(v.fulfillment_basis) !== Boolean(v.intent_version))
      c.addIssue({ code: 'custom', message: 'Podaj dokładną wersję intencji' });
    if (new Set(v.items.map((i) => i.customer_item_id)).size !== v.items.length)
      c.addIssue({ code: 'custom', message: 'Pozycja klienta występuje wielokrotnie' });
    for (const i of v.items)
      if (new Set(i.mappings.map((m) => m.product_id)).size !== i.mappings.length)
        c.addIssue({ code: 'custom', message: 'Składnik występuje wielokrotnie' });
  });
export const b2bDropshipCheckoutInput = z.strictObject({
  ...key,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  confirmed_receiver: z.literal(true),
});
export const b2bDropshipCancelInput = z.strictObject({
  ...key,
  version: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1000),
  confirmed: z.literal(true),
});
export const b2bDropshipReconcileInput = z.strictObject({
  ...key,
  version: z.number().int().positive(),
  confirmed: z.literal(true),
});
export const b2bDropshipPageQuery = z.strictObject({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const b2bDropshipSourceQuery = b2bDropshipPageQuery.extend({
  search: z.string().trim().max(100).default(''),
});
export type B2bDropshipQuoteInput = z.infer<typeof b2bDropshipQuoteInput>;
