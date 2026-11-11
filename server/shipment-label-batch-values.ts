import { createHash } from 'node:crypto';
import { z } from 'zod';
import { printUuid, printVersion } from './print-job-values';

export const SHIPMENT_LABEL_BATCH_LIMITS = {
  max_shipments: 50,
  max_source_bytes: 2097152,
  max_combined_bytes: 16777216,
  max_pages: 500,
  max_copies: 10,
  preview_ttl_seconds: 900,
  max_previews: 2000,
  max_executions: 2000,
} as const;

export const shipmentLabelBatchPreviewInput = z.strictObject({
  client_key: printUuid,
  station_id: printUuid,
  station_version: printVersion,
  printer_id: printUuid,
  printer_version: printVersion,
  copies: z.number().int().min(1).max(SHIPMENT_LABEL_BATCH_LIMITS.max_copies),
  shipments: z
    .array(
      z.strictObject({
        shipment_id: printUuid,
        order_version: printVersion,
        asset_id: printUuid,
      }),
    )
    .min(1)
    .max(SHIPMENT_LABEL_BATCH_LIMITS.max_shipments)
    .refine(
      (rows) => new Set(rows.map((row) => row.shipment_id)).size === rows.length,
      'Każda przesyłka może wystąpić tylko raz',
    ),
});
export const shipmentLabelBatchQueueInput = z.strictObject({
  client_key: printUuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
export const shipmentLabelBatchHistoryInput = z.strictObject({
  kind: z.enum(['preview', 'execution']),
  cursor: printUuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export type ShipmentLabelBatchPreviewInput = z.infer<typeof shipmentLabelBatchPreviewInput>;
export type ShipmentLabelBatchQueueInput = z.infer<typeof shipmentLabelBatchQueueInput>;
export type ShipmentLabelBatchHistoryInput = z.infer<typeof shipmentLabelBatchHistoryInput>;

/** Domain-separated UUID8; caller order is never sorted to generate a batch. */
export function shipmentLabelBatchChildKey(
  parent: string,
  shipment: string,
  operation: 'preview' | 'queue',
) {
  const h = createHash('sha256')
    .update(
      `shipment.label.batch:${printUuid.parse(parent)}:${printUuid.parse(shipment)}:${z.enum(['preview', 'queue']).parse(operation)}`,
    )
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
