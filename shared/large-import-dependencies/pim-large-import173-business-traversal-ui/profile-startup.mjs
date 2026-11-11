import{prepareDurable187Descriptor204Sql}from'./durable187-descriptor204-compatibility.mjs';
/** Source-only integration draft. Ordinary module evaluation loads no historical source compiler. */
import assert from 'node:assert/strict';
import {inspectPackingColdCompartment,projectPackingOriginal173Predecessors} from './packing189-cold-inspection.mjs';
import {projectOrderMergeDelivery209Predecessors} from '../../../tools/parity/order-merge-delivery209-metadata.mjs';
import {frameOrderMergeDelivery209Comparison} from '../../../tools/parity/order-merge-delivery209-comparison-framing.mjs';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as E209,ORDER_MERGE_DELIVERY209_SOURCE_ORIGIN as E209_ORIGIN} from './order-merge-delivery209-source-contract.mjs';
import {assertOrdinary177Contract} from './ordinary177-contract.mjs';
import {createHash} from 'node:crypto';
import {validateRelease,packageBytes} from './portable-release.mjs';
import {loadValidatedEmittedRelease} from './emitted-release.mjs';
import {EMITTED209_SCHEMA} from './resource-format209.mjs';
import {createVerifiedEvidenceCache} from './verified-evidence.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
// Immutable source representation only. The revision is owned by the pinned
// source contract, never an observed database field or a request parameter.
const comparison209=frameOrderMergeDelivery209Comparison(E209,E209_ORIGIN.runtime_revision===22?{runtimeRevision:22}:undefined);
// BOTH constructors mint only this namespace. No exported adoption/rehydration/foreign handle API.
const reviewed=new WeakMap();
function privateState(handle){const state=reviewed.get(handle);assert(state,'startup-requires-private-reviewed-handle');return state;}
function exactKeys(value,keys){assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),keys.slice().sort(),'portable-startup-exact-options');}
function mint(state){const handle=Object.freeze({schema:'large-import173-reviewed-startup/v1'});reviewed.set(handle,state);return handle;}

/** Historical diagnostics only. Capture original opaque retirement synchronously, then lazy-load its compiler. */
export async function createReviewedStartup(compileInput,reviewedEvidenceOptions={}){
 const input=structuredClone(compileInput),retirement=reviewedEvidenceOptions.retirement;
 const options=structuredClone({clockPolicy:reviewedEvidenceOptions.clockPolicy??'rehash-always'});
 assert(Object.keys(reviewedEvidenceOptions).every(k=>['clockPolicy','retirement'].includes(k)),'startup-unknown-options');
 const [{compileReviewedComposite,reviewedEvidenceReferences,assertCompositeInventory},{sha:historicalSha,queryRef}]=await Promise.all([import('./profile-compiler.mjs'),import('./profile-source.mjs')]);
 const c=await compileReviewedComposite(input,retirement===undefined?{}:{retirement});
 const state=structuredClone({kind:'historical',input:{catalog_sql:c.catalog_sql,expectation_origin:'INDEPENDENT_REVIEWED_SOURCE_DDL_EXPECTATION',owner:c.expected_owner,profile:c.expected_profile,profile_sha256:c.profile_sha256,profile_native_sha256:c.profile_native_sha256},refs:reviewedEvidenceReferences(c.loaded_refs,retirement)});
 // Source-owned strategy is created ONLY here. No caller callback can become
 // part of the private state. Historical imports remain in this constructor.
 state.assertSourceExpectation=()=>{assert.equal(historicalSha(state.input.catalog_sql),queryRef.sha256);assert.equal(state.input.expectation_origin,'INDEPENDENT_REVIEWED_SOURCE_DDL_EXPECTATION');assertCompositeInventory(state.input.profile,state.input.owner);};
 state.cache=createVerifiedEvidenceCache(options);await state.cache.verify(state.refs,{forceFullHash:true});return mint(state);
}

/** Exact hashes of the CONSUMED bytes are checked before parsing, independent of validation cuts. */
async function trustedMember(root,item,role){
 assert(item&&item.role===role,'portable-startup-linked-role');const bytes=await packageBytes(root,item.path);
 assert.equal(bytes.length,item.bytes,'portable-startup-consumed-member-size');assert.equal(sha(bytes),item.sha256,'portable-startup-consumed-member-hash');return bytes;
}
async function closePortable(state){
 if(state.packageKind==='emitted'){
  const loaded=await loadValidatedEmittedRelease({releaseDirectory:state.root,manifestSha:state.manifestSha});
  assert.deepEqual(loaded,state.releaseCut,'emitted-startup-release-drift');return loaded.closure;
 }
 const report=await validateRelease(state.root,{expectedManifestSha:state.manifestSha});assert.deepEqual(report,state.integrity,'portable-startup-release-drift');return report;
}
/** Local build-selected source package, never browser JSON/expected-profile/native observation overrides. */
export async function createPortableReviewedStartup(input0){
 exactKeys(input0,['releaseDirectory','manifestSha','expectedOwner']);
 const {releaseDirectory:root,manifestSha,expectedOwner}=structuredClone(input0);
 assert(typeof expectedOwner==='string'&&/^[a-z_][a-z0-9_]{0,62}$/.test(expectedOwner)&&expectedOwner!=='dyna_app'&&expectedOwner!=='PUBLIC','portable-startup-source-owner');
 // The separately configured digest binds the bytes used to dispatch schema.
 // No caller selects a profile, validator, native observation or state strategy.
 const manifestBytes=await packageBytes(root,'release.json');assert.equal(sha(manifestBytes),manifestSha,'portable-startup-consumed-manifest-hash');
 const schema=JSON.parse(manifestBytes).schema;
 let state;
 if(schema==='dynaminds-emitted-local-release/v1'||schema===EMITTED209_SCHEMA){
  const release=await loadValidatedEmittedRelease({releaseDirectory:root,manifestSha});
  const profile=release.expectedProfile,native=release.nativeContract;
  assert(profile.functions.length===native.functions&&profile.relations.length===native.relations,'portable-startup-full-profile-counts');
  assert(profile.functions.length>0&&profile.relations.length>0,'portable-startup-full-profile');
  assert(profile.functions.every(f=>f.owner===expectedOwner)&&profile.relations.every(r=>r.owner===expectedOwner),'portable-startup-source-owner');
  assert.equal(profile.relations.filter(r=>r.name==='large_import173_certificate').length,1,'portable-startup-source-certificate-relation');
  state={kind:'portable',packageKind:'emitted',root,manifestSha,releaseCut:structuredClone(release),input:{catalog_sql:release.catalogueSql,catalog_sha256:release.catalogueSha256,expectation_origin:'COMPLETE_REVIEWED_SOURCE_PROPOSAL_NOT_LIVE_ROWS',owner:expectedOwner,profile:structuredClone(profile),profile_sha256:sha(JSON.stringify(profile)),compatibility:release.compatibilityContract}};
 }else{
  assert.equal(schema,'dynaminds-importer-source-release/v1','portable-startup-supported-package-schema');
  const integrity=await validateRelease(root,{expectedManifestSha:manifestSha});
  const manifest=JSON.parse(manifestBytes);
  const profileItem=manifest.files.find(item=>item.path===manifest.native_contract.profile);
  const profileBytes=await trustedMember(root,profileItem,'expected-profile');const profile=JSON.parse(profileBytes);
  const query=manifest.native_contract.catalog_query,queryItem=manifest.files.find(item=>item.path===query.path);
  assert.equal(queryItem?.sha256,query.sha256,'portable-startup-consumed-query-link');
  const queryBytes=await trustedMember(root,queryItem,'catalog-query'),catalogSql=new TextDecoder('utf-8',{fatal:true}).decode(queryBytes);
  assert(profile.functions.length===manifest.native_contract.functions&&profile.relations.length===manifest.native_contract.relations,'portable-startup-full-profile-counts');
  assert(profile.functions.length>0&&profile.relations.length>0,'portable-startup-full-profile');
  assert(profile.functions.every(f=>f.owner===expectedOwner)&&profile.relations.every(r=>r.owner===expectedOwner),'portable-startup-source-owner');
  assert.equal(profile.relations.filter(r=>r.name==='large_import173_certificate').length,1,'portable-startup-source-certificate-relation');
  let compatibility;
  if(manifest.native_contract.compatibility!==undefined){const link=manifest.native_contract.compatibility,item=manifest.files.find(f=>f.path===link.path);const bytes=await trustedMember(root,item,'compatibility-contract');assert.equal(sha(bytes),link.sha256);compatibility=JSON.parse(bytes);assertOrdinary177Contract(compatibility,profile);}
  state={kind:'portable',packageKind:'source',root,manifestSha,integrity:structuredClone(integrity),input:{catalog_sql:catalogSql,catalog_sha256:query.sha256,expectation_origin:'COMPLETE_REVIEWED_SOURCE_PROPOSAL_NOT_LIVE_ROWS',owner:expectedOwner,profile:structuredClone(profile),profile_sha256:sha(JSON.stringify(profile)),compatibility}};
 }
 state.assertSourceExpectation=()=>{assert.equal(sha(state.input.catalog_sql),state.input.catalog_sha256);assert.equal(state.input.expectation_origin,'COMPLETE_REVIEWED_SOURCE_PROPOSAL_NOT_LIVE_ROWS');};
 // Hash-before-consumption plus full closing cut catches both consumed-byte and final-inventory drift.
 await closePortable(state);return mint(state);
}

/** Genuine injected owner reader; no pool, role switching, schema writes or early candidate helper. */
async function inspectComparedProfile(owner,input0,kind,assertSourceExpectation){
 assertSourceExpectation();
 const input=structuredClone(input0);
 assert(kind==='historical'||kind==='portable');
 assert.equal(sha(JSON.stringify(input.profile)),input.profile_sha256);
 const identity=(await owner.query("SELECT current_user::text AS current_role,session_user::text AS session_role,current_setting('role',true) AS role_setting")).rows[0];
 assert(identity);assert.equal(identity.current_role,input.owner);assert.equal(identity.session_role,input.owner);assert.equal(identity.role_setting,'none','private-keeper-owner-role-none');
 const select=input.catalog_sql.trim().replace(/;$/,'');
 const rows=(await owner.query(`WITH external173 AS MATERIALIZED (${select}) SELECT profile,profile::text AS native_text,encode(sha256(convert_to(profile::text,'UTF8')),'hex') AS native_sha256 FROM external173`)).rows;assert.equal(rows.length,1);
 const row=rows[0];assert.deepEqual(row.profile,input.profile);
 assert(typeof row.native_text==='string'&&typeof row.native_sha256==='string'&&/^[a-f0-9]{64}$/.test(row.native_sha256),'startup-native-serialization');
 assert.deepEqual(JSON.parse(row.native_text),input.profile);const nativeSha=sha(row.native_text);assert.equal(row.native_sha256,nativeSha);
 if(kind==='historical')assert.equal(nativeSha,input.profile_native_sha256);
 // Native equality precedes trusting this exact kernel certificate/validity predicate.
 // JS JSON.stringify(expected) is NEVER used as a PostgreSQL native certificate digest.
 if(input.compatibility!==undefined){
  const expected=assertOrdinary177Contract(input.compatibility,input.profile);
  const cert=(await owner.query(`SELECT (SELECT count(*) FROM public.large_import173_certificate)::text AS count,(SELECT to_jsonb(c) FROM public.large_import173_certificate c WHERE singleton) AS certificate,(SELECT profile::text FROM public.large_import173_certificate WHERE singleton) AS original_native_text,(SELECT predecessor_map::text FROM public.large_import173_certificate WHERE singleton) AS predecessor_native_text,public.large_import173_predecessor_map() AS current_predecessors,public.large_import173_valid() AS valid`)).rows[0];
  assert(cert);assert.equal(cert.count,'1');assert.deepEqual(cert.certificate,expected.original_certificate);assert.deepEqual(JSON.parse(cert.original_native_text),expected.original_profile);assert.equal(sha(cert.original_native_text),cert.certificate.profile_sha256);assert.deepEqual(JSON.parse(cert.predecessor_native_text),cert.certificate.predecessor_map);assert.equal(sha(cert.predecessor_native_text),cert.certificate.predecessor_sha256);
  // Metadata representation only: undo the two current209 descriptors before
  // the existing204/C30 projection and mandatory complete28 comparison.
  const predecessors209=projectOrderMergeDelivery209Predecessors(cert.current_predecessors,comparison209.expected,comparison209.metadataOptions);
  assert.deepEqual(projectPackingOriginal173Predecessors(predecessors209.value),expected.successor_predecessors);assert.equal(cert.valid,true);
 }else{
 const cert=(await owner.query('SELECT (SELECT count(*) FROM public.large_import173_certificate)::text AS count,(SELECT profile_sha256 FROM public.large_import173_certificate WHERE singleton) AS sha,public.large_import173_valid() AS valid')).rows[0];
 assert(cert);assert.equal(cert.count,'1');assert.equal(cert.sha,nativeSha);assert.equal(cert.valid,true);
 }
 return {status:'INDEPENDENT_COMPLETE173_GRAPH_AND_CERT_MATCHED',certified_graph:true,profile_native_sha256:nativeSha,application_activation:false,
 pending:'Genuine source installation, Actor/common-TX/durable registry/all quota intents/native CORE-PIM/current IAM/restore gates are separate; graph alone does not enable routes'};
}
async function verifyEvidence(state,force=false){
 if(state.kind==='portable')return closePortable(state);
 await state.cache.verify(state.refs,force?{forceFullHash:true}:{});return state.cache.metrics();
}
// Only immutable schema/package evidence is shared. Actor/session/IAM/quota verdicts are
// NEVER cached. Every native early/late admission executes its original predicates.
const schemaGenerations=new WeakMap(),activationBusy=new WeakSet(),activationOwners=new WeakSet(),activationFailures=new WeakSet();
const coldSchema='ordinary199-keeper-consumer-credit-runtime-dual173/v1';
const consumerInspections=new WeakMap(),keeper198Inspections=new WeakMap();
function coldEnabled(state){return state.kind==='portable'&&state.input.compatibility?.schema===coldSchema;}
function assertGeneration(state,row){
 assert(row&&row.contract_id==='ordinary182-cold-schema-runtime/v1','runtime-generation-contract');
 assert(typeof row.generation==='string'&&/^[1-9][0-9]*$/.test(row.generation),'runtime-generation-shape');
 assert.equal(row.release_sha256,state.manifestSha,'runtime-generation-exact-release');
 assert.equal(row.native_sha256,state.input.compatibility.durable_writer_epoch_extension.migration_sha256,'runtime-generation-exact-native-contract');
 assert(typeof row.profile_native_sha256==='string'&&/^[a-f0-9]{64}$/.test(row.profile_native_sha256),'runtime-generation-profile-shape');
}
async function readGeneration(owner,state){
 const rows=(await owner.query('SELECT public.ordinary182_owner_gate() AS generation')).rows;
 assert.equal(rows.length,1);assertGeneration(state,rows[0].generation);return structuredClone(rows[0].generation);
}
async function requireIdleActivationOwner(owner){
 // PostgreSQL ReadyForQuery is I only when this connection is outside a transaction.
 // Reject injected RRRO/RW/error transactions BEFORE BEGIN; never steal their closure.
 const connection=owner.connection;assert(connection&&typeof connection.on==='function'&&typeof connection.removeListener==='function','cold-activation-real-idle-pg-owner');
 let status;const ready=message=>{status=message.status;};connection.on('readyForQuery',ready);
 try{const rows=(await owner.query('SHOW transaction_read_only')).rows;assert.equal(status,'I','cold-activation-requires-idle-owner');assert.equal(rows[0]?.transaction_read_only,'off','cold-activation-requires-write-owner');}
 finally{connection.removeListener('readyForQuery',ready);}
}
const packingInspections=new WeakMap();
function inspectPackingReceipt(state,generation){
 const held=packingInspections.get(state);assert(held,'packing189-committed-independent-inspection-required');
 assert.deepEqual(held.generation,generation,'packing189-exact-approved-generation');
 assert.equal(held.release_sha256,state.manifestSha,'packing189-exact-release');
 return Object.freeze({schema:'packing189-committed-cold-inspection/v1',migration_sha256:held.migration_sha256,source_contract_sha256:held.source_contract_sha256,native_catalogue_sha256:held.native_catalogue_sha256,inspection_sha256:held.inspection_sha256,schema_generation:generation.generation,application_activation:false,global_writer_fence_proven:false});
}
export async function activateRuntimeGeneration(owner,handle){
 const state=privateState(handle);if(!coldEnabled(state))return {status:'LEGACY_CADENCE_NO_GENERATION_ACTIVATION',application_activation:false};
 assert(!activationFailures.has(state),'cold-activation-handle-failed');assert(!activationBusy.has(state),'cold-activation-already-running');assert(!activationOwners.has(owner),'cold-activation-owner-already-running');activationBusy.add(state);activationOwners.add(owner);
 let began=false,committed=false,first,failed=false,report,generation,consumerInspection,keeper198DescriptorCut,keeper198Inspection,packingInspection,installation,readInstallation,installationIdentity,readInstallationIdentity248;
 try{
  await verifyEvidence(state,true);await requireIdleActivationOwner(owner);
  await owner.query('BEGIN ISOLATION LEVEL READ COMMITTED');began=true;
  // Fence precedes ALL independent native/profile reads, approval, closing and COMMIT.
  await owner.query('SELECT pg_advisory_xact_lock(982376)');
  keeper198DescriptorCut=await inspectKeeperResourceDescriptors198(owner,state);
  await owner.query('SET LOCAL timezone TO UTC');await owner.query('SET LOCAL jit TO off');
  await owner.query('SET LOCAL search_path TO pg_catalog, public');
  await owner.query("SET LOCAL statement_timeout TO '8s'");await owner.query("SET LOCAL lock_timeout TO '8s'");
  packingInspection=await inspectPackingColdCompartment(owner,state.input.compatibility.packing_required_field_extension);
  await inspectDurableWriterEpochDescriptors(owner,state);
  // Trusted cold admission predicates have a finite120s budget after the bounded8s catalogue Reader phase.
  await owner.query("SET LOCAL statement_timeout TO '120s'");
  report=await inspectComparedProfile(owner,state.input,state.kind,state.assertSourceExpectation);
  await inspectOrdinarySchemaExtension(owner,state);
  if(packingInspection.return_credit211_active){
   installation=await readInstallationCut(owner,true,[...INSTALLATION_SEALS,'return_credit211_metadata']);
   readInstallation=await readInstallationCut(owner,true,[...ORDER_READ_INSTALLATION_SEALS,'return_credit211_metadata']);
  }else{
   installation=await readInstallationCut(owner,true);
   readInstallation=await readInstallationCut(owner,true,ORDER_READ_INSTALLATION_SEALS);
  }
  // Same transaction and row locks as the full cuts just read: the identity of exactly the hashed tuples.
  installationIdentity=await readInstallationIdentity(owner,true,Object.keys(installation.cut.seals));
  readInstallationIdentity248=await readInstallationIdentity(owner,true,Object.keys(readInstallation.cut.seals));
  assert.equal((await owner.query('SELECT public.buyer_address_available() AS valid')).rows[0]?.valid,true,'ordinary-installation-cold-buyer');
  assert.equal((await owner.query('SELECT public.catalog_stock_control_guards() AS valid')).rows[0]?.valid,true,'ordinary-installation-cold-catalog');
  await owner.query("SET LOCAL statement_timeout TO '8s'"); // Restore the normal cold/metadata budget for descriptor checks.
  await inspectKeeperSchemaExtension(owner,state);
  await inspectCoreReviewAliasExtension(owner,state);
  await inspectDurableWriterEpochExtension(owner,state);
  keeper198Inspection=await inspectKeeperResourceExtension198(owner,state,keeper198DescriptorCut);
  consumerInspection=await inspectConsumerCreditExtension(owner,state);
  await verifyEvidence(state,true);
  // This owner-only approval reruns the full native predicates. Give only that
  // statement the existing finite cold budget; metadata/closing reads stay8s.
  await owner.query("SET LOCAL statement_timeout TO '120s'");
  const rows=(await owner.query('SELECT public.ordinary187_approve($1,$2,$3) AS generation',[state.manifestSha,state.input.compatibility.durable_writer_epoch_extension.migration_sha256,report.profile_native_sha256])).rows;
  await owner.query("SET LOCAL statement_timeout TO '8s'");
  assert.equal(rows.length,1);generation=structuredClone(rows[0].generation);assertGeneration(state,generation);
  assert.equal(generation.profile_native_sha256,report.profile_native_sha256,'cold-approval-exact-profile-cut');
  const consumerClosing=(await owner.query(consumerContextSql)).rows[0];assert.deepEqual(consumerClosing,consumerInspection.context,'ordinary188-same-cold-transaction-generation');
  assert.equal(generation.generation,consumerInspection.context.generation,'ordinary188-approved-exact-generation');
  const keeper198Closing=(await owner.query(keeper198ContextSql)).rows[0];assert.deepEqual(keeper198Closing,keeper198Inspection.context,'keeper198-same-cold-transaction-generation');
  assert.equal(generation.generation,keeper198Inspection.context.generation,'keeper198-approved-exact-generation');
  const packingClosing=(await owner.query("SELECT current_database() database,pg_backend_pid() backend_pid,pg_current_xact_id()::text root_xid")).rows[0];
  assert.equal(packingClosing.database,packingInspection.context.database);assert.equal(packingClosing.backend_pid,packingInspection.context.backend_pid);assert.equal(packingClosing.root_xid,packingInspection.context.root_xid,'packing189-same-cold-root-XID');
  await verifyEvidence(state,true);
  assert.deepEqual(await readInstallationCut(owner,false,Object.keys(installation.cut.seals)),installation,'ordinary-installation-closing-cold-cut');
  assert.deepEqual(await readInstallationCut(owner,false,Object.keys(readInstallation.cut.seals)),readInstallation,'ordinary-order-read-closing-cold-cut');
  assert.deepEqual(await readInstallationIdentity(owner,false,Object.keys(installation.cut.seals)),installationIdentity,'ordinary-installation-closing-cold-identity');
  assert.deepEqual(await readInstallationIdentity(owner,false,Object.keys(readInstallation.cut.seals)),readInstallationIdentity248,'ordinary-order-read-closing-cold-identity');
  await owner.query('COMMIT');committed=true;
  ordinaryInstallationCuts.set(state,Object.freeze({generation:structuredClone(generation),installation,identity:installationIdentity}));
  ordinaryOrderReadCuts.set(state,Object.freeze({generation:structuredClone(generation),installation:readInstallation,identity:readInstallationIdentity248}));
  schemaGenerations.set(state,generation);consumerInspections.set(state,Object.freeze({...consumerInspection,generation:structuredClone(generation)}));keeper198Inspections.set(state,Object.freeze({...keeper198Inspection,generation:structuredClone(generation)}));
  packingInspections.set(state,Object.freeze({...packingInspection,release_sha256:state.manifestSha,generation:Object.freeze(structuredClone(generation))}));
 }catch(error){failed=true;first=error;ordinaryInstallationCuts.delete(state);ordinaryOrderReadCuts.delete(state);schemaGenerations.delete(state);consumerInspections.delete(state);keeper198Inspections.delete(state);packingInspections.delete(state);}
 finally{
  if(began&&!committed)try{await owner.query('ROLLBACK');}catch(error){if(!failed){failed=true;first=error;}}
  try{await verifyEvidence(state,true);}catch(error){if(!failed){failed=true;first=error;}}
  activationBusy.delete(state);activationOwners.delete(owner);
 }
 if(failed){ordinaryInstallationCuts.delete(state);ordinaryOrderReadCuts.delete(state);schemaGenerations.delete(state);consumerInspections.delete(state);keeper198Inspections.delete(state);packingInspections.delete(state);activationFailures.add(state);throw first;}
 return {...report,integrity_cadence:'EXPLICIT_OWNER_COLD_VALIDATION_COMMITTED',schema_generation:generation.generation,consumer_credit_inspection:inspectConsumerReceipt(state,generation),keeper_resource_inspection:inspectKeeperResourceReceipt198(state,generation),packing_field_inspection:inspectPackingReceipt(state,generation)};
}
async function inspectKeeperSchemaExtension(owner,state){
 const e=state.input.compatibility.keeper_schema_extension;
 assert(e&&e.original_certificate_unchanged===true&&e.early_late_IAM_and_UNKNOWN_unchanged===true&&e.native_admission_cache===false,'ordinary185-source-extension');
 const rows=(await owner.query(state.input.compatibility.durable_writer_epoch_extension.keeper_anchor_sql)).rows;assert.equal(rows.length,1);
 assert.deepEqual(rows[0].keeper_extension,{roster:e.helpers.map(h=>h.name).sort(),anchors:[...e.helpers,...e.changed_descriptors].map(()=>true)},'ordinary185-independent-native-descriptors');
}
async function inspectCoreReviewAliasExtension(owner,state){
 const e=state.input.compatibility.core_review_alias_extension;
 assert(e&&e.original_certificate_unchanged===true&&e.early_late_IAM_and_UNKNOWN_unchanged===true&&e.native_admission_cache===false,'ordinary186-source-extension');
 const rows=(await owner.query(state.input.compatibility.durable_writer_epoch_extension.alias_anchor_sql)).rows;assert.equal(rows.length,1);
 assert.deepEqual(rows[0].alias_extension,{roster:e.helpers.map(h=>h.name).sort(),anchors:[...e.helpers,...e.changed_descriptors,e.unchanged185_valid_descriptor].map(()=>true)},'ordinary186-independent-native-descriptors');
}
/** Catalogue-only source descriptor read before any root/delegated/new187 helper.
 * Separate submitted statements, never CASE/AND dispatch of an untrusted function. */
async function inspectDurableWriterEpochDescriptors(owner,state){
 const e=state.input.compatibility.durable_writer_epoch_extension;
 assert(e&&e.original_certificate_unchanged===true&&e.per_operation_IAM_unchanged===true&&e.native_admission_cache===false&&e.catalogue_preinspection_before_any_187_dispatch===true,'ordinary187-source-descriptor-boundary');
 const identity=(await owner.query("SELECT current_user::text AS current_role,session_user::text AS session_role,current_setting('role',true) AS role_setting")).rows;
 assert.equal(identity.length,1);assert.deepEqual(identity[0],{current_role:state.input.owner,session_role:state.input.owner,role_setting:'none'},'ordinary187-descriptor-real-owner-none');
 const descriptorSql=await prepareDurable187Descriptor204Sql(owner,e);
 const rows=(await owner.query(descriptorSql)).rows;assert.equal(rows.length,1);
 assert.deepEqual(rows[0].durable_descriptors,{roster:e.public_helper_roster,anchors:[...e.helpers,...e.changed_descriptors,e.unchanged186_valid_descriptor].map(()=>true)},'ordinary187-catalogue-only-full-descriptors-before-dispatch');
}
async function inspectDurableWriterEpochExtension(owner,state){
 // Called only later within activateRuntimeGeneration's same exclusive owner TX,
 // after the independent exact catalogue preinspection and full44 source cut.
 const rows=(await owner.query('SELECT public.ordinary187_private_valid() AS private_structure')).rows;assert.equal(rows.length,1);
 assert.equal(rows[0].private_structure,true,'ordinary187-private-structure-after-accepted-descriptors');
}

const consumerContextSql="SELECT current_user::text AS current_role,session_user::text AS session_role,current_setting('role',true) AS role_setting,current_database() AS database,inet_server_port() AS port,pg_current_xact_id()::text AS root_xid,(SELECT generation::text FROM public.ordinary182_runtime_generation WHERE singleton) AS generation";
async function inspectConsumerCreditExtension(owner,state){
 const e=structuredClone(state.input.compatibility.consumer_credit_extension);
 assert(e&&e.schema==='consumer188-source-bound-cold-extension/v1'&&e.original157_160_bodies_unchanged===true&&e.per_operation_IAM_unchanged===true&&e.native_admission_cache===false,'ordinary188-source-extension');
 assert.equal(sha(e.independent_anchor_sql),e.independent_anchor_sha256,'ordinary188-source-anchor-hash');
 const context=(await owner.query(consumerContextSql)).rows[0];assert(context&&context.current_role===state.input.owner&&context.session_role===state.input.owner&&context.role_setting==='none','ordinary188-cold-owner');
 assert(typeof context.database==='string'&&Number.isInteger(context.port)&&typeof context.root_xid==='string'&&/^[1-9][0-9]*$/.test(context.root_xid)&&typeof context.generation==='string'&&/^[1-9][0-9]*$/.test(context.generation),'ordinary188-cold-context');
 const rows=(await owner.query(e.independent_anchor_sql)).rows;assert.equal(rows.length,1);const observed=rows[0].consumer_extension;
 assert(observed&&observed.helper===true&&typeof observed.native_text==='string'&&typeof observed.native_sha256==='string','ordinary188-full-native-structure');
 assert.deepEqual(Object.keys(observed).sort(),['helper','native_sha256','native_text']);assert.deepEqual(JSON.parse(observed.native_text),e.expected_catalogue,'ordinary188-source-catalogue-equality');assert.equal(sha(observed.native_text),observed.native_sha256,'ordinary188-native-serialization');
 assert.equal(e.structure_check_sql,'SELECT public.ordinary188_structure_valid() AS structure');assert.equal(sha(e.structure_check_sql),e.structure_check_sha256,'ordinary188-source-dispatch-hash');
 // Submit a separate statement only AFTER every catalog field is validated,
 // while the original exclusive schema fence and owner transaction remain held.
 const structureRows=(await owner.query(e.structure_check_sql)).rows;assert.equal(structureRows.length,1);assert.deepEqual(structureRows[0],{structure:true},'ordinary188-full-native-structure');
 const receipt={schema:'consumer188-private-cold-inspection/v1',release_manifest_sha256:state.manifestSha,migration_sha256:e.migration.sha256,structure_sha256:e.structure_migration.sha256,source_contract_sha256:e.source_contract_sha256,native_catalogue_sha256:observed.native_sha256,helper_body_sha256:e.helper.body_sha256,context:structuredClone(context)};
 return Object.freeze({...receipt,inspection_sha256:sha(JSON.stringify(receipt))});
}
function inspectConsumerReceipt(state,generation){
 const held=consumerInspections.get(state);assert(held,'ordinary188-genuine-committed-cold-inspection-required');assert.deepEqual(held.generation,generation,'ordinary188-current-cold-generation');const e=state.input.compatibility.consumer_credit_extension;
 assert.equal(held.release_manifest_sha256,state.manifestSha);assert.equal(held.migration_sha256,e.migration.sha256);assert.equal(held.structure_sha256,e.structure_migration.sha256);assert.equal(held.source_contract_sha256,e.source_contract_sha256);assert.equal(held.helper_body_sha256,e.helper.body_sha256);
 const {inspection_sha256,generation:ignored,...body}=held;assert.equal(inspection_sha256,sha(JSON.stringify(body)),'ordinary188-private-inspection-integrity');
 return Object.freeze({schema:held.schema,migration_sha256:held.migration_sha256,structure_sha256:held.structure_sha256,source_contract_sha256:held.source_contract_sha256,native_catalogue_sha256:held.native_catalogue_sha256,inspection_sha256:held.inspection_sha256,schema_generation:held.context.generation,application_activation:false});
}

const keeper198ContextSql="SELECT current_user::text AS current_role,session_user::text AS session_role,current_setting('role',true) AS role_setting,current_database() AS database,inet_server_port() AS port,pg_current_xact_id()::text AS root_xid,(SELECT generation::text FROM public.ordinary182_runtime_generation WHERE singleton) AS generation";
async function inspectKeeperResourceDescriptors198(owner,state){
 const e=state.input.compatibility.keeper_resource_context_extension;
 assert(e&&e.schema==='keeper198-fixed-native-context-extension/v1'&&e.historical173_44_and_ACL_unchanged===true&&e.per_operation_IAM_unchanged===true&&e.native_admission_cache===false,'keeper198-source-bound-compartment');
 assert.equal(sha(e.independent_anchor_sql),e.independent_anchor_sha256,'keeper198-catalogue-only-source-query');
 assert.equal(sha(e.independent_counts_sql),e.independent_counts_sha256,'keeper198-count-source-query');assert.equal(sha(e.independent_lengths_sql),e.independent_lengths_sha256,'keeper198-length-source-query');
 const countRows=(await owner.query(e.independent_counts_sql)).rows;assert.deepEqual(countRows,[e.expected_counts],'keeper198-exact-bounded-native-counts-before-length');
 const lengthRows=(await owner.query(e.independent_lengths_sql)).rows;assert.equal(lengthRows.length,1);for(const key of ['encoded_definition_bytes','largest_definition_bytes']){assert(typeof lengthRows[0][key]==='string'&&/^[0-9]+$/.test(lengthRows[0][key])&&lengthRows[0][key].length<=20&&BigInt(lengthRows[0][key])<=1048576n,'keeper198-native-length-bound-before-payload');}
 const context=(await owner.query(keeper198ContextSql)).rows[0];assert(context&&context.current_role===state.input.owner&&context.session_role===state.input.owner&&context.role_setting==='none','keeper198-owner-none');
 assert(typeof context.database==='string'&&Number.isInteger(context.port)&&typeof context.root_xid==='string'&&/^[1-9][0-9]*$/.test(context.root_xid)&&typeof context.generation==='string'&&/^[1-9][0-9]*$/.test(context.generation),'keeper198-native-root-context');
 const rows=(await owner.query(e.independent_anchor_sql)).rows;assert.equal(rows.length,1);const observed=rows[0].keeper_resource_extension;
 assert(observed&&typeof observed.native_text==='string'&&typeof observed.native_sha256==='string','keeper198-full-native-catalogue');
 assert.deepEqual(Object.keys(observed).sort(),['anchors','native_sha256','native_text','roster']);
 assert.deepEqual(observed.roster,e.exact_function_roster);assert.deepEqual(observed.anchors,e.descriptors.map(()=>true),'keeper198-entire-descriptor-anchors');
 assert(Buffer.byteLength(observed.native_text,'utf8')<=2097152,'keeper198-whole-payload-bound');
 assert.deepEqual(JSON.parse(observed.native_text),e.expected_catalogue,'keeper198-full-compiled-catalogue-equality');assert.equal(sha(observed.native_text),observed.native_sha256,'keeper198-native-serialization');
 return Object.freeze({context:structuredClone(context),native_catalogue_sha256:observed.native_sha256});
}
async function inspectKeeperResourceExtension198(owner,state,descriptorCut){
 const e=state.input.compatibility.keeper_resource_context_extension;
 assert.equal(e.structure_check_sql,'SELECT public.ordinary187_private_valid() AS structure');assert.equal(sha(e.structure_check_sql),e.structure_check_sha256,'keeper198-exact-source-dispatch');
 // Separate submitted statement AFTER both keeper and complete187 catalogue acceptance, under same982376/TX.
 const rows=(await owner.query(e.structure_check_sql)).rows;assert.equal(rows.length,1);assert.deepEqual(rows[0],{structure:true},'keeper198-native-private-structure');
 const closing=(await owner.query(keeper198ContextSql)).rows[0];assert.deepEqual(closing,descriptorCut.context,'keeper198-same-cold-context-after-dispatch');
 const receipt={schema:'keeper198-private-cold-inspection/v1',release_manifest_sha256:state.manifestSha,migration_sha256:e.migration.sha256,source_contract_sha256:e.source_contract_sha256,native_catalogue_sha256:descriptorCut.native_catalogue_sha256,descriptor_set_sha256:e.descriptor_set_sha256,context:structuredClone(closing)};
 return Object.freeze({...receipt,inspection_sha256:sha(JSON.stringify(receipt))});
}
function inspectKeeperResourceReceipt198(state,generation){
 const held=keeper198Inspections.get(state);assert(held,'keeper198-genuine-committed-cold-inspection-required');assert.deepEqual(held.generation,generation,'keeper198-current-cold-generation');const e=state.input.compatibility.keeper_resource_context_extension;
 assert.equal(held.release_manifest_sha256,state.manifestSha);assert.equal(held.migration_sha256,e.migration.sha256);assert.equal(held.source_contract_sha256,e.source_contract_sha256);assert.equal(held.descriptor_set_sha256,e.descriptor_set_sha256);
 const {inspection_sha256,generation:ignored,...body}=held;assert.equal(inspection_sha256,sha(JSON.stringify(body)),'keeper198-private-inspection-integrity');
 return Object.freeze({schema:held.schema,migration_sha256:held.migration_sha256,source_contract_sha256:held.source_contract_sha256,native_catalogue_sha256:held.native_catalogue_sha256,inspection_sha256:held.inspection_sha256,schema_generation:held.context.generation,application_activation:false});
}

// Installation-only facts: no actor, session, tenant business row or HTTP input is retained.
const ordinaryInstallationCuts=new WeakMap(),ordinaryInstallationGates=new WeakMap(),ordinaryEnteredInstallations=new WeakMap(),ordinaryPreparedInstallations=new WeakMap();
const INSTALLATION_SEALS=Object.freeze(['local_invoice_manifest','fa3_draft_manifest','b2b_invoice_upgrade','b2b_credit_upgrade','credit_source_upgrade_certificate','financial_return_upgrade_certificate','competitor_observation_manifest','buyer_address_manifest','manual_inventory_off_certificate','catalog_stock_control_manifest','catalog_stock_count_manifest','catalog_stock_legacy_group_manifest','catalog_stock_return_manifest']);
const INSTALLATION_MARKERS=Object.freeze(['152_catalog_stock_control','166_buyer_address_sidecar','169_manual_inventory_off']);
const installationMarkersFor=seals=>seals.includes('return_credit211_metadata')?[...INSTALLATION_MARKERS,'211_return_credit148_acceptance']:INSTALLATION_MARKERS;
const INSTALLATION_ROLE_SQL=`SELECT jsonb_build_object('roles',(SELECT coalesce(jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) ORDER BY rolname),'[]'::jsonb) FROM pg_catalog.pg_roles WHERE rolname IN ('postgres','dyna_app')),'memberships',(SELECT coalesce(jsonb_agg(jsonb_build_array(roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option) ORDER BY roleid,member,grantor),'[]'::jsonb) FROM pg_catalog.pg_auth_members)) AS metadata`;
function installationSealSql(lock,seals=INSTALLATION_SEALS){
 const share=lock?' FOR SHARE':'';
 const ctes=seals.map((name,i)=>`s${i} AS MATERIALIZED (SELECT t.* FROM public.${name} t${share})`);
 ctes.push(`markers AS MATERIALIZED (SELECT name FROM public.migrations WHERE name=ANY(ARRAY['${installationMarkersFor(seals).join("','")}']::text[]) ORDER BY name${share})`);
 const pairs=seals.map((name,i)=>`'${name}',(SELECT jsonb_build_object('count',count(*)::integer,'hashes',coalesce(jsonb_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') ORDER BY encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex')),'[]'::jsonb)) FROM s${i} t)`);
 return `WITH ${ctes.join(',')} SELECT jsonb_build_object('seals',jsonb_build_object(${pairs.join(',')}),'markers',(SELECT coalesce(jsonb_agg(name ORDER BY name),'[]'::jsonb) FROM markers)) AS cut`;
}
function checkInstallationCut(cut,seals=INSTALLATION_SEALS){
 assert.deepEqual(Object.keys(cut??{}).sort(),['markers','seals'],'ordinary-installation-cut-shape');
 assert.deepEqual(Object.keys(cut.seals).sort(),[...seals].sort(),'ordinary-installation-fixed-seals');
 for(const name of seals){const row=cut.seals[name];assert.deepEqual(Object.keys(row).sort(),['count','hashes']);assert.equal(row.count,1,'ordinary-installation-singleton');assert(Array.isArray(row.hashes)&&row.hashes.length===1&&/^[a-f0-9]{64}$/.test(row.hashes[0]),'ordinary-installation-full-row-sha');}
 assert.deepEqual(cut.markers,[...installationMarkersFor(seals)].sort(),'ordinary-installation-marker-roster');
}
function checkInstallationRoles(metadata){
 assert.deepEqual(Object.keys(metadata??{}).sort(),['memberships','roles'],'ordinary-installation-role-shape');
 assert(Array.isArray(metadata.roles)&&metadata.roles.length===2);assert.deepEqual(metadata.roles.map(r=>r[0]),['dyna_app','postgres']);
 for(const row of metadata.roles){assert(Array.isArray(row)&&row.length===8&&row.slice(1).every(v=>typeof v==='boolean'));}
 const app=metadata.roles[0];assert.equal(app[1],false);assert.equal(app[5],false);assert.equal(app[7],false);
 assert(Array.isArray(metadata.memberships));for(const row of metadata.memberships)assert(Array.isArray(row)&&row.length===6&&row.slice(0,3).every(v=>typeof v==='string'&&/^[0-9]+$/.test(v))&&row.slice(3).every(v=>typeof v==='boolean'));
 assert(Buffer.byteLength(JSON.stringify(metadata))<=8388608,'ordinary-installation-role-bound');
}
async function readInstallationCut(owner,lock,seals=INSTALLATION_SEALS){
 const rows=(await owner.query(installationSealSql(lock,seals))).rows;assert.equal(rows.length,1);const cut=structuredClone(rows[0].cut);checkInstallationCut(cut,seals);
 const roles=(await owner.query(INSTALLATION_ROLE_SQL)).rows;assert.equal(roles.length,1);const metadata=structuredClone(roles[0].metadata);checkInstallationRoles(metadata);
 return Object.freeze({cut,metadata});
}
// Load dry run 27.10 (docs/parity/INSTALLATION-IDENTITY248-20261027.md): hashing every full seal row per transaction was
// the most frequent active query (the order-read cut includes the ~14 MB 209 projection basis row). A heap tuple is
// never changed in place: any INSERT/UPDATE/DELETE of a seal row, also in replica mode and also with unchanged values,
// leaves a visible version with a new (ctid, xmin); a changed column list, name, type or fast default is a new
// pg_attribute/pg_class row version. The identity of the visible seal rows (relation, ctid, xmin, under the same lock
// as the full read) and of their tables' pg_class/pg_attribute rows is read in the cold transaction right after the
// full cut and again at its close. While a later transaction sees exactly that identity it sees exactly the tuples the
// cold cut hashed, under the same table definitions, so the full hash would repeat the cold one; any difference falls
// back to the full read. Markers and roles stay fresh. Only system columns and pg_catalog rows are returned (no cast,
// no function call); the comparison is done here.
function installationIdentitySql(lock,seals){
 const share=lock?' FOR SHARE':'',names=`ARRAY['${seals.join("','")}']::pg_catalog.name[]`;
 const ctes=seals.map((name,i)=>`s${i} AS MATERIALIZED (SELECT t.tableoid,t.ctid,t.xmin FROM public.${name} t${share})`);
 const parts=seals.map((name,i)=>`SELECT 'row' AS kind,'${name}'::pg_catalog.name AS seal,s${i}.tableoid AS rel,s${i}.ctid AS tid,s${i}.xmin AS version,NULL::pg_catalog.int2 AS attnum FROM s${i}`);
 const own=`c.relnamespace OPERATOR(pg_catalog.=) 'public'::pg_catalog.regnamespace AND c.relname OPERATOR(pg_catalog.=) ANY(${names})`;
 parts.push(`SELECT 'class',c.relname,c.oid,c.ctid,c.xmin,NULL FROM pg_catalog.pg_class c WHERE ${own}`);
 parts.push(`SELECT 'attribute',c.relname,a.attrelid,a.ctid,a.xmin,a.attnum FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid OPERATOR(pg_catalog.=) c.oid WHERE ${own}`);
 return `WITH ${ctes.join(',')} ${parts.join(' UNION ALL ')}`;
}
async function readInstallationIdentity(owner,lock,seals){
 const rows=(await owner.query(installationIdentitySql(lock,seals))).rows;
 const identity=rows.map(r=>JSON.stringify([r.kind,r.seal,String(r.rel),r.tid,r.version,r.attnum])).sort();
 for(const name of seals){assert.equal(rows.filter(r=>r.kind==='row'&&r.seal===name).length,1,'ordinary-installation-identity-singleton');assert.equal(rows.filter(r=>r.kind==='class'&&r.seal===name).length,1,'ordinary-installation-identity-relation');}
 assert(rows.every(r=>typeof r.tid==='string'&&/^\([0-9]+,[0-9]+\)$/.test(r.tid)&&typeof r.version==='string'&&/^[0-9]+$/.test(r.version)),'ordinary-installation-identity-shape');
 return Object.freeze(identity);
}
const sameInstallationIdentity=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>v===b[i]);
const installationMarkerSql=(lock,seals)=>`SELECT coalesce(jsonb_agg(m.name ORDER BY m.name),'[]'::jsonb) AS markers FROM (SELECT name FROM public.migrations WHERE name=ANY(ARRAY['${installationMarkersFor(seals).join("','")}']::text[]) ORDER BY name${lock?' FOR SHARE':''}) m`;
/** Identity unchanged since the cold cut: the seal hashes are the cold ones by the argument above; markers and roles
 * are read fresh, as by the full read. Any other identity: the full read. */
async function readCurrentInstallationCut(owner,lock,seals,cold){
 if(!cold.identity||!sameInstallationIdentity(await readInstallationIdentity(owner,lock,seals),cold.identity))return readInstallationCut(owner,lock,seals);
 const rows=(await owner.query(installationMarkerSql(lock,seals))).rows;assert.equal(rows.length,1);
 const cut={seals:structuredClone(cold.installation.cut.seals),markers:structuredClone(rows[0].markers)};checkInstallationCut(cut,seals);
 const roles=(await owner.query(INSTALLATION_ROLE_SQL)).rows;assert.equal(roles.length,1);const metadata=structuredClone(roles[0].metadata);checkInstallationRoles(metadata);
 return Object.freeze({cut,metadata});
}
const INSTALLATION_CONTEXT_SQL=`SELECT current_database() database,pg_backend_pid() pid,transaction_timestamp()::text start,CASE WHEN current_setting('transaction_read_only')='off' THEN pg_current_xact_id()::text ELSE NULL END root,current_setting('transaction_read_only') read_only,current_user::text role,session_user::text owner,current_setting('role',true) role_setting,current_setting('app.tenant_id',true) tenant,current_setting('session_replication_role') replication,current_setting('TimeZone') timezone,current_setting('statement_timeout') timeout`;
async function installationContext(owner){const rows=(await owner.query(INSTALLATION_CONTEXT_SQL)).rows;assert.equal(rows.length,1);return structuredClone(rows[0]);}
async function recordEnteredInstallation(owner,gate){
 ordinaryEnteredInstallations.delete(owner);const context=await installationContext(owner);
 if(context.read_only==='on')return;
 assert.equal(context.read_only,'off');assert(typeof context.root==='string'&&/^[0-9]+$/.test(context.root));assert(typeof context.start==='string'&&context.start.length>0&&Number.isSafeInteger(context.pid)&&context.pid>0);assert.equal(context.owner,'postgres');assert.equal(context.role,'postgres');assert.equal(context.role_setting,'none');assert.equal(context.replication,'origin');
 ordinaryEnteredInstallations.set(owner,Object.freeze({gate,context}));
}
async function requireEnteredInstallation(owner,gate,tenant){
 const binding=ordinaryInstallationGates.get(gate),entered=ordinaryEnteredInstallations.get(owner);
 assert(binding&&entered?.gate===gate,'ordinary-installation-genuine-entered-lease');assert(!activationFailures.has(binding.state)&&!activationBusy.has(binding.state),'ordinary-installation-startup-unavailable');
 const current=await installationContext(owner),base=entered.context;
 for(const key of ['database','pid','start','root'])assert.equal(current[key],base[key],'ordinary-installation-same-native-transaction');
 assert.equal(current.read_only,'off');assert.equal(current.owner,'postgres');assert.equal(current.role,'dyna_app');assert.equal(current.role_setting,'dyna_app');assert.equal(current.tenant,tenant);assert.equal(current.replication,'origin');assert.equal(current.timezone,'UTC');assert.equal(current.timeout,'8s');
 assert.deepEqual(schemaGenerations.get(binding.state),binding.generation,'ordinary-installation-approved-generation');
 const cold=ordinaryInstallationCuts.get(binding.state);assert(cold);assert.deepEqual(cold.generation,binding.generation,'ordinary-installation-fact-generation');
 return {binding,entered,cold};
}
async function prepareOrdinaryInstallation(owner,gate,tenant){
 if(!ordinaryEnteredInstallations.has(owner))return undefined; // RO/no entered RW scope retains full legacy checks.
 const held=await requireEnteredInstallation(owner,gate,tenant);let cut,failed=false,first;
 try{await owner.query('SET LOCAL ROLE NONE');cut=await readCurrentInstallationCut(owner,true,Object.keys(held.cold.installation.cut.seals),held.cold);assert.deepEqual(cut,held.cold.installation,'ordinary-installation-live-seals-and-roles');}
 catch(e){failed=true;first=e;}
 finally{try{await owner.query('SET LOCAL ROLE dyna_app');}catch(e){if(!failed){failed=true;first=e;}}}
 if(failed)throw first;const closing=await requireEnteredInstallation(owner,gate,tenant);assert.equal(closing.entered,held.entered);
 const fact=Object.freeze({schema:'ordinary-entered-installation-only/v1'});ordinaryPreparedInstallations.set(fact,Object.freeze({owner,gate,tenant,entered:held.entered}));return fact;
}
async function verifyOrdinaryInstallation(owner,gate,tenant,fact){
 const issued=ordinaryPreparedInstallations.get(fact);assert(issued&&issued.owner===owner&&issued.gate===gate&&issued.tenant===tenant,'ordinary-installation-private-fact-required');
 const held=await requireEnteredInstallation(owner,gate,tenant);assert.equal(held.entered,issued.entered,'ordinary-installation-not-reentered');
 const rows=(await owner.query(INSTALLATION_ROLE_SQL)).rows;assert.equal(rows.length,1);checkInstallationRoles(rows[0].metadata);assert.deepEqual(rows[0].metadata,held.cold.installation.metadata,'ordinary-installation-fresh-role-inheritance');
}

// Separate RO authority. Both209 full rows stay fresh: replica-mode owner DML
// can bypass their ordinary triggers without changing the schema generation.
const ORDER_READ_INSTALLATION_SEALS=Object.freeze([...INSTALLATION_SEALS,'order_merge_delivery209_manifest','order_merge_delivery209_projection_basis']);
const ordinaryOrderReadCuts=new WeakMap(),ordinaryOrderReadEntries=new WeakMap(),ordinaryOrderReadFacts=new WeakMap();
const ORDER_READ_CONTEXT_SQL=`SELECT current_database() database,pg_backend_pid() pid,transaction_timestamp()::text start,current_setting('transaction_read_only') read_only,current_setting('transaction_isolation') isolation,current_user::text role,session_user::text owner,current_setting('role',true) role_setting,current_setting('app.tenant_id',true) tenant,current_setting('session_replication_role') replication,current_setting('TimeZone') timezone,current_setting('statement_timeout') timeout`;
async function orderReadContext(owner){const rows=(await owner.query(ORDER_READ_CONTEXT_SQL)).rows;assert.equal(rows.length,1);return structuredClone(rows[0]);}
function clearOrderReadInstallation(owner){
 const entry=ordinaryOrderReadEntries.get(owner);for(const fact of entry?.facts??[])ordinaryOrderReadFacts.delete(fact);
 ordinaryOrderReadEntries.delete(owner);
}
async function recordOrderReadInstallation(owner,gate){
 clearOrderReadInstallation(owner);const context=await orderReadContext(owner);
 if(context.read_only!=='on'||context.isolation!=='repeatable read')return;
 assert.equal(context.owner,'postgres');assert.equal(context.role,'postgres');assert.equal(context.role_setting,'none');
 assert.equal(context.replication,'origin');assert.equal(context.timezone,'UTC');assert.equal(context.timeout,'8s');
 assert(typeof context.database==='string'&&context.database.length>0&&typeof context.start==='string'&&context.start.length>0&&Number.isSafeInteger(context.pid)&&context.pid>0);
 ordinaryOrderReadEntries.set(owner,{gate,context,facts:new Set()});
}
async function requireOrderReadInstallation(owner,gate,tenant){
 const binding=ordinaryInstallationGates.get(gate),entry=ordinaryOrderReadEntries.get(owner);
 assert(binding&&entry?.gate===gate,'ordinary-order-read-genuine-entered-lease');
 assert(!activationFailures.has(binding.state)&&!activationBusy.has(binding.state),'ordinary-order-read-startup-unavailable');
 const current=await orderReadContext(owner);
 for(const key of ['database','pid','start'])assert.equal(current[key],entry.context[key],'ordinary-order-read-same-native-transaction');
 assert.equal(current.read_only,'on');assert.equal(current.isolation,'repeatable read');assert.equal(current.owner,'postgres');
 assert.equal(current.role,'dyna_app');assert.equal(current.role_setting,'dyna_app');assert.equal(current.tenant,tenant);
 assert.equal(current.replication,'origin');assert.equal(current.timezone,'UTC');assert.equal(current.timeout,'8s');
 assert.deepEqual(schemaGenerations.get(binding.state),binding.generation,'ordinary-order-read-approved-generation');
 const cold=ordinaryOrderReadCuts.get(binding.state);assert(cold,'ordinary-order-read-committed-cold-fact');
 assert.deepEqual(cold.generation,binding.generation,'ordinary-order-read-cold-generation');
 return{entry,cold};
}
async function prepareOrderReadInstallation(owner,gate,tenant,identity){
 if(!ordinaryOrderReadEntries.has(owner))return undefined; // outside this managed RRRO lease the full guard remains
 assert(identity&&typeof identity==='object','ordinary-order-read-private-transaction-identity');
 const held=await requireOrderReadInstallation(owner,gate,tenant);let cut,failed=false,first;
 try{await owner.query('SET LOCAL ROLE NONE');cut=await readCurrentInstallationCut(owner,false,Object.keys(held.cold.installation.cut.seals),held.cold);
  assert.deepEqual(cut,held.cold.installation,'ordinary-order-read-fresh-full-seals-markers-roles');}
 catch(e){failed=true;first=e;}
 finally{try{await owner.query('SET LOCAL ROLE dyna_app');}catch(e){if(!failed){failed=true;first=e;}}}
 if(failed)throw first;
 assert.equal((await requireOrderReadInstallation(owner,gate,tenant)).entry,held.entry,'ordinary-order-read-not-reentered');
 const fact=Object.freeze({});ordinaryOrderReadFacts.set(fact,{owner,gate,tenant,identity,entry:held.entry});held.entry.facts.add(fact);return fact;
}
async function consumeOrderReadInstallation(owner,gate,tenant,identity,fact){
 const held=ordinaryOrderReadFacts.get(fact);assert(held&&held.owner===owner&&held.gate===gate&&held.tenant===tenant&&held.identity===identity,'ordinary-order-read-private-one-use-fact');
 ordinaryOrderReadFacts.delete(fact);held.entry.facts.delete(fact); // one use, including a failed await
 assert.equal((await requireOrderReadInstallation(owner,gate,tenant)).entry,held.entry,'ordinary-order-read-not-reentered');
}

const ordinarySchemaGates=new WeakSet();
async function inspectOrdinarySchemaExtension(owner,state){
 const extension=state.input.compatibility.ordinary_schema_extension;
 assert(extension&&extension.protected_original44_unchanged_from182===true,'ordinary184-source-extension');
 const rows=(await owner.query(extension.independent_anchor_sql)).rows;assert.equal(rows.length,1);
 assert.deepEqual(rows[0].extension,{roster:extension.helpers.map(h=>h.name).sort(),anchors:[...extension.helpers.map(()=>true),true]},'ordinary184-independent-raw-helper-descriptors');
 // Available capabilities are schema facts only, checked once within the SAME
 // owner exclusive-fenced cold transaction. No Actor/session/result is retained.
 for(const fixed of ['pim_dictionary_valid','nested172_valid','parcel_physical_wz_valid','operative_delivery_valid']){const rows=(await owner.query('SELECT public.'+fixed+'() AS valid')).rows;assert.equal(rows.length,1);assert.equal(rows[0].valid,true,'ordinary184-cold-capability-predicate:'+fixed);}
}
export function createOrdinarySchemaTransactionGate(handle){
 const state=privateState(handle);
 assert(coldEnabled(state)&&!activationFailures.has(state)&&!activationBusy.has(state),'ordinary184-approved-startup-required');
 const approved=schemaGenerations.get(state);assert(approved,'ordinary184-cold-approval-required');
 inspectConsumerReceipt(state,approved);inspectKeeperResourceReceipt198(state,approved);
 const expected=structuredClone(approved);const installation=ordinaryInstallationCuts.get(state);assert(installation,'ordinary-installation-committed-cold-fact');assert.deepEqual(installation.generation,expected);
 const gate=Object.freeze({async reserve(owner){
  assert(!activationFailures.has(state)&&!activationBusy.has(state),'ordinary184-startup-failed');
  await requireIdleActivationOwner(owner);
  // Idle session reservation precedes BEGIN and its first RR snapshot. Caller
  // must destroy connection if acquisition/cleanup response is uncertain.
  await owner.query('SELECT pg_advisory_lock_shared(982376)');
  let holding=true;
  return Object.freeze({async enter(){
   await gate.enter(owner);
   const rows=(await owner.query('SELECT pg_advisory_unlock_shared(982376) AS released')).rows;
   assert.equal(rows[0]?.released,true,'ordinary184-session-fence-transfer');holding=false;
  },async close(){try{if(holding){const rows=(await owner.query('SELECT pg_advisory_unlock_shared(982376) AS released')).rows;assert.equal(rows[0]?.released,true,'ordinary184-session-fence-cleanup');holding=false;}}finally{clearOrderReadInstallation(owner);}}});
 },async prepareReadInstallation(owner,tenant,identity){return prepareOrderReadInstallation(owner,gate,tenant,identity);},async consumeReadInstallation(owner,tenant,identity,fact){return consumeOrderReadInstallation(owner,gate,tenant,identity,fact);},async prepareInstallation(owner,tenant){return prepareOrdinaryInstallation(owner,gate,tenant);},async verifyInstallation(owner,tenant,fact){return verifyOrdinaryInstallation(owner,gate,tenant,fact);},async enter(owner){
  ordinaryEnteredInstallations.delete(owner);clearOrderReadInstallation(owner);
  assert(!activationFailures.has(state)&&!activationBusy.has(state),'ordinary184-startup-failed');
  const connection=owner.connection;assert(connection&&typeof connection.on==='function'&&typeof connection.removeListener==='function','ordinary184-real-transaction-client');
  let status;const ready=message=>{status=message.status;};connection.on('readyForQuery',ready);
  try{
   // owner_gate takes shared982376 BEFORE reading stamp; actual BEGIN precedes
   // this call, so it fences every later actor/catalog/quota/constraint wait.
   const current=await readGeneration(owner,state);
   assert.equal(status,'T','ordinary184-fence-requires-active-transaction');
   assert.deepEqual(current,expected,'ordinary184-generation-changed-restart-required');
   await recordEnteredInstallation(owner,gate);await recordOrderReadInstallation(owner,gate);assert.equal(status,'T','ordinary-installation-active-native-transaction');
  }finally{connection.removeListener('readyForQuery',ready);}
 }});ordinarySchemaGates.add(gate);ordinaryInstallationGates.set(gate,Object.freeze({state,generation:expected}));return gate;
}
export function assertOwnedOrdinarySchemaTransactionGate(gate){assert(ordinarySchemaGates.has(gate),'ordinary184-genuine-startup-gate-required');}
async function inspectRuntimeGeneration(owner,state){
 if(!coldEnabled(state))return inspectComparedProfile(owner,state.input,state.kind,state.assertSourceExpectation);
 assert(!activationFailures.has(state),'cold-activation-handle-failed');assert(!activationBusy.has(state),'cold-activation-not-committed');
 const current=await readGeneration(owner,state),previous=schemaGenerations.get(state);
 inspectConsumerReceipt(state,current);inspectKeeperResourceReceipt198(state,current);
 if(previous)assert.deepEqual(current,previous,'runtime-generation-changed-restart-required');
 else schemaGenerations.set(state,current); // owner-approved persisted stamp + exact freshly consumed release; never a caller READY JSON.
 return {status:'RUNTIME_GENERATION_MATCHED_AFTER_OWNER_COLD_VALIDATION',certified_graph:true,profile_native_sha256:current.profile_native_sha256,application_activation:false,
  pending:'Native IAM/quota/publication remain fresh; generation does not enable public import',integrity_cadence:'COLD_FULL_VALIDATION_HOT_NATIVE_GENERATION_CHECK',schema_generation:current.generation,consumer_credit_inspection:inspectConsumerReceipt(state,current),keeper_resource_inspection:inspectKeeperResourceReceipt198(state,current)};
}
export async function inspectCompositeStartup(owner,handle){
 const state=privateState(handle);
 if(coldEnabled(state))return inspectRuntimeGeneration(owner,state);
 await verifyEvidence(state);
 let result,first,failed=false;try{result=await inspectComparedProfile(owner,state.input,state.kind,state.assertSourceExpectation);}catch(error){failed=true;first=error;}
 try{await verifyEvidence(state,failed);}catch(error){if(!failed)throw error;}
 if(failed)throw first;return result;
}
// This lifetime owns package evidence only. It never carries an Actor, native
// admission verdict, client, transaction, readiness flag or caller evaluator.
const releaseOperations=new WeakMap();
function operationState(handle,operation){
 const state=privateState(handle),held=releaseOperations.get(operation);
 assert(held&&held.state===state,'startup-operation-exact-private-handle');
 assert.equal(held.phase,'open','startup-operation-no-late-use');return held;
}
/** Full opening cut before any fixed engine native/FS action. */
export async function beginReviewedStartupOperation(handle){
 const state=privateState(handle);
 assert(state.kind==='portable'&&state.packageKind==='emitted','startup-operation-emitted-package-only');
 await verifyEvidence(state,true);
 const operation=Object.freeze({schema:'large-import173-private-release-operation/v1'});
 releaseOperations.set(operation,{state,phase:'open',active:new Set(),closing:null,nativeFailed:false,nativeFirst:undefined});return operation;
}
/** SAME fresh owner/catalogue/certificate inspection; no cross-TX native cache. */
export function inspectCompositeStartupInOperation(owner,handle,operation){
 const held=operationState(handle,operation);
 // Register synchronously so close cannot overtake an already-started inspection.
 const work=inspectRuntimeGeneration(owner,held.state);
 held.active.add(work);work.then(()=>held.active.delete(work),error=>{if(!held.nativeFailed){held.nativeFailed=true;held.nativeFirst=error;}held.active.delete(work);});return work;
}
function portableClosure(state,report){
 return {status:'PORTABLE_STARTUP_FORCED_FULL_SOURCE_RELEASE_RECHECK_COMPLETE',file_count:report.file_count,bytes:report.bytes,complete:true,force_full_hash:true,release_manifest_sha256:state.manifestSha,scope:state.packageKind==='emitted'?'EMITTED_RELEASE_FULL_BYTES_NO_CACHE':'PORTABLE_RELEASE_FULL_BYTES_NO_CACHE',installation:'NOT_RUN',application_activation:false};
}
/** Refuse new inspections immediately, drain started native inspections, then
 * ALWAYS attempt the complete closing package cut. Engine work/clients are
 * drained by the fixed caller before this; this lifetime does not own a pool. */
export function closeReviewedStartupOperation(handle,operation){
 const state=privateState(handle),held=releaseOperations.get(operation);
 assert(held&&held.state===state,'startup-operation-exact-private-handle');
 if(held.closing)return held.closing;
 assert.equal(held.phase,'open','startup-operation-already-closed');held.phase='closing';
 held.closing=(async()=>{
  try{
   await Promise.allSettled([...held.active]);let report,cutFailed=false,cutFirst;
   try{report=await verifyEvidence(state,true);}catch(error){cutFailed=true;cutFirst=error;}
   if(held.nativeFailed)throw held.nativeFirst;
   if(cutFailed)throw cutFirst;return portableClosure(state,report);
  }finally{held.phase='closed';}
 })();return held.closing;
}

/** Force full closure for BOTH actual opaque handle variants, including caller failure cleanup. */
export async function recheckReviewedStartupEvidence(handle){
 const state=privateState(handle);
 if(state.kind==='portable'){
  const report=await verifyEvidence(state,true);
  return portableClosure(state,report);
 }
 await verifyEvidence(state,true);return state.cache.metrics();
}
