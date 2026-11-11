/** Explicit sandbox-only exact-job executor. No scheduler, queue scan, retry or IO at construction. */
import {isDeepStrictEqual}from'node:util';import assert from 'node:assert/strict';import {randomUUID,createHash}from'node:crypto';import{z}from'zod';
import type {FastifyInstance,FastifyRequest}from'fastify';import type{PoolClient}from'pg';
import type{Actor}from'./domain';import{ensure,Problem}from'./errors';
import{inspectOrdinaryConnectorTransport,type OrdinaryConnectorTransport}from'./provider-read-transport';
import type{IntegrationContext}from'./channel-access';
export type OrdinaryConnectorJobExecution={mode:'sandbox_manual_once'};
const INTENT='ordinary.connector.job.once.intent',CLAIM='ordinary.connector.job.once.claim',uuid=z.uuid(),params=z.strictObject({id:uuid}),empty=z.strictObject({});
type ManualActor=Actor&{sessionHash:string};
const kinds=['orders.sync','offer.write','shipping','shipping.dpd','dpd.collection'] as const;
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function assertOrdinaryConnectorJobExecution(mode:OrdinaryConnectorJobExecution|undefined,transport:OrdinaryConnectorTransport|undefined,readOnly:boolean,localFixture:boolean){
 if(mode===undefined)return;assert(mode&&Object.keys(mode).join(',')==='mode'&&mode.mode==='sandbox_manual_once','ordinary-connector-manual-mode');assert(!readOnly&&transport,'ordinary-connector-manual-transport-required');const cap=inspectOrdinaryConnectorTransport(transport);assert(cap.providers.length>0&&cap.providers.every(p=>p.provider!=='woocommerce'&&p.provider!=='mirakl'&&p.mode==='sandbox'),'ordinary-connector-manual-sandbox-capability-required');
}
export async function registerOrdinaryConnectorJobs(app:FastifyInstance,input:{mode?:OrdinaryConnectorJobExecution;transport?:OrdinaryConnectorTransport;context:IntegrationContext;readOnly:boolean;localFixture:boolean;sessionName:string}){
 assertOrdinaryConnectorJobExecution(input.mode,input.transport,input.readOnly,input.localFixture);if(input.mode===undefined)return false;
 // Preserve inert ordinary-factory imports: database/processors load only during app construction with explicit opt-in.
 const [{tenantTx,pool},{audit},{stopAllegroOAuthCommitRefusal},{processIntegrationJob},{processOfferJob,failOffer},{processShipping,failShipping,shippingCloseFailure},{processDpd},{processCollection,failCollection}]=await Promise.all([import('./db'),import('./domain'),import('./channel-access'),import('./sync'),import('./offers'),import('./shipping'),import('./dpd-shipping'),import('./dpd-collections')]);
 const capabilities=inspectOrdinaryConnectorTransport(input.transport!),pending=new Set<Promise<unknown>>();let closing=false,busy=false,cleanupFailure:unknown;
 const actor=(req:FastifyRequest)=>{const a=req.actor,u=req.currentUser;ensure(!closing&&!input.readOnly&&a?.role==='admin'&&!a.apiKeyId&&a.source!=='api'&&req.apiScopes===undefined&&!req.headers.authorization&&typeof req.cookies?.[input.sessionName]==='string'&&(req.cookies[input.sessionName]??'').length>0&&u?.id===a.userId&&u.tenant_id===a.tenantId&&u.role==='admin'&&!u.api_key_id,403,'Wymagana aktualna zwykła sesja administratora');return{...a,sessionHash:createHash('sha256').update(req.cookies[input.sessionName]!).digest('hex')};};
 const security=input.context.allegroSecurity;assert(security&&typeof security.accountSecurityAvailable==='boolean'&&typeof security.workspaceMfaPolicyAvailable==='boolean'&&security.readOnly===false,'ordinary-connector-manual-native-security-context');
 const current=async(c:PoolClient,a:ManualActor)=>{
  // Existing ordinary pool owner performs one fixed metadata-only identity read; no owner role switch on writer client.
  const live=(await pool.query(`SELECT m.role${security.workspaceMfaPolicyAvailable?",coalesce(p.require_mfa,false) AND NOT (a.enabled_at IS NOT NULL AND s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at>clock_timestamp()-interval '8 hours') AS mfa_required":''} FROM public.sessions s JOIN public.users u ON u.id=s.user_id JOIN public.tenants t ON t.id=s.tenant_id JOIN public.memberships m ON (m.user_id,m.tenant_id)=(s.user_id,s.tenant_id) ${security.accountSecurityAvailable?'LEFT JOIN public.account_security a ON a.user_id=u.id':''} ${security.workspaceMfaPolicyAvailable?'LEFT JOIN public.workspace_security_policies p ON p.tenant_id=t.id':''} WHERE s.token_hash=$1 AND s.user_id=$2 AND s.tenant_id=$3 AND s.expires_at>clock_timestamp() ${security.accountSecurityAvailable?'AND s.account_version=coalesce(a.version,0)':''}`,[a.sessionHash,a.userId,a.tenantId])).rows[0];
  ensure(live?.role==='admin'&&!live.mfa_required,403,'Sesja administratora wygasła lub wymaga ponownego uwierzytelnienia');
  ensure((await c.query('SELECT public.offer_sync_is_admin($1) AS ok',[a.userId])).rows[0]?.ok===true,403,'Administrator utracił uprawnienia');
 };
 async function bound(c:PoolClient,a:ManualActor,id:string,fresh:boolean){
  await current(c,a);const job=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,id])).rows[0];
  ensure(job&&kinds.includes(job.kind)&&job.payload?.actor_id===a.userId&&uuid.safeParse(job.payload.channel_id).success&&!job.payload.packing_api_key_id&&!job.payload.accept_observed,404,'Brak własnego obsługiwanego zadania');
  const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2 FOR SHARE',[a.tenantId,job.payload.channel_id])).rows[0];
  const provider=job.kind==='orders.sync'||job.kind==='offer.write'?'allegro':job.kind==='shipping'?'inpost':'dpd';
  ensure(ch&&ch.provider===provider&&ch.mode==='sandbox'&&ch.settings?.simulation===false&&capabilities.providers.some(p=>p.provider===provider&&p.mode==='sandbox'&&(job.kind==='orders.sync'||p.access==='write')),403,'Brak jawnego zakresu sandbox dla zadania');
  let plan:any;
  if(job.kind==='orders.sync'){if(fresh)ensure(job.payload.page===1&&['bootstrap','events'].includes(job.payload.phase),409,'Wyłącznie pierwsza świeża strona synchronizacji');}
  else{
   const collection=job.kind==='dpd.collection',key=collection?job.payload.collection_id:job.payload.plan_id;uuid.parse(key);
   const table=collection?'dpd_collections':job.kind==='offer.write'?'offer_plans':'shipping_plans';
   plan=(await c.query('SELECT * FROM '+table+' WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,key])).rows[0];
   ensure(plan&&plan.tenant_id===a.tenantId&&plan.actor_id===a.userId&&plan.channel_id===ch.id&&plan.job_id===id,409,'Plan nie należy do oryginalnego zadania');
   if(fresh){
    if(job.kind==='shipping'){const allowed:Record<string,[string,string]>={create:['queued','ready'],buy:['buy_queued','buy_ready'],refresh:['queued','refresh_ready']};const cut=allowed[job.payload.action];ensure(cut&&plan.state===cut[0]&&plan.phase===cut[1]&&plan.input?.provider==='inpost',409,'Niepewna lub zmieniona operacja InPost');}
    else if(collection)ensure(!plan.schedule_run_id&&job.payload.action==='create'&&plan.state==='queued'&&plan.phase==='ready'&&['protocol','pickup'].includes(plan.kind),409,'Wyłącznie nowe zlecenie DPD');
    else ensure(plan.state==='queued'&&plan.phase==='ready'&&(job.kind!=='shipping.dpd'||plan.input?.provider==='dpd'),409,'Wyłącznie nowy plan bez rozpoczętego zapisu');
   }
  }
  if(fresh)ensure(job.state==='pending'&&Number(job.attempts)===0&&job.lease_token===null&&job.locked_at===null&&!job.provider_wait_until&&new Date(job.run_at).getTime()<=Date.now(),409,'Wyłącznie świeże niewykonane zadanie');
  await current(c,a);return{job,plan,channel:ch,connection:hash({provider:ch.provider,mode:ch.mode,settings:ch.settings,credentials:ch.credentials}),stableConnection:hash({provider:ch.provider,mode:ch.mode,settings:ch.settings,credentials:provider==='allegro'?null:ch.credentials})};
 }
 async function read(a:ManualActor,id:string){return tenantTx(a.tenantId,async c=>{const{job,plan}=await bound(c,a,id,false);const intents=(await c.query('SELECT detail FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action=$3 ORDER BY id LIMIT 2',[a.tenantId,id,INTENT])).rows;await current(c,a);return{scope:'sandbox_manual_once' as const,job:{id:job.id,kind:job.kind,state:job.state,attempts:Number(job.attempts),max_attempts:Number(job.max_attempts),lease_active:job.lease_token!==null},plan:plan?{id:plan.id,state:plan.state,phase:plan.phase}:null,once_intent_recorded:intents.length===1,completed:job.state==='done',continuation_required:job.state==='pending'&&intents.length===1,automatic_retry:false,provider_acceptance:false};});}
 async function run(a:ManualActor,id:string){
  const intent=randomUUID();let claimed:any,stableConnection:string;
  await tenantTx(a.tenantId,async c=>{const f=await bound(c,a,id,true);ensure(!(await c.query('SELECT id FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action=$3 LIMIT 1',[a.tenantId,id,INTENT])).rows.length,409,'Próba została już wysłana; wyłącznie odczyt i uzgodnienie');await audit(c,a,INTENT,id,{intent_id:intent,kind:f.job.kind,channel_id:f.channel.id,connection_sha256:f.connection});await current(c,a);});
  // If either transaction COMMIT is unacknowledged, no provider call follows.
  claimed=await tenantTx(a.tenantId,async c=>{const f=await bound(c,a,id,true),rows=(await c.query('SELECT detail FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action=$3 ORDER BY id LIMIT 2',[a.tenantId,id,INTENT])).rows;ensure(rows.length===1&&isDeepStrictEqual(rows[0].detail,{intent_id:intent,kind:f.job.kind,channel_id:f.channel.id,connection_sha256:f.connection}),409,'Nie potwierdzono własnej intencji');const job=(await c.query("UPDATE jobs SET state='running',attempts=1,max_attempts=1,locked_at=now(),lease_token=$5,provider_wait_until=NULL,provider_wait_reason=NULL WHERE tenant_id=$1 AND id=$2 AND kind=$3 AND payload=$4::jsonb AND state='pending' AND attempts=0 AND lease_token IS NULL AND locked_at IS NULL AND run_at<=now() RETURNING *",[a.tenantId,id,f.job.kind,JSON.stringify(f.job.payload),randomUUID()])).rows[0];ensure(job,409,'Nie potwierdzono oryginalnej dzierżawy');await audit(c,a,CLAIM,id,{intent_id:intent,kind:job.kind});if(f.channel.provider==='allegro')uuid.parse(f.channel.settings.oauth_connection_id);stableConnection=f.stableConnection;await current(c,a);return job;});
  const context:IntegrationContext={...input.context,transport:async(url,init)=>{
   const target=new URL(url),provider=claimed.kind==='orders.sync'||claimed.kind==='offer.write'?'allegro':claimed.kind==='shipping'?'inpost':'dpd';
   const origins=provider==='allegro'?['https://allegro.pl.allegrosandbox.pl','https://api.allegro.pl.allegrosandbox.pl']:provider==='inpost'?['https://sandbox-api-shipx-pl.easypack24.net']:['https://dpdservicesdemo.dpd.com.pl'];
   ensure(origins.includes(target.origin),403,'Ręczne zadanie dopuszcza wyłącznie oryginalny sandbox');
   await tenantTx(a.tenantId,async c=>{const f=await bound(c,a,id,false);ensure(f.job.state==='running'&&f.job.lease_token===claimed.lease_token&&f.stableConnection===stableConnection,409,'Zadanie lub połączenie zmieniło się przed połączeniem z dostawcą');await current(c,a);});
   return input.transport!(url,init);
  }};
  try{
   await tenantTx(a.tenantId,c=>current(c,a));
   if(claimed.kind==='orders.sync')await processIntegrationJob(claimed,context);else if(claimed.kind==='offer.write')await processOfferJob(claimed,context);else if(claimed.kind==='shipping')await processShipping(claimed,context);else if(claimed.kind==='shipping.dpd')await processDpd(claimed,context);else await processCollection(claimed,context);
  }catch(first){if(shippingCloseFailure(first))cleanupFailure??=first;try{
   if(!await stopAllegroOAuthCommitRefusal(claimed,first)){
    const safe=new Problem(409,'Ręczna próba zatrzymana; wymagany odczyt i uzgodnienie bez ponowienia');
    if(claimed.kind==='offer.write')await failOffer(claimed,safe);else if(['shipping','shipping.dpd'].includes(claimed.kind))await failShipping(claimed,safe);else if(claimed.kind==='dpd.collection')await failCollection(claimed,safe);else await tenantTx(a.tenantId,c=>c.query("UPDATE jobs SET state='failed',error='Ręczna próba wymaga uzgodnienia',lease_token=NULL,locked_at=NULL WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_token=$3",[a.tenantId,id,claimed.lease_token]));
   }
  }catch(close){cleanupFailure??=close;/* Preserve primary cause and refuse a clean close claim. */}throw first;}
  return read(a,id);
 }
 app.get('/api/local-operator/connector-jobs/:id',async(req,reply)=>{const a=actor(req),{id}=params.parse(req.params);empty.parse(req.query);reply.header('Cache-Control','no-store');return read(a,id);});
 app.post('/api/local-operator/connector-jobs/:id/run-once',async(req,reply)=>{const a=actor(req),{id}=params.parse(req.params);empty.parse(req.query);empty.parse(req.body);ensure(!busy,409,'Trwa poprzednia ręczna próba');busy=true;const work=run(a,id);pending.add(work);try{reply.header('Cache-Control','no-store');return await work;}finally{pending.delete(work);busy=false;}});
 app.addHook('onClose',async()=>{closing=true;await Promise.allSettled([...pending]);if(cleanupFailure)throw cleanupFailure;});return true;
}
