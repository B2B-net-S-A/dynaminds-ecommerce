import { z } from 'zod';
import { printUuid, printVersion } from './print-job-values';
export const SHIPMENT_LABEL_PRINT_LIMITS = {
  previews: 2000,
  assets: 2000,
  content_bytes: 2097152,
  snapshot_bytes: 4194304,
  history_bytes: 67108864,
  preview_seconds: 900,
} as const;
export const shipmentLabelPrintPreviewInput = z.strictObject({
  client_key: printUuid,
  order_version: printVersion,
  station_id: printUuid,
  station_version: printVersion,
  printer_id: printUuid,
  printer_version: printVersion,
  copies: z.number().int().min(1).max(10),
  asset_id: printUuid.optional(),
});
export const shipmentLabelPrintQueueInput = z.strictObject({
  client_key: printUuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
export type ShipmentLabelPrintPreviewInput = z.infer<typeof shipmentLabelPrintPreviewInput>;
export type ShipmentLabelPrintQueueInput = z.infer<typeof shipmentLabelPrintQueueInput>;
