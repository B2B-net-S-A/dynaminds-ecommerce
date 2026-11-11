/** Owned snapshot reader: no lease/advisory lock, token/fence CAS or metadata DML. Export-only. */
import assert from 'node:assert/strict';
import type {FastifyRequest} from 'fastify';
import type {Actor} from '../../../server/domain';
import {Problem,ensure} from '../../../server/errors';
import type {Client} from '../pim-large-import173-composed-runtime-backend/storage';
import {decodeState} from '../pim-large-import-core-native-head-codec-backend/state-codec';
import {decodeReview} from '../pim-large-import173-composed-runtime-backend/review-store';
import {verifyNativeBindings} from '../pim-large-import173-composed-runtime-backend/serialization';
import type {Principal} from '../pim-large-import-job-coordinator-backend5/coordinator';
export type ReadPorts={
 /** Genuine original captured HTTP actor; current admin role policy is retained. No JSON Actor input. */
 capture(req:FastifyRequest):Actor;
 /** Fresh dedicated connection with genuine certified owner preflight + app role/tenant. No pool/credentials in reader. */
 connect(actor:Actor):Promise<{c:Client;scope:Principal}>;
 /** Genuine current173 authority with original private digest; auth FOR SHARE lasts until COMMIT. */
 admit(c:Client,actor:Actor,writing:false):Promise<void>;
 cleanupFailure(phase:'rollback'|'close'):void;
};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const owned='tenant_id=$1 AND actor_id=$2 AND api_key_id IS NOT DISTINCT FROM $3::uuid';
const ownedReaders=new WeakSet<object>();
export function assertOwnedMetadataReader(reader:unknown):asserts reader is OwnedMetadataReader{assert(reader&&typeof reader==='object'&&ownedReaders.has(reader),'installed-genuine-select-only-reader');}
export function createOwnedMetadataReader(ports:ReadPorts){ports={...ports};const used=new WeakSet<object>();const reader={async inspect(req:FastifyRequest,id:string,catalogId:string){
 ensure(uuid.test(id)&&uuid.test(catalogId),422,'Nieprawidłowy identyfikator zadania lub katalogu');const actor=ports.capture(req);ensure(actor.role==='admin',403,'Wymagana rola administratora');let c:Client|undefined,started=false,failed=false,first:unknown,result:unknown;
 try{const connection=await ports.connect(actor);ensure(!used.has(connection.c),503,'Odczyt wymaga nowego własnego połączenia');used.add(connection.c);c=connection.c;const p=connection.scope;ensure(p.tenantId===actor.tenantId&&p.userId===actor.userId&&p.apiKeyId===(actor.apiKeyId??null),403,'Inny kontekst odczytu');
  // Native admit uses SELECT FOR SHARE; PostgreSQL READ ONLY would refuse those required auth locks.
  // This snapshot allows those locks but the reader itself executes SELECT only, never claims the Job lease.
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');started=true;await ports.admit(c,actor,false);
  const current=(await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];ensure(current?.role==='dyna_app'&&current.tenant===p.tenantId,403,'Inny kontekst połączenia');
  const values=[p.tenantId,p.userId,p.apiKeyId,id],row=(await c.query('SELECT state_text,state_sha256,revision FROM public.large_import_jobs173 WHERE '+owned+' AND id=$4',values)).rows[0];ensure(row,404,'Nie znaleziono własnego zadania');
  const job=decodeState(row.state_text,row.state_sha256);ensure(job.id===id&&job.revision===Number(row.revision)&&job.principal.tenantId===p.tenantId&&job.principal.userId===p.userId&&job.principal.apiKeyId===p.apiKeyId&&job.core.length>0&&job.core.every(b=>b.request.catalog_id===catalogId),404,'Nie znaleziono zadania tego katalogu');
  const prefix='large-import-raw/v1:';ensure(job.raw.id.startsWith(prefix),422,'Nieprawidłowe źródło zadania');const blobId=job.raw.id.slice(prefix.length);ensure(uuid.test(blobId),422,'Nieprawidłowe źródło zadania');
  const blob=(await c.query('SELECT raw_sha256,raw_bytes,completed_eof,parse_valid FROM public.large_import_blobs173 WHERE '+owned+' AND id=$4',[...values.slice(0,3),blobId])).rows[0];ensure(blob&&blob.completed_eof===true&&blob.parse_valid===true&&blob.raw_sha256===job.raw.sha256&&Number(blob.raw_bytes)===job.raw.byte_count,422,'Niepotwierdzony kompletny oryginał');
  const r=(await c.query('SELECT revision,job_revision,review_text,review_sha256,scope_text,request_texts,row_texts FROM public.large_import_core_reviews173 WHERE '+owned+' AND job_id=$4 ORDER BY revision DESC LIMIT 1',values)).rows[0];let review=null;
  if(r){review=decodeReview(r.review_text,r.review_sha256,job);ensure(review.revision===Number(r.revision)&&Number(r.job_revision)<=job.revision,422,'Inna rewizja przeglądu');verifyNativeBindings(r,review,job);}
  await ports.admit(c,actor,false);await c.query('COMMIT');started=false;result={job,review};
 }catch(e){failed=true;first=e;if(c&&started)try{await c.query('ROLLBACK');}catch{try{ports.cleanupFailure('rollback');}catch{}}}
 finally{if(c)try{await c.end();}catch(e){try{ports.cleanupFailure('close');}catch{}if(!failed){failed=true;first=e;}}}
 if(failed)throw first;return result as {job:ReturnType<typeof decodeState>;review:ReturnType<typeof decodeReview>|null};
 }};ownedReaders.add(reader);return reader;}
export type OwnedMetadataReader=ReturnType<typeof createOwnedMetadataReader>;
