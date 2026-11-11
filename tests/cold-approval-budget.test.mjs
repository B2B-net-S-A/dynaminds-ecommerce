/** Unit sequencing and failure cleanup of the actual activation function body.
 * All native/IO inspections are controlled ports. No real Startup handle, PG,
 * factory, provider call or readiness evidence is created by these tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/profile-startup.mjs',import.meta.url),'utf8');
const start=source.indexOf('export async function activateRuntimeGeneration(owner,handle){');
const end=source.indexOf('\nasync function inspectKeeperSchemaExtension(',start);
assert(start>=0&&end>start,'actual activation body must be present');
const body=source.slice(start,end).replace(/^export /,'');
assert.equal((body.match(/async function activateRuntimeGeneration\(/g)||[]).length,1);
function fixture({failure,failFinalEvidence=false}={}){
 const events=[],context={database:'controlled',backend_pid:1,root_xid:'2',generation:'3'},generation={generation:'3',profile_native_sha256:'a'.repeat(64)};
 const state={manifestSha:'b'.repeat(64),kind:'portable',input:{compatibility:{packing_required_field_extension:{},durable_writer_epoch_extension:{migration_sha256:'c'.repeat(64)}}}};
 const handle=Object.freeze({test_only:true}),handles=new WeakMap([[handle,state]]),activationBusy=new WeakSet(),activationOwners=new WeakSet(),activationFailures=new WeakSet();
 const names=['ordinaryInstallationCuts','ordinaryOrderReadCuts','schemaGenerations','consumerInspections','keeper198Inspections','packingInspections'];
 const maps=Object.fromEntries(names.map(name=>[name,new WeakMap()]));
 let timeout='8s',lockTimeout='8s',inTransaction=false,aborted=false,approvalAttempted=false,committed=false,verifications=0;
 const primary=Object.assign(new Error('controlled primary failure'),{code:'57014'}),secondary=Error('controlled cleanup failure');
 const owner={query:async(sql,args)=>{
  events.push({kind:'sql',sql,timeout,lockTimeout,args});
  if(sql==='ROLLBACK'){inTransaction=false;aborted=false;timeout='8s';lockTimeout='8s';return{rows:[]};}
  if(aborted)throw Error('25P02: no query may follow failed SQL before rollback');
  if(sql==='BEGIN ISOLATION LEVEL READ COMMITTED'){inTransaction=true;return{rows:[]};}
  if(sql==="SET LOCAL statement_timeout TO '120s'"){
   if(failure==='raise-budget'&&verifications===2){aborted=true;throw primary;}
   timeout='120s';return{rows:[]};
  }
  if(sql==="SET LOCAL statement_timeout TO '8s'"){
   if(failure==='restore-budget'&&approvalAttempted){aborted=true;throw primary;}
   timeout='8s';return{rows:[]};
  }
  if(sql==="SET LOCAL lock_timeout TO '8s'"){lockTimeout='8s';return{rows:[]};}
  if(sql.startsWith('SELECT public.ordinary187_approve(')){
   approvalAttempted=true;assert(inTransaction);assert.equal(timeout,'120s');assert.equal(lockTimeout,'8s');
   assert.deepEqual(args,[state.manifestSha,state.input.compatibility.durable_writer_epoch_extension.migration_sha256,generation.profile_native_sha256]);
   if(failure==='approve'){aborted=true;throw primary;}return{rows:[{generation}]};
  }
  if(sql==='CONSUMER_CLOSING'||sql==='KEEPER_CLOSING'){assert.equal(timeout,'8s');return{rows:[context]};}
  if(sql.startsWith('SELECT current_database() database')){assert.equal(timeout,'8s');return{rows:[context]};}
  if(sql==='COMMIT'){assert.equal(timeout,'8s');committed=true;inTransaction=false;timeout='8s';return{rows:[]};}
  if(sql.includes('buyer_address_available')||sql.includes('catalog_stock_control_guards'))return{rows:[{valid:true}]};
  return{rows:[]};
 }};
 const event=(name,result)=>async()=>{events.push({kind:name,timeout,lockTimeout});return result;};
 const ports={assert,privateState:h=>{assert(handles.has(h));return handles.get(h);},coldEnabled:()=>true,
  activationBusy,activationOwners,activationFailures,...maps,
  verifyEvidence:async()=>{verifications++;events.push({kind:'evidence',timeout,lockTimeout});if(failFinalEvidence&&verifications===3)throw secondary;},
  requireIdleActivationOwner:event('idle'),inspectKeeperResourceDescriptors198:event('keeper-descriptors',{}),
  inspectPackingColdCompartment:async()=>{events.push({kind:'packing',timeout,lockTimeout});assert.equal(timeout,'8s');return{context};},
  inspectDurableWriterEpochDescriptors:event('durable-descriptors'),
  inspectComparedProfile:async()=>{events.push({kind:'profile',timeout,lockTimeout});assert.equal(timeout,'120s');return{profile_native_sha256:generation.profile_native_sha256};},
  inspectOrdinarySchemaExtension:event('ordinary-schema'),ORDER_READ_INSTALLATION_SEALS:Object.freeze(['controlled_order_read']),readInstallationCut:async(_owner,lock)=>{events.push({kind:lock?'installation':'installation-closing',timeout,lockTimeout});if(!lock)assert.equal(timeout,'8s');return{controlled:true,cut:{seals:{}}};},
  // 248: the seal identity is read beside each cut (same budget) and again at the close (8s, like the closing cuts).
  readInstallationIdentity:async(_owner,lock)=>{events.push({kind:lock?'identity':'identity-closing',timeout,lockTimeout});if(!lock)assert.equal(timeout,'8s');return Object.freeze([]);},
  inspectKeeperSchemaExtension:event('keeper-schema'),inspectCoreReviewAliasExtension:event('review-alias'),
  inspectDurableWriterEpochExtension:event('durable-extension'),inspectKeeperResourceExtension198:event('keeper-extension',{context}),
  inspectConsumerCreditExtension:event('consumer-extension',{context}),assertGeneration:(_state,g)=>assert.deepEqual(g,generation),
  consumerContextSql:'CONSUMER_CLOSING',keeper198ContextSql:'KEEPER_CLOSING',
  inspectConsumerReceipt:()=>({controlled:true}),inspectKeeperResourceReceipt198:()=>({controlled:true}),inspectPackingReceipt:()=>({controlled:true})};
 const activate=new Function(...Object.keys(ports),body+'\nreturn activateRuntimeGeneration;')(...Object.values(ports));
 return{activate,owner,handle,state,events,primary,secondary,maps,activationBusy,activationOwners,activationFailures,
  get committed(){return committed;},get timeout(){return timeout;},get lockTimeout(){return lockTimeout;},get inTransaction(){return inTransaction;}};
}
function assertRollback(x){
 assert.equal(x.committed,false);assert.equal(x.inTransaction,false);assert.equal(x.timeout,'8s');assert.equal(x.lockTimeout,'8s');
 assert.equal(x.events.filter(e=>e.sql==='ROLLBACK').length,1);assert(!x.events.some(e=>e.sql==='COMMIT'||e.sql==='CONSUMER_CLOSING'||e.sql==='KEEPER_CLOSING'));
 assert.equal(x.activationBusy.has(x.state),false);assert.equal(x.activationOwners.has(x.owner),false);assert.equal(x.activationFailures.has(x.state),true);
 for(const map of Object.values(x.maps))assert.equal(map.has(x.state),false);
}

test('only actual owner approval receives finite120s and normal8s resumes before closing reads/commit',async()=>{
 const x=fixture(),result=await x.activate(x.owner,x.handle);assert(x.committed);assert.equal(result.integrity_cadence,'EXPLICIT_OWNER_COLD_VALIDATION_COMMITTED');
 const a=x.events.findIndex(e=>e.sql?.startsWith('SELECT public.ordinary187_approve('));assert(a>0);
 assert.equal(x.events[a-1].sql,"SET LOCAL statement_timeout TO '120s'");assert.equal(x.events[a+1].sql,"SET LOCAL statement_timeout TO '8s'");
 const evidence=x.events.slice(0,a).filter(e=>e.kind==='evidence').at(-1);assert.equal(evidence.timeout,'8s');
 assert.deepEqual(x.events.filter(e=>e.sql?.startsWith('SET LOCAL lock_timeout')).map(e=>e.sql),["SET LOCAL lock_timeout TO '8s'"]);
 assert.equal(x.activationFailures.has(x.state),false);assert.equal(x.activationBusy.has(x.state),false);assert.equal(x.activationOwners.has(x.owner),false);
 for(const map of Object.values(x.maps))assert.equal(map.has(x.state),true);
});

test('approve timeout rolls back once, preserves first failure through cleanup and poisons handle without retry',async()=>{
 const x=fixture({failure:'approve',failFinalEvidence:true});await assert.rejects(x.activate(x.owner,x.handle),e=>e===x.primary);assertRollback(x);
 const a=x.events.findIndex(e=>e.sql?.startsWith('SELECT public.ordinary187_approve('));assert.equal(x.events[a+1].sql,'ROLLBACK');
 const count=x.events.length;await assert.rejects(x.activate(x.owner,x.handle),/cold-activation-handle-failed/);assert.equal(x.events.length,count);
});

test('failure restoring8s after approval prevents all closing reads and rolls back native approval',async()=>{
 const x=fixture({failure:'restore-budget'});await assert.rejects(x.activate(x.owner,x.handle),e=>e===x.primary);assertRollback(x);
 assert.equal(x.events.filter(e=>e.sql?.startsWith('SELECT public.ordinary187_approve(')).length,1);
 const a=x.events.findIndex(e=>e.sql?.startsWith('SELECT public.ordinary187_approve('));assert.equal(x.events[a+1].sql,"SET LOCAL statement_timeout TO '8s'");assert.equal(x.events[a+2].sql,'ROLLBACK');
});

test('failure applying finite approval budget rolls back without dispatching approval or closing reads',async()=>{
 const x=fixture({failure:'raise-budget'});await assert.rejects(x.activate(x.owner,x.handle),e=>e===x.primary);assertRollback(x);
 assert(!x.events.some(e=>e.sql?.startsWith('SELECT public.ordinary187_approve(')));
});
