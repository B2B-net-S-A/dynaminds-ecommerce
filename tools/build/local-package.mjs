/** Portable file-only emitter. Never starts an app, database, provider or worker. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildLocalDeploymentPackage} from './package-builder.mjs';
import {canonicalRoot,packageBytes,sha,validateRelease} from './portable-release.mjs';

const contractSource='shared/large-import-dependencies/pim-large-import173-business-traversal-ui/';
const validatorNames=['portable-release.mjs','emitted-release.mjs','ordinary177-contract.mjs','resource-definitions.mjs','resource-io.mjs','resource-format209.mjs'];

export function parseArguments(args){
 const flags=new Map();let checkOnly=false;
 for(let i=0;i<args.length;i++){
  const flag=args[i];
  if(flag==='--check-only'){assert(!checkOnly,'duplicate-check-only');checkOnly=true;continue;}
  assert(['--project','--source-contract','--source-manifest-sha','--output'].includes(flag),'unknown-build-option');
  assert(!flags.has(flag)&&typeof args[i+1]==='string'&&!args[i+1].startsWith('--'),'missing-or-duplicate-build-option');
  flags.set(flag,args[++i]);
 }
 assert.equal(flags.size,4,'four-explicit-build-inputs-required');
 const digest=flags.get('--source-manifest-sha');assert(/^[a-f0-9]{64}$/.test(digest),'trusted-source-manifest-sha-required');
 const projectRoot=path.resolve(flags.get('--project')),sourceReleaseRoot=path.resolve(flags.get('--source-contract')),outputRoot=path.resolve(flags.get('--output'));
 assert(outputRoot!==projectRoot&&!outputRoot.startsWith(projectRoot+'/'),'output-must-be-outside-developer-source');
 assert(outputRoot!==sourceReleaseRoot&&!outputRoot.startsWith(sourceReleaseRoot+'/'),'output-must-not-overwrite-source-contract');
 return {projectRoot,sourceReleaseRoot,sourceReleaseManifestSha:digest,outputRoot,checkOnly};
}

export async function checkSourceContract({projectRoot,sourceReleaseRoot,sourceReleaseManifestSha}){
 await canonicalRoot(projectRoot);
 const report=await validateRelease(sourceReleaseRoot,{expectedManifestSha:sourceReleaseManifestSha});
 const manifest=JSON.parse(await packageBytes(sourceReleaseRoot,'release.json'));
 await assertProjectContractMembers(projectRoot,manifest);
 return {source_manifest_sha256:sourceReleaseManifestSha,source_file_count:manifest.files.length,matched_runtime_source_count:manifest.files.filter(f=>f.role==='runtime-source').length,contract_bytes:report.bytes};
}

/** Byte coherence only; callers still validate the complete Source45 manifest first. */
export async function assertProjectContractMembers(projectRoot,manifest){
 // Direct reuse preserves the original builder's exact fourteen runtime-source inputs.
 // Application modules outside this roster are independently inspected by the emitter.
 const runtimeSources=manifest.files.filter(f=>f.role==='runtime-source');
 for(const row of runtimeSources){const bytes=await packageBytes(projectRoot,row.path);assert.equal(bytes.length,row.bytes,'source-contract-runtime-size');assert.equal(sha(bytes),row.sha256,'source-contract-runtime-drift');}
 const compatibility=manifest.files.find(f=>f.path===manifest.native_contract.compatibility.path);
 const projectCompatibility=await packageBytes(projectRoot,contractSource+'ordinary177-contract.json');
 assert.equal(projectCompatibility.length,compatibility.bytes,'source-contract-compatibility-size');assert.equal(sha(projectCompatibility),compatibility.sha256,'source-contract-compatibility-drift');
 for(const row of manifest.files.filter(f=>(f.role==='native-sql'&&/^native\/\d{3}_/.test(f.path))||f.role==='native-sql-runtime-resource')){
  const source=row.role==='native-sql-runtime-resource'?row.path.slice('resources/'.length):'server/'+path.posix.basename(row.path);
  const bytes=await packageBytes(projectRoot,source);assert.equal(bytes.length,row.bytes,'source-contract-native-size');assert.equal(sha(bytes),row.sha256,'source-contract-native-drift');
 }
 for(const name of validatorNames){const bytes=await packageBytes(projectRoot,contractSource+name),tool=await fs.readFile(new URL(name,import.meta.url));assert.equal(sha(bytes),sha(tool),'source-contract-validator-version-drift');}
}

export async function main(args){
 const selected=parseArguments(args);
 for(const file of [selected.outputRoot,selected.outputRoot+'.esbuild-metafile.json']){
  try{await fs.lstat(file);assert.fail('fresh-output-path-required');}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 await canonicalRoot(path.dirname(selected.outputRoot));
 const source=await checkSourceContract(selected);
 if(selected.checkOnly)return {status:'SOURCE_BUILD_INPUTS_VERIFIED_NOT_EMITTED',...source};
 const roster=JSON.parse(await fs.readFile(new URL('entrypoints.json',import.meta.url)));
 assert.deepEqual(Object.keys(roster),['entrypoints']);assert.equal(roster.entrypoints.length,11);
 const report=await buildLocalDeploymentPackage({projectRoot:selected.projectRoot,sourceReleaseRoot:selected.sourceReleaseRoot,sourceReleaseManifestSha:selected.sourceReleaseManifestSha,outputRoot:selected.outputRoot,entrypoints:roster.entrypoints});
 // Recheck the same source contract after emission; no current code is recertified silently.
 await checkSourceContract(selected);
 return {...report,output:selected.outputRoot,metafile:selected.outputRoot+'.esbuild-metafile.json',application_started:false,importer_ready:false};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv.slice(2)).then(report=>console.log(JSON.stringify(report))).catch(e=>{console.error(JSON.stringify({status:'FILE_BUILD_FAILED',name:e.name,code:e.code??null,message_sha256:sha(String(e.message??''))}));process.exitCode=1;});
}
