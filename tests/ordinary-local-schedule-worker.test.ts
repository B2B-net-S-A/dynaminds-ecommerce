/** Real source with controlled module/DB/clock ports. No PG, app or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import * as util from 'node:util';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {transformSync} from 'esbuild';
import {ensure,Problem} from '../server/errors';
const id=(n:number)=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
function selection(){return{schema:'dynaminds-local-schedule-worker/v1',configuration:{releaseDirectory:'/owned/release',manifestSha:'a'.repeat(64),expectedOwner:'postgres',
 databaseUrl:'postgres://postgres:controlled@127.0.0.1:57083/owned_schedule',localConfigurationPath:'/owned/config.private.json',revision:'reviewed209'},
 scope:{tenant_id:id(1),schedule_id:id(2),actor_id:id(3),created_after:'2026-10-18T12:00:00.000Z',actions:[{type:'add_tag',tag:'owned schedule'}]}};}
function recovery(){return{schema:'dynaminds-local-schedule-recovery/v1',job_id:id(5),run_id:id(4),lease_token:id(6),expected_attempts:1,
 schedule_version:'1',definition_version:'1',reason:'Stopped owner; inspect and resume this exact lease',
 expected_checkpoint:{cursor_at_text:null as string|null,cursor_id:null as string|null,scanned:0,done:0,skipped:0,failed:0}};}
function evaluate(name:string,resolve:(key:string)=>any,globals:Record<string,any>={}){
 let source=readFileSync(new URL('../server/'+name,import.meta.url),'utf8');
 if(name==='ordinary-local-worker.ts')source=source.replace('if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))','if(false)');
 const code=transformSync(source,{loader:'ts',format:'cjs',target:'es2022',supported:{'dynamic-import':false}}).code,m={exports:{}};
 new Function('module','require',...Object.keys(globals),code)(m,resolve,...Object.values(globals));return m.exports as any;
}
const node=(key:string)=>({'node:assert/strict':assert,'node:crypto':crypto,'node:util':util,'node:path':path,'node:url':url,'node:fs':fs,'node:fs/promises':fsp})[key];
function model(options:{mode?:string;commitFailure?:unknown;commitRollback?:boolean;processFailure?:unknown;processCommitFailure?:unknown;factoryFailure?:unknown;importFailure?:unknown;closeFailure?:unknown;hold?:boolean;due?:boolean;empty?:boolean;enqueueFailure?:unknown;nextFailure?:unknown;claimFailedRow?:boolean;recoveryExpired?:boolean;recoveryDue?:boolean;recoveryCasFailure?:boolean;recoveryAuditFailure?:unknown;globals?:Record<string,any>}={}){
 const input=selection(),events:string[]=[],sql:{text:string;args:any[]}[]=[],release:{fn?:()=>void}={};let txNumber=0,processorCalls=0,enqueueCalls=0;let transactionTail=Promise.resolve();
 const audits:any[]=[],processedJobs:any[]=[];
 const state:any={role:'admin',schedule:{id:id(2),tenant_id:id(1),actor_id:id(3),enabled:true,version:'1',definition_version:'1',definition:{actions:structuredClone(input.scope.actions)},due_now:options.due===true,due_at:'2026-10-18T12:00:01.000Z'},
  run:{id:id(4),tenant_id:id(1),schedule_id:id(2),actor_id:id(3),job_id:id(5),state:'queued',schedule_version:'1',definition_version:'1',definition:{actions:structuredClone(input.scope.actions)},created_at:'2026-10-18T12:00:01.000Z',cursor_at:null,cursor_id:null,scanned:0,done:0,skipped:0,failed:0},
  job:{id:id(5),tenant_id:id(1),kind:'automation.schedule',payload:{run_id:id(4)},state:'pending',attempts:0,max_attempts:5,lease_token:null,locked_at:null,error:null,provider_wait_until:null,provider_wait_reason:null}};
 if(options.empty){state.job=null;state.run=null;}
 const copy=(row:any)=>({rows:row?[structuredClone(row)]:[]});
 const client={query:async(text:string,args:any[]=[])=>{
  sql.push({text,args:structuredClone(args)});assert(!text.includes('memberships'),'dyna_app must never read account memberships');
  if(text.startsWith('SELECT * FROM automation_schedules')||text.startsWith('SELECT *,next_at::text AS due_at')){events.push('schedule.lock');assert(text.endsWith('FOR UPDATE'));assert.deepEqual(args,[id(2),id(1)]);return copy(state.schedule);}
  if(text==='SELECT public.offer_sync_is_admin($1) ok'){events.push('membership.tenant-locked');assert.deepEqual(args,[id(3)]);return copy({ok:state.role==='admin'});}
  if(text.startsWith('SELECT *,locked_at::text AS recovery_locked_at_text')){events.push('recovery.job.lock');assert.deepEqual(args,[id(5),id(1)]);
   assert(text.endsWith('FOR UPDATE'));return copy(state.job&&{...state.job,recovery_locked_at_text:'2026-10-18 12:00:00.123456+00',recovery_expired:options.recoveryExpired!==false,recovery_due:options.recoveryDue!==false});}
  if(text.startsWith('SELECT *,cursor_at::text AS cursor_at_text')){events.push('recovery.run.lock');assert.deepEqual(args,[id(4),id(1)]);assert(text.endsWith('FOR UPDATE'));
   return copy(state.run&&{...state.run,cursor_at_text:state.run.cursor_at_text??null});}
  if(text.startsWith('UPDATE jobs SET lease_token=$2')){events.push('recovery.cas');assert.deepEqual([args[0],args[2],args[3],args[4],args[5],args[6]],[id(5),id(1),id(6),1,'2026-10-18 12:00:00.123456+00',id(4)]);
   assert(text.includes("locked_at=$6::timestamptz")&&text.includes("locked_at<=clock_timestamp()-interval '2 minutes'")&&text.includes('attempts<max_attempts'));
   if(options.recoveryCasFailure)return copy(null);assert.equal(state.job.lease_token,args[3]);assert.equal(state.job.attempts,args[4]);
   Object.assign(state.job,{lease_token:args[1],locked_at:'2026-10-18T12:03:00.000Z',attempts:state.job.attempts+1});return copy(state.job);}
  if(text.startsWith('SELECT id FROM automation_schedule_runs')){events.push('due.active');assert.deepEqual(args,[id(2),id(1)]);return{rows:state.run?.state==='queued'?[{id:state.run.id}]:[],rowCount:state.run?.state==='queued'?1:0};}
  if(text.startsWith('UPDATE automation_schedules SET error=NULL')){events.push('due.advance');assert.deepEqual(args,[id(2),id(1),state.schedule.version]);if(Object.hasOwn(options,'nextFailure'))throw options.nextFailure;state.schedule.due_now=false;state.schedule.due_at='2026-10-18T12:01:01.000Z';return{rows:[{future:true}]};}
  if(text.startsWith('SELECT j.*')){events.push('job.lock');assert.deepEqual(args,[id(1),id(2),id(3),input.scope.created_after,state.schedule.version]);assert(text.includes('r.failed=0'));
   return copy(state.job?.state==='pending'&&(state.run?.failed===0||options.claimFailedRow)?state.job:null);}
  if(text.startsWith('SELECT * FROM automation_schedule_runs')){events.push('run.lock');assert.deepEqual(args,[id(4),id(1)]);return copy(state.run);}
  if(text.startsWith("UPDATE jobs SET state='running'")){events.push('lease');assert.deepEqual([args[0],args[2],args[3]],[id(5),id(1),id(4)]);assert.match(args[1],/^[a-f0-9-]{36}$/);
   Object.assign(state.job,{state:'running',attempts:1,lease_token:args[1],locked_at:'controlled'});return copy(state.job);}
  if(text.startsWith('SELECT * FROM jobs')){events.push('job.readback');assert.deepEqual(args,[id(5),id(1)]);return copy(state.job);}
  throw Error('Unexpected scoped SQL '+text);
 }};
 const db={pool:{query:async()=>{assert.fail('scoped worker must not read owner-pool IAM or discover other tenants');}},
  tenantTx:async(tenant:string,work:any)=>{assert.equal(tenant,id(1));let unlock!:()=>void;const previous=transactionTail;transactionTail=new Promise<void>(r=>{unlock=r;});await previous;
   const number=++txNumber,before=structuredClone(state);events.push('tx.begin');let result;
   try{result=await work(client);}catch(error){Object.assign(state,before);events.push('tx.rollback');unlock();throw error;}
   events.push('tx.commit');unlock();if(number===1&&Object.hasOwn(options,'commitFailure')){if(options.commitRollback)Object.assign(state,before);throw options.commitFailure;}return result;}};
 const owner={app:{controlled:true},close:async()=>{events.push('owner.close');if(Object.hasOwn(options,'closeFailure'))throw options.closeFailure;}};
 const loaded=evaluate('ordinary-local-schedule-worker.ts',key=>{
  const builtin=node(key);if(builtin)return builtin;
  if(key==='./ordinary-local-runtime'){events.push('factory.import');return{createOrdinaryLocalApplication:async(config:any,args:any)=>{events.push('factory');assert.deepEqual(config,input.configuration);assert.deepEqual(args,{readOnly:false,scopedAutomationEnabled:false});if(Object.hasOwn(options,'factoryFailure'))throw options.factoryFailure;return owner;}};}
  if(key==='./db'){events.push('db.import');if(Object.hasOwn(options,'importFailure'))throw options.importFailure;return db;}
  if(key==='./automation-schedules'){events.push('processor.import');return{
   scheduleHash:(value:any)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),
   enqueueSchedule:async(c:any,actor:any,schedule:any,clientKey:string,hash:string,scheduledFor:string)=>{
    events.push('due.enqueue');enqueueCalls++;assert.equal(c,client);assert.deepEqual(actor,{tenantId:id(1),userId:id(3),role:'admin'});assert.equal(schedule.id,id(2));assert.match(clientKey,/^[a-f0-9-]{36}$/);
    assert.equal(hash,crypto.createHash('sha256').update(JSON.stringify({version:state.schedule.version,due_at:state.schedule.due_at})).digest('hex'));assert.equal(scheduledFor,state.schedule.due_at);assert.notEqual(state.run?.state,'queued');
    state.run={id:id(4),tenant_id:id(1),schedule_id:id(2),actor_id:id(3),job_id:id(5),state:'queued',schedule_version:state.schedule.version,definition_version:state.schedule.definition_version,
     definition:structuredClone(state.schedule.definition),created_at:'2026-10-18T12:00:01.000Z',cursor_at:null,cursor_id:null,scanned:0,done:0,skipped:0,failed:0};
    state.job={id:id(5),tenant_id:id(1),kind:'automation.schedule',payload:{run_id:id(4)},state:'pending',attempts:0,max_attempts:5,lease_token:null,locked_at:null,error:null,provider_wait_until:null,provider_wait_reason:null};
    if(Object.hasOwn(options,'enqueueFailure'))throw options.enqueueFailure;return structuredClone(state.run);
   },processSchedule:async(job:any)=>{
   events.push('process');processorCalls++;processedJobs.push(structuredClone(job));assert.equal(job.lease_token,state.job.lease_token);assert.equal(job.kind,'automation.schedule');
   if(options.hold)await new Promise<void>(r=>{release.fn=r;});if(Object.hasOwn(options,'processFailure'))throw options.processFailure;
   if(options.mode==='no-op')return;
   if(options.mode==='lost-lease'){state.job.lease_token=id(9);return;}
   Object.assign(state.job,{state:'done',attempts:0,lease_token:null,locked_at:null});state.run.state='done';
   if(options.mode==='cancel'){state.job.state='failed';state.job.attempts=1;state.run.state='cancelled';return;}
   if(options.mode==='backpressure'){state.job.state='pending';state.job.error='Oczekiwanie na wolne miejsce w kolejce';state.run.state='queued';return;}
   const n=options.mode==='continuation'&&processorCalls===1?25:1;
   state.run.scanned+=n;state.run.done+=n;state.run.cursor_at='2026-10-18T12:00:02.000Z';state.run.cursor_id=id(100+processorCalls);
   if(options.mode==='continuation'&&processorCalls===1){state.job.state='pending';state.run.state='queued';}
   if(options.mode==='item-failure'){state.run.done--;state.run.failed++;}
   if(options.mode==='foreign-result')state.run.actor_id=id(9);
   if(Object.hasOwn(options,'processCommitFailure'))throw options.processCommitFailure;
  }};}
  if(key==='./domain')return{audit:async(c:any,actor:any,action:string,scheduleId:string,detail:any)=>{
   assert.equal(c,client);assert.deepEqual(actor,{tenantId:id(1),userId:id(3),role:'admin'});assert.equal(action,'automation.schedule.lease_recover');assert.equal(scheduleId,id(2));
   events.push('recovery.audit');audits.push(structuredClone(detail));if(Object.hasOwn(options,'recoveryAuditFailure'))throw options.recoveryAuditFailure;
  }};
  throw Error('Unexpected import '+key);
 },options.globals);return{loaded,input,state,events,sql,release,audits,processedJobs,processorCalls:()=>processorCalls,enqueueCalls:()=>enqueueCalls};
}
test('closed selection and inert import refuse overrides, unsafe actions, identities and watermarks before factory',async()=>{
 const x=model();assert.deepEqual(x.events,[]);assert.deepEqual(x.loaded.validateOrdinaryScheduleWorkerSelection(x.input),x.input);
 for(const mutate of [(s:any)=>{s.scope.actions.push({type:'email',template_id:id(8)});},(s:any)=>{s.scope.actions[0].type='remove_tag';},
  (s:any)=>{s.scope.actions[0].tag=' untrimmed';},(s:any)=>{s.scope.actor_id='actor';},(s:any)=>{s.scope.created_after='2026-02-30T00:00:00.000Z';},
  (s:any)=>{s.scope.created_after='2026-10-18';},(s:any)=>{s.scope.override=true;},(s:any)=>{s.readOnly=false;},(s:any)=>{s.configuration.databaseUrl='postgres://postgres@remote/unsafe';}]){
  const s=selection();mutate(s);await assert.rejects(()=>x.loaded.createOrdinaryLocalScheduleWorker(s));
 }
 for(const s of [null,undefined,[],{}])await assert.rejects(()=>x.loaded.createOrdinaryLocalScheduleWorker(s));assert.deepEqual(x.events,[]);
});
test('normal factory precedes DB imports, real claim is committed before process and exact readback locks follow schedule→job→run',async()=>{
 const x=model(),runtime=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);assert.deepEqual(x.events,['factory.import','factory','db.import','processor.import']);
 x.input.scope.actions[0].tag='caller mutation';assert.equal(await runtime.cycle(),true);
 assert.deepEqual(x.events.slice(4),['tx.begin','schedule.lock','membership.tenant-locked','job.lock','run.lock','lease','tx.commit','process','tx.begin','schedule.lock','job.readback','run.lock','tx.commit']);
 const q=x.sql.find(q=>q.text.startsWith('SELECT j.*'))!.text;
 for(const text of ["j.tenant_id=$1","r.schedule_id=$2","r.actor_id=$3","r.created_at>=$4","r.schedule_version=$5","j.kind='automation.schedule'","j.payload=jsonb_build_object('run_id',r.id::text)","j.attempts=0","j.lease_token IS NULL","j.locked_at IS NULL","j.run_at<=now()","FOR UPDATE OF j SKIP LOCKED"] )assert(q.includes(text),text);
 assert(!x.sql.some(q=>/^UPDATE (?!jobs)|reap|billing/i.test(q.text)));assert.equal(runtime.inspect().claims,'1');assert.equal(runtime.inspect().outcomes[0].state,'DONE_ACKNOWLEDGED_REQUIRES_UI_READBACK');
 await runtime.close();assert(runtime.inspect().closed);
});
test('role is locked only by the tenant helper; disabled schedule idles; foreign or attempted returned records refuse before leasing',async()=>{
 const role=model();role.state.role='operator';const r=await role.loaded.createOrdinaryLocalScheduleWorker(role.input);await assert.rejects(()=>r.cycle());assert(role.events.includes('membership.tenant-locked')&&role.events.includes('tx.rollback'));assert.equal(role.processorCalls(),0);await assert.rejects(()=>r.close());
 const off=model();off.state.schedule.enabled=false;const quiet=await off.loaded.createOrdinaryLocalScheduleWorker(off.input);assert.equal(await quiet.cycle(),false);assert(!off.events.includes('job.lock'));await quiet.close();
 for(const mutate of [(s:any)=>{s.schedule.actor_id=id(9);},(s:any)=>{s.schedule.definition.actions=[{type:'email'}];},(s:any)=>{s.job.tenant_id=id(9);},
  (s:any)=>{s.job.attempts=1;},(s:any)=>{s.job.lease_token=id(9);},(s:any)=>{s.job.payload.extra=true;},(s:any)=>{s.run.schedule_id=id(9);},
  (s:any)=>{s.run.actor_id=id(9);},(s:any)=>{s.run.job_id=id(9);},(s:any)=>{s.run.created_at='2026-10-18T11:59:59.000Z';},
  (s:any)=>{s.run.schedule_version='2';},(s:any)=>{s.run.definition_version='2';},(s:any)=>{s.run.definition.actions=[{type:'remove_tag',tag:'owned schedule'}];}]){
  const x=model();mutate(x.state);const runtime=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);await assert.rejects(()=>runtime.cycle());assert(!x.events.includes('lease'));assert.equal(x.processorCalls(),0);await assert.rejects(()=>runtime.close());
 }
});
test('actual cursor continuation reclaims a new acknowledged lease; current UI definition/version evolution remains allowed',async()=>{
 const x=model({mode:'continuation'}),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);assert.equal(await r.cycle(),true);const lease=x.sql.find(q=>q.text.startsWith('UPDATE jobs'))!.args[1];
 assert.equal(r.inspect().outcomes[0].state,'CONTINUATION_ACKNOWLEDGED');assert.equal(await r.cycle(),true);assert.equal(x.state.run.scanned,26);assert.equal(x.state.run.done,26);
 assert.notEqual(x.sql.filter(q=>q.text.startsWith('UPDATE jobs'))[1].args[1],lease);await r.close();
 const y=model();y.state.schedule.version='2';y.state.schedule.definition_version='2';y.state.schedule.definition.min_age_seconds=86400;
 y.state.run.schedule_version='2';y.state.run.definition_version='2';y.state.run.definition.min_age_seconds=86400;
 const next=await y.loaded.createOrdinaryLocalScheduleWorker(y.input);assert.equal(await next.cycle(),true);await next.close();
});
test('bare processor fulfillment or lost lease is unknown and stops; backpressure/cancellation are distinct acknowledged states',async()=>{
 for(const mode of ['no-op','lost-lease','foreign-result']){const x=model({mode}),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);await assert.rejects(()=>r.cycle());
  assert(r.inspect().unknown&&r.inspect().closing);await assert.rejects(()=>r.cycle());assert.equal(x.processorCalls(),1);await assert.rejects(()=>r.close());}
 for(const [mode,state] of [['backpressure','BACKPRESSURE_ACKNOWLEDGED'],['cancel','CANCELLED_CONFIRMED_NO_REPLAY']]){
  const x=model({mode}),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);assert.equal(await r.cycle(),true);assert.equal(r.inspect().outcomes[0].state,state);assert.equal(r.inspect().unknown,false);await r.close();
 }
 const x=model({mode:'item-failure'}),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);assert.equal(await r.cycle(),true);assert.equal(r.inspect().outcomes[0].state,'KNOWN_ITEM_FAILURE_STOPPED');
 assert(r.inspect().closing);assert.equal(r.inspect().unknown,false);await assert.rejects(()=>r.cycle());await assert.rejects(()=>r.close(),(e:any)=>e.code==='ITEM_FAILURE');
});
test('unknown claim COMMIT and processor errors stop without dispatch/retry; import cleanup preserves original cause',async()=>{
 const x=model({commitFailure:0}),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);await assert.rejects(()=>r.cycle(),e=>e===0);assert.equal(x.processorCalls(),0);await assert.rejects(()=>r.close(),e=>e===0);
 const primary=new Error('processor error'),y=model({processFailure:primary}),s=await y.loaded.createOrdinaryLocalScheduleWorker(y.input);await assert.rejects(()=>s.cycle(),e=>e===primary);await assert.rejects(()=>s.cycle());assert.equal(y.processorCalls(),1);await assert.rejects(()=>s.close(),e=>e===primary);
 const z=model({importFailure:primary,closeFailure:new Error('secondary')});await assert.rejects(()=>z.loaded.createOrdinaryLocalScheduleWorker(z.input),e=>e===primary);assert(z.events.includes('owner.close'));
 const f=model({factoryFailure:primary});await assert.rejects(()=>f.loaded.createOrdinaryLocalScheduleWorker(f.input),e=>e===primary);assert(!f.events.includes('db.import'));
});
test('single flight, controlled start/stop and drain timeout preserve the in-flight owner until settlement',async()=>{
 const timers:{fn:()=>void;delay:number;cancelled:boolean}[]=[],globals={setTimeout:(fn:()=>void,delay:number)=>{const t={fn,delay,cancelled:false};timers.push(t);return t;},clearTimeout:(t:any)=>{t.cancelled=true;}};
 const x=model({hold:true,globals}),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);r.start();r.start();assert.equal(timers.length,1);timers[0].fn();
 for(let i=0;i<80&&!x.release.fn;i++)await Promise.resolve();assert(x.release.fn);const a=r.cycle(),b=r.cycle();assert.equal(a,b);
 const end=r.close();const deadline=timers.find(t=>t.delay===120000)!;assert(deadline);deadline.fn();await assert.rejects(()=>end,(e:any)=>e.code==='DRAIN_UNCONFIRMED');
 assert(!x.events.includes('owner.close'));assert(r.inspect().unknown);x.release.fn!();await a;await r.close();assert(r.inspect().closed);assert.equal(x.processorCalls(),1);
 assert(!timers.some(t=>t.delay===1000&&!t.cancelled));
});
test('existing eleventh entrypoint dispatches only explicit --schedule and preserves repricing parser/ABI',async()=>{
 const called:any[]=[],loaded=evaluate('ordinary-local-worker.ts',key=>{const builtin=node(key);if(builtin)return builtin;
  if(key==='./ordinary-local-schedule-worker')return{ordinaryScheduleWorkerCli:async(args:any)=>{called.push(args);}};
  throw Error('Unexpected dispatch import '+key);});
 assert.deepEqual(loaded.parseOrdinaryRepricingWorkerArgs(['/owned/config','a'.repeat(64)]),{file:'/owned/config',digest:'a'.repeat(64)});
 assert.throws(()=>loaded.parseOrdinaryRepricingWorkerArgs(['--schedule','/owned/config','a'.repeat(64)]));assert.deepEqual(called,[]);
 await loaded.ordinaryLocalWorkerCli(['--schedule','/owned/selected','b'.repeat(64)]);assert.deepEqual(called,[['/owned/selected','b'.repeat(64)]]);
 assert.equal(JSON.parse(readFileSync(new URL('../tools/build/entrypoints.json',import.meta.url),'utf8')).entrypoints.length,11);
});
test('real bounded private selection reader refuses hash/mode/symlink/extra fields; CLI has no listener and closes on signal',async()=>{
 const root=await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(),'schedule worker '))),file=path.join(root,'selection.private.json'),bytes=Buffer.from(JSON.stringify(selection()));
 await fsp.writeFile(file,bytes,{mode:0o600,flag:'wx'});const digest=crypto.createHash('sha256').update(bytes).digest('hex');
 const proc:any=Object.assign(new EventEmitter(),{argv:[],getuid:()=>process.getuid!(),exitCode:undefined,
  stdout:Object.assign(new EventEmitter(),{write:()=>true}),stderr:Object.assign(new EventEmitter(),{write:(_s:any,cb:any)=>{cb?.();return true;}})});
 const intervals:any[]=[],timers:any[]=[],x=model({globals:{process:proc,setTimeout:(fn:any,delay:any)=>{const t={fn,delay};timers.push(t);return t;},clearTimeout:()=>{},
  setInterval:(fn:any)=>{const t={fn};intervals.push(t);return t;},clearInterval:()=>{}}});
 try{
  await assert.rejects(()=>x.loaded.ordinaryScheduleWorkerMain([file,'0'.repeat(64)]));assert(!x.events.includes('factory'));
  await fsp.chmod(file,0o644);await assert.rejects(()=>x.loaded.ordinaryScheduleWorkerMain([file,digest]));await fsp.chmod(file,0o600);
  const link=path.join(root,'link');await fsp.symlink(file,link);await assert.rejects(()=>x.loaded.ordinaryScheduleWorkerMain([link,digest]));
  const r=await x.loaded.ordinaryScheduleWorkerMain([file,digest]);assert(r);assert.equal(timers.length,1);assert.equal(x.processorCalls(),0);
  assert(!Object.hasOwn(r.app,'listen'));proc.emit('SIGTERM');for(let i=0;i<50&&(!r.inspect().closed||proc.listenerCount('SIGTERM')!==0);i++)await Promise.resolve();assert(r.inspect().closed);
  assert.equal(proc.listenerCount('SIGTERM'),0);assert.equal(proc.listenerCount('SIGINT'),0);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});


test('natural due time enqueues only this schedule, advances once and commits before dispatch; not-due and queued occurrences do not enqueue',async()=>{
 const x=model({due:true,empty:true}),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);assert.equal(await r.cycle(),true);
 assert.equal(x.enqueueCalls(),1);assert.equal(x.processorCalls(),1);assert.equal(x.state.schedule.due_now,false);
 assert(x.events.indexOf('membership.tenant-locked')<x.events.indexOf('due.enqueue'));assert(x.events.indexOf('due.advance')<x.events.indexOf('lease'));
 assert(x.events.indexOf('tx.commit')<x.events.indexOf('process'));assert.equal(await r.cycle(),false);assert.equal(x.enqueueCalls(),1);await r.close();
 const quiet=model({empty:true}),q=await quiet.loaded.createOrdinaryLocalScheduleWorker(quiet.input);assert.equal(await q.cycle(),false);assert.equal(quiet.enqueueCalls(),0);await q.close();
 const queued=model({due:true}),k=await queued.loaded.createOrdinaryLocalScheduleWorker(queued.input);assert.equal(await k.cycle(),true);assert.equal(queued.enqueueCalls(),0);assert(queued.state.schedule.due_now);await k.close();
});
test('two controlled workers serialize the schedule lock; restart rereads durable next_at rather than recreating an occurrence',async()=>{
 const x=model({due:true,empty:true}),a=await x.loaded.createOrdinaryLocalScheduleWorker(x.input),b=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);
 const results=await Promise.all([a.cycle(),b.cycle()]);assert.equal(results.filter(Boolean).length,1);assert.equal(x.enqueueCalls(),1);assert.equal(x.processorCalls(),1);await a.close();await b.close();
 const restarted=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);assert.equal(await restarted.cycle(),false);assert.equal(x.enqueueCalls(),1);await restarted.close();
});
test('enqueue/next_at failure rolls back the entire occurrence; unknown COMMIT stops and never dispatches or reclaims an attempted run',async()=>{
 for(const key of ['enqueueFailure','nextFailure']){const cause=new Error(key),x=model({due:true,empty:true,[key]:cause}),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);
  await assert.rejects(()=>r.cycle(),e=>e===cause);assert.equal(x.state.job,null);assert.equal(x.state.run,null);assert(x.state.schedule.due_now);assert.equal(x.processorCalls(),0);await assert.rejects(()=>r.cycle());await assert.rejects(()=>r.close(),e=>e===cause);
 }
 const x=model({due:true,empty:true,commitFailure:0}),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);await assert.rejects(()=>r.cycle(),e=>e===0);assert.equal(x.enqueueCalls(),1);assert.equal(x.processorCalls(),0);
 assert.equal(x.state.job.state,'running');assert.equal(x.state.schedule.due_now,false);await assert.rejects(()=>r.close(),e=>e===0);
 const restart=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);assert.equal(await restart.cycle(),false);assert.equal(x.enqueueCalls(),1);assert.equal(x.processorCalls(),0);await restart.close();
});
test('due admission refuses revoked membership, wrong action/owner and a future watermark without durable enqueue',async()=>{
 for(const mutate of [(x:any)=>{x.state.role='operator';},(x:any)=>{x.state.schedule.actor_id=id(9);},(x:any)=>{x.state.schedule.definition.actions=[{type:'remove_tag',tag:'owned schedule'}];},(x:any)=>{x.input.scope.created_after='2026-10-18T13:00:00.000Z';}]){
  const x=model({due:true,empty:true});mutate(x);const r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);await assert.rejects(()=>r.cycle());assert.equal(x.state.run,null);assert.equal(x.state.job,null);assert(x.state.schedule.due_now);assert.equal(x.processorCalls(),0);await assert.rejects(()=>r.close());
 }
});

function abandon(x:ReturnType<typeof model>){
 Object.assign(x.state.job,{state:'running',attempts:1,lease_token:id(6),locked_at:'2026-10-18T12:00:00.123Z'});
}

test('recovery has a finite intent: no actor/SQL/provider/automatic flags or malformed checkpoint/reason',()=>{
 const x=model();assert.deepEqual(x.loaded.validateOrdinaryScheduleRecoveryRequest(recovery()),recovery());
 for(const mutate of [(r:any)=>{r.actor_id=id(9);},(r:any)=>{r.automatic=true;},(r:any)=>{r.sql='UPDATE jobs';},
  (r:any)=>{r.expected_attempts=0;},(r:any)=>{r.schedule_version='01';},(r:any)=>{r.lease_token='lease';},
  (r:any)=>{r.reason='short';},(r:any)=>{r.reason=' trailing reason ';},(r:any)=>{r.reason='reason\nwith control';},
  (r:any)=>{r.reason='x'.repeat(501);},(r:any)=>{r.expected_checkpoint.scanned=1;},
  (r:any)=>{r.expected_checkpoint.cursor_id=id(300);},(r:any)=>{r.expected_checkpoint.cursor_at_text='timestamp';}]){
  const r=recovery();mutate(r);assert.throws(()=>x.loaded.validateOrdinaryScheduleRecoveryRequest(r));
 }
 assert.deepEqual(x.events,[]);
});

test('explicit recovery rotates one expired owned lease, preserves attempts budget, audits and commits before one batch',async()=>{
 const x=model();abandon(x);x.state.job.max_attempts=2;
 const runtime=await x.loaded.createOrdinaryLocalScheduleWorker(x.input),request=recovery(),unchanged=structuredClone(request);
 assert.equal(await runtime.recoverLease(request),true);assert.deepEqual(request,unchanged);
 assert.deepEqual(x.events.slice(4),['tx.begin','schedule.lock','membership.tenant-locked','recovery.job.lock','recovery.run.lock','recovery.cas','recovery.audit','tx.commit','process','tx.begin','schedule.lock','job.readback','run.lock','tx.commit']);
 assert.equal(x.processedJobs.length,1);assert.equal(x.processedJobs[0].attempts,2);assert.equal(x.processedJobs[0].max_attempts,2);
 assert.notEqual(x.processedJobs[0].lease_token,id(6));assert.equal(x.processedJobs[0].id,id(5));assert.equal(x.processedJobs[0].payload.run_id,id(4));
 assert.equal(x.enqueueCalls(),0);assert.equal(x.audits.length,1);assert.equal(x.audits[0].previous_attempts,1);assert.equal(x.audits[0].attempts,2);
 assert.equal(x.audits[0].previous_lease_token,id(6));assert.equal(x.audits[0].lease_token,x.processedJobs[0].lease_token);assert.deepEqual(x.audits[0].checkpoint,request.expected_checkpoint);
 assert.equal(runtime.inspect().automatic_reclaim,false);assert.equal(runtime.inspect().recovery_requested,true);
 assert.equal(runtime.inspect().outcomes[0].state,'DONE_ACKNOWLEDGED_REQUIRES_UI_READBACK');
 assert.throws(()=>runtime.recoverLease(request));assert.throws(()=>runtime.start());await assert.rejects(()=>runtime.cycle());await runtime.close();
});

test('recovery refuses live, foreign, exhausted, changed-IAM/version/action and provider-wait jobs before rotating a lease',async()=>{
 for(const mutate of [(s:any)=>{s.role='operator';},(s:any)=>{s.schedule.enabled=false;},
  (s:any)=>{s.schedule.actor_id=id(9);},(s:any)=>{s.schedule.version='2';},(s:any)=>{s.schedule.definition_version='2';},
  (s:any)=>{s.schedule.definition.actions=[{type:'email',template_id:id(9)}];},(s:any)=>{s.job.tenant_id=id(9);},
  (s:any)=>{s.job.kind='shipping.create';},(s:any)=>{s.job.payload.extra=true;},(s:any)=>{s.job.lease_token=id(8);},
  (s:any)=>{s.job.attempts=2;},(s:any)=>{s.job.max_attempts=1;},(s:any)=>{s.job.provider_wait_reason='unknown';},
  (s:any)=>{s.job.provider_wait_until='2026-10-19T00:00:00Z';},(s:any)=>{s.run.actor_id=id(9);},
  (s:any)=>{s.run.job_id=id(9);},(s:any)=>{s.run.schedule_version='2';},(s:any)=>{s.run.definition_version='2';},
  (s:any)=>{s.run.created_at='2026-10-18T11:59:59.999Z';},(s:any)=>{s.run.definition.actions=[{type:'remove_tag',tag:'owned schedule'}];}]){
  const x=model();abandon(x);mutate(x.state);const runtime=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);
  await assert.rejects(()=>runtime.recoverLease(recovery()));assert(!x.events.includes('recovery.cas'));assert.equal(x.processorCalls(),0);await assert.rejects(()=>runtime.close());
 }
 for(const options of [{recoveryExpired:false},{recoveryDue:false}]){
  const x=model(options);abandon(x);const runtime=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);
  await assert.rejects(()=>runtime.recoverLease(recovery()));assert(!x.events.includes('recovery.cas'));assert.equal(x.processorCalls(),0);await assert.rejects(()=>runtime.close());
 }
});

test('a known item failure is not an unknown-lease retry, even with an exactly matching checkpoint',async()=>{
 for(const state of ['running','pending','done']){
  const x=model();abandon(x);x.state.run.scanned=1;x.state.run.failed=1;
  if(state!=='running'){x.state.job.state=state;x.state.job.attempts=0;x.state.job.lease_token=null;x.state.job.locked_at=null;if(state==='done')x.state.run.state='done';}
  const request=recovery();request.expected_checkpoint.scanned=1;request.expected_checkpoint.failed=1;
  const r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);await assert.rejects(()=>r.recoverLease(request),/known-item-failure/);
  assert.equal(x.processorCalls(),0);assert(!x.events.includes('recovery.cas'));await assert.rejects(()=>r.close());
 }
});

test('a new normal owner leaves a persisted known-failure continuation untouched instead of processing another batch',async()=>{
 const x=model({mode:'item-failure'}),first=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);await first.cycle();await assert.rejects(()=>first.close());
 // The real processor can leave a failed item in an otherwise queued continuation.
 x.state.run.state='queued';x.state.job.state='pending';const before=structuredClone(x.state),calls=x.processorCalls();
 const restart=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);assert.equal(await restart.cycle(),false);
 assert.equal(x.processorCalls(),calls);assert.deepEqual(x.state,before);assert.equal(restart.inspect().claims,'0');await restart.close();
});

test('an unexpected failed row returned despite eligibility is refused under the run lock before any lease',async()=>{
 const x=model({claimFailedRow:true});x.state.run.scanned=1;x.state.run.failed=1;const before=structuredClone(x.state);
 const r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);await assert.rejects(()=>r.cycle(),/known-item-failure/);
 assert.equal(x.processorCalls(),0);assert(!x.events.includes('lease'));assert.deepEqual(x.state,before);await assert.rejects(()=>r.close());
});

test('manual use of an otherwise idle runtime prevents later recovery in that same instance',async()=>{
 const x=model(),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);await r.cycle();const before=x.sql.length;
 assert.throws(()=>r.recoverLease(recovery()),/requires-unused-runtime/);assert.equal(x.sql.length,before);assert.equal(x.processorCalls(),1);await r.close();
});

test('microsecond checkpoint is authorized exactly; acknowledged 25-item cursor resumes only the remaining item',async()=>{
 const x=model();abandon(x);Object.assign(x.state.run,{cursor_at:'2026-10-18T12:00:00.123Z',cursor_at_text:'2026-10-18 12:00:00.123456+00',cursor_id:id(300),scanned:25,done:25});
 const request=recovery();request.expected_checkpoint={cursor_at_text:'2026-10-18 12:00:00.123456+00',cursor_id:id(300),scanned:25,done:25,skipped:0,failed:0};
 const r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);assert.equal(await r.recoverLease(request),true);assert.equal(x.state.run.scanned,26);assert.equal(x.state.run.done,26);
 assert.equal(x.audits[0].checkpoint.cursor_at_text,'2026-10-18 12:00:00.123456+00');assert.equal(x.enqueueCalls(),0);await r.close();
 const mismatch=model();abandon(mismatch);Object.assign(mismatch.state.run,{cursor_at:'2026-10-18T12:00:00.123Z',cursor_at_text:'2026-10-18 12:00:00.123457+00',cursor_id:id(300),scanned:25,done:25});
 const refused=await mismatch.loaded.createOrdinaryLocalScheduleWorker(mismatch.input);await assert.rejects(()=>refused.recoverLease(request));
 assert(!mismatch.events.includes('recovery.cas'));assert.equal(mismatch.processorCalls(),0);await assert.rejects(()=>refused.close());
});

test('fresh readback classifies already committed done/pending, without replaying or inventing a recovered checkpoint',async()=>{
 for(const done of [false,true]){
  const x=model();x.state.run.scanned=25;x.state.run.done=25;x.state.run.cursor_at='2026-10-18T12:00:00.123Z';x.state.run.cursor_id=id(300);
  if(done){x.state.run.state='done';x.state.job.state='done';}
  const r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);assert.equal(await r.recoverLease(recovery()),false);
  assert.equal(r.inspect().outcomes[0].state,done?'RECOVERY_OBSERVED_DONE_REQUIRES_UI_READBACK':'RECOVERY_OBSERVED_PENDING_NORMAL_CLAIM_REQUIRED');
  assert.equal(x.processorCalls(),0);assert.equal(x.enqueueCalls(),0);assert(!x.events.includes('recovery.cas'));assert.equal(x.audits.length,0);assert.equal(x.state.run.done,25);await r.close();
 }
});

test('CAS loss/audit rollback and unknown recovery or processor COMMIT never dispatch/retry an unacknowledged lease',async()=>{
 for(const options of [{recoveryCasFailure:true},{recoveryAuditFailure:new Error('audit rollback')}]){
  const x=model(options);abandon(x);const before=structuredClone(x.state),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);
  await assert.rejects(()=>r.recoverLease(recovery()));assert.deepEqual(x.state,before);assert.equal(x.processorCalls(),0);assert(r.inspect().unknown);await assert.rejects(()=>r.close());
 }
 const x=model({commitFailure:0});abandon(x);const r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);
 await assert.rejects(()=>r.recoverLease(recovery()),e=>e===0);assert.equal(x.state.job.attempts,2);assert.notEqual(x.state.job.lease_token,id(6));assert.equal(x.processorCalls(),0);
 await assert.rejects(()=>r.cycle());await assert.rejects(()=>r.close(),e=>e===0);
 const restarted=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);await assert.rejects(()=>restarted.recoverLease(recovery()));assert.equal(x.processorCalls(),0);await assert.rejects(()=>restarted.close());
 const cause=new Error('processor outcome unknown'),y=model({processFailure:cause});abandon(y);const runtime=await y.loaded.createOrdinaryLocalScheduleWorker(y.input);
 await assert.rejects(()=>runtime.recoverLease(recovery()),e=>e===cause);assert.equal(y.processorCalls(),1);assert.equal(y.state.job.attempts,2);await assert.rejects(()=>runtime.cycle());await assert.rejects(()=>runtime.close(),e=>e===cause);
});

test('lost recovery ACK with rollback preserves the old lease; lost batch ACK classifies the durable checkpoint without replay',async()=>{
 const x=model({commitFailure:0,commitRollback:true});abandon(x);const before=structuredClone(x.state),r=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);
 await assert.rejects(()=>r.recoverLease(recovery()),e=>e===0);assert.deepEqual(x.state,before);assert.equal(x.processorCalls(),0);await assert.rejects(()=>r.close(),e=>e===0);
 for(const mode of ['continuation',undefined]){
  const y=model({mode,processCommitFailure:new Error('batch committed but ACK lost')});abandon(y);const current=await y.loaded.createOrdinaryLocalScheduleWorker(y.input);
  await assert.rejects(()=>current.recoverLease(recovery()),/ACK lost/);assert.equal(y.processorCalls(),1);assert.equal(y.state.job.attempts,0);assert.equal(y.state.run.done,mode?25:1);
  await assert.rejects(()=>current.close());const restarted=await y.loaded.createOrdinaryLocalScheduleWorker(y.input);
  assert.equal(await restarted.recoverLease(recovery()),false);assert.equal(y.processorCalls(),1);assert.equal(y.enqueueCalls(),0);await restarted.close();
 }
});

test('two explicit recoverers serialize and at most one rotates/processes this expected old lease',async()=>{
 const x=model();abandon(x);const a=await x.loaded.createOrdinaryLocalScheduleWorker(x.input),b=await x.loaded.createOrdinaryLocalScheduleWorker(x.input);
 const results=await Promise.allSettled([a.recoverLease(recovery()),b.recoverLease(recovery())]);
 assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value===true).length,1);assert.equal(x.processorCalls(),1);assert.equal(x.audits.length,1);
 assert.equal(x.events.filter(e=>e==='recovery.cas').length,1);assert.equal(x.enqueueCalls(),0);await Promise.allSettled([a.close(),b.close()]);
});

test('actual processSchedule rejects the old token while a recovered new owner is in flight',async()=>{
 const x=model({hold:true});abandon(x);const runtime=await x.loaded.createOrdinaryLocalScheduleWorker(x.input),work=runtime.recoverLease(recovery());
 for(let n=0;n<100&&!x.release.fn;n++)await Promise.resolve();assert(x.release.fn);assert.notEqual(x.state.job.lease_token,id(6));
 const statements:string[]=[],c={query:async(sql:string,args:any[]=[])=>{
  statements.push(sql);
  if(sql.startsWith('SELECT pg_advisory_xact_lock_shared'))return{rows:[]};
  if(sql==='SELECT * FROM automation_schedules WHERE id=$1 FOR UPDATE')return{rows:[structuredClone(x.state.schedule)]};
  if(sql==="SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE"){
   assert.deepEqual(args,[id(5),id(6)]);const exists=x.state.job.state==='running'&&x.state.job.lease_token===args[1];return{rows:exists?[{id:id(5)}]:[],rowCount:exists?1:0};
  }
  assert.fail('Stale source processor reached run, IAM or business effects');
 }};
 const actual=evaluate('automation-schedules.ts',key=>{
  const builtin=node(key);if(builtin)return builtin;
  if(key==='./db')return{pool:{query:async()=>({rows:[{schedule_id:id(2),actor_id:id(3),definition:structuredClone(x.state.run.definition)}]})},tenantTx:async(t:string,fn:any)=>{assert.equal(t,id(1));return fn(c);}};
  if(key==='./errors')return{ensure,Problem};
  if(['./email-actions','./sms-actions','./domain','./events','./local-financial-policy','./operation-schema','./order-operations','./packing-order-field-requirements','./operation-routes'].includes(key))return{};
  throw Error('Unexpected processor import '+key);
 });
 await actual.processSchedule({id:id(5),tenant_id:id(1),lease_token:id(6),payload:{run_id:id(4)}});
 assert.equal(statements.length,3);assert.equal(x.processorCalls(),1);x.release.fn!();await work;await runtime.close();
});

test('recovery CLI dispatch is explicit and keeps existing schedule/repricing parsers unchanged',async()=>{
 const called:any[]=[],loaded=evaluate('ordinary-local-worker.ts',key=>{const builtin=node(key);if(builtin)return builtin;
  if(key==='./ordinary-local-schedule-worker')return{ordinaryScheduleRecoveryCli:async(args:any)=>{called.push(args);}};
  throw Error('Unexpected dispatch import '+key);
 });
 const args=['/owned/selection','a'.repeat(64),'/owned/recovery','b'.repeat(64)];
 await loaded.ordinaryLocalWorkerCli(['--schedule-recover',...args]);assert.deepEqual(called,[args]);
 const x=model();assert.deepEqual(x.loaded.parseOrdinaryScheduleRecoveryArgs(args),{file:args[0],digest:args[1],recoveryFile:args[2],recoveryDigest:args[3]});
 assert.throws(()=>x.loaded.parseOrdinaryScheduleRecoveryArgs(args.slice(0,2)));assert.throws(()=>x.loaded.parseOrdinaryScheduleWorkerArgs(args));
 assert.throws(()=>x.loaded.parseOrdinaryScheduleRecoveryArgs([...args,'extra']));assert.deepEqual(x.events,[]);
});

test('one-shot CLI consumes two genuine private pinned files, never starts a loop, closes and prints no recovery intent',async()=>{
 const root=await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(),'schedule recovery '))),selected=path.join(root,'selection.private.json'),intent=path.join(root,'recovery.private.json');
 const a=Buffer.from(JSON.stringify(selection())),b=Buffer.from(JSON.stringify(recovery()));await fsp.writeFile(selected,a,{mode:0o600,flag:'wx'});await fsp.writeFile(intent,b,{mode:0o600,flag:'wx'});
 const output:string[]=[],timers:any[]=[],proc:any=Object.assign(new EventEmitter(),{argv:[],getuid:()=>process.getuid!(),exitCode:undefined,
  stdout:Object.assign(new EventEmitter(),{write:(s:string)=>{output.push(s);return true;}}),stderr:Object.assign(new EventEmitter(),{write:(_s:any,cb:any)=>{cb?.();return true;}})});
 const x=model({globals:{process:proc,setTimeout:(fn:any,delay:any)=>{const t={fn,delay};timers.push(t);return t;},clearTimeout:()=>{}}});abandon(x);
 const args=[selected,crypto.createHash('sha256').update(a).digest('hex'),intent,crypto.createHash('sha256').update(b).digest('hex')];
 try{
  await assert.rejects(()=>x.loaded.ordinaryScheduleRecoveryMain([...args.slice(0,3),'0'.repeat(64)]));assert(!x.events.includes('factory'));
  const r=await x.loaded.ordinaryScheduleRecoveryMain(args);assert(r.inspect().closed);assert.equal(r.inspect().loop_started,false);assert.equal(x.processorCalls(),1);assert.equal(timers.length,0);
  assert.equal(proc.listenerCount('SIGTERM'),0);assert.equal(proc.listenerCount('SIGINT'),0);assert.equal(output.length,1);
  const result=JSON.parse(output[0]);assert.equal(result.status,'ORDINARY_LOCAL_SCHEDULE_RECOVERY_ACKNOWLEDGED_REQUIRES_UI_READBACK');assert.equal(result.processed_one_batch,true);assert.equal(result.automatic_reclaim,false);
  assert(!output[0].includes(recovery().lease_token));assert(!output[0].includes(recovery().reason));assert(!output[0].includes('controlled'));
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
