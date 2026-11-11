/** Explicit owned schedule processor. Import is inert; normal Startup precedes
 * all DB/processor imports. No global scheduler, reaper or provider is started. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import path from 'node:path';
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import type {OrdinaryLocalConfiguration} from './ordinary-local-runtime';

export type OrdinaryScheduleWorkerSelection={
 schema:'dynaminds-local-schedule-worker/v1';
 configuration:OrdinaryLocalConfiguration;
 scope:{tenant_id:string;schedule_id:string;actor_id:string;created_after:string;actions:[{type:'add_tag';tag:string}]};
};
export type OrdinaryScheduleRecoveryRequest={
 schema:'dynaminds-local-schedule-recovery/v1';job_id:string;run_id:string;lease_token:string;
 expected_attempts:number;schedule_version:string;definition_version:string;reason:string;
 expected_checkpoint:{cursor_at_text:string|null;cursor_id:string|null;scanned:number;done:number;skipped:number;failed:number};
};
const own=(v:unknown,keys:readonly string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&
 Object.keys(v).length===keys.length&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const canonical=(v:unknown):v is string=>typeof v==='string'&&path.isAbsolute(v)&&path.resolve(v)===v;
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const safeError=(e:unknown)=>{try{const code=(e as any)?.code,message=(e as any)?.message;return{code:typeof code==='string'&&/^[A-Z0-9_]{1,40}$/.test(code)?code:null,
 message_sha256:typeof message==='string'&&Buffer.byteLength(message)<=65536?createHash('sha256').update(message).digest('hex'):null};}catch{return{code:null,message_sha256:null};}};
/** Source-owned closed scope, not caller SQL, callbacks, provider context or runtime overrides. */
export function validateOrdinaryScheduleWorkerSelection(value:unknown):OrdinaryScheduleWorkerSelection{
 assert(own(value,['schema','configuration','scope'])&&value.schema==='dynaminds-local-schedule-worker/v1','ordinary-schedule-selection-schema');
 const c=value.configuration,s=value.scope;
 assert(own(c,['releaseDirectory','manifestSha','expectedOwner','databaseUrl','localConfigurationPath','revision']),'ordinary-schedule-configuration');
 assert(canonical(c.releaseDirectory)&&canonical(c.localConfigurationPath)&&digest(c.manifestSha)&&c.expectedOwner==='postgres'&&
  typeof c.revision==='string'&&c.revision.length>0&&c.revision.length<=120,'ordinary-schedule-configuration');
 assert(typeof c.databaseUrl==='string','ordinary-schedule-database-url');
 const u=new URL(c.databaseUrl);assert(u.protocol==='postgres:'&&u.username==='postgres'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&
  /^\/[A-Za-z0-9_]+$/.test(u.pathname)&&u.search===''&&u.hash==='','ordinary-schedule-local-database');
 assert(own(s,['tenant_id','schedule_id','actor_id','created_after','actions'])&&uuid(s.tenant_id)&&uuid(s.schedule_id)&&uuid(s.actor_id),'ordinary-schedule-scope');
 assert(typeof s.created_after==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s.created_after)&&
  Number.isFinite(Date.parse(s.created_after))&&new Date(s.created_after).toISOString()===s.created_after,'ordinary-schedule-watermark');
 assert(Array.isArray(s.actions)&&s.actions.length===1&&own(s.actions[0],['type','tag'])&&s.actions[0].type==='add_tag'&&
  typeof s.actions[0].tag==='string'&&s.actions[0].tag===s.actions[0].tag.trim()&&s.actions[0].tag.length>=1&&s.actions[0].tag.length<=40&&
  /^[\p{L}\p{N} _.-]+$/u.test(s.actions[0].tag),'ordinary-schedule-add-tag-only');
 return structuredClone(value) as OrdinaryScheduleWorkerSelection;
}

/** Explicit operator intent, never a timeout-driven retry or a provider-recovery override. */
export function validateOrdinaryScheduleRecoveryRequest(value:unknown):OrdinaryScheduleRecoveryRequest{
 assert(own(value,['schema','job_id','run_id','lease_token','expected_attempts','schedule_version','definition_version','reason','expected_checkpoint'])&&
  value.schema==='dynaminds-local-schedule-recovery/v1','ordinary-schedule-recovery-schema');
 for(const key of ['job_id','run_id','lease_token'])assert(uuid(value[key]),'ordinary-schedule-recovery-identity');
 assert(Number.isSafeInteger(value.expected_attempts)&&value.expected_attempts>=1&&value.expected_attempts<=2147483647,'ordinary-schedule-recovery-attempts');
 for(const key of ['schedule_version','definition_version'])assert(typeof value[key]==='string'&&/^[1-9][0-9]{0,18}$/.test(value[key])&&BigInt(value[key])<=9223372036854775807n,'ordinary-schedule-recovery-version');
 assert(typeof value.reason==='string'&&value.reason===value.reason.trim()&&value.reason.length>=8&&value.reason.length<=500&&!/[\x00-\x1f\x7f]/.test(value.reason),'ordinary-schedule-recovery-reason');
 const p=value.expected_checkpoint;
 assert(own(p,['cursor_at_text','cursor_id','scanned','done','skipped','failed']),'ordinary-schedule-recovery-checkpoint');
 for(const key of ['scanned','done','skipped','failed'])assert(Number.isSafeInteger(p[key])&&p[key]>=0&&p[key]<=2147483647,'ordinary-schedule-recovery-checkpoint');
 assert(p.scanned===p.done+p.skipped+p.failed&&(p.cursor_at_text===null)===(p.cursor_id===null),'ordinary-schedule-recovery-checkpoint');
 if(p.cursor_at_text!==null)assert(uuid(p.cursor_id)&&typeof p.cursor_at_text==='string'&&p.cursor_at_text.length<=64&&
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.test(p.cursor_at_text)&&Number.isFinite(Date.parse(p.cursor_at_text)),'ordinary-schedule-recovery-checkpoint');
 return structuredClone(value) as OrdinaryScheduleRecoveryRequest;
}

export async function createOrdinaryLocalScheduleWorker(value:unknown){
 const selected=validateOrdinaryScheduleWorkerSelection(value),scope=selected.scope;
 const factory=await import('./ordinary-local-runtime');
 const owner=await factory.createOrdinaryLocalApplication(selected.configuration,{readOnly:false,scopedAutomationEnabled:false});
 let db:typeof import('./db'),schedules:typeof import('./automation-schedules'),domain:typeof import('./domain');
 try{db=await import('./db');schedules=await import('./automation-schedules');}
 catch(first){try{await owner.close();}catch{/* Preserve the import refusal. */}throw first;}
 const checkActions=(definition:any)=>assert(definition&&isDeepStrictEqual(definition.actions,scope.actions),'ordinary-schedule-actions-changed');
 async function claim(){
  // tenantTx owns genuine RLS/admission/COMMIT. Never process a returned job
  // until that whole promise (including COMMIT and release) is acknowledged.
  return db.tenantTx(scope.tenant_id,async c=>{
   // Same lock order as processSchedule and ordinary schedule edits: schedule,
   // then exact job, then its run. Do not lock a run via the discovery JOIN.
   const s=(await c.query('SELECT *,next_at::text AS due_at,next_at<=now() AS due_now FROM automation_schedules WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[scope.schedule_id,scope.tenant_id])).rows[0];
   assert(s&&s.id===scope.schedule_id&&s.tenant_id===scope.tenant_id&&s.actor_id===scope.actor_id,'ordinary-schedule-owner-changed');
   checkActions(s.definition);assert(typeof s.version==='string'&&/^\d+$/.test(s.version)&&
    typeof s.definition_version==='string'&&/^\d+$/.test(s.definition_version),'ordinary-schedule-version');
   assert(typeof s.enabled==='boolean','ordinary-schedule-enabled-state');
   // Existing SECURITY DEFINER helper observes this real tenantTx's tenant GUC
   // and holds the current membership FOR SHARE until its acknowledged COMMIT.
   // Account tables remain inaccessible to dyna_app; no owner-pool IAM race.
   assert((await c.query('SELECT public.offer_sync_is_admin($1) ok',[s.actor_id])).rows[0]?.ok===true,'ordinary-schedule-author-not-admin');
   if(!s.enabled)return null;
   assert(s.due_now===null||typeof s.due_now==='boolean','ordinary-schedule-due-state');
   if(s.due_now===true){
    assert(typeof s.due_at==='string'&&Number.isFinite(Date.parse(s.due_at)),'ordinary-schedule-due-time');
    const queued=await c.query("SELECT id FROM automation_schedule_runs WHERE schedule_id=$1 AND tenant_id=$2 AND state='queued'",[s.id,scope.tenant_id]);
    if(!queued.rowCount){
     // This schedule lock plus the unique active-run index and one transaction
     // make enqueue+next_at+claim durable together. A restart rereads next_at;
     // it never reconstructs a prior occurrence after an unknown COMMIT.
     const run=await schedules.enqueueSchedule(c,{tenantId:scope.tenant_id,userId:s.actor_id,role:'admin'},s,randomUUID(),
      schedules.scheduleHash({version:s.version,due_at:s.due_at}),s.due_at);
     assert(run?.tenant_id===scope.tenant_id&&run.schedule_id===s.id&&run.actor_id===s.actor_id&&
      run.schedule_version===s.version&&run.definition_version===s.definition_version&&run.state==='queued'&&
      Number.isFinite(new Date(run.created_at).getTime())&&new Date(run.created_at).getTime()>=Date.parse(scope.created_after),'ordinary-schedule-due-run-scope');
     checkActions(run.definition);
     const next=(await c.query(`UPDATE automation_schedules SET error=NULL,next_at=automation_next_at(definition->'frequency',now())
      WHERE id=$1 AND tenant_id=$2 AND version=$3::bigint RETURNING next_at>now() AS future`,[s.id,scope.tenant_id,s.version])).rows;
     assert(next.length===1&&next[0].future===true,'ordinary-schedule-next-occurrence-unconfirmed');
    }
   }
   const job=(await c.query(`SELECT j.* FROM jobs j JOIN automation_schedule_runs r ON (r.tenant_id,r.job_id)=(j.tenant_id,j.id)
    WHERE j.tenant_id=$1 AND r.schedule_id=$2 AND r.actor_id=$3 AND r.created_at>=$4::timestamptz
    AND r.state='queued' AND r.failed=0 AND r.schedule_version=$5 AND j.kind='automation.schedule'
    AND j.payload=jsonb_build_object('run_id',r.id::text) AND j.state='pending' AND j.attempts=0
    AND j.lease_token IS NULL AND j.locked_at IS NULL AND j.run_at<=now()
    ORDER BY j.run_at,j.priority,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
   [scope.tenant_id,scope.schedule_id,scope.actor_id,scope.created_after,s.version])).rows[0];
   if(!job)return null;
   assert(job.tenant_id===scope.tenant_id&&job.kind==='automation.schedule'&&uuid(job.id)&&job.state==='pending'&&job.attempts===0&&
    job.lease_token===null&&job.locked_at===null&&own(job.payload,['run_id'])&&uuid(job.payload.run_id),'ordinary-schedule-job-scope');
   const r=(await c.query('SELECT * FROM automation_schedule_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[job.payload.run_id,scope.tenant_id])).rows[0];
   assert(r&&r.id===job.payload.run_id&&r.tenant_id===scope.tenant_id&&r.schedule_id===scope.schedule_id&&r.actor_id===scope.actor_id&&
    r.job_id===job.id&&r.state==='queued'&&r.schedule_version===s.version&&r.definition_version===s.definition_version&&
    Number.isFinite(new Date(r.created_at).getTime())&&new Date(r.created_at).getTime()>=Date.parse(scope.created_after),'ordinary-schedule-run-scope');
   assert(r.failed===0,'ordinary-schedule-known-item-failure');
   checkActions(r.definition);
   counters(r);cursor(r);
   const lease=randomUUID(),claimed=(await c.query(`UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2,
    provider_wait_until=NULL,provider_wait_reason=NULL WHERE id=$1 AND tenant_id=$3 AND state='pending'
    AND attempts=0 AND lease_token IS NULL AND locked_at IS NULL AND kind='automation.schedule'
    AND payload=jsonb_build_object('run_id',$4::text) RETURNING *`,[job.id,lease,scope.tenant_id,r.id])).rows;
   assert(claimed.length===1,'ordinary-schedule-claim-not-confirmed');const held=claimed[0];
   assert(held.id===job.id&&held.tenant_id===scope.tenant_id&&held.kind==='automation.schedule'&&held.state==='running'&&held.attempts===1&&
    held.lease_token===lease&&own(held.payload,['run_id'])&&held.payload.run_id===r.id,'ordinary-schedule-claim-scope');
   return {job:held,before:structuredClone(r)};
  });
 }
 const counters=(r:any)=>{
  assert(['scanned','done','skipped','failed'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0)&&r.scanned===r.done+r.skipped+r.failed,'ordinary-schedule-result-counters');
 };
 const cursor=(r:any)=>{assert((r.cursor_at===null)===(r.cursor_id===null),'ordinary-schedule-result-cursor');
  if(r.cursor_at===null)return null;assert(uuid(r.cursor_id)&&Number.isFinite(new Date(r.cursor_at).getTime()),'ordinary-schedule-result-cursor');
  return new Date(r.cursor_at).toISOString()+'|'+r.cursor_id;
 };
 async function recoverClaim(request:OrdinaryScheduleRecoveryRequest){
  return db.tenantTx(scope.tenant_id,async c=>{
   const s=(await c.query('SELECT * FROM automation_schedules WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[scope.schedule_id,scope.tenant_id])).rows[0];
   assert(s&&s.id===scope.schedule_id&&s.tenant_id===scope.tenant_id&&s.actor_id===scope.actor_id,'ordinary-schedule-recovery-owner');
   checkActions(s.definition);
   assert((await c.query('SELECT public.offer_sync_is_admin($1) ok',[s.actor_id])).rows[0]?.ok===true,'ordinary-schedule-recovery-author-not-admin');
   const j=(await c.query(`SELECT *,locked_at::text AS recovery_locked_at_text,locked_at<=clock_timestamp()-interval '2 minutes' AS recovery_expired,run_at<=now() AS recovery_due
    FROM jobs WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,[request.job_id,scope.tenant_id])).rows[0];
   const r=(await c.query(`SELECT *,cursor_at::text AS cursor_at_text FROM automation_schedule_runs
    WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,[request.run_id,scope.tenant_id])).rows[0];
   assert(j&&j.id===request.job_id&&j.tenant_id===scope.tenant_id&&j.kind==='automation.schedule'&&own(j.payload,['run_id'])&&j.payload.run_id===request.run_id,'ordinary-schedule-recovery-job-scope');
   assert(r&&r.id===request.run_id&&r.tenant_id===scope.tenant_id&&r.job_id===j.id&&r.schedule_id===scope.schedule_id&&r.actor_id===scope.actor_id&&
    r.schedule_version===request.schedule_version&&r.definition_version===request.definition_version&&
    Number.isFinite(new Date(r.created_at).getTime())&&new Date(r.created_at).getTime()>=Date.parse(scope.created_after),'ordinary-schedule-recovery-run-scope');
   checkActions(r.definition);counters(r);cursor(r);
   assert(r.failed===0,'ordinary-schedule-recovery-known-item-failure');
   assert(j.provider_wait_until===null&&j.provider_wait_reason===null,'ordinary-schedule-recovery-provider-wait-refused');
   // Unknown ACK may have committed a terminal batch or a continuation already.
   // These are locked observations only: do not bless its effects, reset its
   // checkpoint or dispatch from this recovery request. UI readback remains separate.
   if(r.state==='done'&&j.state==='done'&&j.lease_token===null&&j.locked_at===null)return{state:'RECOVERY_OBSERVED_DONE_REQUIRES_UI_READBACK' as const};
   if(r.state==='queued'&&j.state==='pending'&&j.attempts===0&&j.lease_token===null&&j.locked_at===null)return{state:'RECOVERY_OBSERVED_PENDING_NORMAL_CLAIM_REQUIRED' as const};
   assert(s.enabled===true&&s.version===request.schedule_version&&s.definition_version===request.definition_version,'ordinary-schedule-recovery-schedule-changed');
   assert(r.state==='queued'&&j.state==='running'&&j.lease_token===request.lease_token&&j.recovery_expired===true&&j.recovery_due===true&&
    j.locked_at!==null&&typeof j.recovery_locked_at_text==='string'&&j.attempts===request.expected_attempts&&Number.isSafeInteger(j.max_attempts)&&j.max_attempts>j.attempts,'ordinary-schedule-recovery-lease-refused');
   // Exact PostgreSQL cursor text retains microseconds; a JS Date cannot authorize a checkpoint.
   const checkpoint={cursor_at_text:r.cursor_at_text,cursor_id:r.cursor_id,scanned:r.scanned,done:r.done,skipped:r.skipped,failed:r.failed};
   assert(isDeepStrictEqual(checkpoint,request.expected_checkpoint),'ordinary-schedule-recovery-checkpoint-changed');
   const lease=randomUUID(),rows=(await c.query(`UPDATE jobs SET lease_token=$2,locked_at=clock_timestamp(),attempts=attempts+1
    WHERE id=$1 AND tenant_id=$3 AND state='running' AND lease_token=$4 AND attempts=$5 AND attempts<max_attempts
    AND locked_at=$6::timestamptz AND locked_at<=clock_timestamp()-interval '2 minutes' AND run_at<=now()
    AND kind='automation.schedule' AND payload=jsonb_build_object('run_id',$7::text)
    AND provider_wait_until IS NULL AND provider_wait_reason IS NULL RETURNING *`,
   [j.id,lease,scope.tenant_id,request.lease_token,request.expected_attempts,j.recovery_locked_at_text,r.id])).rows;
   assert(rows.length===1,'ordinary-schedule-recovery-cas-unconfirmed');const held=rows[0];
   assert(held.id===j.id&&held.tenant_id===scope.tenant_id&&held.state==='running'&&held.kind==='automation.schedule'&&
    held.lease_token===lease&&held.locked_at!==null&&Number.isFinite(new Date(held.locked_at).getTime())&&held.attempts===j.attempts+1&&held.max_attempts===j.max_attempts&&
    held.provider_wait_until===null&&held.provider_wait_reason===null&&own(held.payload,['run_id'])&&held.payload.run_id===r.id,'ordinary-schedule-recovery-cas-scope');
   domain??=await import('./domain');
   await domain.audit(c,{tenantId:scope.tenant_id,userId:scope.actor_id,role:'admin'},'automation.schedule.lease_recover',scope.schedule_id,
    {run_id:r.id,job_id:j.id,previous_lease_token:request.lease_token,lease_token:lease,previous_attempts:j.attempts,attempts:held.attempts,checkpoint,reason:request.reason});
   return{state:'RECOVERY_LEASE_COMMITTED' as const,held:{job:held,before:structuredClone(r)}};
  });
 }
 async function acknowledge(held:{job:any;before:any}){
  return db.tenantTx(scope.tenant_id,async c=>{
   const {job,before}=held;
   const s=(await c.query('SELECT * FROM automation_schedules WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[scope.schedule_id,scope.tenant_id])).rows[0];
   assert(s&&s.id===scope.schedule_id&&s.tenant_id===scope.tenant_id,'ordinary-schedule-result-owner');
   const j=(await c.query('SELECT * FROM jobs WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[job.id,scope.tenant_id])).rows[0];
   const r=(await c.query('SELECT * FROM automation_schedule_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[before.id,scope.tenant_id])).rows[0];
   assert(j&&j.id===job.id&&j.tenant_id===scope.tenant_id&&j.kind==='automation.schedule'&&own(j.payload,['run_id'])&&j.payload.run_id===before.id&&
    j.lease_token===null&&j.locked_at===null,'ordinary-schedule-result-lease-unconfirmed');
   assert(r&&r.id===before.id&&r.tenant_id===scope.tenant_id&&r.schedule_id===scope.schedule_id&&r.actor_id===scope.actor_id&&r.job_id===job.id&&
    r.schedule_version===before.schedule_version&&r.definition_version===before.definition_version,'ordinary-schedule-result-scope');
   checkActions(r.definition);counters(before);counters(r);
   assert(['scanned','done','skipped','failed'].every(k=>r[k]>=before[k])&&r.scanned-before.scanned<=25,'ordinary-schedule-result-progress');
   const sameCursor=cursor(before)===cursor(r),progress=r.scanned>before.scanned;
   assert(progress?!sameCursor:sameCursor,'ordinary-schedule-result-progress');
   if(r.state==='cancelled'){
    assert(['done','failed'].includes(j.state)&&Number.isSafeInteger(j.attempts)&&j.attempts>=0,'ordinary-schedule-result-cancel');
    return {state:'CANCELLED_CONFIRMED_NO_REPLAY',itemFailure:r.failed>0};
   }
   assert(j.attempts===0,'ordinary-schedule-result-attempts');
   if(r.state==='done'){assert(j.state==='done','ordinary-schedule-result-state');return{state:'DONE_ACKNOWLEDGED_REQUIRES_UI_READBACK',itemFailure:r.failed>0};}
   assert(r.state==='queued'&&j.state==='pending','ordinary-schedule-result-state');
   if(progress)return{state:'CONTINUATION_ACKNOWLEDGED',itemFailure:r.failed>0};
   assert(j.error==='Oczekiwanie na wolne miejsce w kolejce','ordinary-schedule-result-no-progress');
   return{state:'BACKPRESSURE_ACKNOWLEDGED',itemFailure:r.failed>0};
  });
 }
 let closing=false,closed=false,unknown=false,started=false,failed=false,recoveryUsed=false,first:unknown;
 let timer:ReturnType<typeof setTimeout>|undefined,running:Promise<boolean>|undefined,closeAttempt:Promise<void>|undefined;
 let cycles=0n,claims=0n;const outcomes:{cycle:string;state:string;code:string|null;message_sha256:string|null}[]=[];
 function runCycle(recoveryRequest?:OrdinaryScheduleRecoveryRequest):Promise<boolean>{
  if(closing)return Promise.reject(new Error('ordinary-schedule-worker-closing'));
  if(!recoveryRequest&&recoveryUsed)return Promise.reject(new Error('ordinary-schedule-recovery-one-shot'));
  if(running)return running;
  const number=++cycles;
  running=(async()=>{
   try{
    let held:{job:any;before:any}|null;
    if(recoveryRequest){
     const recovered=await recoverClaim(recoveryRequest);
     if(recovered.state!=='RECOVERY_LEASE_COMMITTED'){outcomes.push({cycle:number.toString(),state:recovered.state,code:null,message_sha256:null});return false;}
     held=recovered.held;
    }else held=await claim();
    if(!held){outcomes.push({cycle:number.toString(),state:'NO_OWN_UNATTEMPTED_JOB',code:null,message_sha256:null});return false;}
    claims++;await schedules.processSchedule(held.job);const ack=await acknowledge(held);
    // The existing processor persists its own cursor/receipts. Acknowledged
    // pending continuation is eligible on a later cycle; no stale lease reuse.
    if(ack.itemFailure){failed=true;first=Object.assign(new Error('ordinary-schedule-known-item-failure'),{code:'ITEM_FAILURE'});closing=true;
     outcomes.push({cycle:number.toString(),state:'KNOWN_ITEM_FAILURE_STOPPED',...safeError(first)});
    }else outcomes.push({cycle:number.toString(),state:ack.state,code:null,message_sha256:null});return true;
   }catch(error){if(!failed){failed=true;first=error;}unknown=true;closing=true;
    outcomes.push({cycle:number.toString(),state:'STOPPED_RECONCILE_NO_AUTOREPLAY',...safeError(error)});throw error;
   }finally{if(outcomes.length>64)outcomes.shift();}
  })();const pending=running;void pending.then(()=>{if(running===pending)running=undefined;},()=>{if(running===pending)running=undefined;});return pending;
 }
 function cycle():Promise<boolean>{return runCycle();}
 function recoverLease(value:unknown):Promise<boolean>{
  const request=validateOrdinaryScheduleRecoveryRequest(value);
  assert(!started&&!closing&&!closed&&!running&&!recoveryUsed&&cycles===0n,'ordinary-schedule-recovery-requires-unused-runtime');
  recoveryUsed=true;return runCycle(request);
 }
 const kick=()=>{if(closing)return;void cycle().catch(()=>{/* Retained; never reclaims unknown/failed work. */}).finally(()=>{if(!closing)timer=setTimeout(kick,1000);});};
 function start(){assert(!closing&&!closed&&!recoveryUsed,'ordinary-schedule-worker-closing');if(started)return;started=true;timer=setTimeout(kick,0);}
 function close():Promise<void>{
  closing=true;if(timer)clearTimeout(timer);if(closeAttempt)return closeAttempt;
  closeAttempt=(async()=>{
   let localFailed=false,localFirst:unknown;
   if(running){let deadline:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([running,new Promise<never>((_r,reject)=>{
    deadline=setTimeout(()=>{unknown=true;reject(Object.assign(new Error('ordinary-schedule-worker-drain-unconfirmed'),{code:'DRAIN_UNCONFIRMED'}));},120000);
   })]);}catch(e){localFailed=true;localFirst=failed?first:e;}finally{if(deadline)clearTimeout(deadline);}}
   if(running){unknown=true;throw localFirst??new Error('ordinary-schedule-worker-drain-unconfirmed');}
   try{await owner.close();closed=true;}catch(e){if(!localFailed){localFailed=true;localFirst=e;}}
   if(failed&&!localFailed){localFailed=true;localFirst=first;}if(localFailed)throw localFirst;
  })();const current=closeAttempt;void current.catch(()=>{if(closeAttempt===current&&!closed)closeAttempt=undefined;});return current;
 }
 return Object.freeze({app:owner.app,start,cycle,recoverLease,close,inspect:()=>Object.freeze({scope:'OWN_TENANT_SCHEDULE_ADD_TAG' as const,tenant_id:scope.tenant_id,
  schedule_id:scope.schedule_id,closing,closed,unknown,loop_started:started,active:running?1:0,cycles:cycles.toString(),claims:claims.toString(),outcomes:structuredClone(outcomes),
  global_worker_enabled:false,automatic_reclaim:false,provider_processing:false,recovery_requested:recoveryUsed})});
}

export function parseOrdinaryScheduleWorkerArgs(args:readonly string[]){
 assert(args.length===2,'ordinary-schedule-worker-private-selection-path-sha-required');const[file,digestValue]=args;
 assert(canonical(file)&&digest(digestValue),'ordinary-schedule-worker-private-selection-path-sha-required');return{file,digest:digestValue};
}
export function parseOrdinaryScheduleRecoveryArgs(args:readonly string[]){
 assert(args.length===4,'ordinary-schedule-recovery-private-selection-and-intent-required');
 const selected=parseOrdinaryScheduleWorkerArgs(args.slice(0,2)),intent=parseOrdinaryScheduleWorkerArgs(args.slice(2));
 return{...selected,recoveryFile:intent.file,recoveryDigest:intent.digest};
}
async function readSelection(file:string,digestValue:string){
 assert.equal(await realpath(file),file);const before=await lstat(file,{bigint:true});
 assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.uid===BigInt(process.getuid!())&&(before.mode&0o777n)===0o600n&&before.size>0n&&before.size<=16384n,'ordinary-schedule-private-selection');
 const identity=(s:typeof before)=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
 const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let failed=false;
 try{assert.equal(identity(await fd.stat({bigint:true})),identity(before));const bytes=Buffer.alloc(Number(before.size)+1);let count=0;
  while(count<bytes.length){const part=await fd.read(bytes,count,bytes.length-count,count);if(!part.bytesRead)break;count+=part.bytesRead;}
  assert.equal(BigInt(count),before.size);const exact=bytes.subarray(0,count);assert.equal(createHash('sha256').update(exact).digest('hex'),digestValue);
  assert.equal(identity(await fd.stat({bigint:true})),identity(before));assert.equal(identity(await lstat(file,{bigint:true})),identity(before));assert.equal(await realpath(file),file);
  return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(exact));
 }catch(error){failed=true;throw error;}finally{try{await fd.close();}catch(error){if(!failed)throw error;}}
}
async function scheduleWorkerMain(args:readonly string[],mode:'loop'|'recover'){
 const recoveryArgs=mode==='recover'?parseOrdinaryScheduleRecoveryArgs(args):undefined;
 const selectedArgs=parseOrdinaryScheduleWorkerArgs(recoveryArgs?args.slice(0,2):args);
 const {file,digest}=selectedArgs;
 let runtime:Awaited<ReturnType<typeof createOrdinaryLocalScheduleWorker>>|undefined,stopping:Promise<void>|undefined,monitor:ReturnType<typeof setInterval>|undefined;
 let requestedStop=false,started=false,failed=false,first:unknown,shutdown:Promise<void>|undefined;
 const remember=(e:unknown)=>{if(!failed){failed=true;first=e;}};
 const detach=()=>{process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);process.stdout.removeListener('error',output);process.stderr.removeListener('error',output);};
 const stop=()=>{requestedStop=true;if(monitor)clearInterval(monitor);if(!runtime)return Promise.resolve();return stopping??=runtime.close();};
 const finish=()=>shutdown??=(async()=>{try{await stop();}catch(e){remember(e);process.exitCode=1;reportScheduleFailure('ORDINARY_SCHEDULE_WORKER_STOP_FAILED',first);}finally{detach();}})();
 const signal=()=>{requestedStop=true;if(started)void finish();};
 const output=(e:unknown)=>{remember(e);process.exitCode=1;requestedStop=true;if(started)void finish();};
 process.on('SIGINT',signal);process.on('SIGTERM',signal);process.stdout.on('error',output);process.stderr.on('error',output);
 try{
  const selected=await readSelection(file,digest);
  const request=recoveryArgs?validateOrdinaryScheduleRecoveryRequest(await readSelection(recoveryArgs.recoveryFile,recoveryArgs.recoveryDigest)):undefined;
  if(requestedStop){detach();if(failed)throw first;return;}
  runtime=await createOrdinaryLocalScheduleWorker(selected);
  if(requestedStop){await stop();detach();if(failed)throw first;return;}
  if(request){
   started=true;const processed=await runtime.recoverLease(request);await stop();detach();if(failed)throw first;
   process.stdout.write(JSON.stringify({status:'ORDINARY_LOCAL_SCHEDULE_RECOVERY_ACKNOWLEDGED_REQUIRES_UI_READBACK',
    scope:'OWN_TENANT_SCHEDULE_ADD_TAG',processed_one_batch:processed,outcome:runtime.inspect().outcomes.at(-1)?.state,
    global_worker_enabled:false,automatic_reclaim:false,provider_processing:false})+'\n');return runtime;
  }
  runtime.start();started=true;monitor=setInterval(()=>{if(runtime!.inspect().closing)void finish();},1000);
  process.stdout.write(JSON.stringify({status:'ORDINARY_LOCAL_SCHEDULE_WORKER_STARTED_REQUIRES_RUN_READBACK',scope:'OWN_TENANT_SCHEDULE_ADD_TAG',global_worker_enabled:false,provider_processing:false})+'\n');return runtime;
 }catch(e){remember(e);try{await stop();}catch{}detach();throw first;}
}
export async function ordinaryScheduleWorkerMain(args:readonly string[]){return scheduleWorkerMain(args,'loop');}
export async function ordinaryScheduleRecoveryMain(args:readonly string[]){return scheduleWorkerMain(args,'recover');}
function reportScheduleFailure(status:string,error:unknown){
 process.exitCode=1;
 // A report failure does not replace the retained execution failure or replay it.
 const ignore=()=>{};process.stderr.on('error',ignore);
 try{process.stderr.write(JSON.stringify({status,...safeError(error)})+'\n',()=>setImmediate(()=>process.stderr.removeListener('error',ignore)));}
 catch{setImmediate(()=>process.stderr.removeListener('error',ignore));}
}
export async function ordinaryScheduleWorkerCli(args:readonly string[]){
 try{await ordinaryScheduleWorkerMain(args);}catch(error){reportScheduleFailure('ORDINARY_SCHEDULE_WORKER_START_FAILED',error);}
}
export async function ordinaryScheduleRecoveryCli(args:readonly string[]){
 try{await ordinaryScheduleRecoveryMain(args);}catch(error){reportScheduleFailure('ORDINARY_SCHEDULE_RECOVERY_STOPPED_NO_AUTOREPLAY',error);}
}
