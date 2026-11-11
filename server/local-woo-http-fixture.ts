/** Construction-only installation for one privately pinned official local store. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {constants,type BigIntStats} from 'node:fs';
import {lstat,realpath,open} from 'node:fs/promises';
import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {tenantTx,tenantReadTx} from './db';
import {encrypt,decrypt} from './security';
import {audit,type Actor} from './domain';
import {ensure,Problem} from './errors';
import {createLocalWooHttpTransport,LOCAL_WOO_ORIGIN,LOCAL_WOO_ORIGINS,localWooOrigin} from './local-woo-http-transport';
import type {Transport} from './integrations';
import {processOfferJob,failOffer} from './offers';
import {processIntegrationJob} from './sync';
import {readLocalWooOrders} from './local-woo-orders-read';
import {automaticStockObservationMatches,observedOfferTransport} from './local-woo-observed-lineage';
import {processCatalogSource,failCatalogSource,catalogConnectionMatches} from './catalog-source';
import {processStatusWrite,failStatusJob} from './order-status';
const uuid=z.uuid(),ref=z.strictObject({path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
const configuration=z.strictObject({fixtureId:uuid,channelId:uuid,tenantId:uuid,userId:uuid,origin:z.enum(LOCAL_WOO_ORIGINS).optional(),ca:ref,credentials:ref});
export type LocalWooFixtureConfiguration=z.infer<typeof configuration>;
export type LocalWooHttpFixture=Readonly<{transport:Transport;close:()=>Promise<void>}>;
type Credentials={consumer_key:string;consumer_secret:string};
const credentialsSchema=z.strictObject({consumer_key:z.string().regex(/^ck_[a-f0-9]{40}$/),consumer_secret:z.string().regex(/^cs_[a-f0-9]{40}$/)});
type State={config:LocalWooFixtureConfiguration;credentials:Credentials;sealed:boolean;pending:Set<Promise<unknown>>};
const owned=new WeakMap<LocalWooHttpFixture,State>();
function state(fixture:LocalWooHttpFixture){const s=owned.get(fixture);ensure(s&&!s.sealed,503,'Lokalny sklep testowy jest niedostępny');return s;}
export function assertLocalWooHttpFixture(fixture:LocalWooHttpFixture){state(fixture);}
function identity(s:BigIntStats){return[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');}
async function readPinned(r:z.infer<typeof ref>,privateFile:boolean){
 ensure(path.isAbsolute(r.path)&&path.resolve(r.path)===r.path&&await realpath(r.path)===r.path,422,'Nieprawidłowy plik lokalnego sklepu');
 const before=await lstat(r.path,{bigint:true});ensure(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.uid===BigInt(process.getuid!())&&before.size>0n&&before.size<=65536n&&(!privateFile||(before.mode&0o777n)===0o600n),422,'Nieprawidłowy plik lokalnego sklepu');
 const fd=await open(r.path,constants.O_RDONLY|constants.O_NOFOLLOW);let first:unknown,failed=false,bytes:Buffer|undefined;
 try{assert.equal(identity(await fd.stat({bigint:true})),identity(before));bytes=await fd.readFile();assert.equal(BigInt(bytes.length),before.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),r.sha256);assert.equal(identity(await fd.stat({bigint:true})),identity(before));assert.equal(identity(await lstat(r.path,{bigint:true})),identity(before));assert.equal(await realpath(r.path),r.path);}
 catch(e){failed=true;first=e;}finally{try{await fd.close();}catch(e){if(!failed){failed=true;first=e;}}}if(failed)throw first;return bytes!;
}
function origin(s:State){return localWooOrigin(s.config.origin);}
function settings(s:State){return{store_url:origin(s),simulation:false,local_http_fixture:{schema:'local-woo-http-fixture/v1',fixture_id:s.config.fixtureId,owner_id:s.config.userId}};}
function checkChannel(s:State,ch:any){
 ensure(ch&&ch.id===s.config.channelId&&ch.tenant_id===s.config.tenantId&&ch.provider==='woocommerce'&&ch.mode==='sandbox'&&ch.sync_enabled===false&&isDeepStrictEqual(ch.settings,settings(s))&&isDeepStrictEqual(decrypt(ch.credentials),s.credentials),409,'Kanał lokalnego sklepu zmienił się');
}
async function inspectTransportChannel(s:State){return tenantReadTx(s.config.tenantId,async c=>{
 ensure((await c.query('SELECT public.customer_message_role($1) AS role',[s.config.userId])).rows[0]?.role==='admin',403,'Wymagany aktualny administrator lokalnego sklepu');
 const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2',[s.config.tenantId,s.config.channelId])).rows[0];checkChannel(s,ch);return{credentials:ch.credentials,settings:ch.settings};
});}
export async function createLocalWooHttpFixture(input0:LocalWooFixtureConfiguration):Promise<LocalWooHttpFixture>{
 const config=configuration.parse(structuredClone(input0));
 // All secrets/CA are pinned before installing a transport; no environment override.
 const ca=await readPinned(config.ca,false),bytes=await readPinned(config.credentials,true);
 let credentials:Credentials;try{credentials=credentialsSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)));}catch{throw new Problem(422,'Nieprawidłowe prywatne klucze lokalnego sklepu');}
 const wire=createLocalWooHttpTransport({ca,caSha256:config.ca.sha256,origin:localWooOrigin(config.origin)});
 const s:State={config,credentials,sealed:false,pending:new Set()};
 const auth=Buffer.from(`Basic ${Buffer.from(`${credentials.consumer_key}:${credentials.consumer_secret}`).toString('base64')}`);
 const transport:Transport=(url,init)=>{
  if(s.sealed)return Promise.reject(new Problem(503,'Lokalny sklep testowy jest zamknięty'));
  const work=(async()=>{
   const incoming=Buffer.from(new Headers(init.headers).get('authorization')??'');ensure(incoming.length===auth.length&&timingSafeEqual(incoming,auth),403,'Transport jest przypisany do własnego lokalnego sklepu');
   const before=await inspectTransportChannel(s);const response=await wire(url,init);const after=await inspectTransportChannel(s);
   ensure(isDeepStrictEqual(before,after),409,'Kanał lokalnego sklepu zmienił się podczas żądania');return response;
  })();s.pending.add(work);void work.finally(()=>s.pending.delete(work)).catch(()=>{});return work;
 };
 let closing:Promise<void>|undefined;const fixture:LocalWooHttpFixture=Object.freeze({transport,close:()=>closing??=(async()=>{s.sealed=true;await Promise.allSettled([...s.pending]);})()});owned.set(fixture,s);return fixture;
}
async function nativeAdmin(c:PoolClient,s:State,actor:Actor){
 ensure(actor.role==='admin'&&!actor.apiKeyId&&actor.tenantId===s.config.tenantId&&actor.userId===s.config.userId,403,'Wymagana własna sesja administratora lokalnego sklepu');
 // Existing SD function pins the current own membership FOR SHARE; no auth-table grants.
 ensure((await c.query('SELECT public.offer_sync_is_admin($1) AS ok',[actor.userId])).rows[0]?.ok===true,403,'Wymagany aktualny administrator lokalnego sklepu');
}
function summary(s:State,ch:any){return{scope:'local_https_fixture' as const,provider_verified:false,fixture_id:s.config.fixtureId,channel_id:s.config.channelId,origin:origin(s),provider:'woocommerce',mode:'sandbox',status:ch.status};}
export function localWooHttpFixtureChannelId(fixture:LocalWooHttpFixture){return state(fixture).config.channelId;}
export async function readConfiguredLocalWooHttpChannel(fixture:LocalWooHttpFixture,actor0:Actor){
 const s=state(fixture),actor=structuredClone(actor0);
 return tenantTx(s.config.tenantId,async c=>{
  await nativeAdmin(c,s,actor);
  const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2',[s.config.tenantId,s.config.channelId])).rows[0];
  if(ch)checkChannel(s,ch);
  return {...summary(s,ch??{status:'not_connected'}),enrolled:!!ch,name:ch?.name??null};
 });
}
export async function readLocalWooHttpChannel(fixture:LocalWooHttpFixture,actor0:Actor){
 const s=state(fixture),actor=structuredClone(actor0);return tenantTx(s.config.tenantId,async c=>{await nativeAdmin(c,s,actor);const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2',[s.config.tenantId,s.config.channelId])).rows[0];ensure(ch,404,'Kanał lokalnego sklepu nie został utworzony');checkChannel(s,ch);await nativeAdmin(c,s,actor);return summary(s,ch);});
}
export async function enrollLocalWooHttpChannel(fixture:LocalWooHttpFixture,actor0:Actor,input:unknown){
 const s=state(fixture),actor=structuredClone(actor0),b=z.strictObject({name:z.string().trim().min(2).max(120)}).parse(input);
 return tenantTx(s.config.tenantId,async c=>{
  await nativeAdmin(c,s,actor);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`local-woo-http:${s.config.channelId}`]);
  ensure(!(await c.query('SELECT id FROM channels WHERE id=$1',[s.config.channelId])).rows.length,409,'Oryginalny kanał już istnieje; odczytaj wynik bez ponawiania zapisu');
  const ch=(await c.query(`INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,sync_enabled)
 VALUES($1,$2,'woocommerce',$3,'sandbox',$4,$5,false) RETURNING *`,[s.config.channelId,s.config.tenantId,b.name,encrypt(s.credentials),JSON.stringify(settings(s))])).rows[0];
  checkChannel(s,ch);await audit(c,actor,'integration.local_woocommerce.enroll',ch.id,{fixture_id:s.config.fixtureId,origin:origin(s)});
  await nativeAdmin(c,s,actor);return summary(s,ch);
 });
}

const ONCE_INTENT='integration.local_woocommerce.job_once.intent',ONCE_CLAIMED='integration.local_woocommerce.job_once.claimed';
function observedReconciliation(job:any){return job.kind==='offer.write'&&job.payload?.accept_observed===true;}
/** Observe a known manual or durable automatic stock attempt; never reopen a write. */
function requireObservedReconciliation(s:State,job:any,plan:any,listing:any,original:any,events:any[],automaticParents:any[]=[]){
 const c=s.config,terminalRead=job.state==='done'&&plan.state==='done'&&plan.phase==='done'&&Number(job.attempts)===1&&Number(job.max_attempts)===1&&job.lease_token===null&&job.locked_at===null&&plan.result?.scope==='external_api_observed'&&plan.result.id===plan.remote_id&&isDeepStrictEqual(plan.result.requested_payload,plan.payload)&&plan.result.actual_snapshot?.id===plan.remote_id&&plan.result.actual_snapshot.sku===plan.remote_snapshot?.sku&&typeof plan.result.desired_applied==='boolean';
 ensure(job.tenant_id===c.tenantId&&job.kind==='offer.write'&&job.id!==original?.id&&job.dedup_key===`offer:reconcile:${plan.id}:${job.id}`&&isDeepStrictEqual(job.payload,{plan_id:plan.id,actor_id:c.userId,channel_id:c.channelId,accept_observed:true}),409,'Wymagane oryginalne zadanie uzgodnienia wyłącznie przez odczyt');
 ensure(plan.tenant_id===c.tenantId&&plan.channel_id===c.channelId&&plan.actor_id===c.userId&&plan.job_id===job.id&&plan.sync_version===null&&plan.operation==='sync'&&((job.state==='done'||plan.state==='done'||plan.phase==='done')?terminalRead:['write_started','verify'].includes(plan.phase))&&isDeepStrictEqual(plan.input,{product_id:plan.product_id,warehouse_id:plan.warehouse_id,listing_id:plan.listing_id,operation:'sync',stock:true,price:false,sync_connection_hash:plan.input?.sync_connection_hash})&&/^[a-f0-9]{64}$/.test(plan.input?.sync_connection_hash??''),409,'Wyłącznie zamrożone uzgodnienie stanu istniejącej oferty');
 ensure(typeof plan.remote_id==='string'&&/^[1-9]\d{0,14}$/.test(plan.remote_id)&&Number.isSafeInteger(Number(plan.remote_id))&&plan.remote_snapshot?.id===plan.remote_id&&plan.remote_snapshot.type==='simple'&&typeof plan.remote_snapshot.sku==='string'&&plan.remote_snapshot.sku.length>0&&Number.isSafeInteger(plan.payload?.stock_quantity)&&plan.payload.stock_quantity>=0&&isDeepStrictEqual(plan.payload,{manage_stock:true,stock_quantity:plan.payload.stock_quantity,backorders:'no'}),409,'Nieprawidłowy zamrożony produkt lub zakres uzgodnienia');
 ensure(listing&&listing.tenant_id===c.tenantId&&listing.id===plan.listing_id&&listing.channel_id===c.channelId&&listing.product_id===plan.product_id&&listing.warehouse_id===plan.warehouse_id&&listing.external_id===plan.remote_id&&!listing.parent_external_id,409,'Powiązanie oryginalnej oferty zmieniło się');
 ensure(original&&original.tenant_id===c.tenantId&&original.kind==='offer.write'&&original.dedup_key===`offer:${plan.id}`&&isDeepStrictEqual(original.payload,{plan_id:plan.id,actor_id:c.userId,channel_id:c.channelId})&&original.state==='failed'&&Number(original.attempts)===1&&Number(original.max_attempts)===1&&original.lease_token===null&&original.locked_at===null,409,'Wymagana zakończona pierwotna próba własnego lokalnego sklepu');
 const intent=events.filter(e=>e.action===ONCE_INTENT),claim=events.filter(e=>e.action===ONCE_CLAIMED);
 const manual=events.length===2&&intent.length===1&&claim.length===1&&events.every(e=>e.tenant_id===c.tenantId&&e.user_id===c.userId&&e.entity_id===original.id)&&uuid.safeParse(intent[0]?.detail?.intent_id).success&&isDeepStrictEqual(intent[0].detail,{fixture_id:c.fixtureId,intent_id:intent[0].detail.intent_id,kind:'offer.write'})&&isDeepStrictEqual(claim[0].detail,intent[0].detail);
 ensure(manual||events.length===0&&automaticStockObservationMatches(c,plan,original,automaticParents),409,'Brak jednoznacznego źródła pierwotnego zapisu');
}
async function checkObservedReconciliation(c:PoolClient,s:State,job:any,plan:any){
 const listing=(await c.query('SELECT * FROM listings WHERE tenant_id=$1 AND id=$2',[s.config.tenantId,plan.listing_id])).rows[0];
 const original=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND dedup_key=$2',[s.config.tenantId,`offer:${plan.id}`])).rows[0];
 const events=original?(await c.query('SELECT tenant_id,user_id,entity_id,action,detail FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action IN ($3,$4) ORDER BY id LIMIT 5',[s.config.tenantId,original.id,ONCE_INTENT,ONCE_CLAIMED])).rows:[];
 const automaticParents=original&&events.length===0?(await c.query(`SELECT j.*,row_to_json(r) source_run,
  EXISTS(SELECT 1 FROM listings l JOIN order_pick_items i ON(i.tenant_id,i.product_id)=(l.tenant_id,l.product_id)
   JOIN orders o ON(o.tenant_id,o.id)=(i.tenant_id,i.order_id)
   WHERE l.tenant_id=j.tenant_id AND l.id::text=j.payload->>'listing_id' AND l.product_id::text=j.payload->>'product_id'
    AND l.channel_id=$4 AND l.warehouse_id=$5 AND o.warehouse_id=$5 AND i.order_id=r.order_id) physical_source_matches
  FROM jobs j JOIN automation_runs r ON r.tenant_id=j.tenant_id AND r.id::text=j.payload->>'run_id'
  WHERE j.tenant_id=$1 AND j.kind='automation.local_stock' AND j.payload->>'effect_job_id'=$2
   AND j.payload->>'effect_plan_id'=$3 ORDER BY j.id LIMIT 2`,[s.config.tenantId,original.id,plan.id,s.config.channelId,plan.warehouse_id])).rows:[];
 requireObservedReconciliation(s,job,plan,listing,original,events,automaticParents);
}
async function boundJob(c:PoolClient,s:State,id:string,lock=false){
 const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2',[s.config.tenantId,s.config.channelId])).rows[0];checkChannel(s,ch);
 const j=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[s.config.tenantId,id])).rows[0];
 ensure(j&&j.tenant_id===s.config.tenantId&&['offer.write','orders.sync','order.status.write','catalog.fetch'].includes(j.kind)&&j.payload?.actor_id===s.config.userId,404,'Brak własnego obsługiwanego zadania lokalnego sklepu');
 let plan:any=null;
 if(j.kind==='orders.sync'){
  ensure(Number.isSafeInteger(j.payload.page)&&j.payload.page>=1&&j.payload.page<=201&&isDeepStrictEqual(j.payload,{channel_id:s.config.channelId,actor_id:s.config.userId,page:j.payload.page,phase:'bootstrap'}),409,'Wymagany oryginalny odczyt własnego kanału');
 }else if(j.kind==='catalog.fetch'){
  plan=(await c.query('SELECT * FROM catalog_source_runs WHERE tenant_id=$1 AND id=$2',[s.config.tenantId,j.payload.run_id])).rows[0];
  ensure(plan&&plan.tenant_id===s.config.tenantId&&plan.channel_id===s.config.channelId&&plan.actor_id===s.config.userId&&plan.job_id===j.id&&catalogConnectionMatches(ch,plan),409,'Import katalogu nie należy do własnego ręcznego zadania');
  ensure(isDeepStrictEqual(j.payload,{run_id:plan.id,actor_id:s.config.userId}),409,'Tożsamość oryginalnego importu katalogu zmieniła się');
 }else{
  const table=j.kind==='offer.write'?'offer_plans':'order_status_plans';
  plan=(await c.query('SELECT * FROM '+table+' WHERE tenant_id=$1 AND id=$2',[s.config.tenantId,j.payload.plan_id])).rows[0];
  ensure(plan&&plan.tenant_id===s.config.tenantId&&plan.channel_id===s.config.channelId&&plan.actor_id===s.config.userId&&plan.job_id===j.id&&!plan.sync_version,409,'Plan nie należy do własnego ręcznego zadania');
  if(observedReconciliation(j))await checkObservedReconciliation(c,s,j,plan);
  else ensure(isDeepStrictEqual(j.payload,j.kind==='offer.write'?{plan_id:plan.id,actor_id:s.config.userId,channel_id:s.config.channelId}:{plan_id:plan.id,actor_id:s.config.userId}),409,'Tożsamość oryginalnego zadania zmieniła się');
 }
 return{job:j,plan};
}
// Historical lane ownership survives administrative abort; manual paths never reclaim it.
async function requireManualJob(c:PoolClient,tenantId:string,jobId:string){
 const rows=(await c.query("SELECT to_regclass('public.local_woo_read_occurrences')::text AS relation")).rows;
 ensure(rows.length===1&&Object.hasOwn(rows[0],'relation')&&(rows[0].relation===null||typeof rows[0].relation==='string'&&rows[0].relation.length>0),503,'Nie potwierdzono schematu automatycznych odczytów');
 if(rows[0].relation!==null)ensure(!(await c.query('SELECT id FROM public.local_woo_read_occurrences WHERE tenant_id=$1 AND job_id=$2 LIMIT 1',[tenantId,jobId])).rows.length,409,'Zadanie automatycznego odczytu wymaga uzgodnienia w jego historii; ręczne wykonanie jest wyłączone');
}
function freshJob(job:any,plan:any){ensure(job.state==='pending'&&Number(job.attempts)===0&&job.lease_token===null&&job.locked_at===null&&(!(job.kind==='orders.sync')||job.payload.page===1)&&(!plan||plan.state==='queued'&&(job.kind==='catalog.fetch'?plan.context===null&&Number(plan.fetched)===0&&isDeepStrictEqual(plan.cursor,{phase:'products',product_page:1}):observedReconciliation(job)?['write_started','verify'].includes(plan.phase):plan.phase==='ready')),409,'Wyłącznie nowe zadanie bez próby; odczytaj oryginalny wynik');}
async function jobRead(s:State,actor:Actor,id:string){return tenantTx(s.config.tenantId,async c=>{
 await nativeAdmin(c,s,actor);const{job,plan}=await boundJob(c,s,id);
 const intents=(await c.query('SELECT detail FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action=$3 ORDER BY id LIMIT 2',[s.config.tenantId,id,ONCE_INTENT])).rows;
 ensure(intents.length<=1,409,'Niejednoznaczna pierwotna intencja wykonania');await nativeAdmin(c,s,actor);
 return{scope:'local_https_fixture' as const,channel_id:s.config.channelId,observational_only:observedReconciliation(job),job:{id:job.id,kind:job.kind,state:job.state,attempts:Number(job.attempts),max_attempts:Number(job.max_attempts),lease_active:job.lease_token!==null},plan:plan?{id:plan.id,state:plan.state,phase:job.kind==='catalog.fetch'?plan.cursor.phase:plan.phase}:null,once_intent_recorded:intents.length===1};
});}
export function readLocalWooHttpJob(fixture:LocalWooHttpFixture,actor0:Actor,id0:string){const s=state(fixture),actor=structuredClone(actor0),id=uuid.parse(id0);return jobRead(s,actor,id);}
export function runLocalWooHttpJobOnce(fixture:LocalWooHttpFixture,actor0:Actor,id0:string){
 const s=state(fixture),actor=structuredClone(actor0),id=uuid.parse(id0),intentId=randomUUID();let observedTarget:{id:string;sku:string}|undefined;
 const work=(async()=>{
  // Separate acknowledged durable intent precedes claim: a claim loss cannot permit resend.
  await tenantTx(s.config.tenantId,async c=>{
   await nativeAdmin(c,s,actor);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`local-woo-http-job:${id}`]);
   const{job,plan}=await boundJob(c,s,id,true);await requireManualJob(c,s.config.tenantId,job.id);freshJob(job,plan);
   ensure(!(await c.query('SELECT id FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action=$3 LIMIT 1',[s.config.tenantId,id,ONCE_INTENT])).rows.length,409,'Wykonanie było już wysłane; tylko odczyt oryginalnego wyniku');
   await audit(c,actor,ONCE_INTENT,id,{fixture_id:s.config.fixtureId,intent_id:intentId,kind:job.kind});await nativeAdmin(c,s,actor);
  });
  const claimed=await tenantTx(s.config.tenantId,async c=>{
   await nativeAdmin(c,s,actor);const{job,plan}=await boundJob(c,s,id,true);await requireManualJob(c,s.config.tenantId,job.id);freshJob(job,plan);
   const intents=(await c.query('SELECT detail FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action=$3 ORDER BY id LIMIT 2',[s.config.tenantId,id,ONCE_INTENT])).rows;
   ensure(intents.length===1&&isDeepStrictEqual(intents[0].detail,{fixture_id:s.config.fixtureId,intent_id:intentId,kind:job.kind}),409,'Nie potwierdzono własnej pierwotnej intencji');
   const held=(await c.query(`UPDATE jobs SET state='running',attempts=1,max_attempts=1,locked_at=now(),lease_token=$3,provider_wait_until=NULL,provider_wait_reason=NULL
    WHERE tenant_id=$1 AND id=$2 AND kind=$4 AND state='pending' AND attempts=0 AND lease_token IS NULL AND locked_at IS NULL RETURNING *`,[s.config.tenantId,id,randomUUID(),job.kind])).rows[0];
   ensure(held,409,'Nie potwierdzono oryginalnej dzierżawy');if(observedReconciliation(job))observedTarget={id:plan.remote_id,sku:plan.remote_snapshot.sku};await audit(c,actor,ONCE_CLAIMED,id,{fixture_id:s.config.fixtureId,intent_id:intentId,kind:job.kind});await nativeAdmin(c,s,actor);return held;
  });
  const context={transport:observedTarget?observedOfferTransport(fixture.transport,observedTarget,origin(s)):fixture.transport,...(claimed.kind==='orders.sync'?{localWooOrdersRead:async(channelId:string)=>{ensure(channelId===s.config.channelId,403,'Odczyt zamówień jest przypisany do własnego kanału');return readLocalWooOrders(fixture.transport,`Basic ${Buffer.from(`${s.credentials.consumer_key}:${s.credentials.consumer_secret}`).toString('base64')}`,origin(s));}}:{})};
  try{if(claimed.kind==='catalog.fetch')await processCatalogSource(claimed,context);else if(claimed.kind==='offer.write')await processOfferJob(claimed,context);else if(claimed.kind==='order.status.write')await processStatusWrite(claimed,context);else await processIntegrationJob(claimed,context);}
  catch(first){try{if(claimed.kind==='catalog.fetch')await failCatalogSource(claimed,first);else if(claimed.kind==='offer.write')await failOffer(claimed,first);else if(claimed.kind==='order.status.write')await failStatusJob(claimed,first);else await tenantTx(s.config.tenantId,c=>c.query(`UPDATE jobs SET state='failed',error='Lokalny odczyt wymaga uzgodnienia',lease_token=NULL,locked_at=NULL WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_token=$3`,[s.config.tenantId,id,claimed.lease_token]));}catch{/* Original processor cause remains primary; no resend. */}throw first;}
  return jobRead(s,actor,id);
 })();s.pending.add(work);void work.finally(()=>s.pending.delete(work)).catch(()=>{});return work;
}
