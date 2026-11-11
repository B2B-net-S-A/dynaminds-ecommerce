/** Durable owned finalization readback. Dedicated RR/IAM locks, SELECT-only business
 * behavior; no coordinator lease, Native187 journal, quota reserve/intent/settle. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {FastifyRequest} from 'fastify';
import {ensure} from '../errors';
import type {ReadPorts} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/readonly-store';
import {decodeState} from '../../shared/large-import-dependencies/pim-large-import-core-native-head-codec-backend/state-codec';
import {inspectBusinessKnownCloseSnapshot} from '../../shared/large-import-dependencies/pim-large-import-business-native-proof-ui/owned-inspection';
import {createOrdinarySchemaTransactionGate,inspectCompositeStartup,type ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import {inspectOwnedAllocationRecord,assertOwnedAllocationCustody,type createOwnedAllocationCustody} from './owned-allocation-custody';
import {assertFinalizableImport} from './finalization';
import {inspectBusinessQuotaRenewal,hasKnownCoreCheckpoint} from './quota-renewal-inspection';
import {captureRetirementHistory,retirementRootKey} from './unallocated-upload-retirement';
export type FinalizationPair={state:'open'|'retained'|'unknown';outcome:null|'ready'|'absent'};
export type FinalizationStatus={schema:'large-import-finalization-status/v1';id:string;revision:number;plan_hash:string;job:FinalizationPair;review:FinalizationPair;finalized:boolean;can_continue:boolean;blockers:string[]};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const params=z.strictObject({catalog_id:z.uuid(),id:z.uuid()});
export function createOwnedFinalizationStatus(input:{reader:ReadPorts;startup:ReviewedStartup;rawRoot:string;controlPlaneRoot:string;custody:Awaited<ReturnType<typeof createOwnedAllocationCustody>>}){
 const ports={...input.reader},startup=input.startup,rawRoot=input.rawRoot,controlPlaneRoot=input.controlPlaneRoot,custody=input.custody,gate=createOrdinarySchemaTransactionGate(startup),used=new WeakSet<object>();assertOwnedAllocationCustody(custody,controlPlaneRoot);
 return{async inspect(original:FastifyRequest):Promise<FinalizationStatus>{
  const p=params.parse(structuredClone(original.params)),actor=ports.capture(original),principal=structuredClone({tenantId:actor.tenantId,userId:actor.userId,apiKeyId:actor.apiKeyId??null,role:actor.role}),method=original.method,url=original.url,cookies=structuredClone(original.cookies),query=structuredClone(original.query),authorization=original.headers.authorization;
  ensure(actor.role==='admin'&&method==='GET',403,'Wymagany własny odczyt administratora');
  const check=()=>{assert.deepEqual(params.parse(original.params),p,'finalization-status-params-changed');assert.equal(original.method,method);assert.equal(original.url,url);assert.deepEqual(structuredClone(original.cookies),cookies);assert.equal(original.headers.authorization,authorization);assert.deepEqual(structuredClone(original.query),query);assert.deepEqual({tenantId:actor.tenantId,userId:actor.userId,apiKeyId:actor.apiKeyId??null,role:actor.role},principal);};
  let c:Awaited<ReturnType<ReadPorts['connect']>>['c']|undefined,lease:Awaited<ReturnType<typeof gate.reserve>>|undefined,started=false,locked=false,keys:number[]|undefined,failed=false,first:unknown,result:FinalizationStatus|undefined;
  const report=(phase:'rollback'|'close')=>{try{ports.cleanupFailure(phase);}catch{}};
  try{
   const connection=await ports.connect(actor);c=connection.c;assert(!used.has(c),'finalization-status-fresh-client');used.add(c);assert.deepEqual(connection.scope,{tenantId:principal.tenantId,userId:principal.userId,apiKeyId:principal.apiKeyId});check();
   const endpoint=(await c.query("SELECT current_user role,session_user owner,current_setting('role',true) role_setting,current_setting('app.tenant_id',true) tenant,current_database() database")).rows[0];assert(endpoint?.role==='dyna_app'&&endpoint.owner==='postgres'&&endpoint.role_setting==='dyna_app'&&endpoint.tenant===principal.tenantId,'finalization-status-owned-reader-context');
   await c.query('SET SESSION ROLE NONE');const root=retirementRootKey(endpoint.database,rawRoot,controlPlaneRoot),bytes=Buffer.from(root,'hex');keys=[bytes.readInt32BE(0),bytes.readInt32BE(4)];ensure((await c.query('SELECT pg_try_advisory_lock($1::integer,$2::integer) held',keys)).rows[0]?.held===true,409,'Trwa inna operacja importu');locked=true;
   lease=await gate.reserve(c as never);await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');started=true;await lease.enter();await inspectCompositeStartup(c,startup);
   await c.query('SET LOCAL ROLE dyna_app');check();await ports.admit(c,actor,false);await c.query('SET LOCAL ROLE NONE');
   const key={tenantId:principal.tenantId,userId:principal.userId,apiKeyId:principal.apiKeyId,catalogId:p.catalog_id,kind:'job' as const,publicId:p.id},before=await inspectOwnedAllocationRecord(custody,key),record=before.record;
   const scope={tenantId:principal.tenantId,actorId:principal.userId,apiKeyId:principal.apiKeyId},args=[principal.tenantId,principal.userId,principal.apiKeyId,p.id];
   const row=(await c.query('SELECT state_text,state_sha256,revision,lease_token,leased_at FROM public.large_import_jobs173 WHERE tenant_id=$1 AND actor_id=$2 AND api_key_id IS NOT DISTINCT FROM $3::uuid AND id=$4',args)).rows[0];ensure(row,404,'Nie znaleziono własnego zadania');
   const job=decodeState(row.state_text,row.state_sha256);assert(job.id===p.id&&job.revision===Number(row.revision)&&job.core.length>0&&job.core.every(b=>b.request.catalog_id===p.catalog_id));assert.deepEqual(job.principal,connection.scope);assert.deepEqual(JSON.parse(record.spec_text),job.parsing_spec);const binding=JSON.parse(record.binding_text);assert(binding.config.catalog_id===p.catalog_id&&job.raw.id==='large-import-raw/v1:'+binding.blob_id,'finalization-status-original-source-binding');
   const blockers=new Set<string>();if(row.lease_token!==null||row.leased_at!==null)blockers.add('JOB_IN_PROGRESS');
   let complete=true;try{assertFinalizableImport(job,{revision:job.revision,plan_hash:job.plan_hash,pim_batches:Object.keys(job.pim).map(Number),confirmed:true});}catch{complete=false;const known=hasKnownCoreCheckpoint(job)&&Object.values(job.pim).flat().every(a=>(!a.previewAttempted||!!a.preview)&&(!a.applyAttempted||!!a.applied));blockers.add(known?'JOB_IN_PROGRESS':'BUSINESS_OUTCOME_UNKNOWN');}
   const history=await captureRetirementHistory(c as never,root);if(history.contexts.length||history.journal.some(r=>{assert(r.root_key===root&&sha(r.payload_text)===r.payload_sha256);const x=JSON.parse(r.payload_text);return r.kind==='epoch'?x.state!=='CLOSED':r.kind==='member'?!['COMMITTED','ROLLED_BACK'].includes(x.state)||history.xact_status[x.xid]!==x.native_xact_status:!['original','io'].includes(r.kind)||x.state!=='DRAINED';}))blockers.add('ORIGINAL_NOT_DRAINED');
   const pairs={} as Record<'job'|'review',FinalizationPair>;
   for(const kind of ['job','review'] as const){
    const request=record.allocations[kind];assert(request,'finalization-status-current-pair');const rows:Array<{fact:any;expired:boolean}>=(await c.query('SELECT to_jsonb(r) fact,(expires_at<=clock_timestamp()) expired FROM public.large_import_quota_reservations173 r WHERE tenant_id=$1 AND actor_id=$2 AND api_key_id IS NOT DISTINCT FROM $3::uuid AND id=$4',[...args.slice(0,3),request.reservationId])).rows;assert(rows.length===1);const reservation=rows[0].fact;
    assert(reservation.id===request.reservationId&&reservation.request_id===request.requestId&&reservation.kind===kind&&reservation.tenant_id===principal.tenantId&&reservation.actor_id===principal.userId&&reservation.api_key_id===principal.apiKeyId&&reservation.token_hash===sha(request.privateToken)&&String(reservation.raw_ceiling)===String(request.ceiling.raw)&&String(reservation.metadata_ceiling)===String(request.ceiling.metadata)&&String(reservation.objects_ceiling)===String(request.ceiling.objects),'finalization-status-private-native-owner');
    assert(['open','retained','unknown'].includes(reservation.state)&&[null,'ready','absent','quarantined'].includes(reservation.outcome),'finalization-status-pair-state');assert(reservation.state!=='open'||reservation.outcome===null,'finalization-status-open-outcome');pairs[kind]=reservation.outcome==='quarantined'?{state:'unknown',outcome:null}:{state:reservation.state,outcome:reservation.outcome};
    const bounds:{n:string;bytes:string}=(await c.query('SELECT count(*)::text n,coalesce(sum(octet_length(payload_text)),0)::text bytes FROM public.large_import_quota_resources173 WHERE tenant_id=$1 AND reservation_id=$2',[principal.tenantId,request.reservationId])).rows[0];assert(bounds&&/^[0-9]+$/.test(bounds.n)&&BigInt(bounds.n)<=100000n&&/^[0-9]+$/.test(bounds.bytes)&&BigInt(bounds.bytes)<=BigInt(request.ceiling.metadata),'finalization-status-resource-bound');
    const resources:any[]=(await c.query('SELECT to_jsonb(r) fact FROM public.large_import_quota_resources173 r WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY resource_key LIMIT 100001',[principal.tenantId,request.reservationId])).rows.map(r=>r.fact);assert(String(resources.length)===bounds.n);
    if(resources.some(r=>!['settled','released'].includes(r.state)))blockers.add('PENDING_RESOURCES');
    if(reservation.state==='unknown'||reservation.state==='retained'&&reservation.outcome!=='ready')blockers.add('RESERVATION_UNKNOWN');
    if(reservation.state==='open'&&!complete&&rows[0].expired!==false)blockers.add('LEASE_EXPIRED');
    if(reservation.state==='retained'&&reservation.outcome==='ready')await inspectBusinessKnownCloseSnapshot(c,rawRoot,scope,p.id,{reservation,resources});
    else if(reservation.state==='open'&&complete&&!blockers.size)await inspectBusinessQuotaRenewal(c,rawRoot,scope,p.id,{reservation,resources});
   }
   assert.deepEqual(await inspectOwnedAllocationRecord(custody,key),before,'finalization-status-custody-changed');check();await c.query('SET LOCAL ROLE dyna_app');await ports.admit(c,actor,false);check();
   const finalized=pairs.job.state==='retained'&&pairs.job.outcome==='ready'&&pairs.review.state==='retained'&&pairs.review.outcome==='ready'&&!blockers.size;
   result={schema:'large-import-finalization-status/v1',id:job.id,revision:job.revision,plan_hash:job.plan_hash,job:pairs.job,review:pairs.review,finalized,can_continue:!finalized&&!blockers.size,blockers:[...blockers].sort()};
  }catch(e){failed=true;first=e;}
  finally{if(c&&started)try{await c.query('ROLLBACK');}catch(e){report('rollback');if(!failed){failed=true;first=e;}}if(lease)try{await lease.close();}catch(e){report('close');if(!failed){failed=true;first=e;}}if(c&&locked)try{assert.equal((await c.query('SELECT pg_advisory_unlock($1::integer,$2::integer) released',keys)).rows[0]?.released,true);}catch(e){report('close');if(!failed){failed=true;first=e;}}if(c){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([c.end(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('finalization-status-close-unconfirmed')),5000);})]);}catch(e){try{(c as any).connection?.stream?.destroy();}catch{}report('close');if(!failed){failed=true;first=e;}}finally{clearTimeout(timer);}}}
  if(failed)throw first;assert(result);return result;
 }};
}
