/** Unregistered Native210 transport foundation. No routes, grants or activation.
 * Production writes use tenantTx and its fixed split terminal hook after all
 * sibling finalizers. Native availability is still required; callback-local
 * terminal validation does not replace the outer pre-COMMIT boundary.
 * Only authorized server code may call capture/tenantTx; DB query-port tests do
 * not certify Native execution, schema installation or private managed leases. */
import type {PoolClient} from 'pg';
import type {Actor} from './domain';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {ensure,Problem} from './errors';
import {fa3DraftOwnerInTx} from './fa3-draft-access';
import {ORDER_SPLIT_LIMITS as L,orderSplitPreviewInput,orderSplitExecuteInput,orderSplitUuid} from './order-splits-schema';
import {projectOrderSplitPreview,projectOrderSplitExecution,type Native210PreviewRecord,type Native210SourceRow,type Native210ExecutionRecord,type Native210TargetRow,type Native210AllocationRow} from './order-split-public';
import {enlistOrderSplitTransaction} from './order-split-transaction';

export const ORDER_SPLIT_TRANSPORT_STATE=Object.freeze({nativeReady:false,registered:false,lateManagedTerminalRequired:true});
declare const requestBrand:unique symbol;
export type OrderSplitRequest=Readonly<{tenantId:string;userId:string;role:Actor['role'];readOnly:boolean;[requestBrand]:true}>;
type RequestInput={actor:Actor;currentUser?:{id?:string;tenant_id?:string;role?:string;api_key_id?:string}|null;headers:Record<string,unknown>;cookies:Record<string,string|undefined>};
const authorities=new WeakMap<object,{hash:string}>();
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const same=(a:unknown,b:unknown)=>ensure(canonical(a)===canonical(b),409,'Zmieniona podstawa oryginalnego podziału');
const bounded=(v:unknown,max:number=L.output_bytes)=>ensure(Buffer.byteLength(JSON.stringify(v))<=max,413,'Przekroczony zakres odczytu podziału');
export function captureOrderSplitRequest(req:RequestInput,sessionName:string,options:{readOnly:boolean}):OrderSplitRequest{
 ensure(req&&req.actor&&req.currentUser&&/^dyna_session(?:_preview_\d+)?$/.test(sessionName)&&typeof options?.readOnly==='boolean',401,'Brak zwykłego kontekstu żądania');
 const a=req.actor,u=req.currentUser;orderSplitUuid.parse(a.tenantId);orderSplitUuid.parse(a.userId);
 ensure(!a.apiKeyId&&!u.api_key_id&&a.source!=='api',403,'Ten interfejs podziału wymaga sesji operatora');
 ensure(u.id===a.userId&&u.tenant_id===a.tenantId&&u.role===a.role&&['admin','operator','viewer'].includes(a.role),401,'Zmieniona tożsamość żądania');
 ensure(!req.headers['x-workspace-id']||req.headers['x-workspace-id']===a.tenantId,409,'Zmieniono firmę');
 const bearer=typeof req.headers.authorization==='string'?req.headers.authorization.replace(/^Bearer /,''):undefined;
 const raw=req.cookies[sessionName]??bearer;
 ensure(typeof raw==='string'&&raw.length>0&&raw.length<=512&&!/^dyna_api_/.test(raw),401,'Brak sesji operatora');
 const handle=Object.freeze({tenantId:a.tenantId,userId:a.userId,role:a.role,readOnly:options.readOnly}) as OrderSplitRequest;
 authorities.set(handle,{hash:sha(raw)});return handle;
}
function authority(a:OrderSplitRequest){const p=authorities.get(a);ensure(p,401,'Brak oryginalnego żądania');return p;}
const contextSql=`/* split210:context */ SELECT current_user AS role,session_user AS owner,
 current_setting('app.tenant_id',true) AS tenant,pg_current_xact_id()::text AS root,
 transaction_timestamp()::text AS started,pg_backend_pid()::text AS pid,current_setting('transaction_read_only') AS read_only`;
type Frame={role:string;owner:string;tenant:string;root:string;started:string;pid:string;read_only:string};
async function frame(c:PoolClient,a:OrderSplitRequest){
 authority(a);const r=(await c.query(contextSql)).rows;ensure(r.length===1,403,'Brak transakcji firmy');const f=r[0] as Frame;
 ensure(f.tenant===a.tenantId&&f.role==='dyna_app'&&f.owner==='postgres'&&/^\d+$/.test(f.root)&&/^\d+$/.test(f.pid)&&typeof f.started==='string'&&['on','off'].includes(f.read_only),403,'Brak zwykłej transakcji firmy');return f;
}
async function identity(c:PoolClient,a:OrderSplitRequest,pin=false){
 const p=authority(a);const r=(await c.query('SELECT public.buyer_address_identity($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,false,$6::boolean) AS proof',[a.tenantId,a.userId,null,p.hash,a.role,pin])).rows;
 ensure(r.length===1&&r[0].proof&&r[0].proof.role===a.role,401,'Nie potwierdzono aktualnej sesji');return r[0].proof;
}
async function scoped<T>(c:PoolClient,a:OrderSplitRequest,write:boolean,work:()=>Promise<T>):Promise<T>{
 authority(a);ensure(!write||!a.readOnly,423,'Ta kopia jest tylko do odczytu');ensure(!write||['admin','operator'].includes(a.role),403,'Brak uprawnień zapisu podziału');
 const before=await frame(c,a);ensure(!write||before.read_only==='off',423,'Transakcja tylko do odczytu');
 const initial=await identity(c,a,true);
 const value=await fa3DraftOwnerInTx(c,work);
 same(await frame(c,a),before);same(await identity(c,a),initial);return value;
}
const previewColumns='tenant_id,id,actor_id,api_key_id,client_key,request,source_order_id,source_version::text,scope_hash,snapshot,plan';
const executionColumns='tenant_id,id,preview_id,actor_id,api_key_id,client_key,request,source_order_id,source_version::text,result_source_version::text,scope_hash,before_frame,after_frame';
type Operation='preview'|'execute';
function operation(v:Operation){ensure(v==='preview'||v==='execute',422,'Nieprawidłowa operacja podziału');return v;}
function boundCount(v:unknown,max:number){ensure(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&BigInt(v)<=BigInt(max),413,'Niekompletny lub zbyt duży zakres podziału');return Number(v);}
async function record(c:PoolClient,a:OrderSplitRequest,op:Operation,value:string,byKey:boolean){
 const table=op==='preview'?'order_split210_previews':'order_split210_executions',field=byKey?'client_key':'id',columns=op==='preview'?previewColumns:executionColumns;
 const args=[a.tenantId,a.userId,orderSplitUuid.parse(value)];
 const bound=(await c.query(`/* split210:record-bound */ SELECT count(*)::text AS count,coalesce(sum(octet_length(to_jsonb(r)::text)),0)::text AS bytes FROM public.${table} r WHERE tenant_id=$1 AND actor_id=$2 AND api_key_id IS NULL AND ${field}=$3`,args)).rows;
 ensure(bound.length===1,503,'Niekompletny odczyt podziału');const n=boundCount(bound[0].count,1);ensure(n===1,404,'Nie znaleziono oryginalnego wyniku');boundCount(bound[0].bytes,3*L.source_bytes+L.request_bytes);
 const rows=(await c.query(`/* split210:record */ SELECT ${columns} FROM public.${table} WHERE tenant_id=$1 AND actor_id=$2 AND api_key_id IS NULL AND ${field}=$3 LIMIT 2`,args)).rows;
 ensure(rows.length===1,409,'Zmieniony zakres oryginalnego podziału');const row=rows[0];ensure(row.tenant_id===a.tenantId&&row.actor_id===a.userId&&row.api_key_id===null&&row[field]===value,404,'Nie znaleziono oryginalnego wyniku');return row;
}
async function related<T>(c:PoolClient,a:OrderSplitRequest,table:'source_rows'|'targets'|'allocations',id:string,max:number,bytes:number):Promise<T[]>{
 const field=table==='source_rows'?'preview_id':'execution_id',args=[a.tenantId,id];
 const b=(await c.query(`/* split210:rows-bound */ SELECT count(*)::text AS count,coalesce(sum(octet_length(to_jsonb(r)::text)),0)::text AS bytes FROM public.order_split210_${table} r WHERE tenant_id=$1 AND ${field}=$2`,args)).rows;
 ensure(b.length===1,503,'Niekompletny odczyt pozycji podziału');const count=boundCount(b[0].count,max);boundCount(b[0].bytes,bytes);
 const order=table==='source_rows'?'source_item_id':table==='targets'?'result_index':'result_index,source_item_id';
 const rows=(await c.query(`/* split210:rows */ SELECT * FROM public.order_split210_${table} WHERE tenant_id=$1 AND ${field}=$2 ORDER BY ${order} LIMIT ${max+1}`,args)).rows;
 ensure(rows.length===count,409,'Niekompletny zestaw zapisanych pozycji podziału');return rows;
}
async function load(c:PoolClient,a:OrderSplitRequest,op:Operation,value:string,byKey=false){
 operation(op);const current=await record(c,a,op,value,byKey);
 const preview=(op==='preview'?current:await record(c,a,'preview',current.preview_id,false)) as Native210PreviewRecord;
 const source_rows=await related<Native210SourceRow>(c,a,'source_rows',preview.id,L.source_lines,2*L.source_bytes);
 const context={tenant_id:a.tenantId,actor_id:a.userId,api_key_id:null};
 if(op==='preview')return projectOrderSplitPreview(context,{preview,source_rows});
 const targets=await related<Native210TargetRow>(c,a,'targets',current.id,L.results,L.source_bytes);
 const allocations=await related<Native210AllocationRow>(c,a,'allocations',current.id,L.allocation_rows,2*L.output_bytes);
 return projectOrderSplitExecution(context,{preview,source_rows,execution:current as Native210ExecutionRecord,targets,allocations});
}
function nativeError(e:unknown):never{
 if(e instanceof Problem||e instanceof z.ZodError)throw e;
 const code=(e as {code?:unknown})?.code;
 const status=code==='28000'?401:code==='42501'?403:code==='P0002'?404:['23505','23514','40001'].includes(String(code))?409:['55000','42P01','42883'].includes(String(code))?503:500;
 throw new Problem(status,'Nie potwierdzono oryginalnego wyniku podziału');
}
/** Actual Native call, no automatic retry. Caller MUST own tenantTx and later
 * retain the fixed final terminal tail before registering any route. */
export async function invokeOrderSplitPreviewInTx(c:PoolClient,a:OrderSplitRequest,raw:unknown){try{
 const body=orderSplitPreviewInput.parse(raw);bounded(body,L.request_bytes);
 const head=await scoped(c,a,true,async()=>{
  const proof=authority(a),rows=(await c.query('SELECT public.order_split210_preview($1::jsonb,$2::uuid,$3::uuid,$4::text,$5::text) AS result',[body,a.userId,null,proof.hash,a.role])).rows;
  ensure(rows.length===1,503,'Niekompletna odpowiedź podziału');const ack=rows[0].result;ensure(ack&&typeof ack.replayed==='boolean',503,'Niekompletne potwierdzenie podziału');bounded(ack);
  const saved=await load(c,a,'preview',body.client_key,true);ensure(saved.head.id===ack.id&&saved.head.source_order_id===ack.source_order_id&&saved.head.source_version===ack.source_version&&saved.head.scope_hash===ack.scope_hash,409,'Potwierdzenie nie wskazuje oryginalnego podziału');same(saved.command.request,body);return saved.head;
 });
 // Enlist only the fully verified immutable original, after scoped late IAM.
 // The managed outer boundary retains this duty until COMMIT/ROLLBACK. An
 // absent/conflicting registry is an error requiring that manager to rollback.
 enlistOrderSplitTransaction(c,a,'preview',head.id);return head;
}catch(e){return nativeError(e);}}
export async function invokeOrderSplitExecuteInTx(c:PoolClient,a:OrderSplitRequest,raw:unknown){try{
 const body=orderSplitExecuteInput.parse(raw);bounded(body,L.request_bytes);
 const head=await scoped(c,a,true,async()=>{
  const proof=authority(a),rows=(await c.query('SELECT public.order_split210_execute($1::jsonb,$2::uuid,$3::uuid,$4::text,$5::text) AS result',[body,a.userId,null,proof.hash,a.role])).rows;
  ensure(rows.length===1,503,'Niekompletna odpowiedź podziału');const ack=rows[0].result;ensure(ack&&typeof ack.replayed==='boolean'&&ack.state==='done',503,'Niekompletne potwierdzenie podziału');bounded(ack);
  const saved=await load(c,a,'execute',body.client_key,true),head=saved.head;ensure('state' in head&&'preview_id' in head,503,'Niekompletny wynik wykonania');for(const field of ['id','preview_id','source_order_id','source_version','source_result_version','scope_hash','state'] as const)ensure(head[field]===ack[field],409,'Potwierdzenie nie wskazuje oryginalnego podziału');same(head.children,ack.children);same(saved.command.request,body);
  if(!ack.replayed)await c.query('SELECT public.order_split210_terminal($1::uuid)',[saved.head.id]);
  return saved.head;
 });
 enlistOrderSplitTransaction(c,a,'execute',head.id);return head;
}catch(e){return nativeError(e);}}

/** Fixed final operation port, not a registry or a caller-supplied admission.
 * The actual managed service MUST call this after all sibling finalizers and
 * constraint drains, immediately before COMMIT. No later business DML/wait.
 * Merely exporting this port does not activate ordinary writes or that hook. */
export async function finalizeOrderSplitRequestInTx(c:PoolClient,a:OrderSplitRequest,kind:Operation,commandId:string){try{
 authority(a);operation(kind);const id=orderSplitUuid.parse(commandId);
 ensure(!a.readOnly,423,'Ta kopia jest tylko do odczytu');ensure(['admin','operator'].includes(a.role),403,'Brak uprawnień zapisu podziału');
 const before=await frame(c,a);ensure(before.read_only==='off',423,'Transakcja tylko do odczytu');
 await identity(c,a,true);
 // Unlike scoped(), this fixed tail MUST NOT read IAM after the Native final
 // clock. Native checks the current request again after its source validation;
 // only owner restoration and the no-data transaction context cut follow it.
 await fa3DraftOwnerInTx(c,async()=>{
  const proof=authority(a);
  const rows=(await c.query('SELECT public.order_split210_finalize($1::text,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text)',
   [kind,id,a.userId,null,proof.hash,a.role])).rows;
  ensure(rows.length===1,503,'Niekompletna końcowa kontrola podziału');
 });
 same(await frame(c,a),before);
}catch(e){return nativeError(e);}}

const pageQuery=z.strictObject({cursor:z.string().max(2048).optional(),limit:z.coerce.number().int().min(1).max(100).default(100)});
export type OrderSplitRead={operation:Operation;id:string;view:'head'|'source'|'source-items'|'children'|'commercial';query?:unknown}|{operation:Operation;client_key:string;view:'command'};
function page(data:unknown[],query:unknown,bind:unknown,key:string){
 ensure(typeof key==='string'&&key.length>=32,503,'Brak konfiguracji kursora podziału');const q=pageQuery.parse(query??{}),bound=sha(canonical(bind));let index=0;
 const sign=(s:string)=>createHmac('sha256',key).update(s).digest();
 if(q.cursor){const parts=q.cursor.split('.');ensure(parts.length===2&&parts.every(v=>/^[A-Za-z0-9_-]+$/.test(v)),422,'Niepoprawny kursor podziału');const signature=Buffer.from(parts[1],'base64url'),expected=sign(parts[0]);ensure(signature.length===expected.length&&timingSafeEqual(signature,expected),422,'Niepoprawny kursor podziału');let decoded:any;try{decoded=JSON.parse(Buffer.from(parts[0],'base64url').toString());}catch{throw new Problem(422,'Niepoprawny kursor podziału');}ensure(decoded&&Object.keys(decoded).sort().join('|')==='bind|index'&&decoded.bind===bound&&Number.isSafeInteger(decoded.index)&&decoded.index>0&&decoded.index<data.length,409,'Zmieniony zakres kursora podziału');index=decoded.index;}
 const rows=data.slice(index,index+q.limit),next=index+rows.length;let cursor:string|null=null;if(next<data.length){const s=Buffer.from(JSON.stringify({index:next,bind:bound})).toString('base64url');cursor=s+'.'+sign(s).toString('base64url');}
 return{data:rows,meta:{total:data.length,cursor}};
}
export async function readOrderSplitInTx(c:PoolClient,a:OrderSplitRequest,input:OrderSplitRead,cursorKey:string){try{
 return await scoped(c,a,false,async()=>{
  const byKey=input.view==='command',id=orderSplitUuid.parse(byKey?(input as {client_key:string}).client_key:(input as {id:string}).id);
  const value=await load(c,a,input.operation,id,byKey);let result:unknown;
  if(input.view==='command')result=value.command;else if(input.view==='head')result=value.head;else if(input.view==='source')result=value.source;else if(input.view==='commercial')result=value.commercial;
  else{ensure(input.view==='source-items'||input.view==='children',422,'Niepoprawny zakres podziału');const data=input.view==='source-items'?value.source_items:value.children;result=page(data,(input as {query?:unknown}).query,{tenant:a.tenantId,actor:a.userId,role:a.role,key:null,operation:input.operation,id:value.head.id,scope:value.head.scope_hash,view:input.view,total:data.length},cursorKey);}
  bounded(result);return result;
 });
}catch(e){return nativeError(e);}}

export type OrderSplitLineage={schema:'order-split-lineage/v1';order_id:string;lineage:null|{execution_id:string;source_order_id:string;children:{slot_id:string;order_id:string}[]}};
const lineageCap=65536;
function lineageUuid(value:unknown):string{ensure(typeof value==='string'&&orderSplitUuid.safeParse(value).success,409,'Niespójne powiązania podziału');return value as string;}
function lineageRows(rows:any[],max:number){ensure(rows.length<=max,409,'Niekompletne powiązania podziału');bounded(rows,lineageCap);return rows;}
// Read only the persisted binding, never detail bodies, customer data or a
// command's private snapshot. Invalid/unknown fields remain explicit refusals.
const lineageEventColumns=`id,tenant_id,order_id,
 CASE WHEN kind IN('order.split.source','order.split.child') THEN kind ELSE NULL END kind,
 CASE WHEN jsonb_typeof(detail)='object' THEN detail ?& ARRAY['execution_id','source_order_id','slot_id']
  AND detail-ARRAY['execution_id','source_order_id','slot_id']='{}'::jsonb ELSE false END exact_detail,
 CASE WHEN jsonb_typeof(detail->'execution_id')='string' AND length(detail->>'execution_id')=36 THEN detail->>'execution_id' END execution_id,
 CASE WHEN jsonb_typeof(detail->'source_order_id')='string' AND length(detail->>'source_order_id')=36 THEN detail->>'source_order_id' END source_order_id,
 CASE WHEN jsonb_typeof(detail->'slot_id')='string' AND length(detail->>'slot_id')=36 THEN detail->>'slot_id' END slot_id,
 jsonb_typeof(detail->'slot_id') slot_type`;
const lineageTargetColumns='tenant_id,execution_id,preview_id,result_index,slot_id,order_id,source_order_id';
/** Order-read access is deliberately separate from actor-only command recovery.
 * The first and final order checks run as ordinary dyna_app under tenant RLS.
 * Owner access is limited to explicit-tenant immutable IDs and events. */
export async function readOrderSplitLineageInTx(c:PoolClient,a:OrderSplitRequest,rawId:string):Promise<OrderSplitLineage>{try{
 authority(a);const orderId=orderSplitUuid.parse(rawId),before=await frame(c,a),initial=await identity(c,a,true);
 const visible=async(ids:string[])=>{
  const rows=lineageRows((await c.query('/* split210:lineage-visible-orders */ SELECT tenant_id,id FROM public.orders WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id LIMIT 101',[a.tenantId,ids])).rows,100);
  ensure(rows.length===ids.length&&new Set(rows.map(row=>row.id)).size===ids.length,404,'Nie znaleziono zamówienia');
  for(const row of rows)ensure(row.tenant_id===a.tenantId&&ids.includes(row.id),404,'Nie znaleziono zamówienia');
 };
 await visible([orderId]);
 const result=await fa3DraftOwnerInTx(c,async()=>{
  const current=lineageRows((await c.query('/* split210:lineage-current-target */ SELECT '+lineageTargetColumns+' FROM public.order_split210_targets WHERE tenant_id=$1 AND order_id=$2 LIMIT 2',[a.tenantId,orderId])).rows,1);
  const currentEvents=lineageRows((await c.query('/* split210:lineage-current-events */ SELECT '+lineageEventColumns+" FROM public.order_events WHERE tenant_id=$1 AND order_id=$2 AND starts_with(kind,'order.split') ORDER BY id LIMIT 2",[a.tenantId,orderId])).rows,1);
  if(current.length===0&&currentEvents.length===0){
   const fragments=(await c.query(`/* split210:lineage-source-fragments */ SELECT
    EXISTS(SELECT FROM public.order_split210_targets WHERE tenant_id=$1 AND source_order_id=$2)
    OR EXISTS(SELECT FROM public.order_split210_executions WHERE tenant_id=$1 AND source_order_id=$2)
    OR EXISTS(SELECT FROM public.order_events WHERE tenant_id=$1 AND starts_with(kind,'order.split') AND detail->>'source_order_id'=$2::text) AS present`,[a.tenantId,orderId])).rows;
   ensure(fragments.length===1&&fragments[0].present===false,409,'Niekompletne powiązania źródła podziału');
   return{schema:'order-split-lineage/v1' as const,order_id:orderId,lineage:null};
  }
  ensure(current.length===1&&currentEvents.length===1,409,'Niekompletne powiązania podziału');
  const target=current[0],executionId=lineageUuid(target.execution_id);
  ensure(target.tenant_id===a.tenantId&&target.order_id===orderId,409,'Niespójne powiązania podziału');
  const executions=lineageRows((await c.query('/* split210:lineage-execution */ SELECT tenant_id,id,preview_id,source_order_id FROM public.order_split210_executions WHERE tenant_id=$1 AND id=$2 LIMIT 2',[a.tenantId,executionId])).rows,1);
  ensure(executions.length===1,409,'Brak trwałego wykonania podziału');
  const execution=executions[0],sourceId=lineageUuid(execution.source_order_id),previewId=lineageUuid(execution.preview_id);
  ensure(execution.tenant_id===a.tenantId&&execution.id===executionId,409,'Niespójne wykonanie podziału');
  const targets=lineageRows((await c.query('/* split210:lineage-targets */ SELECT '+lineageTargetColumns+' FROM public.order_split210_targets WHERE tenant_id=$1 AND execution_id=$2 ORDER BY result_index LIMIT 101',[a.tenantId,executionId])).rows,100);
  ensure(targets.length>=2,409,'Niekompletne wyniki podziału');
  const orderIds=new Set<string>(),slots=new Set<string>();let retained=0;
  for(const [index,row]of targets.entries()){
   const id=lineageUuid(row.order_id);ensure(row.tenant_id===a.tenantId&&row.execution_id===executionId&&row.preview_id===previewId&&row.source_order_id===sourceId&&row.result_index===index&&!orderIds.has(id),409,'Niespójny wynik podziału');orderIds.add(id);
   if(row.slot_id===null){retained++;ensure(id===sourceId&&index===targets.length-1,409,'Niespójne zamówienie źródłowe');}
   else{const slot=lineageUuid(row.slot_id);ensure(id!==sourceId&&!slots.has(slot),409,'Niespójny wynik potomny');slots.add(slot);}
  }
  ensure(retained===1&&orderIds.has(orderId),409,'Niekompletne źródło podziału');
  same(targets.find(row=>row.order_id===orderId),target);
  const events=lineageRows((await c.query('/* split210:lineage-events */ SELECT '+lineageEventColumns+" FROM public.order_events WHERE tenant_id=$1 AND starts_with(kind,'order.split') AND (order_id=ANY($3::uuid[]) OR detail->>'execution_id'=$2::text) ORDER BY order_id,id LIMIT 101",[a.tenantId,executionId,[...orderIds]])).rows,100);
  ensure(events.length===targets.length,409,'Niekompletna historia podziału');
  const eventOrders=new Set<string>(),eventIds=new Set<string>();
  for(const event of events){
   const row=targets.find(row=>row.order_id===event.order_id);lineageUuid(event.id);
   ensure(row&&event.tenant_id===a.tenantId&&event.exact_detail===true&&event.execution_id===executionId&&event.source_order_id===sourceId&&!eventOrders.has(event.order_id)&&!eventIds.has(event.id),409,'Niespójna historia podziału');
   ensure(event.kind===(row.slot_id===null?'order.split.source':'order.split.child')&&event.slot_id===row.slot_id&&event.slot_type===(row.slot_id===null?'null':'string'),409,'Niespójne zdarzenie podziału');eventOrders.add(event.order_id);eventIds.add(event.id);
  }
  same(events.find(row=>row.order_id===orderId),currentEvents[0]);
  return{schema:'order-split-lineage/v1' as const,order_id:orderId,lineage:{execution_id:executionId,source_order_id:sourceId,children:targets.filter(row=>row.slot_id!==null).map(row=>({slot_id:row.slot_id as string,order_id:row.order_id as string}))}};
 });
 // The owner wrapper has restored dyna_app before any ordinary visibility read.
 same(await frame(c,a),before);
 await visible(result.lineage?[result.lineage.source_order_id,...result.lineage.children.map(row=>row.order_id)]:[orderId]);
 same(await frame(c,a),before);same(await identity(c,a),initial);bounded(result,lineageCap);return result;
}catch(e){return nativeError(e);}}

/** Ordinary production entry points. No injectable authorization/transaction
 * callbacks, no caller readiness boolean. Dynamic import keeps module inert. */
export function createOrderSplitTransport(){
 return Object.freeze({state:ORDER_SPLIT_TRANSPORT_STATE,
  async preview(a:OrderSplitRequest,body:unknown){
   authority(a);const parsed=orderSplitPreviewInput.parse(body);bounded(parsed,L.request_bytes);
   ensure(!a.readOnly,423,'Ta kopia jest tylko do odczytu');ensure(['admin','operator'].includes(a.role),403,'Brak uprawnień zapisu podziału');
   const {tenantTx}=await import('./db');return tenantTx(a.tenantId,c=>invokeOrderSplitPreviewInTx(c,a,parsed));
  },
  async execute(a:OrderSplitRequest,body:unknown){
   authority(a);const parsed=orderSplitExecuteInput.parse(body);bounded(parsed,L.request_bytes);
   ensure(!a.readOnly,423,'Ta kopia jest tylko do odczytu');ensure(['admin','operator'].includes(a.role),403,'Brak uprawnień zapisu podziału');
   const {tenantTx}=await import('./db');return tenantTx(a.tenantId,c=>invokeOrderSplitExecuteInTx(c,a,parsed));
  },
  async read(a:OrderSplitRequest,input:OrderSplitRead){authority(a);const {tenantTx,localConfig}=await import('./db');return tenantTx(a.tenantId,c=>readOrderSplitInTx(c,a,input,localConfig.encryptionKey),{wmsAdmission:'read'});},
  async lineage(a:OrderSplitRequest,orderId:string){authority(a);const id=orderSplitUuid.parse(orderId);const {tenantTx}=await import('./db');return tenantTx(a.tenantId,c=>readOrderSplitLineageInTx(c,a,id),{wmsAdmission:'read'});},
 });
}
