/** Charged, unusable unknown reservation inspection only. Normal OPEN checkpoint and renewal remain unchanged.
 * Never resolves an outcome, reopens a reservation, changes a ceiling or mints Native authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {auditPrivilegedCurrentProtocolHistory} from './complete-history';
import {retirementRootKey} from './unallocated-upload-retirement';
import {inspectBusinessChargedUnknown,type Scope} from './quota-renewal-inspection';
import {inspectRetainedRawCheckpoint}from'./retained-raw-checkpoint';
import type{SourceOriginalLineage}from'./complete-history';
import {inspectOwnedAllocationRecord,assertOwnedAllocationCustody,type createOwnedAllocationCustody} from './owned-allocation-custody';
import {decodeState} from '../../shared/large-import-dependencies/pim-large-import-core-native-head-codec-backend/state-codec';
import {inspectCompositeStartup,type ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import type {Client} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/storage';
export type ChargedUnknownBusinessInput={startup:ReviewedStartup;rawRoot:string;controlPlaneRoot:string;database:string;scope:Scope;catalogId:string;jobId:string;kind:'job'|'review';custody:Awaited<ReturnType<typeof createOwnedAllocationCustody>>;
 /** Source-captured original request lineage; never SELECTed observed hashes or HTTP input. */
 sourceLineage:readonly SourceOriginalLineage[];signal:AbortSignal};
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
/** SAME caller-owned canonical PG client and already-held exclusive root+schema RRRO
 * scope. Full protocol auditor checks zero contexts, every epoch CLOSED and original/
 * member/IO terminal with exact charge/capacity and Source original-hash membership.
 * Semantic inspector checks every job revision/event/review/resource/private witness,
 * no job lease and physical absence of settled witness locks. Only one final release INTENT may remain unresolved: an exact current-fence matched claim, or an explicit next-fence proposal with no claim resource. Neither is a Native ACK; the full drained Source protocol audit remains mandatory.
 */
export async function inspectChargedUnknownBusiness(c:Client,input:ChargedUnknownBusinessInput){
 const x={...input,scope:structuredClone(input.scope),sourceLineage:structuredClone(input.sourceLineage)};
 assert(x.rawRoot===resolve(x.rawRoot)&&x.controlPlaneRoot===resolve(x.controlPlaneRoot)&&x.rawRoot!==x.controlPlaneRoot,'partial-checkpoint-canonical-roots');
 const sourceRequestHashes=x.sourceLineage.map(r=>r.original_hash);
 assert(/^[A-Za-z0-9_]+$/.test(x.database)&&x.signal instanceof AbortSignal,'partial-checkpoint-local-input');
 assertOwnedAllocationCustody(x.custody,x.controlPlaneRoot);x.signal.throwIfAborted();const root=retirementRootKey(x.database,x.rawRoot,x.controlPlaneRoot);
 const cut=await auditPrivilegedCurrentProtocolHistory(c as never,{root,tenantId:x.scope.tenantId,userId:x.scope.actorId,requestHashes:sourceRequestHashes,sourceLineage:x.sourceLineage,signal:x.signal});
 await inspectCompositeStartup(c,x.startup);
 assert.equal((await c.query('SELECT public.ordinary203_quota_renew_valid() valid')).rows[0]?.valid,true,'partial-checkpoint-genuine-native203-required');
 const ro=(await c.query("SELECT current_user role,current_database() database,current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation")).rows[0];
 assert(ro?.role==='postgres'&&ro.database===x.database&&ro.ro==='on'&&ro.isolation==='repeatable read','partial-checkpoint-same-owner-RRRO');
 const locks=new Set(['SELECT id FROM public.large_import_jobs173 WHERE tenant_id=$1 AND actor_id=$2 AND api_key_id IS NOT DISTINCT FROM $3::uuid AND id=$4 FOR SHARE','SELECT sequence FROM public.large_import_events173 WHERE tenant_id=$1 AND job_id=$2 ORDER BY sequence FOR SHARE','SELECT revision FROM public.large_import_core_reviews173 WHERE tenant_id=$1 AND job_id=$2 ORDER BY revision FOR SHARE','SELECT * FROM public.large_import_blobs173 WHERE tenant_id=$1 AND actor_id=$2 AND api_key_id IS NOT DISTINCT FROM $3::uuid AND id=$4 FOR SHARE','SELECT * FROM public.large_import_parts173 WHERE tenant_id=$1 AND blob_id=$2 ORDER BY offset_bytes FOR SHARE']);
 const reader:Client={query:(sql,args)=>{x.signal.throwIfAborted();assert(sql.startsWith('SELECT '),'partial-checkpoint-SELECT-only');assert(!sql.includes('FOR SHARE')||locks.has(sql),'partial-checkpoint-exact-read-lock-query');return c.query(locks.has(sql)?sql.slice(0,-10):sql,args);},end:()=>{throw Error('partial-checkpoint-caller-owns-client');}};
 assert(x.kind==='job'||x.kind==='review','partial-checkpoint-business-kind');
 const key={tenantId:x.scope.tenantId,userId:x.scope.actorId,apiKeyId:x.scope.apiKeyId,catalogId:x.catalogId,kind:'job' as const,publicId:x.jobId};
 const custody=await inspectOwnedAllocationRecord(x.custody,key),record=custody.record,request=record.allocations[x.kind];assert(request&&request.kind===x.kind,'partial-checkpoint-genuine-current-custody');
 const row=(await reader.query('SELECT to_jsonb(r) fact FROM public.large_import_quota_reservations173 r WHERE tenant_id=$1 AND actor_id=$2 AND api_key_id IS NOT DISTINCT FROM $3::uuid AND id=$4',[x.scope.tenantId,x.scope.actorId,x.scope.apiKeyId,request.reservationId])).rows;
 assert(row.length===1,'partial-checkpoint-owned-reservation');const reservation=row[0].fact;
 assert(reservation.id===request.reservationId&&reservation.request_id===request.requestId&&reservation.token_hash===sha(request.privateToken)&&reservation.kind===x.kind&&reservation.tenant_id===x.scope.tenantId&&reservation.actor_id===x.scope.actorId&&reservation.api_key_id===x.scope.apiKeyId&&reservation.state==='unknown'&&reservation.outcome===null&&String(reservation.raw_ceiling)==='0'&&String(reservation.metadata_ceiling)===String(request.ceiling.metadata)&&String(reservation.objects_ceiling)===String(request.ceiling.objects),'partial-checkpoint-native-private-owner');
 const bounds=(await reader.query('SELECT count(*)::text rows,coalesce(sum(octet_length(payload_text)),0)::text bytes FROM public.large_import_quota_resources173 WHERE tenant_id=$1 AND reservation_id=$2',[x.scope.tenantId,request.reservationId])).rows[0];
 assert(bounds&&/^[0-9]+$/.test(bounds.rows)&&/^[0-9]+$/.test(bounds.bytes)&&(x.kind==='review'||BigInt(bounds.rows)>0n)&&BigInt(bounds.rows)<=100000n&&BigInt(bounds.bytes)<=BigInt(request.ceiling.metadata),'partial-checkpoint-native-resource-bound');
 const resources=(await reader.query('SELECT to_jsonb(r) fact FROM public.large_import_quota_resources173 r WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY resource_key LIMIT 100001',[x.scope.tenantId,request.reservationId])).rows.map(r=>r.fact);assert(String(resources.length)===bounds.rows,'partial-checkpoint-no-resource-truncation');
 if(resources.length===0){assert(x.kind==='review'&&String(reservation.raw_charge)==='0'&&String(reservation.metadata_charge)==='0'&&String(reservation.objects_charge)==='0','partial-checkpoint-empty-review-zero-charge');const reviews=(await reader.query('SELECT count(*)::text n FROM public.large_import_core_reviews173 WHERE tenant_id=$1 AND job_id=$2',[x.scope.tenantId,x.jobId])).rows;assert(reviews.length===1&&reviews[0].n==='0','partial-checkpoint-empty-review-no-native-review');}
 const proof=await inspectBusinessChargedUnknown(reader,x.rawRoot,x.scope,x.jobId,{reservation,resources});
 const job=decodeState(proof.metadata_cut.job.state_text,proof.metadata_cut.job.state_sha256);
 const binding=JSON.parse(record.binding_text);assert(binding&&Object.keys(binding).sort().join(',')==='blob_id,config,upload_key'&&binding.config.catalog_id===x.catalogId,'partial-checkpoint-original-source-binding');
 assert.deepEqual(JSON.parse(record.spec_text),job.parsing_spec,'partial-checkpoint-original-parsing-spec');
 await inspectRetainedRawCheckpoint(reader,x.rawRoot,x.scope,binding.blob_id,x.catalogId,binding.upload_key,{schema:'retained-large-import-upload/v1',status:'UPLOAD_RETAINED_READY_NOT_NATIVE_APPROVED',blob_id:binding.blob_id,raw:job.raw,manifest:job.manifest,spec:job.parsing_spec,whole_native_preview:'OPEN'});
 assert(job.core.every(b=>b.request.catalog_id===x.catalogId),'partial-checkpoint-one-catalog');assert.deepEqual(await inspectOwnedAllocationRecord(x.custody,key),custody,'partial-checkpoint-custody-changed');
 const completedCore=job.core.flatMap((b,n)=>b.execution?[n]:[]),remainingCore=job.core.flatMap((b,n)=>b.execution?[]:[n]);
 // Reconfirm ALL history at the same held snapshot/root after every filesystem await.
 assert.deepEqual(await auditPrivilegedCurrentProtocolHistory(c as never,{root,tenantId:x.scope.tenantId,userId:x.scope.actorId,requestHashes:sourceRequestHashes,sourceLineage:x.sourceLineage,signal:x.signal}),cut,'partial-checkpoint-protocol-changed');
 x.signal.throwIfAborted();
 return Object.freeze({schema:'owned-charged-unknown-business-unusable/v1' as const,job_id:job.id,revision:job.revision,job_sha256:sha(proof.metadata_cut.job.state_text),plan_hash:job.plan_hash,
  completed_core_batches:completedCore,remaining_core_batches:remainingCore,proof,protocol:cut,
  classification:'ATTRIBUTED_CHARGED_UNKNOWN_BUSINESS_UNUSABLE' as const,native_reservation:structuredClone(reservation),native_reservation_sha256:sha(JSON.stringify(reservation)),
  effective_charge:{raw:String(reservation.raw_ceiling),metadata:String(reservation.metadata_ceiling),objects:String(reservation.objects_ceiling)},
  unresolved_resources:structuredClone(proof.unresolved_resources),
  unresolved_proposed_releases:structuredClone(proof.unresolved_proposed_releases),
  usable:false as const,outcomes_resolved:false as const,original_writes_denied_by_native_open_guard:true as const,native203_feature_verified:true as const,
  native_authority:false as const,public_ready:false as const,mutations_performed:0 as const});
}
