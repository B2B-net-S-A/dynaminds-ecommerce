/** Type-only boundary. No default pool, registry, file store, credentials or installed availability. */
import assert from 'node:assert/strict';
import {assertOriginalMetadataBinding,type createDedicatedMetadataTransport} from '../pim-large-import173-composed-runtime-backend/transport';
import type {FastifyRequest} from 'fastify';
import type {Actor} from '../../../server/domain';
import type {createLargeImportCoordinator,Principal,Job,Ref} from '../pim-large-import-job-coordinator-backend5/coordinator';
import type {CoreConfig} from '../pim-large-import-job-coordinator-backend5/native-batches';
import type {CoreReview} from '../pim-large-import-job-coordinator-backend5/core-review';
import type {createAuthenticatedLargeImportUpload,ReadyUpload} from '../pim-large-import-authenticated-upload-ui/upload';
import type {createComposedLargeImportRuntime} from '../pim-large-import173-composed-runtime-backend/runtime';
import type {Ports4} from '../pim-large-import-job-coordinator-backend5/core-review';
import type {RawStorage} from '../pim-large-import173-composed-runtime-backend/storage';
import type {Command,ResolutionAck} from '../pim-large-import-complete-file-review-ui2/model';
export type Coordinator=ReturnType<typeof createLargeImportCoordinator<Actor>>;
export type Upload=ReturnType<typeof createAuthenticatedLargeImportUpload<Actor>>;
export type CertifiedAvailability={certified:true;coreReview:true;streamUpload:true;independentCreates:boolean};
export type Services={actor:Actor;principal:Principal;coordinator:Coordinator;upload:Upload;
 uploads:{
  /** Durable tenant+actor+catalog+key registry. Pending/unknown is never a new upload. Own callback executes once; loss of ACK stays inspectable. */
  once(key:string,catalogId:string,retain:()=>Promise<ReadyUpload>):Promise<ReadyUpload>;
  inspect(key:string,catalogId:string):Promise<ReadyUpload>;
  owned(blobId:string,catalogId:string):Promise<ReadyUpload>;
 };
 /** Genuine saved sidecar/event receipt. Never a made-up hash of the response. */
 witness(value:Job|CoreReview):Promise<Ref>;
 /** Same original, current full job and actual native terminal keeper; no supplied success proof. */
 finalize?(input:import('../../../server/large-import/finalization').ImportFinalizationInput):Promise<import('../../../server/large-import/finalization').ImportFinalizationAck>;
};
export type Binding={
 /** Root certified owner startup gate covers composed173/current-admit/sixth review/scope and durable stores; absent => false. */
 startup():Promise<CertifiedAvailability|false>;
 /** Uses original already authenticated request custody; NEVER deserializes Actor from JSON. */
 bind(req:FastifyRequest):Promise<Services>;
};
export type OriginalMetadataBinding=ReturnType<ReturnType<typeof createDedicatedMetadataTransport>['bind']>;
export type OriginalBindingRuntime=ReturnType<typeof createComposedLargeImportRuntime>&{metadataBinding(actor:Actor):OriginalMetadataBinding};
/** Concrete connection to reviewed runtime; business/eligibility/quota/blob registry implementations remain REQUIRED. */
export function bindComposedRuntime(runtime:OriginalBindingRuntime,ports:{
 startup:Binding['startup'];
 forActor(actor:Actor,originalRequest:FastifyRequest,metadataBinding:OriginalMetadataBinding):Promise<{raw:RawStorage;business:Omit<Ports4<Actor>,'jobs'|'blob'>;upload:Upload;uploads:Services['uploads'];witness:Services['witness'];finalize?:Services['finalize']}>;
}):Binding {
 const startup=ports.startup,prepare=ports.forActor;
 return {startup,async bind(req){const actor=runtime.capture(req),metadataBinding=runtime.metadataBinding(actor);
  assertOriginalMetadataBinding(metadataBinding.ports,req,actor);
  const p=await prepare(actor,req,metadataBinding);
  assert.equal(runtime.metadataBinding(actor),metadataBinding,'http-original-runtime-binding-changed');
  assertOriginalMetadataBinding(metadataBinding.ports,req,actor);
  const r=runtime.bind(actor,p.raw,p.business);
  return {actor,principal:r.scope,coordinator:r.coordinator,upload:p.upload,uploads:p.uploads,witness:p.witness,...(p.finalize?{finalize:p.finalize}:{})};}};
}
export type PrepareBody={blob_id:string;job_id:string;config:CoreConfig};
export type {Command,ResolutionAck,ReadyUpload,Job,CoreReview};
