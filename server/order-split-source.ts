/** Current DB facts for the initial unpaid/manual split. This does not admit a
 * write, transfer reservations, or replace current request IAM/Native checks.
 * Caller owns the managed tenant transaction and must recapture before execute.
 * Serial tracking is not implemented/accepted by this initial frame. */
import type { PoolClient } from 'pg';
import { orderSplitSourceFrame, orderSplitUuid, orderSplitVersion, ORDER_SPLIT_LIMITS as L, type OrderSplitSourceFrame } from './order-splits-schema';
import { orderMergeOriginalPaymentBalanceInTx } from './order-merge-payments';
import { fa3DraftOwnerInTx } from './fa3-draft-access';
import { orderSplitPhysicalSnapshot, ORDER_SPLIT_CUSTODY_LIMITS as C } from './order-split-custody-values';

export class OrderSplitCaptureError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'OrderSplitCaptureError'; }
}
function fact(v: unknown, code: string): asserts v { if (!v) throw new OrderSplitCaptureError(code); }
type Row = Record<string, unknown>;
function count(v: unknown): number {
  fact(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) <= 2147483647n, 'INVALID_HISTORY_COUNT');
  return Number(v);
}
async function one(c: PoolClient, sql: string, args: string[] = []): Promise<Row> {
  const r = await c.query<Row>(sql, args); fact(r.rows.length === 1, 'AMBIGUOUS_SOURCE_FACT'); return r.rows[0];
}
const contextSql = `/* split:context */ SELECT current_user AS role,
 nullif(current_setting('app.tenant_id',true),'') AS tenant,
 current_setting('transaction_read_only') AS read_only,
 pg_current_xact_id()::text AS xid,transaction_timestamp()::text AS started,pg_backend_pid()::text AS pid`;
const own = (table: string, predicate = 'order_id=$2') => `(SELECT count(*) FROM ${table} WHERE tenant_id=$1 AND (${predicate}))`;
const physicalTables = [['reservations','reservations'],['picks','order_pick_items'],['locations','reservation_locations'],['layers','wms_reservation_layers']] as const;
const layerMetadataFrom = `FROM wms_cost_layers l JOIN wms_lots o ON(o.tenant_id,o.id,o.product_id)=(l.tenant_id,l.lot_id,l.product_id)
 WHERE l.tenant_id=$1 AND EXISTS(SELECT 1 FROM wms_reservation_layers r WHERE r.tenant_id=$1 AND r.order_id=$2 AND (r.layer_id,r.product_id)=(l.id,l.product_id))`;
const layerMetadataSelect = `SELECT l.id AS layer_id,l.product_id,l.lot_id,l.fifo_sequence::text AS fifo_sequence,o.expiry_date::text AS expiry_date ${layerMetadataFrom}`;
const physicalBoundsSql = `/* split:physical-bound */ SELECT ${physicalTables.map(([key,table])=>
 `(SELECT count(*)::text FROM ${table} WHERE tenant_id=$1 AND order_id=$2) AS ${key},
 (SELECT coalesce(sum(octet_length(to_jsonb(r)::text)),0)::text FROM ${table} r WHERE tenant_id=$1 AND order_id=$2) AS ${key}_bytes`).join(',')},
 (SELECT count(*)::text ${layerMetadataFrom}) AS layer_metadata,
 (SELECT coalesce(sum(octet_length(to_jsonb(r)::text)),0)::text FROM(${layerMetadataSelect}) r) AS layer_metadata_bytes`;

type PhysicalSnapshot = ReturnType<typeof orderSplitPhysicalSnapshot.parse>;
export type OrderSplitSourceBundle = { source: OrderSplitSourceFrame; physical: PhysicalSnapshot };
/** Raw facts stay raw: no fabricated empty arrays, IDs, counters or metadata.
 * Parents/actual reservation rows are already locked; the WMS policy fence was
 * acquired before those locks. Complete arrays and actual layer/lot joins are
 * bounded before transfer, then independently checked for exact membership. */
async function physicalRows(c: PoolClient, args: string[], source: OrderSplitSourceFrame, reservations: Row[], enabled: boolean): Promise<PhysicalSnapshot> {
  const bound = await one(c, physicalBoundsSql, args);
  let bytes = 0;
  for (const key of ['reservations','picks','locations','layers','layer_metadata']) {
    fact(count(bound[key]) <= C.source_rows_per_kind, 'PHYSICAL_ROW_BOUND'); bytes += count(bound[key+'_bytes']);
  }
  fact(bytes <= C.input_bytes, 'PHYSICAL_BYTES');
  const picks = (await c.query<Row>(`/* split:physical-picks */ SELECT r.* FROM order_pick_items r WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id,id LIMIT 10001 FOR UPDATE OF r`, args)).rows;
  const locations = (await c.query<Row>(`/* split:physical-locations */ SELECT r.* FROM reservation_locations r WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id,location COLLATE "C" LIMIT 10001 FOR UPDATE OF r`, args)).rows;
  const layers = (await c.query<Row>(`/* split:physical-layers */ SELECT r.* FROM wms_reservation_layers r WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id,layer_id,location COLLATE "C" LIMIT 10001 FOR UPDATE OF r`, args)).rows;
  //090/104 wms_row_guard forbids UPDATE/DELETE of lots and cost layers;108's
  // successor exception applies only to reservation layers. Ordinary dyna_app
  // has SELECT/INSERT, not UPDATE: FOR SHARE here would incorrectly require it.
  const layer_metadata = (await c.query<Row>(`/* split:physical-metadata */ ${layerMetadataSelect} ORDER BY l.id LIMIT 10001`, args)).rows;
  const arrays = {reservations,picks,locations,layers,layer_metadata};
  for (const [key,rows] of Object.entries(arrays)) fact(rows.length === count(bound[key]), 'INCOMPLETE_PHYSICAL_ROWS');
  const value = {schema:'order-split-physical-source/v1',tenant_id:args[0],source_order_id:args[1],warehouse_id:source.order.warehouse_id,wms_enabled:enabled,...arrays};
  fact(Buffer.byteLength(JSON.stringify(value)) <= C.input_bytes, 'PHYSICAL_BYTES');
  const parsed = orderSplitPhysicalSnapshot.safeParse(value); fact(parsed.success, 'PHYSICAL_SOURCE_NOT_PRISTINE');
  const p = parsed.data, products = new Map<string,number>();
  for (const i of source.items) products.set(i.product_id,(products.get(i.product_id)??0)+i.quantity);
  const unique = (rows: object[], keys: string[]) => new Set(rows.map(r=>JSON.stringify(keys.map(k=>(r as Row)[k])))).size===rows.length;
  for (const rows of [p.reservations,p.picks,p.locations,p.layers]) for (const r of rows) {
    fact(r.tenant_id===args[0]&&r.order_id===args[1]&&products.has(r.product_id), 'FOREIGN_PHYSICAL_ROW');
    if('warehouse_id' in r)fact(r.warehouse_id===source.order.warehouse_id,'FOREIGN_PHYSICAL_ROW');
  }
  fact(unique(p.reservations,['product_id'])&&unique(p.picks,['product_id'])&&unique(p.picks,['id'])&&unique(p.locations,['product_id','location'])&&unique(p.layers,['product_id','layer_id','location'])&&unique(p.layer_metadata,['layer_id']),'DUPLICATE_PHYSICAL_ROW');
  fact(p.reservations.length===products.size&&p.picks.length===products.size,'INCOMPLETE_PHYSICAL_ROWS');
  const totals = (rows: {product_id:string;quantity:number}[]) => {const m=new Map<string,number>();for(const r of rows)m.set(r.product_id,(m.get(r.product_id)??0)+r.quantity);return m;};
  for(const rows of [p.reservations,p.picks,p.locations,...(enabled?[p.layers]:[])]) {
    const m=totals(rows);fact(m.size===products.size&&[...products].every(([id,q])=>m.get(id)===q),'INCONSISTENT_PHYSICAL_ROWS');
  }
  const key=(r:{product_id:string;location:string})=>JSON.stringify([r.product_id,r.location]);
  const bins=new Map(p.locations.map(r=>[key(r),r.quantity])), layerTotals=new Map<string,number>();
  const meta=new Map(p.layer_metadata.map(r=>[r.layer_id,r])), used=new Set<string>();
  for(const r of p.layers){const m=meta.get(r.layer_id);fact(m&&m.product_id===r.product_id&&bins.has(key(r)),'INCOMPLETE_LAYER_METADATA');used.add(r.layer_id);layerTotals.set(key(r),(layerTotals.get(key(r))??0)+r.quantity);}
  fact(used.size===meta.size,'INCOMPLETE_LAYER_METADATA');
  if(enabled)fact([...bins].every(([id,q])=>layerTotals.get(id)===q),'INCONSISTENT_PHYSICAL_ROWS');
  else fact(p.layers.length===0&&p.layer_metadata.length===0,'WMS_MODE_MISMATCH');
  return p;
}
// Table/column identifiers below are source-owned, never supplied by callers.
const countSql = `/* split:counts */ SELECT
 ${own('payment_entries')}::text AS payment_entries,
 ${own('source_payment_checks')}::text AS source_payment_checks,
 ${own('payment_import_allocation_rows')}::text AS import_allocations,
 ${own('payment_import_receipts')}::text AS payment_import_receipts,
 ${own('jobs', "kind='payment.source.read' AND payload->>'order_id'=$2::text")}::text AS source_payment_jobs,
 (SELECT count(*) FROM payment_import_execution_rows x JOIN payment_import_rows r
  ON(r.tenant_id,r.preview_id,r.row_id)=(x.tenant_id,x.preview_id,x.row_id)
  WHERE x.tenant_id=$1 AND r.allocation->>'order_id'=$2::text)::text AS payment_import_attempts,
 ${own('documents')}::text AS documents,
 (${own('invoice_plans')}+${own('local_invoice_previews')})::text AS invoice_plans,
 (${own('documents', "order_id=$2 AND kind='correction'")}+${own('local_consumer_credit_previews')}+${own('return_credit206_previews')})::text AS corrections,
 ${own('return_cases')}::text AS returns,
 ${own('return_exchanges','original_order_id=$2 OR replacement_order_id=$2')}::text AS exchanges,
 ${own('shipments')}::text AS shipments,
 (${['shipping_plans','order_status_plans','odoo_invoice_exports','ebay_fulfillment_plans','amazon_fulfillment_plans','shopify_fulfillment_plans'].map(t => own(t)).join('+')})::text AS provider_attempts,
 (${own('order_parcel_previews')}+${own('order_parcel_plans')}+${own('packing_receipts')}+${own('order_packing_profiles')})::text AS parcel_plans,
 (SELECT count(*) FROM picking_wave_orders p JOIN picking_waves w ON(w.tenant_id,w.id)=(p.tenant_id,p.wave_id)
  WHERE p.tenant_id=$1 AND p.order_id=$2 AND p.active AND w.state='picking')::text AS active_picking_waves,
 ${own('packing_sessions',"order_id=$2 AND state='active'")}::text AS active_packing_sessions,
 (${own('order_merge_origins')}+${own('order_merge_claims','source_order_id=$2 OR target_order_id=$2')}+
 ${own('order_merge_executions','$2=ANY(source_ids) OR target_order_id=$2')})::text AS merge_lineage,
 (${own('b2b_external_order_intents')}+${own('b2b_external_import_executions')}+
 ${own('b2b_dropship_orders','customer_order_id=$2')}+${own('b2b_dropship_supplier_orders')})::text AS external_intents,
 (${own('order_field_values')}+${own('order_field_value_events')}+${own('order_field_requests')})::text AS custom_fields,
 (${own('picking_wave_scans')}+(SELECT coalesce(sum(scanned),0) FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2)+
 (SELECT coalesce(sum(scanned),0) FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2)+
 (SELECT coalesce(sum(scanned),0) FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2))::text AS physical_scans,
 ${own('wms_reservation_layers',"order_id=$2 AND state<>'active'")}::text AS inactive_layers,
 (SELECT coalesce(sum(consumed_quantity),0) FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2)::text AS location_consumed,
 (SELECT coalesce(sum(released_quantity),0) FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2)::text AS location_released,
 (SELECT coalesce(sum(consumed_quantity),0) FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2)::text AS layer_consumed,
 (SELECT coalesce(sum(released_quantity),0) FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2)::text AS layer_released`;

/** Requires an actual PoolClient inside the same writable dyna_app tenant TX.
 * The xact schema fence and catalogue lock are taken before parent/child locks.
 * Existing209 has no split lineage: absence is checked, not guessed from IDs.
 * Once any split schema is installed this reader refuses until its lineage query
 * is source-authored; it must not silently report zero for a future210 schema. */
async function capture(c: PoolClient, input: {
  tenantId: string; orderId: string; expectedVersion: string;
}, includePhysical: boolean): Promise<{source: OrderSplitSourceFrame;physical?: PhysicalSnapshot}> {
  const t = orderSplitUuid.parse(input.tenantId), id = orderSplitUuid.parse(input.orderId), version = orderSplitVersion.parse(input.expectedVersion);
  const args = [t, id];
  const start = await one(c, contextSql);
  fact(start.role === 'dyna_app' && start.tenant === t && start.read_only === 'off' && typeof start.xid === 'string', 'CURRENT_TENANT_TX_REQUIRED');
  await c.query('/* split:fences */ SELECT pg_advisory_xact_lock_shared(982376),pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['catalog:' + t]);
  const namespace = await fa3DraftOwnerInTx(c, () => one(c, `/* split:namespace */ SELECT (
   EXISTS(SELECT 1 FROM pg_class p JOIN pg_namespace n ON n.oid=p.relnamespace WHERE n.nspname='public' AND p.relname LIKE 'order_split%') OR
   EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'order_split%') OR
   EXISTS(SELECT 1 FROM pg_namespace WHERE nspname LIKE 'order_split%') OR
   EXISTS(SELECT 1 FROM migrations WHERE name LIKE '%order_split%')) AS present`));
  fact(namespace.present === false, 'SPLIT_LINEAGE_READER_REQUIRED');
  let wmsEnabled = false;
  if(includePhysical){
    await c.query('/* split:physical-policy-lock */ SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['wms.policy:'+t]);
    // Real wmsLotsAdmissionInTx synchronization order: shared policy fence,
    // ordinary policy SELECT, then the shared WMS operations fence (the same mode as the
    // tenantTx admission, 250) before parent/stock waits; order/stock row locks decide.
    // Policy activation takes the exclusive counterpart; no UPDATE grant is
    // required just to observe the enabled policy or immutable metadata.
    const policy=(await c.query<Row>('/* split:physical-policy */ SELECT enabled FROM wms_policies WHERE tenant_id=$1 LIMIT 2',[t])).rows;
    fact(policy.length<=1&&(policy.length===0||policy[0].enabled===true),'INVALID_WMS_POLICY');wmsEnabled=policy.length===1;
    if(wmsEnabled)await c.query('/* split:physical-operations-lock */ SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['wms.operations:'+t]);
  }
  const o = await one(c, `/* split:order */ SELECT id,tenant_id,version::text,source,fulfillment_kind,status,
   warehouse_id,currency,payment_mode,shipping_cost,total,channel_id,external_id,b2b_account_id,
   (source_snapshot IS NOT NULL OR b2b_snapshot IS NOT NULL OR replacement_return_id IS NOT NULL) AS unsupported_business_fields
   FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, args);
  fact(o.id === id && o.tenant_id === t && o.version === version, 'SOURCE_ID_OR_VERSION_MISMATCH');
  const size = await one(c, `/* split:line-bound */ SELECT count(*)::text AS n,coalesce(sum(octet_length(to_jsonb(i)::text)),0)::text AS bytes FROM order_items i WHERE tenant_id=$1 AND order_id=$2`, args);
  fact(count(size.n) > 0 && count(size.n) <= L.source_lines && count(size.bytes) <= L.source_bytes, 'SOURCE_LINE_BOUND');
  const itemRows = await c.query<Row>(`/* split:items */ SELECT i.id,i.order_id,i.product_id,p.kind AS product_kind,
   i.quantity,i.price,i.vat,i.line_total,i.components,i.scanned FROM order_items i JOIN products p
   ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id) WHERE i.tenant_id=$1 AND i.order_id=$2
   ORDER BY i.id LIMIT 10001 FOR UPDATE OF i`, args);
  fact(itemRows.rows.length === count(size.n), 'SOURCE_LINE_BOUND');
  const reservations = await c.query<Row>(`/* split:reservations */ SELECT tenant_id,order_id,product_id,warehouse_id,quantity,state,consumed_quantity,released_quantity
   FROM reservations WHERE tenant_id=$1 AND order_id=$2 ORDER BY warehouse_id,product_id LIMIT 10001 FOR UPDATE`, args);
  fact(reservations.rows.length <= L.source_lines, 'RESERVATION_BOUND');
  const totals = new Map<string, number>();
  for (const r of itemRows.rows) {
    fact(typeof r.product_id === 'string' && Number.isSafeInteger(r.quantity) && Number(r.quantity) > 0, 'INVALID_SOURCE_ITEM');
    totals.set(r.product_id, (totals.get(r.product_id) ?? 0) + Number(r.quantity));
  }
  const physical = new Map<string, { consumed: number; released: number }>(); let inactive = 0, consumed = 0, released = 0;
  for (const r of reservations.rows) {
    fact(typeof r.product_id === 'string' && !physical.has(r.product_id) && r.warehouse_id === o.warehouse_id &&
      r.quantity === totals.get(r.product_id), 'AMBIGUOUS_PHYSICAL_MAPPING');
    const a = count(String(r.consumed_quantity)), b = count(String(r.released_quantity));
    physical.set(r.product_id, { consumed: a, released: b }); consumed += a; released += b;
    if (r.state !== 'active') inactive++;
  }
  fact(physical.size === totals.size && [...totals.keys()].every(p => physical.has(p)), 'INCOMPLETE_RESERVATIONS');
  const shape = await one(c, `/* split:physical-shape */ SELECT (
   EXISTS(SELECT 1 FROM reservations r WHERE r.tenant_id=$1 AND r.order_id=$2 AND
    (r.quantity IS DISTINCT FROM (SELECT sum(l.quantity) FROM reservation_locations l
      WHERE(l.tenant_id,l.order_id,l.product_id,l.warehouse_id)=(r.tenant_id,r.order_id,r.product_id,r.warehouse_id)) OR
     r.quantity IS DISTINCT FROM (SELECT sum(p.quantity) FROM order_pick_items p
      WHERE(p.tenant_id,p.order_id,p.product_id)=(r.tenant_id,r.order_id,r.product_id)))) OR
   EXISTS(SELECT 1 FROM order_pick_items p WHERE p.tenant_id=$1 AND p.order_id=$2 AND NOT EXISTS(
    SELECT 1 FROM reservations r WHERE(r.tenant_id,r.order_id,r.product_id)=(p.tenant_id,p.order_id,p.product_id))) OR
   EXISTS(SELECT 1 FROM reservation_locations l WHERE l.tenant_id=$1 AND l.order_id=$2 AND
    ((EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=$1 AND enabled) AND l.quantity IS DISTINCT FROM
      (SELECT sum(w.quantity) FROM wms_reservation_layers w WHERE(w.tenant_id,w.order_id,w.product_id,w.warehouse_id,w.location)=
       (l.tenant_id,l.order_id,l.product_id,l.warehouse_id,l.location))) OR
     (NOT EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=$1 AND enabled) AND EXISTS(
       SELECT 1 FROM wms_reservation_layers w WHERE(w.tenant_id,w.order_id,w.product_id,w.warehouse_id,w.location)=
        (l.tenant_id,l.order_id,l.product_id,l.warehouse_id,l.location)))))) AS inconsistent`, args);
  fact(shape.inconsistent === false, 'INCONSISTENT_PHYSICAL_CUSTODY');
  const facts = await one(c, countSql, args), n = Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, count(v)]));
  const privateFacts = await fa3DraftOwnerInTx(c, () => one(c, `/* split:private-counts */ SELECT
   (${own('b2b_invoice_previews')}+${own('fa3_draft_projects')})::text AS invoice_plans,
   ${own('b2b_credit_previews')}::text AS corrections`, args));
  n.invoice_plans += count(privateFacts.invoice_plans); n.corrections += count(privateFacts.corrections);
  const state = await one(c, '/* split:buyer */ SELECT buyer_address_current_state($1::uuid,$2::uuid) AS state', args);
  const buyer = state.state as Row | null;
  fact(buyer && typeof buyer.version === 'string', 'BUYER_STATE_UNKNOWN');
  // Sidecar inheritance is a future explicit split feature, never implicit loss.
  o.unsupported_business_fields = o.unsupported_business_fields === true || n.custom_fields > 0 || buyer.version !== '0';
  const rowMultiplicity = new Map<string, number>();
  for (const r of itemRows.rows) rowMultiplicity.set(String(r.product_id), (rowMultiplicity.get(String(r.product_id)) ?? 0) + 1);
  const items = itemRows.rows.map(r => {
    const p = physical.get(String(r.product_id))!;
    fact(!(p.consumed || p.released) || rowMultiplicity.get(String(r.product_id)) === 1, 'AMBIGUOUS_PHYSICAL_MAPPING');
    return { ...r, consumed_quantity: p.consumed, released_quantity: p.released };
  });
  const financial = Object.fromEntries(['payment_entries','source_payment_checks','import_allocations','payment_import_receipts','source_payment_jobs','payment_import_attempts'].map(k => [k, n[k]]));
  const blockers = Object.fromEntries(['documents','invoice_plans','corrections','returns','exchanges','shipments','provider_attempts','parcel_plans','active_picking_waves','active_packing_sessions','merge_lineage','external_intents','physical_scans'].map(k => [k, n[k]]));
  const balance = await orderMergeOriginalPaymentBalanceInTx(c, id);
  const value = { schema: 'order-split-source/v1', order: o, items, financial: { ...financial, balance },
    blockers: { ...blockers, split_lineage: 0, non_active_reservations: inactive + n.inactive_layers,
      // Raw observations across custody levels, only a zero/nonzero gate. These
      // are NOT deduplicated business units or a conservation/transfer ledger.
      consumed_quantity: consumed + n.location_consumed + n.layer_consumed,
      released_quantity: released + n.location_released + n.layer_released } };
  fact(Buffer.byteLength(JSON.stringify(value)) <= L.source_bytes, 'SOURCE_BYTES');
  const frame = orderSplitSourceFrame.parse(value);
  const capturedPhysical = includePhysical ? await physicalRows(c,args,frame,reservations.rows,wmsEnabled) : undefined;
  const end = await one(c, contextSql);
  fact(JSON.stringify(start) === JSON.stringify(end), 'TRANSACTION_CONTEXT_CHANGED');
  return {source:frame,...(capturedPhysical?{physical:capturedPhysical}:{})};
}

/** Compatible commercial-only DTO; this does not imply physical-row capture. */
export async function captureOrderSplitSourceInTx(c: PoolClient,input:{tenantId:string;orderId:string;expectedVersion:string}):Promise<OrderSplitSourceFrame>{
  return (await capture(c,input,false)).source;
}
/** Complete commercial + physical facts from the SAME managed transaction.
 * Feed to calculateOrderSplitCustody(bundle.source,request,bundle.physical).
 * No Native210 permission, execution or stock transfer is created here. Earlier
 * actual capture receipts pin the older source hash and do not certify this cut. */
export async function captureOrderSplitSourcesInTx(c:PoolClient,input:{tenantId:string;orderId:string;expectedVersion:string}):Promise<OrderSplitSourceBundle>{
  const bundle=await capture(c,input,true);fact(bundle.physical,'INCOMPLETE_PHYSICAL_ROWS');return{source:bundle.source,physical:bundle.physical};
}
