/** Saved Native210 data → explicit public DTOs. Pure binding/conservation checks,
 * NOT current IAM, catalogue/transaction authority or a registered endpoint.
 * The caller must obtain these ORIGINAL immutable rows through authorized reads.
 * No current order, private snapshot, credential, portal token or custody/cost
 * record is returned. Arrays are complete; future routes paginate these rows.
 * Native JSON bigint versions must still be safe integers here. Full int64
 * versions require a future DB text projection before ordinary JSON parsing. */
import {createHash} from 'node:crypto';
import {ORDER_SPLIT_LIMITS as L, orderSplitPreviewInput, orderSplitExecuteInput} from './order-splits-schema';
import {localInvoiceLineAmounts} from './local-invoice-values';

export type SplitPublicContext = {tenant_id:string; actor_id:string; api_key_id:null};
/** Selected actual columns of immutable210 records. Other real private columns
 * may be present in DB rows; projections never spread them into public output. */
export type Native210PreviewRecord = {
  tenant_id:string; id:string; actor_id:string; api_key_id:string|null; client_key:string; request:unknown;
  source_order_id:string; source_version:string; scope_hash:string; snapshot:unknown; plan:unknown;
};
export type Native210SourceRow = {tenant_id:string;preview_id:string;source_item_id:string;source_order_id:string;row_data:unknown};
export type Native210ExecutionRecord = {
  tenant_id:string;id:string;preview_id:string;actor_id:string;api_key_id:string|null;client_key:string;request:unknown;
  source_order_id:string;source_version:string;result_source_version:string;scope_hash:string;before_frame:unknown;after_frame:unknown;
};
export type Native210TargetRow = {tenant_id:string;execution_id:string;preview_id:string;result_index:number;slot_id:string|null;order_id:string;source_order_id:string;name:string|null;delivery_minor:number;total_minor:number};
export type Native210AllocationRow = {tenant_id:string;execution_id:string;preview_id:string;result_index:number;source_item_id:string;target_item_id:string;product_id:string;quantity:number;from_quantity:number;to_quantity:number;gross_minor:number;net_minor:number;vat_minor:number;payload:unknown};
type PreviewInput = {preview:Native210PreviewRecord;source_rows:Native210SourceRow[]};
type ExecutionInput = PreviewInput & {execution:Native210ExecutionRecord;targets:Native210TargetRow[];allocations:Native210AllocationRow[]};
export class OrderSplitPublicError extends Error {constructor(){super('Nie można potwierdzić kompletnego oryginalnego wyniku podziału.');this.name='OrderSplitPublicError';}}
function need(v:unknown):asserts v {if(!v)throw new OrderSplitPublicError();}
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const same=(a:unknown,b:unknown)=>need(canonical(a)===canonical(b));
function budget(v:unknown,max:number){let s;try{s=JSON.stringify(v);}catch{throw new OrderSplitPublicError();}need(s!==undefined&&Buffer.byteLength(s)<=max);}
function object(v:any){need(v&&typeof v==='object'&&!Array.isArray(v));return v as Record<string,any>;}
function exact(v:any,keys:string[]){object(v);same(Object.keys(v).sort(),[...keys].sort());}
function uuid(v:unknown):asserts v is string {need(typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v));}
function version(v:unknown):asserts v is string {need(typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n);}
// PostgreSQL to_jsonb(bigint) is a JSON number; pg's standalone bigint column is
// a string. Reject already-rounded JSON numbers instead of inventing precision.
function snapshotVersion(v:unknown,expected:string){need(typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&String(v)===expected);}
function int(v:unknown,max:number=L.money_minor,min=0):asserts v is number {need(Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max);}
function array(v:any,max:number,min=0):asserts v is any[] {need(Array.isArray(v)&&v.length>=min&&v.length<=max);}
function text(v:unknown,max=4096):asserts v is string {need(typeof v==='string'&&v.length<=max);}
function hash(v:unknown){need(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v));}
function freeze<T>(v:T):T {if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function generated(seed:string,label:string){const h=createHash('sha256').update('order.split210:'+seed+':'+label).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-8'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
function context(c:SplitPublicContext,row:{tenant_id:string;actor_id:string;api_key_id:string|null}){exact(c,['tenant_id','actor_id','api_key_id']);uuid(c.tenant_id);uuid(c.actor_id);need(c.api_key_id===null&&row.tenant_id===c.tenant_id&&row.actor_id===c.actor_id&&row.api_key_id===null);}
function amounts(g:number,vat:number){const a=localInvoiceLineAmounts(BigInt(g),vat);return{gross_minor:g,net_minor:Number(a.net_minor),vat_minor:Number(a.vat_minor)};}

function validatePreview(c:SplitPublicContext,input:PreviewInput){
 budget(input,64*1024*1024);const p=input.preview;object(p);context(c,p);uuid(p.id);uuid(p.client_key);uuid(p.source_order_id);version(p.source_version);hash(p.scope_hash);
 const parsed=orderSplitPreviewInput.safeParse(p.request);need(parsed.success);const request=parsed.data;same(request,p.request);need(request.client_key===p.client_key&&request.source_order_id===p.source_order_id&&request.expected_source_version===p.source_version);
 budget(p.snapshot,L.source_bytes);budget(p.plan,L.output_bytes);const snapshot=object(p.snapshot),o=object(snapshot.order),plan=object(p.plan);
 need(o.tenant_id===c.tenant_id&&o.id===p.source_order_id);snapshotVersion(o.version,p.source_version);text(o.currency,3);need(['PLN','EUR','USD','GBP','CZK'].includes(o.currency));int(o.shipping_cost,L.delivery_minor);int(o.total);
 array(snapshot.items,L.source_lines,1);array(input.source_rows,L.source_lines,1);need(input.source_rows.length===snapshot.items.length);
 const originals=new Map<string,any>(),archive=new Map<string,Native210SourceRow>();
 for(const row of input.source_rows){exact(row,['tenant_id','preview_id','source_item_id','source_order_id','row_data']);need(row.tenant_id===c.tenant_id&&row.preview_id===p.id&&row.source_order_id===p.source_order_id);uuid(row.source_item_id);need(!archive.has(row.source_item_id));archive.set(row.source_item_id,row);}
 let originalGross=0n;
 for(const row of snapshot.items){object(row);uuid(row.id);uuid(row.product_id);need(row.tenant_id===c.tenant_id&&row.order_id===o.id&&!originals.has(row.id));int(row.quantity,L.quantity,1);int(row.price,L.unit_price_minor);int(row.line_total);need([0,5,8,23].includes(row.vat));text(row.name);text(row.sku);
  need(archive.has(row.id));same(archive.get(row.id)!.row_data,row);originals.set(row.id,row);originalGross+=BigInt(row.line_total);
 }
 need(originalGross+BigInt(o.shipping_cost)===BigInt(o.total));
 exact(plan,['schema','ready','conflicts','results','shipping_tax','custody']);need(plan.schema==='order-split210-commercial-plan/v1'&&typeof plan.ready==='boolean'&&plan.shipping_tax==='not_allocated');object(plan.custody);
 array(plan.results,L.results,2);need(plan.results.length===request.children.length+1);array(plan.conflicts,L.allocation_rows*2);
 const children=[...request.children].sort((a,b)=>a.slot_id<b.slot_id?-1:1),seenOrders=new Set<string>(),seenItems=new Set<string>(),intervals=new Map<string,number>();
 const totalsByLine=new Map<string,{q:bigint;g:bigint;n:bigint;v:bigint}>(),expectedConflicts:any[]=[],rowsByResult:any[][]=[];
 let shipping=0n,grossTotal=0n,netTotal=0n,vatTotal=0n,totalRows=0;
 for(let index=0;index<plan.results.length;index++){
  const r=plan.results[index],retained=index===children.length,child=children[index];exact(r,['kind','slot_id','order_id','name','delivery_minor','items','result_index','items_gross_minor','items_net_minor','items_vat_minor','total_minor']);
  need(r.result_index===index&&r.kind===(retained?'retained_source':'child')&&r.slot_id===(retained?null:child.slot_id)&&r.name===(retained?null:child.name));uuid(r.order_id);need(r.order_id===(retained?o.id:generated(p.id,'order:'+child.slot_id))&&!seenOrders.has(r.order_id));seenOrders.add(r.order_id);
  int(r.delivery_minor,L.delivery_minor);if(!retained)need(r.delivery_minor===child.delivery_minor);shipping+=BigInt(r.delivery_minor);
  array(r.items,L.allocation_rows,1);totalRows+=r.items.length;need(totalRows<=L.allocation_rows);
  const quantities=new Map<string,number>();for(const item of retained?snapshot.items:child.items)quantities.set(retained?item.id:item.source_item_id,retained?item.quantity:item.quantity);
  const expectedIDs=retained?[...originals.keys()].filter(id=>(intervals.get(id)??0)<originals.get(id).quantity):[...quantities.keys()];
  same(r.items.map((a:any)=>a.source_item_id),expectedIDs.sort());
  let g=0n,n=0n,v=0n;const safeRows:any[]=[];
  for(const a of r.items){
   exact(a,['source_item_id','target_item_id','product_id','quantity','price','vat','from_quantity','to_quantity','gross_minor','net_minor','vat_minor','price_adjustment_minor','original_quantity','original_price','original_gross_minor','original_net_minor','original_vat_minor']);
   const original=originals.get(a.source_item_id);need(original);const start=intervals.get(a.source_item_id)??0,q=retained?original.quantity-start:quantities.get(a.source_item_id);int(q,L.quantity,1);
   need(a.product_id===original.product_id&&a.quantity===q&&a.price===original.price&&a.vat===original.vat&&a.from_quantity===start&&a.to_quantity===start+q);intervals.set(a.source_item_id,start+q);need(start+q<=original.quantity);
   const expectedId=retained?original.id:generated(p.id,'item:'+r.slot_id+':'+original.id);need(a.target_item_id===expectedId&&!seenItems.has(expectedId));seenItems.add(expectedId);
   const old=amounts(original.line_total,original.vat);need(a.original_quantity===original.quantity&&a.original_price===original.price&&a.original_gross_minor===old.gross_minor&&a.original_net_minor===old.net_minor&&a.original_vat_minor===old.vat_minor);
   int(a.gross_minor);int(a.net_minor);int(a.vat_minor);need(a.gross_minor===a.net_minor+a.vat_minor);
   const Q=BigInt(original.quantity),G=BigInt(old.gross_minor),N=BigInt(old.net_minor),g0=G*BigInt(start)/Q,g1=G*BigInt(start+q)/Q;
   need(BigInt(a.gross_minor)===g1-g0&&BigInt(a.net_minor)===(G===0n?0n:N*g1/G-N*g0/G));
   const adjustment=BigInt(a.gross_minor)-BigInt(a.price)*BigInt(q);need(Number.isSafeInteger(a.price_adjustment_minor)&&BigInt(a.price_adjustment_minor)===adjustment);
   if(a.vat_minor!==amounts(a.gross_minor,a.vat).vat_minor)expectedConflicts.push({code:'VAT_ROUNDING_CONFLICT',source_item_id:original.id,slot_id:r.slot_id});
   if(adjustment>=BigInt(q))expectedConflicts.push({code:'INVOICE_LINE_ROUNDING_CONFLICT',source_item_id:original.id,slot_id:r.slot_id});
   const t=totalsByLine.get(original.id)??{q:0n,g:0n,n:0n,v:0n};t.q+=BigInt(q);t.g+=BigInt(a.gross_minor);t.n+=BigInt(a.net_minor);t.v+=BigInt(a.vat_minor);totalsByLine.set(original.id,t);
   g+=BigInt(a.gross_minor);n+=BigInt(a.net_minor);v+=BigInt(a.vat_minor);
   safeRows.push({source_item_id:original.id,target_item_id:expectedId,product_id:original.product_id,name:original.name,sku:original.sku,quantity:q,price:a.price,vat:a.vat,gross_minor:a.gross_minor,net_minor:a.net_minor,vat_minor:a.vat_minor,price_adjustment_minor:a.price_adjustment_minor,original_quantity:original.quantity,original_gross_minor:old.gross_minor,original_net_minor:old.net_minor,original_vat_minor:old.vat_minor});
  }
  need(BigInt(r.items_gross_minor)===g&&BigInt(r.items_net_minor)===n&&BigInt(r.items_vat_minor)===v&&BigInt(r.total_minor)===g+BigInt(r.delivery_minor));for(const k of ['items_gross_minor','items_net_minor','items_vat_minor','total_minor'])int(r[k]);
  rowsByResult.push(safeRows);grossTotal+=g;netTotal+=n;vatTotal+=v;
 }
 for(const original of originals.values()){const t=totalsByLine.get(original.id),old=amounts(original.line_total,original.vat);need(t&&t.q===BigInt(original.quantity)&&t.g===BigInt(old.gross_minor)&&t.n===BigInt(old.net_minor)&&t.v===BigInt(old.vat_minor));}
 need(shipping===BigInt(o.shipping_cost)&&grossTotal===originalGross&&grossTotal+shipping===BigInt(o.total));
 // Native loops original item UUID first, result index second. Compare the exact
 // conflict multiset without requiring that incidental loop order in the DTO.
 const conflictKey=(v:any)=>canonical(v);same([...plan.conflicts].map(conflictKey).sort(),expectedConflicts.map(conflictKey).sort());need(plan.ready===(expectedConflicts.length===0));
 const remaining=plan.results.at(-1),childrenRows=plan.results.slice(0,-1).map((r:any)=>({slot_id:r.slot_id,order_id:r.order_id,delivery_minor:r.delivery_minor,items:r.items.map((a:any)=>({source_item_id:a.source_item_id,quantity:a.quantity}))}));
 const sourceItems=[...originals.values()].sort((a,b)=>a.id<b.id?-1:1).map(row=>({source_item_id:row.id,before_quantity:row.quantity,remaining_quantity:remaining.items.find((a:any)=>a.source_item_id===row.id)?.quantity??0}));
 const commercial={schema:'order-split-commercial-review/v1' as const,currency:o.currency,ready:plan.ready,shipping_tax:'not_allocated' as const,conflicts:expectedConflicts.map(v=>({...v})),original:{items_gross_minor:Number(grossTotal),items_net_minor:Number(netTotal),items_vat_minor:Number(vatTotal),delivery_minor:o.shipping_cost,total_minor:o.total},results:plan.results.map((r:any,i:number)=>({kind:r.kind,slot_id:r.slot_id,order_id:r.order_id,name:r.name,items:rowsByResult[i],items_gross_minor:r.items_gross_minor,items_net_minor:r.items_net_minor,items_vat_minor:r.items_vat_minor,delivery_minor:r.delivery_minor,total_minor:r.total_minor}))};
 return{p,request,snapshot,plan,originals,children:childrenRows,sourceItems,commercial,remaining};
}

function result(v:ReturnType<typeof validatePreview>,operation:'preview'|'execute',row:Native210PreviewRecord|Native210ExecutionRecord){
 const execution=operation==='execute',version=execution?(row as Native210ExecutionRecord).result_source_version:v.p.source_version;
 const head={id:row.id,source_order_id:v.p.source_order_id,source_version:v.p.source_version,source_result_version:version,scope_hash:v.p.scope_hash,children:v.children.map(c=>({slot_id:c.slot_id,order_id:c.order_id})),...(execution?{preview_id:v.p.id,state:'done' as const}:{ready:v.plan.ready as boolean})};
 const output={command:{tenant_id:row.tenant_id,actor_id:row.actor_id,api_key_id:null,operation,client_key:row.client_key,request:structuredClone(row.request),[execution?'execution':'preview']:head},head,source:{order_id:v.p.source_order_id,version,item_count:v.sourceItems.length,shipping_cost:v.remaining.delivery_minor},source_items:v.sourceItems,children:v.children,commercial:v.commercial};
 budget(output,L.output_bytes);return freeze(output);
}
export function projectOrderSplitPreview(c:SplitPublicContext,input:PreviewInput){try{return result(validatePreview(c,input),'preview',input.preview);}catch{throw new OrderSplitPublicError();}}
export function projectOrderSplitExecution(c:SplitPublicContext,input:ExecutionInput){try{
 const v=validatePreview(c,input),e=input.execution;object(e);context(c,e);uuid(e.id);uuid(e.client_key);version(e.source_version);version(e.result_source_version);need(BigInt(e.result_source_version)===BigInt(e.source_version)+1n&&e.source_order_id===v.p.source_order_id&&e.source_version===v.p.source_version&&e.preview_id===v.p.id&&e.scope_hash===v.p.scope_hash&&v.plan.ready===true);
 const parsed=orderSplitExecuteInput.safeParse(e.request);need(parsed.success);same(parsed.data,e.request);need(parsed.data.client_key===e.client_key&&parsed.data.preview_id===v.p.id&&parsed.data.scope_hash===v.p.scope_hash);same(e.before_frame,v.p.snapshot);budget(e.after_frame,2*L.source_bytes);
 array(input.targets,L.results,2);array(input.allocations,L.allocation_rows,1);need(input.targets.length===v.plan.results.length&&input.allocations.length===v.plan.results.reduce((n:number,r:any)=>n+r.items.length,0));
 const targets=new Map<number,Native210TargetRow>(),allocations=new Map<string,Native210AllocationRow>();
 for(const t of input.targets){exact(t,['tenant_id','execution_id','preview_id','result_index','slot_id','order_id','source_order_id','name','delivery_minor','total_minor']);need(t.tenant_id===c.tenant_id&&t.execution_id===e.id&&t.preview_id===v.p.id&&t.source_order_id===v.p.source_order_id&&!targets.has(t.result_index));targets.set(t.result_index,t);}
 for(const a of input.allocations){exact(a,['tenant_id','execution_id','preview_id','result_index','source_item_id','target_item_id','product_id','quantity','from_quantity','to_quantity','gross_minor','net_minor','vat_minor','payload']);int(a.result_index,L.results-1);const key=a.result_index+':'+a.source_item_id;need(a.tenant_id===c.tenant_id&&a.execution_id===e.id&&a.preview_id===v.p.id&&!allocations.has(key));allocations.set(key,a);}
 const after=object(e.after_frame);array(after.orders,L.results,2);array(after.items,L.allocation_rows,1);need(after.orders.length===input.targets.length&&after.items.length===input.allocations.length);const orders=new Map<string,any>(),items=new Map<string,any>();
 for(const o of after.orders){object(o);uuid(o.id);need(o.tenant_id===c.tenant_id&&!orders.has(o.id));orders.set(o.id,o);}
 for(const i of after.items){object(i);uuid(i.id);need(i.tenant_id===c.tenant_id&&!items.has(i.id));items.set(i.id,i);}
 for(const r of v.plan.results){const t=targets.get(r.result_index),o=orders.get(r.order_id);need(t&&o);same(t,{tenant_id:c.tenant_id,execution_id:e.id,preview_id:v.p.id,result_index:r.result_index,slot_id:r.slot_id,order_id:r.order_id,source_order_id:v.p.source_order_id,name:r.name,delivery_minor:r.delivery_minor,total_minor:r.total_minor});snapshotVersion(o.version,r.slot_id===null?e.result_source_version:'1');need(o.shipping_cost===r.delivery_minor&&o.total===r.total_minor&&o.currency===v.snapshot.order.currency);
  for(const a of r.items){const saved=allocations.get(r.result_index+':'+a.source_item_id),i=items.get(a.target_item_id),original=v.originals.get(a.source_item_id);need(saved&&i);same(saved.payload,a);for(const k of ['target_item_id','product_id','quantity','from_quantity','to_quantity','gross_minor','net_minor','vat_minor'] as const)need(saved[k]===a[k]);need(i.order_id===r.order_id&&i.product_id===a.product_id&&i.quantity===a.quantity&&i.price===a.price&&i.vat===a.vat&&i.line_total===a.gross_minor&&i.name===original.name&&i.sku===original.sku);}
 }
 return result(v,'execute',e);
}catch{throw new OrderSplitPublicError();}}
