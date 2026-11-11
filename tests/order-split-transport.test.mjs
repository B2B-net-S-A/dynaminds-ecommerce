/** Actual exports + controlled ordinary SQL query port. No PG, HTTP, private
 * managed-lease mint, Native execution, commit or activation acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer,transformWithOxc} from 'vite';
import path from 'node:path';
const dbSource=readFileSync(new URL('../server/db.ts',import.meta.url),'utf8');
const managerStart=dbSource.indexOf('export async function tenantTx<'),managerEnd=dbSource.indexOf('\nexport async function migrate()',managerStart);
assert(managerStart>=0&&managerEnd>managerStart);
const tenantJs=(await transformWithOxc(dbSource.slice(managerStart,managerEnd),'actual-tenant-manager.ts')).code.replace(/^export /,'');
const virtualDb='\0controlled-order-split-db';
const vite=await createServer({plugins:[{name:'controlled-split-db',enforce:'pre',transform(source,id){if(id.endsWith('/server/order-split-transport.ts')){assert.equal(source.split("import('./db')").length-1,4);return source.replaceAll("import('./db')","import('virtual:controlled-split-db')");}},resolveId(id){if(id==='virtual:controlled-split-db')return virtualDb;},load(id){if(id.endsWith('/server/db.ts'))throw Error('Real DB import prohibited in controlled split test');if(id===virtualDb)return `let port=()=>{throw Error('Unconfigured controlled DB port')};export const setTenantTx=v=>{port=v};export const tenantTx=(...args)=>port(...args);export const localConfig={encryptionKey:'x'.repeat(64)};`;}}],server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
const T=await vite.ssrLoadModule(path.resolve('server/order-split-transport.ts'));
const R=await vite.ssrLoadModule(path.resolve('server/order-split-transaction.ts'));
const DB=await vite.ssrLoadModule('virtual:controlled-split-db');
const {drainPublicConstraintsInTx}=await vite.ssrLoadModule(path.resolve('server/public-constraint-drain.ts'));
test.after(()=>vite.close());
const managedClients=new Set();
test.afterEach(()=>{DB.setTenantTx(()=>{throw Error('Unconfigured controlled DB port')});for(const c of managedClients)R.endOrderSplitTransaction(c);managedClients.clear();});
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`,copy=v=>structuredClone(v),secret='s'.repeat(64),rawSession='PRIVATE_BROWSER_SESSION';
const digest=v=>createHash('sha256').update(v).digest('hex');
function generated(seed,label){const h=digest('order.split210:'+seed+':'+label);return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function capture(overrides={},options={readOnly:false}){
 const req={actor:{tenantId:id(1),userId:id(2),role:'operator',source:'manual'},currentUser:{id:id(2),tenant_id:id(1),role:'operator'},headers:{'x-workspace-id':id(1)},cookies:{dyna_session_preview_4103:rawSession},...overrides};
 return T.captureOrderSplitRequest(req,'dyna_session_preview_4103',options);
}
function saved(){
 const tenant=id(1),source=id(3),item=id(4),product=id(5),pid=id(10),eid=id(11),slots=[id(12),id(13)];
 const original={id:item,tenant_id:tenant,order_id:source,product_id:product,name:'Produkt historyczny',sku:'HIST',quantity:3,price:123,vat:23,line_total:369,product_kind:'simple'};
 const order={id:source,tenant_id:tenant,version:7,currency:'PLN',shipping_cost:1,total:370,customer_name:'PRIVATE_CUSTOMER',address:{street:'PRIVATE_ADDRESS'},portal_token:'PRIVATE_PORTAL'};
 const request={client_key:id(20),source_order_id:source,expected_source_version:'7',children:slots.map((s,i)=>({slot_id:s,name:'Paczka '+i,delivery_minor:i===0?1:0,items:[{source_item_id:item,quantity:1}]}))};
 const results=[0,1,2].map(index=>{const retained=index===2,slot=retained?null:slots[index],oid=retained?source:generated(pid,'order:'+slot);return {kind:retained?'retained_source':'child',slot_id:slot,order_id:oid,name:retained?null:request.children[index].name,delivery_minor:index===0?1:0,result_index:index,items:[{source_item_id:item,target_item_id:retained?item:generated(pid,'item:'+slot+':'+item),product_id:product,quantity:1,price:123,vat:23,from_quantity:index,to_quantity:index+1,gross_minor:123,net_minor:100,vat_minor:23,price_adjustment_minor:0,original_quantity:3,original_price:123,original_gross_minor:369,original_net_minor:300,original_vat_minor:69}],items_gross_minor:123,items_net_minor:100,items_vat_minor:23,total_minor:index===0?124:123};});
 const snapshot={order,items:[original],custody:{private_cost:'PRIVATE_COST'},wms_enabled:false,layer_metadata:[]};
 const preview={tenant_id:tenant,id:pid,actor_id:id(2),api_key_id:null,client_key:request.client_key,request,source_order_id:source,source_version:'7',scope_hash:'a'.repeat(64),snapshot,plan:{schema:'order-split210-commercial-plan/v1',ready:true,conflicts:[],results,shipping_tax:'not_allocated',custody:{private_cost:'PRIVATE_PLAN_COST'}}};
 const execution={tenant_id:tenant,id:eid,preview_id:pid,actor_id:id(2),api_key_id:null,client_key:id(21),request:{client_key:id(21),preview_id:pid,scope_hash:preview.scope_hash,confirmed:true},source_order_id:source,source_version:'7',result_source_version:'8',scope_hash:preview.scope_hash,before_frame:copy(snapshot),after_frame:{orders:results.map(r=>({...copy(order),id:r.order_id,version:r.slot_id===null?8:1,total:r.total_minor,shipping_cost:r.delivery_minor})),items:results.map(r=>{const {product_kind,...base}=copy(original);return {...base,id:r.items[0].target_item_id,order_id:r.order_id,quantity:1,line_total:123};}),custody:{private_cost:'PRIVATE_AFTER_COST'}}};
 const source_rows=[{tenant_id:tenant,preview_id:pid,source_item_id:item,source_order_id:source,row_data:copy(original)}];
 const targets=results.map(r=>({tenant_id:tenant,execution_id:eid,preview_id:pid,result_index:r.result_index,slot_id:r.slot_id,order_id:r.order_id,source_order_id:source,name:r.name,delivery_minor:r.delivery_minor,total_minor:r.total_minor}));
 const allocations=results.flatMap(r=>r.items.map(a=>({tenant_id:tenant,execution_id:eid,preview_id:pid,result_index:r.result_index,source_item_id:a.source_item_id,target_item_id:a.target_item_id,product_id:a.product_id,quantity:a.quantity,from_quantity:a.from_quantity,to_quantity:a.to_quantity,gross_minor:a.gross_minor,net_minor:a.net_minor,vat_minor:a.vat_minor,payload:copy(a)})));
 return{preview,execution,source_rows,targets,allocations};
}
function model(options={}){
 const f=saved(),calls=[];let role=options.managedRoot?'postgres':'dyna_app',tenant=id(1),identities=0,contexts=0,finalized=false;const frame={owner:'postgres',root:'100',started:'2026-10-18 00:00:00+00',pid:'55',read_only:'off'};
 const response=rows=>({rows:copy(rows),rowCount:rows.length});
 const c={release(){assert.equal(R.hasOrderSplitTransactionDuty(c),false);calls.push({sql:'POOL_RELEASE',args:[],role});},async query(sql,args=[]){
  calls.push({sql,args:copy(args),role});
  if(options.managedRoot){
   if(sql==='BEGIN'||sql==='ROLLBACK'||sql.startsWith('SET LOCAL statement_timeout'))return response([]);
   if(sql==='COMMIT'){assert(R.hasOrderSplitTransactionDuty(c));if(options.commitLost)throw Error('ACK_LOST');return response([]);}
   if(sql.includes('FROM pg_catalog.pg_constraint'))return response([{schema_name:'public',constraint_name:'order_split210_complete'}]);
   if(sql.startsWith('SET CONSTRAINTS')){if(options.drainError)throw Error('DRAIN_DENIED');return response([]);}
  }
  if(sql.includes('split210:context')){contexts++;return response([{...frame,role,tenant,...options.context,...(options.lateRoot&&contexts>1?{root:'101'}:{})}]);}
  if(sql.includes('buyer_address_identity(')){assert(!options.forbidPostFinalIAM||!finalized,'No waitful IAM read may follow the Native final clock');identities++;if(options.identityError){const e=Error('PRIVATE_CREDENTIAL');e.code='28000';throw e;}return response([{proof:{role:'operator',account_version:options.lateIdentity&&identities>1?'2':'1',policy:null}}]);}
  if(sql.includes('pg_get_userbyid(relowner)'))return response([{role,owner:'postgres',tenant,root:frame.root,started:frame.started,relation_owner:'postgres'}]);
  if(sql==='RESET ROLE'){role='postgres';return response([]);}
  if(sql.startsWith("SELECT set_config('app.tenant_id'")){tenant=args[0];return response([]);}
  if(sql==='SET LOCAL ROLE dyna_app'){role='dyna_app';return response([]);}
  assert.equal(role,'postgres','Native/private row queries must stay inside owner wrapper');
  if(sql.includes('order_split210_finalize(')){
   if(options.finalizerError){const e=Error('PRIVATE_FINALIZER');e.code=options.finalizerError;throw e;}
   finalized=true;
   return response([{order_split210_finalize:''}]);
  }
  if(sql.includes('order_split210_preview(')||sql.includes('order_split210_execute(')){
   if(options.nativeError){const e=Error('PRIVATE_NATIVE_ERROR');e.code=options.nativeError;throw e;}
   const execute=sql.includes('order_split210_execute('),r=execute?f.execution:f.preview;
   const result={id:r.id,source_order_id:r.source_order_id,source_version:r.source_version,scope_hash:r.scope_hash,replayed:!!options.replayed,...(execute?{preview_id:r.preview_id,source_result_version:r.result_source_version,state:'done',children:f.targets.filter(t=>t.slot_id).map(t=>({slot_id:t.slot_id,order_id:t.order_id}))}:{plan:copy(r.plan),expires_at:'2026-10-18T00:15:00Z'})};
   if(options.ackDrift)result.id=id(99);return response([{result}]);
  }
  if(sql.includes('split210:record')){
   const r=sql.includes('order_split210_executions')?f.execution:f.preview,field=sql.includes('client_key=$3')?'client_key':'id';
   const visible=!options.missing&&r.tenant_id===args[0]&&r.actor_id===args[1]&&r.api_key_id===null&&r[field]===args[2];
   if(sql.includes('record-bound'))return response([{count:visible?'1':'0',bytes:String(Buffer.byteLength(JSON.stringify(r)))}]);
   return response(visible?[r]:[]);
  }
  if(sql.includes('split210:rows')){
   const key=sql.includes('order_split210_source_rows')?'source_rows':sql.includes('order_split210_targets')?'targets':'allocations',rows=f[key];
   if(sql.includes('rows-bound'))return response([{count:String(rows.length),bytes:options.oversized?'999999999':String(Buffer.byteLength(JSON.stringify(rows)))}]);
   return response(options.partial?rows.slice(0,-1):rows);
  }
  if(sql.includes('order_split210_terminal(')){if(options.terminalError){const e=Error('PRIVATE_TERMINAL');e.code='23514';throw e;}return response([]);}
  throw Error('Unexpected controlled query: '+sql);
 }};
 // Controlled manager lifecycle, not a genuine DB lease or commit proof.
 if(!options.unmanaged){R.beginOrderSplitTransaction(c);managedClients.add(c);}
 return{f,c,calls,get role(){return role;}};
}
const writes=m=>m.calls.filter(c=>/order_split210_(preview|execute)\(/.test(c.sql));
const read=(m,a,view='command',extra={})=>T.readOrderSplitInTx(m.c,a,view==='command'?{operation:'preview',client_key:m.f.preview.client_key,view}:{operation:'preview',id:m.f.preview.id,view,...extra},secret);

test('actual preview/execute exports invoke real Native210 function names/credential args once, then original saved readback',async()=>{
 for(const op of ['preview','execute']){
  const m=model(),a=capture(),row=m.f[op==='preview'?'preview':'execution'];
  const result=await(op==='preview'?T.invokeOrderSplitPreviewInTx:T.invokeOrderSplitExecuteInTx)(m.c,a,row.request);
  assert.equal(result.id,row.id);assert.equal(writes(m).length,1);assert.deepEqual(writes(m)[0].args,[row.request,id(2),null,digest(rawSession),'operator']);assert.equal(writes(m)[0].role,'postgres');
  assert.ok(m.calls.some(c=>c.sql.includes('client_key=$3')));assert.equal(m.role,'dyna_app');
  const identities=m.calls.filter(c=>c.sql.includes('buyer_address_identity('));assert.deepEqual(identities.map(c=>c.args.at(-1)),[true,false]);assert.ok(identities.every(c=>c.args[3]!==rawSession));
  assert.equal(m.calls.filter(c=>c.sql.includes('order_split210_terminal(')).length,op==='execute'?1:0);
  const encoded=JSON.stringify(result);assert.equal(encoded.includes('PRIVATE_'),false);assert.equal(encoded.includes('plan'),false);
 }
});
test('capture is browser-session bound; copied/forged/foreign request context cannot invoke a query',async()=>{
 for(const req of [{actor:{tenantId:id(1),userId:id(2),role:'operator',apiKeyId:id(99)}},{currentUser:{id:id(99),tenant_id:id(1),role:'operator'}},{headers:{'x-workspace-id':id(99)}},{cookies:{}},{cookies:{dyna_session_preview_4103:'dyna_api_'+'a'.repeat(64)}}])assert.throws(()=>capture(req));
 const m=model(),a=capture();assert.equal(JSON.stringify(a).includes(rawSession),false);assert.equal(Object.hasOwn(a,'hash'),false);
 for(const fake of [{...a},JSON.parse(JSON.stringify(a)),{tenantId:id(1),userId:id(2),role:'operator',readOnly:false}]){await assert.rejects(T.invokeOrderSplitPreviewInTx(m.c,fake,m.f.preview.request));assert.equal(m.calls.length,0);}
});
test('wrong tenant/root role, readonly and current IAM expiry refuse before Native call',async()=>{
 for(const options of [{context:{tenant:id(99)}},{context:{role:'postgres'}},{context:{read_only:'on'}},{identityError:true}]){
  const m=model(options),a=capture();await assert.rejects(T.invokeOrderSplitPreviewInTx(m.c,a,m.f.preview.request));assert.equal(writes(m).length,0);assert.equal(m.role,'dyna_app');
 }
 const m=model(),a=capture({}, {readOnly:true});await assert.rejects(T.invokeOrderSplitExecuteInTx(m.c,a,m.f.execution.request));assert.equal(m.calls.length,0);
});
test('immutable original lookup returns exact safe command/head/source/commercial DTO, never current order or private records',async()=>{
 const m=model(),a=capture();const command=await read(m,a),head=await read(m,a,'head'),source=await read(m,a,'source'),commercial=await read(m,a,'commercial');
 assert.deepEqual(command.request,m.f.preview.request);assert.equal(command.actor_id,id(2));assert.equal(head.id,m.f.preview.id);assert.deepEqual(source,{order_id:id(3),version:'7',item_count:1,shipping_cost:0});assert.equal(commercial.original.total_minor,370);
 assert.equal(JSON.stringify({command,head,source,commercial}).includes('PRIVATE_'),false);assert.equal(writes(m).length,0);assert.ok(m.calls.every(c=>!/^\s*(INSERT|UPDATE|DELETE|BEGIN|COMMIT)/i.test(c.sql)));assert.ok(m.calls.every(c=>!c.sql.includes('FROM public.orders WHERE')));assert.equal(m.role,'dyna_app');
 const exec=await T.readOrderSplitInTx(m.c,a,{operation:'execute',client_key:m.f.execution.client_key,view:'command'},secret);assert.equal(exec.execution.state,'done');assert.equal(exec.execution.source_result_version,'8');assert.equal(writes(m).length,0);
});
test('404 original command stays 404; missing/partial/oversized/foreign archived data never become successful readback',async()=>{
 for(const options of [{missing:true},{partial:true},{oversized:true}]){const m=model(options),a=capture();await assert.rejects(read(m,a),e=>options.missing?e.status===404:true);assert.equal(m.role,'dyna_app');assert.equal(writes(m).length,0);}
 const mutations=[m=>m.f.source_rows[0].preview_id=id(99),m=>m.f.targets[0].order_id=id(99),m=>m.f.allocations[0].quantity=2,m=>m.f.execution.after_frame.orders[0].total++];
 for(const mutate of mutations){const m=model(),a=capture();mutate(m);await assert.rejects(T.readOrderSplitInTx(m.c,a,{operation:'execute',client_key:m.f.execution.client_key,view:'command'},secret));assert.equal(m.role,'dyna_app');}
});
test('new cross-operator lineage access does not broaden original actor-only command or head recovery',async()=>{
 for(const view of ['command','head']){const m=model(),a=capture({actor:{tenantId:id(1),userId:id(99),role:'operator',source:'manual'},currentUser:{id:id(99),tenant_id:id(1),role:'operator'}});await assert.rejects(read(m,a,view),e=>e.status===404);assert.equal(m.role,'dyna_app');assert(m.calls.some(row=>row.sql.includes('record-bound')&&row.sql.includes('actor_id=$2')&&row.args[1]===id(99)));assert.equal(writes(m).length,0);}
});
test('saved-result pagination uses real signed cursor protocol and binds actor/role/resource/collection',async()=>{
 const m=model(),a=capture(),first=await read(m,a,'children',{query:{limit:1}});assert.equal(first.meta.total,2);assert.equal(first.data.length,1);assert.ok(first.meta.cursor);
 const second=await read(m,a,'children',{query:{limit:1,cursor:first.meta.cursor}});assert.equal(second.meta.cursor,null);assert.notEqual(first.data[0].slot_id,second.data[0].slot_id);
 for(const cursor of [first.meta.cursor+'x','bad.cursor','e30.eA'])await assert.rejects(read(m,a,'children',{query:{limit:1,cursor}}));
 await assert.rejects(read(m,a,'source-items',{query:{cursor:first.meta.cursor}}));await assert.rejects(read(m,a,'children',{query:{limit:101}}));
 await assert.rejects(T.readOrderSplitInTx(m.c,a,{operation:'execute',id:m.f.execution.id,view:'children',query:{cursor:first.meta.cursor}},secret));
 assert.equal(writes(m).length,0);assert.equal(m.role,'dyna_app');
});
test('late identity drift or terminal refusal rejects the result and restores owner/tenant, without automatic Native replay',async()=>{
 for(const options of [{lateIdentity:true},{lateRoot:true},{terminalError:true},{ackDrift:true},{nativeError:'57014'}]){
  const m=model(options),a=capture();await assert.rejects(T.invokeOrderSplitExecuteInTx(m.c,a,m.f.execution.request),e=>!e.message.includes('PRIVATE_'));assert.equal(writes(m).length,1);assert.equal(m.role,'dyna_app');
 }
 const m=model({lateIdentity:true}),a=capture();await assert.rejects(read(m,a));assert.equal(writes(m).length,0);assert.equal(m.role,'dyna_app');
});
test('historical Native replay uses current credentials and never calls current-TX terminal on the old execution',async()=>{
 const m=model({replayed:true}),a=capture();const h=await T.invokeOrderSplitExecuteInTx(m.c,a,m.f.execution.request);assert.equal(h.state,'done');assert.equal(writes(m).length,1);assert.equal(m.calls.filter(c=>c.sql.includes('order_split210_terminal(')).length,0);assert.equal(m.calls.filter(c=>c.sql.includes('buyer_address_identity(')).length,2);
});
test('new and historical preview/execute enlist exact captured request and original immutable head for the real outer finalizer',async()=>{
 for(const replayed of [false,true])for(const kind of ['preview','execute']){
  const m=model({replayed,forbidPostFinalIAM:true}),a=capture(),row=m.f[kind==='preview'?'preview':'execution'];
  try{
   assert.equal(R.hasOrderSplitTransactionDuty(m.c),false);
   const head=await(kind==='preview'?T.invokeOrderSplitPreviewInTx:T.invokeOrderSplitExecuteInTx)(m.c,a,row.request);
   assert.equal(head.id,row.id);assert.equal(R.hasOrderSplitTransactionDuty(m.c),true);
   R.enlistOrderSplitTransaction(m.c,a,kind,row.id); // Same exact duty is idempotent.
   assert.throws(()=>R.enlistOrderSplitTransaction(m.c,{...a},kind,row.id),e=>e.status===409);
   assert.throws(()=>R.enlistOrderSplitTransaction(m.c,a,kind,id(99)),e=>e.status===409);
   assert.equal(m.calls.some(c=>c.sql.includes('order_split210_finalize(')),false,'Enlistment is not a callback-local final tail');
   await R.finalizeOrderSplitTransactionInTx(m.c);
   const final=m.calls.filter(c=>c.sql.includes('order_split210_finalize('));assert.equal(final.length,1);
   assert.deepEqual(final[0].args,[kind,row.id,a.userId,null,digest(rawSession),a.role]);
   assert.equal(writes(m).length,1);assert.equal(R.hasOrderSplitTransactionDuty(m.c),true,'Duty survives finalization until outer cleanup');
   await assert.rejects(R.finalizeOrderSplitTransactionInTx(m.c),e=>e.status===503);
  }finally{R.endOrderSplitTransaction(m.c);}
  assert.equal(R.hasOrderSplitTransactionDuty(m.c),false);
 }
});
test('missing/conflicting managed duty rejects callback return; late IAM or malformed saved result never enlist or retry',async()=>{
 for(const kind of ['preview','execute']){
  const a=capture(),m=model({unmanaged:true}),row=m.f[kind==='preview'?'preview':'execution'];
  await assert.rejects((kind==='preview'?T.invokeOrderSplitPreviewInTx:T.invokeOrderSplitExecuteInTx)(m.c,a,row.request),e=>e.status===503);
  assert.equal(writes(m).length,1);assert.equal(R.hasOrderSplitTransactionDuty(m.c),false);assert.equal(m.role,'dyna_app');
  const conflicting=model(),prior=capture();
  try{
   R.enlistOrderSplitTransaction(conflicting.c,prior,'preview',id(98));
   await assert.rejects((kind==='preview'?T.invokeOrderSplitPreviewInTx:T.invokeOrderSplitExecuteInTx)(conflicting.c,a,conflicting.f[kind==='preview'?'preview':'execution'].request),e=>e.status===409);
   R.enlistOrderSplitTransaction(conflicting.c,prior,'preview',id(98));
   assert.equal(writes(conflicting).length,1);assert.equal(conflicting.calls.some(c=>c.sql.includes('order_split210_finalize(')),false);
  }finally{R.endOrderSplitTransaction(conflicting.c);}
  for(const options of [{lateIdentity:true},{ackDrift:true},{partial:true}]){
   const failed=model(options);
   try{await assert.rejects((kind==='preview'?T.invokeOrderSplitPreviewInTx:T.invokeOrderSplitExecuteInTx)(failed.c,a,failed.f[kind==='preview'?'preview':'execution'].request));
    assert.equal(R.hasOrderSplitTransactionDuty(failed.c),false);assert.equal(writes(failed).length,1);assert.equal(failed.role,'dyna_app');
   }finally{R.endOrderSplitTransaction(failed.c);}
  }
 }
 // This adapter never commits/rolls back itself. Its rejection must propagate
 // to the real outer manager, whose rollback/cleanup is separately required.
});
// The public service calls the actual db.ts manager body. Only its external
// dependencies are controlled; registry, split writer/finalizer and drain are real.
function productionManager(m){
 const events=[],ports={pool:{async connect(){events.push('connect');return m.c;}},ordinarySchemaGate:null,
  originalTenantPoolClients187:new WeakMap(),activeManagedSchemaTransactions:new WeakMap(),acknowledgedTenantRollbacks:new WeakMap(),
  runBoundDurableTenantTransaction187:()=>undefined,hasAcknowledgedDurableWorkerRollback187:()=>false,isDurableWorkerClientTainted187:()=>false,
  ...R,drainPublicConstraintsInTx,assertOrderSplitCompositionInTx:c=>{assert.equal(c,m.c);assert(R.hasOrderSplitTransactionDuty(c));events.push('composition');}};
 const names=[...new Set([...tenantJs.matchAll(/\b((?:begin|end|prepare|finalize|preflight)[A-Z]\w+|wmsLotsAdmissionInTx|purchasingSourceAdmissionInTx|purchasingStockAdmissionInTx|catalogStockControlAdmissionInTx)\(/g)].map(m=>m[1]))];
 for(const name of names)if(!(name in ports))ports[name]=async()=>{events.push(name);return false;};
 const manager=new Function(...Object.keys(ports),tenantJs+';return tenantTx;')(...Object.values(ports));
 DB.setTenantTx((tenant,fn,...options)=>{assert.equal(tenant,id(1));assert.deepEqual(options,[]);return manager(tenant,fn);});return events;
}
test('production preview/execute bridge uses actual tenantTx, saved readback and managed final tail before COMMIT',async()=>{
 const service=T.createOrderSplitTransport();assert.deepEqual(service.state,{nativeReady:false,registered:false,lateManagedTerminalRequired:true});
 for(const kind of ['preview','execute'])for(const replayed of [false,true]){
  const m=model({managedRoot:true,unmanaged:true,replayed,forbidPostFinalIAM:true}),events=productionManager(m),row=m.f[kind==='preview'?'preview':'execution'];
  const h=await service[kind](capture(),row.request);assert.equal(h.id,row.id);assert.equal(writes(m).length,1);
  const at=part=>m.calls.findIndex(q=>q.sql.includes(part));
  assert(at('BEGIN')<at('order_split210_'+kind+'('));assert(at('SET CONSTRAINTS')<at('order_split210_finalize('));assert(at('order_split210_finalize(')<at('COMMIT'));assert(at('COMMIT')<at('POOL_RELEASE'));
  assert(events.indexOf('composition')<events.indexOf('preparePimTransactionInTx'));
  assert.equal(m.calls.filter(q=>q.sql.includes('order_split210_finalize(')).length,1);
  assert.equal(m.calls.filter(q=>q.sql.includes('order_split210_terminal(')).length,kind==='execute'&&!replayed?1:0);
  assert.equal(R.hasOrderSplitTransactionDuty(m.c),false);
 }
});
test('production manager propagates absent Native, late IAM, drain/finalizer and unknown COMMIT failure with rollback and no retry',async()=>{
 for(const options of [{nativeError:'42P01'},{nativeError:'42883'},{lateIdentity:true},{drainError:true},{finalizerError:'28000'},{commitLost:true}]){
  const m=model({managedRoot:true,unmanaged:true,...options});productionManager(m);
  await assert.rejects(T.createOrderSplitTransport().execute(capture(),m.f.execution.request),e=>!e.message.includes('PRIVATE_')&&(!options.nativeError||e.status===503));
  assert.equal(writes(m).length,1);assert.equal(m.calls.filter(q=>q.sql==='ROLLBACK').length,1);assert.equal(m.calls.filter(q=>q.sql==='COMMIT').length,options.commitLost?1:0);
  assert(m.calls.filter(q=>q.sql.includes('order_split210_finalize(')).length<=1);assert.equal(R.hasOrderSplitTransactionDuty(m.c),false);assert.equal(m.calls.at(-1).sql,'POOL_RELEASE');
 }
});
test('production bridge rejects forged, readonly, viewer and malformed intent before borrowing a client',async()=>{
 let borrowed=0;DB.setTenantTx(()=>{borrowed++;throw Error('MUST_NOT_BORROW')});
 const service=T.createOrderSplitTransport(),a=capture(),f=saved(),viewer=capture({actor:{tenantId:id(1),userId:id(2),role:'viewer'},currentUser:{id:id(2),tenant_id:id(1),role:'viewer'}});
 for(const kind of ['preview','execute'])for(const [handle,body]of [[{...a},f[kind==='preview'?'preview':'execution'].request],[capture({}, {readOnly:true}),f[kind==='preview'?'preview':'execution'].request],[viewer,f[kind==='preview'?'preview':'execution'].request],[a,{bad:true}]])await assert.rejects(service[kind](handle,body));
 assert.equal(borrowed,0);
});

test('explicit final-boundary export derives six fixed Native args and makes Native finalize the last data query',async()=>{
 for(const kind of ['preview','execute']){
  const m=model({forbidPostFinalIAM:true}),a=capture(),id=m.f[kind==='preview'?'preview':'execution'].id;
  assert.equal(await T.finalizeOrderSplitRequestInTx(m.c,a,kind,id),undefined);
  const final=m.calls.filter(c=>c.sql.includes('order_split210_finalize('));assert.equal(final.length,1);
  assert.deepEqual(final[0].args,[kind,id,a.userId,null,digest(rawSession),'operator']);assert.equal(final[0].role,'postgres');
  assert.equal(m.role,'dyna_app');assert.equal(writes(m).length,0);
  assert.equal(m.calls.some(c=>/split210:(record|rows)|FROM public.orders|order_split210_terminal\(/.test(c.sql)),false);
  assert.deepEqual(m.calls.filter(c=>c.sql.includes('buyer_address_identity(')).map(c=>c.args.at(-1)),[true]);
  assert(m.calls.indexOf(m.calls.find(c=>c.sql.includes('buyer_address_identity(')))<m.calls.indexOf(final[0]));
  const after=m.calls.slice(m.calls.indexOf(final[0])+1);
  assert.deepEqual(after.map(c=>c.sql),["SELECT set_config('app.tenant_id',$1,true)",'SET LOCAL ROLE dyna_app',m.calls.find(c=>c.sql.includes('split210:context')).sql],
   'Only owner restoration and a no-data context cut follow the Native final-boundary call');
  assert(after.every(c=>!c.sql.includes(' FROM ')&&!c.sql.includes('buyer_address_identity(')));
 }
});

test('final boundary refuses copied request, invalid kind/id, readonly/viewer and foreign context before Native invocation',async()=>{
 const a=capture();
 for(const [handle,kind,commandId]of [[{...a},'execute',id(11)],[a,'other',id(11)],[a,'preview','bad-id']]){
  const m=model();await assert.rejects(T.finalizeOrderSplitRequestInTx(m.c,handle,kind,commandId));assert.equal(m.calls.length,0);
 }
 for(const handle of [capture({}, {readOnly:true}),capture({actor:{tenantId:id(1),userId:id(2),role:'viewer'},currentUser:{id:id(2),tenant_id:id(1),role:'viewer'}})]){
  const m=model();await assert.rejects(T.finalizeOrderSplitRequestInTx(m.c,handle,'execute',id(11)));assert.equal(m.calls.length,0);
 }
 for(const options of [{context:{tenant:id(99)}},{context:{role:'postgres'}},{context:{read_only:'on'}},{identityError:true}]){
  const m=model(options);await assert.rejects(T.finalizeOrderSplitRequestInTx(m.c,a,'execute',id(11)));
  assert.equal(m.calls.some(c=>c.sql.includes('order_split210_finalize(')),false);assert.equal(m.role,'dyna_app');
 }
});

test('final boundary uses today credential for historical commands and propagates late refusals without retry',async()=>{
 const current='PRIVATE_CURRENT_SESSION',a=capture({cookies:{dyna_session_preview_4103:current}}),m=model({replayed:true});
 await T.finalizeOrderSplitRequestInTx(m.c,a,'execute',m.f.execution.id);
 const final=m.calls.filter(c=>c.sql.includes('order_split210_finalize('));assert.equal(final.length,1);assert.equal(final[0].args[4],digest(current));
 assert.equal(m.calls.some(c=>c.sql.includes('order_split210_terminal(')),false);
 for(const [code,status]of [['28000',401],['42501',403],['P0002',404],['55000',503],['23514',409],['57014',500]]){
  const v=model({finalizerError:code});await assert.rejects(T.finalizeOrderSplitRequestInTx(v.c,a,'execute',id(11)),e=>e.status===status&&!e.message.includes('PRIVATE_'));
  assert.equal(v.calls.filter(c=>c.sql.includes('order_split210_finalize(')).length,1);assert.equal(v.role,'dyna_app');
 }
 for(const options of [{lateRoot:true}]){
  const v=model(options);await assert.rejects(T.finalizeOrderSplitRequestInTx(v.c,a,'preview',id(10)));
  assert.equal(v.calls.filter(c=>c.sql.includes('order_split210_finalize(')).length,1);assert.equal(v.role,'dyna_app');
 }
 // A post-clock IAM query would fail this port. The Native query owns its
 // closing credential check; the bridge neither waits for nor substitutes one.
 const v=model({lateIdentity:true,forbidPostFinalIAM:true});await T.finalizeOrderSplitRequestInTx(v.c,a,'preview',id(10));
 assert.equal(v.calls.filter(c=>c.sql.includes('buyer_address_identity(')).length,1);
});

test('unregistered finalizer SQL separates new source proof from current-request historical replay duty',()=>{
 const sql=readFileSync(new URL('../tools/parity/order-split210-terminal.sql',import.meta.url),'utf8');
 const historical=sql.slice(sql.indexOf('-- Historical commands'),sql.indexOf('-- Last read'));
 assert(historical.includes('public.order_split210_replay_duties'));
 for(const field of ['d.credential_hash','d.actor_role','d.request_hash','d.api_key_id','d.root_xid','d.transaction_started_at','d.identity_snapshot'])assert(historical.includes(field));
 assert(!historical.includes('order_split210_terminal('));assert(!historical.includes('order_split210_capture('));
 assert(!historical.includes('p.expires_at'));assert(!historical.includes('e.expires_at'));
 assert(sql.includes('current_source:=public.order_split210_capture(p.source_order_id,p.source_version)'));
 assert(sql.includes('p.plan IS DISTINCT FROM current_plan'));assert(sql.includes('s.row_data IS DISTINCT FROM i'));
 assert(sql.includes('PERFORM public.order_split210_terminal(e.id)'));
 assert(sql.includes('closing_auth:=public.order_split210_identity(t,uid,kid,supplied_credential,role_name,false)'));
 assert(sql.indexOf('closing_auth:=')>sql.indexOf('-- Last read'));
 assert(sql.includes("deadline<=clock_timestamp()"));assert(sql.includes('FROM PUBLIC,dyna_app;'));
 assert(!/\bGRANT\b/.test(sql));assert(!sql.includes('SET CONSTRAINTS'));assert(!sql.includes('set_config('));
 assert.equal(T.ORDER_SPLIT_TRANSPORT_STATE.nativeReady,false);
});
