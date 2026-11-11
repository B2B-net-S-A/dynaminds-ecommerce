import { z } from 'zod';
import { orderSchema } from './domain';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const q = z.number().int().min(0).max(100000);
export const B2B_EXTERNAL_ORDER_INTENT_LIMITS = {
  items: 100,
  quantity: 100000,
  page_rows: 100,
  orders: 2000,
  revisions: 10000,
  proof_bytes: 134217728,
} as const;
const allocations = z
  .array(
    z.strictObject({
      customer_item_id: uuid,
      local_quantity: q,
      external_quantity: q,
      unassigned_quantity: q,
      link_id: uuid.nullable(),
    }),
  )
  .min(1)
  .max(100)
  .superRefine((a, c) => {
    if (new Set(a.map((i) => i.customer_item_id)).size !== a.length)
      c.addIssue({ code: 'custom', message: 'Powtórzona tożsamość pozycji' });
    for (const i of a)
      if (i.external_quantity > 0 !== (i.link_id !== null))
        c.addIssue({ code: 'custom', message: 'Zewnętrzna ilość wymaga jawnego połączenia' });
  });
export const b2bExternalOrderIntentCreateInput = z
  .strictObject({
    client_key: uuid,
    expected_commercial_snapshot: z
      .strictObject({
        total: z.number().int().min(0).max(2147483647),
        currency: z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']),
        items: z
          .array(
            z.strictObject({
              customer_item_id: uuid,
              product_id: uuid,
              quantity: z.number().int().min(1).max(100000),
              price: z.number().int().min(0).max(100000000),
              vat: z.union([z.literal(0), z.literal(5), z.literal(8), z.literal(23)]),
              product_version: z.string().regex(/^[1-9][0-9]*$/),
              components: z
                .array(
                  z.strictObject({
                    product_id: uuid,
                    quantity: z.number().int().min(1).max(100000),
                  }),
                )
                .min(1)
                .max(100),
            }),
          )
          .min(1)
          .max(100),
      })
      .optional(),
    order: orderSchema
      .safeExtend({
        source: z.enum(['manual', 'demo']).default('manual'),
        channel_id: z.never().optional(),
        external_id: z.never().optional(),
        items: z
          .array(
            z.strictObject({
              customer_item_id: uuid,
              product_id: uuid,
              quantity: z.number().int().min(1).max(100000),
            }),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    allocations,
  })
  .superRefine((v, c) => {
    if (
      new Set(v.order.items.map((i) => i.customer_item_id)).size !== v.order.items.length ||
      v.order.items.length !== v.allocations.length
    )
      c.addIssue({ code: 'custom', message: 'Przydział wymaga wszystkich unikalnych pozycji' });
    for (const i of v.order.items) {
      const a = v.allocations.find((a) => a.customer_item_id === i.customer_item_id);
      if (!a || a.local_quantity + a.external_quantity + a.unassigned_quantity !== i.quantity)
        c.addIssue({ code: 'custom', message: 'Suma przydziałów nie odpowiada ilości pozycji' });
    }
  });
export const b2bExternalOrderIntentAllocateInput = z.strictObject({
  client_key: uuid,
  version: z.number().int().positive(),
  allocations,
  confirmed: z.literal(true),
});
export const b2bExternalOrderIntentActionInput = z.strictObject({
  client_key: uuid,
  version: z.number().int().positive(),
  confirmed: z.literal(true),
});
export const b2bExternalOrderIntentPageQuery = z.strictObject({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
