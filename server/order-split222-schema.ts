import { z } from 'zod';

/** Native order split (222): one child order per execution. */
export const ORDER_SPLIT222_LIMITS = {
  lines: 100,
  request_bytes: 65536,
  previews: 5000,
  preview_ttl_seconds: 900,
} as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const orderSplit222Id = uuid;
export const orderSplit222PreviewInput = z
  .strictObject({
    client_key: uuid,
    /** Parent lines to move to the child; quantity ≤ the line quantity. */
    items: z
      .array(z.strictObject({ item_id: uuid, quantity: z.number().int().min(1).max(100000) }))
      .min(1)
      .max(ORDER_SPLIT222_LIMITS.lines),
    /** Gross shipping (grosze) moved from the parent to the child; default 0. */
    shipping_cost_to_child: z.number().int().min(0).max(2147483647).default(0),
  })
  .superRefine((v, c) => {
    if (new Set(v.items.map((i) => i.item_id)).size !== v.items.length)
      c.addIssue({ code: 'custom', message: 'Każda pozycja może wystąpić tylko raz' });
  })
  .transform((v) => ({ ...v, items: [...v.items].sort((a, b) => a.item_id.localeCompare(b.item_id)) }));
export const orderSplit222ExecuteInput = z.strictObject({
  client_key: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type OrderSplit222PreviewInput = z.infer<typeof orderSplit222PreviewInput>;
export type OrderSplit222ExecuteInput = z.infer<typeof orderSplit222ExecuteInput>;
