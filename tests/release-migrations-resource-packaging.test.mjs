/** Actual resource builder/reader controlled ports for EVERY release migration (211..) of the one release list
 * (migration-manifest.mjs). Five checks per row; a new manifest row is covered without editing this file.
 * No emitter, PostgreSQL, app or provider. */
import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import{fileURLToPath,pathToFileURL}from'node:url';import{createHash}from'node:crypto';
import * as format from'../tools/build/resource-format209.mjs';import{resource209SourceBytes,encodeResource209}from'../tools/build/resource-io.mjs';import{sourceDdlMigrationPlan}from'../tools/build/source-ddl-migration-plan.mjs';import{readRuntimeResource}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs';
import{RELEASE_MIGRATIONS}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),sha=b=>createHash('sha256').update(b).digest('hex');
const{RESOURCE209_DEFINITION:D209,RESOURCE209_SQL:S209,RESOURCE209_ALIASES:A209,RELEASE_RESOURCES:R}=format;
const base=A209.map(a=>({id:a.id,source:'server/'+path.posix.basename(a.path),path:a.path,consumer:'server/db.ts'}));
const edge=a=>({id:a.native_id,path:a.native_path,sha256:a.sha256}),row=a=>({id:a.id,path:a.path,bytes:a.bytes,sha256:a.sha256,role:'runtime-resource',storage:{path:a.native_path,bytes:a.bytes,sha256:a.sha256,encoding:'identity'}});
const notSelected=()=>Object.assign(Error('not selected'),{code:'ENOENT'});
const source=await fs.readFile(new URL('../tools/build/package-builder.mjs',import.meta.url),'utf8'),start=source.indexOf('export async function buildFixedRuntimeResources209('),end=source.indexOf('\nexport async function buildLocalDeploymentPackage(',start),body=source.slice(start,end).replace(/^export /,'');assert(start>=0&&end>start);
const names=['assert','path','sha','RESOURCE_DEFINITIONS','resource209SourceBytes','encodeResource209','sourceDdlMigrationPlan','packageBytes',...Object.keys(format)],makeStage=io=>Function(...names,body+'\nreturn buildFixedRuntimeResources209;')(assert,path,sha,base,resource209SourceBytes,encodeResource209,sourceDdlMigrationPlan,io,...Object.values(format));

test('the release resources are exactly the manifest rows with their pinned SQL bytes, in ledger order',async()=>{
 assert.equal(await fs.readFile(new URL('../tools/build/resource-format209.mjs',import.meta.url),'utf8'),await fs.readFile(new URL('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/resource-format209.mjs',import.meta.url),'utf8'));
 assert.deepEqual(R.map(r=>[r.number,r.name,r.file,r.alias.native_id,r.alias.bytes,r.alias.sha256]),RELEASE_MIGRATIONS.map(m=>[m.number,m.name,m.file,m.native_id,m.bytes,m.sha256]));
 for(const m of RELEASE_MIGRATIONS){const b=await fs.readFile(path.join(root,'server',m.file));assert.equal(b.length,m.bytes,m.file);assert.equal(sha(b),m.sha256,m.file);}
 assert.equal(R[0].number,211);assert.deepEqual(format.definitions209(base),[...base,D209]);assert.throws(()=>format.definitions209(base,{include211:1}));assert.throws(()=>format.definitions209([...base,R[0].definition]));
 // Legacy names used by the 210/211 readers stay the derived row.
 assert.equal(format.RESOURCE211_ALIAS,R[0].alias);assert.equal(format.RESOURCE211_DEFINITION,R[0].definition);
});

R.forEach((r,k)=>{
 const N=r.number,D=r.definition,A=r.alias,prev=k?R[k-1]:undefined,predecessors=[...A209,...R.slice(0,k).map(x=>x.alias)],later=R.slice(k+1);
 const options=include=>Object.fromEntries([...R.slice(0,k).map(x=>['include'+x.number,true]),['include'+N,include]]);
 const fixture=include=>({schema:format.RESOURCES209_SCHEMA,definitions:format.definitions209(base,options(include)),members:[...A209.map(row),{id:D209.id,path:D209.path,bytes:S209.bytes,sha256:S209.sha256,role:'runtime-resource',storage:{path:S209.path,bytes:S209.stored_bytes,sha256:S209.stored_sha256,encoding:'gzip209'}},...R.slice(0,k).map(x=>row(x.alias)),...(include?[row(A)]:[])],missing:[]});
 test(`${N} exact Native alias extends the complete${prev?.number??209} partition without another physical SQL copy`,()=>{
  const before={sql_graph:predecessors.map(edge)},after={sql_graph:[...predecessors,A].map(edge)};
  assert.equal(format.hasReleaseResourceEdge(N,before),false);assert.equal(format.hasReleaseResourceEdge(N,after),true);
  format.assertStorage209Partition(fixture(false),before);format.assertStorage209Partition(fixture(true),after);
  assert.deepEqual(format.storage209(row(A)),{path:'native/'+r.file,bytes:RELEASE_MIGRATIONS[k].bytes,sha256:RELEASE_MIGRATIONS[k].sha256,encoding:'identity',role:'native-sql'});
  assert.deepEqual(fixture(true).members.filter(x=>x.id!==D.id),fixture(false).members);assert.deepEqual(fixture(true).definitions.filter(d=>d.id!==D.id),fixture(false).definitions);
  if(prev){
   assert.throws(()=>format.hasReleaseResourceEdge(N,{sql_graph:[...predecessors.filter(a=>a!==prev.alias),A].map(edge)}),new RegExp('requires'+prev.number));
   assert.throws(()=>format.definitions209(base,{...options(true),['include'+prev.number]:false}),new RegExp('requires'+prev.number));
  }
 });
 test(`${N} missing/duplicate/tampered edge, logical alias or missing member cannot pass`,()=>{
  const native={sql_graph:[...predecessors,A].map(edge)};
  for(const edit of[c=>c.members.pop(),c=>c.definitions.pop(),c=>c.missing.push(D.id),c=>c.members.push(row(A)),c=>c.members.at(-1).storage.path=D.path,c=>c.members.at(-1).bytes++,c=>c.members.at(-1).sha256='0'.repeat(64),c=>c.members.at(-1).storage.encoding='gzip209']){const c=structuredClone(fixture(true));edit(c);assert.throws(()=>format.assertStorage209Partition(c,native));}
  for(const edit of[n=>n.sql_graph.push(edge(A)),n=>n.sql_graph.at(-1).sha256='0'.repeat(64),n=>n.sql_graph.at(-1).path=`native/${N}_other.sql`,n=>n.sql_graph.at(-1).id='other'+N]){const n=structuredClone(native);edit(n);assert.throws(()=>format.hasReleaseResourceEdge(N,n));}
  assert.throws(()=>format.assertStorage209Partition(fixture(true),{sql_graph:predecessors.map(edge)}));assert.throws(()=>format.assertStorage209Partition(fixture(false),native));
 });
 async function stage({include=true,registration=include,present=include,corrupt=false,registrationFile=r.file}={}){
  const aliases=[...predecessors,...(include?[A]:[])],buffers=new Map();for(const a of aliases)buffers.set(a.native_path,await fs.readFile(path.join(root,'server',path.posix.basename(a.path))));
  const files=aliases.map(a=>({path:a.native_path,bytes:a.bytes,sha256:a.sha256,role:'native-sql'})),puts=[];
  const pairs=[['209_order_merge_delivery_inheritance','209_order_merge_delivery_inheritance.sql'],...R.slice(0,k).map(x=>[x.name,x.file]),...(registration?[[r.name,registrationFile]]:[])];
  const db=Buffer.from('for (const [name, file] of ['+pairs.map(([n,f])=>`['${n}','./${f}']`).join(',')+']) {}');
  const io=async(dir,name)=>{if(dir==='/virtual-output'){assert(buffers.has(name));return buffers.get(name);}assert.equal(dir,root);if(name==='server/db.ts')return db;if(later.some(x=>x.definition.source===name))throw notSelected();
   if(name===D.source){if(!present)throw notSelected();const b=await fs.readFile(path.join(root,name));if(corrupt){const changed=Buffer.from(b);changed[0]^=1;assert.equal(changed.length,b.length);return changed;}return b;}
   assert(base.some(d=>d.source===name)||predecessors.some(a=>'server/'+path.posix.basename(a.path)===name),'finite-file-read:'+name);return fs.readFile(path.join(root,name));};
  const result=await makeStage(io)({projectRoot:root,outputRoot:'/virtual-output',files,put:async(p,b,role)=>{puts.push(p);buffers.set(p,b);files.push({path:p,bytes:b.length,sha256:sha(b),role});},contract:{native_contract:{sql_graph:aliases.map(edge)}},contractBytes:async p=>buffers.get(p)});return{result,puts,files};}
 test(`actual builder selects one full${N} Native SQL resource and preserves legacy${prev?.number??209} output`,async()=>{
  const after=await stage();assert.deepEqual(after.result.resourceContract,fixture(true));assert.deepEqual(after.puts,[S209.path]);assert.equal(after.files.filter(f=>f.path===A.native_path).length,1);assert(!after.files.some(f=>f.path===D.path));assert(after.result.resourceCuts.some(c=>c.path===D.source&&c.sha256===A.sha256));
  const before=await stage({include:false});assert.deepEqual(before.result.resourceContract,fixture(false));assert.deepEqual(before.puts,[S209.path]);
 });
 test(`actual builder refuses partial registration/resource/Native selection and altered full${N} source`,async()=>{
  await assert.rejects(stage({registration:false}),new RegExp(N+'-migration-native-edge-parity'));await assert.rejects(stage({present:false}),new RegExp(N+'-resource-native-edge-parity'));
  await assert.rejects(stage({include:false,registration:true}),new RegExp(N+'-migration-native-edge-parity'));await assert.rejects(stage({include:false,present:true}),new RegExp(N+'-resource-native-edge-parity'));
  await assert.rejects(stage({corrupt:true}),new RegExp(N+'-full-source-pin'));await assert.rejects(stage({registrationFile:N+'_wrong.sql'}),new RegExp(N+'-exact-migration-pair'));
 });
 test(`actual unbundled reader enforces entire${N} bytes and canonical db consumer`,async()=>{
  const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),`release${N}-resource-`)));
  try{await fs.mkdir(temp+'/server');await fs.writeFile(temp+'/package.json',JSON.stringify({name:'dynaminds-ecommerce'}));await fs.writeFile(temp+'/server/db.ts','// actual unbundled source consumer');
   const b=await fs.readFile(path.join(root,D.source));assert.equal(b.length,A.bytes);assert.equal(sha(b),A.sha256);await fs.writeFile(path.join(temp,D.source),b);
   assert.deepEqual(await readRuntimeResource(D.id,pathToFileURL(temp+'/server/db.ts')),b);await fs.appendFile(path.join(temp,D.source),'\n');
   await assert.rejects(readRuntimeResource(D.id,pathToFileURL(temp+'/server/db.ts')),/resource-size/);await assert.rejects(readRuntimeResource(D.id,pathToFileURL(temp+'/package.json')),/source-consumer/);
  }finally{await fs.rm(temp,{recursive:true,force:true});}
 });
});
