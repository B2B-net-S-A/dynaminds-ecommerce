/** Actual service producer; export-only, no pool/app/credentials/default transaction. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Actor} from '../domain';
import {ensure} from '../errors';
import {createPimService,pimPreviewInput,type PimServiceDependencies} from '../pim-dictionaries/service';
import {decodePreview,decodeOperation} from '../pim-dictionaries/legacy/batch-codec';
import type {Ports,Ref,PimStage,PimAck} from '../../shared/large-import-dependencies/pim-large-import-job-coordinator-backend5/coordinator';

type Request=Parameters<ReturnType<typeof createPimService>['captureActor']>[0];
export type Evidence={save(kind:'large-import-pim-stage'|'large-import-pim-preview'|'large-import-pim-operation',bytes:Uint8Array):Promise<Ref>};
export type DriverPorts={
 /** Actual managed PIM transaction: owner preflight, namespace/sibling ordering, prepare/drain/LAST/COMMIT. */
 service:PimServiceDependencies;
 /** Genuine certified172 startup capability; never a browser flag or170 alias. */
 nestedAvailable():boolean;
 /** Owned durable witness writer, quota-hooked by the application. Failure after COMMIT remains unknown. */
 evidence:Evidence;
};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const scope=(a:Actor)=>({tenantId:a.tenantId,userId:a.userId,apiKeyId:a.apiKeyId??null,role:a.role});
/** Bind only the genuine runtime Actor and SAME original authenticated HTTP request. Service has its own credential WeakMap. */
export function createNativePimDriver(input:DriverPorts){
 const deps={...input.service},nested=input.nestedAvailable,evidence=input.evidence,service=createPimService(deps);
 return {bind(runtimeActor:Actor,original:Request,catalogId:string):Ports<Actor>['pim']{
  ensure(uuid.test(catalogId),422,'Nieprawidłowy katalog');assert.deepEqual(scope(runtimeActor),scope(original.actor),'pim-runtime-original-request');
  ensure(runtimeActor.role==='admin',403,'Wymagana rola administratora');
  const actor=service.captureActor(original);assert.deepEqual(scope(actor),scope(runtimeActor),'pim-native-captured-principal');
  const originalScope=scope(runtimeActor);
  const check=(a:Actor)=>{assert.equal(a,runtimeActor,'pim-original-runtime-actor');assert.deepEqual(scope(a),originalScope,'pim-runtime-actor-changed');};
  const writing=(a:Actor)=>{check(a);ensure(!deps.readOnly,423,'Tryb tylko do odczytu');};
  const save=async(kind:Parameters<Evidence['save']>[0],value:unknown):Promise<Ref>=>{
   const bytes=new Uint8Array(Buffer.from(JSON.stringify(value),'utf8'));ensure(bytes.length<=4194304,413,'Pełne świadectwo PIM przekracza limit');
   const ref=structuredClone(await evidence.save(kind,new Uint8Array(bytes)));assert(ref&&typeof ref.id==='string'&&ref.id.length>0&&ref.sha256===hash(bytes)&&ref.byte_count===bytes.length,'pim-durable-witness-readback');return ref;
  };
  return {
   async stage(a,raw):Promise<PimStage>{
    writing(a);const body=structuredClone(raw);ensure(body.core_request.catalog_id===catalogId,422,'Inny katalog partii');
    const mapping=body.typed_mapping as {schema?:unknown};if(mapping?.schema==='legacy-pim-mapping/v2')ensure(nested()===true,503,'Brak zwalidowanego modułu nested172');
    // Real service verifies all durable native098 rows and freshly reads dictionary/products on ONE managed c.
    const result=await service.stageLegacyFile(actor,catalogId,body);check(a);
    ensure(result.schema===(mapping?.schema==='legacy-pim-mapping/v2'?'committed-core-file-pim-stage/v2':'committed-core-file-pim-stage/v1'),503,'Inna wersja producenta Stage');
    ensure(result.execution.id===body.execution_id&&result.execution.preview_id===body.preview.id&&result.execution.scope_hash===body.preview.scope_hash&&result.execution.total===body.preview.total,503,'Inny trwały zakres Stage');
    const p=result.prepared;const witness=await save('large-import-pim-stage',result);
    const unmapped=p.intake.rows.map(r=>({index:r.index,fields:structuredClone(r.unmapped_fields)}));
    if(!p.ready)return{ready:false,intake:structuredClone(p.intake),unmapped,errors:structuredClone(p.errors),witness};
    ensure(p.request.kind==='product_values'&&p.request.client_key===body.client_key&&p.sources.length===p.intake.rows.length,503,'Niepełny producent PIM');
    // Keep full ProductSource15 and complete raw/nested intake. Never toRow() the source or rebuild native IDs.
    return{ready:true,intake:structuredClone(p.intake),unmapped,request:structuredClone(p.request),sources:structuredClone(p.sources),witness};
   },
   async preview(a,raw,key):Promise<PimAck>{
    writing(a);const request=pimPreviewInput.parse(structuredClone(raw));ensure(request.kind==='product_values'&&request.client_key===key,422,'Inny klucz trwałego podglądu');
    const result=decodePreview(await service.preview(actor,catalogId,request),request,catalogId,actor.userId);check(a);
    const witness=await save('large-import-pim-preview',result);return{id:result.id,scope_hash:result.scope_hash,body:result,witness};
   },
   async apply(a,id,raw):Promise<PimAck>{
    writing(a);const body=structuredClone(raw);ensure(body.confirmed===true&&uuid.test(id)&&uuid.test(body.client_key)&&/^[a-f0-9]{64}$/.test(body.scope_hash),422,'Wymagana jawna zgoda i dokładny klucz');
    const saved=await service.readPreview(actor,catalogId,id);const request=pimPreviewInput.parse(saved.request);ensure(request.kind==='product_values',422,'Wymagany podgląd parametrów');
    const preview=decodePreview(saved,request,catalogId,actor.userId);ensure(preview.id===id&&preview.scope_hash===body.scope_hash,409,'Inny zakres zgody');
    // Do not require can_apply/current CAS here: native apply owns exact-key replay after a prior committed effect.
    const result=decodeOperation(await service.apply(actor,catalogId,id,body),preview,catalogId,actor.userId);check(a);
    const witness=await save('large-import-pim-operation',result);return{id:result.id,scope_hash:result.scope_hash,body:result,witness};
   },
  };
 }};
}
