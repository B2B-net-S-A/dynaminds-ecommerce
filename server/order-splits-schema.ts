import { z } from 'zod';

/** Local initial-v1 budgets, not Base limits or evidence of a registered feature. */
export const ORDER_SPLIT_LIMITS = Object.freeze({
  results: 100,
  source_lines: 10000,
  allocation_rows: 10000,
  quantity: 100000,
  product_units: 10000000,
  money_minor: 2147483647,
  unit_price_minor: 100000000,
  delivery_minor: 1000000,
  request_bytes: 1048576,
  source_bytes: 8388608,
  output_bytes: 16777216,
});
export const orderSplitUuid = z.uuid().transform(v => v.toLowerCase());
export const orderSplitVersion = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(v => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
const minor = z.number().int().min(0).max(ORDER_SPLIT_LIMITS.money_minor);
const quantity = z.number().int().min(1).max(ORDER_SPLIT_LIMITS.quantity);
const count = z.number().int().min(0).max(2147483647);
const vat = z.union([z.literal(0), z.literal(5), z.literal(8), z.literal(23)]);
const currency = z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']);
const paymentMode = z.enum(['prepaid', 'cod']);
const allocation = z.strictObject({ source_item_id: orderSplitUuid, quantity });
const child = z.strictObject({
  // Slot identity is user intent, not a future order ID or a trusted admission.
  slot_id: orderSplitUuid,
  name: z.string().min(1).max(120).refine(v => v.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(v)),
  delivery_minor: z.number().int().min(0).max(ORDER_SPLIT_LIMITS.delivery_minor),
  items: z.array(allocation).min(1).max(ORDER_SPLIT_LIMITS.allocation_rows),
});
export const orderSplitPreviewInput = z.strictObject({
  client_key: orderSplitUuid,
  source_order_id: orderSplitUuid,
  expected_source_version: orderSplitVersion,
  children: z.array(child).min(1).max(ORDER_SPLIT_LIMITS.results - 1),
}).superRefine((v, ctx) => {
  if (new Set(v.children.map(c => c.slot_id)).size !== v.children.length)
    ctx.addIssue({ code: 'custom', message: 'Powtórzona tożsamość wyniku podziału' });
  if (v.children.reduce((n, c) => n + c.items.length, 0) > ORDER_SPLIT_LIMITS.allocation_rows)
    ctx.addIssue({ code: 'custom', message: 'Za dużo przydziałów podziału' });
  for (const c of v.children)
    if (new Set(c.items.map(i => i.source_item_id)).size !== c.items.length)
      ctx.addIssue({ code: 'custom', message: 'Powtórzona pozycja źródłowa w jednym wyniku' });
});
export const orderSplitExecuteInput = z.strictObject({
  client_key: orderSplitUuid,
  preview_id: orderSplitUuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});

/** Complete plain projection required from a future current-TX capture. JSON is
 * never proof that these facts are current, complete, owned or Native-authorized. */
export const orderSplitSourceFrame = z.strictObject({
  schema: z.literal('order-split-source/v1'),
  order: z.strictObject({
    id: orderSplitUuid,
    tenant_id: orderSplitUuid,
    version: orderSplitVersion,
    source: z.string().min(1).max(30),
    fulfillment_kind: z.enum(['sale', 'replacement']),
    status: z.string().min(1).max(30),
    warehouse_id: orderSplitUuid,
    currency,
    payment_mode: paymentMode,
    shipping_cost: z.number().int().min(0).max(ORDER_SPLIT_LIMITS.delivery_minor),
    total: minor,
    channel_id: orderSplitUuid.nullable(),
    external_id: z.string().max(500).nullable(),
    b2b_account_id: orderSplitUuid.nullable(),
    unsupported_business_fields: z.boolean(),
  }),
  items: z.array(z.strictObject({
    id: orderSplitUuid,
    order_id: orderSplitUuid,
    product_id: orderSplitUuid,
    product_kind: z.enum(['simple', 'variant', 'bundle', 'group']),
    quantity,
    price: z.number().int().min(0).max(ORDER_SPLIT_LIMITS.unit_price_minor),
    vat,
    line_total: minor,
    // Optional EXPLICIT historical discount fact. A custom line_total alone is
    // not evidence that its difference from price*quantity was a named discount.
    discount_gross_minor: minor.optional(),
    // Frozen ORDER item physical recipe (domain.createOrder), not the catalogue
    // bundle definition. Even a simple order line stores one self-product unit.
    components: z.array(z.strictObject({ product_id: orderSplitUuid, quantity })).max(100),
    scanned: count,
    consumed_quantity: count,
    released_quantity: count,
  })).min(1).max(ORDER_SPLIT_LIMITS.source_lines),
  financial: z.strictObject({
    payment_entries: count,
    //024 audit rows, including unchanged/blocked checks; not an invented ledger.
    source_payment_checks: count,
    import_allocations: count,
    payment_import_receipts: count,
    source_payment_jobs: count,
    // Durable077 execution selections exist before their worker creates entries.
    payment_import_attempts: count,
    balance: z.strictObject({
      currency, payment_mode: paymentMode,
      received: minor, refunded: minor, credit: minor,
      return_credit: minor, cancelled_credit: minor,
      net: z.number().int().min(-2147483647).max(2147483647),
      overpayment: minor, collected: minor, remitted: minor, fees: minor,
      courier_due: z.number().int().min(-2147483647).max(2147483647),
      nominal: minor, amount_due: minor,
    }),
  }),
  blockers: z.strictObject({
    documents: count, invoice_plans: count, corrections: count,
    returns: count, exchanges: count, shipments: count,
    provider_attempts: count, parcel_plans: count,
    active_picking_waves: count, active_packing_sessions: count,
    merge_lineage: count, split_lineage: count,
    external_intents: count,
    non_active_reservations: count,
    physical_scans: count, consumed_quantity: count, released_quantity: count,
  }),
});
export type OrderSplitPreviewInput = z.infer<typeof orderSplitPreviewInput>;
export type OrderSplitExecuteInput = z.infer<typeof orderSplitExecuteInput>;
export type OrderSplitSourceFrame = z.infer<typeof orderSplitSourceFrame>;
