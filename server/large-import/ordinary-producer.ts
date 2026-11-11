import {openLegacyQuarantine,type LegacyRef}from'./legacy-quarantine';
/** Root-called ordinary assembly. Import is inert; no seed, app, listen, migrations or worker.
 * The installed checker must provide real closed implementations/evidence. Missing native
 * proof remains unavailable in the existing private registry; this module never mints it.
 */
import assert from 'node:assert/strict';
import {watchDbClient} from '../db-connection-errors';
import type{SharedWriterScope}from'./shared-session-writer';
import {createOrdinaryInstalledLargeImportPorts,type LocalRuntimeInput} from './ordinary-installed-ports';
import type {PortableStartupInput,ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import type {Actor} from '../domain';
export type InstalledOrdinaryProducerInput={coreCheckpoint?:'known-partial203';
 sharedWriterScope:SharedWriterScope;approvedStartup:ReviewedStartup;release:PortableStartupInput;databaseUrl:string;cursorKey:string;sessionName:'dyna_session';
 root:string;custody:LocalRuntimeInput['custody'];ceilings:LocalRuntimeInput['ceilings'];
 /** Independently accepted source-owned all18/nine adapters, saved wiring proof and complete
  * charged retained inventory including the bounded control-plane cut. No readiness JSON. */
 installed:Pick<LocalRuntimeInput,'registryInput'|'inventoryWithControlPlane'>&{legacyQuarantine?:{baseline:LegacyRef}};
 cleanupFailure(error:unknown):void;
};
export async function createOrdinaryInstalledProducer(input0:InstalledOrdinaryProducerInput){
 // Capture private Root inputs before any import or constructor await. Never read route JSON.
 const input={...input0,release:structuredClone(input0.release),custody:{...input0.custody},ceilings:structuredClone(input0.ceilings),installed:{...input0.installed,...(input0.installed.legacyQuarantine?{legacyQuarantine:structuredClone(input0.installed.legacyQuarantine)}:{}),registryInput:structuredClone(input0.installed.registryInput)}};
 const url=new URL(input.databaseUrl);assert(url.protocol==='postgres:'&&url.username==='postgres'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&/^\/[A-Za-z0-9_]+$/.test(url.pathname)&&url.search===''&&url.hash==='','ordinary-producer-own-loopback-database');
 assert.equal(input.sessionName,'dyna_session');assert.equal(input.release.expectedOwner,'postgres');assert(typeof input.cursorKey==='string'&&input.cursorKey.length>=32,'ordinary-producer-existing-private-cursor-key');
 assert(input.installed?.registryInput?.source?.id==='installed:fixed-engine-v1'&&Array.isArray(input.installed.registryInput.source.sources)&&typeof input.installed.inventoryWithControlPlane==='function','ordinary-producer-real-installed-bindings-required');
 // Resources and exact db env must already have been installed by the normal ordinary
 // constructor. These actual module imports do not run its index/seed/background entry.
 assert.equal(process.env.DATABASE_URL,input.databaseUrl,'ordinary-producer-same-installed-database');
 const [{default:pg},db,core,pimRuntime,nested]=await Promise.all([
  import('pg'),import('../db'),import('../catalog-file-import'),
  import('../pim-dictionaries/runtime'),import('../pim-dictionaries/nested-capability')]);
 // Same ordinary feature preflights. They do not replace native per-operation authority,
 // early/late grants or the managed tenantTx prepare/drain/LAST/COMMIT finalizers.
 const constructionPim=await db.preflightOrdinaryConstructionPim();
 const pimAvailable=constructionPim===undefined?await pimRuntime.preflightPim(db.pool):constructionPim.pimAvailable;
 const nestedAvailable=constructionPim===undefined?await nested.preflightNestedPim(db.pool,pimAvailable):constructionPim.nestedAvailable;
 const coreAvailable=Boolean((await db.pool.query(`SELECT bool_and(to_regclass('public.' || name) IS NOT NULL) present FROM unnest(ARRAY['catalog_file_import_previews','catalog_file_import_rows','catalog_file_import_executions','catalog_file_import_execution_rows']) name`)).rows[0]?.present);
 assert(pimAvailable&&coreAvailable,'ordinary-producer-real-core-pim-prerequisite');
 const connectOwner=async()=>{const c=watchDbClient(new pg.Client({connectionString:input.databaseUrl}),'large-import-producer-owner');try{await c.connect();return c;}catch(first){try{await c.end();}catch(e){try{input.cleanupFailure(e);}catch{}}throw first;}};
 const validateCatalog=async(actor:Actor,catalog:string)=>{
  // Transport authenticates the original cookie/key before/after this read; lookup never
  // grants an Actor and cannot replace CORE/PIM native validation or mutation scope.
  assert(actor.role==='admin');
  const selected=await db.tenantReadTx(actor.tenantId,async c=>(await c.query("SELECT public.product_catalog_read($1,$2,'detail',$3,NULL,1,'{}'::jsonb) fact",[actor.userId,actor.apiKeyId??null,catalog])).rows[0]?.fact);
  assert(selected?.catalog?.id===catalog&&selected.catalog.active===true,'ordinary-producer-own-active-catalog-required');
 };
 const legacyQuarantine=input.installed.legacyQuarantine?await openLegacyQuarantine({startup:input.approvedStartup,connectOwner,database:url.pathname.slice(1),currentRoots:{raw:input.root,controlPlane:input.custody.root},baselineRef:input.installed.legacyQuarantine.baseline,signal:new AbortController().signal,cleanupFailure:input.cleanupFailure}):undefined;
 return createOrdinaryInstalledLargeImportPorts({...(legacyQuarantine?{legacyQuarantine}:{}),...(input.coreCheckpoint?{coreCheckpoint:input.coreCheckpoint}:{}),sharedWriterScope:input.sharedWriterScope,approvedStartup:input.approvedStartup,release:input.release,root:input.root,expectedOwner:'postgres',sessionName:input.sessionName,readOnly:false,connectOwner,cleanupFailure:input.cleanupFailure,
  native:core,coreAvailable:()=>coreAvailable,validateCatalog,
  pim:{service:{sessionName:input.sessionName,readOnly:false,cursorKey:input.cursorKey,transaction:(actor,_write,work)=>db.tenantTx(actor.tenantId,work)},nestedAvailable:()=>nestedAvailable},
  custody:input.custody,ceilings:input.ceilings,registryInput:input.installed.registryInput,inventoryWithControlPlane:input.installed.inventoryWithControlPlane});
}
