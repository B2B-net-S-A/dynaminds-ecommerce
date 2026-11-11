/** Selected local repricing worker. Import is inert: no configuration, pool,
 * scheduling, provider or native construction before the genuine factory. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {OrdinaryLocalConfiguration} from './ordinary-local-runtime';
export type OrdinaryRepricingWorkerOptions={readOnly?:boolean;intervalMs?:number;drainMs?:number};
const safeError=(e:unknown)=>{try{const code=(e as any)?.code,message=(e as any)?.message;return {code:typeof code==='string'&&/^[A-Z0-9_]{1,40}$/.test(code)?code:null,message_sha256:typeof message==='string'&&Buffer.byteLength(message)<=65536?createHash('sha256').update(message).digest('hex'):null};}catch{return {code:null,message_sha256:null};}};
export async function createOrdinaryLocalRepricingWorker(input0:OrdinaryLocalConfiguration,options0:OrdinaryRepricingWorkerOptions={}){
 assert(options0&&typeof options0==='object'&&!Array.isArray(options0)&&Object.keys(options0).every(k=>['readOnly','intervalMs','drainMs'].includes(k)));
 assert(options0.readOnly===undefined||typeof options0.readOnly==='boolean');
 assert(options0.readOnly!==true,'ordinary-repricing-worker-no-readonly');
 const intervalMs=options0.intervalMs??1000,drainMs=options0.drainMs??120000;
 assert(Number.isSafeInteger(intervalMs)&&intervalMs>=1000&&intervalMs<=60000);
 assert(Number.isSafeInteger(drainMs)&&drainMs>=1000&&drainMs<=300000);
 const input=structuredClone(input0);
 // SAME factory installs resources/selects env, migrates and approves/inspects
 // real Startup. No caller flag or reconstructed actor substitutes for it.
 const factory=await import('./ordinary-local-runtime');
 const owner=await factory.createOrdinaryLocalApplication(input,{scopedAutomationEnabled:false});
 let worker:typeof import('./worker'),schedules:typeof import('./repricing-schedules');
 try{worker=await import('./worker');schedules=await import('./repricing-schedules');}
 catch(first){try{await owner.close();}catch{/* Preserve real import cause. */}throw first;}
 const selection=Object.freeze({kind:'pricing.reprice' as const});
 let closing=false,closed=false,unknown=false,loopStarted=false,timer:ReturnType<typeof setTimeout>|undefined;
 let running:Promise<boolean>|undefined,closeAttempt:Promise<void>|undefined;
 let cycles=0n,claims=0n,failed=false,first:unknown;
 const outcomes:{cycle:string;state:string;code:string|null;message_sha256:string|null}[]=[];
 const retain=(e:unknown)=>{if(!failed){failed=true;first=e;}unknown=true;closing=true;};
 function cycle():Promise<boolean>{
  if(closing)return Promise.reject(new Error('ordinary-repricing-worker-closing'));
  if(running)return running;
  const number=++cycles;
  running=(async()=>{
   try{await schedules.scheduleRepricingDue();const claimed=await worker.tick({},selection);if(claimed)claims++;
    outcomes.push({cycle:number.toString(),state:'CYCLE_RETURNED_REQUIRES_RUN_READBACK',code:null,message_sha256:null});return claimed;
   }catch(e){retain(e);outcomes.push({cycle:number.toString(),state:'CYCLE_FAILED_STOPPED_NO_AUTOREPLAY',...safeError(e)});throw e;}
   finally{if(outcomes.length>64)outcomes.shift();}
  })();
  const pending=running;void pending.then(()=>{if(running===pending)running=undefined;},()=>{if(running===pending)running=undefined;});
  return pending;
 }
 const kick=()=>{
  if(closing)return;
  void cycle().catch(()=>{/* Retained; no automatic retry after unknown/failed cycle. */}).finally(()=>{if(!closing){timer=setTimeout(kick,intervalMs);}});
 };
 function start(){assert(!closing&&!closed,'ordinary-repricing-worker-closing');if(loopStarted)return;loopStarted=true;timer=setTimeout(kick,0);}
 async function waitRunning(){
  if(!running)return;const pending=running;let deadline:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([pending,new Promise<never>((_resolve,reject)=>{deadline=setTimeout(()=>{unknown=true;reject(Object.assign(new Error('ordinary-repricing-worker-drain-unconfirmed'),{code:'DRAIN_UNCONFIRMED'}));},drainMs);})]);}
  finally{if(deadline)clearTimeout(deadline);}
 }
 function close():Promise<void>{
  closing=true;if(timer)clearTimeout(timer);if(closeAttempt)return closeAttempt;
  closeAttempt=(async()=>{
   let localFailed=false,localFirst:unknown;
   try{await waitRunning();}catch(e){localFailed=true;localFirst=failed?first:e;}
   // Timeout does not cancel a started native/provider operation. Keep its pool
   // alive; Root must drain/reap, or consciously call close after it settles.
   if(running){unknown=true;if(localFailed)throw localFirst;throw new Error('ordinary-repricing-worker-drain-unconfirmed');}
   try{await owner.close();closed=true;}catch(e){if(!localFailed){localFailed=true;localFirst=failed?first:e;}}
   if(failed&&!localFailed){localFailed=true;localFirst=first;}if(localFailed)throw localFirst;
  })();
  const current=closeAttempt;void current.catch(()=>{if(closeAttempt===current&&!closed)closeAttempt=undefined;});return current;
 }
 return Object.freeze({app:owner.app,start,cycle,close,inspect:()=>Object.freeze({scope:'pricing.reprice' as const,closing,closed,unknown,loop_started:loopStarted,active:running?1:0,cycles:cycles.toString(),claims:claims.toString(),outcomes:structuredClone(outcomes),
  global_worker_enabled:false,provider_price_publication:false,native_or_provider_success_asserted:false})});
}

// Explicit eleventh CLI: private selection path + whole SHA, no HTTP listener,
// bootstrap writes/credentials printed, or inert import side effects.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
export function parseOrdinaryRepricingWorkerArgs(args:readonly string[]){
 assert(args.length===2,'ordinary-repricing-worker-private-selection-path-sha-required');
 const [file,digest]=args;assert(path.isAbsolute(file)&&path.resolve(file)===file&&/^[a-f0-9]{64}$/.test(digest));return {file,digest};
}
async function selectedWorkerConfiguration(file:string,digest:string){
 assert.equal(await realpath(file),file);const before=await lstat(file,{bigint:true});
 assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.uid===BigInt(process.getuid!())&&(before.mode&0o777n)===0o600n&&before.size<=16384n);
 const identity=(s:typeof before)=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
 const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let failed=false;
 try{assert.equal(identity(await fd.stat({bigint:true})),identity(before));const bytes=Buffer.alloc(Number(before.size)+1);let count=0;while(count<bytes.length){const part=await fd.read(bytes,count,bytes.length-count,count);if(!part.bytesRead)break;count+=part.bytesRead;}assert.equal(BigInt(count),before.size);assert.equal(createHash('sha256').update(bytes.subarray(0,count)).digest('hex'),digest);assert.equal(identity(await fd.stat({bigint:true})),identity(before));assert.equal(identity(await lstat(file,{bigint:true})),identity(before));assert.equal(await realpath(file),file);return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes.subarray(0,count))) as OrdinaryLocalConfiguration;}
 catch(first){failed=true;throw first;}finally{try{await fd.close();}catch(close){if(!failed)throw close;}}
}
// Writable failures can arrive after write() returns (and after its callback).
// Keep this report's error listener through that event turn; reporting never
// replaces the original startup/drain failure or retries an output write.
async function reportOrdinaryWorkerFailure(status:string,error:unknown,extra:Record<string,unknown>={}){
 process.exitCode=1;
 await new Promise<void>(resolve=>{
  let completing=false;
  const complete=()=>{if(completing)return;completing=true;setImmediate(()=>{process.stderr.removeListener('error',onError);resolve();});};
  const onError=()=>complete();
  process.stderr.on('error',onError);
  try{process.stderr.write(JSON.stringify({status,...safeError(error),...extra})+'\n',complete);}catch{complete();}
 });
}
export async function ordinaryRepricingWorkerMain(args:readonly string[]){
 const {file,digest}=parseOrdinaryRepricingWorkerArgs(args);
 let runtime:Awaited<ReturnType<typeof createOrdinaryLocalRepricingWorker>>|undefined,stopping:Promise<void>|undefined,monitor:ReturnType<typeof setInterval>|undefined;
 let stopRequested=false,failed=false,first:unknown,outputFailed=false,started=false;
 let shutdown:Promise<void>|undefined;
 const remember=(error:unknown)=>{if(!failed){failed=true;first=error;}};
 const removeListeners=()=>{process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);process.stdout.removeListener('error',onOutputError);process.stderr.removeListener('error',onOutputError);};
 const stop=()=>{stopRequested=true;if(monitor)clearInterval(monitor);if(!runtime)return Promise.resolve();return stopping??=runtime.close();};
 const finishStop=()=>shutdown??=(async()=>{
  try{await stop();}catch(error){remember(error);process.exitCode=1;if(!outputFailed)await reportOrdinaryWorkerFailure('ORDINARY_REPRICING_WORKER_STOP_FAILED',first,{drain_confirmed:runtime?.inspect().closed===true});}
  finally{removeListeners();}
 })();
 const onSignal=()=>{stopRequested=true;if(started)void finishStop();};
 const onOutputError=(error:unknown)=>{outputFailed=true;remember(error);process.exitCode=1;stopRequested=true;if(started)void finishStop();};
 // Remember shutdown before reading private files or constructing the owner.
 // A signal never cancels its in-flight factory or starts a job after it returns.
 process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);process.stdout.on('error',onOutputError);process.stderr.on('error',onOutputError);
 try{
  const configuration=await selectedWorkerConfiguration(file,digest);
  if(stopRequested){removeListeners();if(failed)throw first;return;}
  runtime=await createOrdinaryLocalRepricingWorker(configuration);
  if(stopRequested){await stop();removeListeners();if(failed)throw first;return;}
  runtime.start();started=true;monitor=setInterval(()=>{if(runtime!.inspect().closing)void finishStop();},1000);
  process.stdout.write(JSON.stringify({status:'ORDINARY_LOCAL_REPRICING_WORKER_STARTED_REQUIRES_NATIVE_RUN_READBACK',scope:'pricing.reprice',global_worker_enabled:false,provider_price_publication:false})+'\n');return runtime;
 }catch(error){remember(error);try{await stop();}catch{}removeListeners();throw first;}
}

export async function ordinaryRepricingWorkerCli(args:readonly string[]){
 try{await ordinaryRepricingWorkerMain(args);}catch(first){await reportOrdinaryWorkerFailure('ORDINARY_REPRICING_WORKER_START_FAILED',first);}
}

/** Same eleventh entrypoint; the original two-argument repricing ABI is unchanged. */
export async function ordinaryLocalWorkerCli(args:readonly string[]){
 if(args[0]!=='--schedule'&&args[0]!=='--schedule-recover')return ordinaryRepricingWorkerCli(args);
 try{const schedule=await import('./ordinary-local-schedule-worker');
  if(args[0]==='--schedule-recover')await schedule.ordinaryScheduleRecoveryCli(args.slice(1));
  else await schedule.ordinaryScheduleWorkerCli(args.slice(1));}
 catch(error){await reportOrdinaryWorkerFailure('ORDINARY_SCHEDULE_WORKER_LOAD_FAILED',error);}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 void ordinaryLocalWorkerCli(process.argv.slice(2));
}
