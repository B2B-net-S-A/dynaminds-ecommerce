import {pool} from './db';
import {dispatchAutomation,processAutomation,failAutomation,expireAutomationLeases} from './automations';
import {claimAutomaticJob,requireAutomaticLeaseInTx} from './local-automation-worker-control';
import {processEmail,failEmail} from './email';
import {AUTOMATIC_STOCK_JOB,processAutomaticStock,type AutomaticEffectsContext} from './automation-local-effects';
const errorCode=(error:unknown)=>{try{const code=(error as any)?.code;return ['23503','23505','23514','40001','40P01','55P03','57014'].includes(code)?code:null;}catch{return null;}};
type Visit={tenant:string;rule:string;started_at:string};
type RuleCycle={started_at:string;finished_at:string;outcome:string;error_code:string|null};
export type ScopedWorkerDiagnostic={state:'NOT_STARTED'|'RUNNING'|'DRAINING'|'AMBIGUOUS_RUNTIME';started:boolean|null;draining:boolean|null;current_busy:boolean|null;last_cycle:RuleCycle|null;ram_only:true};
const diagnosticReaders=new Set<(tenant:string,rule:string)=>ScopedWorkerDiagnostic>();
/** Observation only: no activation, authority, queue read or replay. Multiple loops cannot pretend to be one app. */
export function inspectScopedAutomationRule(tenant:string,rule:string,available=true):ScopedWorkerDiagnostic{
 if(!available||diagnosticReaders.size===0)return{state:'NOT_STARTED',started:false,draining:false,current_busy:false,last_cycle:null,ram_only:true};
 if(diagnosticReaders.size!==1)return{state:'AMBIGUOUS_RUNTIME',started:null,draining:null,current_busy:null,last_cycle:null,ram_only:true};
 return [...diagnosticReaders][0]!(tenant,rule);
}
/** Code-owned local loop. No global scheduler/provider; only persistent opted-in rule claims.
 * `tenants` limits discovery to the workspaces whose admin started it (scoped-automation-processor.ts).
 * At the start of a pass (at most every 30 s) it finishes expired single-attempt automation leases of those
 * workspaces as failed with a cause (expireAutomationLeases: never repeated), so a stopped or hung attempt, or a
 * failure that could not be recorded, does not stay `running`.
 * A pass visits every opted-in rule once (pages of 32) and claims at most one job per rule per visit.
 * After a pass that claimed work the next pass starts at once; an idle or failed pass waits 1 s. */
export function startScopedAutomationWorker(context0:AutomaticEffectsContext={},scope:{tenants?:()=>readonly string[]}={}){
 const context=Object.freeze({...context0,localWooChannelIds:Object.freeze([...(context0.localWooChannelIds??[])])});
 let closing=false,running:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined,cursor:[string,string]|null=null,accepted=0n,passClaimed=false,expiredAt:number|undefined;
 const outcomes:{kind:string;state:string;error_code:string|null;cleanup_failed:boolean;visit:(Visit&{finished_at:string})|null}[]=[];
 let visit:Visit|undefined;
 let cleanupFirst:unknown,cleanupFailed=false;
 const record=(v:Omit<typeof outcomes[number],'visit'>)=>{outcomes.push({...v,visit:visit?{...visit,finished_at:new Date().toISOString()}:null});if(outcomes.length>128)outcomes.shift();};
 const readDiagnostic=(tenant:string,rule:string):ScopedWorkerDiagnostic=>{
  const last=[...outcomes].reverse().find(v=>v.visit?.tenant===tenant&&v.visit.rule===rule);
  return{state:closing?'DRAINING':'RUNNING',started:true,draining:closing,current_busy:visit?.tenant===tenant&&visit.rule===rule,
   last_cycle:last?.visit?{started_at:last.visit.started_at,finished_at:last.visit.finished_at,outcome:last.state,error_code:last.error_code}:null,ram_only:true};
 };
 diagnosticReaders.add(readDiagnostic);
 type Cycle={claimed:boolean;failed:boolean;wrapped:boolean};
 const cycle=async():Promise<Cycle>=>{
  if(cursor===null&&(expiredAt===undefined||Date.now()-expiredAt>=30_000)){
   expiredAt=Date.now();
   try{const n=await expireAutomationLeases(scope.tenants?[...scope.tenants()]:null);if(n.jobs)record({kind:'lease_expiry',state:'EXPIRED_LEASES_FAILED',error_code:null,cleanup_failed:false});}
   catch(error){record({kind:'lease_expiry',state:'LEASE_EXPIRY_REFUSED',error_code:errorCode(error),cleanup_failed:false});}
  }
  const parameters:(string|readonly string[]|null)[]=[...(cursor??[null,null]),scope.tenants?[...scope.tenants()]:null];
  const selected=(await pool.query(`SELECT tenant_id,id FROM automation_rules WHERE enabled
   AND config->'local_worker'->>'schema'='owned-automatic-rule/v1' AND config->'local_worker'->>'enabled'='true'
   AND ($1::uuid IS NULL OR(tenant_id,id)>($1::uuid,$2::uuid)) AND ($3::uuid[] IS NULL OR tenant_id=ANY($3::uuid[])) ORDER BY tenant_id,id LIMIT 32`,parameters)).rows;
  if(!selected.length){cursor=null;return{claimed:false,failed:false,wrapped:true};}
  let took=false,failed=false;
  for(const rule of selected){
   if(closing)return{claimed:took,failed,wrapped:false};cursor=[rule.tenant_id,rule.id];let held:Awaited<ReturnType<typeof claimAutomaticJob>>=null;
   visit={tenant:rule.tenant_id,rule:rule.id,started_at:new Date().toISOString()};
   try{
    held=await claimAutomaticJob(rule.tenant_id,rule.id,context);if(!held){record({kind:'unclaimed',state:'NO_UNATTEMPTED_JOB',error_code:null,cleanup_failed:false});continue;}
    // Once a claim COMMIT was acknowledged, close drains this exact started identity.
    accepted++;took=true;
    const claimed=held,guard=(c:Parameters<typeof requireAutomaticLeaseInTx>[0])=>requireAutomaticLeaseInTx(c,claimed.lease,claimed.job);
    if(held.job.kind==='automation')await dispatchAutomation(held.job,held.lease);
    else if(held.job.kind===AUTOMATIC_STOCK_JOB)await processAutomaticStock(held.job,context,guard);
    else if(held.job.kind==='email.send')await processEmail(held.job,{localSinkOnly:true,beforeAttemptInTx:guard});
    else await processAutomation(held.job,held.lease);
    record({kind:held.job.kind,state:'PROCESSOR_RETURNED_REQUIRES_HISTORY_READBACK',error_code:null,cleanup_failed:false});
   }catch(first){
    failed=true;let cleanup=false;if(held)try{if(held.job.kind==='email.send')await failEmail(held.job,first);else await failAutomation(held.job,first);}catch{cleanup=true;if(!cleanupFailed){cleanupFailed=true;cleanupFirst=first;}}
    record({kind:held?.job.kind??'unclaimed',state:held?'ATTEMPT_FAILED_NO_RETRY':'CLAIM_NOT_CONFIRMED',error_code:errorCode(first),cleanup_failed:cleanup});
    // No repeat/reclaim of attempted/unknown work. Only a later distinct unattempted job can be claimed.
   }finally{visit=undefined;}
  }
  // A short page is the end of the rule list: the next cycle starts a new pass from the first rule.
  const wrapped=selected.length<32;if(wrapped)cursor=null;
  return{claimed:took,failed,wrapped};
 };
 const kick=()=>{
  if(closing||running)return;
  // Assign the real entire cycle before a later timer can invoke another one.
  let delay=1000;
  running=cycle().then(r=>{
   // Drain at the pace of the work while the pass claims jobs; any failure keeps the 1 s backoff.
   passClaimed||=r.claimed;if(!r.failed&&passClaimed)delay=0;if(r.wrapped)passClaimed=false;
  },error=>{record({kind:'discovery',state:'DISCOVERY_REFUSED',error_code:errorCode(error),cleanup_failed:false});}).finally(()=>{
   running=undefined;if(!closing){timer=setTimeout(kick,delay);timer.unref();}
  });
 };
 timer=setTimeout(kick,0);timer.unref();let closed:Promise<void>|undefined;
 return Object.freeze({
  close(){if(closed)return closed;closing=true;if(timer)clearTimeout(timer);closed=(async()=>{try{await running;if(cleanupFailed)throw cleanupFirst;}finally{diagnosticReaders.delete(readDiagnostic);}})();return closed;},
  inspect(){return{closing,active:running?1:0,accepted:accepted.toString(),outcomes:outcomes.map(({visit:_,...v})=>({...v})),cleanup_failed:cleanupFailed,scope:'NORMAL_OPTED_RULES_AFTER_WATERMARK',provider_processing:false,automatic_retry:false};},
 });
}
