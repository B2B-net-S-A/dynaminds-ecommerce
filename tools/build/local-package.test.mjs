import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseSync} from 'vite';
import {parseArguments,assertProjectContractMembers} from './local-package.mjs';
import {sha} from './portable-release.mjs';
import {historicalSource} from './historical-source.mjs';
import {inspectRuntimeDependencies} from './inspect.mjs';
import {build} from 'esbuild';
import {assertPortableRuntimeOutput} from './package-builder.mjs';

const base='shared/large-import-dependencies/pim-large-import173-business-traversal-ui/';
const args=['--project','/source','--source-contract','/contract','--source-manifest-sha','a'.repeat(64),'--output','/output'];
test('CLI requires trusted SHA and distinct fresh output, rejects duplicate or missing inputs',()=>{
 assert.equal(parseArguments(args).sourceReleaseManifestSha,'a'.repeat(64));
 for(const bad of [args.slice(0,-2),[...args,'--project','/another'],[...args,'--unknown'],args.map(x=>x==='/output'?'/source/output':x),args.map(x=>x==='/output'?'/contract':x),args.map(x=>x==='a'.repeat(64)?'guess':x)])assert.throws(()=>parseArguments(bad));
});

async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'portable-build-test-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const files=[];
 async function add(name,text,role,contractPath=name){
  await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),text);
  files.push({path:contractPath,role,sha256:sha(text),bytes:Buffer.byteLength(text)});
 }
 await add('server/large-import/runtime-registration.ts','pinned runtime','runtime-source');
 await add('server/177_test.sql','pinned SQL','native-sql','native/177_test.sql');
 await add('server/189_test.sql','pinned dual SQL','native-sql-runtime-resource','resources/server/189_test.sql');
 await add(base+'ordinary177-contract.json','{"pinned":true}','compatibility-contract','contract/ordinary177.json');
 for(const name of ['portable-release.mjs','emitted-release.mjs','ordinary177-contract.mjs','resource-definitions.mjs','resource-io.mjs','resource-format209.mjs']){
  const p=path.join(root,base+name);await fs.writeFile(p,await fs.readFile(new URL(name,import.meta.url)));
 }
 return {root,manifest:{files,native_contract:{compatibility:{path:'contract/ordinary177.json'}}}};
}

test('pinned contract roster is exact while custody and application changes remain outside it',async t=>{
 const f=await fixture(t);await assertProjectContractMembers(f.root,f.manifest);
 await fs.writeFile(path.join(f.root,'server/large-import/owned-allocation-custody.ts'),'new552 code');
 await fs.writeFile(path.join(f.root,'server/large-import/ordinary-installed-ports.ts'),'new552 code');
 await assertProjectContractMembers(f.root,f.manifest);
});
for(const [name,file] of [['runtime','server/large-import/runtime-registration.ts'],['Native SQL','server/177_test.sql'],['dual-role SQL','server/189_test.sql'],['compatibility',base+'ordinary177-contract.json'],['validator',base+'ordinary177-contract.mjs'],['209 codec validator',base+'resource-io.mjs'],['209 format validator',base+'resource-format209.mjs']]){
 test(`${name} drift requires a new matching source contract; cannot reuse old Source45`,async t=>{
  const f=await fixture(t);await fs.appendFile(path.join(f.root,file),'tampered');
  await assert.rejects(assertProjectContractMembers(f.root,f.manifest));
 });
}

for(const reachable of [false,true])test(`absent historical source ${reachable?'survives and remains forbidden':'is proved dead without opening archive files'}`,async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'portable-history-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'server'));
 await fs.writeFile(path.join(root,'server/module.mjs'),"export const live=1;export async function oldDerivation(){return import('../data/source-drafts/absent/old.mjs');}");
 await fs.writeFile(path.join(root,'server/main.mjs'),reachable?"import {oldDerivation} from './module.mjs';console.log(await oldDerivation());":"import {live} from './module.mjs';console.log(live);");
 await fs.writeFile(path.join(root,'package.json'),'{"dependencies":{}}');await fs.writeFile(path.join(root,'package-lock.json'),'{"packages":{}}');
 const inspected=await inspectRuntimeDependencies({projectRoot:root,entrypoints:['server/main.mjs']});
 assert(inspected.files.every(f=>!f.path.startsWith('data/source-drafts/')));
 assert(inspected.blockers.every(f=>f.kind==='historical-runtime-dependency'));
 const output=await build({absWorkingDir:root,entryPoints:['server/main.mjs'],bundle:true,treeShaking:true,write:false,platform:'node',format:'esm',plugins:[{name:'same-portable-resolver',setup(b){b.onResolve({filter:/.*/},a=>historicalSource(a,root));}}]});
 // Same existing emitter's no-archive-output guard must refuse the reachable case.
 if(reachable)assert.throws(()=>output.outputFiles.forEach(f=>assertPortableRuntimeOutput(f.text)));
 else output.outputFiles.forEach(f=>assertPortableRuntimeOutput(f.text));
});


test('actual emission printer removes whitespace without renaming or changing SQL/string/regex data and shared namespace',async t=>{
 // Read the real build call so this check cannot keep testing an unrelated
 // minifier configuration if the production emission options change.
 const source=await fs.readFile(new URL('package-builder.mjs',import.meta.url),'utf8');
 const parsed=parseSync('package-builder.mjs',source,{lang:'js'}),calls=[];assert.equal(parsed.errors.length,0);
 const visit=node=>{if(!node||typeof node!=='object')return;if(node.type==='CallExpression'&&node.callee?.type==='Identifier'&&node.callee.name==='build')calls.push(node);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}};visit(parsed.program);
 assert.equal(calls.length,1);assert.equal(calls[0].arguments[0].type,'ObjectExpression');
 const properties=new Map(calls[0].arguments[0].properties.filter(p=>p.type==='Property').map(p=>[p.key.name,p.value]));
 const options={};for(const key of ['bundle','splitting','treeShaking','minifyWhitespace','write','metafile']){
  const value=properties.get(key);assert(value?.type==='Literal'&&typeof value.value==='boolean');options[key]=value.value;
 }
 assert.equal(options.minifyWhitespace,true);assert.equal(options.write,false);assert.equal(options.splitting,true);assert.equal(options.treeShaking,true);
 for(const key of ['minify','minifyIdentifiers','minifySyntax'])assert(!properties.has(key),'no additional minification');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'portable-whitespace-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const sql="SELECT  'two  spaces'::text;\n  -- preserve SQL line\nSELECT E'line\\nvalue';\n";
 const text='first  line\n    second\tline';
 await fs.writeFile(path.join(root,'shared.mjs'),`const privateToken=Object.freeze({});export const sameToken=()=>privateToken;export const sql=${JSON.stringify(sql)};export const text=${JSON.stringify(text)};export const pattern=/^a  b\\s+c$/u;export function PublicTaskFunction(){return sql;}export class PublicTaskClass{};export const unused='SHOULD_NOT_SURVIVE_TREE_SHAKING';`);
 const entry="export {sameToken,sql,text,pattern,PublicTaskFunction,PublicTaskClass} from './shared.mjs';\n";
 await fs.writeFile(path.join(root,'one.mjs'),entry);await fs.writeFile(path.join(root,'two.mjs'),entry);
 const output=await build({...options,absWorkingDir:root,entryPoints:['one.mjs','two.mjs'],outdir:'built',platform:'node',format:'esm',outExtension:{'.js':'.mjs'},logLevel:'silent'});
 assert.equal(output.warnings.length,0);for(const file of output.outputFiles){assertPortableRuntimeOutput(file.text);assert(!file.text.includes('SHOULD_NOT_SURVIVE_TREE_SHAKING'));await fs.mkdir(path.dirname(file.path),{recursive:true});await fs.writeFile(file.path,file.contents);}
 const one=await import(pathToFileURL(path.join(root,'built/one.mjs')).href),two=await import(pathToFileURL(path.join(root,'built/two.mjs')).href);
 assert.equal(one.sql,sql);assert.equal(one.text,text);assert.equal(one.PublicTaskFunction(),sql);assert.equal(one.PublicTaskFunction.name,'PublicTaskFunction');assert.equal(one.PublicTaskClass.name,'PublicTaskClass');assert.equal(new one.PublicTaskClass().constructor.name,'PublicTaskClass');
 assert.equal(one.pattern.source,'^a  b\\s+c$');assert.equal(one.pattern.flags,'u');assert(one.pattern.test('a  b   c'));assert(!one.pattern.test('a b   c'));
 assert.strictEqual(one.sameToken(),two.sameToken(),'one shared private namespace across entrypoints');assert.strictEqual(one.PublicTaskClass,two.PublicTaskClass);
 const repeated=await build({...options,absWorkingDir:root,entryPoints:['one.mjs','two.mjs'],outdir:'built',platform:'node',format:'esm',outExtension:{'.js':'.mjs'},logLevel:'silent'});
 assert.deepEqual(repeated.outputFiles.map(f=>[f.path,sha(f.contents)]),output.outputFiles.map(f=>[f.path,sha(f.contents)]),'deterministic emitted bytes');
});
