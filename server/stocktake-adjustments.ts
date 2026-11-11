import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { pool, tenantTx, localConfig } from './db';
import { ensure, Problem } from './errors';
import { audit } from './domain';
import { transitionStocktake } from './stocktakes';
import { postWmsStocktakeInTx } from './wms-stocktakes';
import * as V from './stocktake-adjustments-schema';
import { prepareCatalogStockEffectInTx, finishCatalogStockEffectInTx, abandonCatalogStockEffectInTx } from './catalog-stock-control';
import { captureCatalogStockEffectJournalsInTx, catalogStockEffectProofInTx } from './catalog-stock-effects';

type Row = Record<string, any>;
type Grant = V.AdjustmentFlags;
type Context = { readOnly?: boolean };
type Access = { writing: boolean; admin: boolean; on: boolean };
const incomplete = () => new Problem(503, 'Niekompletne dokumenty rozliczenia spisu');

export async function stocktakeAdjustmentsAvailable(c: Pool|PoolClient = pool): Promise<boolean> {
  const p = (await c.query(`SELECT to_regprocedure('public.stocktake_adjustment_installed()') marker,
    EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'stocktake_adjustment_%')
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'stocktake_adjustment_%')
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'stocktake_adjustment_%')
    OR EXISTS(SELECT 1 FROM pg_constraint WHERE conname IN('stocktake_adjustment_stock_identity','stocktake_adjustment_location_identity')) partial,
    to_regclass('public.migrations') ledger`)).rows[0];
  const installed = p.ledger && (await c.query("SELECT EXISTS(SELECT 1 FROM public.migrations WHERE name='149_stocktake_adjustments') installed")).rows[0].installed;
  if (!p.marker) { if (p.partial || installed) throw incomplete(); return false; }
  try { ensure((await c.query('SELECT public.stocktake_adjustment_guards() ok')).rows[0]?.ok, 503, 'Niekompletne dokumenty rozliczenia spisu'); return true; }
  catch (error: any) { if (['42P01','42703','42883'].includes(error.code)) throw incomplete(); throw error; }
}
function mapped(error: any): never {
  if (error instanceof Problem) throw error;
  if (error.code === '55000') throw incomplete();
  if (error.code === '28000') throw new Problem(401, 'Klucz API został cofnięty lub wygasł');
  if (error.code === '42501') throw new Problem(403, 'Brak aktualnego uprawnienia rozliczenia spisu');
  if (error.code === 'P0002') throw new Problem(404, 'Nie znaleziono własnego spisu, serii lub dokumentu');
  if (error.code === '54000') throw new Problem(413, 'Limit dowodów rozliczenia spisu');
  if (['23514','23503','23505','P0003'].includes(error.code)) throw new Problem(409, 'Zakres spisu, dokumentów lub numeracji zmienił się');
  throw error;
}
/** Same managed owner connection; this bridge is infrastructure, not a public principal. */
async function owner<T>(c: PoolClient, a: V.AdjustmentActor, work: () => Promise<T>): Promise<T> {
  const before = (await c.query('SELECT current_user role,session_user owner,current_setting(\'app.tenant_id\') tenant')).rows[0];
  ensure(before.tenant === a.tenantId && (before.role === 'dyna_app' || before.role === before.owner), 403, 'Nieprawidłowy kontekst transakcji');
  await c.query('RESET ROLE');
  let failed = false;
  try {
    const identity = (await c.query(`SELECT current_user=session_user own,
      pg_get_userbyid(relowner)=session_user relation_owner FROM pg_class WHERE oid='public.stocktake_adjustment_series'::regclass`)).rows[0];
    ensure(identity?.own && identity?.relation_owner, 403, 'Nieprawidłowy właściciel połączenia');
    return await work();
  } catch (error) { failed = true; throw error; }
  finally { if (before.role === 'dyna_app') {
    try { await c.query('SET LOCAL ROLE dyna_app'); }
    catch (error) { if (!failed) throw error; }
  } }
}
async function grant(c: PoolClient, a: V.AdjustmentActor, access: Access, pin: boolean): Promise<Grant> {
  return owner(c,a,async () => {
    if(pin)ensure(await stocktakeAdjustmentsAvailable(c),503,'Niekompletne dokumenty spisu');
    return (await c.query('SELECT public.stocktake_adjustment_access($1,$2,$3,$4,$5,$6) access_flags',
      [a.userId,a.apiKeyId ?? null,access.writing,access.admin,access.on,pin])).rows[0].access_flags;
  });
}
const moneyKeys = new Set(['unit_cost_minor','currency','exponent','value_minor','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','rows_sha256','_exponent']);
function project(value: unknown, costs: boolean): any {
  if (Array.isArray(value)) return value.map(v => project(v,costs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== '_exponent' && (costs || !moneyKeys.has(k))).map(([k,v])=>[k,project(v,costs)]));
  return value;
}
function flags(g: Grant, ctx: Context): V.AdjustmentFlags { return { available:true,read_only:!!ctx.readOnly,
  current_role:g.current_role,can_read:g.can_read,can_write:g.can_write && !ctx.readOnly,can_read_value:g.can_read_value }; }
function controls(value: Row,g: Grant,ctx: Context): Row {
  value=project(value,g.can_read_value);
  if(value.source) value.source={...value.source,can_preview:value.source.can_preview && g.current_role==='admin' && g.can_write && !ctx.readOnly};
  if(value.preview) value.preview={...value.preview,can_post:!value.preview.receipt_id && Date.parse(value.preview.expires_at)>Date.now() && g.current_role==='admin' && g.can_write && !ctx.readOnly};
  return {...value,...flags(g,ctx)};
}
async function tx<T extends Row>(a: V.AdjustmentActor,ctx: Context,access: Access,work:(c:PoolClient,access:Access)=>Promise<T>):Promise<T & V.AdjustmentFlags> {
  ensure(!access.writing || !ctx.readOnly,423,'Odtworzona kopia jest tylko do odczytu');
  V.adjustmentUuid.parse(a.tenantId);V.adjustmentUuid.parse(a.userId);if(a.apiKeyId)V.adjustmentUuid.parse(a.apiKeyId);
  try { return await tenantTx(a.tenantId,async c => {
    await c.query("SET LOCAL TimeZone='UTC'");
    ensure(await owner(c,a,()=>stocktakeAdjustmentsAvailable(c)),503,'Kopia nie zawiera dokumentów spisu');
    await grant(c,a,access,false);
    const result=await work(c,access);
    await owner(c,a,async()=>{await c.query('SELECT public.stocktake_adjustment_budget()');});
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    // No FK, journal, document or output hydration query may follow this PIN.
    const current=await grant(c,a,access,true);
    const response=controls(result,current,ctx);
    ensure(Buffer.byteLength(JSON.stringify(response))<=V.STOCKTAKE_ADJUSTMENT_LIMITS.response_bytes,413,'Odpowiedź przekracza limit');
    return response as T & V.AdjustmentFlags;
  },{wmsAdmission:access.writing?'serial':'read'}); } catch(error){return mapped(error);}
}
const read: Access={writing:false,admin:false,on:false};
function snapshot(p:Row): V.AdjustmentSnapshot { return {source:p.frame.source,year:p.frame.year,series:p.frame.series,
  row_count:p.frame.row_count,rows_sha256:p.frame.rows_sha256,summary:p.frame.summary}; }
async function storedPreview(c:PoolClient,a:V.AdjustmentActor,id:string):Promise<Row> {
  return owner(c,a,async()=>{const p=(await c.query(`SELECT p.*,to_jsonb(p)->>'created_at' created_at,to_jsonb(p)->>'expires_at' expires_at,
    r.id receipt_id FROM public.stocktake_adjustment_previews p LEFT JOIN public.stocktake_adjustment_receipts r ON(r.tenant_id,r.preview_id)=(p.tenant_id,p.id)
    WHERE(p.tenant_id,p.id)=($1,$2)`,[a.tenantId,id])).rows[0];ensure(p,404,'Nie znaleziono własnego podglądu');return p;});
}
function previewView(p:Row):V.AdjustmentPreview {return {id:p.id,source_kind:p.source_kind,stocktake_id:p.request.stocktake_id,
  request:p.request,scope_hash:p.scope_hash,snapshot:snapshot(p),created_at:p.created_at,expires_at:p.expires_at,
  receipt_id:p.receipt_id??null,can_post:false};}
function seriesView(s:Row):V.AdjustmentSeries {return {id:s.id,kind:s.kind,name:s.name,prefix:s.prefix,version:'1',created_at:s.created_at};}
async function documents(c:PoolClient,a:V.AdjustmentActor,receiptId:string):Promise<V.AdjustmentDocument[]> {
  return owner(c,a,async()=>{const rows=(await c.query(`SELECT d.*,to_jsonb(d)->>'created_at' created_at,p.source_kind,p.request->>'stocktake_id' stocktake_id,p.frame->'source'->'warehouse' warehouse
    FROM public.stocktake_adjustment_documents d JOIN public.stocktake_adjustment_receipts r ON(r.tenant_id,r.id)=(d.tenant_id,d.receipt_id)
    JOIN public.stocktake_adjustment_previews p ON(p.tenant_id,p.id)=(r.tenant_id,r.preview_id) WHERE(d.tenant_id,d.receipt_id)=($1,$2) ORDER BY d.kind`,[a.tenantId,receiptId])).rows;
    return rows.map(documentView);});
}
function documentView(d:Row):V.AdjustmentDocument {return {id:d.id,receipt_id:d.receipt_id,kind:d.kind,number:d.number,series_id:d.series_id,
  year:d.year,sequence:String(d.sequence),source_kind:d.source_kind,stocktake_id:d.stocktake_id,warehouse:d.warehouse,row_count:d.row_count,summary:d.summary,created_at:d.created_at};}
async function receipt(c:PoolClient,a:V.AdjustmentActor,id:string):Promise<V.AdjustmentReceipt> {
  const r=await owner(c,a,async()=>{const row=(await c.query(`SELECT r.*,to_jsonb(r)->>'created_at' created_at,p.frame,p.scope_hash,p.request preview_request
    FROM public.stocktake_adjustment_receipts r JOIN public.stocktake_adjustment_previews p ON(p.tenant_id,p.id)=(r.tenant_id,r.preview_id) WHERE(r.tenant_id,r.id)=($1,$2)`,[a.tenantId,id])).rows[0];ensure(row,404,'Nie znaleziono własnego potwierdzenia');return row;});
  return {id:r.id,preview_id:r.preview_id,client_key:r.client_key,scope_hash:r.scope_hash,request:r.request,snapshot:snapshot(r),
    source:{source_kind:r.source_kind,stocktake_id:r.preview_request.stocktake_id,posting_id:r.posting_id,operation_id:r.operation_id,version:String(r.source_version),state:'posted'},
    documents:await documents(c,a,id),created_at:r.created_at};
}
async function fenceWarehouse(c:PoolClient,a:V.AdjustmentActor,sk:string,sid:string) {
  const wh=await owner(c,a,async()=>{const h=(await c.query(`SELECT warehouse_id FROM public.${sk==='wms'?'wms_stocktakes':'stocktakes'} WHERE(tenant_id,id)=($1,$2)`,[a.tenantId,sid])).rows[0];ensure(h,404,'Nie znaleziono własnego spisu');return h.warehouse_id;});
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['catalog:'+a.tenantId]);
  await owner(c,a,async()=>{await c.query('SELECT public.warehouse_inventory_policy_lock($1,$2)',[a.tenantId,wh]);});
  return wh;
}
export async function stocktakeAdjustmentOptions(a:V.AdjustmentActor,ctx:Context={}) {
  if(!await stocktakeAdjustmentsAvailable()) return {available:false,read_only:!!ctx.readOnly,current_role:null,can_read:false,can_write:false,can_read_value:false,series:[],limits:V.STOCKTAKE_ADJUSTMENT_LIMITS};
  return tx(a,ctx,{...read},async c=>({series:await owner(c,a,async()=>{const rows=(await c.query("SELECT s.*,to_jsonb(s)->>'created_at' created_at FROM public.stocktake_adjustment_series s WHERE tenant_id=$1 ORDER BY kind,name,id LIMIT 101",[a.tenantId])).rows;ensure(rows.length<=100,413,'Limit serii');return rows.map(seriesView);}),limits:V.STOCKTAKE_ADJUSTMENT_LIMITS}));
}
export async function createStocktakeAdjustmentSeries(a:V.AdjustmentActor,raw:unknown,ctx:Context={}) {
  const b=V.adjustmentSeriesInput.parse(raw);return tx(a,ctx,{writing:true,admin:true,on:false},async c=>{
    const id=randomUUID();const chosen=await owner(c,a,async()=>(await c.query('SELECT public.stocktake_adjustment_create_series($1,$2,$3,$4) id',[id,JSON.stringify(b),a.userId,a.apiKeyId??null])).rows[0].id);
    const s=await owner(c,a,async()=>(await c.query("SELECT s.*,to_jsonb(s)->>'created_at' created_at FROM public.stocktake_adjustment_series s WHERE(tenant_id,id)=($1,$2)",[a.tenantId,chosen])).rows[0]);
    if(chosen===id)await audit(c,{...a,source:a.source??'manual'},'stocktake.adjustment.series',chosen,{});
    return {series:seriesView(s),reused:chosen!==id};});
}
export async function stocktakeAdjustmentSource(a:V.AdjustmentActor,sk:'quantity'|'wms',id:string,ctx:Context={}) {
  return tx(a,ctx,{...read,admin:true,on:sk==='wms'},async c=>({source:await owner(c,a,async()=>(await c.query('SELECT public.stocktake_adjustment_source($1,$2) payload',[sk,id])).rows[0].payload.source)}));
}
export async function previewStocktakeAdjustment(a:V.AdjustmentActor,raw:unknown,ctx:Context={}) {
  const b=V.adjustmentPreviewInput.parse(raw);return tx(a,ctx,{writing:true,admin:true,on:b.source_kind==='wms'},async c=>{
    await fenceWarehouse(c,a,b.source_kind,b.stocktake_id);const id=randomUUID();const chosen=await owner(c,a,async()=>(await c.query('SELECT public.stocktake_adjustment_preview($1,$2,$3,$4) id',[id,JSON.stringify(b),a.userId,a.apiKeyId??null])).rows[0].id);
    return {preview:previewView(await storedPreview(c,a,chosen)),reused:chosen!==id};});
}
export async function stocktakeAdjustmentPreview(a:V.AdjustmentActor,id:string,ctx:Context={}) {
  return tx(a,ctx,{...read},async(c,access)=>{const p=await storedPreview(c,a,id);access.admin=!p.receipt_id;access.on=p.source_kind==='wms';return {preview:previewView(p)};});
}
export async function stocktakeAdjustmentPreviewRows(a:V.AdjustmentActor,id:string,q:ReturnType<typeof V.adjustmentRowsQuery.parse>,ctx:Context={}) {
  return tx(a,ctx,{...read},async(c,access)=>{const p=await storedPreview(c,a,id);access.admin=!p.receipt_id;access.on=p.source_kind==='wms';
    const rows=await owner(c,a,async()=>(await c.query('SELECT payload FROM public.stocktake_adjustment_preview_rows WHERE(tenant_id,preview_id)=($1,$2) AND ordinal>=$3 ORDER BY ordinal LIMIT $4',[a.tenantId,id,Number(q.cursor??0),q.limit])).rows);
    const total=Number(p.frame.row_count),next=Number(q.cursor??0)+rows.length;
    return {data:rows.map(r=>r.payload),meta:{cursor:next<total?String(next):null,total},preview_id:id,scope_hash:p.scope_hash};});
}
/** Called once inside a managed tenant transaction; receipts resolve ACK loss before any fresh source/CAS. */
export async function postStocktakeAdjustmentInTx(c:PoolClient,a:V.AdjustmentActor,id:string,raw:unknown) {
  const b=V.adjustmentPostInput.parse(raw);const p=await storedPreview(c,a,id);
  const access:Access={writing:true,admin:true,on:p.source_kind==='wms'};
  await grant(c,a,access,false);
  const existing=await owner(c,a,async()=>(await c.query('SELECT id,actor_id,api_key_id,preview_id,request FROM public.stocktake_adjustment_receipts WHERE(tenant_id,client_key)=($1,$2)',[a.tenantId,b.client_key])).rows[0]);
  if(existing){ensure(existing.actor_id===a.userId && existing.api_key_id===(a.apiKeyId??null) && existing.preview_id===id && isDeepStrictEqual(existing.request,b),409,'Klucz ma inne żądanie');
    const saved=await receipt(c,a,existing.id);await c.query('SET CONSTRAINTS ALL IMMEDIATE');await grant(c,a,access,true);return {receipt:saved,documents:saved.documents,reused:true};}
  const products = await owner(c,a,async() => (await c.query(
    `SELECT DISTINCT (payload->>'product_id')::uuid product_id FROM public.stocktake_adjustment_preview_rows
     WHERE tenant_id=$1 AND preview_id=$2 ORDER BY product_id LIMIT 10001`, [a.tenantId,id])).rows.map(r => r.product_id as string));
  ensure(products.length <= 10000,413,'Pełny zakres rozliczenia spisu przekracza limit');
  const eid=randomUUID();
  const catalogEffect = products.length ? await prepareCatalogStockEffectInTx(c,a,{
    source_kind:'stocktake',source_id:eid,warehouse_ids:[p.frame.source.warehouse.id],product_ids:products,
  }) : null;
  const catalogBaseline = await captureCatalogStockEffectJournalsInTx(c,catalogEffect);
  await fenceWarehouse(c,a,p.source_kind,p.request.stocktake_id);
  const chosen=await owner(c,a,async()=>(await c.query('SELECT public.stocktake_adjustment_prepare($1,$2,$3,$4,$5) id',[id,eid,JSON.stringify(b),a.userId,a.apiKeyId??null])).rows[0].id);
  if(chosen!==eid){if(catalogEffect)await abandonCatalogStockEffectInTx(c,a,catalogEffect);const saved=await receipt(c,a,chosen);await c.query('SET CONSTRAINTS ALL IMMEDIATE');await grant(c,a,access,true);return {receipt:saved,documents:saved.documents,reused:true};}
  const finish=async()=>{await owner(c,a,async()=>{await c.query('SELECT public.stocktake_adjustment_finish($1,$2,$3)',[eid,a.userId,a.apiKeyId??null]);});
    if(catalogEffect&&catalogBaseline)await finishCatalogStockEffectInTx(c,a,catalogEffect,
      await catalogStockEffectProofInTx(c,catalogBaseline,{receipt_id:eid}));
  };
  if(p.source_kind==='quantity'){await transitionStocktake(c,{...a,source:a.source??'manual'},p.request.stocktake_id,{version:p.request.version},'post');await finish();}
  else await postWmsStocktakeInTx(c,{...a,source:a.source??'manual',canReadValue:true},p.request.stocktake_id,
    {client_key:b.client_key,version:p.request.version,review_id:p.request.review_id,scope_hash:p.request.scope_hash,confirmed:true},
    {adjustment:{admissionId:eid,beforeFinish:finish}});
  await audit(c,{...a,source:a.source??'manual'},'stocktake.adjustment.post',eid,{preview_id:id});
  const saved=await receipt(c,a,eid);await c.query('SET CONSTRAINTS ALL IMMEDIATE');await grant(c,a,access,true);
  return {receipt:saved,documents:saved.documents,reused:false};
}
export async function postStocktakeAdjustment(a:V.AdjustmentActor,id:string,raw:unknown,ctx:Context={}) {
  const b=V.adjustmentPostInput.parse(raw);return tx(a,ctx,{writing:true,admin:true,on:false},async(c,access)=>{const p=await storedPreview(c,a,id);access.on=p.source_kind==='wms';await grant(c,a,access,false);return postStocktakeAdjustmentInTx(c,a,id,b);});
}
export async function stocktakeAdjustmentReceipt(a:V.AdjustmentActor,id:string,ctx:Context={}) {return tx(a,ctx,{...read},async c=>{const r=await receipt(c,a,id);return {receipt:r,documents:r.documents};});}
export async function stocktakeAdjustmentDocuments(a:V.AdjustmentActor,q:ReturnType<typeof V.adjustmentHistoryQuery.parse>,ctx:Context={}) {
  return tx(a,ctx,{...read},async c=>{const rows=await owner(c,a,async()=>(await c.query(`SELECT d.*,to_jsonb(d)->>'created_at' created_at,p.source_kind,p.request->>'stocktake_id' stocktake_id,p.frame->'source'->'warehouse' warehouse
    FROM public.stocktake_adjustment_documents d JOIN public.stocktake_adjustment_receipts r ON(r.tenant_id,r.id)=(d.tenant_id,d.receipt_id)
    JOIN public.stocktake_adjustment_previews p ON(p.tenant_id,p.id)=(r.tenant_id,r.preview_id) WHERE d.tenant_id=$1
    AND($2::uuid IS NULL OR(d.created_at,d.id)<(SELECT created_at,id FROM public.stocktake_adjustment_documents WHERE(tenant_id,id)=($1,$2)))
    AND($3::text IS NULL OR d.kind=$3) AND($4::uuid IS NULL OR d.warehouse_id=$4) AND($5::text IS NULL OR p.source_kind=$5)
    AND($6::uuid IS NULL OR coalesce(p.quantity_stocktake_id,p.wms_stocktake_id)=$6) ORDER BY d.created_at DESC,d.id DESC LIMIT $7`,
    [a.tenantId,q.cursor??null,q.kind??null,q.warehouse_id??null,q.source_kind??null,q.stocktake_id??null,q.limit+1])).rows);
    return {data:rows.slice(0,q.limit).map(documentView),meta:{cursor:rows.length>q.limit?rows[q.limit-1].id:null}};});
}
async function oneDocument(c:PoolClient,a:V.AdjustmentActor,id:string) {const r=await owner(c,a,async()=>(await c.query('SELECT receipt_id FROM public.stocktake_adjustment_documents WHERE(tenant_id,id)=($1,$2)',[a.tenantId,id])).rows[0]);ensure(r,404,'Nie znaleziono własnego dokumentu');const d=(await documents(c,a,r.receipt_id)).find(v=>v.id===id);ensure(d,404,'Nie znaleziono dokumentu');return d;}
export async function stocktakeAdjustmentDocument(a:V.AdjustmentActor,id:string,ctx:Context={}) {return tx(a,ctx,{...read},async c=>({document:await oneDocument(c,a,id)}));}
export async function stocktakeAdjustmentDocumentRows(a:V.AdjustmentActor,id:string,q:ReturnType<typeof V.adjustmentRowsQuery.parse>,ctx:Context={}) {
  return tx(a,ctx,{...read},async c=>{const d=await oneDocument(c,a,id);const rows=await owner(c,a,async()=>(await c.query('SELECT payload FROM public.stocktake_adjustment_document_rows WHERE(tenant_id,document_id)=($1,$2) AND ordinal>=$3 ORDER BY ordinal LIMIT $4',[a.tenantId,id,Number(q.cursor??0),q.limit])).rows);
    const next=Number(q.cursor??0)+rows.length;return {data:rows.map(r=>r.payload),meta:{cursor:next<d.row_count?String(next):null,total:d.row_count},document_id:id};});
}

// Immutable document reads keep the entire header/manifest in one RR snapshot.
// A separate RC finalizer on this same connection sees current IAM after waits.
// No hydration, resource query or rendered content precedes the final grant.
async function immutableRead<T,R extends Row>(a:V.AdjustmentActor,ctx:Context,
  work:(c:PoolClient,g:Grant)=>Promise<T>,finish:(value:T,current:Grant)=>R):Promise<R & V.AdjustmentFlags> {
  V.adjustmentUuid.parse(a.tenantId);V.adjustmentUuid.parse(a.userId);if(a.apiKeyId)V.adjustmentUuid.parse(a.apiKeyId);
  const c=await pool.connect();
  async function context() {
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);
    await c.query("SET LOCAL TimeZone='UTC'");await c.query("SET LOCAL statement_timeout='8s'");
  }
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await context();
    ensure(await owner(c,a,()=>stocktakeAdjustmentsAvailable(c)),503,'Kopia nie zawiera dokumentów spisu');
    const initial=await grant(c,a,read,false),value=await work(c,initial);
    await c.query('COMMIT');
    // IAM FOR SHARE needs a writable transaction; this finalizer performs no DML.
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');await context();
    const current=await grant(c,a,read,true);
    // Finish is pure. Explicit value requests are denied on late scope loss;
    // serialized CSV/XML cannot subsequently be repaired by object redaction.
    const result={...finish(value,current),...flags(current,ctx)};
    ensure(Buffer.byteLength(JSON.stringify(result))<=V.STOCKTAKE_ADJUSTMENT_LIMITS.response_bytes,413,'Pełna odpowiedź przekracza limit');
    await c.query('COMMIT');return result;
  } catch(error) {await c.query('ROLLBACK').catch(()=>undefined);return mapped(error);}
  finally {c.release();}
}
type RegisterQuery=ReturnType<typeof V.adjustmentRegisterQuery.parse>;
type RegisterSeek={id:string;at:string};
const cursorDomain=Buffer.from('stocktake-adjustment-register:v1');
function cursorKey(){return createHash('sha256').update(cursorDomain).update(localConfig.encryptionKey).digest();}
function registerBinding(a:V.AdjustmentActor,q:RegisterQuery,g:Grant,ctx:Context) {
  return {tenant:a.tenantId,user:a.userId,key:a.apiKeyId??null,role:g.current_role,read_only:!!ctx.readOnly,
    can_read:g.can_read,can_write:g.can_write,can_read_value:g.can_read_value,
    filters:{kind:q.kind??null,source_kind:q.source_kind??null,warehouse_id:q.warehouse_id??null,
      number_prefix:q.number_prefix??null,from:q.from??null,to:q.to??null,limit:q.limit}};
}
function sealRegisterCursor(seek:RegisterSeek,binding:unknown) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cursorKey(),iv);cipher.setAAD(cursorDomain);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify({v:1,seek,binding}),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url');
}
function openRegisterCursor(raw:string|undefined,binding:unknown):RegisterSeek|null {
  if(!raw)return null;let value:Row;
  try {
    const b=Buffer.from(raw,'base64url');if(b.length<29||b.toString('base64url')!==raw)throw Error('cursor');
    const d=createDecipheriv('aes-256-gcm',cursorKey(),b.subarray(0,12));d.setAAD(cursorDomain);d.setAuthTag(b.subarray(12,28));
    value=JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'));
    if(value.v!==1||!V.adjustmentUuid.safeParse(value.seek?.id).success||typeof value.seek?.at!=='string'
      ||value.seek.at.length>80||!Number.isFinite(Date.parse(value.seek.at)))throw Error('cursor');
  }catch{throw new Problem(422,'Nieprawidłowy kursor rejestru');}
  ensure(isDeepStrictEqual(value.binding,binding),409,'Kursor dotyczy innego zakresu lub uprawnień');return value.seek;
}
export async function stocktakeAdjustmentRegister(a:V.AdjustmentActor,raw:unknown,ctx:Context={}):Promise<V.AdjustmentRegister> {
  const q=V.adjustmentRegisterQuery.parse(raw);
  return immutableRead(a,ctx,async(c,g)=>{
    const binding=registerBinding(a,q,g,ctx),seek=openRegisterCursor(q.cursor,binding);
    return owner(c,a,async()=>{
      if(q.warehouse_id)ensure((await c.query('SELECT id FROM public.warehouses WHERE(tenant_id,id)=($1,$2)',[a.tenantId,q.warehouse_id])).rowCount,404,'Nie znaleziono własnego magazynu');
      const params=[a.tenantId,q.kind??null,q.source_kind??null,q.warehouse_id??null,q.number_prefix??null,q.from??null,q.to??null];
      const predicate=`d.tenant_id=$1 AND($2::text IS NULL OR d.kind=$2) AND($3::text IS NULL OR p.source_kind=$3)
        AND($4::uuid IS NULL OR d.warehouse_id=$4) AND($5::text IS NULL OR starts_with(d.number,$5))
        AND($6::timestamptz IS NULL OR d.created_at>=$6) AND($7::timestamptz IS NULL OR d.created_at<=$7)`;
      const joins=`FROM public.stocktake_adjustment_documents d
        JOIN public.stocktake_adjustment_receipts r ON(r.tenant_id,r.id)=(d.tenant_id,d.receipt_id)
        JOIN public.stocktake_adjustment_previews p ON(p.tenant_id,p.id)=(r.tenant_id,r.preview_id)`;
      if(seek)ensure((await c.query(`SELECT d.id ${joins} WHERE ${predicate} AND d.id=$8 AND d.created_at=$9::timestamptz`,[...params,seek.id,seek.at])).rowCount,404,'Kursor nie należy do własnego rejestru');
      const rows=(await c.query(`SELECT d.*,to_jsonb(d)->>'created_at' created_at,p.source_kind,p.request->>'stocktake_id' stocktake_id,p.frame->'source'->'warehouse' warehouse
        ${joins} WHERE ${predicate} AND($8::timestamptz IS NULL OR(d.created_at,d.id)<($8::timestamptz,$9::uuid))
        ORDER BY d.created_at DESC,d.id DESC LIMIT $10`,[...params,seek?.at??null,seek?.id??null,q.limit+1])).rows;
      return {rows,binding};
    });
  },(value,current)=>{
    const binding=registerBinding(a,q,current,ctx);
    if(q.cursor)ensure(isDeepStrictEqual(binding,value.binding),409,'Uprawnienia kursora zmieniły się');
    const page=value.rows.slice(0,q.limit),last=page.at(-1);
    return {data:project(page.map(documentView),current.can_read_value),meta:{limit:q.limit,
      cursor:value.rows.length>q.limit&&last?sealRegisterCursor({id:last.id,at:last.created_at},binding):null}};
  });
}
const csvBase=['record_type','document_id','receipt_id','number','kind','source_kind','stocktake_id','series_id','year','sequence','created_at',
  'warehouse_id','warehouse_name','warehouse_code','row_count','pw_quantity','rw_quantity','ordinal','source_ordinal','line_id','product_id','sku','name','location','quantity','delta','lot_id','lot_code','expiry_date','layer_id','movement_id','stock_movement_id'];
const csvValues=['currency','exponent','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','unit_cost_minor','value_minor','cost_state'];
function csvCell(value:unknown) {
  let v=value===null||value===undefined?'':String(value);
  if(typeof value==='string'&&/^[\s]*[=+\-@\t\r\n]/u.test(v))v="'"+v;
  return '"'+v.replaceAll('"','""')+'"';
}
function xmlText(v:unknown){const text=String(v);ensure(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\p{Cs}]/u.test(text),422,'Tekst dokumentu nie jest poprawnym XML');return text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');}
function xmlElement(name:string,value:unknown):string {
  if(value===null||value===undefined)return `<${name} nil="true"/>`;
  if(typeof value==='object')return `<${name}>${Object.entries(value).map(([k,v])=>xmlElement(k,v)).join('')}</${name}>`;
  return `<${name}>${xmlText(value)}</${name}>`;
}
function exportContent(document:V.AdjustmentDocument,rows:V.AdjustmentDocumentRow[],format:'csv'|'xml',values:boolean) {
  if(format==='xml')return '<?xml version="1.0" encoding="UTF-8"?>\n<stocktake_adjustment version="1">'+xmlElement('document',document)+'<rows>'+rows.map(r=>xmlElement('row',r)).join('')+'</rows></stocktake_adjustment>\n';
  const columns=[...csvBase,...(values?csvValues:[])];
  const common={document_id:document.id,receipt_id:document.receipt_id,number:document.number,kind:document.kind,source_kind:document.source_kind,stocktake_id:document.stocktake_id,
    series_id:document.series_id,year:document.year,sequence:document.sequence,created_at:document.created_at,warehouse_id:document.warehouse.id};
  const head={...common,record_type:'document',warehouse_name:document.warehouse.name,warehouse_code:document.warehouse.code,row_count:document.row_count,...document.summary};
  const records:Row[]=[head,...rows.map(r=>({...common,...r,record_type:'row',...(values?{exponent:document.summary.exponent,cost_state:r.unit_cost_minor===null?'unknown':'known'}:{})}))];
  return [columns.map(csvCell).join(','),...records.map(r=>columns.map(k=>csvCell(r[k])).join(','))].join('\r\n')+'\r\n';
}
export async function stocktakeAdjustmentDocumentExport(a:V.AdjustmentActor,id:string,raw:unknown,ctx:Context={}):Promise<V.AdjustmentExport> {
  id=V.adjustmentUuid.parse(id);const q=V.adjustmentExportQuery.parse(raw);
  return immutableRead(a,ctx,async(c,g)=>{
    ensure(!q.include_values||g.can_read_value,403,'Brak aktualnego dostępu do wartości dokumentu');
    const document=await oneDocument(c,a,id);
    ensure(document.row_count<=V.STOCKTAKE_ADJUSTMENT_LIMITS.fragments,413,'Limit pełnego manifestu dokumentu');
    const rows=await owner(c,a,async()=>(await c.query('SELECT ordinal,payload FROM public.stocktake_adjustment_document_rows WHERE(tenant_id,document_id)=($1,$2) ORDER BY ordinal LIMIT $3',[a.tenantId,id,V.STOCKTAKE_ADJUSTMENT_LIMITS.fragments+1])).rows);
    ensure(rows.length===document.row_count&&rows.every((r,i)=>r.ordinal===i&&r.payload.ordinal===i),409,'Niepełny manifest dokumentu');
    return {document,rows:rows.map(r=>r.payload)};
  },(value,current)=>{
    ensure(!q.include_values||current.can_read_value,403,'Brak aktualnego dostępu do wartości dokumentu');
    const values=q.include_values&&value.document.source_kind==='wms';
    const document:V.AdjustmentDocument=project(value.document,values),rows:V.AdjustmentDocumentRow[]=project(value.rows,values);
    return {document,format:q.format,filename:`${document.kind}-${document.id}.${q.format}`,
      content_type:q.format==='csv'?'text/csv; charset=utf-8' as const:'application/xml; charset=utf-8' as const,
      content:exportContent(document,rows,q.format,values),values_included:values,row_count:rows.length};
  });
}
