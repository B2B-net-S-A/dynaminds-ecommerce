/** Selected stock-only execution. No global scheduler, lease reaper or write retry.
 * Existing configuration214 is the durable user consent; the CLI capability is
 * separate from read212. Existing offer processors own plans/provider receipts.
 * audit_events journals exact new jobs, dispatch intent and completion checkpoint.
 * A dispatch without a matching ACK blocks this entire selected channel, including
 * new configuration versions. Restart never turns an uncertain PUT into a new job.
 * Only the selected owner can close such a dispatch (preview reads Woo, reconcile records the
 * operator outcome and its ACK); nothing here ever re-sends the PUT.
 */
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {tenantTx,tenantReadTx} from './db';
import {audit,type Actor} from './domain';
import {ensure,Problem} from './errors';
import {WooCommerce,type Transport} from './integrations';
import {decrypt} from './security';
import {LOCAL_WOO_ORIGINS} from '../shared/local-woo-origins';
import {localWooRegistryFixture,type LocalWooHttpRegistry} from './local-woo-http-registry';
import {readConfiguredLocalWooHttpChannel} from './local-woo-http-fixture';
import {enqueueOfferSync,processOfferSync,failOfferSync} from './offer-sync';
import {processOfferJob,failOffer,desiredOffer,offerSnapshotHash} from './offers';
import {offerConnectionHash} from './offer-sync-policy';
import type {LocalWooStockContext} from './local-woo-stock-context';

const selection=z.strictObject({tenantId:z.uuid(),userId:z.uuid(),channelId:z.uuid(),fixtureId:z.uuid(),origin:z.enum(LOCAL_WOO_ORIGINS)});
export type LocalWooStockSelection=z.infer<typeof selection>;
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const actor=(s:LocalWooStockSelection):Actor=>({tenantId:s.tenantId,userId:s.userId,role:'admin'});
const sourceHash=(ch:any)=>hash({id:ch.id,tenant_id:ch.tenant_id,provider:ch.provider,mode:ch.mode,settings:ch.settings,credentials:ch.credentials,sync_enabled:ch.sync_enabled});
const schema='local-woo-stock-owned/v1';
const ownedAction='local_woo.stock.owned',dispatchAction='local_woo.stock.dispatch',ackAction='local_woo.stock.ack',reconcileAction='local_woo.stock.reconcile',failureAction='local_woo.stock.failure';
const hex64=z.string().regex(/^[a-f0-9]{64}$/);
const stockPayload=z.strictObject({manage_stock:z.literal(true),stock_quantity:z.number().int().min(0),backorders:z.literal('no')});
export const localWooStockReconcileCommand=z.strictObject({client_key:z.uuid(),dispatch_id:z.uuid(),expected_snapshot_sha256:hex64,observation_sha256:hex64.nullable(),outcome:z.enum(['EFFECT_CONFIRMED','SUPERSEDED','FAILED']),confirmed:z.literal(true)});
type ReconcileCommand=z.infer<typeof localWooStockReconcileCommand>;
type Outcome=ReconcileCommand['outcome'];
type FailurePhase='eligibility'|'claim'|'prepare'|'processor'|'provider_read'|'provider_write'|'after_write'|'completion';
type Trace={phase:FailurePhase;requests:number;writes:number;failureHandlerFailed:boolean};
const failureEvidence=z.strictObject({status:z.literal('RETAINED_FAILURE'),phase:z.enum(['eligibility','claim','prepare','processor','provider_read','provider_write','after_write','completion']),detected_at:z.iso.datetime(),dispatch_id:z.uuid().nullable(),job_id:z.uuid().nullable(),kind:z.enum(['offer.sync','offer.write']).nullable(),error_category:z.enum(['POSTGRES','PROBLEM','HTTP','ERROR','THROWN_VALUE']),error_class:z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/).nullable(),sqlstate:z.string().regex(/^[0-9A-Z]{5}$/).nullable(),http_status:z.number().int().min(400).max(599).nullable(),provider_http_status:z.number().int().min(100).max(599).nullable(),error_fingerprint:hex64,plan_phase:z.string().regex(/^[a-z_]{1,32}$/).nullable(),provider_requests:z.number().int().min(0),provider_writes:z.number().int().min(0),failure_handler_failed:z.boolean(),automatic_retry:z.literal(false)});
export type LocalWooStockFailure=z.infer<typeof failureEvidence>;
export type LocalWooStockLog=(line:Record<string,unknown>)=>void;
const defaultLog:LocalWooStockLog=line=>console.error(JSON.stringify(line));
// Read only own data properties: a thrown value may have hostile getters or carry secrets.
function ownValue(error:unknown,key:string):unknown{try{return error!==null&&(typeof error==='object'||typeof error==='function')?Object.getOwnPropertyDescriptor(error,key)?.value:undefined;}catch{return undefined;}}
/** Sanitized cause: category, class, statuses and a fingerprint. Never a message, body, URL or credential. */
function failureCause(error:unknown){
 const code=ownValue(error,'code'),status=ownValue(error,'status'),message=ownValue(error,'message');
 const sqlstate=typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)&&typeof ownValue(error,'severity')==='string'?code:null;
 const http_status=sqlstate===null&&Number.isInteger(status)&&Number(status)>=400&&Number(status)<=599?Number(status):null;
 const text=typeof message==='string'?message:typeof error==='string'?error:typeof error;
 const provider=/^API dostawcy: HTTP ([1-5]\d\d)$/.exec(text);
 let name='';try{name=error instanceof Error?String(Object.getPrototypeOf(error)?.constructor?.name??''):'';}catch{name='';}
 return{error_category:sqlstate?'POSTGRES' as const:error instanceof Problem?'PROBLEM' as const:http_status!==null?'HTTP' as const:error instanceof Error?'ERROR' as const:'THROWN_VALUE' as const,
  error_class:/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name)?name:null,sqlstate,http_status,provider_http_status:provider?Number(provider[1]):null,
  error_fingerprint:createHash('sha256').update(Buffer.from(text.slice(0,8192)).subarray(0,8192)).digest('hex')};
}
// Bounded per-store drain: one cycle runs due work back to back instead of one job per worker tick.
const DRAIN_PER_CYCLE=25;
type Ownership={schema:typeof schema;scope:LocalWooStockSelection;channel_id:string;kind:'offer.sync'|'offer.write';version:number;source_hash:string;parent_id:string|null;plan_id:string|null;checkpoint_hash:string};
type Held={s:LocalWooStockSelection;job:any;own:Ownership;token:string};
function settings(s:LocalWooStockSelection){return{store_url:s.origin,simulation:false,local_http_fixture:{schema:'local-woo-http-fixture/v1',fixture_id:s.fixtureId,owner_id:s.userId}};}
async function config(c:PoolClient,s:LocalWooStockSelection,exclusive=false){return(await c.query('SELECT *,next_run_at IS NULL OR next_run_at<=clock_timestamp() AS stock_due FROM offer_sync_configs WHERE channel_id=$1'+(exclusive?' FOR UPDATE':' FOR SHARE'),[s.channelId])).rows[0];}
/** The same inert predicate as the eligibility read: a paused/unconsented schedule is idle, never a stop. */
const eligibleConfig=(cfg:any)=>cfg?.enabled===true&&cfg.stock===true&&cfg.price===false&&cfg.external_authorized===true;
/** consent=false only after this execution's write left: the pause cannot undo that PUT, so its verification
 * read and receipt may finish under the unchanged owner, source and admin (never a new write). */
async function authorize(c:PoolClient,s:LocalWooStockSelection,version?:number,expectedSource?:string,exclusive=false,consent=true){
 const cfg=await config(c,s,exclusive);
 ensure(cfg?.tenant_id===s.tenantId&&cfg.actor_id===s.userId&&(!consent||eligibleConfig(cfg)&&cfg.price_list_id===null&&(version===undefined||cfg.version===version)),409,'Stanowy harmonogram wymaga aktualnej osobnej zgody');
 const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2 FOR SHARE',[s.tenantId,s.channelId])).rows[0];
 ensure(ch?.provider==='woocommerce'&&ch.mode==='sandbox'&&ch.sync_enabled===false&&isDeepStrictEqual(ch.settings,settings(s))&&cfg.connection_hash===offerConnectionHash(ch)&&(expectedSource===undefined||sourceHash(ch)===expectedSource),409,'Zmienione własne połączenie harmonogramu');
 ensure((await c.query('SELECT public.offer_sync_is_admin($1) AS ok',[s.userId])).rows[0]?.ok===true,403,'Autor harmonogramu utracił uprawnienia');
 return{cfg,ch};
}
async function jobSnapshot(c:PoolClient,id:string,lock=false){return(await c.query('SELECT j.*,to_jsonb(j) AS stock_snapshot FROM jobs j WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];}
function payloadIdentity(j:any,s:LocalWooStockSelection,own:Ownership){
 ensure(j?.tenant_id===s.tenantId&&j.kind===own.kind&&j.payload?.actor_id===s.userId&&j.payload.channel_id===s.channelId&&isDeepStrictEqual(j.payload.local_woo_stock,{schema,scope_hash:hash(s),parent_id:own.parent_id}),409,'Zmienione powiązanie zadania stanów');
 if(j.kind==='offer.sync')ensure(j.payload.version===own.version&&j.dedup_key==='offer.sync:'+j.id,409,'Zmieniona wersja przeglądu');
 else ensure(j.payload.plan_id===own.plan_id&&j.dedup_key==='offer:'+own.plan_id,409,'Zmieniony plan zapisu');
 ensure(Number(j.max_attempts)===1&&!j.provider_wait_until&&!j.provider_wait_reason,409,'Obce ponawianie zadania');
}
function ownership(value:any,s:LocalWooStockSelection):Ownership{
 ensure(value?.schema===schema&&isDeepStrictEqual(value.scope,s)&&value.channel_id===s.channelId&&['offer.sync','offer.write'].includes(value.kind)&&Number.isSafeInteger(value.version)&&value.version>0&&/^[a-f0-9]{64}$/.test(value.source_hash)&&/^[a-f0-9]{64}$/.test(value.checkpoint_hash)&& (value.kind==='offer.sync'?value.parent_id===null&&value.plan_id===null:z.uuid().safeParse(value.parent_id).success&&z.uuid().safeParse(value.plan_id).success),409,'Nieprawidłowy zapis pochodzenia zadania');return value;
}
/** Exact endpoint and exact three-field stock payload; no price/create/delete. */
export function localWooStockTransport(base:Transport,origin:string,before:(method:string,url:URL)=>Promise<void>,plan?:{remote_id:string;parent_external_id?:string|null;payload:unknown}):Transport{
 let putDispatched=false;
 return async(url,init)=>{
  const u=new URL(url),method=init.method??'GET';
  ensure(u.origin===origin&&!u.username&&!u.password&&!u.hash&&!u.search&&/^\/wp-json\/wc\/v3\/products\/[1-9]\d*(?:\/variations\/[1-9]\d*)?$/.test(u.pathname)&&['GET','PUT'].includes(method),403,'Wyłącznie stan istniejącej oferty własnego sklepu');
  if(plan){const expected=plan.parent_external_id?`/wp-json/wc/v3/products/${plan.parent_external_id}/variations/${plan.remote_id}`:`/wp-json/wc/v3/products/${plan.remote_id}`;ensure(u.pathname===expected||method==='GET'&&!!plan.parent_external_id&&u.pathname===`/wp-json/wc/v3/products/${plan.parent_external_id}`,403,'Odczyt poza własnym planem');}
  if(method==='GET')ensure(!init.body,403,'Odczyt nie przyjmuje treści');
  else{
   const path=plan?.parent_external_id?`/wp-json/wc/v3/products/${plan.parent_external_id}/variations/${plan.remote_id}`:`/wp-json/wc/v3/products/${plan?.remote_id}`;
   ensure(plan&&u.pathname===path&&!putDispatched,409,'Zapis poza własnym planem lub ponowienie PUT');
   const body=z.strictObject({manage_stock:z.literal(true),stock_quantity:z.number().int().min(0),backorders:z.literal('no')}).parse(JSON.parse(String(init.body)));
   ensure(isDeepStrictEqual(body,plan.payload),409,'Zmieniona treść planu stanów');
  }
  await before(method,u);
  // Burn before calling transport: a lost provider ACK is never permission to retry.
  if(method==='PUT')putDispatched=true;
  const response=await base(url,init);
  await before('AFTER',u);
  return response;
 };
}
export function createLocalWooStockLane(registry:LocalWooHttpRegistry,input:readonly LocalWooStockSelection[],options:{log?:LocalWooStockLog}={}){
 const scopes=z.array(selection).min(1).max(5).parse(structuredClone(input));
 for(const field of ['channelId','fixtureId','origin'] as const)ensure(new Set(scopes.map(s=>s[field])).size===scopes.length,422,'Powtórzony wybrany sklep');
 for(const s of scopes)localWooRegistryFixture(registry,actor(s),s.channelId);
 let closed=false,active:Promise<void>|undefined;const stopped=new Set<string>();
 // Tokens whose execution this instance owns (from before the dispatch commit until it settles).
 const executing=new Set<string>(),failures=new Map<string,LocalWooStockFailure>(),log=options.log??defaultLog;
 function emit(line:Record<string,unknown>){try{log(line);}catch{/* Logging never changes a lane outcome. */}}
 async function register(c:PoolClient,s:LocalWooStockSelection,id:string,base:Omit<Ownership,'checkpoint_hash'>){
  let j=await jobSnapshot(c,id,true);
  ensure(j?.state==='pending'&&Number(j.attempts)===0&&j.lease_token===null&&j.locked_at===null&&!j.error,409,'Nie można przyjąć istniejącej lub rozpoczętej pracy');
  ensure(!(await c.query('SELECT id FROM audit_events WHERE action=$1 AND entity_id=$2',[ownedAction,id])).rowCount,409,'Praca ma już właściciela');
  await c.query("UPDATE jobs SET max_attempts=1,payload=jsonb_set(payload,'{local_woo_stock}',$2::jsonb) WHERE id=$1",[id,JSON.stringify({schema,scope_hash:hash(s),parent_id:base.parent_id})]);
  j=await jobSnapshot(c,id);const own={...base,checkpoint_hash:hash(j.stock_snapshot)};payloadIdentity(j,s,own);
  await audit(c,actor(s),ownedAction,id,own);return{j,own};
 }
 async function blocked(c:PoolClient,s:LocalWooStockSelection){
  // Scope is bound in every lookup; no global pending/running queue is read/reaped.
  return(await c.query(`SELECT d.id FROM audit_events d WHERE d.action=$1 AND d.detail->>'channel_id'=$2 AND NOT EXISTS(SELECT FROM audit_events a WHERE a.action=$3 AND a.entity_id=d.entity_id AND a.detail->>'channel_id'=$2) LIMIT 1`,[dispatchAction,s.channelId,ackAction])).rowCount!==0;
 }
 async function claim(s:LocalWooStockSelection):Promise<Held|undefined>{
  const tokens:string[]=[];
  try{return await tenantTx(s.tenantId,async c=>{
   if(closed)return;
   // Paused or changed to ineligible since the eligibility read (or mid-drain): idle, like eligibility.
   if(!eligibleConfig(await config(c,s,true)))return;
   // Serialize construction-selected schedulers with the existing config CAS.
   const {cfg,ch}=await authorize(c,s,undefined,undefined,true);
   ensure(!(await blocked(c,s)),409,'Niepotwierdzone wykonanie wymaga jawnego uzgodnienia');
   // Only a dispatched failure (attempts>0) can be uncertain; owned work failed before any dispatch (an older
   // configuration cancelled it as failed) had no effect and never holds the lane.
   const entries=(await c.query(`SELECT a.entity_id,a.detail FROM audit_events a JOIN jobs j ON j.id=a.entity_id AND j.tenant_id=a.tenant_id WHERE a.action=$1 AND a.detail->>'channel_id'=$2 AND (j.state IN('pending','running') OR (j.state='failed' AND j.attempts>0 AND NOT EXISTS(SELECT FROM audit_events r WHERE r.tenant_id=j.tenant_id AND r.action=$3 AND r.entity_id=j.id AND r.detail->>'channel_id'=$2))) ORDER BY CASE WHEN j.kind='offer.write' THEN 0 ELSE 1 END,a.created_at,a.id LIMIT 101`,[ownedAction,s.channelId,reconcileAction])).rows;
   ensure(entries.length<=100,409,'Kolejka wybranego sklepu wymaga przeglądu');
   let candidate:any,own:Ownership|undefined;
   for(const entry of entries){
    const o=ownership(entry.detail,s),j=await jobSnapshot(c,entry.entity_id,true);payloadIdentity(j,s,o);
    ensure(j.state!=='running'&&j.state!=='failed',409,'Rozpoczęty lub niepewny zapis blokuje następny cykl');
    if(o.version!==cfg.version)continue; // A paused/replaced configuration owns its own cancellation.
    if(!candidate){candidate=j;own=o;}
   }
   if(!candidate){
    if(!cfg.stock_due||entries.length)return;
    // Never adopt a manual/global job, even if it has this channel/config version.
    if((await c.query("SELECT id FROM jobs WHERE kind='offer.sync' AND state IN('pending','running') AND payload->>'channel_id'=$1 LIMIT 1",[s.channelId])).rowCount)return;
    const created=await enqueueOfferSync(c,actor(s),s.channelId);ensure(created.reused===false,409,'Brak nowego własnego przeglądu');
    const bound=await register(c,s,created.id,{schema,scope:s,channel_id:s.channelId,kind:'offer.sync',version:cfg.version,source_hash:sourceHash(ch),parent_id:null,plan_id:null});candidate=bound.j;own=bound.own;
   }
   ensure(own&&own.source_hash===sourceHash(ch),409,'Zmienione połączenie od utworzenia pracy');
   ensure(candidate.state==='pending'&&Number(candidate.attempts)===0&&candidate.lease_token===null&&candidate.locked_at===null&&!candidate.error,409,'Praca nie jest świeżym punktem kontynuacji');
   const last=(await c.query('SELECT detail FROM audit_events WHERE action=$1 AND detail->>\'job_id\'=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[ackAction,candidate.id])).rows[0];
   ensure(hash(candidate.stock_snapshot)===(last?.detail?.checkpoint_hash??own.checkpoint_hash),409,'Zmieniony punkt kontynuacji');
   const dueAt=new Date(candidate.run_at).getTime();ensure(Number.isFinite(dueAt),409,'Nieprawidłowy termin pracy');
   if(dueAt>Date.now())return;
   if(candidate.kind==='offer.write')await checkPlan(c,s,candidate,own);
   const token=randomUUID();tokens.push(token);executing.add(token);const job=(await c.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=clock_timestamp() WHERE id=$1 AND state='pending' AND attempts=0 AND lease_token IS NULL RETURNING *",[candidate.id,token])).rows[0];
   ensure(job,409,'Inny wykonawca przejął pracę');
   await audit(c,actor(s),dispatchAction,token,{channel_id:s.channelId,job_id:job.id,ownership_hash:hash(own),before_hash:hash(candidate.stock_snapshot),automatic_retry:false});
   return{s,job,own,token};
  });}catch(error){for(const token of tokens)executing.delete(token);throw error;}
 }
 async function checkPlan(c:PoolClient,s:LocalWooStockSelection,j:any,o:Ownership,phase='ready'){
  const p=(await c.query('SELECT * FROM offer_plans WHERE id=$1',[o.plan_id])).rows[0];
  ensure(p?.tenant_id===s.tenantId&&p.actor_id===s.userId&&p.channel_id===s.channelId&&p.job_id===j.id&&p.sync_version===o.version&&p.operation==='sync'&&p.input?.stock===true&&p.input.price===false&&p.input.listing_id&&p.remote_id&&p.state==='queued'&&p.phase===phase,409,'Plan nie jest nowym własnym zapisem stanu');
  z.strictObject({manage_stock:z.literal(true),stock_quantity:z.number().int().min(0),backorders:z.literal('no')}).parse(p.payload);return p;
 }
 async function fence(c:PoolClient,h:Held,afterWrite=false){
  // Catalogue writers acquire this advisory lock before channel/listing rows.
  // Take the same shared lock BEFORE our source-row locks, never under wire.
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['catalog:'+h.s.tenantId]);
  await authorize(c,h.s,afterWrite?undefined:h.own.version,h.own.source_hash,false,!afterWrite);
  const j=await jobSnapshot(c,h.job.id,true);payloadIdentity(j,h.s,h.own);
  ensure(j.state==='running'&&j.lease_token===h.token&&isDeepStrictEqual(j.payload,h.job.payload),409,'Zmieniona dzierżawa własnego wykonania');
 }
 async function execute(h:Held){
  const trace:Trace={phase:'prepare',requests:0,writes:0,failureHandlerFailed:false};
  try{await executeHeld(h,trace);}
  catch(error){await recordFailure(h,error,trace);throw error;}
  finally{executing.delete(h.token);}
 }
 async function recordFailure(h:Held,error:unknown,trace:Trace){
  const evidence:LocalWooStockFailure={status:'RETAINED_FAILURE',phase:trace.phase,detected_at:new Date().toISOString(),dispatch_id:h.token,job_id:h.job.id,kind:h.job.kind,...failureCause(error),plan_phase:null,provider_requests:trace.requests,provider_writes:trace.writes,failure_handler_failed:trace.failureHandlerFailed,automatic_retry:false};
  try{await tenantTx(h.s.tenantId,async c=>{
   if(h.own.plan_id){const phase=(await c.query('SELECT phase FROM offer_plans WHERE id=$1',[h.own.plan_id])).rows[0]?.phase;evidence.plan_phase=typeof phase==='string'&&/^[a-z_]{1,32}$/.test(phase)?phase:null;}
   await audit(c,actor(h.s),failureAction,h.token,{schema:'local-woo-stock-failure/v1',channel_id:h.s.channelId,evidence});
  });}catch{/* Diagnostic COMMIT may be unknown; the unacknowledged dispatch stays the durable stop. */}
  failures.set(h.s.channelId,evidence);
  const{status:_status,...fields}=evidence;emit({level:'error',step:'local_woo.stock.failure',tenant_id:h.s.tenantId,channel_id:h.s.channelId,...fields});
 }
 async function executeHeld(h:Held,trace:Trace){
  const fixture=localWooRegistryFixture(registry,actor(h.s),h.s.channelId);
  // Counted at the network boundary, after every lane check. Only a non-GET request can have an
  // effect at Woo (the lane transport admits GET and the planned PUT only); once one has left, a later
  // failure is possibly effective and keeps the stop.
  let providerRequests=0,providerWrites=0;const counted:Transport=async(url,init)=>{
   providerRequests++;trace.requests=providerRequests;const write=(init.method??'GET').toUpperCase()!=='GET';
   if(write){providerWrites++;trace.writes=providerWrites;trace.phase='provider_write';}else if(providerWrites===0)trace.phase='provider_read';
   const response=await fixture.transport(url,init);if(write)trace.phase='after_write';return response;
  };
  // A refusal by the lane itself (its fences, consent/source/lease checks, its transport, or the
  // provider call behind it) is never a plan conflict: it keeps the stop for the operator.
  let laneRefused=false;const lane=<T>(work:Promise<T>)=>work.catch((e:unknown)=>{laneRefused=true;throw e;});
  const plan=h.job.kind==='offer.write'?await tenantReadTx(h.s.tenantId,c=>checkPlan(c,h.s,h.job,h.own)):undefined;
  const context:LocalWooStockContext={
   localWooStockFence:(c,j)=>lane((async()=>{ensure(j.id===h.job.id&&j.lease_token===h.token,409,'Obce wywołanie procesora');await fence(c,h,providerWrites>0);})()),
   localWooStockQueued:async(c,parent,q)=>{
    ensure(parent.id===h.job.id&&h.job.kind==='offer.sync'&&q.state==='queued',409,'Obce dziecko przeglądu');await fence(c,h);
    await register(c,h.s,q.job_id,{schema,scope:h.s,channel_id:h.s.channelId,kind:'offer.write',version:h.own.version,source_hash:h.own.source_hash,parent_id:h.job.id,plan_id:q.id});
   },
   transport:(url,init)=>lane(laneTransport(url,init)),
  };
  const laneTransport=localWooStockTransport(counted,h.s.origin,async(method,u)=>{
    await tenantTx(h.s.tenantId,async c=>{
     // The PUT's own fence always runs with providerWrites=0: a paused/changed schedule never sends a write.
     await fence(c,h,providerWrites>0);
     const parts=u.pathname.split('/'),parent=parts.includes('variations')?parts[5]:null,id=parts.at(-1);
     const parentRead=method!=='PUT'&&plan?.input.parent_external_id&&u.pathname===`/wp-json/wc/v3/products/${plan.input.parent_external_id}`;
     const boundId=parentRead?plan.remote_id:id,boundParent=parentRead?plan.input.parent_external_id:parent??'';
     const linked=await c.query("SELECT id FROM listings WHERE channel_id=$1 AND ((external_id=$2 AND coalesce(parent_external_id,'')=$3) OR ($4::boolean AND parent_external_id=$2)) LIMIT 1",[h.s.channelId,boundId,boundParent,h.job.kind==='offer.sync'&&method!=='PUT'&&parent===null]);
     ensure(linked.rowCount===1,409,'Brak własnego aktualnego powiązania oferty');
     if(method==='PUT'){
      const current=await checkPlan(c,h.s,h.job,h.own,'write_started');
      ensure(plan&&isDeepStrictEqual(current.payload,plan.payload)&&isDeepStrictEqual(current.input,plan.input)&&isDeepStrictEqual(current.local_snapshot,plan.local_snapshot)&&current.remote_id===plan.remote_id,409,'Zmieniony stan od przygotowania zapisu');
      const latest=await desiredOffer(c,actor(h.s),current.input);
      ensure(offerSnapshotHash(latest.snapshot)===offerSnapshotHash(plan.local_snapshot),409,'Stan lokalny zmienił się przed wysłaniem');
     }
    });
   },plan?{remote_id:plan.remote_id,parent_external_id:plan.input.parent_external_id,payload:plan.payload}:undefined);
  try{
   trace.phase='processor';
   if(h.job.kind==='offer.sync')await processOfferSync(h.job,context);else await processOfferJob(h.job,context);
  }catch(error){
   if(h.job.kind==='offer.write'&&providerWrites===0&&!laneRefused&&error instanceof Problem&&error.status===409&&await replanWithoutEffect(h,error,providerRequests))return;
   if(providerWrites===0&&await cancelWithoutEffect(h,providerRequests))return;
   // max_attempts=1 makes the existing failure handlers terminal, never a retry.
   try{if(h.job.kind==='offer.sync')await failOfferSync(h.job,error);else await failOffer(h.job,error);}
   catch{trace.failureHandlerFailed=true;/* Keep the original cause; the dispatch stays unacknowledged. */}
   throw error; // no ACK: durable dispatch blocks this channel after restart too.
  }
  trace.phase='completion';
  try{await complete(h,plan);}
  catch(error){if(providerWrites===0&&await cancelWithoutEffect(h,providerRequests))return;throw error;}
 }
 async function complete(h:Held,plan:any){
  await tenantTx(h.s.tenantId,async c=>{
   const j=await jobSnapshot(c,h.job.id,true);payloadIdentity(j,h.s,h.own);
   ensure(['done','pending'].includes(j.state)&&!j.error&&j.lease_token===null&&j.locked_at===null,409,'Procesor nie potwierdził zakończenia');
   let providerResult:unknown=null;
   if(j.kind==='offer.write'){
    const p=(await c.query('SELECT * FROM offer_plans WHERE id=$1',[h.own.plan_id])).rows[0];
    ensure(j.state==='done'&&p?.state==='done'&&p.phase==='done'&&p.result?.scope==='external_api_verified'&&p.result.desired_applied===true&&p.result.local_changed===false&&isDeepStrictEqual(p.result.requested_payload,plan.payload)&&isDeepStrictEqual(p.result.verified_payload,plan.payload),409,'Brak dokładnego potwierdzenia zapisu dostawcy');
    providerResult=p.result;
   }
   await audit(c,actor(h.s),ackAction,h.token,{channel_id:h.s.channelId,job_id:j.id,checkpoint_hash:hash(j.stock_snapshot),state:j.state,plan_id:h.own.plan_id,provider_result:providerResult,automatic_retry:false});
  });
 }
 const cancelled='Harmonogram stanów wstrzymano lub zmieniono; zadanie anulowane bez skutku u dostawcy';
 /** No-effect boundary for a schedule pause/change (any new configuration version since this dispatch):
  * this execution sent no non-GET request to Woo (counted at the network boundary; the PUT's own fence
  * refuses a changed schedule before the wire) and the job is still ours, or the configuration already
  * closed our offer.sync continuation as done with its cause. The job ends done with the cause, a write
  * plan still queued (never past 'write_started') becomes 'conflict' and the dispatch gets its ACK
  * (NO_EFFECT_CANCELLED): the channel is not parked and re-enabling plans afresh. Anything else (a write
  * left, changed lease/plan/owner, same configuration version) keeps the existing stop. */
 async function cancelWithoutEffect(h:Held,providerRequests:number){
  try{return await tenantTx(h.s.tenantId,async c=>{
   await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['catalog:'+h.s.tenantId]);
   const cfg=await config(c,h.s,true);
   ensure(cfg?.tenant_id===h.s.tenantId&&cfg.channel_id===h.s.channelId&&cfg.actor_id===h.s.userId&&Number.isSafeInteger(cfg.version)&&cfg.version!==h.own.version,409,'Harmonogram nie zmienił się od wysłania');
   const j=await jobSnapshot(c,h.job.id,true);payloadIdentity(j,h.s,h.own);
   let planPhase:string|null=null;
   if(j.state==='running'&&j.lease_token===h.token&&isDeepStrictEqual(j.payload,h.job.payload)){
    if(h.own.kind==='offer.write'){
     const p=(await c.query('SELECT * FROM offer_plans WHERE id=$1 FOR UPDATE',[h.own.plan_id])).rows[0];
     ensure(p?.tenant_id===h.s.tenantId&&p.channel_id===h.s.channelId&&p.job_id===j.id&&p.state==='queued'&&['ready','write_started'].includes(p.phase),409,'Plan opuścił fazę bez skutku');
     planPhase=p.phase;
    }
    const done=await c.query("UPDATE jobs SET state='done',error=$3,lease_token=NULL,locked_at=NULL WHERE id=$1 AND state='running' AND lease_token=$2 RETURNING *",[j.id,h.token,cancelled]);ensure(done.rowCount===1,409,'Zmieniona dzierżawa własnego wykonania');
    if(planPhase){const p=await c.query("UPDATE offer_plans SET state='conflict',error=$2 WHERE id=$1 AND state='queued' AND phase=$4 AND job_id=$3 RETURNING id",[h.own.plan_id,cancelled,j.id,planPhase]);ensure(p.rowCount===1,409,'Plan opuścił fazę bez skutku');}
   }else ensure(h.own.kind==='offer.sync'&&j.state==='done'&&typeof j.error==='string'&&j.lease_token===null&&j.locked_at===null,409,'Zmieniona dzierżawa własnego wykonania');
   const after=await jobSnapshot(c,j.id);
   await audit(c,actor(h.s),ackAction,h.token,{channel_id:h.s.channelId,job_id:j.id,checkpoint_hash:hash(after.stock_snapshot),state:'done',plan_id:h.own.plan_id,plan_phase:planPhase,provider_result:null,outcome:'NO_EFFECT_CANCELLED',cause:cancelled,config_version:cfg.version,provider_requests:providerRequests,provider_writes:0,automatic_retry:false});
   emit({level:'info',step:'local_woo.stock.cancelled',tenant_id:h.s.tenantId,channel_id:h.s.channelId,dispatch_id:h.token,job_id:j.id,kind:h.own.kind,plan_phase:planPhase,provider_requests:providerRequests,provider_writes:0,automatic_retry:false});
   return true;
  });}catch{return false;}
 }
 /** No-effect boundary for offer.write: a 409 plan conflict raised while this execution has sent
  * no write request to Woo (read-only GETs only, e.g. the remote snapshot check), with the plan still
  * queued in phase 'ready' (never 'write_started', which precedes every PUT) and the job still running
  * under our lease. No effect reached the provider, so the job ends done, the plan becomes
  * 'conflict' with its cause and the dispatch gets its ACK; the next offer.sync plans again. Any other
  * failure, or this check not holding, keeps failOffer + the durable unacknowledged dispatch stop. */
 async function replanWithoutEffect(h:Held,error:Problem,providerRequests:number){
  try{return await tenantTx(h.s.tenantId,async c=>{
   await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['catalog:'+h.s.tenantId]);
   const j=await jobSnapshot(c,h.job.id,true);payloadIdentity(j,h.s,h.own);
   ensure(j.state==='running'&&j.lease_token===h.token&&isDeepStrictEqual(j.payload,h.job.payload),409,'Zmieniona dzierżawa własnego wykonania');
   const p=(await c.query('SELECT * FROM offer_plans WHERE id=$1 FOR UPDATE',[h.own.plan_id])).rows[0];
   ensure(p?.tenant_id===h.s.tenantId&&p.channel_id===h.s.channelId&&p.job_id===j.id&&p.state==='queued'&&p.phase==='ready',409,'Plan opuścił fazę bez skutku');
   const done=await c.query("UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL WHERE id=$1 AND state='running' AND lease_token=$2 RETURNING *",[j.id,h.token]);ensure(done.rowCount===1,409,'Zmieniona dzierżawa własnego wykonania');
   const plan=await c.query("UPDATE offer_plans SET state='conflict',error=$2 WHERE id=$1 AND state='queued' AND phase='ready' AND job_id=$3 RETURNING id",[p.id,error.message,j.id]);ensure(plan.rowCount===1,409,'Plan opuścił fazę bez skutku');
   const after=await jobSnapshot(c,j.id);
   await audit(c,actor(h.s),ackAction,h.token,{channel_id:h.s.channelId,job_id:j.id,checkpoint_hash:hash(after.stock_snapshot),state:'done',plan_id:h.own.plan_id,provider_result:null,outcome:'NO_EFFECT_REPLAN',cause:error.message.slice(0,500),provider_requests:providerRequests,provider_writes:0,automatic_retry:false});
   return true;
  });}catch{return false;}
 }
 // Selected stores are independent (own tenant, channel, origin and fixture), so each runs its own
 // strictly serial chain concurrently with the others; a slow or stopped store never delays another.
 async function runScope(s:LocalWooStockSelection){
  if(closed||stopped.has(s.channelId))return;
  let phase:FailurePhase='eligibility';
  try{
   const eligible=await tenantReadTx(s.tenantId,async c=>eligibleConfig((await c.query('SELECT enabled,stock,price,external_authorized FROM offer_sync_configs WHERE channel_id=$1',[s.channelId])).rows[0]));
   if(!eligible)return;
   const enrolled=await readConfiguredLocalWooHttpChannel(localWooRegistryFixture(registry,actor(s),s.channelId),actor(s));ensure(enrolled.enrolled===true&&enrolled.origin===s.origin&&enrolled.fixture_id===s.fixtureId,409,'Niepotwierdzony wybrany sklep');
   // Every claim repeats the full consent/source/dispatch checks; every write re-reads Woo before its PUT.
   for(let n=0;n<DRAIN_PER_CYCLE&&!closed;n++){phase='claim';const held=await claim(s);if(!held)return;phase='processor';await execute(held);}
  }catch(error){
   stopped.add(s.channelId);
   if(phase==='processor')return; // execute() already retained and logged the sanitized cause.
   const evidence:LocalWooStockFailure={status:'RETAINED_FAILURE',phase,detected_at:new Date().toISOString(),dispatch_id:null,job_id:null,kind:null,...failureCause(error),plan_phase:null,provider_requests:0,provider_writes:0,failure_handler_failed:false,automatic_retry:false};
   failures.set(s.channelId,evidence);const{status:_status,...fields}=evidence;
   emit({level:'error',step:'local_woo.stock.stopped',tenant_id:s.tenantId,channel_id:s.channelId,...fields});
  }
 }
 async function cycle(){
  if(closed)return;if(active)return active;
  active=Promise.all(scopes.map(runScope)).then(()=>undefined).finally(()=>{active=undefined;});return active;
 }

 // ---- Operator path for an unacknowledged dispatch (session routes in local-woo-stock-lane-routes.ts) ----
 function own(a:Actor,id:string){
  ensure(a.role==='admin'&&!a.apiKeyId,403,'Wymagana sesja administratora');
  const s=scopes.find(s=>s.tenantId===a.tenantId&&s.userId===a.userId&&s.channelId===id);ensure(s,404,'Brak własnego wybranego kanału');return s;
 }
 async function configured(s:LocalWooStockSelection){const v=await readConfiguredLocalWooHttpChannel(localWooRegistryFixture(registry,actor(s),s.channelId),actor(s));ensure(v.enrolled===true&&v.origin===s.origin&&v.fixture_id===s.fixtureId,409,'Niepotwierdzony wybrany sklep');}
 // Same lock order as claim/fence: (advisory) -> config -> channel -> admin -> job -> plan.
 async function reconcileContext(c:PoolClient,s:LocalWooStockSelection,lock:boolean){
  const cfg=lock?await config(c,s,true):(await c.query('SELECT * FROM offer_sync_configs WHERE channel_id=$1',[s.channelId])).rows[0];
  ensure(cfg?.tenant_id===s.tenantId&&cfg.channel_id===s.channelId&&cfg.actor_id===s.userId,409,'Zmieniony właściciel harmonogramu stanów');
  const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2'+(lock?' FOR SHARE':''),[s.tenantId,s.channelId])).rows[0];
  ensure(ch?.provider==='woocommerce'&&ch.mode==='sandbox'&&ch.sync_enabled===false&&isDeepStrictEqual(ch.settings,settings(s)),409,'Zmienione własne połączenie harmonogramu');
  if(lock)ensure((await c.query('SELECT public.offer_sync_is_admin($1) AS ok',[s.userId])).rows[0]?.ok===true,403,'Wymagany aktualny własny administrator');
  else ensure((await c.query('SELECT public.customer_message_role($1) AS role',[s.userId])).rows[0]?.role==='admin',403,'Wymagany aktualny własny administrator');
  const d=(await c.query(`SELECT d.id,d.entity_id,d.detail FROM audit_events d WHERE d.action=$1 AND d.detail->>'channel_id'=$2 AND NOT EXISTS(SELECT FROM audit_events a WHERE a.action=$3 AND a.entity_id=d.entity_id AND a.detail->>'channel_id'=$2) ORDER BY d.created_at,d.id LIMIT 1`,[dispatchAction,s.channelId,ackAction])).rows[0];
  if(!d)return{ch,pending:null};
  const token=String(d.entity_id),jobId=d.detail?.job_id;
  ensure(z.uuid().safeParse(token).success&&z.uuid().safeParse(jobId).success&&d.detail.automatic_retry===false,409,'Nieprawidłowy zapis wykonania');
  const owned=(await c.query('SELECT o.detail FROM audit_events o WHERE o.action=$1 AND o.entity_id=$2 LIMIT 2',[ownedAction,jobId])).rows;
  ensure(owned.length===1,409,'Niejednoznaczne pochodzenie zadania');
  const o=ownership(owned[0].detail,s);ensure(d.detail.ownership_hash===hash(o),409,'Zmienione pochodzenie zadania');
  const j=await jobSnapshot(c,jobId,lock);payloadIdentity(j,s,o);
  ensure(j.state==='running'&&j.lease_token===token||['failed','done'].includes(j.state)&&j.lease_token===null&&j.locked_at===null,409,'Niespodziewany stan zadania; wymaga ręcznego przeglądu');
  ensure(o.source_hash===sourceHash(ch),409,'Połączenie zmieniło się od wykonania; przywróć je przed uzgodnieniem');
  let plan:any=null;
  if(o.kind==='offer.write'){
   plan=(await c.query('SELECT p.*,to_jsonb(p) AS reconcile_snapshot FROM offer_plans p WHERE id=$1'+(lock?' FOR UPDATE':''),[o.plan_id])).rows[0];
   ensure(plan?.tenant_id===s.tenantId&&plan.actor_id===s.userId&&plan.channel_id===s.channelId&&plan.job_id===j.id&&plan.sync_version===o.version&&plan.operation==='sync'&&plan.input?.stock===true&&plan.input.price===false&&typeof plan.remote_id==='string'&&/^[1-9]\d*$/.test(plan.remote_id)&&(plan.input.parent_external_id===undefined||plan.input.parent_external_id===null||/^[1-9]\d*$/.test(String(plan.input.parent_external_id)))&&stockPayload.safeParse(plan.payload).success,409,'Plan nie jest własnym zapisem stanu');
   ensure(['queued','failed','done'].includes(plan.state)&&['ready','write_started','verify','done'].includes(plan.phase),409,'Plan został już uzgodniony lub zmieniony');
  }
  const expected=hash(['local-woo-stock-reconcile-snapshot/v1',s,d.id,token,d.detail,o,j.stock_snapshot,plan?.reconcile_snapshot??null,sourceHash(ch)]);
  return{ch,pending:{token,own:o,job:j,plan,expected}};
 }
 type Pending=NonNullable<Awaited<ReturnType<typeof reconcileContext>>['pending']>;
 type Observation={observed:{manage_stock:boolean;stock_quantity:number|null;backorders:string|null};observation_sha256:string;matches:boolean};
 /** One provider GET of the planned offer through the lane's exact-path transport; never a write. */
 async function observe(s:LocalWooStockSelection,ch:any,plan:any):Promise<Observation>{
  const fixture=localWooRegistryFixture(registry,actor(s),s.channelId);
  const readOnly:Transport=(url,init)=>{ensure((init.method??'GET').toUpperCase()==='GET'&&!init.body,403,'Uzgodnienie wyłącznie odczytuje stan oferty');return fixture.transport(url,init);};
  const parent=plan.input.parent_external_id?String(plan.input.parent_external_id):undefined;
  const transport=localWooStockTransport(readOnly,s.origin,async method=>{ensure(method==='GET'||method==='AFTER',403,'Uzgodnienie wyłącznie odczytuje stan oferty');},{remote_id:plan.remote_id,parent_external_id:parent??null,payload:plan.payload});
  const r=await new WooCommerce(ch.settings,decrypt(ch.credentials),transport).product(plan.remote_id,parent);
  ensure(String(r?.id)===plan.remote_id,502,'Dostawca zwrócił inną ofertę');
  const observed={manage_stock:r.manage_stock===true,stock_quantity:Number.isSafeInteger(r.stock_quantity)?Number(r.stock_quantity):null,backorders:typeof r.backorders==='string'&&/^[a-z_]{1,16}$/.test(r.backorders)?r.backorders:null};
  return{observed,observation_sha256:hash(['local-woo-stock-observation/v1',plan.id,plan.remote_id,parent??null,observed]),matches:isDeepStrictEqual(observed,plan.payload)};
 }
 function allowed(p:Pending,observation:Observation|null):Outcome[]{
  if(p.own.kind==='offer.sync')return['FAILED'];
  if(p.plan.state==='done')return observation?['EFFECT_CONFIRMED']:[];
  if(!observation)return['FAILED'];
  return observation.matches?['EFFECT_CONFIRMED','FAILED']:['SUPERSEDED','FAILED'];
 }
 function summary(s:LocalWooStockSelection,p:Pending){
  return{channel_id:s.channelId,dispatch_id:p.token,job_id:p.job.id,kind:p.own.kind,plan_id:p.own.plan_id,job_state:p.job.state,plan_state:p.plan?.state??null,plan_phase:p.plan?.phase??null,remote_id:p.plan?.remote_id??null,parent_external_id:p.plan?.input.parent_external_id??null};
 }
 async function diagnosticFor(c:PoolClient,s:LocalWooStockSelection,token:string){
  const entry=(await c.query('SELECT f.detail FROM audit_events f WHERE f.action=$1 AND f.entity_id=$2 ORDER BY f.created_at DESC,f.id DESC LIMIT 1',[failureAction,token])).rows[0]?.detail;
  if(entry){
   const parsed=failureEvidence.safeParse(entry.evidence);
   ensure(entry.schema==='local-woo-stock-failure/v1'&&entry.channel_id===s.channelId&&parsed.success&&parsed.data.dispatch_id===token,409,'Niepotwierdzona diagnostyka zapisu');
   return{...parsed.data,source:'audit' as const};
  }
  const memory=failures.get(s.channelId);
  return memory?.dispatch_id===token?{...memory,source:'memory' as const}:{status:'NO_RETAINED_CAUSE' as const,dispatch_id:token,automatic_retry:false as const};
 }
 async function readStockLane(a:Actor,id:string){
  const s=own(a,id);
  return tenantReadTx(s.tenantId,async c=>{
   const ctx=await reconcileContext(c,s,false),p=ctx.pending,memory=failures.get(id);
   return{channel_id:id,blocked:stopped.has(id),reconciliation_required:!!p,in_progress:!!p&&executing.has(p.token),dispatch:p?summary(s,p):null,
    diagnostic:p?await diagnosticFor(c,s,p.token):memory&&stopped.has(id)?{...memory,source:'memory' as const}:null,automatic_retry:false as const};
  });
 }
 async function previewReconciliation(a:Actor,id:string){
  const s=own(a,id);await configured(s);
  const ctx=await tenantReadTx(s.tenantId,async c=>{const v=await reconcileContext(c,s,false);return{...v,diagnostic:v.pending?await diagnosticFor(c,s,v.pending.token):null};});
  const p=ctx.pending;
  if(!p)return{status:'NO_UNACKNOWLEDGED_DISPATCH' as const,channel_id:id,blocked:stopped.has(id),automatic_retry:false as const};
  if(executing.has(p.token))return{status:'DISPATCH_IN_PROGRESS' as const,...summary(s,p),automatic_retry:false as const};
  let observation:Observation|null=null,observation_error=null;
  if(p.plan){try{observation=await observe(s,ctx.ch,p.plan);}catch(error){const cause=failureCause(error);observation_error={error_category:cause.error_category,http_status:cause.http_status,provider_http_status:cause.provider_http_status};}}
  return{status:'LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW' as const,...summary(s,p),planned:p.plan?.payload??null,observed:observation?.observed??null,observation_sha256:observation?.observation_sha256??null,observation_error,
   matches_plan:observation?.matches??null,allowed_outcomes:allowed(p,observation),expected_snapshot_sha256:p.expected,diagnostic:ctx.diagnostic,original_outcome:'UNCONFIRMED' as const,operation:'RECONCILE_WITHOUT_RETRY' as const,automatic_retry:false as const};
 }
 async function priorReconcile(c:PoolClient,s:LocalWooStockSelection,b:ReconcileCommand,requestHash:string){
  const d=(await c.query("SELECT r.detail FROM audit_events r WHERE r.action=$1 AND r.detail->>'client_key'=$2 ORDER BY r.created_at,r.id LIMIT 1",[reconcileAction,b.client_key])).rows[0]?.detail;
  if(!d)return null;
  ensure(d.channel_id===s.channelId&&d.actor_id===s.userId&&d.request_hash===requestHash,409,'Klucz uzgodnienia użyty z inną tożsamością lub treścią');
  ensure(d.response?.status==='LOCAL_WOO_STOCK_DISPATCH_RECONCILED'&&d.response.client_key===b.client_key&&d.response.dispatch_id===b.dispatch_id&&d.response.automatic_retry===false,409,'Niepotwierdzony zapisany wynik uzgodnienia');
  return d.response;
 }
 function settle(s:LocalWooStockSelection){stopped.delete(s.channelId);failures.delete(s.channelId);}
 const stale='Zmieniony stan zapisu; odczytaj ponownie podgląd bez ponawiania operacji';
 async function reconcile(a:Actor,id:string,body:unknown){
  ensure(!closed,503,'Procesor zamknięty');
  const s=own(a,id),b=localWooStockReconcileCommand.parse(body),requestHash=hash(['local-woo-stock-reconcile-command/v1',s,b]);
  const prior=await tenantReadTx(s.tenantId,c=>priorReconcile(c,s,b,requestHash));
  if(prior){settle(s);return prior;}
  ensure(!executing.has(b.dispatch_id),409,'Zapis jest w toku; poczekaj na jego wynik');
  await configured(s);
  const first=await tenantReadTx(s.tenantId,c=>reconcileContext(c,s,false)),p0=first.pending;
  ensure(p0&&p0.token===b.dispatch_id&&p0.expected===b.expected_snapshot_sha256,409,stale);
  if(p0.own.kind==='offer.sync')ensure(b.outcome==='FAILED',409,'Przegląd bez zapisu można wyłącznie zakończyć');
  if(p0.plan?.state==='done')ensure(b.outcome==='EFFECT_CONFIRMED',409,'Zakończony plan można wyłącznie potwierdzić');
  let observation:Observation|null=null;
  if(b.outcome==='FAILED')ensure(b.observation_sha256===null,422,'Zakończenie bez potwierdzenia nie przyjmuje obserwacji');
  else{
   ensure(p0.plan&&b.observation_sha256,422,'Potwierdzenie wymaga obserwacji stanu WooCommerce');
   // Fresh read (no DB locks held across the wire): the operator decided on the previewed observation.
   // A provider refusal here is not the operator's session failing; report it as an upstream read error.
   try{observation=await observe(s,first.ch,p0.plan);}catch{throw new Problem(502,'Nie udało się odczytać stanu WooCommerce; zapis nie został ponowiony');}
   ensure(observation.observation_sha256===b.observation_sha256,409,'Stan WooCommerce zmienił się od podglądu; odczytaj ponownie bez zapisu');
   if(b.outcome==='EFFECT_CONFIRMED')ensure(observation.matches||p0.plan.state==='done',409,'Obserwowany stan WooCommerce nie odpowiada planowi');
   else ensure(!observation.matches,409,'Obserwowany stan odpowiada planowi; potwierdź skutek zamiast zastępować');
  }
  const ack=await tenantTx(s.tenantId,async c=>{
   await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['catalog:'+s.tenantId]);
   const ctx=await reconcileContext(c,s,true),again=await priorReconcile(c,s,b,requestHash);if(again)return again;
   ensure(!executing.has(b.dispatch_id),409,'Zapis jest w toku; poczekaj na jego wynik');
   const p=ctx.pending;ensure(p&&p.token===b.dispatch_id&&p.expected===b.expected_snapshot_sha256,409,stale);
   const j=p.job,plan=p.plan,jobState=b.outcome==='FAILED'?'failed':'done';
   const note=b.outcome==='EFFECT_CONFIRMED'?'Uzgodnione przez operatora: skutek zapisu potwierdzony odczytem':b.outcome==='SUPERSEDED'?'Uzgodnione przez operatora: zapis zastąpiony aktualnym stanem WooCommerce':'Zapis zakończony przez operatora; pierwotny wynik niepotwierdzony';
   if(j.state!=='done'&&j.state!==jobState){
    const changed=await c.query('UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL WHERE id=$1 AND state=$4 AND lease_token IS NOT DISTINCT FROM $5::uuid RETURNING id',[j.id,jobState,note,j.state,j.lease_token]);
    ensure(changed.rowCount===1,409,stale);
   }
   let planState=plan?.state??null;
   if(plan&&plan.state!=='done'){
    const next=b.outcome==='EFFECT_CONFIRMED'?{state:'done',phase:'done',error:null}:b.outcome==='SUPERSEDED'?{state:'conflict',phase:'reconciled',error:note}:{state:'failed',phase:'reconciled',error:note};
    const result={scope:'operator_reconciled',desired_applied:b.outcome==='EFFECT_CONFIRMED',local_changed:false,requested_payload:plan.payload,observed_payload:observation?.observed??null,
     reconciliation:{schema:'local-woo-stock-reconcile/v1',outcome:b.outcome,client_key:b.client_key,dispatch_id:p.token,original_state:plan.state,original_phase:plan.phase,observation_sha256:b.observation_sha256,original_outcome:'UNCONFIRMED',automatic_retry:false}};
    const changed=await c.query("UPDATE offer_plans SET state=$2,phase=$3,error=$4,result=coalesce(result,'{}'::jsonb)||$5::jsonb,completed_at=CASE WHEN $2::text='done' THEN now() ELSE completed_at END WHERE id=$1 AND state=$6 AND phase=$7 AND job_id=$8 RETURNING id",[plan.id,next.state,next.phase,next.error,JSON.stringify(result),plan.state,plan.phase,j.id]);
    ensure(changed.rowCount===1,409,stale);planState=next.state;
   }
   const after=await jobSnapshot(c,j.id);
   const response={status:'LOCAL_WOO_STOCK_DISPATCH_RECONCILED' as const,channel_id:id,dispatch_id:p.token,job_id:j.id,plan_id:p.own.plan_id,kind:p.own.kind,client_key:b.client_key,outcome:b.outcome,expected_snapshot_sha256:b.expected_snapshot_sha256,observation_sha256:b.observation_sha256,job_state:after.state,plan_state:planState,original_outcome:'UNCONFIRMED' as const,automatic_retry:false as const};
   await audit(c,a,reconcileAction,j.id,{schema:'local-woo-stock-reconcile/v1',channel_id:id,actor_id:s.userId,client_key:b.client_key,request_hash:requestHash,dispatch_id:p.token,job_id:j.id,plan_id:p.own.plan_id,kind:p.own.kind,outcome:b.outcome,original_outcome:'UNCONFIRMED',expected_snapshot_sha256:b.expected_snapshot_sha256,observation_sha256:b.observation_sha256,observed:observation?.observed??null,planned:plan?.payload??null,job_state_before:j.state,plan_state_before:plan?.state??null,plan_phase_before:plan?.phase??null,response,automatic_retry:false});
   await audit(c,actor(s),ackAction,p.token,{channel_id:id,job_id:j.id,checkpoint_hash:hash(after.stock_snapshot),state:after.state,plan_id:p.own.plan_id,provider_result:null,outcome:'OPERATOR_RECONCILED',reconciliation:b.outcome,automatic_retry:false});
   return response;
  });
  settle(s);
  emit({level:'info',step:'local_woo.stock.reconcile',tenant_id:s.tenantId,channel_id:id,dispatch_id:ack.dispatch_id,job_id:ack.job_id,kind:ack.kind,outcome:ack.outcome,job_state:ack.job_state,plan_state:ack.plan_state,automatic_retry:false});
  return ack;
 }
 async function observeReconciliation(a:Actor,id:string,body:unknown){
  const s=own(a,id),b=localWooStockReconcileCommand.parse(body),requestHash=hash(['local-woo-stock-reconcile-command/v1',s,b]);
  const ack=await tenantReadTx(s.tenantId,async c=>{ensure((await c.query('SELECT public.customer_message_role($1) AS role',[s.userId])).rows[0]?.role==='admin',403,'Wymagany aktualny własny administrator');return priorReconcile(c,s,b,requestHash);});
  if(ack)settle(s);
  return{status:ack?'RECONCILE_RESULT_ACKNOWLEDGED' as const:'RECONCILE_RESULT_UNKNOWN' as const,channel_id:id,client_key:b.client_key,ack:ack??null,automatic_retry:false as const};
 }
 return Object.freeze({cycle,readStockLane,previewReconciliation,reconcile,observeReconciliation,inspect:()=>({selected:scopes.length,blocked:stopped.size,closed}),close:async()=>{closed=true;await active;}});
}
