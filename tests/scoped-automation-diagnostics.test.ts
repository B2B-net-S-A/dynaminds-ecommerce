import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';
import {ensure,Problem} from '../server/errors';
import * as wooOrigins from '../shared/local-woo-origins';
const require=createRequire(import.meta.url);
// Actual modules, with explicit transaction/processor/timer ports. No listener,
// provider, database or package factory is constructed by these controls.
function load(name:string,deps:Record<string,any>,globals:Record<string,any>={}){
 const code=transformSync(readFileSync(new URL('../server/'+name+'.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs',target:'es2022',supported:{'dynamic-import':false}}).code;
 const m={exports:{}};new Function('module','require',...Object.keys(globals),code)(m,(key:string)=>{
  if(key in deps)return deps[key];if(key==='./smtp')return{localSmtpPort:()=>assert.fail('No SMTP policy or transport in read-only reconciliation controls')};if(key==='./errors')return{ensure,Problem};if(key==='../shared/local-woo-origins')return wooOrigins;if(!key.startsWith('.'))return require(key);throw Error('Unmodeled '+key);
 },...Object.values(globals));return m.exports as any;
}
const id=(n:number)=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const tenant=id(1),ruleId=id(2),owner=id(3),otherTenant=id(4),otherRule=id(5);
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function until(condition:()=>boolean){for(let n=0;n<500;n++){if(condition())return;await Promise.resolve();}assert.fail('Controlled module did not settle');}
function model(){
 const timers:{callback:()=>void;cancelled:boolean}[]=[],queries:string[]=[],claims:string[]=[],processors:string[]=[];
 let rows:any[]=[{tenant_id:tenant,id:ruleId}],discoveryError:any,claimError:any,processError:any,cleanupError:any,hold:ReturnType<typeof deferred>|undefined,unclaimed=false;
 const claim=async(t:string,r:string)=>{claims.push(t+':'+r);if(claimError)throw claimError;return unclaimed?null:{job:{tenant_id:t,id:id(6),kind:'automation.run'},lease:{}};};
 const process=async()=>{processors.push('process');if(hold)await hold.promise;if(processError)throw processError;};
 const worker=load('scoped-automation-worker',{
  './db':{pool:{query:async(sql:string)=>{queries.push(sql);if(discoveryError)throw discoveryError;return{rows};}}},
  './local-automation-worker-control':{claimAutomaticJob:claim,requireAutomaticLeaseInTx:async()=>{}},
  './automations':{dispatchAutomation:process,processAutomation:process,failAutomation:async()=>{if(cleanupError)throw cleanupError;}},
  './email':{processEmail:process,failEmail:async()=>{if(cleanupError)throw cleanupError;}},
  './automation-local-effects':{AUTOMATIC_STOCK_JOB:'automation.local_stock',processAutomaticStock:process},
 },{setTimeout:(callback:()=>void)=>{const t={callback,cancelled:false};timers.push(t);return{unref(){},t};},clearTimeout:(timer:any)=>{timer.t.cancelled=true;}});
 const kick=()=>{const t=timers.shift();assert(t&&!t.cancelled);t.callback();};
 return{worker,queries,claims,processors,kick,setRows:(v:any[])=>{rows=v;},setUnclaimed:()=>{unclaimed=true;},setHold:()=>{hold=deferred();return hold;},setErrors:(v:any)=>{({discoveryError,claimError,processError,cleanupError}=v);}};
}
test('module import is inert; only actual start/close changes RAM runtime',async()=>{
 const q=model();assert.equal(q.queries.length,0);assert.equal(q.worker.inspectScopedAutomationRule(tenant,ruleId).state,'NOT_STARTED');
 const runtime=q.worker.startScopedAutomationWorker();assert.deepEqual(q.worker.inspectScopedAutomationRule(tenant,ruleId),{state:'RUNNING',started:true,draining:false,current_busy:false,last_cycle:null,ram_only:true});
 assert.equal(q.queries.length,0);assert.equal(runtime.close(),runtime.close());await runtime.close();assert.equal(q.worker.inspectScopedAutomationRule(tenant,ruleId).state,'NOT_STARTED');
});
test('busy and recent timestamps belong only to requested tenant AND rule; close drains once',async()=>{
 const q=model(),hold=q.setHold(),runtime=q.worker.startScopedAutomationWorker();q.kick();await until(()=>q.processors.length===1);
 assert.equal(q.worker.inspectScopedAutomationRule(tenant,ruleId).current_busy,true);
 for(const [t,r] of [[otherTenant,ruleId],[tenant,otherRule]])assert.deepEqual(q.worker.inspectScopedAutomationRule(t,r),{state:'RUNNING',started:true,draining:false,current_busy:false,last_cycle:null,ram_only:true});
 let ended=false;const end=runtime.close().then(()=>{ended=true;});await Promise.resolve();assert(!ended);assert.equal(q.worker.inspectScopedAutomationRule(tenant,ruleId).state,'DRAINING');hold.resolve();await end;
 assert.equal(q.processors.length,1);assert.equal(q.worker.inspectScopedAutomationRule(tenant,ruleId).state,'NOT_STARTED');
 assert(!JSON.stringify(runtime.inspect()).includes('started_at'));assert(!JSON.stringify(runtime.inspect()).includes(tenant));
});
test('own completed visit reports safe outcome but never raw failure, IDs or global discovery facts',async()=>{
 const q=model(),error=Object.assign(Error('postgres://secret/tenant-data'),{code:'57014'});q.setErrors({processError:error});const runtime=q.worker.startScopedAutomationWorker();q.kick();await until(()=>runtime.inspect().active===0);
 const d=q.worker.inspectScopedAutomationRule(tenant,ruleId);assert.equal(d.current_busy,false);assert.equal(d.last_cycle.outcome,'ATTEMPT_FAILED_NO_RETRY');assert.equal(d.last_cycle.error_code,'57014');assert(Number.isFinite(Date.parse(d.last_cycle.started_at)));assert(Number.isFinite(Date.parse(d.last_cycle.finished_at)));
 assert(!JSON.stringify(d).includes('secret'));assert(!JSON.stringify(d).includes(tenant));assert.equal(q.worker.inspectScopedAutomationRule(otherTenant,otherRule).last_cycle,null);
 q.setErrors({discoveryError:error});q.kick();await until(()=>runtime.inspect().active===0);assert.deepEqual(q.worker.inspectScopedAutomationRule(tenant,ruleId),d);await runtime.close();
});
test('failed claim is distinguished from attempt; unknown codes are redacted and cleanup failure removes registry',async()=>{
 const q=model(),primary=Object.assign(Error('private'),{code:'ECONNRESET'});q.setErrors({claimError:primary});const runtime=q.worker.startScopedAutomationWorker();q.kick();await until(()=>runtime.inspect().active===0);
 assert.equal(q.worker.inspectScopedAutomationRule(tenant,ruleId).last_cycle.outcome,'CLAIM_NOT_CONFIRMED');assert.equal(q.worker.inspectScopedAutomationRule(tenant,ruleId).last_cycle.error_code,null);assert.equal(q.processors.length,0);
 q.setErrors({processError:primary,cleanupError:Error('secondary')});q.kick();await until(()=>runtime.inspect().active===0);await assert.rejects(runtime.close(),e=>e===primary);assert.equal(q.worker.inspectScopedAutomationRule(tenant,ruleId).state,'NOT_STARTED');
});
test('recent history remains bounded to existing 128 slots; evicted own visit is unknown, not durable absence',async()=>{
 const q=model();q.setUnclaimed();const runtime=q.worker.startScopedAutomationWorker();
 for(let batch=0;batch<5;batch++){q.setRows(Array.from({length:26},(_,n)=>({tenant_id:tenant,id:id(100+batch*26+n)})));q.kick();await until(()=>runtime.inspect().active===0);}
 assert.equal(runtime.inspect().outcomes.length,128);assert.equal(q.worker.inspectScopedAutomationRule(tenant,id(100)).last_cycle,null);assert.equal(q.worker.inspectScopedAutomationRule(tenant,id(229)).last_cycle.outcome,'NO_UNATTEMPTED_JOB');
 assert.equal(q.queries.length,5);assert(q.queries.every(s=>s.startsWith('SELECT')&&s.includes('LIMIT 32')));assert.equal(q.claims.length,130);await runtime.close();
});
test('multiple local loops refuse a fabricated single runtime, unavailable app masks all RAM facts',async()=>{
 const q=model(),a=q.worker.startScopedAutomationWorker(),b=q.worker.startScopedAutomationWorker();assert.deepEqual(q.worker.inspectScopedAutomationRule(tenant,ruleId),{state:'AMBIGUOUS_RUNTIME',started:null,draining:null,current_busy:null,last_cycle:null,ram_only:true});
 assert.equal(q.worker.inspectScopedAutomationRule(tenant,ruleId,false).state,'NOT_STARTED');await a.close();assert.equal(q.worker.inspectScopedAutomationRule(tenant,ruleId).state,'RUNNING');await b.close();
});
function routeModel(q:ReturnType<typeof model>,unresolved:any=async()=>({scope:'ALL_OWN_RULE_RUNS',data:[],has_more:false,next_cursor:null})){
 const gets=new Map<string,any>(),sqls:string[]=[],telemetryCalls:any[]=[],unresolvedCalls:any[]=[];let role='admin',own=true,active=true;
 const c={query:async(sql:string,args:any[])=>{sqls.push(sql);if(sql.includes('packing_current_role'))return{rows:[{role}]};if(sql.includes('SELECT * FROM automation_rules')){assert.deepEqual(args,[tenant,ruleId]);return{rows:[{id:ruleId,actor_id:own?owner:id(99),version:'4',config:{local_worker:{enabled:active}}}]};}if(sql.includes('FROM jobs')||sql.includes('FROM automation_runs'))return{rows:[]};throw Error(sql);}};
 const control=load('local-automation-worker-control',{
  './db':{tenantReadTx:async(t:string,fn:any)=>{assert.equal(t,tenant);return fn(c);},tenantTx:async()=>{assert.fail('No write transaction');}},'./domain':{audit:()=>assert.fail('No audit write')},
  './local-automation-worker-policy':{WORKER_SCHEMA:'owned-automatic-rule/v1',activationForRule:()=>active?{}:null},'./operation-schema':{},
  './automation-local-effects':{AUTOMATIC_STOCK_JOB:'automation.local_stock',readAutomaticEffectsPage:async()=>({effects:new Map(),coverage:{per_kind_limit:500,stock_truncated:false,email_truncated:false}}),readAutomaticRuleReconciliation:async()=>({scope:'ALL_OWN_RULE_RUNS',required:false,stock_required:false,email_required:false})},
  './automation-unresolved-effects':{readUnresolvedAutomaticEffects:async(c:any,t:string,r:string,input:any)=>{unresolvedCalls.push([t,r,input]);return unresolved(c,t,r,input);}},
  './scoped-automation-worker':{inspectScopedAutomationRule:(...args:any[])=>{telemetryCalls.push(args);return q.worker.inspectScopedAutomationRule(...args);}},
 });
 const app={server:{listening:true},get:(path:string,handler:any)=>gets.set(path,handler),post:()=>{}};
 control.registerAutomaticWorkerControl(app,{readOnly:false,available:true});
 const get=(patch:any={})=>gets.get('/api/automations/:id/local-worker')({actor:{tenantId:tenant,userId:owner,role:'admin',...patch.actor},params:{id:ruleId},...patch});
 return{get,app,sqls,telemetryCalls,unresolvedCalls,setRole:(v:string)=>{role=v;},setOwn:(v:boolean)=>{own=v;},setActive:(v:boolean)=>{active=v;}};
}
test('actual authorized GET adds own RAM diagnostic without extra SQL; config pause is never drain acknowledgement',async()=>{
 const q=model(),route=routeModel(q);let result=await route.get();assert.equal(result.runtime.state,'NOT_STARTED');assert.equal(result.runtime.paused,null);
 const hold=q.setHold(),runtime=q.worker.startScopedAutomationWorker();q.kick();await until(()=>q.processors.length===1);result=await route.get();assert.equal(result.runtime.current_busy,true);assert.equal(result.runtime.paused,false);
 route.setActive(false);result=await route.get();assert.equal(result.runtime.paused,true);assert.equal(result.runtime.current_busy,true);assert.equal(result.runtime.pause_scope,'RULE_CONFIGURATION_ONLY_NOT_DRAIN_ACK');
 const end=runtime.close();result=await route.get();assert.equal(result.runtime.state,'DRAINING');assert.equal(result.runtime.paused,null);hold.resolve();await end;
 assert(route.sqls.every(s=>s.startsWith('SELECT')));assert.equal(route.sqls.length,16);assert(route.telemetryCalls.every(args=>args[0]===tenant&&args[1]===ruleId&&args[2]===true));
});
test('actual GET denies viewer, API key/scope, downgraded IAM and foreign owner BEFORE RAM read',async()=>{
 const q=model(),route=routeModel(q);
 for(const actor of [{tenantId:tenant,userId:owner,role:'viewer'},{tenantId:tenant,userId:owner,role:'admin',apiKeyId:id(10)}])await assert.rejects(()=>route.get({actor}));
 await assert.rejects(()=>route.get({apiScopes:['read']}));route.setRole('viewer');await assert.rejects(()=>route.get());route.setRole('admin');route.setOwn(false);await assert.rejects(()=>route.get());assert.equal(route.telemetryCalls.length,0);
});
test('actual GET cannot announce worker running merely because HTTP listener is up; stopped listener masks another loop',async()=>{
 const q=model(),route=routeModel(q);assert.equal((await route.get()).processor_running,true);assert.equal((await route.get()).runtime.started,false);
 const runtime=q.worker.startScopedAutomationWorker();route.app.server.listening=false;const result=await route.get();assert.equal(result.runtime.state,'NOT_STARTED');assert.equal(result.runtime.paused,null);await runtime.close();
});

// The actual route and both actual effects readers share a controlled SQL port.
// Only the database boundary is modeled; no alternate route/reconciliation logic.
function recoveryRouteModel({runCount=26,stockCount=0,emailCount=0,unknown='email',foreign='none'}:{runCount?:number;stockCount?:number;emailCount?:number;unknown?:string;foreign?:'none'|'tenant'|'rule'}={}){
 const queries:{sql:string;args:any[]}[]=[],allRuns=Array.from({length:runCount},(_,n)=>({id:id(200+n)}));
 const origin=allRuns.at(-1)!.id,scope={tenant_id:foreign==='tenant'?otherTenant:tenant,rule_id:foreign==='rule'?otherRule:ruleId};
 const stocks=Array.from({length:stockCount},(_,n)=>({id:id(1000+n),state:'done',payload:{run_id:allRuns[0]!.id,action:{},effect_job_id:id(9000)},plan_state:'done',phase:'done',effect_state:'done',result:{desired_applied:true},plan_payload:{stock_quantity:4}}));
 const emails=Array.from({length:emailCount},(_,n)=>({id:id(3000+n),automation_run_id:allRuns[0]!.id,state:'smtp_accepted',job_state:'done'}));
 if(unknown==='pending'){stocks.push({id:id(7002),state:'pending',payload:{run_id:origin,action:{},effect_job_id:id(9000)},plan_state:'ready',phase:'ready',effect_state:'pending',result:{desired_applied:false},plan_payload:{stock_quantity:4}});emails.push({id:id(7003),automation_run_id:origin,state:'queued',job_state:'pending'});}
 if(unknown==='email')emails.push({id:id(7000),automation_run_id:origin,state:'uncertain',job_state:'failed'});
 if(unknown==='stock')stocks.push({id:id(7001),state:'failed',payload:{run_id:origin,action:{},effect_job_id:id(9000)},plan_state:'ready',phase:'sending',effect_state:'failed',result:{desired_applied:false},plan_payload:{stock_quantity:4}});
 const c={query:async(sql:string,args:any[])=>{
  queries.push({sql,args});assert(sql.startsWith('SELECT'),'Recovery status is read-only');
  if(sql.includes('packing_current_role'))return{rows:[{role:'admin'}]};
  if(sql.includes('SELECT * FROM automation_rules'))return{rows:[{id:ruleId,actor_id:owner,version:'4',config:{}}]};
  if(sql.startsWith('SELECT j.kind'))return{rows:[]}; // Parent dispatcher/run completed before child dispatch.
  if(sql.startsWith('SELECT id FROM automation_runs')){assert.deepEqual(args,[tenant,ruleId]);assert(sql.endsWith('LIMIT 26'));return{rows:allRuns.slice(0,26)};}
  if(sql.startsWith('SELECT\n  EXISTS')){
   assert.deepEqual(args,[tenant,ruleId]);assert(!/LIMIT|created_at|enabled_at/.test(sql),'Global warning cannot be recent-page/watermark limited');
   assert.equal((sql.match(/r.tenant_id=\$1 AND r.rule_id=\$2/g)||[]).length,2);
   assert(sql.includes('j.tenant_id=r.tenant_id')&&sql.includes('(b.tenant_id,b.automation_run_id)=(r.tenant_id,r.id)'));
   assert(sql.includes("j.kind='automation.local_stock'")&&sql.includes("j.state<>'pending'"));
   assert(sql.includes('IS DISTINCT FROM true')&&sql.includes("p.result->'desired_applied'='true'::jsonb")&&sql.includes('9007199254740991')&&sql.includes('trunc('));
   assert(sql.includes("m.state='uncertain' OR j.state='running'"));
   const own=scope.tenant_id===args[0]&&scope.rule_id===args[1];return{rows:[{stock_required:own&&unknown==='stock',email_required:own&&unknown==='email'}]};
  }
  if(sql.startsWith('SELECT j.id')){assert(sql.endsWith('LIMIT 501'));return{rows:foreign!=='none'?[]:stocks.filter(r=>args[0].includes(r.payload.run_id)).slice(0,501)};}
  if(sql.startsWith('SELECT m.id')){assert(sql.endsWith('LIMIT 501'));return{rows:foreign!=='none'?[]:emails.filter(r=>args[0].includes(r.automation_run_id)).slice(0,501)};}
  throw Error('Unmodeled query '+sql);
 }};
 const realEffects=load('automation-local-effects',{'./db':{},'./offers':{},'./automation-local-channel':{}});
 const gets=new Map<string,any>(),control=load('local-automation-worker-control',{
  './db':{tenantReadTx:async(t:string,fn:any)=>{assert.equal(t,tenant);return fn(c);},tenantTx:()=>assert.fail('No mutation transaction')},'./domain':{},'./operation-schema':{},
  './local-automation-worker-policy':{WORKER_SCHEMA:'owned-automatic-rule/v1',activationForRule:()=>null},'./automation-local-effects':realEffects,
  './automation-unresolved-effects':{readUnresolvedAutomaticEffects:async()=>({scope:'ALL_OWN_RULE_RUNS',data:[],has_more:false,next_cursor:null})},
  './scoped-automation-worker':{inspectScopedAutomationRule:()=>({state:'NOT_STARTED'})},
 });
 control.registerAutomaticWorkerControl({server:{listening:true},get:(p:string,h:any)=>gets.set(p,h),post:()=>{}},{readOnly:false,available:true});
 return{queries,get:()=>gets.get('/api/automations/:id/local-worker')({actor:{tenantId:tenant,userId:owner,role:'admin'},params:{id:ruleId}})};
}
test('actual own-rule GET keeps durable unknown beyond the latest25 runs, even after opt-in removal/restart',async()=>{
 for(const unknown of ['email','stock']){
  const q=recoveryRouteModel({unknown}),r=await q.get();assert.equal(r.reconciliation_required,true);assert.deepEqual(r.child_effects,[]);
  assert.deepEqual(r.child_effects_coverage,{scope:'RECENT_OWN_RULE_RUNS',run_limit:25,runs_truncated:true,per_kind_limit:500,stock_truncated:false,email_truncated:false,reconciliation_scope:'ALL_OWN_RULE_RUNS'});
  assert.equal(r.runtime.state,'NOT_STARTED');assert.equal(r.automatic_retry,false);assert.equal(q.queries.filter(q=>q.sql.startsWith('SELECT\n  EXISTS')).length,1);
 }
});
test('actual own-rule GET keeps unknown beyond500 per-kind details and reports both independent truncation bounds',async()=>{
 for(const unknown of ['email','stock']){
  const q=recoveryRouteModel({runCount:1,stockCount:unknown==='stock'?500:0,emailCount:unknown==='email'?500:0,unknown}),r=await q.get();
  assert.equal(r.child_effects.length,500);assert(r.child_effects.every((e:any)=>!e.reconciliation_required));assert.equal(r.reconciliation_required,true);
  assert.equal(r.child_effects_coverage.runs_truncated,false);assert.equal(r.child_effects_coverage[unknown+'_truncated'],true);
 }
});
test('actual own-rule GET does not turn verified/pending or foreign-scope effects into own unresolved work',async()=>{
 for(const config of [{runCount:1,stockCount:1,emailCount:1,unknown:'none'},{runCount:1,unknown:'pending'},...(['tenant','rule'] as const).flatMap(foreign=>['email','stock'].map(unknown=>({unknown,foreign})))]){
  const q=recoveryRouteModel(config),r=await q.get();assert.equal(r.reconciliation_required,false);assert.equal(r.automatic_retry,false);
 }
});

test('actual GET authorizes current own-rule admin before unresolved anchor/query and passes only its scope',async()=>{
 const marker={scope:'ALL_OWN_RULE_RUNS',data:[],has_more:false,next_cursor:null};let actual=0;
 const q=model(),route=routeModel(q,async(_c:any,t:string,r:string,input:any)=>{actual++;assert.equal(t,tenant);assert.equal(r,ruleId);assert.deepEqual(input,{reconciliation_after:'stock:'+id(101)});return marker;});
 for(const patch of [{actor:{tenantId:tenant,userId:owner,role:'viewer'}},{apiScopes:['read']},{actor:{tenantId:tenant,userId:owner,role:'admin',apiKeyId:id(90)}}])await assert.rejects(()=>route.get(patch));
 route.setRole('viewer');await assert.rejects(()=>route.get());route.setRole('admin');route.setOwn(false);await assert.rejects(()=>route.get());assert.equal(actual,0);
 route.setOwn(true);const response=await route.get({query:{reconciliation_after:'stock:'+id(101)}});assert.equal(response.unresolved_effects,marker);assert.equal(actual,1);
 assert.deepEqual(route.unresolvedCalls,[[tenant,ruleId,{reconciliation_after:'stock:'+id(101)}]]);assert(route.sqls.every(sql=>sql.startsWith('SELECT')));
});
