/** Export-only injected PostgreSQL metadata adapter. No default pool, disk/network or worker startup. */
import {createHash,randomUUID} from 'node:crypto';
import {attachCoreReviewLease} from './review-store';
import type {Store4,Lease4} from '../pim-large-import-job-coordinator-backend5/core-review';
import type {Job,Principal,Ref,Store,Lease} from '../pim-large-import-job-coordinator-backend3/coordinator';
import type {Manifest,Batch,Spec,Sink,RawSeal} from '../pim-large-import-stream-foundation-ui2/stream';

export type Client={query(sql:string,values?:unknown[]):Promise<{rows:any[];rowCount?:number|null}>;end():Promise<void>};
export type MetadataPorts={
 /** Fresh dedicated app-role connection, real authenticated metadata admission, tenant GUC already bound. */
 connect(scope:Principal):Promise<Client>;
 admit(c:Client,scope:Principal):Promise<void>;
 /** Private diagnostic only. Never prints SQL values, credentials, blob data or unredacted errors. */
 cleanupFailure(error:unknown):void;
};
export type RawStorage={appendExact(storageId:string,bytes:Uint8Array,offset:number):Promise<void>;inspect(storageId:string):Promise<{sha256:string;byte_count:number}>;read(storageId:string):AsyncIterable<Uint8Array>};
function reportCleanup(ports:MetadataPorts,error:unknown){try{ports.cleanupFailure(error);}catch{}}
const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex'),clone=<T>(v:T):T=>structuredClone(v);
function need(v:unknown,message:string):asserts v{if(!v)throw Error(message);}
const uuid=(v:string)=>need(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v),'metadata-uuid');
const samePrincipal=(a:Principal,b:Principal)=>a.tenantId===b.tenantId&&a.userId===b.userId&&a.apiKeyId===b.apiKeyId;
function scopeCheck(p:Principal){uuid(p.tenantId);uuid(p.userId);if(p.apiKeyId!==null)uuid(p.apiKeyId);}
import {decodeState,decodeBatch,decodeManifest,validateSpec} from '../pim-large-import-core-native-head-codec-backend/state-codec';
export {decodeState} from '../pim-large-import-core-native-head-codec-backend/state-codec';
/** BEGIN failures still rollback; the exact first error, including falsy values, survives cleanup. */
const activeTransactions=new WeakSet<Client>();
export async function transaction<T>(c:Client,work:()=>Promise<T>,rollbackFailure:(error:unknown)=>void=()=>{}):Promise<T>{need(!activeTransactions.has(c),'metadata-overlapping-transaction');activeTransactions.add(c);let failed=false,first:unknown,value:T|undefined;try{await c.query('BEGIN');value=await work();await c.query('COMMIT');}catch(e){failed=true;first=e;try{await c.query('ROLLBACK');}catch(e){try{rollbackFailure(e);}catch{}}}finally{activeTransactions.delete(c);}if(failed)throw first;return value as T;}
async function use<T>(ports:MetadataPorts,scope:Principal,work:(c:Client)=>Promise<T>):Promise<T>{scopeCheck(scope);let c:Client|undefined,failed=false,first:unknown,result:T|undefined;try{c=await ports.connect(clone(scope));await ports.admit(c,clone(scope));const s=(await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];need(s?.role==='dyna_app'&&s.tenant===scope.tenantId,'metadata-real-tenant-app-role');result=await work(c);}catch(e){failed=true;first=e;}finally{if(c)try{await c.end();}catch(e){reportCleanup(ports,e);if(!failed){failed=true;first=e;}}}if(failed)throw first;return result as T;}
const ownerWhere='tenant_id=$1 AND actor_id=$2 AND api_key_id IS NOT DISTINCT FROM $3::uuid';
const params=(p:Principal)=>[p.tenantId,p.userId,p.apiKeyId];

/** A session advisory lock spans independently COMMITted CAS checkpoints; no long open transaction. */
export function createPostgresJobStore(ports:MetadataPorts,scope:Principal):Store4{
 scope=clone(scope);scopeCheck(scope);
 const tx=<T>(c:Client,work:()=>Promise<T>,cleanup=false)=>transaction(c,async()=>{if(!cleanup)await ports.admit(c,clone(scope));const result=await work();if(!cleanup)await ports.admit(c,clone(scope));return result;},ports.cleanupFailure);
 const load=async(c:Client,id:string)=>{await ports.admit(c,clone(scope));const r=(await c.query(`SELECT state_text,state_sha256 FROM public.large_import_jobs173 WHERE ${ownerWhere} AND id=$4`,[...params(scope),id])).rows[0];need(r,'metadata-job-not-owned');const j=decodeState(r.state_text,r.state_sha256);need(j.id===id&&samePrincipal(j.principal,scope),'metadata-principal');return j;};
 return {
  async createIfAbsent(job){job=clone(job);uuid(job.id);need(job.revision===0&&job.events.length===0&&samePrincipal(job.principal,scope),'metadata-new-job');const text=JSON.stringify(job);decodeState(text,hash(text));return use(ports,scope,c=>tx(c,async()=>{await c.query('INSERT INTO public.large_import_jobs173(tenant_id,id,actor_id,api_key_id,plan_hash,state_text,state_sha256,revision) VALUES($1,$4,$2,$3,$5,$6,$7,0) ON CONFLICT(tenant_id,id) DO NOTHING',[...params(scope),job.id,job.plan_hash,text,hash(text)]);const actual=await load(c,job.id);need(actual.plan_hash===job.plan_hash,'metadata-job-id-conflict');return clone(actual);}));},
  async withLease<T>(id:string,work:(lease:Lease4)=>Promise<T>){uuid(id);return use(ports,scope,async c=>{
   const lockKey=`large-import173:${scope.tenantId}:${id}`,locked=(await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked',[lockKey])).rows[0]?.locked;need(locked===true,'metadata-job-busy');
   let failed=false,first:unknown,result:T|undefined,token:string|undefined,fence:string|undefined;
   try{
    await ports.admit(c,clone(scope));token=randomUUID();const r=await tx(c,async()=>{const r=(await c.query(`UPDATE public.large_import_jobs173 SET lease_fence=lease_fence+1,lease_token=$5,leased_at=clock_timestamp() WHERE ${ownerWhere} AND id=$4 RETURNING lease_fence::text fence`,[...params(scope),id,token])).rows[0];need(r,'metadata-job-not-owned');return r;});fence=r.fence;
    const lease:Lease={load:()=>tx(c,()=>load(c,id)),save:async(next,expected)=>{next=clone(next);await ports.admit(c,clone(scope));need(next.id===id&&next.revision===expected+1&&next.events.length===next.revision&&Number.isSafeInteger(expected),'metadata-next-revision');const text=JSON.stringify(next);decodeState(text,hash(text));need(samePrincipal(next.principal,scope),'metadata-principal');const event=next.events.at(-1)!;need(event.sequence===expected,'metadata-event-sequence');await tx(c,async()=>{const updated=await c.query(`UPDATE public.large_import_jobs173 SET state_text=$8,state_sha256=$9,revision=$10 WHERE ${ownerWhere} AND id=$4 AND lease_token=$5 AND lease_fence=$6::bigint AND revision=$7 RETURNING revision`,[...params(scope),id,token,fence,expected,text,hash(text),next.revision]);need(updated.rows.length===1,'metadata-stale-fence-or-cas');const eventText=JSON.stringify(event);await c.query('INSERT INTO public.large_import_events173(tenant_id,job_id,sequence,revision,event_text,event_sha256) VALUES($1,$2,$3,$4,$5,$6)',[scope.tenantId,id,event.sequence,next.revision,eventText,hash(eventText)]);});}};
    const attached=attachCoreReviewLease({c,ports,scope,jobId:id,token:token!,fence:fence!});
    try{result=await work({...lease,review:attached.review});}finally{await attached.close();}
   }catch(e){failed=true;first=e;}
   finally{
    if(token&&fence)try{await tx(c,async()=>{await c.query(`UPDATE public.large_import_jobs173 SET lease_token=NULL,leased_at=NULL WHERE ${ownerWhere} AND id=$4 AND lease_token=$5 AND lease_fence=$6::bigint`,[...params(scope),id,token,fence]);},true);}catch(e){reportCleanup(ports,e);if(!failed){failed=true;first=e;}}
    try{need((await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) unlocked',[lockKey])).rows[0]?.unlocked===true,'metadata-lock-release');}catch(e){reportCleanup(ports,e);if(!failed){failed=true;first=e;}}
   }if(failed)throw first;return result as T;
  });},
 };
}
const rawId=(id:string)=>`large-import-raw/v1:${id}`;
export function batchRef(blobId:string,index:number,id:string){uuid(blobId);need(Number.isSafeInteger(index)&&index>=0&&index<=99999&&/^[a-f0-9]{64}$/.test(id),'batch-ref');return `large-import-batch/v1:${blobId}:${index}:${id}`;}
function parseRaw(ref:Ref){const id=ref.id.slice('large-import-raw/v1:'.length);need(ref.id.startsWith('large-import-raw/v1:'),'raw-ref');uuid(id);return id;}
function parseBatch(ref:string){const m=/^large-import-batch\/v1:([a-f0-9-]{36}):(0|[1-9][0-9]{0,4}):([a-f0-9]{64})$/.exec(ref);need(m,'batch-ref');uuid(m[1]);return {blobId:m[1],index:Number(m[2]),id:m[3]};}

/** Raw bytes belong to an injected durable immutable byte store; PostgreSQL binds append metadata and exact JSON text. */
export function createPostgresBlobMetadata(ports:MetadataPorts,scope:Principal,raw:RawStorage){
 scope=clone(scope);scopeCheck(scope);
 const tx=<T>(c:Client,work:()=>Promise<T>,cleanup=false)=>transaction(c,async()=>{if(!cleanup)await ports.admit(c,clone(scope));const result=await work();if(!cleanup)await ports.admit(c,clone(scope));return result;},ports.cleanupFailure);
 const blob=async(c:Client,id:string)=>{const r=(await c.query(`SELECT * FROM public.large_import_blobs173 WHERE ${ownerWhere} AND id=$4`,[...params(scope),id])).rows[0];need(r,'metadata-blob-not-owned');return r;};
 return {
  async create(blobId:string,storageId:string,spec:Spec,maxBytes=30000000){uuid(blobId);need(storageId&&storageId.length<=500&&Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=30000000,'blob-create');spec=validateSpec(spec);const text=JSON.stringify(spec);await use(ports,scope,c=>tx(c,async()=>{await c.query('INSERT INTO public.large_import_blobs173(tenant_id,id,actor_id,api_key_id,storage_id,spec_text,max_bytes) VALUES($1,$4,$2,$3,$5,$6,$7) ON CONFLICT(tenant_id,id) DO NOTHING',[...params(scope),blobId,storageId,text,maxBytes]);const r=await blob(c,blobId);need(r.storage_id===storageId&&r.spec_text===text&&Number(r.max_bytes)===maxBytes,'blob-create-replay');}));},
  sink(blobId:string):Sink{uuid(blobId);return {
   async appendOriginal(part,offset){need(part instanceof Uint8Array,'raw-part');part=new Uint8Array(part);need(part instanceof Uint8Array&&part.length>0&&part.length<=65536&&Number.isSafeInteger(offset)&&offset>=0,'raw-part');const partHash=hash(part);await use(ports,scope,c=>tx(c,async()=>{const b=await blob(c,blobId);need(b.raw_sha256===null,'raw-sealed');/* External write must be exact-offset idempotent. Lost ACK may safely retry the same part. */await raw.appendExact(b.storage_id,part.slice(),offset);await c.query('INSERT INTO public.large_import_parts173(tenant_id,blob_id,offset_bytes,byte_count,sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,blob_id,offset_bytes) DO NOTHING',[scope.tenantId,blobId,offset,part.length,partHash]);const r=(await c.query('SELECT byte_count,sha256 FROM public.large_import_parts173 WHERE tenant_id=$1 AND blob_id=$2 AND offset_bytes=$3',[scope.tenantId,blobId,offset])).rows[0];need(r?.byte_count===part.length&&r.sha256===partHash,'raw-part-replay');}));},
   async putBatch(batch){batch=clone(batch);const text=JSON.stringify(batch);decodeBatch(text,hash(text));need(batch.provisional===true&&batch.schema==='large-core-import-parser-batch/v1','provisional-batch');return use(ports,scope,c=>tx(c,async()=>{await blob(c,blobId);await c.query('INSERT INTO public.large_import_batches173(tenant_id,blob_id,index,id,batch_text,text_sha256) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,blob_id,index) DO NOTHING',[scope.tenantId,blobId,batch.index,batch.id,text,hash(text)]);const r=(await c.query('SELECT batch_text,text_sha256 FROM public.large_import_batches173 WHERE tenant_id=$1 AND blob_id=$2 AND index=$3',[scope.tenantId,blobId,batch.index])).rows[0];need(r?.batch_text===text&&r.text_sha256===hash(text),'batch-replay');return batchRef(blobId,batch.index,batch.id);}));},
   async sealOriginal(seal:RawSeal){seal=clone(seal);await use(ports,scope,c=>tx(c,async()=>{const b=await blob(c,blobId),observed=await raw.inspect(b.storage_id);need(observed.sha256===seal.sha256&&observed.byte_count===seal.byte_count,'raw-storage-seal');await c.query(`UPDATE public.large_import_blobs173 SET raw_sha256=$5,raw_bytes=$6,completed_eof=$7,parse_valid=$8 WHERE ${ownerWhere} AND id=$4 AND (raw_sha256 IS NULL OR raw_sha256=$5)`,[...params(scope),blobId,seal.sha256,seal.byte_count,seal.completed_eof,seal.parse_valid]);const r=await blob(c,blobId);need(r.raw_sha256===seal.sha256&&Number(r.raw_bytes)===seal.byte_count&&r.completed_eof===seal.completed_eof&&r.parse_valid===seal.parse_valid,'raw-seal-replay');}));},
   async commitManifest(manifest){const text=JSON.stringify(manifest);decodeManifest(text,hash(text));await use(ports,scope,c=>tx(c,async()=>{const b=await blob(c,blobId);need(b.parse_valid===true&&b.completed_eof===true,'valid-eof-required');await c.query(`UPDATE public.large_import_blobs173 SET manifest_text=$5,manifest_sha256=$6 WHERE ${ownerWhere} AND id=$4 AND (manifest_text IS NULL OR manifest_text=$5)`,[...params(scope),blobId,text,hash(text)]);const r=await blob(c,blobId);need(r.manifest_text===text&&r.manifest_sha256===hash(text),'manifest-replay');}));},
  };},
  async readManifest(blobId:string){return use(ports,scope,c=>tx(c,async()=>{const b=await blob(c,blobId);need(b.manifest_text&&b.manifest_sha256===hash(b.manifest_text),'sealed-manifest');const manifest=decodeManifest(b.manifest_text,b.manifest_sha256);need(typeof b.spec_text==='string'&&Buffer.byteLength(b.spec_text)<=65536,'stored-spec-bytes');const spec=validateSpec(JSON.parse(b.spec_text));need(manifest.format===spec.format&&manifest.raw.sha256===b.raw_sha256&&manifest.raw.byte_count===Number(b.raw_bytes)&&b.completed_eof===true&&b.parse_valid===true,'stored-manifest-raw-spec');return {manifest,spec,raw:{id:rawId(blobId),sha256:b.raw_sha256,byte_count:Number(b.raw_bytes)}as Ref};}));},
  async *readRaw(ref:Ref){
   ref=clone(ref);scopeCheck(scope);let c:Client|undefined,failed=false;
   try{c=await ports.connect(clone(scope));await ports.admit(c,clone(scope));const current=(await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];need(current?.role==='dyna_app'&&current.tenant===scope.tenantId,'metadata-real-tenant-app-role');
    const owned=async()=>{const b=await blob(c!,parseRaw(ref));need(b.manifest_text&&b.raw_sha256===ref.sha256&&Number(b.raw_bytes)===ref.byte_count,'raw-manifest-ref');return b;};
    const b=await tx(c,owned);for await(const chunk of raw.read(b.storage_id)){need(chunk instanceof Uint8Array&&chunk.length<=65536,'raw-read-bounded-part');const detached=new Uint8Array(chunk);await tx(c,owned);yield detached;}
   }catch(error){failed=true;throw error;}finally{if(c)try{await c.end();}catch(error){reportCleanup(ports,error);if(!failed)throw error;}}
  },
  async readBatch(ref:string){const p=parseBatch(ref);return use(ports,scope,c=>tx(c,async()=>{await blob(c,p.blobId);const r=(await c.query('SELECT batch_text,text_sha256,id FROM public.large_import_batches173 WHERE tenant_id=$1 AND blob_id=$2 AND index=$3',[scope.tenantId,p.blobId,p.index])).rows[0];need(r?.id===p.id&&r.text_sha256===hash(r.batch_text),'batch-stored-sha');const batch=decodeBatch(r.batch_text,r.text_sha256);need(batch.id===p.id&&batch.index===p.index,'batch-ref-content');return batch;}));},
 };
}
