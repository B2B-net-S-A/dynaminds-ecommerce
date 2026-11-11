import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { pool, localConfig } from './db';
import { ensure, Problem } from './errors';
import { stocktakeAdjustmentsAvailable } from './stocktake-adjustments';
import { catalogStockControlAvailable } from './catalog-stock-control';
import { warehouseWmsCorrectionPublication,warehouseWmsCorrectionHead,warehouseWmsCorrectionSummary,assertWarehouseWmsCorrectionValues } from './warehouse-wms-correction-projection';
import { adjustmentUuid } from './stocktake-adjustments-schema';
import * as V from './warehouse-document-register-schema';

type Row=Record<string,any>;
type Context={readOnly?:boolean};
type Grant=V.WarehouseRegisterFlags & {corrections_available:boolean};
type Query=ReturnType<typeof V.warehouseRegisterQuery.parse>;
const money=new Set(['unit_cost_minor','value_minor','currency','exponent','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','rows_sha256','_exponent','known_quantity','zero_cost_quantity','unknown_quantity','known_value_minor','signed_known_value_minor']);
function project<T>(v:T,values:boolean):T {
  if(Array.isArray(v))return v.map(x=>project(x,values)) as T;
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='_exponent'&&(values||!money.has(k))).map(([k,x])=>[k,project(x,values)])) as T;
  return v;
}
async function owner<T>(c:PoolClient,a:V.WarehouseRegisterActor,work:()=>Promise<T>):Promise<T> {
  const before=(await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id') tenant")).rows[0];
  ensure(before.tenant===a.tenantId&&(before.role==='dyna_app'||before.role===before.owner),403,'Nieprawidłowy kontekst rejestru');
  await c.query('RESET ROLE');let failed=false;
  try {
    const identity=(await c.query("SELECT current_user=session_user own,pg_get_userbyid(relowner)=session_user relation_owner FROM pg_class WHERE oid='public.stocktake_adjustment_series'::regclass")).rows[0];
    ensure(identity?.own&&identity?.relation_owner,403,'Nieprawidłowy właściciel połączenia');return await work();
  } catch(e){failed=true;throw e;}
  finally {if(before.role==='dyna_app')try{await c.query('SET LOCAL ROLE dyna_app');}catch(e){if(!failed)throw e;}}
}
async function correctionsAvailable(c:PoolClient):Promise<boolean>{
  if(!await catalogStockControlAvailable(c))return false;
  const p=(await c.query("SELECT to_regprocedure('public.catalog_stock_control_wms_correction_build(uuid,jsonb)') builder,to_regprocedure('public.catalog_stock_control_wms_correction_seal()') seal")).rows[0];
  ensure(!!p.builder===!!p.seal,503,'Niekompletny publikator korekty WMS');return !!p.builder;
}
async function access(c:PoolClient,a:V.WarehouseRegisterActor,pin:boolean):Promise<Grant> {
  return owner(c,a,async()=>{
    ensure(await stocktakeAdjustmentsAvailable(c),503,'Rejestr wymaga kompletnego modułu149');
    const deps=(await c.query("SELECT to_regclass('public.warehouse_documents') head,to_regclass('public.warehouse_document_lines') lines,to_regclass('public.stock_movements') movements,to_regclass('public.warehouses') warehouses")).rows[0];
    ensure(Object.values(deps).every(Boolean),503,'Niekompletne źródła rejestru');
    const corrections_available=await correctionsAvailable(c);
    return {...(await c.query('SELECT public.stocktake_adjustment_access($1,$2,false,false,false,$3) access_flags',[a.userId,a.apiKeyId??null,pin])).rows[0].access_flags,corrections_available};
  });
}
function flags(g:Grant,ctx:Context):V.WarehouseRegisterFlags {return {available:true,read_only:!!ctx.readOnly,current_role:g.current_role,can_read:g.can_read,can_write:g.can_write&&!ctx.readOnly,can_read_value:g.can_read_value};}
function mapped(e:any):never {
  if(e instanceof Problem)throw e;
  if(e.code==='28000')throw new Problem(401,'Klucz API został cofnięty lub wygasł');
  if(e.code==='42501')throw new Problem(403,'Brak aktualnego uprawnienia rejestru');
  if(['55000','42P01','42703','42883'].includes(e.code))throw new Problem(503,'Niekompletne źródła rejestru');
  throw e;
}
async function read<T,R extends object>(a:V.WarehouseRegisterActor,ctx:Context,work:(c:PoolClient,g:Grant)=>Promise<T>,finish:(value:T,g:Grant)=>R):Promise<R&V.WarehouseRegisterFlags> {
  adjustmentUuid.parse(a.tenantId);adjustmentUuid.parse(a.userId);if(a.apiKeyId)adjustmentUuid.parse(a.apiKeyId);
  const c=await pool.connect();
  async function context(){await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);await c.query("SET LOCAL TimeZone='UTC'");await c.query("SET LOCAL statement_timeout='8s'");}
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await context();const g=await access(c,a,false),value=await work(c,g);await c.query('COMMIT');
    // FOR SHARE final IAM needs RC writable, but this adapter executes no DML.
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');await context();const current=await access(c,a,true);
    ensure(current.corrections_available===g.corrections_available,503,'Zakres publikatora korekty zmienił się');
    const result={...finish(value,current),...flags(current,ctx)};
    ensure(Buffer.byteLength(JSON.stringify(result))<=V.WAREHOUSE_DOCUMENT_REGISTER_LIMITS.response_bytes,413,'Pełny dokument przekracza limit');
    await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK').catch(()=>undefined);return mapped(e);}finally{c.release();}
}

// Both branches bind the full tenant tuple, including private149 reads. This
// union is paginated in SQL, never by merging two truncated API pages.
const legacyUnion=`SELECT 'warehouse'::text origin,d.id,d.created_at sort_at,to_jsonb(d)->>'created_at' created_at,
  CASE d.kind WHEN 'receipt' THEN 'PZ' WHEN 'transfer' THEN 'MM' WHEN 'issue' THEN 'WZ' ELSE 'count' END kind,
  d.number,d.status,'warehouse'::text source_kind,d.warehouse_id,d.destination_id,
  jsonb_build_object('id',w.id,'name',w.name,'code',w.code) warehouse,
  CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id',t.id,'name',t.name,'code',t.code) END destination,
  'current'::text warehouse_names,(SELECT count(*)::int FROM public.warehouse_document_lines l WHERE(l.tenant_id,l.document_id)=(d.tenant_id,d.id)) row_count,
  false value_available,NULL::jsonb summary,to_jsonb(d) raw,NULL::jsonb source
  FROM public.warehouse_documents d JOIN public.warehouses w ON(w.tenant_id,w.id)=(d.tenant_id,d.warehouse_id)
  LEFT JOIN public.warehouses t ON(t.tenant_id,t.id)=(d.tenant_id,d.destination_id) WHERE d.tenant_id=$1
  UNION ALL
  SELECT 'stocktake_adjustment'::text,d.id,d.created_at,to_jsonb(d)->>'created_at',d.kind,d.number,'posted'::text,p.source_kind,d.warehouse_id,NULL::uuid,
  p.frame->'source'->'warehouse',NULL::jsonb,'frozen'::text,d.row_count,p.source_kind='wms',d.summary,to_jsonb(d),
  jsonb_build_object('preview_id',p.id,'stocktake_id',p.request->>'stocktake_id','posting_id',r.posting_id,'operation_id',r.operation_id)
  FROM public.stocktake_adjustment_documents d JOIN public.stocktake_adjustment_receipts r ON(r.tenant_id,r.id)=(d.tenant_id,d.receipt_id)
  JOIN public.stocktake_adjustment_previews p ON(p.tenant_id,p.id)=(r.tenant_id,r.preview_id) WHERE d.tenant_id=$1`;
// Genuine absence of152/the older152 publisher keeps the existing two-source
// registry. Any installed/torn152 or partially present publisher fails closed.
const correctionUnion=String.raw`SELECT 'wms_correction'::text,a.id,(c.payload->>'created_at')::timestamptz,c.payload->>'created_at',
 c.payload->>'kind',c.payload->>'number','posted'::text,'wms'::text,(c.payload#>>'{warehouse,id}')::uuid,NULL::uuid,
 c.payload->'warehouse',NULL::jsonb,'frozen'::text,(c.payload->>'row_count')::int,true,
 jsonb_build_object('quantity',c.payload->>'quantity',
  'known_quantity',c.payload#>>'{summary,known_quantity}','zero_cost_quantity',c.payload#>>'{summary,zero_cost_quantity}',
  'unknown_quantity',c.payload#>>'{summary,unknown_quantity}','known_value_minor',c.payload#>>'{summary,known_value_minor}',
  'signed_known_value_minor',c.payload#>>'{summary,signed_known_value_minor}',
  'currency',c.payload#>>'{summary,currency}','exponent',c.payload#>'{summary,exponent}','pw_quantity',CASE WHEN c.payload->>'kind'='PW' THEN c.payload->>'quantity' ELSE '0' END,
  'rw_quantity',CASE WHEN c.payload->>'kind'='RW' THEN c.payload->>'quantity' ELSE '0' END,
  'known_pw_minor',CASE WHEN c.payload->>'kind'='PW' THEN c.payload#>>'{summary,known_value_minor}' ELSE '0' END,
  'known_rw_minor',CASE WHEN c.payload->>'kind'='RW' THEN c.payload#>>'{summary,known_value_minor}' ELSE '0' END,
  'unknown_pw_quantity',CASE WHEN c.payload->>'kind'='PW' THEN c.payload#>>'{summary,unknown_quantity}' ELSE '0' END,
  'unknown_rw_quantity',CASE WHEN c.payload->>'kind'='RW' THEN c.payload#>>'{summary,unknown_quantity}' ELSE '0' END),
 c.payload-'rows',jsonb_build_object('native_document_id',d.id,'native_document_number',d.number,
  'native_document_kind',CASE WHEN d.kind='receipt' THEN 'PZ' WHEN d.kind='issue' THEN 'WZ' ELSE 'invalid' END,
  'operation_id',e.operation_id,'preview_id',a.source_id)
 FROM public.catalog_stock_control_effects e JOIN public.catalog_stock_control_effect_admissions a
 ON(a.tenant_id,a.id)=(e.tenant_id,e.admission_id)
 JOIN public.warehouse_documents d ON(d.tenant_id,d.id)=(e.tenant_id,e.warehouse_document_id)
 CROSS JOIN LATERAL(SELECT e.proof->'correction_document' payload)c
 WHERE e.tenant_id=$1 AND a.sealed AND a.source_kind='wms_movement' AND c.payload->>'protocol'='wms_adjustment'`;
// The native receipt/issue remains a valid explicit detail/export identity.
// Global user lists show its one published PW/RW instead of a second PZ/WZ.
const correctionParentSuppression=String.raw` AND NOT EXISTS(
 SELECT FROM public.catalog_stock_control_effects effect
 JOIN public.catalog_stock_control_effect_admissions admission
 ON(admission.tenant_id,admission.id)=(effect.tenant_id,effect.admission_id)
 JOIN public.wms_operations operation ON(operation.tenant_id,operation.id)=(effect.tenant_id,effect.operation_id)
 JOIN public.wms_previews preview ON(preview.tenant_id,preview.id)=(admission.tenant_id,admission.source_id)
 WHERE(effect.tenant_id,effect.warehouse_document_id)=(d.tenant_id,d.id)
 AND admission.sealed AND admission.source_kind='wms_movement' AND operation.kind='adjustment' AND preview.kind='adjustment'
 AND(operation.tenant_id,operation.warehouse_document_id)=(d.tenant_id,d.id)
 AND operation.request->>'preview_id'=preview.id::text AND operation.actor_id IS NOT DISTINCT FROM admission.actor_id
 AND effect.proof#>>'{correction_document,protocol}'='wms_adjustment'
 AND effect.proof#>>'{correction_document,id}'=admission.id::text
 AND effect.proof#>>'{correction_document,preview_id}'=preview.id::text
 AND effect.proof#>>'{correction_document,operation_id}'=operation.id::text
 AND effect.proof#>>'{correction_document,warehouse_document_id}'=d.id::text
 AND effect.proof#>>'{correction_document,kind}'=CASE d.kind WHEN 'receipt' THEN 'PW' WHEN 'issue' THEN 'RW' ELSE 'invalid' END)`;
function union(corrections:boolean,includeCorrectionParents=false){
 const parents=corrections&&!includeCorrectionParents
  ?legacyUnion.replace('WHERE d.tenant_id=$1\n  UNION ALL','WHERE d.tenant_id=$1'+correctionParentSuppression+'\n  UNION ALL')
  :legacyUnion;
 return parents+(corrections?'\n UNION ALL\n'+correctionUnion:'');
}
const predicate=`($2::text IS NULL OR u.origin=$2) AND($3::text IS NULL OR u.kind=$3)
  AND($4::text IS NULL OR u.status=$4) AND($5::text IS NULL OR u.source_kind=$5)
  AND($6::uuid IS NULL OR u.warehouse_id=$6 OR u.destination_id=$6)
  AND($7::text IS NULL OR starts_with(u.number,$7))
  AND($8::timestamptz IS NULL OR u.sort_at>=$8) AND($9::timestamptz IS NULL OR u.sort_at<=$9)`;
function header(r:Row):V.WarehouseRegisterHeader {
  const wh=(w:Row):V.WarehouseRegisterWarehouse=>({id:w.id,name:w.name,code:w.code});
  return {origin:r.origin,id:r.id,kind:r.kind,number:r.number,status:r.status,created_at:r.created_at,source_kind:r.source_kind,
    warehouse:wh(r.warehouse),destination:r.destination?wh(r.destination):null,warehouse_names:r.warehouse_names,row_count:r.row_count,value_available:r.value_available,summary:r.summary};
}
function publicHeader(r:Row,g:Grant):V.WarehouseRegisterHeader {if(r.origin==='wms_correction')r={...r,summary:warehouseWmsCorrectionSummary(warehouseWmsCorrectionHead(r.raw,g.can_read_value))};const h=project(header(r),g.can_read_value);h.value_available=h.value_available&&g.can_read_value;return h;}
function binding(a:V.WarehouseRegisterActor,q:Query,g:Grant,ctx:Context){return {tenant:a.tenantId,user:a.userId,key:a.apiKeyId??null,role:g.current_role,read_only:!!ctx.readOnly,
  read:g.can_read,write:g.can_write,value:g.can_read_value,publisher:g.corrections_available,filters:{origin:q.origin??null,kind:q.kind??null,status:q.status??null,source_kind:q.source_kind??null,warehouse_id:q.warehouse_id??null,number_prefix:q.number_prefix??null,from:q.from??null,to:q.to??null,limit:q.limit}};}
const domain=Buffer.from('warehouse-document-register:v1');
const key=()=>createHash('sha256').update(domain).update(localConfig.encryptionKey).digest();
type Seek={id:string;origin:V.WarehouseRegisterHeader['origin'];at:string};
function seal(seek:Seek,b:unknown){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(),iv);c.setAAD(domain);const body=Buffer.concat([c.update(JSON.stringify({v:1,seek,binding:b}),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64url');}
function open(raw:string|undefined,b:unknown):Seek|null {
  if(!raw)return null;let value:Row;
  try{const bytes=Buffer.from(raw,'base64url');if(bytes.length<29||bytes.toString('base64url')!==raw)throw Error('cursor');const c=createDecipheriv('aes-256-gcm',key(),bytes.subarray(0,12));c.setAAD(domain);c.setAuthTag(bytes.subarray(12,28));value=JSON.parse(Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString());
    if(value.v!==1||!V.warehouseRegisterParams.safeParse({origin:value.seek?.origin,id:value.seek?.id}).success||typeof value.seek.at!=='string'||value.seek.at.length>80||!Number.isFinite(Date.parse(value.seek.at)))throw Error('cursor');
  }catch{throw new Problem(422,'Nieprawidłowy kursor rejestru');}
  ensure(isDeepStrictEqual(value.binding,b),409,'Kursor dotyczy innego zakresu lub uprawnień');return value.seek;
}
async function snapshotAt(c:PoolClient):Promise<string>{return(await c.query("SELECT to_jsonb(transaction_timestamp())#>>'{}' AS snapshot_at")).rows[0].snapshot_at;}
export async function warehouseDocumentRegister(a:V.WarehouseRegisterActor,raw:unknown,ctx:Context={}):Promise<V.WarehouseRegisterPage> {
  const q=V.warehouseRegisterQuery.parse(raw);
  return read(a,ctx,async(c,g)=>{const b=binding(a,q,g,ctx),seek=open(q.cursor,b);
    return owner(c,a,async()=>{
      if(q.warehouse_id)ensure((await c.query('SELECT id FROM public.warehouses WHERE(tenant_id,id)=($1,$2)',[a.tenantId,q.warehouse_id])).rowCount,404,'Nie znaleziono własnego magazynu');
      const params=[a.tenantId,q.origin??null,q.kind??null,q.status??null,q.source_kind??null,q.warehouse_id??null,q.number_prefix??null,q.from??null,q.to??null];
      if(seek)ensure((await c.query(`WITH u AS(${union(g.corrections_available)}) SELECT id FROM u WHERE ${predicate} AND(u.origin,u.id,u.sort_at)=($10::text,$11::uuid,$12::timestamptz)`,[...params,seek.origin,seek.id,seek.at])).rowCount,404,'Kursor nie należy do własnego rejestru');
      const rows=(await c.query(`WITH u AS(${union(g.corrections_available)}) SELECT * FROM u WHERE ${predicate}
        AND($10::timestamptz IS NULL OR(u.sort_at,u.origin,u.id)<($10::timestamptz,$11::text,$12::uuid))
        ORDER BY u.sort_at DESC,u.origin DESC,u.id DESC LIMIT $13`,[...params,seek?.at??null,seek?.origin??null,seek?.id??null,q.limit+1])).rows;
      return {rows,binding:b,snapshot_at:await snapshotAt(c)};
    });
  },(v,g)=>{const b=binding(a,q,g,ctx);if(q.cursor)ensure(isDeepStrictEqual(b,v.binding),409,'Uprawnienia kursora zmieniły się');const page=v.rows.slice(0,q.limit),last=page.at(-1);
    return {data:page.map(r=>publicHeader(r,g)),meta:{limit:q.limit,cursor:v.rows.length>q.limit&&last?seal({origin:last.origin,id:last.id,at:last.created_at},b):null},snapshot_at:v.snapshot_at};});
}
async function detail(c:PoolClient,a:V.WarehouseRegisterActor,origin:V.WarehouseRegisterHeader['origin'],id:string,g:Grant):Promise<V.WarehouseRegisterDetail> {
  return owner(c,a,async()=>{
    const r=(await c.query(`WITH u AS(${union(g.corrections_available,true)}) SELECT * FROM u WHERE(origin,id)=($2::text,$3::uuid)`,[a.tenantId,origin,id])).rows[0];ensure(r,404,'Nie znaleziono własnego dokumentu');
    ensure(r.row_count<=V.WAREHOUSE_DOCUMENT_REGISTER_LIMITS.rows,413,'Limit pełnego manifestu');
    let rows:V.WarehouseRegisterRow[],evidence:V.WarehouseRegisterEvidence,movements:V.WarehouseRegisterMovement[]=[];
    if(origin==='warehouse'){
      const found=(await c.query('SELECT product_id,sku,name,quantity,location,expected_on_hand,expected_reserved,expected_version::text FROM public.warehouse_document_lines WHERE(tenant_id,document_id)=($1,$2) ORDER BY product_id LIMIT $3',[a.tenantId,id,V.WAREHOUSE_DOCUMENT_REGISTER_LIMITS.rows+1])).rows;
      rows=found.map((l,i)=>({...l,origin:'warehouse' as const,ordinal:i}));
      evidence={origin,version:String(r.raw.version),reference:r.raw.reference,note:r.raw.note,posted_at:r.raw.posted_at};
      movements=(await c.query("SELECT id,product_id,warehouse_id,delta,kind,to_jsonb(m)->>'created_at' created_at FROM public.stock_movements m WHERE(tenant_id,warehouse_document_id)=($1,$2) ORDER BY m.created_at,m.id LIMIT $3",[a.tenantId,id,V.WAREHOUSE_DOCUMENT_REGISTER_LIMITS.rows+1])).rows;
      ensure(movements.length<=V.WAREHOUSE_DOCUMENT_REGISTER_LIMITS.rows,413,'Limit pełnych ruchów');
    }else if(origin==='wms_correction'){
      const stored=(await c.query("SELECT e.proof->'correction_document' payload FROM public.catalog_stock_control_effects e JOIN public.catalog_stock_control_effect_admissions a ON(a.tenant_id,a.id)=(e.tenant_id,e.admission_id) WHERE(e.tenant_id,e.admission_id)=($1,$2) AND a.sealed AND a.source_kind='wms_movement'",[a.tenantId,id])).rows;
      ensure(stored.length===1,409,'Niepełny zapisany dokument korekty');
      const d=warehouseWmsCorrectionPublication(stored[0].payload);
      ensure(d.id===id&&d.operation_id===r.source.operation_id&&d.preview_id===r.source.preview_id&&
        d.warehouse_document_id===r.source.native_document_id&&['PZ','WZ'].includes(r.source.native_document_kind)&&
        r.source.native_document_kind===(d.kind==='PW'?'PZ':'WZ'),409,'Obcy rzeczywisty rodzic korekty WMS');
      rows=d.rows.map(row=>({...row,origin:'wms_correction' as const,kind:d.kind}));
      r.summary=warehouseWmsCorrectionSummary(d);
      evidence={origin,protocol:d.protocol,preview_id:d.preview_id,operation_id:d.operation_id,
        warehouse_document_id:d.warehouse_document_id,warehouse_document_number:r.source.native_document_number,
        warehouse_document_kind:r.source.native_document_kind,series_id:d.series_id,year:d.year,sequence:d.sequence};
      // Journal IDs belong to each frozen physical row; never duplicate one
      // aggregate journal once per layer as fictitious separate movements.
    }else{
      const found=(await c.query('SELECT ordinal,payload FROM public.stocktake_adjustment_document_rows WHERE(tenant_id,document_id)=($1,$2) ORDER BY ordinal LIMIT $3',[a.tenantId,id,V.WAREHOUSE_DOCUMENT_REGISTER_LIMITS.rows+1])).rows;
      ensure(found.every((x,i)=>x.ordinal===i&&x.payload.ordinal===i),409,'Niepełny manifest dokumentu');
      rows=found.map(x=>({...x.payload,origin:'stocktake_adjustment' as const}));
      evidence={origin,receipt_id:r.raw.receipt_id,preview_id:r.source.preview_id,stocktake_id:r.source.stocktake_id,posting_id:r.source.posting_id,operation_id:r.source.operation_id,series_id:r.raw.series_id,year:r.raw.year,sequence:String(r.raw.sequence)};
    }
    ensure(rows.length===r.row_count,409,'Niepełny manifest dokumentu');
    return {document:header(r),rows,movements,evidence,row_names:'recorded',snapshot_at:await snapshotAt(c)};
  });
}
export async function warehouseDocumentRegisterDetail(a:V.WarehouseRegisterActor,origin:unknown,id:unknown,ctx:Context={}):Promise<V.WarehouseRegisterDetailReply> {
  const p=V.warehouseRegisterParams.parse({origin,id});return read(a,ctx,(c,g)=>detail(c,a,p.origin,p.id,g),(v,g)=>{if(v.document.origin==='wms_correction'&&g.can_read_value)assertWarehouseWmsCorrectionValues(v.document.summary);const result=project(v,g.can_read_value);result.document.value_available=result.document.value_available&&g.can_read_value;return result;});
}
const csvBase=['record_type','origin','document_id','number','kind','status','source_kind','created_at','warehouse_id','warehouse_name','warehouse_code','destination_id','destination_name','destination_code','warehouse_names','value_available','row_names','row_count','pw_quantity','rw_quantity','version','reference','note','posted_at','receipt_id','preview_id','stocktake_id','posting_id','operation_id','series_id','year','sequence','ordinal','source_ordinal','line_id','product_id','sku','name','quantity','location','delta','expected_on_hand','expected_reserved','expected_version','lot_id','lot_code','expiry_date','layer_id','movement_id','stock_movement_id','movement_kind','movement_created_at'];
const csvCorrection=['protocol','warehouse_document_id','warehouse_document_number','warehouse_document_kind','location_movement_id','layer_movement_id'];
const csvCorrectionMoney=['known_quantity','zero_cost_quantity','unknown_quantity','known_value_minor','signed_known_value_minor'];
const csvMoney=['currency','exponent','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','unit_cost_minor','value_minor','cost_state'];
function csvCell(v:unknown){let text=v==null?'':String(v);if(typeof v==='string'&&/^[\s]*[=+\-@\t\r\n]/u.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
function xmlText(v:unknown){const s=String(v);ensure(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\p{Cs}]/u.test(s),422,'Tekst dokumentu nie jest poprawnym XML');return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;').replaceAll('\r','&#13;');}
function xmlNode(name:string,v:unknown):string {if(v==null)return `<${name} nil="true"/>`;if(Array.isArray(v))return `<${name}>${v.map(x=>xmlNode('row',x)).join('')}</${name}>`;if(typeof v==='object')return `<${name}>${Object.entries(v).map(([k,x])=>xmlNode(k,x)).join('')}</${name}>`;return `<${name}>${xmlText(v)}</${name}>`;}
function content(v:V.WarehouseRegisterDetail,format:'csv'|'xml',values:boolean):string {
  if(format==='xml')return '<?xml version="1.0" encoding="UTF-8"?>\n<warehouse_document version="1">'+xmlNode('document',v.document)+xmlNode('evidence',v.evidence)+xmlNode('rows',v.rows)+xmlNode('movements',v.movements)+'</warehouse_document>\n';
  const d=v.document,common={origin:d.origin,document_id:d.id,number:d.number,kind:d.kind,status:d.status,source_kind:d.source_kind,created_at:d.created_at,warehouse_id:d.warehouse.id};
  const isCorrection=d.origin==='wms_correction';
  const records:Row[]=[{...common,...v.evidence,record_type:'document',warehouse_name:d.warehouse.name,warehouse_code:d.warehouse.code,destination_id:d.destination?.id,destination_name:d.destination?.name,destination_code:d.destination?.code,warehouse_names:d.warehouse_names,value_available:d.value_available,row_names:v.row_names,row_count:d.row_count,...d.summary,...(values&&isCorrection?{signed_known_value_minor:BigInt((d.summary as any).signed_known_value_minor)}:{})},
    ...v.rows.map(r=>({...common,...r,...(r.origin==='wms_correction'?{quantity:BigInt(r.quantity),delta:BigInt(r.delta)}:{}),record_type:'row',...(values?{exponent:d.summary?.exponent,cost_state:'unit_cost_minor'in r&&r.unit_cost_minor===null?'unknown':'unit_cost_minor'in r&&r.unit_cost_minor==='0'&&isCorrection?'zero':'known'}:{})})),
    ...v.movements.map(m=>({...common,record_type:'movement',product_id:m.product_id,warehouse_id:m.warehouse_id,delta:m.delta,movement_id:m.id,movement_kind:m.kind,movement_created_at:m.created_at}))];
  const columns=[...csvBase,...(isCorrection?csvCorrection:[]),...(values?[...csvMoney,...(isCorrection?csvCorrectionMoney:[])]:[])];return [columns.map(csvCell).join(','),...records.map(r=>columns.map(k=>csvCell(r[k])).join(','))].join('\r\n')+'\r\n';
}
export async function warehouseDocumentRegisterExport(a:V.WarehouseRegisterActor,origin:unknown,id:unknown,raw:unknown,ctx:Context={}):Promise<V.WarehouseRegisterExport> {
  const p=V.warehouseRegisterParams.parse({origin,id}),q=V.warehouseRegisterExportQuery.parse(raw);
  return read(a,ctx,async(c,g)=>{ensure(!q.include_values||g.can_read_value,403,'Brak aktualnego dostępu do wartości');return detail(c,a,p.origin,p.id,g);},(v,g)=>{
    ensure(!q.include_values||g.can_read_value,403,'Brak aktualnego dostępu do wartości');const values=q.include_values&&v.document.value_available;
    if(values&&v.document.origin==='wms_correction')assertWarehouseWmsCorrectionValues(v.document.summary);
    const clean=project(v,values);clean.document.value_available=values;
    return {document:clean.document,filename:`${clean.document.kind}-${p.origin}-${p.id}.${q.format}`,content_type:q.format==='csv'?'text/csv; charset=utf-8' as const:'application/xml; charset=utf-8' as const,
      content:content(clean,q.format,values),format:q.format,values_included:values,row_count:clean.rows.length,snapshot_at:clean.snapshot_at};
  });
}
