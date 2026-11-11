import type {UploadClaim} from './registry';
/** Server-side export-only adapter. No default pool, file root, route, request, listener or worker. */
import {randomUUID} from 'node:crypto';
import {retainAndChunkImport,DEFAULT_POLICY,type Spec,type Sink,type Manifest,type RawSeal} from '../pim-large-import-stream-foundation-ui2/stream';
import type {Principal,Ref} from '../pim-large-import-job-coordinator-backend3/coordinator';
import {catalogXmlPathValid} from '../../catalog-xml-path';

export type Captured={principal:Principal;authorityStamp:string};
export type QuotaReservation={id:string};
export type UploadRequest={spec:Spec};
export type ByteStore<A>={
 create(a:A,blobId:string):Promise<string>;
 seal(a:A,handle:string,fact:{sha256:string;byte_count:number}):Promise<unknown>;
 /** Reserve failure publication BEFORE stream/metadata writes; unused intent retains full unknown charge. */
 prepareCleanup(a:A,handle:string):Promise<{publishFailure():Promise<void>;retainUnused():Promise<void>}>;
};
export type Metadata={create(blobId:string,storageId:string,spec:Spec,maxBytes:number):Promise<void>;sink(blobId:string):Sink;readManifest(blobId:string):Promise<{manifest:Manifest;spec:Spec;raw:Ref}>};
export type Ports<A>={
 /** Real normal authenticated write/IAM + future certified storage availability. Never caller JSON authority. */
 capture(a:A):Promise<Captured>;
 revalidate(a:A,captured:Captured):Promise<void>;
 /** Durable atomic tenant/global/day reservation, not a local-memory quota. */
 quotas:{reserve(captured:Captured,maxBytes:number):Promise<QuotaReservation>;close(reservation:QuotaReservation,result:{outcome:'ready'|'quarantined'|'unknown';acknowledged_bytes:number;raw:RawSeal|null}):Promise<void>};
 bytes:ByteStore<A>;
 /** Bind existing PG metadata adapter to genuine authority + bytes.rawPort(a); still no installed173 claim. */
 metadata(a:A,captured:Captured):Promise<Metadata>;
 /** Whitelisted phase only; never error/body/path/credentials. Callback failure cannot replace the first failure. */
 cleanupFailure(phase:'quarantine'|'reservation-close'):void;
};
export type ReadyUpload={schema:'retained-large-import-upload/v1';status:'UPLOAD_RETAINED_READY_NOT_NATIVE_APPROVED';blob_id:string;raw:Ref;manifest:Manifest;spec:Spec;whole_native_preview:'OPEN'};
const need=(ok:unknown,message:string):void=>{if(!ok)throw Error(message);};
const uuid=(s:string)=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function snapshotSpec(input:Spec):Spec{
 const s=structuredClone(input),known=new Set(Object.keys(DEFAULT_POLICY));
 need(s&&typeof s==='object'&&Object.keys(s).every(k=>['format','delimiter','recordPath','limits'].includes(k)),'upload-spec');
 need(s.format==='csv'||s.format==='xml','upload-format');
 if(s.format==='csv')need([',',';','\t','|'].includes(s.delimiter)&&!Object.hasOwn(s,'recordPath'),'upload-csv-spec');
 else need(catalogXmlPathValid(s.recordPath,true,DEFAULT_POLICY.xmlDepth)&&!s.recordPath.includes('@')&&!Object.hasOwn(s,'delimiter'),'upload-xml-spec');
 const ceiling=s.format==='csv'?5_000_000:30_000_000;
 for(const [k,v]of Object.entries(s.limits??{}))need(known.has(k)&&Number.isSafeInteger(v)&&v!>0&&v!<=DEFAULT_POLICY[k as keyof typeof DEFAULT_POLICY]&&(k!=='maxFileBytes'||v!<=ceiling),'upload-policy');
 return {...s,limits:{...s.limits,maxFileBytes:s.limits?.maxFileBytes??ceiling}};
}
/** Canonical <=64KiB retained parts, independent of network fragmentation; private byte-store cap1024 is not exhausted by tiny packets. */
export async function* coalesceUploadChunks(chunks:AsyncIterable<Uint8Array>,signal?:AbortSignal):AsyncGenerator<Uint8Array>{
 let pending=new Uint8Array(65536),used=0;
 for await(const chunk of chunks){need(chunk instanceof Uint8Array&&chunk.byteLength<=65536,'upload-input-chunk-limit');need(!signal?.aborted,'upload-aborted');const detached=new Uint8Array(chunk);
  for(let at=0;at<detached.length;){const n=Math.min(65536-used,detached.length-at);pending.set(detached.subarray(at,at+n),used);used+=n;at+=n;
   if(used===65536){const output=pending;pending=new Uint8Array(65536);used=0;yield output;}
  }
 }
 need(!signal?.aborted,'upload-aborted');if(used)yield pending.slice(0,used);
}
function capturedValue(c:Captured){need(c&&uuid(c.principal?.tenantId)&&uuid(c.principal?.userId)&&(c.principal.apiKeyId===null||uuid(c.principal.apiKeyId))&&typeof c.authorityStamp==='string'&&c.authorityStamp.length>0,'upload-real-captured-scope');return structuredClone(c);}

/** One new upload, no native core/PIM writes, no automatic job creation/consent. Original stream is never text-normalized. */
export function createAuthenticatedLargeImportUpload<A>(ports:Ports<A>){
 return {
  async retain(a:A,request:UploadRequest,chunks:AsyncIterable<Uint8Array>,signal:AbortSignal|undefined,claim:UploadClaim):Promise<ReadyUpload>{
   // Snapshot parser policy before any awaited authority/storage operation (coordinator3 TOCTOU rule).
   const spec=snapshotSpec(request.spec),maxBytes=spec.limits!.maxFileBytes!,blobId=randomUUID();
   let captured:Captured|undefined,reservation:QuotaReservation|undefined,handle:string|undefined,metadata:Metadata|undefined;
   let cleanup:Awaited<ReturnType<ByteStore<A>['prepareCleanup']>>|undefined;
   let failed=false,first:unknown,acknowledged=0,raw:RawSeal|null=null,manifestAttempted=false,ready:ReadyUpload|undefined;
   const current=async()=>{need(!signal?.aborted,'upload-aborted');await ports.revalidate(a,structuredClone(captured!));need(!signal?.aborted,'upload-aborted');};
   try{
    need(!signal?.aborted,'upload-aborted');captured=capturedValue(await ports.capture(a));
    reservation=structuredClone(await ports.quotas.reserve(structuredClone(captured),maxBytes));need(typeof reservation.id==='string'&&reservation.id.length>0,'upload-quota-reservation');
    await current();need(claim?.kind==='private-upload-claim/v1'&&typeof claim.attach==='function','upload-private-claim-required');await claim.attach(blobId);await current();handle=await ports.bytes.create(a,blobId);need(handle===`large-import-raw-file/v1:${captured.principal.tenantId}:${blobId}`,'upload-owned-handle');
    await current();cleanup=await ports.bytes.prepareCleanup(a,handle);await current();metadata=await ports.metadata(a,structuredClone(captured));await current();await metadata.create(blobId,handle,structuredClone(spec),maxBytes);
    const original=metadata.sink(blobId),bound:Sink={
     appendOriginal:async(bytes,offset)=>{const retained=new Uint8Array(bytes);await current();need(offset===acknowledged&&retained.length>0&&retained.length<=65536&&offset+retained.length<=maxBytes,'upload-offset-or-quota');await original.appendOriginal(retained,offset);acknowledged+=retained.length;},
     putBatch:async batch=>{const retained=structuredClone(batch);await current();return original.putBatch(retained);},
     sealOriginal:async fact=>{raw=structuredClone(fact);await current();need(fact.byte_count===acknowledged,'upload-seal-acknowledged-count');await ports.bytes.seal(a,handle!,{sha256:fact.sha256,byte_count:fact.byte_count});await current();await original.sealOriginal(structuredClone(fact));},
     commitManifest:async manifest=>{const retained=structuredClone(manifest);await current();manifestAttempted=true;await original.commitManifest(retained);},
    };
    const generated=await retainAndChunkImport(coalesceUploadChunks(chunks,signal),spec,bound);await current();const saved=await metadata.readManifest(blobId);await current();
    need(same(saved.manifest,generated)&&same(saved.spec,spec)&&saved.raw.id===`large-import-raw/v1:${blobId}`&&saved.raw.sha256===generated.raw.sha256&&saved.raw.byte_count===generated.raw.byte_count,'upload-durable-manifest-readback');
    ready={schema:'retained-large-import-upload/v1',status:'UPLOAD_RETAINED_READY_NOT_NATIVE_APPROVED',blob_id:blobId,raw:structuredClone(saved.raw),manifest:structuredClone(saved.manifest),spec:structuredClone(saved.spec),whole_native_preview:'OPEN'};
   }catch(e){failed=true;first=e;}
   // Failure retains charged raw/provisional metadata. A possibly committed manifest ACK is unknown, not deleted or overwritten.
   let outcome:'ready'|'quarantined'|'unknown'=ready?'ready':'unknown';
   if(cleanup){try{if(failed&&!manifestAttempted){await cleanup.publishFailure();outcome='quarantined';}else{await cleanup.retainUnused();outcome='unknown';}}catch(e){try{ports.cleanupFailure('quarantine');}catch{}outcome='unknown';if(!failed){failed=true;first=e;}}}
   if(reservation)try{await ports.quotas.close(reservation,{outcome,acknowledged_bytes:acknowledged,raw:raw?structuredClone(raw):null});}catch(e){try{ports.cleanupFailure('reservation-close');}catch{}if(!failed){failed=true;first=e;}}
   if(failed)throw first;return ready!;
  },
 };
}
