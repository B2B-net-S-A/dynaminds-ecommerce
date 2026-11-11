import type { Pool,PoolClient } from 'pg';
import {assertOwnedOrdinarySchemaTransactionGate,type OrdinarySchemaTransactionGate} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import { z } from 'zod';
import { pool } from './db';
import { ensure, Problem } from './errors';
import { beginWmsTransaction,endWmsTransaction,wmsLotsAdmissionInTx } from './wms-lots-transaction';
import { beginPurchasingTransaction,endPurchasingTransaction,purchasingStockAdmissionInTx } from './purchasing-transaction';
import * as T from './catalog-stock-control-transaction';
import * as V from './catalog-stock-control-schema';

type Row=Record<string,any>;
type Context={readOnly?:boolean;writersAvailable?:boolean;schemaGate?:OrdinarySchemaTransactionGate};
type Grant={current_role:string;can_manage:boolean;can_read_value:boolean};
export async function catalogStockControlAvailable(c:Pool|PoolClient=pool):Promise<boolean>{return T.catalogStockControlInstalledInTx(c);}
function mapError(e:unknown):never{
  if(e instanceof Problem)throw e;const q=e as{code?:string};
  if(['55000','42P01','42703','42883'].includes(q.code??''))throw new Problem(503,'Niekompletny moduł ścisłej kontroli katalogu');
  if(q.code==='28000')throw new Problem(401,'Klucz API został cofnięty lub wygasł');
  if(q.code==='42501')throw new Problem(403,'Brak aktualnego uprawnienia BO');
  if(q.code==='P0002')throw new Problem(404,'Nie znaleziono własnego źródła BO');
  if(q.code==='54000')throw new Problem(413,'Limit pełnego manifestu lub historii BO');
  if(['23514','23503','23505','40001','40P01'].includes(q.code??''))throw new Problem(409,'Źródło BO lub dokument fizycznego efektu zmieniło się');
  throw e;
}
const costKeys=new Set(['unit_cost_minor','value_minor','currency','exponent','known_quantity','zero_cost_quantity','unknown_quantity','known_value_minor','signed_known_value_minor','rows_sha256']);
function redact<T>(value:T,allowed:boolean):T{
  if(allowed)return value;
  if(Array.isArray(value))return value.map(v=>redact(v,false)) as T;
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!costKeys.has(k)).map(([k,v])=>[k,redact(v,false)])) as T;
  return value;
}
function flags(g:Grant,ctx:Context):V.CatalogStockControlFlags{return{available:true,activation_available:!!ctx.writersAvailable,writers_available:!!ctx.writersAvailable,can_read:true,can_manage:g.can_manage&&!ctx.readOnly,can_read_value:g.can_read_value,current_role:g.current_role,read_only:!!ctx.readOnly};}
async function access(c:PoolClient,a:V.CatalogStockControlActor,writing:boolean,pin:boolean,active:boolean):Promise<Grant>{return(await c.query('SELECT public.catalog_stock_control_access($1,$2,$3,$4,$5) access_flags',[a.userId,a.apiKeyId??null,writing,pin,active])).rows[0].access_flags;}
/** RR immutable reads, fresh RC final access; no hydration query after final PIN. */
function tx<R extends Row>(a:V.CatalogStockControlActor,writing:boolean,active:boolean,ctx:Context,body:(c:PoolClient)=>Promise<R>):Promise<R&V.CatalogStockControlFlags>;
function tx<R extends Row,P extends Row>(a:V.CatalogStockControlActor,writing:boolean,active:boolean,ctx:Context,body:(c:PoolClient)=>Promise<R>,project:(v:R,f:V.CatalogStockControlFlags)=>P):Promise<P&V.CatalogStockControlFlags>;
async function tx(a:V.CatalogStockControlActor,writing:boolean,active:boolean,ctx:Context,body:(c:PoolClient)=>Promise<Row>,project:(v:Row,f:V.CatalogStockControlFlags)=>Row=(v,f)=>redact(v,f.can_read_value)):Promise<Row&V.CatalogStockControlFlags>{
  ensure(!writing||!ctx.readOnly,423,'Odtworzona kopia jest tylko do odczytu');
  V.catalogStockControlUuid.parse(a.tenantId);V.catalogStockControlUuid.parse(a.userId);if(a.apiKeyId)V.catalogStockControlUuid.parse(a.apiKeyId);
  const gate=ctx.schemaGate;if(gate)assertOwnedOrdinarySchemaTransactionGate(gate);
  const c=await pool.connect();let lease:Awaited<ReturnType<OrdinarySchemaTransactionGate['reserve']>>|undefined,destroy=false,firstError:unknown;
  const reserve=async()=>{if(gate)try{lease=await gate.reserve(c);}catch(error){destroy=true;throw error;}};
  const enter=async()=>{if(lease)try{await lease.enter();}catch(error){destroy=true;throw error;}};
  const closeLease=async()=>{if(lease)try{await lease.close();lease=undefined;}catch(error){destroy=true;throw error;}};
  T.beginCatalogStockControlTransaction(c);beginWmsTransaction(c);beginPurchasingTransaction(c);
  try{
    ensure((await c.query('SELECT session_user owner')).rows[0].owner==='postgres',403,'Nieprawidłowy właściciel połączenia BO');
    await reserve();await c.query(writing?'BEGIN ISOLATION LEVEL READ COMMITTED':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query('RESET ROLE');await enter();await c.query("SET LOCAL TimeZone='UTC'");await c.query("SET LOCAL statement_timeout='15s'");await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);
    ensure(await catalogStockControlAvailable(c),503,'Kopia nie zawiera ścisłej kontroli katalogu');
    if(writing){await wmsLotsAdmissionInTx(c,a,'shared');await purchasingStockAdmissionInTx(c,a);await T.catalogStockControlAdmissionInTx(c,a,'activation');}
    else await wmsLotsAdmissionInTx(c,a,'read');
    await access(c,a,writing,false,active);
    const value=await body(c);
    if(writing)await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    else{await c.query('COMMIT');await closeLease();await reserve();await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');await c.query('RESET ROLE');await enter();await c.query("SET LOCAL TimeZone='UTC'");await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);}
    ensure(await catalogStockControlAvailable(c),503,'Zakres modułu BO zmienił się');
    const f=flags(await access(c,a,writing,true,active),ctx);const response={...project(value,f),...f};
    if(writing)await T.finalizeCatalogStockCountTerminalInTx(c,[{actor:a,roles:['admin'],scopes:['inventory:read','inventory:write']}]);
    await c.query('COMMIT');return response;
  }catch(e){firstError=e;try{await c.query('ROLLBACK');}catch{destroy=true;}return mapError(e);}finally{let cleanup:unknown;try{await closeLease();}catch(error){cleanup=error;}T.endCatalogStockControlTransaction(c);endWmsTransaction(c);endPurchasingTransaction(c);if(destroy)c.release(true);else c.release();if(cleanup!==undefined&&firstError===undefined)throw cleanup;}
}
function previewView(p:Row,operationId:string|null):V.CatalogStockControlPreview{return{id:p.id,catalog_id:p.catalog_id,client_key:p.client_key,request:p.request,scope_hash:p.scope_hash,snapshot:p.frame.snapshot,blockers:p.frame.blockers,ready:p.frame.blockers.length===0,row_count:p.frame.rows.length,created_at:p.created_at,expires_at:p.expires_at,operation_id:operationId,can_commit:false};}
async function previewInTx(c:PoolClient,a:V.CatalogStockControlActor,id:string){const p=(await c.query('SELECT to_jsonb(p) row FROM public.catalog_stock_control_previews p WHERE(tenant_id,id)=($1,$2)',[a.tenantId,id])).rows[0]?.row;ensure(p,404,'Nie znaleziono własnego podglądu BO');const o=(await c.query('SELECT id FROM public.catalog_stock_control_operations WHERE(tenant_id,preview_id)=($1,$2)',[a.tenantId,id])).rows[0];return{p,view:previewView(p,o?.id??null)};}
function eligible(p:V.CatalogStockControlPreview,f:V.CatalogStockControlFlags){return{...redact(p,f.can_read_value),can_commit:f.activation_available&&f.can_manage&&p.ready&&p.operation_id===null&&Date.parse(p.expires_at)>Date.now()};}
export async function sourceCatalogStockControl(a:V.CatalogStockControlActor,id:string,ctx:Context={}){
  id=V.catalogStockControlUuid.parse(id);return tx(a,false,true,ctx,async c=>{const f=(await c.query('SELECT public.catalog_stock_control_frame($1) frame',[id])).rows[0].frame;return{source:{snapshot:f.snapshot,blockers:f.blockers,ready:f.blockers.length===0,can_preview:false}};},(v,f)=>({...redact(v,f.can_read_value),source:{...redact(v.source,f.can_read_value),can_preview:f.activation_available&&f.can_manage&&v.source.ready}}));
}
export async function previewCatalogStockControl(a:V.CatalogStockControlActor,id:string,input:unknown,ctx:Context={}){
  ensure(ctx.writersAvailable,503,'Adaptery wszystkich fizycznych writerów wymagają certyfikacji');
  id=V.catalogStockControlUuid.parse(id);const b=V.catalogStockControlPreviewInput.parse(input);b.warehouse_policy_versions.sort((x,y)=>x.warehouse_id.localeCompare(y.warehouse_id));b.series_versions.sort((x,y)=>x.warehouse_id.localeCompare(y.warehouse_id));
  return tx(a,true,true,ctx,async c=>{const r=(await c.query('SELECT public.catalog_stock_control_preview($1,$2,$3,$4::jsonb) result',[a.userId,a.apiKeyId??null,id,JSON.stringify(b)])).rows[0].result;const {view}=await previewInTx(c,a,r.preview.id);return{preview:view,reused:r.reused as boolean};},(v,f)=>({...v,preview:eligible(v.preview,f)}));
}
export async function commitCatalogStockControl(a:V.CatalogStockControlActor,id:string,input:unknown,ctx:Context={}){
  ensure(ctx.writersAvailable,503,'Adaptery wszystkich fizycznych writerów wymagają certyfikacji');
  id=V.catalogStockControlUuid.parse(id);const b=V.catalogStockControlCommitInput.parse(input);return tx(a,true,true,ctx,async c=>{const r=(await c.query('SELECT public.catalog_stock_control_commit($1,$2,$3,$4::jsonb) result',[a.userId,a.apiKeyId??null,id,JSON.stringify(b)])).rows[0].result;return{operation:r.operation as V.CatalogStockControlOperation,reused:r.reused as boolean};});
}
export async function catalogStockControlDetail(a:V.CatalogStockControlActor,kind:'preview'|'operation'|'document',id:string,ctx:Context={}){
  id=V.catalogStockControlUuid.parse(id);return tx(a,false,kind==='preview',ctx,async c=>{
    if(kind==='preview')return{preview:(await previewInTx(c,a,id)).view} as Row;
    const table=kind==='operation'?'catalog_stock_control_operations':'catalog_stock_control_documents';const r=(await c.query(`SELECT payload FROM public.${table} WHERE(tenant_id,id)=($1,$2)`,[a.tenantId,id])).rows[0];ensure(r,404,'Nie znaleziono własnego dowodu BO');return{[kind]:r.payload};
  },(v,f)=>v.preview?{...v,preview:eligible(v.preview,f)}:redact(v,f.can_read_value));
}
export async function catalogStockControlRows(a:V.CatalogStockControlActor,kind:'preview'|'document',id:string,input:unknown,ctx:Context={}){
  id=V.catalogStockControlUuid.parse(id);const q=V.catalogStockControlPageQuery.parse(input),offset=q.cursor??0;
  return tx(a,false,kind==='preview',ctx,async c=>{
    let all:V.CatalogStockControlRow[],pin:Row;
    if(kind==='preview'){const {p}=await previewInTx(c,a,id);all=p.frame.rows;pin={preview_id:id,scope_hash:p.scope_hash};}
    else{const d=(await c.query('SELECT payload FROM public.catalog_stock_control_documents WHERE(tenant_id,id)=($1,$2)',[a.tenantId,id])).rows[0];ensure(d,404,'Nie znaleziono własnego BO');all=(await c.query('SELECT ordinal,payload FROM public.catalog_stock_control_rows WHERE(tenant_id,document_id)=($1,$2) ORDER BY ordinal',[a.tenantId,id])).rows.map(r=>({...r.payload,source_ordinal:r.payload.ordinal,ordinal:r.ordinal}));pin={document_id:id};}
    ensure(offset<=all.length,409,'Kursor poza pełnym manifestem BO');return{data:all.slice(offset,offset+q.limit),meta:{...pin,cursor:offset+q.limit<all.length?offset+q.limit:null,limit:q.limit,total:all.length}};
  });
}
export async function catalogStockControlHistory(a:V.CatalogStockControlActor,input:unknown={},ctx:Context={}){
  const q=V.catalogStockControlHistoryQuery.parse(input);return tx(a,false,false,ctx,async c=>{
    if(q.catalog_id)ensure((await c.query('SELECT id FROM public.product_catalogs WHERE(tenant_id,id)=($1,$2)',[a.tenantId,q.catalog_id])).rowCount,404,'Nie znaleziono własnego katalogu historii BO');
    if(q.warehouse_id)ensure((await c.query('SELECT id FROM public.warehouses WHERE(tenant_id,id)=($1,$2)',[a.tenantId,q.warehouse_id])).rowCount,404,'Nie znaleziono własnego magazynu historii BO');
    if(q.cursor)ensure((await c.query('SELECT id FROM public.catalog_stock_control_operations WHERE(tenant_id,id)=($1,$2)',[a.tenantId,q.cursor])).rowCount,404,'Nie znaleziono własnego kursora BO');
    const rows=(await c.query(`SELECT payload FROM public.catalog_stock_control_operations o WHERE tenant_id=$1 AND($2::uuid IS NULL OR catalog_id=$2) AND($3::uuid IS NULL OR id<$3) AND($4::uuid IS NULL OR EXISTS(SELECT FROM public.catalog_stock_control_documents d WHERE(d.tenant_id,d.operation_id,d.warehouse_id)=($1,o.id,$4))) ORDER BY id DESC LIMIT $5`,[a.tenantId,q.catalog_id??null,q.cursor??null,q.warehouse_id??null,q.limit+1])).rows.map(r=>r.payload);
    return{data:rows.slice(0,q.limit),meta:{cursor:rows.length>q.limit?rows[q.limit-1].id:null,limit:q.limit}};
  });
}
const csv=(v:unknown)=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
const xml=(v:unknown)=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export async function exportCatalogStockControlDocument(a:V.CatalogStockControlActor,id:string,input:unknown,ctx:Context={}){
  id=V.catalogStockControlUuid.parse(id);const q=V.catalogStockControlExportQuery.parse(input);
  return tx(a,false,false,ctx,async c=>{const d=(await c.query('SELECT payload FROM public.catalog_stock_control_documents WHERE(tenant_id,id)=($1,$2)',[a.tenantId,id])).rows[0]?.payload;ensure(d,404,'Nie znaleziono własnego BO');const rows=(await c.query('SELECT ordinal,payload FROM public.catalog_stock_control_rows WHERE(tenant_id,document_id)=($1,$2) ORDER BY ordinal LIMIT 10001',[a.tenantId,id])).rows.map(r=>({...r.payload,source_ordinal:r.payload.ordinal,ordinal:r.ordinal}));ensure(rows.length===d.row_count&&rows.length<=V.CATALOG_STOCK_CONTROL_LIMITS.rows,413,'Niepełny lub zbyt duży manifest BO');return{document:d,rows};},(v,f)=>{
    ensure(!q.include_values||f.can_read_value,403,'Brak aktualnego prawa do wartości BO');const valuesIncluded=q.include_values&&v.document.summary.currency!==undefined;const safe=redact(v,valuesIncluded&&f.can_read_value);const cols=['ordinal','source_ordinal','warehouse_id','product_id','sku','name','location','quantity','reserved','stock_version','bin_basis_hash','layer_id','lot_id','position_version',...(valuesIncluded?['unit_cost_minor','value_minor','currency','exponent']:[])];
    const content=q.format==='csv'?['record,key,value',...Object.entries(safe.document).map(([k,v])=>['document',k,typeof v==='object'?JSON.stringify(v):v].map(csv).join(',')),cols.map(csv).join(','),...safe.rows.map((r:Row)=>cols.map(k=>csv(r[k])).join(','))].join('\r\n'):`<?xml version="1.0" encoding="UTF-8"?><bo><header>${Object.entries(safe.document).map(([k,v])=>`<${k}>${xml(typeof v==='object'?JSON.stringify(v):v)}</${k}>`).join('')}</header><rows>${safe.rows.map((r:Row)=>'<row>'+cols.map(k=>r[k]===null?`<${k} nil="true"/>`:`<${k}>${xml(r[k])}</${k}>`).join('')+'</row>').join('')}</rows></bo>`;
    const reply={document:safe.document,format:q.format,values_included:q.include_values&&safe.document.summary.currency!==undefined,filename:`BO-${id}.${q.format}`,content_type:q.format==='csv'?'text/csv; charset=utf-8':'application/xml; charset=utf-8',content,row_count:safe.rows.length};ensure(Buffer.byteLength(JSON.stringify(reply),'utf8')<=V.CATALOG_STOCK_CONTROL_LIMITS.export_bytes,413,'Limit pełnego eksportu BO');return reply;
  });
}
/** Same-client owner bridge. Original SQL errors survive aborted transaction restore. */
async function owner<R>(c:PoolClient,fn:()=>Promise<R>):Promise<R>{const prior=(await c.query('SELECT current_user role,session_user owner')).rows[0];ensure(prior.owner==='postgres'&&['postgres','dyna_app'].includes(prior.role),403,'Nieprawidłowy właściciel efektu strict');if(prior.role==='dyna_app')await c.query('RESET ROLE');let failed=false;try{return await fn();}catch(e){failed=true;return mapError(e);}finally{if(prior.role==='dyna_app'){if(failed)await c.query('SET LOCAL ROLE dyna_app').catch(()=>{});else await c.query('SET LOCAL ROLE dyna_app');}}}
// Token objects own custody. Failed transactions must not leave a strong token
// registry attached to a long-lived pooled client.
const tokens=new WeakMap<V.CatalogStockEffectAdmission,{client:PoolClient;actor:string;token:string}>();
const actorKey=(a:V.CatalogStockControlActor)=>JSON.stringify([a.tenantId,a.userId,a.apiKeyId??null,a.source??'manual']);
function assertToken(c:PoolClient,a:V.CatalogStockControlActor,t:V.CatalogStockEffectAdmission){const custody=tokens.get(t);ensure(custody&&custody.client===c&&custody.actor===actorKey(a)&&custody.token===JSON.stringify(t)&&t.tenant_id===a.tenantId,403,'Obcy lub zmieniony token strict');}
/** Metadata births use the real current policy; never manufacture a physical
 * admission for an empty product or expose private policy tables to app SQL. */
export async function catalogStockControlStrictCatalogInTx(c:PoolClient,a:V.CatalogStockControlActor,catalogId:string|null,requirements:{scopes:readonly string[]}={scopes:['products:write']}):Promise<boolean>{
  const admission=await T.catalogStockControlAdmissionInTx(c,a);
  if(!admission.installed||catalogId===null)return false;
  ensure((await c.query("SELECT current_setting('app.tenant_id',true) tenant")).rows[0].tenant===a.tenantId,403,'Obcy zakres katalogu');
  const strict=await owner(c,async()=>Boolean((await c.query('SELECT public.catalog_stock_control_policy($1) policy',[catalogId])).rows[0].policy.strict));
  if(strict)T.enlistCatalogStockControlActorInTx(c,a,{adminOnly:true,scopes:requirements.scopes});
  return strict;
}
// 270: when installed, the stock_verdict_ copy of a sealed adapter (the same body asking the 248 verdict for the catalog
// guard: same answer or error) instead of the sealed function, whose body runs the full guard; before 270, the sealed one.
async function installed270(c:PoolClient,signature:string):Promise<boolean>{return (await c.query('SELECT to_regprocedure($1) IS NOT NULL installed',[signature])).rows[0].installed;}
export async function prepareCatalogStockEffectInTx(c:PoolClient,a:V.CatalogStockControlActor,source:V.CatalogStockEffectSource):Promise<V.CatalogStockEffectAdmission|null>{
  source={...source,warehouse_ids:[...new Set(source.warehouse_ids)].sort(),product_ids:[...new Set(source.product_ids)].sort()};
  if(!await owner(c,()=>catalogStockControlAvailable(c)))return null;
  await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('catalog:'||$1,0))",[a.tenantId]);
  ensure(a.userId!==null||a.source==='system'&&!a.apiKeyId,403,'Brak jawnego systemowego kontekstu źródła');
  // Physical adapters retain the enclosing operation's authority. A PO
  // receipt is purchasing; a legacy bin move needs inventory:write alone.
  const scopes=source.source_kind==='purchase_receipt'?['purchasing:write']:
    source.source_kind==='dispatch'||source.source_kind==='return'?['orders:write']:
    ['wms_movement','wms_receipt','wms_opening','stocktake'].includes(source.source_kind)?['inventory:read','inventory:write']:
    ['inventory:write'];
  T.enlistCatalogStockControlActorInTx(c,a,{scopes,adminOnly:['warehouse_document','purchase_receipt','stocktake'].includes(source.source_kind)});
  const token=await owner(c,async()=>{const fn=await installed270(c,'public.stock_verdict_effect_prepare(uuid,uuid,jsonb)')?'stock_verdict_effect_prepare':'catalog_stock_control_effect_prepare';
    return (await c.query(`SELECT public.${fn}($1,$2,$3::jsonb) token`,[a.userId,a.apiKeyId??null,JSON.stringify(source)])).rows[0].token;}) as V.CatalogStockEffectAdmission|null;
  if(token)tokens.set(token,{client:c,actor:actorKey(a),token:JSON.stringify(token)});return token;
}
export async function finishCatalogStockEffectInTx(c:PoolClient,a:V.CatalogStockControlActor,token:V.CatalogStockEffectAdmission|null,proof:V.CatalogStockEffectProof){if(token){assertToken(c,a,token);await owner(c,async()=>{const fn=await installed270(c,'public.stock_verdict_effect_finish(uuid,uuid,uuid,jsonb)')?'stock_verdict_effect_finish':'catalog_stock_control_effect_finish';await c.query(`SELECT public.${fn}($1,$2,$3,$4::jsonb)`,[a.userId,a.apiKeyId??null,token.id,JSON.stringify(proof)]);});tokens.delete(token);}}
export async function abandonCatalogStockEffectInTx(c:PoolClient,a:V.CatalogStockControlActor,token:V.CatalogStockEffectAdmission|null){if(token){assertToken(c,a,token);await owner(c,async()=>{await c.query('SELECT public.catalog_stock_control_effect_abandon($1,$2,$3)',[a.userId,a.apiKeyId??null,token.id]);});tokens.delete(token);}}

/** Safe read of the already sealed correction graph, never a new admission.
 * Actual WMS caller performs fresh read/value IAM. Hydrate before its PIN. */
export async function catalogWmsCorrectionDocumentInTx(c:PoolClient,a:V.CatalogStockControlActor,operationId:string,values:boolean):Promise<Row|null>{
 ensure((await c.query("SELECT current_setting('app.tenant_id',true) tenant")).rows[0].tenant===a.tenantId,403,'Obcy odczyt dokumentu korekty');
 operationId=V.catalogStockControlUuid.parse(operationId);
 return owner(c,async()=>{
  if(!await catalogStockControlAvailable(c))return null;
  const rows=(await c.query(`SELECT e.proof->'correction_document' document FROM public.catalog_stock_control_effects e
   JOIN public.catalog_stock_control_effect_admissions a ON(a.tenant_id,a.id)=(e.tenant_id,e.admission_id)
   WHERE(e.tenant_id,e.operation_id)=($1,$2) AND a.source_kind='wms_movement' AND a.sealed`,[a.tenantId,operationId])).rows;
  ensure(rows.length<=1,409,'Powielony dokument korekty');return rows[0]?.document?redact(rows[0].document,values):null;
 });
}

/** Pure projection after the native caller's final fresh permission check. */
export function projectCatalogWmsCorrectionDocument(document:Row|null,values:boolean):Row|null{return redact(document,values);}

/** Quantity-only, one page/one query. Immutable source hydration precedes the
 * WMS caller's final fresh IAM PIN; never returns private proof or cost fields. */
const correctionOperationHeadSchema=z.strictObject({
 id:V.catalogStockControlUuid,protocol:z.literal('wms_adjustment'),operation_id:V.catalogStockControlUuid,
 kind:z.enum(['PW','RW']),number:z.string().min(1).max(100),year:z.number().int().min(1).max(9999),
 sequence:z.string().regex(/^[1-9][0-9]{0,18}$/),quantity:z.string().regex(/^[1-9][0-9]{0,18}$/),
 row_count:z.number().int().min(1).max(10000),
 warehouse:z.strictObject({id:V.catalogStockControlUuid,name:z.string(),code:z.string()}),
 product:z.strictObject({id:V.catalogStockControlUuid,sku:z.string(),name:z.string()}),
});
export type CatalogWmsCorrectionOperationHead=z.infer<typeof correctionOperationHeadSchema>;
export async function catalogWmsCorrectionHeadsInTx(c:PoolClient,a:V.CatalogStockControlActor,operationIds:readonly string[]):Promise<Map<string,CatalogWmsCorrectionOperationHead>>{
 ensure(operationIds.length<=50,413,'Limit strony historii korekt');
 const ids=operationIds.map(id=>V.catalogStockControlUuid.parse(id));
 ensure(new Set(ids).size===ids.length,409,'Powielona operacja historii');
 ensure((await c.query("SELECT current_setting('app.tenant_id',true) tenant")).rows[0].tenant===a.tenantId,403,'Obcy odczyt historii korekt');
 return owner(c,async()=>{
  const result=new Map<string,CatalogWmsCorrectionOperationHead>();
  // Probe even an empty page: damaged installed publisher must not become EOF.
  if(!await catalogStockControlAvailable(c)||ids.length===0)return result;
  const records=(await c.query(`/* catalog_wms_correction_heads_page */
   SELECT e.operation_id,jsonb_build_object('id',p->'id','protocol',p->'protocol','operation_id',p->'operation_id',
    'kind',p->'kind','number',p->'number','year',p->'year','sequence',p->'sequence',
    'quantity',p->'quantity','row_count',p->'row_count','warehouse',p->'warehouse',
    'product',jsonb_build_object('id',dl.product_id,'sku',dl.sku,'name',dl.name)) head,
    coalesce(a.sealed AND a.source_kind='wms_movement' AND p->>'protocol'='wms_adjustment'
     AND p->>'id'=a.id::text AND p->>'operation_id'=o.id::text AND p->>'preview_id'=pv.id::text
     AND p->>'warehouse_document_id'=d.id::text AND e.warehouse_document_id=d.id
     AND a.source_id=pv.id AND pv.actor_id=a.actor_id AND o.actor_id=a.actor_id
     AND pv.kind='adjustment' AND pv.ready AND o.kind='adjustment'
     AND o.request->>'preview_id'=pv.id::text AND o.request->>'scope_hash'=pv.scope_hash
     AND o.request->'confirmed'='true'::jsonb AND o.warehouse_document_id=d.id
     AND o.order_id IS NULL AND o.return_id IS NULL AND o.purchase_receipt_id IS NULL
     AND d.status='posted' AND d.reference='WMS/'||pv.id::text AND d.destination_id IS NULL
     AND d.warehouse_id::text=pv.request->>'warehouse_id' AND p#>>'{warehouse,id}'=d.warehouse_id::text
     AND a.request->'product_ids'=jsonb_build_array(pv.request->'product_id')
     AND a.request->'warehouse_ids'=jsonb_build_array(pv.request->'warehouse_id')
     AND p->>'number'=a.number->>'number' AND p->>'kind'=a.number->>'kind'
     AND p->>'series_id'=a.number->>'series_id' AND p->'year'=a.number->'year'
     AND p->>'sequence'=a.number->>'sequence' AND dl.n=1
     AND dl.product_id::text=pv.request->>'product_id' AND dl.location=pv.request->>'location'
     AND sm.n=1 AND bm.n=1 AND sm.delta<>0 AND sm.delta::text=pv.request->>'quantity'
     AND sm.kind='wms_adjustment' AND bm.kind='wms_adjustment' AND bm.delta=sm.delta
     AND sm.product_id=dl.product_id AND bm.product_id=dl.product_id
     AND sm.warehouse_id=d.warehouse_id AND bm.warehouse_id=d.warehouse_id AND bm.location=dl.location
     AND dl.quantity=abs(sm.delta) AND p->>'quantity'=abs(sm.delta)::text
     AND p->>'kind'=(CASE WHEN sm.delta>0 THEN 'PW' ELSE 'RW' END)
     AND d.kind=(CASE WHEN sm.delta>0 THEN 'receipt' ELSE 'issue' END)
     AND rw.n BETWEEN 1 AND 10000 AND rw.n=rw.distinct_ids AND rw.n=lm.n
     AND p->>'row_count'=rw.n::text AND rw.quantity=abs(sm.delta)::numeric
     AND rw.valid AND (sm.delta<0 OR rw.n=1),false) bound
   FROM public.catalog_stock_control_effects e
   JOIN public.catalog_stock_control_effect_admissions a ON(a.tenant_id,a.id)=(e.tenant_id,e.admission_id)
   CROSS JOIN LATERAL(SELECT e.proof->'correction_document' p) publication
   LEFT JOIN public.wms_operations o ON(o.tenant_id,o.id)=(e.tenant_id,e.operation_id)
   LEFT JOIN public.wms_previews pv ON(pv.tenant_id,pv.id)=(a.tenant_id,a.source_id)
   LEFT JOIN public.warehouse_documents d ON(d.tenant_id,d.id)=(e.tenant_id,e.warehouse_document_id)
   LEFT JOIN LATERAL(SELECT count(*) n,min(product_id::text)::uuid product_id,min(sku) sku,min(name) name,
    min(location) location,min(quantity) quantity FROM public.warehouse_document_lines
    WHERE(tenant_id,document_id)=(e.tenant_id,d.id)) dl ON true
   LEFT JOIN LATERAL(SELECT count(*) n,min(id::text)::uuid id,min(product_id::text)::uuid product_id,
    min(warehouse_id::text)::uuid warehouse_id,min(delta) delta,min(kind) kind
    FROM public.stock_movements WHERE(tenant_id,warehouse_document_id)=(e.tenant_id,d.id)) sm ON true
   LEFT JOIN LATERAL(SELECT count(*) n,min(id::text)::uuid id,min(product_id::text)::uuid product_id,
    min(warehouse_id::text)::uuid warehouse_id,min(delta) delta,min(kind) kind,min(location) location
    FROM public.stock_location_movements WHERE(tenant_id,operation_id)=(e.tenant_id,o.id)) bm ON true
   LEFT JOIN LATERAL(SELECT count(*) n FROM public.wms_layer_movements
    WHERE(tenant_id,operation_id)=(e.tenant_id,o.id)) lm ON true
   LEFT JOIN LATERAL(SELECT count(*) n,count(DISTINCT r->>'layer_movement_id') distinct_ids,
    sum(abs(j.delta)::numeric) quantity,bool_and(coalesce(
     r->>'ordinal'=(ord-1)::text AND r->>'product_id'=dl.product_id::text
     AND r->>'warehouse_id'=d.warehouse_id::text AND r->>'operation_id'=o.id::text
     AND r->>'sku'=dl.sku AND r->>'name'=dl.name AND r->>'location'=dl.location
     AND r->>'stock_movement_id'=sm.id::text AND r->>'location_movement_id'=bm.id::text
     AND r->>'quantity'=abs(j.delta)::text AND r->>'delta'=j.delta::text
     AND j.kind='adjustment' AND sign(j.delta)=sign(sm.delta) AND j.delta<>0
     AND j.product_id=dl.product_id AND j.warehouse_id=d.warehouse_id AND j.location=dl.location
     AND r->>'layer_id'=cl.id::text AND r->>'lot_id'=lot.id::text,false)) valid
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'rows')='array' THEN p->'rows' ELSE '[]'::jsonb END)
      WITH ORDINALITY frozen(r,ord)
    LEFT JOIN public.wms_layer_movements j ON j.tenant_id=e.tenant_id AND j.id::text=r->>'layer_movement_id' AND j.operation_id=o.id
    LEFT JOIN public.wms_cost_layers cl ON(cl.tenant_id,cl.id,cl.product_id)=(j.tenant_id,j.layer_id,j.product_id)
    LEFT JOIN public.wms_lots lot ON(lot.tenant_id,lot.id,lot.product_id)=(cl.tenant_id,cl.lot_id,cl.product_id)) rw ON true
   WHERE e.tenant_id=$1 AND e.operation_id=ANY($2::uuid[]) AND (e.proof ? 'correction_document' OR (a.source_kind='wms_movement' AND pv.kind='adjustment'))`,[a.tenantId,ids])).rows;
  for(const r of records){const parsed=correctionOperationHeadSchema.safeParse(r.head);
   ensure(r.bound===true&&parsed.success,503,'Niepełny zapieczętowany nagłówek korekty');
   if(!parsed.success)throw new Problem(503,'Niepełny nagłówek korekty');const h=parsed.data;
   ensure(ids.includes(r.operation_id)&&h.operation_id===r.operation_id&&!result.has(r.operation_id)
    &&h.number===`${h.kind}/${h.year}/${h.sequence.padStart(6,'0')}`
    &&BigInt(h.sequence)<=9223372036854775807n&&BigInt(h.quantity)<=2147483647n,
    503,'Obcy lub powielony nagłówek korekty');result.set(r.operation_id,h);
  }return result;
 });
}
