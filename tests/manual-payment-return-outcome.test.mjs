/** Actual asynchronous service/route bodies with controlled transaction ports.
 * No module-level db/config imports, HTTP, PG, seeding or Native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {transformSync} from 'esbuild';
import {z} from 'zod';
const paymentSource=readFileSync(new URL('../server/payments.ts',import.meta.url),'utf8'),returnSource=readFileSync(new URL('../server/returns.ts',import.meta.url),'utf8');
const id=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`,actor={tenantId:id(1),userId:id(2),role:'admin'},oid=id(3),rid=id(4),item=id(5),warehouse=id(6);
function ensure(condition,status,message){if(!condition)throw Object.assign(Error(message),{status});}
function part(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert(a>=0&&b>a,'actual source delimiters');return source.slice(a,b);}
function actual(code,name,ports){const js=transformSync(code.replace(/^export /gm,''),{loader:'ts',format:'cjs'}).code;return new Function(...Object.keys(ports),js+';return '+name+';')(...Object.values(ports));}
const replayBody=part(paymentSource,'async function replay(','\nexport type Entry'); // Entry exported since 29d6e82 (order sections)
const appendBody=part(paymentSource,'export async function appendPayment(','\nexport async function confirmOutstanding(');
const paymentBody=part(paymentSource,'export async function recordPayment(','\nasync function validatePaymentEntry(');
const receiveBody=part(returnSource,'function returnReceiveOutcome','\nexport async function decideReturn(');
const paymentInput=actual(part(paymentSource,'const amount =','\nexport const reversalInput'),'paymentInput',{z});
function pureSchemaModule(name,allowed){
 const source=readFileSync(new URL('../server/'+name,import.meta.url),'utf8'),module={exports:{}};
 const code=transformSync(source,{loader:'ts',format:'cjs'}).code;
 new Function('require','module','exports',code)(name=>{assert(Object.hasOwn(allowed,name),'only pure schema imports permitted: '+name);return allowed[name];},module,module.exports);
 return module.exports;
}
const lotSchemas=pureSchemaModule('wms-lots-schema.ts',{'zod':{z}}),workflowSchemas=pureSchemaModule('wms-lots-workflow-schema.ts',{'zod':{z},'./wms-lots-schema':lotSchemas});
const receiveInput=actual(part(returnSource,'const quantity =','\nexport const returnInput')+'\n'+part(returnSource,'export const receiveInput =','\nexport const decisionInput'),'receiveInput',{z,returnWmsLots:workflowSchemas.returnWmsLots});

const allocatedBody=part(returnSource,'export const allocatedRefund =','\n/** Trusted typed148');
const allocatedRefund=actual(allocatedBody,'allocatedRefund',{});
function paymentModel(){
 const state={version:1,entries:[],writes:0,events:0,reads:0,active:false,log:[],failLate:false,failCommit:false},client={async query(sql,args=[]){ensure(state.active,500,'query outside managed transaction');state.log.push(sql);
  if(sql.startsWith('SELECT id,request FROM payment_entries'))return{rows:state.entries.filter(e=>e.order_id===args[0]&&e.client_key===args[1]).map(e=>({id:e.id,request:e.request}))};
  if(sql==='SELECT id FROM orders WHERE id=$1 FOR UPDATE')return{rows:[{id:oid}]};
  if(sql.includes('FROM shipping_plans'))return{rows:[],rowCount:0};
  if(sql.startsWith('INSERT INTO payment_entries')){const[entry,tenant,order,key,input,kind,amount,fee,currency,method,reference,note]=args;state.entries.push({id:entry,tenant_id:tenant,order_id:order,client_key:key,request:JSON.parse(input),kind,amount,fee,currency,method,reference,note});state.writes++;return{rows:[]};}
  if(sql.startsWith('UPDATE orders')){state.version++;return{rows:[]};}
  if(sql.startsWith('INSERT INTO audit_events'))return{rows:[]};
  assert.fail('unexpected actual payment SQL '+sql);
 }};
 const history=async()=>({balance:{amount_due:100-state.entries.reduce((n,e)=>n+e.amount,0)},data:structuredClone(state.entries),next:null});
 const replay=actual(replayBody,'replay',{ensure,isDeepStrictEqual});
 const append=actual(appendBody,'appendPayment',{ensure,randomUUID,localFinancialContext:{parse(){throw Error('unexpected imported financial context');}},resolveOrderMergeOwnerInTx:async()=>oid,assertSaleFinancialOrderInTx:async()=>{},assertRefundRemedyInTx:async()=>{},stampLocalFinancialVersion:async()=>{throw Error('manual payment must not use imported financial effect');},financialEvent:async()=>{state.events++;},
  // 238 audit writer: the same one audit_events insert for a session actor (no API key here).
  insertAuditEvent:async(c,a,action,id,detail)=>c.query('INSERT INTO audit_events(id,tenant_id,user_id,action,entity_id,detail) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),a.tenantId,a.userId,action,id,JSON.stringify(detail)])});
 const record=actual(paymentBody,'recordPayment',{ensure,order:async(c,id,lock)=>{assert.equal(c,client);assert.equal(id,oid);assert.equal(lock,true);assert(state.active);state.log.push('actual mutation order lock');return{id:oid,version:state.version};},replay,validatePaymentEntry:async()=>{},appendPayment:append,advancePaid:async()=>{if(state.failLate)throw Object.assign(Error('late payment admission failed'),{status:403});},paymentHistory:history});
 async function tx(_tenant,fn){assert.equal(_tenant,actor.tenantId);assert(!state.active);const before=structuredClone({version:state.version,entries:state.entries,writes:state.writes,events:state.events});state.active=true;try{const result=await fn(client);if(state.failCommit)throw Error('managed commit refused');return result;}catch(e){Object.assign(state,before);throw e;}finally{state.active=false;}}
 // b5a0bae: GET history runs in tenantReadTx; a read transaction that must not write and never commits a mutation.
 async function readTx(_tenant,fn){assert.equal(_tenant,actor.tenantId);assert(!state.active);const writes=state.writes,versions=state.version;state.reads++;state.active=true;try{return await fn(client);}finally{state.active=false;assert.equal(state.writes,writes,'read transaction must not write');assert.equal(state.version,versions,'read transaction must not advance the order');}}
 const body=()=>({client_key:randomUUID(),version:state.version,kind:'receipt',amount:25,fee:0,currency:'PLN',method:'bank_transfer',reference:'Synthetic local confirmation',note:'',confirmed:true});
 return{state,client,tx,readTx,record,history,body};
}
function receiveModel({existing=false,sequence=1,internal=false}={}){
 const input={version:2,shipping_refund:0,note:'Synthetic received return',items:[{item_id:item,accepted:1,restocked:0}]};
 const state={r:{id:rid,order_id:oid,warehouse_id:warehouse,legacy:false,remedy:'refund',state:existing?'refund_pending':'requested',version:existing?3:2,receipt:existing?structuredClone(input):null,receipt_sequence:existing?sequence:0,received_at:existing?'2026-10-18T02:00:00.000Z':null,requested_shipping:0,refund_amount:existing?100:0},writes:0,items:[],log:[],active:false,failPin:false,failCommit:false,badSequence:false};
 const client={async query(sql,args=[]){assert(state.active,'controlled original transaction required');state.log.push(sql);
  if(sql.startsWith('SELECT order_id,warehouse_id FROM return_cases'))return{rows:[{order_id:oid,warehouse_id:warehouse}]};
  if(sql.includes('b2b_network_return_dispatched'))return{rows:[{dispatched:true}]};
  if(sql.startsWith('SELECT l.*,i.quantity'))return{rows:[{item_id:item,requested:1,quantity:1,line_total:100,components:[{product_id:id(7),quantity:1}]}]};
  if(sql.includes('SELECT coalesce(sum(l.accepted)'))return{rows:[{n:0}]};
  if(sql.startsWith('UPDATE return_items')){state.items=[{item_id:args[4],accepted:args[0],restocked:args[1],refund_amount:args[2]}];return{rows:[]};}
  if(sql.startsWith('UPDATE return_cases SET')){state.r={...state.r,state:'refund_pending',receipt:JSON.parse(args[1]),refunded_shipping:args[2],refund_amount:args[3],decision_note:args[4],received_at:'2026-10-18T02:01:00.000Z',receipt_sequence:state.badSequence?0:1,version:3};state.writes++;return{rows:[]};}
  if(sql==='SET CONSTRAINTS ALL IMMEDIATE')return{rows:[]};
  assert.fail('unexpected actual RMA SQL '+sql);
 }};
 const completion={id:id(90),return_id:rid},log=name=>async()=>{state.log.push(name);};
 const ports={ensure,isDeepStrictEqual,allocatedRefund,
  prepareReturnCompletionInTx:async(_c,_a,raw)=>{state.log.push('prepare completion');state.preparedRequest=structuredClone(raw.request);return completion;},assertReturnCompletionInTx:(c,a,h,id,b)=>{assert.equal(c,client);assert.equal(id,rid);assert.equal(h,completion);assert.deepEqual(b,state.preparedRequest??input);},
  certifyDestinationCoreInTx:async()=>{throw Error('unexpected destination admission');},enlistReturnCompletionActorInTx:async(_c,a)=>a,
  lockWarehouseInventoryPoliciesInTx:async()=>[{warehouse_id:warehouse,usage:'sale',enabled:true}],lockParcelReturnOrderInTx:log('parcel lock'),admitLocalReturnReceiveInTx:log('local admission'),wmsLotsPolicyInTx:async()=>({enabled:false}),
  lockedReturn:async(c,id)=>{assert.equal(c,client);assert.equal(id,rid);state.log.push('actual mutation return/order lock');return{order:{id:oid},r:structuredClone(state.r)};},assertCoordinatedReturnWriteInTx:log('coordinated admission'),assertLocalReturnReceiveReplayInTx:log('replay admission'),
  replayReturnCompletionInTx:log('replay completion'),getReturn:async()=>{state.log.push('hydrate original return');return{...structuredClone(state.r),items:structuredClone(state.items)};},
  pinReturnCompletionInTx:async()=>{state.log.push('terminal IAM pin');if(state.failPin)throw Object.assign(Error('late RMA identity revoked'),{status:403});},
  claimFinancialReturnCompletionInTx:log('financial claim'),prepareLocalReturnReceiveInTx:async()=>null,prepareParcelReturnReceiveInTx:async()=>false,prepareDestinationParcelReceiveInTx:async()=>{throw Error('unexpected destination parcel');},assertB2bExternalLocalRestockInTx:log('physical eligibility'),
  returnWmsLotsInTx:async()=>{throw Error('restock zero must not fabricate WMS');},returnOverview:async()=>({items:[{returned:0,quantity:1}]}),changed:log('return changed'),retainNativeReturnCompletionInTx:()=>{state.log.push('retain native');},completeReturnCompletionInTx:log('complete native'),
 };
 const receive=actual(receiveBody,'receiveReturn',ports);
 async function tx(_tenant,fn){assert.equal(_tenant,actor.tenantId);assert(!state.active);const before=structuredClone({r:state.r,writes:state.writes,items:state.items});state.active=true;try{const result=await fn(client);if(state.failCommit)throw Error('managed commit refused');return result;}catch(e){Object.assign(state,before);throw e;}finally{state.active=false;}}
 const call=()=>tx(actor.tenantId,c=>receive(c,actor,rid,input,false,internal?{completion}:{}));
 return{state,client,tx,receive,input,completion,call,ports};
}
const paymentRouteSource=readFileSync(new URL('../server/payment-routes.ts',import.meta.url),'utf8'),returnRouteSource=readFileSync(new URL('../server/return-routes.ts',import.meta.url),'utf8');
// Route bodies include their final brace; use full source from the declaration.
function routeHandlers(source,name,ports){const handlers=new Map(),app={get(path,handler){handlers.set('GET '+path,handler);},post(path,handler){handlers.set('POST '+path,handler);}};actual(source.slice(source.indexOf('export function '+name+'(')),name,ports)(app,{sessionName:'synthetic-session'});return handlers;}
test('actual payment mutation returns the newly inserted UUID; lost response exact replay returns true and that same durable entry',async()=>{
 const m=paymentModel(),body=m.body();const first=await m.tx(actor.tenantId,c=>m.record(c,actor,oid,body));assert.equal(first.reused,false);assert.equal(first.payment_entry_id,m.state.entries[0].id);assert.equal(m.state.writes,1);const {reused,payment_entry_id,...business}=first;assert.deepEqual(business,await m.history());
 // The client loses this committed result; only an explicit original-key call follows.
 const replay=await m.tx(actor.tenantId,c=>m.record(c,actor,oid,body));assert.equal(replay.reused,true);assert.equal(replay.payment_entry_id,first.payment_entry_id);assert.equal(m.state.writes,1);assert.equal(m.state.events,1);
 const freshBody=m.body(),next=await m.tx(actor.tenantId,c=>m.record(c,actor,oid,freshBody));assert.equal(next.reused,false);assert.notEqual(next.payment_entry_id,first.payment_entry_id);assert.equal(m.state.writes,2);
});
test('actual payment replay preserves exact request checks, stale new-key CAS and viewer refusal',async()=>{
 const m=paymentModel(),body=m.body();await m.tx(actor.tenantId,c=>m.record(c,actor,oid,body));for(const b of[{...body,amount:26},{...body,client_key:randomUUID()}])await assert.rejects(m.tx(actor.tenantId,c=>m.record(c,actor,oid,b)),e=>e.status===409);await assert.rejects(m.tx(actor.tenantId,c=>m.record(c,{...actor,role:'viewer'},oid,m.body())),e=>e.status===403);assert.equal(m.state.writes,1);
});
test('actual ordinary payment route exposes no success on late admission or commit failure and leaves GET history literal',async()=>{
 for(const stage of['failLate','failCommit']){const m=paymentModel(),handlers=routeHandlers(paymentRouteSource,'registerPaymentRoutes',{z,tenantTx:m.tx,tenantReadTx:m.readTx,paymentInput,paymentHistory:m.history,recordPayment:m.record,reversalInput:{parse:x=>x},reversePayment:async()=>{throw Error('not tested');}}),request={actor,params:{id:oid},body:m.body(),query:{}};m.state[stage]=true;await assert.rejects(handlers.get('POST /api/orders/:id/payments')(request));assert.equal(m.state.writes,0);assert.equal(m.state.entries.length,0);m.state[stage]=false;const fresh=await handlers.get('POST /api/orders/:id/payments')(request);assert.equal(fresh.reused,false);assert.equal(m.state.reads,0);const get=await handlers.get('GET /api/orders/:id/payments')(request);assert.equal(m.state.reads,1);assert(!Object.hasOwn(get,'reused'));assert(!Object.hasOwn(get,'payment_entry_id'));}
});
test('actual RMA fresh and replay branches use hydrated durable identity and retain terminal completion sequence',async()=>{
 const m=receiveModel(),first=await m.call();assert.equal(first.reused,false);assert.deepEqual(first.receive_receipt,{return_id:rid,receipt_sequence:1});assert.equal(m.state.writes,1);const pin=m.state.log.lastIndexOf('terminal IAM pin');assert(m.state.log.indexOf('complete native')<m.state.log.indexOf('SET CONSTRAINTS ALL IMMEDIATE'));assert(m.state.log.indexOf('SET CONSTRAINTS ALL IMMEDIATE')<pin);assert.deepEqual(first.receipt,m.input);
 const replay=await m.call();assert.equal(replay.reused,true);assert.deepEqual(replay.receive_receipt,first.receive_receipt);assert.equal(m.state.writes,1);assert(m.state.log.includes('replay completion'));const{reused,receive_receipt,...business}=replay;assert.deepEqual(business,{...structuredClone(m.state.r),items:m.state.items});
});
test('actual first encountered historical RMA is reused; legacy unsequenced identity stays explicitly null',async()=>{
 for(const sequence of[1,0,null]){const m=receiveModel({existing:true,sequence}),r=await m.call();assert.equal(r.reused,true);assert.equal(m.state.writes,0);assert.deepEqual(r.receive_receipt,sequence===1?{return_id:rid,receipt_sequence:1}:null);}
});
test('actual RMA changed historical body refuses without receipt mutation and trusted outer completion remains deferred',async()=>{
 const m=receiveModel({existing:true});await assert.rejects(m.tx(actor.tenantId,c=>m.receive(c,actor,rid,{...m.input,note:'Changed stored receipt'})),e=>e.status===409);assert.equal(m.state.writes,0);
 const outer=receiveModel({internal:true}),r=await outer.call();assert.equal(r.reused,false);assert.deepEqual(r.receive_receipt,{return_id:rid,receipt_sequence:1});assert(!outer.state.log.includes('complete native'));assert(!outer.state.log.includes('terminal IAM pin'));assert(!outer.state.log.includes('SET CONSTRAINTS ALL IMMEDIATE'));assert(outer.state.log.includes('retain native'));
});
test('actual ordinary RMA route cannot deliver outcome before late identity/commit or with an unsequenced fresh write',async()=>{
 for(const stage of['failPin','failCommit','badSequence']){const m=receiveModel(),handlers=routeHandlers(returnRouteSource,'registerReturnRoutes',{z,ensure,tenantTx:m.tx,financialReturn162RequestActor:async()=>actor,receiveInput,receiveReturn:m.receive});m.state[stage]=true;await assert.rejects(handlers.get('POST /api/returns/:id/receive')({actor,params:{id:rid},body:m.input}));assert.equal(m.state.writes,0);assert.equal(m.state.r.receipt,null);}
});

test('actual ordinary routes preserve real schema normalization and exact original replay across a lost response',async()=>{
 const p=paymentModel(),ph=routeHandlers(paymentRouteSource,'registerPaymentRoutes',{z,tenantTx:p.tx,paymentInput,paymentHistory:p.history,recordPayment:p.record,reversalInput:{parse:x=>x},reversePayment:async()=>{throw Error('not tested');}}),body={...p.body(),version:'1',reference:'  Original synthetic payment  '};delete body.fee;delete body.note;const req={actor,params:{id:oid},body,query:{}},first=await ph.get('POST /api/orders/:id/payments')(req);assert.equal(first.reused,false);assert.equal(p.state.entries[0].request.version,1);assert.equal(p.state.entries[0].request.fee,0);assert.equal(p.state.entries[0].request.reference,'Original synthetic payment');const again=await ph.get('POST /api/orders/:id/payments')(req);assert.equal(again.reused,true);assert.equal(again.payment_entry_id,first.payment_entry_id);assert.equal(p.state.writes,1);
 const r=receiveModel(),rh=routeHandlers(returnRouteSource,'registerReturnRoutes',{z,ensure,tenantTx:r.tx,financialReturn162RequestActor:async()=>actor,receiveInput,receiveReturn:r.receive}),request={actor,params:{id:rid},body:{...r.input,version:'2',note:'  Original synthetic return  '}};delete request.body.shipping_refund;const received=await rh.get('POST /api/returns/:id/receive')(request);assert.equal(received.reused,false);assert.equal(received.receipt.version,2);assert.equal(received.receipt.note,'Original synthetic return');assert.equal(received.receipt.shipping_refund,0);const replay=await rh.get('POST /api/returns/:id/receive')(request);assert.equal(replay.reused,true);assert.deepEqual(replay.receive_receipt,received.receive_receipt);assert.equal(r.state.writes,1);
});
test('actual RMA replay binds the entire archived WMS body including original key and locations',async()=>{
 const m=receiveModel({existing:true});m.input.wms_lots={client_key:id(55),policy_version:'2',stock_versions:[{warehouse_id:warehouse,product_id:id(7),version:'0'}],picks:[{issue_fragment_id:id(56),quantity:1,location:'A-1'}]};m.state.r.receipt=structuredClone(m.input);const replay=await m.call();assert.equal(replay.reused,true);for(const mutate of[b=>b.wms_lots.client_key=id(57),b=>b.wms_lots.stock_versions[0].version='1',b=>b.wms_lots.picks[0].location='A-2']){const changed=structuredClone(m.input);mutate(changed);await assert.rejects(m.tx(actor.tenantId,c=>m.receive(c,actor,rid,changed)),e=>e.status===409);}assert.equal(m.state.writes,0);
});
