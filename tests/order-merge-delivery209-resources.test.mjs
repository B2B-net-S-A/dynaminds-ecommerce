/** Actual builder resource stage -> strict package intake -> genuine installed reader.
 * Small synthetic source/profile/ABI, four real pinned SQL assets. No PG/app/esbuild. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {buildFixedRuntimeResources209} from '../tools/build/package-builder.mjs';
import {sourceDdlMigrationPlan} from '../tools/build/source-ddl-migration-plan.mjs';
import {loadValidatedEmittedRelease} from '../tools/build/emitted-release.mjs';
import {RESOURCE_DEFINITIONS} from '../tools/build/resource-definitions.mjs';
import {RESOURCE209_DEFINITION as D,RESOURCE209_SQL as SQL,RESOURCE209_ALIASES as ALIASES,EMITTED209_SCHEMA,RESOURCES209_SCHEMA,storage209} from '../tools/build/resource-format209.mjs';
import {resourceBytes,resource209SourceBytes,encodeResource209,decodeResource209} from '../tools/build/resource-io.mjs';
import {createInstalledRuntimeResourceReader,readInstalledRuntimeResource} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,''),H='shared/large-import-dependencies/pim-large-import173-business-traversal-ui/';
const sha=b=>createHash('sha256').update(b).digest('hex'),json=x=>Buffer.from(JSON.stringify(x,null,2)+'\n');
async function fixture({v2=true}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dyna-resource209-'))),source=path.join(root,'source'),release=path.join(root,'release');
 await fs.mkdir(path.join(source,'server'),{recursive:true});await fs.mkdir(release);
 const files=[];const put=async(name,bytes,role)=>{assert(bytes.length<=16777216);assert(!files.some(r=>r.path===name));await fs.mkdir(path.dirname(path.join(release,name)),{recursive:true});await fs.writeFile(path.join(release,name),bytes,{flag:'wx',mode:0o600});files.push({path:name,bytes:bytes.length,sha256:sha(bytes),role});};
 const originals=new Map();for(const a of ALIASES){const bytes=await fs.readFile(path.join(project,'server',path.basename(a.path)));assert.equal(bytes.length,a.bytes);assert.equal(sha(bytes),a.sha256);await fs.writeFile(path.join(source,'server',path.basename(a.path)),bytes);await put(a.native_path,bytes,'native-sql');originals.set(a.native_path,bytes);}
 if(v2){await fs.copyFile(path.join(project,D.source),path.join(source,D.source));const current=await fs.readFile(path.join(project,'server/db.ts'),'utf8'),spread='      ...RELEASE_MIGRATION_PROGRAM,\n';assert.equal(current.split(spread).length,2,'one release-list spread removed only in legacy fixture');const later=[...current.matchAll(/    \['(\d{3})_[a-z0-9_]+', '\.\/[a-z0-9_]+\.sql'\],\n/g)].filter(m=>Number(m[1])>209);assert.deepEqual(later,[],'every post-209 migration comes from the release list');const legacy=current.replace(spread,'');const stages=sourceDdlMigrationPlan(legacy);assert.equal(stages.at(-1).name,'209_order_merge_delivery_inheritance');assert(!stages.some(s=>/^2(?:1\d|[2-9]\d)_/.test(s.name)));await fs.writeFile(path.join(source,'server/db.ts'),legacy);}
 const nc={profile:'contract/profile.json',inventory:'contract/inventory.json',catalog_query:{path:'native/query.sql',sha256:sha(Buffer.from('SELECT 1;'))},sql_graph:ALIASES.map(a=>({id:a.native_id,path:a.native_path,sha256:a.sha256})),functions:0,relations:0,basis:'COMPLETE_REVIEWED_SOURCE_PROPOSAL_NOT_LIVE_ROWS'};
 const abi={schema:'dynaminds-importer-adapter-abi/v1',operations_source:'synthetic/operations.ts',definition_source:'synthetic/adapter.ts',operations:[{name:'synthetic-order',charges:['synthetic-charge']}]};
 await put(nc.profile,json({functions:[],relations:[]}),'expected-profile');await put(nc.inventory,json({counts:{functions:0,relations:0},functions:[],source_graph:nc.sql_graph,query:nc.catalog_query}),'source-inventory');
 await put(nc.catalog_query.path,Buffer.from('SELECT 1;'),'catalog-query');await put('contract/abi.json',json(abi),'adapter-abi');
 await put(abi.operations_source,Buffer.from("export const OPERATIONS = {\n 'synthetic-order': ['synthetic-charge'],\n} as const;"),'runtime-source');await put(abi.definition_source,Buffer.from('// synthetic held adapter'),'held-adapter-source');
 const sourceManifest={schema:'dynaminds-importer-source-release/v1',origin:'REAL_SOURCE_DERIVED_EXPECTATION_NOT_OBSERVED_NATIVE_AUTHORITY',scope:'SOURCE_CONTRACT_PROTOTYPE_NOT_EXECUTABLE_DISTRIBUTION',native_contract:nc,adapter_contract:{abi:'contract/abi.json',inventory_source:abi.operations_source,native_group_cap:64,coverage:'SOURCE_IDENTITIES_ONLY_NATIVE_WIRING_NOT_RUN'},files:structuredClone(files)};
 const sourceRaw=json(sourceManifest);await put('contract/source-release-manifest.json',sourceRaw,'source-contract-manifest');
 const nativeRead=async name=>{const value=originals.get(name);assert(value);return value;};
 const built=await buildFixedRuntimeResources209({projectRoot:source,outputRoot:release,files,put,contract:sourceManifest,contractBytes:nativeRead});
 const lock=Buffer.from('{"lockfileVersion":3}');await put('package-lock.json',lock,'dependency-lock');await put('runtime/server/db.mjs',Buffer.from('// synthetic emitted consumer; never executed'),'emitted-runtime');
 const manifest={schema:v2?EMITTED209_SCHEMA:'dynaminds-emitted-local-release/v1',scope:'EMITTED_LOCAL_PACKAGE_RESOURCE_REVIEW_PENDING',origin:sourceManifest.origin,application_activation:false,native_installation:'NOT_RUN',installed_adapter_acceptance:'NOT_AVAILABLE',static_resource_completeness:'NOT_PROVEN',native_contract:nc,adapter_contract:sourceManifest.adapter_contract,source_contract_manifest_sha256:sha(sourceRaw),package_lock_sha256:sha(lock),entries:[{source:'server/db.ts',path:'runtime/server/db.mjs'}],private_startup_module_count:1,resource_contract:built.resourceContract,files};
 const save=async m=>{const bytes=json(m);await fs.writeFile(path.join(release,'release.json'),bytes,{mode:0o600});return sha(bytes);};const manifestSha=await save(manifest);
 return{root,source,release,files,manifest,built,manifestSha,save,originals,consumer:pathToFileURL(path.join(release,'runtime/server/db.mjs')),close:()=>fs.rm(root,{recursive:true,force:true})};
}
test('actual source209 codecs bind exact raw UTF8 and one fixed Node-produced physical gzip; generic bounds unchanged',async()=>{
 const raw=await resource209SourceBytes(project),packed=encodeResource209(raw);assert.equal(raw.length,28449419);assert.equal(sha(raw),'0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a');assert.equal(packed.length,3855468);assert.equal(sha(packed),'0dd7ab6630f760d1b62847918ff84e1cde92209da2a90d74da35d09f50c73c28');assert.deepEqual(encodeResource209(raw),packed);assert.deepEqual(decodeResource209(packed),raw);
 await assert.rejects(resourceBytes(project,D.source),/resource-regular-bounded/);
 for(const bad of [packed.subarray(0,-1),Buffer.concat([packed,Buffer.from([0])]),Buffer.concat([packed,packed]),Buffer.from('not gzip'),gzipSync(Buffer.alloc(SQL.bytes+1)),gzipSync(Buffer.from([0xc3,0x28]))])assert.throws(()=>decodeResource209(bad));
 const changed=Buffer.from(raw);changed[0]^=1;assert.throws(()=>encodeResource209(changed),/source-sha/);
});
test('real builder stage and installed reader roundtrip preserve three literal native assets and Source04-like manifest bytes',async t=>{
 const f=await fixture();try{
  assert.equal(f.built.resourceContract.schema,RESOURCES209_SCHEMA);assert.equal(f.built.resourceContract.members.length,4);assert.equal(f.built.resourceContract.missing.length,RESOURCE_DEFINITIONS.length-3);
  for(const a of ALIASES){assert(!f.files.some(r=>r.path===a.path));assert.deepEqual(await fs.readFile(path.join(f.release,a.native_path)),f.originals.get(a.native_path));}
  const sourceRaw=await fs.readFile(path.join(f.release,'contract/source-release-manifest.json'));
  const loaded=await loadValidatedEmittedRelease({releaseDirectory:f.release,manifestSha:f.manifestSha});assert.equal(loaded.manifest.schema,EMITTED209_SCHEMA);assert(loaded.closure.bytes<96*1024*1024);
  const reader=await createInstalledRuntimeResourceReader({releaseDirectory:f.release,manifestSha:f.manifestSha});
  assert.deepEqual(await readInstalledRuntimeResource(reader,D.id,f.consumer),await resource209SourceBytes(project));for(const a of ALIASES)assert.deepEqual(await readInstalledRuntimeResource(reader,a.id,f.consumer),f.originals.get(a.native_path));
  assert.deepEqual(await fs.readFile(path.join(f.release,'contract/source-release-manifest.json')),sourceRaw);
  await t.test('arbitrary aliases, old-format storage, fixed-pin drift and missing partition stay refused even with a new manifest hash',async()=>{
   for(const mutate of [m=>m.resource_contract.members.find(r=>r.id===ALIASES[0].id).storage.path='native/202_owned_business_quota_expiry_renewal.sql',m=>m.resource_contract.members.find(r=>r.id===D.id).bytes++,m=>m.resource_contract.members.find(r=>r.id===D.id).storage.sha256='a'.repeat(64),m=>m.resource_contract.members.pop(),m=>m.schema='dynaminds-emitted-local-release/v1',m=>m.resource_contract.members[0].storage.encoding='gzip209',m=>m.native_contract.sql_graph[0].id='foreign']){
    const bad=structuredClone(f.manifest);mutate(bad);const digest=await f.save(bad);await assert.rejects(createInstalledRuntimeResourceReader({releaseDirectory:f.release,manifestSha:digest}));
   }await f.save(f.manifest);
  });
  await t.test('fresh installed reads refuse physical-byte replacement, symlink and hardlink, then still require the pinned manifest',async()=>{
   const file=path.join(f.release,SQL.path),original=await fs.readFile(file),other=path.join(f.root,'other.gz');await fs.writeFile(other,original);
   const changed=Buffer.from(original);changed[20]^=1;await fs.writeFile(file,changed);await assert.rejects(readInstalledRuntimeResource(reader,D.id,f.consumer));await fs.unlink(file);
   await fs.symlink(other,file);await assert.rejects(readInstalledRuntimeResource(reader,D.id,f.consumer));await fs.unlink(file);await fs.link(other,file);await assert.rejects(readInstalledRuntimeResource(reader,D.id,f.consumer));await fs.unlink(file);await fs.writeFile(file,original);
   await f.save({...f.manifest,application_activation:true});await assert.rejects(readInstalledRuntimeResource(reader,D.id,f.consumer));await f.save(f.manifest);
  });
 }finally{await f.close();}
});
test('the actual old v1 builder partition and installed reader still use original raw resources without alias storage',async()=>{
 const f=await fixture({v2:false});try{
  assert.equal(f.built.resourceContract.schema,'dynaminds-fixed-runtime-resources/v1');assert.deepEqual(f.built.resourceContract.definitions,RESOURCE_DEFINITIONS);assert(f.built.resourceContract.members.every(r=>!Object.hasOwn(r,'storage')));
  const reader=await createInstalledRuntimeResourceReader({releaseDirectory:f.release,manifestSha:f.manifestSha});for(const a of ALIASES){assert(f.files.some(r=>r.path===a.path));assert.deepEqual(await readInstalledRuntimeResource(reader,a.id,f.consumer),f.originals.get(a.native_path));}
  await assert.rejects(readInstalledRuntimeResource(reader,D.id,f.consumer),/runtime-resource-unavailable/);
 }finally{await f.close();}
});
test('actual IO rejects growth during read with only the original fixed allocation plus one sentinel byte',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dyna-resource209-growth-'))),file=path.join(root,'small.sql');await fs.writeFile(file,Buffer.alloc(16,65));
 const probe=await fs.open(file,'r'),proto=Object.getPrototypeOf(probe),read=proto.read,readFile=proto.readFile;await probe.close();let reads=0,unboundedReads=0;
 try{
  proto.readFile=async function(){unboundedReads++;throw Error('unbounded readFile forbidden');};
  proto.read=async function(buffer,offset,length,position){reads++;assert.equal(buffer.byteLength,17,'the pre-read size plus one is the entire allocation');assert(length<=17&&offset+length<=17);if(reads===1)await fs.appendFile(file,Buffer.alloc(1024,66));return read.call(this,buffer,offset,length,position);};
  await assert.rejects(resourceBytes(root,'small.sql'),/resource-read-grew/);assert.equal(reads,1);assert.equal(unboundedReads,0);
 }finally{proto.read=read;proto.readFile=readFile;await fs.rm(root,{recursive:true,force:true});}
});
test('actual db209 migration cannot silently emit v1 when the pinned SQL is missing or the migration pair changes',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dyna-resource209-required-')));await fs.mkdir(path.join(root,'server'));const output=path.join(root,'output');await fs.mkdir(output);let writes=0;
 const row="['209_order_merge_delivery_inheritance', './209_order_merge_delivery_inheritance.sql'],",program=rows=>"async function migrate(){ for (const [name, file] of [\n['208_consumer_return_credit_guard_dedup', './208_consumer_return_credit_guard_dedup.sql'],\n"+rows+"\n]) { } }";
 const invoke=()=>buildFixedRuntimeResources209({projectRoot:root,outputRoot:output,files:[],put:async()=>{writes++;throw Error('must not write before required SQL exists');},contract:{native_contract:{sql_graph:[]}},contractBytes:async()=>{throw Error('unexpected native read');}});
 try{
  await fs.writeFile(path.join(root,'server/db.ts'),program(row));await assert.rejects(invoke(),/deployment209-migration-requires-fixed-v2-sql/);assert.equal(writes,0);
  await fs.writeFile(path.join(root,'server/db.ts'),program(row.replace('./209_order_merge_delivery_inheritance.sql','./209_other.sql')));await assert.rejects(invoke(),/deployment209-exact-migration-pair/);assert.equal(writes,0);
  await fs.writeFile(path.join(root,'server/db.ts'),program(''));const legacy=await invoke();assert.equal(legacy.resourceContract.schema,'dynaminds-fixed-runtime-resources/v1');assert.deepEqual(legacy.resourceContract.definitions,RESOURCE_DEFINITIONS);assert.equal(writes,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('old definitions and portable parsers remain literal; code-owned format and IO mirrors are byte equal',async()=>{
 for(const name of ['resource-format209.mjs','resource-io.mjs','emitted-release.mjs'])assert.deepEqual(await fs.readFile(path.join(project,'tools/build',name)),await fs.readFile(path.join(project,H,name)));
 assert.deepEqual(await fs.readFile(path.join(project,'tools/build/resource-definitions.mjs')),await fs.readFile(path.join(project,H,'resource-definitions.mjs')));
 for(const a of ALIASES){const row={id:a.id,path:a.path,bytes:a.bytes,sha256:a.sha256,role:'runtime-resource',storage:{path:a.native_path,bytes:a.bytes,sha256:a.sha256,encoding:'identity'}};assert.equal(storage209(row).path,a.native_path);assert.throws(()=>storage209({...row,id:'sql:server/unrelated.sql'}));}
});
