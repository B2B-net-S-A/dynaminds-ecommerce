import { assertNoPartialCommercialInvoiceInTx } from './commercial-sale-scope';
import { assertNoInvoice230InTx } from './invoice230';
/** SOURCE_DRAFT_ONLY158. Private fixed-operation coordinator, no arbitrary callback API.
 * All actual sibling finalizers/FK waits precede FA3 native terminal clock.
 * This file does NOT install routes, issue FV, number FV, serialize FA3 XML or call KSeF.
 */
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {pool,localConfig} from './db';
import {audit} from './domain';
import {ensure,Problem} from './errors';
import {beginWmsTransaction,endWmsTransaction,wmsLotsAdmissionInTx,finalizeWmsActorsInTx} from './wms-lots-transaction';
import {beginPurchasingTransaction,endPurchasingTransaction,purchasingStockAdmissionInTx} from './purchasing-transaction';
import {beginDispatchTransaction,endDispatchTransaction,finalizeDispatchActorsInTx} from './dispatch-transaction';
import {beginCatalogStockControlTransaction,endCatalogStockControlTransaction,catalogStockControlAdmissionInTx,finalizeCatalogStockControlActorsInTx,finalizeCatalogStockCountTerminalInTx} from './catalog-stock-control-transaction';
import {beginAllegroAuthorityTransaction,endAllegroAuthorityTransaction,finalizeAllegroAuthoritiesInTx} from './allegro-oauth-authority';
import {fa3DraftAvailableInTx,fa3DraftOwnerInTx} from './fa3-draft-access';
import {validateB2bFa3Draft,B2bFa3Error,type B2bFa3Draft} from './fa3-draft-model';
import {b2bFa3NativeRequest,b2bFa3NativeRequestActor,b2bFa3NativeIdentityHash,b2bFa3NativeManifestHash,
 prepareB2bFa3NativeDraftInTx,b2bFa3NativePreparedInTx,finalizeB2bFa3NativeDraftInTx,discardB2bFa3NativeDraft,
 type B2bFa3NativeActor,type B2bFa3NativeHandle} from './fa3-draft-source';
export {b2bFa3NativeRequest as fa3DraftPreviewInput,b2bFa3NativeRequestActor as fa3DraftRequestActor};
const uuid=z.uuid().transform(v=>v.toLowerCase());
export const fa3DraftApproveInput=z.strictObject({client_key:uuid,scope_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),project_only:z.literal(true)});
export const fa3DraftPageQuery=z.strictObject({limit:z.coerce.number().int().min(1).max(50).default(50),cursor:z.string().min(1).max(2048).optional()});
export type Fa3DraftPreview={id:string;order_id:string;series_id:string;scope_hash:string;expires_at:string;draft:B2bFa3Draft;draft_hash:string;xml_mapping_ready:boolean;can_approve:boolean};
export type Fa3DraftProject={id:string;preview_id:string;order_id:string;state:'approved_project';draft:B2bFa3Draft;draft_hash:string;scope_hash:string;issued:false;ksef_state:'not_submitted';created_at:string};
export type Fa3DraftReceipt={id:string;project_id:string;preview_id:string;client_key:string;scope_hash:string;approved_at:string};
type Row=Record<string,any>;
const bounded=<T>(v:T):T=>{ensure(Buffer.byteLength(JSON.stringify(v),'utf8')<=1048576,413,'Pełny wynik projektu przekracza1MiB; brak obcięcia');return v;};
function failure(e:unknown):never{
 if(e instanceof Problem)throw e;if(e instanceof z.ZodError||e instanceof B2bFa3Error)throw new Problem(422,'Niepełny lub nieobsługiwany projekt B2B');
 const code=(e as {code?:string})?.code;
 if(code==='28000')throw new Problem(401,'Sesja lub klucz B2B utraciły ważność');
 if(code==='42501')throw new Problem(403,'Brak aktualnych uprawnień B2B');
 if(code==='55000'||code==='42P01'||code==='42883')throw new Problem(503,'Niepełne natywne metadane B2B');
 if(code==='22023'||code==='22P02'||code==='22007'||code==='22008')throw new Problem(422,'Niepełne dane projektu B2B');
 if(code==='23514'||code==='23505')throw new Problem(409,'Źródło lub zgoda projektu B2B zmieniły się');
 if(code==='P0002')throw new Problem(404,'Nie znaleziono własnego projektu lub źródła B2B');
 if(code==='54000')throw new Problem(413,'Budżet pełnych projektów B2B przekroczony');throw e;
}
function draft(v:unknown,hash:string){const d=validateB2bFa3Draft(v);ensure(b2bFa3NativeManifestHash(d)===hash,503,'Niespójny niezmienny draft');return d;}
function preview(r:Row,canWrite:boolean):Fa3DraftPreview{const d=draft(r.draft,r.draft_hash);return{id:r.id,order_id:r.order_id,series_id:r.series_id,scope_hash:r.scope_hash,expires_at:r.expires_at,draft:d,draft_hash:r.draft_hash,xml_mapping_ready:d.lines.every(l=>l.rounding_gross_minor==='0'),can_approve:canWrite&&r.pending===true};}
function project(r:Row):Fa3DraftProject{return{id:r.id,preview_id:r.preview_id,order_id:r.order_id,state:'approved_project',draft:draft(r.draft,r.draft_hash),draft_hash:r.draft_hash,scope_hash:r.scope_hash,issued:false,ksef_state:'not_submitted',created_at:r.created_at};}
function receipt(r:Row):Fa3DraftReceipt{return{id:r.id,project_id:r.project_id,preview_id:r.preview_id,client_key:r.client_key,scope_hash:r.scope_hash,approved_at:r.approved_at};}
async function previewInTx(c:PoolClient,a:B2bFa3NativeActor,pid:string,canWrite:boolean){
 const row=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT to_jsonb(p)||jsonb_build_object('pending',p.expires_at>clock_timestamp() AND NOT EXISTS(SELECT FROM fa3_draft_projects d WHERE(d.tenant_id,d.preview_id)=(p.tenant_id,p.id))) r
 FROM fa3_draft_previews p WHERE(p.tenant_id,p.id)=($1,$2)`,[a.tenantId,pid])).rows[0]?.r);
 ensure(row,404,'Brak własnego podglądu B2B');return preview(row,canWrite&&row.actor_id===a.userId&&(row.api_key_id??null)===(a.apiKeyId??null));
}
async function projectInTx(c:PoolClient,a:B2bFa3NativeActor,id:string){
 const r=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT to_jsonb(d) project,to_jsonb(r) receipt FROM fa3_draft_projects d JOIN fa3_draft_receipts r ON(r.tenant_id,r.project_id)=(d.tenant_id,d.id) WHERE(d.tenant_id,d.id)=($1,$2)`,[a.tenantId,id])).rows[0]);
 ensure(r,404,'Brak własnego zatwierdzonego projektu B2B');return {project:project(r.project),receipt:receipt(r.receipt)};
}
type Operation={kind:'options'}|{kind:'source';id:string}|{kind:'preview';id:string;body:unknown}|{kind:'preview_detail';id:string}|{kind:'approve';id:string;body:unknown}|{kind:'detail';id:string}|{kind:'list';query:unknown};
/** Nonexported typed operation selector means callers cannot introduce a COUNT,
 * OAuth/provider, WMS or later arbitrary callback into this terminal scope. */
async function managed(a:B2bFa3NativeActor,op:Operation):Promise<any>{
 const h=b2bFa3NativeIdentityHash(a),writing=['preview','approve'].includes(op.kind),c=await pool.connect();let handle:B2bFa3NativeHandle|undefined;
 try{
  await c.query('BEGIN');await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);
  await c.query("SET LOCAL statement_timeout='8s'");await c.query("SET LOCAL TimeZone='UTC'");
  beginWmsTransaction(c);beginPurchasingTransaction(c);beginDispatchTransaction(c);beginCatalogStockControlTransaction(c);beginAllegroAuthorityTransaction(c);
  await wmsLotsAdmissionInTx(c,{tenantId:a.tenantId},'shared');await purchasingStockAdmissionInTx(c,{tenantId:a.tenantId});await catalogStockControlAdmissionInTx(c,{tenantId:a.tenantId},'shared');
  const available=await fa3DraftAvailableInTx(c);
  if(!available){ensure(op.kind==='options',503,'Moduł projektów B2B niedostępny');await c.query('COMMIT');return{available:false,read_only:false,current_role:null,can_read:false,can_prepare:false,persistence_available:false,can_approve:false};}
  await fa3DraftOwnerInTx(c,()=>c.query('SELECT public.fa3_draft_require($1,$2,$3,$4,false)',[a.userId,a.apiKeyId??null,h,writing]));
  await c.query("SELECT set_config('fa3_draft.identity_hash',$1,true)",[h]);
  let out:any;
  if(op.kind==='options'){
   const grant=(await c.query('SELECT public.local_invoice_access($1,$2,true,false) g',[a.userId,a.apiKeyId??null])).rows[0].g;
   out={available:true,read_only:false,current_role:grant.role,can_read:true,can_prepare:grant.allowed===true,persistence_available:true,can_approve:grant.allowed===true};
  }else if(op.kind==='source'){out=await sourceInTx(c,a,op.id);}
  else if(op.kind==='preview'){
   const b=b2bFa3NativeRequest.parse(op.body);ensure(b.order_id===op.id,422,'Niezgodne zamówienie podglądu');
   await assertNoPartialCommercialInvoiceInTx(c,op.id);await assertNoInvoice230InTx(c,op.id);
   const prior=await fa3DraftOwnerInTx(c,async()=> (await c.query('SELECT id,actor_id,api_key_id,request FROM fa3_draft_previews WHERE(tenant_id,client_key)=($1,$2)',[a.tenantId,b.client_key])).rows[0]);
   let p:Row;
   if(prior){ensure(prior.actor_id===a.userId&&(prior.api_key_id??null)===(a.apiKeyId??null)&&b2bFa3NativeManifestHash(prior.request)===b2bFa3NativeManifestHash(b),409,'Klucz podglądu użyty z inną zgodą');p={id:prior.id,reused:true};}
   else{
    handle=await prepareB2bFa3NativeDraftInTx(c,a,b);const candidate=b2bFa3NativePreparedInTx(c,a,handle);
    p=await fa3DraftOwnerInTx(c,async()=> (await c.query('SELECT public.fa3_draft_store_preview($1::jsonb,$2,$3::jsonb,$4,$5,$6) p',[JSON.stringify(b),candidate.shipping_id,JSON.stringify(candidate.draft),a.userId,a.apiKeyId??null,h])).rows[0].p);
    if(!p.reused)await audit(c,a,'b2b.fa3.preview',p.id,{order_id:b.order_id,series_id:b.seller_series_id});
   }
   out={preview:await previewInTx(c,a,p.id,true),reused:Boolean(p.reused)};
  }else if(op.kind==='approve'){
   const b=fa3DraftApproveInput.parse(op.body);
   const ownPreview=await fa3DraftOwnerInTx(c,async()=> (await c.query('SELECT order_id FROM fa3_draft_previews WHERE(tenant_id,id)=($1,$2)',[a.tenantId,op.id])).rows[0]);
   ensure(ownPreview,404,'Brak własnego podglądu B2B');await assertNoPartialCommercialInvoiceInTx(c,ownPreview.order_id);await assertNoInvoice230InTx(c,ownPreview.order_id);
   const r=await fa3DraftOwnerInTx(c,async()=> (await c.query('SELECT public.fa3_draft_approve($1,$2::jsonb,$3,$4,$5) r',[op.id,JSON.stringify(b),a.userId,a.apiKeyId??null,h])).rows[0].r);
   if(!r.reused)await audit(c,a,'b2b.fa3.approve',r.project_id,{preview_id:op.id,receipt_id:r.receipt_id,scope_hash:b.scope_hash});
   out={...await projectInTx(c,a,r.project_id),reused:Boolean(r.reused)};
  }else if(op.kind==='preview_detail'){const grant=(await c.query('SELECT public.local_invoice_access($1,$2,true,false) g',[a.userId,a.apiKeyId??null])).rows[0].g;out={preview:await previewInTx(c,a,op.id,grant.allowed===true)};}
  else if(op.kind==='detail'){out=await projectInTx(c,a,op.id);}
  else{out=await listInTx(c,a,op.query);}
  // Result hydrated/validated in RAM before any last managed authority check.
  out=bounded(out);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  if(handle){await finalizeB2bFa3NativeDraftInTx(c,a,handle);handle=undefined;}
  await finalizeWmsActorsInTx(c);await finalizeCatalogStockControlActorsInTx(c);await finalizeDispatchActorsInTx(c);
  await finalizeCatalogStockCountTerminalInTx(c);await finalizeAllegroAuthoritiesInTx(c);
  // The fixed operations above enlist NO COUNT/OAuth/physical actors. All sibling
  // finalizers still run; this actual native clock is LAST, immediately COMMIT.
  const terminal=(await c.query('SELECT public.fa3_draft_terminal($1,$2,$3,$4) g',[a.userId,a.apiKeyId??null,h,writing])).rows[0].g;
  if(op.kind==='options'){out.current_role=terminal.role;out.can_prepare=terminal.allowed===true;out.can_approve=terminal.allowed===true;}
  if(out.preview)out.preview.can_approve&&=terminal.allowed===true&&Date.parse(out.preview.expires_at)>Date.parse(terminal.stamp);
  await c.query('COMMIT');return out;
 }catch(e){await c.query('ROLLBACK');return failure(e);}finally{
  if(handle)discardB2bFa3NativeDraft(c,a,handle);
  endWmsTransaction(c);endPurchasingTransaction(c);endDispatchTransaction(c);endCatalogStockControlTransaction(c);endAllegroAuthorityTransaction(c);c.release();
 }
}
function encodeCursor(body:string){const b=Buffer.from(body).toString('base64url');return b+'.'+createHmac('sha256',localConfig.encryptionKey).update('fa3-projects\0'+b).digest('hex');}
function decodeCursor(value:string){const [b,mac,...rest]=value.split('.');ensure(!rest.length&&b&&/^[a-f0-9]{64}$/.test(mac??''),422,'Niepoprawny kursor');const expected=createHmac('sha256',localConfig.encryptionKey).update('fa3-projects\0'+b).digest();ensure(timingSafeEqual(Buffer.from(mac,'hex'),expected),422,'Niepoprawny podpis kursora');return Buffer.from(b,'base64url').toString('utf8');}
const cursorSchema=z.strictObject({domain:z.literal('fa3-approved-projects/v1'),tenant:uuid,actor:uuid,key:uuid.nullable(),grant:z.string(),limit:z.number().int().min(1).max(50),at:z.string(),id:uuid});
async function listInTx(c:PoolClient,a:B2bFa3NativeActor,input:unknown){
 const q=fa3DraftPageQuery.parse(input),grant=(await c.query('SELECT public.local_invoice_access($1,$2,false,false) g',[a.userId,a.apiKeyId??null])).rows[0].g;
 const auth=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT coalesce(a.version,0) account_version,pg_postmaster_start_time() epoch,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_identity,(SELECT to_jsonb(k)-'token_hash' FROM api_keys k WHERE(k.tenant_id,k.id,k.user_id)=($1,$3,$2)) key,
 (SELECT to_jsonb(p) FROM workspace_security_policies p WHERE p.tenant_id=$1) policy FROM users u LEFT JOIN account_security a ON a.user_id=u.id WHERE u.id=$2`,[a.tenantId,a.userId,a.apiKeyId??null])).rows[0]);
 const grantHash=b2bFa3NativeManifestHash({grant,auth,identity:b2bFa3NativeIdentityHash(a)});let anchor:z.infer<typeof cursorSchema>|undefined;
 if(q.cursor){try{anchor=cursorSchema.parse(JSON.parse(decodeCursor(q.cursor)));}catch{throw new Problem(422,'Niepoprawny kursor projektów B2B');}
  ensure(anchor.tenant===a.tenantId&&anchor.actor===a.userId&&anchor.key===(a.apiKeyId??null)&&anchor.grant===grantHash&&anchor.limit===q.limit,409,'Kursor z innego kontekstu projektu');
  ensure((await fa3DraftOwnerInTx(c,()=>c.query('SELECT id FROM fa3_draft_projects WHERE(tenant_id,id,created_at)=($1,$2,$3::timestamptz)',[a.tenantId,anchor!.id,anchor!.at]))).rowCount,422,'Kursor nie ma rzeczywistego wiersza');
 }
 const rows=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT to_jsonb(d) r FROM fa3_draft_projects d WHERE tenant_id=$1${anchor?' AND(created_at,id)<($2::timestamptz,$3::uuid)':''} ORDER BY created_at DESC,id DESC LIMIT ${q.limit+1}`,anchor?[a.tenantId,anchor.at,anchor.id]:[a.tenantId])).rows.map(r=>r.r));
 const page=rows.slice(0,q.limit),last=page.at(-1);
 const next=rows.length>q.limit&&last?encodeCursor(JSON.stringify({domain:'fa3-approved-projects/v1',tenant:a.tenantId,actor:a.userId,key:a.apiKeyId??null,grant:grantHash,limit:q.limit,at:last.created_at,id:last.id})):null;
 return{projects:page.map(project),next_cursor:next};
}
async function sourceInTx(c:PoolClient,a:B2bFa3NativeActor,id:string){
 await assertNoPartialCommercialInvoiceInTx(c,id);
 ensure((await c.query('SELECT id FROM orders WHERE(tenant_id,id)=($1,$2)',[a.tenantId,id])).rowCount,404,'Brak własnego zamówienia B2B');
 const series=await fa3DraftOwnerInTx(c,async()=> (await c.query('SELECT id,name,definition FROM local_invoice_series WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 51',[a.tenantId])).rows);
 ensure(series.length<=50,413,'Źródło wymaga pełnej listy maksymalnie50serii');ensure(series.length,409,'Utwórz rzeczywistą serię sprzedawcy');
 const src=await fa3DraftOwnerInTx(c,async()=> (await c.query('SELECT public.fa3_draft_source($1::jsonb,false) s',[JSON.stringify({order_id:id,seller_series_id:series[0].id})])).rows[0].s);
 const o=src.order;ensure(o.currency==='PLN'&&o.address?.country==='PL'&&o.fulfillment_kind==='sale'&&['shipped','delivered'].includes(o.status),422,'Źródło wymaga wysłanej krajowej sprzedaży PL/PLN');
 ensure(src.items.every((i:Row)=>[0,5,8,23].includes(i.vat)),422,'Nieobsługiwana historyczna stawka VAT');let buyer=null,basis=null;
 if(src.bridge){const p=src.bridge.bill_to;buyer={kind:'business',name:p.name,tax_id:p.tax_id,address:{country:p.address.country,line1:p.address.street,line2:p.address.postal_code+' '+p.address.city}};
  basis={kind:'native_b2b_bill_to',binding_id:src.dropship.id,binding_version:src.dropship.version,snapshot_hash:b2bFa3NativeManifestHash({bridge:src.bridge,parent:src.dropship,quote:src.quote})};}
 else ensure(o.source==='manual'&&o.b2b_account_id===null&&o.b2b_snapshot===null,422,'Portal/import B2B wymaga osobnego źródła');
 return{order_id:o.id,order_version:o.version,number:o.number,status:o.status,currency:o.currency,native_source_kind:src.bridge?'dropship_frozen':'ordinary_explicit',
 seller_series:series.map(s=>({id:s.id,name:s.name,seller:{kind:'business',name:s.definition.seller.name,tax_id:s.definition.seller.tax_id,address:{country:s.definition.seller.country,line1:s.definition.seller.street,line2:s.definition.seller.postal_code+' '+s.definition.seller.city}},definition_hash:b2bFa3NativeManifestHash(s.definition)})),
 items:src.items.map((i:Row)=>({id:i.id,name:i.name,quantity:String(i.quantity),unit_gross_minor:String(i.price),gross_minor:String(i.line_total),vat_rate:i.vat})),shipping_gross_minor:String(o.shipping_cost),order_total_minor:String(o.total),buyer,buyer_basis:basis};
}
export const fa3DraftOptions=(a:B2bFa3NativeActor)=>managed(a,{kind:'options'});
export const fa3DraftOrderSource=(a:B2bFa3NativeActor,id:string)=>managed(a,{kind:'source',id:uuid.parse(id)});
export const fa3DraftPreview=(a:B2bFa3NativeActor,id:string,body:unknown)=>managed(a,{kind:'preview',id:uuid.parse(id),body});
export const fa3DraftPreviewDetail=(a:B2bFa3NativeActor,id:string)=>managed(a,{kind:'preview_detail',id:uuid.parse(id)});
export const fa3DraftApprove=(a:B2bFa3NativeActor,id:string,body:unknown)=>managed(a,{kind:'approve',id:uuid.parse(id),body});
export const fa3DraftProjectDetail=(a:B2bFa3NativeActor,id:string)=>managed(a,{kind:'detail',id:uuid.parse(id)});
export const fa3DraftProjects=(a:B2bFa3NativeActor,query:unknown)=>managed(a,{kind:'list',query});
/** Construction/request metadata probe uses pool's actual owner role. Never
 * queries a private migration ledger under dyna_app; no user data is returned. */
export async function fa3DraftModuleAvailable(){
 const p=(await pool.query(`SELECT EXISTS(SELECT FROM migrations WHERE name='158_fa3_draft_native') installed,
 to_regprocedure('public.fa3_draft_guards()') IS NOT NULL helper,
 (EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'fa3\\_draft\\_%' ESCAPE '\\')
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fa3\\_draft\\_%' ESCAPE '\\')) artifacts`)).rows[0];
 if(!p.installed&&!p.helper&&!p.artifacts)return false;ensure(p.installed&&p.helper,503,'Niepełny moduł B2B');
 ensure((await pool.query('SELECT public.fa3_draft_guards() ok')).rows[0].ok===true,503,'Uszkodzone metadane B2B');return true;
}
