/** Actual tenantTx/runDurableWorker bodies + real registry/finalizer/drain.
 * Controlled dependencies do NOT mint a genuine PG lease or certify Native. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createServer,transformWithOxc} from 'vite';
import path from 'node:path';
const db=readFileSync(new URL('../server/db.ts',import.meta.url),'utf8');
const epoch=readFileSync(new URL('../server/large-import/durable-original-epoch.ts',import.meta.url),'utf8');
async function body(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert(a>=0&&b>a);return(await transformWithOxc(source.slice(a,b),'controlled-managed-tail.ts')).code.replace(/^export /,'');}
const tenantJs=await body(db,'export async function tenantTx<','\nexport async function migrate(');
const workerJs=await body(epoch,'export function runDurableWorker187<','\n/** Logical poison');
const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
const R=await vite.ssrLoadModule(path.resolve('server/order-split-transaction.ts'));
const Transport=await vite.ssrLoadModule(path.resolve('server/order-split-transport.ts'));
const {drainPublicConstraintsInTx}=await vite.ssrLoadModule(path.resolve('server/public-constraint-drain.ts'));
const {fa3DraftOwnerInTx}=await vite.ssrLoadModule(path.resolve('server/fa3-draft-access.ts'));
const {assertDbLocksHeldInTx}=await vite.ssrLoadModule(path.resolve('server/db-lock-holder.ts'));
await vite.close();
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
function harness(durable=false,options={}){
 const events=[],queries=[];let role='postgres',tenant='',active=false,ended=false;
 const response=rows=>({rows,rowCount:rows.length});
 const c={release(destroy){events.push('release:'+!!destroy);assert(!R.hasOrderSplitTransactionDuty(c),'outer cleanup before pool release');},async query(sql,args=[]){
  queries.push({sql,role});events.push('q:'+sql);
  if(sql.startsWith('BEGIN')){active=true;return response([]);}
  if(sql==='COMMIT'||sql==='ROLLBACK'){
   assert(active);if(options.commitLost&&sql==='COMMIT')throw Error('ACK_LOST');
   if(options.duty!==false)assert(R.hasOrderSplitTransactionDuty(c),'duty survives until actual outer termination');
   active=false;ended=true;return response([]);
  }
  if(sql==='SET LOCAL ROLE dyna_app'){role='dyna_app';return response([]);}
  if(sql==='RESET ROLE'){role='postgres';return response([]);}
  if(sql.startsWith("SELECT set_config('app.tenant_id'")){tenant=args[0];return response([]);}
  if(sql.startsWith('SET LOCAL statement_timeout'))return response([]);
  if(sql.includes('ordinary187_enter('))return response([{value:{backend_pid:55,xid:'100'}}]);
  if(sql.includes('ordinary187_seal(')){assert(R.hasOrderSplitTransactionDuty(c)||options.duty===false);if(options.sealError)throw Error('SEAL_DENIED');return response([]);}
  if(sql.includes('FROM pg_catalog.pg_constraint'))return response([{schema_name:'public',constraint_name:'order_split210_complete'}]);
  if(sql.startsWith('SET CONSTRAINTS')){
   assert.equal(role,durable?'postgres':'dyna_app');
   if(options.drainError&&(sql.includes('ordinary187_private')===options.privateDrain))throw Error('DRAIN_DENIED');
   return response([]);
  }
  if(sql.includes('split210:context'))return response([{role,owner:'postgres',tenant,root:'100',started:'now',pid:'55',read_only:'off'}]);
  if(sql.includes('buyer_address_identity(')){assert(!events.includes('native-finished'),'no postclock IAM');return response([{proof:{role:'operator',account_version:'1'}}]);}
  if(sql.includes('pg_get_userbyid(relowner)'))return response([{role,owner:'postgres',tenant,root:'100',started:'now',relation_owner:'postgres'}]);
  if(sql.includes('order_split210_finalize(')){
   assert.equal(role,'postgres');if(options.nativeError){const e=Error('PRIVATE_NATIVE');e.code='28000';throw e;}
   events.push('native-finished');return response([{order_split210_finalize:''}]);
  }
  assert.fail('Unexpected same-client query '+sql);
 }};
 const gate={async reserve(client){assert.equal(client,c);assert.equal(active,false);events.push('reserve');return{async enter(){assert(active);events.push('enter');},async close(){assert(ended||!active);events.push('lease-close');}};}};
 const owner={pending:new Set(),state:'open',database:'controlled',port:57081,gate,journal:{},parent:{},control:{},root:'root',epoch:'1',originalId:id(10),originalToken:'controlled'};
 const tainted=new WeakSet(),acknowledgedDurableWorkerRollbacks187=new WeakMap();
 const workerPorts={original:()=>owner,busy:new WeakSet(),tainted,current:()=>events.push('original-current'),identity:async()=>({pid:55,backend_start:'start'}),journal:async(x,mode,fn)=>{
  return fn({async query(sql){events.push('journal:'+sql);return response([]);}});
 },randomUUID,token:()=> 'controlled',assert,workerFrames:new AsyncLocalStorage(),hasOrderSplitTransactionDuty:R.hasOrderSplitTransactionDuty,fa3DraftOwnerInTx,drainPublicConstraintsInTx,finalizeOrderSplitTransactionInTx:R.finalizeOrderSplitTransactionInTx,acknowledgedDurableWorkerRollbacks187};
 const worker=new Function(...Object.keys(workerPorts),workerJs+';return runDurableWorker187;')(...Object.values(workerPorts));
 const ports={pool:{async connect(){events.push('connect');return c;}},ordinarySchemaGate:gate,originalTenantPoolClients187:new WeakMap(),activeManagedSchemaTransactions:new WeakMap(),acknowledgedTenantRollbacks:new WeakMap(),
  runBoundDurableTenantTransaction187:(client,tenantId,work)=>durable?worker({},client,'growth',work):undefined,
  hasAcknowledgedDurableWorkerRollback187:(e,client)=>acknowledgedDurableWorkerRollbacks187.get(e)===client,isDurableWorkerClientTainted187:client=>tainted.has(client),
  beginActiveManagedSchemaTransaction:async()=>{assert(active);events.push('managed-begin');},...R,drainPublicConstraintsInTx,assertDbLocksHeldInTx,
  // Composition policy/getters have their own real-module tests. This port
  // tests that the actual manager checks the policy before ANY sibling tail.
  assertOrderSplitCompositionInTx:client=>{assert.equal(client,c);events.push('split-composition');if(options.mixedDuty){const e=Error('MIXED_SPLIT_DUTY');e.status=409;throw e;}}};
 const names=[...new Set([...tenantJs.matchAll(/\b((?:begin|end|prepare|finalize|preflight)[A-Z]\w+|wmsLotsAdmissionInTx|purchasingSourceAdmissionInTx|purchasingStockAdmissionInTx|catalogStockControlAdmissionInTx)\(/g)].map(m=>m[1]))];
 for(const name of names)if(!(name in ports))ports[name]=async()=>{events.push(name);return false;};
 const tenantTx=new Function(...Object.keys(ports),tenantJs+';return tenantTx;')(...Object.values(ports));
 const a=Transport.captureOrderSplitRequest({actor:{tenantId:id(1),userId:id(2),role:'operator',source:'manual'},currentUser:{id:id(2),tenant_id:id(1),role:'operator'},headers:{},cookies:{dyna_session:'PRIVATE_REAL_CAPTURE'}},'dyna_session',{readOnly:false});
 return{c,events,queries,run:()=>tenantTx(id(1),async client=>{
  assert.equal(client,c);assert(active);events.push('business-body');
  if(options.duty!==false)R.enlistOrderSplitTransaction(c,a,options.kind??'preview',id(3));
  if(options.bodyError)throw Error('BODY_DENIED');return 'original-result';
 }),held:()=>R.hasOrderSplitTransactionDuty(c)};
}
const index=(h,s)=>h.events.findIndex(v=>v.includes(s));
for(const durable of [false,true]){
 test(`${durable?'durable':'ordinary'} actual manager completes all siblings/drains before the real split finalizer and COMMIT`,async()=>{
  for(const kind of ['preview','execute']){
   const h=harness(durable,{kind});assert.equal(await h.run(),'original-result');
   assert(index(h,'enter')<index(h,'managed-begin'));assert(index(h,'managed-begin')<index(h,'business-body'));
   assert(index(h,'business-body')<index(h,'split-composition'));assert(index(h,'split-composition')<index(h,'preparePimTransactionInTx'));
   const endSibling=index(h,'finalizeMiraklSessionAuthoritiesInTx'),drain=index(h,'SET CONSTRAINTS "public"'),final=index(h,'order_split210_finalize('),commit=index(h,'q:COMMIT');
   assert(endSibling<drain&&drain<final&&final<commit,'actual outer ordering, including public drain when PIM not started');
   if(durable){assert(index(h,'ordinary187_seal(')<drain);assert(drain<index(h,'SET CONSTRAINTS ordinary187_private.ordinary187_context_final IMMEDIATE'));assert(index(h,'ordinary187_context_final IMMEDIATE')<final);}
   else assert(!h.queries.some(q=>q.sql.includes('ordinary187_')));
   const tail=h.queries.slice(h.queries.findIndex(q=>q.sql.includes('order_split210_finalize('))+1);
   assert(tail.every(q=>q.sql==='COMMIT'||q.sql==='SET LOCAL ROLE dyna_app'||q.sql.startsWith("SELECT set_config('app.tenant_id'")||q.sql.includes('split210:context')));
   assert.equal(h.held(),false);assert(index(h,'q:COMMIT')<index(h,'lease-close'));
  }
 });
 test(`${durable?'durable':'ordinary'} mixed split duty refuses before any sibling prepare/clock, seal, drain or COMMIT`,async()=>{
  const h=harness(durable,{mixedDuty:true});await assert.rejects(h.run(),e=>e.status===409);
  assert(h.events.includes('split-composition'));assert(h.events.includes('q:ROLLBACK'));
  assert(!h.events.some(e=>e.startsWith('prepare')||e.startsWith('finalize')));
  assert(!h.queries.some(q=>q.sql.includes('ordinary187_seal(')||q.sql.startsWith('SET CONSTRAINTS')||q.sql.includes('order_split210_finalize(')||q.sql==='COMMIT'));
  assert.equal(h.held(),false);
 });
 test(`${durable?'durable':'ordinary'} body/drain/finalizer failures roll back without retry and retain duty through rollback`,async()=>{
  const cases=[{bodyError:true},{drainError:true,privateDrain:false},{nativeError:true},...(durable?[{drainError:true,privateDrain:true},{sealError:true}]:[])];
  for(const options of cases){
   const h=harness(durable,options);await assert.rejects(h.run());
   assert(!h.events.includes('q:COMMIT'));assert(h.events.includes('q:ROLLBACK'));assert.equal(h.held(),false);
   assert(h.queries.filter(q=>q.sql.includes('order_split210_finalize(')).length<=1);
  }
 });
 test(`${durable?'durable':'ordinary'} unrelated transaction skips split finalizer and extra public/private drains`,async()=>{
  const h=harness(durable,{duty:false});assert.equal(await h.run(),'original-result');
  assert(!h.queries.some(q=>q.sql.includes('order_split210_finalize(')||q.sql.startsWith('SET CONSTRAINTS')));assert.equal(h.held(),false);
 });
 test(`${durable?'durable':'ordinary'} lost COMMIT ACK never repeats split command/finalizer`,async()=>{
  const h=harness(durable,{commitLost:true});await assert.rejects(h.run(),/ACK_LOST/);
  assert.equal(h.queries.filter(q=>q.sql==='COMMIT').length,1);assert.equal(h.queries.filter(q=>q.sql.includes('order_split210_finalize(')).length,1);assert.equal(h.held(),false);
 });
}
