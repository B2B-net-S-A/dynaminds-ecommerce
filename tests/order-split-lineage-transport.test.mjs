/** Actual lineage reader/factory with controlled role-aware query ports. No PG,
 * installed210, business execution, transaction commit or activation claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createServer} from 'vite';
const dbId='\0lineage-controlled-db';
const vite=await createServer({plugins:[{name:'lineage-controlled-db',enforce:'pre',transform(source,id){if(id.endsWith('/server/order-split-transport.ts'))return source.replaceAll("import('./db')","import('virtual:lineage-db')");},resolveId(id){if(id==='virtual:lineage-db')return dbId;},load(id){if(id.endsWith('/server/db.ts'))throw Error('Real DB import prohibited');if(id===dbId)return 'let port;export const setPort=v=>port=v;export const tenantTx=(...args)=>port(...args);';}}],server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
const T=await vite.ssrLoadModule(path.resolve('server/order-split-transport.ts'));
const DB=await vite.ssrLoadModule('virtual:lineage-db');
test.after(()=>vite.close());
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`,tenant=id(1),source=id(3),execution=id(4),preview=id(5),child=id(6),otherChild=id(7),copy=v=>structuredClone(v);
function request(role='operator',user=id(99),scopeTenant=tenant){
 return T.captureOrderSplitRequest({actor:{tenantId:scopeTenant,userId:user,role,source:'manual'},currentUser:{id:user,tenant_id:scopeTenant,role},headers:{},cookies:{dyna_session:'PRIVATE_LINEAGE_SESSION'}},'dyna_session',{readOnly:true});
}
function model(options={}){
 let role='dyna_app',iam=0,frames=0,visible=0;
 const calls=[],targets=[{tenant_id:tenant,execution_id:execution,preview_id:preview,result_index:0,slot_id:id(90),order_id:child,source_order_id:source},{tenant_id:tenant,execution_id:execution,preview_id:preview,result_index:1,slot_id:id(80),order_id:otherChild,source_order_id:source},{tenant_id:tenant,execution_id:execution,preview_id:preview,result_index:2,slot_id:null,order_id:source,source_order_id:source}];
 const events=targets.map((row,i)=>({id:id(20+i),tenant_id:tenant,order_id:row.order_id,kind:row.slot_id===null?'order.split.source':'order.split.child',exact_detail:true,execution_id:execution,source_order_id:source,slot_id:row.slot_id,slot_type:row.slot_id===null?'null':'string'}));
 const saved={tenant_id:tenant,id:execution,preview_id:preview,source_order_id:source};
 options.change?.({targets,events,saved});
 const rows=v=>({rows:copy(v),rowCount:v.length});
 const c={async query(sql,args=[]){
  calls.push({sql,args:copy(args),role});
  if(sql.includes('split210:context')){frames++;return rows([{role,owner:'postgres',tenant,root:options.lateRoot&&frames>1?'101':'100',started:'2026-10-18 00:00:00+00',pid:'5',read_only:'off'}]);}
  if(sql.includes('buyer_address_identity(')){iam++;if(options.expired&&iam>1){const e=Error('PRIVATE_SESSION');e.code='28000';throw e;}return rows([{proof:{role:options.role??'operator',version:options.lateIAM&&iam>1?'2':'1'}}]);}
  if(sql.includes('pg_get_userbyid(relowner)'))return rows([{role,owner:'postgres',tenant,root:'100',started:'2026-10-18 00:00:00+00',relation_owner:'postgres'}]);
  if(sql==='RESET ROLE'){role='postgres';return rows([]);}
  if(sql.startsWith("SELECT set_config('app.tenant_id'"))return rows([]);
  if(sql==='SET LOCAL ROLE dyna_app'){role='dyna_app';return rows([]);}
  if(sql.includes('lineage-visible-orders')){
   assert.equal(role,'dyna_app','Ordinary order visibility MUST be outside owner callback');visible++;
   return rows(args[1].filter(value=>!(options.invisibleCurrent&&visible===1)&&!(options.hiddenPeer&&value===otherChild)).map(value=>({tenant_id:tenant,id:value})));
  }
  assert.equal(role,'postgres','Only explicit-tenant ID projection runs as owner');assert.equal(args[0],tenant);
  if(options.ownerError)throw Error('OWNER_FAILED');
  if(sql.includes('lineage-source-fragments'))return rows([{present:!!options.sourceFragments}]);
  if(sql.includes('lineage-current-target'))return rows(options.none?[]:options.currentTargets??targets.filter(row=>row.order_id===args[1]));
  if(sql.includes('lineage-current-events'))return rows(options.none?[]:options.currentEvents??events.filter(row=>row.order_id===args[1]));
  if(sql.includes('lineage-execution'))return rows(options.missingExecution?[]:[saved]);
  if(sql.includes('lineage-targets'))return rows(options.targetRows??targets);
  if(sql.includes('lineage-events'))return rows(options.eventRows??events);
  throw Error('Unexpected query');
 }};
 return{c,calls,targets,events,get role(){return role;}};
}
async function read(m,a=request(),order=child){return T.readOrderSplitLineageInTx(m.c,a,order);}
function readonly(m){assert(m.calls.every(row=>!/^\s*(INSERT|UPDATE|DELETE|BEGIN|COMMIT|GRANT|ALTER|CREATE)/i.test(row.sql)));assert(!m.calls.some(row=>/order_split210_(preview|execute|terminal|finalize)\(/.test(row.sql)));assert(!JSON.stringify(m.calls).includes('PRIVATE_LINEAGE_SESSION'));}

test('different same-tenant operators and viewer read the full safe persisted result_index order under ordinary RLS',async()=>{
 for(const role of ['admin','operator','viewer']){
  const m=model({role}),a=request(role);const result=await read(m,a);
  assert.deepEqual(result,{schema:'order-split-lineage/v1',order_id:child,lineage:{execution_id:execution,source_order_id:source,children:[{slot_id:id(90),order_id:child},{slot_id:id(80),order_id:otherChild}]}});
  assert.equal(m.role,'dyna_app');const owner=m.calls.filter(row=>row.role==='postgres'&&row.sql.includes('split210:lineage-'));assert(owner.every(row=>row.sql.includes('tenant_id=$1')));assert(owner.every(row=>!row.sql.includes('actor_id')));
  assert.equal(m.calls.filter(row=>row.sql.includes('lineage-visible-orders')).length,2);assert.equal(m.calls.filter(row=>row.sql.includes('buyer_address_identity(')).length,2);readonly(m);
 }
 const m=model();assert.equal((await read(m,request(),source)).lineage.source_order_id,source);
});
test('two distinct same-role users each bind their own fresh IAM while reading identical tenant lineage',async()=>{
 const results=[];
 for(const user of [id(2),id(99)]){const m=model();results.push(await read(m,request('operator',user)));const iam=m.calls.filter(row=>row.sql.includes('buyer_address_identity('));assert.equal(iam.length,2);assert(iam.every(row=>row.args[0]===tenant&&row.args[1]===user&&row.args[4]==='operator'));readonly(m);}
 assert.deepEqual(results[0],results[1]);
 const foreign=model();await assert.rejects(read(foreign,request('operator',id(99),id(101))),e=>e.status===403);assert(!foreign.calls.some(row=>row.sql==='RESET ROLE'));assert(!foreign.calls.some(row=>row.sql.includes('lineage-')));
});
test('zero targets AND zero split events is explicit null, invisible current order refuses before owner access',async()=>{
 const none=model({none:true});assert.deepEqual(await read(none),{schema:'order-split-lineage/v1',order_id:child,lineage:null});readonly(none);
 const no=model({invisibleCurrent:true});await assert.rejects(read(no),e=>e.status===404);assert(!no.calls.some(row=>row.sql==='RESET ROLE'));assert(!no.calls.some(row=>row.sql.includes('lineage-current')));
 const torn=model({none:true,sourceFragments:true});await assert.rejects(read(torn),e=>e.status===409);assert.equal(torn.role,'dyna_app');readonly(torn);
});
test('complete100-target persisted graph returns all99 children within the fixed ID-only bound',async()=>{
 const m=model({change({targets,events}){const rows=Array.from({length:100},(_,i)=>({tenant_id:tenant,execution_id:execution,preview_id:preview,result_index:i,slot_id:i===99?null:id(2000+i),order_id:i===99?source:i===0?child:id(1000+i),source_order_id:source}));targets.splice(0,targets.length,...rows);events.splice(0,events.length,...rows.map((row,i)=>({id:id(3000+i),tenant_id:tenant,order_id:row.order_id,kind:row.slot_id===null?'order.split.source':'order.split.child',exact_detail:true,execution_id:execution,source_order_id:source,slot_id:row.slot_id,slot_type:row.slot_id===null?'null':'string'})));}});
 const result=await read(m);assert.equal(result.lineage.children.length,99);assert.equal(result.lineage.children[98].order_id,id(1098));assert(Buffer.byteLength(JSON.stringify(result))<65536);readonly(m);
});
test('partial/missing/foreign/duplicate targets and events refuse409 rather than becoming empty history',async()=>{
 const variants=[
  {currentEvents:[]},{currentTargets:[]},{missingExecution:true},{currentTargets:[{},{}]},
  {change:({targets})=>targets.splice(1)},{change:({events})=>events.pop()},
  {change:({targets})=>targets[1].result_index=0},{change:({targets})=>targets[1].order_id=child},
  {change:({targets})=>targets[1].slot_id=targets[0].slot_id},{change:({targets})=>targets[2].slot_id=id(70)},
  {change:({targets})=>targets[1].source_order_id=id(70)},{change:({targets})=>targets[1].tenant_id=id(70)},
  {change:({targets})=>targets[1].preview_id=id(70)},{change:({saved})=>saved.id=id(70)},
  {change:({events})=>events[1].exact_detail=false},{change:({events})=>events[1].execution_id=id(70)},
  {change:({events})=>events[1].source_order_id=id(70)},{change:({events})=>events[1].kind=null},
  {change:({events})=>events[1].slot_id=id(70)},{change:({events})=>events[2].slot_type=null},
  {change:({events})=>events[1].order_id=child},{change:({events})=>events[1].id=events[0].id},
  {targetRows:Array.from({length:101},()=>({}))},{eventRows:Array.from({length:101},()=>({}))},
 ];
 for(const options of variants){const m=model(options);await assert.rejects(read(m),e=>e.status===409,JSON.stringify(options));assert.equal(m.role,'dyna_app');readonly(m);}
});
test('all target orders require final ordinary RLS and fresh identity/context; owner errors restore role and disclose no IDs',async()=>{
 for(const options of [{hiddenPeer:true},{lateIAM:true},{lateRoot:true},{expired:true},{ownerError:true}]){
  const m=model(options);await assert.rejects(read(m));assert.equal(m.role,'dyna_app');readonly(m);
 }
 const m=model(),a=request();await assert.rejects(read(m,{...a}),e=>e.status===401);assert.equal(m.calls.length,0);
});
test('projection SQL keeps101 sentinel,64KiB transfer bounds and exact event3-key/type checks, no private snapshots',async()=>{
 const m=model();await read(m);const owner=m.calls.filter(row=>row.sql.includes('lineage-')&&row.role==='postgres');
 assert(owner.every(row=>!/SELECT \*|request|snapshot|before_frame|after_frame|actor_id|api_key_id/.test(row.sql)));
 assert(owner.filter(row=>/lineage-(targets|events) \*/.test(row.sql)).every(row=>row.sql.includes('LIMIT 101')));
 const event=m.calls.find(row=>row.sql.includes('lineage-events')).sql;assert(event.includes("detail-ARRAY['execution_id','source_order_id','slot_id']='{}'::jsonb"));assert(event.includes("jsonb_typeof(detail->'slot_id')"));assert(event.includes('order_id=ANY($3::uuid[])'));readonly(m);
 const oversized=model({currentEvents:[{x:'x'.repeat(65536)}]});await assert.rejects(read(oversized),e=>e.status===413);assert.equal(oversized.role,'dyna_app');
});
test('real production factory uses tenantTx read admission and does not enlist a write or load cursor secrets',async()=>{
 const m=model();let calls=0;DB.setPort(async(tenantId,fn,options)=>{calls++;assert.equal(tenantId,tenant);assert.deepEqual(options,{wmsAdmission:'read'});return fn(m.c);});
 const result=await T.createOrderSplitTransport().lineage(request(),child);assert.equal(result.lineage.execution_id,execution);assert.equal(calls,1);readonly(m);
});
