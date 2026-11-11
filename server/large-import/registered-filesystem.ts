/** Concrete publisher2/keeper2 construction from ONE original authenticated request. No default pool or filesystem provisioning. */
import assert from 'node:assert/strict';
import type {Actor} from '../domain';
import {inspectCompositeStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import type {ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/api';
import {createDedicatedMetadataTransport,assertOriginalMetadataBinding,type BoundMetadataPorts,type Ports as TransportPorts} from '../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
import {createPublicationAuthorityFactory} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/authority';
import {createQuotaRawStore} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/store';
import {createBoundUploadBytes,type BoundRawPort} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/raw-port';
import {createDurableUploadRegistry,type RegistryPorts} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/registry';
import {createPrivateWitnessStore} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/witness';
import {createReadyUploadReconcilerFactory,type ReadyUploadReconciler} from '../../shared/large-import-dependencies/pim-large-import173-upload-once-replay-backend/reconcile';
import {createRegisteredUploadService,type ReplayUploadPorts} from '../../shared/large-import-dependencies/pim-large-import173-upload-once-replay-backend/upload-service';
import {snapshotSpec,type Ports as UploadPorts} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/upload';
import type {NativeQuota} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/publisher';
import type {OwnedRequest} from '../../shared/large-import-dependencies/pim-large-import-upload-quota-broker-backend3/broker';
import type {PortsKeeper} from '../../shared/large-import-dependencies/pim-large-import-quota-terminal-reconcile-backend2/keeper';
import type {Spec} from '../../shared/large-import-dependencies/pim-large-import-stream-foundation-ui2/stream';
type Original=Parameters<ReturnType<typeof createDedicatedMetadataTransport>['capture']>[0];
export type RegisteredFilesystem=Readonly<{kind:'registered-full-publisher-filesystem/v2'}>;
type RegisteredUpload=ReturnType<typeof createRegisteredUploadService<Actor>>;
const uploadBindings=new WeakMap<object,{handle:RegisteredFilesystem;actor:Actor;original:Original;uploads:RegisteredUpload['uploads']&{inspectQuarantinedOriginal(blobId:string):Promise<void>};reconciler:ReadyUploadReconciler;catalogId:string;requestId:string}>();
export function inspectRegisteredUpload(upload:RegisteredUpload['upload'],uploads:Pick<RegisteredUpload['uploads'],'once'|'inspect'|'owned'>,handle:RegisteredFilesystem,actor:Actor,original:Original){const f=uploadBindings.get(upload);assert(f&&f.uploads===uploads&&f.handle===handle&&f.actor===actor&&f.original===original,'registered-authentic-upload-service');return{catalogId:f.catalogId,requestId:f.requestId};}
/** Exact original retained-read verification; no once/reserve/publisher/settlement dispatch. */
export async function inspectRegisteredRetainedUploadOriginal(upload:RegisteredUpload['upload'],uploads:Pick<RegisteredUpload['uploads'],'once'|'inspect'|'owned'>,handle:RegisteredFilesystem,actor:Actor,original:Original){
 inspectRegisteredUpload(upload,uploads,handle,actor,original);const f=uploadBindings.get(upload)!;
 return await f.uploads.inspectRetained(f.requestId,f.catalogId);
}
/** Exact attributed quarantine readback under the same source-owned upload invocation. No publication/retry. */
export async function inspectRegisteredQuarantinedUploadOriginal(upload:RegisteredUpload['upload'],uploads:Pick<RegisteredUpload['uploads'],'once'|'inspect'|'owned'>,handle:RegisteredFilesystem,actor:Actor,original:Original,blobId:string){
 inspectRegisteredUpload(upload,uploads,handle,actor,original);const f=uploadBindings.get(upload)!;
 return await f.uploads.inspectQuarantinedOriginal(blobId);
}
const bindings=new WeakMap<object,{actor:Actor;original:Original;startup:ReviewedStartup;raw:BoundRawPort}>();
export function assertRegisteredFilesystem(handle:RegisteredFilesystem,actor:Actor,original:Original,startup:ReviewedStartup,raw:BoundRawPort){const fact=bindings.get(handle);assert(fact&&fact.actor===actor&&fact.original===original&&fact.startup===startup&&fact.raw===raw,'registered-full-publisher-custody');}
export type FilesystemPorts={
 root:string;startup:ReviewedStartup;transport:Omit<TransportPorts,'preflightOwner173'>;
 keeper:Pick<PortsKeeper,'preflightOwner'|'connectOwner'>;
 validateCatalog(a:Actor,catalogId:string):Promise<void>;
 readReady:RegistryPorts<Actor>['readReady'];
};
export function createRegisteredFilesystemFactory(input:FilesystemPorts){
 const root=input.root,startup=input.startup,transportInput={...input.transport},keeperInput={...input.keeper},validateCatalog=input.validateCatalog,readReady=input.readReady;
 const transport:TransportPorts={...transportInput,preflightOwner173:async c=>{await inspectCompositeStartup(c,startup);return 'VALID';}},metadata=createDedicatedMetadataTransport(transport),publication=createPublicationAuthorityFactory(transport),reconciliation=createReadyUploadReconcilerFactory({root,transport,...keeperInput,cleanupFailure:transport.cleanupFailure});
 return {bind(actor:Actor,original:Original,inputRequest:OwnedRequest,native:NativeQuota,catalogId:string,maxBytes:number,providedMetadata?:BoundMetadataPorts){
  // Capture and detach synchronously. No reconstructed Actor crosses a private transport WeakMap.
  const request=structuredClone(inputRequest);assert(request.kind==='upload'||((request.kind==='job'||request.kind==='review')&&request.ceiling.raw===0),'registered-filesystem-allocation-kind');const principal={tenantId:actor.tenantId,userId:actor.userId,apiKeyId:actor.apiKeyId??null};
  let ports:BoundMetadataPorts;
  if(providedMetadata){assertOriginalMetadataBinding(providedMetadata,original,actor);ports=providedMetadata;}
  else{const captured=metadata.capture(original);assert.deepEqual({tenantId:captured.tenantId,userId:captured.userId,apiKeyId:captured.apiKeyId??null,role:captured.role},{...principal,role:actor.role},'registered-filesystem-original-principal');ports=metadata.bind(captured).ports;assertOriginalMetadataBinding(ports,original,captured);}
  const quota={...native},scope={tenantId:principal.tenantId,actorId:principal.userId,apiKeyId:principal.apiKeyId},authority=publication.bind(actor,original,request,ports),reconciler=request.kind==='upload'?reconciliation.bind(actor,original,request,quota):undefined;
  const authorize=async(a:Actor)=>{assert.equal(a,actor,'registered-filesystem-original-actor');const x=structuredClone(await quota.snapshot());assert(x.reservation.id===request.reservationId&&x.reservation.tenant_id===principal.tenantId&&x.reservation.actor_id===principal.userId&&x.reservation.api_key_id===principal.apiKeyId,'registered-filesystem-native-reservation');return{reservationId:request.reservationId,scope:{...scope},quota};};
  const common={root,publication:authority,authorize,cleanupFailure:transport.cleanupFailure},store=createQuotaRawStore({...common,validateCatalog}),bytes=createBoundUploadBytes(store,actor,catalogId,maxBytes),registry=createDurableUploadRegistry({...common,validateCatalog,readReady}),witness=createPrivateWitnessStore(common),handle=Object.freeze({kind:'registered-full-publisher-filesystem/v2' as const});
  bindings.set(handle,{actor,original,startup,raw:bytes.raw});
  return Object.freeze({handle,raw:bytes.raw,bytes:bytes.bytes,store,registry,witness,get reconciler(){assert(request.kind==='upload'&&reconciler,'registered-upload-reconciler-only');return reconciler;},
   createUpload(ports:Omit<ReplayUploadPorts<Actor>,'bytes'>,spec:Spec){assert(request.kind==='upload'&&reconciler,'registered-upload-service-only');const planned=snapshotSpec(spec);assert(planned.limits!.maxFileBytes===maxBytes,'registered-upload-same-file-ceiling');const service=createRegisteredUploadService(actor,catalogId,{...ports,bytes:bytes.bytes},registry,planned,reconciler,request.requestId);const uploads=Object.assign(service.uploads,{async inspectQuarantinedOriginal(blobId:string){
    const reader=await bytes.raw.prepareSealedRead(`large-import-raw-file/v1:${principal.tenantId}:${blobId}`);let error:unknown;
    try{await reader.inspect();}catch(e){error=e;}
    assert((error as Error)?.name==='AssertionError'&&(error as Error).message==='raw-quarantined','installed-quarantine-original-read-not-denied');
   }});uploadBindings.set(service.upload,{handle,actor,original,uploads,reconciler,catalogId,requestId:request.requestId});return {...service,uploads};},
  });
 }};
}
