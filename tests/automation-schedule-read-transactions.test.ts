/** Actual route handlers with controlled tenant transaction ports; no PG, HTTP or app.
 * The model checks route composition and snapshot use, not PostgreSQL RLS/auth/performance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as crypto from 'node:crypto';
import * as util from 'node:util';
import {transformSync} from 'esbuild';
import {z} from 'zod';
import {ensure, Problem} from '../server/errors';

const id=(n:number)=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const own=id(1),foreign=id(2),schedule=id(10),foreignSchedule=id(11),run=id(100);
const LIST='/api/automation-schedules';
const HISTORY='/api/automation-schedules/:id/runs';
const DETAIL='/api/automation-schedule-runs/:id';
const compiled=transformSync(readFileSync(new URL('../server/automation-schedule-routes.ts',import.meta.url),'utf8'),{
  loader:'ts',format:'cjs',target:'es2022',
}).code;

function fixture(){
  const state={
    schedules:[{id:schedule,tenant_id:own,name:'Owned'},{id:foreignSchedule,tenant_id:foreign,name:'Foreign'}],
    runs:[...Array.from({length:26},(_,n)=>({id:id(100+n),tenant_id:own,schedule_id:schedule,
      // Equal timestamps exercise the id tie-break as well as the cursor boundary.
      created_at:'2026-10-18T12:00:00.000Z',state:'done',done:26,scanned:26,failed:0,error:null,
      job_state:'done',job_error:null})),
      {id:id(900),tenant_id:foreign,schedule_id:foreignSchedule,created_at:'2026-10-19T12:00:00.000Z',
        state:'done',done:99,scanned:99,failed:0,error:null,job_state:'done',job_error:null}],
    items:[...Array.from({length:26},(_,n)=>({tenant_id:own,run_id:run,order_id:id(200+n),state:'done'})),
      {tenant_id:foreign,run_id:id(900),order_id:id(999),state:'done'}],
  };
  const routes=new Map<string,(req:any)=>Promise<any>>();
  const transactions:{mode:'read'|'write';tenant:string;queries:string[];outcome:string;closed:boolean}[]=[];
  const locks:string[]=[],unexpected:string[]=[];
  const stopWrite=new Error('controlled write boundary');
  let failNextRead:Error|undefined;
  let afterHeader:(()=>void)|undefined;
  const sortedRuns=(rows:typeof state.runs)=>[...rows].sort((a,b)=>
    b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
  async function transaction(mode:'read'|'write',tenant:string,work:any){
    const tx={mode,tenant,queries:[] as string[],outcome:'open',closed:false};transactions.push(tx);
    const snapshot=structuredClone(state);
    const client={tx,query:async(sql:string,args:any[]=[])=>{
      tx.queries.push(sql);
      if(mode==='write')throw stopWrite;
      assert.match(sql,/^SELECT\b/);
      assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|FOR SHARE|pg_advisory)\b/i);
      if(failNextRead){const error=failNextRead;failNextRead=undefined;throw error;}
      const schedules=snapshot.schedules.filter(s=>s.tenant_id===tenant);
      const runs=snapshot.runs.filter(r=>r.tenant_id===tenant);
      let rows:any[];
      if(sql.startsWith('SELECT s.*,r.state')){
        rows=schedules.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)).slice(0,100).map(s=>{
          const latest=sortedRuns(runs.filter(r=>r.schedule_id===s.id))[0];
          return{...s,last_state:latest?.state??null,last_scanned:latest?.scanned??null,
            last_done:latest?.done??null,last_failed:latest?.failed??null,last_error:latest?.error??null};
        });
      }else if(sql==='SELECT id FROM automation_schedules WHERE id=$1'){
        rows=schedules.filter(s=>s.id===args[0]).map(s=>({id:s.id}));
      }else if(sql.startsWith('SELECT * FROM automation_schedule_runs WHERE schedule_id=')){
        const cursor=runs.find(r=>r.id===args[1]&&r.schedule_id===args[0]);
        rows=sortedRuns(runs.filter(r=>r.schedule_id===args[0]&&(!args[1]||Boolean(cursor&&
          (r.created_at<cursor.created_at||(r.created_at===cursor.created_at&&r.id<cursor.id)))))).slice(0,26);
      }else if(sql.startsWith('SELECT r.*,j.state AS job_state')){
        rows=runs.filter(r=>r.id===args[0]);
        afterHeader?.();afterHeader=undefined;
      }else if(sql.startsWith('SELECT * FROM automation_schedule_items WHERE run_id=')){
        rows=snapshot.items.filter(i=>i.tenant_id===tenant&&i.run_id===args[0]&&(!args[1]||i.order_id>args[1]))
          .sort((a,b)=>a.order_id.localeCompare(b.order_id)).slice(0,26);
      }else throw new Error('Unexpected controlled read query');
      return{rows:structuredClone(rows),rowCount:rows.length};
    }};
    try{const result=await work(client);tx.outcome='commit';return result;}
    catch(error){tx.outcome='rollback';throw error;}
    finally{tx.closed=true;}
  }
  const rejectHelper=(name:string)=>async()=>{unexpected.push(name);throw new Error('Unexpected read side effect: '+name);};
  const module={exports:{} as any};
  new Function('module','require',compiled)(module,(key:string)=>{
    if(key==='node:crypto')return crypto;
    if(key==='node:util')return util;
    if(key==='zod')return{z};
    if(key==='./errors')return{ensure};
    if(key==='./db')return{tenantReadTx:(t:string,f:any)=>transaction('read',t,f),tenantTx:(t:string,f:any)=>transaction('write',t,f)};
    if(key==='./email-actions')return{lockEmailQueue:async(c:any,t:string)=>{
      assert.equal(c.tx.mode,'write','Reads must not take the email-producer mutex');assert.equal(c.tx.tenant,t);locks.push(t);
    }};
    if(key==='./domain')return{audit:rejectHelper('audit')};
    if(key==='./automation-schedule-schema')return{scheduleCreate:{parse:(v:any)=>v},scheduleEdit:{parse:(v:any)=>v},scheduleQueue:{parse:(v:any)=>v}};
    if(key==='./automation-schedules')return Object.fromEntries(['scheduleHash','validateSchedule','cancelScheduleRuns','enqueueSchedule','previewSchedule'].map(k=>[k,rejectHelper(k)]));
    throw new Error('Unexpected route import '+key);
  });
  const register=(method:string)=>(path:string,handler:any)=>routes.set(method+' '+path,handler);
  module.exports.registerAutomationScheduleRoutes({get:register('GET'),post:register('POST'),patch:register('PATCH')});
  return{state,transactions,locks,unexpected,stopWrite,
    failRead:(error:Error)=>{failNextRead=error;},
    concurrentlyAfterHeader:(fn:()=>void)=>{afterHeader=fn;},
    call:(method:string,path:string,options:any={})=>{
      const handler=routes.get(method+' '+path);assert(handler,'Registered route missing');
      return Promise.resolve().then(()=>handler({actor:{tenantId:own,userId:id(3),role:'admin',...options.actor},
        params:{id:schedule,...options.params},query:options.query??{},body:options.body??{}}));
    },
  };
}

function assertPureReads(x:ReturnType<typeof fixture>){
  assert(x.transactions.length>0);
  assert(x.transactions.every(t=>t.mode==='read'&&t.closed));
  assert.deepEqual(x.locks,[]);assert.deepEqual(x.unexpected,[]);
}

test('list uses a tenant read transaction for viewers and returns the latest owned summary',async()=>{
  const x=fixture();const result=await x.call('GET',LIST,{actor:{role:'viewer'}});
  assert.deepEqual(result.data.map((s:any)=>s.id),[schedule]);
  assert.equal(result.data[0].last_done,26);assert.equal(result.data[0].last_state,'done');
  const other=await x.call('GET',LIST,{actor:{tenantId:foreign,role:'operator'}});
  assert.deepEqual(other.data.map((s:any)=>s.id),[foreignSchedule]);assert.equal(other.data[0].last_done,99);
  assertPureReads(x);
});

test('run history keeps 25+1 cursor pages, tie-break ordering and foreign-cursor isolation',async()=>{
  const x=fixture();const first=await x.call('GET',HISTORY);
  assert.equal(first.data.length,25);assert.equal(first.meta.cursor,id(101));
  const last=await x.call('GET',HISTORY,{query:{after:first.meta.cursor}});
  assert.equal(last.meta.cursor,null);
  assert.deepEqual([...first.data,...last.data].map(r=>r.id),Array.from({length:26},(_,n)=>id(125-n)));
  const foreignCursor=await x.call('GET',HISTORY,{query:{after:id(900)}});
  assert.deepEqual(foreignCursor,{data:[],meta:{cursor:null}});assertPureReads(x);
});

test('detail keeps job/header fields and 25+1 order-item pages with no duplicates',async()=>{
  const x=fixture();const first=await x.call('GET',DETAIL,{params:{id:run}});
  assert.equal(first.job_state,'done');assert.equal(first.job_error,null);assert.equal(first.done,26);
  assert.equal(first.items.length,25);assert.equal(first.meta.cursor,id(224));
  const last=await x.call('GET',DETAIL,{params:{id:run},query:{after:first.meta.cursor}});
  assert.equal(last.meta.cursor,null);
  assert.deepEqual([...first.items,...last.items].map(i=>i.order_id),Array.from({length:26},(_,n)=>id(200+n)));
  assertPureReads(x);
});

test('foreign or absent schedule/run remains 404 inside the scoped read, without side effects',async()=>{
  const x=fixture();
  for(const [path,key] of [[HISTORY,foreignSchedule],[HISTORY,id(998)],[DETAIL,id(900)],[DETAIL,id(998)]]){
    await assert.rejects(x.call('GET',path,{params:{id:key}}),(e:unknown)=>e instanceof Problem&&e.status===404);
  }
  assert(x.transactions.every(t=>t.outcome==='rollback'));assertPureReads(x);
});

test('header and items share one read snapshot while the next request sees concurrent progress',async()=>{
  const x=fixture();
  x.concurrentlyAfterHeader(()=>{
    x.state.runs.find(r=>r.id===run)!.done=27;
    x.state.items.push({tenant_id:own,run_id:run,order_id:id(226),state:'done'});
  });
  const old=await x.call('GET',DETAIL,{params:{id:run},query:{after:id(224)}});
  assert.equal(old.done,26);assert.deepEqual(old.items.map((i:any)=>i.order_id),[id(225)]);
  assert.equal(x.transactions.length,1);assert.equal(x.transactions[0].queries.length,2);
  const current=await x.call('GET',DETAIL,{params:{id:run},query:{after:id(224)}});
  assert.equal(current.done,27);assert.deepEqual(current.items.map((i:any)=>i.order_id),[id(225),id(226)]);
  assertPureReads(x);
});

test('read failures propagate unchanged and close the read transaction without write fallback',async()=>{
  const x=fixture();const denied=new Error('controlled admission/query failure');x.failRead(denied);
  await assert.rejects(x.call('GET',HISTORY),(e:unknown)=>e===denied);
  assert.equal(x.transactions[0].outcome,'rollback');assertPureReads(x);
});

test('all four mutations retain the write transaction and email mutex before database work',async()=>{
  const x=fixture();
  for(const [method,path,body] of [
    ['POST',LIST,{client_key:id(700),name:'New'}],
    ['PATCH','/api/automation-schedules/:id',{version:'1',enabled:false}],
    ['POST','/api/automation-schedules/:id/preview',{}],
    ['POST','/api/automation-schedules/:id/run',{version:'1',client_key:id(701)}],
  ] as const){
    await assert.rejects(x.call(method,path,{body}),(e:unknown)=>e===x.stopWrite);
  }
  assert.equal(x.transactions.length,4);assert(x.transactions.every(t=>t.mode==='write'&&t.closed&&t.outcome==='rollback'));
  assert.deepEqual(x.locks,[own,own,own,own]);assert.deepEqual(x.unexpected,[]);
});
