/** Preparatory browser custody only: no transport, automatic POST/retry or backend acceptance.
 * Future controller holds withSplitCustodyLock across fresh authorization, retain,
 * dispatch, original-command GET/full pages and clear. Child names are the user's
 * explicit command labels; no customer/header/credential fields are copied. */
import {ORDER_SPLIT_LIMITS as L, orderSplitPreviewInput, orderSplitExecuteInput} from '../server/order-splits-schema';
import type {OrderSplitPreviewInput} from '../server/order-splits-schema';
type Store = Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type ChildIdentity = {slot_id:string;order_id:string};
type Source = {id:string;version:string;shipping_cost:number;items:{id:string;quantity:number}[]};
export type SplitIntent = {schema:'order-split-custody/v1';actor:string;kind:'preview'|'execute';serialized:string;source:Source;preview?:{id:string;scope_hash:string;serialized:string;children:ChildIdentity[]}};
/** Derived from a FRESH controller authorization read, with no assumed role.
 * Server/Native independently enforce actual credentials and privileges. */
export type SplitAuthorization = {actor:string;can_write:boolean;read_only:boolean;restore_preview:boolean};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const version=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const qty=(v:unknown):v is number=>Number.isInteger(v)&&Number(v)>0&&Number(v)<=L.quantity;
const delivery=(v:unknown):v is number=>Number.isInteger(v)&&Number(v)>=0&&Number(v)<=L.delivery_minor;
const need=(v:unknown)=>{if(!v)throw Error('Nie potwierdzono oryginalnej próby podziału. Nowe zapisy pozostają zablokowane.');};
const exact=(v:any,keys:string[])=>need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'));
const bytes=(v:string)=>new TextEncoder().encode(v).length;
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const same=(a:unknown,b:unknown)=>need(canonical(a)===canonical(b));
export function splitActor(context:string){const parts=context.split(':');need(parts.length>=2&&uuid(parts[0])&&uuid(parts[1]));return parts[0]+':'+parts[1];}
export const splitIntentKey=(actor:string)=>'dyna:order-split-custody:v1:'+splitActor(actor);
export async function withSplitCustodyLock<T>(actor:string,run:()=>Promise<T>,locks:Pick<LockManager,'request'>|undefined=globalThis.navigator?.locks):Promise<T>{
 need(locks&&typeof locks.request==='function');return locks!.request(splitIntentKey(actor)+':exclusive',{mode:'exclusive',ifAvailable:true},async lock=>{need(lock);return run();});
}
function request(serialized:unknown,kind:'preview'|'execute'){
 need(typeof serialized==='string'&&bytes(serialized)<=L.request_bytes);const raw=JSON.parse(serialized as string);
 const parsed=kind==='preview'?orderSplitPreviewInput.parse(raw):orderSplitExecuteInput.parse(raw);same(raw,parsed);return parsed;
}
function childIdentities(value:any,plan:OrderSplitPreviewInput,sourceId:string){
 need(Array.isArray(value)&&value.length===plan.children.length);
 const slots=new Set(plan.children.map(c=>c.slot_id)),seen=new Set(),bySlot=new Map<string,string>();
 for(const c of value){exact(c,['slot_id','order_id']);need(slots.has(c.slot_id)&&!bySlot.has(c.slot_id)&&uuid(c.order_id)&&c.order_id!==sourceId&&!seen.has(c.order_id));seen.add(c.order_id);bySlot.set(c.slot_id,c.order_id);}return bySlot;
}
const sortedIdentities=(v:ChildIdentity[])=>[...v].sort((a,b)=>a.slot_id<b.slot_id?-1:a.slot_id>b.slot_id?1:0);
const sortedAllocations=(v:{source_item_id:string;quantity:number}[])=>[...v].sort((a,b)=>a.source_item_id<b.source_item_id?-1:a.source_item_id>b.source_item_id?1:0);
export function validateSplitIntent(value:unknown,actor:string):SplitIntent{
 const v:any=value;need(v?.kind==='preview'||v?.kind==='execute');exact(v,['schema','actor','kind','serialized','source',...(v.kind==='execute'?['preview']:[])]);
 need(v.schema==='order-split-custody/v1'&&v.actor===splitActor(actor));
 exact(v.source,['id','version','shipping_cost','items']);need(uuid(v.source.id)&&version(v.source.version)&&delivery(v.source.shipping_cost)&&Array.isArray(v.source.items)&&v.source.items.length>0&&v.source.items.length<=L.source_lines);
 const quantities=new Map<string,number>();for(const item of v.source.items){exact(item,['id','quantity']);need(uuid(item.id)&&qty(item.quantity)&&!quantities.has(item.id));quantities.set(item.id,item.quantity);}
 const body=request(v.serialized,v.kind);
 if(v.kind==='execute'){exact(v.preview,['id','scope_hash','serialized','children']);need(uuid(v.preview.id)&&hash(v.preview.scope_hash));need('preview_id' in body&&body.preview_id===v.preview.id&&body.scope_hash===v.preview.scope_hash);}
 const plan=(v.kind==='preview'?body:request(v.preview.serialized,'preview')) as OrderSplitPreviewInput;
 need(plan.source_order_id===v.source.id&&plan.expected_source_version===v.source.version);
 need(plan.children.reduce((sum,c)=>sum+c.delivery_minor,0)<=v.source.shipping_cost);
 const allocated=new Map<string,number>();for(const child of plan.children)for(const item of child.items){need(quantities.has(item.source_item_id));allocated.set(item.source_item_id,(allocated.get(item.source_item_id)??0)+item.quantity);}
 let remaining=0;for(const[id,q]of quantities){const n=allocated.get(id)??0;need(n<=q);remaining+=q-n;}need(remaining>0);
 if(v.kind==='execute')childIdentities(v.preview.children,plan,v.source.id);
 need(bytes(JSON.stringify(v))<=4*L.request_bytes);return structuredClone(v);
}
export function readSplitIntent(store:Store,actor:string){const raw=store.getItem(splitIntentKey(actor));if(raw===null)return null;need(bytes(raw)<=4*L.request_bytes);return validateSplitIntent(JSON.parse(raw),actor);}
export function retainSplitIntent(store:Store,value:SplitIntent){const v=validateSplitIntent(value,value.actor);need(readSplitIntent(store,v.actor)===null);const raw=JSON.stringify(v);store.setItem(splitIntentKey(v.actor),raw);need(store.getItem(splitIntentKey(v.actor))===raw);return v;}
export function assertHeldSplitIntent(store:Store,intent:SplitIntent){same(readSplitIntent(store,intent.actor),validateSplitIntent(intent,intent.actor));}

/** FUTURE DTO proposal, not an implemented endpoint:
 * lookup={tenant_id,actor_id,api_key_id:null,operation,client_key,request,preview|execution}.
 * Head={id,source_order_id,source_version,source_result_version,scope_hash,children,
 *       ready:boolean [preview] OR preview_id,state:'done' [execute]}.
 * Readback={source:{order_id,version,item_count,shipping_cost},source_pages,children_pages};
 * source.shipping_cost is the planned [preview] / committed [execute] remainder.
 * pages carry {requested_cursor,data,meta:{total,cursor}} in exact cursor order.
 * Source rows={source_item_id,before_quantity,remaining_quantity}; child rows=
 * {slot_id,order_id,delivery_minor,items:[{source_item_id,quantity}]}.
 * Parent must GET every page of the ORIGINAL command, never reconstruct it
 * from today's unrelated source or accept404 as permission to repeat POST.
 * Verification here covers identity, full quantities and delivery allocation;
 * total/net/VAT, stock, finance and actual current-TX facts still require the
 * future backend/Native gates. This is not full commercial verification. */
function pages(input:any,total:number,key:(r:any)=>string){
 need(Array.isArray(input)&&input.length>0&&input.length<=10001);const rows:any[]=[],seen=new Set<string>(),cursors=new Set<string>();let next:string|null=null;
 for(let i=0;i<input.length;i++){const p=input[i];exact(p,['requested_cursor','data','meta']);exact(p.meta,['total','cursor']);need(p.requested_cursor===next&&p.meta.total===total&&Array.isArray(p.data)&&p.data.length<=10000);
  for(const row of p.data){const id=key(row);need(typeof id==='string'&&id.length>0&&!seen.has(id));seen.add(id);rows.push(row);}need(rows.length<=total);
  next=p.meta.cursor;need(next===null||typeof next==='string'&&next.length>0&&next.length<=4096&&!cursors.has(next));if(next!==null){need(p.data.length>0&&i<input.length-1);cursors.add(next);}else need(i===input.length-1);
 }need(next===null&&rows.length===total);return rows;
}
export function verifySplitCommand(value:any,input:SplitIntent,readback:any){
 const intent=validateSplitIntent(input,input.actor),body=JSON.parse(intent.serialized),plan=(intent.kind==='preview'?body:JSON.parse(intent.preview!.serialized)) as OrderSplitPreviewInput;
 need(bytes(JSON.stringify(value))<=L.output_bytes&&bytes(JSON.stringify(readback))<=L.output_bytes);
 const[tenant,user]=intent.actor.split(':');need(value?.tenant_id===tenant&&value.actor_id===user&&value.api_key_id===null&&value.operation===intent.kind&&value.client_key===body.client_key);same(value.request,body);
 const h=value[intent.kind==='preview'?'preview':'execution'];need(h&&uuid(h.id)&&h.source_order_id===intent.source.id&&h.source_version===intent.source.version&&version(h.source_result_version)&&hash(h.scope_hash));const headChildren=childIdentities(h.children,plan,intent.source.id);
 if(intent.kind==='execute'){need(h.preview_id===body.preview_id&&h.scope_hash===body.scope_hash&&h.state==='done'&&BigInt(h.source_result_version)>BigInt(intent.source.version));same(sortedIdentities(h.children),sortedIdentities(intent.preview!.children));}else need(typeof h.ready==='boolean'&&h.source_result_version===intent.source.version);
 exact(readback,['source','source_pages','children_pages']);exact(readback.source,['order_id','version','item_count','shipping_cost']);need(readback.source.order_id===intent.source.id&&readback.source.version===h.source_result_version&&readback.source.item_count===intent.source.items.length&&delivery(readback.source.shipping_cost));
 need(readback.source.shipping_cost===intent.source.shipping_cost-plan.children.reduce((sum,c)=>sum+c.delivery_minor,0));
 const source=pages(readback.source_pages,intent.source.items.length,r=>r.source_item_id),children=pages(readback.children_pages,plan.children.length,r=>r.slot_id);
 const actualChildren=new Map(children.map(c=>[c.slot_id,c]));const assigned=new Map<string,number>();
 for(const planned of plan.children){const child=actualChildren.get(planned.slot_id);exact(child,['slot_id','order_id','delivery_minor','items']);need(child.order_id===headChildren.get(planned.slot_id)&&child.delivery_minor===planned.delivery_minor&&Array.isArray(child.items)&&child.items.length===planned.items.length);for(const item of child.items){exact(item,['source_item_id','quantity']);need(uuid(item.source_item_id)&&qty(item.quantity));}same(sortedAllocations(child.items),sortedAllocations(planned.items));for(const item of planned.items)assigned.set(item.source_item_id,(assigned.get(item.source_item_id)??0)+item.quantity);}
 const actualSource=new Map(source.map(r=>[r.source_item_id,r]));for(const item of intent.source.items){const row=actualSource.get(item.id);exact(row,['source_item_id','before_quantity','remaining_quantity']);need(row.before_quantity===item.quantity&&row.remaining_quantity===item.quantity-(assigned.get(item.id)??0));}
 return structuredClone(h);
}
/** Explicit manual reconciliation only. Controller retains its actor lock across
 * this call and obtains fresh write authority after all original-result reads. */
export async function clearSplitIntent(store:Store,intent:SplitIntent,value:unknown,readback:unknown,current:()=>Promise<SplitAuthorization>){
 assertHeldSplitIntent(store,intent);const result=verifySplitCommand(value,intent,readback);need(typeof current==='function');const now=await current();need(now&&splitActor(now.actor)===intent.actor&&now.can_write===true&&now.read_only===false&&now.restore_preview===false);
 assertHeldSplitIntent(store,intent);store.removeItem(splitIntentKey(intent.actor));need(readSplitIntent(store,intent.actor)===null);return result;
}
