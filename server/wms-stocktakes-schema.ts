import { z } from 'zod';
import { wmsDecimal, type WmsActor } from './wms-lots-schema';
export type WmsStocktakeActor = WmsActor & { canReadValue?: boolean };
export const WMS_STOCKTAKE_LIMITS = {
  positions: 10000,
  count_batch: 100,
  page: 100,
  request_bytes: 2097152,
  response_bytes: 5242880,
  open: 20,
  heads: 2000,
  reviews: 2000,
  evidence_bytes: 134217728,
} as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
const text = (n: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(n)
    .refine(
      (v) => !v.includes('\0') && Buffer.from(v).toString('utf8') === v,
      'Nieprawidłowy Unicode',
    );
const location = text(80).refine(
  (v) => !/[\u0000-\u001f\u007f]/.test(v),
  'Znaki sterujące w lokalizacji',
);
const version = wmsDecimal.refine((v) => BigInt(v) > 0n);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const wmsStocktakeLot = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), lot_id: uuid }),
  z.strictObject({
    kind: z.literal('new'),
    lot_code: text(100),
    expiry_date: z.iso.date().nullable(),
  }),
]);
export const wmsStocktakeCreateInput = z.strictObject({
  client_key: uuid,
  warehouse_id: uuid,
  name: text(100).min(3),
  policy_version: version,
  blind: z.boolean().default(true),
  location_prefix: z
    .string()
    .trim()
    .max(80)
    .refine(
      (v) => !/[\u0000-\u001f\u007f]/.test(v) && Buffer.from(v).toString('utf8') === v,
      'Nieprawidłowy prefiks lokalizacji',
    )
    .default(''),
  product_ids: z.array(uuid).min(1).max(10000).optional(),
  discoveries: z
    .array(z.strictObject({ product_id: uuid, location, lot: wmsStocktakeLot }))
    .max(10000)
    .default([]),
});
export const wmsStocktakeCountInput = z.strictObject({
  client_key: uuid,
  note: text(500).min(3),
  lines: z
    .array(
      z.strictObject({
        id: uuid,
        version,
        basis_token: hash,
        quantity: z.number().int().min(0).max(2147483647),
      }),
    )
    .min(1)
    .max(100)
    .refine((v) => new Set(v.map((r) => r.id)).size === v.length, 'Powtórzony pomiar'),
});
export const wmsStocktakeReviewInput = z.strictObject({
  client_key: uuid,
  version,
  note: text(500).min(3),
  surplus: z
    .array(
      z.strictObject({
        line_id: uuid,
        unit_cost_minor: wmsDecimal,
        currency: z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']),
      }),
    )
    .max(10000)
    .refine((v) => new Set(v.map((r) => r.line_id)).size === v.length)
    .default([]),
});
export const wmsStocktakePostInput = z.strictObject({
  client_key: uuid,
  version,
  review_id: uuid,
  scope_hash: hash,
  confirmed: z.literal(true),
});
export const wmsStocktakeCommandInput = z.strictObject({
  client_key: uuid,
  version,
  note: text(500).min(3),
});
export const wmsStocktakePageQuery = z.strictObject({
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const wmsStocktakeListQuery = wmsStocktakePageQuery.extend({
  warehouse_id: uuid.optional(),
});
export type WmsStocktakeFragment = {
  layer_id: string | null;
  quantity: number;
  delta: number;
  unit_cost_minor: string | null;
  currency: string;
};
export type WmsStocktakeApplyRow = {
  line_id: string;
  product_id: string;
  location: string;
  lot: { id: string | null; lot_code: string; expiry_date: string | null };
  before_quantity: number;
  after_quantity: number;
  fragments: WmsStocktakeFragment[];
};
