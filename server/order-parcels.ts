import { preparePimPublicConstraintsInTx } from './pim-dictionaries/runtime';
import type {BuyerAddressRequest} from './buyer-address';
import {captureOperationalDeliveryAuthority} from './operational-delivery-consumers';
import {capturePhysicalParcelWzAuthority,enlistPhysicalParcelWzDispatchInTx} from './physical-parcel-wz';
import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { pool,tenantTx,localConfig } from './db';
import { enlistOperationalDeliveryInTx } from './operational-delivery-consumers';
import { audit,event } from './domain';
import { ensure,Problem } from './errors';
import { consumeOrderParcelInTx } from './order-parcel-stock';
import { assertLabelsNotCancelledInTx,CANCELLED_PARCEL_REFUSAL } from './shipment-cancelled';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { enlistDispatchActorInTx } from './dispatch-transaction';
import { prepareAutomaticWzInTx, finishAutomaticWzInTx } from './warehouse-wz-issuer';
import { lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';
import * as V from './order-parcels-values';
import {orderParcelCommercialOriginsAvailable,orderParcelCancelledInTx} from './order-parcel-commercial-origins';
export {orderParcelCommercialOriginsAvailable,orderParcelCommercialOriginsInTx} from './order-parcel-commercial-origins';
export { ORDER_PARCEL_LIMITS } from './order-parcels-values';
export type { OrderParcelActor,OrderParcelPreview,OrderParcelPlan,OrderParcelDispatch } from './order-parcels-values';
const tables=['order_parcel_previews','order_parcel_plans','order_parcel_allocations','order_parcel_dispatches','order_parcel_admissions'];
const incomplete='Moduł paczek jest niekompletny';
export async function orderParcelsAvailable(c:Pool|PoolClient):Promise<boolean>{
 try{
  const p=(await c.query(`SELECT current_user role,EXISTS(SELECT 1 FROM unnest($1::text[]) n WHERE to_regclass(n) IS NOT NULL) OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'order_parcel_%') OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid IN(to_regclass('reservations'),to_regclass('reservation_locations'),to_regclass('wms_reservation_layers')) AND attname='consumed_quantity' AND NOT attisdropped) artifacts`,[tables])).rows[0];
  if(!p.artifacts){ensure(p.role!=='dyna_app',503,incomplete);ensure(!(await c.query("SELECT EXISTS(SELECT 1 FROM migrations WHERE name='134_order_parcels') installed")).rows[0].installed,503,incomplete);return false;}
  ensure((await c.query("SELECT to_regprocedure('order_parcel_guards()') IS NOT NULL AND to_regprocedure('order_parcel_installed()') IS NOT NULL ok")).rows[0].ok,503,incomplete);
  const g=(await c.query('SELECT order_parcel_guards() ok,order_parcel_installed() installed')).rows[0];ensure(g.ok&&g.installed,503,incomplete);return true;
 }catch(e){if(['42P01','42703','42883'].includes((e as {code?:string}).code??''))throw new Problem(503,incomplete);throw e;}
}
type Grant={role:V.OrderParcelActor['role'];key_valid:boolean;allowed:boolean};
async function access(c:PoolClient,a:V.OrderParcelActor,write:boolean,pin=false){const g=(await c.query('SELECT order_parcel_access($1,$2,$3,$4) g',[a.userId,a.apiKeyId??null,write,pin])).rows[0].g as Grant;ensure(g.key_valid,401,'Klucz paczek jest nieaktualny');ensure(g.allowed,403,'Brak aktualnego uprawnienia do paczek');return g;}
async function flags(c:PoolClient,a:V.OrderParcelActor,write:boolean){const g=await access(c,a,write,true);const w=(await c.query('SELECT order_parcel_access($1,$2,true,false) g',[a.userId,a.apiKeyId??null])).rows[0].g as Grant;return {available:true,read_only:false,current_role:g.role,can_read:true,can_write:w.key_valid&&w.allowed};}
async function tx<T>(a:V.OrderParcelActor,write:boolean,fn:(c:PoolClient)=>Promise<T>){ensure(await orderParcelsAvailable(pool),503,incomplete);await orderParcelCommercialOriginsAvailable(pool);try{return await tenantTx(a.tenantId,async c=>{ensure(await orderParcelsAvailable(c),503,incomplete);await orderParcelCommercialOriginsAvailable(c);await access(c,a,write);return fn(c);});}catch(e){if(e instanceof Problem)throw e;const x=e as {code?:string;message?:string};if(x.code==='23514'&&x.message==='Klucz paczek jest nieaktualny')throw new Problem(401,x.message);if(x.code==='23514'&&x.message==='Brak aktualnego uprawnienia do paczek')throw new Problem(403,x.message);if(x.code==='28000')throw new Problem(401,'Bieżąca sesja paczek wygasła');if(x.code==='42501')throw new Problem(403,'Brak bieżącego uprawnienia odbiorcy paczki');if(x.code==='40001')throw new Problem(409,'Bieżący odbiorca lub rola paczki zmieniły się');if(x.code==='55000')throw new Problem(503,incomplete);if(x.code==='P0002')throw new Problem(404,x.message??'Nie znaleziono paczki');if(['23514','23503','23505'].includes(x.code??''))throw new Problem(409,x.message??'Zakres paczek zmienił się');throw e;}}
const iso=(v:Date|string)=>v instanceof Date?v.toISOString():v;
async function row(c:PoolClient,table:string,id:string){const r=(await c.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];ensure(r,404,'Nie znaleziono zakresu paczek');return r;}
/** Warehouse SHARE must precede the parcel quota/order/stock locks. These reads
 * are own-scope and unlocked; revalidate after the existing SQL lock admission.
 * Do not require sale here: an immutable committed replay changes no stock. */
async function parcelWarehouseIds(c:PoolClient,orderId:string,frozenIds:readonly string[]=[]):Promise<string[]>{
 const head=await row(c,'orders',orderId);
 const holds=(await c.query<{warehouse_id:string}>('SELECT DISTINCT warehouse_id FROM reservations WHERE order_id=$1 ORDER BY warehouse_id',[orderId])).rows;
 return [...new Set([head.warehouse_id as string,...holds.map(r=>r.warehouse_id),...frozenIds])].sort();
}
async function admitParcelWarehouses(c:PoolClient,orderId:string,frozenIds:readonly string[]=[]){
 const ids=await parcelWarehouseIds(c,orderId,frozenIds);
 await lockWarehouseInventoryPoliciesInTx(c,ids);
 return ids;
}
/** Warehouse policies precede the exact existing134 namespace locks. The prior
 * lookup after these locks sees a concurrent committed receipt before admission;
 * unchanged native functions still authenticate its exact request/actor/hash. */
export async function lockOperationalParcelInTx(c:PoolClient,a:V.OrderParcelActor,orderId:string,frozenIds:readonly string[]=[]){
 const ids=await admitParcelWarehouses(c,orderId,frozenIds);
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('order.parcels.quota:'||$1::text,0))",[a.tenantId]);
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('order.parcels:'||$1::text||':'||$2::text,0))",[a.tenantId,orderId]);
 return ids;
}
/** Read context is zero persistent DML, including release frames. A release is
 * authorized by its own native137 producer and cannot invent a167 parcel proof. */
export async function enlistOperationalParcelInTx(c:PoolClient,a:V.OrderParcelActor,orderId:string,clientKey:string,write:boolean){
 return enlistOperationalDeliveryInTx(c,{actor:a,orderId,consumer:'parcel',clientKey,encryptionKey:localConfig.encryptionKey,write,persistEvidence:write});
}
async function assertParcelWarehouses(c:PoolClient,orderId:string,ids:readonly string[],frozenIds:readonly string[]=[]){
 ensure((await parcelWarehouseIds(c,orderId,frozenIds)).join(',')===ids.join(','),409,'Magazyny paczek zmieniły się przed blokadą');
}
function frozenWarehouseIds(payload:{parcels:Array<{products:Array<{warehouse_id:string}>}>}):string[]{
 return [...new Set(payload.parcels.flatMap(p=>p.products.map(r=>r.warehouse_id)))].sort();
}
async function previewView(c:PoolClient,id:string):Promise<V.OrderParcelPreview>{const p=await row(c,'order_parcel_previews',id);const plan=(await c.query('SELECT id FROM order_parcel_plans WHERE preview_id=$1',[id])).rows[0];return {id:p.id,kind:'preview',...(p.payload.protocol?{protocol:p.payload.protocol}:{}),order_id:p.order_id,order_version:p.payload.source.order.version,scope_hash:p.scope_hash,source:p.payload.source,parcels:p.payload.parcels,summary:p.payload.summary,created_at:iso(p.created_at),expires_at:iso(p.expires_at),applied_plan_id:plan?.id??null,can_apply:!plan&&new Date(p.expires_at).getTime()>Date.now()};}
async function planView(c:PoolClient,id:string):Promise<V.OrderParcelPlan>{const p=await row(c,'order_parcel_plans',id);const o=(await c.query('SELECT status,version::text FROM orders WHERE id=$1',[p.order_id])).rows[0];ensure(o,503,incomplete);const rows=(await c.query('SELECT a.index,a.shipment_id,d.id dispatch_id,s.dispatched_at FROM order_parcel_allocations a JOIN shipments s ON(s.tenant_id,s.id)=(a.tenant_id,a.shipment_id) LEFT JOIN order_parcel_dispatches d ON(d.tenant_id,d.plan_id,d.parcel_index)=(a.tenant_id,a.plan_id,a.index) WHERE a.plan_id=$1 ORDER BY a.index',[id])).rows;ensure(rows.length===p.payload.parcels.length&&rows.every(r=>Boolean(r.dispatch_id)===Boolean(r.dispatched_at)),503,incomplete);const cancelled=await orderParcelCancelledInTx(c,id);ensure(rows.every(r=>!r.dispatch_id||!cancelled.has(r.index)),503,incomplete);const progress=rows.map(r=>({index:r.index,shipment_id:r.shipment_id,state:r.dispatch_id?'dispatched' as const:cancelled.has(r.index)?'cancelled' as const:'pending' as const,dispatch_id:r.dispatch_id??null,release_id:cancelled.get(r.index)??null}));
 const origins:V.OrderParcelCommercialOrigin[]=await orderParcelCommercialOriginsAvailable(c)?(await c.query(`SELECT o.id origin_id,o.item_id,o.parcel_index,o.shipment_id,o.quantity,coalesce(i.quantity,0) issued_quantity,o.snapshot->'components' components,i.dispatch_id FROM order_parcel_commercial_origins o LEFT JOIN order_parcel_origin_issues i ON(i.tenant_id,i.origin_id)=(o.tenant_id,o.id) WHERE o.plan_id=$1 ORDER BY o.parcel_index,o.item_id`,[id])).rows.map(r=>({...r,cancelled_quantity:cancelled.has(r.parcel_index)?r.quantity:0})):[];
 return {id:p.id,kind:'plan',...(p.payload.protocol?{protocol:p.payload.protocol}:{}),preview_id:p.preview_id,order_id:p.order_id,order_version:p.payload.source.order.version,scope_hash:p.scope_hash,source:p.payload.source,parcels:p.payload.parcels,summary:p.payload.summary,created_at:iso(p.created_at),progress,origins,order_status:o.status,current_order_version:o.version,complete:progress.every(r=>r.state!=='pending')};}
function dispatchView(d:any):V.OrderParcelDispatch{return {id:d.id,plan_id:d.plan_id,parcel_index:d.parcel_index,shipment_id:d.shipment_id,scope_hash:d.scope_hash,created_at:iso(d.created_at),receipt:d.receipt};}
/** Read projection of the same existing whole-order issue; parcel-only SQL counters stay unchanged.
 * Never infer an issue from status, an active reservation or an uncommitted shipment. */
function projectLegacyWholeOrderIssue(source:V.OrderParcelSource,commercialLines:import('./order-parcel-commercial-values').CommercialLine[],counters:any[],stockIssues:any[],locationIssues:any[],layerIssues:any[]){
 if(source.active_plan_id!==null||!source.shipments.some(s=>s.dispatched_at))return false;
 ensure(source.shipments.filter(s=>s.dispatched_at).length===1&&source.products.length>0,503,incomplete);
 const number=(n:unknown)=>{const v=typeof n==='string'&&/^[0-9]+$/.test(n)?Number(n):n;ensure(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0,503,incomplete);return v as number;};
 ensure(counters.length===source.products.length&&new Set(counters.map(r=>r.product_id)).size===counters.length,503,incomplete);
 ensure(stockIssues.length===source.products.length&&new Set(stockIssues.map(r=>r.product_id)).size===stockIssues.length,503,incomplete);
 let expectedLocations=0,expectedLayers=0;
 for(const product of source.products){
  const r=counters.find(r=>r.product_id===product.product_id),stock=stockIssues.find(r=>r.product_id===product.product_id);
  ensure(r?.state==='consumed'&&stock?.warehouse_id===r.warehouse_id&&number(stock.quantity)===product.quantity&&number(stock.rows)===1&&product.consumed_quantity===0&&product.released_quantity===0,503,incomplete);
  ensure(product.locations.length>0&&new Set(product.locations.map((l:any)=>l.location)).size===product.locations.length&&product.locations.reduce((q:number,l:any)=>q+number(l.quantity),0)===product.quantity,503,incomplete);
  for(const location of product.locations){const rows=locationIssues.filter(r=>r.product_id===product.product_id&&r.warehouse_id===stock.warehouse_id&&r.location===location.location);ensure(rows.length===1&&number(rows[0].quantity)===location.quantity&&number(rows[0].rows)===1&&location.consumed_quantity===0&&location.released_quantity===0,503,incomplete);expectedLocations++;}
  for(const layer of product.layers){const rows=layerIssues.filter(r=>r.product_id===product.product_id&&r.warehouse_id===stock.warehouse_id&&r.location===layer.location&&r.layer_id===layer.layer_id);ensure(rows.length===1&&number(rows[0].quantity)===layer.quantity&&number(rows[0].bad_journals)===0&&rows[0].hold_state==='consumed'&&layer.consumed_quantity===0&&layer.released_quantity===0,503,incomplete);expectedLayers++;}
  if(product.layers.length)ensure(product.layers.reduce((q:number,l:any)=>q+number(l.quantity),0)===product.quantity,503,incomplete);
 }
 ensure(locationIssues.length===expectedLocations&&layerIssues.length===expectedLayers,503,incomplete);
 for(const product of source.products){product.consumed_quantity=product.quantity;product.remaining=0;for(const entry of [...product.locations,...product.layers]){entry.consumed_quantity=entry.quantity;entry.remaining=0;}}
 const demand=new Map<string,number>();let commercialMatches=commercialLines.length>0;
 for(const line of commercialLines){if(!Number.isSafeInteger(line.quantity)||line.quantity<1||!line.components.length||new Set(line.components.map(c=>c.product_id)).size!==line.components.length){commercialMatches=false;continue;}for(const c of line.components){const q=(demand.get(c.product_id)??0)+c.quantity*line.quantity;if(!Number.isSafeInteger(c.quantity)||c.quantity<1||!Number.isSafeInteger(q))commercialMatches=false;demand.set(c.product_id,q);}}
 commercialMatches=commercialMatches&&demand.size===source.products.length&&source.products.every(p=>demand.get(p.product_id)===p.quantity);
 for(const line of commercialLines){line.origin_available=commercialMatches;line.issued=commercialMatches?line.quantity:null;line.cancelled=commercialMatches?0:null;line.pending=commercialMatches?0:null;}
 // Preserve the native refusal to start a second dispatch; correct its public explanation only.
 if(source.unavailable_reason==='ORDER_NOT_PACKED')source.unavailable_reason='SHIPPING_ALREADY_STARTED';
 return true;
}
// Public read projection only: ordinary full cancellation does not mutate SQL137 counters.
function projectedParcelReleased(quantity:number,consumed:number,counter:number,ordinaryReleased:boolean){
 ensure(Number.isSafeInteger(quantity)&&Number.isSafeInteger(consumed)&&Number.isSafeInteger(counter)&&quantity>=0&&consumed>=0&&counter>=0&&consumed+counter<=quantity,503,incomplete);
 return ordinaryReleased?quantity-consumed:counter;
}
export async function orderParcelSource(a:V.OrderParcelActor,orderId:string){orderId=V.parcelUuid.parse(orderId);return tx(a,false,async c=>{
 const warehouses=await lockOperationalParcelInTx(c,a,orderId);
 await enlistOperationalParcelInTx(c,a,orderId,randomUUID(),false);
 const source=(await c.query('SELECT order_parcel_source($1) source',[orderId])).rows[0].source as V.OrderParcelSource;
 await assertParcelWarehouses(c,orderId,warehouses);
 const commercial_available=await orderParcelCommercialOriginsAvailable(c);
 const commercial_lines=commercial_available?(await c.query('SELECT order_parcel_commercial_lines($1) lines',[orderId])).rows[0].lines:[];
 const ordinaryCancelled=source.active_plan_id===null&&source.order.status==='cancelled';
 const cancelled=source.active_plan_id?await orderParcelCancelledInTx(c,source.active_plan_id):new Map<number,string>();
 if(commercial_available&&source.active_plan_id){
  const commercialPlan=(await c.query("SELECT payload->>'protocol' protocol FROM order_parcel_plans WHERE id=$1",[source.active_plan_id])).rows[0]?.protocol==='commercial_v1';
  const totals=(await c.query(`SELECT o.item_id,coalesce(sum(i.quantity),0)::integer issued,coalesce(sum(o.quantity) FILTER(WHERE o.parcel_index=ANY($2::integer[])),0)::integer cancelled FROM order_parcel_commercial_origins o LEFT JOIN order_parcel_origin_issues i ON(i.tenant_id,i.origin_id)=(o.tenant_id,o.id) WHERE o.plan_id=$1 GROUP BY o.item_id`,[source.active_plan_id,[...cancelled.keys()]])).rows;
  for(const line of commercial_lines){const t=totals.find(t=>t.item_id===line.item_id);line.origin_available=commercialPlan;line.issued=commercialPlan?(t?.issued??0):null;line.cancelled=commercialPlan?(t?.cancelled??0):null;line.pending=commercialPlan?line.quantity-line.issued-line.cancelled:null;}
 }else for(const line of commercial_lines){line.origin_available=true;line.issued=0;line.cancelled=ordinaryCancelled?line.quantity:0;line.pending=line.quantity-line.cancelled;}
 // Public remaining projection may include137; never change the frozen151 SQL frame.
 const counters=(await c.query(`SELECT product_id,warehouse_id,state,coalesce((to_jsonb(r)->>'released_quantity')::integer,0) released_quantity FROM reservations r WHERE order_id=$1`,[orderId])).rows;
 const locationCounters=(await c.query(`SELECT product_id,location,coalesce((to_jsonb(r)->>'released_quantity')::integer,0) released_quantity FROM reservation_locations r WHERE order_id=$1`,[orderId])).rows;
 const layerCounters=(await c.query(`SELECT product_id,layer_id,location,state,coalesce((to_jsonb(r)->>'released_quantity')::integer,0) released_quantity FROM wms_reservation_layers r WHERE order_id=$1`,[orderId])).rows;
 for(const product of source.products){const r=counters.find(r=>r.product_id===product.product_id),ordinaryReleased=ordinaryCancelled&&r?.state==='released';product.released_quantity=projectedParcelReleased(product.quantity,product.consumed_quantity,r?.released_quantity??0,ordinaryReleased);product.remaining=product.quantity-product.consumed_quantity-product.released_quantity;
  for(const location of product.locations??[]){location.released_quantity=projectedParcelReleased(location.quantity,location.consumed_quantity,locationCounters.find(r=>r.product_id===product.product_id&&r.location===location.location)?.released_quantity??0,ordinaryReleased);location.remaining=location.quantity-location.consumed_quantity-location.released_quantity;}
  for(const layer of product.layers??[]){const hold=layerCounters.find(r=>r.product_id===product.product_id&&r.layer_id===layer.layer_id&&r.location===layer.location);layer.released_quantity=projectedParcelReleased(layer.quantity,layer.consumed_quantity,hold?.released_quantity??0,ordinaryReleased&&hold?.state==='released');layer.remaining=layer.quantity-layer.consumed_quantity-layer.released_quantity;}
 }
 // Existing legacy whole-order dispatch closes reservation state, not parcel-only counters.
 if(source.active_plan_id===null&&source.shipments.some(s=>s.dispatched_at)){
  const stockIssues=(await c.query(`SELECT product_id,warehouse_id,sum(-delta)::bigint::text quantity,count(*)::integer rows FROM stock_movements WHERE order_id=$1 AND tenant_id=$2 AND kind='shipment' GROUP BY product_id,warehouse_id`,[orderId,a.tenantId])).rows;
  const locationIssues=(await c.query(`SELECT product_id,warehouse_id,location,sum(-delta)::bigint::text quantity,count(*)::integer rows FROM stock_location_movements WHERE order_id=$1 AND tenant_id=$2 AND kind='shipment' GROUP BY product_id,warehouse_id,location`,[orderId,a.tenantId])).rows;
  const layerIssues=(await c.query(`SELECT f.product_id,f.warehouse_id,f.location,f.layer_id,h.state hold_state,sum(f.quantity)::bigint::text quantity,count(*) FILTER(WHERE (SELECT count(*) FROM wms_layer_movements m WHERE (m.tenant_id,m.operation_id,m.product_id,m.warehouse_id,m.location,m.layer_id)=(f.tenant_id,f.operation_id,f.product_id,f.warehouse_id,f.location,f.layer_id) AND m.kind='dispatch' AND m.delta=-f.quantity)<>1)::integer bad_journals FROM wms_issue_fragments f JOIN wms_reservation_layers h ON(h.tenant_id,h.order_id,h.product_id,h.warehouse_id,h.location,h.layer_id)=(f.tenant_id,f.order_id,f.product_id,f.warehouse_id,f.location,f.layer_id) WHERE f.order_id=$1 AND f.tenant_id=$2 GROUP BY f.product_id,f.warehouse_id,f.location,f.layer_id,h.state`,[orderId,a.tenantId])).rows;
  projectLegacyWholeOrderIssue(source,commercial_lines,counters,stockIssues,locationIssues,layerIssues);
 }
 const f=await flags(c,a,false);return {source:{...source,commercial_available,commercial_lines,can_preview:source.can_preview&&f.can_write},limits:V.ORDER_PARCEL_LIMITS,...f};
 });}
export async function createOrderParcelPreview(a:V.OrderParcelActor,orderId:string,input:unknown){orderId=V.parcelUuid.parse(orderId);const b=V.orderParcelPreviewInput.parse(input);return tx(a,true,async c=>{if('protocol' in b)ensure(await orderParcelCommercialOriginsAvailable(c),503,'Kopia nie zawiera pochodzenia handlowego paczek');const warehouses=await lockOperationalParcelInTx(c,a,orderId);const prior=(await c.query('SELECT id FROM order_parcel_previews WHERE client_key=$1',[b.client_key])).rows[0];if(!prior)await enlistOperationalParcelInTx(c,a,orderId,b.client_key,true);const id=(await c.query('SELECT order_parcel_store_preview($1,$2,$3,$4,$5) id',[randomUUID(),orderId,b,a.userId,a.apiKeyId??null])).rows[0].id;// After the SQL lock of the order's shipments: a cancelled label is no parcel source.
 await assertLabelsNotCancelledInTx(c,b.parcels.flatMap(p=>p.shipment_id?[p.shipment_id]:[]),CANCELLED_PARCEL_REFUSAL);await assertParcelWarehouses(c,orderId,warehouses);await preparePimPublicConstraintsInTx(c);const preview=await previewView(c,id);const f=await flags(c,a,true);return {preview:{...preview,can_apply:preview.can_apply&&f.can_write},reused:Boolean(prior),...f};});}
export async function orderParcelPreviewDetail(a:V.OrderParcelActor,id:string){id=V.parcelUuid.parse(id);return tx(a,false,async c=>{const preview=await previewView(c,id);const p=await row(c,'order_parcel_previews',id);const f=await flags(c,a,false);return {preview:{...preview,can_apply:preview.can_apply&&f.can_write&&p.actor_id===a.userId&&p.api_key_id===(a.apiKeyId??null)},...f};});}
export async function applyOrderParcelPlan(a:V.OrderParcelActor,id:string,input:unknown){id=V.parcelUuid.parse(id);const b=V.orderParcelApplyInput.parse(input);return tx(a,true,async c=>{const head=await row(c,'order_parcel_previews',id),frozenIds=frozenWarehouseIds(head.payload),warehouses=await lockOperationalParcelInTx(c,a,head.order_id,frozenIds);const prior=(await c.query('SELECT id FROM order_parcel_plans WHERE client_key=$1',[b.client_key])).rows[0];if(!prior)await enlistOperationalParcelInTx(c,a,head.order_id,b.client_key,true);const eid=(await c.query('SELECT order_parcel_apply($1,$2,$3,$4,$5) id',[id,randomUUID(),b,a.userId,a.apiKeyId??null])).rows[0].id;await assertLabelsNotCancelledInTx(c,head.payload.parcels.flatMap((p:{source_kind:string;shipment_id:string})=>p.source_kind==='existing'?[p.shipment_id]:[]),CANCELLED_PARCEL_REFUSAL);await assertParcelWarehouses(c,head.order_id,warehouses,frozenIds);if(!prior)await audit(c,a,'order.parcels.apply',eid);await preparePimPublicConstraintsInTx(c);const plan=await planView(c,eid);return {plan,reused:Boolean(prior),...await flags(c,a,true)};});}
export async function orderParcelPlanDetail(a:V.OrderParcelActor,id:string){id=V.parcelUuid.parse(id);return tx(a,false,async c=>{const plan=await planView(c,id);const dispatches=(await c.query('SELECT * FROM order_parcel_dispatches WHERE plan_id=$1 ORDER BY parcel_index',[id])).rows.map(dispatchView);return {plan,dispatches,...await flags(c,a,false)};});}
/** Same-client sibling entrypoint: the original HTTP request must have been
 * authenticated by the app before capture. Native access and managed admission
 * remain mandatory; this function neither begins nor commits a transaction. */
const dispatchAuthorities=new WeakMap<V.OrderParcelActor,PoolClient|null>();
export function captureOrderParcelDispatchAuthority(req:BuyerAddressRequest,sessionName:string):V.OrderParcelActor{
 const actor=capturePhysicalParcelWzAuthority(req,sessionName,captureOperationalDeliveryAuthority(req,sessionName));
 dispatchAuthorities.set(actor,null);return actor;
}
export async function dispatchOrderParcelInTx(c:PoolClient,a:V.OrderParcelActor,id:string,index:number,input:unknown){
 id=V.parcelUuid.parse(id);index=V.orderParcelIndex.parse(index);const b=V.orderParcelDispatchInput.parse(input);
 const bound=dispatchAuthorities.get(a);
 ensure(bound!==undefined,401,'Wydanie wymaga przechwyconego żądania HTTP');
 ensure(bound===null||bound===c,409,'Klient przechwyconego wydania zmienił się');
 // Existing managed WeakMap rejects another/unmanaged/finalized client before SQL.
 enlistDispatchActorInTx(c,a,['orders:read','orders:write']);
 dispatchAuthorities.set(a,c);
 const context=(await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant,current_setting('transaction_read_only') read_only")).rows[0];
 ensure(context.role==='dyna_app'&&context.tenant===a.tenantId&&context.read_only==='off',403,'Zakres zarządzanego wydania zmienił się');
 ensure(await orderParcelsAvailable(c),503,incomplete);await orderParcelCommercialOriginsAvailable(c);await access(c,a,true);
 return dispatchOrderParcelWorkInTx(c,a,id,index,b);
}
async function dispatchOrderParcelWorkInTx(c:PoolClient,a:V.OrderParcelActor,id:string,index:number,b:V.OrderParcelApplyInput){
  const operationalActor=a;
  a=enlistDispatchActorInTx(c,a,['orders:read','orders:write']);
  a=enlistWmsActorInTx(c,a,{orders:true});
  const head=await row(c,'order_parcel_plans',id),frozenIds=frozenWarehouseIds(head.payload);
  const warehouses=await lockOperationalParcelInTx(c,operationalActor,head.order_id,frozenIds);
  const prior=(await c.query('SELECT id FROM order_parcel_dispatches WHERE client_key=$1',[b.client_key])).rows[0];
  if(!prior){await enlistOperationalParcelInTx(c,operationalActor,head.order_id,b.client_key,true);await enlistPhysicalParcelWzDispatchInTx(c,operationalActor,id,index,b.client_key);}
  const proposed=randomUUID(),parcel=head.payload.parcels[index];
  ensure(parcel&&parcel.index===index,404,'Nie znaleziono paczki planu');
  const source={kind:'parcel' as const,order_id:head.order_id as string,plan_id:id,
    parcel_index:index,shipment_id:parcel.shipment_id as string,dispatch_id:proposed};
  const wz=await prepareAutomaticWzInTx(c,a,source);
  const eid=(await c.query('SELECT order_parcel_prepare_dispatch($1,$2,$3,$4,$5,$6) id',
    [id,index,proposed,b,a.userId,a.apiKeyId??null])).rows[0].id;
  await assertParcelWarehouses(c,head.order_id,warehouses,frozenIds);
  const reused=eid!==proposed;
  if(!reused){
   const scope=(await c.query('SELECT order_parcel_dispatch_scope($1,$2,$3,$4,$5) r',
     [id,index,eid,a.userId,a.apiKeyId??null])).rows[0].r;
   ensure(scope.order_id===head.order_id&&scope.parcel.shipment_id===source.shipment_id&&
     frozenIds.every(id=>warehouses.includes(id))&&scope.parcel.products.every((p:{warehouse_id:string})=>warehouses.includes(p.warehouse_id)),
     409,'Zakres wydania zmienił magazyny lub przesyłkę');
   const receipt=await consumeOrderParcelInTx(c,a,{operation_id:eid,plan_id:id,parcel_index:index,
     shipment_id:scope.parcel.shipment_id,order_id:scope.order_id,allocations:scope.parcel.products});
   await c.query('SELECT order_parcel_finish_dispatch($1,$2,$3,$4)',[eid,receipt,a.userId,a.apiKeyId??null]);
   await event(c,a.tenantId,scope.order_id,'order.parcel.dispatched',
     {plan_id:id,parcel_index:index,shipment_id:scope.parcel.shipment_id,dispatch_id:eid});
   await audit(c,a,'order.parcel.dispatch',eid);
   const physical={stock_movements:receipt.stock_movements,location_movements:receipt.location_movements,
     wms:receipt.wms};
   await finishAutomaticWzInTx(c,a,wz,{source,physical});
  }
  await preparePimPublicConstraintsInTx(c);
  const plan=await planView(c,id),dispatch=dispatchView(await row(c,'order_parcel_dispatches',eid));
  return {plan,dispatch,reused,...await flags(c,a,true)};
}
export async function dispatchOrderParcel(a:V.OrderParcelActor,id:string,index:number,input:unknown) {
 id=V.parcelUuid.parse(id);index=V.orderParcelIndex.parse(index);
 const b=V.orderParcelDispatchInput.parse(input);
 return tx(a,true,c=>dispatchOrderParcelWorkInTx(c,a,id,index,b));
}
export async function orderParcelHistory(a:V.OrderParcelActor,orderId:string,input:unknown){orderId=V.parcelUuid.parse(orderId);const q=V.orderParcelHistoryInput.parse(input);return tx(a,false,async c=>{await row(c,'orders',orderId);const table=q.kind==='preview'?'order_parcel_previews':'order_parcel_plans';if(q.cursor)ensure((await c.query(`SELECT id FROM ${table} WHERE order_id=$1 AND id=$2`,[orderId,q.cursor])).rowCount,404,'Kursor nie należy do historii zamówienia');const rows=(await c.query(`SELECT id,order_id,scope_hash,payload->'summary' summary,created_at,${q.kind==='preview'?'expires_at':'preview_id'} FROM ${table} WHERE order_id=$1 AND($2::uuid IS NULL OR(created_at,id)<(SELECT created_at,id FROM ${table} WHERE order_id=$1 AND id=$2)) ORDER BY created_at DESC,id DESC LIMIT $3`,[orderId,q.cursor??null,q.limit+1])).rows;const data=rows.slice(0,q.limit).map(r=>({...r,kind:q.kind,created_at:iso(r.created_at),...(r.expires_at?{expires_at:iso(r.expires_at)}:{})}));return {data,next_cursor:rows.length>q.limit?data.at(-1)!.id:null,...await flags(c,a,false)};});}
