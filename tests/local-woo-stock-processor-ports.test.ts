/** Exercise actual processor transaction bodies with controlled ports, no PG/HTTP. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as crypto from 'node:crypto';
import {transformSync} from 'esbuild';
import {ensure,Problem} from '../server/errors';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function syncModel(revokeAfterPreview=false){
 const events:string[]=[],cfg={channel_id:id(2),tenant_id:id(1),warehouse_id:id(8),version:1,stock:true,price:false,price_list_id:null,external_authorized:true,verify_seconds:60},j={id:id(3),tenant_id:id(1),lease_token:id(4),payload:{channel_id:id(2),actor_id:id(5),version:1,after:null,stats:{checked:0,skipped:0,queued:0,unchanged:0,waiting:0,errors:0}}};let revoked=false,queued=0;
 const snapshot={quantity:8},p={id:id(6),before:{stock_quantity:7},payload:{manage_stock:true,stock_quantity:8,backorders:'no'}};
 const c={query:async(sql:string,args:any[])=>{
  if(sql.startsWith('SELECT * FROM offer_sync_configs'))return{rows:[cfg]};
  if(sql.startsWith("SELECT id FROM jobs WHERE id=$1 AND lease_token=$2")||sql.startsWith('UPDATE jobs SET locked_at'))return{rowCount:1,rows:[{id:j.id}]};
  if(sql.startsWith('SELECT l.* FROM listings'))return{rows:[{id:id(7),external_id:'1',product_id:id(9),parent_external_id:null}]};
  if(sql.startsWith('SELECT * FROM offer_sync_items')||sql.startsWith('SELECT id,state,phase FROM offer_plans'))return{rows:[]};
  if(sql.startsWith('SELECT local_snapshot'))return{rows:[{local_snapshot:snapshot}]};
  if(sql.startsWith('INSERT INTO offer_sync_items')){events.push('saveItem:'+args[9]);return{rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE jobs SET state=')){events.push('parent.checkpoint');return{rowCount:1};}
  if(sql.startsWith('UPDATE offer_sync_configs SET last_run_at'))return{rowCount:1};
  throw Error('Unexpected actual sync SQL '+sql);
 }};
 const ctx={localWooStockFence:async(client:any,job:any)=>{assert.equal(client,c);assert.equal(job,j);events.push('fence');ensure(!revoked,409,'Source revoked');},localWooStockQueued:async(client:any,job:any,q:any)=>{assert.equal(client,c);assert.equal(job,j);assert.deepEqual(q,{id:p.id,job_id:id(10),state:'queued'});events.push('child.owned.same.tx');}};
 const resolve=(name:string):any=>{
  if(name==='node:crypto')return crypto;if(name==='./errors')return{ensure,Problem};if(name==='./db')return{tenantTx:async(_id:string,fn:any)=>{events.push('tx.begin');const out=await fn(c);events.push('tx.commit');return out;},pool:{query:()=>assert.fail('global pool scheduler not allowed')}};
  if(name==='./domain')return{audit:async()=>{}};if(name==='./channel-access')return{loadChannel:async()=>({id:id(2),provider:'woocommerce'}),withAllegroJobContext:(v:any)=>({...v})};
  if(name==='./offer-sync-policy')return{syncPolicy:async()=>true};if(name==='./sync')return{systemActor:async()=>({tenantId:id(1),userId:id(5),role:'admin'})};
  if(name==='./offers')return{offerInput:{parse:(v:any)=>v},desiredOffer:async()=>({quantity:8,p:{price:100,vat:23},snapshot}),offerSnapshotHash:(s:any)=>JSON.stringify(s),offerMatches:()=>false,previewOffer:async()=>{events.push('preview');revoked=revokeAfterPreview;return p;},queueOffer:async(client:any)=>{assert.equal(client,c);queued++;events.push('child.queue');return{id:p.id,job_id:id(10),state:'queued'};}};
  if(name==='./allegro-oauth-authority')return{allegroOAuthCommitRefusalDetails:()=>false};
  if(name==='./amazon-api-limits')return{AmazonApiWait:class extends Error{}};if(name==='./ebay-api-limits')return{EbayApiWait:class extends Error{}};throw Error(name);
 };
 const module={exports:{}};new Function('module','require',transformSync(readFileSync(new URL('../server/offer-sync.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs',target:'es2022'}).code)(module,resolve);
 return{run:()=>(module.exports as any).processOfferSync(j,ctx),events,get queued(){return queued;}};
}
test('actual full offer.sync calls source fence then exact queue callback on the same transaction before commit',async()=>{const m=syncModel();await m.run();assert.equal(m.queued,1);const at=m.events.indexOf('child.queue');assert.equal(m.events[at-1],'fence');assert.equal(m.events[at+1],'child.owned.same.tx');const commit=m.events.indexOf('tx.commit',at);assert(commit>m.events.indexOf('saveItem:queued'));assert(m.events.indexOf('parent.checkpoint')>commit);});
test('actual full offer.sync cannot queue/stage a child after revocation during preview',async()=>{const m=syncModel(true);await assert.rejects(m.run(),/Source revoked/);assert.equal(m.queued,0);assert(!m.events.includes('parent.checkpoint'));assert(!m.events.some(x=>x.startsWith('saveItem:')));});
test('actual offer.write phase invokes same-TX fence before job lock or any plan mutation',async()=>{
 const src=readFileSync(new URL('../server/offers.ts',import.meta.url),'utf8'),start=src.indexOf('async function offerPhase('),end=src.indexOf('\nfunction matches(',start);assert(start>0&&end>start);
 const code=transformSync(src.slice(start,end)+'\nexports.phase=offerPhase;',{loader:'ts',format:'cjs',target:'es2022'}).code;
 const calls:string[]=[],client={query:()=>assert.fail('Fence must run before query')},job={tenant_id:id(1)};
 const module={exports:{}};new Function('exports','tenantTx','fenced',code)(module.exports,async(tenant:string,fn:any)=>{assert.equal(tenant,id(1));calls.push('tx');return fn(client);},()=>assert.fail('Before existing lease fence'));
 for(const phase of ['write_started','verify'])await assert.rejects((module.exports as any).phase(job,{phase},{localWooStockFence:async(c:any,j:any)=>{assert.equal(c,client);assert.equal(j,job);calls.push('source');throw Error('Source revoked');}}),/Source revoked/);
 assert.deepEqual(calls,['tx','source','tx','source']);
});
function writeModel(revokeOnVerification=false){
 const src=readFileSync(new URL('../server/offers.ts',import.meta.url),'utf8'),start=src.indexOf('async function fenced('),end=src.indexOf('\nexport async function failOffer(',start);assert(start>0&&end>start);
 const job={id:id(20),tenant_id:id(1),lease_token:id(21),payload:{actor_id:id(5),channel_id:id(2),plan_id:id(6)}},snapshot={quantity:8,price:100,currency:'PLN'},payload={manage_stock:true,stock_quantity:8,backorders:'no'};
 const ch={id:id(2),provider:'woocommerce',settings:{simulation:false}},plan:any={id:id(6),tenant_id:id(1),actor_id:id(5),channel_id:id(2),product_id:id(9),listing_id:id(7),warehouse_id:id(8),operation:'sync',sync_version:1,state:'queued',phase:'ready',remote_id:'1',input:{stock:true,price:false},payload,local_snapshot:snapshot};
 const events:string[]=[],state:any={revoked:false,quantity:7,plan,jobState:'running',listingUpdates:0};
 const c={query:async(sql:string,args:any[]=[])=>{
  events.push(sql);
  if(sql.startsWith('UPDATE jobs SET locked_at'))return{rows:[{id:job.id}],rowCount:1};
  if(sql.startsWith('SELECT * FROM offer_plans'))return{rows:[structuredClone(plan)]};
  if(sql.startsWith('SELECT pg_advisory'))return{rows:[]};
  if(sql==='SELECT offer_sync_is_admin($1) AS authorized')return{rows:[{authorized:true}]};
  if(sql.startsWith('SELECT * FROM channels'))return{rows:[ch]};
  if(sql.startsWith('UPDATE offer_plans SET phase=')){plan.phase=args[1];return{rowCount:1};}
  if(sql.startsWith('SELECT last_result'))return{rows:[{last_result:{}}]};
  if(sql.startsWith('SELECT price FROM'))return{rows:[{price:100}]};
  if(sql.startsWith('SELECT price_currency'))return{rows:[{price_currency:'PLN'}]};
  if(sql.startsWith('UPDATE listings SET')){state.listingUpdates++;return{rowCount:1};}
  if(sql.startsWith("UPDATE offer_plans SET state='done'")){plan.state='done';plan.phase='done';plan.result=JSON.parse(args[3]);return{rowCount:1};}
  if(sql.startsWith("UPDATE jobs SET state='done'")){state.jobState='done';return{rowCount:1};}
  throw Error('Unexpected actual write SQL '+sql);
 }};
 class Woo{
  constructor(readonly ctx:any){}
  async product(){const response=await this.ctx.transport('https://localhost:8443/wp-json/wc/v3/products/1',{method:'GET'});return response.json();}
  async writeProduct(_id:string,p:any){await this.ctx.transport('https://localhost:8443/wp-json/wc/v3/products/1',{method:'PUT',body:JSON.stringify(p)});}
 }
 class Other{}
 class Lock{async connect(){events.push('lock.connect');}async query(){return{rows:[]};}async end(){events.push('lock.close');}}
 const tx=async(_t:string,fn:any)=>{events.push('tx.begin');try{const r=await fn(c);events.push('tx.commit');return r;}catch(e){events.push('tx.rollback');throw e;}};
 // f7fe7ef: the advisory-lock connection is wrapped by db-lock-holder (lost connection fails closed); the controlled
 // Lock never loses its connection, so the wrapper is modeled as transparent around the same flow.
 const env:any={ensure,Problem,pg:{Client:Lock},lockDbClient:(client:any)=>client,holdingDbLock:(_client:any,fn:()=>Promise<unknown>)=>fn(),pool:{options:{connectionString:'controlled'}},tenantTx:tx,withAllegroJobContext:(v:any)=>({...v}),systemActor:async()=>({tenantId:id(1),userId:id(5),role:'admin'}),loadChannel:async()=>ch,hash:(v:any)=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'),connectionHash:()=>'',local:async()=>({snapshot,p:{price:100}}),syncPolicy:async()=>true,requireSyncPolicy:async()=>{},requireNoShopifyUncertain:async()=>{},creation:()=>false,WooCommerce:Woo,PrestaShop:Other,Shopify:Other,Ebay:Other,Allegro:Other,decimal:(n:number)=>(n/100).toFixed(2),audit:async()=>events.push('audit.done'),channelRead:async(_t:string,_c:string,fn:any,ctx:any)=>fn(new Woo(ctx))};
 const code=transformSync(src.slice(start,end)+'\nexports.process=processOfferJob;',{loader:'ts',format:'cjs',target:'es2022'}).code,module={exports:{}};new Function('module','exports',...Object.keys(env),code)(module,module.exports,...Object.values(env));
 const ctx={localWooStockFence:async(client:any,j:any)=>{assert.equal(client,c);assert.equal(j,job);events.push('stock.fence');ensure(!state.revoked,409,'Revoked before final write stage');},transport:async(_url:string,init:any)=>{events.push('wire:'+init.method);if(init.method==='PUT')state.quantity=JSON.parse(init.body).stock_quantity;if(init.method==='GET'&&state.quantity===8&&revokeOnVerification)state.revoked=true;return new Response(JSON.stringify({id:1,stock_quantity:state.quantity,manage_stock:true,backorders:'no',status:'publish'}));}};
 return{run:()=>(module.exports as any).processOfferJob(job,ctx),events,state};
}
test('actual full Woo offer.write retains existing GET→phase→PUT→GET→result flow with final same-TX fence',async()=>{const m=writeModel();await m.run();assert.deepEqual(m.events.filter(x=>x.startsWith('wire:')),['wire:GET','wire:PUT','wire:GET']);assert.equal(m.state.jobState,'done');assert.equal(m.state.plan.result.scope,'external_api_verified');assert.equal(m.state.plan.result.desired_applied,true);assert.equal(m.state.listingUpdates,1);assert.equal(m.events.at(-1),'lock.close');const lastWire=m.events.lastIndexOf('wire:GET');assert(m.events.indexOf('stock.fence',lastWire)>lastWire);});
test('actual full Woo offer.write refuses local completion after source revocation during provider verification',async()=>{const m=writeModel(true);await assert.rejects(m.run(),/Revoked before final write stage/);assert.equal(m.state.quantity,8,'provider changed; do not mislabel rollback of provider');assert.equal(m.state.jobState,'running');assert.equal(m.state.plan.phase,'write_started');assert.equal(m.state.listingUpdates,0);assert.equal(m.state.plan.result,undefined);assert(!m.events.includes('audit.done'));assert.equal(m.events.at(-1),'lock.close');});
