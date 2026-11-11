import { z } from 'zod';
import { printUuid, printVersion } from './print-job-values';
export const SHIPMENT_LABEL_CACHE_LIMITS = {
  assets: 2000,
  acquisitions: 2000,
  content_bytes: 2097152,
  history_bytes: 67108864,
  page: 50,
} as const;
export const SHIPMENT_LABEL_CACHE_STATES = [
  'fetching',
  'ready',
  'failed',
  'unknown',
  'abandoned',
] as const;
export const shipmentLabelCacheAcquireInput = z.strictObject({
  client_key: printUuid,
  order_version: printVersion,
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed_existing_label: z.literal(true),
});
export const shipmentLabelCacheReconcileInput = z.strictObject({
  client_key: printUuid,
  confirmed_abandon: z.literal(true),
});
export const shipmentLabelCachePageInput = z.strictObject({
  cursor: printUuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export type ShipmentLabelCacheAcquireInput = z.infer<typeof shipmentLabelCacheAcquireInput>;
export type ShipmentLabelCacheReconcileInput = z.infer<typeof shipmentLabelCacheReconcileInput>;
export type ShipmentLabelCachePageInput = z.infer<typeof shipmentLabelCachePageInput>;
export type ShipmentLabelCacheHead = {
  id: string;
  shipment_id: string;
  order_id: string;
  provider: 'inpost' | 'dpd';
  mode: 'sandbox' | 'live';
  tracking_number: string;
  shipping_plan_id: string | null;
  format: 'pdf';
  layout: 'A6' | 'A4';
  content_sha256: string;
  content_bytes: number;
  source_hash: string;
  acquisition_id: string;
  origin: 'provider_get' | 'legacy_dpd_cache';
  created_at: string;
};
export type ShipmentLabelCacheAcquisition = {
  id: string;
  shipment_id: string;
  state: (typeof SHIPMENT_LABEL_CACHE_STATES)[number];
  asset_id: string | null;
  source_hash: string;
  created_at: string;
  updated_at: string;
  error_code:
    | 'LABEL_FETCH_FAILED'
    | 'LABEL_INVALID'
    | 'SOURCE_CHANGED'
    | 'ACCESS_REVOKED'
    | 'ABANDONED'
    | null;
  can_reconcile: boolean;
};
