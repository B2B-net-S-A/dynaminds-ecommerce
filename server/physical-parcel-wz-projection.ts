/** Pure proposed physical_item_components_v1 projection. NOT_APPLIED: no IAM,
 * SQL admission, receipt, movement or migration. The future native producer must
 * supply genuinely scoped frozen plan/order_items/reservations and real dispatch
 * rows. Explicit logistics attribution is not a commercial sale-unit origin.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PHYSICAL_WZ_LIMITS = { bytes: 4 * 1024 * 1024, items: 500, parcels: 50, entries: 5000, count: 1_000_000_000 } as const;
export class PhysicalWzProjectionError extends Error {
  constructor(public readonly status: 409 | 413 | 422, public readonly reason: string) { super(reason); }
}
function fail(status: 409 | 413 | 422, reason: string): never { throw new PhysicalWzProjectionError(status, reason); }
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const count = z.number().int().min(1).max(PHYSICAL_WZ_LIMITS.count);
const nonnegative = z.number().int().min(0).max(PHYSICAL_WZ_LIMITS.count);
const sourceCount = z.number().int().min(1).max(1_000_000);
const physical = z.strictObject({ product_id: uuid, warehouse_id: uuid, quantity: count });
const component = z.strictObject({ product_id: uuid, quantity: sourceCount });
const item = z.strictObject({ item_id: uuid, product_id: uuid, name: z.string().min(1).max(1000), sku: z.string().min(1).max(1000), quantity: sourceCount,
  line_total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), vat: z.number().int().min(0).max(100), currency: z.string().regex(/^[A-Z]{3}$/),
  components: z.array(component).max(500) });
const reservation = z.strictObject({ product_id: uuid, warehouse_id: uuid, quantity: count, consumed_quantity: nonnegative, state: z.enum(['active', 'consumed']) });
const parcel = z.strictObject({ parcel_index: z.number().int().min(0).max(49), shipment_id: uuid, products: z.array(physical).min(1).max(500) });
const mapping = z.strictObject({ parcel_index: z.number().int().min(0).max(49), shipment_id: uuid,
  components: z.array(z.strictObject({ item_id: uuid, product_id: uuid, quantity: count })).min(1).max(PHYSICAL_WZ_LIMITS.entries) });
const progress = z.strictObject({ parcel_index: z.number().int().min(0).max(49), shipment_id: uuid, state: z.enum(['pending', 'dispatched', 'cancelled']),
  dispatch_id: uuid.nullable(), issued_products: z.array(physical).max(500) });
export const physicalParcelWzInput = z.strictObject({ tenant_id: uuid, order_id: uuid, plan_id: uuid,
  plan_scope_hash: z.string().regex(/^[a-f0-9]{64}$/), currency: z.string().regex(/^[A-Z]{3}$/),
  items: z.array(item).min(1).max(PHYSICAL_WZ_LIMITS.items), reservations: z.array(reservation).min(1).max(500),
  parcels: z.array(parcel).min(2).max(PHYSICAL_WZ_LIMITS.parcels), allocation: z.array(mapping).min(2).max(PHYSICAL_WZ_LIMITS.parcels),
  progress: z.array(progress).min(2).max(PHYSICAL_WZ_LIMITS.parcels) });
export type PhysicalParcelWzInput = z.infer<typeof physicalParcelWzInput>;
export type PhysicalWzLine = {
  lineage_kind: 'physical_item_components_v1'; item_id: string; product_id: string; name: string; sku: string;
  original_quantity: number; line_total: number; vat: number; currency: string;
  components: { product_id: string; quantity: number }[];
  component_quantities: { product_id: string; quantity: number }[];
};
export type PhysicalParcelWzProjection = {
  state: 'pending' | 'already_dispatched'; prior_dispatch_id: string | null;
  lineage_kind: 'physical_item_components_v1'; tenant_id: string; order_id: string; plan_id: string; plan_scope_hash: string;
  parcel_index: number; shipment_id: string; projection_sha256: string;
  // Hash codec is intentionally NOT PostgreSQL jsonb::text/native scope hash.
  projection_hash_codec: 'physical_item_components_v1/canonical-json'; commercial_lines: PhysicalWzLine[];
};
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const key = (...ids: string[]) => ids.join('/');
function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
function unique<T>(rows: T[], getKey: (row: T) => string, reason: string) {
  const out = new Map<string, T>();
  for (const row of rows) { const k = getKey(row); if (out.has(k)) fail(422, reason); out.set(k, row); }
  return out;
}
function add(out: Map<string, bigint>, k: string, n: bigint) {
  const total = (out.get(k) ?? 0n) + n;
  if (n <= 0n || total > BigInt(PHYSICAL_WZ_LIMITS.count)) fail(413, 'physical_quantity_budget');
  out.set(k, total);
}
function equalCounts(a: Map<string, bigint>, b: Map<string, bigint>, reason: string) {
  if (a.size !== b.size || [...a].some(([k, n]) => b.get(k) !== n)) fail(409, reason);
}
function products(rows: z.infer<typeof physical>[]) {
  unique(rows, r => key(r.warehouse_id, r.product_id), 'duplicate_physical_product');
  return new Map(rows.map(r => [key(r.warehouse_id, r.product_id), BigInt(r.quantity)]));
}
/** Validates the COMPLETE explicit map on every invocation, including prior
 * parcels. Current consumed quantities are a progress check, never the immutable
 * mapping/hash basis. Deliberately no current order status/version equality.
 * Already-dispatched result is a replay directive: do not admit/number/write.
 */
export function projectPhysicalParcelWz(raw: unknown, selectedParcelIndex: number): PhysicalParcelWzProjection {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(raw); } catch { fail(422, 'invalid_json_input'); }
  if (serialized === undefined) fail(422, 'invalid_json_input');
  if (Buffer.byteLength(serialized, 'utf8') > PHYSICAL_WZ_LIMITS.bytes) fail(413, 'snapshot_byte_budget');
  const parsed = physicalParcelWzInput.safeParse(raw);
  if (!parsed.success) fail(422, 'invalid_projection_input');
  const b = parsed.data;
  if (!Number.isSafeInteger(selectedParcelIndex) || selectedParcelIndex < 0 || selectedParcelIndex >= b.parcels.length) fail(422, 'invalid_selected_parcel');
  if (b.allocation.reduce((n, r) => n + r.components.length, 0) > PHYSICAL_WZ_LIMITS.entries || b.parcels.reduce((n, r) => n + r.products.length, 0) > 500) fail(413, 'mapping_entry_budget');
  const items = unique(b.items, r => r.item_id, 'duplicate_historical_item');
  const parcels = unique(b.parcels, r => String(r.parcel_index), 'duplicate_parcel');
  unique(b.parcels, r => r.shipment_id, 'duplicate_shipment');
  const mappings = unique(b.allocation, r => String(r.parcel_index), 'duplicate_mapping_parcel');
  const states = unique(b.progress, r => String(r.parcel_index), 'duplicate_progress_parcel');
  if (mappings.size !== parcels.size || states.size !== parcels.size) fail(409, 'incomplete_parcel_scope');
  const expectedItems = new Map<string, bigint>(), expectedProducts = new Map<string, bigint>();
  const canonicalItems = [...items.values()].sort((a, c) => cmp(a.item_id, c.item_id)).map(r => {
    if (r.currency !== b.currency) fail(409, 'historical_currency_mismatch');
    const recipe = r.components.length ? r.components : [{ product_id: r.product_id, quantity: 1 }];
    unique(recipe, c => c.product_id, 'duplicate_historical_component');
    const components = [...recipe].sort((a, c) => cmp(a.product_id, c.product_id));
    for (const c of components) { const n = BigInt(r.quantity) * BigInt(c.quantity); add(expectedItems, key(r.item_id, c.product_id), n); add(expectedProducts, c.product_id, n); }
    return { ...r, components };
  });
  const reservationRows = unique(b.reservations, r => key(r.warehouse_id, r.product_id), 'duplicate_reservation');
  const reservedProducts = new Map<string, bigint>(), reserved = new Map<string, bigint>(), consumed = new Map<string, bigint>();
  for (const r of reservationRows.values()) {
    if (r.consumed_quantity > r.quantity || (r.state === 'consumed' ? r.consumed_quantity !== r.quantity : r.consumed_quantity >= r.quantity)) fail(409, 'invalid_reservation_progress');
    add(reservedProducts, r.product_id, BigInt(r.quantity)); add(reserved, key(r.warehouse_id, r.product_id), BigInt(r.quantity));
    if (r.consumed_quantity) add(consumed, key(r.warehouse_id, r.product_id), BigInt(r.consumed_quantity));
  }
  equalCounts(expectedProducts, reservedProducts, 'historical_reservation_mismatch');
  const allocatedItems = new Map<string, bigint>(), allocatedPhysical = new Map<string, bigint>(), issued = new Map<string, bigint>();
  const dispatchIds = new Set<string>();
  const canonicalParcels = [...parcels.values()].sort((a, c) => a.parcel_index - c.parcel_index).map((p, idx) => {
    if (p.parcel_index !== idx) fail(409, 'noncontiguous_parcels');
    const m = mappings.get(String(idx)), s = states.get(String(idx));
    if (!m || !s || m.shipment_id !== p.shipment_id || s.shipment_id !== p.shipment_id) fail(409, 'parcel_identity_mismatch');
    if (s.state === 'cancelled') fail(409, 'cancelled_physical_scope_unsupported');
    const actual = products(p.products), mappingProducts = new Map<string, bigint>();
    unique(m.components, r => key(r.item_id, r.product_id), 'duplicate_mapping_component');
    for (const c of m.components) {
      if (!expectedItems.has(key(c.item_id, c.product_id))) fail(409, 'unknown_historical_component');
      add(allocatedItems, key(c.item_id, c.product_id), BigInt(c.quantity)); add(mappingProducts, c.product_id, BigInt(c.quantity));
    }
    const parcelProductCounts = new Map<string, bigint>();
    for (const r of p.products) { add(parcelProductCounts, r.product_id, BigInt(r.quantity)); add(allocatedPhysical, key(r.warehouse_id, r.product_id), BigInt(r.quantity)); }
    equalCounts(parcelProductCounts, mappingProducts, 'parcel_product_mismatch');
    if (s.state === 'pending') { if (s.dispatch_id !== null || s.issued_products.length) fail(409, 'unexpected_pending_issue'); }
    else {
      if (!s.dispatch_id || dispatchIds.has(s.dispatch_id)) fail(409, 'invalid_dispatch_identity'); dispatchIds.add(s.dispatch_id);
      equalCounts(actual, products(s.issued_products), 'prior_dispatch_product_mismatch');
      for (const [k, n] of actual) add(issued, k, n);
    }
    return { parcel_index: idx, shipment_id: p.shipment_id, products: [...p.products].sort((a, c) => cmp(key(a.warehouse_id, a.product_id), key(c.warehouse_id, c.product_id))),
      components: [...m.components].sort((a, c) => cmp(key(a.item_id, a.product_id), key(c.item_id, c.product_id))) };
  });
  equalCounts(expectedItems, allocatedItems, 'historical_item_component_mismatch');
  equalCounts(reserved, allocatedPhysical, 'plan_reservation_mismatch');
  equalCounts(consumed, issued, 'consumed_dispatch_mismatch');
  const basis = { lineage_kind: 'physical_item_components_v1', tenant_id: b.tenant_id, order_id: b.order_id, plan_id: b.plan_id, plan_scope_hash: b.plan_scope_hash, currency: b.currency,
    items: canonicalItems, reservations: [...reservationRows.values()].map(({ consumed_quantity: _c, state: _s, ...r }) => r).sort((a, c) => cmp(key(a.warehouse_id, a.product_id), key(c.warehouse_id, c.product_id))), parcels: canonicalParcels };
  const selected = canonicalParcels[selectedParcelIndex]!, state = states.get(String(selectedParcelIndex))!;
  const commercial_lines: PhysicalWzLine[] = state.state === 'dispatched' ? [] : canonicalItems.flatMap(({ quantity, ...r }) => {
    const counts = selected.components.filter(c => c.item_id === r.item_id).map(({ product_id, quantity }) => ({ product_id, quantity }));
    return counts.length ? [{ lineage_kind: 'physical_item_components_v1' as const, ...r, original_quantity: quantity, component_quantities: counts }] : [];
  });
  return immutable({ state: state.state === 'dispatched' ? 'already_dispatched' : 'pending', prior_dispatch_id: state.dispatch_id,
    lineage_kind: 'physical_item_components_v1', tenant_id: b.tenant_id, order_id: b.order_id, plan_id: b.plan_id, plan_scope_hash: b.plan_scope_hash,
    parcel_index: selected.parcel_index, shipment_id: selected.shipment_id, projection_sha256: createHash('sha256').update(JSON.stringify(basis)).digest('hex'),
    projection_hash_codec: 'physical_item_components_v1/canonical-json', commercial_lines });
}
