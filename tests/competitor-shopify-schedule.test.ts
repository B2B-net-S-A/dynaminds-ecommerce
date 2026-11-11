import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import * as crypto from 'node:crypto';
import {z} from 'zod';
import {Problem,ensure} from '../server/errors';
import * as schedule from '../server/competitor-shopify-schedule';
import * as schemas from '../server/competitor-observations-schema';
import * as ranking from '../server/competitor-ranking';
import {repricingConfig} from '../server/repricing';
import Fastify from 'fastify';
const tenant='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',list='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 user='cccccccc-cccc-4ccc-8ccc-cccccccccccc',runId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 jobId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',product='ffffffff-ffff-4fff-8fff-ffffffffffff';
const source={product_id:product,source_namespace:'shopify:competitors',shop_root:'https://competitor.example/',
 handle:'coat',remote_product_id:'10',variant_id:'20',currency:'PLN',delivery_gross_minor:'499',
 gross_prices_confirmed:true,fixed_delivery_confirmed:true};
const definition=(mode='collection_only')=>({profile_config_version:2,sources:[source],mode,
 local_observations_confirmed:true,collection_confirmed:true,price_changes_confirmed:mode==='collect_then_reprice'});
const profile={version:7,config_version:2,source_namespace:source.source_namespace,own_seller_id:'shopify:own.example'};
const job={id:jobId,tenant_id:tenant,lease_token:'live-lease',payload:{run_id:runId,collection_profile_version:7}};
// 639a9e1: repricing-schedules.ts reads the run-history cursor helpers; worker and run paths never reach them.
const historyUnused={historyAfter:()=>assert.fail('Run history is outside controlled schedule tests'),historyCursor:()=>assert.fail('Run history is outside controlled schedule tests')};
// REPRICE-005 (repricing-channel.ts): channel results of scheduled runs are outside these controlled schedule
// tests; modeled as on a database without migration 247 (no channel rows, empty summaries, no-op reconcile and routes).
const channelUnused={recordRunChannelInTx:async()=>0,channelSummaries:async()=>new Map(),reconcileRepricingChannelDue:async()=>{},registerRepricingChannelRoutes:()=>{}};
function load(name:string,modules:Record<string,unknown>):any{
 const source=readFileSync(new URL('../server/'+name,import.meta.url),'utf8');
 const code=transformSync(source,{loader:'ts',format:'cjs',target:'es2018',supported:{'dynamic-import':false}}).code;
 const module={exports:{}};new Function('module','require',code)(module,(k:string)=>{
  assert(Object.hasOwn(modules,k),'Unexpected import '+k);return modules[k];});return module.exports;
}
test('legacy config remains unchanged; explicit collection modes/consent/source/currency identities are strict',()=>{
 assert.equal(schedule.scheduledShopifyDefinition({enabled:true}),null);
 for(const bad of [null,undefined,{shopify_collection:null},{shopify_collection:{...definition(),mode:'publish_provider'}},
  {shopify_collection:{...definition('collect_then_reprice'),price_changes_confirmed:false}}])assert.throws(()=>schedule.scheduledShopifyDefinition(bad));
 assert.throws(()=>schedule.shopifyCollectionDefinition.parse({...definition(),sources:[source,source]}));
 assert.throws(()=>schedule.assertCollectionSourcesMatchProfile(schedule.shopifyCollectionDefinition.parse(definition()),{...profile,config_version:3},'PLN'));
 assert.throws(()=>schedule.assertCollectionSourcesMatchProfile(schedule.shopifyCollectionDefinition.parse(definition()),{...profile,own_seller_id:'shopify:competitor.example'},'PLN'));
 assert.throws(()=>schedule.assertCollectionSourcesMatchProfile(schedule.shopifyCollectionDefinition.parse(definition()),profile,'EUR'));
 assert.throws(()=>schedule.scheduledCollectionProfileVersion({run_id:runId}));
 assert.throws(()=>repricingConfig.parse({strategy:'cost_margin',shopify_collection:definition('collect_then_reprice')}));
 assert.equal(repricingConfig.parse({strategy:'competitor_rank',shopify_collection:definition('collect_then_reprice')}).strategy,'competitor_rank');
});
function processor(mode:string|null,controls:{scanned?:number;role?:boolean;lease?:boolean;profileVersion?:number;advance?:boolean;blocked?:boolean}={}){
 const events:string[]=[],queries:{sql:string;args:any[]}[]=[];
 const cfg={enabled:true,version:3,actor_id:user,rule_config_version:6,interval_minutes:5};
 const rule={version:31,config_version:6,config:{enabled:true,strategy:'competitor_rank',...(mode?{shopify_collection:definition(mode)}:{})}};
 const run={id:runId,tenant_id:tenant,price_list_id:list,state:'queued',actor_id:user,job_id:jobId,schedule_version:3,rule_version:31,expected_list_version:4,
  batch_size:10,scanned:controls.scanned??0,changed:0,cursor:null,upper_id:product};
 const c={query:async(sql:string,args:any[]=[])=>{
  queries.push({sql,args});let rows:any[]=[],rowCount=0;
  if(sql.startsWith('SELECT price_list_id FROM repricing_runs'))rows=[{price_list_id:list}];
  else if(sql.startsWith('SELECT * FROM price_lists'))rows=[{id:list,active:true,currency:'PLN',version:4}];
  else if(sql.startsWith('SELECT * FROM repricing_rules'))rows=[rule];
  else if(sql.startsWith('SELECT * FROM repricing_schedules'))rows=[cfg];
  else if(sql.startsWith('SELECT * FROM repricing_runs'))rows=[run];
  else if(sql.startsWith('SELECT id FROM jobs'))rows=controls.lease===false?[]:[{id:jobId}];
  else if(sql.includes('offer_sync_is_admin'))rows=[{ok:controls.role!==false}];
  else if(sql.startsWith('SELECT * FROM competitor_observation_profiles'))rows=[{...profile,version:controls.profileVersion??7}];
  else if(sql.startsWith('UPDATE repricing_runs SET rule_version'))rows=controls.advance===false?[]:[{rule_version:32}];
  else if(sql.startsWith('SELECT product_id FROM repricing_inputs'))rows=[{product_id:product}];
  else if(sql.startsWith('UPDATE repricing_runs SET cursor'))rows=[{...run,scanned:1,changed:controls.blocked?0:1}];
  else if(sql.startsWith('UPDATE repricing_runs SET state=')){events.push('finished');rows=[{state:args[1],scanned:1,changed:run.changed}];}
  return {rows,rowCount:rows.length||rowCount};
 }};
 const modules={'node:crypto':crypto,'zod':{z},'./errors':{ensure,Problem},'./repricing-rules':historyUnused,'./repricing-channel':channelUnused,
  './competitor-shopify-schedule':schedule,'./domain':{audit:async()=>{}},
  './db':{pool:{},tenantTx:async(_t:string,fn:(c:any)=>unknown)=>fn(c)},
  './competitor-shopify-collector':{collectShopifyCompetitorObservations:async()=>{events.push('collect');return {observations:[]};}},
  './competitor-observations':{enlistCompetitorCollectionWorkerInTx:async()=>{events.push('native-author');},
   importScheduledCompetitorObservationsInTx:async(_c:any,_job:any,_id:string,b:any)=>{events.push('batch');assert.equal(b.client_key,runId);assert.equal(b.profile_version,7);return {rule_version:32};},enlistCompetitorRankingWorkerInTx:async()=>{}},
  './repricing':{repricingRows:async()=>[{state:controls.blocked?'blocked':'change'}],applyRepricingPrices:async()=>{events.push('local-prices');return {changed:1,version:5};}}};
 return {api:load('repricing-schedules.ts',modules),events,queries};
}
test('actual existing processor collection-only writes one batch then ends before local price/apply/preview',async()=>{
 const p=processor('collection_only');await p.api.processRepricing(job);
 assert.deepEqual(p.events,['native-author','collect','batch','finished']);
 assert(!p.queries.some(q=>q.sql.startsWith('INSERT INTO repricing_previews')));
});
test('collection-before-repricing binds ONLY own returned rule version and preserves blocked-price threshold',async()=>{
 const p=processor('collect_then_reprice');await p.api.processRepricing(job);
 assert.deepEqual(p.events,['native-author','collect','batch','local-prices','finished']);
 const q=p.queries.find(q=>q.sql.startsWith('UPDATE repricing_runs SET rule_version'))!;
 assert.deepEqual(q.args,[runId,32,31]);
 const blocked=processor('collect_then_reprice',{blocked:true});await blocked.api.processRepricing(job);
 assert(!blocked.events.includes('local-prices'));assert(blocked.events.includes('finished'));
 const drift=processor('collect_then_reprice',{advance:false});await assert.rejects(drift.api.processRepricing(job));assert(!drift.events.includes('local-prices'));
});
test('subsequent batch never recollects; stale lease/role/profile deny before provider read, legacy branch is retained',async()=>{
 for(const fault of [{lease:false},{role:false},{profileVersion:8}]){const p=processor('collection_only',fault);await p.api.processRepricing(job).catch(()=>{});assert(!p.events.includes('collect'));assert(!p.events.includes('batch'));}
 const next=processor('collect_then_reprice',{scanned:10});await next.api.processRepricing(job);assert(!next.events.includes('collect'));assert(next.events.includes('local-prices'));
 const old=processor(null);await old.api.processRepricing(job);assert(!old.events.includes('collect'));assert(old.events.includes('local-prices'));
});
function observationModule(extra:Record<string,unknown>={}){return load('competitor-observations.ts',{'node:crypto':crypto,'zod':{z},'./errors':{ensure,Problem},
 './competitor-ranking':ranking,'./competitor-observations-schema':schemas,'./competitor-shopify-schedule':schedule,
 './public-constraint-drain':{drainPublicConstraintsInTx:async()=>{}},'./domain':{audit:async()=>{}},'./product-deletions':{assertProductsNotDeletedInTx:async()=>{}},...extra});}
test('actual scheduled admission source rejects unmanaged TX/lease and modeled current-role drift; no HTTP/admin request',async()=>{
 const api=observationModule();let role=true,lease=true,calls=0;
 const c={query:async(sql:string,args:any[])=>{
  if(sql.includes('pg_current_xact_id()'))return {rows:[{root:'xid',start:'start',pid:1,role:'dyna_app',tenant}]};
  if(sql.startsWith('SELECT r.id,r.actor_id')){assert.deepEqual(args,[tenant,list,runId,jobId,'live-lease',7]);assert(sql.includes("j.kind='pricing.reprice'"));assert(sql.includes('FOR SHARE OF r,s,j,rr,p'));return {rows:lease?[{id:runId,actor_id:user,profile_config_version:2,config:{shopify_collection:definition()}}]:[]};}
  if(sql.includes('to_regprocedure'))return {rows:[{present:true}]};
  if(sql==='SELECT competitor_observation_available() available')return {rows:[{available:true}]};
  if(sql.includes('competitor_observation_worker_identity')){calls++;if(!role)throw {code:'42501'};return {rows:[{identity:{role:'admin',account_version:'1',policy:null}}]};}
  throw new Error('Unexpected query');
 }};
 await assert.rejects(api.enlistCompetitorCollectionWorkerInTx(c,job,list));api.beginCompetitorObservationTransaction(c);
 lease=false;await assert.rejects(api.enlistCompetitorCollectionWorkerInTx(c,job,list));assert.equal(calls,0);
 lease=true;role=false;await assert.rejects(api.enlistCompetitorCollectionWorkerInTx(c,job,list),(e:unknown)=>e instanceof Problem&&e.status===403);
 role=true;const f=await api.enlistCompetitorCollectionWorkerInTx(c,job,list);assert.equal(f.actor_id,user);
 const raw={client_key:runId,profile_version:7,local_observations_confirmed:true,observations:[{product_id:product,source_namespace:source.source_namespace,
  offer_id:'configured-variant',seller_id:'shopify:competitor.example',currency:'PLN',price_gross_minor:'100',delivery_gross_minor:'499',available:true,observed_at:'2026-10-12T12:00:00.000000Z'}]};
 await assert.rejects(api.importScheduledCompetitorObservationsInTx(c,job,list,{...raw,client_key:jobId}),/własnemu przebiegowi/);
 await assert.rejects(api.importScheduledCompetitorObservationsInTx(c,job,list,{...raw,profile_version:8}),/przypiętej wersji/);
 api.endCompetitorObservationTransaction(c);
});
test('shared batch core keeps HTTP defaults and exempts only its exact validated collector run',()=>{
 const s=readFileSync(new URL('../server/competitor-observations.ts',import.meta.url),'utf8');
 assert(s.includes('storeObservationBatchInTx(c,a,id,raw);'));
 assert(s.includes('return storeObservationBatchInTx(c,actor,listId,b,frame.id);'));
 assert(s.includes("AND($2::uuid IS NULL OR id<>$2) RETURNING job_id\",[id,ownCollectorRun]"));
 assert(s.includes("ensure(b.client_key===frame.id,409"));
 // Native SQL guards and terminal functions are called, not replaced/resealed.
 assert(s.includes('competitor_observation_worker_terminal($1,$2,$3,$4)'));
});
test('actual shared batch core uses native worker proof without HTTP WeakMap, preserves exact own-run exclusion and rejects IAM drift',async()=>{
 for(const drift of [false,true]){
  const api=observationModule();let reads=0,inserts=0,excluded:any,profiles=7;
  const c={query:async(sql:string,args:any[]=[])=>{
   let rows:any[]=[];
   if(sql.includes('pg_current_xact_id()'))rows=[{root:'xid',start:'start',pid:1,role:'dyna_app',tenant}];
   else if(sql.startsWith('SELECT r.id,r.actor_id'))rows=[{id:runId,actor_id:user,profile_config_version:2,config:{shopify_collection:definition()}}];
   else if(sql.includes('to_regprocedure'))rows=[{present:true}];
   else if(sql==='SELECT competitor_observation_available() available')rows=[{available:true}];
   else if(sql.includes('competitor_observation_worker_identity')){reads++;if(drift&&reads===3)throw {code:'42501'};rows=[{identity:{role:'admin',account_version:'1',policy:null}}];}
   else if(sql.includes('competitor_observation_identity('))assert.fail('Scheduled core must not request HTTP identity');
   else if(sql.startsWith('SELECT id,name,currency'))rows=[{id:list,active:true,currency:'PLN'}];
   else if(sql.startsWith('SELECT * FROM repricing_rules'))rows=[{version:31}];
   else if(sql.startsWith('SELECT *,to_jsonb(p)'))rows=[{...profile,data_version:0,snapshot:profile}];
   else if(sql.startsWith('SELECT * FROM competitor_observation_batches'))rows=[];
   else if(sql.startsWith('SELECT id,kind FROM products'))rows=[{id:product,kind:'simple'}];
   else if(sql.startsWith('SELECT to_char(clock_timestamp()'))rows=[{stamp:'2026-10-13T00:00:00.000000Z'}];
   else if(sql.startsWith('INSERT INTO competitor_observation_batches'))inserts++;
   else if(sql.startsWith('UPDATE competitor_observation_profiles'))profiles++;
   else if(sql.startsWith('UPDATE repricing_rules SET version='))rows=[{version:32}];
   else if(sql.startsWith('UPDATE repricing_runs SET state=')){excluded=args;rows=[];}
   else if(sql.startsWith('SELECT id,price_list_id,client_key'))rows=[{id:'new-batch',count:1}];
   else if(sql.startsWith('SELECT price_list_id,version'))rows=[{...profile,version:profiles}];
   return {rows,rowCount:rows.length};
  }};
  api.beginCompetitorObservationTransaction(c);
  const raw={client_key:runId,profile_version:7,local_observations_confirmed:true,observations:[{product_id:product,source_namespace:source.source_namespace,
   offer_id:'configured-variant',seller_id:'shopify:competitor.example',currency:'PLN',price_gross_minor:'100',delivery_gross_minor:'499',available:true,observed_at:'2026-10-12T12:00:00.000000Z'}]};
  if(drift){await assert.rejects(api.importScheduledCompetitorObservationsInTx(c,job,list,raw),(e:unknown)=>e instanceof Problem&&e.status===403);assert.equal(inserts,0);}
  else{const result=await api.importScheduledCompetitorObservationsInTx(c,job,list,raw);assert.equal(result.rule_version,32);assert.equal(inserts,1);assert.deepEqual(excluded,[list,runId]);}
  api.endCompetitorObservationTransaction(c);
 }
});
test('actual service schedule config uses original request/current native IAM, profile/rule/schedule CAS and one cadence version',async()=>{
 for(const fault of ['none','readonly','viewer','stale','terminal'] as const){
  const sqls:string[]=[],argsList:any[][]=[];let connected=0,cancelled=0;
  const c={release(){},query:async(sql:string,args:any[]=[])=>{
   sqls.push(sql);argsList.push(args);let rows:any[]=[];
   if(sql.startsWith('SELECT m.role,'))rows=[{role:fault==='viewer'?'viewer':'admin',account_version:'1',scope_ok:true,mfa_required:false}];
   else if(sql.includes('pg_current_xact_id()'))rows=[{root:'tx',start:'start',pid:1,role:'dyna_app',tenant}];
   else if(sql.includes('to_regprocedure'))rows=[{present:true}];
   else if(sql==='SELECT competitor_observation_available() available')rows=[{available:true}];
   else if(sql.includes('competitor_observation_identity'))rows=[{identity:{role:'admin',version:'1'}}];
   else if(sql.includes('competitor_observation_terminal')){if(fault==='terminal')throw {code:'42501'};rows=[{}];}
   else if(sql.startsWith('SELECT id,name,currency'))rows=[{id:list,active:true,currency:'PLN'}];
   else if(sql.startsWith('SELECT * FROM repricing_rules'))rows=[{config:{enabled:true,strategy:'competitor_rank'},config_version:6}];
   else if(sql.startsWith('SELECT price_list_id,version'))rows=[profile];
   else if(sql.startsWith('SELECT * FROM repricing_schedules'))rows=[{version:3,batch_size:150}];
   else if(sql.startsWith('UPDATE repricing_rules SET config='))rows=[{config_version:7}];
   else if(sql.startsWith('INSERT INTO repricing_schedules'))rows=[{version:4,enabled:true,rule_config_version:7}];
   return {rows,rowCount:rows.length};
  }};
  const api=observationModule({'./repricing-schedules':{cancelRepricingRunsInTx:async()=>{cancelled++;}}});
  const service=api.createCompetitorObservationService({pool:{connect:async()=>{connected++;return c;}},cursorKey:'a'.repeat(64),sessionName:'dyna_session',readOnly:fault==='readonly'});
  const req={actor:{tenantId:tenant,userId:user,role:fault==='viewer'?'viewer':'admin'},currentUser:{id:user,tenant_id:tenant},headers:{},cookies:{dyna_session:'synthetic-unit-session-not-a-real-account'}};
  const body={version:fault==='stale'?4:3,rule_config_version:6,profile_version:7,enabled:true,interval_minutes:5,
   sources:[source],mode:'collect_then_reprice',local_observations_confirmed:true,collection_confirmed:true,price_changes_confirmed:true};
  if(fault==='none'){const result=await service.putCollectionSchedule(req,list,body);assert.equal(result.schedule.version,4);assert.equal(result.purpose,'collect_then_reprice');assert.equal(cancelled,1);assert(sqls.includes('COMMIT'));
   const q=sqls.findIndex(s=>s.startsWith('UPDATE repricing_rules SET config='));const stored=JSON.parse(argsList[q][1]);assert.equal(stored.profile_config_version,2);assert.equal(stored.sources[0].variant_id,'20');
   assert.equal(argsList[sqls.findIndex(s=>s.startsWith('INSERT INTO repricing_schedules'))][6],150);
  }else{await assert.rejects(service.putCollectionSchedule(req,list,body));assert(!sqls.includes('COMMIT'));if(fault==='readonly')assert.equal(connected,0);else assert(sqls.includes('ROLLBACK'));}
 }
});
test('actual existing schedule/run API preserves run-key idempotency and pins profile version into ordinary worker job',async()=>{
 const queries:{sql:string;args:any[]}[]=[];let old:any=null;
 const c={query:async(sql:string,args:any[]=[])=>{
  queries.push({sql,args});let rows:any[]=[];
  if(sql.startsWith('SELECT * FROM price_lists'))rows=[{id:list,active:true,currency:'PLN',version:4}];
  else if(sql.startsWith('SELECT * FROM repricing_rules'))rows=[{version:31,config_version:6,config:{enabled:true,shopify_collection:definition()}}];
  else if(sql.startsWith('SELECT * FROM repricing_schedules'))rows=[{enabled:true,version:3,actor_id:user,rule_config_version:6,batch_size:50}];
  else if(sql.startsWith('SELECT * FROM repricing_runs WHERE client_key'))rows=old?[old]:[];
  else if(sql.includes('offer_sync_is_admin'))rows=[{ok:true}];
  else if(sql.startsWith('SELECT count(*)::int n FROM jobs'))rows=[{n:0}];
  else if(sql.startsWith('SELECT count(*)::int total'))rows=[{total:1,upper_id:product}];
  else if(sql.startsWith('SELECT * FROM competitor_observation_profiles'))rows=[profile];
  else if(sql.startsWith('INSERT INTO repricing_runs')){old={id:args[0],price_list_id:list,schedule_version:3};rows=[old];}
  return {rows,rowCount:rows.length};
 }};
 const api=load('repricing-schedules.ts',{'node:crypto':crypto,'zod':{z},'./errors':{ensure,Problem},'./competitor-shopify-schedule':schedule,
 './competitor-shopify-collector':{},'./repricing':{},'./repricing-rules':historyUnused,'./repricing-channel':channelUnused,'./domain':{audit:async()=>{}},'./db':{pool:{},tenantTx:async(_t:string,fn:(c:any)=>unknown)=>fn(c)}});
 const app=Fastify();app.addHook('onRequest',async(req:any)=>{req.actor={tenantId:tenant,userId:user,role:'admin'};});
 app.setErrorHandler((e,_r,reply)=>reply.code(e instanceof Problem?e.status:500).send({}));api.registerRepricingScheduleRoutes(app);
 try{
  const payload={version:3,client_key:runId},url=`/api/price-lists/${list}/repricing/schedule/run`;
  const first=await app.inject({method:'POST',url,payload});assert.equal(first.statusCode,200);
  const inserted=queries.filter(q=>q.sql.startsWith('INSERT INTO jobs'));assert.equal(inserted.length,1);
  const queued=JSON.parse(inserted[0].args[2]);assert.equal(queued.collection_profile_version,7);assert.equal(queued.run_id,first.json().id);
  const second=await app.inject({method:'POST',url,payload});assert.equal(second.json().replayed,true);
  assert.equal(queries.filter(q=>q.sql.startsWith('INSERT INTO jobs')).length,1);
  assert.equal((await app.inject({method:'POST',url,payload:{...payload,version:4}})).statusCode,409);
 }finally{await app.close();}
});
test('collection schedule inputs refuse missing price/gross/delivery/import consent before any service write',()=>{
 const body={version:0,rule_config_version:6,profile_version:7,enabled:true,interval_minutes:5,sources:[source],
  mode:'collect_then_reprice',local_observations_confirmed:true,collection_confirmed:true,price_changes_confirmed:true};
 for(const field of ['local_observations_confirmed','collection_confirmed','price_changes_confirmed'])assert.throws(()=>schedule.shopifyCollectionScheduleInput.parse({...body,[field]:false}));
 assert.throws(()=>schedule.shopifyCollectionScheduleInput.parse({...body,sources:[{...source,fixed_delivery_confirmed:false}]}));
 assert.throws(()=>schedule.shopifyCollectionScheduleInput.parse({...body,sources:[{...source,gross_prices_confirmed:false}]}));
 assert.equal(schedule.shopifyCollectionScheduleInput.parse({...body,mode:'collection_only',price_changes_confirmed:false}).mode,'collection_only');
});
