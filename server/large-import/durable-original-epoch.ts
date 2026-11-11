import {auditCompleteProtocolHistory} from './complete-history';
import {requireExecutedTerminalReceipt187} from '../../shared/large-import-dependencies/pim-large-import-quota-terminal-reconcile-backend2/keeper';
/** Native187 source bridge under derivation. Not wired into factory; no public admission authority.
 * Structural pg ports here are trusted private construction inputs, not proof of unforgeable Client provenance. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {requireActiveSharedRootRequest,requireActiveSharedRootWriter,consumeConfirmedSharedOriginalRelease187,type SharedOriginalWriter} from './shared-session-writer';
import {requirePreparedEpochOrigin187,requirePreparedEpochDrain187,requirePreparedEpochTerminalOrigin187,type Prepared} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/publisher';
import type {Client,PoolClient} from 'pg';
import {hasOrderSplitTransactionDuty,finalizeOrderSplitTransactionInTx} from '../order-split-transaction';
import {drainPublicConstraintsInTx} from '../public-constraint-drain';
import {fa3DraftOwnerInTx} from '../fa3-draft-access';
import type {FastifyRequest} from 'fastify';
import type {Actor} from '../domain';
import {requireOriginalMetadataBinding,type OriginalMetadataBinding} from './original-metadata';
import {requireOriginalTenantPoolClient187,requireOriginalTenantPoolLease187} from '../db';
import {admitOriginalEpochJournal,assertOriginalMetadataClientBinding187} from '../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
import {createOrdinarySchemaTransactionGate,type ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';

declare const originalBrand:unique symbol;
export type DurableOriginal187={readonly [originalBrand]:true};
type Gate=ReturnType<typeof createOrdinarySchemaTransactionGate>;
type Facts={root:string;rawRoot:string;database:string;port:number;epoch:string;originalId:string;epochToken:string;originalToken:string;actor:Actor;request:FastifyRequest;metadata:OriginalMetadataBinding;gate:Gate;journal:Client;parent:Client;control:Client;tail:Promise<unknown>;state:'open'|'poisoned'|'unknown'|'finished';pending:Set<Promise<unknown>>};
const facts=new WeakMap<object,Facts>(),busy=new WeakSet<object>(),tainted=new WeakSet<object>();
const token=()=>randomBytes(32).toString('hex');
const workerFrames=new AsyncLocalStorage<Facts>();
const acknowledgedDurableWorkerRollbacks187=new WeakMap<object,object>();
export function hasAcknowledgedDurableWorkerRollback187(error:unknown,c:object){return !!error&&typeof error==='object'&&acknowledgedDurableWorkerRollbacks187.get(error)===c;}
export function isDurableWorkerClientTainted187(c:object){return tainted.has(c);}
type OriginalWork187={handle:DurableOriginal187;owner:Facts;active:boolean;tasks:Set<Promise<unknown>>;failed:boolean;first?:unknown};
const originalKeeperClients187=new WeakMap<object,OriginalWork187>();
const originalWork187=new AsyncLocalStorage<OriginalWork187>(),appBridgeBusy187=new WeakSet<object>(),workedOriginals187=new WeakSet<object>(),participatingClients187=new WeakMap<object,OriginalWork187>();
type IOFacts={owner:Facts;prepared:Prepared;id:string;token:string;preparedSha:string;state:'arming'|'armed'|'draining'|'drained'|'unknown'};
const ioFacts=new WeakMap<object,IOFacts>(),ownedIO=new WeakMap<object,Set<Prepared>>();
function original(h:DurableOriginal187){const x=facts.get(h);assert(x,'epoch187-authentic-original');return x;}
function current(x:Facts){requireOriginalMetadataBinding(x.metadata,x.actor,x.request);assert(x.state==='open','epoch187-original-not-open');}
async function identity(c:Client,database:string,port:number){const r=(await c.query("SELECT current_user role,session_user session_role,current_setting('role',true) role_setting,current_database() db,inet_server_port() port,host(inet_server_addr()) address,pg_backend_pid() pid,to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows;assert(r.length===1&&r[0].role==='postgres'&&r[0].session_role==='postgres'&&r[0].role_setting==='none'&&r[0].db===database&&r[0].port===port&&['127.0.0.1','::1'].includes(r[0].address)&&typeof r[0].backend_start==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(r[0].backend_start),'epoch187-real-owner-none');return r[0];}
/** The caller has preallocated THREE genuine dedicated clients before any worker/resource locks.
 * Native exact187 validation is a required future cold anchor; absence refuses before epoch creation. */
export async function bindDurableOriginal187(input:{startup:ReviewedStartup;journal:Client;parent:Client;control:Client;database:string;databasePort:number;rawRoot:string;controlPlaneRoot:string;releaseSha256:string;actor:Actor;request:FastifyRequest;metadata:OriginalMetadataBinding}):Promise<DurableOriginal187>{
 requireOriginalMetadataBinding(input.metadata,input.actor,input.request);assert(Number.isSafeInteger(input.databasePort)&&input.databasePort>0&&input.databasePort<=65535&&/^[A-Za-z0-9_]+$/.test(input.database)&&input.rawRoot===resolve(input.rawRoot)&&input.controlPlaneRoot===resolve(input.controlPlaneRoot)&&input.rawRoot!==input.controlPlaneRoot&&/^[a-f0-9]{64}$/.test(input.releaseSha256),'epoch187-exact-private-construction');assert(input.journal!==input.parent&&input.control!==input.parent&&input.control!==input.journal&&!busy.has(input.journal)&&!busy.has(input.parent)&&!busy.has(input.control),'epoch187-distinct-preallocated-clients');
 const gate=createOrdinarySchemaTransactionGate(input.startup),root=createHash('sha256').update(JSON.stringify(['dynaminds-private-large-import-root-barrier/v1',input.database,input.rawRoot,input.controlPlaneRoot])).digest('hex'),keyBuffer=Buffer.from(root,'hex'),epochToken=token(),originalToken=token(),originalId=randomUUID();
 const x:Facts={root,rawRoot:input.rawRoot,database:input.database,port:input.databasePort,epoch:'',originalId,epochToken,originalToken,actor:input.actor,request:input.request,metadata:input.metadata,gate,journal:input.journal,parent:input.parent,control:input.control,tail:Promise.resolve(),state:'open',pending:new Set()};
 const parent=await identity(input.parent,input.database,input.databasePort);await identity(input.journal,input.database,input.databasePort);await identity(input.control,input.database,input.databasePort);
 await journal(x,'bootstrap',async c=>{assert.equal((await c.query('SELECT public.ordinary187_private_valid() valid')).rows[0]?.valid,true,'epoch187-full-cold-anchor-required');const opened=(await c.query('SELECT public.ordinary187_owner_open($1,$2,$3,$4,$5,$6,$7) value',[root,[keyBuffer.readInt32BE(0),keyBuffer.readInt32BE(4)],input.actor.tenantId,input.actor.userId,input.actor.apiKeyId??null,epochToken,input.releaseSha256])).rows[0]?.value;assert(opened?.root_key===root&&/^[1-9][0-9]*$/.test(opened?.epoch),'epoch187-native-open-receipt');x.epoch=opened.epoch;
  // Same existing root/gate and metadata admission checks, now before one atomic COMMIT.
  current(x);await admitOriginalEpochJournal(c,x.metadata.ports,x.request,x.actor);
  current(x);await c.query('SELECT public.ordinary187_owner_pin($1,$2,$3)',[x.root,x.epoch,x.epochToken]);await admitOriginalEpochJournal(c,x.metadata.ports,x.request,x.actor);
  await c.query('SELECT public.ordinary187_owner_original($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[root,x.epoch,epochToken,originalId,input.actor.tenantId,input.actor.userId,input.actor.apiKeyId??null,createHash('sha256').update(JSON.stringify({method:input.request.method,url:input.request.url,tenant:input.actor.tenantId,actor:input.actor.userId,api:input.actor.apiKeyId??null})).digest('hex'),originalToken,parent.pid,parent.backend_start]);
 });
 const h=Object.freeze(Object.create(null)) as DurableOriginal187;facts.set(h,x);return h;
}
/** Serial original journal TXs. This is called only before worker resource locks or after their real TX ends. */
function journal<T>(x:Facts,mode:'growth'|'terminal'|'bootstrap'|'close',work:(c:Client)=>Promise<T>):Promise<T>{
 const task=x.tail.then(async()=>{assert(!busy.has(x.journal)&&!tainted.has(x.journal),'epoch187-journal-client-in-use-or-unknown');busy.add(x.journal);let lease:Awaited<ReturnType<Gate['reserve']>>|undefined,began=false,rootHeld=false,commitAttempted=false,committed=false,failed=false,first:unknown,value:T|undefined;
 try{lease=await x.gate.reserve(x.journal);if(mode==='bootstrap'||mode==='close'){const b=Buffer.from(x.root,'hex');assert.equal((await x.journal.query('SELECT pg_try_advisory_lock($1::integer,$2::integer) held',[b.readInt32BE(0),b.readInt32BE(4)])).rows[0]?.held,true,'epoch187-bootstrap-root-exclusive-before-IAM');rootHeld=true;}began=true;await x.journal.query('BEGIN');await lease.enter();if(mode==='growth'||mode==='bootstrap'){current(x);if(mode==='growth')await x.journal.query('SELECT public.ordinary187_owner_pin($1,$2,$3)',[x.root,x.epoch,x.epochToken]);await admitOriginalEpochJournal(x.journal,x.metadata.ports,x.request,x.actor);}value=await work(x.journal);if(mode==='growth'||mode==='bootstrap'){current(x);await admitOriginalEpochJournal(x.journal,x.metadata.ports,x.request,x.actor);}commitAttempted=true;await x.journal.query('COMMIT');committed=true;began=false;}catch(e){failed=true;first=e;}finally{if(began)try{await x.journal.query('ROLLBACK');began=false;}catch(e){x.state='unknown';tainted.add(x.journal);if(!failed){failed=true;first=e;}}if(commitAttempted&&!committed){x.state='unknown';tainted.add(x.journal);}if(rootHeld)try{const b=Buffer.from(x.root,'hex');assert.equal((await x.journal.query('SELECT pg_advisory_unlock($1::integer,$2::integer) released',[b.readInt32BE(0),b.readInt32BE(4)])).rows[0]?.released,true,'epoch187-exact-bootstrap-root-release');}catch(e){x.state='unknown';if(!failed){failed=true;first=e;}}if(lease)try{await lease.close();}catch(e){x.state='unknown';tainted.add(x.journal);if(!failed){failed=true;first=e;}}busy.delete(x.journal);}if(failed)throw first;return value as T;});
 x.tail=task.then(()=>undefined,()=>undefined);return task;
}
/** Early entry precedes all caller work (including SAVEPOINT/IAM/catalog/quota); final seal precedes real COMMIT.
 * ACK_LOST never becomes a completed command, even if a later owner query can see its transaction. */
export function runDurableWorker187<T>(h:DurableOriginal187,c:Client,mode:'growth'|'terminal',work:()=>Promise<T>):Promise<T>{
 const x=original(h);assert(!busy.has(c)&&!tainted.has(c)&&c!==x.journal&&c!==x.parent&&c!==x.control,'epoch187-distinct-idle-worker');if(mode==='growth')current(x);assert(mode==='growth'||mode==='terminal','epoch187-exact-worker-mode');busy.add(c);
 const task=(async()=>{let lease:Awaited<ReturnType<Gate['reserve']>>|undefined,began=false,entered=false,commitAttempted=false,committed=false,failed=false,first:unknown,value:T|undefined,ack:'COMMIT_ACK'|'ROLLBACK_ACK'|'ACK_LOST'='ACK_LOST';const member=randomUUID(),memberToken=token();
 try{const worker=await identity(c,x.database,x.port);lease=await x.gate.reserve(c);await journal(x,mode,async j=>{await j.query('SELECT public.ordinary187_owner_member($1,$2,$3,$4,$5,$6,$7,$8,$9)',[x.root,x.epoch,x.originalId,x.originalToken,member,memberToken,worker.pid,worker.backend_start,mode]);});await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');began=true;await lease.enter();const receipt=(await c.query('SELECT public.ordinary187_enter($1,$2,$3,$4,$5,$6,$7) value',[x.root,x.epoch,x.originalId,x.originalToken,member,memberToken,mode])).rows[0]?.value;assert(receipt?.backend_pid===worker.pid&&/^[1-9][0-9]*$/.test(receipt?.xid),'epoch187-native-enter-receipt');entered=true;
 // No resource locks/work yet: independent journal cannot wait behind this worker's quota locks.
 await journal(x,'terminal',j=>j.query('SELECT public.ordinary187_owner_member_xid($1,$2,$3,$4,$5)',[x.root,x.epoch,member,memberToken,receipt.xid]));
 if(mode==='growth')current(x);value=await workerFrames.run(x,work);await c.query('SELECT public.ordinary187_seal($1,$2,$3)',[x.root,x.epoch,member]);
 // Only tenantTx's real pool participant can have this fixed split duty. Its
 // ledger survives the inner callback's cleanup until this actual outer tail.
 const splitClient=c as PoolClient;
 if(hasOrderSplitTransactionDuty(splitClient)){
  await fa3DraftOwnerInTx(splitClient,async()=>{
   await drainPublicConstraintsInTx(splitClient);
   // The ordinary public drain deliberately excludes this private187 marker.
   await c.query('SET CONSTRAINTS ordinary187_private.ordinary187_context_final IMMEDIATE');
  });
  await finalizeOrderSplitTransactionInTx(splitClient);
 }
 commitAttempted=true;await c.query('COMMIT');committed=true;began=false;ack='COMMIT_ACK';
 }catch(e){failed=true;first=e;}finally{
 if(began&&!committed)try{await c.query('ROLLBACK');began=false;ack=commitAttempted?'ACK_LOST':'ROLLBACK_ACK';}catch(e){ack='ACK_LOST';if(!failed){failed=true;first=e;}}
 // Worker has ended its TX before any finish journal quota locks. Lost ACK stays unresolved.
 if(entered&&!began)try{await journal(x,'terminal',j=>j.query('SELECT public.ordinary187_owner_member_finish($1,$2,$3,$4,$5)',[x.root,x.epoch,member,memberToken,ack]));}catch(e){x.state='unknown';if(!failed){failed=true;first=e;}}
 else{x.state='unknown';tainted.add(c);}if(lease)try{await lease.close();}catch(e){x.state='unknown';tainted.add(c);if(!failed){failed=true;first=e;}}busy.delete(c);if(ack==='ACK_LOST'){x.state='unknown';tainted.add(c);}if(failed&&first&&typeof first==='object'){acknowledgedDurableWorkerRollbacks187.delete(first);if(ack==='ROLLBACK_ACK'&&!commitAttempted)acknowledgedDurableWorkerRollbacks187.set(first,c);}}
 if(failed)throw first;return value as T;})();x.pending.add(task);void task.then(()=>x.pending.delete(task),()=>x.pending.delete(task));return task;
}
/** Logical poison ACK serializes after active native growth transactions. It is not instantaneous physical death cancellation. */
export async function poisonDurableOriginal187(h:DurableOriginal187){
 const x=original(h),c=x.control;assert(!busy.has(c),'epoch187-distinct-poison-controller');x.state='poisoned';busy.add(c);let lease:Awaited<ReturnType<Gate['reserve']>>|undefined,began=false,failed=false,first:unknown,value:unknown;
 // Never join x.tail: entered workers may still need their independent xid journal before any business work.
 try{await identity(c,x.database,x.port);lease=await x.gate.reserve(c);await c.query('BEGIN');began=true;await lease.enter();value=await c.query('SELECT public.ordinary187_owner_poison($1,$2,$3)',[x.root,x.epoch,x.epochToken]);await c.query('COMMIT');began=false;}catch(e){failed=true;first=e;}finally{if(began)try{await c.query('ROLLBACK');}catch(e){if(!failed){failed=true;first=e;}}if(lease)try{await lease.close();}catch(e){if(!failed){failed=true;first=e;}}busy.delete(c);}if(failed){x.state='unknown';throw first;}return value;
}
export function inspectDurableOriginal187(h:DurableOriginal187){const x=original(h);return Object.freeze({state:x.state,pending:x.pending.size,installed_in_factory:false,full_FS_census:false,commands_available:false,public_ready:false});}

/** Genuine publisher-issued Prepared only. No raw resource/proof/boolean constructor.
 * Called by the publisher after independently committed intents and before its first fsTx. */
export async function armPreparedIO187(h:DurableOriginal187,p:Prepared):Promise<void>{
 const x=original(h);current(x);assert(!workerFrames.getStore(),'epoch187-IO-arm-before-worker-resource-TX');assert(!ioFacts.has(p),'epoch187-Prepared-IO-once');
 const a=requirePreparedEpochOrigin187(p);assert(a.root===x.rawRoot&&a.actor===x.actor&&a.original===x.request,'epoch187-Prepared-exact-original');assert(a.scope.tenantId===x.actor.tenantId&&a.scope.actorId===x.actor.userId&&a.scope.apiKeyId===(x.actor.apiKeyId??null),'epoch187-Prepared-exact-principal');
 const plan={schema:'original-prepared-IO187/v1',root_key:x.root,epoch:x.epoch,original_id:x.originalId,reservation_id:a.reservationId,request_id:a.requestId,request_kind:a.requestKind,resources:a.resources};
 const sha=createHash('sha256').update(JSON.stringify(plan)).digest('hex'),f:IOFacts={owner:x,prepared:p,id:randomUUID(),token:token(),preparedSha:sha,state:'arming'};ioFacts.set(p,f);let held=ownedIO.get(h);if(!held){held=new Set();ownedIO.set(h,held);}held.add(p);
 try{await journal(x,'growth',async c=>{const r=(await c.query('SELECT public.ordinary187_owner_io_arm($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) value',[x.root,x.epoch,x.originalId,x.originalToken,f.id,f.token,a.reservationId,JSON.stringify(a.resources),sha])).rows[0]?.value;assert(r?.io_id===f.id&&r.state==='ARMED'&&r.prepared_sha256===sha,'epoch187-IO-exact-ARM-receipt');});f.state='armed';}catch(e){f.state='unknown';x.state='unknown';throw e;}
}
/** Called only after the authentic publisher has ended FS/SQL transactions and released its lock.
 * Failed/unknown native ACK is never converted into completed IO by readback. */
export async function drainPreparedIO187(p:Prepared):Promise<void>{
 const f=ioFacts.get(p);assert(f,'epoch187-authentic-armed-Prepared');const x=f.owner;assert(!workerFrames.getStore(),'epoch187-IO-drain-after-worker-TX');assert(f.state==='armed','epoch187-IO-no-retry');requireOriginalMetadataBinding(x.metadata,x.actor,x.request);
 f.state='draining';try{const d=await requirePreparedEpochDrain187(p);assert(d.root===x.rawRoot&&d.actor===x.actor&&d.original===x.request,'epoch187-drain-exact-original');
 const sha=createHash('sha256').update(JSON.stringify({schema:'original-prepared-IO-drain187/v1',prepared_sha256:f.preparedSha,cut:d.cut})).digest('hex');
 await journal(x,'terminal',async c=>{const r=(await c.query('SELECT public.ordinary187_owner_io_drain($1,$2,$3,$4,$5,$6) value',[x.root,x.epoch,f.id,f.token,f.preparedSha,sha])).rows[0]?.value;assert(r?.io_id===f.id&&r.state==='DRAINED','epoch187-IO-exact-DRAIN-receipt');});f.state='drained';}catch(e){f.state='unknown';x.state='unknown';throw e;}
}
/** Source-owned original cut attempts only its captured Prepared handles. It never cancels in-flight IO.
 * Native resources/FS must already satisfy exact terminal drain; unresolved/quarantine paths refuse. */
export async function drainDurablePreparedIO187(h:DurableOriginal187):Promise<void>{const x=original(h);assert(!workerFrames.getStore()&&x.pending.size===0,'epoch187-all-worker-TXs-ended-before-IO-cut');for(const p of ownedIO.get(h)??[]){const f=ioFacts.get(p)!;if(f.state==='drained')continue;assert(f.state==='armed','epoch187-original-unresolved-IO');await drainPreparedIO187(p);}}

type IssuedMetadataClient187={query(sql:string,values?:unknown[]):Promise<{rows:any[]}>;end():Promise<void>};
/** Actual ReadyForQuery I is checked before ANY role reset, BEGIN or journal/member admission.
 * This reuses the established ordinary gate protocol, within the already-issued private connection boundary. */
async function requireIdleIssuedClient187(c:IssuedMetadataClient187):Promise<void>{
 const connection=(c as unknown as {connection?:{on(name:string,f:(m:{status:string})=>void):void;removeListener(name:string,f:(m:{status:string})=>void):void}}).connection;
 assert(connection&&typeof connection.on==='function'&&typeof connection.removeListener==='function','epoch187-issued-client-real-protocol');let status:string|undefined,failed=false,first:unknown;const ready=(m:{status:string})=>{status=m.status};connection.on('readyForQuery',ready);
 try{const r=(await c.query('SHOW transaction_read_only')).rows;assert(status==='I'&&r.length===1&&r[0]?.transaction_read_only==='off','epoch187-issued-client-idle-before-role-reset');}catch(e){failed=true;first=e;}finally{try{connection.removeListener('readyForQuery',ready);}catch(e){if(!failed){failed=true;first=e;}}}if(failed)throw first;
}

/** Private original body adapter. Requires SAME genuine shared-frame request and actor; no caller config hook.
 * No native epoch is minted here. The future normal factory must supply the already-authentic original handle. */
export async function runDurableOriginalWork187<T>(h:DurableOriginal187,work:()=>Promise<T>):Promise<T>{
 const x=original(h);current(x);requireActiveSharedRootRequest(x.rawRoot,x.request);requireActiveSharedRootWriter(x.rawRoot,x.actor);const parent=originalWork187.getStore();if(parent){assert(parent.active&&parent.handle===h,'epoch187-no-foreign-or-escaped-original-frame');return work();}assert(!workedOriginals187.has(h),'epoch187-original-work-once');workedOriginals187.add(h);
 const frame:OriginalWork187={handle:h,owner:x,active:true,tasks:new Set(),failed:false};let failed=false,first:unknown,value:T|undefined;
 try{value=await originalWork187.run(frame,work);}catch(e){failed=true;first=e;}finally{frame.active=false;while(frame.tasks.size)await Promise.allSettled([...frame.tasks]);if(!failed&&frame.failed){failed=true;first=frame.first;}}
 if(failed)throw first;return value as T;
}
/** Normal factory keeper connection ONLY: first real original metadata issuance/admission, then
 * authenticated owner-mode transition before existing07/09 keeper preflight. No raw owner adoption. */
export async function prepareOriginalKeeperOwner187(c:IssuedMetadataClient187):Promise<void>{
 const f=originalWork187.getStore();assert(f?.active,'epoch187-keeper-current-original-required');const x=f.owner;
 current(x);requireActiveSharedRootRequest(x.rawRoot,x.request);requireActiveSharedRootWriter(x.rawRoot,x.actor);
 assertOriginalMetadataClientBinding187(c,x.metadata.ports,x.request,x.actor);assert(!originalKeeperClients187.has(c)&&!busy.has(c)&&!tainted.has(c),'epoch187-keeper-fresh-issued-client');
 await requireIdleIssuedClient187(c);const r=(await c.query("SELECT current_user role,session_user session_role,current_setting('role',true) role_setting,current_setting('app.tenant_id',true) tenant")).rows[0];
 assert(r?.role==='dyna_app'&&r.session_role==='postgres'&&r.role_setting==='dyna_app'&&r.tenant===x.actor.tenantId,'epoch187-keeper-issued-app-role');
 try{await c.query('SET SESSION ROLE NONE');}catch(e){x.state='unknown';tainted.add(c);throw e;}
 originalKeeperClients187.set(c,f);
}
/** Actual metadata/quota BEGIN hook. Undefined means no private187 original is participating;
 * an active187 frame always refuses unissued/foreign/stale clients before role reset, never falls back. */
export function runBoundDurableMetadataTransaction187<T>(c:IssuedMetadataClient187,work:()=>Promise<T>,cleanupFailure:(e:unknown)=>void=()=>{}):Promise<T>|undefined{
 const frame=originalWork187.getStore();if(!frame){assert(!participatingClients187.has(c),'epoch187-bound-client-outside-original-frame');return undefined;}const x=frame.owner;
 assert(frame.active,'epoch187-original-frame-ended');current(x);requireActiveSharedRootRequest(x.rawRoot,x.request);requireActiveSharedRootWriter(x.rawRoot,x.actor);
 assertOriginalMetadataClientBinding187(c,x.metadata.ports,x.request,x.actor);assert(!appBridgeBusy187.has(c)&&!busy.has(c)&&!tainted.has(c),'epoch187-app-client-not-idle-or-known');appBridgeBusy187.add(c);participatingClients187.set(c,frame);
 const ownerKeeper=originalKeeperClients187.get(c);assert(!ownerKeeper||ownerKeeper===frame,'epoch187-keeper-same-original-frame');
 const task=(async()=>{let failed=false,first:unknown,value:T|undefined,reset=false,roleResetAttempted=false;
 try{await requireIdleIssuedClient187(c);const role=(await c.query("SELECT current_user role,session_user session_role,current_setting('role',true) role_setting,current_setting('app.tenant_id',true) tenant")).rows[0];assert(role?.role===(ownerKeeper?'postgres':'dyna_app')&&role.session_role==='postgres'&&role.role_setting===(ownerKeeper?'none':'dyna_app')&&role.tenant===x.actor.tenantId,'epoch187-issued-app-role-tenant');if(!ownerKeeper){roleResetAttempted=true;await c.query('SET SESSION ROLE NONE');reset=true;}
  value=await runDurableWorker187(frame.handle,c as unknown as Client,ownerKeeper?'terminal':'growth',async()=>{assert(frame.active,'epoch187-no-growth-after-original-body');current(x);requireActiveSharedRootRequest(x.rawRoot,x.request);requireActiveSharedRootWriter(x.rawRoot,x.actor);if(ownerKeeper)await admitOriginalEpochJournal(c as unknown as Client,x.metadata.ports,x.request,x.actor);else{await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[x.actor.tenantId]);}const out=await work();assert(frame.active,'epoch187-no-commit-after-original-body');current(x);requireActiveSharedRootRequest(x.rawRoot,x.request);requireActiveSharedRootWriter(x.rawRoot,x.actor);if(ownerKeeper)await admitOriginalEpochJournal(c as unknown as Client,x.metadata.ports,x.request,x.actor);return out;});
 }catch(e){failed=true;first=e;}finally{
  if(roleResetAttempted&&!reset){x.state='unknown';tainted.add(c);}
  // Unknown worker transport/rollback is never reused even for a role-restoration query.
  if(reset&&!tainted.has(c))try{await c.query('SET SESSION ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,false)",[x.actor.tenantId]);}catch(e){x.state='unknown';tainted.add(c);try{cleanupFailure(e);}catch{}if(!failed){failed=true;first=e;}}
  appBridgeBusy187.delete(c);
 }if(failed)throw first;return value as T;})();frame.tasks.add(task);x.pending.add(task);void task.then(()=>{frame.tasks.delete(task);x.pending.delete(task)},e=>{frame.tasks.delete(task);x.pending.delete(task);if(!frame.failed){frame.failed=true;frame.first=e}});return task;
}

const poolParticipantLeases187=new WeakMap<object,OriginalWork187>();
/** Normal Core/PIM pool path. Lookup-only DB source ledger plus genuine current
 * original/shared frame; no caller configuration or boolean admission. */
export function runBoundDurableTenantTransaction187<T>(c:Client,tenantId:string,work:()=>Promise<T>):Promise<T>|undefined{
 const frame=originalWork187.getStore(),lease=requireOriginalTenantPoolLease187(c,tenantId);if(!frame){assert(!poolParticipantLeases187.has(lease),'epoch187-pool-lease-outside-original-frame');return undefined;}
 const x=frame.owner;assert(frame.active,'epoch187-pool-original-frame-ended');current(x);requireActiveSharedRootRequest(x.rawRoot,x.request);requireActiveSharedRootWriter(x.rawRoot,x.actor);
 const issued=requireOriginalTenantPoolClient187(c,tenantId);assert(issued.lease===lease,'epoch187-pool-same-current-borrow');assert(issued.gate,'epoch187-original-pool-genuine-Startup');assert(tenantId===x.actor.tenantId&&issued.database===x.database&&issued.port===x.port,'epoch187-pool-exact-original-database-tenant');
 assert(!poolParticipantLeases187.has(issued.lease)&&!appBridgeBusy187.has(c)&&!busy.has(c)&&!tainted.has(c),'epoch187-pool-lease-not-idle-or-known');appBridgeBusy187.add(c);poolParticipantLeases187.set(issued.lease,frame);
 const task=(async()=>{let failed=false,first:unknown,value:T|undefined;
  try{await requireIdleIssuedClient187(c);value=await runDurableWorker187(frame.handle,c,'growth',async()=>{
   assert(frame.active,'epoch187-pool-no-growth-after-original-body');current(x);requireActiveSharedRootRequest(x.rawRoot,x.request);requireActiveSharedRootWriter(x.rawRoot,x.actor);const result=await work();
   assert(frame.active,'epoch187-pool-no-commit-after-original-body');current(x);requireActiveSharedRootRequest(x.rawRoot,x.request);requireActiveSharedRootWriter(x.rawRoot,x.actor);return result;
  });}catch(e){failed=true;first=e;}finally{appBridgeBusy187.delete(c);}if(failed)throw first;return value as T;
 })();frame.tasks.add(task);x.pending.add(task);void task.then(()=>{frame.tasks.delete(task);x.pending.delete(task)},e=>{frame.tasks.delete(task);x.pending.delete(task);if(!frame.failed){frame.failed=true;frame.first=e}});return task;
}

/** Current source-owned original only; no configuration callback or reconstructed handle. */
export function currentDurablePreparedOriginal187(root:string,actor:object,request:object):DurableOriginal187|undefined{
 const f=originalWork187.getStore();if(!f)return undefined;
 assert(f.active&&f.owner.rawRoot===root&&f.owner.actor===actor&&f.owner.request===request,'epoch187-current-Prepared-original');
 requireActiveSharedRootRequest(root,request);requireActiveSharedRootWriter(root,actor);current(f.owner);return f.handle;
}
/** Strict drain while the same shared cleanup frame remains alive. Unsupported terminal IO refuses. */
export async function markDurableOriginalDrained187(h:DurableOriginal187):Promise<void>{
 const x=original(h);requireActiveSharedRootRequest(x.rawRoot,x.request);assert(x.state==='open'&&x.pending.size===0,'epoch187-drain-ended-workers');
 await drainDurablePreparedIO187(h);
 await journal(x,'terminal',async c=>{const r=(await c.query('SELECT public.ordinary187_owner_original_drained($1,$2,$3,$4) value',[x.root,x.epoch,x.originalId,x.originalToken])).rows[0]?.value;
 assert(r?.original_id===x.originalId&&r.state==='DRAINED'&&r.protocol_only===true&&r.business_ACK_proved===false&&r.full_FS_census===false,'epoch187-original-DRAINED-receipt');});
 drainedOriginals187.add(h);
}
const drainedOriginals187=new WeakSet<object>();
/** After actual session unlock AND owned client.end ACK, consume the exact command/epoch receipt once.
 * Native CLOSED authenticates protocol history, never business ACK or complete filesystem census. */
export async function closeReleasedDurableOriginal187(h:DurableOriginal187,shared:SharedOriginalWriter):Promise<void>{
 const x=original(h);consumeConfirmedSharedOriginalRelease187(shared,x.actor,x.request,h);
 await poisonDurableOriginal187(h);
 assert(drainedOriginals187.has(h)&&x.pending.size===0,'epoch187-close-requires-original-drain');
 try{await journal(x,'close',async c=>{const r=(await c.query('SELECT public.ordinary187_owner_closed_complete($1,$2,$3) value',[x.root,x.epoch,x.epochToken])).rows[0]?.value;
 assert(r?.root_key===x.root&&r.epoch===x.epoch&&r.state==='CLOSED'&&r.protocol_only===true&&r.business_ACK_proved===false&&r.full_FS_census===false&&r.public_ready===false,'epoch187-protocol-CLOSED-receipt');
 // Native authenticates its complete pre-close protocol cut; this is not an independent Source whole-history audit.
 assert(typeof r.complete_before_rows==='string'&&/^[1-9][0-9]*$/.test(r.complete_before_rows)&&r.complete_before_rows.length<=20
  &&typeof r.complete_before_payload_bytes==='string'&&/^[1-9][0-9]*$/.test(r.complete_before_payload_bytes)&&r.complete_before_payload_bytes.length<=20
  &&typeof r.complete_before_chain_sha256==='string'&&/^[a-f0-9]{64}$/.test(r.complete_before_chain_sha256),'epoch187-native-complete-before-cut-receipt');});x.state='finished';}catch(e){x.state='unknown';throw e;}
}

const originalTerminalReceipts187=new WeakMap<object,Map<string,ReturnType<typeof requireExecutedTerminalReceipt187>>>();
/** Lookup-only native effect argument; arbitrary facts/results cannot register. Default legacy path is unchanged. */
export function recordExecutedTerminalReceipt187(value:object):void{
 const frame=originalWork187.getStore();if(!frame)return;assert(frame.active,'epoch187-terminal-current-original');const x=frame.owner,f=requireExecutedTerminalReceipt187(value);
 current(x);requireActiveSharedRootRequest(x.rawRoot,x.request);assert(f.root===x.rawRoot&&f.original===x.request&&f.scope.tenantId===x.actor.tenantId&&f.scope.actorId===x.actor.userId&&f.scope.apiKeyId===(x.actor.apiKeyId??null)&&f.request.kind==='upload','epoch187-terminal-exact-original');
 let rows=originalTerminalReceipts187.get(x);if(!rows){rows=new Map();originalTerminalReceipts187.set(x,rows);}const key=f.request.reservationId+'\0'+f.resource_key;assert(!rows.has(key),'epoch187-terminal-native-effect-once');rows.set(key,f);
}
/** Same armed Prepared, original owner/frame, exact native07 proof only. No raw receipt constructor. */
export function requirePreparedTerminalReceipt187(p:Prepared,key:string){
 const held=ioFacts.get(p);assert(held&&held.state==='draining','epoch187-terminal-same-draining-Prepared');const x=held.owner;
 requireActiveSharedRootRequest(x.rawRoot,x.request);const plan=requirePreparedEpochTerminalOrigin187(p),f=originalTerminalReceipts187.get(x)?.get(plan.reservationId+'\0'+key);assert(f&&f.original===x.request&&f.request.requestId===plan.requestId,'epoch187-terminal-same-reservation-request');
 const receipt=JSON.parse(f.receipt_text),witness=JSON.parse(f.witness_text),r=plan.resources.find(r=>r.key===key),old=f.original_resource as any;assert(r&&r.kind==='blob'&&old.tenant_id===x.actor.tenantId&&old.reservation_id===plan.reservationId&&old.resource_key===key&&old.kind===r.kind&&Number.isSafeInteger(old.byte_count)&&old.byte_count===r.byte_count&&old.sha256===r.sha256,'epoch187-terminal-original-resource');
 assert(createHash('sha256').update(f.receipt_text).digest('hex')===f.receipt_sha256&&receipt.schema==='quota-terminal-receipt/v1'&&receipt.tenant_id===x.actor.tenantId&&receipt.reservation_id===plan.reservationId&&receipt.resource_key===key&&receipt.client_key===f.client_key&&receipt.original_sha256===r.sha256&&Number.isSafeInteger(receipt.original_bytes)&&receipt.original_bytes===r.byte_count&&receipt.old_state===old.state&&receipt.witness_sha256===createHash('sha256').update(f.witness_text).digest('hex'),'epoch187-terminal-native-receipt-binding');
 assert(witness.schema==='private-quota-terminal-witness/v1'&&witness.reservation_id===plan.reservationId&&witness.request_id===plan.requestId&&witness.resource_key===key&&witness.original_sha256===r.sha256&&Number.isSafeInteger(witness.byte_count)&&witness.byte_count===r.byte_count&&witness.classification===receipt.classification&&Array.isArray(witness.fs_cut),'epoch187-terminal-source-witness-binding');
 assert.deepEqual(witness.scope,plan.scope,'epoch187-terminal-full-scope');
 const classification=key.endsWith(':quarantine-json')?'unused-quarantine':key.includes(':lock:')?'released-lock':null;assert(classification&&receipt.classification===classification&&witness.classification===classification&&(classification==='unused-quarantine'?old.state==='intent':['intent','settled'].includes(old.state)),'epoch187-terminal-unused-or-owned-lock-only');
 return {receipt_text:f.receipt_text,receipt_sha256:f.receipt_sha256,witness_text:f.witness_text};
}

/** Explicit private read, never called automatically for every HTTP original.
 * Requires an authentic finished in-process handle; no saved hash/JSON can
 * recover or fabricate its epoch token. Caller retains its owned client lifetime.
 * Caller supplies authenticated request lineage; full FS/context/business proof
 * is still owned by the separate installed census and existing inspectors.
 */
export async function auditReleasedDurableOriginalHistory187(h:DurableOriginal187,input:{signal:AbortSignal;requestHashes:readonly string[];maxRows?:number;maxPayloadBytes?:number}){
 const x=original(h);requireOriginalMetadataBinding(x.metadata,x.actor,x.request);assert(x.state==='finished'&&x.pending.size===0,'epoch187-audit-requires-finished-original');
 const options={signal:input.signal,requestHashes:[...input.requestHashes],maxRows:input.maxRows??1000000,maxPayloadBytes:input.maxPayloadBytes??256*1024*1024};
 const signal=AbortSignal.any([options.signal,AbortSignal.timeout(120000)]);
 const task=x.tail.then(async()=>{
  const c=x.journal;assert(!busy.has(c)&&!tainted.has(c),'epoch187-audit-owner-busy-or-unknown');busy.add(c);
  let lease:Awaited<ReturnType<Gate['reserve']>>|undefined,began=false,rootHeld=false,failed=false,first:unknown,result:Awaited<ReturnType<typeof auditCompleteProtocolHistory>>|undefined;
  const b=Buffer.from(x.root,'hex'),keys=[b.readInt32BE(0),b.readInt32BE(4)];
  const rawQuery=(text:string,values:unknown[]=[])=>{const command={text,values,query_timeout:8000};return c.query(command);};
  const query=(text:string,values:unknown[]=[])=>{signal.throwIfAborted();return rawQuery(text,values);};
  const cut=async()=>{const r=(await query("SELECT count(*)::text rows,coalesce(sum(octet_length(payload_text)),0)::text bytes,max(epoch)::text max_epoch,(SELECT count(*)::text FROM ordinary187_private.contexts WHERE root_key=$1) contexts FROM ordinary187_private.journal WHERE root_key=$1",[x.root])).rows[0];assert(r&&/^[1-9][0-9]*$/.test(r.rows)&&/^(0|[1-9][0-9]*)$/.test(r.bytes)&&r.max_epoch===x.epoch&&r.contexts==='0','epoch187-audit-entire-current-root');return r;};
  try{
   requireOriginalMetadataBinding(x.metadata,x.actor,x.request);await requireIdleIssuedClient187(c);await identity(c,x.database,x.port);lease=await x.gate.reserve(c);
   assert.equal((await query('SELECT pg_try_advisory_lock($1::integer,$2::integer) held',keys)).rows[0]?.held,true,'epoch187-audit-exclusive-root');rootHeld=true;
   await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;await lease.enter();
   const before=await cut();
   result=await auditCompleteProtocolHistory({query:async(text,values)=>query(text,values)},{root:x.root,epoch:x.epoch,token:x.epochToken,tenantId:x.actor.tenantId,userId:x.actor.userId,requestHashes:options.requestHashes,signal,maxRows:options.maxRows,maxPayloadBytes:options.maxPayloadBytes});
   requireOriginalMetadataBinding(x.metadata,x.actor,x.request);assert(result.rows===before.rows&&result.payload_bytes===before.bytes,'epoch187-audit-no-prefix-sampling');assert.deepEqual(await cut(),before,'epoch187-audit-current-root-drift');
   await rawQuery('ROLLBACK');began=false;
  }catch(e){failed=true;first=e;}
  finally{
   if(began)try{await rawQuery('ROLLBACK');began=false;}catch(e){tainted.add(c);x.state='unknown';if(!failed){failed=true;first=e;}}
   if(rootHeld)try{assert.equal((await rawQuery('SELECT pg_advisory_unlock($1::integer,$2::integer) released',keys)).rows[0]?.released,true,'epoch187-audit-exact-root-release');}catch(e){tainted.add(c);x.state='unknown';if(!failed){failed=true;first=e;}}
   if(lease)try{await lease.close();}catch(e){tainted.add(c);x.state='unknown';if(!failed){failed=true;first=e;}}
   busy.delete(c);
  }
  if(failed)throw first;assert(result);return result;
 });
 x.tail=task.catch(()=>{});return task;
}
