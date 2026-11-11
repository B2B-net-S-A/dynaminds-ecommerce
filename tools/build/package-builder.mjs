/** File-only build/install preparation. Never imports the server or invokes PG. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {historicalSource} from './historical-source.mjs';
import {inspectRuntimeDependencies} from './inspect.mjs';
import {selectRuntimeOutputs} from './output-closure.mjs';
import {loadValidatedEmittedRelease} from './emitted-release.mjs';
import {RESOURCE_DEFINITIONS} from './resource-definitions.mjs';
import {RESOURCE187_ALIAS,hasResource187AliasEdge,RESOURCE209_DEFINITION,RESOURCE209_SQL,RESOURCE209_ALIASES,RELEASE_RESOURCES,releaseResourceSelection,EMITTED209_SCHEMA,RESOURCES209_SCHEMA,definitions209,storage209,assertStorage209Partition} from './resource-format209.mjs';
import {RELEASE_MIGRATIONS} from './migration-manifest.mjs';
import {resource209SourceBytes,encodeResource209} from './resource-io.mjs';
import {sourceDdlMigrationPlan} from './source-ddl-migration-plan.mjs';
import {canonicalRoot,packageBytes,packageInventory,relativeName,sha,validateRelease} from './portable-release.mjs';

const json=x=>Buffer.from(JSON.stringify(x,null,2)+'\n');
const archive=p=>/^(?:data\/source-drafts\/|worktrees\/|\.git\/)/.test(p);
const forbiddenText=text=>/(?:data\/source-drafts\/|\/Users\/[^\s"']+\/.*worktrees\/)/.test(text);
export function assertPortableRuntimeOutput(text){assert(!forbiddenText(text),'deployment-emitted-absolute-or-archive-reference');}
const stable=(a,b)=>a<b?-1:a>b?1:0;
const packageName=n=>n.startsWith('@')?n.split('/').slice(0,2).join('/'):n.split('/')[0];

/** server/mf-xsd.ts in the package needs every schemas/mf file (with the manifest, members equal to its pins)
 * and the exact locked engine; without them the release would refuse to start, so the package is not emitted. */
export function assertReleaseXsdClosure({emittedSources,dependencies,resourceContract,schemaManifest}){
 if(!emittedSources.has('server/mf-xsd.ts'))return;
 assert(dependencies.some(d=>d.name==='xmllint-wasm'&&d.version==='5.3.0'&&d.integrity),'deployment-xsd-engine-locked');
 assert(resourceContract&&schemaManifest,'deployment-xsd-missing');
 assert(!resourceContract.missing.some(id=>id.startsWith('xsd:')),'deployment-xsd-missing');
 const manifest=JSON.parse(schemaManifest),members=new Map(resourceContract.members.filter(r=>r.id.startsWith('xsd:')).map(r=>[r.id,r]));
 assert(members.has('xsd:manifest.json'),'deployment-xsd-missing');
 assert.equal(members.size,manifest.files.length+1,'deployment-xsd-member-count');
 for(const f of manifest.files){const r=members.get('xsd:'+f.path);assert(r&&r.sha256===f.sha256&&r.bytes===f.bytes,'deployment-xsd-member:'+f.path);}
}

/** Actual builder resource stage. File-only data; caller validates its source release separately. */
export async function buildFixedRuntimeResources209({projectRoot,outputRoot,files,put,contract,contractBytes}){
 const cuts=[],missing=[],missingResources=[],resourceMembers=[];
 let source209;try{source209=await resource209SourceBytes(projectRoot);}catch(e){if(e?.code!=='ENOENT')throw e;}
 // One row per release migration (211..): its exact source bytes, Native edge, and db.ts registration.
 const release=[];
 for(const r of RELEASE_RESOURCES){let bytes;try{bytes=await packageBytes(projectRoot,r.definition.source);}catch(e){if(e?.code!=='ENOENT')throw e;}release.push({...r,bytes,registered:false});}
 const include187=hasResource187AliasEdge(contract.native_contract),selection=releaseResourceSelection(contract.native_contract);
 for(const r of release)r.include=selection['include'+r.number];
 let db;try{db=await packageBytes(projectRoot,'server/db.ts');}catch(e){if(e?.code!=='ENOENT')throw e;}
 if(db){
  const plan=sourceDdlMigrationPlan(db.toString('utf8'));
  const name='209_order_merge_delivery_inheritance',file=name+'.sql',related=plan.filter(row=>row.name===name||row.file===file);
  if(related.length){assert.deepEqual(related,[{name,file}],'deployment209-exact-migration-pair');assert(source209!==undefined,'deployment209-migration-requires-fixed-v2-sql');}
  for(const r of release){const pair=plan.filter(row=>row.name===r.name||row.file===r.file);if(pair.length){assert.deepEqual(pair,[{name:r.name,file:r.file}],'deployment'+r.number+'-exact-migration-pair');r.registered=true;}}
  cuts.push({path:'server/db.ts',sha256:sha(db)});
 }
 release.forEach((r,i)=>{
  const n=r.number;assert.equal(r.registered,r.include,'deployment'+n+'-migration-native-edge-parity');assert.equal(r.bytes!==undefined,r.include,'deployment'+n+'-resource-native-edge-parity');
  if(r.include){if(i===0)assert(source209!==undefined,'deployment'+n+'-requires209');else assert(release[i-1].include,'deployment'+n+'-requires'+release[i-1].number);assert.equal(r.bytes.length,r.alias.bytes);assert.equal(sha(r.bytes),r.alias.sha256,'deployment'+n+'-full-source-pin');}
 });
 const v2=source209!==undefined,definitions=v2?definitions209(RESOURCE_DEFINITIONS,selection):RESOURCE_DEFINITIONS;
 const packingPath='resources/server/189_packing_required_order_fields.sql',packingId='sql:server/189_packing_required_order_fields.sql';
 const packingEdge=contract.native_contract.sql_graph.find(e=>e.id==='packing189_required_fields'),packingAlias=packingEdge?.path===packingPath;
 for(const d of definitions){
  let bytes;const own=release.find(r=>r.definition.id===d.id);if(d.id===RESOURCE209_DEFINITION.id)bytes=source209;else if(own)bytes=own.bytes;else try{bytes=await packageBytes(projectRoot,d.source);}catch(e){if(e?.code!=='ENOENT')throw e;}
  if(bytes===undefined){missing.push(d.id);missingResources.push(d.source);continue;}
  let row={id:d.id,path:d.path,bytes:bytes.length,sha256:sha(bytes),role:'runtime-resource'};
  const fixed=v2&&[...RESOURCE209_ALIASES,...(include187 ? [RESOURCE187_ALIAS] : []),...release.filter(r=>r.include).map(r=>r.alias)].find(a=>a.id===d.id);
  if(fixed){
   assert.equal(d.source,'server/'+path.posix.basename(fixed.path));assert.equal(d.consumer,'server/db.ts');
   assert.equal(bytes.length,fixed.bytes);assert.equal(sha(bytes),fixed.sha256);
   const native=files.find(f=>f.path===fixed.native_path);assert.deepEqual(native,{path:fixed.native_path,bytes:fixed.bytes,sha256:fixed.sha256,role:'native-sql'});
   assert.deepEqual(await contractBytes(fixed.native_path),bytes,'deployment209-native-source-parity');assert.deepEqual(await packageBytes(outputRoot,fixed.native_path),bytes,'deployment209-native-output-parity');
   row={...row,storage:{path:fixed.native_path,bytes:fixed.bytes,sha256:fixed.sha256,encoding:'identity'}};storage209(row);
   assert(!files.some(f=>f.path===d.path),'deployment209-no-alias-copy');
  }else if(v2&&d.id===RESOURCE209_DEFINITION.id){
   const encoded=encodeResource209(bytes);row={...row,storage:{path:RESOURCE209_SQL.path,bytes:encoded.length,sha256:sha(encoded),encoding:'gzip209'}};storage209(row);await put(RESOURCE209_SQL.path,encoded,'runtime-resource-gzip209');
  }else{
   const existing=files.find(f=>f.path===d.path),alias=d.id===packingId&&packingAlias;
   if(existing){assert(alias&&d.path===packingPath&&d.source==='server/189_packing_required_order_fields.sql'&&d.consumer==='server/db.ts','deployment-no-generic-resource-collision');assert.equal(existing.role,'native-sql-runtime-resource');assert.equal(existing.bytes,bytes.length);assert.equal(existing.sha256,sha(bytes));assert.equal(packingEdge.sha256,sha(bytes));assert.deepEqual(await packageBytes(outputRoot,d.path),bytes,'deployment-packing-entire-physical-byte-parity');assert.deepEqual(await contractBytes(d.path),bytes);}
   else{assert(!alias,'deployment-packing-native-member-required-before-resource');await put(d.path,bytes,'runtime-resource');}
   if(alias)row.role='native-sql-runtime-resource';
  }
  resourceMembers.push(row);cuts.push({path:d.source,sha256:sha(bytes)});
 }
 const resourceContract={schema:v2?RESOURCES209_SCHEMA:'dynaminds-fixed-runtime-resources/v1',definitions,members:resourceMembers,missing};
 if(v2)assertStorage209Partition(resourceContract,contract.native_contract);
 return{resourceContract,resourceCuts:cuts,missingResources};
}

export async function buildLocalDeploymentPackage(options){
 assert.deepEqual(Object.keys(options).sort(),['entrypoints','outputRoot','projectRoot','sourceReleaseManifestSha','sourceReleaseRoot']);
 const input=structuredClone(options);
 await canonicalRoot(input.projectRoot);
 assert(path.isAbsolute(input.outputRoot)&&path.resolve(input.outputRoot)===input.outputRoot);
 assert(!input.outputRoot.startsWith(input.projectRoot+'/server/')&&!input.outputRoot.startsWith(input.projectRoot+'/shared/'));
 const graph=await inspectRuntimeDependencies({projectRoot:input.projectRoot,entrypoints:input.entrypoints});
 const hard=graph.blockers.filter(b=>b.kind!=='historical-runtime-dependency');
 assert.equal(hard.length,0,'deployment-static-resolution-blockers');
 const consumed=new Map(graph.files.map(f=>[f.path,f]));
 const virtual='.deployment-emitted-not-written';
 const loaders={'.ts':'ts','.mts':'ts','.cts':'ts','.tsx':'tsx','.js':'js','.mjs':'js','.cjs':'js','.jsx':'jsx','.json':'json'};
 const emitted=await build({absWorkingDir:input.projectRoot,entryPoints:input.entrypoints,
  outdir:virtual,outbase:'.',entryNames:'[dir]/[name]',chunkNames:'chunks/[name]-[hash]',outExtension:{'.js':'.mjs'},
  // Shared chunks preserve ONE private Startup namespace across the declared
  // entries. Only the exact reachable output graph is shipped below.
  bundle:true,splitting:true,treeShaking:true,minifyWhitespace:true,write:false,metafile:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',
  logOverride:{'unsupported-dynamic-import':'warning','unsupported-require-call':'warning','indirect-require':'warning'},
  plugins:[{name:'exact-source-cut',setup(b){b.onResolve({filter:/.*/},args=>historicalSource(args,input.projectRoot));b.onLoad({filter:/.*/,namespace:'file'},async args=>{
   const name=path.relative(input.projectRoot,args.path).split(path.sep).join('/');relativeName(name);
   const member=consumed.get(name);assert(member,'deployment-new-uninspected-input');
   const bytes=await packageBytes(input.projectRoot,name);assert.equal(bytes.length,member.bytes);assert.equal(sha(bytes),member.sha256,'deployment-consumed-byte-drift');
   const loader=loaders[path.extname(name)];assert(loader);return{contents:bytes,loader,resolveDir:path.dirname(args.path)};
  });}}],
 });
 await fs.writeFile(input.outputRoot+'.esbuild-metafile.json',json(emitted.metafile),{flag:'wx',mode:0o600});
 assert.equal(emitted.warnings.length,0,'deployment-emission-warnings');
 const selected=selectRuntimeOutputs(emitted.metafile,input.entrypoints),selectedOutputs=new Set(selected.files),rootOutputs=new Set(selected.roots);
 const survivors=new Set(selected.emitted_sources);
 const archived=[...survivors].filter(archive);assert.deepEqual(archived,[],'deployment-live-archive-import');
 // Source-authoritative native/profile/ABI data is an independently selected
 // build input. A historical native snapshot or tool receipt cannot substitute.
 await validateRelease(input.sourceReleaseRoot,{expectedManifestSha:input.sourceReleaseManifestSha});
 const raw=await packageBytes(input.sourceReleaseRoot,'release.json');assert.equal(sha(raw),input.sourceReleaseManifestSha);
 const contract=JSON.parse(raw),members=new Map(contract.files.map(f=>[f.path,f]));
 async function contractBytes(name){const f=members.get(name);assert(f);const bytes=await packageBytes(input.sourceReleaseRoot,name);assert.equal(bytes.length,f.bytes);assert.equal(sha(bytes),f.sha256,'deployment-consumed-contract-drift');return bytes;}
 await fs.mkdir(input.outputRoot,{recursive:false,mode:0o700});await canonicalRoot(input.outputRoot);
 const files=[];
 async function put(name,bytes,role){relativeName(name);assert(!files.some(f=>f.path===name));assert(bytes.length<=32*1024*1024,'emitted-member-32MiB');
  const target=path.join(input.outputRoot,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx',mode:0o644});files.push({path:name,bytes:bytes.length,sha256:sha(bytes),role});}
 const entries=[];
 for(const out of emitted.outputFiles){
  const outputName=path.relative(input.projectRoot,out.path).split(path.sep).join('/');
  if(!selectedOutputs.has(outputName))continue;
  const rel=path.relative(path.join(input.projectRoot,virtual),out.path).split(path.sep).join('/');relativeName(rel);
  assertPortableRuntimeOutput(out.text);
  await put('runtime/'+rel,out.contents,'emitted-runtime');
  const metadata=emitted.metafile.outputs[outputName];
  if(rootOutputs.has(outputName))entries.push({source:metadata.entryPoint,path:'runtime/'+rel});
 }
 assert.equal(entries.length,input.entrypoints.length);
 const sourcePackage=await packageBytes(input.projectRoot,'package.json'),lockRaw=await packageBytes(input.projectRoot,'package-lock.json');
 assert.equal(sha(sourcePackage),graph.package_sha256);assert.equal(sha(lockRaw),graph.lock_sha256);
 const pkg=JSON.parse(sourcePackage),lock=JSON.parse(lockRaw);
 const externals=new Set(selected.external_specifiers.filter(p=>!p.startsWith('node:')).map(packageName));
 const builtin=new Set((await import('node:module')).builtinModules);
 const dependencies=[];
 for(const name of [...externals].filter(n=>!builtin.has(n)).sort(stable)){
  assert(Object.hasOwn(pkg.dependencies??{},name),'deployment-runtime-dependency-not-declared');
  const actual=lock.packages?.['node_modules/'+name];assert(actual?.version&&actual?.integrity,'deployment-runtime-dependency-not-locked');
  dependencies.push({name,version:actual.version,integrity:actual.integrity});
 }
 // Same dependency lists/root name/version as the genuine npm lock. No copied
 // dev-server/build scripts are executable installer steps.
 const deploymentPkg={...pkg,type:'module',scripts:Object.fromEntries(entries.map((e,n)=>['run:'+n,'node '+e.path]))};
 await put('package.json',json(deploymentPkg),'dependency-package');await put('package-lock.json',lockRaw,'dependency-lock');
 const packingNativeId='packing189_required_fields',packingResourceId='sql:server/189_packing_required_order_fields.sql',packingSqlPath='resources/server/189_packing_required_order_fields.sql',packingDualRole='native-sql-runtime-resource';
 const packingEdges=contract.native_contract.sql_graph.filter(m=>m.id===packingNativeId);assert(packingEdges.length<=1,'deployment-packing-native-edge-unique');const packingAlias=packingEdges[0]?.path===packingSqlPath;
 if(packingEdges.length)assert(['native/189_packing_required_order_fields.sql',packingSqlPath].includes(packingEdges[0].path),'deployment-packing-native-fixed-path');
 if(packingAlias)assert.equal(members.get(packingSqlPath)?.role,packingDualRole,'deployment-packing-dual-source-role');
 const nativeNames=new Set([contract.native_contract.profile,contract.native_contract.inventory,contract.native_contract.catalog_query.path,...contract.native_contract.sql_graph.map(m=>m.path),contract.adapter_contract.abi,contract.adapter_contract.inventory_source]);
 if(contract.native_contract.compatibility!==undefined)nativeNames.add(contract.native_contract.compatibility.path);
 const abi=JSON.parse(await contractBytes(contract.adapter_contract.abi));nativeNames.add(abi.definition_source);
 for(const name of [...nativeNames].sort(stable))await put(name,await contractBytes(name),members.get(name).role);
 await put('contract/source-release-manifest.json',raw,'source-contract-manifest');
 // db.ts uses new URL(file,import.meta.url), including schema.sql and the
 // unnumbered WMS file. After bundling its URL belongs to an emitted module,
 // not the original source/server directory. Copy all source-listed SQL to
 // EVERY reachable module containing db.ts, conservatively, and list missing
 // source resources explicitly (the isolated code overlay has no SQL assets).
 const resourceCuts=[],missingResources=[];
 let resourceContract;
 const fixedResources=survivors.has('shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs');
 if(fixedResources){
  const definitionName='shared/large-import-dependencies/pim-large-import173-business-traversal-ui/resource-definitions.mjs';
  assert(survivors.has(definitionName),'fixed-resource-definitions-must-execute');
  const actualDefinitions=(await import(pathToFileURL(path.join(input.projectRoot,definitionName)))).RESOURCE_DEFINITIONS;
  assert.deepEqual(actualDefinitions,RESOURCE_DEFINITIONS,'fixed-resource-definition-source-equality');
  const manifestName='shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
  if(survivors.has(manifestName))assert.deepEqual((await import(pathToFileURL(path.join(input.projectRoot,manifestName)))).RELEASE_MIGRATIONS,RELEASE_MIGRATIONS,'fixed-release-migration-manifest-source-equality');
  const built=await buildFixedRuntimeResources209({projectRoot:input.projectRoot,outputRoot:input.outputRoot,files,put,contract,contractBytes});
  resourceContract=built.resourceContract;resourceCuts.push(...built.resourceCuts);missingResources.push(...built.missingResources);
 }
 let schemaManifest;try{schemaManifest=await packageBytes(input.projectRoot,'schemas/mf/manifest.json');}catch(e){if(e?.code!=='ENOENT')throw e;}
 assertReleaseXsdClosure({emittedSources:survivors,dependencies,resourceContract,schemaManifest});
 const dbOutputs=selected.files.filter(p=>emitted.metafile.outputs[p].inputs?.['server/db.ts']?.bytesInOutput>0);
 let requiredSql=[];
 if(dbOutputs.length&&!fixedResources){
  const db=await packageBytes(input.projectRoot,'server/db.ts');assert.equal(sha(db),consumed.get('server/db.ts').sha256);
  requiredSql=[...new Set([...db.toString('utf8').matchAll(/['"]\.\/([a-zA-Z0-9_-]+\.sql)['"]/g)].map(m=>m[1]))].sort(stable);
  assert(requiredSql.includes('schema.sql')&&requiredSql.includes('wms-stocktake-invariants.sql'),'deployment-real-db-resource-family');
  for(const name of requiredSql){
   const sourceName='server/'+name;let bytes;
   try{bytes=await packageBytes(input.projectRoot,sourceName);}catch(first){if(first?.code==='ENOENT'){missingResources.push(sourceName);continue;}throw first;}
   resourceCuts.push({path:sourceName,sha256:sha(bytes)});
   for(const output of dbOutputs){const rel=path.relative(virtual,output).split(path.sep).join('/');relativeName(rel);const destination=path.posix.join('runtime',path.posix.dirname(rel),name);if(!files.some(f=>f.path===destination))await put(destination,bytes,'server-migration-resource');}
  }
 }
 const assetRequirements=[];
 for(const sourceName of fixedResources?[]:survivors){
  const sourceBytes=await packageBytes(input.projectRoot,sourceName);
  for(const match of sourceBytes.toString('utf8').matchAll(/new\s+URL\(\s*['"]((?:\.\/|\.\.\/)[^'"\n]+\.(?:ttf|pdf))['"]\s*,\s*import\.meta\.url\s*\)/g)){
   const resource=path.posix.normalize(path.posix.join(path.posix.dirname(sourceName),match[1]));relativeName(resource);
   const containing=selected.files.filter(p=>emitted.metafile.outputs[p].inputs?.[sourceName]?.bytesInOutput>0),destinations=[];
   let bytes;try{bytes=await packageBytes(input.projectRoot,resource);}catch(first){if(first?.code!=='ENOENT')throw first;}
   for(const output of containing){const rel=path.relative(virtual,output).split(path.sep).join('/');relativeName(rel);const destination=path.posix.normalize(path.posix.join('runtime',path.posix.dirname(rel),match[1]));relativeName(destination);assert(destination.startsWith('runtime/'),'deployment-emitted-asset-escape');destinations.push(destination);if(bytes&&!files.some(f=>f.path===destination))await put(destination,bytes,'emitted-runtime-resource');}
   assetRequirements.push({source:sourceName,resource,destinations,present:bytes!==undefined});
   if(bytes)resourceCuts.push({path:resource,sha256:sha(bytes)});else missingResources.push(resource);
  }
 }
 const startupSource='shared/large-import-dependencies/pim-large-import173-business-traversal-ui/profile-startup.mjs';
 const startupOutputs=selected.files.filter(p=>emitted.metafile.outputs[p].inputs?.[startupSource]?.bytesInOutput>0);
 if(survivors.has(startupSource))assert.equal(startupOutputs.length,1,'deployment-private-startup-namespace-duplicated');
 const staticFiles=await packageInventory(path.join(input.projectRoot,'dist'));assert(staticFiles.length>0,'complete-current-host-dist-required');
 const staticMembers=[];for(const n of staticFiles){relativeName(n);const b=await packageBytes(input.projectRoot,'dist/'+n);await put('dist/'+n,b,'frontend-static');staticMembers.push(files.find(f=>f.path==='dist/'+n));resourceCuts.push({path:'dist/'+n,sha256:sha(b)});}
 const staticContract={schema:'dynaminds-host-dist/v1',root:'dist',entry:'dist/index.html',members:staticMembers};
 const manifest={schema:resourceContract?.schema===RESOURCES209_SCHEMA?EMITTED209_SCHEMA:'dynaminds-emitted-local-release/v1',scope:'EMITTED_LOCAL_PACKAGE_RESOURCE_REVIEW_PENDING',origin:contract.origin,
  entries:entries.sort((a,b)=>stable(a.source,b.source)),native_contract:contract.native_contract,adapter_contract:contract.adapter_contract,
  source_contract_manifest_sha256:input.sourceReleaseManifestSha,locked_dependencies:dependencies,package_lock_sha256:sha(lockRaw),
  emitted_sources:[...survivors].sort(stable).map(p=>consumed.get(p)),files:files.sort((a,b)=>stable(a.path,b.path)),
  emitted_output_closure:{roots:selected.roots,files:selected.files,excluded_unreachable:selected.excluded_unreachable},
  private_startup_module_count:startupOutputs.length,migration_resources:requiredSql.length-missingResources.filter(p=>p.startsWith('server/')&&p.endsWith('.sql')).length,
  emitted_asset_requirements:assetRequirements,missing_runtime_resources:[...new Set(missingResources)].sort(stable),
  ...(resourceContract?{resource_contract:resourceContract}:{}),
  static_resource_completeness:'HASHED_FULL_HOST_DIST',static_contract:staticContract,dependency_installation:'NOT_RUN',native_installation:'NOT_RUN',
  installed_adapter_acceptance:'NOT_AVAILABLE',application_activation:false,
 };
 for(const f of graph.files)assert.equal(sha(await packageBytes(input.projectRoot,f.path)),f.sha256,'deployment-final-source-drift');
 for(const f of resourceCuts)assert.equal(sha(f.path===RESOURCE209_DEFINITION.source?await resource209SourceBytes(input.projectRoot):await packageBytes(input.projectRoot,f.path)),f.sha256,'deployment-final-resource-drift');
 for(const name of nativeNames)await contractBytes(name);
 await put('release.json',json(manifest),'deployment-manifest');
 const digest=files.find(f=>f.path==='release.json').sha256;
 const report=await validateLocalDeploymentPackage(input.outputRoot,{expectedManifestSha:digest});
 return{...report,parsed_source_count:graph.files.length,emitted_source_count:survivors.size,dead_archive_inputs:graph.files.filter(f=>archive(f.path)&&!survivors.has(f.path)).map(f=>f.path)};
}

export async function validateLocalDeploymentPackage(root,{expectedManifestSha}){
 const loaded=await loadValidatedEmittedRelease({releaseDirectory:root,manifestSha:expectedManifestSha}),m=loaded.manifest;
 return{status:'ACTUAL_EMITTED_LOCAL_PACKAGE_BYTES_VERIFIED_NOT_INSTALLED',manifest_sha256:expectedManifestSha,file_count:loaded.closure.file_count,bytes:loaded.closure.bytes,
  entrypoints:m.entries,locked_dependencies:m.locked_dependencies,static_resource_completeness:m.static_resource_completeness,static_contract:m.static_contract,dependency_installation:'NOT_RUN',native_installation:'NOT_RUN',installed_adapter_acceptance:'NOT_AVAILABLE',application_activation:false};
}

/** Installer preparation only; never executes npm, app initializers or SQL. */
export async function prepareLocalDeploymentInstall(root,selection){
 assert.deepEqual(Object.keys(selection).sort(),['expectedManifestSha']);
 const report=await validateLocalDeploymentPackage(root,selection);
 return{status:'LOCAL_DEPLOYMENT_INSTALL_STEPS_PREPARED_NOT_RUN',release_manifest_sha256:report.manifest_sha256,
  dependency_command:{cwd:root,executable:'npm',args:['ci','--omit=dev','--ignore-scripts']},entries:report.entrypoints,
  blocked_before_application_start:['complete-runtime-resource-review','genuine-native-install-or-compatibility','fixed-installed-adapter-acceptance','attributed-inventory'],application_activation:false};
}
