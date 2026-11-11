/** Actual stock-lane operator route handlers with controlled native-session/core ports. No HTTP/DB/listener. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {transformSync} from 'esbuild';import {z} from 'zod';import {ensure,Problem} from '../server/errors';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const base='/api/local-fixtures/woocommerce/channels/:channelId/stock-lane';
const body={client_key:id(8),dispatch_id:id(9),expected_snapshot_sha256:'a'.repeat(64),observation_sha256:'b'.repeat(64),outcome:'EFFECT_CONFIRMED',confirmed:true};
function fixture(patch:any={}){
 const routes=new Map<string,any>(),calls:any[]=[],state:any={running:true,...patch};
 const lane={
  readStockLane:async(...args:any[])=>{calls.push(['status',...args]);return{channel_id:args[1],blocked:true,reconciliation_required:true,in_progress:false,dispatch:null,diagnostic:null,automatic_retry:false};},
  previewReconciliation:async(...args:any[])=>{calls.push(['preview',...args]);return{status:'LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW'};},
  reconcile:async(...args:any[])=>{calls.push(['reconcile',...args]);if(state.failure)throw state.failure;return{status:'LOCAL_WOO_STOCK_DISPATCH_RECONCILED'};},
  observeReconciliation:async(...args:any[])=>{calls.push(['observe',...args]);return{status:'RECONCILE_RESULT_UNKNOWN',ack:null};},
 };
 const m={exports:{}};new Function('module','require',transformSync(readFileSync(new URL('../server/local-woo-stock-lane-routes.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs',target:'es2022'}).code)(m,(name:string)=>{if(name==='zod')return{z};if(name==='./errors')return{ensure};throw Error('Unexpected runtime dependency '+name);});
 (m.exports as any).registerLocalWooStockLaneRoutes({get:(p:string,f:any)=>routes.set('GET '+p,f),post:(p:string,f:any)=>routes.set('POST '+p,f)},{lane:state.absent?undefined:lane,readOnly:state.readOnly??false,sessionName:'dyna_session',processorRunning:()=>state.running});
 const req=()=>({actor:{tenantId:id(1),userId:id(2),role:'admin'},currentUser:{tenant_id:id(1),id:id(2),role:'admin'},cookies:{dyna_session:'private'},headers:{},params:{channelId:id(3)},query:{},body:structuredClone(body)});
 const invoke=async(method:string,path=base,r:any=req())=>(await routes.get(method+' '+path)(r));
 return{routes,calls,state,req,invoke};
}
const untrusted=[(r:any)=>r.headers.authorization='Bearer bad',(r:any)=>r.cookies={},(r:any)=>r.actor.apiKeyId=id(7),(r:any)=>r.apiScopes=[],(r:any)=>r.actor.source='api',(r:any)=>r.actor.role='viewer',(r:any)=>r.currentUser.role='viewer',(r:any)=>r.currentUser.tenant_id=id(99),(r:any)=>r.currentUser.id=id(99),(r:any)=>r.currentUser.api_key_id=id(9),(r:any)=>r.params={channelId:'bad'},(r:any)=>r.query={extra:1}];
test('routes remain absent without an explicitly constructed stock lane',()=>{assert.equal(fixture({absent:true}).routes.size,0);assert.equal(fixture().routes.size,4);});
test('status and preview are native-session reads (also readonly/stopped) bound to the session actor and channel',async()=>{
 const f=fixture({readOnly:true,running:false}),r=f.req();const status=await f.invoke('GET',base,r);
 assert.equal(status.scope,'selected_local_stock');assert.equal(status.provider_verified,false);assert.equal(status.processor_running,false);assert.equal(status.reconciliation_required,true);
 assert.equal((await f.invoke('GET',base+'/reconciliation-preview',r)).status,'LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW');
 assert.equal((await f.invoke('POST',base+'/reconcile/observe',r)).status,'RECONCILE_RESULT_UNKNOWN');
 assert.deepEqual(f.calls,[['status',r.actor,id(3)],['preview',r.actor,id(3)],['observe',r.actor,id(3),body]]);
});
test('reconcile delegates the unchanged confirmed command once; a core refusal propagates without route retry',async()=>{
 const f=fixture(),r=f.req();assert.equal((await f.invoke('POST',base+'/reconcile',r)).status,'LOCAL_WOO_STOCK_DISPATCH_RECONCILED');assert.deepEqual(f.calls,[['reconcile',r.actor,id(3),body]]);
 const e=new Problem(409,'Stan WooCommerce zmienił się od podglądu');f.state.failure=e;await assert.rejects(f.invoke('POST',base+'/reconcile',r),x=>x===e);assert.equal(f.calls.length,2);
});
test('readonly refuses reconcile before core; untrusted principals and malformed route/query never reach core',async()=>{
 const ro=fixture({readOnly:true});await assert.rejects(ro.invoke('POST',base+'/reconcile'),(e:any)=>e.status===423);assert.equal(ro.calls.length,0);
 for(const [method,path] of [['GET',base],['GET',base+'/reconciliation-preview'],['POST',base+'/reconcile'],['POST',base+'/reconcile/observe']])for(const mutate of untrusted){const f=fixture(),r=f.req();mutate(r);await assert.rejects(f.invoke(method,path,r));assert.equal(f.calls.length,0,method+' '+path);}
});
