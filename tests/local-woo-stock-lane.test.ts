/** Actual selected stock lane; all DB/registry/provider/processor ports controlled.
 * No Postgres, HTTP, application or provider acceptance is claimed here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as crypto from 'node:crypto';
import * as util from 'node:util';
import {z} from 'zod';
import {transformSync} from 'esbuild';
import {ensure,Problem} from '../server/errors';
import {LOCAL_WOO_ORIGINS} from '../shared/local-woo-origins';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(x:any)=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const source=readFileSync(new URL('../server/local-woo-stock-lane.ts',import.meta.url),'utf8');
function actualWoo(){
 const src=readFileSync(new URL('../server/integrations.ts',import.meta.url),'utf8'),baseStart=src.indexOf('export class ApiClient {'),baseEnd=src.indexOf('export class Dpd ',baseStart),wooStart=src.indexOf('export class WooCommerce '),wooEnd=src.indexOf('export class Allegro ',wooStart);
 assert(baseStart>0&&baseEnd>baseStart&&wooStart>baseEnd&&wooEnd>wooStart);
 const module={exports:{}};new Function('module','exports','ensure','Problem','safeFetch','setTimeout',transformSync(src.slice(baseStart,baseEnd)+src.slice(wooStart,wooEnd),{loader:'ts',format:'cjs',target:'es2022'}).code)(module,module.exports,ensure,Problem,()=>assert.fail('No actual HTTP'),()=>assert.fail('No provider retry expected'));return(module.exports as any).WooCommerce;
}
function model(options:{variant?:boolean;unknownPut?:boolean;unknownDispatch?:boolean;returnRunning?:boolean;beforeWrite?:(s:any)=>void;afterPut?:(s:any)=>void;conflict?:'before_request'|'after_get'|'after_put';putError?:unknown;duringWrite?:()=>Promise<void>;afterSync?:(s:any)=>void;getStatus?:()=>number;second?:boolean;secondGate?:Promise<void>;afterEligibility?:(s:any)=>void}={}){
 const s={tenantId:id(1),userId:id(2),channelId:id(3),fixtureId:id(4),origin:LOCAL_WOO_ORIGINS[0]};
 const s2={tenantId:id(1),userId:id(2),channelId:id(5),fixtureId:id(6),origin:LOCAL_WOO_ORIGINS[1]};const logs:any[]=[];
 const ch={id:s.channelId,tenant_id:s.tenantId,provider:'woocommerce',mode:'sandbox',sync_enabled:false,credentials:'PRIVATE_CIPHER',settings:{store_url:s.origin,simulation:false,local_http_fixture:{schema:'local-woo-http-fixture/v1',fixture_id:s.fixtureId,owner_id:s.userId}}};
 const state:any={role:'admin',enrolled:true,ch,cfg:{tenant_id:s.tenantId,channel_id:s.channelId,actor_id:s.userId,version:1,enabled:true,stock:true,price:false,price_list_id:null,external_authorized:true,stock_due:true,connection_hash:hash({provider:ch.provider,mode:ch.mode,settings:ch.settings})},jobs:[],plans:[],audits:[],quantity:7,localQuantity:8};
 const sql:string[]=[],wire:string[]=[],processed:string[]=[];let sequence=50,queue=Promise.resolve(),unknownDispatch=options.unknownDispatch;
 const row=(x:any)=>({rows:x?[structuredClone(x)]:[],rowCount:x?1:0});
 const newJob=(kind='offer.sync',payload:any={channel_id:s.channelId,actor_id:s.userId,version:1,after:null,stats:{}},dedup?:string)=>{const j={id:id(++sequence),tenant_id:s.tenantId,kind,payload,state:'pending',attempts:0,max_attempts:5,run_at:'2026-01-01T00:00:00.000Z',lease_token:null,locked_at:null,error:null,dedup_key:dedup??''};if(!dedup)j.dedup_key='offer.sync:'+j.id;state.jobs.push(j);return j;};
 const client={query:async(q:string,a:any[]=[])=>{
  sql.push(q);
  if(q.startsWith('SELECT pg_advisory_xact_lock_shared'))return row({});
  if(q.startsWith('SELECT enabled,stock,price')){const r=row(state.cfg);options.afterEligibility?.(state);return r;}
  if(q.startsWith('SELECT *,next_run_at'))return row(state.cfg);
  if(q.startsWith('SELECT * FROM channels'))return row(state.ch);
  if(q==='SELECT public.offer_sync_is_admin($1) AS ok')return row({ok:state.role==='admin'});
  if(q.startsWith('SELECT j.*,to_jsonb(j)')){const j=state.jobs.find((x:any)=>x.id===a[0]);return row(j&&{...j,stock_snapshot:structuredClone(j)});}
  if(q.startsWith('SELECT id FROM audit_events'))return row(state.audits.find((x:any)=>x.action===a[0]&&x.entity_id===a[1]));
  if(q.startsWith('UPDATE jobs SET max_attempts=1')){const j=state.jobs.find((x:any)=>x.id===a[0]);j.max_attempts=1;j.payload.local_woo_stock=JSON.parse(a[1]);return row(j);}
  if(q.startsWith('SELECT d.id FROM audit_events'))return row(state.audits.find((x:any)=>x.action===a[0]&&x.detail.channel_id===a[1]&&!state.audits.some((y:any)=>y.action===a[2]&&y.entity_id===x.entity_id&&y.detail.channel_id===a[1])));
  if(q.startsWith('SELECT a.entity_id,a.detail'))return{rows:state.audits.filter((x:any)=>x.action===a[0]&&x.detail.channel_id===a[1]&&state.jobs.some((j:any)=>j.id===x.entity_id&&(['pending','running'].includes(j.state)||j.state==='failed'&&(!q.includes('j.attempts>0')||j.attempts>0)&&!state.audits.some((r:any)=>r.action===a[2]&&r.entity_id===j.id&&r.detail.channel_id===a[1])))).sort((x:any,y:any)=>(x.detail.kind==='offer.write'?0:1)-(y.detail.kind==='offer.write'?0:1)).map((x:any)=>structuredClone({entity_id:x.entity_id,detail:x.detail}))};
  if(q.startsWith("SELECT id FROM jobs WHERE kind='offer.sync'"))return row(state.jobs.find((j:any)=>j.kind==='offer.sync'&&['pending','running'].includes(j.state)&&j.payload.channel_id===a[0]));
  if(q.startsWith('SELECT detail FROM audit_events'))return row(state.audits.filter((x:any)=>x.action===a[0]&&x.detail.job_id===a[1]).at(-1));
  if(q.startsWith("UPDATE jobs SET state='running'")){const j=state.jobs.find((j:any)=>j.id===a[0]&&j.state==='pending'&&j.attempts===0&&!j.lease_token);if(j)Object.assign(j,{state:'running',attempts:1,lease_token:a[1],locked_at:'2026-10-19T10:00:00.000Z'});return row(j);}
  if(q.startsWith("UPDATE jobs SET state='done'")){const j=state.jobs.find((j:any)=>j.id===a[0]&&j.state==='running'&&j.lease_token===a[1]);if(j)Object.assign(j,{state:'done',error:a[2]??null,lease_token:null,locked_at:null});return row(j);}
  if(q.startsWith("UPDATE offer_plans SET state='conflict'")){const p=state.plans.find((p:any)=>p.id===a[0]&&p.state==='queued'&&p.phase===(a[3]??'ready')&&p.job_id===a[2]);if(p)Object.assign(p,{state:'conflict',error:a[1]});return row(p);}
  if(q.startsWith('SELECT * FROM offer_plans'))return row(state.plans.find((p:any)=>p.id===a[0]));
  if(q.startsWith('SELECT id FROM listings'))return row(a[0]===s.channelId&&(options.variant?(a[1]==='2'&&a[2]==='1'||a[1]==='1'&&a[2]===''&&a[3]===true):(a[1]==='1'&&a[2]===''))?{id:id(10)}:null);
  if(q.startsWith('SELECT * FROM offer_sync_configs WHERE channel_id=$1'))return row(state.cfg);
  if(q==='SELECT public.customer_message_role($1) AS role')return row({role:state.role});
  if(q.startsWith('SELECT d.id,d.entity_id,d.detail FROM audit_events d'))return{rows:state.audits.filter((x:any)=>x.action===a[0]&&x.detail.channel_id===a[1]&&!state.audits.some((y:any)=>y.action===a[2]&&y.entity_id===x.entity_id&&y.detail.channel_id===a[1])).slice(0,1).map((x:any)=>structuredClone({id:x.id,entity_id:x.entity_id,detail:x.detail}))};
  if(q.startsWith('SELECT o.detail FROM audit_events o'))return{rows:state.audits.filter((x:any)=>x.action===a[0]&&x.entity_id===a[1]).map((x:any)=>structuredClone({detail:x.detail}))};
  if(q.startsWith('SELECT r.detail FROM audit_events r'))return row(state.audits.find((x:any)=>x.action===a[0]&&x.detail.client_key===a[1])&&{detail:state.audits.find((x:any)=>x.action===a[0]&&x.detail.client_key===a[1]).detail});
  if(q.startsWith('SELECT f.detail FROM audit_events f')){const f=state.audits.filter((x:any)=>x.action===a[0]&&x.entity_id===a[1]).at(-1);return row(f&&{detail:f.detail});}
  if(q.startsWith('SELECT p.*,to_jsonb(p) AS reconcile_snapshot FROM offer_plans p')){const p=state.plans.find((p:any)=>p.id===a[0]);return row(p&&{...p,reconcile_snapshot:structuredClone(p)});}
  if(q.startsWith('SELECT phase FROM offer_plans'))return row(state.plans.find((p:any)=>p.id===a[0])&&{phase:state.plans.find((p:any)=>p.id===a[0]).phase});
  if(q.startsWith('UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL WHERE id=$1 AND state=$4')){const j=state.jobs.find((j:any)=>j.id===a[0]&&j.state===a[3]&&j.lease_token===a[4]);if(j)Object.assign(j,{state:a[1],error:a[2],lease_token:null,locked_at:null});return row(j);}
  if(q.startsWith('UPDATE offer_plans SET state=$2,phase=$3,error=$4')){const p=state.plans.find((p:any)=>p.id===a[0]&&p.state===a[5]&&p.phase===a[6]&&p.job_id===a[7]);if(p)Object.assign(p,{state:a[1],phase:a[2],error:a[3],result:{...(p.result??{}),...JSON.parse(a[4])}});return row(p);}
  throw Error('Unmodelled real query: '+q);
 }};
 const tx=async(_tenant:string,fn:any)=>{assert.equal(_tenant,s.tenantId);let yes!:()=>void;const previous=queue;queue=new Promise<void>(r=>yes=r);await previous;const before=structuredClone(state);try{const result=await fn(client);if(unknownDispatch&&state.audits.some((a:any)=>a.action==='local_woo.stock.dispatch')&&!before.audits.some((a:any)=>a.action==='local_woo.stock.dispatch')){unknownDispatch=false;throw Object.assign(Error('Lost COMMIT ACK'),{committed:true});}return result;}catch(e){if(!(e as any).committed){for(const k of Object.keys(state))delete state[k];Object.assign(state,before);}throw e;}finally{yes();}};
 const base=async(_url:string,init:RequestInit)=>{const method=init.method??'GET';wire.push(method);const forced=method==='GET'?options.getStatus?.():undefined;if(forced)return new Response('{"message":"ck_live_SECRET"}',{status:forced,headers:{'content-type':'application/json'}});if(method==='PUT'){state.quantity=JSON.parse(String(init.body)).stock_quantity;options.afterPut?.(state);if(options.unknownPut)throw options.putError??Error('Provider ACK lost');}return new Response(JSON.stringify(options.variant&&_url.endsWith('/products/1')?{id:1,type:'variable',variations:[2]}:{id:options.variant?2:1,manage_stock:true,stock_quantity:state.quantity,backorders:'no'}),{headers:{'content-type':'application/json'}});};
 const registry={};const fixture={transport:base},fixture2={transport:base,second:true};
 const complete=(job:any)=>{const j=state.jobs.find((x:any)=>x.id===job.id);Object.assign(j,{state:'done',attempts:0,lease_token:null,locked_at:null,error:null});};
 const Woo=actualWoo();
 const wc=(ctx:any)=>new Woo({store_url:s.origin},{consumer_key:'controlled',consumer_secret:'controlled'},ctx.transport);
 const processSync=async(job:any,ctx:any)=>{
  processed.push(job.kind);await tx(s.tenantId,(c:any)=>ctx.localWooStockFence(c,job));
  if(options.variant)await wc(ctx).product('2','1');else await ctx.transport(s.origin+'/wp-json/wc/v3/products/1',{method:'GET'});
  const p={id:id(++sequence),tenant_id:s.tenantId,actor_id:s.userId,channel_id:s.channelId,operation:'sync',sync_version:job.payload.version,input:{stock:true,price:false,listing_id:id(10),...(options.variant?{parent_external_id:'1'}:{})},local_snapshot:{quantity:8},remote_id:options.variant?'2':'1',state:'queued',phase:'ready',payload:{manage_stock:true,stock_quantity:8,backorders:'no'}};
  await tx(s.tenantId,async(c:any)=>{const j=newJob('offer.write',{plan_id:p.id,actor_id:s.userId,channel_id:s.channelId},'offer:'+p.id);state.plans.push({...p,job_id:j.id});await ctx.localWooStockQueued(c,job,{id:p.id,job_id:j.id,state:'queued'});complete(job);});
  options.afterSync?.(state);
 };
 const processWrite=async(job:any,ctx:any)=>{
  processed.push(job.kind);await tx(s.tenantId,(c:any)=>ctx.localWooStockFence(c,job));
  const p=state.plans.find((p:any)=>p.id===job.payload.plan_id);
  const conflict=()=>{throw new Problem(409,'Cena lub stan zmieniły się przed wykonaniem. Przygotuj nowy plan');};
  if(options.conflict==='before_request')conflict();
  if(options.variant)await wc(ctx).product('2','1');else await ctx.transport(s.origin+'/wp-json/wc/v3/products/1',{method:'GET'});
  if(options.conflict==='after_get')conflict();
  options.beforeWrite?.(state);
  await tx(s.tenantId,async(c:any)=>{await ctx.localWooStockFence(c,job);p.phase='write_started';});
  await options.duringWrite?.();
  if(options.variant)await wc(ctx).writeProduct('2',p.payload,'1');else await ctx.transport(s.origin+'/wp-json/wc/v3/products/1',{method:'PUT',body:JSON.stringify(p.payload)});
  if(options.conflict==='after_put')conflict();
  if(options.variant)await wc(ctx).product('2','1');else await ctx.transport(s.origin+'/wp-json/wc/v3/products/1',{method:'GET'});
  if(options.returnRunning)return;
  await tx(s.tenantId,async(c:any)=>{await ctx.localWooStockFence(c,job);p.state='done';p.phase='done';p.result={scope:'external_api_verified',desired_applied:true,local_changed:false,requested_payload:p.payload,verified_payload:p.payload};complete(job);});
 };
 const failed=async(job:any)=>{const j=state.jobs.find((j:any)=>j.id===job.id);Object.assign(j,{state:'failed',lease_token:null,locked_at:null,error:'controlled failure'});};
 const resolve=(name:string):any=>{
  if(name==='node:crypto')return crypto;if(name==='node:util')return util;if(name==='zod')return{z};if(name==='./errors')return{ensure,Problem};if(name==='./db')return{tenantTx:tx,tenantReadTx:tx};
  if(name==='./integrations')return{WooCommerce:Woo};if(name==='./security')return{decrypt:(x:any)=>{assert.equal(x,state.ch.credentials);return{consumer_key:'controlled',consumer_secret:'controlled'};}};
  if(name==='./domain')return{audit:async(_c:any,a:any,action:string,entity_id:string,detail:any)=>{assert.equal(a.tenantId,s.tenantId);state.audits.push({id:id(++sequence),action,entity_id,detail:structuredClone(detail)});}};
  if(name==='../shared/local-woo-origins')return{LOCAL_WOO_ORIGINS};
  if(name==='./local-woo-http-registry')return{localWooRegistryFixture:(r:any,a:any,cid:any)=>{assert.equal(r,registry);assert(cid===s.channelId||options.second&&cid===s2.channelId);assert.equal(a.userId,s.userId);return cid===s.channelId?fixture:fixture2;}};
  if(name==='./local-woo-http-fixture')return{readConfiguredLocalWooHttpChannel:async(f:any)=>{if(f.second){await options.secondGate;return{enrolled:true,origin:s2.origin,fixture_id:s2.fixtureId};}return{enrolled:state.enrolled,origin:s.origin,fixture_id:s.fixtureId};}};
  if(name==='./offer-sync')return{enqueueOfferSync:async()=>{state.cfg.stock_due=false;return{id:newJob('offer.sync',{channel_id:s.channelId,actor_id:s.userId,version:state.cfg.version,after:null,stats:{}}).id,reused:false};},processOfferSync:processSync,failOfferSync:failed};
  if(name==='./offers')return{processOfferJob:processWrite,failOffer:failed,desiredOffer:async()=>({snapshot:{quantity:state.localQuantity}}),offerSnapshotHash:hash};
  if(name==='./offer-sync-policy')return{offerConnectionHash:(ch:any)=>hash({provider:ch.provider,mode:ch.mode,settings:ch.settings})};throw Error('Unexpected module '+name);
 };
 const module={exports:{}};new Function('module','require',transformSync(source,{loader:'ts',format:'cjs',target:'es2022'}).code)(module,resolve);const api=module.exports as any;
 return{state,sql,wire,processed,s,s2,logs,api,newJob,lane:(scopes:any[]=[s])=>api.createLocalWooStockLane(registry,scopes,{log:(line:unknown)=>logs.push(line)}),tx};
}
test('disabled, price and unconsented configs remain inert; no old jobs are claimed',async()=>{for(const patch of [{enabled:false},{price:true},{stock:false},{external_authorized:false}]){const m=model();Object.assign(m.state.cfg,patch);const old=m.newJob();const before=structuredClone(old);await m.lane().cycle();assert.deepEqual(old,before);assert.equal(m.state.audits.length,0);assert.equal(m.wire.length,0);assert(m.sql.every(q=>q.startsWith('SELECT enabled,stock,price')));}});
test('old same-channel pending/running work is never adopted, changed or reaped',async()=>{for(const state of ['pending','running']){const m=model(),old=m.newJob();old.state=state;const before=structuredClone(old);await m.lane().cycle();assert.deepEqual(old,before);assert.equal(m.state.audits.length,0);assert.equal(m.processed.length,0);}});
test('natural selected cycle owns only the exact new child and retains the real verified receipt',async()=>{const m=model(),lane=m.lane();await lane.cycle();assert.deepEqual(m.processed,['offer.sync','offer.write'],'one cycle drains the due child');assert.equal(m.state.jobs.length,2);assert.equal(m.state.audits.filter((a:any)=>a.action==='local_woo.stock.owned').length,2);await lane.cycle();assert.deepEqual(m.processed,['offer.sync','offer.write']);assert.deepEqual(m.wire,['GET','GET','PUT','GET']);assert.equal(m.state.quantity,8);assert(m.state.jobs.every((j:any)=>j.state==='done'&&j.max_attempts===1));const receipt=m.state.audits.filter((a:any)=>a.action==='local_woo.stock.ack').at(-1);assert.equal(receipt.detail.provider_result.scope,'external_api_verified');assert.deepEqual(receipt.detail.provider_result.verified_payload,{manage_stock:true,stock_quantity:8,backorders:'no'});await lane.cycle();assert.equal(m.wire.filter(x=>x==='PUT').length,1);});
test('lost provider ACK blocks every new cycle and new config version, also in a new instance',async()=>{const m=model({unknownPut:true}),lane=m.lane();await lane.cycle();await lane.cycle();assert.equal(m.state.quantity,8);assert.equal(m.wire.filter(x=>x==='PUT').length,1);assert.equal(lane.inspect().blocked,1);m.state.cfg.version=2;m.state.cfg.stock_due=true;await m.lane().cycle();await m.lane().cycle();assert.equal(m.state.jobs.length,2);assert.equal(m.wire.filter(x=>x==='PUT').length,1);assert.equal(m.state.audits.filter((a:any)=>a.action==='local_woo.stock.ack').length,1);});
test('lost dispatch COMMIT acknowledgement never calls the processor or reclaims running',async()=>{const m=model({unknownDispatch:true});await m.lane().cycle();assert.equal(m.processed.length,0);assert.equal(m.state.jobs[0].state,'running');await m.lane().cycle();assert.equal(m.processed.length,0);assert.equal(m.state.jobs.length,1);assert.equal(m.wire.length,0);});
test('processor returning without completion ACK retains unresolved dispatch and cannot be repeated',async()=>{const m=model({returnRunning:true}),lane=m.lane();await lane.cycle();await lane.cycle();assert.equal(lane.inspect().blocked,1);await m.lane().cycle();assert.equal(m.wire.filter(x=>x==='PUT').length,1);assert.equal(m.state.jobs[1].state,'running');});
test('fresh admin, source and current local stock fence prevent a stale PUT',async()=>{for(const mutate of [(s:any)=>s.role='viewer',(s:any)=>s.ch.credentials='ROTATED',(s:any)=>s.localQuantity=9,(s:any)=>s.cfg.enabled=false]){const m=model({beforeWrite:mutate}),lane=m.lane();await lane.cycle();await lane.cycle();assert.equal(m.wire.filter(x=>x==='PUT').length,0);assert.equal(lane.inspect().blocked,1);await m.lane().cycle();assert.equal(m.wire.filter(x=>x==='PUT').length,0);}});
test('source/config change after wire leaves uncertainty and never fabricates a receipt',async()=>{const m=model({afterPut:s=>s.ch.credentials='ROTATED'}),lane=m.lane();await lane.cycle();await lane.cycle();assert.equal(m.state.quantity,8);assert.equal(lane.inspect().blocked,1);assert.equal(m.state.audits.filter((a:any)=>a.action==='local_woo.stock.ack').length,1);await m.lane().cycle();assert.equal(m.wire.filter(x=>x==='PUT').length,1);});
test('two construction instances serialize claims; old/foreign jobs remain byte-identical',async()=>{const m=model(),foreign=m.newJob('orders.sync',{channel_id:id(999),actor_id:id(998)},'foreign');const before=structuredClone(foreign);const one=m.lane(),two=m.lane();await Promise.all([one.cycle(),two.cycle()]);assert.equal(m.processed.filter(x=>x==='offer.sync').length,1);assert.equal(m.processed.filter(x=>x==='offer.write').length,1);assert.deepEqual(m.state.jobs.find((j:any)=>j.id===foreign.id),before);assert.equal(m.wire.filter(x=>x==='PUT').length,1,'the one child is written exactly once');});
test('tampered pending child checkpoint is refused before dispatch, including after restart',async()=>{const m=model({afterSync:s=>{s.jobs[1].payload.plan_id=id(777);}}),first=m.lane();await first.cycle();assert.equal(first.inspect().blocked,1,'drained claim refuses the tampered child');const lane=m.lane();await lane.cycle();assert.equal(lane.inspect().blocked,1);assert.equal(m.wire.length,1);assert.equal(m.state.jobs[1].state,'pending');});
test('closing seals claims and does not mutate another job',async()=>{const m=model(),lane=m.lane();await lane.close();await lane.cycle();assert.equal(m.state.jobs.length,0);assert.equal(m.wire.length,0);});
test('actual transport refuses price/create/wrong endpoint/second PUT even after a lost ACK',async()=>{const m=model();let calls=0;const payload={manage_stock:true,stock_quantity:8,backorders:'no'},url=m.s.origin+'/wp-json/wc/v3/products/1';const transport=m.api.localWooStockTransport(async()=>{calls++;throw Error('Lost ACK');},m.s.origin,async()=>{}, {remote_id:'1',payload});for(const [u,init] of [[url,{method:'POST',body:JSON.stringify(payload)}],[url,{method:'PUT',body:JSON.stringify({...payload,regular_price:'8.00'})}],[url+'?force=true',{method:'PUT',body:JSON.stringify(payload)}],[m.s.origin+'/wp-json/wc/v3/products/2',{method:'PUT',body:JSON.stringify(payload)}]])await assert.rejects(transport(u,init));assert.equal(calls,0);await assert.rejects(transport(url,{method:'PUT',body:JSON.stringify(payload)}));await assert.rejects(transport(url,{method:'PUT',body:JSON.stringify(payload)}));assert.equal(calls,1);});

test('actual WooCommerce variant membership reads the bound parent without a separate parent listing and only PUTs the variant',async()=>{const m=model({variant:true}),lane=m.lane();await lane.cycle();assert.equal(lane.inspect().blocked,0);await lane.cycle();assert.equal(lane.inspect().blocked,0);assert.equal(m.state.jobs[1].state,'done');assert.equal(m.state.quantity,8);assert.deepEqual(m.wire,['GET','GET','GET','GET','PUT','GET','GET']);const p={remote_id:'2',parent_external_id:'1',payload:{manage_stock:true,stock_quantity:8,backorders:'no'}};let writes=0;const t=m.api.localWooStockTransport(async()=>{writes++;return new Response('{}');},m.s.origin,async()=>{},p);await assert.rejects(t(m.s.origin+'/wp-json/wc/v3/products/1',{method:'PUT',body:JSON.stringify(p.payload)}));await assert.rejects(t(m.s.origin+'/wp-json/wc/v3/products/3',{method:'GET'}));assert.equal(writes,0);});

test('plan conflict before any Woo request ends cleanly as replan; channel stays unblocked and the next offer.sync plans again',async()=>{
 const m=model({conflict:'before_request'}),lane=m.lane();await lane.cycle();assert.deepEqual(m.wire,['GET']);await lane.cycle();
 assert.deepEqual(m.processed,['offer.sync','offer.write']);assert.deepEqual(m.wire,['GET'],'no request was sent for the write');
 assert.equal(lane.inspect().blocked,0);const j=m.state.jobs[1],p=m.state.plans[0];
 assert.equal(j.state,'done');assert.equal(j.lease_token,null);assert.equal(j.error,null);assert.equal(p.state,'conflict');assert.match(p.error,/przed wykonaniem/);
 const ack=m.state.audits.filter((a:any)=>a.action==='local_woo.stock.ack').at(-1);
 assert.equal(ack.detail.job_id,j.id);assert.equal(ack.detail.outcome,'NO_EFFECT_REPLAN');assert.equal(ack.detail.provider_requests,0);assert.equal(ack.detail.provider_result,null);assert.match(ack.detail.cause,/przed wykonaniem/);assert.equal(ack.detail.automatic_retry,false);
 m.state.cfg.stock_due=true;const next=m.lane();await next.cycle();assert.equal(next.inspect().blocked,0);assert.deepEqual(m.processed,['offer.sync','offer.write','offer.sync','offer.write'],'the new plan is drained in the same cycle');assert.equal(m.state.jobs.length,4);
 assert.equal(m.wire.filter(x=>x==='PUT').length,0);
});
test('conflict after a read-only GET (remote changed since plan) is still no effect: replan, unblocked',async()=>{
 const m=model({conflict:'after_get'}),lane=m.lane();await lane.cycle();await lane.cycle();
 assert.deepEqual(m.wire,['GET','GET'],'only reads reached Woo');assert.equal(lane.inspect().blocked,0);
 assert.equal(m.state.jobs[1].state,'done');assert.equal(m.state.plans[0].state,'conflict');
 const ack=m.state.audits.filter((a:any)=>a.action==='local_woo.stock.ack').at(-1);assert.equal(ack.detail.outcome,'NO_EFFECT_REPLAN');assert.equal(ack.detail.provider_writes,0);assert.equal(ack.detail.provider_requests,1);
 m.state.cfg.stock_due=true;await m.lane().cycle();assert.deepEqual(m.processed,['offer.sync','offer.write','offer.sync','offer.write']);
});
test('conflict after a PUT reached Woo keeps the uncertain-effect stop (no replan, no ACK)',async()=>{
 const m=model({conflict:'after_put'}),lane=m.lane();await lane.cycle();await lane.cycle();
 assert.equal(m.wire.filter(x=>x==='PUT').length,1);assert.equal(lane.inspect().blocked,1);assert.equal(m.state.jobs[1].state,'failed');assert.equal(m.state.plans[0].state,'queued');
 assert.equal(m.state.audits.filter((a:any)=>a.action==='local_woo.stock.ack').length,1);m.state.cfg.stock_due=true;await m.lane().cycle();assert.equal(m.processed.length,2);
});

// Operator reconciliation of an uncertain write (PUT may have landed) and lane throughput.
const operator=(m:any,patch:any={})=>({tenantId:m.s.tenantId,userId:m.s.userId,role:'admin',...patch});
const planned={manage_stock:true,stock_quantity:8,backorders:'no'};
const leak=/SECRET|ck_live|body=/;
async function parked(options:any={}){
 const m=model({unknownPut:true,putError:Object.assign(Error('socket hang up ck_live_SECRET body={"x":1}'),{code:'ECONNRESET'}),...options}),lane=m.lane();
 await lane.cycle();await lane.cycle();assert.equal(lane.inspect().blocked,1);return{m,lane};
}
const frozen=(m:any)=>structuredClone({jobs:m.state.jobs,plans:m.state.plans,audits:m.state.audits});
const command=(p:any,outcome:string,patch:any={})=>({client_key:id(900),dispatch_id:p.dispatch_id,expected_snapshot_sha256:p.expected_snapshot_sha256,observation_sha256:outcome==='FAILED'?null:p.observation_sha256,outcome,confirmed:true,...patch});

test('uncertain write: status keeps a sanitized cause and logs one structured line; preview only GETs and shows plan vs observed',async()=>{
 const{m,lane}=await parked();
 const failure=m.state.audits.filter((a:any)=>a.action==='local_woo.stock.failure');assert.equal(failure.length,1);
 const e=failure[0].detail.evidence;assert.equal(e.phase,'provider_write');assert.equal(e.error_category,'ERROR');assert.equal(e.error_class,'Error');assert.equal(e.http_status,null);assert.equal(e.provider_writes,1);assert.equal(e.plan_phase,'write_started');assert.match(e.error_fingerprint,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(m.state.audits),leak);
 const lines=m.logs.filter((l:any)=>l.step==='local_woo.stock.failure');assert.equal(lines.length,1);assert.equal(lines[0].level,'error');assert.equal(lines[0].phase,'provider_write');assert.equal(lines[0].channel_id,m.s.channelId);assert.equal(lines[0].automatic_retry,false);assert.doesNotMatch(JSON.stringify(m.logs),leak);
 const status=await lane.readStockLane(operator(m),m.s.channelId);
 assert.equal(status.reconciliation_required,true);assert.equal(status.dispatch.kind,'offer.write');assert.equal(status.dispatch.job_state,'failed');assert.equal(status.diagnostic.phase,'provider_write');assert.doesNotMatch(JSON.stringify(status),leak);
 const before=frozen(m),wire=m.wire.length,preview=await lane.previewReconciliation(operator(m),m.s.channelId);
 assert.deepEqual(m.wire.slice(wire),['GET'],'observation is one read; never a PUT');assert.deepEqual(frozen(m),before,'preview changes nothing');
 assert.equal(preview.status,'LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW');assert.deepEqual(preview.planned,planned);assert.deepEqual(preview.observed,planned);assert.equal(preview.matches_plan,true);
 assert.deepEqual(preview.allowed_outcomes,['EFFECT_CONFIRMED','FAILED']);assert.match(preview.observation_sha256,/^[a-f0-9]{64}$/);assert.equal(preview.automatic_retry,false);assert.equal(preview.diagnostic.phase,'provider_write');
});
test('EFFECT_CONFIRMED closes the dispatch with a full audit, unblocks the channel and never repeats the PUT',async()=>{
 const{m,lane}=await parked(),a=operator(m),p=await lane.previewReconciliation(a,m.s.channelId);
 const ack=await lane.reconcile(a,m.s.channelId,command(p,'EFFECT_CONFIRMED'));
 assert.equal(ack.status,'LOCAL_WOO_STOCK_DISPATCH_RECONCILED');assert.equal(ack.outcome,'EFFECT_CONFIRMED');assert.equal(ack.automatic_retry,false);assert.equal(ack.job_state,'done');assert.equal(ack.plan_state,'done');
 const j=m.state.jobs[1],plan=m.state.plans[0];assert.equal(j.state,'done');assert.equal(plan.state,'done');assert.equal(plan.phase,'done');
 assert.equal(plan.result.scope,'operator_reconciled','never counted as a provider-verified write');assert.equal(plan.result.desired_applied,true);assert.deepEqual(plan.result.observed_payload,planned);assert.equal(plan.result.reconciliation.original_phase,'write_started');
 const rec=m.state.audits.filter((x:any)=>x.action==='local_woo.stock.reconcile');assert.equal(rec.length,1);assert.equal(rec[0].entity_id,j.id);assert.equal(rec[0].detail.outcome,'EFFECT_CONFIRMED');assert.equal(rec[0].detail.actor_id,m.s.userId);assert.deepEqual(rec[0].detail.observed,planned);assert.equal(rec[0].detail.job_state_before,'failed');
 const acks=m.state.audits.filter((x:any)=>x.action==='local_woo.stock.ack');assert.equal(acks.at(-1).entity_id,p.dispatch_id);assert.equal(acks.at(-1).detail.outcome,'OPERATOR_RECONCILED');
 assert(m.logs.some((l:any)=>l.step==='local_woo.stock.reconcile'&&l.outcome==='EFFECT_CONFIRMED'));
 assert.equal(lane.inspect().blocked,0);const puts=m.wire.filter(x=>x==='PUT').length;
 await lane.cycle();await m.lane().cycle();assert.equal(m.wire.filter(x=>x==='PUT').length,puts,'no automatic retry of the uncertain PUT');assert.equal(m.state.jobs.length,2);assert.equal(lane.inspect().blocked,0);
 assert.equal((await lane.readStockLane(a,m.s.channelId)).reconciliation_required,false);
 m.state.cfg.stock_due=true;await lane.cycle();const fresh=m.state.plans.at(-1);assert.notEqual(fresh.id,plan.id,'next write is a new plan');assert.equal(m.state.jobs[1].state,'done');assert.equal(plan.state,'done');
});
test('stale observation race: Woo changed after the preview is refused without any write',async()=>{
 const{m,lane}=await parked(),a=operator(m),p=await lane.previewReconciliation(a,m.s.channelId);
 m.state.quantity=5;const before=frozen(m);
 await assert.rejects(lane.reconcile(a,m.s.channelId,command(p,'EFFECT_CONFIRMED')),(e:any)=>e.status===409&&/od podglądu/.test(e.message));
 assert.deepEqual(frozen(m),before);assert.equal(m.wire.filter(x=>x==='PUT').length,1);await lane.cycle();assert.equal(lane.inspect().blocked,1);
 const again=await lane.previewReconciliation(a,m.s.channelId);assert.equal(again.matches_plan,false);assert.notEqual(again.observation_sha256,p.observation_sha256);
});
test('stale DB snapshot after preview is refused',async()=>{
 const{m,lane}=await parked(),a=operator(m),p=await lane.previewReconciliation(a,m.s.channelId);
 m.state.plans[0].error='changed';const before=frozen(m);
 await assert.rejects(lane.reconcile(a,m.s.channelId,command(p,'FAILED')),(e:any)=>e.status===409);assert.deepEqual(frozen(m),before);
 await assert.rejects(lane.reconcile(a,m.s.channelId,command(p,'FAILED',{dispatch_id:id(901)})),(e:any)=>e.status===409);
});
test('SUPERSEDED requires an observed mismatch and CONFIRMED refuses one',async()=>{
 const{m,lane}=await parked(),a=operator(m);m.state.quantity=5;const p=await lane.previewReconciliation(a,m.s.channelId);
 assert.equal(p.matches_plan,false);assert.deepEqual(p.allowed_outcomes,['SUPERSEDED','FAILED']);assert.deepEqual(p.observed,{...planned,stock_quantity:5});
 await assert.rejects(lane.reconcile(a,m.s.channelId,command(p,'EFFECT_CONFIRMED')),(e:any)=>e.status===409);
 const ack=await lane.reconcile(a,m.s.channelId,command(p,'SUPERSEDED'));assert.equal(ack.plan_state,'conflict');
 const plan=m.state.plans[0];assert.equal(plan.state,'conflict');assert.equal(plan.phase,'reconciled');assert.equal(plan.result.desired_applied,false);assert.equal(m.state.jobs[1].state,'done');assert.equal(lane.inspect().blocked,0);
 const n=model({unknownPut:true}),l=n.lane();await l.cycle();const pp=await l.previewReconciliation(operator(n),n.s.channelId);assert.equal(pp.matches_plan,true);
 await assert.rejects(l.reconcile(operator(n),n.s.channelId,command(pp,'SUPERSEDED')),(e:any)=>e.status===409);
});
test('FAILED closes without claiming the effect; the job is never run again, also after restart',async()=>{
 const{m,lane}=await parked(),a=operator(m),p=await lane.previewReconciliation(a,m.s.channelId);
 await assert.rejects(lane.reconcile(a,m.s.channelId,command(p,'FAILED',{observation_sha256:p.observation_sha256})),(e:any)=>e.status===422);
 const ack=await lane.reconcile(a,m.s.channelId,command(p,'FAILED'));assert.equal(ack.job_state,'failed');assert.equal(ack.plan_state,'failed');assert.equal(ack.original_outcome,'UNCONFIRMED');
 const plan=m.state.plans[0];assert.equal(plan.phase,'reconciled');assert.equal(plan.result.reconciliation.outcome,'FAILED');assert.equal(m.state.jobs[1].state,'failed');
 const puts=m.wire.filter(x=>x==='PUT').length,processed=m.processed.length;await lane.cycle();const restarted=m.lane();await restarted.cycle();
 assert.equal(restarted.inspect().blocked,0);assert.equal(m.processed.length,processed);assert.equal(m.wire.filter(x=>x==='PUT').length,puts);
 m.state.cfg.stock_due=true;await restarted.cycle();assert.deepEqual(m.processed.slice(processed),['offer.sync','offer.write'],'a fresh plan, never the reconciled job');
 assert.notEqual(m.state.plans.at(-1).id,plan.id);assert.equal(m.state.jobs[1].state,'failed');assert.equal(plan.state,'failed');assert.equal(m.wire.filter(x=>x==='PUT').length,puts+1,'only the new plan wrote');
});
test('authorization refusals: role, API key, other operator, other channel/tenant, lost DB admin, malformed body',async()=>{
 const{m,lane}=await parked(),a=operator(m),p=await lane.previewReconciliation(a,m.s.channelId),before=frozen(m),body=command(p,'EFFECT_CONFIRMED');
 for(const[who,status]of [[operator(m,{role:'viewer'}),403],[operator(m,{apiKeyId:id(77)}),403],[operator(m,{userId:id(78)}),404],[operator(m,{tenantId:id(79)}),404]] as const){
  await assert.rejects(lane.previewReconciliation(who,m.s.channelId),(e:any)=>e.status===status);await assert.rejects(lane.reconcile(who,m.s.channelId,body),(e:any)=>e.status===status);await assert.rejects(lane.readStockLane(who,m.s.channelId),(e:any)=>e.status===status);
 }
 await assert.rejects(lane.reconcile(a,id(80),body),(e:any)=>e.status===404);
 await assert.rejects(lane.reconcile(a,m.s.channelId,{...body,confirmed:false}),(e:any)=>e.name==='ZodError');
 await assert.rejects(lane.reconcile(a,m.s.channelId,{...body,extra:1}),(e:any)=>e.name==='ZodError');
 m.state.role='viewer';await assert.rejects(lane.previewReconciliation(a,m.s.channelId),(e:any)=>e.status===403);await assert.rejects(lane.reconcile(a,m.s.channelId,body),(e:any)=>e.status===403);
 assert.deepEqual(frozen(m),before);assert.equal(lane.inspect().blocked,1);
});
test('client key is idempotent: replay returns the stored result; reuse with another body is refused; observe reads it',async()=>{
 const{m,lane}=await parked(),a=operator(m),p=await lane.previewReconciliation(a,m.s.channelId),body=command(p,'EFFECT_CONFIRMED');
 assert.equal((await lane.observeReconciliation(a,m.s.channelId,body)).status,'RECONCILE_RESULT_UNKNOWN');
 const first=await lane.reconcile(a,m.s.channelId,body),wire=m.wire.length,second=await lane.reconcile(a,m.s.channelId,body);
 assert.deepEqual(second,first);assert.equal(m.wire.length,wire,'replay does not read Woo again');assert.equal(m.state.audits.filter((x:any)=>x.action==='local_woo.stock.reconcile').length,1);
 await assert.rejects(lane.reconcile(a,m.s.channelId,{...body,outcome:'FAILED',observation_sha256:null}),(e:any)=>e.status===409);
 const seen=await lane.observeReconciliation(a,m.s.channelId,body);assert.equal(seen.status,'RECONCILE_RESULT_ACKNOWLEDGED');assert.deepEqual(seen.ack,first);
});
test('unacknowledged offer.sync dispatch (lost dispatch COMMIT) can only be failed and needs no provider read',async()=>{
 const m=model({unknownDispatch:true}),lane=m.lane();await lane.cycle();assert.equal(m.state.jobs[0].state,'running');await lane.cycle();
 const a=operator(m),p=await lane.previewReconciliation(a,m.s.channelId);assert.equal(p.kind,'offer.sync');assert.deepEqual(p.allowed_outcomes,['FAILED']);assert.equal(p.observed,null);assert.equal(m.wire.length,0);
 await assert.rejects(lane.reconcile(a,m.s.channelId,command(p,'EFFECT_CONFIRMED',{observation_sha256:null})),(e:any)=>e.status===409||e.status===422);
 const ack=await lane.reconcile(a,m.s.channelId,command(p,'FAILED'));assert.equal(ack.job_state,'failed');assert.equal(m.state.jobs[0].state,'failed');assert.equal(m.processed.length,0);
 m.state.cfg.stock_due=true;await lane.cycle();assert.equal(lane.inspect().blocked,0);assert.equal(m.processed[0],'offer.sync');
});
test('an executing dispatch cannot be reconciled from under the lane',async()=>{
 let lane:any;const seen:any[]=[];
 const m:any=model({returnRunning:true,duringWrite:async()=>{const a=operator(m);seen.push(await lane.previewReconciliation(a,m.s.channelId));const token=m.state.audits.filter((x:any)=>x.action==='local_woo.stock.dispatch').at(-1).entity_id;
  await assert.rejects(lane.reconcile(a,m.s.channelId,{client_key:id(902),dispatch_id:token,expected_snapshot_sha256:'0'.repeat(64),observation_sha256:null,outcome:'FAILED',confirmed:true}),(e:any)=>e.status===409&&/w toku/.test(e.message));}});
 lane=m.lane();await lane.cycle();await lane.cycle();
 assert.equal(seen.length,1);assert.equal(seen[0].status,'DISPATCH_IN_PROGRESS');assert.equal(m.state.audits.filter((x:any)=>x.action==='local_woo.stock.reconcile').length,0);
 const p=await lane.previewReconciliation(operator(m),m.s.channelId);assert.equal(p.status,'LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW');assert.equal(p.job_state,'running');
});
test('throughput: one cycle drains the plan and its write; the write still reads Woo right before its PUT',async()=>{
 const m=model(),lane=m.lane();await lane.cycle();assert.deepEqual(m.processed,['offer.sync','offer.write']);assert.deepEqual(m.wire,['GET','GET','PUT','GET']);assert(m.state.jobs.every((j:any)=>j.state==='done'));
 await lane.cycle();assert.deepEqual(m.processed,['offer.sync','offer.write'],'nothing due: no extra work');
});
test('throughput: selected stores run concurrently; a slow store does not hold back another; a claim stop is logged',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);const m=model({second:true,secondGate:gate}),lane=m.lane([m.s2,m.s]);
 const work=lane.cycle();await new Promise(r=>setTimeout(r,30));assert.deepEqual(m.processed,['offer.sync','offer.write'],'first-listed slow store did not serialize the other');
 release();await work;assert.equal(lane.inspect().blocked,1,'foreign-configured second store stops on its own');
 const stop=m.logs.find((l:any)=>l.step==='local_woo.stock.stopped');assert.equal(stop.channel_id,m.s2.channelId);assert.equal(stop.phase,'claim');assert.equal(stop.automatic_retry,false);
});
test('reconcile: provider refusal on the fresh read is a 502 without any write; unenrolled store is refused before Woo',async()=>{
 let status:number|undefined;const{m,lane}=await parked({getStatus:()=>status}),a=operator(m),p=await lane.previewReconciliation(a,m.s.channelId),before=frozen(m);
 status=401;const preview=await lane.previewReconciliation(a,m.s.channelId);assert.equal(preview.observed,null);assert.deepEqual(preview.allowed_outcomes,['FAILED']);assert.equal(preview.observation_error.provider_http_status,401);assert.doesNotMatch(JSON.stringify(preview),leak);
 await assert.rejects(lane.reconcile(a,m.s.channelId,command(p,'EFFECT_CONFIRMED')),(e:any)=>e.status===502&&!leak.test(e.message));assert.deepEqual(frozen(m),before);
 status=undefined;m.state.enrolled=false;const wire=m.wire.length;
 await assert.rejects(lane.previewReconciliation(a,m.s.channelId),(e:any)=>e.status===409);await assert.rejects(lane.reconcile(a,m.s.channelId,command(p,'EFFECT_CONFIRMED')),(e:any)=>e.status===409);assert.equal(m.wire.length,wire);assert.deepEqual(frozen(m),before);
});

// Schedule pause/change (offer-sync-configuration.ts): no-blind-retry boundary per job. A write that left keeps
// its verification; work without any non-GET request ends without effect; nothing here parks the channel.
const cancelCause='Harmonogram stanów wstrzymano lub zmieniono; zadanie anulowane bez skutku u dostawcy';
/** The configuration transaction's effect on the lane's rows (SQL modelled in offer-sync-commands.test.ts). */
function reschedule(st:any,enabled:boolean){
 st.cfg.version++;st.cfg.enabled=enabled;st.cfg.stock_due=enabled;
 for(const j of st.jobs)if(j.state==='pending'&&j.attempts===0&&!j.lease_token&&j.payload.local_woo_stock?.schema==='local-woo-stock-owned/v1'&&(j.kind==='offer.sync'||st.plans.some((p:any)=>p.job_id===j.id&&p.state==='queued'&&p.phase==='ready')))Object.assign(j,{state:'done',error:cancelCause});
 for(const p of st.plans)if(p.state==='queued'&&p.phase==='ready'&&!st.jobs.some((j:any)=>j.id===p.job_id&&j.state==='running'&&j.payload.local_woo_stock))Object.assign(p,{state:'conflict',error:'Harmonogram ofert wyłączono lub zmieniono'});
}
const once=(fn:(s:any)=>void)=>{let first=true;return(s:any)=>{if(first){first=false;fn(s);}};};
const acks=(m:any)=>m.state.audits.filter((a:any)=>a.action==='local_woo.stock.ack');
test('pause or change before the PUT: the held write ends done without effect, the channel is not parked, re-enabling resumes',async()=>{
 for(const enabled of [false,true]){
  const m=model({beforeWrite:once(s=>reschedule(s,enabled))}),lane=m.lane();await lane.cycle();
  const j=m.state.jobs[1],p=m.state.plans[0];assert.equal(j.state,'done');assert.equal(j.lease_token,null);assert.match(j.error,/bez skutku/);assert.equal(p.state,'conflict');assert.equal(p.phase,'ready');
  const ack=acks(m).find((a:any)=>a.detail.job_id===j.id);assert.equal(ack.detail.outcome,'NO_EFFECT_CANCELLED');assert.equal(ack.detail.provider_writes,0);assert.equal(ack.detail.provider_requests,1);assert.equal(ack.detail.automatic_retry,false);
  assert(!m.state.audits.some((a:any)=>a.action==='local_woo.stock.failure'));assert(!m.state.jobs.some((x:any)=>x.state==='failed'));assert.equal(lane.inspect().blocked,0);
  if(enabled){
   // A changed (still enabled) schedule is due at once: the same drain plans and writes under the new version.
   assert.deepEqual(m.processed,['offer.sync','offer.write','offer.sync','offer.write']);assert.equal(m.wire.filter(x=>x==='PUT').length,1);assert.equal(m.state.plans[1].sync_version,2);
  }else{
   assert.equal(m.wire.filter(x=>x==='PUT').length,0,'no PUT after the pause');
   m.state.cfg.enabled=true;m.state.cfg.version++;m.state.cfg.stock_due=true;
   const next=m.lane();await next.cycle();assert.equal(next.inspect().blocked,0);
   assert.equal(m.wire.filter(x=>x==='PUT').length,1,'re-enabled: a fresh plan is written');
  }
  assert.equal(m.state.jobs.length,4);assert(m.state.jobs.every((x:any)=>x.state==='done'));
  await lane.cycle();assert.equal(lane.inspect().blocked,0,'the original instance is not parked either');
 }
});
test('pause after the PUT left: the write is verified and acknowledged, never parked; a genuine lost ACK still parks',async()=>{
 const m=model({afterPut:s=>reschedule(s,false)}),lane=m.lane();await lane.cycle();
 assert.equal(m.wire.filter(x=>x==='PUT').length,1);assert.deepEqual(m.wire,['GET','GET','PUT','GET'],'verification read after the pause');
 assert.equal(lane.inspect().blocked,0);assert.equal(m.state.jobs[1].state,'done');assert.equal(m.state.plans[0].state,'done');
 assert.equal(acks(m).at(-1).detail.provider_result.scope,'external_api_verified');
 await lane.cycle();assert.equal(m.processed.length,2,'paused: nothing new');
 const u=model({unknownPut:true,afterPut:s=>reschedule(s,false)}),l=u.lane();await l.cycle();
 assert.equal(l.inspect().blocked,1,'an uncertain write keeps the stop');assert.equal(u.state.jobs[1].state,'failed');
 const p=await l.previewReconciliation(operator(u),u.s.channelId);assert.equal(p.status,'LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW');assert.deepEqual(p.allowed_outcomes,['EFFECT_CONFIRMED','FAILED']);
 const ack=await l.reconcile(operator(u),u.s.channelId,command(p,'EFFECT_CONFIRMED'));assert.equal(ack.job_state,'done');assert.equal(l.inspect().blocked,0);
});
test('pause after the plan was queued: the owned pending child and offer.sync continuation end without effect; no stop; re-enabling plans again',async()=>{
 const m=model({afterSync:once(s=>{s.jobs[0].state='pending';reschedule(s,false);})}),lane=m.lane();await lane.cycle();
 assert.deepEqual(m.processed,['offer.sync']);assert.equal(m.wire.filter(x=>x==='PUT').length,0);assert.equal(lane.inspect().blocked,0);
 assert.equal(m.state.jobs[0].state,'done');assert.equal(m.state.jobs[1].state,'done');assert.equal(m.state.plans[0].state,'conflict');
 const ack=acks(m).at(-1);assert.equal(ack.detail.job_id,m.state.jobs[0].id);assert.equal(ack.detail.outcome,'NO_EFFECT_CANCELLED');
 assert.equal((await lane.readStockLane(operator(m),m.s.channelId)).reconciliation_required,false);
 m.state.cfg.enabled=true;m.state.cfg.version++;m.state.cfg.stock_due=true;await lane.cycle();
 assert.equal(lane.inspect().blocked,0);assert.deepEqual(m.processed,['offer.sync','offer.sync','offer.write']);assert.equal(m.wire.filter(x=>x==='PUT').length,1);
});
test('pause between the eligibility read and the claim is inert, not a stop',async()=>{
 const m=model({afterEligibility:once(s=>reschedule(s,false))}),lane=m.lane();await lane.cycle();
 assert.equal(lane.inspect().blocked,0);assert.equal(m.state.jobs.length,0);assert(!m.logs.some((l:any)=>l.step==='local_woo.stock.stopped'));
 m.state.cfg.enabled=true;m.state.cfg.version++;m.state.cfg.stock_due=true;await lane.cycle();assert.deepEqual(m.processed,['offer.sync','offer.write']);
});
test('legacy: owned work failed by an older configuration before any dispatch does not park the channel after re-enabling',async()=>{
 const m=model({afterSync:once(s=>{s.cfg.version++;s.cfg.enabled=false;Object.assign(s.jobs[1],{state:'failed',error:'Harmonogram ofert wyłączono lub zmieniono'});s.plans[0].state='conflict';})}),lane=m.lane();await lane.cycle();
 assert.equal(lane.inspect().blocked,0);m.state.cfg.enabled=true;m.state.cfg.version++;m.state.cfg.stock_due=true;
 const next=m.lane();await next.cycle();assert.equal(next.inspect().blocked,0);assert.equal(m.wire.filter(x=>x==='PUT').length,1);
 assert.match(source,/j\.state='failed' AND j\.attempts>0/,'only a dispatched failure (attempts>0) can hold the lane');
});
test('a job that failed after it was dispatched still parks when the schedule changes (no cancellation of uncertain work)',async()=>{
 const m=model({conflict:'after_put',afterPut:s=>reschedule(s,true)}),lane=m.lane();await lane.cycle();
 assert.equal(lane.inspect().blocked,1);assert.equal(m.state.jobs[1].state,'failed');assert(!acks(m).some((a:any)=>a.detail.outcome==='NO_EFFECT_CANCELLED'));
});
