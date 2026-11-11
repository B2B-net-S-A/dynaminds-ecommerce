import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {Writable} from 'node:stream';
import {Problem,ensure} from '../server/errors';
const tenant='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',jobId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function evaluate(name:string,resolve:(key:string)=>any,globals:Record<string,any>={}){let source=readFileSync(new URL('../server/'+name,import.meta.url),'utf8');
 if(name==='ordinary-local-worker.ts'){const guard='if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))';assert.equal(source.split(guard).length,2);source=source.replace(guard,'if(false)');}
 const code=transformSync(source,{loader:'ts',format:'cjs',target:'es2022',supported:{'dynamic-import':false}}).code;const m={exports:{}};new Function('module','require',...Object.keys(globals),code)(m,resolve,...Object.values(globals));return m.exports as any;}
function actualTick({kind='pricing.reprice',empty=false,rollbackError=false,claimError=false,scope=null,releaseError=false,falsyClaim=false}:{kind?:string;empty?:boolean;rollbackError?:boolean;claimError?:boolean;scope?:unknown;releaseError?:boolean;falsyClaim?:boolean}={}){
 const releaseArgs:unknown[]=[],calls:string[]=[],sqls:string[]=[],primary=Object.assign(new Error('controlled claim failure'),{code:'CLAIM_TEST'}),secondary=new Error('controlled rollback failure');
 const c={query:async(sql:string,args?:any[])=>{sqls.push(sql);if(sql==='ROLLBACK'&&rollbackError)throw secondary;if(sql.startsWith('SELECT * FROM jobs'))return{rows:empty?[]:[{id:jobId,tenant_id:tenant,kind,payload:{run_id:jobId}}]};if(sql.startsWith("UPDATE jobs SET state='running'")){if(claimError)throw (falsyClaim?0:primary);assert(args&&args[0]===jobId&&/^[a-f0-9-]{36}$/.test(args[1]));return{rows:[{id:jobId,tenant_id:tenant,kind,payload:{run_id:jobId},lease_token:args[1]}]};}return{rows:[{present:false}],rowCount:0};},release:(arg?:unknown)=>{calls.push('release');releaseArgs.push(arg);if(releaseError)throw new Error('controlled release failure');}};
 const module=evaluate('worker.ts',k=>{if(k==='node:crypto')return crypto;if(k==='./errors')return{Problem,ensure};if(k==='./db')return{pool:{query:async(sql:string)=>{sqls.push('GLOBAL '+sql);return{rows:[{present:false}]};},connect:async()=>{calls.push('connect');return c;}},tenantTx:async(_t:string,fn:any)=>fn(c)};
  return new Proxy({}, {get:(_t,p:string)=>p===Symbol.toStringTag as any?undefined:p.endsWith('_JOB')?'unrelated:'+p:async(job:any)=>{calls.push(p);if(p==='processRepricing')assert(job.lease_token);}});});
 return{module,calls,sqls,primary,secondary,scope,releaseArgs};
}
test('actual pricing-only tick excludes global billing/reapers and foreign state mutations; SAME native lease claim/COMMIT/dispatch',async()=>{
 const x=actualTick();assert.equal(await x.module.tick({},Object.freeze({kind:'pricing.reprice'})),true);assert.deepEqual(x.calls,['connect','release','processRepricing']);assert.equal(x.sqls[0],'BEGIN');assert(x.sqls[1].endsWith(" AND kind='pricing.reprice'"));assert(x.sqls[2].includes(" AND kind='pricing.reprice' ORDER BY")&&x.sqls[2].includes('FOR UPDATE SKIP LOCKED'));assert(x.sqls[3].startsWith("UPDATE jobs SET state='running',attempts=attempts+1"));assert.equal(x.sqls[4],'COMMIT');assert.equal(x.sqls.length,5);
});
test('actual default worker retains original broad preamble, recovery and original claim SQL/processor',async()=>{
 const x=actualTick();await x.module.tick();assert(x.calls.includes('renewBillingDue'));assert(x.calls.includes('reapSupplierRemoteFetches'));const query=x.sqls.find(s=>s.startsWith('SELECT * FROM jobs'))!;
 // 4276940: automation.local_stock belongs to the scoped rule worker and is excluded from the broad claim too.
 assert.equal(query,"SELECT * FROM jobs WHERE state='pending' AND kind NOT IN ('catalog.ai','catalog.deepl','catalog.deepl.batch','automation.local_stock') AND run_at<=now() ORDER BY run_at,priority,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1");assert(x.sqls.some(s=>s.startsWith('UPDATE shipping_plans')));assert(x.calls.includes('processRepricing'));
});
test('actual scoped tick rejects malformed scope BEFORE any query, no job returnsfalse, foreign returned claim rollsback before dispatch',async()=>{
 for(const scope of [null,{},false,{kind:'orders.sync'},{kind:'pricing.reprice',admin:true},Object.assign(Object.create({kind:'pricing.reprice'}),{admin:true})]){const x=actualTick();await assert.rejects(()=>x.module.tick({},scope));assert.equal(x.sqls.length,0);assert.equal(x.calls.length,0);}
 const idle=actualTick({empty:true});assert.equal(await idle.module.tick({},{kind:'pricing.reprice'}),false);assert(!idle.calls.includes('processRepricing'));
 const foreign=actualTick({kind:'shipping.buy'});await assert.rejects(()=>foreign.module.tick({},{kind:'pricing.reprice'}));assert(foreign.sqls.includes('ROLLBACK'));assert(!foreign.calls.includes('processRepricing'));
});
test('actual scoped claim preserves first error through rollback refusal; default rollback behavior remains legacy',async()=>{
 const x=actualTick({claimError:true,rollbackError:true});await assert.rejects(()=>x.module.tick({},{kind:'pricing.reprice'}),e=>e===x.primary);assert.deepEqual(x.calls,['connect','release']);
 const legacy=actualTick({claimError:true,rollbackError:true});await assert.rejects(()=>legacy.module.tick(),e=>e===legacy.secondary);
});
function entry({factoryFailure,importFailure,cycleFailure,ownerFailure,hold=false}:{factoryFailure?:unknown;importFailure?:unknown;cycleFailure?:unknown;ownerFailure?:unknown;hold?:boolean}={}){
 const events:string[]=[],releases:{fn?:()=>void}={},owner={app:{source_test_only:true},close:async()=>{events.push('owner.close');if(ownerFailure!==undefined)throw ownerFailure;}};
 const loaded=evaluate('ordinary-local-worker.ts',k=>{if(k==='node:assert/strict')return assert;if(k==='node:crypto')return crypto;if(k==='node:path')return path;if(k==='node:url')return url;if(k==='node:fs')return fs;if(k==='node:fs/promises')return fsp;
  if(k==='./ordinary-local-runtime'){events.push('factory.import');return{createOrdinaryLocalApplication:async(input:any,options:any)=>{events.push('factory.construct');assert.deepEqual(options,{scopedAutomationEnabled:false});assert.equal(input.test_source_fixture,true);if(factoryFailure!==undefined)throw factoryFailure;return owner;}};}
  if(k==='./worker'){events.push('worker.import');if(importFailure!==undefined)throw importFailure;return{tick:async(ctx:any,selection:any)=>{events.push('tick');assert.deepEqual(ctx,{});assert.deepEqual(selection,{kind:'pricing.reprice'});assert(Object.isFrozen(selection));if(hold)await new Promise<void>(r=>{releases.fn=r;});if(cycleFailure!==undefined)throw cycleFailure;return true;}};}
  if(k==='./repricing-schedules'){events.push('schedule.import');return{scheduleRepricingDue:async()=>{events.push('due');}};}
  throw Error('Unexpected import '+k);});return{loaded,events,owner,releases};
}
test('actual entry import inert, options/readonly refuse before factory; genuine factory success precedes worker/db import',async()=>{
 const x=entry();assert.deepEqual(x.events,[]);for(const options of [{readOnly:true},{readOnly:'false'},{callerApproved:true},{intervalMs:0},{drainMs:0},[]])await assert.rejects(()=>x.loaded.createOrdinaryLocalRepricingWorker({test_source_fixture:true},options));assert.deepEqual(x.events,[]);
 const runtime=await x.loaded.createOrdinaryLocalRepricingWorker({test_source_fixture:true});assert.deepEqual(x.events,['factory.import','factory.construct','worker.import','schedule.import']);assert.equal(runtime.inspect().cycles,'0');await runtime.close();assert(runtime.inspect().closed);
});
test('actual entry single-flight cycle awaits actual due before SAME tick; close waits active cycle before owner',async()=>{
 const x=entry({hold:true}),r=await x.loaded.createOrdinaryLocalRepricingWorker({test_source_fixture:true});const a=r.cycle(),b=r.cycle();assert.equal(a,b);await Promise.resolve();assert.deepEqual(x.events.slice(-2),['due','tick']);let closed=false;const end=r.close().then(()=>{closed=true;});await Promise.resolve();assert(!closed);assert(!x.events.includes('owner.close'));await assert.rejects(()=>r.cycle());x.releases.fn!();await a;await end;assert(closed&&r.inspect().closed);assert.equal(r.inspect().claims,'1');assert.equal(x.events.filter(v=>v==='tick').length,1);
});
test('actual entry import/factory failures preserve primary; retained cycle failure stops autoreplay and close retains falsy cause',async()=>{
 const first=new Error('controlled import'),x=entry({importFailure:first,ownerFailure:new Error('cleanup')});await assert.rejects(()=>x.loaded.createOrdinaryLocalRepricingWorker({test_source_fixture:true}),e=>e===first);assert(x.events.includes('owner.close'));
 const y=entry({factoryFailure:first});await assert.rejects(()=>y.loaded.createOrdinaryLocalRepricingWorker({test_source_fixture:true}),e=>e===first);assert(!y.events.includes('worker.import'));
 const z=entry({cycleFailure:0}),r=await z.loaded.createOrdinaryLocalRepricingWorker({test_source_fixture:true});await assert.rejects(()=>r.cycle(),e=>e===0);assert(r.inspect().closing&&r.inspect().unknown);await assert.rejects(()=>r.cycle());await assert.rejects(()=>r.close(),e=>e===0);assert(r.inspect().closed);assert.equal(z.events.filter(v=>v==='tick').length,1);
});
test('actual bounded drain refuses while flight still active without closing pool; conscious later close after settlement succeeds',async()=>{
 const x=entry({hold:true}),r=await x.loaded.createOrdinaryLocalRepricingWorker({test_source_fixture:true},{drainMs:1000}),flight=r.cycle();await Promise.resolve();await assert.rejects(()=>r.close(),(e:any)=>e.code==='DRAIN_UNCONFIRMED');assert.equal(r.inspect().closed,false);assert.equal(r.inspect().unknown,true);assert(!x.events.includes('owner.close'));x.releases.fn!();await flight;await r.close();assert.equal(r.inspect().closed,true);assert.equal(x.events.filter(v=>v==='tick').length,1);
});
test('actual standalone CLI parser takes only canonical private-selection path+SHA, no port/flags/secret payload',()=>{
 const x=entry();assert.deepEqual(x.loaded.parseOrdinaryRepricingWorkerArgs(['/owned/configuration.private.json','a'.repeat(64)]),{file:'/owned/configuration.private.json',digest:'a'.repeat(64)});for(const args of [[],['relative','a'.repeat(64)],['/owned/../config','a'.repeat(64)],['/owned/config','bad'],['/owned/config','a'.repeat(64),'--admin']])assert.throws(()=>x.loaded.parseOrdinaryRepricingWorkerArgs(args));assert.equal(x.events.length,0);
});
test('actual automatic loop start is idempotent and close prevents another cycle while draining started job',async()=>{
 const x=entry({hold:true}),r=await x.loaded.createOrdinaryLocalRepricingWorker({test_source_fixture:true});r.start();r.start();await new Promise(done=>setTimeout(done,20));assert.equal(x.events.filter(v=>v==='due').length,1);assert.equal(x.events.filter(v=>v==='tick').length,1);const end=r.close();await Promise.resolve();assert(!x.events.includes('owner.close'));x.releases.fn!();await end;await new Promise(done=>setTimeout(done,1050));assert.equal(x.events.filter(v=>v==='tick').length,1);assert(r.inspect().closed&&r.inspect().loop_started);
});

test('actual scoped unconfirmed rollback disposes client, preserves arbitrary first cause even release throws; confirmed/default release unchanged',async()=>{
 const unknown=actualTick({claimError:true,rollbackError:true});await assert.rejects(()=>unknown.module.tick({},{kind:'pricing.reprice'}),e=>e===unknown.primary);assert.deepEqual(unknown.releaseArgs,[true]);assert(!unknown.calls.includes('processRepricing'));
 const broken=actualTick({claimError:true,rollbackError:true,releaseError:true});await assert.rejects(()=>broken.module.tick({},{kind:'pricing.reprice'}),e=>e===broken.primary);assert.deepEqual(broken.releaseArgs,[true]);
 const falsy=actualTick({claimError:true,rollbackError:true,releaseError:true,falsyClaim:true});await assert.rejects(()=>falsy.module.tick({},{kind:'pricing.reprice'}),e=>e===0);assert.deepEqual(falsy.releaseArgs,[true]);
 const confirmed=actualTick({claimError:true});await assert.rejects(()=>confirmed.module.tick({},{kind:'pricing.reprice'}),e=>e===confirmed.primary);assert.deepEqual(confirmed.releaseArgs,[undefined]);
 const healthy=actualTick();await healthy.module.tick({},{kind:'pricing.reprice'});assert.deepEqual(healthy.releaseArgs,[undefined]);
 const legacy=actualTick({claimError:true,rollbackError:true});await assert.rejects(()=>legacy.module.tick(),e=>e===legacy.secondary);assert.deepEqual(legacy.releaseArgs,[undefined]);
 const releaseOnly=actualTick({empty:true,releaseError:true});await assert.rejects(()=>releaseOnly.module.tick({},{kind:'pricing.reprice'}),e=>(e as Error).message==='controlled release failure');assert.deepEqual(releaseOnly.releaseArgs,[undefined]);
});

// The real CLI and private-file reader run with only explicit IO/timer/process
// ports. No genuine factory, database, listener, credential file or signal runs.
function cliModel({readHold=false,factoryHold=false,closeHold=false,factoryFailure,closeFailure,stderrFailure,selectionGrowth=false,selectionShrink=false,selectionReadFailure,selectionCloseFailure}:{readHold?:boolean;factoryHold?:boolean;closeHold?:boolean;factoryFailure?:unknown;closeFailure?:unknown;stderrFailure?:Error;selectionGrowth?:boolean;selectionShrink?:boolean;selectionReadFailure?:unknown;selectionCloseFailure?:unknown}={}){
 const events:string[]=[],stdout:string[]=[],stderr:string[]=[],timers:{callback:()=>void;cancelled:boolean}[]=[],intervals:{callback:()=>void;cancelled:boolean}[]=[];
 const gate=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};};
 const read=gate(),factory=gate(),close=gate();
 const bytes=Buffer.from(JSON.stringify({test_source_fixture:true})),file='/owned/worker-selection.private.json',digest=crypto.createHash('sha256').update(bytes).digest('hex');
 const reads:{length:number;position:number;allocation:number;returned:number}[]=[],wire=selectionGrowth?Buffer.concat([bytes,Buffer.alloc(1024*1024,0x20)]):selectionShrink?bytes.subarray(0,bytes.length-1):bytes;let readStarted=false;
 const stat={dev:1n,ino:2n,mode:0o100600n,uid:501n,nlink:1n,size:BigInt(bytes.length),mtimeNs:3n,ctimeNs:4n,isFile:()=>true,isSymbolicLink:()=>false};
 const proc=Object.assign(new EventEmitter(),{argv:[],exitCode:undefined as number|undefined,getuid:()=>501,
  stdout:Object.assign(new EventEmitter(),{write:(s:string)=>{stdout.push(s);return true;}}),
  stderr:new Writable({write(chunk,_encoding,callback){stderr.push(String(chunk));queueMicrotask(()=>callback(stderrFailure));}})});
 const owner={app:{source_test_only:true},close:async()=>{events.push('owner.close');if(closeHold)await close.promise;if(closeFailure!==undefined)throw closeFailure;}};
 const loaded=evaluate('ordinary-local-worker.ts',k=>{
  if(k==='node:assert/strict')return assert;if(k==='node:crypto')return crypto;if(k==='node:path')return path;if(k==='node:url')return url;if(k==='node:fs')return{constants:fs.constants};
  if(k==='node:fs/promises')return{realpath:async(p:string)=>p,lstat:async()=>stat,open:async()=>({stat:async()=>stat,read:async(buffer:Buffer,offset:number,length:number,position:number)=>{if(!readStarted){readStarted=true;events.push('selection.read');if(readHold)await read.promise;}if(selectionReadFailure!==undefined)throw selectionReadFailure;const returned=Math.max(0,Math.min(length,wire.length-position));wire.copy(buffer,offset,position,position+returned);reads.push({length,position,allocation:buffer.length,returned});return{bytesRead:returned,buffer};},readFile:async()=>assert.fail('Unbounded private-file read is forbidden'),close:async()=>{events.push('selection.close');if(selectionCloseFailure!==undefined)throw selectionCloseFailure;}})};
  if(k==='./ordinary-local-runtime')return{createOrdinaryLocalApplication:async(input:any,options:any)=>{events.push('factory');assert.deepEqual(input,{test_source_fixture:true});assert.deepEqual(options,{scopedAutomationEnabled:false});if(factoryHold)await factory.promise;if(factoryFailure!==undefined)throw factoryFailure;return owner;}};
  if(k==='./worker')return{tick:async()=>{events.push('tick');return true;}};
  if(k==='./repricing-schedules')return{scheduleRepricingDue:async()=>{events.push('due');}};
  throw Error('Unmodeled CLI dependency '+k);
 },{process:proc,setTimeout:(callback:()=>void)=>{const t={callback,cancelled:false};timers.push(t);return t;},clearTimeout:(t:any)=>{t.cancelled=true;},setInterval:(callback:()=>void)=>{const t={callback,cancelled:false};intervals.push(t);return t;},clearInterval:(t:any)=>{t.cancelled=true;}});
 const detached=()=>{for(const signal of['SIGINT','SIGTERM'])assert.equal(proc.listenerCount(signal),0);assert.equal(proc.stdout.listenerCount('error'),0);assert.equal(proc.stderr.listenerCount('error'),0);};
 return{main:()=>loaded.ordinaryRepricingWorkerMain([file,digest]),cli:()=>loaded.ordinaryRepricingWorkerCli([file,digest]),events,stdout,stderr,proc,timers,intervals,read,factory,close,detached,reads,selectionBytes:bytes.length};
}
async function cliUntil(condition:()=>boolean){for(let n=0;n<200;n++){if(condition())return;await Promise.resolve();}assert.fail('Controlled CLI did not reach boundary');}
test('actual CLI remembers stop during private selection; closes file and never constructs or starts a worker',async()=>{
 for(const signal of['SIGINT','SIGTERM']){
  const q=cliModel({readHold:true}),flight=q.main();await cliUntil(()=>q.events.includes('selection.read'));assert.equal(q.proc.listenerCount(signal),1);
  q.proc.emit(signal);q.proc.emit(signal);q.read.release();assert.equal(await flight,undefined);assert.deepEqual(q.events,['selection.read','selection.close']);assert.equal(q.stdout.length,0);assert.equal(q.timers.length,0);q.detached();
 }
});
test('actual CLI remembers stop during factory and drains returned owner once without schedule, claim or started acknowledgement',async()=>{
 const q=cliModel({factoryHold:true,closeHold:true}),flight=q.main();await cliUntil(()=>q.events.includes('factory'));q.proc.emit('SIGTERM');q.proc.emit('SIGINT');q.factory.release();await cliUntil(()=>q.events.includes('owner.close'));
 let settled=false;void flight.then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);assert.equal(q.events.filter(v=>v==='owner.close').length,1);assert.equal(q.stdout.length,0);assert.equal(q.timers.length,0);q.close.release();assert.equal(await flight,undefined);q.detached();assert.equal(q.proc.exitCode,undefined);
});
test('actual CLI startup failure preserves falsy primary through shutdown and releases its own handlers',async()=>{
 const q=cliModel({factoryHold:true,factoryFailure:0}),flight=q.main();await cliUntil(()=>q.events.includes('factory'));q.proc.emit('SIGTERM');q.factory.release();await assert.rejects(flight,e=>e===0);assert.equal(q.events.filter(v=>v==='owner.close').length,0);assert.equal(q.stdout.length,0);q.detached();
 const badClose=new Error('controlled close'),r=cliModel({factoryHold:true,closeFailure:badClose}),f=r.main();await cliUntil(()=>r.events.includes('factory'));r.proc.emit('SIGTERM');r.factory.release();await assert.rejects(f,e=>e===badClose);assert.equal(r.events.filter(v=>v==='owner.close').length,1);r.detached();
});
test('actual CLI output failure during factory is retained, drains once and never starts automatic work',async()=>{
 const primary=Object.assign(new Error('controlled private output failure'),{code:'EPIPE'}),q=cliModel({factoryHold:true,closeFailure:new Error('secondary close')}),flight=q.main();await cliUntil(()=>q.events.includes('factory'));
 q.proc.stdout.emit('error',primary);q.factory.release();await assert.rejects(flight,e=>e===primary);assert.equal(q.proc.exitCode,1);assert.equal(q.events.filter(v=>v==='owner.close').length,1);assert.equal(q.stdout.length,0);assert.equal(q.stderr.length,0);q.detached();
});
test('actual CLI running stop cancels the next cycle and monitor, drains once and removes only its own handlers',async()=>{
 const q=cliModel({closeHold:true}),foreign=()=>{};q.proc.on('SIGTERM',foreign);const runtime=await q.main();assert(runtime);assert.equal(q.stdout.length,1);assert.equal(q.timers.length,1);assert.equal(q.intervals.length,1);
 q.proc.emit('SIGTERM');q.proc.emit('SIGINT');await cliUntil(()=>q.events.includes('owner.close'));assert(q.timers[0]!.cancelled&&q.intervals[0]!.cancelled);q.close.release();await cliUntil(()=>q.proc.listenerCount('SIGINT')===0);assert.equal(q.proc.listenerCount('SIGTERM'),1);assert.equal(q.proc.listeners('SIGTERM')[0],foreign);assert.equal(q.events.filter(v=>v==='owner.close').length,1);assert(!q.events.includes('tick'));q.proc.removeListener('SIGTERM',foreign);q.detached();
});

test('actual CLI stop diagnostic survives asynchronous Writable error after owner close failure, preserving the primary',async()=>{
 const primary=Object.assign(new Error('controlled owner close failure'),{code:'OWNER_CLOSE'}),secondary=Object.assign(new Error('controlled broken stderr'),{code:'EPIPE'});
 const q=cliModel({closeFailure:primary,stderrFailure:secondary});await q.main();
 q.proc.emit('SIGTERM');q.proc.emit('SIGINT');
 await new Promise<void>(resolve=>setImmediate(resolve));
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(q.events.filter(v=>v==='owner.close').length,1);assert.equal(q.stderr.length,1);
 const diagnostic=JSON.parse(q.stderr[0]!);assert.equal(diagnostic.status,'ORDINARY_REPRICING_WORKER_STOP_FAILED');assert.equal(diagnostic.code,'OWNER_CLOSE');assert.equal(diagnostic.message_sha256,crypto.createHash('sha256').update(primary.message).digest('hex'));assert.equal(diagnostic.drain_confirmed,false);
 assert.equal(q.proc.exitCode,1);q.detached();
});
test('actual CLI entrypoint protects asynchronous stderr failure after startup cleanup and preserves falsy startup cause',async()=>{
 for(const primary of[Object.assign(new Error('controlled factory failure'),{code:'FACTORY_FAIL'}),0]){
  const q=cliModel({factoryFailure:primary,stderrFailure:Object.assign(new Error('secondary output'),{code:'EPIPE'})});await q.cli();
  assert.equal(q.stderr.length,1);const diagnostic=JSON.parse(q.stderr[0]!);assert.equal(diagnostic.status,'ORDINARY_REPRICING_WORKER_START_FAILED');assert.equal(diagnostic.code,primary===0?null:'FACTORY_FAIL');assert.equal(q.events.filter(v=>v==='owner.close').length,0);assert.equal(q.proc.exitCode,1);q.detached();
 }
});
test('actual CLI private selection uses original-size+1 bounded reads and an EOF sentinel before factory',async()=>{
 const q=cliModel(),runtime=await q.main();assert(runtime);assert.equal(q.reads.length,2);assert.deepEqual(q.reads,[{length:q.selectionBytes+1,position:0,allocation:q.selectionBytes+1,returned:q.selectionBytes},{length:1,position:q.selectionBytes,allocation:q.selectionBytes+1,returned:0}]);assert.equal(q.events.filter(x=>x==='factory').length,1);q.proc.emit('SIGTERM');await cliUntil(()=>q.proc.listenerCount('SIGINT')===0);q.detached();
});
for(const kind of['growth','shrink']as const)test('actual CLI refuses selection '+kind+' after lstat without unbounded allocation, factory or worker start',async()=>{
 const q=cliModel({selectionGrowth:kind==='growth',selectionShrink:kind==='shrink'});await assert.rejects(q.main());assert.equal(q.events.filter(x=>x==='selection.close').length,1);assert(!q.events.includes('factory')&&!q.events.includes('tick'));assert.equal(q.stdout.length,0);assert.equal(q.timers.length,0);assert(q.reads.length>=1&&q.reads.length<=2);assert(q.reads.every(r=>r.allocation===q.selectionBytes+1&&r.length<=q.selectionBytes+1));assert.equal(q.reads.reduce((n,r)=>n+r.returned,0),kind==='growth'?q.selectionBytes+1:q.selectionBytes-1);q.detached();
});
test('actual bounded selection preserves its read failure, including falsy cause, over secondary close failure',async()=>{
 for(const primary of[Object.assign(Error('owned read failure'),{code:'EIO'}),0]){const q=cliModel({selectionReadFailure:primary,selectionCloseFailure:Error('secondary close')});await assert.rejects(q.main(),e=>e===primary);assert.equal(q.events.filter(x=>x==='selection.close').length,1);assert(!q.events.includes('factory'));q.detached();}
 const close=Error('only selection close failure'),q=cliModel({selectionCloseFailure:close});await assert.rejects(q.main(),e=>e===close);assert(!q.events.includes('factory'));q.detached();
});
