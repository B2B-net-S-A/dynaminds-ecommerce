import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ORDER_PARCEL_LIMITS = { parcels: 50, products: 500, preview_ttl_seconds: 900, previews: 2000, plans: 2000, history_bytes: 67108864, snapshot_bytes: 4194304 } as const;
export const parcelUuid = z.uuid().transform(v => v.toLowerCase());
export const parcelVersion = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
const products = z.array(z.strictObject({ product_id: parcelUuid, quantity: z.number().int().min(1).max(1000000) })).min(1).max(500).refine(rows => new Set(rows.map(r => r.product_id)).size === rows.length, 'Powtórzony produkt paczki');
export const orderParcelDraft = z.strictObject({ source_kind: z.enum(['demo', 'existing']), shipment_id: parcelUuid.optional(), products, cod_minor: z.number().int().min(0).max(2147483647) }).refine(v => (v.source_kind === 'existing') === Boolean(v.shipment_id), 'Istniejąca przesyłka wymaga identyfikatora; DEMO tworzy własny');
export const legacyOrderParcelPreviewInput = z.strictObject({ client_key: parcelUuid, order_version: parcelVersion, parcels: z.array(orderParcelDraft).min(2).max(50) }).refine(v => { const ids = v.parcels.flatMap(p => p.shipment_id ? [p.shipment_id] : []); return new Set(ids).size === ids.length && v.parcels.reduce((n,p)=>n+p.products.length,0)<=500; }, 'Powtórzona przesyłka lub zbyt wiele pozycji');
const commercialItems = z.array(z.strictObject({item_id:parcelUuid,quantity:z.number().int().min(1).max(1000000)})).min(1).max(500).refine(v=>new Set(v.map(i=>i.item_id)).size===v.length,'Powtórzona pozycja paczki');
export const orderParcelCommercialDraft = z.strictObject({source_kind:z.enum(['demo','existing']),shipment_id:parcelUuid.optional(),cod_minor:z.number().int().min(0).max(2147483647),items:commercialItems}).refine(v=>(v.source_kind==='existing')===Boolean(v.shipment_id),'Niepoprawne źródło przesyłki');
export const commercialOrderParcelPreviewInput = z.strictObject({client_key:parcelUuid,order_version:parcelVersion,protocol:z.literal('commercial_v1'),parcels:z.array(orderParcelCommercialDraft).min(2).max(50)}).refine(v=>{const ids=v.parcels.flatMap(p=>p.shipment_id?[p.shipment_id]:[]);return new Set(ids).size===ids.length&&v.parcels.reduce((n,p)=>n+p.items.length,0)<=500;},'Powtórzona przesyłka lub zbyt wiele pozycji');
export const orderParcelPreviewInput = z.union([legacyOrderParcelPreviewInput,commercialOrderParcelPreviewInput]);
export const orderParcelApplyInput = z.strictObject({ client_key: parcelUuid, scope_hash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) });
export const orderParcelDispatchInput = orderParcelApplyInput;
export const orderParcelHistoryInput = z.strictObject({ kind: z.enum(['preview','plan']).default('plan'), cursor: parcelUuid.optional(), limit: z.coerce.number().int().min(1).max(50).default(50) });
export const orderParcelIndex = z.coerce.number().int().min(0).max(49);
export type OrderParcelActor = import('./domain').Actor & { apiKeyId?: string };
export type OrderParcelPreviewInput = z.infer<typeof orderParcelPreviewInput>;
export type OrderParcelApplyInput = z.infer<typeof orderParcelApplyInput>;
export type OrderParcelHistoryInput = z.infer<typeof orderParcelHistoryInput>;
/** Canonical namespace keys never depend on a runtime random retry. */
export function orderParcelIdentity(parent: string, index: number) {
  const h=createHash('sha256').update(`order.parcel:${parcelUuid.parse(parent)}:${orderParcelIndex.parse(index)}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export type OrderParcelLocation = { location:string; quantity:number };
export type OrderParcelLotHold = OrderParcelLocation & { layer_id:string };
export type OrderParcelProduct = { product_id:string; warehouse_id:string; quantity:number; locations:OrderParcelLocation[]; lot_holds:OrderParcelLotHold[] };
export type OrderParcel = { index:number; source_kind:'demo'|'existing'; shipment_id:string; carrier:string; mode:string; tracking_number:string; cod_minor:number; items?:import('./order-parcel-commercial-values').CommercialParcelItem[]; products:OrderParcelProduct[] };
export type OrderParcelSource = { order:{id:string;number:string;version:string;status:string;warehouse_id:string;payment_mode:string;currency:string}; receiver:Record<string,unknown>; products:Record<string,any>[]; shipments:Record<string,any>[]; cod_due:number; payment_due:number; active_plan_id:string|null; wms_enabled:boolean; can_preview:boolean; unavailable_reason:string|null; commercial_available?:boolean; commercial_lines?:import('./order-parcel-commercial-values').CommercialLine[] };
export type OrderParcelPreview = { id:string;kind:'preview';protocol?:'commercial_v1';order_id:string;order_version:string;scope_hash:string;source:OrderParcelSource;parcels:OrderParcel[];summary:{parcels:number;products:number;physical_quantity:number;cod_minor:number};created_at:string;expires_at:string;applied_plan_id:string|null;can_apply:boolean };
export type OrderParcelPlan = Omit<OrderParcelPreview,'kind'|'expires_at'|'applied_plan_id'|'can_apply'> & {kind:'plan';preview_id:string;progress:{index:number;shipment_id:string;state:'pending'|'dispatched'|'cancelled';dispatch_id:string|null;release_id:string|null}[];order_status:string;current_order_version:string;complete:boolean;origins:OrderParcelCommercialOrigin[]};
export type OrderParcelDispatch = {id:string;plan_id:string;parcel_index:number;shipment_id:string;scope_hash:string;created_at:string;receipt:Record<string,unknown>};

export type OrderParcelCommercialOrigin = {origin_id:string;item_id:string;parcel_index:number;shipment_id:string;quantity:number;issued_quantity:number;cancelled_quantity:number;components:import('./order-parcel-commercial-values').CommercialComponent[];dispatch_id:string|null};
