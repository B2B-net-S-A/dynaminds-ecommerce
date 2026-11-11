import { z } from 'zod';
import type { Actor, AuditActor } from './domain';

export const WMS_LOT_LIMITS = {
  lines: 500,
  physical_rows: 10000,
  page: 50,
  request_bytes: 2 * 1024 * 1024,
  response_bytes: 5 * 1024 * 1024,
  evidence_bytes: 128 * 1024 * 1024,
  previews: 2000,
  operations: 100000,
  layers: 100000,
  preview_ttl_minutes: 15,
} as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
const clean = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .refine(
      (v) => !v.includes('\0') && Buffer.from(v, 'utf8').toString('utf8') === v,
      'Tekst musi być poprawnym Unicode bez NUL',
    );
export const wmsDecimal = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n, 'Przekroczono int64');
const version = wmsDecimal.refine((v) => BigInt(v) > 0n, 'Wersja musi być dodatnia');
const currency = z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']);
const location = clean(80)
  .min(1)
  .refine(
    (v) => !/[\u0000-\u001f\u007f]/.test(v),
    'Lokalizacja nie może zawierać znaków sterujących',
  );
const note = clean(1000).min(3);
const quantity = z.number().int().min(1).max(1000000);
export const wmsStockVersion = z.strictObject({
  warehouse_id: uuid,
  product_id: uuid,
  version: wmsDecimal,
});
export const wmsReceiptLine = z.strictObject({
  product_id: uuid,
  location,
  quantity,
  lot_code: clean(100).min(1),
  unit_cost_minor: wmsDecimal,
  currency,
  expiry_date: z.iso.date().nullable().optional(),
});
export const wmsOpeningInput = z.strictObject({
  client_key: uuid,
  policy_version: wmsDecimal,
  currency,
  note,
  lines: z
    .array(
      z.strictObject({
        warehouse_id: uuid,
        product_id: uuid,
        location,
        quantity: z.number().int().min(1).max(2147483647),
        stock_version: wmsDecimal,
        lot_code: clean(100).min(1),
        unit_cost_minor: wmsDecimal.nullable(),
      }),
    )
    .max(WMS_LOT_LIMITS.physical_rows),
});
export const wmsActivateInput = z.strictObject({
  client_key: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  ack_unknown_costs: z.boolean().default(false),
});
export const wmsReceiveInput = z.strictObject({
  client_key: uuid,
  policy_version: version,
  warehouse_id: uuid,
  stock_versions: z.array(wmsStockVersion).min(1).max(WMS_LOT_LIMITS.lines),
  lines: z.array(wmsReceiptLine).min(1).max(WMS_LOT_LIMITS.lines),
  warehouse_document_id: uuid.optional(),
  purchase_receipt_id: uuid.optional(),
  note,
  confirmed: z.literal(true),
});
export const wmsMovementInput = z
  .strictObject({
    client_key: uuid,
    policy_version: version,
    kind: z.enum(['issue', 'transfer', 'bin_move', 'adjustment']),
    product_id: uuid,
    warehouse_id: uuid,
    location,
    destination_warehouse_id: uuid.optional(),
    destination_location: location.optional(),
    quantity: z
      .number()
      .int()
      .min(-1000000)
      .max(1000000)
      .refine((v) => v !== 0),
    stock_versions: z.array(wmsStockVersion).min(1).max(2),
    layer_ids: z.array(uuid).min(1).max(WMS_LOT_LIMITS.physical_rows).optional(),
    unit_cost_minor: wmsDecimal.optional(),
    currency: currency.optional(),
    lot_code: clean(100).min(1).optional(),
    warehouse_document_id: uuid.optional(),
    note,
  })
  .superRefine((v, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.kind !== 'adjustment' && v.quantity <= 0) bad('Ruch wymaga dodatniej ilości');
    if (
      v.kind === 'transfer' &&
      (!v.destination_warehouse_id ||
        v.destination_warehouse_id === v.warehouse_id ||
        !v.destination_location)
    )
      bad('MM wymaga innego magazynu i lokalizacji docelowej');
    if (
      v.kind === 'bin_move' &&
      (v.destination_warehouse_id ||
        !v.destination_location ||
        v.destination_location === v.location)
    )
      bad('Ruch bin wymaga innej lokalizacji w tym samym magazynie');
    if (
      ['issue', 'adjustment'].includes(v.kind) &&
      (v.destination_warehouse_id || v.destination_location)
    )
      bad('Ten ruch nie ma lokalizacji docelowej');
    if (
      v.kind === 'adjustment' &&
      v.quantity > 0 &&
      (v.unit_cost_minor === undefined || !v.currency || !v.lot_code)
    )
      bad('Dodatnia korekta wymaga jawnego kosztu, waluty i kodu partii');
    if (v.kind === 'adjustment' && v.quantity < 0 && !v.layer_ids)
      bad('Ujemna korekta wymaga jawnego wyboru warstw');
  });
export const wmsExecuteInput = z.strictObject({
  client_key: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
export const wmsReturnInput = z.strictObject({
  client_key: uuid,
  policy_version: version,
  return_id: uuid,
  warehouse_id: uuid,
  stock_versions: z.array(wmsStockVersion).min(1).max(WMS_LOT_LIMITS.lines),
  picks: z
    .array(z.strictObject({ issue_fragment_id: uuid, quantity, location }))
    .min(1)
    .max(WMS_LOT_LIMITS.physical_rows),
  note,
  confirmed: z.literal(true),
});
export const wmsPageQuery = z.strictObject({ cursor: z.string().max(2000).optional() });
export const wmsOperationQuery = wmsPageQuery.extend({ order_id: uuid.optional() });
export const wmsPositionsQuery = wmsPageQuery.extend({
  warehouse_id: uuid.optional(),
  product_id: uuid.optional(),
  lot_id: uuid.optional(),
});
export const wmsValuationQuery = z.strictObject({
  warehouse_id: uuid.optional(),
  product_id: uuid.optional(),
});
export const WMS_VALUATION_WAREHOUSE_LIMIT = 200;
/** Physical holdings at one database snapshot, not a return/COGS attribution. */
export type WmsValuationTotals = {
  quantity: string; totalquantity: string; physical_quantity: string;
  reserved_quantity: string; physical_available: string;
  sellable_quantity: string; sellable_available: string;
  known_minor: string; unknown_quantity: string; known_quantity: string;
  zero_cost_quantity: string; currency: string; exponent: number;
};
export type WmsPhysicalValuation = WmsValuationTotals & {
  snapshot_at: string; warehouse_policy_available: boolean;
  warehouses: Array<{ warehouse_id: string; name: string; code: string;
    policy: { usage: 'sale' | 'custody'; enabled: boolean; version: string };
    valuation: WmsValuationTotals }>;
  usage_buckets: Array<{ usage: 'sale' | 'custody'; valuation: WmsValuationTotals }>;
};
export type WmsActor = (Actor | AuditActor) & {
  apiKeyId?: string;
  source?: 'manual' | 'api' | 'system';
};
export type WmsReceiptLine = z.infer<typeof wmsReceiptLine>;
export type WmsStockVersion = z.infer<typeof wmsStockVersion>;
export type WmsPick = { layer_id: string; location: string; quantity: number };
/** Existing owner/product/stock/bin locks are acquired by the root caller before these helpers. */
export type WmsOperationContext = {
  client_key: string;
  kind: string;
  policy_version?: string;
  request: unknown;
  operation_id?: string;
  order_id?: string;
  warehouse_document_id?: string;
  purchase_receipt_id?: string;
  return_id?: string;
  source?: 'manual' | 'api' | 'system';
};
