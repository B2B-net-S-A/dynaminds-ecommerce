/** Actual fixed209 wrapper/normalizer bodies and compiled21+259 descriptors.
 * Structural memberships with controlled IO; no PG, startup or business proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as E,ORDER_MERGE_DELIVERY209_BUSINESS_SOURCE as business} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import {projectOrderMergeDelivery209Catalogue as inverse} from '../tools/parity/order-merge-delivery209-catalogue.mjs';
import {frameOrderMergeDelivery209Comparison} from '../tools/parity/order-merge-delivery209-comparison-framing.mjs';
import {validateRecoverySchema,SCHEMA_VERSION,SQL_SHA256} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {SCOPE} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {SOURCE_SELECTION} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
import {projectReleaseColdChain} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs';
import * as RELEASE_COLD_PROJECTORS from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/release-cold-projectors.mjs';
import {ORDER_MERGE_SNAPSHOT257_SOURCE_CONTRACT as E257} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-snapshot257-source-contract.mjs';
const source=readFileSync(new URL('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs',import.meta.url),'utf8'),normalizerSource=readFileSync(new URL('../server/ordinary-legacy-schema.mjs',import.meta.url),'utf8');
// The later (211..261) owner-ACL contracts of the normalizer list, empty here like 207/208/209.
const successorContractStubs=Object.fromEntries([...normalizerSource.matchAll(/^import \{([A-Z0-9_]+_SOURCE_CONTRACT)\} from/gm)].map(m=>[m[1],{additions:[]}]).filter(([n])=>!/^(RETURN_CREDIT20[78]|ORDER_MERGE_DELIVERY209)_/.test(n)));
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const sha=v=>createHash('sha256').update(v).digest('hex'),id=r=>r.kind+'\0'+r.key;
const historicalBytes=readFileSync(new URL('fixtures/order-merge-delivery209-source21-contract.json.gz',import.meta.url));
assert.equal(historicalBytes.length,2957592);assert.equal(sha(historicalBytes),'9188cfb3d23dabe095fa2af2cd4d91e805aff969f0565518d495169858f6497c');
const historicalDecoded=gunzipSync(historicalBytes,{maxOutputLength:22468966});
assert.equal(historicalDecoded.length,22468966);assert.equal(sha(historicalDecoded),'45c383e6af47e7f3d7ee35e92e91c147094c4bb6b60cd35cbc4a5ab506777bb6');
const E21=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(historicalDecoded));
const counters={schema:'schemas',relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types'};
// A required source208 namespace marker makes inactive14-before validation take
// the strict branch. Other fields here are structural, never compiler evidence.
const returnMarker={kind:'function',key:'public.return_credit208_fingerprint()',value:E.changes.find(r=>r.kind==='function').before};
function seal(records){
 records.sort((a,b)=>id(a)<id(b)?-1:1);const counts={};
 // Reader rejects absent count axes, so obtain its complete shape from Source208.
 const countKeys='relations,indexes,sequences,inheritance,columns,constraints,policies,triggers,unsupported_internal_trigger_when,functions,types,event_triggers,default_acl,roles,role_memberships,extensions,rules,unsupported_relations,unsupported_routines,operators,operator_classes,operator_families,operator_family_operators,operator_family_procedures,access_methods,languages,extension_members,unsupported_ranges,unsupported_operator_shells,unsupported_statistics,unsupported_publications,unsupported_subscriptions,unsupported_collations,unsupported_foreign_servers,unsupported_languages'.split(',');
 for(const key of countKeys)counts[key]=0;counts.schemas=[...SCOPE].sort();for(const r of records)if(r.kind!=='schema')counts[counters[r.kind]]++;
 const body={schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts,records};return{...body,sha256:sha(JSON.stringify(canonical(body)))};
}
function fixture(active=true,contract=E){
 const shape=(kind,key,fields)=>({kind,key,value:Object.fromEntries(fields.split(',').map(k=>[k,k==='acl'?[]:k==='acl_null'?false:null]))});
 const rows=SCOPE.map(key=>({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[]}}));
 for(const key of SOURCE_SELECTION.required_tables)rows.push(shape('relation',key,'owner,kind,persistence,access_method,row_security,force_row_security,replica_identity,partition,partition_bound,partition_key,options,tablespace,acl_null,acl,view'));
 for(const key of SOURCE_SELECTION.required_functions)rows.push(shape('function',key,'owner,language,kind,cost,rows,security_definer,leakproof,strict,returns_set,volatility,parallel,support,variadic,argument_names,argument_modes,arguments,result,defaults,source,binary,config,definition,acl_null,acl'));
 const byId=new Map(rows.map(r=>[id(r),r]));
 for(const c of contract.changes)byId.set(id(c),{kind:c.kind,key:c.key,value:c[active?'after':'before']});
 byId.set(id(returnMarker),returnMarker);if(active)for(const r of contract.additions)byId.set(id(r),r);
 return seal([...byId.values()]);
}
// 257 (after the Source21 fixture was pinned) changes the body of the 209 validation snapshot and reads it back to
// the Source22 body, the only 209 revision of the product; a Source21 snapshot body is neither, so the product chain
// refuses it. The Source21 projector keeps every real compiled inverse and ports 257 with the same identity rule
// bound to the Source21 snapshot record of its own contract.
const snapshot257Key=id(E257.changes[0].before),same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function releaseColdChainFor(contract){
 if(contract===E)return projectReleaseColdChain;
 const snapshot=contract.additions.find(r=>id(r)===snapshot257Key);assert(snapshot&&!same(snapshot,E257.changes[0].before),'Source21 has its own 209 snapshot body');
 const port257=value=>{const row=value.records.find(r=>id(r)===snapshot257Key);
  return row&&same(row,snapshot)?{catalogue:value,active:false,removed_records:0,changed_records:0,mode:'SOURCE257_ABSENT_PREDECESSOR_IDENTITY',authority:false}:RELEASE_COLD_PROJECTORS.projectCompiledOrderMergeSnapshot257Catalogue(value);};
 return original=>projectReleaseColdChain(original,{...RELEASE_COLD_PROJECTORS,projectCompiledOrderMergeSnapshot257Catalogue:port257});
}
function projector(contract=E,runtimeRevision=22){
 const a=source.indexOf('export function projectPackingOrderMergeDelivery209Catalogue(value){'),b=source.indexOf('/** Exact literal189',a);assert(a>0&&b>a);
 const comparison209=frameOrderMergeDelivery209Comparison(contract,runtimeRevision===22?{runtimeRevision:22}:undefined);
 const ports={assert,validateRecoverySchema,projectReleaseColdChain:releaseColdChainFor(contract),comparison209,ORDER_MERGE_DELIVERY209_BUSINESS_SOURCE:business,projectOrderMergeDelivery209Catalogue:inverse,source209Snapshots:new WeakMap(),source209AdditionIds:new Set(contract.additions.map(id))};
 return new Function(...Object.keys(ports),source.slice(a,b).replace(/^export /,'')+'\nreturn projectPackingOrderMergeDelivery209Catalogue;')(...Object.values(ports));
}
test('fixed compiled209 wrapper inverts all21+259 before parent comparison, retaining only immutable representation reuse',()=>{
 const project=projector(),foreign=fixture(),owned=validateRecoverySchema(foreign),result=project(owned);
 assert.equal(result.active,true);assert.equal(result.changed_records,21);assert.equal(result.removed_records,259);assert.equal(result.authority,false);
 assert.equal(result.catalogue.sha256,validateRecoverySchema(fixture(false)).sha256);assert.equal(project(owned),result);assert(Object.isFrozen(result)&&Object.isFrozen(result.removed_counts));
 assert(!Object.isFrozen(foreign));assert.notEqual(project(foreign),result,'Equal foreign snapshots do not acquire the previous owned key');
 const changed=fixture();const changedFunction=changed.records.find(r=>r.key===E.changes.find(c=>c.kind==='function').key);changedFunction.value={...changedFunction.value,source:'tamper'};
 assert.throws(()=>project(seal(changed.records)),/209 complete current successor/);
});
test('actual cold wrapper preserves independently pinned Source21 default14+240 and its full before identity',()=>{
 const project=projector(E21,21),r=project(fixture(true,E21));
 assert.equal(r.changed_records,14);assert.equal(r.removed_records,240);assert.equal(r.authority,false);
 assert.equal(r.catalogue.sha256,validateRecoverySchema(fixture(false,E21)).sha256);
 const owned=validateRecoverySchema(fixture(false,E21)),inactive=project(owned);assert.equal(inactive.active,false);assert.equal(inactive.catalogue,owned);
 // The product chain itself (257 bound to the Source22 body) refuses the Source21 snapshot, and a tampered body still refuses through the port.
 assert.throws(()=>projectReleaseColdChain(validateRecoverySchema(fixture(true,E21))),/257 exact complete changed descriptor:function\0public\.order_merge_delivery209_validation_snapshot\(\)/);
 const tampered=fixture(true,E21).records.map(r=>id(r)===snapshot257Key?{...r,value:{...r.value,source:'tamper'}}:r);
 assert.throws(()=>project(seal(tampered)),/257 exact complete changed descriptor/);
});
test('inactive208 must match all21 exact BEFORE records and cannot borrow a remembered successful projection',()=>{
 const project=projector(),before=fixture(false),owned=validateRecoverySchema(before),result=project(owned);
 assert.equal(result.active,false);assert.equal(result.catalogue,owned);
 const c=E.changes.find(c=>c.kind==='constraint');before.records.find(r=>id(r)===id(c)).value={...c.before,validated:false};
 assert.throws(()=>project(seal(before.records)),/209 absent requires exact21/);
});
test('earlier205/pre205 identity retains every row; partial namespace, composite type, external edge and FK reference refuse',()=>{
 const project=projector(),earlier=fixture(false);earlier.records=earlier.records.filter(r=>id(r)!==id(returnMarker));
 const owned=validateRecoverySchema(seal(earlier.records));assert.equal(project(owned).catalogue,owned);assert.equal(project(owned).active,false);
 const pre205=validateRecoverySchema(seal(earlier.records.filter(r=>r.key!=='public.catalog_header205_valid()')));assert.equal(project(pre205).catalogue,pre205);
 const samples=[E.additions.find(r=>r.kind==='relation'),E.additions.find(r=>r.kind==='type'),E.additions.find(r=>r.kind==='trigger'&&!r.key.includes('public.order_merge_delivery209_')),
 {kind:'constraint',key:'public.orders.renamed_209_reference',value:{...E.changes.find(r=>r.kind==='constraint').before,kind:'f',definition:'FOREIGN KEY (id) REFERENCES public.order_merge_delivery209_receipts(id)'}}];
 for(const row of samples){assert(row);assert.throws(()=>project(seal([...earlier.records,row])),'A partial209 edge cannot take earlier identity');}
});
test('normalizer validates the whole proposed catalogue before GRANT and rolls back drift before or after materialization',async()=>{
 const input=fixture(),target=SOURCE_SELECTION.required_tables.find(k=>k.startsWith('public.'));
 const record=input.records.find(r=>r.kind==='relation'&&r.key===target);record.value={...record.value,owner:'postgres',kind:'r',acl_null:true,acl:[{grantor:'postgres',grantee:'postgres',privilege:'SELECT',grantable:false}]};
 const raw=seal(input.records),targetAfter={...record,value:{...record.value,acl_null:false}},hashes=[[sha(id(record)),sha(JSON.stringify(canonical(targetAfter)))]];
 for(const failureAt of [undefined,0,1]){
  const failure=Error('unrelated policy drift'),events=[],owner={async query(sql){events.push(sql);return{rows:[]};}},after=seal(raw.records.map(r=>id(r)===id(record)?targetAfter:r));let compares=0;
  const ports={assert,canonical,sha,validateRecoverySchema,catalogueDigest:value=>sha(JSON.stringify(canonical(value))),RETURN_CREDIT207_SOURCE_CONTRACT:{additions:[]},RETURN_CREDIT208_SOURCE_CONTRACT:{additions:[]},ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT:{additions:[]},...successorContractStubs,PACKING189_CONTRACT:{dependency_compilation:{object_hashes:hashes}},derivePackingColdIdentity:async c=>{assert.equal(c,owner);events.push('identity');return{owned:true};},readPackingCatalogue:async(c,identity)=>{assert.equal(c,owner);assert.deepEqual(identity,{owned:true});events.push('read');return raw;},observePackingColdCatalogue:async c=>{assert.equal(c,owner);events.push('observe');return{catalogue:after};},comparePackingCompiledExpectation:(expected,value)=>{events.push('compare');assert.equal(value.sha256,after.sha256);if(compares++===failureAt)throw failure;}};
  const a=normalizerSource.indexOf('export async function normalizeOrdinaryLegacyOwnerAcls(owner){'),run=new Function(...Object.keys(ports),normalizerSource.slice(a).replace(/^export /,'')+'\nreturn normalizeOrdinaryLegacyOwnerAcls;')(...Object.values(ports));
  if(failureAt!==undefined)await assert.rejects(run(owner),e=>e===failure);else assert.deepEqual(await run(owner),{owner_default_acls_materialized:1});
  const grant=events.findIndex(e=>e.startsWith('GRANT ')),compare=events.indexOf('compare');assert(compare>events.indexOf('read'));if(failureAt===0){assert.equal(grant,-1);assert(!events.includes('observe'));}else{assert(grant>compare);assert(events.indexOf('observe')>grant);assert.equal(compares,2);}assert.equal(events.at(-1),failureAt===undefined?'COMMIT':'ROLLBACK');
 }
});
test('actual native-installation body checks209 before208/207 and gives the unchanged wave closure only the final predecessor',()=>{
 const a=source.indexOf('export function assertPackingNativeInstallation(value){'),b=source.indexOf('/** Full dependency comparison.',a),events=[];
 const routines=Array.from({length:4},(_,i)=>({key:'public.packing_required_controlled_'+i+'()',argument_names:null,returns:'boolean',volatility:'s',app_execute:false,body_sha256:sha('controlled-'+i)})),triggers=Array.from({length:3},(_,i)=>({key:'public.orders.packing_required_fields_controlled_'+i,name:'packing_required_fields_controlled_'+i,type:7,attributes:[]}));
 const rows=routines.map((e,i)=>({kind:'function',key:e.key,value:{source:'controlled-'+i,argument_names:null,owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:false,leakproof:false,strict:false,returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,argument_modes:null,arguments:'',result:'boolean',defaults:null,binary:null,config:['search_path=pg_catalog, public'],acl_null:false,acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]}}));
 rows.push(...triggers.map(e=>({kind:'trigger',key:e.key,value:{internal:false,name:e.name,enabled:'O',type:e.type,function:'packing_required_fields_guard()',attributes:[],arguments:'',constraint:null,constraint_relation:null,deferrable:false,deferred:false,has_when:false,old_table:null,new_table:null}})));
 const raw={records:rows},s208={},s207={},s205={},ports={assert,hash:sha,PACKING189_CONTRACT:{required_tables:[],routines,triggers},validateRecoverySchema:v=>v,
 projectPackingOrderMergeDelivery209Catalogue:v=>{assert.equal(v,raw);events.push('209');return{catalogue:s208};},projectReturnCredit208Catalogue:v=>{assert.equal(v,s208);events.push('208');return{catalogue:s207};},projectReturnCredit207Catalogue:v=>{assert.equal(v,s207);events.push('207');return{catalogue:s205};},assertPackingWaveDescriptorClosure:v=>{assert.equal(v,s205);events.push('wave');}};
 const install=new Function(...Object.keys(ports),source.slice(a,b).replace(/^export /,'')+'\nreturn assertPackingNativeInstallation;')(...Object.values(ports));
 assert.equal(install(raw),raw);assert.deepEqual(events,['209','208','207','wave']);
 rows[0].value.acl.push({grantor:'postgres',grantee:'dyna_app',privilege:'EXECUTE',grantable:false});assert.throws(()=>install(raw),/packing-source-function-acl/);
});
