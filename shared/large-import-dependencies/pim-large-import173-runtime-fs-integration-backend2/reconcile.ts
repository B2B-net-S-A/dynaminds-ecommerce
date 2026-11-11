/** Source-owned exact keeper recovery. No zero-byte fake settlement or repeated filesystem publisher. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createTerminalQuotaKeeper,type PortsKeeper} from '../pim-large-import-quota-terminal-reconcile-backend2/keeper';
import type {Actor} from '../../../server/domain';
import type {OwnedRequest} from '../pim-large-import-upload-quota-broker-backend3/broker';
import type {NativeQuota} from './publisher';
export type ReadyUploadReconciler=Readonly<{kind:'private-ready-upload-reconciler/v1'}>;
type Bound=ReturnType<ReturnType<typeof createTerminalQuotaKeeper>['bind']>;
const bindings=new WeakMap<object,{actor:Actor;request:OwnedRequest;quota:NativeQuota;keeper:Bound}>();
/** UUIDv8 private deterministic idempotency key; not a product/Actor ID or a credential. Stable original allocation identity. */
export function terminalClientKey(reservationId:string,key:string){const bytes=createHash('sha256').update('large-import-terminal/v1\0'+reservationId+'\0'+key).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const hex=bytes.toString('hex');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');}
export function createReadyUploadReconcilerFactory(ports:PortsKeeper){const keeper=createTerminalQuotaKeeper(ports);return{
 bind(actor:Actor,original:Parameters<typeof keeper.capture>[0],input:OwnedRequest,quota:NativeQuota):ReadyUploadReconciler{
  const captured=keeper.capture(original);assert.deepEqual({u:actor.userId,t:actor.tenantId,k:actor.apiKeyId??null,r:actor.role},{u:captured.userId,t:captured.tenantId,k:captured.apiKeyId??null,r:captured.role},'reconcile-same-original-principal');const request=structuredClone(input),handle=Object.freeze({kind:'private-ready-upload-reconciler/v1' as const});bindings.set(handle,{actor,request,quota,keeper:keeper.bind(captured,request)});return handle;
 },
};}
export async function reconcileReadyUpload(handle:ReadyUploadReconciler,actor:object){const b=bindings.get(handle);assert(b&&b.actor===actor,'reconcile-private-original');let failed=false,first:unknown;try{
 const snapshot:any=structuredClone(await b.quota.snapshot());assert(snapshot.reservation.id===b.request.reservationId&&snapshot.reservation.request_id===b.request.requestId&&Array.isArray(snapshot.resources),'reconcile-actual-resource-inventory');
 const keys=new Set<string>();for(const r of snapshot.resources){assert(typeof r.resource_key==='string'&&!keys.has(r.resource_key),'reconcile-duplicate-resource');keys.add(r.resource_key);}
 const candidates=snapshot.resources.filter((r:any)=>/^blob:fs:(blobs|uploads|witnesses):[^:]+:lock:[^:]+$/.test(r.resource_key)||/^blob:fs:blobs:[^:]+:quarantine-json$/.test(r.resource_key)).sort((a:any,b:any)=>a.resource_key<b.resource_key?-1:a.resource_key>b.resource_key?1:0);
 // Exact native keeper independently verifies complete original FS/PG custody and charges its immutable TEXT receipts.
 for(const r of candidates)await b.keeper.releaseExact(r.resource_key,terminalClientKey(b.request.reservationId,r.resource_key));
 return await b.keeper.closeKnown(terminalClientKey(b.request.reservationId,'upload-known-close'));
 }catch(e){failed=true;first=e;try{await b.quota.unknown();}catch{}}if(failed)throw first;throw Error('reconcile-unreachable');}
