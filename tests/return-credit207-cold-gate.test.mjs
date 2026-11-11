/** Actual cold-inspection function body with controlled metadata/IO ports.
 * No PostgreSQL, native handle, factory, migration or acceptance proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {RELEASE_MIGRATIONS} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
import {RELEASE_COLD_MARKER_SQL,assertReleaseColdMarkers} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs';
const source=readFileSync(new URL('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs',import.meta.url),'utf8');
const start=source.indexOf('export async function inspectPackingColdCompartment(owner,extension){');assert(start>=0);
const body=source.slice(start).replace(/^export /,'');
const hash=v=>createHash('sha256').update(v).digest('hex');
// active<N> is the projected activity of release migration N (default false); its marker follows it unless markers overrides.
function fixture(options={}){
 const {active207=true,markers={},transactionStatus='T'}=options,act=n=>options['active'+n]??false;
 const events=[],C={migration:{sha256:'a'.repeat(64)},dependency_compilation_pending:false,dependency_compilation:{test_only:true}};
 const extension={schema:'packing189-source-bound-cold-extension/v1',migration_sha256:C.migration.sha256,source_contract_sha256:hash(JSON.stringify(C)),dependency_compilation_pending:false,catalogue_only_before_dispatch:true,separate_private_receipt_after_commit:true,global_writer_fence_proven:false};
 class ControlledClient extends EventEmitter{connection=new EventEmitter();async query(sql){events.push('markers');assert(sql.includes("name='206_return_credit_destinations_history'"));assert(sql.includes("name='207_consumer_return_credit'"));assert(sql.includes("name='208_consumer_return_credit_guard_dedup'"));assert(sql.includes("name='209_order_merge_delivery_inheritance'"));assert(sql.includes("name='212_local_woo_read_lane'"));assert(sql.includes("name='213_local_woo_read_reconciliation'"));for(const m of RELEASE_MIGRATIONS)assert(sql.includes("name='"+m.name+"'"));this.connection.emit('readyForQuery',{status:transactionStatus});return{rows:[{migration_present:true,history206_present:true,consumer207_present:true,consumer208_present:true,delivery209_present:true,...Object.fromEntries(RELEASE_MIGRATIONS.map(m=>[m.cold.marker+'_present',act(m.number)===true])),...markers}]};}}
 const owner=new ControlledClient(),observation={catalogue:{controlled:true},context:{root_xid:'2'},migration_sha256:C.migration.sha256,source_contract_sha256:extension.source_contract_sha256,native_catalogue_sha256:'b'.repeat(64)};
 const projected208={controlled:'exact209inverse'},projected207={controlled:'exact208inverse'},ports={assert,pg:{Client:ControlledClient},PACKING189_CONTRACT:C,hash,freeze:x=>x,RELEASE_COLD_MARKER_SQL,assertReleaseColdMarkers,
  observePackingColdCatalogue:async c=>{assert.equal(c,owner);events.push('catalogue');return observation;},
  projectPackingOrderMergeDelivery209Catalogue:value=>{assert.equal(value,observation.catalogue);events.push('source209');return{active:true,catalogue:projected208,...Object.fromEntries(RELEASE_MIGRATIONS.map(m=>[m.cold.key+'_active',act(m.number)]))};},
  projectReturnCredit208Catalogue:value=>{assert.equal(value,projected208);events.push('source208');return{active:true,catalogue:projected207};},
  projectReturnCredit207Catalogue:value=>{assert.equal(value,projected207);events.push('source207');return{active:active207};},
  projectKnownPartialCore203Catalogue:()=>({active:true}),projectHeaderMetadata205Catalogue:()=>({active:true}),projectPartialCommercial204Catalogue:()=>({active:true}),
  comparePackingCompiledExpectation:()=>{events.push('full-predecessor-compare');return{equal:true};}};
 const inspect=new Function(...Object.keys(ports),body+'\nreturn inspectPackingColdCompartment;')(...Object.values(ports));
 return{inspect,owner,extension,events};
}
function closed(x){assert.equal(x.owner.listenerCount('error'),0);assert.equal(x.owner.listenerCount('end'),0);assert.equal(x.owner.connection.listenerCount('readyForQuery'),0);}
test('ordinary cold requires projected exact207 after208 before full comparison and all five installed markers',async()=>{
 const x=fixture(),result=await x.inspect(x.owner,x.extension);assert.equal(result.authority,false);assert.deepEqual(x.events,['catalogue','source209','source208','source207','full-predecessor-compare','markers']);closed(x);
});
test('absent/partial207 cannot become ordinary ready using a valid historical205 predecessor',async()=>{
 const x=fixture({active207:false});await assert.rejects(x.inspect(x.owner,x.extension),/return-credit207-exact-current-cold-catalogue-required/);assert.deepEqual(x.events,['catalogue','source209','source208','source207']);closed(x);
});
test('each absent migration marker refuses cold readiness and closes listeners',async()=>{
 for(const[name,reason]of [['migration_present','packing-partial-migration-marker'],['history206_present','return-credit206-migration-marker'],['consumer207_present','return-credit207-migration-marker'],['consumer208_present','return-credit208-migration-marker'],['delivery209_present','order-merge-delivery209-migration-marker']]){
  const x=fixture({markers:{[name]:false}});await assert.rejects(x.inspect(x.owner,x.extension),new RegExp(reason));closed(x);
 }
});
test('marker read must remain in the same open owner transaction',async()=>{
 const x=fixture({transactionStatus:'I'});await assert.rejects(x.inspect(x.owner,x.extension),/packing-marker-same-held-TX/);closed(x);
});

test('212 source projection and migration marker must agree strictly, without changing earlier207 gates',async()=>{
 const absent=fixture();const old=await absent.inspect(absent.owner,absent.extension);assert.equal(old.local_woo_read212_active,false);closed(absent);
 const active=fixture({active212:true});const current=await active.inspect(active.owner,active.extension);assert.equal(current.local_woo_read212_active,true);closed(active);
 for(const marker of [undefined,false,null,1,'true']){const x=fixture({active212:true,markers:{woo212_present:marker}});await assert.rejects(x.inspect(x.owner,x.extension),/local-woo-read212-migration-marker/);closed(x);}
 const stale=fixture({markers:{woo212_present:true}});await assert.rejects(stale.inspect(stale.owner,stale.extension),/local-woo-read212-migration-marker/);closed(stale);
});

for(const m of RELEASE_MIGRATIONS.filter(m=>m.number>=213))test(`${m.number} exact metadata activity requires a strict matching marker`,async()=>{const N=m.number,key=m.cold.marker+'_present',label=new RegExp(m.cold.key.replaceAll('_','-')+'-migration-marker');const x=fixture({['active'+N]:true});await x.inspect(x.owner,x.extension);closed(x);for(const marker of [undefined,false,null,1,'true']){const f=fixture({['active'+N]:true,markers:{[key]:marker}});await assert.rejects(f.inspect(f.owner,f.extension),label);closed(f);}const f=fixture({markers:{[key]:true}});await assert.rejects(f.inspect(f.owner,f.extension),label);closed(f);});


