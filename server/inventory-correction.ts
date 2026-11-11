import { drainPublicConstraintsInTx } from './public-constraint-drain';
/** SOURCE_ONLY intended server module: public WMS adjustment adapter; OFF remains separate.
 * HTTP credential custody is trusted application evidence, not an independent SQL actor certificate.
 * No top-level app/db evaluation. Existing WMS090/strict152 remain the physical writers.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ensure } from './errors';
import { inventoryCorrectionPreviewInput, inventoryCorrectionExecuteInput } from './inventory-correction-schema';

type Actor={tenantId:string;userId:string;role:'admin'|'operator'|'viewer';apiKeyId?:string;source:'manual'|'api';canReadValue:boolean};
type Request={actor:{tenantId:string;userId:string|null;role:'admin'|'operator'|'viewer';apiKeyId?:string};currentUser:{api_key_id?:unknown};apiScopes?:string[];headers:{authorization?:string};cookies:Record<string,string|undefined>};
type Proof={actor:Actor;digest:string;mode:'session'|'api'};
type Duty={proof:Proof;write:boolean;previewId:string|null;preview:unknown;operationId:string|null;operation:unknown;ttl:boolean;read:boolean;cost:boolean};
type Managed={duties:Duty[];prepared:boolean};
const custody=new WeakMap<Actor,Proof>();
const managed=new WeakMap<PoolClient,Managed>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasInventoryCorrectionTransactionDuty(c:PoolClient){return Boolean(managed.get(c)?.duties.length);}
const has=(r:Request,...scopes:string[])=>!r.apiScopes||scopes.every(s=>r.apiScopes!.includes(s));
export function captureInventoryCorrectionActor(req:Request,sessionName:string,legacy=false):Actor{
 ensure(req.actor.userId,401,'Wymagany bieżący użytkownik');
 const bearer=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):undefined;
 const api=bearer?.startsWith('dyna_api_')===true;
 const key=req.currentUser.api_key_id;
 ensure(!api||typeof key==='string'&&req.actor.apiKeyId===key&&!!req.apiScopes,401,'Brak bieżącego klucza API');
 ensure(api||!req.apiScopes&&!req.actor.apiKeyId,401,'Niespójna przestrzeń uwierzytelnienia');
 const token=api?bearer:req.cookies[sessionName]??bearer;
 ensure(token,401,'Brak aktualnej sesji');
 ensure(legacy||has(req,'inventory:read'),403,'Brak zakresu odczytu magazynu');
 const actor:Actor={tenantId:req.actor.tenantId,userId:req.actor.userId,role:req.actor.role,
  source:api?'api':'manual',...(api?{apiKeyId:key as string}:{}),canReadValue:req.actor.role==='admin'&&has(req,'purchasing:read')};
 custody.set(actor,{actor,digest:createHash('sha256').update(token).digest('hex'),mode:api?'api':'session'});
 return actor;
}
export function beginInventoryCorrectionTransaction(c:PoolClient){ensure(!managed.has(c),500,'Powtórzona transakcja korekty');managed.set(c,{duties:[],prepared:false});}
export function endInventoryCorrectionTransaction(c:PoolClient){managed.delete(c);}
async function owner<T>(c:PoolClient,fn:()=>Promise<T>):Promise<T>{
 const state=(await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant")).rows[0];
 ensure(state.role==='dyna_app'&&state.owner==='postgres',403,'Wymagany zarządzany kontekst właściciela');
 await c.query('RESET ROLE');let failed=false;try{return await fn();}catch(e){failed=true;throw e;}finally{if(failed)await c.query('SET LOCAL ROLE dyna_app').catch(()=>{});else await c.query('SET LOCAL ROLE dyna_app');}
}
async function record(c:PoolClient,a:Actor,p:Record<string,any>|null,write:boolean,ttl:boolean,operation?:Record<string,any>){
 const proof=custody.get(a),tx=managed.get(c);
 ensure(proof&&tx&&!tx.prepared,500,'Brak rzeczywistej zarządzanej władzy HTTP');
 ensure((await c.query("SELECT current_setting('app.tenant_id',true) tenant")).rows[0].tenant===a.tenantId,403,'Obcy zakres korekty');
 ensure(!p||p.kind==='adjustment'&&p.tenant_id===a.tenantId,409,'Podgląd nie jest własną korektą WMS');
 if(write)ensure(a.role==='admin',403,'Korekta kosztowa wymaga administratora');
 const preview=p?(await c.query('SELECT to_jsonb(p) value FROM wms_previews p WHERE(tenant_id,id)=($1,$2)',[a.tenantId,p.id])).rows[0]?.value:null;
 const op=operation?(await c.query('SELECT to_jsonb(o) value FROM wms_operations o WHERE(tenant_id,id)=($1,$2)',[a.tenantId,operation.id])).rows[0]?.value:null;
 ensure(!p||preview,409,'Brak rzeczywistego podglądu');
 ensure(!operation||op&&op.kind==='adjustment'&&op.actor_id===a.userId&&op.request.preview_id===p?.id&&op.source===a.source,409,'Brak własnego wykonania korekty');
 tx.duties.push({proof,write,previewId:p?.id??null,preview,operationId:operation?.id??null,operation:op,ttl,read:p!==null,cost:p!==null&&(write||a.canReadValue)});
}
export async function enlistInventoryLegacyAdjustmentInTx(c:PoolClient,a:Actor,productId:string){
 const {catalogStockControlStrictCatalogInTx}=await import('./catalog-stock-control');
 const p=(await c.query('SELECT catalog_id FROM products WHERE(tenant_id,id)=($1,$2)',[a.tenantId,productId])).rows[0];
 ensure(p,404,'Nie znaleziono własnego produktu');
 ensure(!await catalogStockControlStrictCatalogInTx(c,a,p.catalog_id,{scopes:['inventory:read','inventory:write']}),409,'Ścisła korekta bez WMS wymaga odrębnego natywnego protokołu PW/RW');
 await record(c,a,null,true,false);
}
export async function previewInventoryCorrection(a:Actor,raw:unknown){
 const body=inventoryCorrectionPreviewInput.parse(raw);
 const W=await import('./wms-lots');
 return W.createWmsMovementPreview(a,body,{enlist:async(c,p,replay)=>{await record(c,a,p,true,!replay);}});
}
export async function readInventoryCorrectionPreview(a:Actor,id:string){
 const W=await import('./wms-lots');
 return W.wmsPreviewDetail(a,id,'movement',{enlist:async(c,p)=>{await record(c,a,p,false,false);}});
}
export async function executeInventoryCorrection(a:Actor,raw:unknown){
 const b=inventoryCorrectionExecuteInput.parse(raw),W=await import('./wms-lots');
 const result=await W.executeWmsMovement(a,b.preview_id,{client_key:b.client_key,scope_hash:b.scope_hash,confirmed:b.confirmed},{
  validate:async(_c,p)=>{ensure(p.kind==='adjustment',409,'Źródło nie jest korektą WMS');},
  enlist:async(c,p,replay,operation)=>{await record(c,a,p,true,!replay,operation);},
 });
 return {...result,correction_protocol:'wms_adjustment090' as const,document_protocol:result.correction_document?'strict152_pw_rw' as const:'native_wms090' as const};
}
// Owner bridge reads private IAM without widening sealed ACLs. Native writes still
// execute only under dyna_app inside the original managed transaction.
async function pin(c:PoolClient,p:Proof){
 const a=p.actor;
 await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[a.userId]);
 await c.query('SELECT id FROM tenants WHERE id=$1 FOR SHARE',[a.tenantId]);
 await c.query('SELECT user_id FROM account_security WHERE user_id=$1 FOR SHARE',[a.userId]);
 await c.query('SELECT tenant_id FROM workspace_security_policies WHERE tenant_id=$1 FOR SHARE',[a.tenantId]);
 await c.query('SELECT user_id FROM memberships WHERE(tenant_id,user_id)=($1,$2) FOR SHARE',[a.tenantId,a.userId]);
 if(p.mode==='api')await c.query('SELECT id FROM api_keys WHERE(tenant_id,user_id,id)=($1,$2,$3) FOR SHARE',[a.tenantId,a.userId,a.apiKeyId]);
 else await c.query('SELECT token_hash FROM sessions WHERE(tenant_id,user_id,token_hash)=($1,$2,$3) FOR SHARE',[a.tenantId,a.userId,p.digest]);
}
async function check(c:PoolClient,d:Duty){
 const a=d.proof.actor;
 // A MATERIALIZED clock is shared by credential expiry, MFA and preview TTL.
 // This terminal read has no row locks, constraint hydration or physical writer.
 const sql=`WITH clock AS MATERIALIZED(SELECT clock_timestamp() now), principal AS(
 SELECT m.role,coalesce(pol.require_mfa,false) required,sec.enabled_at,
 ${d.proof.mode==='api'?"k.scopes,k.revoked_at IS NULL AND k.token_hash=$3 AND k.expires_at>clock.now alive,true session_valid,true mfa_valid":"NULL::text[] scopes,s.expires_at>clock.now alive,s.account_version=coalesce(sec.version,0) session_valid,s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at>clock.now-interval '8 hours' mfa_valid"}
 FROM clock JOIN users u ON u.id=$2 JOIN tenants t ON t.id=$1 JOIN memberships m ON(m.tenant_id,m.user_id)=(t.id,u.id)
 LEFT JOIN account_security sec ON sec.user_id=u.id LEFT JOIN workspace_security_policies pol ON pol.tenant_id=t.id
 ${d.proof.mode==='api'?"JOIN api_keys k ON(k.tenant_id,k.user_id,k.id)=($1,$2,$4)":"JOIN sessions s ON(s.tenant_id,s.user_id,s.token_hash)=($1,$2,$3)"}
 ) SELECT principal.*, ${d.ttl?'EXISTS(SELECT FROM wms_previews pv,clock WHERE(pv.tenant_id,pv.id)=($1,$5) AND pv.expires_at>clock.now)':'true'} ttl FROM principal`;
 // Explicit $4/$5 typing keeps both SQL variants valid under extended pg parse.
 const full=sql.replace('SELECT principal.*,','SELECT $4::uuid AS key_binding,$5::uuid AS preview_binding,principal.*,');
 const r=(await c.query(full,[a.tenantId,a.userId,d.proof.digest,a.apiKeyId??null,d.previewId])).rows[0];
 ensure(r&&r.alive&&r.session_valid,401,'Sesja lub klucz korekty wygasły albo zostały odwołane');
 ensure(r.role===a.role,409,'Bieżąca rola zmieniła się');
 ensure(!r.required||r.enabled_at&&r.mfa_valid,403,'Wymagane bieżące MFA');
 const scopes=[...(d.read?['inventory:read']:[]),...(d.write?['inventory:write']:[]),...(d.cost?['purchasing:read',...(d.write?['purchasing:write']:[])]:[])];
 ensure(d.proof.mode!=='api'||Array.isArray(r.scopes)&&scopes.every(s=>r.scopes.includes(s)),403,'Brak aktualnych zakresów korekty');
 ensure(!d.write||r.role==='admin',403,'Korekta wymaga bieżącego administratora');
 ensure(r.ttl,409,'Natywny podgląd korekty wygasł podczas oczekiwania');
}
export async function prepareInventoryCorrectionFinalizationInTx(c:PoolClient){
 const tx=managed.get(c);if(!tx?.duties.length)return;
 ensure(!tx.prepared,500,'Powtórzony PIN korekty');
 await drainPublicConstraintsInTx(c);
 await owner(c,async()=>{
  const sorted=[...tx.duties].sort((x,y)=>JSON.stringify([x.proof.actor.userId,x.proof.actor.apiKeyId??x.proof.digest]).localeCompare(JSON.stringify([y.proof.actor.userId,y.proof.actor.apiKeyId??y.proof.digest])));
  for(const d of sorted){await pin(c,d.proof);await check(c,d);
   if(d.previewId)ensure((await c.query('SELECT to_jsonb(p)=$3::jsonb ok FROM wms_previews p WHERE(tenant_id,id)=($1,$2)',[d.proof.actor.tenantId,d.previewId,JSON.stringify(d.preview)])).rows[0]?.ok,409,'Natywny podgląd korekty zmienił się');
   if(d.operationId)ensure((await c.query('SELECT to_jsonb(o)=$3::jsonb ok FROM wms_operations o WHERE(tenant_id,id)=($1,$2)',[d.proof.actor.tenantId,d.operationId,JSON.stringify(d.operation)])).rows[0]?.ok,409,'Natywne wykonanie korekty zmieniło się');
  }
 });tx.prepared=true;
}
/** LAST cooperative clock gate, after every sibling PIN/constraint/source wait. */
export async function finalizeInventoryCorrectionClockInTx(c:PoolClient){
 const tx=managed.get(c);if(!tx?.duties.length)return;
 ensure(tx.prepared,500,'Brak końcowego PIN korekty');
 // Public adapters perform exactly one preview/read/execute (or legacy delta) per
 // transaction. No multi-duty loop whose earlier deadline could precede a wait.
 ensure(tx.duties.length===1,500,'Korekta publiczna wymaga pojedynczego końcowego obowiązku');
 await owner(c,()=>check(c,tx.duties[0]));
}
