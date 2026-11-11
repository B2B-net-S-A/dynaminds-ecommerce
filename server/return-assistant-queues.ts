import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { pool,tenantTx } from './db';
import { ensure,Problem } from './errors';
import { audit } from './domain';
import { returnAssistantAvailable } from './return-assistant';
import type { ReturnAssistantActor } from './return-assistant-schema';
import * as V from './return-assistant-queues-schema';
const tables=['return_assistant_settings','return_assistant_queues','return_assistant_queue_items','return_assistant_queue_operations','return_assistant_queue_admissions'];
const functions=['return_assistant_queue_installed()','return_assistant_queue_require(uuid,uuid,boolean,boolean)','return_assistant_queue_defaults()','return_assistant_queue_navigation(jsonb)','return_assistant_queue_values(jsonb)','return_assistant_queue_lock()','return_assistant_queue_budget()','return_assistant_queue_head(return_assistant_queues)','return_assistant_queue_read(uuid,uuid,text,uuid,uuid,integer)','return_assistant_queue_write(uuid,uuid,uuid,text,uuid,jsonb)','return_assistant_queue_guard()','return_assistant_queue_immutable()','return_assistant_queue_complete()','return_assistant_queue_guards()'];
export async function returnAssistantQueuesAvailable(c:Pool|PoolClient=pool):Promise<boolean>{
 try{
 const artifact=(await c.query("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1)) OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'return_assistant_queue_%') present",[tables])).rows[0].present;
 if(!artifact){if(c===pool)ensure(!(await c.query("SELECT EXISTS(SELECT 1 FROM migrations WHERE name='140_return_assistant_queues') marker")).rows[0].marker,503,'Niekompletna kolejka asystenta');return false;}
 ensure((await c.query("SELECT NOT EXISTS(SELECT 1 FROM unnest($1::text[])a(name) WHERE to_regclass('public.'||a.name) IS NULL) AND NOT EXISTS(SELECT 1 FROM unnest($2::text[])a(name) WHERE to_regprocedure(a.name) IS NULL) ok",[tables,functions])).rows[0].ok,503,'Niekompletna kolejka asystenta');
 ensure(await returnAssistantAvailable(c),503,'Kolejka wymaga kompletnego asystenta');
 ensure((await c.query('SELECT return_assistant_queue_installed() AND return_assistant_queue_guards() ok')).rows[0].ok,503,'Niekompletna kolejka asystenta');return true;
 }catch(e){if(['42P01','42703','42883','42704'].includes((e as any).code))throw new Problem(503,'Niekompletna kolejka asystenta');throw e;}
}
function mapped(e:unknown):never{const x=e as {code?:string;message?:string};if(x.code==='55000'&&x.message==='Niekompletna kolejka asystenta')throw new Problem(503,x.message);if(x.code==='P0002')throw new Problem(404,x.message??'Nie znaleziono własnej kolejki');if(x.code==='23514'){if(x.message==='Klucz asystenta jest nieaktualny')throw new Problem(401,x.message);if(x.message==='Brak aktualnego uprawnienia do asystenta')throw new Problem(403,x.message);throw new Problem(409,x.message??'Kolejka wymaga świeżych danych');}if(['23505','23503','22003'].includes(x.code??''))throw new Problem(409,'Kolejka lub wersja operacji jest zajęta');throw e;}
async function flags(c:PoolClient,a:ReturnAssistantActor,writing:boolean,pin:boolean){
 const g=(await c.query('SELECT return_assistant_access($1,$2,$3,$4) g',[a.userId,a.apiKeyId??null,writing,pin])).rows[0].g;
 ensure(g.key_valid,401,'Klucz asystenta jest nieaktualny');ensure(g.allowed,403,'Brak aktualnego uprawnienia do asystenta');
 return {available:true,read_only:false,current_role:g.role,can_read:true,can_write:g.can_write===true,can_save_settings:g.can_write===true,can_manage_queue:g.can_write===true};
}
async function tx<T extends Record<string,unknown>>(a:ReturnAssistantActor,writing:boolean,fn:(c:PoolClient)=>Promise<T>):Promise<T & Awaited<ReturnType<typeof flags>>>{
 ensure(await returnAssistantQueuesAvailable(pool),503,'Kopia nie zawiera kolejki asystenta');
 try{return await tenantTx(a.tenantId,async c=>{ensure(await returnAssistantQueuesAvailable(c),503,'Kopia nie zawiera kolejki asystenta');await flags(c,a,writing,false);const r=await fn(c);await c.query('SET CONSTRAINTS ALL IMMEDIATE');return {...r,...await flags(c,a,writing,true)};});}catch(e){return mapped(e);}
}
const neutral=()=>({available:false,read_only:false,current_role:null,can_read:false,can_write:false,can_save_settings:false,can_manage_queue:false});
export async function returnAssistantQueueSettings(a:ReturnAssistantActor){if(!await returnAssistantQueuesAvailable(pool))return {settings:{version:'0',values:V.DEFAULT_RETURN_ASSISTANT_SETTINGS},limits:V.RETURN_ASSISTANT_QUEUE_LIMITS,...neutral()};return tx(a,false,async c=>({...await read(c,a,'settings'),limits:V.RETURN_ASSISTANT_QUEUE_LIMITS}));}
async function read(c:PoolClient,a:ReturnAssistantActor,op:string,id:string|null=null,cursor:string|null=null,limit=50){return (await c.query('SELECT return_assistant_queue_read($1,$2,$3,$4,$5,$6) r',[a.userId,a.apiKeyId??null,op,id,cursor,limit])).rows[0].r;}
type QueueOperationResult=Record<string,unknown>&{operation_id:string;reused:boolean};
async function write(a:ReturnAssistantActor,op:'settings'|'create'|'update',id:string|null,body:unknown){return tx(a,true,async c=>{const r:QueueOperationResult=(await c.query('SELECT return_assistant_queue_write($1,$2,$3,$4,$5,$6) r',[randomUUID(),a.userId,a.apiKeyId??null,op,id,body])).rows[0].r;if(!r.reused)await audit(c,a,'return.assistant.queue.'+op,r.operation_id);return r;});}
export async function saveReturnAssistantQueueSettings(a:ReturnAssistantActor,input:unknown){return write(a,'settings',null,V.settingsInput.parse(input));}
export async function createReturnAssistantQueue(a:ReturnAssistantActor,input:unknown){return write(a,'create',randomUUID(),V.createQueueInput.parse(input));}
export async function updateReturnAssistantQueue(a:ReturnAssistantActor,id:string,input:unknown){return write(a,'update',V.createQueueInput.shape.client_key.parse(id),V.updateQueueInput.parse(input));}
export async function returnAssistantQueues(a:ReturnAssistantActor,input:unknown){const q=V.listQuery.parse(input);if(!await returnAssistantQueuesAvailable(pool))return {data:[],next_cursor:null,...neutral()};return tx(a,false,c=>read(c,a,'list',null,q.cursor??null,q.limit));}
export async function returnAssistantQueueDetail(a:ReturnAssistantActor,id:string){id=V.createQueueInput.shape.client_key.parse(id);return tx(a,false,c=>read(c,a,'detail',id));}
export async function returnAssistantQueueItems(a:ReturnAssistantActor,id:string,input:unknown){id=V.createQueueInput.shape.client_key.parse(id);const q=V.itemsQuery.parse(input);return tx(a,false,c=>read(c,a,'items',id,q.cursor??null,q.limit));}
/** Optional current presentation; historical lines remain the sole commercial authority.
 * The caller has already admitted current orders:read and pins that grant after hydration. */
export class ReturnAssistantPresentationLimitError extends Problem {
 constructor(message:string){super(409,message,'RETURN_ASSISTANT_PRESENTATION_LIMIT');}
}
function presentationLimit(condition:unknown,message:string):asserts condition {
 if(!condition)throw new ReturnAssistantPresentationLimitError(message);
}
export async function returnAssistantQueuePresentationInTx(c:PoolClient,returnId:string){
 if(!await returnAssistantQueuesAvailable(c))return null;
 const r=(await c.query(`SELECT rc.id,rc.order_id,rc.warehouse_id,rc.number,rc.kind,rc.created_at,o.number order_number,o.customer_name customer,o.total commercial_value,o.currency FROM return_cases rc JOIN orders o ON(o.tenant_id,o.id)=(rc.tenant_id,rc.order_id) WHERE rc.id=$1`,[returnId])).rows[0];ensure(r,404,'Nie znaleziono własnego RMA');
 const lines=(await c.query(`SELECT ri.item_id,oi.product_id,row_number() OVER(ORDER BY ri.item_id)::int ordinal,ri.name historical_name,ri.sku,ri.requested,oi.quantity original_quantity,oi.line_total,ri.components,
 p.name current_name,p.sku current_sku,p.ean current_ean,
 CASE WHEN octet_length(p.images::text)<=65536 AND jsonb_array_length(p.images)<=20 THEN p.images ELSE NULL END images,
 p.id IS NOT NULL AND(octet_length(p.images::text)>65536 OR jsonb_array_length(p.images)>20) images_over_limit
 FROM return_items ri JOIN order_items oi ON(oi.tenant_id,oi.order_id,oi.id)=(ri.tenant_id,ri.order_id,ri.item_id) LEFT JOIN products p ON(p.tenant_id,p.id)=(oi.tenant_id,oi.product_id) WHERE ri.return_id=$1 ORDER BY ri.item_id LIMIT 101`,[returnId])).rows;
 presentationLimit(lines.length<=100&&!lines.some(l=>l.images_over_limit),'RMA przekracza zakres prezentacji');
 const products=[...new Set(lines.flatMap(l=>(l.components as {product_id:string}[]).map(p=>p.product_id)))];presentationLimit(products.length<=500,'RMA przekracza zakres prezentacji fizycznej');
 const locations=(await c.query('SELECT product_id,warehouse_id,location,quantity FROM stock_locations WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id,location COLLATE "C" LIMIT 501',[r.warehouse_id,products])).rows;
 const stock=(await c.query('SELECT product_id,warehouse_id,on_hand,reserved,available,version::text FROM stock WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id LIMIT 501',[r.warehouse_id,products])).rows;
 presentationLimit(locations.length<=500&&stock.length<=500,'Lokalizacje RMA przekraczają zakres prezentacji');
 const image=(images:unknown):string|null=>{if(!Array.isArray(images))return null;for(const value of images){if(typeof value!=='string'||value.length>2048)continue;if(/^\/api\/product-images\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))return value;try{const u=new URL(value);if(u.protocol==='https:'&&!u.username&&!u.password)return value;}catch{}}return null;};
 const result={return_id:r.id,read_at:new Date().toISOString(),case:{number:r.number,order_number:r.order_number,created_at:r.created_at instanceof Date?r.created_at.toISOString():r.created_at,kind:r.kind,customer:r.customer,commercial_value:r.commercial_value,currency:r.currency},lines:lines.map(({current_name,current_sku,current_ean,images,images_over_limit,...line})=>{const ids=new Set((line.components as {product_id:string}[]).map(p=>p.product_id));return {...line,current_catalog:current_name==null?null:{name:current_name,sku:current_sku,ean:current_ean??null,image_url:image(images)},locations:locations.filter(p=>ids.has(p.product_id)),stock:stock.filter(p=>ids.has(p.product_id))};})};
 presentationLimit(Buffer.byteLength(JSON.stringify(result))<=4194304,'Prezentacja RMA przekracza limit danych');return result;
}
