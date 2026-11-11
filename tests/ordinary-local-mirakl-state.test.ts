import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync,constants} from 'node:fs';
import * as path from 'node:path';
import {transformSync} from 'esbuild';
import {validateOrdinaryConnectorAccess} from '../server/ordinary-connector-policy';
import {MIRAKL_CONTROL_DATABASE} from '../server/mirakl-read-postgres';
import * as localWooOrigins from '../shared/local-woo-origins';

const password='CONTROLLED_PRIVATE_PASSWORD';
const configuration={releaseDirectory:'/owned/release',manifestSha:'a'.repeat(64),expectedOwner:'postgres',databaseUrl:`postgres://postgres:${password}@127.0.0.1:57081/dynaminds_main`,localConfigurationPath:'/owned/config.json',revision:'controlled-revision'};
const selection={database:'dynaminds_connector_state'};
const connectorAccess={providers:[{provider:'mirakl' as const,instanceUrl:'https://controlled.mirakl.net',shopId:'2000',access:'read' as const}]};
function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
/** The complete actual factory is evaluated unchanged. IO/PG/native/app ports are
 * controlled; this tests ownership/order, not an actual cold boot or control DB. */
function model(input:{verifyFailure?:unknown;appFailure?:unknown;appCloseFailure?:unknown;poolCloseFailure?:unknown;holdAppClose?:boolean;holdDrain?:boolean}={}){
 const events:string[]=[],output:string[]=[],poolOptions:any[]=[],appOptions:any[]=[],appGate=gate(),drainGate=gate();
 const bytes=Buffer.from(JSON.stringify({dbPassword:password,encryptionKey:'controlled-encryption-key'}));
 const stats={dev:1n,ino:2n,mode:0o100600n,uid:501n,nlink:1n,size:BigInt(bytes.length),mtimeNs:1n,ctimeNs:1n,isFile:()=>true,isSymbolicLink:()=>false};
 const repository={controlled_repository:true};let controlPool:EventEmitter|undefined;
 const app={close:async()=>{events.push('app.close');if(input.holdAppClose)await appGate.promise;if(input.appCloseFailure!==undefined)throw input.appCloseFailure;events.push('app.closed');}};
 class ControlPool extends EventEmitter{
  constructor(options:unknown){super();controlPool=this;poolOptions.push(options);events.push('control.pool');}
  async end(){events.push('control.end');if(input.poolCloseFailure!==undefined)throw input.poolCloseFailure;}
 }
 class Owner extends EventEmitter{async connect(){events.push('owner.connect');}async query(){return{rows:[]};}async end(){events.push('owner.end');}}
 const db={localConfig:{encryptionKey:'controlled'},migrate:async()=>{events.push('main.migrate');},sealOrdinaryConstructionPimScope:async()=>{events.push('main.seal');},installOrdinarySchemaRuntime:()=>{},pool:{end:async()=>{events.push('main.end');}}};
 const control={MIRAKL_CONTROL_DATABASE,verifyMiraklReadPostgres:async(p:unknown)=>{assert.equal(p,controlPool);events.push('control.verify');if(input.verifyFailure!==undefined)throw input.verifyFailure;},createMiraklReadPostgresRepository:(p:unknown)=>{assert.equal(p,controlPool);events.push('control.repository');return repository;}};
 const processPort={env:{} as Record<string,string>,getuid:()=>501,stderr:{write:(text:string)=>{output.push(text);}}};
 // Real db-connection-errors module bound to the controlled process (its log line goes to output).
 const dbErrors={exports:{} as Record<string,unknown>};
 new Function('module','exports','require','process',transformSync(readFileSync(new URL('../server/db-connection-errors.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs',target:'es2022'}).code)(dbErrors,dbErrors.exports,()=>{throw Error('db-connection-errors imports nothing');},processPort);
 const resolver=(name:string):any=>{
  if(name==='node:assert/strict')return assert;
  if(name==='node:path')return path;
  if(name==='node:perf_hooks')return{performance:{now:()=>1}};
  if(name==='node:fs')return{constants};
  if(name==='node:fs/promises')return{realpath:async(p:string)=>p,lstat:async()=>stats,open:async()=>{events.push('private.open');return{stat:async()=>stats,readFile:async()=>bytes,close:async()=>{events.push('private.close');}};}};
  if(name==='./ordinary-connector-jobs')return{assertOrdinaryConnectorJobExecution:()=>{}};
  if(name==='./mirakl-read-postgres')return control;
  if(name==='./provider-read-transport')return{inspectOrdinaryConnectorTransport:(p:any)=>p.configuration};
  if(name==='./ordinary-legacy-schema.mjs')return{normalizeOrdinaryLegacyOwnerAcls:async()=>{}};
  if(name==='./local-ui-origin')return{validateTrustedLocalUiOrigin:(v:string)=>v};
  if(name==='./ordinary-provider-reads')return{prepareOrdinaryProviderReads:()=>undefined,prepareOrdinaryAmazonMcfReads:()=>undefined,prepareOrdinaryNbpRates:()=>undefined,
   prepareOrdinaryConnectorAccess:(value:any,context:any)=>{if(value===undefined)return undefined;assert(!context.readOnly,'readonly');return{configuration:validateOrdinaryConnectorAccess(value)};}};
  if(name==='./catalog-stock-writer-coverage')return{disposeStockWriterActivation:async()=>{}};
  if(name==='../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api')return{
   createPortableReviewedStartup:async()=>({controlled_startup:true}),activateRuntimeGeneration:async()=>{},inspectCompositeStartup:async()=>{},recheckReviewedStartupEvidence:async()=>{events.push('startup.recheck');}};
  if(name==='../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs')return{installRuntimeResources:async()=>{events.push('resources.install');}};
  if(name==='./mf-xsd')return{assertMfXsdRelease:async()=>{}};
  if(name==='./ordinary-request-lifetime')return{createOrdinaryRequestLifetime:()=>({}),beginOrdinaryShutdown:()=>{events.push('shutdown.begin');},drainOrdinaryRequests:async()=>{events.push('requests.drain');if(input.holdDrain)await drainGate.promise;events.push('requests.drained');},inspectOrdinaryRequests:()=>({})};
  if(name==='./large-import/shared-session-writer')return{};
  // 9224af7: the factory bounds configured local Woo fixtures by the actual shared store limit.
  if(name==='../shared/local-woo-origins')return localWooOrigins;
  if(name==='./local-woo-http-transport')return{localWooOrigin:()=>assert.fail('No local Woo fixtures in Mirakl state tests')};
  if(name==='./database-temp-privilege')return{assertDatabaseTempPrivilege:async(pool:unknown)=>{assert.equal(pool,db.pool);events.push('temp262.check');}};
  if(name==='./db-connection-errors')return dbErrors.exports;
  if(name==='./db')return db;
  if(name==='pg')return{Pool:ControlPool,Client:Owner};
  if(name==='./app')return{buildApp:async(options:any)=>{events.push('app.build');appOptions.push(options);if(input.appFailure!==undefined)throw input.appFailure;return app;}};
  throw Error('Unexpected factory dependency '+name);
 };
 const source=readFileSync(new URL('../server/ordinary-local-runtime.ts',import.meta.url),'utf8');
 const code=transformSync(source,{loader:'ts',format:'cjs',target:'es2022',supported:{'dynamic-import':false}}).code;
 const module={exports:{} as {createOrdinaryLocalApplication:(configuration:any,options?:any)=>Promise<any>}};
 new Function('module','require','process',code)(module,resolver,processPort);
 assert.equal(events.length,0,'import creates no pool, private IO, native startup or app');
 return{create:module.exports.createOrdinaryLocalApplication,events,output,poolOptions,appOptions,repository,appGate,drainGate,get controlPool(){return controlPool;}};
}

test('Mirakl state selection refuses readonly, malformed or unselected capabilities before IO/global installation claim',async()=>{
 for(const options of [{miraklReadState:null},{miraklReadState:{database:'dynaminds_main'}},{miraklReadState:{database:'dynaminds_connector_state',password:'secret'}},
  {miraklReadState:selection,readOnly:true},{miraklReadState:selection},{miraklReadState:selection,connectorAccess:{providers:[{provider:'inpost',mode:'sandbox',access:'read'}]}}]){
  const x=model();await assert.rejects(x.create(configuration,options));assert.deepEqual(x.events,[]);
  const runtime=await x.create(configuration,{miraklReadState:selection,connectorAccess});await runtime.close();
  assert.equal(x.events.filter(e=>e==='control.pool').length,1,'refusal must not consume the global installation claim');
 }
});

test('owned control pool derives only database from validated Main URL, verifies before app and injects repository',async()=>{
 const x=model();const runtime=await x.create(configuration,{miraklReadState:selection,connectorAccess});
 const p=x.poolOptions[0],selected=new URL(p.connectionString),main=new URL(configuration.databaseUrl);
 assert.equal(selected.pathname,'/dynaminds_connector_state');selected.pathname=main.pathname;assert.equal(selected.href,main.href);
 assert.equal(p.max,4);assert.equal(p.connectionTimeoutMillis,5000);assert.equal(p.query_timeout,8000);assert.equal(p.idleTimeoutMillis,30000);
 assert.match(p.options,/jit=off/);assert.match(p.options,/timezone=UTC/);assert.match(p.options,/statement_timeout=5000/);assert.match(p.options,/lock_timeout=3000/);assert.match(p.options,/idle_in_transaction_session_timeout=10000/);
 assert(x.events.indexOf('control.verify')<x.events.indexOf('resources.install'));
 assert(x.events.indexOf('control.verify')<x.events.indexOf('app.build'));assert.equal(x.appOptions[0].miraklReadRepository,x.repository);assert.equal(x.appOptions[0].backgroundWorkersEnabled,false);
 x.controlPool!.emit('error',Error(password));assert.deepEqual(x.output.map(s=>JSON.parse(s)),[{event:'DATABASE_CONNECTION_ERROR',source:'mirakl-read-state',code:'UNCLASSIFIED'}]);assert(!x.output.join('').includes(password));
 await runtime.close();await runtime.close();assert.equal(x.events.filter(e=>e==='control.end').length,1);
 assert(x.events.indexOf('requests.drained')<x.events.indexOf('control.end'));assert(x.events.indexOf('app.closed')<x.events.indexOf('control.end'));
});

test('default remains inert for control DB; normal factory does not construct, verify or inject a Mirakl repository',async()=>{
 const x=model(),runtime=await x.create(configuration);assert.equal(x.poolOptions.length,0);assert.equal(x.appOptions[0].miraklReadRepository,undefined);await runtime.close();assert(!x.events.includes('control.end'));
});

test('control readiness failure is redacted, closes the owned pool and prevents native/Main/app work',async()=>{
 const x=model({verifyFailure:Error(password),poolCloseFailure:Error('secondary '+password)});
 await assert.rejects(x.create(configuration,{miraklReadState:selection,connectorAccess}),e=>e instanceof Error&&e.message==='ordinary-mirakl-read-state-not-ready'&&!e.message.includes(password));
 assert.equal(x.events.filter(e=>e==='control.end').length,1);assert(!x.events.includes('resources.install'));assert(!x.events.includes('main.migrate'));assert(!x.events.includes('app.build'));
 const same=model(),databaseUrl=configuration.databaseUrl.replace('/dynaminds_main','/dynaminds_connector_state');
 await assert.rejects(same.create({...configuration,databaseUrl},{miraklReadState:selection,connectorAccess}),/ordinary-mirakl-read-state-not-ready/);assert.equal(same.poolOptions.length,0);
});

test('app failure retains primary and drains before closing control pool; successful close waits real app and request drain',async()=>{
 const primary=Error('controlled app failure'),failed=model({appFailure:primary,poolCloseFailure:Error('secondary')});
 await assert.rejects(failed.create(configuration,{miraklReadState:selection,connectorAccess}),e=>e===primary);
 assert(failed.events.indexOf('requests.drained')<failed.events.indexOf('control.end'));
 const x=model({holdAppClose:true,holdDrain:true}),runtime=await x.create(configuration,{miraklReadState:selection,connectorAccess});
 const closing=runtime.close();await Promise.resolve();assert(!x.events.includes('control.end'));x.appGate.resolve();
 for(let i=0;i<30&&!x.events.includes('requests.drain');i++)await Promise.resolve();
 assert(x.events.includes('requests.drain'));assert(!x.events.includes('control.end'));x.drainGate.resolve();await closing;assert.equal(x.events.filter(e=>e==='control.end').length,1);
});

test('close failure preserves app cause, still closes control/Main pools; isolated control close error is fixed/redacted',async()=>{
 const primary=Error('controlled app close failure'),x=model({appCloseFailure:primary,poolCloseFailure:Error(password)}),runtime=await x.create(configuration,{miraklReadState:selection,connectorAccess});
 await assert.rejects(runtime.close(),e=>e===primary);assert(x.events.includes('control.end'));assert(x.events.includes('main.end'));
 const y=model({poolCloseFailure:Error(password)}),r=await y.create(configuration,{miraklReadState:selection,connectorAccess});
 await assert.rejects(r.close(),e=>e instanceof Error&&e.message==='ordinary-mirakl-read-state-close-unconfirmed');assert(y.events.includes('main.end'));
});
