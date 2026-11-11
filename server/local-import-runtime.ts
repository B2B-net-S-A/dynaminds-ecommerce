/** Inert installed exercise facade. Import never reads configuration or creates a pool/app/client. */
import assert from 'node:assert/strict';
import {watchDbClient} from './db-connection-errors';
import {realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createPortableReviewedStartup,inspectCompositeStartup,recheckReviewedStartupEvidence,type ReviewedStartup} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import {installRuntimeResources} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs';
import {assertMfXsdRelease} from './mf-xsd';
import {runFixedMetadataExercise as executeMetadata,type MetadataExerciseData,type MetadataExerciseRequest} from './large-import/installed-metadata-checker';
import type {Client} from '../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/storage';
import type {Actor} from './domain';
import type {OwnedBusinessTasks,CompositionPorts} from '../shared/large-import-dependencies/pim-large-import-business-native-proof-ui/composition';
export {createPortableReviewedStartup,inspectCompositeStartup,recheckReviewedStartupEvidence};
export const createPortableStartup=createPortableReviewedStartup;
let installedConfiguration:InternalExerciseInstallation|undefined;
export type InternalExerciseInstallation={releaseDirectory:string;manifestSha:string;expectedOwner:'postgres';databaseUrl:string;localConfigurationPath:string;revision:string};
export async function createAppForInternalExercise(input0:InternalExerciseInstallation){
 const input=structuredClone(input0);
 assert.deepEqual(Object.keys(input).sort(),['databaseUrl','expectedOwner','localConfigurationPath','manifestSha','releaseDirectory','revision']);
 assert.equal(input.expectedOwner,'postgres');
 const url=new URL(input.databaseUrl);assert.equal(url.protocol,'postgres:');assert.equal(url.username,'postgres');
 assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'local-postgres-required');assert(url.pathname.length>1);
 assert(path.isAbsolute(input.localConfigurationPath)&&path.resolve(input.localConfigurationPath)===input.localConfigurationPath);
 assert.equal(await realpath(input.localConfigurationPath),input.localConfigurationPath);
 const config=await lstat(input.localConfigurationPath);assert(config.isFile()&&!config.isSymbolicLink()&&config.nlink===1&&(config.mode&0o777)===0o600,'private-local-config-required');
 assert(input.revision.length>0);
 if(installedConfiguration)assert.deepEqual(input,installedConfiguration,'one-exercise-installation-context');else installedConfiguration=structuredClone(input);
 await installRuntimeResources({releaseDirectory:input.releaseDirectory,manifestSha:input.manifestSha});
 await assertMfXsdRelease();
 process.env.DATABASE_URL=input.databaseUrl;process.env.DYNA_LOCAL_CONFIG_PATH=input.localConfigurationPath;process.env.APP_REVISION=input.revision;
 process.env.DYNA_TEST='true';process.env.DYNA_WORKER_DISABLED='true';
 const db=await import('./db'),pg=await import('pg');
 const owners=new Map<Client,{closed:boolean}>(),cleanupErrors:unknown[]=[];let closing=false,providerCalls=0,app:Awaited<ReturnType<typeof import('./app')['buildApp']>>|undefined;
 const cleanupFailure=(e:unknown)=>{cleanupErrors.push({name:e instanceof Error?e.name:typeof e});};
 const pending=new Set<Promise<Client>>();
 const acquireOwner=async():Promise<Client>=>{
  assert(!closing,'exercise-context-closing');const native=watchDbClient(new pg.default.Client({connectionString:input.databaseUrl}),'local-import-owner');
  const client=native as unknown as Client;owners.set(client,{closed:false});const end=client.end.bind(client);
  client.end=async()=>{await end();owners.get(client)!.closed=true;};
  try{await native.connect();assert(!closing,'exercise-context-closed-during-connect');
   await native.query("SET SESSION statement_timeout='8s'");await native.query("SET SESSION lock_timeout='8s'");await native.query('SET SESSION jit=off');await native.query("SET SESSION timezone='UTC'");
   const identity=(await native.query("SELECT current_user owner,session_user session_owner,current_setting('role') role")).rows[0];
   assert(identity.owner==='postgres'&&identity.session_owner==='postgres'&&identity.role==='none','fresh-owner-identity');return client;
  }catch(first){try{await client.end();}catch(e){cleanupFailure(e);}throw first;}
 };
 const connectOwner=():Promise<Client>=>{const work=acquireOwner();pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;};
 const closePool=async()=>{closing=true;await Promise.allSettled([...pending]);for(const [c,s]of owners)if(!s.closed)try{await c.end();}catch(e){cleanupFailure(e);}await db.pool.end();};
 const catalogValidator=async(actor:Actor,catalog:string)=>{
  const selected=await db.tenantReadTx(actor.tenantId,async c=>(await c.query("SELECT public.product_catalog_read($1,$2,'detail',$3,NULL,1,'{}'::jsonb) fact",[actor.userId,actor.apiKeyId??null,catalog])).rows[0]?.fact);
  assert(selected?.catalog?.id===catalog&&selected.catalog.active===true,'current-tenant-active-catalog-required');
 };
 try{
  await db.migrate();const module=await import('./app');
  app=await module.buildApp({logging:false,readOnly:false,backgroundWorkersEnabled:false,integrationTransport:async()=>{providerCalls++;throw Error('Internal exercise provider forbidden');}});
 }catch(first){try{await closePool();}catch(e){cleanupFailure(e);}throw first;}
 return Object.freeze({app,
  async runFixedMetadataExercise(data:MetadataExerciseData&{startup:ReviewedStartup;original:MetadataExerciseRequest}){
   assert(!closing,'exercise-context-closing');const startup=data.startup,original=data.original,detached=structuredClone({privateRoot:data.privateRoot,fixture:data.fixture,uploadAllocation:data.uploadAllocation,jobAllocation:data.jobAllocation});
   return executeMetadata({...detached,startup,original,validateCatalog:catalogValidator,transport:{connectOwner,expectedOwner:'postgres',sessionName:'dyna_session',cleanupFailure,preflightOwner173:async c=>{await inspectCompositeStartup(c,startup);return 'VALID';}}});
  },
 async createCorePimExercise(startup: ReviewedStartup, privateRoot: string, cursorKey: string, tasks: OwnedBusinessTasks) {
 assert(!closing, 'exercise-context-closing');
 const capturedStartup=startup, root=privateRoot, capturedCursorKey=cursorKey;
 assert(path.isAbsolute(root)&&path.resolve(root)===root,'business-canonical-private-root');
 assert(typeof capturedCursorKey==='string'&&capturedCursorKey.length>0,'business-cursor-key-required');
 const run=tasks.run.bind(tasks);assert(!tasks.isShuttingDown(),'business-owned-task-ledger-closing');
 // Root register-before-await ledger: same object is passed to composition below.
 return run('business:assembly',async()=>{
 const ownedByAssembly=new Set<Client>();
 const businessConnectOwner=async()=>{const client=await connectOwner();ownedByAssembly.add(client);return client;};
 try{
 // Requires the two source-owned SAME-binding replacements listed in PLAN.md.
 const [{createReadyInternalBusinessEngine}, native, pimRuntime, nested]=await Promise.all([
  import('../shared/large-import-dependencies/pim-large-import-business-native-proof-ui/composition'),
  import('./catalog-file-import'),
  import('./pim-dictionaries/runtime'),
  import('./pim-dictionaries/nested-capability'),
 ]);
 const profile=async()=>{
  const client=await businessConnectOwner();let first:unknown,failed=false;
  try { await inspectCompositeStartup(client,capturedStartup); }
  catch(error){failed=true;first=error;}
  finally {try {await client.end();}catch(error){cleanupFailure(error);if(!failed){failed=true;first=error;}}}
  if(failed)throw first;
 };
 await profile();
 const pimAvailable=await pimRuntime.preflightPim(db.pool);
 const nestedAvailable=await nested.preflightNestedPim(db.pool,pimAvailable);
 assert(pimAvailable&&nestedAvailable,'actual-pim-and-nested-native-required');
 const required=['createCatalogFileImportPreview','catalogFileImportPreviewDetail',
  'executeCatalogFileImport','catalogFileImportExecutionDetail',
  'inspectCoreBatchEligibilityInTx','inspectCoreImportCapacityInTx'] as const;
 assert(required.every(name=>typeof native[name]==='function'),'actual-core-module-required');
 const transport:CompositionPorts['transport']={connectOwner:businessConnectOwner,expectedOwner:'postgres',sessionName:'dyna_session',
  cleanupFailure,preflightOwner173:async(client:Client)=>{
   await inspectCompositeStartup(client,capturedStartup);return 'VALID' as const;
  }};
 const operationNames:string[]=[];
 const ports:CompositionPorts={tasks,root,native,transport,
  assertBusinessSourceAndNativeProfile:profile,
  validateCatalog:catalogValidator,coreAvailable:()=>required.every(name=>typeof native[name]==='function'),
  keeper:{root,transport,preflightOwner:profile,cleanupFailure,
   connectOwner:async(scope)=>{
    const client=await businessConnectOwner();
    try{await client.query("SELECT set_config('app.tenant_id',$1,false)",[scope.tenantId]);return client;}
    catch(first){try{await client.end();}catch(error){cleanupFailure(error);}throw first;}
   }},
  pim:{service:{sessionName:'dyna_session',readOnly:false,cursorKey:capturedCursorKey,
   transaction:(actor,_writing,work)=>db.tenantTx(actor.tenantId,work)},
   nestedAvailable:()=>nestedAvailable},
  // Existing known close uses the real owned keeper. Unknown does not become known.
  inventory:()=>({inspect:async()=>{throw Error('Unknown reconciliation requires actual attributed inventory');}}),
  observeOperation:operation=>{operationNames.push(operation);}, // Diagnostic-only.
 };
 const engine=await createReadyInternalBusinessEngine(ports);
 return Object.freeze({engine,inspectDiagnosticOperations:()=>[...operationNames]});
 }catch(first){
  // Close only clients acquired by this failed assembly; retain the original cause.
  for(const client of ownedByAssembly)if(!owners.get(client)?.closed)try{await client.end();}catch(error){cleanupFailure(error);}
  try{await recheckReviewedStartupEvidence(capturedStartup);}catch(error){cleanupFailure(error);}
  throw first;
 }
 });
},
 nativeOwnerFactory:connectOwner,catalogValidator,closePool,
  inspectLifecycle(){return{providerCalls,cleanupErrors:structuredClone(cleanupErrors),ownerClients:[...owners.values()].map(x=>({...x})),allOwnedClientsClosed:[...owners.values()].every(x=>x.closed)};},
 });
}
export const createBuildApp=createAppForInternalExercise;

/** Same source-owned synchronous ledger for app, route and business engine. */
export {createRouteTasks as createOwnedBusinessTasks} from './large-import/owned-route-tasks';

/** Explicit same-graph protocol audit; authentic finished handle only, no readiness authority. */
export {auditReleasedDurableOriginalHistory187} from './large-import/durable-original-epoch';

/** Explicit normal-admin empty-bootstrap operator; no automatic repair/import replay. */
export {reconcileEmptyEpochFromAuthenticatedOperator} from './large-import/empty-epoch-operator';
