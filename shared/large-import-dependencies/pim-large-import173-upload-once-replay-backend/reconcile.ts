import {currentDurablePreparedOriginal187,drainDurablePreparedIO187} from '../../../server/large-import/durable-original-epoch';
import {participateSharedOriginalFactory} from '../../../server/large-import/shared-session-writer';
/** Source-owned exact keeper recovery. No zero-byte fake settlement or repeated filesystem publisher. */
import assert from 'node:assert/strict';import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {createTerminalQuotaKeeper,inspectTerminalFiles,type PortsKeeper} from '../pim-large-import-quota-terminal-reconcile-backend2/keeper';
import type {Actor} from '../../../server/domain';
import type {OwnedRequest} from '../pim-large-import-upload-quota-broker-backend3/broker';
import type {NativeQuota} from '../pim-large-import173-runtime-fs-integration-backend2/publisher';
export type ReadyUploadReconciler=Readonly<{kind:'private-ready-upload-reconciler/v1'}>;
type Bound=ReturnType<ReturnType<typeof createTerminalQuotaKeeper>['bind']>;
const bindings=new WeakMap<object,{actor:Actor;request:OwnedRequest;quota:NativeQuota;keeper:Bound;root:string;original:object}>();
/** UUIDv8 private deterministic idempotency key; not a product/Actor ID or a credential. Stable original allocation identity. */
export function terminalClientKey(reservationId:string,key:string){const bytes=createHash('sha256').update('large-import-terminal/v1\0'+reservationId+'\0'+key).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const hex=bytes.toString('hex');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');}
export function createReadyUploadReconcilerFactory(ports:PortsKeeper){const keeper=createTerminalQuotaKeeper(ports);return{
 bind(actor:Actor,original:Parameters<typeof keeper.capture>[0],input:OwnedRequest,quota:NativeQuota):ReadyUploadReconciler{
  const captured=keeper.capture(original);assert.deepEqual({u:actor.userId,t:actor.tenantId,k:actor.apiKeyId??null,r:actor.role},{u:captured.userId,t:captured.tenantId,k:captured.apiKeyId??null,r:captured.role},'reconcile-same-original-principal');const request=structuredClone(input),handle=Object.freeze({kind:'private-ready-upload-reconciler/v1' as const});bindings.set(handle,{actor,request,quota,keeper:participateSharedOriginalFactory(original,keeper.bind(captured,request),['releaseExact','readClosed','closeKnown']),root:ports.root,original});return handle;
 },
};}
export async function reconcileReadyUpload(handle:ReadyUploadReconciler,actor:object){const b=bindings.get(handle);assert(b&&b.actor===actor,'reconcile-private-original');let failed=false,first:unknown;try{
 const snapshot:any=structuredClone(await b.quota.snapshot());assert(snapshot.reservation.id===b.request.reservationId&&snapshot.reservation.request_id===b.request.requestId&&Array.isArray(snapshot.resources),'reconcile-actual-resource-inventory');
 const keys=new Set<string>();for(const r of snapshot.resources){assert(typeof r.resource_key==='string'&&!keys.has(r.resource_key),'reconcile-duplicate-resource');keys.add(r.resource_key);}
 const candidates=snapshot.resources.filter((r:any)=>/^blob:fs:(blobs|uploads|witnesses):[^:]+:lock:[^:]+$/.test(r.resource_key)||/^blob:fs:blobs:[^:]+:quarantine-json$/.test(r.resource_key)).sort((a:any,b:any)=>a.resource_key<b.resource_key?-1:a.resource_key>b.resource_key?1:0);
 // Exact native keeper independently verifies complete original FS/PG custody and charges its immutable TEXT receipts.
 for(const r of candidates)await b.keeper.releaseExact(r.resource_key,terminalClientKey(b.request.reservationId,r.resource_key));
 // Genuine07 receipts and owner end ACKs precede same-original Prepared drain, outside every worker transaction.
 const original=currentDurablePreparedOriginal187(b.root,b.actor,b.original);assert(original,'reconcile-current-authentic-original-drain');
 await drainDurablePreparedIO187(original);
 return await b.keeper.closeKnown(terminalClientKey(b.request.reservationId,'upload-known-close'));
 }catch(e){failed=true;first=e;try{await b.quota.unknown();}catch{}}if(failed)throw first;throw Error('reconcile-unreachable');}

/** No allocation, finish, release, publisher or producer on retained POST recovery. */
const recoveryObservations=new AsyncLocalStorage<{actor:Actor;request_id:string;reservation_id:string;blob_id:string;receipt:unknown}[]>();
export async function observeNativeUploadRecovery<T>(work:()=>Promise<T>){const results:{actor:Actor;request_id:string;reservation_id:string;blob_id:string;receipt:unknown}[]=[];let value:T|undefined,failed=false,error:unknown;try{value=await recoveryObservations.run(results,work);}catch(e){failed=true;error=e;}return{value,failed,error,results:[...results]};}
export async function verifyRetainedUploadReplay(handle:ReadyUploadReconciler,actor:object,ready:import('../pim-large-import173-runtime-fs-integration-backend2/upload').ReadyUpload){
 const b=bindings.get(handle);assert(b&&b.actor===actor,'replay-private-original');const value=structuredClone(ready),before:any=structuredClone(await b.quota.snapshot()),q=before.reservation;
 assert(q&&q.id===b.request.reservationId&&q.request_id===b.request.requestId&&q.tenant_id===b.actor.tenantId&&q.actor_id===b.actor.userId&&q.api_key_id===(b.actor.apiKeyId??null)&&q.kind===b.request.kind&&q.state==='retained'&&q.outcome==='ready'&&String(q.raw_ceiling)===String(b.request.ceiling.raw)&&String(q.metadata_ceiling)===String(b.request.ceiling.metadata)&&String(q.objects_ceiling)===String(b.request.ceiling.objects),'replay-exact-retained-reservation');
 const receipt=await b.keeper.readClosed(terminalClientKey(b.request.reservationId,'upload-known-close'));
 assert(typeof q.inventory_sha256==='string'&&receipt.receipt.inventory_sha256===q.inventory_sha256,'replay-original-inventory-receipt-binding');
 const fs=await inspectTerminalFiles(b.root,{tenantId:b.actor.tenantId,actorId:b.actor.userId,apiKeyId:b.actor.apiKeyId??null},b.request.requestId,`blob:fs:blobs:${value.blob_id}:quarantine-json`,'unused-quarantine');
 assert(fs.blob_id===value.blob_id&&fs.raw_sha256===value.raw.sha256&&fs.raw_bytes===value.raw.byte_count&&fs.ready_spec_text===JSON.stringify(value.spec)&&fs.ready_manifest_text===JSON.stringify(value.manifest),'replay-native-ready-physical-seal-binding');
 const after=structuredClone(await b.quota.snapshot());assert.deepEqual(after,before,'replay-quota-full-zero');recoveryObservations.getStore()?.push({actor:b.actor,request_id:b.request.requestId,reservation_id:b.request.reservationId,blob_id:value.blob_id,receipt:structuredClone(receipt.receipt)});return structuredClone(receipt.receipt);
}
