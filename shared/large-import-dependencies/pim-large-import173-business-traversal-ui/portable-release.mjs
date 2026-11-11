/** Portable integrity only. No DB, application, startup capability or readiness. */
import assert from 'node:assert/strict';
import {assertOrdinary177Contract,ORDINARY177_CONTRACT_SHA,ORDINARY177_SCHEMA} from './ordinary177-contract.mjs';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA='dynaminds-importer-source-release/v1';
export const sha=b=>createHash('sha256').update(b).digest('hex');
const PACKING_NATIVE_ID='packing189_required_fields',PACKING_RESOURCE_ID='sql:server/189_packing_required_order_fields.sql',PACKING_SQL_PATH='resources/server/189_packing_required_order_fields.sql',PACKING_LEGACY_PATH='native/189_packing_required_order_fields.sql',PACKING_DUAL_ROLE='native-sql-runtime-resource';
const ROLES=new Set(['runtime-source','held-adapter-source','native-sql','catalog-query','expected-profile','source-inventory','adapter-abi','compatibility-contract',PACKING_DUAL_ROLE]);
const MAX_FILE=32*1024*1024,MAX_TOTAL=64*1024*1024;
export function relativeName(name){
 assert(typeof name==='string'&&name.length>0&&name.length<=500&&!/[\\\0:]/.test(name),'release-relative-path');
 assert(!path.posix.isAbsolute(name)&&name===path.posix.normalize(name),'release-path-normalized');
 assert(name.split('/').every(x=>x!==''&&x!=='.'&&x!=='..'),'release-path-escape');
 return name;
}
const signature=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
export async function canonicalRoot(root){
 assert(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)===root,'release-root-absolute-canonical');
 const st=await fs.lstat(root);assert(st.isDirectory()&&!st.isSymbolicLink(),'release-root-directory');
 assert.equal(await fs.realpath(root),root,'release-root-alias');return root;
}
/** Each ancestor, FD and final path is checked; no symlink/hardlink/hash fallback. */
export async function packageBytes(root,name){
 relativeName(name);await canonicalRoot(root);
 let current=root;for(const segment of name.split('/').slice(0,-1)){
  current=path.join(current,segment);const st=await fs.lstat(current);
  assert(st.isDirectory()&&!st.isSymbolicLink(),'release-parent-directory');assert.equal(await fs.realpath(current),current,'release-parent-alias');
 }
 const file=path.join(root,...name.split('/')),before=await fs.lstat(file,{bigint:true});
 assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size<=BigInt(MAX_FILE),'release-regular-bounded-file');
 let fd,first;try{
  fd=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=await fd.stat({bigint:true});assert.equal(signature(opened),signature(before),'release-open-drift');
  const bytes=await fd.readFile();assert.equal(bytes.length,Number(before.size),'release-size-drift');
  const after=await fd.stat({bigint:true}),live=await fs.lstat(file,{bigint:true});
  assert.equal(signature(after),signature(before),'release-fd-drift');assert.equal(signature(live),signature(before),'release-path-drift');
  assert.equal(await fs.realpath(file),file,'release-file-alias');return bytes;
 }catch(e){first=e;throw e;}finally{if(fd)try{await fd.close();}catch(e){if(!first)throw e;}}
}
export async function packageInventory(root){
 await canonicalRoot(root);const files=[];
 async function visit(dir,prefix){for(const entry of await fs.readdir(dir,{withFileTypes:true})){
  const name=prefix+entry.name;relativeName(name);const full=path.join(dir,entry.name),st=await fs.lstat(full);
  assert(!st.isSymbolicLink(),'release-inventory-symlink');
  if(st.isDirectory())await visit(full,name+'/');else{assert(st.isFile()&&st.nlink===1,'release-inventory-regular');files.push(name);}
 }}await visit(root,'');return files.sort();
}
function exactKeys(x,keys){assert(x&&typeof x==='object'&&!Array.isArray(x));assert.deepEqual(Object.keys(x).sort(),[...keys].sort(),'release-exact-fields');}
/** Literal source inventory parser, shared by generator and verifier. */
export function operationAbi(text){
 const match=/export const OPERATIONS = \{([\s\S]*?)\} as const;/.exec(text);assert(match,'real-operation-inventory');
 const operations=[];let rest=match[1];for(const m of match[1].matchAll(/'([a-z0-9-]+)'\s*:\s*\[([^\]]*)\]\s*,/g)){
  const charges=m[2].split(',').map(x=>x.trim()).filter(Boolean);assert(charges.every(x=>/^'[a-z0-9-]+'$/.test(x)));operations.push({name:m[1],charges:charges.map(x=>x.slice(1,-1))});rest=rest.replace(m[0],'');
 }assert.equal(rest.trim(),'','operation-inventory-literal-only');assert(operations.length>0&&new Set(operations.map(x=>x.name)).size===operations.length);return operations;
}
/** expectedManifestSha comes from trusted local build selection, never from the package itself. */
export async function validateRelease(root,{expectedManifestSha}={}){
 assert(typeof expectedManifestSha==='string'&&/^[a-f0-9]{64}$/.test(expectedManifestSha),'release-trusted-manifest-sha-required');
 const raw=await packageBytes(root,'release.json');assert.equal(sha(raw),expectedManifestSha,'release-manifest-tamper');const manifest=JSON.parse(raw);
 exactKeys(manifest,['schema','version','scope','origin','native_contract','adapter_contract','files','excluded_authority']);
 assert.equal(manifest.schema,SCHEMA);assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(manifest.version));
 assert.equal(manifest.scope,'SOURCE_CONTRACT_PROTOTYPE_NOT_EXECUTABLE_DISTRIBUTION');assert.equal(manifest.origin,'REAL_SOURCE_DERIVED_EXPECTATION_NOT_OBSERVED_NATIVE_AUTHORITY');
 assert.deepEqual(manifest.excluded_authority,['native-installation','startup-capability','public-readiness','historical-tool-receipts','runtime-row-snapshots']);
 assert(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=4096);const names=new Set(),data=new Map();let total=0;
 for(const item of manifest.files){exactKeys(item,['path','sha256','bytes','role']);relativeName(item.path);assert(item.path!=='release.json'&&!names.has(item.path),'release-duplicate-member');names.add(item.path);
  assert(ROLES.has(item.role)&&/^[a-f0-9]{64}$/.test(item.sha256)&&Number.isSafeInteger(item.bytes)&&item.bytes>=0&&item.bytes<=MAX_FILE,'release-member-shape');
  total+=item.bytes;assert(total<=MAX_TOTAL,'release-total-cap');const bytes=await packageBytes(root,item.path);assert.equal(bytes.length,item.bytes);assert.equal(sha(bytes),item.sha256,'release-member-tamper');data.set(item.path,bytes);
 }
 assert.deepEqual(await packageInventory(root),['release.json',...names].sort(),'release-exact-inventory');
 const get=(name,role)=>{relativeName(name);assert.equal(manifest.files.find(x=>x.path===name)?.role,role,'release-linked-role');return JSON.parse(data.get(name));};
 exactKeys(manifest.native_contract,['profile','inventory','catalog_query','sql_graph','functions','relations','basis',...(manifest.native_contract.compatibility===undefined?[]:['compatibility'])]);
 assert.equal(manifest.native_contract.basis,'COMPLETE_REVIEWED_SOURCE_PROPOSAL_NOT_LIVE_ROWS');
 const profile=get(manifest.native_contract.profile,'expected-profile'),inventory=get(manifest.native_contract.inventory,'source-inventory');
 assert(Array.isArray(profile.functions)&&Array.isArray(profile.relations));assert.equal(profile.functions.length,manifest.native_contract.functions);assert.equal(profile.relations.length,manifest.native_contract.relations);
 assert.equal(inventory.counts.functions,profile.functions.length);assert.equal(inventory.counts.relations,profile.relations.length);
 const expected=new Map(profile.functions.map(f=>[f.signature,f]));assert.equal(expected.size,profile.functions.length);
 for(const f of inventory.functions){const observed=expected.get(f.signature);assert(observed,'release-complete-source-function');for(const key of ['body_sha256','result','language','security_definer','volatility','strict','configuration','defaults'])assert.deepEqual(observed[key],f[key],'release-source-profile-function-'+key);}
 assert(!Object.hasOwn(profile,'graph')&&!Object.hasOwn(profile,'rows'),'release-no-row-snapshot');
 assert.deepEqual(inventory.source_graph,manifest.native_contract.sql_graph);assert.deepEqual(inventory.query,manifest.native_contract.catalog_query);
 const packingEdges=manifest.native_contract.sql_graph.filter(s=>s.id===PACKING_NATIVE_ID);assert(packingEdges.length<=1,'packing-native-edge-unique');
 if(packingEdges.length)assert([PACKING_LEGACY_PATH,PACKING_SQL_PATH].includes(packingEdges[0].path),'packing-native-fixed-path');
 const packingAlias=packingEdges[0]?.path===PACKING_SQL_PATH;
 const dualMembers=manifest.files.filter(f=>f.role===PACKING_DUAL_ROLE);assert.deepEqual(dualMembers.map(f=>f.path),packingAlias?[PACKING_SQL_PATH]:[],'packing-dual-role-one-fixed-member');
 if(packingAlias)assert.equal(manifest.native_contract.sql_graph.filter(s=>s.path===PACKING_SQL_PATH).length,1,'packing-native-path-no-other-edge');
 const sqlIds=new Set();for(const module of manifest.native_contract.sql_graph){exactKeys(module,['id','path','sha256']);assert(!sqlIds.has(module.id)&&/^[a-z0-9_]+$/.test(module.id));sqlIds.add(module.id);relativeName(module.path);
  const nativeRole=module.id===PACKING_NATIVE_ID&&packingAlias?PACKING_DUAL_ROLE:'native-sql';assert.equal(manifest.files.find(x=>x.path===module.path)?.role,nativeRole);assert.equal(sha(data.get(module.path)),module.sha256);
 }
 const compatibility=manifest.native_contract.compatibility;
 const has179=manifest.native_contract.sql_graph.some(s=>s.id==='ordinary182_cold_runtime_admission');
 assert.equal(compatibility!==undefined,has179,'dual173-migration-contract-together');
 if(compatibility!==undefined){exactKeys(compatibility,['schema','path','sha256']);assert.equal(compatibility.schema,ORDINARY177_SCHEMA);assert.equal(compatibility.sha256,ORDINARY177_CONTRACT_SHA);assert.equal(sha(data.get(compatibility.path)),ORDINARY177_CONTRACT_SHA);const c=get(compatibility.path,'compatibility-contract');assertOrdinary177Contract(c,profile);assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='ordinary182_cold_runtime_admission')?.sha256,c.migration_sha256);assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='ordinary181_same_root_observations')?.sha256,c.optimization_source_basis.predecessor181_migration_sha256,'exact-retained181-predecessor');assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='ordinary184_ordinary_schema_admission')?.sha256,c.ordinary_schema_extension.migration_sha256,'exact184-extension');assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='ordinary185_private_keeper_generation')?.sha256,c.keeper_schema_extension.migration_sha256,'exact185-extension');assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='ordinary186_core_review_alias_binding')?.sha256,c.core_review_alias_extension.migration_sha256,'exact186-extension');assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='ordinary187_durable_original_writer_epoch')?.sha256,c.durable_writer_epoch_extension.migration_sha256,'exact187-extension');assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='consumer188_business')?.sha256,c.consumer_credit_extension.migration.sha256,'exact188-business');assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='consumer188_structure')?.sha256,c.consumer_credit_extension.structure_migration.sha256,'exact188-structure');assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='ordinary183_original_key_recovery')?.sha256,c.ordinary_schema_extension.recovery183_migration_sha256,'exact183-recovery-native-source');assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='ordinary180_consistent_history_dag')?.sha256,c.optimization_source_basis.predecessor180_migration_sha256,'exact-retained180-predecessor');assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='ordinary179_shared_manual_dag')?.sha256,c.optimization_source_basis.predecessor179_migration_sha256,'exact-retained179-predecessor');assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='ordinary178_compatibility')?.sha256,c.optimization_source_basis.predecessor_migration_sha256,'exact-retained178-predecessor');}
 if(manifest.native_contract.compatibility!==undefined){const extension203=get(manifest.native_contract.compatibility.path,'compatibility-contract').quota_partial_core203_extension;assert(extension203&&extension203.schema==='source203-known-partial-core-quota-exact-inverse/v1'&&extension203.old202_and_native17344_literal===true&&extension203.actual_runtime_acceptance===false,'exact203-source-extension');assert.equal(manifest.native_contract.sql_graph.find(s=>s.id==='ordinary203_known_partial_core_quota')?.sha256,extension203.migration_sha256,'exact203-native-edge');}
 const query=manifest.native_contract.catalog_query;exactKeys(query,['path','sha256']);relativeName(query.path);assert.equal(manifest.files.find(x=>x.path===query.path)?.role,'catalog-query');assert.equal(sha(data.get(query.path)),query.sha256);
 exactKeys(manifest.adapter_contract,['abi','inventory_source','native_group_cap','coverage']);assert.equal(manifest.adapter_contract.native_group_cap,64);assert.equal(manifest.adapter_contract.coverage,'SOURCE_IDENTITIES_ONLY_NATIVE_WIRING_NOT_RUN');
 const abi=get(manifest.adapter_contract.abi,'adapter-abi');assert.equal(abi.schema,'dynaminds-importer-adapter-abi/v1');assert.equal(abi.operations_source,manifest.adapter_contract.inventory_source);
 assert.equal(manifest.files.find(x=>x.path===abi.operations_source)?.role,'runtime-source');assert(Array.isArray(abi.operations)&&abi.operations.length>0&&new Set(abi.operations.map(x=>x.name)).size===abi.operations.length);
 assert.deepEqual(abi.operations,operationAbi(data.get(abi.operations_source).toString('utf8')),'release-real-operation-abi');
 assert.equal(manifest.files.find(x=>x.path===abi.definition_source)?.role,'held-adapter-source');
 // Close with another complete bounded byte cut; never cache a package from an earlier invocation.
 for(const item of [{path:'release.json',sha256:expectedManifestSha},...manifest.files])assert.equal(sha(await packageBytes(root,item.path)),item.sha256,'release-final-cut-tamper');
 assert.deepEqual(await packageInventory(root),['release.json',...names].sort(),'release-final-inventory');
 // A relocation changes no release identity. Output is data only: it cannot mint a Startup/Actor.
 return {status:'PORTABLE_IMPORTER_SOURCE_RELEASE_INTEGRITY_VERIFIED_NOT_INSTALLED',manifest_sha256:expectedManifestSha,version:manifest.version,file_count:names.size,bytes:total,native_functions:profile.functions.length,native_relations:profile.relations.length,operation_count:abi.operations.length,installation:'NOT_RUN',startup_authority:false,application_activation:false};
}
