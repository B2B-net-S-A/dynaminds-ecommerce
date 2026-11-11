import {admitLegacyOriginalSnapshot,type LegacyQuarantine}from'./legacy-quarantine';
/** Cooperative session barrier. Not installation certification, complete census, native IAM or public command authority. */
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {watchDbClient} from '../db-connection-errors';
import {bindDurableOriginal187,runDurableOriginalWork187,markDurableOriginalDrained187,closeReleasedDurableOriginal187,auditReleasedDurableOriginalHistory187,type DurableOriginal187} from './durable-original-epoch';
import type {FastifyRequest} from 'fastify';
import type {Actor} from '../domain';
import {assertOriginalMetadataClientBinding187} from '../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
import type {OriginalMetadataBinding} from './original-metadata';
import {createOrdinarySchemaTransactionGate,recheckReviewedStartupEvidence,type ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import {createOwnedClientLifecycle} from './owned-client-lifecycle';
import {createOwnedWriterParticipant,bindOriginalWriter,assertOriginalWriterBinding,runOriginalWriter,runOriginalWriterCleanup,closeOwnedWriterParticipant,inspectHeldOriginalWriterFailure,type OwnedWriterParticipant,type OriginalWriterBinding} from './original-writer-participation';

declare const scopeBrand:unique symbol,originalBrand:unique symbol,censusBrand:unique symbol;
export type SharedWriterScope={readonly [scopeBrand]:true};
export type SharedOriginalWriter={readonly [originalBrand]:true};
export type SharedCensusLease={readonly [censusBrand]:true};
type Owner={releasedHistoryAudit?:ReleasedHistoryAuditSelector;startup:ReviewedStartup;gate:ReturnType<typeof createOrdinarySchemaTransactionGate>;local:OwnedWriterParticipant;roots:readonly string[];db:string;port:number;role:string;key:readonly [number,number];life:ReturnType<typeof createOwnedClientLifecycle<pg.Client>>;state:'open'|'sealed'|'poisoned'|'closing'|'closed';releaseSha:string;pending:Set<Promise<unknown>>;leases:Set<Lease>;closing?:Promise<void>};
type Bound={owner:Owner;actor:Actor;original:FastifyRequest;principal:Readonly<OriginalMetadataBinding['scope']>;metadata:OriginalMetadataBinding;local:OriginalWriterBinding};
type Lease={owner:Owner;client:pg.Client;mode:'shared'|'exclusive';phase:'open'|'released'|'uncertain';consumed:boolean;censusTx:boolean;failed:boolean;first?:unknown;frame?:Frame;release():Promise<void>};
type Frame={bound:Bound;lease:Lease;active:boolean;failed:boolean;first?:unknown;signal?:AbortSignal;durable?:DurableOriginal187};
const originalHandles=new WeakMap<Owner,WeakMap<object,SharedOriginalWriter>>();
const owners=new WeakMap<object,Owner>(),bindings=new WeakMap<object,Bound>(),census=new WeakMap<object,Lease>();
/** Minted only after real shared lease release and physical owned-client end ACK. */
const confirmedSharedReleases187=new WeakMap<object,{bound:Bound;durable:DurableOriginal187;receipt:object}>();
export function consumeConfirmedSharedOriginalRelease187(handle:SharedOriginalWriter,actor:Actor,original:FastifyRequest,durable:DurableOriginal187){const b=boundOf(handle),f=confirmedSharedReleases187.get(handle);assert(b&&f?.bound===b&&b.actor===actor&&b.original===original&&f.durable===durable,'shared187-genuine-current-epoch-confirmed-release');confirmedSharedReleases187.delete(handle);return f.receipt;}
const active=new AsyncLocalStorage<Frame>();const opaque=()=>Object.freeze(Object.create(null));
function checkAbort(signal?:AbortSignal){if(signal?.aborted)throw Error('shared-writer-original-operation-aborted');}
function ownerOf(scope:SharedWriterScope){const o=owners.get(scope);assert(o?.state==='open','shared-writer-authentic-open-scope');return o;}
function boundOf(value:SharedOriginalWriter){const b=bindings.get(value);assert(b,'shared-writer-authentic-original');assertOriginalWriterBinding(b.local,b.actor,b.original);return b;}
function key(db:string,roots:readonly string[]):readonly [number,number]{const h=createHash('sha256').update(JSON.stringify(['dynaminds-private-large-import-root-barrier/v1',db,...roots])).digest();return [h.readInt32BE(0),h.readInt32BE(4)];}
/** Private normal-construction input only. Existing generation approval is REQUIRED; never activates or accepts a caller Reader. */
export async function createSharedWriterScope(input:{startup:ReviewedStartup;releasedHistoryAudit?:ReleasedHistoryAuditSelector;databaseUrl:string;rawRoot:string;controlPlaneRoot:string;expectedOwner:'postgres';cleanupFailure(e:unknown):void}):Promise<SharedWriterScope>{
 const startup=input.startup,databaseUrl=input.databaseUrl,rawRoot=input.rawRoot,controlPlaneRoot=input.controlPlaneRoot,role=input.expectedOwner,diagnostic=input.cleanupFailure;
 const releasedHistoryAudit=input.releasedHistoryAudit;assert(releasedHistoryAudit===undefined||typeof releasedHistoryAudit==='function','shared187-local-acceptance-audit-selector');
 let url:URL;try{url=new URL(databaseUrl);}catch{throw Error('shared-writer-private-database-config');}
 assert(url.protocol==='postgres:'&&url.username===role&&role==='postgres'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&/^\/[A-Za-z0-9_]+$/.test(url.pathname)&&!url.search&&!url.hash,'shared-writer-private-loopback-database');
 assert(process.env.DATABASE_URL===databaseUrl,'shared-writer-same-installed-database');
 const gate=createOrdinarySchemaTransactionGate(startup); // Genuine ALREADY approved factory handle; fresh producer handle refuses.
 const release=await recheckReviewedStartupEvidence(startup);assert('release_manifest_sha256' in release&&release.complete,'shared-writer-real-emitted-evidence');
 const local=await createOwnedWriterParticipant(startup,rawRoot,controlPlaneRoot),roots=Object.freeze([rawRoot,controlPlaneRoot]),db=url.pathname.slice(1);
 const life=createOwnedClientLifecycle(async()=>{const c=watchDbClient(new pg.Client({connectionString:databaseUrl,statement_timeout:8000,lock_timeout:8000,connectionTimeoutMillis:8000}),'large-import-shared-writer');try{await c.connect();return c;}catch(first){try{await c.end();}catch(e){try{diagnostic(e);}catch{}}throw first;}},diagnostic);
 const o:Owner={...(releasedHistoryAudit===undefined?{}:{releasedHistoryAudit}),startup,gate,local,roots,db,port:Number(url.port||5432),role,key:key(db,roots),life,state:'open',releaseSha:release.release_manifest_sha256,pending:new Set(),leases:new Set()};const h=opaque() as SharedWriterScope;owners.set(h,o);originalHandles.set(o,new WeakMap());return h;
}
/** SAME package fresh producer handle obtains only existing scope participation; no native generation is minted/adopted. */
export async function linkSharedProducerParticipant(scope:SharedWriterScope,startup:ReviewedStartup,rawRoot:string,controlPlaneRoot:string):Promise<OwnedWriterParticipant>{const o=ownerOf(scope);assert.deepEqual([rawRoot,controlPlaneRoot],o.roots,'shared-writer-producer-exact-roots');const release=await recheckReviewedStartupEvidence(startup);assert('release_manifest_sha256' in release&&release.release_manifest_sha256===o.releaseSha,'shared-writer-producer-same-release');assert(o.state==='open','shared-writer-link-during-close');return o.local;}
export function sealSharedWriterScope(scope:SharedWriterScope){const o=ownerOf(scope);assert(o.pending.size===0&&o.leases.size===0,'shared-writer-seal-busy');o.state='sealed';}
export function bindSharedOriginal(scope:SharedWriterScope,actor:Actor,original:FastifyRequest,metadata:OriginalMetadataBinding):SharedOriginalWriter{const owner=ownerOf(scope),local=bindOriginalWriter(owner.local,actor,original,metadata),old=originalHandles.get(owner)!.get(original);if(old){const b=boundOf(old);assert(b.actor===actor&&b.local===local,'shared-writer-original-already-bound-differently');return old;}const h=opaque() as SharedOriginalWriter;bindings.set(h,{owner,actor,original,principal:Object.freeze({...metadata.scope}),metadata,local});originalHandles.get(owner)!.set(original,h);return h;}
export function assertSharedOriginalWriter(handle:SharedOriginalWriter){boundOf(handle);}
async function acquire(o:Owner,mode:'shared'|'exclusive',signal?:AbortSignal):Promise<Lease>{
 checkAbort(signal);
 assert(o.state==='open','shared-writer-scope-closing');let c:pg.Client|undefined,lease:Lease|undefined,tx=false,failed=false,first:unknown,dead=false,deadFirst:unknown,ownedEnding=false;
 const poison=(error:unknown)=>{if(ownedEnding&&(!lease||lease.phase==='released'))return;if(o.state==='open'||o.state==='sealed')o.state='poisoned';if(!dead){dead=true;deadFirst=error;}if(lease){lease.phase='uncertain';if(!lease.failed){lease.failed=true;lease.first=deadFirst;}if(lease.frame&&!lease.frame.failed){const prior=inspectHeldOriginalWriterFailure(lease.frame.bound.local);lease.frame.failed=true;lease.frame.first=prior?.failed?prior.first:deadFirst;}}};
 try{
  c=await o.life.acquire(async client=>{const end=client.end.bind(client);client.end=()=>{ownedEnding=true;return end();};client.on('error',poison);client.on('end',()=>{if(!ownedEnding&&(!lease||lease.phase==='open'))poison(Error('shared-writer-owned-session-ended'));});const row=(await client.query("SELECT current_user role,session_user session_role,current_setting('role',true) role_setting,current_database() db,host(inet_server_addr()) address")).rows[0];assert(row?.role===o.role&&row.session_role===o.role&&row.role_setting==='none'&&row.db===o.db&&['127.0.0.1','::1'].includes(row.address),'shared-writer-real-owner-database');const readOnly=(await client.query('SHOW transaction_read_only')).rows[0];assert.equal(readOnly?.transaction_read_only,'off','shared-writer-idle-owned-session');});
  if(dead)throw deadFirst;checkAbort(signal);const client=c,fn=mode==='shared'?'pg_try_advisory_lock_shared':'pg_try_advisory_lock',row=(await client.query(`SELECT ${fn}($1::integer,$2::integer) held`,[...o.key])).rows[0];assert.equal(row?.held,true,'shared-writer-busy-no-wait-or-takeover');
  let releaseTask:Promise<void>|undefined;lease={owner:o,client,mode,phase:'open',consumed:false,censusTx:false,failed:false,release(){if(releaseTask)return releaseTask;releaseTask=(async()=>{let bad=lease!.failed,cause:unknown=lease!.first;try{assert(lease!.phase==='open','shared-writer-release-lost-session');if(lease!.censusTx){await client.query('ROLLBACK');lease!.censusTx=false;}const fn=mode==='shared'?'pg_advisory_unlock_shared':'pg_advisory_unlock';assert.equal((await client.query(`SELECT ${fn}($1::integer,$2::integer) released`,[...o.key])).rows[0]?.released,true,'shared-writer-exact-session-release');lease!.phase='released';}catch(e){if(!bad){bad=true;cause=e;}lease!.phase='uncertain';if(o.state==='open'||o.state==='sealed')o.state='poisoned';}try{await client.end();}catch(e){if(!bad){bad=true;cause=e;lease!.phase='uncertain';}}finally{o.leases.delete(lease!);}if(bad)throw cause;})();return releaseTask;}};o.leases.add(lease);
  // Schema gate is used ONLY for its actual fresh native generation check. Its schema lock is not the mutable-root lock.
  tx=true;await client.query('BEGIN READ ONLY');await o.gate.enter(client);await client.query('ROLLBACK');tx=false;if(dead)throw deadFirst;checkAbort(signal);assert(o.state==='open','shared-writer-scope-closing');return lease;
 }catch(e){failed=true;first=dead?deadFirst:e;}finally{if(failed){if(tx&&c)try{await c.query('ROLLBACK');}catch{}if(lease)try{await lease.release();}catch{}else if(c)try{await c.end();}catch{}}}
 throw first;
}
function track<T>(o:Owner,task:Promise<T>):Promise<T>{o.pending.add(task);void task.then(()=>o.pending.delete(task),()=>o.pending.delete(task));return task;}
/** Entire logical original command: prep→native/evidence/quota→mandatory cleanup, not one transaction. */
/** Private per-invocation opt-in. The Source keeps its authentic handle/token inside
 * this lifetime; callback receives only protocol result metadata. Never enabled
 * implicitly for every original, and never a FS/business/readiness certificate. */
export type ReleasedHistoryAuditWindow={releasedHistoryAudit:{signal:AbortSignal;requestHashes:readonly string[];onResult(result:Awaited<ReturnType<typeof auditReleasedDurableOriginalHistory187>>):void|Promise<void>}};
/** Explicit trusted local acceptance selection. SAME genuine original only; no Native observed hash list or default per-request audit. */
export type ReleasedHistoryAuditSelector=(original:FastifyRequest)=>ReleasedHistoryAuditWindow|undefined;
export function runSharedOriginal<T>(handle:SharedOriginalWriter,work:()=>Promise<T>,signal?:AbortSignal,options?:ReleasedHistoryAuditWindow):Promise<T>{
 checkAbort(signal);
 let audit:ReleasedHistoryAuditWindow['releasedHistoryAudit']|undefined;
 if(options!==undefined){assert(options&&typeof options==='object'&&!Array.isArray(options)&&Object.keys(options).length===1&&Object.hasOwn(options,'releasedHistoryAudit'),'shared187-explicit-audit-options');const selected=options.releasedHistoryAudit;assert(selected&&Object.keys(selected).sort().join(',')==='onResult,requestHashes,signal'&&selected.signal instanceof AbortSignal&&typeof selected.onResult==='function'&&Array.isArray(selected.requestHashes)&&selected.requestHashes.length>0&&selected.requestHashes.length<=1000000&&selected.requestHashes.every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))&&new Set(selected.requestHashes).size===selected.requestHashes.length,'shared187-authenticated-audit-lineage');audit={signal:selected.signal,requestHashes:Object.freeze([...selected.requestHashes]),onResult:selected.onResult};}
 const b=boundOf(handle),parent=active.getStore();if(parent){assert(options===undefined,'shared187-audit-only-outer-original');assert(parent.active&&parent.bound===b&&parent.lease.phase==='open','shared-writer-stale-or-foreign-context');return runOriginalWriter(b.local,work);}
 // Only outer ordinary invocations consult the Source-owned scope selector.
 // Nested shared calls and exclusive census transfer never invoke/reacquire this audit.
 if(options===undefined&&b.owner.releasedHistoryAudit){const selectedOptions=b.owner.releasedHistoryAudit(b.original);
 if(selectedOptions!==undefined){assert(selectedOptions&&typeof selectedOptions==='object'&&!Array.isArray(selectedOptions)&&Object.keys(selectedOptions).length===1&&Object.hasOwn(selectedOptions,'releasedHistoryAudit'),'shared187-explicit-audit-options');const selected=selectedOptions.releasedHistoryAudit;assert(selected&&Object.keys(selected).sort().join(',')==='onResult,requestHashes,signal'&&selected.signal instanceof AbortSignal&&typeof selected.onResult==='function'&&Array.isArray(selected.requestHashes)&&selected.requestHashes.length>0&&selected.requestHashes.length<=1000000&&selected.requestHashes.every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))&&new Set(selected.requestHashes).size===selected.requestHashes.length,'shared187-authenticated-audit-lineage');audit={signal:selected.signal,requestHashes:Object.freeze([...selected.requestHashes]),onResult:selected.onResult};}
 }
 assert(b.owner.state==='open','shared-writer-scope-closing');confirmedSharedReleases187.delete(handle);return track(b.owner,(async()=>{
 const clients:pg.Client[]=[];let failed=false,first:unknown,value:T|undefined;
 try{for(let i=0;i<3;i++)clients.push(await b.owner.life.acquire(async()=>{}));
 const durable=await bindDurableOriginal187({startup:b.owner.startup,journal:clients[0],parent:clients[1],control:clients[2],database:b.owner.db,databasePort:b.owner.port,rawRoot:b.owner.roots[0],controlPlaneRoot:b.owner.roots[1],releaseSha256:b.owner.releaseSha,actor:b.actor,request:b.original,metadata:b.metadata});
 const lease=await acquire(b.owner,'shared',signal);
 try{value=await heldCommand(b,lease,work,signal,durable);}catch(e){failed=true;first=e;}
 try{await closeReleasedDurableOriginal187(durable,handle);
  // heldCommand has ACKed shared lease unlock/client.end, and close has ACKed
  // CLOSED_complete. All three dedicated clients still belong to this task.
  // The existing auditor reacquires its own exclusive root + schema RRRO scope.
  if(!failed&&audit){const result=await auditReleasedDurableOriginalHistory187(durable,{signal:audit.signal,requestHashes:audit.requestHashes});await audit.onResult(result);}
 }catch(e){b.owner.state='poisoned';if(!failed){failed=true;first=e;}}
 }catch(e){b.owner.state='poisoned';if(!failed){failed=true;first=e;}}
 finally{for(const c of clients.reverse())try{if(audit){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([c.end(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('shared187-audit-owned-client-end-unconfirmed')),5000);})]);}catch(e){try{c.connection?.stream?.destroy();}catch{/* Preserve first end/timeout refusal. */}throw e;}finally{clearTimeout(timer);}}else await c.end();}catch(e){if(audit)b.owner.state='poisoned';if(!failed){failed=true;first=e;}}}
 if(failed)throw first;return value as T;
 })());
}
async function heldCommand<T>(b:Bound,lease:Lease,work:()=>Promise<T>,signal?:AbortSignal,durable?:DurableOriginal187):Promise<T>{let failed=false,first:unknown,value:T|undefined;const oldHandle=originalHandles.get(b.owner)!.get(b.original)!;confirmedSharedReleases187.delete(oldHandle);const frame:Frame={bound:b,lease,active:true,failed:false,signal,durable};lease.frame=frame;try{assert(durable,'shared187-census-transfer-needs-authentic-native-original');value=await active.run(frame,async()=>{let bad=false,cause:unknown,result:T|undefined;try{result=await runOriginalWriter(b.local,async()=>{checkAbort(signal);const out=await (durable?runDurableOriginalWork187(durable,work):work());checkAbort(signal);return out;});}catch(e){bad=true;cause=e;}if(durable)try{await markDurableOriginalDrained187(durable);}catch(e){if(!bad){bad=true;cause=e;}}if(bad)throw cause;return result as T;});}catch(e){if(!frame.failed){frame.failed=true;frame.first=e;}}finally{frame.active=false;try{await lease.release();assert.equal(lease.phase,'released','shared187-release-ACK-required');const handle=originalHandles.get(b.owner)!.get(b.original);assert(handle&&bindings.get(handle)===b,'shared187-bound-handle-release');if(durable)confirmedSharedReleases187.set(handle,{bound:b,durable,receipt:Object.freeze(Object.create(null))});}catch(e){if(!frame.failed){frame.failed=true;frame.first=e;}}lease.frame=undefined;}if(frame.failed)throw frame.first;return value as T;}
export function runSharedCleanup<T>(handle:SharedOriginalWriter,work:()=>Promise<T>):Promise<T>{const b=bindings.get(handle),frame=active.getStore();assert(b&&frame?.active&&frame.bound===b&&frame.lease.phase==='open','shared-writer-cleanup-only-held-original');return runOriginalWriterCleanup(b.local,work);}
/** Actual direct writer entry guard. Neither root name nor an Actor tuple mints a lease. */
export function requireActiveSharedRootWriter(root:string,actor?:object){const f=active.getStore();assert(f?.active&&f.lease.phase==='open'&&f.bound.owner.roots.includes(root),'shared-writer-direct-entry-requires-held-original');checkAbort(f.signal);if(actor)assert.equal(f.bound.actor,actor,'shared-writer-direct-exact-actor');assertOriginalWriterBinding(f.bound.local,f.bound.actor,f.bound.original);}
/** New allocation identity comes only from SAME actual original route and privately captured principal. */
export function requireActiveSharedAllocationKey(root:string,key:{tenantId:string;userId:string;apiKeyId:string|null;catalogId:string;kind:'upload'|'job';publicId:string}){requireActiveSharedRootWriter(root);const f=active.getStore()!,a=f.bound.actor,p=f.bound.original.params as any,q=f.bound.original.query as any,b=f.bound.original.body as any;assert(key.tenantId===a.tenantId&&key.userId===a.userId&&key.apiKeyId===(a.apiKeyId??null),'shared-custody-exact-original-principal');assert(p?.catalog_id===key.catalogId,'shared-custody-exact-original-catalog');assert((key.kind==='upload'?q?.upload_key:b?.job_id)===key.publicId,'shared-custody-exact-original-public-key');}
/** Original captured metadata principal; cleanup keeps only existing held no-growth scope. Native admission remains mandatory. */
export function requireActiveSharedMetadataScope(scope:{tenantId:string;userId:string;apiKeyId:string|null},cleanup=false){const f=active.getStore();assert(f?.active&&f.lease.phase==='open','shared-writer-metadata-effect-held-session');assert.deepEqual(scope,f.bound.principal,'shared-writer-metadata-exact-original-principal');if(!cleanup){checkAbort(f.signal);assertOriginalWriterBinding(f.bound.local,f.bound.actor,f.bound.original);}}
export function requireActiveSharedWriterActor(actor:object){const f=active.getStore();assert(f?.active&&f.lease.phase==='open'&&f.bound.actor===actor,'shared-writer-native-exact-held-actor');checkAbort(f.signal);assertOriginalWriterBinding(f.bound.local,f.bound.actor,f.bound.original);}
export function inspectSharedMetadataIfParticipating(scope:{tenantId:string;userId:string;apiKeyId:string|null},cleanup=false){if(active.getStore())requireActiveSharedMetadataScope(scope,cleanup);}
export function requireSharedMutationFrame(cleanup=false,handle?:SharedOriginalWriter){const f=active.getStore();assert(f?.active&&f.lease.phase==='open','shared-writer-hook-held-session');if(handle)assert(bindings.get(handle)===f.bound,'shared-writer-hook-exact-original-binding');if(!cleanup){checkAbort(f.signal);assertOriginalWriterBinding(f.bound.local,f.bound.actor,f.bound.original);}}
export function requireActiveSharedRootCleanup(root:string){const f=active.getStore();assert(f?.active&&f.lease.phase==='open'&&f.bound.owner.roots.includes(root),'shared-writer-cleanup-requires-existing-held-original');}
export function requireActiveSharedRootCleanupRequest(root:string,original:object){const f=active.getStore();assert(f?.active&&f.lease.phase==='open'&&f.bound.owner.roots.includes(root)&&f.bound.original===original,'shared-writer-cleanup-exact-existing-request');}
export function requireActiveSharedRootRequest(root:string,original:object){const f=active.getStore();assert(f?.active&&f.lease.phase==='open'&&f.bound.owner.roots.includes(root)&&f.bound.original===original,'shared-writer-direct-exact-original-request');checkAbort(f.signal);assertOriginalWriterBinding(f.bound.local,f.bound.actor,f.bound.original);}
export function requireActiveSharedOriginalRequest(original:object){const f=active.getStore();assert(f?.active&&f.lease.phase==='open'&&f.bound.original===original,'shared-writer-direct-exact-original-request');checkAbort(f.signal);assertOriginalWriterBinding(f.bound.local,f.bound.actor,f.bound.original);}
export function requireActiveSharedOriginalWriter(actor:object,original:object){const f=active.getStore();assert(f?.active&&f.lease.phase==='open'&&f.bound.actor===actor&&f.bound.original===original,'shared-writer-exact-original-command');assertOriginalWriterBinding(f.bound.local,f.bound.actor,f.bound.original);}
/** Same actual factory object, before its existing brands/freeze. Tracks direct child lifetimes; not a brand proving arbitrary port authenticity. */
const directFactories=new WeakSet<object>();
export function participateSharedDirectFactory<T extends object>(root:string,port:T,methods:Readonly<Record<string,'growth'|'cleanup'>>):T{
 assert(!directFactories.has(port),'shared-direct-factory-once');
 for(const [name,kind] of Object.entries(methods)){const method=(port as any)[name];assert.equal(typeof method,'function','shared-direct-real-method');Object.defineProperty(port,name,{value:(...args:unknown[])=>{(kind==='cleanup'?requireActiveSharedRootCleanup:requireActiveSharedRootWriter)(root);const f=active.getStore()!;return (kind==='cleanup'?runOriginalWriterCleanup:runOriginalWriter)(f.bound.local,()=>Promise.resolve(Reflect.apply(method,port,args)));},enumerable:true,writable:false,configurable:false});}
 directFactories.add(port);return port;
}
/** Same actual original-bound native service object. Readback/receipt validation remains inside tracked lifetime. */
export function participateSharedOriginalFactory<T extends object>(original:object,port:T,methods:readonly string[]):T{
 assert(!directFactories.has(port),'shared-original-factory-once');for(const name of methods){const method=(port as any)[name];assert.equal(typeof method,'function','shared-original-real-method');Object.defineProperty(port,name,{value:(...args:unknown[])=>{requireActiveSharedOriginalRequest(original);const f=active.getStore()!;return runOriginalWriter(f.bound.local,()=>Promise.resolve(Reflect.apply(method,port,args)));},enumerable:true,writable:false,configurable:false});}directFactories.add(port);return port;
}
/** Exclusion only. Callers still need genuine owner RRRO/full native+FS census and current original IAM; no observer callback can certify it. */
export function reserveSharedCensus(scope:SharedWriterScope):Promise<SharedCensusLease>{const o=ownerOf(scope);assert(!active.getStore(),'shared-census-no-shared-upgrade');return track(o,(async()=>{const lease=await acquire(o,'exclusive');try{lease.censusTx=true;await lease.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await o.gate.enter(lease.client);assert.equal((await lease.client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only,'on','shared-census-real-readonly-snapshot');const h=opaque() as SharedCensusLease;census.set(h,lease);return h;}catch(first){try{await lease.release();}catch{}throw first;}})());}
export async function releaseSharedCensus(handle:SharedCensusLease){const lease=census.get(handle);assert(lease?.phase==='open'&&!lease.consumed,'shared-census-authentic-unconsumed');lease.consumed=true;await lease.release();}
/** Keeps SAME exclusive session through the first mutation; no drop/reacquire gap. No readiness/IAM claim. */
export function transferSharedCensus<T>(leaseHandle:SharedCensusLease,originalHandle:SharedOriginalWriter,work:()=>Promise<T>):Promise<T>{const lease=census.get(leaseHandle),b=boundOf(originalHandle);assert(lease?.phase==='open'&&!lease.consumed&&lease.owner===b.owner&&lease.mode==='exclusive','shared-census-exact-transfer');assert(b.owner.state==='open'&&!active.getStore(),'shared-census-transfer-state');lease.consumed=true;return track(b.owner,(async()=>{try{if(lease.censusTx){await lease.client.query('ROLLBACK');lease.censusTx=false;}assert(lease.phase==='open','shared-census-session-lost-before-first-mutation');}catch(first){try{await lease.release();}catch{}throw first;}return heldCommand(b,lease,work);})());}
export function inspectSharedCensusLease(handle:SharedCensusLease){const l=census.get(handle);assert(l,'shared-census-authentic-lease');return Object.freeze({phase:l.phase,mode:l.mode,readonly_snapshot_open:l.censusTx,consumed:l.consumed,complete_live_census:false,authorizes_commands:false});}
export function closeSharedWriterScope(scope:SharedWriterScope):Promise<void>{const o=owners.get(scope);assert(o,'shared-writer-authentic-scope');if(o.closing)return o.closing;o.state='closing';o.closing=(async()=>{await Promise.allSettled([...o.pending]);let failed=false,first:unknown;for(const lease of [...o.leases])try{await lease.release();}catch(e){if(!failed){failed=true;first=e;}}try{await closeOwnedWriterParticipant(o.local);}catch(e){if(!failed){failed=true;first=e;}}try{await o.life.closeAll();}catch(e){if(!failed){failed=true;first=e;}}o.state='closed';if(failed)throw first;})();return o.closing;}
export function inspectSharedWriterScope(scope:SharedWriterScope){const o=owners.get(scope);assert(o,'shared-writer-authentic-scope');return Object.freeze({state:o.state,active_owned_sessions:o.leases.size,pending:o.pending.size,cooperative_session_barrier:true,installed_native_protocol:false,legacy_nonparticipant_exclusion:false,complete_live_census:false,authorizes_commands:false});}

/** Exact protocol root from authenticated Source construction; no caller root choice. */
export function sharedWriterProtocolRoot(scope:SharedWriterScope){const o=ownerOf(scope);return createHash('sha256').update(JSON.stringify(['dynaminds-private-large-import-root-barrier/v1',o.db,...o.roots])).digest('hex');}
const renewalLeases202=new WeakSet<object>();
/** Lookup ONLY the actual original-issued client holding this renewal's exclusive session root.
 * Ordinary callers cannot adopt a saved Client, frame or serialized receipt. */
export function requireActiveSharedQuotaRenewalClient202(original:FastifyRequest){const f=active.getStore();assert(f?.active&&f.bound.original===original&&f.lease.phase==='open'&&f.lease.mode==='exclusive'&&renewalLeases202.has(f.lease),'renewal202-same-exclusive-worker');checkAbort(f.signal);assertOriginalMetadataClientBinding187(f.lease.client as any,f.bound.metadata.ports,original,f.bound.actor);return f.lease.client;}
async function acquireRenewalWorker202(b:Bound,signal:AbortSignal):Promise<Lease>{
 const o=b.owner;assert(o.state==='open','renewal202-open-owner');let c:pg.Client|undefined,lease:Lease|undefined,held=false,failed=false,first:unknown;
 try{checkAbort(signal);c=await b.metadata.ports.connect(b.metadata.scope) as unknown as pg.Client;assertOriginalMetadataClientBinding187(c as any,b.metadata.ports,b.original,b.actor);
  const row=(await c.query("SELECT current_user role,session_user session_role,current_setting('role',true) role_setting,current_database() db,inet_server_port() port,host(inet_server_addr()) address")).rows[0];assert(row?.role==='dyna_app'&&row.session_role===o.role&&row.role_setting==='dyna_app'&&row.db===o.db&&row.port===o.port&&['127.0.0.1','::1'].includes(row.address),'renewal202-genuine-issued-worker-identity');
  assert.equal((await c.query('SELECT pg_try_advisory_lock($1::integer,$2::integer) held',[...o.key])).rows[0]?.held,true,'renewal202-exclusive-root-no-upgrade-or-takeover');held=true;
  const client=c;let releaseTask:Promise<void>|undefined;
  lease={owner:o,client,mode:'exclusive',phase:'open',consumed:false,censusTx:false,failed:false,release(){if(releaseTask)return releaseTask;return releaseTask=(async()=>{let bad=lease!.failed,cause=lease!.first;
   try{assert(lease!.phase==='open','renewal202-release-known-session');assert.equal((await client.query('SELECT pg_advisory_unlock($1::integer,$2::integer) released',[...o.key])).rows[0]?.released,true,'renewal202-exact-worker-root-unlock');held=false;lease!.phase='released';}catch(e){bad=true;cause??=e;lease!.phase='uncertain';o.state='poisoned';}
   try{await endRenewalClient202(client);}catch(e){bad=true;cause??=e;lease!.phase='uncertain';o.state='poisoned';}finally{o.leases.delete(lease!);}if(bad)throw cause;
  })();}};
  const poison=(e:unknown)=>{if(lease!.phase!=='open')return;o.state='poisoned';lease!.phase='uncertain';lease!.failed=true;lease!.first??=e;if(lease!.frame){lease!.frame.failed=true;lease!.frame.first??=e;}};
  client.on('error',poison);client.on('end',()=>poison(Error('renewal202-worker-ended-before-release')));renewalLeases202.add(lease);o.leases.add(lease);checkAbort(signal);return lease;
 }catch(e){failed=true;first=e;}finally{if(failed){if(lease)try{await lease.release();}catch{}else if(c){if(held)try{await c.query('SELECT pg_advisory_unlock($1::integer,$2::integer)',[...o.key]);}catch{o.state='poisoned';}try{await endRenewalClient202(c);}catch{o.state='poisoned';}}}}throw first;
}
async function endRenewalClient202(c:pg.Client){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([c.end(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('renewal202-client-end-unconfirmed')),5000);})]);}catch(e){try{c.connection?.stream?.destroy();}catch{}throw e;}finally{clearTimeout(timer);}}
/** Only this fixed authenticated POST can request a renewal original. All preparation is
 * completed before entry. The actual metadata worker owns EXCLUSIVE root for its entire
 * transaction: ordinary187_enter SHARE is reentrant on SAME backend, never another client.
 * The existing genuine durable bootstrap, drain, physical end and CLOSED proof are retained. */
export function runSharedQuotaRenewalOriginal<T>(handle:SharedOriginalWriter,work:()=>Promise<T>,signal:AbortSignal):Promise<T>{
 const b=boundOf(handle),body=structuredClone(b.original.body) as Record<string,unknown>;
 assert(!active.getStore()&&b.actor.role==='admin'&&b.actor.apiKeyId==null,'renewal202-normal-admin-outer-original');
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
 const params=()=>{const value=b.original.params as {catalog_id?:unknown;id?:unknown};assert(value&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).length===2&&Object.hasOwn(value,'catalog_id')&&Object.hasOwn(value,'id'),'renewal202-closed-original-params');assert(typeof value.catalog_id==='string'&&uuid.test(value.catalog_id)&&typeof value.id==='string'&&uuid.test(value.id));return{catalog_id:value.catalog_id,id:value.id};},p=params();
 assert(b.original.method==='POST'&&b.original.url===`/api/product-catalogs/${p.catalog_id}/large-import/jobs/${p.id}/quota/renew`,'renewal202-fixed-original-route');
 assert(body&&Object.keys(body).sort().join(',')==='expected_job_expires_at,expected_review_expires_at'&&Object.values(body).every(v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v)),'renewal202-fixed-expiry-CAS');
 checkAbort(signal);assert(b.owner.state==='open','renewal202-open-scope');confirmedSharedReleases187.delete(handle);
 let audit:ReleasedHistoryAuditWindow['releasedHistoryAudit']|undefined;
 // Same trusted Source-original selector runs before any renewal Native work.
 if(b.owner.releasedHistoryAudit){const selectedOptions=b.owner.releasedHistoryAudit(b.original);
 if(selectedOptions!==undefined){assert(selectedOptions&&typeof selectedOptions==='object'&&!Array.isArray(selectedOptions)&&Object.keys(selectedOptions).length===1&&Object.hasOwn(selectedOptions,'releasedHistoryAudit'),'shared187-explicit-audit-options');const selected=selectedOptions.releasedHistoryAudit;assert(selected&&Object.keys(selected).sort().join(',')==='onResult,requestHashes,signal'&&selected.signal instanceof AbortSignal&&typeof selected.onResult==='function'&&Array.isArray(selected.requestHashes)&&selected.requestHashes.length>0&&selected.requestHashes.length<=1000000&&selected.requestHashes.every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))&&new Set(selected.requestHashes).size===selected.requestHashes.length,'shared187-authenticated-audit-lineage');audit={signal:selected.signal,requestHashes:Object.freeze([...selected.requestHashes]),onResult:selected.onResult};}
 }

 return track(b.owner,(async()=>{const clients:pg.Client[]=[];let failed=false,first:unknown,value:T|undefined;
  try{for(let i=0;i<3;i++)clients.push(await b.owner.life.acquire(async()=>{}));
   const durable=await bindDurableOriginal187({startup:b.owner.startup,journal:clients[0],parent:clients[1],control:clients[2],database:b.owner.db,databasePort:b.owner.port,rawRoot:b.owner.roots[0],controlPlaneRoot:b.owner.roots[1],releaseSha256:b.owner.releaseSha,actor:b.actor,request:b.original,metadata:b.metadata});
   const lease=await acquireRenewalWorker202(b,signal);
   try{value=await heldCommand(b,lease,async()=>{assert.deepEqual(params(),p);assert.deepEqual(b.original.body,body);const out=await work();assert.deepEqual(params(),p);assert.deepEqual(b.original.body,body);return out;},signal,durable);}catch(e){failed=true;first=e;}
   try{await closeReleasedDurableOriginal187(durable,handle);if(!failed&&audit){const result=await auditReleasedDurableOriginalHistory187(durable,{signal:audit.signal,requestHashes:audit.requestHashes});await audit.onResult(result);}}catch(e){b.owner.state='poisoned';if(!failed){failed=true;first=e;}}
  }catch(e){b.owner.state='poisoned';if(!failed){failed=true;first=e;}}
  finally{for(const c of clients.reverse())try{await endRenewalClient202(c);}catch(e){b.owner.state='poisoned';if(!failed){failed=true;first=e;}}}
  if(failed)throw first;return value as T;
 })());
}

/** Fixed read-only legacy admission on the genuine still-owned census session, before Native187 entry. */
export async function admitSharedCensusLegacyOriginal(handle:SharedCensusLease,scope:SharedWriterScope,startup:ReviewedStartup,legacy:LegacyQuarantine,original:FastifyRequest){const lease=census.get(handle),o=ownerOf(scope);assert(lease&&lease.owner===o&&o.startup===startup&&lease.phase==='open'&&lease.mode==='exclusive'&&lease.censusTx===true&&!lease.consumed&&!active.getStore()&&o.state==='open','legacy-genuine-unconsumed-census-session');const readonlyClient={query:(sql:string,args?:unknown[])=>{assert(sql.startsWith('SELECT '),'legacy-census-SELECT-only');return lease.client.query(sql,args);},end:async()=>{throw Error('legacy-census-does-not-own-client');}};await admitLegacyOriginalSnapshot(legacy,startup,original,readonlyClient,{raw:o.roots[0],controlPlane:o.roots[1]});assert(lease.phase==='open'&&!lease.consumed&&lease.censusTx===true,'legacy-census-session-changed');}
