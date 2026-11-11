/** Actual cold-inspection function bodies with controlled metadata/IO ports.
 * No missing-module substitute, app, PG, factory or Native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {RELEASE_MIGRATIONS} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
import {RELEASE_COLD_MARKER_SQL,assertReleaseColdMarkers} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs';
// Marker override per release migration: marker<N>, or the legacy spelling the older tests below still use.
const LEGACY_MARKER_KEYS={211:'credit211Marker',212:'woo212Marker',213:'woo213Marker',214:'sync214Marker',215:'crm215Marker',216:'import216Marker',217:'crm217Marker',218:'crm218Marker',219:'crm219Marker',220:'wire220Marker',221:'wire221Marker',222:'split222Marker',223:'reasons223Marker',224:'categories224Marker',225:'deletions225Marker',226:'tax226Marker',227:'nbp227Marker',228:'rodo228Marker',229:'ksef229Marker',230:'invoice230Marker',231:'ksefInvoice231Marker',232:'invoiceCorrections232Marker',233:'fiscalReceipts233Marker'};
const releaseMarkers=config=>Object.fromEntries(RELEASE_MIGRATIONS.map(m=>{const k=['marker'+m.number,LEGACY_MARKER_KEYS[m.number]].find(k=>k&&Object.hasOwn(config,k));return[m.cold.marker+'_present',k?config[k]:config['active'+m.number]===true];}));
const releaseActive=config=>Object.fromEntries(RELEASE_MIGRATIONS.map(m=>[m.cold.key+'_active',Object.hasOwn(config,'active'+m.number)?config['active'+m.number]:false]));
const source=readFileSync(new URL('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs',import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const functionBody=(name,end)=>{const start=source.indexOf('export '+name);assert(start>=0);const finish=end?source.indexOf(end,start):source.length;assert(finish>start);return source.slice(start,finish).replace(/^export /,'');};
const inspectBody=functionBody('async function inspectPackingColdCompartment(owner,extension){');
function fixture(config={}){
 const events=[],contract={migration:{sha256:'a'.repeat(64)},dependency_compilation_pending:false,dependency_compilation:{controlled:true}},raw={records:[{kind:'policy',value:{using:'exact tenant'}}]},projected208={exact_source208:true},projected207={exact_source207:true};
 const extension={schema:'packing189-source-bound-cold-extension/v1',migration_sha256:contract.migration.sha256,source_contract_sha256:hash(JSON.stringify(contract)),dependency_compilation_pending:false,catalogue_only_before_dispatch:true,separate_private_receipt_after_commit:true,global_writer_fence_proven:false};
 class ControlledClient extends EventEmitter{connection=new EventEmitter();async query(sql){
  events.push('markers');for(const name of ['189_packing_required_order_fields','206_return_credit_destinations_history','207_consumer_return_credit','208_consumer_return_credit_guard_dedup','209_order_merge_delivery_inheritance',...RELEASE_MIGRATIONS.map(m=>m.name)])assert(sql.includes("name='"+name+"'"));assert(!/\b(?:BEGIN|COMMIT|ROLLBACK|SET)\b/.test(sql));
  if(config.markerError){this.emit('error',config.markerError);throw Error('secondary controlled query failure');}
  if(config.markerEnd)this.emit('end');this.connection.emit('readyForQuery',{status:config.transactionStatus??'T'});
  const row={migration_present:true,history206_present:true,consumer207_present:true,consumer208_present:true,delivery209_present:true,...releaseMarkers(config),...config.markers};return{rows:config.rows??[row]};
 }}
 const owner=new ControlledClient(),observation={catalogue:raw,context:{root_xid:'2'},migration_sha256:contract.migration.sha256,source_contract_sha256:extension.source_contract_sha256,native_catalogue_sha256:'b'.repeat(64)};
 const active=key=>Object.hasOwn(config,key)?config[key]:true,ports={assert,pg:{Client:ControlledClient},PACKING189_CONTRACT:contract,hash,freeze:value=>value,RELEASE_COLD_MARKER_SQL,assertReleaseColdMarkers,
  observePackingColdCatalogue:async client=>{assert.equal(client,owner);events.push('catalogue');if(config.observeError)owner.emit('error',config.observeError);return observation;},
  projectPackingOrderMergeDelivery209Catalogue:value=>{assert.equal(value,raw);events.push('source209');if(config.project213Error)throw config.project213Error;return{active:active('active209'),catalogue:projected208,...releaseActive(config)};},
  projectReturnCredit208Catalogue:value=>{assert.equal(value,projected208);events.push('source208');return{active:active('active208'),catalogue:projected207};},
  projectReturnCredit207Catalogue:value=>{assert.equal(value,projected207,'Source207 must receive the exact208 inverse, never raw208');events.push('source207');return{active:active('active207'),catalogue:{exact_source205:true}};},
  projectKnownPartialCore203Catalogue:value=>{assert.equal(value,projected208);events.push('source203');return{active:active('active203')};},
  projectHeaderMetadata205Catalogue:value=>{assert.equal(value,projected208);events.push('source205');return{active:active('active205')};},
  projectPartialCommercial204Catalogue:value=>{assert.equal(value,projected208);events.push('source204');return{active:active('active204')};},
  comparePackingCompiledExpectation:(expected,value)=>{assert.equal(expected,contract.dependency_compilation);assert.equal(value,raw,'Full predecessor comparison retains the original full catalogue input');events.push('full-predecessor-compare');if(config.compareError)throw config.compareError;return{equal:true};},
 };
 const inspect=new Function(...Object.keys(ports),inspectBody+'\nreturn inspectPackingColdCompartment;')(...Object.values(ports));return{inspect,owner,extension,events,raw};
}
function closed(model){assert.equal(model.owner.listenerCount('error'),0);assert.equal(model.owner.listenerCount('end'),0);assert.equal(model.owner.connection.listenerCount('readyForQuery'),0);}
test('ordinary cold requires active raw209, then exact208 and207, all prior gates and full comparison before the five markers',async()=>{
 const model=fixture(),value=await model.inspect(model.owner,model.extension);assert.equal(value.authority,false);assert.equal(value.catalogue,model.raw);assert.deepEqual(model.events,['catalogue','source209','source208','source207','source203','source205','source204','full-predecessor-compare','markers']);closed(model);
});
test('inactive or nonboolean209,208 and207 cannot borrow historical readiness or reach full comparison',async()=>{
 for(const key of ['active209','active208','active207'])for(const value of [false,'true',1,null,undefined]){
  const model=fixture({[key]:value});
  await assert.rejects(model.inspect(model.owner,model.extension),new RegExp(key==='active209'?'order-merge-delivery209-exact-current-cold-catalogue-required':key==='active208'?'return-credit208-exact-current-cold-catalogue-required':'return-credit207-exact-current-cold-catalogue-required'));assert.deepEqual(model.events,key==='active209'?['catalogue','source209']:key==='active208'?['catalogue','source209','source208']:['catalogue','source209','source208','source207']);closed(model);
 }
});
test('203,204 and205 gates and the full predecessor comparison remain mandatory after208 projection',async()=>{
 for(const [key,reason]of [['active203','partial203'],['active205','header205'],['active204','partial204']]){const model=fixture({[key]:false});await assert.rejects(model.inspect(model.owner,model.extension),new RegExp(reason));assert(!model.events.includes('full-predecessor-compare'));assert(!model.events.includes('markers'));closed(model);}
 const expected=Error('controlled unrelated policy drift'),model=fixture({compareError:expected});await assert.rejects(model.inspect(model.owner,model.extension),error=>error===expected);assert(!model.events.includes('markers'));closed(model);
});
test('all five markers require stricttrue; missing, false, numeric and string acknowledgements refuse with clean listeners',async()=>{
 for(const [key,reason]of [['migration_present','packing-partial'],['history206_present','return-credit206'],['consumer207_present','return-credit207'],['consumer208_present','return-credit208'],['delivery209_present','order-merge-delivery209']])for(const value of [undefined,false,null,1,'true']){
  const model=fixture({markers:{[key]:value}});await assert.rejects(model.inspect(model.owner,model.extension),new RegExp(reason));closed(model);
 }
 for(const rows of [[],[{},{}]]){const model=fixture({rows});await assert.rejects(model.inspect(model.owner,model.extension));closed(model);}
});
test('marker read remains in the held transaction and primary transport loss never yields a cold receipt',async()=>{
 for(const status of ['I','E']){const model=fixture({transactionStatus:status});await assert.rejects(model.inspect(model.owner,model.extension),/packing-marker-same-held-TX/);closed(model);}
 const original=Error('controlled original owner loss');for(const config of [{observeError:original},{markerError:original}]){const model=fixture(config);await assert.rejects(model.inspect(model.owner,model.extension),error=>error===original);closed(model);}
 const ended=fixture({markerEnd:true});await assert.rejects(ended.inspect(ended.owner,ended.extension),/packing owner ended/);closed(ended);
});
test('source-projected211 additionally requires its real migration marker in the same held transaction',async()=>{
 const good=fixture({active211:true}),result=await good.inspect(good.owner,good.extension);
 assert.equal(result.return_credit211_active,true);assert.equal(good.events.at(-1),'markers');closed(good);
 for(const marker of [undefined,false,null,1,'true']){
  const m=fixture({active211:true,credit211Marker:marker});await assert.rejects(m.inspect(m.owner,m.extension),/return-credit211-migration-marker/);closed(m);
 }
 for(const status of ['I','E']){
  const m=fixture({active211:true,transactionStatus:status});await assert.rejects(m.inspect(m.owner,m.extension),/packing-marker-same-held-TX/);closed(m);
 }
 const stale=fixture({active211:false,credit211Marker:true});await assert.rejects(stale.inspect(stale.owner,stale.extension),/return-credit211-migration-marker/);closed(stale);
});
test('actual compiled-comparison body composes209 before208 and207 and still rejects unrelated full metadata drift',()=>{
 const compareBody=functionBody('function comparePackingCompiledExpectation(expected,actual){','/** Catalogue ONLY.'),events=[],routines=Array.from({length:4},(_,i)=>({key:'public.packing_required_'+i+'()'})),triggers=Array.from({length:3},(_,i)=>({key:'public.t'+i}));
 const dependency={kind:'policy',key:'public.orders.tenant',value:{using:'exact tenant',check:'exact tenant'}},packing=[...routines.map(row=>({kind:'function',key:row.key,value:{}})),...triggers.map(row=>({kind:'trigger',key:row.key,value:{}}))];
 const counts={constraints:1,functions:4,indexes:0,relations:1,columns:1,triggers:3},after207={schema:'controlled',postgres_major:18,scope:['public'],sql_sha256:'b'.repeat(64),counts,records:[...packing,dependency]},raw={records:[...after207.records,{kind:'function',key:'public.return_credit208_fingerprint()',value:{}}],sha256:'c'.repeat(64)},after208={exact207:true},after209={exact208:true};
 const createCandidate=(legacy,program)=>({schema:'packing189-compiled-catalogue-expectation/v1',source_compilation_proven:false,compiler_receipt_sha256:null,source_program_sha256:program,complete_legacy_metadata:structuredClone(legacy)});
 const legacy={schema:after207.schema,postgres_major:18,scope:['public'],sql_sha256:after207.sql_sha256,counts:{...counts,functions:0,triggers:0},records:[dependency]};legacy.sha256=hash(JSON.stringify(legacy));const expected={...createCandidate(legacy,'d'.repeat(64)),source_compilation_proven:true,compiler_receipt_sha256:'e'.repeat(64)};
 const ports={assert,projectPackingOrderMergeDelivery209Catalogue:value=>{assert.equal(value,raw);events.push('source209');return{catalogue:after209};},projectReturnCredit208Catalogue:value=>{assert.equal(value,after209);events.push('source208');return{catalogue:after208};},projectReturnCredit207Catalogue:value=>{assert.equal(value,after208);events.push('source207');return{catalogue:after207};},assertPackingNativeInstallation:value=>{assert.equal(value,after207);events.push('native');return value;},projectPackingWaveLegacyRecords:value=>({records:value.records,removed_functions:0,removed_indexes:0,removed_relations:0,removed_columns:0}),PACKING189_CONTRACT:{routines,triggers},projectMigrationsNullability:records=>({records,removed_constraints:0}),createPackingCompilationCandidate:createCandidate,canonical:value=>value,hash,freeze:value=>value};
 const compare=new Function(...Object.keys(ports),compareBody+'\nreturn comparePackingCompiledExpectation;')(...Object.values(ports));assert.equal(compare(expected,raw).equal,true);assert.deepEqual(events,['source209','source208','source207','native']);
 dependency.value.check='DIFFERENT tenant';assert.throws(()=>compare(expected,raw),/packing-full-compiled-dependency-drift/);
});

test('strict212 marker parity follows exact source activity and keeps every prior gate/listener cleanup',async()=>{
 const good=fixture({active212:true}),result=await good.inspect(good.owner,good.extension);assert.equal(result.local_woo_read212_active,true);assert.equal(good.events.at(-1),'markers');closed(good);
 for(const marker of [undefined,false,null,1,'true']){const m=fixture({active212:true,woo212Marker:marker});await assert.rejects(m.inspect(m.owner,m.extension),/local-woo-read212-migration-marker/);closed(m);}
 for(const activity of [false,undefined,null,1,'true']){const m=fixture({active212:activity,woo212Marker:true});await assert.rejects(m.inspect(m.owner,m.extension),/local-woo-read212-migration-marker/);closed(m);}
 for(const status of ['I','E']){const m=fixture({active212:true,transactionStatus:status});await assert.rejects(m.inspect(m.owner,m.extension),/packing-marker-same-held-TX/);closed(m);}
});

test('213 marker accepts exactly the projected metadata activity in the same held owner transaction',async()=>{
 for(const active213 of [false,true]){const m=fixture({active212:true,active213}),value=await m.inspect(m.owner,m.extension);assert.equal(value.local_woo_read213_active,active213);assert.equal(value.local_woo_read212_active,true);assert.equal(value.authority,false);assert.equal(value.catalogue,m.raw);assert.equal(m.events.at(-1),'markers');closed(m);}
 for(const [active213,woo213Marker]of [[true,false],[false,true]]){const m=fixture({active212:true,active213,woo213Marker});await assert.rejects(m.inspect(m.owner,m.extension),/local-woo-read213-migration-marker/);closed(m);}
});
test('missing or nonboolean213 migration acknowledgements never stand for true or false metadata activity',async()=>{
 for(const active213 of [false,true])for(const marker of [undefined,null,0,1,'true','false',{},[]]){const m=fixture({active212:true,active213,woo213Marker:marker});await assert.rejects(m.inspect(m.owner,m.extension),/local-woo-read213-migration-marker/);assert.equal(m.events.at(-1),'markers');closed(m);}
});
test('partial213 projection cannot reach marker lookup or use an older212 receipt; predecessor drift still refuses',async()=>{
 const original=Error('controlled partial213 complete-descriptor refusal'),m=fixture({active212:true,active213:true,project213Error:original});await assert.rejects(m.inspect(m.owner,m.extension),e=>e===original);assert.deepEqual(m.events,['catalogue','source209']);closed(m);
 const drift=Error('controlled unrelated predecessor mismatch'),n=fixture({active212:true,active213:true,compareError:drift});await assert.rejects(n.inspect(n.owner,n.extension),e=>e===drift);assert(!n.events.includes('markers'));closed(n);
});
test('active213 markers retain owner-TX, primary failure and complete listener cleanup requirements',async()=>{
 for(const transactionStatus of ['I','E']){const m=fixture({active212:true,active213:true,transactionStatus});await assert.rejects(m.inspect(m.owner,m.extension),/packing-marker-same-held-TX/);closed(m);}
 const first=Error('controlled213 owner loss');for(const patch of [{markerError:first},{observeError:first}]){const m=fixture({active212:true,active213:true,...patch});await assert.rejects(m.inspect(m.owner,m.extension),e=>e===first);closed(m);}
});

test('214 full source projection requires the matching strict migration marker, with absent214 predecessor support',async()=>{
 for(const active214 of [false,true]){const m=fixture({active212:true,active213:true,active214}),v=await m.inspect(m.owner,m.extension);assert.equal(v.offer_sync214_active,active214);assert.equal(v.authority,false);closed(m);}
 for(const active214 of [false,true])for(const sync214Marker of [undefined,null,0,1,'true','false',{},[],!active214]){const m=fixture({active212:true,active213:true,active214,sync214Marker});await assert.rejects(m.inspect(m.owner,m.extension),/offer-sync214-migration-marker/);closed(m);}
});

test('215 exact source activity and migration marker agree strictly without borrowing predecessor readiness',async()=>{
 for(const active215 of [false,true]){const m=fixture({active212:true,active213:true,active214:true,active215}),v=await m.inspect(m.owner,m.extension);assert.equal(v.crm215_active,active215);assert.equal(v.authority,false);closed(m);}
 for(const active215 of [false,true])for(const crm215Marker of [undefined,null,0,1,'true','false',{},[],!active215]){const m=fixture({active212:true,active213:true,active214:true,active215,crm215Marker});await assert.rejects(m.inspect(m.owner,m.extension),/crm215-migration-marker/);closed(m);}
});

for(const m of RELEASE_MIGRATIONS.filter(m=>m.number>=216))test(`${m.number} full source projection and held migration marker require exact boolean parity`,async()=>{const N=m.number,label=new RegExp(m.cold.key.replaceAll('_','-')+'-migration-marker');const x=fixture({['active'+N]:true});await x.inspect(x.owner,x.extension);closed(x);for(const v of [undefined,false,null,0,1,'true']){const f=fixture({['active'+N]:true,['marker'+N]:v});await assert.rejects(f.inspect(f.owner,f.extension),label);closed(f);}const f=fixture({['marker'+N]:true});await assert.rejects(f.inspect(f.owner,f.extension),label);closed(f);});

