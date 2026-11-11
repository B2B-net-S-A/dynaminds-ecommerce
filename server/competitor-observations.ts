import { drainPublicConstraintsInTx } from './public-constraint-drain';
/** Explicit local observations. No provider lookup and no price writer. */
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {ensure,Problem} from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';
import type {Actor} from './domain';
import {rankCompetitorOffers} from './competitor-ranking';
import {scheduledShopifyDefinition,scheduledCollectionProfileVersion,shopifyCollectionScheduleInput,shopifyCollectionDefinition,assertCollectionSourcesMatchProfile} from './competitor-shopify-schedule';
import {COMPETITOR_OBSERVATION_LIMITS,competitorBatchInput,competitorProfileInput,competitorPageInput,type CompetitorProfile,type CompetitorBatch,type CompetitorObservation} from './competitor-observations-schema';
export * from './competitor-observations-schema';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export function competitorObservationCanonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(competitorObservationCanonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+competitorObservationCanonical(v)).join(',')+'}';
 ensure(value===null||['string','boolean','number'].includes(typeof value),422,'Niepoprawny jawny rekord');return JSON.stringify(value);
}
type Request={actor:Actor;currentUser?:{id:string;tenant_id:string};headers:{authorization?:string;'x-workspace-id'?:string|string[]};cookies:Record<string,string|undefined>};
type Authority={actor:Actor;hash:string};
const authorities=new WeakMap<Actor,Authority>();
type Duty={actor:Actor;write:boolean;initial:string};
type Transaction={root:string;start:string;pid:number;duties:Map<Actor,Duty>;rankings:Map<CompetitorRankBasis,RankProof>;workers:Map<string,{tenant:string;actorId:string;initial:string;collectionLists?:Set<string>;collectionRuns?:Set<string>}>};
const transactions=new WeakMap<PoolClient,Transaction>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasCompetitorObservationTransactionDuty(c:PoolClient){return Boolean(transactions.get(c)?.duties.size || transactions.get(c)?.rankings.size || transactions.get(c)?.workers.size);}
type RankProof={c:PoolClient;tenant:string;list:{id:string;currency:string};rule:{config:{undercut_amount:number}};productId:string;canonical:string;deadline:string|null};
const rankProofs=new WeakMap<CompetitorRankBasis,RankProof>();
export function competitorObservationRequestActor(req:Request,sessionName:string):Actor {
 ensure(/^dyna_session(?:_preview_\d+)?$/.test(sessionName),500,'Brak natywnej przestrzeni sesji');
 ensure(req.currentUser?.id===req.actor.userId&&req.currentUser.tenant_id===req.actor.tenantId,401,'Brak zaufanej tożsamości');
 const key=req.actor.apiKeyId,token=key?req.headers.authorization?.replace(/^Bearer /,''):req.cookies[sessionName]??req.headers.authorization?.replace(/^Bearer /,'');
 ensure(token&&(!key||/^dyna_api_[a-f0-9]{64}$/.test(token)),401,'Brak aktualnej sesji lub klucza');
 ensure(!req.headers['x-workspace-id']||req.headers['x-workspace-id']===req.actor.tenantId,409,'Zmieniono firmę');
 const actor=Object.freeze({...req.actor});authorities.set(actor,{actor,hash:sha(token)});return actor;
}
export function beginCompetitorObservationTransaction(c:PoolClient){ensure(!transactions.has(c),500,'Powtórzony kontekst transakcji');transactions.set(c,{root:'',start:'',pid:0,duties:new Map(),rankings:new Map(),workers:new Map()});}
export function endCompetitorObservationTransaction(c:PoolClient){transactions.delete(c);}
async function context(c:PoolClient,tenant:string){
 const tx=transactions.get(c);ensure(tx,500,'Brak zarządzanej transakcji');
 const row=(await c.query("SELECT pg_current_xact_id()::text root,to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') start,pg_backend_pid() pid,current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];
 ensure(row.role==='dyna_app'&&row.tenant===tenant,403,'Nieprawidłowy kontekst firmy');
 if(!tx.root){tx.root=row.root;tx.start=row.start;tx.pid=row.pid;}else ensure(tx.root===row.root&&tx.start===row.start&&tx.pid===row.pid,409,'Zmieniono korzeń transakcji');return tx;
}
function nativeError(e:unknown):never{
 if(e instanceof Problem||e instanceof z.ZodError)throw e;
 const code=(e as {code?:string})?.code;
 if(code==='28000')throw new Problem(401,'Sesja lub klucz wygasły');
 if(code==='42501')throw new Problem(403,'Brak bieżących uprawnień');
 if(code==='40001'||code==='23505')throw new Problem(409,'Zmieniona lub powtórzona podstawa obserwacji');
 if(code==='55000'||code==='42P01'||code==='42883')throw new Problem(503,'Niekompletny moduł obserwacji');
 if(code==='23514')throw new Problem(409,'Natywna podstawa obserwacji została odrzucona');throw e;
}
async function available(c:PoolClient){
 const p=(await c.query("SELECT to_regprocedure('public.competitor_observation_available()') present")).rows[0];
 if(!p.present){const remnants=(await c.query("SELECT EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'competitor_observation%') OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'competitor_observation%') bad")).rows[0].bad;ensure(!remnants,503,'Niekompletna instalacja obserwacji');return false;}
 try{return (await c.query('SELECT competitor_observation_available() available')).rows[0].available===true;}catch(e){return nativeError(e);}
}
async function identity(c:PoolClient,a:Actor,write:boolean){const proof=authorities.get(a);ensure(proof,401,'Brak zaufanego żądania');try{return (await c.query('SELECT competitor_observation_identity($1,$2,$3,$4,$5,$6,false) identity',[a.tenantId,a.userId,a.apiKeyId??null,proof.hash,a.role,write])).rows[0].identity;}catch(e){return nativeError(e);}}
export async function enlistCompetitorObservationAuthorityInTx(c:PoolClient,a:Actor,mode:'read'|'write'){
 const tx=await context(c,a.tenantId);ensure(await available(c),503,'Moduł obserwacji nie jest dostępny');
 const old=tx.duties.get(a),write=mode==='write'||old?.write===true,current=sha(competitorObservationCanonical(await identity(c,a,write)));
 if(old)ensure(old.initial===current,409,'Uprawnienia zmieniły się podczas operacji');else tx.duties.set(a,{actor:a,write,initial:current});
 if(old)old.write=write;
}
/** Root calls AFTER all sibling finalizers and ALL IMMEDIATE, directly before COMMIT. */
export async function finalizeCompetitorObservationAuthoritiesInTx(c:PoolClient){
 const tx=transactions.get(c);if(!tx||(!tx.duties.size&&!tx.rankings.size&&!tx.workers.size))return;
 await drainPublicConstraintsInTx(c);
 // Acquire ALL identity locks before any final clock, including sibling actors.
 for(const d of tx.duties.values()){const a=d.actor,p=authorities.get(a)!;try{await c.query('SELECT competitor_observation_identity($1,$2,$3,$4,$5,$6,true)',[a.tenantId,a.userId,a.apiKeyId??null,p.hash,a.role,d.write]);}catch(e){nativeError(e);}}
 for(const w of tx.workers.values()){
  const lists=[...new Set([...tx.rankings.values()].filter(p=>p.tenant===w.tenant).map(p=>p.list.id).concat([...(w.collectionLists??[])]))].sort();ensure(lists.length,409,'Brak natywnej podstawy przebiegu rankingu');
  try{const identity=(await c.query('SELECT competitor_observation_worker_identity($1,$2,$3,true) identity',[w.tenant,w.actorId,lists])).rows[0].identity;ensure(sha(competitorObservationCanonical(identity))===w.initial,409,'Uprawnienia autora harmonogramu zmieniły się');}catch(e){nativeError(e);}
 }
 for(const duty of tx.duties.values()){
  await context(c,duty.actor.tenantId);
  ensure(sha(competitorObservationCanonical(await identity(c,duty.actor,duty.write)))===duty.initial,409,'Uprawnienia zmieniły się podczas operacji');
 }
 // Native profile/offer evidence and eligibility are re-read after every IAM
 // lock wait. Do not recompute the repricing row's current price after writing it.
 for(const [basis,p]of tx.rankings){
  ensure(competitorObservationCanonical(basis)===p.canonical,409,'Zmieniono zamrożoną podstawę rankingu');
  const now=(await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 now_ms')).rows[0].now_ms;
  const fresh=await collectCompetitorRankingInTx(c,p.tenant,p.list,p.rule,p.productId,now);
  ensure(competitorObservationCanonical(fresh)===p.canonical,409,'Obserwacje lub ważność rankingu zmieniły się');
 }
 const deadlines=[...tx.rankings.values()].flatMap(p=>p.deadline?[p.deadline]:[]).sort();const deadline=deadlines[0]??null;
 // Each terminal independently pins native identity then checks fresh metadata
 // then the DB clock. There is no owner-role restoration after these calls.
 for(const duty of tx.duties.values()){const a=duty.actor,p=authorities.get(a)!;try{await c.query('SELECT competitor_observation_terminal($1,$2,$3,$4,$5,$6,$7)',[a.tenantId,a.userId,a.apiKeyId??null,p.hash,a.role,duty.write,deadline]);}catch(e){nativeError(e);}}
 for(const w of tx.workers.values()){const lists=[...new Set([...tx.rankings.values()].filter(p=>p.tenant===w.tenant).map(p=>p.list.id).concat([...(w.collectionLists??[])]))].sort();try{await c.query('SELECT competitor_observation_worker_terminal($1,$2,$3,$4)',[w.tenant,w.actorId,lists,deadline]);}catch(e){nativeError(e);}}
 if(!tx.duties.size&&!tx.workers.size&&tx.rankings.size){try{await c.query('SELECT competitor_observation_rank_terminal($1)',[deadline]);}catch(e){nativeError(e);}}
}
// Absent-module options still refresh native owner-readable credentials before
// and after the tenant read. This path never reads a private migration ledger.
async function ownerIdentity(c:PoolClient,a:Actor,write:boolean){
 const p=authorities.get(a);ensure(p,401,'Brak zaufanej tożsamości');
 const from=a.apiKeyId?`FROM api_keys k JOIN memberships m ON(m.user_id,m.tenant_id)=(k.user_id,k.tenant_id) JOIN users u ON u.id=k.user_id JOIN tenants t ON t.id=k.tenant_id LEFT JOIN account_security s ON s.user_id=u.id LEFT JOIN workspace_security_policies w ON w.tenant_id=t.id WHERE(k.id,k.user_id,k.tenant_id,k.token_hash)=($4::uuid,$2::uuid,$1::uuid,$3) AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp()`:`FROM sessions k JOIN memberships m ON(m.user_id,m.tenant_id)=(k.user_id,k.tenant_id) JOIN users u ON u.id=k.user_id JOIN tenants t ON t.id=k.tenant_id LEFT JOIN account_security s ON s.user_id=u.id LEFT JOIN workspace_security_policies w ON w.tenant_id=t.id WHERE(k.user_id,k.tenant_id,k.token_hash)=($2::uuid,$1::uuid,$3) AND k.expires_at>clock_timestamp() AND k.account_version=coalesce(s.version,0)`;
 const r=(await c.query(`SELECT m.role,coalesce(s.version,0)::text account_version,to_jsonb(w) policy,${a.apiKeyId?"k.scopes,k.scopes@>CASE WHEN $5::boolean THEN ARRAY['products:read','products:write']::text[] ELSE ARRAY['products:read']::text[] END scope_ok,coalesce(w.require_mfa,false) AND s.enabled_at IS NULL mfa_required":"NULL::text[] scopes,true scope_ok,coalesce(w.require_mfa,false) AND NOT coalesce(s.enabled_at IS NOT NULL AND k.mfa_verified_at IS NOT NULL AND k.mfa_verified_at>clock_timestamp()-interval '8 hours',false) mfa_required"} ${from}`,a.apiKeyId?[a.tenantId,a.userId,p.hash,a.apiKeyId,write]:[a.tenantId,a.userId,p.hash])).rows[0];
 ensure(r,401,'Sesja lub klucz wygasły');ensure(r.role===a.role,409,'Rola zmieniła się');ensure(r.scope_ok&&!r.mfa_required&&(!write||r.role==='admin'),403,'Brak bieżących uprawnień');return sha(competitorObservationCanonical(r));
}
const profileProjection="price_list_id,version,config_version,data_version,source_namespace,own_seller_id,rank,own_delivery_gross_minor::text,max_age_minutes,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') updated_at";
const batchProjection="id,price_list_id,client_key,profile_version,profile_config_version,profile_data_version,request_hash,count,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') created_at";
const observationProjection="id,batch_id,ordinal,product_id,source_namespace,offer_id,seller_id,currency,price_gross_minor::text,delivery_gross_minor::text,available,to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') observed_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') created_at";
async function listFrame(c:PoolClient,id:string,lock=false){
 if(lock)await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('catalog:'||current_setting('app.tenant_id'),0))");
 const list=(await c.query('SELECT id,name,currency,version,active FROM price_lists WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];ensure(list,404,'Nie znaleziono cennika');
 const rule=(await c.query('SELECT * FROM repricing_rules WHERE price_list_id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];return {list,rule};
}
async function profile(c:PoolClient,id:string):Promise<CompetitorProfile|null>{return(await c.query('SELECT '+profileProjection+' FROM competitor_observation_profiles WHERE price_list_id=$1',[id])).rows[0]??null;}
async function audit(c:PoolClient,a:Actor,action:string,id:string,detail:unknown){await(await import('./domain')).audit(c,a,action,id,detail);}
async function invalidateData(c:PoolClient,id:string,ownCollectorRun:string|null=null){
 await c.query('SELECT price_list_id FROM repricing_schedules WHERE price_list_id=$1 FOR UPDATE',[id]);
 const cancelled=(await c.query("UPDATE repricing_runs SET state=CASE WHEN changed>0 THEN 'partial' ELSE 'cancelled' END,error='Zmieniły się obserwacje konkurencji',finished_at=now() WHERE price_list_id=$1 AND state='queued' AND($2::uuid IS NULL OR id<>$2) RETURNING job_id",[id,ownCollectorRun])).rows;
 await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error='Zmieniły się obserwacje konkurencji' WHERE id=ANY($1::uuid[])",[cancelled.map(r=>r.job_id)]);
 await c.query("UPDATE repricing_schedules SET next_at=clock_timestamp()+make_interval(mins=>interval_minutes) WHERE price_list_id=$1 AND enabled AND next_at IS NULL",[id]);
}
const pageCursor=z.strictObject({v:z.literal(1),tenant:z.uuid(),user:z.uuid(),role:z.enum(['admin','operator','viewer']),key:z.uuid().nullable(),auth:z.string().regex(/^[a-f0-9]{64}$/),readonly:z.boolean(),list:z.uuid(),kind:z.enum(['batches','observations']),product:z.uuid().nullable(),limit:z.literal(50),id:z.uuid()});
async function storeObservationBatchInTx(c:PoolClient,a:Actor,id:string,raw:unknown,ownCollectorRun:string|null=null){
ensure(Buffer.byteLength(JSON.stringify(raw)??'','utf8')<=1000000,413,'Partia przekracza 1 MB');const b=competitorBatchInput.parse(raw),requestText=competitorObservationCanonical(b),requestHash=sha(requestText);ensure(Buffer.byteLength(requestText)<=1000000,413,'Partia przekracza 1 MB');
   const {list,rule}=await listFrame(c,id,true);ensure(rule,409,'Najpierw skonfiguruj repricing');
   const p=(await c.query('SELECT *,to_jsonb(p) snapshot FROM competitor_observation_profiles p WHERE price_list_id=$1 FOR UPDATE',[id])).rows[0];ensure(p,409,'Najpierw zapisz profil konkurencji');
   if(ownCollectorRun===null)await enlistCompetitorObservationAuthorityInTx(c,a,'write');
   else{
    const tx=await context(c,a.tenantId),w=tx.workers.get(a.tenantId+':'+a.userId);
    ensure(w&&w.collectionLists?.has(id)&&w.collectionRuns?.has(ownCollectorRun),403,'Brak własnego natywnego przebiegu kolekcji');
    try{const current=(await c.query('SELECT competitor_observation_worker_identity($1,$2,$3,false) identity',[a.tenantId,a.userId,[id]])).rows[0].identity;
     ensure(sha(competitorObservationCanonical(current))===w.initial,409,'Uprawnienia autora harmonogramu zmieniły się');
    }catch(e){nativeError(e);}
   }
   const previous=(await c.query('SELECT * FROM competitor_observation_batches WHERE price_list_id=$1 AND client_key=$2',[id,b.client_key])).rows[0];
   if(previous){ensure(previous.request_hash===requestHash&&competitorObservationCanonical(previous.request)===requestText&&previous.actor_id===a.userId&&(previous.api_key_id??null)===(a.apiKeyId??null),409,'Klucz partii jest związany z innym żądaniem');return {batch:(await c.query('SELECT '+batchProjection+' FROM competitor_observation_batches WHERE id=$1',[previous.id])).rows[0] as CompetitorBatch,profile:(await profile(c,id))!,rule_version:rule.version,reused:true};}
   ensure(list.active,409,'Cennik jest nieaktywny');ensure(p.version===b.profile_version,409,'Profil zmienił się');ensure(b.observations.every(o=>o.source_namespace===p.source_namespace&&o.currency===list.currency),422,'Źródło lub waluta nie pasują do profilu i cennika');
   const products=(await c.query('SELECT id,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[[...new Set(b.observations.map(o=>o.product_id))]])).rows;ensure(products.length===new Set(b.observations.map(o=>o.product_id)).size&&products.every(p=>p.kind!=='group'),422,'Partia zawiera niewłasny lub grupowy produkt');await assertProductsNotDeletedInTx(c,products.map(p=>p.id));
   const now=(await c.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') stamp")).rows[0].stamp;ensure(b.observations.every(o=>o.observed_at<=now),422,'Obserwacja pochodzi z przyszłości');
   const bid=randomUUID();await c.query('INSERT INTO competitor_observation_batches(id,tenant_id,price_list_id,client_key,actor_id,api_key_id,profile_version,profile_config_version,profile_data_version,request_hash,request_text,request,profile_snapshot,list_currency,count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15)',[bid,a.tenantId,id,b.client_key,a.userId,a.apiKeyId??null,p.version,p.config_version,p.data_version,requestHash,requestText,requestText,JSON.stringify(p.snapshot),list.currency,b.observations.length]);
   await c.query(`INSERT INTO competitor_observations(id,tenant_id,price_list_id,batch_id,ordinal,product_id,source_namespace,offer_id,seller_id,currency,price_gross_minor,delivery_gross_minor,available,observed_at) SELECT gen_random_uuid(),$1,$2,$3,n::integer,(o->>'product_id')::uuid,o->>'source_namespace',o->>'offer_id',o->>'seller_id',o->>'currency',(o->>'price_gross_minor')::integer,(o->>'delivery_gross_minor')::integer,(o->>'available')::boolean,(o->>'observed_at')::timestamptz FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS entries(o,n)`,[a.tenantId,id,bid,JSON.stringify(b.observations)]);
   await c.query('UPDATE competitor_observation_profiles SET version=version+1,data_version=data_version+1,updated_at=clock_timestamp() WHERE price_list_id=$1',[id]);
   const rv=(await c.query('UPDATE repricing_rules SET version=version+1,updated_at=now() WHERE price_list_id=$1 RETURNING version',[id])).rows[0].version;await invalidateData(c,id,ownCollectorRun);await audit(c,a,'competitor.observations.import',bid,{price_list_id:id,count:b.observations.length,request_hash:requestHash});
   return {batch:(await c.query('SELECT '+batchProjection+' FROM competitor_observation_batches WHERE id=$1',[bid])).rows[0] as CompetitorBatch,profile:(await profile(c,id))!,rule_version:rv,reused:false};
}

export function createCompetitorObservationService(cfg:{pool:Pool;cursorKey:string;sessionName:string;readOnly:boolean}){
 ensure(/^[a-f0-9]{64}$/.test(cfg.cursorKey),500,'Brak prywatnego klucza stronicowania');
 async function tx<T>(req:Request,write:boolean,fn:(c:PoolClient,a:Actor,installed:boolean)=>Promise<T>){
  ensure(!write||!cfg.readOnly,423,'Kopia przywrócona jest tylko do odczytu');const a=competitorObservationRequestActor(req,cfg.sessionName),c=await cfg.pool.connect();
  try{await c.query('BEGIN');await c.query("SET LOCAL TimeZone='UTC'");await c.query("SET LOCAL statement_timeout='8s'");const ownerInitial=await ownerIdentity(c,a,write);await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);await c.query('SET LOCAL ROLE dyna_app');beginCompetitorObservationTransaction(c);
   const installed=await available(c);if(installed)await enlistCompetitorObservationAuthorityInTx(c,a,write?'write':'read');
   // Installed operations retain their native final PIN; neutral absent options
   // compare owner-readable credentials after the tenant read as well.
   const result=await fn(c,a,installed);await c.query('SET CONSTRAINTS ALL IMMEDIATE');await finalizeCompetitorObservationAuthoritiesInTx(c);if(!installed){await c.query('RESET ROLE');ensure(await ownerIdentity(c,a,write)===ownerInitial,409,'Uprawnienia zmieniły się podczas odczytu');}await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK');return nativeError(e);}finally{endCompetitorObservationTransaction(c);c.release();}
 }
 const requireInstalled=(installed:boolean)=>ensure(installed,503,'Moduł obserwacji nie jest dostępny');
 const signed=(value:z.infer<typeof pageCursor>)=>{const body=Buffer.from(JSON.stringify(value)).toString('base64url');return body+'.'+createHmac('sha256',cfg.cursorKey).update('competitor-observation/v1\0'+body).digest('hex');};
 function decode(raw:string){const [body,mac,...extra]=raw.split('.');ensure(!extra.length&&body&&/^[A-Za-z0-9_-]+$/.test(body)&&/^[a-f0-9]{64}$/.test(mac??''),422,'Niepoprawny kursor');ensure(timingSafeEqual(createHmac('sha256',cfg.cursorKey).update('competitor-observation/v1\0'+body).digest(),Buffer.from(mac,'hex')),422,'Niepoprawny kursor');try{return pageCursor.parse(JSON.parse(Buffer.from(body,'base64url').toString()));}catch{throw new Problem(422,'Niepoprawny kursor');}}
 return {
  options:(req:Request,id:string)=>tx(req,false,async(c,a,installed)=>{await listFrame(c,id);let canWrite=installed&&!cfg.readOnly&&a.role==='admin';if(canWrite){try{await identity(c,a,true);}catch(e){if(e instanceof Problem&&e.status===403)canWrite=false;else throw e;}}return {available:installed,can_read:installed,can_write:canWrite,read_only:cfg.readOnly,current_role:a.role,limits:COMPETITOR_OBSERVATION_LIMITS,observation_origin:'manual_local' as const,ranking_strategy:'competitor_rank' as const};}),
  getProfile:(req:Request,id:string)=>tx(req,false,async(c,_a,installed)=>{requireInstalled(installed);const {list,rule}=await listFrame(c,id);return {list,rule_version:rule?.version??null,profile:await profile(c,id)};}),
  putProfile:(req:Request,id:string,raw:unknown)=>tx(req,true,async(c,a,installed)=>{
   requireInstalled(installed);const b=competitorProfileInput.parse(raw),{list,rule}=await listFrame(c,id,true);ensure(list.active,409,'Cennik jest nieaktywny');ensure(rule,409,'Najpierw skonfiguruj repricing');
   const old=(await c.query('SELECT * FROM competitor_observation_profiles WHERE price_list_id=$1 FOR UPDATE',[id])).rows[0];await enlistCompetitorObservationAuthorityInTx(c,a,'write');ensure((old?.version??0)===b.version,409,'Profil zmienił się');
   const d=b.profile,args=[a.tenantId,id,d.source_namespace,d.own_seller_id,d.rank,d.own_delivery_gross_minor,d.max_age_minutes];
   if(old)await c.query('UPDATE competitor_observation_profiles SET version=version+1,config_version=config_version+1,source_namespace=$3,own_seller_id=$4,rank=$5,own_delivery_gross_minor=$6,max_age_minutes=$7,updated_at=clock_timestamp() WHERE tenant_id=$1 AND price_list_id=$2',args);
   else await c.query('INSERT INTO competitor_observation_profiles(tenant_id,price_list_id,version,config_version,data_version,source_namespace,own_seller_id,rank,own_delivery_gross_minor,max_age_minutes) VALUES($1,$2,1,1,0,$3,$4,$5,$6,$7)',args);
   const rv=(await c.query('UPDATE repricing_rules SET version=version+1,config_version=config_version+1,updated_at=now() WHERE price_list_id=$1 RETURNING version',[id])).rows[0].version;
   await(await import('./repricing-schedules')).invalidateRepricingSchedule(c,id,'Zmienił się profil konkurencji');await audit(c,a,'competitor.profile.save',id,{version:b.version+1});return {profile:(await profile(c,id))!,rule_version:rv};
  }),
  importBatch:(req:Request,id:string,raw:unknown)=>tx(req,true,async(c,a,installed)=>{requireInstalled(installed);return storeObservationBatchInTx(c,a,id,raw);}),
  putCollectionSchedule:(req:Request,id:string,raw:unknown)=>tx(req,true,async(c,a,installed)=>{
   requireInstalled(installed);const b=shopifyCollectionScheduleInput.parse(raw),{list,rule}=await listFrame(c,id,true);
   ensure(list.active&&rule?.config.enabled,409,'Cennik lub reguła jest nieaktywna');
   const p=await profile(c,id);ensure(p&&p.version===b.profile_version,409,'Profil konkurencji zmienił się');
   ensure(rule.config_version===b.rule_config_version,409,'Definicja reguły zmieniła się');
   const definition=shopifyCollectionDefinition.parse({profile_config_version:p.config_version,sources:b.sources,
    local_observations_confirmed:b.local_observations_confirmed,collection_confirmed:b.collection_confirmed,mode:b.mode,price_changes_confirmed:b.price_changes_confirmed});
   assertCollectionSourcesMatchProfile(definition,p,list.currency);
   ensure(definition.mode!=='collect_then_reprice'||rule.config.strategy==='competitor_rank',422,'Kolekcja przed repricingiem wymaga strategii competitor_rank');
   const cfg=(await c.query('SELECT * FROM repricing_schedules WHERE price_list_id=$1 FOR UPDATE',[id])).rows[0];
   ensure((cfg?.version??0)===b.version,409,'Harmonogram zmienił się');
   await(await import('./repricing-schedules')).cancelRepricingRunsInTx(c,id,'Zmieniono tryb harmonogramu kolekcji');
   const changed=(await c.query("UPDATE repricing_rules SET config=jsonb_set(config,'{shopify_collection}',$2::jsonb),version=version+1,config_version=config_version+1,updated_at=now() WHERE price_list_id=$1 RETURNING config_version",[id,JSON.stringify(definition)])).rows[0];
   const next=(await c.query('INSERT INTO repricing_schedules(tenant_id,price_list_id,actor_id,enabled,rule_config_version,interval_minutes,batch_size,next_at) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $4 THEN now()+make_interval(mins=>$6) ELSE NULL END) ON CONFLICT(tenant_id,price_list_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,rule_config_version=excluded.rule_config_version,interval_minutes=excluded.interval_minutes,batch_size=excluded.batch_size,next_at=excluded.next_at,version=repricing_schedules.version+1,error=NULL,updated_at=now() RETURNING *',[a.tenantId,id,a.userId,b.enabled,changed.config_version,b.interval_minutes,cfg?.batch_size??100])).rows[0];
   await audit(c,a,'competitor.collection.schedule.configure',id,{version:next.version,enabled:next.enabled,interval_minutes:next.interval_minutes,source_count:definition.sources.length,purpose:definition.mode});
   return {schedule:next,purpose:definition.mode};
  }),
  getBatch:(req:Request,id:string,bid:string)=>tx(req,false,async(c,_a,installed)=>{requireInstalled(installed);await listFrame(c,id);const batch=(await c.query('SELECT '+batchProjection+' FROM competitor_observation_batches WHERE price_list_id=$1 AND id=$2',[id,bid])).rows[0] as CompetitorBatch;ensure(batch,404,'Nie znaleziono własnej partii');const observations=(await c.query('SELECT '+observationProjection+' FROM competitor_observations WHERE price_list_id=$1 AND batch_id=$2 ORDER BY ordinal',[id,bid])).rows as CompetitorObservation[];ensure(observations.length===batch.count,503,'Niekompletna partia obserwacji');return {batch,observations};}),
  page:(req:Request,id:string,kind:'batches'|'observations',raw:unknown)=>tx(req,false,async(c,a,installed)=>{
   requireInstalled(installed);const q=competitorPageInput.parse(raw);ensure(kind==='observations'||q.product_id===null,422,'Filtr produktu dotyczy obserwacji');await listFrame(c,id);const duty=transactions.get(c)!.duties.get(a)!;
   const bound={v:1 as const,tenant:a.tenantId,user:a.userId,role:a.role,key:a.apiKeyId??null,auth:duty.initial,readonly:cfg.readOnly,list:id,kind,product:q.product_id,limit:50 as const},after=q.after?decode(q.after):null;
   if(after)for(const k of Object.keys(bound) as (keyof typeof bound)[])ensure(bound[k]===after[k],409,'Kursor dotyczy innej osoby, firmy lub filtra');
   const table=kind==='batches'?'competitor_observation_batches':'competitor_observations',filter=kind==='observations'?' AND($2::uuid IS NULL OR product_id=$2)':' AND $2::uuid IS NULL';
   if(after)ensure((await c.query('SELECT 1 FROM '+table+' WHERE price_list_id=$1'+filter+' AND id=$3::uuid',[id,q.product_id,after.id])).rowCount,409,'Kotwica strony jest niedostępna');
   const rows=(await c.query('SELECT '+(kind==='batches'?batchProjection:observationProjection)+' FROM '+table+' WHERE price_list_id=$1'+filter+' AND($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT 51',[id,q.product_id,after?.id??null])).rows;
   const data=rows.slice(0,50);return {data,next_cursor:rows.length>50?signed({...bound,id:data.at(-1)!.id}):null};
  }),
 };
}
export type CompetitorRankOfferBasis=CompetitorObservation&{total_gross_minor?:string;rank?:number;reason?:string};
export type CompetitorRankBasis={schema:'competitor-ranking/v1';profile_version:number|null;config_version:number|null;data_version:number|null;source_hash:string;currency:string;product_id:string;source_namespace:string|null;own_seller_id:string|null;rank:number|null;own_delivery_gross_minor:string|null;undercut_gross_minor:string;max_age_minutes:number|null;state:'ready'|'blocked';reason:string|null;selected:CompetitorRankOfferBasis|null;raw_target_gross_minor:string|null;ranked_offers:CompetitorRankOfferBasis[];excluded_offers:CompetitorRankOfferBasis[]};
/** Existing preview/apply and schedule caller hold their native list/rule locks.
 * Returned JSON contains no volatile age or clock field. Freshness is recomputed. */
export async function collectCompetitorRankingInTx(c:PoolClient,tenant:string,list:{id:string;currency:string},rule:{config:{undercut_amount:number}},productId:string,nowMs:number):Promise<CompetitorRankBasis>{
 await context(c,tenant);ensure(await available(c),503,'Moduł obserwacji nie jest dostępny');const p=(await c.query('SELECT *,to_jsonb(p) snapshot FROM competitor_observation_profiles p WHERE price_list_id=$1 FOR SHARE',[list.id])).rows[0];if(!p)return rememberRank(c,tenant,list,rule,productId,{schema:'competitor-ranking/v1',profile_version:null,config_version:null,data_version:null,source_hash:sha(competitorObservationCanonical({price_list_id:list.id,currency:list.currency,product_id:productId,profile:null})),currency:list.currency,product_id:productId,source_namespace:null,own_seller_id:null,rank:null,own_delivery_gross_minor:null,undercut_gross_minor:String(rule.config.undercut_amount),max_age_minutes:null,state:'blocked',reason:'profile_missing',selected:null,raw_target_gross_minor:null,ranked_offers:[],excluded_offers:[]});
 const rows=(await c.query('SELECT '+observationProjection+' FROM (SELECT DISTINCT ON(source_namespace,offer_id) * FROM competitor_observations WHERE price_list_id=$1 AND product_id=$2 AND source_namespace=$3 ORDER BY source_namespace,offer_id,observed_at DESC,id DESC) latest ORDER BY offer_id COLLATE "C" LIMIT 1001',[list.id,productId,p.source_namespace])).rows as CompetitorObservation[];
 ensure(rows.length<=1000,413,'Produkt przekracza 1000 ofert');const publicProfile=(await profile(c,list.id))!;const source={profile:publicProfile,currency:list.currency,product_id:productId,observations:rows};const sourceText=competitorObservationCanonical(source);ensure(Buffer.byteLength(sourceText)<=1000000,413,'Podstawa produktu przekracza 1 MB');
 const result=rankCompetitorOffers({productId,currency:list.currency,ownSellerId:p.own_seller_id,ownDeliveryGrossMinor:BigInt(p.own_delivery_gross_minor),undercutGrossMinor:BigInt(rule.config.undercut_amount),rank:p.rank,nowMs,maxAgeMs:p.max_age_minutes*60000,offers:rows.map(o=>({offerId:o.offer_id,productId:o.product_id,sellerId:o.seller_id,currency:o.currency,grossPriceMinor:BigInt(o.price_gross_minor),deliveryGrossMinor:BigInt(o.delivery_gross_minor),available:o.available,observedAtMs:Date.parse(o.observed_at)}))});
 const byId=new Map(rows.map(o=>[o.offer_id,o]));const ranked=result.rankedOffers.map(o=>({...byId.get(o.offerId)!,total_gross_minor:o.totalGrossMinor.toString(),rank:o.rank}));const excluded=result.excludedOffers.map(o=>({...byId.get(o.offer.offerId)!,reason:o.reason}));
 return rememberRank(c,tenant,list,rule,productId,{schema:'competitor-ranking/v1',profile_version:p.version,config_version:p.config_version,data_version:p.data_version,source_hash:sha(sourceText),currency:list.currency,product_id:productId,source_namespace:p.source_namespace,own_seller_id:p.own_seller_id,rank:p.rank,own_delivery_gross_minor:String(p.own_delivery_gross_minor),undercut_gross_minor:String(rule.config.undercut_amount),max_age_minutes:p.max_age_minutes,state:result.state,reason:result.reason,selected:result.selected?ranked.find(o=>o.offer_id===result.selected!.offerId)!:null,raw_target_gross_minor:result.targetGrossMinor?.toString()??null,ranked_offers:ranked,excluded_offers:excluded});
}

function rememberRank(c:PoolClient,tenant:string,list:{id:string;currency:string},rule:{config:{undercut_amount:number}},productId:string,basis:CompetitorRankBasis){
 const deadline=basis.ranked_offers.length?new Date(Math.min(...basis.ranked_offers.map(o=>Date.parse(o.observed_at)))+basis.max_age_minutes!*60000+1).toISOString():null;
 rankProofs.set(basis,{c,tenant,list:{id:list.id,currency:list.currency},rule:{config:{undercut_amount:rule.config.undercut_amount}},productId,canonical:competitorObservationCanonical(basis),deadline});return basis;
}
export async function enlistCompetitorRankingBasisInTx(c:PoolClient,basis:CompetitorRankBasis){
 const p=rankProofs.get(basis);ensure(p&&p.c===c,403,'Brak natywnej podstawy rankingu w tej transakcji');const tx=await context(c,p.tenant);
 ensure(competitorObservationCanonical(basis)===p.canonical,409,'Zmieniono podstawę rankingu');tx.rankings.set(basis,p);
 ensure([...tx.rankings.keys()].reduce((n,b)=>n+b.ranked_offers.length+b.excluded_offers.length,0)<=5000,413,'Preview przekracza 5000 ofert');
 ensure(Buffer.byteLength(competitorObservationCanonical([...tx.rankings.keys()]))<=2000000,413,'Preview przekracza 2 MB');
}

/** Only the native schedule processor may enlist its stored author; no HTTP
 * credential is invented. Terminal verifies actual own schedule author tuples. */
export async function enlistCompetitorRankingWorkerInTx(c:PoolClient,tenant:string,actorId:string){
 const tx=await context(c,tenant);ensure(await available(c),503,'Brak modułu obserwacji');
 try{const current=(await c.query('SELECT competitor_observation_worker_identity($1,$2,NULL,false) identity',[tenant,actorId])).rows[0].identity;const initial=sha(competitorObservationCanonical(current)),key=tenant+':'+actorId,old=tx.workers.get(key);ensure(!old||old.initial===initial,409,'Zmieniono autora harmonogramu');if(!old)tx.workers.set(key,{tenant,actorId,initial});}catch(e){nativeError(e);}
}

/** Real current run/lease + stored author. These native worker checks grant no
 * HTTP session and never construct an administrator request. */
export async function enlistCompetitorCollectionWorkerInTx(c:PoolClient,job:any,listId:string){
 await context(c,job.tenant_id);
 const frame=(await c.query("SELECT r.id,r.actor_id,s.rule_config_version,p.config_version profile_config_version,rr.config FROM repricing_runs r JOIN repricing_schedules s ON(s.tenant_id,s.price_list_id)=(r.tenant_id,r.price_list_id) JOIN jobs j ON(j.tenant_id,j.id)=(r.tenant_id,r.job_id) JOIN repricing_rules rr ON(rr.tenant_id,rr.price_list_id)=(s.tenant_id,s.price_list_id) JOIN competitor_observation_profiles p ON(p.tenant_id,p.price_list_id)=(s.tenant_id,s.price_list_id) WHERE r.tenant_id=$1 AND r.price_list_id=$2 AND r.id=$3 AND j.id=$4 AND j.kind='pricing.reprice' AND j.state='running' AND j.lease_token=$5 AND j.payload->>'run_id'=r.id::text AND j.payload->'collection_profile_version'=to_jsonb($6::integer) AND p.version=$6 AND r.state='queued' AND s.enabled AND(s.version,s.actor_id)=(r.schedule_version,r.actor_id) AND rr.config_version=s.rule_config_version AND rr.version=r.rule_version FOR SHARE OF r,s,j,rr,p",[job.tenant_id,listId,job.payload.run_id,job.id,job.lease_token,scheduledCollectionProfileVersion(job.payload)])).rows[0];
 ensure(frame,409,'Brak aktualnej dzierżawy kolekcji lub zmieniony harmonogram');
 const definition=scheduledShopifyDefinition(frame.config);ensure(definition&&definition.profile_config_version===frame.profile_config_version,409,'Definicja profilu kolekcji zmieniła się');
 await enlistCompetitorRankingWorkerInTx(c,job.tenant_id,frame.actor_id);
 const tx=transactions.get(c)!,w=tx.workers.get(job.tenant_id+':'+frame.actor_id)!;
 try{const current=(await c.query('SELECT competitor_observation_worker_identity($1,$2,$3,false) identity',[job.tenant_id,frame.actor_id,[listId]])).rows[0].identity;
  ensure(sha(competitorObservationCanonical(current))===w.initial,409,'Uprawnienia autora harmonogramu zmieniły się');
 }catch(e){nativeError(e);}
 (w.collectionLists??=new Set()).add(listId);(w.collectionRuns??=new Set()).add(frame.id);return frame;
}
export async function importScheduledCompetitorObservationsInTx(c:PoolClient,job:any,listId:string,raw:unknown){
 const frame=await enlistCompetitorCollectionWorkerInTx(c,job,listId);
 const b=competitorBatchInput.parse(raw);ensure(b.client_key===frame.id,409,'Partia nie odpowiada własnemu przebiegowi');
 ensure(b.profile_version===scheduledCollectionProfileVersion(job.payload),409,'Partia nie odpowiada przypiętej wersji profilu');
 const actor:Actor=Object.freeze({tenantId:job.tenant_id,userId:frame.actor_id,role:'admin'});
 return storeObservationBatchInTx(c,actor,listId,b,frame.id);
}
