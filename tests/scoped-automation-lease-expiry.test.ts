/** Load-test dry run 27.10 (docs/scale/LOAD-TEST-DRYRUN-20261027.md §3): an `automation.run` job stayed `running`
 * with its lease and a `queued` run, and failed runs said only „Błąd wykonania automatyzacji”. Actual modules with
 * modeled ports: a failure records its cause, and the scoped processor finishes an expired single-attempt lease
 * as failed with a cause instead of leaving it running (never pending again: no repeat). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';
const require=createRequire(import.meta.url);
const errors=require('../server/errors'),{Problem}=errors;
function load(name:string,deps:Record<string,any>,globals:Record<string,any>={}){
 const code=transformSync(readFileSync(new URL('../server/'+name+'.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs',target:'es2022',supported:{'dynamic-import':false}}).code;
 const m={exports:{}};new Function('module','require',...Object.keys(globals),code)(m,(key:string)=>{
  if(key in deps)return deps[key];if(!key.startsWith('.'))return require(key);throw Error('Unmodeled '+key);
 },...Object.values(globals));return m.exports as any;
}
const tick=()=>new Promise<void>(r=>setImmediate(r));

function automations(){
 const queries:{sql:string;params:any[]}[]=[];
 const client={query:async(sql:string,params:any[]=[])=>{queries.push({sql,params});return /RETURNING state/.test(sql)?{rows:[{state:'failed'}],rowCount:1}:{rows:[],rowCount:1};}};
 const pool={query:async(sql:string,params:any[]=[])=>{queries.push({sql,params});return{rows:[{jobs:1,runs:1}],rowCount:1};}};
 const stub=new Proxy({},{get:()=>()=>{throw Error('not used');}});
 const m=load('automations',{
  './db':{pool,tenantTx:async(_t:string,fn:(c:any)=>any)=>fn(client)},'./errors':errors,
  './local-automation-worker-control':stub,'./customer-message-workflow-schema':stub,'./customer-message-workflows':stub,'./email-actions':stub,
  './domain':stub,'./local-financial-policy':stub,'./events':stub,'./operation-schema':stub,'./order-operations':stub,'./legacy-return-automation-group':stub,
 });
 return{m,queries};
}
const job={id:'job-1',tenant_id:'tenant-1',lease_token:'lease-1',payload:{run_id:'run-1'}};

test('a database failure records its cause on the job and the run, not only the generic text',async()=>{
 const {m,queries}=automations();
 await m.failAutomation(job,Object.assign(new Error('canceling statement due to statement timeout'),{code:'57014'}));
 const jobUpdate=queries.find(q=>/UPDATE jobs/.test(q.sql))!,runUpdate=queries.find(q=>/UPDATE automation_runs/.test(q.sql))!;
 assert.match(jobUpdate.params[2],/^Błąd wykonania automatyzacji \(przyczyna: kod bazy 57014 — przekroczony limit czasu instrukcji\)$/);
 assert.equal(runUpdate.params[1],jobUpdate.params[2],'the run says the same as its job');
 assert.equal(jobUpdate.params[3],false,'a database failure is not a refusal');
});

test('a non-database error names its class and message; a Problem keeps its own message',async()=>{
 const a=automations();
 await a.m.failAutomation(job,new TypeError("Cannot read properties of undefined (reading 'id')"));
 assert.equal(a.queries.find(q=>/UPDATE jobs/.test(q.sql))!.params[2],"Błąd wykonania automatyzacji (przyczyna: TypeError: Cannot read properties of undefined (reading 'id'))");
 const b=automations();
 await b.m.failAutomation(job,new Problem(409,'Nieaktualne wykonanie reguły'));
 assert.equal(b.queries.find(q=>/UPDATE jobs/.test(q.sql))!.params[2],'Nieaktualne wykonanie reguły');
 assert.equal(b.queries.find(q=>/UPDATE jobs/.test(q.sql))!.params[3],true);
});

test('lease expiry: only single-attempt automation leases older than the limit, row locks skipped, run failed with the same cause',async()=>{
 const {m,queries}=automations();
 assert.deepEqual(await m.expireAutomationLeases(['tenant-1']),{jobs:1,runs:1});
 const q=queries[0]!;
 for(const part of ["kind IN ('automation','automation.run')","state='running'",'attempts>=max_attempts','lease_token IS NOT NULL','FOR UPDATE SKIP LOCKED',"SET state='failed'","r.state='queued'",'r.job_id=f.id'])
  assert.ok(q.sql.includes(part),part);
 assert.ok(!/state='pending'/.test(q.sql),'never back to pending: an attempted job is not repeated');
 assert.deepEqual(q.params.slice(0,2),[['tenant-1'],'5 minutes']);
 assert.match(q.params[2],/^Dzierżawa wykonania automatyzacji wygasła po 5 min bez zapisanego wyniku/);
});

/** Scoped processor with modeled ports: the processor throws and recording the failure throws too (the dry-run case). */
function scoped(){
 const timers:{callback:()=>void;ms:number}[]=[],expiries:(readonly string[]|null)[]=[];
 let held=true;
 const pool={query:async()=>({rows:[{tenant_id:'t1',id:'r1'}]})};
 const worker=load('scoped-automation-worker',{
  './db':{pool},
  './local-automation-worker-control':{claimAutomaticJob:async()=>held?(held=false,{job:{tenant_id:'t1',id:'j1',kind:'automation.run'},lease:{}}):null,requireAutomaticLeaseInTx:async()=>{}},
  './automations':{dispatchAutomation:async()=>{},processAutomation:async()=>{throw Object.assign(Error('timeout'),{code:'57014'});},
   failAutomation:async()=>{throw Object.assign(Error('cleanup'),{code:'57014'});},expireAutomationLeases:async(t:readonly string[]|null)=>{expiries.push(t);return{jobs:0,runs:0};}},
  './email':{processEmail:async()=>{},failEmail:async()=>{}},
  './automation-local-effects':{AUTOMATIC_STOCK_JOB:'automation.local_stock',processAutomaticStock:async()=>{}},
 },{setTimeout:(callback:()=>void,ms:number)=>{const t={callback,ms};timers.push(t);return{unref(){}};},clearTimeout:()=>{}});
 const fire=async()=>{const t=timers.shift()!;t.callback();for(let i=0;i<50;i++)await tick();};
 return{worker,expiries,fire,timers};
}

test('the scoped processor expires stale leases of its own workspaces at the start of a pass, at most every 30 s',async()=>{
 const s=scoped(),runtime=s.worker.startScopedAutomationWorker({},{tenants:()=>['t1']});
 await s.fire();
 assert.deepEqual(s.expiries,[['t1']],'the first pass expires before it claims');
 assert.equal(runtime.inspect().cleanup_failed,true,'recording the failure failed: the job is left to the lease expiry');
 for(let i=0;i<5;i++)await s.fire();
 assert.equal(s.expiries.length,1,'throttled within 30 s');
 await runtime.close().catch(()=>{});
});
