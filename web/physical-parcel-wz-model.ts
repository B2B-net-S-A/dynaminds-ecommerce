/** SOURCE_DRAFT / NOT_ADOPTED. Browser-only pure editor; no IAM, endpoint,
 * receipt, native hash or apply authority. Inputs must come from the genuine
 * scoped source. A complete result is a preview request, never consent/apply. */
export const PHYSICAL_WZ_UI_LIMITS = { parcels:50, items:500, physical_entries:500, mapping_entries:5000, bytes:4194304, count:1000000000 } as const;
export type PhysicalWzProduct = {product_id:string;warehouse_id:string;quantity:number};
export type PhysicalWzItem = {item_id:string;product_id:string;name:string;sku:string;quantity:number;line_total:number;vat:number;currency:string;components:{product_id:string;quantity:number}[]};
export type PhysicalWzUiSource = {
 tenant_id:string;order_id:string;order_version:string;plan_id:string;plan_scope_hash:string;protocol:'physical_v1';currency:string;revision:string;
 approved_mapping_id:string|null;approved_at:string|null;items:PhysicalWzItem[];
 reservations:(PhysicalWzProduct&{consumed_quantity:number;state:'active'|'consumed'})[];
 parcels:{parcel_index:number;shipment_id:string;products:PhysicalWzProduct[]}[];
 progress:{parcel_index:number;shipment_id:string;state:'pending'|'dispatched';dispatch_id:string|null;issued_products:PhysicalWzProduct[]}[];
};
export type PhysicalWzUiScope = {contextKey:string;tenant_id:string;order_id:string;plan_id:string;readOnly:boolean};
export type PhysicalWzDraftRow = {key:string;item_id:string;product_id:string;quantity:string};
export type PhysicalWzUiDraft = {source:PhysicalWzUiSource;scope:PhysicalWzUiScope;parcels:{parcel_index:number;shipment_id:string;rows:PhysicalWzDraftRow[]}[]};
export type PhysicalWzIssue = {code:string;parcel_index?:number;item_id?:string;product_id?:string;expected?:string;actual?:string};
export type PhysicalWzPreviewRequest = {client_key:string;revision:string;parcels:{parcel_index:number;shipment_id:string;components:{item_id:string;product_id:string;quantity:number}[]}[]};
export class PhysicalWzUiModelError extends Error {constructor(public readonly issues:readonly PhysicalWzIssue[]){super(issues.map(i=>i.code).join(', '));}}
const fail=(code:string):never=>{throw new PhysicalWzUiModelError([{code}]);};
const need=(ok:unknown,code:string):void=>{if(!ok)fail(code);};
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
const digest=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const integer=(n:unknown,min:number,max:number):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=min&&n<=max;
const historicalText=(s:unknown,max:number)=>typeof s==='string'&&s.length>0&&s.length<=max;
const text=(s:unknown,max:number)=>typeof s==='string'&&s.length>0&&s.length<=max&&!/[\x00-\x1f\x7f]/.test(s);
function exact(v:unknown,keys:string[]){need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===keys.sort().join('|'),'source_shape');}
function canonical(v:unknown):unknown{return Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;}
const same=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
const copy=<T>(v:T):T=>structuredClone(v);
const key=(...s:string[])=>s.join('/');
function add(m:Map<string,bigint>,k:string,n:bigint){const v=(m.get(k)??0n)+n;need(n>0n&&v<=BigInt(PHYSICAL_WZ_UI_LIMITS.count),'source_count_budget');m.set(k,v);}
function equalCounts(a:Map<string,bigint>,b:Map<string,bigint>,code:string){need(a.size===b.size&&[...a].every(([k,n])=>b.get(k)===n),code);}
function unique<T>(rows:T[],identify:(v:T)=>string,code:string){const seen=new Set<string>();for(const r of rows){const k=identify(r);need(!seen.has(k),code);seen.add(k);}}
const recipe=(i:PhysicalWzItem)=>i.components.length?i.components:[{product_id:i.product_id,quantity:1}];
function physical(rows:PhysicalWzProduct[]){need(Array.isArray(rows)&&rows.length<=500,'source_products');for(const r of rows)exact(r,['product_id','warehouse_id','quantity']);unique(rows,r=>key(r.warehouse_id,r.product_id),'source_duplicate_product');const m=new Map<string,bigint>();for(const r of rows){exact(r,['product_id','warehouse_id','quantity']);need(uuid(r.product_id)&&uuid(r.warehouse_id)&&integer(r.quantity,1,PHYSICAL_WZ_UI_LIMITS.count),'source_product');add(m,key(r.warehouse_id,r.product_id),BigInt(r.quantity));}return m;}

/** Enforces genuine immutable recipe/physical/progress conservation. Does not
 * recompute revision. Source cancelled/unknown protocol is explicitly blocked. */
export function validatePhysicalWzUiSource(s:PhysicalWzUiSource):void{
 exact(s,['tenant_id','order_id','order_version','plan_id','plan_scope_hash','protocol','currency','revision','approved_mapping_id','approved_at','items','reservations','parcels','progress']);
 need(uuid(s.tenant_id)&&uuid(s.order_id)&&uuid(s.plan_id)&&digest(s.plan_scope_hash)&&digest(s.revision)&&s.protocol==='physical_v1','source_identity');
 need(typeof s.order_version==='string'&&/^[1-9][0-9]{0,18}$/.test(s.order_version)&&BigInt(s.order_version)<=9223372036854775807n&&/^[A-Z]{3}$/.test(s.currency),'source_version_currency');
 need(s.approved_mapping_id===null?s.approved_at===null:uuid(s.approved_mapping_id)&&typeof s.approved_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}(?:Z|\+00:00)$/.test(s.approved_at)&&Number.isFinite(Date.parse(s.approved_at)),'source_mapping_head');
 need(Array.isArray(s.items)&&integer(s.items.length,1,500)&&Array.isArray(s.reservations)&&integer(s.reservations.length,1,500)&&Array.isArray(s.parcels)&&integer(s.parcels.length,2,50)&&Array.isArray(s.progress)&&s.progress.length===s.parcels.length,'source_scope');
 for(const i of s.items)exact(i,['item_id','product_id','name','sku','quantity','line_total','vat','currency','components']);
 for(const r of s.reservations)exact(r,['product_id','warehouse_id','quantity','consumed_quantity','state']);
 for(const p of s.parcels){exact(p,['parcel_index','shipment_id','products']);need(Array.isArray(p.products),'source_parcel_products');}
 for(const p of s.progress)exact(p,['parcel_index','shipment_id','state','dispatch_id','issued_products']);
 unique(s.items,i=>i.item_id,'source_duplicate_item');const expected=new Map<string,bigint>();
 for(const i of s.items){exact(i,['item_id','product_id','name','sku','quantity','line_total','vat','currency','components']);need(uuid(i.item_id)&&uuid(i.product_id)&&historicalText(i.name,1000)&&historicalText(i.sku,1000)&&integer(i.quantity,1,1000000)&&integer(i.line_total,0,Number.MAX_SAFE_INTEGER)&&integer(i.vat,0,100)&&i.currency===s.currency&&Array.isArray(i.components)&&i.components.length<=500,'source_item');for(const c of i.components){exact(c,['product_id','quantity']);need(uuid(c.product_id)&&integer(c.quantity,1,1000000),'source_component');}unique(i.components,c=>c.product_id,'source_duplicate_recipe');for(const c of recipe(i)){exact(c,['product_id','quantity']);need(uuid(c.product_id)&&integer(c.quantity,1,1000000),'source_component');add(expected,c.product_id,BigInt(i.quantity)*BigInt(c.quantity));}}
 unique(s.reservations,r=>key(r.warehouse_id,r.product_id),'source_duplicate_reservation');const reserved=new Map<string,bigint>(),byProduct=new Map<string,bigint>(),consumed=new Map<string,bigint>();
 for(const r of s.reservations){exact(r,['product_id','warehouse_id','quantity','consumed_quantity','state']);need(uuid(r.product_id)&&uuid(r.warehouse_id)&&integer(r.quantity,1,PHYSICAL_WZ_UI_LIMITS.count)&&integer(r.consumed_quantity,0,r.quantity)&&(r.state==='consumed'?r.consumed_quantity===r.quantity:r.state==='active'&&r.consumed_quantity<r.quantity),'source_reservation');add(reserved,key(r.warehouse_id,r.product_id),BigInt(r.quantity));add(byProduct,r.product_id,BigInt(r.quantity));if(r.consumed_quantity)add(consumed,key(r.warehouse_id,r.product_id),BigInt(r.consumed_quantity));}
 equalCounts(expected,byProduct,'source_historical_reservation_mismatch');unique(s.parcels,p=>String(p.parcel_index),'source_duplicate_parcel');unique(s.parcels,p=>p.shipment_id,'source_duplicate_shipment');unique(s.progress,p=>String(p.parcel_index),'source_duplicate_progress');
 need(s.parcels.reduce((n,p)=>n+p.products.length,0)<=500,'source_physical_entry_budget');const allocated=new Map<string,bigint>(),issued=new Map<string,bigint>(),dispatches=new Set<string>();
 for(const [index,p] of [...s.parcels].sort((a,b)=>a.parcel_index-b.parcel_index).entries()){
  exact(p,['parcel_index','shipment_id','products']);need(p.parcel_index===index&&uuid(p.shipment_id)&&Array.isArray(p.products)&&p.products.length>0,'source_parcel');const products=physical(p.products);for(const [k,n] of products)add(allocated,k,n);
  const progress=s.progress.find(r=>r.parcel_index===index);need(progress,'source_missing_progress');const r=progress!;exact(r,['parcel_index','shipment_id','state','dispatch_id','issued_products']);need(r.shipment_id===p.shipment_id,'source_progress_identity');
  if(r.state==='pending')need(r.dispatch_id===null&&Array.isArray(r.issued_products)&&r.issued_products.length===0,'source_pending_progress');
  else{need(r.state==='dispatched'&&uuid(r.dispatch_id)&&!dispatches.has(r.dispatch_id),'source_unsupported_progress');dispatches.add(r.dispatch_id!);equalCounts(products,physical(r.issued_products),'source_prior_dispatch_mismatch');for(const [k,n] of products)add(issued,k,n);}
 }
 equalCounts(reserved,allocated,'source_plan_reservation_mismatch');equalCounts(consumed,issued,'source_consumed_dispatch_mismatch');need(new TextEncoder().encode(JSON.stringify(s)).length<=PHYSICAL_WZ_UI_LIMITS.bytes,'source_byte_budget');
}
function scope(s:PhysicalWzUiSource,c:PhysicalWzUiScope){need(text(c.contextKey,500)&&typeof c.readOnly==='boolean'&&s.tenant_id===c.tenant_id&&s.order_id===c.order_id&&s.plan_id===c.plan_id,'editor_scope');}
export function createPhysicalWzDraft(s:PhysicalWzUiSource,c:PhysicalWzUiScope):PhysicalWzUiDraft{validatePhysicalWzUiSource(s);scope(s,c);return freeze({source:copy(s),scope:copy(c),parcels:[...s.parcels].sort((a,b)=>a.parcel_index-b.parcel_index).map(p=>({parcel_index:p.parcel_index,shipment_id:p.shipment_id,rows:[]}))});}
function writable(d:PhysicalWzUiDraft){need(!d.scope.readOnly&&d.source.approved_mapping_id===null,'editor_read_only');}
export function addPhysicalWzRow(d:PhysicalWzUiDraft,index:number,rowKey:string):PhysicalWzUiDraft{writable(d);need(text(rowKey,100)&&!d.parcels.some(p=>p.rows.some(r=>r.key===rowKey))&&d.parcels.reduce((n,p)=>n+p.rows.length,0)<5000,'editor_row_key_budget');const n=copy(d),p=n.parcels.find(p=>p.parcel_index===index);need(p,'editor_parcel');p!.rows.push({key:rowKey,item_id:'',product_id:'',quantity:''});return freeze(n);}
export function editPhysicalWzRow(d:PhysicalWzUiDraft,index:number,rowKey:string,change:Partial<Pick<PhysicalWzDraftRow,'item_id'|'product_id'|'quantity'>>):PhysicalWzUiDraft{writable(d);need(Object.keys(change).every(k=>['item_id','product_id','quantity'].includes(k))&&Object.values(change).every(v=>typeof v==='string'&&v.length<=100),'editor_change');const n=copy(d),row=n.parcels.find(p=>p.parcel_index===index)?.rows.find(r=>r.key===rowKey);need(row,'editor_row');Object.assign(row!,change);return freeze(n);}
export function removePhysicalWzRow(d:PhysicalWzUiDraft,index:number,rowKey:string):PhysicalWzUiDraft{writable(d);const n=copy(d),p=n.parcels.find(p=>p.parcel_index===index);need(p?.rows.some(r=>r.key===rowKey),'editor_row');p!.rows=p!.rows.filter(r=>r.key!==rowKey);return freeze(n);}
export function eligiblePhysicalWzItems(s:PhysicalWzUiSource,index:number,productId:string):readonly PhysicalWzItem[]{validatePhysicalWzUiSource(s);need(s.parcels.find(p=>p.parcel_index===index)?.products.some(p=>p.product_id===productId),'editor_component');return freeze(copy(s.items.filter(i=>recipe(i).some(c=>c.product_id===productId)).sort((a,b)=>a.item_id<b.item_id?-1:1)));}

function mapping(d:PhysicalWzUiDraft):{issues:PhysicalWzIssue[];parcels:PhysicalWzPreviewRequest['parcels']}{
 const issues:PhysicalWzIssue[]=[],parcels:PhysicalWzPreviewRequest['parcels']=[],expectedItems=new Map<string,bigint>(),actualItems=new Map<string,bigint>();
 for(const i of d.source.items)for(const c of recipe(i))add(expectedItems,key(i.item_id,c.product_id),BigInt(i.quantity)*BigInt(c.quantity));
 need(d.parcels.length===d.source.parcels.length&&d.parcels.reduce((n,p)=>n+p.rows.length,0)<=5000,'editor_full_scope');unique(d.parcels,p=>String(p.parcel_index),'editor_duplicate_parcel');unique(d.parcels.flatMap(p=>p.rows),r=>r.key,'editor_duplicate_row');
 for(const p of [...d.parcels].sort((a,b)=>a.parcel_index-b.parcel_index)){
  const original=d.source.parcels.find(s=>s.parcel_index===p.parcel_index);need(original&&original.shipment_id===p.shipment_id,'editor_parcel_identity');const expected=new Map<string,bigint>(),actual=new Map<string,bigint>(),seen=new Set<string>(),components:PhysicalWzPreviewRequest['parcels'][number]['components']=[];
  for(const r of original!.products)add(expected,r.product_id,BigInt(r.quantity));
  for(const r of p.rows){
   if(r.item_id===''&&r.product_id===''&&r.quantity==='')continue;
   const detail={parcel_index:p.parcel_index,item_id:r.item_id,product_id:r.product_id};
   if(!uuid(r.item_id)||!uuid(r.product_id)||r.quantity===''){issues.push({code:'selection_incomplete',...detail});continue;}
   const item=d.source.items.find(i=>i.item_id===r.item_id);if(!item||!recipe(item).some(c=>c.product_id===r.product_id)||!expected.has(r.product_id)){issues.push({code:'unknown_historical_component',...detail});continue;}
   if(!/^(0|[1-9][0-9]{0,9})$/.test(r.quantity)||BigInt(r.quantity)>BigInt(PHYSICAL_WZ_UI_LIMITS.count)){issues.push({code:'quantity_not_canonical',...detail});continue;}const n=BigInt(r.quantity);if(n===0n)continue;
   const identity=key(r.item_id,r.product_id);if(seen.has(identity)){issues.push({code:'duplicate_component',...detail});continue;}seen.add(identity);
   actual.set(r.product_id,(actual.get(r.product_id)??0n)+n);actualItems.set(identity,(actualItems.get(identity)??0n)+n);components.push({item_id:r.item_id,product_id:r.product_id,quantity:Number(n)});
  }
  for(const [product_id,n]of expected)if(actual.get(product_id)!==n)issues.push({code:'parcel_component_total',parcel_index:p.parcel_index,product_id,expected:n.toString(),actual:(actual.get(product_id)??0n).toString()});
  components.sort((a,b)=>key(a.item_id,a.product_id)<key(b.item_id,b.product_id)?-1:1);parcels.push({parcel_index:p.parcel_index,shipment_id:p.shipment_id,components});
 }
 for(const [k,n]of expectedItems)if(actualItems.get(k)!==n){const [item_id,product_id]=k.split('/');issues.push({code:'historical_item_total',item_id,product_id,expected:n.toString(),actual:(actualItems.get(k)??0n).toString()});}
 return {issues,parcels};
}
export function validatePhysicalWzDraft(d:PhysicalWzUiDraft):readonly PhysicalWzIssue[]{validatePhysicalWzUiSource(d.source);scope(d.source,d.scope);return freeze(mapping(d).issues);}
/** Full current source and UI scope must still be exactly the captured frame.
 * No hash generation: native revision travels unchanged; caller requests a
 * genuine preview, validates its returned scope, then asks separate consent. */
export function preparePhysicalWzPreview(s:PhysicalWzUiSource,d:PhysicalWzUiDraft,c:PhysicalWzUiScope,clientKey:string):Readonly<{request:PhysicalWzPreviewRequest;body:string}>{
 validatePhysicalWzUiSource(s);scope(s,c);writable(d);need(!c.readOnly&&same(c,d.scope)&&same(s,d.source),'editor_stale_source');need(uuid(clientKey),'editor_client_key');const v=mapping(d);if(v.issues.length)throw new PhysicalWzUiModelError(freeze(v.issues));const request={client_key:clientKey,revision:s.revision,parcels:v.parcels},body=JSON.stringify(request);need(new TextEncoder().encode(body).length<=PHYSICAL_WZ_UI_LIMITS.bytes,'editor_body_budget');return freeze({request,body});
}
