/** Compiled package intake DATA only. Startup/private resources mint elsewhere. */
import assert from 'node:assert/strict';
import {assertOrdinary177Contract,ORDINARY177_CONTRACT_SHA,ORDINARY177_SCHEMA} from './ordinary177-contract.mjs';
import {packageBytes,packageInventory,sha,relativeName,operationAbi} from './portable-release.mjs';
import {EMITTED209_SCHEMA,RESOURCES209_SCHEMA,RESOURCE209_DEFINITION,storage209,assertStorage209Partition} from './resource-format209.mjs';
import {decodeResource209} from './resource-io.mjs';
const exact=(v,keys)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...keys].sort());};
function frozen(v){if(v&&typeof v==='object'){for(const x of Object.values(v))frozen(x);Object.freeze(v);}return v;}
const PACKING_NATIVE_ID='packing189_required_fields',PACKING_RESOURCE_ID='sql:server/189_packing_required_order_fields.sql',PACKING_SQL_PATH='resources/server/189_packing_required_order_fields.sql',PACKING_LEGACY_PATH='native/189_packing_required_order_fields.sql',PACKING_DUAL_ROLE='native-sql-runtime-resource';
const utf8=b=>new TextDecoder('utf-8',{fatal:true}).decode(b);
export async function loadValidatedEmittedRelease(options){
 exact(options,['releaseDirectory','manifestSha']);const {releaseDirectory,manifestSha}=structuredClone(options);
 assert(/^[a-f0-9]{64}$/.test(manifestSha));
 const raw=await packageBytes(releaseDirectory,'release.json');assert.equal(sha(raw),manifestSha,'emitted-manifest-consumed-sha');const m=JSON.parse(utf8(raw));
 const v2=m.schema===EMITTED209_SCHEMA;assert(v2||m.schema==='dynaminds-emitted-local-release/v1','emitted-known-format');if(v2)assert(m.resource_contract,'emitted209-resource-contract-required');assert.equal(m.scope,'EMITTED_LOCAL_PACKAGE_RESOURCE_REVIEW_PENDING');
 assert.equal(m.origin,'REAL_SOURCE_DERIVED_EXPECTATION_NOT_OBSERVED_NATIVE_AUTHORITY');assert.equal(m.application_activation,false);
 assert.equal(m.native_installation,'NOT_RUN');assert.equal(m.installed_adapter_acceptance,'NOT_AVAILABLE');assert(['NOT_PROVEN','HASHED_FULL_HOST_DIST'].includes(m.static_resource_completeness));
 assert(Array.isArray(m.files)&&m.files.length>0&&m.files.length<=4096);let total=0;const data=new Map(),members=new Map();
 for(const f of m.files){exact(f,['path','bytes','sha256','role']);relativeName(f.path);assert(f.path!=='release.json'&&!members.has(f.path));assert(Number.isSafeInteger(f.bytes)&&f.bytes>=0&&f.bytes<=32*1024*1024&&/^[a-f0-9]{64}$/.test(f.sha256),'emitted-member-32MiB');
  total+=f.bytes;assert(total<=128*1024*1024,'emitted-total-128MiB');const b=await packageBytes(releaseDirectory,f.path);assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256,'emitted-consumed-member-sha');members.set(f.path,f);data.set(f.path,b);
 }
 const linked=(name,role)=>{relativeName(name);assert.equal(members.get(name)?.role,role,'emitted-linked-role');const b=data.get(name);assert(b);return b;};
 assert.deepEqual(await packageInventory(releaseDirectory),['release.json',...members.keys()].sort(),'emitted-exact-inventory');
 if(m.static_resource_completeness==='HASHED_FULL_HOST_DIST'){
  const sc=m.static_contract;exact(sc,['schema','root','entry','members']);assert.equal(sc.schema,'dynaminds-host-dist/v1');assert.equal(sc.root,'dist');assert.equal(sc.entry,'dist/index.html');
  assert(Array.isArray(sc.members)&&sc.members.length>0);assert.equal(new Set(sc.members.map(f=>f.path)).size,sc.members.length);
  for(const f of sc.members){assert(f.path.startsWith('dist/'));assert.deepEqual(members.get(f.path),f);linked(f.path,'frontend-static');}
  assert.deepEqual(sc.members.map(f=>f.path).sort(),m.files.filter(f=>f.path.startsWith('dist/')).map(f=>f.path).sort());
  const index=utf8(linked(sc.entry,'frontend-static')),references=[...index.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(x=>'dist'+x[1]);
  assert(references.some(n=>n.endsWith('.js'))&&references.some(n=>n.endsWith('.css')),'emitted-static-entry-assets');for(const n of references)linked(n,'frontend-static');
 }else assert.equal(m.static_contract,undefined,'legacy-no-static-claim');
 const sourceRaw=linked('contract/source-release-manifest.json','source-contract-manifest');assert.equal(sha(sourceRaw),m.source_contract_manifest_sha256);const source=JSON.parse(utf8(sourceRaw));
 assert.equal(source.schema,'dynaminds-importer-source-release/v1');assert.equal(source.origin,m.origin);assert.equal(source.scope,'SOURCE_CONTRACT_PROTOTYPE_NOT_EXECUTABLE_DISTRIBUTION');
 assert.deepEqual(m.native_contract,source.native_contract);assert.deepEqual(m.adapter_contract,source.adapter_contract);
 const sourceMembers=new Map(source.files.map(f=>[f.path,f]));assert.equal(sourceMembers.size,source.files.length,'emitted-source-manifest-duplicate');
 const sourceLinked=(name,role)=>{const original=sourceMembers.get(name);assert(original&&original.role===role,'emitted-linked-source-member-required');const b=linked(name,role);assert.equal(b.length,original.bytes);assert.equal(sha(b),original.sha256);return b;};
 for(const f of source.files.filter(f=>members.has(f.path))){const b=linked(f.path,f.role);assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256,'emitted-native-source-contract-member');}
 const nc=m.native_contract,profile=JSON.parse(utf8(sourceLinked(nc.profile,'expected-profile'))),inventory=JSON.parse(utf8(sourceLinked(nc.inventory,'source-inventory')));
 assert.equal(nc.basis,'COMPLETE_REVIEWED_SOURCE_PROPOSAL_NOT_LIVE_ROWS');assert(!Object.hasOwn(profile,'graph')&&!Object.hasOwn(profile,'rows'));
 assert.equal(profile.functions.length,nc.functions);assert.equal(profile.relations.length,nc.relations);assert.equal(inventory.counts.functions,nc.functions);assert.equal(inventory.counts.relations,nc.relations);
 const functions=new Map(profile.functions.map(f=>[f.signature,f]));assert.equal(functions.size,profile.functions.length);assert.equal(inventory.functions.length,profile.functions.length);
 assert.equal(new Set(inventory.functions.map(f=>f.signature)).size,inventory.functions.length,'emitted-source-function-duplicate');assert.deepEqual(inventory.functions.map(f=>f.signature).sort(),[...functions.keys()].sort(),'emitted-source-full-function-signatures');
 for(const f of inventory.functions){const p=functions.get(f.signature);assert(p);for(const k of ['body_sha256','result','language','security_definer','volatility','strict','configuration','defaults'])assert.deepEqual(p[k],f[k]);}
 assert.deepEqual(inventory.source_graph,nc.sql_graph);assert.deepEqual(inventory.query,nc.catalog_query);
 const packingEdges=nc.sql_graph.filter(s=>s.id===PACKING_NATIVE_ID);assert(packingEdges.length<=1,'emitted-packing-native-edge-unique');
 if(packingEdges.length)assert([PACKING_LEGACY_PATH,PACKING_SQL_PATH].includes(packingEdges[0].path),'emitted-packing-native-fixed-path');
 const packingAlias=packingEdges[0]?.path===PACKING_SQL_PATH,packingEdge=packingEdges[0];
 assert.deepEqual(m.files.filter(f=>f.role===PACKING_DUAL_ROLE).map(f=>f.path),packingAlias?[PACKING_SQL_PATH]:[],'emitted-packing-dual-one-fixed-member');
 assert.deepEqual(source.files.filter(f=>f.role===PACKING_DUAL_ROLE).map(f=>f.path),packingAlias?[PACKING_SQL_PATH]:[],'emitted-source-packing-dual-one-fixed-member');
 if(packingAlias)assert.equal(nc.sql_graph.filter(s=>s.path===PACKING_SQL_PATH).length,1,'emitted-packing-native-path-unique');
 for(const sql of nc.sql_graph){const role=sql.id===PACKING_NATIVE_ID&&packingAlias?PACKING_DUAL_ROLE:'native-sql';assert.equal(sha(sourceLinked(sql.path,role)),sql.sha256);}
 if(packingAlias)assert(m.resource_contract!==undefined,'emitted-packing-runtime-partition-required');
 let compatibility;
 assert.equal(nc.compatibility!==undefined,nc.sql_graph.some(s=>s.id==='ordinary182_cold_runtime_admission'),'emitted-dual173-migration-contract-together');
 if(nc.compatibility!==undefined){exact(nc.compatibility,['schema','path','sha256']);assert.equal(nc.compatibility.schema,ORDINARY177_SCHEMA);assert.equal(nc.compatibility.sha256,ORDINARY177_CONTRACT_SHA);const b=sourceLinked(nc.compatibility.path,'compatibility-contract');assert.equal(sha(b),ORDINARY177_CONTRACT_SHA);compatibility=JSON.parse(utf8(b));assertOrdinary177Contract(compatibility,profile);assert.equal(nc.sql_graph.find(s=>s.id==='ordinary182_cold_runtime_admission')?.sha256,compatibility.migration_sha256);assert.equal(nc.sql_graph.find(s=>s.id==='ordinary181_same_root_observations')?.sha256,compatibility.optimization_source_basis.predecessor181_migration_sha256,'exact-retained181-predecessor');assert.equal(nc.sql_graph.find(s=>s.id==='ordinary184_ordinary_schema_admission')?.sha256,compatibility.ordinary_schema_extension.migration_sha256,'exact184-extension');assert.equal(nc.sql_graph.find(s=>s.id==='ordinary185_private_keeper_generation')?.sha256,compatibility.keeper_schema_extension.migration_sha256,'exact185-extension');assert.equal(nc.sql_graph.find(s=>s.id==='ordinary186_core_review_alias_binding')?.sha256,compatibility.core_review_alias_extension.migration_sha256,'exact186-extension');assert.equal(nc.sql_graph.find(s=>s.id==='ordinary187_durable_original_writer_epoch')?.sha256,compatibility.durable_writer_epoch_extension.migration_sha256,'exact187-extension');assert.equal(nc.sql_graph.find(s=>s.id==='consumer188_business')?.sha256,compatibility.consumer_credit_extension.migration.sha256,'exact188-business');assert.equal(nc.sql_graph.find(s=>s.id==='consumer188_structure')?.sha256,compatibility.consumer_credit_extension.structure_migration.sha256,'exact188-structure');assert.equal(nc.sql_graph.find(s=>s.id==='ordinary183_original_key_recovery')?.sha256,compatibility.ordinary_schema_extension.recovery183_migration_sha256,'exact183-recovery-native-source');assert.equal(nc.sql_graph.find(s=>s.id==='ordinary180_consistent_history_dag')?.sha256,compatibility.optimization_source_basis.predecessor180_migration_sha256,'exact-retained180-predecessor');assert.equal(nc.sql_graph.find(s=>s.id==='ordinary179_shared_manual_dag')?.sha256,compatibility.optimization_source_basis.predecessor179_migration_sha256,'exact-retained179-predecessor');assert.equal(nc.sql_graph.find(s=>s.id==='ordinary178_compatibility')?.sha256,compatibility.optimization_source_basis.predecessor_migration_sha256,'exact-retained178-predecessor');}
 const query=sourceLinked(nc.catalog_query.path,'catalog-query');assert.equal(sha(query),nc.catalog_query.sha256);
 const abi=JSON.parse(utf8(sourceLinked(m.adapter_contract.abi,'adapter-abi')));assert.deepEqual(abi.operations,operationAbi(utf8(sourceLinked(abi.operations_source,'runtime-source'))));sourceLinked(abi.definition_source,'held-adapter-source');
 assert.equal(sha(linked('package-lock.json','dependency-lock')),m.package_lock_sha256);
 assert(Array.isArray(m.entries)&&m.entries.length>0);for(const e of m.entries)linked(e.path,'emitted-runtime');
 assert.equal(m.private_startup_module_count,1,'emitted-private-startup-module-count');
 if(m.resource_contract!==undefined){
  const rc=m.resource_contract;exact(rc,['schema','definitions','members','missing']);assert.equal(rc.schema,v2?RESOURCES209_SCHEMA:'dynaminds-fixed-runtime-resources/v1');if(v2)assertStorage209Partition(rc,nc);
  assert(Array.isArray(rc.definitions)&&Array.isArray(rc.members)&&Array.isArray(rc.missing));const defs=new Map();
  for(const d of rc.definitions){exact(d,['id','source','path','consumer']);assert(typeof d.id==='string'&&!defs.has(d.id));relativeName(d.source);relativeName(d.path);relativeName(d.consumer);defs.set(d.id,d);}
  const accounted=new Set();for(const r of rc.members){exact(r,['id','path','bytes','sha256','role',...(v2&&Object.hasOwn(r,'storage')?['storage']:[])]);assert(!accounted.has(r.id));const d=defs.get(r.id);assert(d&&d.path===r.path);const alias=r.id===PACKING_RESOURCE_ID&&packingAlias;assert.equal(r.role,alias?PACKING_DUAL_ROLE:'runtime-resource','emitted-fixed-resource-role');if(alias){assert.equal(r.path,PACKING_SQL_PATH);assert.equal(d.source,'server/189_packing_required_order_fields.sql');assert.equal(d.consumer,'server/db.ts');assert.equal(r.sha256,packingEdge.sha256);assert.deepEqual(sourceMembers.get(r.path),{path:r.path,bytes:r.bytes,sha256:r.sha256,role:PACKING_DUAL_ROLE});}if(v2&&Object.hasOwn(r,'storage')){const storage=storage209(r);assert(!members.has(r.path),'emitted209-no-logical-copy');assert.deepEqual(members.get(storage.path),{path:storage.path,bytes:storage.bytes,sha256:storage.sha256,role:storage.role});const bytes=linked(storage.path,storage.role);if(r.id===RESOURCE209_DEFINITION.id){const decoded=decodeResource209(bytes);assert.equal(decoded.length,r.bytes);assert.equal(sha(decoded),r.sha256);}}else{assert.deepEqual(members.get(r.path),{path:r.path,bytes:r.bytes,sha256:r.sha256,role:r.role});linked(r.path,r.role);}accounted.add(r.id);}
  for(const id of rc.missing){assert(defs.has(id)&&!accounted.has(id));accounted.add(id);}assert.equal(accounted.size,defs.size);
  if(packingAlias){assert.equal(rc.members.filter(r=>r.id===PACKING_RESOURCE_ID).length,1,'emitted-packing-both-logical-roles-required');assert(!rc.missing.includes(PACKING_RESOURCE_ID),'emitted-packing-runtime-not-missing');}
  // Reader additionally compares definitions with its fixed code-owned set.
  // This parser never grants a caller-supplied logical resource mapping.
 }
 for(const f of [{path:'release.json',sha256:manifestSha},...m.files])assert.equal(sha(await packageBytes(releaseDirectory,f.path)),f.sha256,'emitted-final-full-byte-cut');
 assert.deepEqual(await packageInventory(releaseDirectory),['release.json',...members.keys()].sort());
 return frozen({releaseDirectory,manifestSha,manifest:m,expectedProfile:profile,compatibilityContract:compatibility,catalogueSql:utf8(query),catalogueSha256:nc.catalog_query.sha256,nativeContract:nc,adapterContract:m.adapter_contract,
  closure:{status:'EMITTED_RELEASE_FULL_BYTES_VERIFIED_NOT_INSTALLED',complete:true,force_full_hash:true,file_count:members.size,bytes:total,release_manifest_sha256:manifestSha,application_activation:false}});
}
