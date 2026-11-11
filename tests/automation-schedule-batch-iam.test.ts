/** Actual processor source, controlled transaction ports. No SQL/PG/HTTP/app. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as crypto from 'node:crypto';
import {transformSync} from 'esbuild';

const id=(n:number)=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
class Problem extends Error{constructor(public status:number,message:string){super(message);}}
function model(){
 const events:string[]=[],queries:{sql:string;args:any[]}[]=[];
 const state:any={role:true,infoActor:id(9),lease:true,
  schedule:{id:id(2),actor_id:id(3),enabled:true,version:'1',definition_version:'1'},
  run:{id:id(4),job_id:id(5),actor_id:id(3),state:'queued',schedule_version:'1',definition_version:'1',
   definition:{actions:[{type:'add_tag',tag:'owned'}],statuses:['new'],min_age_seconds:0,repetition:'each_run'},
   as_of_text:'2026-10-18 12:00:00+00',cursor_at:null,cursor_id:null},jobState:'running'};
 const job={id:id(5),tenant_id:id(1),lease_token:id(6),payload:{run_id:id(4)}};
 let tenant:string|undefined;
 const c={query:async(sql:string,args:any[]=[])=>{
  queries.push({sql,args:structuredClone(args)});assert.equal(tenant,id(1));
  if(sql.startsWith('SELECT pg_advisory_xact_lock_shared'))return{rows:[]};
  if(sql.startsWith('SELECT * FROM automation_schedules')){events.push('schedule.lock');assert.deepEqual(args,[id(2)]);return{rows:[structuredClone(state.schedule)]};}
  if(sql.startsWith('SELECT id FROM jobs')){events.push('job.lock');assert.deepEqual(args,[id(5),id(6)]);return{rows:state.lease?[{id:id(5)}]:[],rowCount:state.lease?1:0};}
  if(sql.startsWith('SELECT *,as_of::text')){events.push('run.lock');assert.deepEqual(args,[id(4)]);return{rows:[structuredClone(state.run)]};}
  if(sql==='SELECT public.offer_sync_is_admin($1) ok'){
   events.push('membership.share');assert.deepEqual(args,[state.run.actor_id]);return{rows:[{ok:state.role}]};
  }
  if(sql.startsWith('SELECT count(*)::int AS n FROM jobs'))return{rows:[{n:0}]};
  if(sql.startsWith('SELECT o.id,o.number')){events.push('candidates');return{rows:[]};}
  if(sql.startsWith("UPDATE automation_schedule_runs SET state='cancelled'")){events.push('cancel');state.run.state='cancelled';return{rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE automation_schedule_runs SET scanned=')){events.push('finish');state.run.state=args[7];return{rows:[],rowCount:1};}
  if(sql.startsWith("UPDATE jobs SET state='done'")){state.jobState='done';return{rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE jobs SET state=$2')){state.jobState=args[1];return{rows:[],rowCount:1};}
  throw Error('Unexpected processor SQL '+sql);
 }};
 const db={pool:{query:async(sql:string,args:any[])=>{
  assert(sql.startsWith('SELECT schedule_id,actor_id,definition FROM automation_schedule_runs'),'owner-pool IAM is forbidden');
  assert.deepEqual(args,[id(4),id(1)]);return{rows:[{schedule_id:id(2),actor_id:state.infoActor,definition:structuredClone(state.run.definition)}]};
 }},tenantTx:async(t:string,work:any)=>{assert.equal(t,id(1));tenant=t;events.push('tenant.begin');try{const value=await work(c);events.push('tenant.commit');return value;}finally{tenant=undefined;}}};
 const source=readFileSync(new URL('../server/automation-schedules.ts',import.meta.url),'utf8');
 const compiled=transformSync(source,{loader:'ts',format:'cjs',target:'es2022'}).code;
 const module={exports:{}};
 const fallback=new Proxy({}, {get:(_target,key)=>key===Symbol.toStringTag?undefined:async()=>undefined});
 new Function('module','require',compiled)(module,(key:string)=>{
  if(key==='node:crypto')return crypto;
  if(key==='./db')return db;
  if(key==='./errors')return{Problem,ensure:(ok:unknown,status:number,message:string)=>{if(!ok)throw new Problem(status,message);}};
  if(key==='./domain')return{audit:async()=>{events.push('audit');}};
  if(key==='./local-financial-policy')return{localFinancialFencesAvailable:async()=>false};
  return fallback;
 });
 return{processor:module.exports as any,state,job,events,queries};
}

test('actual batch checks locked run actor in the current tenant before actions, never an owner-pool role snapshot',async()=>{
 const x=model();await x.processor.processSchedule(x.job);
 assert.deepEqual(x.events,['tenant.begin','schedule.lock','job.lock','run.lock','membership.share','candidates','finish','audit','tenant.commit']);
 assert.equal(x.state.run.state,'done');assert.equal(x.state.jobState,'done');assert.notEqual(x.state.infoActor,x.state.run.actor_id);
});

test('revoked or missing membership cancels the exact run without reading candidates or changing orders',async()=>{
 for(const role of [false,null,undefined]){
  const x=model();x.state.role=role;await x.processor.processSchedule(x.job);
  assert.equal(x.state.run.state,'cancelled');assert.equal(x.state.jobState,'done');assert(!x.events.includes('candidates'));
  assert(x.events.indexOf('membership.share')<x.events.indexOf('cancel'));assert.equal(x.events.at(-1),'tenant.commit');
 }
});

test('changed owner or either schedule version cancels before batch effects; lost lease cannot enter IAM or actions',async()=>{
 for(const field of ['actor_id','version','definition_version']){
  const x=model();x.state.schedule[field]=field==='actor_id'?id(8):'2';await x.processor.processSchedule(x.job);
  assert.equal(x.state.run.state,'cancelled');assert(!x.events.includes('candidates'));
 }
 const x=model();x.state.lease=false;await x.processor.processSchedule(x.job);
 assert.equal(x.state.run.state,'queued');assert(!x.events.includes('membership.share'));assert(!x.events.includes('candidates'));
});

test('reused SQL helper is granted tenant-bound SECURITY DEFINER with membership FOR SHARE, not a new account grant',()=>{
 const source=readFileSync(new URL('../server/017_offer_sync.sql',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('CREATE FUNCTION offer_sync_is_admin(actor_id uuid)'));
 assert(block.includes('LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public'));
 assert(block.includes("tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid"));
 assert(block.includes('WHERE user_id=actor_id'));assert(block.includes('FOR SHARE'));
 assert(block.includes('REVOKE ALL ON FUNCTION offer_sync_is_admin(uuid) FROM PUBLIC'));
 assert(block.includes('GRANT EXECUTE ON FUNCTION offer_sync_is_admin(uuid) TO dyna_app'));
});
