/** Finite file-only extension of the N10 source contract. Never starts a runtime. */
import assert from 'node:assert/strict';
import fs,{constants} from 'node:fs/promises';
import path from 'node:path';
import {canonicalRoot,packageBytes,sha,validateRelease} from './portable-release.mjs';
import {assertProjectContractMembers} from './local-package.mjs';

export const FIVE_STORE_SOURCE_INPUTS=Object.freeze({
 parent_manifest_sha256:'f371be7c8b7d5e0bb5862169514af99348b8e3959885ed078a079a5cec0d3cbc',
 source_git_revision:'9224af7fd9ad0acef6f5ad3a03cc8a88a8500a29',
 runtime:Object.freeze({path:'server/ordinary-local-runtime.ts',role:'runtime-source',before_bytes:20676,before_sha256:'9f900fe402966df6d6864d2840a1f7ca6bc002e0ef64d8fc2e1a6ef105c43ce9',bytes:20762,sha256:'d96121ff97c170e57081972e129e0a402e029498e0495979d553a57e2f3594c8'}),
 origins:Object.freeze({path:'shared/local-woo-origins.ts',role:'runtime-source',bytes:792,sha256:'46f776a662ba9a2fb2772dffcc976af04c4443a53ef2e97f734782f89379346c'}),
});
const I=FIVE_STORE_SOURCE_INPUTS;
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
function exactBytes(value,bytes,digest,label){assert(Buffer.isBuffer(value),label+'-buffer');if(bytes!==null)assert.equal(value.length,bytes,label+'-bytes');assert.equal(sha(value),digest,label+'-sha256');}
function row(input){return {path:input.path,sha256:input.sha256,bytes:input.bytes,role:input.role};}

/** No caller-selected hashes or roster: only this reviewed source transition. */
export function deriveFiveStoreSourceContract({parentManifestBytes,runtimeBytes,originsBytes}){
 exactBytes(parentManifestBytes,null,I.parent_manifest_sha256,'five-store-parent');
 exactBytes(runtimeBytes,I.runtime.bytes,I.runtime.sha256,'five-store-runtime');
 exactBytes(originsBytes,I.origins.bytes,I.origins.sha256,'five-store-origins');
 const before=JSON.parse(parentManifestBytes),after=structuredClone(before);
 assert.equal(before.files.length,60);assert.equal(before.files.filter(f=>f.role==='runtime-source').length,25);assert.equal(before.native_contract.sql_graph.length,29);
 const index=before.files.findIndex(f=>f.path===I.runtime.path);assert(index>=0);
 assert.deepEqual(before.files[index],{path:I.runtime.path,sha256:I.runtime.before_sha256,bytes:I.runtime.before_bytes,role:'runtime-source'});
 assert(!before.files.some(f=>f.path===I.origins.path));
 after.version='1.0.0-full-base-five-store.5';
 after.files[index]=row(I.runtime);after.files.push(row(I.origins));
 assert.equal(after.files.length,61);assert.equal(after.files.filter(f=>f.role==='runtime-source').length,26);
 assert.deepEqual(after.native_contract,before.native_contract);assert.deepEqual(after.adapter_contract,before.adapter_contract);
 const inverse=structuredClone(after);assert.deepEqual(inverse.files.pop(),row(I.origins));inverse.files[index]=structuredClone(before.files[index]);inverse.version=before.version;
 assert.deepEqual(inverse,before);assert.deepEqual(json(inverse),parentManifestBytes,'five-store-whole-parent-byte-inverse');
 const manifestBytes=json(after);
 return {manifest:after,manifestBytes,manifest_sha256:sha(manifestBytes),inverseManifestBytes:json(inverse),
  changes:[{before:structuredClone(before.files[index]),after:row(I.runtime)},{before:null,after:row(I.origins)}],
  preserved_members:59,native_edges:29,application_activation:false,native_certification:false,business_acceptance:false};
}

async function syncDirectory(directory){const fd=await fs.open(directory,constants.O_RDONLY);try{await fd.sync();}finally{await fd.close();}}
async function save(file,bytes){const fd=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}await syncDirectory(path.dirname(file));}

/** Root may invoke this later. EXCL output survives failures; never retries or overwrites. */
export async function prepareFiveStoreSourceContract({parentRoot,projectRoot,outputRoot}){
 await canonicalRoot(parentRoot);await canonicalRoot(projectRoot);
 assert(path.isAbsolute(outputRoot)&&path.resolve(outputRoot)===outputRoot,'five-store-canonical-output');
 for(const input of [parentRoot,projectRoot])assert(outputRoot!==input&&!outputRoot.startsWith(input+'/'),'five-store-output-outside-inputs');
 await canonicalRoot(path.dirname(outputRoot));
 try{await fs.lstat(outputRoot);assert.fail('five-store-fresh-output-required');}catch(error){if(error.code!=='ENOENT')throw error;}
 await validateRelease(parentRoot,{expectedManifestSha:I.parent_manifest_sha256});
 const parentManifestBytes=await packageBytes(parentRoot,'release.json');
 const runtimeBytes=await packageBytes(projectRoot,I.runtime.path),originsBytes=await packageBytes(projectRoot,I.origins.path);
 const derived=deriveFiveStoreSourceContract({parentManifestBytes,runtimeBytes,originsBytes});
 await assertProjectContractMembers(projectRoot,derived.manifest);
 await fs.mkdir(outputRoot,{mode:0o700});await syncDirectory(path.dirname(outputRoot));
 for(const member of derived.manifest.files){
  const target=path.join(outputRoot,member.path);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
  if(member.path===I.runtime.path||member.path===I.origins.path)await save(target,member.path===I.runtime.path?runtimeBytes:originsBytes);
  else{
   const original=await packageBytes(parentRoot,member.path);assert.equal(original.length,member.bytes);assert.equal(sha(original),member.sha256);
   try{await fs.copyFile(path.join(parentRoot,member.path),target,constants.COPYFILE_FICLONE|constants.COPYFILE_EXCL);}
   catch(error){if(!['ENOTSUP','EOPNOTSUPP','EINVAL'].includes(error.code))throw error;await fs.copyFile(path.join(parentRoot,member.path),target,constants.COPYFILE_EXCL);}
   await fs.chmod(target,0o600);const fd=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}
   assert.deepEqual(await packageBytes(outputRoot,member.path),original);await syncDirectory(path.dirname(target));
  }
 }
 await save(path.join(outputRoot,'release.json'),derived.manifestBytes);
 const validation=await validateRelease(outputRoot,{expectedManifestSha:derived.manifest_sha256});
 await validateRelease(parentRoot,{expectedManifestSha:I.parent_manifest_sha256});
 assert.deepEqual(await packageBytes(projectRoot,I.runtime.path),runtimeBytes);assert.deepEqual(await packageBytes(projectRoot,I.origins.path),originsBytes);
 await assertProjectContractMembers(projectRoot,derived.manifest);
 // Close every newly-created directory entry, including nested directories.
 async function syncTree(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true}))if(entry.isDirectory())await syncTree(path.join(directory,entry.name));await syncDirectory(directory);}
 await syncTree(outputRoot);await syncDirectory(path.dirname(outputRoot));
 return {status:'FIVE_STORE_SOURCE_CONTRACT_61_MEMBERS_29_EDGES_NOT_ACTIVATED',source_git_revision:I.source_git_revision,source_manifest_sha256:derived.manifest_sha256,source_manifest_bytes:derived.manifestBytes.length,files:61,runtime_sources:26,native_edges:29,preserved_members:59,validation,SQL_executed:false,application_activation:false,native_certification:false,business_acceptance:false};
}
