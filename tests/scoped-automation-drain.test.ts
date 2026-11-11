/** Drain rate of the scoped rule processor (server/scoped-automation-worker.ts) with the actual
 * module and modeled ports: a pass that claimed work starts the next one at once, a pass that
 * claimed nothing (or failed) waits the 1 s tick. Claims stay one job per rule per visit. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';
const require=createRequire(import.meta.url);
function load(name:string,deps:Record<string,any>,globals:Record<string,any>){
 const code=transformSync(readFileSync(new URL('../server/'+name+'.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs',target:'es2022',supported:{'dynamic-import':false}}).code;
 const m={exports:{}};new Function('module','require',...Object.keys(globals),code)(m,(key:string)=>{
  if(key in deps)return deps[key];if(!key.startsWith('.'))return require(key);throw Error('Unmodeled '+key);
 },...Object.values(globals));return m.exports as any;
}
const id=(n:number)=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const tenantA=id(1),tenantB=id(2);
const tick=()=>new Promise<void>(r=>setImmediate(r));
/** Rules with per-rule FIFO queues; discovery honours the cursor, the tenant scope and LIMIT 32. */
function model(rules:{tenant:string;rule:string;jobs:number}[]){
 const timers:{callback:()=>void;ms:number;cancelled:boolean}[]=[],claims:string[]=[],processed:string[]=[],discoveries:any[][]=[];
 const queues=new Map(rules.map(r=>[r.tenant+':'+r.rule,Array.from({length:r.jobs},(_,n)=>r.rule.slice(0,8)+'#'+n)]));
 let failNext:'claim'|'process'|'discovery'|null=null,hold:Promise<void>|undefined;
 const pool={query:async(_sql:string,[t,r,scope]:any[])=>{
  discoveries.push([t,r,scope]);if(failNext==='discovery'){failNext=null;throw Object.assign(Error('discovery'),{code:'57014'});}
  const rows=rules.map(x=>({tenant_id:x.tenant,id:x.rule})).filter(x=>(t===null||x.tenant_id+x.id>t+r)&&(scope===null||scope.includes(x.tenant_id)))
   .sort((a,b)=>(a.tenant_id+a.id).localeCompare(b.tenant_id+b.id)).slice(0,32);
  return{rows};
 }};
 const claim=async(t:string,r:string)=>{
  if(failNext==='claim'){failNext=null;throw Object.assign(Error('claim'),{code:'40001'});}
  const job=queues.get(t+':'+r)?.shift();if(!job)return null;claims.push(job);return{job:{tenant_id:t,id:job,kind:'automation.run'},lease:{}};
 };
 const process=async(job:any)=>{if(hold)await hold;if(failNext==='process'){failNext=null;throw Object.assign(Error('process'),{code:'23514'});}processed.push(job.id);};
 const worker=load('scoped-automation-worker',{
  './db':{pool},
  './local-automation-worker-control':{claimAutomaticJob:claim,requireAutomaticLeaseInTx:async()=>{}},
  './automations':{dispatchAutomation:process,processAutomation:process,failAutomation:async()=>{}},
  './email':{processEmail:process,failEmail:async()=>{}},
  './automation-local-effects':{AUTOMATIC_STOCK_JOB:'automation.local_stock',processAutomaticStock:process},
 },{setTimeout:(callback:()=>void,ms:number)=>{const t={callback,ms,cancelled:false};timers.push(t);return{unref(){},t};},clearTimeout:(timer:any)=>{if(timer)timer.t.cancelled=true;}});
 const remaining=()=>[...queues.values()].reduce((n,q)=>n+q.length,0);
 /** Fires timers one by one, waiting for each cycle to settle. Returns the delays that were waited. */
 async function drive(runtime:any,stop:()=>boolean,max=2000){
  const waited:number[]=[];
  for(let n=0;n<max&&!stop();n++){
   const t=timers.shift();if(!t)break;if(t.cancelled)continue;waited.push(t.ms);t.callback();
   for(let i=0;i<50&&(runtime.inspect().active||!timers.length);i++)await tick();
  }
  return waited;
 }
 return{worker,timers,claims,processed,discoveries,remaining,drive,queues,
  failOnce:(v:'claim'|'process'|'discovery')=>{failNext=v;},setHold:(p:Promise<void>|undefined)=>{hold=p;}};
}
const seconds=(waited:number[])=>waited.filter(ms=>ms>=1000).length;

test('N queued jobs of one rule drain without a 1 s wait between them; idle goes back to the 1 s tick',async()=>{
 const q=model([{tenant:tenantA,rule:id(10),jobs:200}]),runtime=q.worker.startScopedAutomationWorker();
 const waited=await q.drive(runtime,()=>q.remaining()===0);
 assert.equal(q.processed.length,200);assert.deepEqual(q.processed,q.claims,'claimed and processed in the same order, one at a time');
 assert.equal(seconds(waited),0,'no 1 s tick while the rule had work');
 // The pass after the last job finds nothing and waits the full tick.
 await q.drive(runtime,()=>q.timers[0]?.ms===1000);assert.equal(q.timers[0]!.ms,1000);
 const idle=await q.drive(runtime,()=>false,5);assert.deepEqual(idle,[1000,1000,1000,1000,1000],'an idle processor keeps the 1 s tick');
 assert.equal(runtime.inspect().accepted,'200');await runtime.close();
});

test('a busy rule does not starve another tenant: each pass visits every rule once',async()=>{
 const busy=id(10),small=id(11),q=model([{tenant:tenantA,rule:busy,jobs:120},{tenant:tenantB,rule:small,jobs:3}]);
 const runtime=q.worker.startScopedAutomationWorker();
 await q.drive(runtime,()=>q.remaining()===0);
 const last=Math.max(...q.claims.map((c,i)=>c.startsWith(small.slice(0,8))?i:-1));
 assert.equal(last,5,'the 3 jobs of the second tenant are claims 2, 4 and 6: '+q.claims.slice(0,8).join(','));
 assert.equal(q.processed.length,123);await runtime.close();
});

test('more than one page of rules: an idle second page does not add a 1 s wait to the busy first page',async()=>{
 const rules=Array.from({length:40},(_,n)=>({tenant:tenantA,rule:id(100+n),jobs:n===0?50:0})),q=model(rules);
 const runtime=q.worker.startScopedAutomationWorker();const waited=await q.drive(runtime,()=>q.remaining()===0);
 assert.equal(q.processed.length,50);assert.equal(seconds(waited),0);
 assert(q.discoveries.every(([t])=>t===null||typeof t==='string'));await runtime.close();
});

test('a failed claim, attempt or discovery keeps the 1 s backoff even when the pass claimed work',async()=>{
 for(const failure of ['claim','process','discovery'] as const){
  const q=model([{tenant:tenantA,rule:id(10),jobs:6}]),runtime=q.worker.startScopedAutomationWorker();
  await q.drive(runtime,()=>q.claims.length>=2);q.failOnce(failure);
  const waited=await q.drive(runtime,()=>q.remaining()===0);
  assert.equal(seconds(waited),1,failure+': exactly one backoff tick: '+waited.join(','));
  // A failed attempt is never retried: the job is consumed, the rest still drains.
  assert.equal(q.processed.length,failure==='process'?5:6,failure);await runtime.close();
 }
});

test('close during a drain finishes the current job only and leaves the rest unclaimed',async()=>{
 const q=model([{tenant:tenantA,rule:id(10),jobs:50}]),runtime=q.worker.startScopedAutomationWorker();
 await q.drive(runtime,()=>q.claims.length>=10);
 let release!:()=>void;q.setHold(new Promise<void>(r=>{release=r;}));
 for(let n=0;n<5&&!runtime.inspect().active;n++){q.timers.shift()!.callback();for(let i=0;i<20;i++)await tick();}
 assert.equal(runtime.inspect().active,1);const claimed=q.claims.length;
 let closed=false;const end=runtime.close().then(()=>{closed=true;});for(let i=0;i<5;i++)await tick();assert(!closed,'close waits for the job in flight');
 release();await end;q.setHold(undefined);
 assert.equal(q.claims.length,claimed,'no claim after close');assert.equal(q.processed.length,claimed);
 assert(q.timers.every(x=>x.cancelled),'no timer survives close: '+q.timers.length);assert.equal(q.remaining(),50-claimed);
});

test('workspace scope is read again on every pass: a stopped workspace is not claimed in the next pass',async()=>{
 const a=id(10),b=id(11),q=model([{tenant:tenantA,rule:a,jobs:30},{tenant:tenantB,rule:b,jobs:30}]);
 const scope=new Set([tenantA,tenantB]),runtime=q.worker.startScopedAutomationWorker({},{tenants:()=>[...scope]});
 await q.drive(runtime,()=>q.claims.length>=10);scope.delete(tenantB);const before=q.claims.filter(c=>c.startsWith(b.slice(0,8))).length;
 await q.drive(runtime,()=>q.queues.get(tenantA+':'+a)!.length===0);
 assert(q.claims.filter(c=>c.startsWith(b.slice(0,8))).length<=before+1,'at most the pass already selected');
 assert(q.discoveries.slice(-3).every(([, ,s])=>JSON.stringify(s)===JSON.stringify([tenantA])));
 assert.equal(q.queues.get(tenantA+':'+a)!.length,0);await runtime.close();
});
