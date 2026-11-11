/** Actual sync processor with controlled DB/connector ports; no PG/network. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as crypto from 'node:crypto';
import {transformSync} from 'esbuild';
import {ensure} from '../server/errors';
const source=readFileSync(new URL('../server/sync.ts',import.meta.url),'utf8');
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(v:unknown)=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return{promise,resolve};}
function fixture({fence=true,sourceText=source}={}){
 const original={id:id(3),tenant_id:id(1),provider:'woocommerce',mode:'sandbox',settings:{store_url:'https://localhost:18445',simulation:false},credentials:'ciphertext',sync_enabled:false,event_cursor:null};
 const job={id:id(4),tenant_id:id(1),kind:'orders.sync',state:'running',attempts:1,lease_token:id(5),payload:{actor_id:id(2),channel_id:id(3),page:1,phase:'bootstrap'}};
 const state:any={role:'admin',channel:structuredClone(original),job:structuredClone(job),staged:[],runs:[],quota:0};const calls:string[]=[],release=deferred<any>(),started=deferred<void>();let tx=false,fenceClient:any;
 const c={query:async(text:string,args:any[]=[])=>{assert(tx,'staging query requires exact active transaction');
  if(text==='SELECT * FROM channels WHERE tenant_id=$1 AND id=$2 FOR UPDATE'){calls.push('fence.channel');assert.deepEqual(args,[id(1),id(3)]);return{rows:[structuredClone(state.channel)]};}
  if(text==='SELECT public.offer_sync_is_admin($1) AS ok'){calls.push('fence.admin');assert.deepEqual(args,[id(2)]);return{rows:[{ok:state.role==='admin'}]};}
  if(text.includes("SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE")){calls.push('job.lock');assert.deepEqual(args,[id(4),id(5)]);return{rows:state.job.state==='running'&&state.job.lease_token===args[1]?[{id:id(4)}]:[]};}
  if(text.startsWith('UPDATE channels SET event_cursor=')){calls.push('channel.completion');return{rows:[]};}
  if(text.startsWith('UPDATE jobs SET state=')){calls.push('job.completion');state.job.state=args[0];return{rows:[]};}
  if(text.startsWith('INSERT INTO integration_runs(')){calls.push('run.insert');state.runs.push(args);return{rows:[]};}
  throw Error('Unexpected controlled statement: '+text);
 }};
 const tenantTx=async(tenant:string,fn:any)=>{assert.equal(tenant,id(1));assert(!tx);tx=true;const before=structuredClone(state);try{const result=await fn(c);calls.push('tx.commit');return result;}catch(e){Object.assign(state,before);calls.push('tx.rollback');throw e;}finally{tx=false;}};
 class WooCommerce{}class PrestaShop{}class Allegro{}class Shopify{}
 const port=(name:string)=>async()=>{throw Error('Unselected provider '+name);};
 const module={exports:{}};new Function('module','require',transformSync(sourceText,{loader:'ts',format:'cjs',target:'es2022'}).code)(module,(name:string)=>{
  if(name==='node:crypto')return crypto;
  if(name==='./db')return{tenantTx,pool:{query:async(text:string,args:any[])=>{assert(text.startsWith('SELECT role FROM memberships'));assert.deepEqual(args,[id(1),id(2)]);calls.push('actor.initial');return{rows:[{role:state.role}]};}}};
  if(name==='./errors')return{ensure};
  if(name==='./domain')return{audit:async()=>{}};
  if(name==='./integrations')return{WooCommerce,PrestaShop,Allegro};if(name==='./shopify')return{Shopify};
  if(name==='./imports')return{acquireOrderFieldObservationAdmissionInTx:async(client:any)=>{assert.equal(client,c);assert(tx);state.quota++;calls.push('quota');},stageOrders:async(client:any,actor:any,ch:any,rows:any[])=>{assert.equal(client,c);assert(tx);assert.equal(actor.userId,id(2));assert.equal(ch.id,id(3));state.staged.push(...rows);calls.push('stage');}};
  if(name==='./channel-access')return{withAllegroJobContext:(ctx:any)=>({...ctx}),loadChannel:async()=>structuredClone(original),channelRead:async(tenant:string,channel:string,read:any)=>{assert.equal(tenant,id(1));assert.equal(channel,id(3));return read(new WooCommerce());}};
  const other:Record<string,any>={'./shopify-oauth':{shopifyAccountPolicy:port(name)},'./shopify-auth-input':{shopifyCredentialIdentity:port(name)},'./amazon-account':{amazonAccountPolicy:port(name)},'./amazon-order-sync':{amazonSyncPayload:port(name),processAmazonSync:port(name)},'./ebay-order-sync':{ebaySyncPayload:port(name),processEbaySync:port(name)},'./odoo-order-sync':{odooSyncPayload:port(name),processOdooSync:port(name)}};assert(Object.hasOwn(other,name),'explicit controlled import '+name);return other[name];
 });
 const context:any={localWooOrdersRead:async(channel:string)=>{assert.equal(channel,id(3));calls.push('read');started.resolve();return release.promise;}};
 if(fence)context.localWooReadLaneBeforeStage=async(client:any,current:any)=>{assert(tx);assert.equal(client,c);fenceClient=client;assert.equal(current.id,job.id);assert.equal(current.lease_token,job.lease_token);const ch=(await client.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[id(1),id(3)])).rows[0];ensure((await client.query('SELECT public.offer_sync_is_admin($1) AS ok',[id(2)])).rows[0].ok===true,403,'Administrator utracił zgodę');ensure(hash(ch)===hash(original),409,'Połączenie zmieniło się');};
 const run=()=> (module.exports as any).processIntegrationJob(structuredClone(job),context);
 const complete=()=>release.resolve({data:[{id:77,total:'12.30'}],has_more:false,pagination:{schema:'local-woo-orders-read/v1',complete:true,pages:1,unique_orders:1,response_bytes:100,termination:'total_pages'}});
 return{run,state,calls,started,complete,get fenceClient(){return fenceClient;}};
}
test('same transaction final fence runs before lease, quota, staging and completion',async()=>{const f=fixture(),work=f.run();await f.started.promise;f.complete();await work;assert.equal(f.state.staged.length,1);assert.equal(f.state.runs.length,1);assert.equal(f.state.job.state,'done');assert.deepEqual(f.calls,['actor.initial','read','fence.channel','fence.admin','job.lock','quota','stage','channel.completion','job.completion','run.insert','tx.commit']);assert(f.fenceClient);});
test('admin revoked during actual delayed Woo read prevents all durable staging/completion',async()=>{const f=fixture(),work=f.run();await f.started.promise;f.state.role='viewer';f.complete();await assert.rejects(work,(e:any)=>e.status===403);assert.equal(f.state.staged.length,0);assert.equal(f.state.runs.length,0);assert.equal(f.state.quota,0);assert.equal(f.state.job.state,'running');assert(!f.calls.includes('job.lock'));assert(f.calls.includes('tx.rollback'));});
test('source or ciphertext changed during read refuses before staging, preserving held lease',async()=>{for(const change of [(f:any)=>f.state.channel.credentials='rotated',(f:any)=>f.state.channel.settings.store_url='https://localhost:18446',(f:any)=>f.state.channel.sync_enabled=true]){const f=fixture(),work=f.run();await f.started.promise;change(f);f.complete();await assert.rejects(work,(e:any)=>e.status===409);assert.equal(f.state.staged.length,0);assert.equal(f.state.runs.length,0);assert.equal(f.state.quota,0);assert.equal(f.state.job.state,'running');assert(!f.calls.includes('job.lock'));}});
test('lease loss after successful fence still follows existing no-stage path',async()=>{const f=fixture(),work=f.run();await f.started.promise;f.state.job.lease_token=id(99);f.complete();await work;assert.equal(f.state.staged.length,0);assert.equal(f.state.runs.length,0);assert(f.calls.includes('job.lock'));assert(!f.calls.includes('stage'));});
test('ordinary existing Woo context without a lane hook retains its original read/stage behavior',async()=>{const f=fixture({fence:false}),work=f.run();await f.started.promise;f.complete();await work;assert.equal(f.state.staged.length,1);assert.equal(f.state.runs.length,1);assert(!f.calls.includes('fence.channel'));assert.equal(f.state.job.state,'done');});
