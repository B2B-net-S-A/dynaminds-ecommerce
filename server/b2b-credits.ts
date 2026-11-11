/** Staged160 fixed managed coordinator. No arbitrary callbacks or provider/KSeF I/O. */
import type {Pool,PoolClient} from 'pg';
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
import {fa3DraftOwnerInTx} from './fa3-draft-access';
import {B2bFa3Error} from './fa3-draft-model';
import {b2bFa3NativeRequestActor,b2bFa3NativeIdentityHash,b2bFa3NativeManifestHash,type B2bFa3NativeActor} from './fa3-draft-source';
import {b2bCreditPreviewInput,b2bCreditIssueInput,b2bCreditPageQuery,validateB2bCreditSnapshot,validateB2bCreditDocument,type B2bCreditPreview,type B2bCreditDocument,type B2bCreditReceipt,type B2bCreditSource} from './b2b-credit-values';
import {prepareB2bHistoricalPzInTx,claimB2bHistoricalPzCandidateInTx,discardB2bHistoricalPz} from './b2b-credit-physical';
import {B2bCorrectionError} from './b2b-credit-arithmetic';
import {tagEligibilityForVerifiedCreditSource160} from './b2b-credit-source-eligibility';
import {b2bCreditPrintHtml} from './b2b-credit-print';
export {b2bCreditPreviewInput,b2bCreditIssueInput,b2bCreditPageQuery,b2bFa3NativeRequestActor as b2bCreditRequestActor};
const uuid=z.uuid().transform(v=>v.toLowerCase());
type Row=Record<string,any>;
const bounded=<T>(v:T):T=>{ensure(Buffer.byteLength(JSON.stringify(v),'utf8')<=4194304,413,'Pełny wynik korekty przekracza4MiB; brak obcięcia');return v;};
function failure(e:unknown):never{
 if(e instanceof Problem)throw e;if(e instanceof B2bCorrectionError)throw new Problem(e.code==='BYTES_EXCEEDED'?413:e.code==='INVALID_INPUT'?422:409,'Niepełna albo nieobsługiwana historia korekty');if(e instanceof z.ZodError||e instanceof B2bFa3Error)throw new Problem(422,'Niepełna lub nieobsługiwana faktura B2B');
 const code=(e as {code?:string})?.code;
 if(code==='28000')throw new Problem(401,'Sesja lub klucz B2B utraciły ważność');
 if(code==='42501')throw new Problem(403,'Brak aktualnych uprawnień B2B');
 if(code==='55000'||code==='42P01'||code==='42883')throw new Problem(503,'Niepełne natywne metadane B2B');
 if(code==='22023'||code==='22P02'||code==='22007'||code==='22008')throw new Problem(422,'Niepełne dane faktury B2B');
 if(code==='23514'||code==='23505')throw new Problem(409,'Źródło lub zgoda faktury B2B zmieniły się');
 if(code==='P0002')throw new Problem(404,'Nie znaleziono własnej faktury lub źródła B2B');
 if(code==='54000')throw new Problem(413,'Budżet pełnych faktur B2B przekroczony');throw e;
}
async function moduleProbe(c:Pool|PoolClient){
 const p=(await c.query(`SELECT EXISTS(SELECT FROM migrations WHERE name='160_b2b_credit') installed,
 to_regprocedure('public.b2b_credit_guards()') IS NOT NULL helper,
 (EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'b2b\\_credit\\_%' ESCAPE '\\') OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'b2b\\_credit\\_%' ESCAPE '\\') OR EXISTS(SELECT FROM pg_trigger WHERE tgname LIKE 'b2b\\_credit\\_%' ESCAPE '\\') OR EXISTS(SELECT FROM pg_constraint WHERE conname='documents_b2b_credit')) artifacts`)).rows[0];
 if(!p.installed&&!p.helper&&!p.artifacts)return false;ensure(p.installed&&p.helper,503,'Niepełny moduł wystawieniaFV');
 ensure((await c.query('SELECT public.b2b_credit_guards() ok')).rows[0].ok===true,503,'Uszkodzony profil upgradeFV');return true;
}
export const b2bCreditModuleAvailable=()=>moduleProbe(pool);
async function previewInTx(c:PoolClient,a:B2bFa3NativeActor,id:string,canWrite:boolean):Promise<B2bCreditPreview>{
 const p=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT to_jsonb(p)||jsonb_build_object('pending',p.expires_at>clock_timestamp() AND NOT EXISTS(SELECT FROM b2b_credit_receipts r WHERE(r.tenant_id,r.preview_id)=(p.tenant_id,p.id))) r FROM b2b_credit_previews p WHERE(p.tenant_id,p.id)=($1,$2)`,[a.tenantId,id])).rows[0]?.r);
 ensure(p,404,'Brak własnego podgląduFV');return {id:p.id,original_document_id:p.original_document_id,return_id:p.return_id,scope_hash:p.scope_hash,expires_at:p.expires_at,snapshot:validateB2bCreditSnapshot(p.snapshot),can_issue:canWrite&&p.pending===true&&p.actor_id===a.userId&&(p.api_key_id??null)===(a.apiKeyId??null)};
}
function document(raw:Row):B2bCreditDocument{
 const d={id:raw.id,order_id:raw.order_id,return_id:raw.return_id,kind:raw.kind,mode:raw.mode,number:raw.number,data:raw.data,created_at:raw.created_at};return validateB2bCreditDocument(d);
}
function receipt(raw:Row):B2bCreditReceipt{raw={...raw,return_receipt_id:raw.return_receipt_id??raw.financial_return_receipt_id};return Object.fromEntries(['id','document_id','preview_id','original_document_id','original_receipt_id','return_id','return_receipt_id','receipt_sequence','previous_receipt_id','client_key','scope_hash','calculation_hash','year','sequence','number','issued_at'].map(k=>[k,raw[k]])) as B2bCreditReceipt;}
async function detailInTx(c:PoolClient,a:B2bFa3NativeActor,id:string){
 // Own native document RLS first, never owner bridge for a foreign raw identifier.
 ensure((await c.query(`SELECT id FROM documents WHERE(tenant_id,id)=($1,$2) AND mode='b2b_correction'`,[a.tenantId,id])).rowCount,404,'Brak własnejFV');
 const r=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT to_jsonb(d) document,to_jsonb(r) receipt FROM documents d JOIN b2b_credit_receipts r ON(r.tenant_id,r.document_id)=(d.tenant_id,d.id) WHERE(d.tenant_id,d.id)=($1,$2)`,[a.tenantId,id])).rows[0]);
 ensure(r,503,'FV nie ma niezmiennego receipt');const d=document(r.document),p=receipt(r.receipt);
 ensure(p.document_id===d.id&&p.preview_id===d.data.preview_id&&p.original_document_id===d.data.original_document_id&&p.original_receipt_id===d.data.original_receipt_id&&p.return_id===d.return_id&&p.return_receipt_id===d.data.return_receipt_id&&p.receipt_sequence===d.data.receipt_sequence&&p.calculation_hash===d.data.calculation_hash&&p.number===d.number&&p.scope_hash===d.data.scope_hash&&p.year===d.data.year&&p.sequence===d.data.sequence&&b2bFa3NativeManifestHash(r.receipt.snapshot)===b2bFa3NativeManifestHash(d.data),503,'Niespójny niezmienny grafFV');return{document:d,receipt:p};
}
type Write={kind:'preview';body:z.infer<typeof b2bCreditPreviewInput>}|{kind:'issue';id:string;body:z.infer<typeof b2bCreditIssueInput>};
async function writeInTx(c:PoolClient,a:B2bFa3NativeActor,w:Write,h:string){
 const p=w.kind==='issue'?await fa3DraftOwnerInTx(c,async()=> (await c.query('SELECT original_document_id,return_id FROM b2b_credit_previews WHERE(tenant_id,id)=($1,$2)',[a.tenantId,w.id])).rows[0]):w.body;
 ensure(p,404,'Brak własnego preview160');
 // Same native acquisition order BEFORE collectors pin any source row. No
 // owner/RLS bypass: locks validates the actual own159 document first.
 await fa3DraftOwnerInTx(c,()=>c.query('SELECT public.b2b_credit_locks($1)',[p.original_document_id]));
 const replay=await fa3DraftOwnerInTx(c,async()=> (await c.query(w.kind==='preview'?'SELECT id FROM b2b_credit_previews WHERE(tenant_id,client_key)=($1,$2)':'SELECT id FROM b2b_credit_receipts WHERE(tenant_id,client_key)=($1,$2)',[a.tenantId,w.body.client_key])).rowCount);
 const invoke=(input:unknown,calc:unknown)=>fa3DraftOwnerInTx(c,async()=> (await c.query(w.kind==='preview'?'SELECT public.b2b_credit_preview($1::jsonb,$2::jsonb,$3::jsonb,$4,$5,$6) r':'SELECT public.b2b_credit_issue($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7) r',w.kind==='preview'?[JSON.stringify(w.body),input===null?null:JSON.stringify(input),calc===null?null:JSON.stringify(calc),a.userId,a.apiKeyId??null,h]:[w.id,JSON.stringify(w.body),input===null?null:JSON.stringify(input),calc===null?null:JSON.stringify(calc),a.userId,a.apiKeyId??null,h])).rows[0].r);
 // Already-issued replay does not reinterpret immutable history as a new command.
 // The native replay branch still checks actual principal, key, preview/bodyhash.
 if(replay)return invoke(null,null);
 const token=await prepareB2bHistoricalPzInTx(c,a,{document_id:p.original_document_id,return_id:p.return_id});
 try{const proof=await claimB2bHistoricalPzCandidateInTx(c,a,token);return await invoke(proof.input,proof.calculation);}finally{discardB2bHistoricalPz(c,a,token);}
}
async function sourceInTx(c:PoolClient,a:B2bFa3NativeActor,id:string):Promise<B2bCreditSource>{
 ensure((await c.query("SELECT id FROM documents WHERE(tenant_id,id)=($1,$2) AND kind='invoice' AND mode='b2b_invoice'",[a.tenantId,id])).rowCount,404,'Brak własnej FV159');
 const src=await fa3DraftOwnerInTx(c,async()=>{await c.query('SELECT public.b2b_credit_locks($1)',[id]);return(await c.query('SELECT public.b2b_credit_basis($1,NULL) source',[id])).rows[0].source;});
 const original=src.input.original;const previous=[];for(const p of src.input.previous_credits)previous.push(await detailInTx(c,a,p.document_id));
 const accepted=src.input.acceptances.map((r:Row)=>({return_id:r.return_id,number:r.number,receipt_sequence:r.receipt_sequence,received_at:r.received_at,refund_amount_minor:r.refund_amount_minor,refunded_shipping_minor:r.refunded_shipping_minor,receipt_id:r.native_proof.receipt_id,credited_document_id:src.input.previous_credits.find((p:Row)=>p.return_id===r.return_id)?.document_id??null,...(r.acceptance_kind==='financial_no_restock'?{acceptance_kind:'financial_no_restock' as const}:{})}));
 return bounded(tagEligibilityForVerifiedCreditSource160({original,accepted_returns:accepted,previous_credits:previous,next_return_id:accepted[previous.length]?.return_id??null}));
}
type Operation={kind:'options'}|{kind:'preview';body:unknown}|{kind:'preview_detail';id:string}|{kind:'issue';id:string;body:unknown}|{kind:'detail';id:string}|{kind:'print';id:string}|{kind:'list';query:unknown}|{kind:'source';id:string};
async function managed(a:B2bFa3NativeActor,op:Operation):Promise<any>{
 const h=b2bFa3NativeIdentityHash(a),writing=op.kind==='preview'||op.kind==='issue',c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);await c.query("SET LOCAL statement_timeout='8s'");await c.query("SET LOCAL TimeZone='UTC'");
  beginWmsTransaction(c);beginPurchasingTransaction(c);beginDispatchTransaction(c);beginCatalogStockControlTransaction(c);beginAllegroAuthorityTransaction(c);
  await wmsLotsAdmissionInTx(c,{tenantId:a.tenantId},'shared');await purchasingStockAdmissionInTx(c,{tenantId:a.tenantId});await catalogStockControlAdmissionInTx(c,{tenantId:a.tenantId},'shared');
  const available=await fa3DraftOwnerInTx(c,()=>moduleProbe(c));
  if(!available){ensure(op.kind==='options',503,'WystawienieFV niedostępne');await c.query('COMMIT');return{available:false,read_only:false,current_role:null,can_read:false,can_preview:false,can_issue:false};}
  await fa3DraftOwnerInTx(c,()=>c.query('SELECT public.b2b_credit_require($1,$2,$3,$4,false)',[a.userId,a.apiKeyId??null,h,writing]));
  await c.query("SELECT set_config('b2b_credit.identity_hash',$1,true)",[h]);let out:any;
  if(op.kind==='options'){const g=(await c.query('SELECT public.local_invoice_access($1,$2,true,false) g',[a.userId,a.apiKeyId??null])).rows[0].g;out={available:true,read_only:false,current_role:g.role,can_read:true,can_preview:g.allowed===true,can_issue:g.allowed===true};}
  else if(op.kind==='preview'){
   const b=b2bCreditPreviewInput.parse(op.body);const r=await writeInTx(c,a,{kind:'preview',body:b},h);
   if(!r.reused)await audit(c,a,'b2b.credit.preview',r.id,{original_document_id:b.original_document_id,return_id:b.return_id});out={preview:await previewInTx(c,a,r.id,true),reused:Boolean(r.reused)};
  }else if(op.kind==='issue'){
   const b=b2bCreditIssueInput.parse(op.body);const r=await writeInTx(c,a,{kind:'issue',id:op.id,body:b},h);
   if(!r.reused)await audit(c,a,'b2b.credit.issue',r.document_id,{preview_id:op.id,receipt_id:r.receipt_id,scope_hash:b.scope_hash});out={...await detailInTx(c,a,r.document_id),reused:Boolean(r.reused)};
  }else if(op.kind==='preview_detail'){const g=(await c.query('SELECT public.local_invoice_access($1,$2,true,false) g',[a.userId,a.apiKeyId??null])).rows[0].g;out={preview:await previewInTx(c,a,op.id,g.allowed===true)};}
  else if(op.kind==='detail'||op.kind==='print'){const d=await detailInTx(c,a,op.id);out=op.kind==='print'?b2bCreditPrintHtml(d.document):d;}
  else if(op.kind==='source'){out=await sourceInTx(c,a,op.id);}
  else{out=await listInTx(c,a,op.query);}
  if(typeof out!=='string')bounded(out); // print renderer has its independent full4MiB bound.
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');await finalizeWmsActorsInTx(c);await finalizeCatalogStockControlActorsInTx(c);await finalizeDispatchActorsInTx(c);await finalizeCatalogStockCountTerminalInTx(c);await finalizeAllegroAuthoritiesInTx(c);
  // Fixed native operation selector never enlists arbitrary COUNT/OAuth/physical mutations.
  // ALL graph, FK, RAM serialization and sibling blockers precede this actual last native clock.
  const terminal=(await c.query('SELECT public.b2b_credit_terminal($1,$2,$3,$4) g',[a.userId,a.apiKeyId??null,h,writing])).rows[0].g;
  if(op.kind==='options'){out.current_role=terminal.role;out.can_preview=terminal.allowed===true;out.can_issue=terminal.allowed===true;}
  if(out?.preview)out.preview.can_issue&&=terminal.allowed===true&&Date.parse(out.preview.expires_at)>Date.parse(terminal.stamp);
  await c.query('COMMIT');return out;
 }catch(e){await c.query('ROLLBACK');return failure(e);}finally{endWmsTransaction(c);endPurchasingTransaction(c);endDispatchTransaction(c);endCatalogStockControlTransaction(c);endAllegroAuthorityTransaction(c);c.release();}
}
function encodeCursor(body:string){const b=Buffer.from(body).toString('base64url');return b+'.'+createHmac('sha256',localConfig.encryptionKey).update('b2b-corrections\0'+b).digest('hex');}
function decodeCursor(value:string){const [b,mac,...rest]=value.split('.');ensure(!rest.length&&b&&/^[a-f0-9]{64}$/.test(mac??''),422,'Niepoprawny kursor');const expected=createHmac('sha256',localConfig.encryptionKey).update('b2b-corrections\0'+b).digest();ensure(timingSafeEqual(Buffer.from(mac,'hex'),expected),422,'Niepoprawny podpis kursora');return Buffer.from(b,'base64url').toString('utf8');}
const cursorSchema=z.strictObject({domain:z.literal('b2b-native-corrections/v1'),tenant:uuid,actor:uuid,key:uuid.nullable(),grant:z.string(),limit:z.number().int().min(1).max(50),at:z.string(),id:uuid});
async function listInTx(c:PoolClient,a:B2bFa3NativeActor,input:unknown){
 const q=b2bCreditPageQuery.parse(input),grant=(await c.query('SELECT public.local_invoice_access($1,$2,false,false) g',[a.userId,a.apiKeyId??null])).rows[0].g;
 const auth=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT coalesce(a.version,0) account_version,pg_postmaster_start_time() epoch,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_identity,(SELECT to_jsonb(k)-'token_hash' FROM api_keys k WHERE(k.tenant_id,k.id,k.user_id)=($1,$3,$2)) key,
 (SELECT to_jsonb(p) FROM workspace_security_policies p WHERE p.tenant_id=$1) policy FROM users u LEFT JOIN account_security a ON a.user_id=u.id WHERE u.id=$2`,[a.tenantId,a.userId,a.apiKeyId??null])).rows[0]);
 const grantHash=b2bFa3NativeManifestHash({grant,auth,identity:b2bFa3NativeIdentityHash(a)});let anchor:z.infer<typeof cursorSchema>|undefined;
 if(q.cursor){try{anchor=cursorSchema.parse(JSON.parse(decodeCursor(q.cursor)));}catch{throw new Problem(422,'Niepoprawny kursor FV B2B');}
  ensure(anchor.tenant===a.tenantId&&anchor.actor===a.userId&&anchor.key===(a.apiKeyId??null)&&anchor.grant===grantHash&&anchor.limit===q.limit,409,'Kursor z innego kontekstu FV');
  ensure((await fa3DraftOwnerInTx(c,()=>c.query('SELECT document_id FROM b2b_credit_receipts WHERE(tenant_id,document_id,issued_at)=($1,$2,$3::timestamptz)',[a.tenantId,anchor!.id,anchor!.at]))).rowCount,422,'Kursor nie ma rzeczywistego wiersza');
 }
 const rows=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT to_jsonb(d) r,to_jsonb(receipt) receipt FROM b2b_credit_receipts receipt JOIN documents d ON(d.tenant_id,d.id)=(receipt.tenant_id,receipt.document_id) WHERE receipt.tenant_id=$1${anchor?' AND(receipt.issued_at,receipt.document_id)<($2::timestamptz,$3::uuid)':''} ORDER BY receipt.issued_at DESC,receipt.document_id DESC LIMIT ${q.limit+1}`,anchor?[a.tenantId,anchor.at,anchor.id]:[a.tenantId])).rows);
 const page=rows.slice(0,q.limit),last=page.at(-1);
 const next=rows.length>q.limit&&last?encodeCursor(JSON.stringify({domain:'b2b-native-corrections/v1',tenant:a.tenantId,actor:a.userId,key:a.apiKeyId??null,grant:grantHash,limit:q.limit,at:last.receipt.issued_at,id:last.r.id})):null;
 return{documents:page.map(row=>document(row.r)),next_cursor:next};
}
export const b2bCreditOptions=(a:B2bFa3NativeActor)=>managed(a,{kind:'options'});
export const b2bCreditPreview=(a:B2bFa3NativeActor,body:unknown)=>managed(a,{kind:'preview',body});
export const b2bCreditSource=(a:B2bFa3NativeActor,id:string)=>managed(a,{kind:'source',id:uuid.parse(id)});
export const b2bCreditPreviewDetail=(a:B2bFa3NativeActor,id:string)=>managed(a,{kind:'preview_detail',id:uuid.parse(id)});
export const b2bCreditIssue=(a:B2bFa3NativeActor,id:string,body:unknown)=>managed(a,{kind:'issue',id:uuid.parse(id),body});
export const b2bCreditDetail=(a:B2bFa3NativeActor,id:string)=>managed(a,{kind:'detail',id:uuid.parse(id)});
export const b2bCreditPrint=(a:B2bFa3NativeActor,id:string)=>managed(a,{kind:'print',id:uuid.parse(id)});
export const b2bCreditRegister=(a:B2bFa3NativeActor,query:unknown)=>managed(a,{kind:'list',query});
