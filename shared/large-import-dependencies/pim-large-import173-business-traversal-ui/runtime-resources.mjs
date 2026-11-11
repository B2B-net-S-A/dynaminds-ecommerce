/** Fixed runtime resources. Private resource state is separate from Startup/readiness authority. */
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {RESOURCE_DEFINITIONS} from './resource-definitions.mjs';
import {resourceBytes,resourceSha,resource209SourceBytes,decodeResource209} from './resource-io.mjs';
import {EMITTED209_SCHEMA,RESOURCES209_SCHEMA,RESOURCE209_DEFINITION,RELEASE_RESOURCES,releaseResourceSelection,definitions209,storage209,assertStorage209Partition} from './resource-format209.mjs';
import {loadValidatedEmittedRelease} from './emitted-release.mjs';
export {RESOURCE_DEFINITIONS} from './resource-definitions.mjs';
const PACKING_NATIVE_ID='packing189_required_fields',PACKING_RESOURCE_ID='sql:server/189_packing_required_order_fields.sql',PACKING_SQL_PATH='resources/server/189_packing_required_order_fields.sql',PACKING_LEGACY_PATH='native/189_packing_required_order_fields.sql',PACKING_DUAL_ROLE='native-sql-runtime-resource';
const privateReaders=new WeakMap();let selected;
const keys=(v,names)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),names.sort());};
function contract(manifest){
 const edges=manifest.native_contract.sql_graph.filter(s=>s.id===PACKING_NATIVE_ID);assert(edges.length<=1,'resource-packing-native-edge-unique');if(edges.length)assert([PACKING_LEGACY_PATH,PACKING_SQL_PATH].includes(edges[0].path),'resource-packing-native-fixed-path');const packingAlias=edges[0]?.path===PACKING_SQL_PATH;
 assert.deepEqual(manifest.files.filter(f=>f.role===PACKING_DUAL_ROLE).map(f=>f.path),packingAlias?[PACKING_SQL_PATH]:[],'resource-packing-dual-one-fixed-member');if(packingAlias)assert.equal(manifest.native_contract.sql_graph.filter(s=>s.path===PACKING_SQL_PATH).length,1,'resource-packing-native-path-unique');
 const c=manifest.resource_contract;keys(c,['schema','definitions','members','missing']);const v2=manifest.schema===EMITTED209_SCHEMA,selection=releaseResourceSelection(manifest.native_contract);assert(v2||!selection.include211,'resource211-requires-v2');const definitions=v2?definitions209(RESOURCE_DEFINITIONS,selection):RESOURCE_DEFINITIONS;assert.equal(c.schema,v2?RESOURCES209_SCHEMA:'dynaminds-fixed-runtime-resources/v1');assert.deepEqual(c.definitions,definitions);if(v2)assertStorage209Partition(c,manifest.native_contract);
 assert(Array.isArray(c.members)&&Array.isArray(c.missing));const members=new Map(),missing=new Set();
 for(const row of c.members){keys(row,['id','path','bytes','sha256','role',...(v2&&Object.hasOwn(row,'storage')?['storage']:[])]);const d=definitions.find(x=>x.id===row.id);assert(d&&!members.has(row.id),'resource-known-unique-id');assert.equal(row.path,d.path);const alias=row.id===PACKING_RESOURCE_ID&&packingAlias;assert.equal(row.role,alias?PACKING_DUAL_ROLE:'runtime-resource','resource-fixed-role');if(alias){assert.equal(row.path,PACKING_SQL_PATH);assert.equal(d.source,'server/189_packing_required_order_fields.sql');assert.equal(d.consumer,'server/db.ts');assert.equal(row.sha256,edges[0].sha256);}if(v2&&Object.hasOwn(row,'storage')){const storage=storage209(row);assert(!manifest.files.some(f=>f.path===row.path),'resource209-no-logical-copy');assert.deepEqual(manifest.files.find(f=>f.path===storage.path),{path:storage.path,bytes:storage.bytes,sha256:storage.sha256,role:storage.role});}else{const file=manifest.files.find(f=>f.path===row.path);assert(file);assert.deepEqual(file,{path:row.path,bytes:row.bytes,sha256:row.sha256,role:row.role});}members.set(row.id,Object.freeze({...row}));}
 for(const id of c.missing){assert(definitions.some(d=>d.id===id)&&!members.has(id)&&!missing.has(id),'resource-missing-partition');missing.add(id);}
 assert.equal(members.size+missing.size,definitions.length);if(packingAlias)assert(members.has(PACKING_RESOURCE_ID)&&!missing.has(PACKING_RESOURCE_ID),'resource-packing-both-logical-roles-required');return{members,missing};
}
/** Only the genuine fixed validator can establish a resource reader. No input handles/maps/resolvers. */
export async function createInstalledRuntimeResourceReader(input0){
 keys(input0,['releaseDirectory','manifestSha']);const input=structuredClone(input0);
 assert(path.isAbsolute(input.releaseDirectory)&&path.resolve(input.releaseDirectory)===input.releaseDirectory);assert(/^[a-f0-9]{64}$/.test(input.manifestSha));
 const validated=await loadValidatedEmittedRelease(input),manifest=validated.manifest;
 // Bind the bytes actually consumed here; restoration before a later cut cannot excuse poison.
 const raw=await resourceBytes(input.releaseDirectory,'release.json');assert.equal(resourceSha(raw),input.manifestSha);assert.deepEqual(JSON.parse(raw),manifest);
 const resources=contract(manifest),handle=Object.freeze({schema:'fixed-installed-resource-reader/v1'});
 privateReaders.set(handle,{...input,manifest:structuredClone(manifest),...resources});return handle;
}
export async function readInstalledRuntimeResource(handle,id,consumerUrl){
 const state=privateReaders.get(handle);assert(state,'resource-original-private-reader-required');const definition=RESOURCE_DEFINITIONS.find(d=>d.id===id)??(id===RESOURCE209_DEFINITION.id?RESOURCE209_DEFINITION:RELEASE_RESOURCES.find(r=>r.definition.id===id)?.definition);assert(definition,'resource-id-unavailable');
 const url=new URL(consumerUrl);assert.equal(url.protocol,'file:');const absolute=fileURLToPath(url);assert.equal(await fs.realpath(absolute),absolute);const relative=path.relative(state.releaseDirectory,absolute).split(path.sep).join('/');
 const consumer=state.manifest.files.find(f=>f.path===relative);assert(consumer&&consumer.role==='emitted-runtime','resource-consumer-not-selected-emitted-module');
 await resourceBytes(state.releaseDirectory,relative,consumer);
 const before=await resourceBytes(state.releaseDirectory,'release.json');assert.equal(resourceSha(before),state.manifestSha);
 const member=state.members.get(id);assert(member,'runtime-resource-unavailable:'+id);const storage=Object.hasOwn(member,'storage')?storage209(member):member;let bytes=await resourceBytes(state.releaseDirectory,storage.path,storage);if(storage.encoding==='gzip209')bytes=decodeResource209(bytes);assert.equal(bytes.length,member.bytes);assert.equal(resourceSha(bytes),member.sha256);
 assert.equal(resourceSha(await resourceBytes(state.releaseDirectory,'release.json')),state.manifestSha);await resourceBytes(state.releaseDirectory,relative,consumer);return bytes;
}
/** Called once by the code-owned installed bootstrap before migrate/buildApp. */
export async function installRuntimeResources(input){
 if(selected){const state=privateReaders.get(selected);assert.deepEqual(input,{releaseDirectory:state.releaseDirectory,manifestSha:state.manifestSha},'resource-installation-already-bound');return;}
 const handle=await createInstalledRuntimeResourceReader(input);
 // Synchronous after await; a concurrent foreign installation must not replace the selected capability.
 if(selected){const a=privateReaders.get(selected),b=privateReaders.get(handle);assert.equal(a.releaseDirectory,b.releaseDirectory);assert.equal(a.manifestSha,b.manifestSha);}else selected=handle;
}
/** Original unbundled host use remains fixed to the actual canonical server directory. */
export async function readRuntimeResource(id,consumerUrl){
 if(selected)return readInstalledRuntimeResource(selected,id,consumerUrl);
 const definition=RESOURCE_DEFINITIONS.find(d=>d.id===id)??(id===RESOURCE209_DEFINITION.id?RESOURCE209_DEFINITION:RELEASE_RESOURCES.find(r=>r.definition.id===id)?.definition);assert(definition,'resource-id-unavailable');const url=new URL(consumerUrl);assert.equal(url.protocol,'file:');const file=fileURLToPath(url);
 assert.equal(await fs.realpath(file),file,'source-resource-consumer-alias');const stem=path.basename(definition.consumer,'.ts');assert(['.ts','.js','.mjs'].some(ext=>path.basename(file)===stem+ext)&&path.basename(path.dirname(file))==='server','installed-resources-not-bound-and-not-original-source-consumer');
 const root=path.dirname(path.dirname(file));assert.equal(await fs.realpath(root),root);const packageFile=await resourceBytes(root,'package.json');assert.equal(JSON.parse(packageFile).name,'dynaminds-ecommerce','source-project-package-required');return id===RESOURCE209_DEFINITION.id?resource209SourceBytes(root):resourceBytes(root,definition.source,RELEASE_RESOURCES.find(r=>r.definition.id===id)?.alias);
}
