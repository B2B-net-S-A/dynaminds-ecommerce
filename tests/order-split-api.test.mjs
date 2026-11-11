/** Actual browser client + actual workspace transport with controlled HTTP only.
 * Future DTO contract tests, not registered backend/Native or split acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createServer} from 'vite';
const vite = await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
const {createOrderSplitApi} = await vite.ssrLoadModule(path.resolve('web/order-split-api.ts'));
const C = await vite.ssrLoadModule(path.resolve('web/order-split-custody.ts'));
const A = await vite.ssrLoadModule(path.resolve('web/api.ts'));
await vite.close();
const id = n => `${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const actor = id(1)+':'+id(2), copy = v => structuredClone(v);
const source = {id:id(3),version:'7',shipping_cost:50,items:[{id:id(20),quantity:5},{id:id(21),quantity:2}]};
const body = {client_key:id(5),source_order_id:source.id,expected_source_version:'7',children:[
  {slot_id:id(10),name:'Wynik pierwszy',delivery_minor:10,items:[{source_item_id:id(20),quantity:2}]},
  {slot_id:id(11),name:'Wynik drugi',delivery_minor:20,items:[{source_item_id:id(20),quantity:1},{source_item_id:id(21),quantity:1}]},
]};
const identities = [{slot_id:id(10),order_id:id(30)},{slot_id:id(11),order_id:id(31)}];
const serialized = JSON.stringify(body,null,2)+'\n';
const preview = {schema:'order-split-custody/v1',actor,kind:'preview',serialized,source};
const execute = {...preview,kind:'execute',serialized:JSON.stringify({client_key:id(6),preview_id:id(40),scope_hash:'a'.repeat(64),confirmed:true}),preview:{id:id(40),scope_hash:'a'.repeat(64),serialized,children:identities}};
const json = (v,status=200) => new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
function mutex(){const held=new Set();return {async request(name,opts,fn){assert.deepEqual(opts,{mode:'exclusive',ifAvailable:true});if(held.has(name))return fn(null);held.add(name);try{return await fn({name});}finally{held.delete(name);}}};}
function outcome(intent){
 const execution=intent.kind==='execute';
 const h={id:execution?id(41):id(40),source_order_id:source.id,source_version:'7',source_result_version:execution?'8':'7',scope_hash:'a'.repeat(64),children:copy(identities),...(execution?{preview_id:id(40),state:'done'}:{ready:true})};
 return {head:h,command:{tenant_id:id(1),actor_id:id(2),api_key_id:null,operation:intent.kind,client_key:JSON.parse(intent.serialized).client_key,request:JSON.parse(intent.serialized),[execution?'execution':'preview']:h},
 source:{order_id:source.id,version:execution?'8':'7',item_count:2,shipping_cost:20},
 sourceRows:[{source_item_id:id(20),before_quantity:5,remaining_quantity:2},{source_item_id:id(21),before_quantity:2,remaining_quantity:1}],
 children:body.children.map((c,i)=>({...identities[i],delivery_minor:c.delivery_minor,items:copy(c.items)}))};
}
function setup(intent=preview,hook=()=>{},options={}){
 const old={fetch:globalThis.fetch,storage:Object.getOwnPropertyDescriptor(globalThis,'localStorage'),navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator')};
 const map=new Map(),store={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const locks=options.locks??mutex();
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:options.store??store});
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks}});
 A.setWorkspace(id(1));
 const controller=new AbortController(),calls=[],o=outcome(intent);
 const auth={tenant_id:id(1),user_id:id(2),role:'operator',readOnly:false,signal:controller.signal,...options.authority};
 let meReads=0;
 globalThis.fetch=async(url,init)=>{
  const u=new URL(url,'http://local.test'),entry={path:u.pathname,query:u.search,method:init.method,body:init.body,headers:init.headers,signal:init.signal,credentials:init.credentials};calls.push(entry);
  const custom=await hook(entry,{o,store,map,controller,calls,get meReads(){return meReads;}});if(custom)return custom;
  if(u.pathname==='/api/health')return json({order_splits_available:true,restore_preview:false});
  if(u.pathname==='/api/auth/me'){meReads++;return json({user:{tenant_id:id(1),id:id(2),role:'operator'},restore_preview:false});}
  if(init.method==='POST'){assert.equal(store.getItem(C.splitIntentKey(actor)),JSON.stringify(intent));assert.deepEqual(JSON.parse(init.body),JSON.parse(intent.serialized));return json(o.head,201);}
  if(u.pathname.includes('/commands/'))return json(o.command);
  if(u.pathname.endsWith('/source'))return json(o.source);
  const child=u.pathname.endsWith('/children'),rows=child?o.children:o.sourceRows;
  assert.ok(child||u.pathname.endsWith('/source-items'));
  const cursor=u.searchParams.get('cursor');assert.ok(cursor===null||cursor==='next cursor/+');
  return json({data:[rows[cursor===null?0:1]],meta:{total:2,cursor:cursor===null?'next cursor/+':null}});
 };
 return {store,map,calls,o,controller,client:createOrderSplitApi(auth),restore(){globalThis.fetch=old.fetch;for(const key of ['localStorage','navigator']){const d=key==='localStorage'?old.storage:old.navigator;if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}A.setWorkspace(null);}};
}

test('preview and execute use shared transport, durable original logical body/key, full pages and late actual authority',async()=>{
 for(const intent of [preview,execute]){const f=setup(intent);try{
  assert.deepEqual(await f.client.submit(intent),f.o.head);assert.equal(f.store.getItem(C.splitIntentKey(actor)),null);
  const writes=f.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/order-splits/'+(intent.kind==='preview'?'previews':'executions'));
  assert.deepEqual(JSON.parse(writes[0].body),JSON.parse(intent.serialized));assert.equal(f.calls.filter(c=>c.path==='/api/auth/me').length,2);
  for(const c of f.calls){assert.equal(c.credentials,'same-origin');assert.equal(c.signal,f.controller.signal);if(c.path!=='/api/health')assert.equal(c.headers['X-Workspace-ID'],id(1));}
  assert.ok(f.calls.some(c=>c.query==='?cursor=next%20cursor%2F%2B'));
 }finally{f.restore();}}
});
test('lost POST ACK remains held across a new client; explicit recovery performs GETs only',async()=>{
 let lost=true;const f=setup(preview,c=>{if(c.method==='POST'&&lost){lost=false;throw Error('lost ACK secret must not propagate');}});try{
  await assert.rejects(f.client.submit(preview),e=>!e.message.includes('secret'));
  assert.equal(C.readSplitIntent(f.store,actor).serialized,serialized);
  await assert.rejects(f.client.submit({...preview,serialized:JSON.stringify({...body,client_key:id(99)})}));assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  const count=f.calls.length;const next=createOrderSplitApi({tenant_id:id(1),user_id:id(2),role:'operator',readOnly:false,signal:f.controller.signal});
  assert.deepEqual(await next.recover(),f.o.head);assert.ok(f.calls.slice(count).every(c=>c.method==='GET'));assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 }finally{f.restore();}
});
test('404 lookup, invalid JSON and malformed successful ACK retain the original key with no retry',async()=>{
 for(const fault of ['404','invalid-json','non-json','private-plan','wrong-ack']){
  const f=setup(preview,(c,{o})=>{
   if(fault==='404'&&c.path.includes('/commands/'))return json({code:'NOT_FOUND'},404);
   if(c.method==='POST'){
    if(fault==='invalid-json')return new Response('{broken',{status:201,headers:{'Content-Type':'application/json'}});
    if(fault==='non-json')return new Response('not json',{status:201});
    if(fault==='private-plan')return json({...o.head,plan:{private_data:'never return'}} ,201);
    if(fault==='wrong-ack')return json({...o.head,id:id(99)},201);
   }
  });try{await assert.rejects(f.client.submit(preview));assert.deepEqual(C.readSplitIntent(f.store,actor),preview);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);}finally{f.restore();}
 }
});
test('foreign tenant/actor/key/body, swapped child bindings or private extra fields never clear custody',async()=>{
 const mutations=[o=>o.command.tenant_id=id(99),o=>o.command.actor_id=id(99),o=>o.command.api_key_id=id(99),o=>o.command.client_key=id(99),o=>o.command.request.children[0].delivery_minor=11,o=>o.command.portal_token='secret',o=>o.head.scope_hash='invalid',o=>o.head.children[0].order_id=id(99)];
 for(const mutate of mutations){const f=setup(preview);mutate(f.o);try{await assert.rejects(f.client.submit(preview));assert.deepEqual(C.readSplitIntent(f.store,actor),preview);}finally{f.restore();}}
});
test('partial pages, cursor loop, duplicate row, remaining quantity and delivery drift stay held',async()=>{
 for(const fault of ['partial','loop','duplicate','quantity','shipping','child','extra','wrong-total']){
  const f=setup(preview,(c,{o})=>{
   if(c.path.endsWith('/source-items')){
    if(fault==='partial')return json({data:[o.sourceRows[0]],meta:{total:2,cursor:null}});
    if(fault==='loop')return json({data:[o.sourceRows[0]],meta:{total:2,cursor:'same'}});
    if(fault==='duplicate')return json({data:[o.sourceRows[0],o.sourceRows[0]],meta:{total:2,cursor:null}});
    if(fault==='wrong-total')return json({data:o.sourceRows,meta:{total:3,cursor:null}});
   }
  });
  if(fault==='quantity')f.o.sourceRows[0].remaining_quantity++;
  if(fault==='shipping')f.o.source.shipping_cost++;
  if(fault==='child')f.o.children[0].items[0].quantity++;
  if(fault==='extra')f.o.children[0].address={secret:'excluded'};
  try{await assert.rejects(f.client.submit(preview));assert.deepEqual(C.readSplitIntent(f.store,actor),preview);assert.ok(f.calls.length<12);}finally{f.restore();}
 }
});
test('fresh readiness/me fail closed on old server, restore, role, tenant or user before any POST',async()=>{
 for(const fault of ['old','restore-health','restore-me','role','tenant','user']){
  const f=setup(preview,(c)=>{
   if(c.path==='/api/health'&&fault==='old')return json({restore_preview:false});
   if(c.path==='/api/health'&&fault==='restore-health')return json({order_splits_available:true,restore_preview:true});
   if(c.path==='/api/auth/me')return json({user:{tenant_id:fault==='tenant'?id(99):id(1),id:fault==='user'?id(99):id(2),role:fault==='role'?'viewer':'operator'},restore_preview:fault==='restore-me'});
  });try{await assert.rejects(f.client.submit(preview));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(C.readSplitIntent(f.store,actor),null);}finally{f.restore();}
 }
});
test('late role/revoke/restore/readiness change after all result reads keeps original custody',async()=>{
 for(const fault of ['role','restore','disabled','revoked']){
  let health=0,me=0;const f=setup(preview,c=>{
   if(c.path==='/api/health'&&++health===2)return json({order_splits_available:fault!=='disabled',restore_preview:fault==='restore'});
   if(c.path==='/api/auth/me'&&++me===2){if(fault==='revoked')return json({code:'DENIED'},403);return json({user:{tenant_id:id(1),id:id(2),role:fault==='role'?'viewer':'operator'},restore_preview:false});}
  });try{await assert.rejects(f.client.submit(preview));assert.deepEqual(C.readSplitIntent(f.store,actor),preview);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);}finally{f.restore();}
 }
});
test('actual shared workspace epoch rejects an in-flight switch even when workspace changes back',async()=>{
 const f=setup(preview,(c)=>{if(c.path.includes('/commands/')){A.setWorkspace(id(99));A.setWorkspace(id(1));}});try{
  await assert.rejects(f.client.submit(preview));assert.deepEqual(C.readSplitIntent(f.store,actor),preview);assert.ok(!f.calls.some(c=>c.path.endsWith('/source')));
 }finally{f.restore();}
});
test('wrong active workspace, abort before dispatch and abort after result prevent POST or clearing',async()=>{
 for(const fault of ['workspace','early-abort','late-abort']){
  const f=setup(preview,(c,{controller})=>{if(fault==='late-abort'&&c.path.endsWith('/children')&&c.query)controller.abort();});
  if(fault==='workspace')A.setWorkspace(id(99));if(fault==='early-abort')f.controller.abort();
  try{await assert.rejects(f.client.submit(preview));if(fault==='late-abort')assert.deepEqual(C.readSplitIntent(f.store,actor),preview);else{assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(C.readSplitIntent(f.store,actor),null);}}finally{f.restore();}
 }
});
test('unsupported/busy actor lock, readOnly and failed durable storage refuse without mutation',async()=>{
 for(const fault of ['no-lock','busy','readonly','quota']){
  const options=fault==='no-lock'?{locks:{}}:fault==='busy'?{locks:{request:async(_n,_o,fn)=>fn(null)}}:fault==='readonly'?{authority:{readOnly:true}}:{store:{getItem:()=>null,setItem(){throw Error('quota');},removeItem(){throw Error('must not clear');}}};
  const f=setup(preview,()=>{},options);try{await assert.rejects(f.client.submit(preview));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);}finally{f.restore();}
 }
});
test('two cooperating clients serialize the entire write/readback and preserve held A after lost ACK',async()=>{
 let release;const wait=new Promise(resolve=>release=resolve);let entered;const started=new Promise(resolve=>entered=resolve);
 const f=setup(preview,async c=>{if(c.method==='POST'){entered();await wait;throw Error('ACK lost');}});try{
  const first=f.client.submit(preview);await started;
  const second=createOrderSplitApi({tenant_id:id(1),user_id:id(2),role:'operator',readOnly:false,signal:f.controller.signal});
  const other={...preview,serialized:JSON.stringify({...body,client_key:id(99)})};
  await assert.rejects(second.submit(other));assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(C.readSplitIntent(f.store,actor).serialized,serialized);
  release();await assert.rejects(first);await assert.rejects(second.submit(other));assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(C.readSplitIntent(f.store,actor).serialized,serialized);
 }finally{release();f.restore();}
});
test('foreign intent and recovering without held custody are local refusals; reordered ACK object is accepted',async()=>{
 const f=setup(preview,c=>{if(c.method==='POST'){const h=outcome(preview).head;return json(Object.fromEntries(Object.entries(h).reverse()),201);}});try{
  await assert.rejects(f.client.submit({...preview,actor:id(99)+':'+id(2)}));await assert.rejects(f.client.recover());assert.equal(f.calls.length,0);
  assert.deepEqual(await f.client.submit(preview),f.o.head);
 }finally{f.restore();}
});
test('verified persistence is synchronous, frozen and precedes custody clear; quota/async/late IAM failures preserve pending',async()=>{
 for(const kind of ['quota','promise','late-role','ok']){
  let me=0,persisted=0;const f=setup(preview,c=>{if(c.path==='/api/auth/me'&&++me===2&&kind==='late-role')return json({user:{tenant_id:id(1),id:id(2),role:'viewer'},restore_preview:false});});
  const persist=h=>{persisted++;assert.equal(Object.isFrozen(h),true);assert.equal(Object.isFrozen(h.children[0]),true);assert.deepEqual(C.readSplitIntent(f.store,actor),preview);if(kind==='quota')throw Error('quota');if(kind==='promise')return Promise.reject(Error('unsupported async persistence'));};
  try{if(kind==='ok'){await f.client.submit(preview,persist);assert.equal(C.readSplitIntent(f.store,actor),null);}else{await assert.rejects(f.client.submit(preview,persist));assert.deepEqual(C.readSplitIntent(f.store,actor),preview);}assert.equal(persisted,1);}finally{f.restore();}
 }
});
const reviewBasis={currency:'PLN',shipping_cost:50,items:[{id:id(20),name:'Produkt A',sku:'SKU-A',quantity:5,price:100,line_total:500},{id:id(21),name:'Produkt B',sku:'SKU-B',quantity:2,price:100,line_total:200}]};
function reviewDto(){
 let serial=60;
 const item=(sourceId,q,retained=false)=>{const s=reviewBasis.items.find(i=>i.id===sourceId);return {source_item_id:sourceId,target_item_id:retained?sourceId:id(serial++),product_id:sourceId===id(20)?id(80):id(81),name:s.name,sku:s.sku,quantity:q,price:100,vat:0,gross_minor:q*100,net_minor:q*100,vat_minor:0,price_adjustment_minor:0,original_quantity:s.quantity,original_gross_minor:s.line_total,original_net_minor:s.line_total,original_vat_minor:0};};
 const result=(slot,order,name,delivery,items)=>({kind:slot===null?'retained_source':'child',slot_id:slot,order_id:order,name,items,items_gross_minor:items.reduce((n,i)=>n+i.gross_minor,0),items_net_minor:items.reduce((n,i)=>n+i.net_minor,0),items_vat_minor:0,delivery_minor:delivery,total_minor:items.reduce((n,i)=>n+i.gross_minor,delivery)});
 return {schema:'order-split-commercial-review/v1',currency:'PLN',ready:true,shipping_tax:'not_allocated',conflicts:[],original:{items_gross_minor:700,items_net_minor:700,items_vat_minor:0,delivery_minor:50,total_minor:750},results:[result(id(10),id(30),body.children[0].name,10,[item(id(20),2)]),result(id(11),id(31),body.children[1].name,20,[item(id(20),1),item(id(21),1)]),result(null,source.id,null,20,[item(id(20),2,true),item(id(21),1,true)])]};
}
test('completed preview commercial read is GET-only and conserves exact source prices/GNV/shipping; private/drift fields refuse',async()=>{
 for(const change of [null,v=>v.results[0].items[0].price++,v=>v.results[0].items[0].name='foreign',v=>v.results[0].items[0].net_minor++,v=>v.results[0].delivery_minor++,v=>v.results[0].order_id=id(99),v=>v.original.items_vat_minor++,v=>v.results[0].items[0].portal_token='PRIVATE',v=>v.plan={private:'PRIVATE'},v=>v.results.pop()]){
  const dto=reviewDto();if(change)change(dto);
  const f=setup(preview,c=>c.path.endsWith('/commercial')?json(dto):undefined);
  try{if(change)await assert.rejects(f.client.reviewPreview(preview,reviewBasis));else{const r=await f.client.reviewPreview(preview,reviewBasis);assert.equal(r.commercial.original.total_minor,750);assert.equal(Object.isFrozen(r.commercial.results[0].items[0]),true);}assert.ok(f.calls.every(c=>c.method==='GET'));assert.equal(C.readSplitIntent(f.store,actor),null);}finally{f.restore();}
 }
});
test('readonly completed inspection never clears a pending command or writes; recovery persistence remains explicit',async()=>{
 const f=setup(preview,()=>{}, {authority:{readOnly:true}});try{assert.deepEqual(await f.client.inspect(preview),f.o.head);C.retainSplitIntent(f.store,preview);await assert.rejects(f.client.inspect(preview));await assert.rejects(f.client.recover());assert.deepEqual(C.readSplitIntent(f.store,actor),preview);assert.ok(f.calls.every(c=>c.method==='GET'));}finally{f.restore();}
});
test('commercial review refuses a cent shifted between results even when all source sums and arithmetic still balance',async()=>{
 const dto=reviewDto();
 for(const [index,delta] of [[0,1],[1,-1]]){const r=dto.results[index],a=r.items.find(i=>i.source_item_id===id(20));a.gross_minor+=delta;a.net_minor+=delta;a.price_adjustment_minor+=delta;r.items_gross_minor+=delta;r.items_net_minor+=delta;r.total_minor+=delta;}
 const f=setup(preview,c=>c.path.endsWith('/commercial')?json(dto):undefined);
 try{await assert.rejects(f.client.reviewPreview(preview,reviewBasis));assert.ok(f.calls.every(c=>c.method==='GET'));assert.equal(C.readSplitIntent(f.store,actor),null);}finally{f.restore();}
});
