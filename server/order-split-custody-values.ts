/** Proposed physical partitions only. No DB, stock write, new ID or admission.
 * Future Native210 must recapture all rows under its real locks and reconstruct
 * this plan. JSON and the deterministic digests are never authority.
 *
 * Capture contract: four complete104 snapshot arrays after134/137 counters;
 * layer_metadata is an explicit join of wms_reservation_layers.layer_id to
 * wms_cost_layers(id,product_id,lot_id,fifo_sequence) and wms_lots.expiry_date.
 * FIFO partitions ALREADY RESERVED cells; it does not reserve available stock,
 * refresh prices, change lots, infer expiry eligibility, or apply FEFO.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { calculateOrderSplit } from './order-splits-values';
import { orderSplitSourceFrame, orderSplitUuid as uuid, ORDER_SPLIT_LIMITS as L } from './order-splits-schema';

export const ORDER_SPLIT_CUSTODY_LIMITS = Object.freeze({ source_rows_per_kind: 10000, planned_rows: 100000, input_bytes: 8388608, output_bytes: 16777216 });
const C = ORDER_SPLIT_CUSTODY_LIMITS;
export class OrderSplitCustodyError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'OrderSplitCustodyError'; }
}
function requireFact(v: unknown, code: string): asserts v { if (!v) throw new OrderSplitCustodyError(code); }
function encoded(v: unknown, cap: number): string {
  let value: string | undefined;
  try { value = JSON.stringify(v); } catch { throw new OrderSplitCustodyError('CUSTODY_BYTES'); }
  requireFact(value !== undefined && Buffer.byteLength(value) <= cap, 'CUSTODY_BYTES'); return value;
}
const quantity = z.number().int().min(1).max(L.product_units), zero = z.literal(0);
const context = { tenant_id: uuid, order_id: uuid, product_id: uuid };
const physical = { ...context, warehouse_id: uuid, quantity, consumed_quantity: zero, released_quantity: zero };
const location = z.string().min(1).max(80).refine(s => s.trim() === s && !/[\x00-\x1f\x7f]/.test(s));
const int64 = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(s => BigInt(s) <= 9223372036854775807n);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => { const v = new Date(s + 'T00:00:00.000Z'); return Number.isFinite(v.getTime()) && v.toISOString().slice(0, 10) === s; });
const reservation = z.strictObject({ ...physical, state: z.literal('active') });
const pick = z.strictObject({ ...context, id: uuid, sku: z.string().max(200), name: z.string().max(1000), ean: z.string().max(200), quantity, scanned: zero });
const bin = z.strictObject({ ...physical, location, scanned: zero });
const layer = z.strictObject({ ...physical, location, layer_id: uuid, state: z.literal('active'), scanned: zero });
const metadata = z.strictObject({ layer_id: uuid, product_id: uuid, lot_id: uuid, fifo_sequence: int64, expiry_date: date.nullable() });
const list = <T extends z.ZodType>(row: T) => z.array(row).max(C.source_rows_per_kind);
export const orderSplitPhysicalSnapshot = z.strictObject({
  schema: z.literal('order-split-physical-source/v1'), tenant_id: uuid, source_order_id: uuid, warehouse_id: uuid,
  wms_enabled: z.boolean(), reservations: list(reservation), picks: list(pick), locations: list(bin), layers: list(layer), layer_metadata: list(metadata),
});
type Snapshot = z.infer<typeof orderSplitPhysicalSnapshot>;
type Reservation = z.infer<typeof reservation>; type Pick = z.infer<typeof pick>;
type Bin = z.infer<typeof bin>; type Layer = z.infer<typeof layer>; type Metadata = z.infer<typeof metadata>;
type ProductQuantity = { product_id: string; quantity: number };
type Target = {
  kind: 'child' | 'retained_source'; slot_id: string | null;
  commercial_items: { source_item_id: string; product_id: string; quantity: number }[];
  reservations: { product_id: string; warehouse_id: string; quantity: number; state: 'active'; consumed_quantity: 0; released_quantity: 0 }[];
  picks: { source_pick_id: string; product_id: string; sku: string; name: string; ean: string; quantity: number; scanned: 0 }[];
  locations: { product_id: string; warehouse_id: string; location: string; quantity: number; scanned: 0; consumed_quantity: 0; released_quantity: 0 }[];
  layers: { product_id: string; warehouse_id: string; location: string; layer_id: string; quantity: number; scanned: 0; state: 'active'; consumed_quantity: 0; released_quantity: 0; lot_id: string; fifo_sequence: string; expiry_date: string | null }[];
};
const cmp = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const cell = (r: { product_id: string; location: string }) => JSON.stringify([r.product_id, r.location]);
const layerCell = (r: { product_id: string; location: string; layer_id: string }) => JSON.stringify([r.product_id, r.layer_id, r.location]);
function unique<T>(rows: T[], key: (r: T) => string, code: string): Map<string, T> {
  const map = new Map(rows.map(r => [key(r), r])); requireFact(map.size === rows.length, code); return map;
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => cmp(a, b)).map(([k, x]) => [k, canonical(x)]));
  return v;
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function frozen<T>(v: T): T { if (v && typeof v === 'object') { for (const child of Object.values(v)) frozen(child); Object.freeze(v); } return v; }
function sum(rows: { quantity: number }[]) { return rows.reduce((n, row) => n + row.quantity, 0); }
function grouped<T extends {product_id: string}>(rows: T[]) {
  const map = new Map<string, T[]>(); for (const row of rows) { const group = map.get(row.product_id) ?? []; group.push(row); map.set(row.product_id, group); } return map;
}

export function calculateOrderSplitCustody(sourceInput: unknown, requestInput: unknown, custodyInput: unknown) {
  encoded(sourceInput, L.source_bytes); encoded(requestInput, L.request_bytes); encoded(custodyInput, C.input_bytes);
  const parsed = orderSplitPhysicalSnapshot.safeParse(custodyInput); requireFact(parsed.success, 'INVALID_PHYSICAL_SOURCE');
  const s: Snapshot = parsed.data, source = orderSplitSourceFrame.parse(sourceInput);
  const calculation = calculateOrderSplit(source, requestInput);
  requireFact(calculation.ready, 'COMMERCIAL_ALLOCATION_NOT_READY');
  const { tenant_id: tenant, source_order_id: order, warehouse_id: warehouse } = s;
  requireFact(tenant === source.order.tenant_id && order === source.order.id && warehouse === source.order.warehouse_id, 'FOREIGN_PHYSICAL_SOURCE');
  const products = new Map<string, number>();
  for (const line of source.items) products.set(line.product_id, (products.get(line.product_id) ?? 0) + line.quantity);
  for (const rows of [s.reservations, s.picks, s.locations, s.layers]) for (const row of rows) {
    requireFact(row.tenant_id === tenant && row.order_id === order && products.has(row.product_id), 'FOREIGN_PHYSICAL_ROW');
    if ('warehouse_id' in row) requireFact(row.warehouse_id === warehouse, 'FOREIGN_PHYSICAL_ROW');
  }
  const reservations = unique<Reservation>(s.reservations, r => r.product_id, 'DUPLICATE_RESERVATION');
  const picks = unique<Pick>(s.picks, r => r.product_id, 'DUPLICATE_PICK');
  unique(s.picks, r => r.id, 'DUPLICATE_PICK_ID');
  unique<Bin>(s.locations, cell, 'DUPLICATE_LOCATION'); unique<Layer>(s.layers, layerCell, 'DUPLICATE_LAYER_CELL');
  const meta = unique<Metadata>(s.layer_metadata, r => r.layer_id, 'DUPLICATE_LAYER_METADATA');
  const lots = new Map<string, {product_id: string; expiry_date: string | null}>();
  for (const row of s.layer_metadata) {
    const previous = lots.get(row.lot_id);
    requireFact(!previous || (previous.product_id === row.product_id && previous.expiry_date === row.expiry_date), 'INCONSISTENT_LOT_METADATA');
    lots.set(row.lot_id, {product_id: row.product_id, expiry_date: row.expiry_date});
  }
  requireFact(reservations.size === products.size && picks.size === products.size, 'INCOMPLETE_PRODUCT_CUSTODY');
  if (!s.wms_enabled) requireFact(s.layers.length === 0 && meta.size === 0, 'WMS_MODE_MISMATCH');
  const usedMeta = new Set<string>();
  for (const row of s.layers) { const m = meta.get(row.layer_id); requireFact(m && m.product_id === row.product_id, 'MISSING_OR_FOREIGN_LAYER_METADATA'); usedMeta.add(row.layer_id); }
  requireFact(usedMeta.size === meta.size, 'UNUSED_LAYER_METADATA');
  const productBins = grouped(s.locations), productLayers = grouped(s.layers), layerTotals = new Map<string, number>();
  for (const row of s.layers) layerTotals.set(cell(row), (layerTotals.get(cell(row)) ?? 0) + row.quantity);
  for (const [product, quantity] of products) {
    requireFact(reservations.get(product)?.quantity === quantity && picks.get(product)?.quantity === quantity, 'PRODUCT_QUANTITY_MISMATCH');
    const bins = productBins.get(product) ?? [], layers = productLayers.get(product) ?? [];
    requireFact(sum(bins) === quantity, 'LOCATION_QUANTITY_MISMATCH');
    if (s.wms_enabled) {
      requireFact(sum(layers) === quantity, 'LAYER_QUANTITY_MISMATCH');
      for (const row of bins) requireFact(layerTotals.get(cell(row)) === row.quantity, 'LAYER_LOCATION_MISMATCH');
      const knownBins = new Set(bins.map(cell)); requireFact(layers.every(r => knownBins.has(cell(r))), 'FOREIGN_LAYER_LOCATION');
    }
  }
  // Normalize row order before hashing; an unordered SQL result is not intent.
  s.reservations.sort((a,b) => cmp(a.product_id,b.product_id)); s.picks.sort((a,b) => cmp(a.product_id,b.product_id));
  s.locations.sort((a,b) => cmp(a.product_id,b.product_id) || cmp(a.location,b.location));
  s.layers.sort((a,b) => cmp(a.product_id,b.product_id) || cmp(a.layer_id,b.layer_id) || cmp(a.location,b.location));
  s.layer_metadata.sort((a,b) => cmp(a.layer_id,b.layer_id));
  const targets: Target[] = calculation.results.map(r => ({kind: r.kind, slot_id: r.slot_id,
    commercial_items: r.items.map(i => ({source_item_id: i.source_item_id, product_id: i.product_id, quantity: i.quantity})), reservations: [], picks: [], locations: [], layers: []}));
  const targetQuantities = targets.map(t => { const map = new Map<string, number>(); for (const i of t.commercial_items) map.set(i.product_id, (map.get(i.product_id) ?? 0) + i.quantity); return map; });
  let rows = 0;
  function append<T>(list: T[], row: T) { requireFact(++rows <= C.planned_rows, 'PLANNED_ROW_BOUND'); list.push(row); }
  for (const product of [...products.keys()].sort(cmp)) {
    const pick = picks.get(product)!;
    const chunks = (s.wms_enabled ? [...(productLayers.get(product) ?? [])].sort((a,b) => {
      const x = BigInt(meta.get(a.layer_id)!.fifo_sequence), y = BigInt(meta.get(b.layer_id)!.fifo_sequence);
      return (x < y ? -1 : x > y ? 1 : 0) || cmp(a.layer_id,b.layer_id) || cmp(a.location,b.location);
    }) : [...(productBins.get(product) ?? [])].sort((a,b) => cmp(a.location,b.location))).map(row => ({row, remaining: row.quantity}));
    let cursor = 0;
    for (const [index, target] of targets.entries()) {
      const quantity = targetQuantities[index].get(product) ?? 0; if (!quantity) continue;
      append(target.reservations, {product_id: product, warehouse_id: warehouse, quantity, state: 'active', consumed_quantity: 0, released_quantity: 0});
      append(target.picks, {source_pick_id: pick.id, product_id: product, sku: pick.sku, name: pick.name, ean: pick.ean, quantity, scanned: 0});
      let remaining = quantity; const bins = new Map<string, number>();
      while (remaining) {
        const chunk = chunks[cursor]; requireFact(chunk && chunk.remaining > 0, 'PHYSICAL_OVER_ALLOCATION');
        const amount = Math.min(remaining, chunk.remaining); remaining -= amount; chunk.remaining -= amount;
        bins.set(chunk.row.location, (bins.get(chunk.row.location) ?? 0) + amount);
        if ('layer_id' in chunk.row) {
          requireFact(typeof chunk.row.layer_id === 'string', 'INVALID_LAYER_ID');
          const m = meta.get(chunk.row.layer_id)!;
          append(target.layers, {product_id: product, warehouse_id: warehouse, location: chunk.row.location, layer_id: chunk.row.layer_id, quantity: amount, scanned: 0, state: 'active', consumed_quantity: 0, released_quantity: 0, lot_id: m.lot_id, fifo_sequence: m.fifo_sequence, expiry_date: m.expiry_date});
        }
        if (chunk.remaining === 0) cursor++;
      }
      for (const [location, quantity] of [...bins].sort(([a],[b]) => cmp(a,b))) append(target.locations, {product_id: product, warehouse_id: warehouse, location, quantity, scanned: 0, consumed_quantity: 0, released_quantity: 0});
    }
    requireFact(chunks.every(c => c.remaining === 0), 'UNALLOCATED_PHYSICAL_QUANTITY');
  }
  const body = {schema: 'order-split-custody-plan/v1' as const, integration_ready: false as const, native_admission: false as const,
    stock_mutation_planned: false as const, tenant_id: tenant, source_order_id: order, source_version: source.order.version, warehouse_id: warehouse,
    wms_enabled: s.wms_enabled, allocation_order: 'canonical_child_slots_then_retained_source/fifo_sequence_layer_location_C' as const,
    source_frame_sha256: hash(source), request_sha256: hash(calculation.request), custody_sha256: hash(s),
    source_quantities: [...products].sort(([a],[b]) => cmp(a,b)).map(([product_id,quantity]): ProductQuantity => ({product_id,quantity})), targets, planned_rows: rows};
  encoded(body, C.output_bytes); return frozen({...body, plan_sha256: hash(body)});
}
