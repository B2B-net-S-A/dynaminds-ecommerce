import { createHash } from 'node:crypto';
import { z } from 'zod';
import { proformaIssueInput, proformaPreviewInput } from './proforma-values';

export const PROFORMA_BATCH_LIMITS = {
  orders: 50,
  page: 50,
  preview_bytes: 4194304,
  history_bytes: 67108864,
  previews: 2000,
  executions: 2000,
  preview_minutes: 15,
} as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const proformaBatchPreviewInput = z.strictObject({
  client_key: uuid,
  series_id: uuid,
  shipping_vat: proformaPreviewInput.shape.shipping_vat,
  orders: z
    .array(
      z.strictObject({ order_id: uuid, order_version: proformaPreviewInput.shape.order_version }),
    )
    .min(1)
    .max(50)
    .refine((rows) => new Set(rows.map((r) => r.order_id)).size === rows.length)
    .transform((rows) =>
      [...rows].sort((a, b) => (a.order_id < b.order_id ? -1 : a.order_id > b.order_id ? 1 : 0)),
    ),
});
export const proformaBatchIssueInput = proformaIssueInput;
export const proformaBatchHistoryQuery = z.strictObject({
  kind: z.enum(['preview', 'execution']),
  cursor: uuid.optional(),
});
export type ProformaBatchPreviewInput = z.infer<typeof proformaBatchPreviewInput>;
export type ProformaBatchIssueInput = z.infer<typeof proformaBatchIssueInput>;
/** Version-8 UUID, deterministic only inside this domain; never a user-selectable child key. */
export function proformaBatchChildKey(
  parentId: string,
  orderId: string,
  operation: 'preview' | 'issue',
) {
  const h = createHash('sha256')
    .update(`proforma.batch:${parentId.toLowerCase()}:${orderId.toLowerCase()}:${operation}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
