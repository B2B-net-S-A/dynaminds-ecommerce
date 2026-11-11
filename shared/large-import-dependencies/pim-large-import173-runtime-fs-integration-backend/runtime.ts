/** Concrete source-only hook composition. No startup side effects or optimistic runtime factory. */
import assert from 'node:assert/strict';
import {createDedicatedMetadataTransport,type Ports as TransportPorts} from '../pim-large-import173-composed-runtime-backend/transport';
import {createPostgresJobStore,createPostgresBlobMetadata,type RawStorage} from './storage';
import {assertBoundRawPort,type BoundRawPort} from './raw-port';
import type {RawStorage as HistoricalRawStorage} from '../pim-large-import173-composed-runtime-backend/storage';
import type {MutationHooks} from './hooks';
import {createLargeImportCoordinator} from '../pim-large-import-job-coordinator-backend5/coordinator';
import type {Ports4} from '../pim-large-import-job-coordinator-backend5/core-review';
import type {Actor} from '../../../server/domain';
import {inspectReadiness,type WriteHookRegistry} from '../pim-large-import-write-hook-registry-backend/registry';
type Request=Parameters<ReturnType<typeof createDedicatedMetadataTransport>['capture']>[0];
export type HookFactory=(actor:Actor,originalRequest:Request)=>{mutations:MutationHooks;raw:BoundRawPort};
/** Root-owned factory requires genuine broker + original request bridge. Registration/native wiring proof remains separate. */
export function createHookedLargeImportRuntime(transportPorts:TransportPorts,forActor:HookFactory){
 const transport=createDedicatedMetadataTransport(transportPorts),originals=new WeakMap<Actor,Request>(),createHooks=forActor;
 return {capture(request:Request){const actor=transport.capture(request);originals.set(actor,request);return actor;},
  bind(actor:Actor,raw:HistoricalRawStorage,business:Omit<Ports4<Actor>,'jobs'|'blob'>){
   const original=originals.get(actor);assert(original,'hook-runtime-original-request');const {scope,ports}=transport.bind(actor),owned=createHooks(actor,original);
   assert(owned?.mutations&&owned.raw===raw,'hook-runtime-required-owned-hooks');
   assertBoundRawPort(raw,actor);const storagePorts={...ports,mutations:owned.mutations},rawPort=raw;
   const store=createPostgresJobStore(storagePorts,scope),blobs=createPostgresBlobMetadata(storagePorts,scope,rawPort);
   const authority=async(a:Actor)=>{assert.equal(a,actor,'hook-runtime-original-actor');const principal=await business.authority(a);assert.deepEqual(principal,scope,'hook-runtime-current-principal');return principal;};
   return {scope,coordinator:createLargeImportCoordinator({...business,authority,jobs:store,blob:blobs}),blobs};
  },
 };
}
/** Source-owned application factory. Cannot be obtained from this candidate without real registered native wiring evidence. */
export async function createRegisteredRuntimeFactory(registry:WriteHookRegistry,forActor:HookFactory){
 const expectedRegistry=registry,createHooks=forActor;
 if(!await inspectReadiness(expectedRegistry))return false;
 return (transport:TransportPorts,handle:WriteHookRegistry)=>{assert.equal(handle,expectedRegistry,'hook-runtime-registry-identity');return createHookedLargeImportRuntime(transport,createHooks);};
}
