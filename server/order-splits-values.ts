/** Pure proposed allocation, no DB/IAM/Native, ledger copy, IDs, hashes or writes.
 * All facts must later be recaptured under the real source/order/custody locks. */
import { localInvoiceLineAmounts } from './local-invoice-values';
import {
  ORDER_SPLIT_LIMITS as L, orderSplitPreviewInput, orderSplitSourceFrame,
  type OrderSplitSourceFrame,
} from './order-splits-schema';

export class OrderSplitError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'OrderSplitError'; }
}
function requireFact(v: unknown, code: string): asserts v { if (!v) throw new OrderSplitError(code); }
function bytes(v: unknown, max: number, code: string) {
  let text: string | undefined;
  try { text = JSON.stringify(v); } catch { throw new OrderSplitError(code); }
  requireFact(text !== undefined && Buffer.byteLength(text) <= max, code);
}
function frozen<T>(v: T): T {
  if (v && typeof v === 'object') { for (const x of Object.values(v)) frozen(x); Object.freeze(v); }
  return v;
}
function number(v: bigint): number {
  requireFact(v >= 0n && v <= BigInt(L.money_minor), 'MONEY_OVERFLOW'); return Number(v);
}
function adjustment(v: bigint): number {
  const maxNominal = BigInt(L.unit_price_minor) * BigInt(L.quantity);
  requireFact(v >= -maxNominal && v <= BigInt(L.money_minor) && Number.isSafeInteger(Number(v)), 'MONEY_OVERFLOW');
  return Number(v);
}
type Money = { gross_minor: number; net_minor: number; vat_minor: number };
type Provenance = {
  source_order_id: string; source_version: string; source_item_id: string;
  original_quantity: number; original_price: number; original_vat: number;
  original_amounts: Money;
  original_discount_gross_minor: number | null;
  original_price_adjustment_minor: number;
};
type AllocatedLine = Money & {
  source_item_id: string; product_id: string; quantity: number; price: number; vat: number;
  from_quantity: number; to_quantity: number; provenance: Provenance;
  discount_gross_minor: number | null;
  price_adjustment_minor: number;
};
type Totals = { items_gross_minor: number; items_net_minor: number; items_vat_minor: number; delivery_minor: number; total_minor: number };
type Result = { kind: 'child' | 'retained_source'; slot_id: string | null; name: string | null; source_order_id: string; items: AllocatedLine[]; totals: Totals };
export type OrderSplitVatConflict = {
  code: 'VAT_ROUNDING_CONFLICT'; slot_id: string | null; source_item_id: string;
  allocated: Money; current_invoice_amounts: Money;
};
export type OrderSplitLineRoundingConflict = {
  code: 'INVOICE_LINE_ROUNDING_CONFLICT'; slot_id: string | null; source_item_id: string;
  price: number; quantity: number; gross_minor: number; price_adjustment_minor: number;
  current_invoice_rule: 'gross_minus_unit_times_quantity_lt_quantity';
};
const invoiceMoney = (gross: number, rate: number): Money => {
  const value = localInvoiceLineAmounts(BigInt(gross), rate);
  return { gross_minor: number(BigInt(value.gross_minor)), net_minor: number(BigInt(value.net_minor)), vat_minor: number(BigInt(value.vat_minor)) };
};
function preconditions(s: OrderSplitSourceFrame) {
  const o = s.order;
  requireFact(o.source === 'manual' && o.fulfillment_kind === 'sale' && o.status === 'new', 'UNSUPPORTED_SOURCE_HEADER');
  requireFact(o.channel_id === null && o.external_id === null && o.b2b_account_id === null && !o.unsupported_business_fields, 'UNSUPPORTED_SOURCE_BINDING');
  requireFact(Object.values(s.blockers).every(n => n === 0), 'SOURCE_HISTORY_OR_PARTIAL_FULFILLMENT');
  // Counts cover actual077 queued intent and024 non-mutating checks, even at net zero.
  const { balance, ...history } = s.financial;
  requireFact(Object.values(history).every(n => n === 0), 'FINANCIAL_HISTORY_UNSUPPORTED');
  requireFact(balance.currency === o.currency && balance.payment_mode === o.payment_mode, 'FINANCIAL_HEADER_MISMATCH');
  for (const k of ['received', 'refunded', 'credit', 'return_credit', 'cancelled_credit', 'net', 'overpayment', 'collected', 'remitted', 'fees', 'courier_due'] as const)
    requireFact(balance[k] === 0, 'UNPAID_FRAME_REQUIRED');
  requireFact(balance.nominal === o.total && balance.amount_due === o.total, 'UNPAID_FRAME_REQUIRED');
}

/** Canonical ordering is slot UUID, then source line UUID, then the source
 * remainder LAST. The request's original names/IDs are preserved without trim.
 * Gross uses cumulative quantity FLOOR deltas. Net uses cumulative allocated
 * gross FLOOR deltas, so even historical sub-unit gross fragments cannot yield
 * negative VAT/net or net greater than gross. Both conserve the source line. They
 * are a local proposed invariant, not a Base rounding or invoice acceptance.
 * Shipping is explicit gross cents only: an order has no frozen shipping VAT
 * rate; these item tax totals do not pretend to allocate shipping tax. */
export function calculateOrderSplit(sourceInput: unknown, requestInput: unknown) {
  bytes(requestInput, L.request_bytes, 'REQUEST_BYTES'); bytes(sourceInput, L.source_bytes, 'SOURCE_BYTES');
  const requestParsed = orderSplitPreviewInput.safeParse(requestInput), sourceParsed = orderSplitSourceFrame.safeParse(sourceInput);
  requireFact(requestParsed.success, 'INVALID_REQUEST'); requireFact(sourceParsed.success, 'INVALID_SOURCE');
  const s = sourceParsed.data, request = requestParsed.data, o = s.order;
  requireFact(request.source_order_id === o.id && request.expected_source_version === o.version, 'SOURCE_ID_OR_VERSION_MISMATCH');
  preconditions(s);
  const children = [...request.children].sort((a, b) => a.slot_id < b.slot_id ? -1 : a.slot_id > b.slot_id ? 1 : 0);
  const childQuantities = children.map(c => new Map(c.items.map(i => [i.source_item_id, i.quantity])));
  const items = [...s.items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sources = new Map(items.map(i => [i.id, i]));
  requireFact(sources.size === items.length, 'DUPLICATE_SOURCE_ITEM');
  let gross = 0n;
  const physical = new Map<string, bigint>();
  for (const i of items) {
    requireFact(i.order_id === o.id, 'FOREIGN_SOURCE_ITEM');
    requireFact(i.product_kind === 'simple', 'UNSUPPORTED_PRODUCT_KIND');
    requireFact(i.components.length === 1 && i.components[0].product_id === i.product_id && i.components[0].quantity === 1, 'UNSUPPORTED_PRODUCT_RECIPE');
    requireFact(i.scanned === 0 && i.consumed_quantity === 0 && i.released_quantity === 0, 'SOURCE_HISTORY_OR_PARTIAL_FULFILLMENT');
    if (i.discount_gross_minor !== undefined)
      requireFact(BigInt(i.price) * BigInt(i.quantity) - BigInt(i.discount_gross_minor) === BigInt(i.line_total), 'EXPLICIT_DISCOUNT_MISMATCH');
    gross += BigInt(i.line_total);
    physical.set(i.product_id, (physical.get(i.product_id) ?? 0n) + BigInt(i.quantity));
  }
  requireFact([...physical.values()].every(q => q <= BigInt(L.product_units)), 'PRODUCT_QUANTITY_OVERFLOW');
  requireFact(gross + BigInt(o.shipping_cost) === BigInt(o.total), 'SOURCE_TOTAL_MISMATCH');
  number(gross + BigInt(o.shipping_cost));
  const moved = new Map<string, number>();
  for (const c of children) for (const i of c.items) {
    const original = sources.get(i.source_item_id); requireFact(original, 'UNKNOWN_SOURCE_ITEM');
    const q = (moved.get(i.source_item_id) ?? 0) + i.quantity;
    requireFact(q <= original.quantity, 'OVER_ALLOCATION'); moved.set(i.source_item_id, q);
  }
  requireFact(items.some(i => i.quantity > (moved.get(i.id) ?? 0)), 'EMPTY_RETAINED_SOURCE');
  requireFact(children.reduce((n, c) => n + c.items.length, 0) + items.filter(i => i.quantity > (moved.get(i.id) ?? 0)).length <= L.allocation_rows, 'ALLOCATION_ROW_BOUND');
  const shipping = children.reduce((n, c) => n + BigInt(c.delivery_minor), 0n);
  requireFact(shipping <= BigInt(o.shipping_cost), 'DELIVERY_OVER_ALLOCATION');
  const results: Result[] = children.map(c => ({kind: 'child', slot_id: c.slot_id, name: c.name, source_order_id: o.id, items: [], totals: {items_gross_minor: 0, items_net_minor: 0, items_vat_minor: 0, delivery_minor: c.delivery_minor, total_minor: 0}}));
  results.push({kind: 'retained_source', slot_id: null, name: null, source_order_id: o.id, items: [], totals: {items_gross_minor: 0, items_net_minor: 0, items_vat_minor: 0, delivery_minor: number(BigInt(o.shipping_cost) - shipping), total_minor: 0}});
  const blockers: (OrderSplitVatConflict | OrderSplitLineRoundingConflict)[] = [];
  let rowCount = 0;
  for (const i of items) {
    const original = invoiceMoney(i.line_total, i.vat), q = BigInt(i.quantity);
    const nominal = BigInt(i.price) * q;
    const provenance: Provenance = { source_order_id: o.id, source_version: o.version, source_item_id: i.id, original_quantity: i.quantity, original_price: i.price, original_vat: i.vat, original_amounts: original, original_discount_gross_minor: i.discount_gross_minor ?? null, original_price_adjustment_minor: adjustment(BigInt(i.line_total) - nominal) };
    let end = 0n;
    let allocatedDiscount = 0n;
    let allocatedGross = 0n, allocatedNet = 0n, allocatedVat = 0n;
    for (let index = 0; index < results.length; index++) {
      const quantity = index === children.length ? i.quantity - (moved.get(i.id) ?? 0) : (childQuantities[index].get(i.id) ?? 0);
      if (quantity === 0) continue;
      requireFact(++rowCount <= L.allocation_rows, 'ALLOCATION_ROW_BOUND');
      const start = end; end += BigInt(quantity);
      const grossEnd = BigInt(original.gross_minor) * end / q;
      const grossStart = BigInt(original.gross_minor) * start / q;
      const g = grossEnd - grossStart;
      const n = original.gross_minor === 0 ? 0n :
        BigInt(original.net_minor) * grossEnd / BigInt(original.gross_minor) - BigInt(original.net_minor) * grossStart / BigInt(original.gross_minor);
      const amounts = {gross_minor: number(g), net_minor: number(n), vat_minor: number(g - n)};
      allocatedGross += g; allocatedNet += n; allocatedVat += g - n;
      const r = results[index];
      const priceAdjustment = g - BigInt(i.price) * BigInt(quantity);
      const discount = i.discount_gross_minor === undefined ? null : number(-priceAdjustment);
      if (discount !== null) allocatedDiscount += BigInt(discount);
      r.items.push({...amounts, source_item_id: i.id, product_id: i.product_id, quantity, price: i.price, vat: i.vat, from_quantity: Number(start), to_quantity: Number(end), provenance, discount_gross_minor: discount, price_adjustment_minor: adjustment(priceAdjustment)});
      // Source157 also checks the historical commercial-line residual, independently
      // of its VAT helper. Preserve money and expose refusal; never silently reprice.
      if (priceAdjustment >= BigInt(quantity))
        blockers.push({code: 'INVOICE_LINE_ROUNDING_CONFLICT', slot_id: r.slot_id, source_item_id: i.id, price: i.price, quantity, gross_minor: amounts.gross_minor, price_adjustment_minor: adjustment(priceAdjustment), current_invoice_rule: 'gross_minus_unit_times_quantity_lt_quantity'});
      const invoice = invoiceMoney(amounts.gross_minor, i.vat);
      if (invoice.net_minor !== amounts.net_minor || invoice.vat_minor !== amounts.vat_minor)
        blockers.push({code: 'VAT_ROUNDING_CONFLICT', slot_id: r.slot_id, source_item_id: i.id, allocated: amounts, current_invoice_amounts: invoice});
    }
    requireFact(end === q, 'QUANTITY_CONSERVATION');
    requireFact(allocatedGross === BigInt(original.gross_minor) && allocatedNet === BigInt(original.net_minor) && allocatedVat === BigInt(original.vat_minor), 'LINE_MONEY_CONSERVATION');
    if (i.discount_gross_minor !== undefined) requireFact(allocatedDiscount === BigInt(i.discount_gross_minor), 'DISCOUNT_CONSERVATION');
  }
  for (const r of results) {
    requireFact(r.items.length > 0, 'EMPTY_RESULT');
    for (const [target, key] of [['items_gross_minor', 'gross_minor'], ['items_net_minor', 'net_minor'], ['items_vat_minor', 'vat_minor']] as const)
      r.totals[target] = number(r.items.reduce((n, i) => n + BigInt(i[key]), 0n));
    r.totals.total_minor = number(BigInt(r.totals.items_gross_minor) + BigInt(r.totals.delivery_minor));
  }
  requireFact(results.reduce((n, r) => n + BigInt(r.totals.total_minor), 0n) === BigInt(o.total), 'MONEY_CONSERVATION');
  const value = {
    schema: 'order-split-calculation/v1' as const, ready: blockers.length === 0, blockers,
    source_order_id: o.id, source_version: o.version, tenant_id: o.tenant_id, warehouse_id: o.warehouse_id,
    currency: o.currency, payment_mode: o.payment_mode,
    rounding_method: 'cumulative_source_gross_then_net_by_gross_floor_children_then_remainder/v2' as const,
    financial_scope: 'unpaid_only_no_ledger_copy' as const,
    shipping_tax: 'not_allocated' as const,
    // Normalized UUIDs, not an original transport-body or idempotency hash proof.
    request, results, allocation_rows: rowCount,
    remaining_quantities: items.map(i => ({source_item_id: i.id, original_quantity: i.quantity, moved_quantity: moved.get(i.id) ?? 0, remaining_quantity: i.quantity - (moved.get(i.id) ?? 0)})),
  };
  bytes(value, L.output_bytes, 'OUTPUT_BYTES'); return frozen(value);
}
