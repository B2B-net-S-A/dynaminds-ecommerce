import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticStockObservationMatches,observedOfferTransport} from '../server/local-woo-observed-lineage';
import type {Transport} from '../server/integrations';

function fixture(){
 const config={tenantId:'own-tenant',userId:'own-admin',channelId:'own-store'};
 const plan={id:'plan',listing_id:'listing',product_id:'product',warehouse_id:'warehouse'},original={id:'original'};
 const action={type:'sync_local_woo_stock',channel_id:config.channelId,warehouse_id:plan.warehouse_id,channel_hash:'a'.repeat(64)};
 const payload={run_id:'run',action_index:1,order_id:'order',owner_id:config.userId,listing_id:plan.listing_id,product_id:plan.product_id,action,effect_plan_id:plan.id,effect_job_id:original.id};
 const parent={id:'parent',tenant_id:config.tenantId,kind:'automation.local_stock',state:'failed',attempts:1,max_attempts:1,lease_token:null,locked_at:null,
  physical_source_matches:true,dedup_key:'automation-stock:run:1:listing',payload,
  source_run:{id:'run',tenant_id:config.tenantId,state:'done',order_id:'order',definition:{actor_id:config.userId,actions:[{type:'set_status',status:'new'},structuredClone(action)]},
   result:{actions:[{}, {stock_sync:{state:'queued',channel_id:config.channelId,job_ids:['parent']}}]}}};
 return{config,plan,original,parent};
}
test('durable failed automatic stock has one exact frozen lineage, including physical order mapping',()=>{
 const f=fixture();assert(automaticStockObservationMatches(f.config,f.plan,f.original,[f.parent]));
 const pinned=fixture();pinned.parent.payload.action={...pinned.parent.payload.action,listing_id:'listing'} as any;
 pinned.parent.source_run.definition.actions[1]=structuredClone(pinned.parent.payload.action);
 assert(automaticStockObservationMatches(pinned.config,pinned.plan,pinned.original,[pinned.parent]));
 assert(!automaticStockObservationMatches(f.config,f.plan,f.original,[]));assert(!automaticStockObservationMatches(f.config,f.plan,f.original,[f.parent,f.parent]));
});
test('foreign, unattempted, still leased, ambiguous and forged automatic origins cannot admit observation',()=>{
 const mutations:((p:any)=>void)[]=[
  p=>p.tenant_id='foreign',p=>p.kind='automation',p=>p.state='running',p=>p.state='pending',p=>p.attempts=0,p=>p.max_attempts=2,
  p=>p.lease_token='still-held',p=>p.locked_at=new Date(),p=>p.physical_source_matches=false,p=>p.dedup_key+='other',
  p=>p.payload.owner_id='foreign',p=>p.payload.effect_job_id='foreign',p=>p.payload.effect_plan_id='foreign',p=>p.payload.product_id='foreign',p=>p.payload.listing_id='foreign',
  p=>p.payload.action_index=-1,p=>p.payload.action_index=0.5,p=>p.payload.action.channel_id='foreign',p=>p.payload.action.warehouse_id='foreign',
  p=>p.payload.action.channel_hash=undefined,p=>p.payload.action.listing_id='foreign',p=>p.payload.extra=true,
  p=>p.source_run.state='queued',p=>p.source_run.id='foreign',p=>p.source_run.tenant_id='foreign',p=>p.source_run.order_id='foreign',
  p=>p.source_run.definition.actor_id='foreign',p=>p.source_run.definition.actions[1].channel_hash='b'.repeat(64),
  p=>p.source_run.result.actions[1].stock_sync.job_ids=[],p=>p.source_run.result.actions[1].stock_sync.job_ids=['parent','parent'],
  p=>p.source_run.result.actions[1].stock_sync.channel_id='foreign',p=>p.source_run.result.actions[1].stock_sync.state='preview',
  p=>{p.payload.action.price=true;p.source_run.definition.actions[1].price=true;},
  p=>p.source_run.result.actions[1].stock_sync.extra=true,
  p=>p.source_run.result.actions[1].stock_sync.job_ids=['parent',...Array.from({length:200},(_,i)=>'other'+i)],
  p=>p.source_run.result.actions[1].stock_sync.job_ids=['parent',42],
 ];
 for(const mutate of mutations){const f=fixture();mutate(f.parent);assert(!automaticStockObservationMatches(f.config,f.plan,f.original,[f.parent]),String(mutate));}
});
test('actual observation wrapper permits one exact GET and refuses every write, store swap, body or second attempt before transport',async()=>{
 const calls:string[]=[],wire:Transport=async(url)=>{calls.push(url);return Response.json({id:17,sku:'SKU',type:'simple'});};
 const read=observedOfferTransport(wire,{id:'17',sku:'SKU'},'https://localhost:8444'),url='https://localhost:8444/wp-json/wc/v3/products/17';
 for(const [u,init] of [[url,{method:'PUT'}],[url,{method:'POST'}],[url,{method:'GET',body:'{}'}],[url.replace('8444','8443'),{}],[url+'?context=edit',{}]] as const)await assert.rejects(()=>read(u,init));
 assert.equal(calls.length,0);assert.equal((await read(url,{})).status,200);assert.equal(calls.length,1);
 await assert.rejects(()=>read(url,{}));assert.equal(calls.length,1);
});
test('unknown observation response, wrong SKU/type/id and network loss never acquire a second GET',async()=>{
 for(const value of [{id:18,sku:'SKU',type:'simple'},{id:17,sku:'other',type:'simple'},{id:17,sku:'SKU',type:'variable'},null,'network']){
  let calls=0;const read=observedOfferTransport(async()=>{calls++;if(value==='network')throw Error('lost response');return value===null?Response.json({}, {status:502}):Response.json(value);},{id:'17',sku:'SKU'},'https://localhost:8443');
  const url='https://localhost:8443/wp-json/wc/v3/products/17';await assert.rejects(()=>read(url,{}));await assert.rejects(()=>read(url,{}));assert.equal(calls,1);
 }
});
