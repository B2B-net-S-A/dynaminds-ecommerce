/** Build-time static dependency inspection. Never imports or activates the application. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {builtinModules} from 'node:module';
import {build} from 'esbuild';
import {canonicalRoot,packageBytes,relativeName,sha} from './portable-release.mjs';
import {historicalSource} from './historical-source.mjs';

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const forbidden = name => /^(?:data\/source-drafts\/|worktrees\/|\.git\/)/.test(name);
const packageName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0,2).join('/') : specifier.split('/')[0];

export async function inspectRuntimeDependencies(options) {
  assert.deepEqual(Object.keys(options).sort(), ['entrypoints','projectRoot']);
  const {projectRoot,entrypoints} = structuredClone(options);
  await canonicalRoot(projectRoot);
  assert(Array.isArray(entrypoints) && entrypoints.length > 0 && entrypoints.length <= 64);
  entrypoints.forEach(relativeName);
  assert.equal(new Set(entrypoints).size,entrypoints.length);
  const consumed = new Map();
  const loaders = {'.ts':'ts','.mts':'ts','.cts':'ts','.tsx':'tsx','.js':'js','.mjs':'js','.cjs':'js','.jsx':'jsx','.json':'json'};
  // esbuild resolves actual TypeScript/ESM imports without executing module initializers.
  // Unresolvable dynamic imports are elevated so they cannot silently disappear.
  const compiled = await build({
    absWorkingDir:projectRoot, entryPoints:entrypoints, outdir:'.runtime-closure-not-written',
    bundle:true, write:false, metafile:true, platform:'node', format:'esm',
    packages:'external', treeShaking:false, logLevel:'silent',
    logOverride:{'unsupported-dynamic-import':'warning','unsupported-require-call':'warning','indirect-require':'warning'},
    plugins:[{name:'portable-relative-imports',setup(api) {
      api.onResolve({filter:/.*/}, args => {
        if(args.kind==='entry-point') return;
        assert(!path.isAbsolute(args.path),'runtime-absolute-import');
        assert(!/^[a-z][a-z0-9+.-]*:/i.test(args.path) || builtins.has(args.path),'runtime-url-import');
        return historicalSource(args,projectRoot);
      });
      api.onLoad({filter:/.*/,namespace:'file'}, async args => {
        const relative=path.relative(projectRoot,args.path).split(path.sep).join('/');
        relativeName(relative);
        const loader=loaders[path.extname(relative)];
        assert(loader,'runtime-source-loader-not-reviewed');
        const bytes=await packageBytes(projectRoot,relative);
        const identity={sha256:sha(bytes),bytes:bytes.length};
        if(consumed.has(relative)) assert.deepEqual(consumed.get(relative),identity,'runtime-source-changed-during-resolution');
        consumed.set(relative,identity);
        return {contents:bytes,loader,resolveDir:path.dirname(args.path)};
      });
    }}],
  });
  const files=[],edges=[],packages=new Set(),blockers=[];
  // Input metadata also records TS imports erased during transformation as
  // external. Only the emitted output can establish a surviving external edge.
  const emittedExternal=new Set(Object.values(compiled.metafile.outputs)
    .flatMap(output=>output.imports).filter(dependency=>dependency.external)
    .map(dependency=>dependency.path));
  for(const warning of compiled.warnings) blockers.push({kind:'bundle-warning',id:warning.id,file:warning.location?.file??null,line:warning.location?.line??null});
  for(const [input,metadata] of Object.entries(compiled.metafile.inputs)) {
    const absolute=path.resolve(projectRoot,input),relative=path.relative(projectRoot,absolute).split(path.sep).join('/');
    relativeName(relative);
    assert(!relative.startsWith('../'),'runtime-dependency-escape');
    if(forbidden(relative)) blockers.push({kind:'historical-runtime-dependency',file:relative});
    const bytes=await packageBytes(projectRoot,relative);
    assert.equal(metadata.bytes,bytes.length,'runtime-bundle-input-drift');
    assert.deepEqual(consumed.get(relative),{sha256:sha(bytes),bytes:bytes.length},'runtime-consumed-input-drift');
    files.push({path:relative,sha256:sha(bytes),bytes:bytes.length});
    for(const dependency of metadata.imports) {
      const emitted=dependency.external!==true || emittedExternal.has(dependency.path);
      edges.push({from:relative,to:dependency.path,kind:dependency.kind,external:dependency.external===true,runtime_emitted:emitted});
      if(!emitted) continue;
      if(dependency.external&&forbidden(dependency.path)){
        blockers.push({kind:'historical-runtime-dependency',file:relative,specifier:dependency.path});
        continue;
      }
      if(dependency.external && !builtins.has(dependency.path)) {
        if(dependency.path.startsWith('.') || path.isAbsolute(dependency.path)) {
          blockers.push({kind:'unresolved-runtime-relative-import',file:relative,specifier:dependency.path});
          continue;
        }
        packages.add(packageName(dependency.path));
      }
    }
  }
  const packageBytesRaw=await packageBytes(projectRoot,'package.json');
  const lockBytes=await packageBytes(projectRoot,'package-lock.json');
  const packageJson=JSON.parse(packageBytesRaw),lock=JSON.parse(lockBytes);
  assert(lock.packages,'runtime-npm-lock-required');
  const externalPackages=[];
  for(const name of [...packages].sort()) {
    const selected=lock.packages[`node_modules/${name}`];
    assert(selected && typeof selected.version==='string','runtime-external-package-not-locked');
    if(!Object.hasOwn(packageJson.dependencies??{},name)) blockers.push({kind:'external-not-runtime-dependency',package:name});
    externalPackages.push({name,version:selected.version,integrity:selected.integrity??null});
  }
  // Final independent byte cut: a graph made from mixed source revisions is not reusable.
  for(const file of files) assert.equal(sha(await packageBytes(projectRoot,file.path)),file.sha256,'runtime-source-changed-during-build');
  assert.equal(sha(await packageBytes(projectRoot,'package.json')),sha(packageBytesRaw));
  assert.equal(sha(await packageBytes(projectRoot,'package-lock.json')),sha(lockBytes));
  return {
    status:blockers.length?'STATIC_RUNTIME_GRAPH_HAS_DELIVERY_BLOCKERS':'STATIC_RUNTIME_GRAPH_COLLECTED_RESOURCE_REVIEW_PENDING',
    entrypoints,files:files.sort((a,b)=>a.path.localeCompare(b.path)),edges,externalPackages,blockers,
    package_sha256:sha(packageBytesRaw),lock_sha256:sha(lockBytes),
    file_count:files.length,bytes:files.reduce((sum,file)=>sum+file.bytes,0),
    immutable_runtime_resources:'NOT_PROVEN_BY_STATIC_IMPORT_GRAPH',
    executable_distribution:false,native_installation:'NOT_RUN',application_activation:false,
  };
}
