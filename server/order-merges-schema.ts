import { z } from 'zod';

export const ORDER_MERGE_LIMITS = {
  orders: 100,
  lines: 10000,
  rows_page: 100,
  sources_page: 100,
  history_page: 25,
  request_bytes: 65536,
  preview_bytes: 8388608,
  response_bytes: 5242880,
  evidence_bytes: 134217728,
  previews: 2000,
  executions: 2000,
  preview_ttl_seconds: 900,
} as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const orderMergeMode = z.enum(['technical_merge', 'into_main_order']);
export const orderMergePreviewInput = z
  .strictObject({
    client_key: uuid,
    main_order_id: uuid,
    order_ids_to_merge: z.array(uuid).min(1).max(99),
    merge_mode: orderMergeMode,
    sum_delivery_costs: z.boolean(),
  })
  .superRefine((v, c) => {
    if (
      new Set(v.order_ids_to_merge).size !== v.order_ids_to_merge.length ||
      v.order_ids_to_merge.includes(v.main_order_id)
    )
      c.addIssue({
        code: 'custom',
        message: 'Wybierz unikalne zamówienia; główne nie może wystąpić ponownie',
      });
  })
  .transform((v) => ({ ...v, order_ids_to_merge: [...v.order_ids_to_merge].sort() }));
export const orderMergeExecuteInput = z.strictObject({
  client_key: uuid,
  preview_id: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  confirmed_receiver_selection: z.boolean().optional(),
});
export const orderMergePageQuery = z.strictObject({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export const orderMergeHistoryQuery = z.strictObject({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(25).default(25),
});
export type OrderMergePreviewInput = z.infer<typeof orderMergePreviewInput>;
export type OrderMergeExecuteInput = z.infer<typeof orderMergeExecuteInput>;
export type OrderMergePageQuery = z.infer<typeof orderMergePageQuery>;
