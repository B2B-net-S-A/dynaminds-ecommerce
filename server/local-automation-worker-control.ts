import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {tenantTx,tenantReadTx} from './db';
import {audit,type Actor} from './domain';
import {ensure} from './errors';
import {localSmtpPort} from './smtp';
import {WORKER_SCHEMA,activationForRule,supportedAutomaticRule,assertFrozenEntry,assertUnattempted,type Activation} from './local-automation-worker-policy';
import {normalizedRule} from './operation-schema';
import {readUnresolvedAutomaticEffects} from './automation-unresolved-effects';
import {LOCAL_WOO_ORIGINS} from '../shared/local-woo-origins';
import {AUTOMATIC_STOCK_JOB,validateAutomaticEffectsInTx,automaticLocalEmailChannel,readAutomaticEffectsPage,readAutomaticRuleReconciliation,type AutomaticEffectsContext} from './automation-local-effects';
declare const brand:unique symbol;
export type AutomaticLease={readonly [brand]:true};
type Held={job:any;facts:any;ruleId:string;activation:Activation;eventId:string;kind:'automation'|'automation.run'|'automation.local_stock'|'email.send';channels:readonly string[]};
const leases=new WeakMap<AutomaticLease,Held>();
const key=(tenant:string,rule:string)=>'automatic-rule:'+tenant+':'+rule;
const lock=(c:PoolClient,tenant:string,rule:string)=>c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key(tenant,rule)]);
async function admin(c:PoolClient,id:string){ensure((await c.query('SELECT offer_sync_is_admin($1) ok',[id])).rows[0]?.ok===true,403,'Autor nie jest aktualnym administratorem');}
const mint=(held:Held)=>{const value=Object.freeze({}) as AutomaticLease;leases.set(value,held);return value;};
async function childRun(c:PoolClient,job:any){
 if(job.kind===AUTOMATIC_STOCK_JOB){
  const r=(await c.query('SELECT * FROM automation_runs WHERE tenant_id=$1 AND id=$2',[job.tenant_id,job.payload.run_id])).rows[0];
  const action=r?.definition?.actions?.[job.payload.action_index];
  ensure(r?.state==='done'&&r.order_id===job.payload.order_id&&r.definition.actor_id===job.payload.owner_id
   &&action?.type==='sync_local_woo_stock'&&isDeepStrictEqual(action,job.payload.action)
   &&r.result?.actions?.[job.payload.action_index]?.stock_sync?.job_ids?.includes(job.id),409,'Obce źródło synchronizacji reguły');
  ensure((await c.query(`SELECT l.id FROM listings l JOIN order_pick_items i ON(i.tenant_id,i.product_id)=(l.tenant_id,l.product_id)
   JOIN orders o ON(o.tenant_id,o.id)=(i.tenant_id,i.order_id)
   WHERE l.tenant_id=$1 AND l.id=$2 AND l.channel_id=$3 AND l.warehouse_id=$4 AND l.product_id=$5
    AND i.order_id=$6 AND o.warehouse_id=$4`,[job.tenant_id,job.payload.listing_id,action.channel_id,action.warehouse_id,job.payload.product_id,r.order_id])).rowCount,409,'Oferta nie odpowiada fizycznemu zamówieniu');
  return r;
 }
 const m=(await c.query(`SELECT m.*,b.automation_run_id,b.actor_id,b.mode,b.channel_id,b.state batch_state FROM email_messages m
  JOIN email_batches b ON(b.tenant_id,b.id)=(m.tenant_id,m.batch_id) WHERE m.tenant_id=$1 AND m.id=$2 AND m.job_id=$3`,[job.tenant_id,job.payload.message_id,job.id])).rows[0];
 ensure(m?.state==='queued'&&m.attempted_at===null&&m.mode==='smtp'&&m.sender?.local_sink===true&&m.payload?.recipient?.endsWith('.test'),409,'Wiadomość nie jest nowym lokalnym emailem reguły');
 await automaticLocalEmailChannel(c,job.tenant_id,m.channel_id);
 const r=(await c.query('SELECT * FROM automation_runs WHERE tenant_id=$1 AND id=$2',[job.tenant_id,m.automation_run_id])).rows[0];
 ensure(r?.state==='done'&&r.definition.actor_id===m.actor_id&&r.order_id===m.order_id
  &&r.result?.actions?.some((a:any)=>a.email?.message_id===m.id&&a.email?.batch_id===m.batch_id),409,'Obce źródło lokalnego email');return r;
}
export async function requireAutomaticLeaseInTx(c:PoolClient,value:AutomaticLease,job:any){
 const held=leases.get(value);ensure(held&&held.job===job&&isDeepStrictEqual(held.facts,job),403,'Obca lub zmieniona dzierżawa automatyczna');
 await lock(c,job.tenant_id,held.ruleId);
 const rule=(await c.query('SELECT * FROM automation_rules WHERE tenant_id=$1 AND id=$2 FOR SHARE',[job.tenant_id,held.ruleId])).rows[0];
 const current=activationForRule(rule);ensure(current&&isDeepStrictEqual(current,held.activation),409,'Aktywacja zmieniła się przed wykonaniem');await admin(c,current.owner_id);
 await validateAutomaticEffectsInTx(c,job.tenant_id,current.owner_id,normalizedRule(rule).actions,held.channels);
 const event=(await c.query('SELECT * FROM order_events WHERE tenant_id=$1 AND id=$2 AND created_at>$3::timestamptz',[job.tenant_id,held.eventId,current.enabled_at])).rows[0];
 ensure(event,409,'Zdarzenie jest poza wodnym znacznikiem aktywacji');
 if(held.kind==='automation'){
  ensure(event.order_id===job.payload.orderId&&event.kind===job.payload.trigger,409,'Obce zdarzenie dyspozytora');
  assertFrozenEntry(rule,job.payload.rules?.find((r:any)=>r.id===held.ruleId));
 }else{
  const child=held.kind===AUTOMATIC_STOCK_JOB||held.kind==='email.send';
  const run=child?await childRun(c,job):(await c.query('SELECT * FROM automation_runs WHERE tenant_id=$1 AND id=$2',[job.tenant_id,job.payload.run_id])).rows[0];
  ensure(run&&(child||run.job_id===job.id)&&run.rule_id===rule.id&&String(run.rule_version)===current.rule_version&&run.event_id===event.id&&run.order_id===event.order_id&&run.state===(child?'done':'queued'),409,'Obce wykonanie reguły');
  assertFrozenEntry(rule,{...run.definition,id:run.rule_id,tenant_id:run.tenant_id,version:run.rule_version,action:'actions',config:run.definition});
 }
 // Advisory lock stays held by the original tenantTx until its native finalization and COMMIT.
}
export async function claimAutomaticJob(tenant:string,ruleId:string,context:AutomaticEffectsContext={}):Promise<{job:any;lease:AutomaticLease}|null>{
 return tenantTx(tenant,async c=>{
  await lock(c,tenant,ruleId);
  const rule=(await c.query('SELECT * FROM automation_rules WHERE tenant_id=$1 AND id=$2 FOR SHARE',[tenant,ruleId])).rows[0];
  const activation=activationForRule(rule);if(!activation)return null;await admin(c,activation.owner_id);
  const channels=Object.freeze([...(context.localWooChannelIds??[])]);
  await validateAutomaticEffectsInTx(c,tenant,activation.owner_id,normalizedRule(rule).actions,channels);
  // Prefer already-materialized opted-in runs. No expired/attempted job is reclaimed. Payload ids come from LATERAL(… OFFSET 0): a join clause casting j.payload is not leakproof, so under RLS it is never an index condition (p275: a scan of every run of the rule / every order event per claim).
  let job=(await c.query(`SELECT j.* FROM jobs j CROSS JOIN LATERAL(SELECT (j.payload->>'run_id')::uuid run_id OFFSET 0)x JOIN automation_runs r ON(r.tenant_id,r.id,r.job_id)=(j.tenant_id,x.run_id,j.id)
   JOIN order_events e ON(e.tenant_id,e.id)=(r.tenant_id,r.event_id)
   WHERE j.tenant_id=$1 AND r.rule_id=$2 AND r.rule_version=$3::bigint AND r.state='queued'
    AND e.created_at>$4::timestamptz AND j.created_at>$4::timestamptz AND j.kind='automation.run'
    AND j.state='pending' AND j.attempts=0 AND j.lease_token IS NULL AND j.locked_at IS NULL AND j.run_at<=now()
   ORDER BY j.run_at,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,[tenant,ruleId,activation.rule_version,activation.enabled_at])).rows[0];
  if(!job)job=(await c.query(`SELECT j.* FROM jobs j CROSS JOIN LATERAL(SELECT (j.payload->>'run_id')::uuid run_id OFFSET 0)x JOIN automation_runs r ON(r.tenant_id,r.id)=(j.tenant_id,x.run_id)
   JOIN order_events e ON(e.tenant_id,e.id)=(r.tenant_id,r.event_id)
   WHERE j.tenant_id=$1 AND r.rule_id=$2 AND r.rule_version=$3::bigint AND r.state='done' AND j.kind='automation.local_stock'
    AND e.created_at>$4::timestamptz AND j.created_at>$4::timestamptz AND j.state='pending' AND j.attempts=0
    AND j.lease_token IS NULL AND j.locked_at IS NULL AND j.run_at<=now()
   ORDER BY j.run_at,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,[tenant,ruleId,activation.rule_version,activation.enabled_at])).rows[0];
  if(!job)job=(await c.query(`SELECT j.* FROM jobs j JOIN email_messages m ON(m.tenant_id,m.job_id)=(j.tenant_id,j.id)
   JOIN email_batches b ON(b.tenant_id,b.id)=(m.tenant_id,m.batch_id) JOIN automation_runs r ON(r.tenant_id,r.id)=(b.tenant_id,b.automation_run_id)
   JOIN order_events e ON(e.tenant_id,e.id)=(r.tenant_id,r.event_id)
   WHERE j.tenant_id=$1 AND r.rule_id=$2 AND r.rule_version=$3::bigint AND r.state='done' AND j.kind='email.send'
    AND e.created_at>$4::timestamptz AND j.created_at>$4::timestamptz AND j.state='pending' AND j.attempts=0
    AND j.lease_token IS NULL AND j.locked_at IS NULL AND j.run_at<=now() AND m.state='queued' AND m.attempted_at IS NULL
   ORDER BY j.run_at,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,[tenant,ruleId,activation.rule_version,activation.enabled_at])).rows[0];
  let eventId:string;
  if(job&&(job.kind===AUTOMATIC_STOCK_JOB||job.kind==='email.send')){
   assertUnattempted(job,tenant,job.kind);const run=await childRun(c,job);ensure(run.rule_id===ruleId&&String(run.rule_version)===activation.rule_version,409,'Obca wersja reguły efektu');
   assertFrozenEntry(rule,{...run.definition,id:run.rule_id,tenant_id:run.tenant_id,version:run.rule_version,action:'actions',config:run.definition});eventId=run.event_id;
  }else if(job){
   assertUnattempted(job,tenant,'automation.run');
   const run=(await c.query('SELECT * FROM automation_runs WHERE tenant_id=$1 AND id=$2',[tenant,job.payload.run_id])).rows[0];
   ensure(run&&run.job_id===job.id&&run.rule_id===ruleId&&String(run.rule_version)===activation.rule_version&&run.state==='queued',409,'Niezgodny run/job');
   assertFrozenEntry(rule,{...run.definition,id:run.rule_id,tenant_id:run.tenant_id,version:run.rule_version,action:'actions',config:run.definition});eventId=run.event_id;
  }else{
   job=(await c.query(`SELECT j.* FROM jobs j CROSS JOIN LATERAL(SELECT (j.payload->>'eventId')::uuid event_id,(j.payload->>'orderId')::uuid order_id,j.payload->>'trigger' kind OFFSET 0)x JOIN order_events e ON(e.tenant_id,e.id)=(j.tenant_id,x.event_id)
    WHERE j.tenant_id=$1 AND j.kind='automation' AND j.payload->'rules' @> $2::jsonb
     AND e.order_id=x.order_id AND e.kind=x.kind
     AND e.created_at>$3::timestamptz AND j.created_at>$3::timestamptz AND j.state='pending' AND j.attempts=0
     AND j.lease_token IS NULL AND j.locked_at IS NULL AND j.run_at<=now()
    ORDER BY j.run_at,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,[tenant,JSON.stringify([{id:ruleId,version:activation.rule_version}]),activation.enabled_at])).rows[0];
   if(!job)return null;assertUnattempted(job,tenant,'automation');assertFrozenEntry(rule,job.payload.rules?.find((r:any)=>r.id===ruleId));eventId=job.payload.eventId;
  }
  const claimed=(await c.query(`UPDATE jobs SET state='running',attempts=1,max_attempts=1,locked_at=now(),lease_token=$3
   WHERE tenant_id=$1 AND id=$2 AND state='pending' AND attempts=0 AND lease_token IS NULL AND locked_at IS NULL AND run_at<=now() RETURNING *`,[tenant,job.id,randomUUID()])).rows[0];
  ensure(claimed,409,'Dzierżawa została zmieniona');
  // tenantTx returns this private handle only AFTER acknowledged COMMIT. Unknown claim COMMIT cannot escape.
  return{job:claimed,lease:mint({job:claimed,facts:structuredClone(claimed),ruleId,activation,eventId,kind:claimed.kind,channels})};
 });
}
const request=z.strictObject({client_key:z.uuid(),version:z.string().regex(/^[1-9]\d*$/),enabled:z.boolean()});
export function registerAutomaticWorkerControl(app:FastifyInstance,options:{readOnly:boolean;available:boolean|((tenant:string)=>boolean);localWooChannelIds?:readonly string[]}){
 const configuredChannels=Object.freeze([...(options.localWooChannelIds??[])]);
 // A function when a workspace admin can start the processor at runtime (scoped-automation-processor.ts).
 const available=(tenant:string)=>typeof options.available==='function'?options.available(tenant):options.available;
 const actor=(req:any)=>{ensure(req.actor.role==='admin'&&!req.actor.apiKeyId&&!req.apiScopes,403,'Wymagana sesja administratora');return req.actor as Actor;};
 app.get('/api/automations/local-effects/options',async req=>{
  const a=actor(req);return tenantReadTx(a.tenantId,async c=>{
   ensure((await c.query('SELECT public.packing_current_role($1,false) role',[a.userId])).rows[0]?.role==='admin',403,'Wymagany bieżący administrator');
   const channels=(await c.query(`SELECT id,name,settings FROM channels WHERE tenant_id=$1 AND id=ANY($2::uuid[])
    AND provider='woocommerce' AND mode='sandbox' AND sync_enabled=false AND settings->>'simulation'='false'
    AND settings->'local_http_fixture'->>'schema'='local-woo-http-fixture/v1' AND settings->>'store_url'=ANY($4::text[])
    AND settings->'local_http_fixture'->>'owner_id'=$3 ORDER BY name,id`,[a.tenantId,configuredChannels,a.userId,LOCAL_WOO_ORIGINS])).rows;
   const listingRows=(await c.query(`SELECT l.id,l.channel_id,l.product_id,p.sku,l.warehouse_id FROM listings l JOIN products p ON(p.tenant_id,p.id)=(l.tenant_id,l.product_id)
    WHERE l.tenant_id=$1 AND l.channel_id=ANY($2::uuid[]) AND p.kind IN('simple','variant') AND l.external_id~'^[1-9][0-9]{0,14}$' ORDER BY p.sku,l.id LIMIT 501`,[a.tenantId,channels.map((ch:any)=>ch.id)])).rows;
   const smtp=(await c.query(`SELECT id,name FROM channels WHERE tenant_id=$1 AND provider='smtp' AND mode='sandbox'
    AND settings->>'delivery'='local_sink' AND settings->>'host'='127.0.0.1' AND settings->>'port'=$2
    AND settings->>'from_email' LIKE '%.test' ORDER BY name,id`,[a.tenantId,String(localSmtpPort())])).rows;
   return{channels:channels.map((ch:any)=>({id:ch.id,name:ch.name,fixture_id:ch.settings.local_http_fixture.fixture_id,owner_id:a.userId,enrolled:true,
    listings:listingRows.slice(0,500).filter((l:any)=>l.channel_id===ch.id).map(({channel_id,...l}:any)=>l)})),smtp_channels:smtp,
    warehouses:(await c.query('SELECT id,name FROM warehouses WHERE tenant_id=$1 ORDER BY name,id LIMIT 200',[a.tenantId])).rows,
    listings_truncated:listingRows.length>500,processor_running:available(a.tenantId)&&app.server.listening};
  });
 });
 app.post('/api/automations/:id/local-worker',async(req,reply)=>{
  ensure(!options.readOnly,423,'Kopia tylko do odczytu');const a=actor(req),id=z.uuid().parse((req.params as any).id),b=request.parse(req.body);
  ensure(!b.enabled||available(a.tenantId),409,'Procesor reguł automatycznych nie działa dla tej firmy. Uruchom go w panelu „Nadzór workerów” (Automatyzacje) albo uruchom aplikację lokalną z opcją --scoped-automation i spróbuj ponownie. Nic nie zostało zapisane.');
  const result=await tenantTx(a.tenantId,async c=>{
   await lock(c,a.tenantId,id);await admin(c,a.userId);
   const idemKey='automatic-worker:'+b.client_key,hash=createHash('sha256').update(JSON.stringify([a.tenantId,a.userId,id,b])).digest('hex');
   await c.query('INSERT INTO idempotency_keys(tenant_id,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[a.tenantId,idemKey,hash]);
   const saved=(await c.query('SELECT * FROM idempotency_keys WHERE tenant_id=$1 AND key=$2 FOR UPDATE',[a.tenantId,idemKey])).rows[0];ensure(saved?.request_hash===hash,409,'Klucz użyty z innymi danymi');if(saved.response)return saved.response;
   const rule=(await c.query('SELECT * FROM automation_rules WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,id])).rows[0];ensure(rule&&rule.actor_id===a.userId,403,'Wyłącznie własna reguła');ensure(String(rule.version)===b.version,409,'Reguła zmieniła się');
   ensure(!b.enabled||rule.enabled&&supportedAutomaticRule(rule),422,'Reguła jest wyłączona lub wymaga dostawcy');
   if(b.enabled)await validateAutomaticEffectsInTx(c,a.tenantId,a.userId!,normalizedRule(rule).actions,configuredChannels);
   const time=(await c.query('SELECT clock_timestamp()::text enabled_at')).rows[0].enabled_at;
   const version=String(BigInt(rule.version)+1n),setting:Activation={schema:WORKER_SCHEMA,enabled:b.enabled,owner_id:a.userId,rule_version:version,enabled_at:time,client_key:b.client_key};
   const updated=(await c.query(`UPDATE automation_rules SET config=jsonb_set(config,'{local_worker}',$3::jsonb,true),version=version+1,updated_at=now()
    WHERE tenant_id=$1 AND id=$2 AND version=$4::bigint RETURNING *`,[a.tenantId,id,JSON.stringify(setting),b.version])).rows[0];ensure(updated&&String(updated.version)===version,409,'Konflikt aktywacji');
   const response={status:'AUTOMATIC_RULE_CONFIGURATION_ACKNOWLEDGED',rule_id:id,version,activation:setting,automatic_retry:false};
   await audit(c,a,'automation.worker.configure',id,{enabled:b.enabled,version,client_key:b.client_key});
   await c.query('UPDATE idempotency_keys SET response=$3 WHERE tenant_id=$1 AND key=$2',[a.tenantId,idemKey,JSON.stringify(response)]);return response;
  });return reply.code(201).send(result);
 });
 app.get('/api/automations/:id/local-worker',async req=>{
  const a=actor(req),id=z.uuid().parse((req.params as any).id);
  return tenantReadTx(a.tenantId,async c=>{
   ensure((await c.query('SELECT public.packing_current_role($1,false) role',[a.userId])).rows[0]?.role==='admin',403,'Autor nie jest aktualnym administratorem');const rule=(await c.query('SELECT * FROM automation_rules WHERE tenant_id=$1 AND id=$2',[a.tenantId,id])).rows[0];ensure(rule&&rule.actor_id===a.userId,404,'Brak własnej reguły');
   const unresolvedEffects=await readUnresolvedAutomaticEffects(c,a.tenantId,id,(req as any).query??{});
   const raw=rule.config?.local_worker??null,active=activationForRule(rule);
   // Preserve attempted-history visibility even when a normal rule edit removed the opt-in.
   const jobs=(await c.query(`SELECT j.kind,j.state,j.attempts,count(*)::int count FROM jobs j LEFT JOIN automation_runs r ON(r.tenant_id,r.job_id)=(j.tenant_id,j.id)
    WHERE j.tenant_id=$1 AND (j.kind='automation.run' AND r.rule_id=$2 OR j.kind='automation' AND j.payload->'rules' @> $3::jsonb)
    GROUP BY j.kind,j.state,j.attempts ORDER BY j.kind,j.state,j.attempts`,[a.tenantId,id,JSON.stringify([{id}])])).rows;
   const processorRunning=available(a.tenantId)&&app.server.listening;
   const runs=(await c.query('SELECT id FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 ORDER BY created_at DESC,id DESC LIMIT 26',[a.tenantId,id])).rows;
   const page=await readAutomaticEffectsPage(c,runs.slice(0,25).map((r:any)=>r.id)),childEffects=[...page.effects.values()].flat();
   const reconciliation=await readAutomaticRuleReconciliation(c,a.tenantId,id);
   // The app already loads this module for its onListen worker. Lazy observation avoids a new construction cycle.
   // Authorization above precedes all telemetry access; only this own rule's recent RAM visits are returned.
   const runtime=(await import('./scoped-automation-worker')).inspectScopedAutomationRule(a.tenantId,id,processorRunning);
   return{rule_id:id,version:String(rule.version),activation:raw,effective:processorRunning&&!!active,state:!raw?'NOT_CONFIGURED':!processorRunning?'PROCESSOR_STOPPED':active?'ENABLED':'DISABLED_OR_RULE_CHANGED',jobs,
    child_effects:childEffects,unresolved_effects:unresolvedEffects,child_effects_coverage:{scope:'RECENT_OWN_RULE_RUNS',run_limit:25,runs_truncated:runs.length>25,...page.coverage,reconciliation_scope:reconciliation.scope},processor_running:processorRunning,
    runtime:{...runtime,paused:runtime.state==='RUNNING'?!active:null,pause_scope:'RULE_CONFIGURATION_ONLY_NOT_DRAIN_ACK',last_cycle_scope:'RECENT_OWN_RULE_VISIT_NOT_DURABLE_HISTORY'},
    reconciliation_required:jobs.some((j:any)=>j.state==='running'&&Number(j.attempts)>0)||childEffects.some(e=>e.reconciliation_required)||reconciliation.required,automatic_retry:false,provider_processing:childEffects.some(e=>e.type==='sync_local_woo_stock')};
  });
 });
}
