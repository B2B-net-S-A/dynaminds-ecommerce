/** Staged159 fixed managed coordinator. No arbitrary callbacks or provider/KSeF I/O. */
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
import {b2bInvoicePreviewInput,b2bInvoiceIssueInput,b2bInvoicePageQuery,validateB2bInvoiceSnapshot,validateB2bInvoiceDocument,type B2bInvoicePreview,type B2bInvoiceDocument,type B2bInvoiceReceipt} from './b2b-invoice-values';
import {b2bInvoicePrintHtml} from './b2b-invoice-print';
export {b2bInvoicePreviewInput,b2bInvoiceIssueInput,b2bInvoicePageQuery,b2bFa3NativeRequestActor as b2bInvoiceRequestActor};
const uuid=z.uuid().transform(v=>v.toLowerCase());
type Row=Record<string,any>;
const bounded=<T>(v:T):T=>{ensure(Buffer.byteLength(JSON.stringify(v),'utf8')<=1048576,413,'Pełny wynik FV przekracza1MiB; brak obcięcia');return v;};
function failure(e:unknown):never{
 if(e instanceof Problem)throw e;if(e instanceof z.ZodError||e instanceof B2bFa3Error)throw new Problem(422,'Niepełna lub nieobsługiwana faktura B2B');
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
 const p=(await c.query(`SELECT EXISTS(SELECT FROM migrations WHERE name='159_b2b_invoice') installed,
 to_regprocedure('public.b2b_invoice_guards()') IS NOT NULL helper,
 (EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'b2b\\_invoice\\_%' ESCAPE '\\') OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'b2b\\_invoice\\_%' ESCAPE '\\')) artifacts`)).rows[0];
 if(!p.installed&&!p.helper&&!p.artifacts)return false;ensure(p.installed&&p.helper,503,'Niepełny moduł wystawieniaFV');
 ensure((await c.query('SELECT public.b2b_invoice_guards() ok')).rows[0].ok===true,503,'Uszkodzony profil upgradeFV');return true;
}
export const b2bInvoiceModuleAvailable=()=>moduleProbe(pool);
async function previewInTx(c:PoolClient,a:B2bFa3NativeActor,id:string,canWrite:boolean):Promise<B2bInvoicePreview>{
 const p=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT to_jsonb(p)||jsonb_build_object('pending',p.expires_at>clock_timestamp() AND NOT EXISTS(SELECT FROM b2b_invoice_receipts r WHERE(r.tenant_id,r.preview_id)=(p.tenant_id,p.id))) r FROM b2b_invoice_previews p WHERE(p.tenant_id,p.id)=($1,$2)`,[a.tenantId,id])).rows[0]?.r);
 ensure(p,404,'Brak własnego podgląduFV');return {id:p.id,project_id:p.project_id,order_id:p.order_id,scope_hash:p.scope_hash,expires_at:p.expires_at,snapshot:validateB2bInvoiceSnapshot(p.snapshot),can_issue:canWrite&&p.pending===true&&p.actor_id===a.userId&&(p.api_key_id??null)===(a.apiKeyId??null)};
}
function document(raw:Row):B2bInvoiceDocument{
 const d={id:raw.id,order_id:raw.order_id,kind:raw.kind,mode:raw.mode,number:raw.number,data:raw.data,created_at:raw.created_at};return validateB2bInvoiceDocument(d);
}
function receipt(raw:Row):B2bInvoiceReceipt{return{id:raw.id,document_id:raw.document_id,preview_id:raw.preview_id,project_id:raw.project_id,project_receipt_id:raw.project_receipt_id,client_key:raw.client_key,scope_hash:raw.scope_hash,year:raw.year,sequence:raw.sequence,number:raw.number,issued_at:raw.issued_at};}
async function detailInTx(c:PoolClient,a:B2bFa3NativeActor,id:string){
 // Own native document RLS first, never owner bridge for a foreign raw identifier.
 ensure((await c.query(`SELECT id FROM documents WHERE(tenant_id,id)=($1,$2) AND mode='b2b_invoice'`,[a.tenantId,id])).rowCount,404,'Brak własnejFV');
 const r=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT to_jsonb(d) document,to_jsonb(r) receipt FROM documents d JOIN b2b_invoice_receipts r ON(r.tenant_id,r.document_id)=(d.tenant_id,d.id) WHERE(d.tenant_id,d.id)=($1,$2)`,[a.tenantId,id])).rows[0]);
 ensure(r,503,'FV nie ma niezmiennego receipt');const d=document(r.document),p=receipt(r.receipt);
 ensure(p.document_id===d.id&&p.preview_id===d.data.preview_id&&p.project_id===d.data.project_id&&p.project_receipt_id===d.data.project_receipt_id&&p.number===d.number&&p.scope_hash===d.data.scope_hash&&p.year===d.data.year&&p.sequence===d.data.sequence&&b2bFa3NativeManifestHash(r.receipt.snapshot)===b2bFa3NativeManifestHash(d.data),503,'Niespójny niezmienny grafFV');return{document:d,receipt:p};
}
type Operation={kind:'options'}|{kind:'preview';id:string;body:unknown}|{kind:'preview_detail';id:string}|{kind:'issue';id:string;body:unknown}|{kind:'detail';id:string}|{kind:'print';id:string}|{kind:'list';query:unknown};
async function managed(a:B2bFa3NativeActor,op:Operation):Promise<any>{
 const h=b2bFa3NativeIdentityHash(a),writing=op.kind==='preview'||op.kind==='issue',c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);await c.query("SET LOCAL statement_timeout='8s'");await c.query("SET LOCAL TimeZone='UTC'");
  beginWmsTransaction(c);beginPurchasingTransaction(c);beginDispatchTransaction(c);beginCatalogStockControlTransaction(c);beginAllegroAuthorityTransaction(c);
  await wmsLotsAdmissionInTx(c,{tenantId:a.tenantId},'shared');await purchasingStockAdmissionInTx(c,{tenantId:a.tenantId});await catalogStockControlAdmissionInTx(c,{tenantId:a.tenantId},'shared');
  const available=await fa3DraftOwnerInTx(c,()=>moduleProbe(c));
  if(!available){ensure(op.kind==='options',503,'WystawienieFV niedostępne');await c.query('COMMIT');return{available:false,read_only:false,current_role:null,can_read:false,can_preview:false,can_issue:false};}
  await fa3DraftOwnerInTx(c,()=>c.query('SELECT public.b2b_invoice_require($1,$2,$3,$4,false)',[a.userId,a.apiKeyId??null,h,writing]));
  await c.query("SELECT set_config('b2b_invoice.identity_hash',$1,true)",[h]);let out:any;
  if(op.kind==='options'){const g=(await c.query('SELECT public.local_invoice_access($1,$2,true,false) g',[a.userId,a.apiKeyId??null])).rows[0].g;out={available:true,read_only:false,current_role:g.role,can_read:true,can_preview:g.allowed===true,can_issue:g.allowed===true};}
  else if(op.kind==='preview'){
   const b=b2bInvoicePreviewInput.parse(op.body);ensure(b.project_id===op.id,422,'Niezgodny projekt źródłowyFV');
   // Native SQL reads the own immutable project and source before locks, then rechecks after locks.
   const r=await fa3DraftOwnerInTx(c,async()=> (await c.query('SELECT public.b2b_invoice_preview($1,$2::jsonb,$3,$4,$5) r',[op.id,JSON.stringify(b),a.userId,a.apiKeyId??null,h])).rows[0].r);
   if(!r.reused)await audit(c,a,'b2b.invoice.preview',r.id,{project_id:op.id});out={preview:await previewInTx(c,a,r.id,true),reused:Boolean(r.reused)};
  }else if(op.kind==='issue'){
   const b=b2bInvoiceIssueInput.parse(op.body);const r=await fa3DraftOwnerInTx(c,async()=> (await c.query('SELECT public.b2b_invoice_issue($1,$2::jsonb,$3,$4,$5) r',[op.id,JSON.stringify(b),a.userId,a.apiKeyId??null,h])).rows[0].r);
   if(!r.reused)await audit(c,a,'b2b.invoice.issue',r.document_id,{preview_id:op.id,receipt_id:r.receipt_id,scope_hash:b.scope_hash});out={...await detailInTx(c,a,r.document_id),reused:Boolean(r.reused)};
  }else if(op.kind==='preview_detail'){const g=(await c.query('SELECT public.local_invoice_access($1,$2,true,false) g',[a.userId,a.apiKeyId??null])).rows[0].g;out={preview:await previewInTx(c,a,op.id,g.allowed===true)};}
  else if(op.kind==='detail'||op.kind==='print'){const d=await detailInTx(c,a,op.id);out=op.kind==='print'?b2bInvoicePrintHtml(d.document):d;}
  else{out=await listInTx(c,a,op.query);}
  if(typeof out!=='string')bounded(out); // print renderer has its independent full2MiB bound.
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');await finalizeWmsActorsInTx(c);await finalizeCatalogStockControlActorsInTx(c);await finalizeDispatchActorsInTx(c);await finalizeCatalogStockCountTerminalInTx(c);await finalizeAllegroAuthoritiesInTx(c);
  // Fixed native operation selector never enlists arbitrary COUNT/OAuth/physical mutations.
  // ALL graph, FK, RAM serialization and sibling blockers precede this actual last native clock.
  const terminal=(await c.query('SELECT public.b2b_invoice_terminal($1,$2,$3,$4) g',[a.userId,a.apiKeyId??null,h,writing])).rows[0].g;
  if(op.kind==='options'){out.current_role=terminal.role;out.can_preview=terminal.allowed===true;out.can_issue=terminal.allowed===true;}
  if(out?.preview)out.preview.can_issue&&=terminal.allowed===true&&Date.parse(out.preview.expires_at)>Date.parse(terminal.stamp);
  await c.query('COMMIT');return out;
 }catch(e){await c.query('ROLLBACK');return failure(e);}finally{endWmsTransaction(c);endPurchasingTransaction(c);endDispatchTransaction(c);endCatalogStockControlTransaction(c);endAllegroAuthorityTransaction(c);c.release();}
}
function encodeCursor(body:string){const b=Buffer.from(body).toString('base64url');return b+'.'+createHmac('sha256',localConfig.encryptionKey).update('b2b-invoices\0'+b).digest('hex');}
function decodeCursor(value:string){const [b,mac,...rest]=value.split('.');ensure(!rest.length&&b&&/^[a-f0-9]{64}$/.test(mac??''),422,'Niepoprawny kursor');const expected=createHmac('sha256',localConfig.encryptionKey).update('b2b-invoices\0'+b).digest();ensure(timingSafeEqual(Buffer.from(mac,'hex'),expected),422,'Niepoprawny podpis kursora');return Buffer.from(b,'base64url').toString('utf8');}
const cursorSchema=z.strictObject({domain:z.literal('b2b-native-invoices/v1'),tenant:uuid,actor:uuid,key:uuid.nullable(),grant:z.string(),limit:z.number().int().min(1).max(50),at:z.string(),id:uuid});
async function listInTx(c:PoolClient,a:B2bFa3NativeActor,input:unknown){
 const q=b2bInvoicePageQuery.parse(input),grant=(await c.query('SELECT public.local_invoice_access($1,$2,false,false) g',[a.userId,a.apiKeyId??null])).rows[0].g;
 const auth=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT coalesce(a.version,0) account_version,pg_postmaster_start_time() epoch,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_identity,(SELECT to_jsonb(k)-'token_hash' FROM api_keys k WHERE(k.tenant_id,k.id,k.user_id)=($1,$3,$2)) key,
 (SELECT to_jsonb(p) FROM workspace_security_policies p WHERE p.tenant_id=$1) policy FROM users u LEFT JOIN account_security a ON a.user_id=u.id WHERE u.id=$2`,[a.tenantId,a.userId,a.apiKeyId??null])).rows[0]);
 const grantHash=b2bFa3NativeManifestHash({grant,auth,identity:b2bFa3NativeIdentityHash(a)});let anchor:z.infer<typeof cursorSchema>|undefined;
 if(q.cursor){try{anchor=cursorSchema.parse(JSON.parse(decodeCursor(q.cursor)));}catch{throw new Problem(422,'Niepoprawny kursor FV B2B');}
  ensure(anchor.tenant===a.tenantId&&anchor.actor===a.userId&&anchor.key===(a.apiKeyId??null)&&anchor.grant===grantHash&&anchor.limit===q.limit,409,'Kursor z innego kontekstu FV');
  ensure((await fa3DraftOwnerInTx(c,()=>c.query('SELECT document_id FROM b2b_invoice_receipts WHERE(tenant_id,document_id,issued_at)=($1,$2,$3::timestamptz)',[a.tenantId,anchor!.id,anchor!.at]))).rowCount,422,'Kursor nie ma rzeczywistego wiersza');
 }
 const rows=await fa3DraftOwnerInTx(c,async()=> (await c.query(`SELECT to_jsonb(d) r,to_jsonb(receipt) receipt FROM b2b_invoice_receipts receipt JOIN documents d ON(d.tenant_id,d.id)=(receipt.tenant_id,receipt.document_id) WHERE receipt.tenant_id=$1${anchor?' AND(receipt.issued_at,receipt.document_id)<($2::timestamptz,$3::uuid)':''} ORDER BY receipt.issued_at DESC,receipt.document_id DESC LIMIT ${q.limit+1}`,anchor?[a.tenantId,anchor.at,anchor.id]:[a.tenantId])).rows);
 const page=rows.slice(0,q.limit),last=page.at(-1);
 const next=rows.length>q.limit&&last?encodeCursor(JSON.stringify({domain:'b2b-native-invoices/v1',tenant:a.tenantId,actor:a.userId,key:a.apiKeyId??null,grant:grantHash,limit:q.limit,at:last.receipt.issued_at,id:last.r.id})):null;
 return{documents:page.map(row=>document(row.r)),next_cursor:next};
}
export const b2bInvoiceOptions=(a:B2bFa3NativeActor)=>managed(a,{kind:'options'});
export const b2bInvoicePreview=(a:B2bFa3NativeActor,id:string,body:unknown)=>managed(a,{kind:'preview',id:uuid.parse(id),body});
export const b2bInvoicePreviewDetail=(a:B2bFa3NativeActor,id:string)=>managed(a,{kind:'preview_detail',id:uuid.parse(id)});
export const b2bInvoiceIssue=(a:B2bFa3NativeActor,id:string,body:unknown)=>managed(a,{kind:'issue',id:uuid.parse(id),body});
export const b2bInvoiceDetail=(a:B2bFa3NativeActor,id:string)=>managed(a,{kind:'detail',id:uuid.parse(id)});
export const b2bInvoicePrint=(a:B2bFa3NativeActor,id:string)=>managed(a,{kind:'print',id:uuid.parse(id)});
export const b2bInvoiceRegister=(a:B2bFa3NativeActor,query:unknown)=>managed(a,{kind:'list',query});
