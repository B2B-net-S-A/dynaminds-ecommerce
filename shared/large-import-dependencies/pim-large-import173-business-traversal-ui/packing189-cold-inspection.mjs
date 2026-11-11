import{ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT,ORDER_MERGE_DELIVERY209_BUSINESS_SOURCE,ORDER_MERGE_DELIVERY209_SOURCE_ORIGIN}from'./order-merge-delivery209-source-contract.mjs';
import{projectOrderMergeDelivery209Catalogue}from'../../../tools/parity/order-merge-delivery209-catalogue.mjs';
import{frameOrderMergeDelivery209Comparison}from'../../../tools/parity/order-merge-delivery209-comparison-framing.mjs';
import{projectReturnCredit208Catalogue}from'./return-credit208-source-compatibility.mjs';
import * as RELEASE_COLD_PROJECTORS from './release-cold-projectors.mjs';
import {RELEASE_MIGRATIONS} from './migration-manifest.mjs';
import{projectReturnCredit207Catalogue}from'./return-credit207-source-compatibility.mjs';
import{projectHeaderMetadata205Catalogue}from'./header205-source-compatibility.mjs';
import{projectPartialCommercial204Catalogue,projectPartialCommercial204Predecessors}from'./packing204-source-compatibility.mjs';
import{projectKnownPartialCore203Catalogue}from'./packing203-source-compatibility.mjs';
import assert from 'node:assert/strict';
import {projectMigrationsNullability} from './migrations-nullability-compatibility.mjs';
import{assertPackingWaveDescriptorClosure,projectPackingWaveLegacyRecords}from'./packing189-wave-compatibility.mjs';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {Socket} from 'node:net';
import {PACKING_HEADER_SQL} from './packing189-native-header-sql.mjs';
import {PACKING189_CONTRACT} from './packing189-cold-contract.mjs';
import {validateRecoverySchema as validateCompilerV7} from './packing189-v7-compiler-validator.mjs';
import {SCHEMA_VERSION,SQL_SHA256} from './packing189-catalogue-reader.mjs';
import {readPackingCatalogue,derivePackingColdIdentity,inspectPackingCatalogueContext,validateRecoverySchema,compareRecoverySchemas} from './packing189-catalogue-reader.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const freeze=x=>{if(x&&typeof x==='object'){for(const y of Object.values(x))freeze(y);Object.freeze(x);}return x;};
// Keep the ORIGINAL complete21 expectation for the full inverse. Only the
// separate173 predecessor-map representation receives legacy14 plus its stage.
const comparison209=frameOrderMergeDelivery209Comparison(ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT,ORDER_MERGE_DELIVERY209_SOURCE_ORIGIN.runtime_revision===22?{runtimeRevision:22}:undefined);
// Metadata representation reuse, never a Native/IAM/installation verdict.
// Only the reader's owned immutable snapshot is a key; foreign inputs must pass
// the reader again. Earlier205/pre205 identity still faces the full parent compare.
const source209Snapshots=new WeakMap();
const source209AdditionIds=new Set(ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT.additions.map(r=>r.kind+'\0'+r.key));
/** The release cold chain (211..) from the one release migration list: newest first, each compiled inverse
 * receives the catalogue its successor left; a row's activity requires its predecessor's (legacy 211-215 excepted). */
const RELEASE_COLD=Object.freeze(RELEASE_MIGRATIONS.map(m=>Object.freeze({number:m.number,name:m.name,...m.cold,label:m.cold.key.replaceAll('_','-')})));
export function projectReleaseColdChain(original,projectors=RELEASE_COLD_PROJECTORS){
 const steps=new Map();let catalogue=original;
 for(const m of [...RELEASE_COLD].reverse()){const project=projectors[m.project];assert.equal(typeof project,'function','release-cold-projector-missing:'+m.project);const step=project(catalogue);steps.set(m.number,step);catalogue=step.catalogue;}
 for(let i=RELEASE_COLD.length-1;i>0;i--){const m=RELEASE_COLD[i],previous=RELEASE_COLD[i-1];if(m.requires)assert(!steps.get(m.number).active||steps.get(previous.number).active===true,m.label+'-requires'+previous.number);}
 return Object.freeze({catalogue,active:Object.freeze(Object.fromEntries(RELEASE_COLD.map(m=>[m.key+'_active',steps.get(m.number).active])))});
}
/** The marker columns and their parity with the projected activity, one per release migration. */
export const RELEASE_COLD_MARKER_SQL=RELEASE_COLD.map(m=>",EXISTS(SELECT FROM public.migrations WHERE name='"+m.name+"') AS "+m.marker+"_present").join('');
export function assertReleaseColdMarkers(row,successor){for(const m of RELEASE_COLD)assert.equal(row[m.marker+'_present'],successor[m.key+'_active']===true,m.label+'-migration-marker');}
export function projectPackingOrderMergeDelivery209Catalogue(value){
 const original=validateRecoverySchema(value),previous=source209Snapshots.get(original);if(previous)return previous;
 const chain=projectReleaseColdChain(original),owned=chain.catalogue;
 const has209=owned.records.some(r=>source209AdditionIds.has(r.kind+'\0'+r.key)||/^public\._?order_merge_delivery209_/.test(r.key)||(r.kind==='trigger'&&['constraint','constraint_relation','function'].some(k=>typeof r.value[k]==='string'&&/^(?:public\.)?order_merge_delivery209_/.test(r.value[k])))||(r.kind==='constraint'&&typeof r.value.definition==='string'&&/\b(?:public\.)?order_merge_delivery209_/.test(r.value.definition)));
 const hasReturnFamily=owned.records.some(r=>/^public\._?return_credit20[678]_/.test(r.key));
 let result;
 // This branch is intentionally inactive: full205 and earlier comparisons are
 // visited again after207 inversion. Partial209 may NEVER borrow this identity.
 if(!has209&&!hasReturnFamily)result=Object.freeze({catalogue:owned,mode:'earlier205_identity',active:false,removed_records:0,changed_records:0,removed_counts:Object.freeze({relations:0,columns:0,constraints:0,indexes:0,policies:0,triggers:0,functions:0,types:0}),authority:false});
 else result=projectOrderMergeDelivery209Catalogue(owned,comparison209.inverseExpected,{...comparison209.inverseOptions,source209Business:ORDER_MERGE_DELIVERY209_BUSINESS_SOURCE});
 if(has209)assert.equal(result.active,true,'209-partial-namespace-or-external-edge-cannot-be-inactive');
 result=Object.freeze({...result,...chain.active});
 source209Snapshots.set(original,result);return result;
}
/** Exact literal189 source bodies/header/ACL and actual three noninternal triggers.
 * This is deliberately not a table dependency certificate. */
export function assertPackingNativeInstallation(value){
 const x=validateRecoverySchema(value),index=new Map(x.records.map(r=>[r.kind+'\0'+r.key,r.value]));
 for(const key of PACKING189_CONTRACT.required_tables)assert(index.has('relation\0'+key),'packing-required-table');
 const ownFunctions=x.records.filter(r=>r.kind==='function'&&/^public\.packing_required/.test(r.key));
 assert.equal(ownFunctions.length,4,'packing-exact-native-function-roster');
 for(const e of PACKING189_CONTRACT.routines){
  const p=index.get('function\0'+e.key);assert(p,'packing-missing-source-function');
  assert.equal(hash(p.source),e.body_sha256,'packing-source-function-body');
  assert.deepEqual(p.argument_names,e.argument_names,'packing-function-argument-names');
  const expected={owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:false,leakproof:false,strict:false,returns_set:false,volatility:e.volatility,parallel:'u',support:null,variadic:null,argument_modes:null,arguments:e.key.slice(e.key.indexOf('(')+1,-1),result:e.returns,defaults:null,binary:null,config:['search_path=pg_catalog, public'],acl_null:false};
  for(const [key,v] of Object.entries(expected))assert.deepEqual(p[key],v,'packing-source-function-header-'+key);
  const acl=(e.app_execute?['dyna_app','postgres']:['postgres']).map(grantee=>({grantor:'postgres',grantee,privilege:'EXECUTE',grantable:false}));
  assert.deepEqual(p.acl.map(grant=>({...grant})),acl,'packing-source-function-acl');
 }
 const ownTriggers=x.records.filter(r=>r.kind==='trigger'&&!r.value.internal&&r.value.name.startsWith('packing_required_fields_'));
 assert.equal(ownTriggers.length,3,'packing-exact-native-trigger-roster');
 for(const e of PACKING189_CONTRACT.triggers){
  const t=index.get('trigger\0'+e.key);assert(t,'packing-missing-source-trigger');
  const expected={internal:false,name:e.name,enabled:'O',type:e.type,function:'packing_required_fields_guard()',attributes:e.attributes,arguments:'',constraint:null,constraint_relation:null,deferrable:false,deferred:false,has_when:false,old_table:null,new_table:null};
  for(const [key,v]of Object.entries(expected))assert.deepEqual(t[key],v,'packing-source-trigger-'+key);
 }
 assertPackingWaveDescriptorClosure(projectReturnCredit207Catalogue(projectReturnCredit208Catalogue(projectPackingOrderMergeDelivery209Catalogue(x).catalogue).catalogue).catalogue);return x;
}
/** Full dependency comparison. No ignored columns/policies/ACLs/triggers/types.
 * The expectation is the source-owned reviewed compiler artifact, not a caller flag. */
export function comparePackingDependencyCatalogue(expected,actual){
 const left=assertPackingNativeInstallation(expected),right=assertPackingNativeInstallation(actual);
 const result=compareRecoverySchemas(left,right);assert.equal(result.equal,true,'packing-full-source-dependency-drift');return result;
}
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
/** Source-authenticated metadata projection only. No Native call, certificate change or cached guard result.
 * Exact Source204 metadata is inverted before the unchanged C30 projection;
 * whole current3 C30 descriptors must match and the caller retains whole28 equality. */
export function projectPackingOriginal173Predecessors(value){
 assert(value&&typeof value==='object'&&!Array.isArray(value),'packing173-predecessor-object');
 const roster=["allegro_oauth_recovery_guards","b2b_credit_guards","b2b_invoice_guards","buyer_address_guards","catalog_stock_control_guards","catalog_stock_count_guards","catalog_stock_legacy_group_guards","catalog_stock_return_guards","competitor_observation_guards","cooperation171_valid","credit_source_upgrade_valid","fa3_draft_guards","financial_return_guards","financial_return_upgrade_valid","label_print_guards","local_invoice_guards","manual_inventory_off_valid","nested172_valid","operative_delivery_valid","packed_label_print_guards","parcel_physical_wz_valid","pim_dictionary_valid","print_job_guards","product_rule_price_tags_guards","product_rule_schedule_guards","stocktake_adjustment_guards","warehouse_automatic_wz_guards","warehouse_wz_issuer_guards"];
 assert.deepEqual(Object.keys(value).sort(),roster,'packing173-exact28-predecessor-roster');
 const current=projectPartialCommercial204Predecessors(value);
 const fixed=[["buyer_address_guards","390878abaad2515009a8ae2093f8f4f3d1a1c5ede13ad09ec7b846b965de70d1","05189f4743482990fd88f100613472051f5896aea40fcb033b8e7c22290f752a","efd28568cb7d0b997b728ff2b1c521c0446399b1529065715c0be4d30f9f8d81"],["financial_return_upgrade_valid","42700137d0b72c471b62a0faf2b5f58041934ec6dac2f5fa87882069a2342e0f","161443a20b774a89b72cb2153809b87bb1b7ecbcbbc114bc23543e2b3f02d39f","a61c47f909a82678f2594fddccdc2f33248ebcd117f8ef9f041ba21cfb1a7045"],["manual_inventory_off_valid","01b58d1d515fac4efa1bc9813cad2c2325518ae0344c87344a26034b10ab48cc","c1c7f16fb52307653eb53c595b1832742427fec5369736bdf75dd264295311bb","d6b038ff56ebcd5ecce2fa3e62226f6affb275d8c59833fb9b3a9b8c743bc2db"]],c=PACKING189_CONTRACT.wave_predecessor_compatibility;
 assert(c&&c.source_before_after_full_descriptor_inverse===true&&c.old_certificate_rows_not_updated===true,'packing173-source-C30-provenance');
 assert.equal(c.changed_descriptors.length,30,'packing173-exact-C30-roster');
 const project=(name,v)=>{
  const x=Object.fromEntries(["cost","kind","rows","owner","result","strict","defaults","language","parallel","arguments","leakproof","definition","volatility","returns_set","argument_modes","argument_names","security_definer"].map(k=>[k,structuredClone(v[k])]));
  x.signature=name+'()';x.configuration=structuredClone(v.config);
  x.acl=v.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]).sort((a,b)=>{for(let i=0;i<3;i++){if(a[i]<b[i])return-1;if(a[i]>b[i])return 1;}return Number(a[3])-Number(b[3]);});return x;
 };
 const result=structuredClone(current);
 for(const[name,beforeSha,afterSha,beforeDescriptorSha]of fixed){
  const matches=c.changed_descriptors.filter(d=>d.key==='public.'+name+'()');assert.equal(matches.length,1,'packing173-unique-fixed-source-descriptor');const d=matches[0],before=d.header_and_ACL_expected;
  assert.equal(d.before_sha256,beforeSha);assert.equal(d.after_sha256,afterSha);assert.equal(d.before_descriptor_sha256,beforeDescriptorSha);
  assert.equal(hash(JSON.stringify(canonical(before))),beforeDescriptorSha,'packing173-entire-source-before-descriptor');
  assert.equal(before.source,d.before_source);assert.equal(hash(d.before_source),beforeSha);assert.equal(hash(d.after_source),afterSha);
  assert.equal(before.definition.split(d.before_source).length,2,'packing173-source-definition-body-framing');
  const after={...structuredClone(before),source:d.after_source,definition:before.definition.replace(d.before_source,d.after_source)};
  assert.deepEqual(current[name],project(name,after),'packing173-entire-current-fixed-predecessor');
  result[name]=project(name,before);
 }
 return result;
}
/** Only rebinds protocol/query identity for a separately authenticated Source-DDL
 * compiler's original full V7 cut. Every logical descriptor/count is retained.
 * Does not turn that cut into an approved expectation or runtime capability. */
export function rebindCompilerV7Catalogue(value){
 const old=validateCompilerV7(value);const current={schema:SCHEMA_VERSION,postgres_major:old.postgres_major,scope:[...old.scope],sql_sha256:SQL_SHA256,counts:structuredClone(old.counts),records:structuredClone(old.records)};
 const rebound={...current,sha256:hash(JSON.stringify(canonical(current)))};return validateRecoverySchema(rebound);
}
/** Compact complete metadata commitments, produced ONLY as a compilation candidate.
 * Root must separately prove ordered source-DDL compilation + independent review;
 * this producer never mints a runtime handle or declares that provenance proved. */
export function createPackingCompilationCandidate(catalogue,sourceProgramSha){
 const x=validateRecoverySchema(catalogue);assert(/^[a-f0-9]{64}$/.test(sourceProgramSha));
 const object_hashes=x.records.map(r=>[hash(r.kind+'\0'+r.key),hash(JSON.stringify(canonical(r)))]).sort((a,b)=>a[0]<b[0]?-1:1);
 const candidate=freeze({schema:'packing189-compiled-catalogue-expectation/v1',catalogue_schema:x.schema,sql_sha256:x.sql_sha256,postgres_major:x.postgres_major,scope:[...x.scope],counts:structuredClone(x.counts),records:x.records.length,native_catalogue_sha256:x.sha256,object_hashes,source_program_sha256:sourceProgramSha,compiler_receipt_sha256:null,source_compilation_proven:false});
 assert(Buffer.byteLength(JSON.stringify(candidate))<=8388608,'packing-compiled-expectation-byte-bound');return candidate;
}
/** Full logical identity/value equality; no physical OIDs and no ignored axes. */
export function comparePackingCompiledExpectation(expected,actual){
 assert(expected&&expected.schema==='packing189-compiled-catalogue-expectation/v1');
 assert(expected.source_compilation_proven===true&&/^[a-f0-9]{64}$/.test(expected.compiler_receipt_sha256??''),'packing-reviewed-source-compilation-required');
 const checked=assertPackingNativeInstallation(projectReturnCredit207Catalogue(projectReturnCredit208Catalogue(projectPackingOrderMergeDelivery209Catalogue(actual).catalogue).catalogue).catalogue);const wave=projectPackingWaveLegacyRecords(checked);const additions=new Set([...PACKING189_CONTRACT.routines.map(e=>'function\0'+e.key),...PACKING189_CONTRACT.triggers.map(e=>'trigger\0'+e.key)]);
 const nullability=projectMigrationsNullability(wave.records.filter(r=>!additions.has(r.kind+'\0'+r.key)));
 const remaining=nullability.records;assert.equal(checked.records.length-remaining.length,7+wave.removed_functions+wave.removed_indexes+wave.removed_relations+wave.removed_columns+nullability.removed_constraints,'packing-exact-declared-source-additions');
 const legacy={schema:checked.schema,postgres_major:checked.postgres_major,scope:[...checked.scope],sql_sha256:checked.sql_sha256,counts:{...checked.counts,constraints:checked.counts.constraints-nullability.removed_constraints,functions:checked.counts.functions-4-wave.removed_functions,indexes:checked.counts.indexes-wave.removed_indexes,relations:checked.counts.relations-wave.removed_relations,columns:checked.counts.columns-wave.removed_columns,triggers:checked.counts.triggers-3},records:remaining};
 const legacyValue={...legacy,sha256:hash(JSON.stringify(canonical(legacy)))};
 const candidate=createPackingCompilationCandidate(legacyValue,expected.source_program_sha256);
 const {compiler_receipt_sha256,source_compilation_proven,...left}=expected;
 const {compiler_receipt_sha256:unused,source_compilation_proven:unproved,...right}=candidate;
 assert.deepEqual(canonical(left),canonical(right),'packing-full-compiled-dependency-drift');return freeze({equal:true,records:actual.records.length,native_catalogue_sha256:actual.sha256,compiler_receipt_sha256,source_program_sha256:expected.source_program_sha256});
}
/** Catalogue ONLY. Never calls189 candidates, a foreign immutable body,187approve,
 * BEGIN/COMMIT, role setters or any business helper. Caller owns cold TX/closure. */
export async function observePackingColdCatalogue(owner){
 assert(owner instanceof pg.Client,'packing-native-Client-required');const stream=owner.connection?.stream;
 assert(stream instanceof Socket&&!stream.destroyed&&['127.0.0.1','::1'].includes(stream.remoteAddress)&&stream.remotePort===owner.port,'packing-native-loopback-owner');
 let lost=false,first;const poison=e=>{if(!lost){lost=true;first=e??Error('packing owner ended');}},onEnd=()=>poison();
 // Continuous listener custody spans identity-reader handoff, not only one query.
 owner.on('error',poison);owner.on('end',onEnd);
 try{
 const selected=await derivePackingColdIdentity(owner);if(lost)throw first;
 const catalogue=await readPackingCatalogue(owner,selected);if(lost)throw first;assertPackingNativeInstallation(catalogue);
 const header=(await owner.query(PACKING_HEADER_SQL,[JSON.stringify(PACKING189_CONTRACT.routines.map(e=>({identity:e.identity,body_sha256:e.body_sha256,returns:e.returns,volatility:e.volatility,app_execute:e.app_execute,argument_names:e.argument_names})))])).rows;
 if(lost)throw first;assert.equal(header.length,1);assert.equal(header[0].n,4);assert.equal(header[0].present,4);assert.equal(header[0].routines_valid,true,'packing-full-source-native-header');assert.equal(header[0].triggers_valid,true,'packing-full-source-native-trigger');
 const context=inspectPackingCatalogueContext(catalogue);
 assert(typeof context.root_xid==='string'&&/^[1-9][0-9]*$/.test(context.root_xid),'packing-cold-root-XID');
 return freeze({schema:'packing189-cold-observation/v1',catalogue,context,migration_sha256:PACKING189_CONTRACT.migration.sha256,source_contract_sha256:hash(JSON.stringify(PACKING189_CONTRACT)),native_catalogue_sha256:catalogue.sha256,authority:false});
 }catch(e){throw lost?first:e;}finally{owner.removeListener('error',poison);owner.removeListener('end',onEnd);}
}
/** Runtime inspection cannot accept arbitrary serialized expectations. Only a
 * literal source-owned compiler cut in PACKING189_CONTRACT may enable this path. */
export async function inspectPackingColdCompartment(owner,extension){
 assert(extension&&extension.schema==='packing189-source-bound-cold-extension/v1','packing-fixed-source-extension');
 assert.equal(extension.migration_sha256,PACKING189_CONTRACT.migration.sha256,'packing-fixed-source-migration');
 assert.equal(extension.source_contract_sha256,hash(JSON.stringify(PACKING189_CONTRACT)),'packing-fixed-source-contract');
 assert.equal(extension.dependency_compilation_pending,PACKING189_CONTRACT.dependency_compilation_pending,'packing-fixed-source-compilation-state');
 assert.equal(extension.catalogue_only_before_dispatch,true);assert.equal(extension.separate_private_receipt_after_commit,true);assert.equal(extension.global_writer_fence_proven,false);
 assert(owner instanceof pg.Client,'packing-native-Client-required');let lost=false,first;
 const poison=e=>{if(!lost){lost=true;first=e??Error('packing owner ended');}},onEnd=()=>poison();owner.on('error',poison);owner.on('end',onEnd);
 try{
 const observation=await observePackingColdCatalogue(owner);if(lost)throw first;
 assert(PACKING189_CONTRACT.dependency_compilation!==null&&!PACKING189_CONTRACT.dependency_compilation_pending,'packing-full-source-compiled-dependencies-required');
 const successor209=projectPackingOrderMergeDelivery209Catalogue(observation.catalogue);assert.equal(successor209.active,true,'order-merge-delivery209-exact-current-cold-catalogue-required');
 const successor208=projectReturnCredit208Catalogue(successor209.catalogue);assert.equal(successor208.active,true,'return-credit208-exact-current-cold-catalogue-required');
 assert.equal(projectReturnCredit207Catalogue(successor208.catalogue).active,true,'return-credit207-exact-current-cold-catalogue-required');
 assert.equal(projectKnownPartialCore203Catalogue(successor209.catalogue).active,true,'partial203-exact-current-cold-functions-required');
 assert.equal(projectHeaderMetadata205Catalogue(successor209.catalogue).active,true,'header205-exact-current-cold-functions-required');
 assert.equal(projectPartialCommercial204Catalogue(successor209.catalogue).active,true,'partial204-exact-current-cold-functions-required');
 comparePackingCompiledExpectation(PACKING189_CONTRACT.dependency_compilation,observation.catalogue);
 // Marker read is separate and only after complete source-compiled migrations table/RLS/ACL match.
 let status;const ready=m=>{status=m.status;};owner.connection.on('readyForQuery',ready);
 try{const rows=(await owner.query("SELECT EXISTS(SELECT FROM public.migrations WHERE name='189_packing_required_order_fields') AS migration_present,EXISTS(SELECT FROM public.migrations WHERE name='206_return_credit_destinations_history') AS history206_present,EXISTS(SELECT FROM public.migrations WHERE name='207_consumer_return_credit') AS consumer207_present,EXISTS(SELECT FROM public.migrations WHERE name='208_consumer_return_credit_guard_dedup') AS consumer208_present,EXISTS(SELECT FROM public.migrations WHERE name='209_order_merge_delivery_inheritance') AS delivery209_present"+RELEASE_COLD_MARKER_SQL+"")).rows;
 if(lost)throw first;assert.equal(status,'T','packing-marker-same-held-TX');assert.equal(rows.length,1);assert.equal(rows[0].migration_present,true,'packing-partial-migration-marker');
 assert.equal(rows[0].history206_present,true,'return-credit206-migration-marker');assert.equal(rows[0].consumer207_present,true,'return-credit207-migration-marker');assert.equal(rows[0].consumer208_present,true,'return-credit208-migration-marker');assert.equal(rows[0].delivery209_present,true,'order-merge-delivery209-migration-marker');
 assertReleaseColdMarkers(rows[0],successor209);
 }finally{owner.connection.removeListener('readyForQuery',ready);}

 return freeze({...observation,return_credit211_active:successor209.return_credit211_active===true,local_woo_read212_active:successor209.local_woo_read212_active===true,local_woo_read213_active:successor209.local_woo_read213_active===true,offer_sync214_active:successor209.offer_sync214_active===true,crm215_active:successor209.crm215_active===true,inspection_sha256:hash(JSON.stringify({migration:observation.migration_sha256,source:observation.source_contract_sha256,catalogue:observation.native_catalogue_sha256,context:observation.context})),authority:false});
 }catch(e){throw lost?first:e;}finally{owner.removeListener('error',poison);owner.removeListener('end',onEnd);}
}
