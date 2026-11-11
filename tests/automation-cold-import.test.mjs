import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

test('cold actual app module graph initializes catalog schema with inert PG and no services',async()=>{
 const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),temp=await mkdtemp(path.join(tmpdir(),'dyna-automation-cold-import-'));
 try{
  const config=path.join(temp,'controlled.private.json');await writeFile(config,JSON.stringify({dbPassword:'controlled-cold-import-only',encryptionKey:'a'.repeat(64)}),{mode:0o600});
  const child=path.join(temp,'cold.mjs');
  const pg=`globalThis.__coldPg={pools:0,clients:0,queries:0,connects:0};
   class Pool{constructor(options){this.options=options;globalThis.__coldPg.pools++;}on(){return this;}query(){globalThis.__coldPg.queries++;throw Error('cold-import-query-forbidden');}connect(){globalThis.__coldPg.connects++;throw Error('cold-import-connect-forbidden');}async end(){}}
   class Client{constructor(){globalThis.__coldPg.clients++;throw Error('cold-import-client-forbidden');}}
   const types={setTypeParser(){},getTypeParser(){return x=>x;}};function escapeLiteral(){throw Error('cold-import-SQL-generation-forbidden');}function escapeIdentifier(){throw Error('cold-import-SQL-generation-forbidden');}
   export{Pool,Client,types,escapeLiteral,escapeIdentifier};export default{Pool,Client,types,escapeLiteral,escapeIdentifier};`;
  const code=`import assert from 'node:assert/strict';import{registerHooks}from'node:module';import net from'node:net';
   net.Server.prototype.listen=function(){throw Error('cold-import-listener-forbidden');};net.Socket.prototype.connect=function(){throw Error('cold-import-network-forbidden');};
   const stub=${JSON.stringify('data:text/javascript,'+encodeURIComponent(pg))};registerHooks({resolve(specifier,context,next){if(specifier==='pg')return{url:stub,shortCircuit:true};return next(specifier,context);}});
   const app=await import(${JSON.stringify(pathToFileURL(path.join(app,'server/app.ts')).href)});
   const domain=await import(${JSON.stringify(pathToFileURL(path.join(app,'server/domain.ts')).href)});
   const rules=await import(${JSON.stringify(pathToFileURL(path.join(app,'server/product-rules.ts')).href)});
   assert.equal(typeof app.buildApp,'function');assert(domain.catalogFields.shape.name);assert.equal(typeof rules.productRuleDefinition.parse,'function');
   assert.equal(globalThis.__coldPg.queries,0);assert.equal(globalThis.__coldPg.connects,0);assert.equal(globalThis.__coldPg.clients,0);
   process.stdout.write(JSON.stringify({status:'ACTUAL_COLD_MODULE_IMPORT_PASS_NOT_FACTORY_OR_BUSINESS',pg:globalThis.__coldPg})+'\\n');`;
  await writeFile(child,code);
  const result=spawnSync(process.execPath,['--import',pathToFileURL(path.join(app,'node_modules/tsx/dist/loader.mjs')).href,child],{cwd:app,env:{PATH:process.env.PATH,DYNA_LOCAL_CONFIG_PATH:config,DATABASE_URL:'postgres://postgres:controlled@127.0.0.1:1/cold_import_only'},encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
  assert.equal(result.status,0,result.stderr||result.error?.message);const observed=JSON.parse(result.stdout.trim());assert.equal(observed.status,'ACTUAL_COLD_MODULE_IMPORT_PASS_NOT_FACTORY_OR_BUSINESS');assert.equal(observed.pg.queries,0);assert.equal(observed.pg.connects,0);
  // The event path must remain lightweight even when future imports are added.
  const source=await readFile(path.join(app,'server/automation-local-channel.ts'),'utf8');
  assert(!/^import(?! type).*from ['"]\.\/(?:db|domain|offers|operation-schema)['"]/m.test(source));
 }finally{await rm(temp,{recursive:true,force:true});}
});
