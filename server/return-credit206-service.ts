/** Separate successor service. No module-import IO beyond established db/config imports; requires genuine installed Native207. */
import type {PoolClient} from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {consumerCreditPreviewIssueState} from './consumer-credit-preview-state';
import {selectConsumerReturnSource} from './consumer-return-source-selection';
import {pool,tenantTx,hasAcknowledgedTenantRollback} from './db';
import {ensure,Problem} from './errors';
import {tokenHash} from './security';
import {localInvoiceRequestHash} from './local-invoice-values';
import {consumerCreditHash} from './local-consumer-credit-arithmetic';
import {calculateReturnCredit206} from './return-credit206-arithmetic';
import {creditUuid,returnCredit206PreviewInput,returnCredit206IssueInput,returnCredit206SeriesInput,type ReturnCredit206Source,type ReturnCredit206Preview,type ReturnCredit206Document} from './return-credit206-values';
import type {LocalInvoiceActor} from './local-invoice-values';
const frames=new WeakMap<LocalInvoiceActor,string>();
const failedWrites=new WeakMap<object,{actor_id:string;tenant_id:string;operation:'preview'|'issue'|'series';client_key:string;write_outcome:'failed_before_write'}>();
export function returnCredit206RequestActor(req:any,sessionName:string):LocalInvoiceActor{ensure(req.currentUser?.id===req.actor.userId&&req.currentUser.tenant_id===req.actor.tenantId,401,'Brak oryginalnej tożsamości żądania');const key=req.apiKeyId??req.actor.apiKeyId,raw=key?req.headers.authorization?.replace(/^Bearer /,''):req.cookies[sessionName]??req.headers.authorization?.replace(/^Bearer /,'');ensure(raw,401,'Brak sesji');const actor=Object.freeze({...req.actor,...(key?{apiKeyId:key}:{})});frames.set(actor,tokenHash(raw));return actor;}
export const returnCredit206FailedWrite=(error:unknown)=>error&&typeof error==='object'?failedWrites.get(error):undefined;
export async function returnCredit206Available():Promise<boolean>{const p=(await pool.query("SELECT to_regprocedure('public.return_credit206_guards()') fn,EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'return\\_credit206\\_%' ESCAPE '\\') partial")).rows[0];if(!p.fn&&!p.partial)return false;ensure(p.fn,503,'Niekompletny moduł');const v=(await pool.query('SELECT public.return_credit206_installed() installed,public.return_credit206_guards() valid')).rows[0];ensure(v.installed&&v.valid,503,'Niekompletny moduł');return true;}
async function owner<T>(c:PoolClient,a:LocalInvoiceActor,fn:()=>Promise<T>):Promise<T>{const r=(await c.query("SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];ensure(r.owner==='postgres'&&['postgres','dyna_app'].includes(r.role)&&r.tenant===a.tenantId,403,'Nieprawidłowy własny kontekst');let first:unknown,failed=false,out!:T;if(r.role==='dyna_app')await c.query('RESET ROLE');try{out=await fn();}catch(e){failed=true;first=e;}if(r.role==='dyna_app')try{await c.query('SET LOCAL ROLE dyna_app');}catch(e){if(!failed){failed=true;first=e;}}if(failed)throw first;return out;}
async function terminal(c:PoolClient,a:LocalInvoiceActor,write:boolean){await c.query('SELECT public.return_credit206_terminal($1,$2,$3)',[a.userId,a.apiKeyId??null,write]);}
async function flags(c:PoolClient,a:LocalInvoiceActor){const g=(await c.query('SELECT public.local_invoice_access($1,$2,false,false) read,public.local_invoice_access($1,$2,true,false) write',[a.userId,a.apiKeyId??null])).rows[0];ensure(g.read.key_valid&&g.read.allowed,403,'Brak aktualnych praw odczytu');return{available:true,current_role:g.read.role,can_read:true,can_preview:Boolean(g.write.allowed&&g.write.key_valid),can_issue:Boolean(g.write.allowed&&g.write.key_valid),read_only:false,scope:{countries:['PL'],currencies:['PLN'],buyer:'consumer',physical_protocols:['rma','assistant_v1','destinations_v1'],financial_strategy:'consumer_return',ksef_state:'not_submitted',fiscalized:false}};}
function mapped(error:unknown):Problem{if(error instanceof Problem)return error;const code=(error as{code?:string})?.code;if(code==='28000')return new Problem(401,'Sesja dokumentu wygasła');if(code==='42501')return new Problem(403,'Brak aktualnych praw dokumentu');if(code==='P0002')return new Problem(404,'Nie znaleziono własnego źródła korekty');if(['23514','23505','40001','40P01'].includes(code??''))return new Problem(409,'Dane dokumentu, zwrotu lub numeracji zmieniły się; odczytaj oryginalny wynik');if(code==='22023')return new Problem(422,'Niepełny obsługiwany zakres korekty');if(code==='54000')return new Problem(413,'Całe źródło korekty przekracza limit');return new Problem(503,'Niekompletny moduł lub niedostępny odczyt korekty');}
async function tx<T>(a:LocalInvoiceActor,write:boolean,fn:(c:PoolClient)=>Promise<T>,command?:{operation:'preview'|'issue'|'series';client_key:string}):Promise<T>{ensure(await returnCredit206Available(),503,'Korekty nie są zainstalowane');const hash=frames.get(a);ensure(hash,401,'Brak oryginalnej ramki żądania');const work=async(c:PoolClient)=>{await c.query("SELECT set_config('local_invoice.identity_hash',$1,true)",[hash]);await terminal(c,a,write);const result=await fn(c);await terminal(c,a,write);return result;};try{return await tenantTx(a.tenantId,work);}catch(e){const error=mapped(e);if(write&&command&&hasAcknowledgedTenantRollback(e,a.tenantId,work))failedWrites.set(error,{actor_id:a.userId,tenant_id:a.tenantId,operation:command.operation,client_key:command.client_key,write_outcome:'failed_before_write'});throw error;}}
async function source(c:PoolClient,a:LocalInvoiceActor,did:string,rid:string):Promise<ReturnCredit206Source>{const x=await owner(c,a,async()=> (await c.query('SELECT public.return_credit206_source($1,$2) source',[did,rid])).rows[0].source as ReturnCredit206Source);return x;}
async function preview(c:PoolClient,row:any,canWrite:boolean,a:LocalInvoiceActor):Promise<ReturnCredit206Preview>{return{id:row.id,original_document_id:row.original_document_id,return_id:row.return_id,scope_hash:row.scope_hash,calculation_hash:row.calculation_hash,snapshot:row.snapshot,expires_at:row.expires_at instanceof Date?row.expires_at.toISOString():row.expires_at,...await consumerCreditPreviewIssueState(c,'destinations',row,canWrite,a)};}
async function detail(c:PoolClient,id:string){const d=(await c.query('SELECT * FROM return_credit206_documents WHERE id=$1',[id])).rows[0],r=(await c.query('SELECT * FROM return_credit206_receipts WHERE document_id=$1',[id])).rows[0];ensure(d&&r,404,'Brak własnej korekty');ensure(d.kind==='correction'&&d.mode==='consumer_return_credit'&&isDeepStrictEqual(d.data,{...r.snapshot,number:r.number,year:r.year,sequence:r.sequence,preview_id:r.preview_id,scope_hash:r.scope_hash})&&d.original_document_id===r.original_document_id&&d.return_id===r.return_id&&r.calculation_hash===consumerCreditHash(r.snapshot.calculation),503,'Niepełny trwały dokument');const document:ReturnCredit206Document={id:d.id,order_id:d.order_id,original_document_id:d.original_document_id,return_id:d.return_id,kind:d.kind,mode:d.mode,number:d.number,data:d.data,created_at:d.created_at.toISOString()};return{document,receipt:{id:r.id,document_id:r.document_id,preview_id:r.preview_id,original_document_id:r.original_document_id,original_receipt_id:r.original_receipt_id,return_id:r.return_id,return_receipt_id:r.return_receipt_id,previous_receipt_id:r.previous_receipt_id,receipt_sequence:r.receipt_sequence,client_key:r.client_key,scope_hash:r.scope_hash,calculation_hash:r.calculation_hash,year:r.year,sequence:r.sequence,number:r.number,actor_id:r.actor_id,api_key_id:r.api_key_id??null}};}
export async function returnCredit206Options(a:LocalInvoiceActor){if(!await returnCredit206Available())return{available:false,can_read:false,can_preview:false,can_issue:false,read_only:false};return tx(a,false,c=>flags(c,a));}
export async function returnCredit206Source(a:LocalInvoiceActor,orderId:string,requestedReturn?:string){
 orderId=creditUuid.parse(orderId);if(requestedReturn)requestedReturn=creditUuid.parse(requestedReturn);
 return tx(a,false,async c=>{
  const docs=(await c.query("SELECT d.id FROM documents d JOIN local_invoice_receipts r ON(r.tenant_id,r.document_id)=(d.tenant_id,d.id) WHERE d.order_id=$1 AND d.kind='invoice' AND d.mode='local_invoice' LIMIT 2",[orderId])).rows;
  ensure(docs.length===1,404,'Zamówienie nie ma własnej numerowanej faktury');
  const first=await owner(c,a,async()=> (await c.query(`SELECT rc.id FROM return_cases rc WHERE rc.order_id=$1 AND (rc.received_at IS NOT NULL OR EXISTS(SELECT FROM return_destination_admissions da WHERE(da.tenant_id,da.return_id)=(rc.tenant_id,rc.id) AND da.after_snapshot IS NOT NULL AND da.payload->>'action'='reject' AND da.payload#>>'{snapshot,protocol}'='destinations_v1')) ORDER BY coalesce(rc.received_at,rc.updated_at),rc.id LIMIT 1`,[orderId])).rows[0]);
  ensure(first,404,'Zamówienie nie ma przyjęcia zwrotu');
  const graph=await source(c,a,docs[0].id,requestedReturn??first.id);let decision=calculateReturnCredit206(graph);
  const selected=selectConsumerReturnSource(graph,decision.next_return_id,requestedReturn);
  if(selected!==graph.selected_return_id)decision=calculateReturnCredit206({...graph,selected_return_id:selected});
  const next=decision.next_return_id?(await c.query('SELECT version::text FROM return_cases WHERE id=$1',[decision.next_return_id])).rows[0]:null;
  const series=(await c.query('SELECT id,version::text,name,prefix,enabled FROM return_credit206_series WHERE enabled ORDER BY created_at,id LIMIT 101')).rows;ensure(series.length<=100,503,'Niepełny zbiór serii korekt');
  return{...await flags(c,a),original:graph.original,acceptances:graph.acceptances,rejected_inspections:graph.rejected_inspections,previous_credits:graph.previous_credits,credit_families:graph.credit_families,physical_protocols:graph.physical_protocols,series,next_return_id:decision.next_return_id,current_return_version:next?.version??null,eligible:decision.status==='credit_required',eligibility_reason:decision.status==='no_commercial_change'?'no_commercial_change':decision.status==='earlier_acceptance_required'?'earlier_acceptance_required':decision.status==='already_credited'?'already_credited':null,calculation:decision.calculation,physical_history_hash:decision.physical_history_hash};
 });
}
export async function returnCredit206Preview(a:LocalInvoiceActor,input:unknown){const b=returnCredit206PreviewInput.parse(input);return tx(a,true,async c=>{const r=(await c.query('SELECT public.return_credit206_preview($1::jsonb,$2,$3) p',[JSON.stringify(b),a.userId,a.apiKeyId??null])).rows[0].p;ensure(r.original_document_id===b.original_document_id&&r.return_id===b.return_id&&r.calculation_hash===consumerCreditHash(r.snapshot.calculation)&&r.request_hash===localInvoiceRequestHash(a.tenantId,a.userId,a.apiKeyId??null,'consumer-return-credit-preview',b.original_document_id,b),503,'Brak oryginalnego preview');if(!r.reused){const decision=calculateReturnCredit206(await source(c,a,b.original_document_id,b.return_id));ensure(decision.status==='credit_required'&&decision.calculation,409,'Przyjęcie nie wymaga nowej korekty');const expected=decision.calculation;ensure(isDeepStrictEqual(r.snapshot.calculation,expected)&&r.snapshot.physical_history_hash===decision.physical_history_hash,503,'Brak parytetu rzeczywistego preview');}return{...await flags(c,a),preview:await preview(c,r,true,a),reused:r.reused,client_key:b.client_key,operation:'preview',actor_id:a.userId,api_key_id:a.apiKeyId??null};},{operation:'preview',client_key:b.client_key});}
export async function returnCredit206PreviewDetail(a:LocalInvoiceActor,id:string){return tx(a,false,async c=>{const p=(await c.query('SELECT p.*,(SELECT document_id FROM return_credit206_receipts r WHERE r.preview_id=p.id) issued_document_id FROM return_credit206_previews p WHERE p.id=$1',[creditUuid.parse(id)])).rows[0];ensure(p,404,'Brak własnego preview');const f=await flags(c,a);return{...f,preview:await preview(c,p,f.can_issue,a)};});}
export async function returnCredit206Issue(a:LocalInvoiceActor,id:string,input:unknown){id=creditUuid.parse(id);const b=returnCredit206IssueInput.parse(input);return tx(a,true,async c=>{const r=(await c.query('SELECT public.return_credit206_issue($1,$2::jsonb,$3,$4) receipt',[id,JSON.stringify(b),a.userId,a.apiKeyId??null])).rows[0].receipt;ensure(r.preview_id===id&&r.client_key===b.client_key&&r.scope_hash===b.scope_hash&&r.request_hash===localInvoiceRequestHash(a.tenantId,a.userId,a.apiKeyId??null,'consumer-return-credit-issue',id,b),503,'Inny oryginalny issue');return{...await flags(c,a),...await detail(c,r.document_id),reused:r.reused,client_key:b.client_key,operation:'issue',actor_id:a.userId,api_key_id:a.apiKeyId??null};},{operation:'issue',client_key:b.client_key});}
export async function returnCredit206Detail(a:LocalInvoiceActor,id:string){return tx(a,false,async c=>({...await flags(c,a),...await detail(c,creditUuid.parse(id))}));}
export async function returnCredit206Register(a:LocalInvoiceActor,cursor?:string){return tx(a,false,async c=>{const rows=(await c.query("SELECT d.id,d.order_id,d.original_document_id,d.return_id,d.number,d.created_at,d.data#>'{calculation,totals,delta}' totals FROM return_credit206_documents d WHERE($1::uuid IS NULL OR(d.created_at,d.id)<(SELECT created_at,id FROM return_credit206_documents WHERE id=$1)) ORDER BY d.created_at DESC,d.id DESC LIMIT 51",[cursor?creditUuid.parse(cursor):null])).rows;if(cursor)ensure((await c.query('SELECT id FROM return_credit206_documents WHERE id=$1',[cursor])).rowCount,404,'Obcy kursor');return{...await flags(c,a),data:rows.slice(0,50),next_cursor:rows.length>50?rows[49].id:null};});}
export async function returnCredit206OriginalCommand(a:LocalInvoiceActor,key:string,operation:'preview'|'issue'|'series'){key=creditUuid.parse(key);return tx(a,false,async c=>{const table=operation==='preview'?'return_credit206_previews':operation==='series'?'return_credit206_series':'return_credit206_receipts';const rows=(await c.query(`SELECT * FROM ${table} WHERE(client_key,actor_id) =($1,$2) AND api_key_id IS NOT DISTINCT FROM $3::uuid LIMIT 2`,[key,a.userId,a.apiKeyId??null])).rows;ensure(rows.length===1,404,'Brak dokładnego oryginalnego wyniku');const r=rows[0],f=await flags(c,a);return{...f,operation,client_key:key,actor_id:a.userId,api_key_id:a.apiKeyId??null,...(operation==='preview'?{preview:await preview(c,r,f.can_issue,a)}:operation==='series'?{series:{id:r.id,version:String(r.version),name:r.name,prefix:r.prefix,enabled:r.enabled}}:await detail(c,r.document_id))};});}

export async function returnCredit206Series(a:LocalInvoiceActor){return tx(a,false,async c=>({...await flags(c,a),data:(await c.query('SELECT id,version::text,name,prefix,enabled FROM return_credit206_series ORDER BY created_at,id LIMIT 101')).rows}));}
export async function returnCredit206CreateSeries(a:LocalInvoiceActor,input:unknown){const b=returnCredit206SeriesInput.parse(input);return tx(a,true,async c=>{const row=(await c.query('SELECT public.return_credit206_series_create($1::jsonb,$2,$3) series',[JSON.stringify(b),a.userId,a.apiKeyId??null])).rows[0].series;ensure(row.client_key===b.client_key&&row.actor_id===a.userId&&(row.api_key_id??null)===(a.apiKeyId??null)&&row.request_hash===localInvoiceRequestHash(a.tenantId,a.userId,a.apiKeyId??null,'consumer-return-credit-series',b.client_key,b),503,'Brak dokładnego wyniku konfiguracji serii');return{...await flags(c,a),series:{id:row.id,version:String(row.version),name:row.name,prefix:row.prefix,enabled:row.enabled},reused:row.reused,operation:'series',client_key:b.client_key,actor_id:a.userId,api_key_id:a.apiKeyId??null};},{operation:'series',client_key:b.client_key});}
/** Strategy selection is a current-authorized read of real sealed physical history.
 * Absence of the successor never turns a destinations return into a legacy write. */
export async function returnCredit206Strategy(a:LocalInvoiceActor,orderId:string){
 orderId=creditUuid.parse(orderId);const identity=frames.get(a);ensure(identity,401,'Brak oryginalnej tożsamości korekty');
 const available=await returnCredit206Available();
 return tenantTx(a.tenantId,async c=>{
  await c.query("SELECT set_config('local_invoice.identity_hash',$1,true)",[identity]);
  await c.query('SELECT public.local_consumer_credit_terminal($1,$2,false)',[a.userId,a.apiKeyId??null]);
  ensure((await c.query('SELECT id FROM orders WHERE id=$1',[orderId])).rowCount,404,'Nie znaleziono własnego zamówienia');
  // 148's completed admission is authentic destinations history even when
  // nonstrict OFF deliberately produced no numbered169 receipt. Never route
  // that history to legacy. Without the installed211 successor, each received
  // admission still needs its own sealed169.
  const history=await owner(c,a,async()=> (await c.query(`SELECT
    (EXISTS(SELECT FROM catalog_stock_return_receipts r
      JOIN catalog_stock_return_admissions ca ON(ca.tenant_id,ca.id)=(r.tenant_id,r.id)
      WHERE(r.tenant_id,r.order_id)=($1,$2) AND ca.protocol='destinations_v1' AND ca.sealed)
    OR EXISTS(SELECT FROM return_destination_admissions da
      WHERE(da.tenant_id,da.order_id)=($1,$2) AND da.after_snapshot IS NOT NULL
      AND da.payload->>'action' IN('receive','reject') AND da.payload#>>'{snapshot,protocol}'='destinations_v1')) AS destination,
    EXISTS(SELECT FROM return_destination_admissions da
      WHERE(da.tenant_id,da.order_id)=($1,$2) AND da.after_snapshot IS NOT NULL
      AND da.payload->>'action'='receive' AND da.payload#>>'{snapshot,protocol}'='destinations_v1'
      AND NOT EXISTS(SELECT FROM catalog_stock_return_receipts r
        JOIN catalog_stock_return_admissions ca ON(ca.tenant_id,ca.id)=(r.tenant_id,r.id)
        WHERE(r.tenant_id,r.order_id,r.return_id,r.assistant_receipt_id)=
          (da.tenant_id,da.order_id,da.return_id,da.receipt_id)
        AND ca.protocol='destinations_v1' AND ca.sealed)) AS catalog_receipt_missing`,[a.tenantId,orderId])).rows[0]);
  ensure(history && typeof history.destination==='boolean' && typeof history.catalog_receipt_missing==='boolean',503,'Niepełny stan strategii korekty');
  let native148Available=false;
  if(history.catalog_receipt_missing){
   ensure(history.destination,503,'Niespójny stan przyjęcia zwrotu');
   native148Available=await owner(c,a,async()=>{
    try{
     const module=(await c.query(`SELECT
       to_regprocedure('public.return_credit211_metadata_valid()') metadata_fn,
       to_regprocedure('public.return_credit211_acceptance(uuid,uuid)') acceptance_fn,
       to_regprocedure('public.return_credit211_history148(uuid)') history_fn,
       to_regprocedure('public.return_credit211_source(uuid,uuid)') source_fn,
       to_regprocedure('public.return_credit211_ensure_parent(uuid)') parent_fn,
       to_regclass('public.return_credit211_metadata') metadata_table,
       to_regclass('public.return_credit211_acceptances') parent_table,
       (EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'return_credit211_'))
        OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'return_credit211_'))
        OR EXISTS(SELECT FROM pg_type WHERE typnamespace='public'::regnamespace AND (starts_with(typname,'return_credit211_') OR starts_with(typname,'_return_credit211_')))) partial`)).rows[0];
     const required=['metadata_fn','acceptance_fn','history_fn','source_fn','parent_fn','metadata_table','parent_table'] as const;
     ensure(module&&typeof module.partial==='boolean',503,'Niepełny stan modułu korekt211');
     if(!module.partial&&required.every(key=>module[key]===null))return false;
     ensure(module.partial&&required.every(key=>Boolean(module[key]))&&available,503,'Niekompletny moduł korekt211');
     // metadata_valid authenticates the complete installed footprint and six
     // fixed206 changes. Source compilation/normal installation owns its seal;
     // presence, a caller flag or a draft source contract cannot enable this.
     ensure((await c.query('SELECT public.return_credit211_metadata_valid() valid')).rows[0]?.valid===true,503,'Niepełny seal modułu korekt211');
     const missing=(await c.query(`SELECT da.return_id,da.receipt_id FROM return_destination_admissions da
       WHERE(da.tenant_id,da.order_id)=($1,$2) AND da.after_snapshot IS NOT NULL
       AND da.payload->>'action'='receive' AND da.payload#>>'{snapshot,protocol}'='destinations_v1'
       AND NOT EXISTS(SELECT FROM catalog_stock_return_receipts r
         JOIN catalog_stock_return_admissions ca ON(ca.tenant_id,ca.id)=(r.tenant_id,r.id)
         WHERE(r.tenant_id,r.order_id,r.return_id,r.assistant_receipt_id)=
           (da.tenant_id,da.order_id,da.return_id,da.receipt_id)
         AND ca.protocol='destinations_v1' AND ca.sealed)
       ORDER BY da.return_id LIMIT 1001`,[a.tenantId,orderId])).rows;
     ensure(missing.length>0&&missing.length<=1000,503,'Niepełny zbiór przyjęć zwrotu211');
     for(const row of missing){
      // Parents are born during issue, so table presence is not acceptance.
      // The real resolver checks169 first and refuses partial169 before148.
      const accepted=(await c.query('SELECT public.return_credit211_acceptance($1,$2) acceptance',[orderId,row.return_id])).rows[0]?.acceptance;
      ensure(accepted?.family==='destinations148'&&accepted.protocol==='destinations_v1'
       &&accepted.tenant_id===a.tenantId&&accepted.order_id===orderId&&accepted.return_id===row.return_id&&accepted.id===row.receipt_id
       &&Number.isInteger(accepted.receipt_sequence)&&accepted.receipt_sequence>=1&&accepted.receipt_sequence<=1000
       &&/^[a-f0-9]{64}$/.test(accepted.evidence_hash??'')&&/^[a-f0-9]{64}$/.test(accepted.financial?.financial_hash??''),503,'Niepełna autoryzacja rzeczywistego przyjęcia211');
     }
     ensure((await c.query('SELECT public.return_credit211_metadata_valid() valid')).rows[0]?.valid===true,503,'Seal modułu korekt211 zmienił się');
     return true;
    }catch{ensure(false,503,'Niekompletny moduł lub historia korekt211');return false;}
   });
  }
  await c.query('SELECT public.local_consumer_credit_terminal($1,$2,false)',[a.userId,a.apiKeyId??null]);
  if(history.catalog_receipt_missing&&!native148Available)return{order_id:orderId,strategy:'destinations' as const,available:false,unavailable_reason:'catalog_receipt_required' as const};
  return{order_id:orderId,strategy:history.destination?'destinations':'legacy',available:history.destination?available:true};
 });
}
