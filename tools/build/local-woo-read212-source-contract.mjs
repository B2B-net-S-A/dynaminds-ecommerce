/** Closed file-only N11→212 source binding. Publication never installs SQL or starts workers. */
import assert from 'node:assert/strict';
import fs,{constants} from 'node:fs/promises';
import path from 'node:path';
import {canonicalRoot,packageBytes,sha,validateRelease} from './portable-release.mjs';
import {assertProjectContractMembers} from './local-package.mjs';
import {LOCAL_WOO_READ212_SOURCE_CONTRACT as E,LOCAL_WOO_READ212_SOURCE_ORIGIN as O} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read212-source-contract.mjs';
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const LOCAL_WOO_READ212_SOURCE_INPUTS=freeze({
 parent_manifest_sha256:'f12bcc8836dd5064db0530c9881480f8831bb22232e128ca227a9b04cfcda3e4',
 native:{source:'server/212_local_woo_read_lane.sql',path:'native/212_local_woo_read_lane.sql',id:'local_woo_read212_lane',bytes:4392,sha256:'febb4ab6b75dc67eef25f31a0a449ac1652a9bc4d256cb2dd0900164b62f6d66'},
 sources:[
  {
    "path": "server/app.ts",
    "bytes": 103874,
    "sha256": "81e197f9aad228e33713ee40aba681e1ea25e956abeac77580809214b6910f65",
    "role": "runtime-source"
  },
  {
    "path": "server/ordinary-local-runtime.ts",
    "bytes": 22018,
    "sha256": "b154a178ea987ad4a948b394f19fb78529dc94df891a8f9b2304429e33135328",
    "role": "runtime-source"
  },
  {
    "path": "server/local-woo-read-lane.ts",
    "bytes": 24537,
    "sha256": "a76c1c48d5b274879e5ee4dd142f6965e47679bb97bbf751ec0b8d6685b32cd2",
    "role": "runtime-source"
  },
  {
    "path": "server/local-woo-read-lane-routes.ts",
    "bytes": 2529,
    "sha256": "0eb3fe687bffa6d995ada0424cc022114408a0b022a6b95e6505674e03ca7809",
    "role": "runtime-source"
  },
  {
    "path": "server/local-woo-read-worker.ts",
    "bytes": 2045,
    "sha256": "b79b64632595bcc5a2fbe1185b0fa8af0e523c8201a6280b83bfadbf96d7656b",
    "role": "runtime-source"
  },
  {
    "path": "server/ordinary-local-cli.ts",
    "bytes": 8943,
    "sha256": "14644fe896a552e4c139b8e000c17b6ef707bbc2a4659a390783ded9815e89de",
    "role": "runtime-source"
  },
  {
    "path": "server/db.ts",
    "bytes": 44753,
    "sha256": "37ddf82e09c7a3330132dda44e1d6d883305205079f0f587f5ce2da3fef21d54",
    "role": "runtime-source"
  },
  {
    "path": "server/catalog-source.ts",
    "bytes": 30008,
    "sha256": "aeaa7393b8bd1ef2260cdc7c65a67cb432210c02c7023c61d81fca3df4fb1ef3",
    "role": "runtime-source"
  },
  {
    "path": "server/sync.ts",
    "bytes": 14191,
    "sha256": "d3276b83e7485ff05b32f12b9d54a85f6311e20a063286ce6324b3c3728644d7",
    "role": "runtime-source"
  },
  {
    "path": "shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read212-source-contract.mjs",
    "bytes": 16960,
    "sha256": "d890406bcd7c5772dcd798e6002dc0888929d562c6ac1a574500e2c85e905043",
    "role": "runtime-source"
  },
  {
    "path": "shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read212-source-compatibility.mjs",
    "bytes": 2302,
    "sha256": "db90d7574e146de791bbf9289f59d048ad6f5e7f5fd5b1c93ca4184c88ab38ff",
    "role": "runtime-source"
  },
  {
    "path": "shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs",
    "bytes": 22577,
    "sha256": "80b64e353272f92d3471c8f5081cadffc381b53b9a10dd22b353dab2f3aa5811",
    "role": "runtime-source"
  },
  {
    "path": "shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs",
    "bytes": 8825,
    "sha256": "c181e12279011a3d92195d27074680f5c995366f39364f4e6db20c8d48b91e71",
    "role": "runtime-source"
  },
  {
    "path": "shared/large-import-dependencies/pim-large-import173-business-traversal-ui/resource-format209.mjs",
    "bytes": 7742,
    "sha256": "5b7148d0c63c273164cbec662d001cd10a09db5b14fda752c14394da590720a4",
    "role": "runtime-source"
  },
  {
    "path": "web/configured-woo.tsx",
    "bytes": 17356,
    "sha256": "a56b295c8fce04f38b13019290fc7d540a2a16844b8703c8722e264a6a233b67",
    "role": "runtime-source"
  },
  {
    "path": "web/local-woo-read-lanes.tsx",
    "bytes": 16732,
    "sha256": "bc3bee3f5423f4b61d1a6f5e764b2e9093f42b5603b67ddc67b58a9c09d90d07",
    "role": "runtime-source"
  },
  {
    "path": "tools/local/operator.mjs",
    "bytes": 21533,
    "sha256": "2a809f51d35a116b537949e3b1a714aa4e72fc6dfb501dfc72be31e6c7ca75ca",
    "role": "runtime-source"
  }
]
});
const I=LOCAL_WOO_READ212_SOURCE_INPUTS,json=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
function exact(bytes,row,label){assert(Buffer.isBuffer(bytes),label+'-buffer');assert.equal(bytes.length,row.bytes,label+'-bytes');assert.equal(sha(bytes),row.sha256,label+'-sha');}
function member(r){return{path:r.path,sha256:r.sha256,bytes:r.bytes,role:r.role};}
/** Fixed input roster and byte pins only; callers cannot select a vector, hashes or approval flags. */
export function deriveLocalWooRead212SourceContract({parentManifestBytes,parentInventoryBytes,sourceBytes}){
 assert(Buffer.isBuffer(parentManifestBytes));assert.equal(sha(parentManifestBytes),I.parent_manifest_sha256,'212 literal N11 parent');
 assert(O.source_compilation_proven===true&&E?.source_compilation_proven===true,'212 independent source compilation publication required');
 assert.deepEqual(E.sql,{bytes:I.native.bytes,sha256:I.native.sha256});assert.equal(E.additions.length,239);assert.deepEqual(E.changes,[]);assert.deepEqual(E.removed,[]);
 const names=[...I.sources.map(r=>r.path),I.native.source];assert.deepEqual(Object.keys(sourceBytes).sort(),names.slice().sort(),'212 complete fixed source inputs');
 for(const r of I.sources)exact(sourceBytes[r.path],r,r.path);exact(sourceBytes[I.native.source],I.native,'212 native source');
 const before=JSON.parse(parentManifestBytes),after=structuredClone(before);
 assert.equal(before.files.length,61);assert.equal(before.files.filter(r=>r.role==='runtime-source').length,26);assert.equal(before.native_contract.sql_graph.length,29);
 assert.deepEqual(before.native_contract.sql_graph.at(-1),{id:'return_credit211_native148_acceptance',path:'native/211_return_credit148_acceptance_install.sql',sha256:'08a7f80a919ffb5e8bc24675d2ca39ac48e633586cafc15ff5f31c46a459cc65'});
 const inventoryIndex=before.files.findIndex(r=>r.role==='source-inventory');assert(inventoryIndex>=0);const inventoryRow=before.files[inventoryIndex];exact(parentInventoryBytes,inventoryRow,'212 N11 inventory');
 const oldInventory=JSON.parse(parentInventoryBytes),inventory=structuredClone(oldInventory),edge={id:I.native.id,path:I.native.path,sha256:I.native.sha256};
 assert.deepEqual(oldInventory.source_graph,before.native_contract.sql_graph);assert(!after.files.some(r=>r.path===I.native.path));
 const changes=[];for(const r of I.sources){const index=after.files.findIndex(row=>row.path===r.path);if(index>=0){assert.equal(after.files[index].role,'runtime-source');changes.push({index,before:structuredClone(after.files[index]),after:member(r)});after.files[index]=member(r);}else{changes.push({index:after.files.length,before:null,after:member(r)});after.files.push(member(r));}}
 assert.equal(changes.filter(r=>r.before).length,2,'212 only app/runtime replace old contract members');assert.equal(changes.filter(r=>!r.before).length,15);
 const nativeRow={path:I.native.path,sha256:I.native.sha256,bytes:I.native.bytes,role:'native-sql'};after.files.push(nativeRow);after.native_contract.sql_graph.push(edge);inventory.source_graph.push(edge);
 const inventoryBytes=json(inventory);after.files[inventoryIndex]={...inventoryRow,bytes:inventoryBytes.length,sha256:sha(inventoryBytes)};after.version='1.0.0-full-base-local-woo-read.212';
 assert.equal(after.files.length,77);assert.equal(after.files.filter(r=>r.role==='runtime-source').length,41);assert.equal(after.native_contract.sql_graph.length,30);
 const inverseInventory=structuredClone(inventory);assert.deepEqual(inverseInventory.source_graph.pop(),edge);assert.deepEqual(json(inverseInventory),parentInventoryBytes,'212 inventory entire byte inverse');
 const inverse=structuredClone(after);assert.deepEqual(inverse.files.pop(),nativeRow);assert.deepEqual(inverse.native_contract.sql_graph.pop(),edge);
 for(const change of changes.toReversed())if(change.before)inverse.files[change.index]=change.before;else assert.deepEqual(inverse.files.pop(),change.after);
 inverse.files[inventoryIndex]=inventoryRow;inverse.version=before.version;assert.deepEqual(json(inverse),parentManifestBytes,'212 whole N11 manifest byte inverse');
 const manifestBytes=json(after);return{manifest:after,manifestBytes,manifest_sha256:sha(manifestBytes),inventoryBytes,inventory_path:inventoryRow.path,changes,
  inverseManifestBytes:json(inverse),inverseInventoryBytes:json(inverseInventory),source_compilation_proven:true,native_certification:false,application_activation:false,business_acceptance:false};
}
async function syncDirectory(dir){const fd=await fs.open(dir,constants.O_RDONLY);try{await fd.sync();}finally{await fd.close();}}
async function save(file,bytes){const fd=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}await syncDirectory(path.dirname(file));}
/** Root-only explicit file publisher. Output must be fresh; receipts belong outside the exact release root. */
export async function prepareLocalWooRead212SourceContract({parentRoot,projectRoot,outputRoot}){
 await canonicalRoot(parentRoot);await canonicalRoot(projectRoot);assert(path.isAbsolute(outputRoot)&&path.resolve(outputRoot)===outputRoot);
 for(const input of[parentRoot,projectRoot])assert(outputRoot!==input&&!outputRoot.startsWith(input+'/'),'212 output outside inputs');await canonicalRoot(path.dirname(outputRoot));
 try{await fs.lstat(outputRoot);assert.fail('212 fresh output required');}catch(e){if(e.code!=='ENOENT')throw e;}
 await validateRelease(parentRoot,{expectedManifestSha:I.parent_manifest_sha256});const parentManifestBytes=await packageBytes(parentRoot,'release.json'),before=JSON.parse(parentManifestBytes),inventoryRow=before.files.find(r=>r.role==='source-inventory');
 const parentInventoryBytes=await packageBytes(parentRoot,inventoryRow.path),sourceBytes={};for(const r of I.sources)sourceBytes[r.path]=await packageBytes(projectRoot,r.path);sourceBytes[I.native.source]=await packageBytes(projectRoot,I.native.source);
 const derived=deriveLocalWooRead212SourceContract({parentManifestBytes,parentInventoryBytes,sourceBytes});await assertProjectContractMembers(projectRoot,derived.manifest);
 await fs.mkdir(outputRoot,{mode:0o700});await syncDirectory(path.dirname(outputRoot));
 const replacements=new Map(I.sources.map(r=>[r.path,sourceBytes[r.path]]));replacements.set(I.native.path,sourceBytes[I.native.source]);replacements.set(derived.inventory_path,derived.inventoryBytes);
 for(const row of derived.manifest.files){const target=path.join(outputRoot,row.path);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});const replacement=replacements.get(row.path);
  if(replacement)await save(target,replacement);else{const original=await packageBytes(parentRoot,row.path);exact(original,row,'212 preserved '+row.path);
   try{await fs.copyFile(path.join(parentRoot,row.path),target,constants.COPYFILE_FICLONE|constants.COPYFILE_EXCL);}catch(e){if(!['ENOTSUP','EOPNOTSUPP','EINVAL'].includes(e.code))throw e;await fs.copyFile(path.join(parentRoot,row.path),target,constants.COPYFILE_EXCL);}
   await fs.chmod(target,0o600);const fd=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}assert.deepEqual(await packageBytes(outputRoot,row.path),original);
  }
 }
 await save(path.join(outputRoot,'release.json'),derived.manifestBytes);const validation=await validateRelease(outputRoot,{expectedManifestSha:derived.manifest_sha256});await assertProjectContractMembers(projectRoot,derived.manifest);
 await validateRelease(parentRoot,{expectedManifestSha:I.parent_manifest_sha256});for(const r of I.sources)assert.deepEqual(await packageBytes(projectRoot,r.path),sourceBytes[r.path]);assert.deepEqual(await packageBytes(projectRoot,I.native.source),sourceBytes[I.native.source]);
 async function syncTree(dir){for(const e of await fs.readdir(dir,{withFileTypes:true}))if(e.isDirectory())await syncTree(path.join(dir,e.name));await syncDirectory(dir);}await syncTree(outputRoot);await syncDirectory(path.dirname(outputRoot));
 return{status:'LOCAL_WOO_READ212_SOURCE_CONTRACT_77_MEMBERS_30_EDGES_NOT_ACTIVATED',source_manifest_sha256:derived.manifest_sha256,source_manifest_bytes:derived.manifestBytes.length,files:77,runtime_sources:41,native_edges:30,source_compilation_proven:true,validation,SQL_executed:false,application_activation:false,native_certification:false,business_acceptance:false};
}
