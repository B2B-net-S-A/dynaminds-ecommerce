import { z } from 'zod';
import type { Actor } from './domain';
import { packingMeasurementsInput } from './packing-measurements';

export const PACKING_LIMITS = {
  stations: 100,
  cartons: 500,
  active_sessions: 500,
  sessions: 2000,
  previews: 2000,
  receipts: 2000,
  operations: 100000,
  storage_bytes: 134217728,
  snapshot_bytes: 5242880,
  request_bytes: 65536,
  page: 50,
  order_items: 100,
  physical_items: 10000,
  allocations: 10000,
  lease_seconds: 900,
  preview_seconds: 300,
} as const;
export type PackingActor = Actor & {
  apiKeyId?: string;
  source?: 'manual' | 'api';
  canReadProducts?: boolean;
  requireProductsRead?: boolean;
};
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const packingVersion = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n, 'Wersja przekracza bigint');
const text = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .refine(
      (v) =>
        v.length >= min &&
        v.length <= max &&
        Buffer.from(v, 'utf8').toString('utf8') === v &&
        !/[\u0000-\u001f\u007f]/.test(v),
      'Nieprawidłowy tekst',
    );
const key = { client_key: uuid };
const dimensions = z.strictObject({
  length_mm: z.number().int().min(1).max(3000),
  width_mm: z.number().int().min(1).max(3000),
  height_mm: z.number().int().min(1).max(3000),
});
export const packingStationCreateInput = z.strictObject({
  ...key,
  code: text(40),
  label: text(120),
  enabled: z.boolean(),
});
export const packingStationPatchInput = z
  .strictObject({
    ...key,
    version: packingVersion,
    code: text(40).optional(),
    label: text(120).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => ['code', 'label', 'enabled'].some((k) => Object.hasOwn(b, k)), 'Brak zmian');
export const packingCartonCreateInput = z
  .strictObject({
    ...key,
    code: text(40),
    label: text(120),
    enabled: z.boolean(),
    inner_dimensions: dimensions,
    outer_dimensions: dimensions,
    tare_grams: z.number().int().min(0).max(1000000),
  })
  .refine(
    (b) =>
      Object.keys(b.inner_dimensions).every(
        (k) =>
          b.inner_dimensions[k as keyof typeof b.inner_dimensions] <=
          b.outer_dimensions[k as keyof typeof b.outer_dimensions],
      ),
    'Wnętrze kartonu przekracza wymiary zewnętrzne',
  );
export const packingCartonPatchInput = z
  .strictObject({
    ...key,
    version: packingVersion,
    code: text(40).optional(),
    label: text(120).optional(),
    enabled: z.boolean().optional(),
    inner_dimensions: dimensions.optional(),
    outer_dimensions: dimensions.optional(),
    tare_grams: z.number().int().min(0).max(1000000).optional(),
  })
  .refine((b) => Object.keys(b).length > 2, 'Brak zmian');
export const packingPolicyInput = z.strictObject({
  ...key,
  version: z.union([z.literal('0'), packingVersion]),
  require_parcel_profile: z.boolean(),
});
export const packingSessionCreateInput = z.strictObject({
  ...key,
  order_id: uuid,
  order_version: packingVersion,
  station_id: uuid,
  station_version: packingVersion,
  lease_token: uuid,
});
export const packingLeaseRenewInput = z.strictObject({
  ...key,
  session_version: packingVersion,
  lease_token: uuid,
});
export const packingTakeoverInput = z.strictObject({
  ...key,
  session_version: packingVersion,
  station_id: uuid,
  station_version: packingVersion,
  lease_token: uuid,
});
export const packingCancelInput = z.strictObject({ ...key, session_version: packingVersion });
export const packingScanInput = z.strictObject({
  ...key,
  session_version: packingVersion,
  order_version: packingVersion,
  code: text(80),
  location: text(80).optional(),
  layer_id: uuid.optional(),
});
const packaging = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('carton'), carton_id: uuid, carton_version: packingVersion }),
  z.strictObject({ kind: z.literal('custom'), label: text(120), reason: text(500, 3) }),
]);
export const packingPreviewInput = z.discriminatedUnion('kind', [
  z.strictObject({
    ...key,
    kind: z.literal('finish'),
    session_id: uuid,
    session_version: packingVersion,
    order_version: packingVersion,
    station_version: packingVersion,
    packaging,
    measurements: packingMeasurementsInput,
    include_product_estimate: z.boolean(),
  }),
  z.strictObject({
    ...key,
    kind: z.literal('remeasure'),
    order_id: uuid,
    order_version: packingVersion,
    profile_revision: packingVersion,
    replaces_receipt_id: uuid,
    station_id: uuid,
    station_version: packingVersion,
    packaging,
    measurements: packingMeasurementsInput,
    include_product_estimate: z.boolean(),
    reason: text(500, 3),
  }),
]);
export const packingFinishInput = z.strictObject({
  ...key,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  confirm_measured: z.literal(true),
});
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
export const packingPageQuery = z.strictObject({
  cursor: z.string().max(1500).optional(),
  enabled: bool.optional(),
  search: text(120).optional(),
});
export const packingCandidateQuery = z.strictObject({
  warehouse_id: uuid,
  search: text(120).optional(),
  cursor: z.string().max(1500).optional(),
});
export const packingFrozenPageQuery = z.strictObject({
  cursor: z.string().max(1500).optional(),
  product_id: uuid.optional(),
});
export const packingReceiptPageQuery = z.strictObject({
  cursor: z.string().max(1500).optional(),
  order_id: uuid.optional(),
});
export type PackingLeaseContext = { lease_token?: string };
export type PackingBinding = { receipt_id: string; scope_hash: string; profile_revision: string };
export type PackingSessionHead = {
  id: string;
  order_id: string;
  station_id: string;
  owner_id: string;
  owner_name: string;
  state: string;
  version: string;
  lease_generation: string;
  expires_at: string;
  created_at: string;
};
export type PackingScanResult = {
  id: string;
  session_id: string;
  order_id: string;
  product_id: string;
  scanned_code: string;
  location: string;
  quantity: number;
  scanned_before: number;
  scanned_after: number;
  before_session_version: string;
  after_session_version: string;
  order_version: string;
  created_at: string;
};
export type PackingPreviewSnapshot = Record<string, any>;
export type PackingReceiptHead = Record<string, any>;
