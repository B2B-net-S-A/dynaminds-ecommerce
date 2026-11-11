/** Monotonic closed-loop HTTP executor. Import-inert; no DB, app factory or admission claim. */
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
export const SCALE_SLOTS=Object.freeze(['A','B','C','D','E']);
export const SCALE_OPERATIONS=Object.freeze({order_list:'read',catalog_search:'read',order_detail:'read',order_create:'write',reserve_and_status:'write',payment_or_document:'write',stock_operation:'write',return_receive:'write'});
export const realScaleClock=Object.freeze({now:()=>performance.now(),wait:(ms,signal)=>new Promise(resolve=>{let timer;const done=()=>{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();else timer=setTimeout(done,ms);}),setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:(timer)=>clearTimeout(timer)});
const safeCount=n=>assert(Number.isSafeInteger(n)&&n>=0,'finite-counter-required');
function histogram(){let count=0,max=0;const bins=new Map();return{add(ms){assert(Number.isFinite(ms)&&ms>=0);const upper=ms>10000?Infinity:ms<=1000?Math.ceil(ms):Math.ceil(ms/10)*10;bins.set(upper,(bins.get(upper)??0)+1);count++;max=Math.max(max,ms);},report(){const sorted=[...bins].sort((a,b)=>a[0]-b[0]);const q=f=>{if(!count)return null;const target=Math.ceil(count*f);let seen=0;for(const[value,n]of sorted){seen+=n;if(seen>=target)return Number.isFinite(value)?value:null;}};return{count,p50_ms:q(.5),p95_ms:q(.95),p99_ms:q(.99),max_ms:max,overflow_count:bins.get(Infinity)??0,bins:sorted.map(([upper,n])=>[Number.isFinite(upper)?upper:null,n]),quantiles:'upper_bucket_bounds; <=1ms below1s, <=10ms through10s; nonempty null quantile/bucket means overflow beyond10s'};}};}
export function validateScaleExecutionConfig(config){
 assert(config&&typeof config==='object');const t=config.timing,h=config.http;
 assert(t&&h&&Number.isSafeInteger(t.warmup_seconds)&&t.warmup_seconds>=0&&t.warmup_seconds<=600);
 assert(Array.isArray(t.measurement_phases)&&t.measurement_phases.length===2);
 assert(t.measurement_phases[0].id==='steady12'&&t.measurement_phases[0].http_clients===12&&t.measurement_phases[1].id==='steady24'&&t.measurement_phases[1].http_clients===24);
 for(const p of t.measurement_phases)assert(Number.isSafeInteger(p.duration_seconds)&&p.duration_seconds>0&&p.duration_seconds<=1800);
 assert.equal(t.measurement_seconds,t.measurement_phases.reduce((n,p)=>n+p.duration_seconds,0));
 assert.equal(h.timeouts_ms.driver_request,10000);assert.equal(h.payload.request_bytes_max,65536);assert.equal(h.payload.response_bytes_max,1048576);
 assert.deepEqual(Object.keys(h.tenant_share_percent).sort(),SCALE_SLOTS);assert(SCALE_SLOTS.every(s=>h.tenant_share_percent[s]===20));
 assert.equal(h.mix.length,8);assert.deepEqual(h.mix.map(m=>m.id).sort(),Object.keys(SCALE_OPERATIONS).sort());assert.equal(h.mix.reduce((n,m)=>n+m.percent,0),100);
 for(const m of h.mix)assert(m.class===SCALE_OPERATIONS[m.id]&&Number.isInteger(m.percent)&&m.percent>0);
 return structuredClone(config);
}
export function validateScaleOperationPorts(ports){
 assert(ports&&typeof ports==='object'&&!Array.isArray(ports),'complete-five-tenant-operation-ports-required');assert.deepEqual(Object.keys(ports).sort(),SCALE_SLOTS);
 for(const slot of SCALE_SLOTS){assert.deepEqual(Object.keys(ports[slot]).sort(),Object.keys(SCALE_OPERATIONS).sort());for(const op of Object.keys(SCALE_OPERATIONS)){const p=ports[slot][op];assert(p&&Object.keys(p).sort().join(',')==='complete,prepare'&&typeof p.prepare==='function'&&typeof p.complete==='function','complete-eight-operation-ports-required');}}
 return ports;
}
/** prepare and execute must do one measured HTTP attempt; no retry is performed here.
 * The CLI owns real fetch/abort and source-pinned synchronous request/DTO ports.
 * Metrics are executor evidence only. Background/dataset/correctness gates remain separate. */
export async function runFullBaseScaleExecutor({config,prepare,execute,onIntent,onSample,clock=realScaleClock,signal,runId}){
 const c=validateScaleExecutionConfig(config);for(const fn of[prepare,execute,onIntent,onSample])assert.equal(typeof fn,'function');assert(typeof runId==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(runId));
 const phases=[{id:'warmup',duration_seconds:c.timing.warmup_seconds,http_clients:12,measured:false},...c.timing.measurement_phases.map(p=>({...p,measured:true}))];
 let offset=0;for(const p of phases){p.start_ms=offset;offset+=p.duration_seconds*1000;p.end_ms=offset;}
 const totalMs=offset,start=clock.now(),secondCount=Math.ceil(totalMs/1000),windows=Array.from({length:secondCount},()=>({peak:0,inflight_ms:0}));
 const hist=new Map(),counts=Object.fromEntries(phases.map(p=>[p.id,{scheduled:0,started:0,completed:0,success:0,expected_refusal:0,failure:0,not_dispatched:0,cross_boundary:0}]));
 const activeMs=Object.fromEntries(phases.map(p=>[p.id,Array(24).fill(0)])),busy=new Map();let last=0,inflight=0,peak=0,sequence=0,stopped=false,first,hasError=false;
 const waits=new AbortController(),abortWaits=()=>waits.abort();signal?.addEventListener('abort',abortWaits,{once:true});
 const stop=error=>{stopped=true;waits.abort();if(!hasError){hasError=true;first=error;}};
 const elapsed=()=>{const v=clock.now()-start;assert(Number.isFinite(v)&&v>=last,'monotonic-clock-required');return v;};
 function advance(at){
  assert(at>=last);const bounded=Math.min(at,totalMs);let from=Math.min(last,totalMs);
  while(from<bounded){const second=Math.floor(from/1000),end=Math.min(bounded,(second+1)*1000);windows[second].peak=Math.max(windows[second].peak,inflight);windows[second].inflight_ms+=(end-from)*inflight;from=end;}
  last=at;
 }
 function markBegin(client,at){advance(at);assert(!busy.has(client),'one-actual-request-per-client');busy.set(client,at);inflight++;peak=Math.max(peak,inflight);if(at<totalMs)windows[Math.floor(at/1000)].peak=Math.max(windows[Math.floor(at/1000)].peak,inflight);}
 function markEnd(client,at){advance(at);const began=busy.get(client);assert(began!==undefined);for(const p of phases)activeMs[p.id][client]+=Math.max(0,Math.min(at,p.end_ms)-Math.max(began,p.start_ms));busy.delete(client);inflight--;}
 const cycle=c.http.mix.flatMap(m=>Array(m.percent).fill(m.id));
 const phaseAt=at=>phases.find(p=>at>=p.start_ms&&at<p.end_ms);
 async function clientLoop(client){
  while(!stopped&&!signal?.aborted){
   const at=elapsed(),p=phaseAt(at);if(!p)return;
   if(client>=p.http_clients){const next=phases.find(x=>x.start_ms>at&&client<x.http_clients);if(!next)return;await clock.wait(next.start_ms-at,waits.signal);continue;}
   const n=sequence++;safeCount(sequence);const task=Object.freeze({request_id:runId+':'+n,sequence:n,client,tenant_slot:SCALE_SLOTS[n%5],operation:cycle[Math.floor(n/5)%100],phase:p.id,measured:p.measured});counts[p.id].scheduled++;
   let request;
   try{request=prepare(task);assert(!request||typeof request.then!=='function','synchronous-prepare-no-hidden-http-required');await onIntent(task,request);}catch(error){stop(error);return;}
   // A stopped/aborted peer never authorizes another request, even if intent IO completed.
   if(stopped||signal?.aborted||elapsed()>=p.end_ms){counts[p.id].not_dispatched++;const at=elapsed();await onSample(Object.freeze({...task,start_ms:at,end_ms:at,duration_ms:0,http_status:null,outcome:'not_dispatched',reason:stopped||signal?.aborted?'EXECUTOR_STOPPED':'PHASE_BOUNDARY',attempted:false}));if(stopped||signal?.aborted)return;counts[p.id].cross_boundary++;continue;}
   const began=elapsed(),controller=new AbortController();let timedOut=false;const abort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted)controller.abort(signal.reason);
   const timer=clock.setTimer(()=>{timedOut=true;controller.abort(new Error('scale-http-deadline'));},c.http.timeouts_ms.driver_request);
   counts[p.id].started++;markBegin(client,began);let outcome='failure',status=null,reason=null,terminalError;
   try{const result=await execute(task,request,controller.signal);assert(result&&['success','expected_refusal','failure'].includes(result.outcome)&&Number.isInteger(result.http_status)&&result.http_status>=100&&result.http_status<=599,'bounded-http-outcome-required');status=result.http_status;outcome=result.outcome;assert(outcome!=='success'||status>=200&&status<300,'success-requires-2xx');assert(outcome!=='expected_refusal'||status===409,'only-labelled-409-refusal');reason=result.reason??null;assert(reason===null||typeof reason==='string'&&/^[A-Z0-9_]{1,80}$/.test(reason));if(timedOut||controller.signal.aborted){outcome='failure';reason=timedOut?'HTTP_TIMEOUT':'HTTP_ABORTED';}if(outcome==='failure')terminalError=new Error('scale-unexpected-http-outcome');}
   catch(error){outcome='failure';terminalError=error;reason=timedOut?'HTTP_TIMEOUT':controller.signal.aborted?'HTTP_ABORTED':status===null?'HTTP_UNCONFIRMED':'HTTP_RESPONSE_INVALID';}
   finally{clock.clearTimer(timer);signal?.removeEventListener('abort',abort);}
   const ended=elapsed();markEnd(client,ended);const duration=ended-began;if(timedOut||duration>=c.http.timeouts_ms.driver_request){outcome='failure';reason='HTTP_TIMEOUT';controller.abort(new Error('scale-http-deadline'));terminalError??=new Error('scale-http-deadline');}counts[p.id].completed++;counts[p.id][outcome]++;if(ended>p.end_ms)counts[p.id].cross_boundary++;
   const bucket=p.id+':'+task.tenant_slot+':'+task.operation+':'+outcome;if(!hist.has(bucket))hist.set(bucket,histogram());hist.get(bucket).add(duration);
   const sample=Object.freeze({...task,start_ms:began,end_ms:ended,duration_ms:duration,http_status:status,outcome,reason});
   if(terminalError)stop(terminalError);
   try{await onSample(sample);}catch(error){stop(error);return;}
   if(terminalError)return;
  }
 }
 const workers=await Promise.allSettled(Array.from({length:24},(_,n)=>clientLoop(n).catch(error=>{stop(error);throw error;})));for(const r of workers)if(r.status==='rejected')stop(r.reason);
 const ended=elapsed();advance(ended);signal?.removeEventListener('abort',abortWaits);assert.equal(inflight,0);
 const report={schema:'dynaminds-full-base-scale-http-executor/v1',status:hasError?'FAILED_HTTP_EXECUTOR':signal?.aborted?'STOPPED_HTTP_EXECUTOR':'HTTP_EXECUTOR_COMPLETE_NOT_FULL_PROFILE',execution_performed:true,full_profile_measurement:false,scale_acceptance:false,provider_acceptance:false,expected_duration_ms:totalMs,elapsed_ms:ended,measurement_seconds:c.timing.measurement_seconds,warmup_excluded_from_measurement:true,actual_peak_inflight:peak,counts,phases:phases.map(p=>({id:p.id,measured:p.measured,planned_start_ms:p.start_ms,planned_end_ms:p.end_ms,http_clients:p.http_clients,client_active_ms:activeMs[p.id].slice(0,p.http_clients)})),histograms:Object.fromEntries([...hist].map(([k,v])=>[k,v.report()])),one_second_windows:windows,limitations:['HTTP executor only; dataset/native ledger, workers/import/sync, server ingress overlap, resources, cold starts and recovery not measured or accepted.','Per-request histograms include failures separately; phase membership is request-start time; cross-boundary completions remain recorded.','Synchronous source-pinned prepare/complete ports must not open hidden IO; all measured network IO belongs to execute.']};
 if(hasError){const error=new Error('FULL_BASE_SCALE_HTTP_EXECUTOR_FAILED',{cause:first});Object.defineProperty(error,'scaleReport',{value:report});throw error;}
 return report;
}
