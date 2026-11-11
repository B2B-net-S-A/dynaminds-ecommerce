// Complete real service with explicit SQL/processor models; no PG, HTTP or provider calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const root=process.cwd(),key='__wooAttachmentModel';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor={tenantId:id(1),userId:id(2),role:'admin'},channel=id(3),listing=id(4),product=id(5),order=id(6);
const hash=ch=>createHash('sha256').update(JSON.stringify({provider:ch.provider,mode:ch.mode,settings:ch.settings})).digest('hex');
const stubs={
 './db':`export const tenantTx=(t,f)=>globalThis.${key}.tx(t,f);export const tenantReadTx=(t,f)=>globalThis.${key}.readTx(t,f);`,
 './domain':`export const audit=(...a)=>globalThis.${key}.audit(...a);`,
 './security':`export const decrypt=JSON.parse;export const encrypt=JSON.stringify;`,
 './errors':`export class Problem extends Error{constructor(status,message){super(message);this.status=status;}};export const ensure=(ok,status,message)=>{if(!ok)throw new Problem(status,message)};`,
 './offers':`export const offerInput={parse:x=>x};export const previewOffer=(...a)=>globalThis.${key}.preview(...a);export const queueOffer=(...a)=>globalThis.${key}.queue(...a);export const processOfferJob=j=>globalThis.${key}.process(j);export const failOffer=async(j)=>globalThis.${key}.fail(j);`,
 './order-status':`export const previewStatus=a=>globalThis.${key}.preview(a,${JSON.stringify(channel)},{order_id:${JSON.stringify(order)}});export const queueStatusInTx=(...a)=>globalThis.${key}.queue(...a);export const processStatusWrite=j=>globalThis.${key}.process(j);export const failStatusJob=async(j)=>globalThis.${key}.fail(j);`,
 './sync-routes':`export const receiveWooWebhookInTx=()=>{throw Error('UNSELECTED_STAGE')};`,
 './sync':`export const processIntegrationJob=()=>{throw Error('UNSELECTED_STAGE')};`,
 './imports':`export const importSourceHash=()=>{};export const normalizeOrder=()=>{};`,
};
async function load(file){
 const result=await build({entryPoints:[file],bundle:true,platform:'node',format:'esm',packages:'external',write:false,plugins:[{name:'explicit-model',setup(b){b.onResolve({filter:/^\.\//},a=>({path:a.path,namespace:'model'}));b.onLoad({filter:/.*/,namespace:'model'},a=>({contents:stubs[a.path],loader:'js'}));}}]});
 const js=Buffer.from(result.outputFiles[0].contents).toString().replace('from "zod"','from '+JSON.stringify(import.meta.resolve('zod')));
 return (await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'))).createLocalWooFlow;
}
const factory=await load(path.join(root,'server/local-woo-flow.ts'));
const oldFactory=await load(path.join(root,'data/source-drafts/pim-large-import173-woo-attachment-fix-backend/before.ts'));
function model(step='listing-sync'){
 const x={step,trace:[],receipts:[],jobs:new Map(),plans:new Map(),serial:100,read:false};
 x.ch={id:channel,provider:'woocommerce',mode:'sandbox',sync_enabled:false,settings:{simulation:true,local_offer_source:'scoped-woocommerce-offer/v1',local_offer_actor_id:actor.userId,local_woo_flow:{schema:'scoped-woocommerce-flow/v1',owner_id:actor.userId,product_id:product,listing_id:listing,warehouse_id:id(7),steps:step==='cancel-status'?{'order-stage':{request_id:id(8),state:'acknowledged',source_order_id:123}}:{}}}};
 x.listing={id:listing,product_id:product,warehouse_id:id(7),status:'simulation',external_id:'DEMO-own',price_currency:'PLN'};
 const r=rows=>({rows,rowCount:rows.length});
 x.query=async(sql,args=[])=>{
  x.trace.push({sql,args});if(x.read)assert(sql.startsWith('SELECT')&&!sql.includes('FOR UPDATE'),'READ_ONLY_MODEL');
  if(sql.includes('offer_sync_is_admin'))return r([{ok:true}]);
  if(sql.includes('customer_message_role'))return r([{role:'admin'}]);
  if(sql.startsWith('SELECT * FROM channels'))return r([structuredClone(x.ch)]);
  if(sql.includes('FROM listings l JOIN products'))return r([x.listing]);
  if(sql.startsWith('SELECT id FROM offer_plans'))return r([{id:id(9)}]);
  if(sql.startsWith('UPDATE channels SET settings')){x.ch.settings.local_woo_flow=JSON.parse(args[2]);return r([]);}
  if(sql.startsWith('SELECT detail FROM audit_events')){
   assert(sql.includes('ORDER BY id LIMIT 2'));
   return r(x.receipts.filter(a=>a.tenant===args[0]&&a.user===args[1]&&a.channel===args[2]&&a.action==='integration.woocommerce.local_flow.attached'&&a.detail.request_id===args[3]&&a.detail.step===args[4]).slice(0,2).map(a=>({detail:structuredClone(a.detail)})));
  }
  if(sql.startsWith('SELECT * FROM offer_plans')||sql.startsWith('SELECT * FROM order_status_plans'))return r(x.plans.has(args[1])?[x.plans.get(args[1])]:[]);
  if(sql.startsWith('SELECT * FROM jobs'))return r(x.jobs.has(args[1])?[x.jobs.get(args[1])]:[]);
  if(sql.startsWith("UPDATE jobs SET state='running'")){
   const j=x.jobs.get(args[1]);assert.equal(j.kind,args[3]);assert.equal(j.state,'pending');Object.assign(j,{state:'running',attempts:1,max_attempts:1,lease_token:args[2],locked_at:'model'});return r([{...j}]);
  }
  if(sql.includes('FROM inbound_orders i JOIN orders o'))return r([{id:order,number:'OWN',status:'cancelled'}]);
  if(sql.startsWith('SELECT id,kind,state'))return r([...x.jobs.values()].filter(j=>args[1].includes(j.id)));
  if(sql.startsWith('SELECT pg_advisory'))return r([]);
  throw Error('UNHANDLED_SQL:'+sql);
 };
 x.tx=async(t,f)=>{assert.equal(t,actor.tenantId);const v=await f({query:x.query});if(x.commitUnknown&&x.jobs.size){x.commitUnknown=false;throw x.first;}return v;};
 x.readTx=async(t,f)=>{assert.equal(t,actor.tenantId);x.read=true;try{return await f({query:x.query});}finally{x.read=false;}};
 x.audit=async(_c,a,action,ch,detail)=>{assert.equal(a,actor);x.receipts.push({tenant:a.tenantId,user:a.userId,channel:ch,action,detail:structuredClone(detail)});x.trace.push({sql:'MODEL_AUDIT',action});};
 x.preview=async(a,ch,input)=>{
  assert.equal(a,actor);assert.equal(ch,channel);const p={...input,id:id(x.serial++),tenant_id:a.tenantId,actor_id:a.userId,channel_id:ch,local_status:x.step==='cancel-status'?'cancelled':undefined,state:'preview',job_id:null,fingerprint:hash(x.ch)};x.plans.set(p.id,p);x.trace.push({sql:'MODEL_PREVIEW',fingerprint:p.fingerprint});return p;
 };
 x.queue=async(_c,a,pid)=>{
  const p=x.plans.get(pid);assert.equal(hash(x.ch),p.fingerprint,'SOURCE_FINGERPRINT_QUEUE');const kind=x.step==='listing-sync'?'offer.write':'order.status.write';
  const payload=x.step==='listing-sync'?{plan_id:pid,actor_id:a.userId,channel_id:channel}:{plan_id:pid,actor_id:a.userId};
  const j={id:id(x.serial++),tenant_id:a.tenantId,kind,payload,state:'pending',attempts:0,max_attempts:5,lease_token:null,locked_at:null};x.jobs.set(j.id,j);Object.assign(p,{state:'queued',job_id:j.id});return {job_id:j.id};
 };
 x.process=async j=>{x.trace.push({sql:'MODEL_PROCESS'});if(x.editSettings)x.ch.settings.real_connection_change=true;
  assert.equal(hash(x.ch),x.plans.get(j.payload.plan_id).fingerprint,'SOURCE_FINGERPRINT_PROCESS');if(x.first)throw x.first;
  Object.assign(x.jobs.get(j.id),{state:'done',lease_token:null,locked_at:null});Object.assign(x.plans.get(j.payload.plan_id),{state:'done',phase:'done',result:{scope:'local_simulation',desired_applied:true}});
 };
 x.fail=j=>Object.assign(x.jobs.get(j.id),{state:'failed',lease_token:null,locked_at:null});
 globalThis[key]=x;return x;
}
async function run(x,make=factory,request=id(20)){globalThis[key]=x;const s=make();try{return await s.run(actor,{channel_id:channel,request_id:request,step:x.step});}finally{await s.close();}}
async function read(x){globalThis[key]=x;const s=factory();try{return await s.read(actor,channel);}finally{await s.close();}}
test('old complete service reproduces self-invalidating settings; fixed sync and cancel preserve fingerprint through processor',async()=>{
 await assert.rejects(run(model(),oldFactory),/SOURCE_FINGERPRINT_PROCESS/);
 for(const step of ['listing-sync','cancel-status']){
  const x=model(step),dto=await run(x);assert.equal(dto.steps[step].state,'acknowledged');
  const a=x.trace.findIndex(t=>t.sql==='MODEL_PREVIEW'),b=x.trace.findIndex(t=>t.sql==='MODEL_PROCESS');
  assert(!x.trace.slice(a,b).some(t=>t.sql.startsWith('UPDATE channels SET settings')));
  assert(x.trace.slice(a,b).some(t=>t.action==='integration.woocommerce.local_flow.attached'));
 }
});
test('external real settings mutation still refuses original fingerprint and preserves original refs UNKNOWN',async()=>{
 const x=model();x.editSettings=true;await assert.rejects(run(x),/SOURCE_FINGERPRINT_PROCESS/);const m=x.ch.settings.local_woo_flow.steps['listing-sync'];assert.equal(m.state,'unknown');assert.equal(m.job_id,[...x.jobs.keys()][0]);assert.equal(m.plan_id,[...x.plans.keys()][0]);
});
test('uncertain COMMIT never mints processor claim; read projects persisted pending refs without writes/retry',async()=>{
 const x=model();x.commitUnknown=true;x.first=Error('MODEL_COMMIT_UNKNOWN');await assert.rejects(run(x),e=>e===x.first);assert(!x.trace.some(t=>t.sql==='MODEL_PROCESS'));
 const before=structuredClone(x.ch),dto=await read(x);assert.deepEqual(x.ch,before);assert.equal(dto.steps['listing-sync'].job_id,[...x.jobs.keys()][0]);assert.equal(dto.steps['listing-sync'].state,'unknown');
 await assert.rejects(run(x),/już wysłany/);assert(!x.trace.some(t=>t.sql==='MODEL_PROCESS'));
});
async function failed(){const x=model();x.first=Error('MODEL_FIRST_PROCESSOR');await assert.rejects(run(x),e=>e===x.first);return x;}
test('processor first failure and original IDs survive catch plus repeated manual reads',async()=>{
 const x=await failed(),a=await read(x),b=await read(x);assert.deepEqual(a,b);assert.equal(a.steps['listing-sync'].state,'unknown');assert.equal(x.trace.filter(t=>t.sql==='MODEL_PROCESS').length,1);
});
test('foreign tenant/user/channel/request/step receipt does not enrich missing marker or grant ACK',async()=>{
 for(const [key,value] of [['tenant',id(90)],['user',id(91)],['channel',id(92)],['request_id',id(93)],['step','cancel-status']]){
  const x=await failed();delete x.ch.settings.local_woo_flow.steps['listing-sync'].job_id;delete x.ch.settings.local_woo_flow.steps['listing-sync'].plan_id;
  const a=x.receipts.find(a=>a.action.endsWith('.attached'));if(key==='step'||key==='request_id')a.detail[key]=value;else a[key]=value;
  const m=(await read(x)).steps['listing-sync'];assert.equal(m.job_id,undefined);assert.equal(m.state,'unknown');
 }
});
test('duplicate/malformed receipts and conflicting remembered IDs fail closed',async()=>{
 for(const corrupt of [x=>x.receipts.push(structuredClone(x.receipts.find(a=>a.action.endsWith('.attached')))),x=>x.receipts.find(a=>a.action.endsWith('.attached')).detail.extra=true,x=>x.receipts.find(a=>a.action.endsWith('.attached')).detail.job_id='bad',x=>x.ch.settings.local_woo_flow.steps['listing-sync'].job_id=id(999)]){
  const x=await failed();corrupt(x);await assert.rejects(read(x));
 }
});
test('real linked job/plan binding, kind, exact payload and allocation attempts are mandatory',async()=>{
 for(const corrupt of [j=>j.kind='webhook.stage',j=>j.tenant_id=id(90),j=>j.payload.actor_id=id(90),j=>j.payload.channel_id=id(90),j=>j.payload.plan_id=id(90),j=>j.attempts=2]){const x=await failed();corrupt([...x.jobs.values()][0]);await assert.rejects(read(x),/Obce powiązanie/);}
 for(const corrupt of [p=>p.actor_id=id(90),p=>p.channel_id=id(90),p=>p.job_id=id(90),p=>p.operation='create_draft',p=>p.listing_id=id(90),p=>p.product_id=id(90)]){const x=await failed();corrupt([...x.plans.values()][0]);await assert.rejects(read(x));}
});
test('missing receipt stays absent and old acknowledged/failed marker is neither demoted nor rerun',async()=>{
 const x=await failed();x.receipts=[];const original=structuredClone(x.ch.settings.local_woo_flow);assert.equal((await read(x)).steps['listing-sync'].state,'unknown');assert.deepEqual(x.ch.settings.local_woo_flow,original);await assert.rejects(run(x));
 const y=model();await run(y);const ack=structuredClone(y.ch.settings.local_woo_flow);await read(y);assert.deepEqual(y.ch.settings.local_woo_flow,ack);await assert.rejects(run(y));
});
test('cancel attachment refuses an old paid plan even when the actual original order is now cancelled',async()=>{
 const x=model('cancel-status');x.first=Error('MODEL_STATUS_FIRST');await assert.rejects(run(x),e=>e===x.first);
 const p=[...x.plans.values()][0];p.local_status='paid';await assert.rejects(read(x),/oryginalnego anulowania/);
 p.local_status='cancelled';assert.equal((await read(x)).steps['cancel-status'].state,'unknown');
});
test('global fingerprint source and order-stage attach remain unchanged; audit is existing INSERT not schema authority',async()=>{
 const current=await fs.readFile('server/local-woo-flow.ts','utf8'),before=await fs.readFile('data/source-drafts/pim-large-import173-woo-attachment-fix-backend/before.ts','utf8');
 // before.ts is the README's opening server/local-woo-flow.ts (restored from the stock-file-import worktree draft).
 assert.equal(createHash('sha256').update(before).digest('hex'),'6925889a1811be9e57ae3bda4f1df8da99f321e45395a83c73d70e885a788d1b');
 const policy=await fs.readFile('server/offer-sync-policy.ts','utf8');assert(policy.includes('JSON.stringify({ provider: ch.provider, mode: ch.mode, settings: ch.settings })'));
 assert(current.includes("if(input.step==='order-stage') {\n      Object.assign(m,refs,{job_id:job.id});\n      await writeEnvelope(c,actor,ch.id,e);"));
 // '(' keeps the markers exact: the later readCurrent/queueCurrent helpers also start with these words.
 for(const [a,b] of [['  async function queue(','  async function read(']])assert.equal(current.slice(current.indexOf(a),current.indexOf(b)),before.slice(before.indexOf(a),before.indexOf(b)));
 assert(current.includes('AND entity_id=$3 AND action=')&&current.includes('ORDER BY id LIMIT 2'));
});

// Fresh native facts are modeled below; DTO is data-only, never native authority.
async function beforeWriteConflict(){
 const x=await failed(),p=[...x.plans.values()][0];Object.assign(p,{state:'conflict',phase:'ready',result:null});
 // The historical attachment path has no audit receipt; validate the old known refs directly.
 x.receipts=x.receipts.filter(a=>!a.action.endsWith('.attached'));return x;
}
test('fresh failed-before-write proof preserves original UNKNOWN/refs and read has no writes',async()=>{
 const x=await beforeWriteConflict(),before=structuredClone(x.ch);const dto=await read(x),m=dto.steps['listing-sync'];
 assert.deepEqual(dto.failed_before_write,{'listing-sync':{request_id:m.request_id,job_id:m.job_id,plan_id:m.plan_id}});
 assert.equal(m.state,'unknown');assert.deepEqual(x.ch,before);assert.equal(x.trace.filter(t=>t.sql==='MODEL_PROCESS').length,1);
});
test('failed-before-write excludes every uncertain/written/foreign/native lease condition',async()=>{
 for(const corrupt of [
 x=>x.ch.settings.local_woo_flow.steps['listing-sync'].state='sent',x=>delete x.ch.settings.local_woo_flow.steps['listing-sync'].job_id,
 x=>[...x.jobs.values()][0].state='running',x=>[...x.jobs.values()][0].state='pending',x=>[...x.jobs.values()][0].attempts=2,
 x=>[...x.jobs.values()][0].lease_token=id(999),x=>[...x.jobs.values()][0].locked_at='active',x=>[...x.jobs.values()][0].payload.accept_observed=true,
 x=>[...x.jobs.values()][0].payload.actor_id=id(999),x=>[...x.jobs.values()][0].payload.channel_id=id(999),x=>[...x.jobs.values()][0].tenant_id=id(999),
 x=>[...x.plans.values()][0].state='failed',x=>[...x.plans.values()][0].phase='write_started',x=>[...x.plans.values()][0].phase='verify',x=>[...x.plans.values()][0].phase='done',x=>[...x.plans.values()][0].result={},
 x=>[...x.plans.values()][0].actor_id=id(999),x=>[...x.plans.values()][0].product_id=id(999),x=>[...x.plans.values()][0].listing_id=id(999),x=>[...x.plans.values()][0].job_id=id(999),x=>[...x.plans.values()][0].warehouse_id=id(999),
 ]){const x=await beforeWriteConflict();corrupt(x);assert.deepEqual((await read(x)).failed_before_write,{});}
});
test('raw API cannot begin new order stage across UNKNOWN; only unused cancellation with fresh row-pinned proof proceeds',async()=>{
 const x=await beforeWriteConflict();x.first=null;x.step='order-stage';const count=x.trace.filter(t=>t.sql.startsWith('UPDATE channels SET settings')).length;
 await assert.rejects(run(x,factory,id(23)),e=>/Niepewny etap blokuje/.test(e.message));assert.equal(x.trace.filter(t=>t.sql.startsWith('UPDATE channels SET settings')).length,count);
 x.step='cancel-status';x.ch.settings.local_woo_flow.steps['order-stage']={request_id:id(8),state:'acknowledged',source_order_id:123};
 // run helper's old request20 is intentionally refused; use a genuinely new request for independent cancellation.
 globalThis[key]=x;const s=factory();try{
  const dto=await s.run(actor,{channel_id:channel,request_id:id(21),step:'cancel-status'});assert.equal(dto.steps['cancel-status'].state,'acknowledged');assert.equal(dto.steps['listing-sync'].state,'unknown');assert.equal(dto.steps['listing-sync'].request_id,id(20));
  assert(x.trace.some(t=>t.sql.startsWith('SELECT * FROM jobs')&&t.sql.endsWith('FOR SHARE')));assert(x.trace.some(t=>t.sql.startsWith('SELECT * FROM offer_plans')&&t.sql.endsWith('FOR SHARE')));
  await assert.rejects(s.run(actor,{channel_id:channel,request_id:id(22),step:'listing-sync'}));
 }finally{await s.close();}
});
test('independent cancellation is denied when old conflict proof changes or another unsettled step exists',async()=>{
 for(const corrupt of [x=>[...x.plans.values()][0].phase='write_started',x=>x.ch.settings.local_woo_flow.steps['order-stage']={request_id:id(8),state:'unknown',source_order_id:123}]){
  const x=await beforeWriteConflict();x.first=null;x.step='cancel-status';corrupt(x);const before=structuredClone(x.ch);globalThis[key]=x;const s=factory();try{await assert.rejects(s.run(actor,{channel_id:channel,request_id:id(21),step:'cancel-status'}),/Niepewny etap blokuje/);assert.deepEqual(x.ch,before);}finally{await s.close();}
 }
});
