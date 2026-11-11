import { z } from 'zod';

export const B2B_RETURN_LOCAL_ORIGIN_LIMITS = Object.freeze({
  items: 100,
  sources: 1000,
  history: 2000,
  bytes: 8 * 1024 * 1024,
});
export const b2bReturnLocalOriginInput = z
  .strictObject({
    client_key: z.uuid(),
    version: z.number().int().min(1).max(2147483647),
    scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
    items: z
      .array(
        z.strictObject({
          customer_item_id: z.uuid(),
          shipment_id: z.uuid(),
          quantity: z.number().int().min(1).max(100000),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((body, ctx) => {
    if (new Set(body.items.map((i) => i.customer_item_id)).size !== body.items.length)
      ctx.addIssue({ code: 'custom', message: 'Pozycja RMA występuje więcej niż raz' });
  });
export type B2bReturnLocalOrigin = {
  id: string;
  scope_hash: string;
  created_at: string;
  items: Array<{ customer_item_id: string; shipment_id: string; quantity: number }>;
};
export type B2bReturnLocalSource = {
  customer_item_id: string;
  shipment_id: string;
  sku: string;
  name: string;
  requested: number;
  issued_quantity: number;
  quantity_available: number;
  components: Array<{ product_id: string; quantity: number }>;
};
export type B2bReturnLocalContext = {
  fulfillment_origin: 'ordinary' | 'unselected' | 'local' | 'partner' | 'supplier';
  local_origin: B2bReturnLocalOrigin | null;
  local_sources: B2bReturnLocalSource[];
  local_scope_hash: string | null;
  can_select_local_origin: boolean;
};
