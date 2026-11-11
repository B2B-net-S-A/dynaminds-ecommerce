/** Real resource stage -> real emitted intake -> installed reader; no esbuild/app/PG. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {buildFixedRuntimeResources209} from '../tools/build/package-builder.mjs';
import {loadValidatedEmittedRelease} from '../tools/build/emitted-release.mjs';
import {RESOURCE187_ALIAS as A,RESOURCE209_ALIASES as LEGACY,EMITTED209_SCHEMA,storage209,assertStorage209Partition,hasResource187AliasEdge} from '../tools/build/resource-format209.mjs';
import {createInstalledRuntimeResourceReader,readInstalledRuntimeResource} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex'),json=v=>Buffer.from(JSON.stringify(v,null,2)+'\n'),edge=a=>({id:a.native_id,path:a.native_path,sha256:a.sha256});
async function fixture({v2=true,native187=true,corruptSource=false,missingNative=false}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dyna-187-alias-'))),source=root+'/source',release=root+'/release';
 await fs.mkdir(source+'/server',{recursive:true});await fs.mkdir(release);const files=[],originals=new Map();
 const put=async(name,b,role)=>{assert(b.length<=16777216);assert(!files.some(r=>r.path===name));await fs.mkdir(path.dirname(release+'/'+name),{recursive:true});await fs.writeFile(release+'/'+name,b,{flag:'wx',mode:0o600});files.push({path:name,bytes:b.length,sha256:sha(b),role});};
 try{
  for(const a of [...LEGACY,A]){const b=await fs.readFile(project+'server/'+path.basename(a.path));assert.equal(b.length,a.bytes);assert.equal(sha(b),a.sha256);originals.set(a.native_path,b);let input=b;if(corruptSource&&a===A){input=Buffer.from(b);input[0]^=1;}await fs.writeFile(source+'/server/'+path.basename(a.path),input);if((a!==A||native187)&&!(missingNative&&a===A))await put(a.native_path,b,'native-sql');}
  if(v2){await fs.copyFile(project+'server/209_order_merge_delivery_inheritance.sql',source+'/server/209_order_merge_delivery_inheritance.sql');await fs.writeFile(source+'/server/db.ts',"for (const [name, file] of [['209_order_merge_delivery_inheritance','./209_order_merge_delivery_inheritance.sql']]) {}");}
  const nc={profile:'contract/profile.json',inventory:'contract/inventory.json',catalog_query:{path:'native/query.sql',sha256:sha(Buffer.from('SELECT 1;'))},sql_graph:[...LEGACY,...(native187?[A]:[])].map(edge),functions:0,relations:0,basis:'COMPLETE_REVIEWED_SOURCE_PROPOSAL_NOT_LIVE_ROWS'},abi={schema:'dynaminds-importer-adapter-abi/v1',operations_source:'synthetic/operations.ts',definition_source:'synthetic/adapter.ts',operations:[{name:'synthetic-order',charges:['synthetic-charge']}]};
  await put(nc.profile,json({functions:[],relations:[]}),'expected-profile');await put(nc.inventory,json({counts:{functions:0,relations:0},functions:[],source_graph:nc.sql_graph,query:nc.catalog_query}),'source-inventory');await put(nc.catalog_query.path,Buffer.from('SELECT 1;'),'catalog-query');await put('contract/abi.json',json(abi),'adapter-abi');await put(abi.operations_source,Buffer.from("export const OPERATIONS = {\n 'synthetic-order': ['synthetic-charge'],\n} as const;"),'runtime-source');await put(abi.definition_source,Buffer.from('// held synthetic adapter'),'held-adapter-source');
  const sourceManifest={schema:'dynaminds-importer-source-release/v1',origin:'REAL_SOURCE_DERIVED_EXPECTATION_NOT_OBSERVED_NATIVE_AUTHORITY',scope:'SOURCE_CONTRACT_PROTOTYPE_NOT_EXECUTABLE_DISTRIBUTION',native_contract:nc,adapter_contract:{abi:'contract/abi.json',inventory_source:abi.operations_source,native_group_cap:64,coverage:'SOURCE_IDENTITIES_ONLY_NATIVE_WIRING_NOT_RUN'},files:structuredClone(files)},sourceRaw=json(sourceManifest);await put('contract/source-release-manifest.json',sourceRaw,'source-contract-manifest');
  const built=await buildFixedRuntimeResources209({projectRoot:source,outputRoot:release,files,put,contract:sourceManifest,contractBytes:async p=>{assert(originals.has(p));return originals.get(p);}}),lock=Buffer.from('{"lockfileVersion":3}');await put('package-lock.json',lock,'dependency-lock');await put('runtime/server/db.mjs',Buffer.from('// emitted consumer; not executed'),'emitted-runtime');
  const manifest={schema:v2?EMITTED209_SCHEMA:'dynaminds-emitted-local-release/v1',scope:'EMITTED_LOCAL_PACKAGE_RESOURCE_REVIEW_PENDING',origin:sourceManifest.origin,application_activation:false,native_installation:'NOT_RUN',installed_adapter_acceptance:'NOT_AVAILABLE',static_resource_completeness:'NOT_PROVEN',native_contract:nc,adapter_contract:sourceManifest.adapter_contract,source_contract_manifest_sha256:sha(sourceRaw),package_lock_sha256:sha(lock),entries:[{source:'server/db.ts',path:'runtime/server/db.mjs'}],private_startup_module_count:1,resource_contract:built.resourceContract,files};
  const save=async()=>{const b=json(manifest);await fs.writeFile(release+'/release.json',b,{mode:0o600});return sha(b);},manifestSha=await save();
  return{root,release,manifest,manifestSha,save,built,originals,sourceRaw,consumer:pathToFileURL(release+'/runtime/server/db.mjs'),close:()=>fs.rm(root,{recursive:true,force:true})};
 }catch(e){await fs.rm(root,{recursive:true,force:true});throw e;}
}
test('literal187 identity is optional and does not expand the three required legacy aliases',async()=>{
 assert.equal(LEGACY.length,3);assert.equal(A.bytes,1590107);assert.equal(A.sha256,'4e5b45aadf79c3c0b0613715b0e17ece2a5e61dbe2df44936ef83d81ad37bb63');assert.equal(A.native_id,'ordinary187_durable_original_writer_epoch');assert(hasResource187AliasEdge({sql_graph:[edge(A)]}));
 for(const edges of [[],[edge(A),edge(A)],[{...edge(A),sha256:'0'.repeat(64)}],[{...edge(A),id:'other'}]])assert.equal(hasResource187AliasEdge({sql_graph:edges}),false);
 assert.deepEqual(await fs.readFile(project+'tools/build/resource-format209.mjs'),await fs.readFile(project+'shared/large-import-dependencies/pim-large-import173-business-traversal-ui/resource-format209.mjs'));
});
test('actual builder retains every logical definition and Native byte, stores187 physically once, and genuine installed reads exact full SQL',async()=>{
 const f=await fixture();try{const logical=f.built.resourceContract.members.find(r=>r.id===A.id);assert.deepEqual(storage209(logical),{path:A.native_path,bytes:A.bytes,sha256:A.sha256,encoding:'identity',role:'native-sql'});assert.equal(f.manifest.files.filter(r=>r.path===A.native_path).length,1);assert(!f.manifest.files.some(r=>r.path===A.path));assert.deepEqual(f.manifest.native_contract.sql_graph,[...LEGACY,A].map(edge));assert.equal(f.manifest.resource_contract.definitions.find(r=>r.id===A.id).consumer,'server/db.ts');
  const loaded=await loadValidatedEmittedRelease({releaseDirectory:f.release,manifestSha:f.manifestSha});assert(loaded.closure.bytes<96*1024*1024);const reader=await createInstalledRuntimeResourceReader({releaseDirectory:f.release,manifestSha:f.manifestSha});assert.deepEqual(await readInstalledRuntimeResource(reader,A.id,f.consumer),f.originals.get(A.native_path));assert.deepEqual(await fs.readFile(f.release+'/contract/source-release-manifest.json'),f.sourceRaw);
  for(const mutate of [m=>m.native_contract.sql_graph=m.native_contract.sql_graph.filter(r=>r.id!==A.native_id),m=>m.native_contract.sql_graph.push(edge(A)),m=>m.native_contract.sql_graph.find(r=>r.id===A.native_id).sha256='0'.repeat(64),m=>m.resource_contract.members.push({...logical}),m=>m.resource_contract.members.find(r=>r.id===A.id).storage.path=A.path,m=>m.resource_contract.missing.push(A.id)]){const m=structuredClone(f.manifest);mutate(m);assert.throws(()=>assertStorage209Partition(m.resource_contract,m.native_contract));}
  const physical=f.release+'/'+A.native_path,bytes=await fs.readFile(physical),bad=Buffer.from(bytes);bad[0]^=1;await fs.writeFile(physical,bad);await assert.rejects(readInstalledRuntimeResource(reader,A.id,f.consumer));await fs.unlink(physical);await assert.rejects(readInstalledRuntimeResource(reader,A.id,f.consumer));await fs.writeFile(physical,bytes,{mode:0o600});assert.deepEqual(await readInstalledRuntimeResource(reader,A.id,f.consumer),bytes);
 }finally{await f.close();}
});
test('older v2 unaliased187 remains valid even with the same Native edge; alias cannot also retain a physical logical copy',async()=>{
 const f=await fixture();try{const b=f.originals.get(A.native_path);await fs.mkdir(path.dirname(f.release+'/'+A.path),{recursive:true});await fs.writeFile(f.release+'/'+A.path,b,{mode:0o600});f.manifest.files.push({path:A.path,bytes:b.length,sha256:sha(b),role:'runtime-resource'});let manifestSha=await f.save();await assert.rejects(loadValidatedEmittedRelease({releaseDirectory:f.release,manifestSha}));
  delete f.manifest.resource_contract.members.find(r=>r.id===A.id).storage;manifestSha=await f.save();const reader=await createInstalledRuntimeResourceReader({releaseDirectory:f.release,manifestSha});assert.deepEqual(await readInstalledRuntimeResource(reader,A.id,f.consumer),b);
 }finally{await f.close();}
});
test('v1 resource representation stays unaliased and actual builder refuses a missing physical native or changed source before aliasing',async()=>{
 const f=await fixture({v2:false});try{assert(f.manifest.resource_contract.members.every(r=>!Object.hasOwn(r,'storage')));const reader=await createInstalledRuntimeResourceReader({releaseDirectory:f.release,manifestSha:f.manifestSha});assert.deepEqual(await readInstalledRuntimeResource(reader,A.id,f.consumer),f.originals.get(A.native_path));}finally{await f.close();}
 await assert.rejects(fixture({corruptSource:true}));await assert.rejects(fixture({missingNative:true}));
});

test('actual v2 builder without a187 Native edge retains the original unaliased logical resource and reader',async()=>{
 const f=await fixture({native187:false});try{const member=f.manifest.resource_contract.members.find(r=>r.id===A.id);assert(!Object.hasOwn(member,'storage'));assert(f.manifest.files.some(r=>r.path===A.path));assert(!f.manifest.files.some(r=>r.path===A.native_path));const reader=await createInstalledRuntimeResourceReader({releaseDirectory:f.release,manifestSha:f.manifestSha});assert.deepEqual(await readInstalledRuntimeResource(reader,A.id,f.consumer),f.originals.get(A.native_path));}finally{await f.close();}
});
