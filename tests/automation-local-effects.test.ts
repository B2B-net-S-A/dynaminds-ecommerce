import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';
import {z} from 'zod';
import Fastify from 'fastify';
import {ensure,Problem} from '../server/errors';
import * as wooOrigins from '../shared/local-woo-origins';
const require=createRequire(import.meta.url);
// These controls execute the actual modules. PostgreSQL transactions, offer/SMTP
// processors and timers are explicitly modeled; no pool, listener or wire opens.
function load(name:string,deps:Record<string,any>={},globals:Record<string,any>={}){
 const source=readFileSync(new URL('../server/'+name+'.ts',import.meta.url),'utf8');
 const code=transformSync(source,{loader:'ts',format:'cjs',target:'es2022'}).code,m={exports:{}};
 new Function('module','require',...Object.keys(globals),code)(m,(key:string)=>{
  if(key in deps)return deps[key];if(key==='./smtp')return smtpPolicy();if(key==='./errors')return{ensure,Problem};if(key==='../shared/local-woo-origins')return wooOrigins;
  if(!key.startsWith('.'))return require(key);throw Error('Unmodeled dependency '+key);
 },...Object.values(globals));return m.exports as any;
}
function smtpPolicy(localSmtpPort?:number){return load('smtp',{'./db':{localConfig:{encryptionKey:'27'.repeat(32),...(localSmtpPort===undefined?{}:{localSmtpPort})}},'./integrations':{publicAddresses:()=>assert.fail('No external DNS in controlled SMTP policy tests')}});}
const hashes=load('email-hash');
// a75087a: email.ts renders tags through the actual message-variables module; the modeled templates use only row tags.
const messageVariables=load('message-variables',{'./db':{localConfig:{encryptionKey:'27'.repeat(32)}},'./buyer-address':{effectiveDeliveryInTx:()=>assert.fail('No delivery address tag in controlled SMTP templates')}});
const emailActions=load('email-actions',{'./email':{}}),smsActions=load('sms-actions',{'./sms':{}});
const schema=load('operation-schema',{'./email-actions':emailActions,'./sms-actions':smsActions,'./customer-message-workflow-schema':load('customer-message-workflow-schema')});
const policy=load('local-automation-worker-policy',{'./operation-schema':schema});
const id=(n:number)=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const tenant=id(1),owner=id(2),channel=id(3),warehouse=id(4),listing=id(5),product=id(6),order=id(7),runId=id(8),jobId=id(9),ruleId=id(10),eventId=id(11);
const actor={tenantId:tenant,userId:owner,role:'admin'};
const stockAction={type:'sync_local_woo_stock',channel_id:channel,warehouse_id:warehouse};
const emailAction={type:'email',template_id:id(12),mode:'smtp',channel_id:id(13),confirm_external:false};
const rule=(actions:any[])=>({id:ruleId,tenant_id:tenant,actor_id:owner,name:'Local V2',trigger:'order.created',enabled:true,priority:50,delay_seconds:0,version:'2',action:'actions',config:{match:'all',conditions:[],actions}});
const woo=()=>({id:channel,tenant_id:tenant,provider:'woocommerce',mode:'sandbox',sync_enabled:false,credentials:'encrypted-test-only',settings:{store_url:'https://localhost:8443',simulation:false,local_http_fixture:{schema:'local-woo-http-fixture/v1',fixture_id:id(14),owner_id:owner}}});
const smtp=()=>({id:id(13),tenant_id:tenant,provider:'smtp',mode:'sandbox',settings:{delivery:'local_sink',host:'127.0.0.1',port:1025,from_email:'sender@example.test'}});
function effects(c:any,offers:any={},ownerPort?:number){return load('automation-local-effects',{'./smtp':smtpPolicy(ownerPort),'./automation-local-channel':load('automation-local-channel'),'./db':{tenantTx:async(t:string,fn:any)=>{assert.equal(t,tenant);return fn(c);}},'./offers':{offerInput:{parse:(x:any)=>x},...offers}});}
test('actual rule schema and opt-in allow status/stock/local SMTP, reject external email/SMS and message workflow',()=>{
 for(const action of [{type:'set_status',status:'paid'},stockAction,{...stockAction,listing_id:listing},emailAction])assert(policy.supportedAutomaticRule(rule([action])));
 for(const action of [{...emailAction,confirm_external:true},{type:'email',template_id:id(12),mode:'local'},{type:'sms',template_id:id(12),mode:'local'}])assert(!policy.supportedAutomaticRule(rule([action])));
 assert.throws(()=>schema.orderAction.parse({...stockAction,price:true}));assert.throws(()=>schema.orderAction.parse({...stockAction,channel_id:'foreign'}));
 assert(!policy.supportedAutomaticRule({...rule([{type:'customer_message_note',body:'abc'}]),trigger:'customer_message.received'}));
});
test('actual frozen comparison accepts only generated versions/hashes; explicit definitions and action order remain exact',()=>{
 const a=rule([emailAction,stockAction,{type:'set_workflow',status_id:id(15)}]);
 const b=structuredClone(a);Object.assign(b.config.actions[0],{template_version:'4',channel_hash:'a'.repeat(64)});Object.assign(b.config.actions[1],{channel_hash:'b'.repeat(64)});Object.assign(b.config.actions[2],{status_version:'5'});
 assert(policy.sameDefinition(a,b));b.config.actions[1].channel_id=id(20);assert(!policy.sameDefinition(a,b));
 const exact=rule([{...stockAction,channel_hash:'a'.repeat(64)}]);assert(!policy.sameDefinition(exact,rule([{...stockAction,channel_hash:'b'.repeat(64)}])));
 assert(!policy.sameDefinition(a,rule([stockAction,emailAction,{type:'set_workflow',status_id:id(15)}])));
});
test('actual event retains order history/outbound/status signals but creates no empty dispatcher; configured rules still freeze and queue once',async()=>{
 for(const configured of [false,true]){
  const calls:string[]=[],sqls:string[]=[],rules=configured?[rule([stockAction])]:[];
  const c={query:async(sql:string)=>{sqls.push(sql);if(sql.startsWith('SELECT id,status'))return{rows:[{id:order,status:'new',source:'woocommerce'}]};if(sql.startsWith('SELECT sku,quantity'))return{rows:[{sku:'component',quantity:2}]};if(sql.startsWith('SELECT * FROM automation_rules'))return{rows:rules};if(sql.startsWith('SELECT 1 FROM automation_rules'))return{rows:[],rowCount:0};return{rows:[],rowCount:1};}};
  const events=load('events',{'./automation-v2-triggers':load('automation-v2-triggers'),'./customer-message-workflow-schema':load('customer-message-workflow-schema'),'./email-actions':{freezeEmailActions:async(_c:any,a:any)=>a},'./sms-actions':{freezeSmsActions:async(_c:any,a:any)=>a},'./automation-local-channel':{freezeAutomaticStockActions:async(_c:any,t:any,o:any,a:any)=>{assert.equal(t,tenant);assert.equal(o,owner);calls.push('freeze');return a;}},'./order-status-signals':{signalStatus:async()=>{calls.push('status');}},'./outbound-webhooks':{enqueueOutgoing:async()=>{calls.push('outbound');}}});
  await events.event(c,tenant,order,'order.created');assert.equal(sqls.filter(s=>s.startsWith('INSERT INTO order_events')).length,1);assert.equal(sqls.filter(s=>s.startsWith('INSERT INTO jobs')).length,configured?1:0);assert.deepEqual(calls,configured?['freeze','outbound','status']:['outbound','status']);
 }
});
test('actual local channel checks refuse foreign owner/origin/provider/live/simulation/drift; all seven finite ports admitted',async()=>{
 let ch=woo();const c={query:async()=>({rows:[ch],rowCount:1})},e=effects(c);
 for(const origin of wooOrigins.LOCAL_WOO_ORIGINS){ch.settings.store_url=origin;await e.automaticStockChannel(c,tenant,owner,stockAction);}
 const original=woo();for(const mutate of [(x:any)=>x.provider='allegro',(x:any)=>x.mode='live',(x:any)=>x.settings.simulation=true,(x:any)=>x.settings.local_http_fixture.owner_id=id(20),(x:any)=>x.settings.store_url='https://remote.example',(x:any)=>x.settings.store_url='https://localhost:8445']){ch=structuredClone(original);mutate(ch);await assert.rejects(()=>e.automaticStockChannel(c,tenant,owner,stockAction));}
 ch=original;const action={...stockAction,channel_hash:e.automaticChannelHash(ch)};ch.credentials='rotated';await assert.rejects(()=>e.automaticStockChannel(c,tenant,owner,action));
});
test('actual admission requires construction-selected channel, own warehouse/listing and strictly local SMTP',async()=>{
 let ch:any=woo();const c={query:async(sql:string)=>sql.includes('FROM channels')?{rows:[ch],rowCount:1}:{rows:[],rowCount:1}},e=effects(c);
 await assert.rejects(()=>e.validateAutomaticEffectsInTx(c,tenant,owner,[stockAction],[]));await e.validateAutomaticEffectsInTx(c,tenant,owner,[stockAction],[channel]);
 ch=smtp();await e.validateAutomaticEffectsInTx(c,tenant,owner,[emailAction],[]);ch.settings.delivery='external';await assert.rejects(()=>e.validateAutomaticEffectsInTx(c,tenant,owner,[emailAction],[]));
 ch=smtp();ch.settings.host='localhost';await assert.rejects(()=>e.automaticLocalEmailChannel(c,tenant,ch.id));
});
function queueModel({count=2,active=0,duplicate=false,collision=false}:{count?:number;active?:number;duplicate?:boolean;collision?:boolean}={}){
 const inserted:any[]=[],sqls:string[]=[];let lastPayload:any;const rows=Array.from({length:count},(_,i)=>({id:id(30+i),product_id:id(40+i),warehouse_id:warehouse}));
 const c={query:async(sql:string,args:any[]=[])=>{sqls.push(sql);if(sql.includes('FROM channels'))return{rows:[woo()],rowCount:1};if(sql.includes('FROM order_pick_items'))return{rows,rowCount:rows.length};if(sql.includes('count(*)'))return{rows:[{n:active}]};
  if(sql.startsWith('INSERT INTO jobs')){lastPayload=JSON.parse(args[3]);inserted.push(lastPayload);return{rows:duplicate?[]:[{id:id(50+inserted.length)}]};}
  if(sql.startsWith('SELECT id,payload'))return{rows:[{id:id(60),payload:collision?{bad:true}:lastPayload}]};return{rows:[],rowCount:1};}};
 return{c,e:effects(c),inserted,sqls};
}
const context={chain_id:id(70),depth:0,trace:[],operation:{kind:'rule',id:runId,action_index:0}};
test('actual stock queue expands physical bundle picks to every mapped listing, one immutable dedup identity each',async()=>{
 const q=queueModel(),r=await q.e.queueAutomaticStockAction(q.c,actor,order,stockAction,context);
 assert.equal(r.stock_sync.job_ids.length,2);assert.equal(q.inserted.length,2);assert(q.sqls.find(x=>x.includes('FROM order_pick_items'))?.includes("p.kind IN('simple','variant')"));
 for(const p of q.inserted){assert.equal(p.run_id,runId);assert.equal(p.owner_id,owner);assert.equal(p.order_id,order);assert.equal(p.action_index,0);assert.equal(p.action.type,'sync_local_woo_stock');}
 assert(q.sqls.some(s=>s.includes('ON CONFLICT(tenant_id,dedup_key) DO NOTHING')));
});
test('actual queue preview/manual denial/no mappings/bounds/full queue and dedup collision cause no duplicate effects',async()=>{
 const preview=queueModel();assert.equal((await preview.e.queueAutomaticStockAction(preview.c,actor,order,stockAction,{preview:true})).stock_sync.state,'preview');assert.equal(preview.inserted.length,0);
 const manual=queueModel();await assert.rejects(()=>manual.e.queueAutomaticStockAction(manual.c,actor,order,stockAction));assert.equal(manual.inserted.length,0);
 const none=queueModel({count:0});assert.equal((await none.e.queueAutomaticStockAction(none.c,actor,order,stockAction,context)).stock_sync.state,'no_linked_physical_products');
 for(const args of [{count:201},{active:999},{count:0}]){const q=queueModel(args);await assert.rejects(()=>q.e.queueAutomaticStockAction(q.c,actor,order,args.count===0?{...stockAction,listing_id:listing}:stockAction,context));assert.equal(q.inserted.length,0);}
 const duplicate=queueModel({count:1,duplicate:true});assert.equal((await duplicate.e.queueAutomaticStockAction(duplicate.c,actor,order,stockAction,context)).stock_sync.job_ids[0],id(60));
 const collision=queueModel({count:1,duplicate:true,collision:true});await assert.rejects(()=>collision.e.queueAutomaticStockAction(collision.c,actor,order,stockAction,context));
});
function processModel({drift=false,badPlan=false,processorFailure=false,cleanupFailure=false}:{drift?:boolean;badPlan?:boolean;processorFailure?:boolean;cleanupFailure?:boolean}={}){
 const calls:string[]=[],sqls:string[]=[],primary=new Error('modeled wire failure');let current=true;
 const job={id:jobId,tenant_id:tenant,kind:'automation.local_stock',lease_token:id(80),payload:{run_id:runId,owner_id:owner,product_id:product,listing_id:listing,action:stockAction}};
 const plan={id:id(81),actor_id:owner,channel_id:channel,listing_id:listing,product_id:product,operation:'sync',state:'preview',input:{stock:true,price:false},payload:{manage_stock:true,stock_quantity:4,backorders:'no',...(badPlan?{regular_price:'99'}:{})}};
 const child={id:id(82),tenant_id:tenant,kind:'offer.write',lease_token:id(83),payload:{plan_id:plan.id,actor_id:owner,channel_id:channel}};
 const c={query:async(sql:string,args:any[]=[])=>{sqls.push(sql);if(sql.includes('FROM channels'))return{rows:[woo()]};if(sql.startsWith('SELECT * FROM offer_plans'))return{rows:[plan]};if(sql.startsWith('UPDATE jobs SET state=\'running\''))return{rows:[child]};if(sql.includes('SELECT p.*,j.state'))return{rows:[{...plan,job_id:child.id,job_state:'done',state:'done',phase:'done',result:{desired_applied:true},payload:plan.payload}]};return{rows:[],rowCount:1};}};
 const e=effects(c,{previewOffer:async(_a:any,_ch:any,input:any,ctx:any)=>{calls.push('preview');assert.equal(input.stock,true);assert.equal(input.price,false);await ctx.transport('https://localhost:8443/wp-json/wc/v3/products/17',{method:'GET'});if(drift)current=false;return{id:plan.id};},queueOffer:async()=>{calls.push('queue');return{job_id:child.id};},processOfferJob:async(_job:any,ctx:any)=>{calls.push('processor');assert(sqls.some(s=>s.includes('payload=payload||')));await ctx.transport('https://localhost:8443/wp-json/wc/v3/products/17',{method:'PUT'});if(processorFailure)throw primary;},failOffer:async()=>{calls.push('fail');if(cleanupFailure)throw new Error('secondary cleanup');}});
 const transport=async(_url:any,_init:any)=>{calls.push('transport');return{};},guard=async()=>{calls.push('guard');ensure(current,409,'Disabled after preview');};
 return{e,job,calls,sqls,primary,guard,context:{transport,localWooChannelIds:[channel]}};
}
test('actual stock processor persists exact child identity before one stock-only offer processor, fences every transport and verifies native ACK',async()=>{
 const q=processModel();await q.e.processAutomaticStock(q.job,q.context,q.guard);assert.equal(q.calls.filter(x=>x==='queue').length,1);assert.equal(q.calls.filter(x=>x==='processor').length,1);assert.equal(q.calls.filter(x=>x==='transport').length,2);assert(q.sqls.at(-1)?.includes("state='done'"));
 for(let n=0;n<q.calls.length;n++)if(q.calls[n]==='transport')assert(q.calls.slice(0,n).includes('guard'));
});
test('actual stock processor refuses absent selection/transport, connection/activation change and price payload before dispatch; unknown never retries',async()=>{
 const absent=processModel();await assert.rejects(()=>absent.e.processAutomaticStock(absent.job,{transport:absent.context.transport,localWooChannelIds:[]},absent.guard));assert.equal(absent.calls.length,0);
 for(const options of [{drift:true},{badPlan:true}]){const q=processModel(options);await assert.rejects(()=>q.e.processAutomaticStock(q.job,q.context,q.guard));assert(!q.calls.includes('queue'));assert(!q.calls.includes('processor'));}
 const failed=processModel({processorFailure:true,cleanupFailure:true});await assert.rejects(()=>failed.e.processAutomaticStock(failed.job,failed.context,failed.guard),e=>e===failed.primary);assert.equal(failed.calls.filter(x=>x==='processor').length,1);assert(!failed.sqls.some(s=>s.includes("state='done'")));
});
test('actual effect readback separates known offer ACK from unconfirmed parent and SMTP acceptance from delivery; no writes',async()=>{
 const sqls:string[]=[],c={query:async(sql:string)=>{sqls.push(sql);return{rows:sql.includes('FROM jobs j')?[{id:jobId,state:'failed',error:'controlled',created_at:'today',payload:{run_id:runId,action:stockAction,listing_id:listing,effect_job_id:id(82)},plan_state:'done',phase:'done',effect_state:'done',result:{desired_applied:true},plan_payload:{stock_quantity:4}}]:[{id:id(90),automation_run_id:runId,channel_id:id(13),job_id:id(91),state:'smtp_accepted',job_state:'done',created_at:'today'}]};}},e=effects(c);
 const rows=(await e.readAutomaticEffects(c,[runId])).get(runId);assert.equal(rows[0].outcome,'VERIFIED');assert.equal(rows[0].parent_acknowledged,false);assert.equal(rows[0].verified_stock,4);assert.equal(rows[1].outcome,'SMTP_ACCEPTED_NOT_DELIVERED');assert(sqls.every(s=>s.startsWith('SELECT')));assert(!JSON.stringify(rows).includes('credentials'));
});
function leaseModel(kind='automation.run'){
 const action=kind==='email.send'?emailAction:kind==='automation.local_stock'?stockAction:{type:'set_status',status:'paid'};
 const base:any=rule([action]);base.config.local_worker={schema:policy.WORKER_SCHEMA,enabled:true,owner_id:owner,rule_version:'2',enabled_at:'2026-10-16T01:00:00Z',client_key:id(95)};
 const run={id:runId,tenant_id:tenant,rule_id:ruleId,rule_version:'2',event_id:eventId,order_id:order,job_id:jobId,state:'queued',definition:{...schema.normalizedRule(base),actor_id:owner},result:{actions:[]}};
 const job:any={id:jobId,tenant_id:tenant,kind,state:'pending',attempts:0,lease_token:null,locked_at:null,payload:kind==='email.send'?{message_id:id(96)}:kind==='automation.local_stock'?{run_id:runId,owner_id:owner,order_id:order,listing_id:listing,product_id:product,action_index:0,action:stockAction}:{run_id:runId}};let selected=true;
 const message={id:id(96),job_id:jobId,automation_run_id:runId,actor_id:owner,order_id:order,batch_id:id(97),state:'queued',attempted_at:null,mode:'smtp',channel_id:id(13),sender:{local_sink:true},payload:{recipient:'buyer@example.test'}};
 if(kind!=='automation.run'){run.state='done';run.result.actions=kind==='email.send'?[{email:{message_id:message.id,batch_id:message.batch_id}}]:[{stock_sync:{job_ids:[jobId]}}] as any;}
 const sqls:string[]=[];const c={query:async(sql:string,args:any[]=[])=>{sqls.push(sql);if(sql.startsWith('SELECT * FROM automation_rules'))return{rows:[base]};if(sql.includes('offer_sync_is_admin'))return{rows:[{ok:true}]};if(sql.startsWith('SELECT j.*')){const matches=sql.includes("j.kind='"+kind+"'");const rows=selected&&matches?[job]:[];if(rows.length)selected=false;return{rows};}if(sql.startsWith('SELECT m.*,b.automation_run_id'))return{rows:[message]};if(sql.includes('FROM channels'))return{rows:[args[1]===channel?woo():smtp()],rowCount:1};if(sql.startsWith('SELECT * FROM automation_runs'))return{rows:[run]};if(sql.startsWith('SELECT * FROM order_events'))return{rows:[{id:eventId,order_id:order,kind:'order.created'}]};if(sql.startsWith('UPDATE jobs SET state='))return{rows:[{...job,state:'running',attempts:1,max_attempts:1,lease_token:args[2],locked_at:'now'}]};return{rows:[],rowCount:1};}};
 const control=load('local-automation-worker-control',{'./db':{tenantTx:async(_t:any,fn:any)=>fn(c),tenantReadTx:async(_t:any,fn:any)=>fn(c)},'./domain':{audit:async()=>{}},'./operation-schema':schema,'./local-automation-worker-policy':policy,'./automation-local-effects':effects(c),'./automation-unresolved-effects':{readUnresolvedAutomaticEffects:()=>assert.fail('No unresolved read in this control test')}});
 return{control,c,base,job,run,message,sqls};
}
test('actual opt-in claim and branded lease bind immutable job/rule/event, reject forged/mutated/revoked authority without global reaper',async()=>{
 const q=leaseModel(),held=await q.control.claimAutomaticJob(tenant,ruleId);assert(held);await q.control.requireAutomaticLeaseInTx(q.c,held.lease,held.job);await assert.rejects(()=>q.control.requireAutomaticLeaseInTx(q.c,{},held.job));
 held.job.payload.run_id=id(99);await assert.rejects(()=>q.control.requireAutomaticLeaseInTx(q.c,held.lease,held.job));held.job.payload.run_id=runId;q.base.enabled=false;await assert.rejects(()=>q.control.requireAutomaticLeaseInTx(q.c,held.lease,held.job));
 assert(q.sqls.some(s=>s.includes('j.attempts=0')&&s.includes('FOR UPDATE OF j SKIP LOCKED')));assert(!q.sqls.some(s=>s.includes("interval '2 minutes'")));
});
test('actual Fastify metadata route uses only construction-selected own channels and current admin; no secrets/writes',async()=>{
 for(const ownerPort of [1025,2525]){
 let role='admin';const selected=[channel],sqls:string[]=[],ch={...woo(),name:'Local A'};
 if(ownerPort===2525)ch.settings.store_url='https://localhost:18447';
 const c={query:async(sql:string,args:any[]=[])=>{sqls.push(sql);if(sql.includes('packing_current_role'))return{rows:[{role}]};
  if(sql.includes("provider='woocommerce'")){assert.deepEqual(args,[tenant,[channel],owner,wooOrigins.LOCAL_WOO_ORIGINS]);assert(sql.includes("settings->'local_http_fixture'->>'schema'")&&sql.includes("settings->>'store_url'=ANY($4::text[])"));return{rows:[{id:ch.id,name:ch.name,settings:ch.settings}]};}
  if(sql.includes('FROM listings'))return{rows:[{id:listing,channel_id:channel,product_id:product,sku:'BUNDLE-PHYSICAL',warehouse_id:warehouse}]};
  if(sql.includes("provider='smtp'")){assert(sql.includes("settings->>'port'=$2"));assert.deepEqual(args,[tenant,String(ownerPort)]);return{rows:[{id:id(13),name:'Local mail'}]};}if(sql.includes('FROM warehouses'))return{rows:[{id:warehouse,name:'Main'}]};throw Error(sql);}};
 const e=effects(c,{},ownerPort),control=load('local-automation-worker-control',{'./smtp':smtpPolicy(ownerPort),'./db':{tenantTx:async(_t:any,fn:any)=>fn(c),tenantReadTx:async(t:any,fn:any)=>{assert.equal(t,tenant);return fn(c);}},'./domain':{audit:async()=>{}},'./operation-schema':schema,'./local-automation-worker-policy':policy,'./automation-local-effects':e,'./automation-unresolved-effects':{readUnresolvedAutomaticEffects:()=>assert.fail('No unresolved read in this metadata test')}});
 const app=Fastify();app.addHook('preHandler',async req=>{(req as any).actor={...actor,role:req.headers['x-test-role']??'admin',apiKeyId:req.headers['x-test-key']?id(100):undefined};});app.setErrorHandler((err:any,_req,reply)=>reply.code(err.status??500).send({error:err.message}));
 control.registerAutomaticWorkerControl(app,{readOnly:false,available:true,localWooChannelIds:selected});selected.push(id(110));
 try{const r=await app.inject({method:'GET',url:'/api/automations/local-effects/options'});assert.equal(r.statusCode,200,r.body);const body=r.json();assert.equal(body.channels.length,1);assert.equal(body.channels[0].listings[0].product_id,product);assert.equal(body.processor_running,false);assert.equal(body.channels[0].enrolled,true);assert(!r.body.includes('credentials'));assert(!r.body.includes('encrypted-test-only'));assert(!r.body.includes('store_url'));
  for(const headers of [{'x-test-role':'viewer'},{'x-test-key':'yes'}])assert.equal((await app.inject({method:'GET',url:'/api/automations/local-effects/options',headers})).statusCode,403);
  role='viewer';assert.equal((await app.inject({method:'GET',url:'/api/automations/local-effects/options'})).statusCode,403);assert(sqls.every(s=>s.startsWith('SELECT')));
 }finally{await app.close();}
 }
});
test('actual stock/email child claims require exact done run output, own immutable origin and zero prior attempts',async()=>{
 for(const kind of ['automation.local_stock','email.send']){
  const q=leaseModel(kind),held=await q.control.claimAutomaticJob(tenant,ruleId,{localWooChannelIds:[channel]});assert.equal(held.job.kind,kind);await q.control.requireAutomaticLeaseInTx(q.c,held.lease,held.job);
  q.run.result.actions=[];await assert.rejects(()=>q.control.requireAutomaticLeaseInTx(q.c,held.lease,held.job));
  const attempted=leaseModel(kind);attempted.job.attempts=1;await assert.rejects(()=>attempted.control.claimAutomaticJob(tenant,ruleId,{localWooChannelIds:[channel]}));assert(!attempted.sqls.some(s=>s.startsWith('UPDATE jobs SET state=')));
  const incomplete=leaseModel(kind);incomplete.run.state='queued';await assert.rejects(()=>incomplete.control.claimAutomaticJob(tenant,ruleId,{localWooChannelIds:[channel]}));
 }
 const foreign=leaseModel('email.send');foreign.message.actor_id=id(98);await assert.rejects(()=>foreign.control.claimAutomaticJob(tenant,ruleId));
 const foreignStock=leaseModel('automation.local_stock');await assert.rejects(()=>foreignStock.control.claimAutomaticJob(tenant,ruleId,{localWooChannelIds:[]}));
});
function workerModel(kind:string,hold=false){
 const calls:string[]=[],scheduled:(()=>void)[]=[],channels=[channel];let release:()=>void=()=>{},taken=false;
 const finish=new Promise<void>(r=>{release=r;});const job={kind,tenant_id:tenant,id:jobId,payload:{}};
 const worker=load('scoped-automation-worker',{'./db':{pool:{query:async()=>({rows:[{tenant_id:tenant,id:ruleId}]})}},'./automations':{dispatchAutomation:async()=>{calls.push('dispatch');},processAutomation:async()=>{calls.push('run');},failAutomation:async()=>{calls.push('fail');}},'./local-automation-worker-control':{claimAutomaticJob:async(_t:any,_r:any,ctx:any)=>{assert.deepEqual(ctx.localWooChannelIds,[channel]);if(taken)return null;taken=true;return{job,lease:{}};},requireAutomaticLeaseInTx:async()=>{calls.push('guard');}},'./email':{processEmail:async(_j:any,o:any)=>{assert.equal(o.localSinkOnly,true);await o.beforeAttemptInTx({});calls.push('email');if(hold)await finish;},failEmail:async()=>{calls.push('failEmail');}},'./automation-local-effects':{AUTOMATIC_STOCK_JOB:'automation.local_stock',processAutomaticStock:async(_j:any,ctx:any,guard:any)=>{assert(Object.isFrozen(ctx.localWooChannelIds));await guard({});calls.push('stock');if(hold)await finish;}}},{setTimeout:(cb:()=>void)=>{scheduled.push(cb);return{unref(){}};},clearTimeout:()=>{calls.push('clearTimer');}});
 return{runtime:worker.startScopedAutomationWorker({transport:async()=>{},localWooChannelIds:channels}),calls,scheduled,channels,release};
}
test('actual scoped worker dispatches only selected claimed identities; context snapshot and graceful close drain child effects',async()=>{
 for(const [kind,expected] of [['automation','dispatch'],['automation.run','run'],['automation.local_stock','stock'],['email.send','email']]){
  const q=workerModel(kind,true);q.channels.push(id(99));q.scheduled.shift()!();for(let i=0;i<15;i++)await Promise.resolve();assert(q.calls.includes(expected));let closed=false;const end=q.runtime.close().then(()=>{closed=true;});await Promise.resolve();if(['email.send','automation.local_stock'].includes(kind))assert(!closed);q.release();await end;assert(q.runtime.inspect().closing);assert.equal(q.runtime.inspect().active,0);assert.equal(q.runtime.inspect().accepted,'1');
 }
});

function emailModel({external=false,recipient='buyer@example.test',guardFailure=false,smtpFailure=false,ownerPort,channelPort=1025}:{external?:boolean;recipient?:string;guardFailure?:boolean;smtpFailure?:boolean;ownerPort?:number;channelPort?:number}={}){
 const calls:string[]=[],sqls:string[]=[],updates:any[]=[],ch=smtp();ch.settings.port=channelPort;if(external)ch.settings.delivery='external';
 const orderRow={id:order,version:'1',number:'T-1',customer_name:'Synthetic',email:recipient,total:1000,currency:'PLN',status:'new',source:'woocommerce'};
 const m={id:id(100),job_id:jobId,batch_id:id(101),order_id:order,state:'queued',attempted_at:null,actor_id:owner,mode:'smtp',channel_id:ch.id,channel_hash:hashes.emailChannelHash(ch),template_id:id(12),sender:{local_sink:true},snapshot:{subject:'Test',body:'Body',html:'',attachment:'none',version:'1'},payload:{recipient,subject:'Test',text:'Body',html:'<p>Body</p>'},origin:{actor_id:owner,order_guard:'content'}};
 const c={query:async(sql:string,args:any[]=[])=>{sqls.push(sql);if(sql.includes('SELECT id FROM jobs'))return{rows:[{id:jobId}],rowCount:1};if(sql.includes('SELECT m.*,b.actor_id'))return{rows:[m]};if(sql.startsWith('SELECT * FROM channels'))return{rows:[ch]};if(sql.startsWith('SELECT active FROM email_templates'))return{rows:[{active:true}]};if(sql.startsWith('SELECT * FROM orders'))return{rows:[orderRow]};if(sql.startsWith('SELECT tracking_number'))return{rows:[]};if(sql.startsWith('UPDATE email_messages SET state='))updates.push(args);return{rows:[],rowCount:1};}};
 const mod=load('email',{'./email-actions':{checkEmailOrigin:async()=>calls.push('origin'),lockEmailQueue:async()=>calls.push('queueLock')},'./team-email-recipients':{teamEmailAddresses:async()=>assert.fail('A buyer e-mail (no snapshot.team_user_id) never reads team recipients')},'./db':{pool:{query:async()=>({rows:[{role:'admin'}]})},tenantTx:async(_t:any,fn:any)=>fn(c)},'./domain':{audit:async()=>{}},'./smtp':{localSmtpPort:smtpPolicy(ownerPort).localSmtpPort,smtpSettings:{parse:(s:any)=>s},SmtpClient:class{async send(){calls.push('smtp');if(smtpFailure)throw Error('uncertain modeled wire');return{accepted_by_smtp:true,delivered:false,local_sink:true};}}},'./security':{decrypt:()=>({}),encrypt:()=>''},'./email-attachments':{emailAttachment:async()=>null,savedEmailFile:async()=>null,EMAIL_BATCH_FILE_LIMIT:1},'./email-hash':hashes,'./message-variables':messageVariables});
 const automatic={localSinkOnly:true,beforeAttemptInTx:async()=>{calls.push('guard');ensure(!guardFailure,403,'Revoked');}};
 return{mod,calls,sqls,updates,automatic,job:{id:jobId,tenant_id:tenant,lease_token:id(102),payload:{message_id:m.id}}};
}
test('actual SMTP prepare runs current source guard before attempted marker; only .test local sink reaches modeled send exactly once',async()=>{
 const q=emailModel();await q.mod.processEmail(q.job,q.automatic);assert.deepEqual(q.calls.slice(0,3),['guard','queueLock','origin']);assert.equal(q.calls.filter(x=>x==='smtp').length,1);assert(q.sqls.some(s=>s.includes('SET attempted_at=now()')));assert.equal(q.updates[0][1],'smtp_accepted');
 for(const options of [{external:true},{recipient:'buyer@example.com'},{guardFailure:true}]){const q=emailModel(options);await assert.rejects(()=>q.mod.processEmail(q.job,q.automatic));assert(!q.calls.includes('smtp'));assert(!q.sqls.some(s=>s.includes('SET attempted_at=now()')));}
 const unknown=emailModel({smtpFailure:true});await unknown.mod.processEmail(unknown.job,unknown.automatic);assert.equal(unknown.updates[0][1],'uncertain');assert.equal(unknown.calls.filter(x=>x==='smtp').length,1);
});

test('actual bounded effects page exposes sentinel truncation without changing the existing Map reader ABI',async()=>{
 const jobs=Array.from({length:501},(_,n)=>({id:id(8000+n),state:'pending',payload:{run_id:runId,action:{}},plan_state:null,phase:null,effect_state:null}));
 const emails=Array.from({length:501},(_,n)=>({id:id(9000+n),automation_run_id:runId,state:'queued',job_state:'pending'}));
 const c={query:async(sql:string)=>{assert(sql.startsWith('SELECT')&&sql.endsWith('LIMIT 501'));return{rows:sql.includes('FROM jobs j')?jobs:emails};}},e=effects(c);
 const page=await e.readAutomaticEffectsPage(c,[runId]);assert.equal(page.effects.get(runId).length,1000);assert.deepEqual(page.coverage,{per_kind_limit:500,stock_truncated:true,email_truncated:true});
 assert.deepEqual(await e.readAutomaticEffects(c,[runId]),page.effects);
 const empty=await e.readAutomaticEffectsPage({query:()=>assert.fail('Empty page performs no SQL')},[]);assert.equal(empty.effects.size,0);assert.deepEqual(empty.coverage,{per_kind_limit:500,stock_truncated:false,email_truncated:false});
});
test('actual complete reconciliation reader refuses missing or nullable aggregate acknowledgement',async()=>{
 for(const row of [undefined,{}, {stock_required:null,email_required:false},{stock_required:false,email_required:null},{stock_required:1,email_required:false}]){
  const c={query:async(sql:string,args:any[])=>{assert(sql.startsWith('SELECT')&&!sql.includes('LIMIT'));assert.deepEqual(args,[tenant,ruleId]);return{rows:row?[row]:[]};}},e=effects(c);
  await assert.rejects(()=>e.readAutomaticRuleReconciliation(c,tenant,ruleId));
 }
});


test('owner-selected port binds automatic admission and final SMTP scope; wrong profile refuses before attempted_at',async()=>{
 for(const ownerPort of [1025,2525]){
  let ch=smtp();ch.settings.port=ownerPort;const c={query:async()=>({rows:[ch],rowCount:1})},e=effects(c,{},ownerPort);
  await e.automaticLocalEmailChannel(c,tenant,ch.id);await e.validateAutomaticEffectsInTx(c,tenant,owner,[emailAction]);
  for(const mutate of [(x:any)=>x.settings.port=ownerPort===1025?2525:1025,(x:any)=>x.tenant_id=id(999),(x:any)=>x.mode='live',(x:any)=>x.settings.host='127.0.0.2',(x:any)=>x.settings.from_email='sender@example.com']){ch=smtp();ch.settings.port=ownerPort;mutate(ch);await assert.rejects(()=>e.automaticLocalEmailChannel(c,tenant,ch.id));}
  const q=emailModel({ownerPort,channelPort:ownerPort});await q.mod.processEmail(q.job,q.automatic);assert.equal(q.calls.filter(x=>x==='smtp').length,1);assert(q.sqls.some(s=>s.includes('SET attempted_at=now()')));
  const other=emailModel({ownerPort,channelPort:ownerPort===1025?2525:1025});await assert.rejects(()=>other.mod.processEmail(other.job,other.automatic));assert(!other.sqls.some(s=>s.includes('SET attempted_at=now()')));assert(!other.calls.includes('smtp'));
 }
});

test('actual smtp-example route selects only own matching profile port or inserts a new channel without changing old ones',async()=>{
 const source=readFileSync(new URL('../server/app.ts',import.meta.url),'utf8'),start=source.indexOf("  app.post('/api/integrations/smtp-example'"),end=source.indexOf("  app.get('/api/integrations',",start);assert(start>0&&end>start);
 const route=source.slice(start,end);assert.equal(route.match(/app.post/g)?.length,1);assert(route.trimEnd().endsWith('});'));
 for(const ownerPort of [1025,2525])for(const matching of [false,true]){
  const rows=[{id:id(201),tenant_id:tenant,port:1025},{id:id(202),tenant_id:id(999),port:2525},...(matching?[{id:id(203),tenant_id:tenant,port:ownerPort}]:[])],saved=structuredClone(rows),queries:any[]=[],inserted:any[]=[];let handler:any;
  const c={query:async(sql:string,args:any[]=[])=>{queries.push({sql,args});if(sql.startsWith('SELECT id FROM tenants'))return{rows:[{id:tenant}]};if(sql.startsWith('SELECT id FROM channels')){assert(sql.includes('tenant_id=$1')&&sql.includes("settings->>'port'=$2"));assert.deepEqual(args,[tenant,String(ownerPort)]);return{rows:rows.filter(r=>r.tenant_id===args[0]&&String(r.port)===args[1]).slice(0,1)};}assert(sql.startsWith('INSERT INTO channels'));const settings=JSON.parse(args[3]);assert.equal(settings.port,ownerPort);assert.equal(settings.host,'127.0.0.1');assert.equal(settings.delivery,'local_sink');assert(settings.from_email.endsWith('.test'));inserted.push(settings);return{rows:[{id:args[0]}]};}};
  const fn=transformSync(route,{loader:'ts',format:'cjs',target:'es2022'}).code;
  new Function('app','ensure','emailAvailable','canWrite','tenantTx','localSmtpPort','randomUUID','encrypt',fn)({post:(url:string,callback:any)=>{assert.equal(url,'/api/integrations/smtp-example');handler=callback;}},ensure,true,()=>{},async(t:string,work:any)=>{assert.equal(t,tenant);return work(c);},smtpPolicy(ownerPort).localSmtpPort,()=>id(204),()=> 'encrypted-empty-test-only');
  const result=await handler({actor});assert.equal(result.delivery,'local_sink');assert.deepEqual(rows,saved);assert(!queries.some(q=>q.sql.startsWith('UPDATE')));
  const expected=rows.find(r=>r.tenant_id===tenant&&r.port===ownerPort);assert.equal(result.channel_id,expected?.id??id(204));assert.equal(inserted.length,expected?0:1);
 }
});
