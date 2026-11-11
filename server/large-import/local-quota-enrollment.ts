/** Export-only LOCAL OPERATOR enrollment. No route, default pool, native schema or public entitlement. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,mkdir,readdir,realpath} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import type {FastifyRequest} from 'fastify';
import {createDedicatedMetadataTransport,type Ports} from '../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
import {inspectCompositeStartup,type ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';

type Policy={scope:string;raw_limit:string;metadata_limit:string;objects_limit:string;daily_limit:string;baseline_raw:string;baseline_metadata:string;baseline_objects:string;baseline_day:string;baseline_daily:string;inventory_sha256:string;lease_seconds:number};
export type LocalQuotaProfile=Readonly<{authorization:'ROOT_APPROVED_LOCAL_ACCEPTANCE_PROFILE';tenant_id:string;user_id:string;raw_limit:1048576;metadata_limit:67108864;objects_limit:2048;daily_limit:20;lease_seconds:3600}>;
export type LocalQuotaPlan=Readonly<{authorization:'ROOT_REVIEWED_BOUNDED_ACCEPTANCE_CASE';raw:12288;metadata:3670016;objects:1408;daily:7}>;
type Ref={path:string;sha256:string;bytes:number};
export type EnrollmentInput={authorization:'ROOT_LOCAL_ACCEPTANCE_MISSING_TENANT_POLICY_ONLY';profile:LocalQuotaProfile;plannedCase:LocalQuotaPlan;expectedGlobalPolicy:Policy;roots:readonly string[];outputDirectory:string;original:FastifyRequest;startup:ReviewedStartup;connectOwner:Ports['connectOwner'];sessionName:string;readOnly:boolean};
const tables=['large_import_blobs173','large_import_parts173','large_import_batches173','large_import_jobs173','large_import_events173','large_import_core_reviews173','large_import_quota_reservations173','large_import_quota_resources173','large_import_quota_terminal_witnesses173','large_import_quota_terminal_receipts173'] as const;
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const uuid=(x:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const integer=(x:unknown)=>typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x);
function policy(x:Policy){assert(x.scope==='global');for(const n of ['raw_limit','metadata_limit','objects_limit','daily_limit','baseline_raw','baseline_metadata','baseline_objects','baseline_daily'] as const)assert(integer(x[n]));assert(/^\d{4}-\d{2}-\d{2}$/.test(x.baseline_day)&&/^[a-f0-9]{64}$/.test(x.inventory_sha256));assert(Number.isInteger(x.lease_seconds)&&x.lease_seconds>=30&&x.lease_seconds<=86400);}
export function validateLocalQuotaProfile(p:LocalQuotaProfile,g:Policy){
 assert(p.authorization==='ROOT_APPROVED_LOCAL_ACCEPTANCE_PROFILE'&&uuid(p.tenant_id)&&uuid(p.user_id));
 assert(p.raw_limit===1048576&&p.metadata_limit===67108864&&p.objects_limit===2048);
 assert(p.daily_limit===20&&p.lease_seconds===3600);policy(g);
 for(const k of ['raw_limit','metadata_limit','objects_limit','daily_limit'] as const)assert(BigInt(p[k])<=BigInt(g[k]),'local-profile-exceeds-global-policy');
 assert(p.lease_seconds<=g.lease_seconds,'local-profile-lease-exceeds-global');
}
async function syncDirectory(path:string){const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let first:unknown;try{await fd.sync();}catch(e){first=e;}try{await fd.close();}catch(e){first??=e;}if(first)throw first;}
async function save(path:string,value:unknown):Promise<Ref>{const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let first:unknown;try{await fd.writeFile(bytes);await fd.sync();}catch(e){first=e;}try{await fd.close();}catch(e){first??=e;}if(first)throw first;await syncDirectory(dirname(path));return{path,sha256:hash(bytes),bytes:bytes.length};}
async function rootCut(roots:string[],tenant:string){const facts=[];for(const path of roots){const st=await lstat(path);assert(st.isDirectory()&&!st.isSymbolicLink()&&(st.mode&0o777)===0o700&&await realpath(path)===path);if(process.getuid)assert.equal(st.uid,process.getuid());const names=(await readdir(path)).sort();assert(!names.includes(tenant),'local-enrollment-tenant-filesystem-not-empty');facts.push({path,dev:st.dev,ino:st.ino,names});}return facts;}
function safeError(e:unknown){const x=e as {name?:unknown;code?:unknown};return{name:typeof x?.name==='string'?x.name:'Error',code:typeof x?.code==='string'?x.code:null};}
/** The native connection belongs to this invocation; query failures always propagate their first cause. */
export async function enrollLocalAcceptanceQuota(input:EnrollmentInput){
 // Snapshot every caller value/callback/reference before the first await.
 const authorization=input.authorization,profile=structuredClone(input.profile),planned=structuredClone(input.plannedCase),global=structuredClone(input.expectedGlobalPolicy),roots=[...input.roots],out=input.outputDirectory,original=input.original,startup=input.startup,connectOwner=input.connectOwner,sessionName=input.sessionName,readOnly=input.readOnly;
 assert(authorization==='ROOT_LOCAL_ACCEPTANCE_MISSING_TENANT_POLICY_ONLY'&&readOnly===false&&typeof connectOwner==='function');validateLocalQuotaProfile(profile,global);
 assert(planned.authorization==='ROOT_REVIEWED_BOUNDED_ACCEPTANCE_CASE'&&planned.raw===12288&&planned.metadata===3670016&&planned.objects===1408&&planned.daily===7);
 assert(planned.raw<=profile.raw_limit&&planned.metadata<=profile.metadata_limit&&planned.objects<=profile.objects_limit&&planned.daily<=profile.daily_limit);
 assert(out===resolve(out)&&roots.length>0&&roots.length<=8&&new Set(roots).size===roots.length&&roots.every(p=>p===resolve(p)));
 assert(!roots.some((a,i)=>roots.some((b,j)=>i!==j&&(a.startsWith(b+'/')||b.startsWith(a+'/'))))&&!roots.some(p=>out===p||out.startsWith(p+'/')));
 let client:Awaited<ReturnType<Ports['connectOwner']>>|undefined,outputOwned=false,active=false,sent=false,commitAttempted=false,committed=false,first:unknown;const cleanup:ReturnType<typeof safeError>[]=[];let result:unknown;const artifacts:Ref[]=[];
 const transport=createDedicatedMetadataTransport({connectOwner,expectedOwner:'postgres',sessionName,cleanupFailure:e=>{cleanup.push(safeError(e));},preflightOwner173:async c=>{await c.query("SET SESSION statement_timeout='8s'");await c.query("SET SESSION lock_timeout='8s'");await c.query("SET SESSION timezone='UTC'");await inspectCompositeStartup(c,startup);return 'VALID';}});
 const actor=transport.capture(original);assert(actor.role==='admin'&&!actor.apiKeyId&&actor.tenantId===profile.tenant_id&&actor.userId===profile.user_id,'local-enrollment-original-session-principal');
 const bound=transport.bind(actor);
 try{
  const parent=await lstat(dirname(out));assert(parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o777)===0o700&&await realpath(dirname(out))===dirname(out));if(process.getuid)assert.equal(parent.uid,process.getuid());
  await mkdir(out,{mode:0o700});outputOwned=true;await syncDirectory(dirname(out));const outputStat=await lstat(out);assert(outputStat.isDirectory()&&!outputStat.isSymbolicLink()&&(outputStat.mode&0o777)===0o700&&await realpath(out)===out);if(process.getuid)assert.equal(outputStat.uid,process.getuid());
  const beforeRoots=await rootCut(roots,profile.tenant_id);
  client=await bound.ports.connect(bound.scope);await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');active=true;await bound.ports.admit(client,bound.scope);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('large-import173:quota:global',0))");await client.query("SELECT pg_advisory_xact_lock(hashtextextended('large-import173:quota:tenant:'||$1,0))",[profile.tenant_id]);
  await client.query('SET LOCAL ROLE NONE');
  const context=(await client.query("SELECT current_user::text role,session_user::text session_role,current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') readonly,current_setting('statement_timeout') timeout,current_setting('jit') jit")).rows[0];assert(context?.role==='postgres'&&context.session_role==='postgres'&&context.isolation==='read committed'&&context.readonly==='off'&&context.timeout==='8s'&&context.jit==='off');
  const getGlobal=async()=>{const r=(await client!.query("SELECT scope,raw_limit::text,metadata_limit::text,objects_limit::text,daily_limit::text,baseline_raw::text,baseline_metadata::text,baseline_objects::text,baseline_day::text,baseline_daily::text,inventory_sha256,lease_seconds FROM public.large_import_quota_policies173 WHERE scope='global' FOR SHARE")).rows;assert(r.length===1,'local-enrollment-global-policy-required');assert.deepEqual(r[0],global,'local-enrollment-approved-global-policy-drift');return r[0];};
  await getGlobal();assert((await client.query('SELECT count(*)::text n FROM public.large_import_quota_policies173 WHERE scope=$1',['tenant:'+profile.tenant_id])).rows[0]?.n==='0','local-enrollment-missing-only');
  const cut=async()=>{const rows=[];for(const t of tables){const limits=(await client!.query(`SELECT count(*)::text n,coalesce(sum(pg_column_size(r)),0)::text bytes,count(*) FILTER(WHERE tenant_id=$1)::text tenant_rows FROM public.${t} r`,[profile.tenant_id])).rows[0];assert(limits&&integer(limits.n)&&BigInt(limits.n)<=100000n&&integer(limits.bytes)&&BigInt(limits.bytes)<=67108864n&&limits.tenant_rows==='0','local-enrollment-fresh-tenant-native-not-empty');const r=(await client!.query(`SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text,'UTF8')),'hex') sha256 FROM public.${t} r`)).rows[0];assert(/^[a-f0-9]{64}$/.test(r?.sha256));rows.push({table:t,count:limits.n,sha256:r.sha256});}return rows;};
  const policies=async()=>(await client!.query("SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY scope),'[]'::jsonb)::text,'UTF8')),'hex') sha256 FROM public.large_import_quota_policies173 r WHERE scope<>$1",['tenant:'+profile.tenant_id])).rows[0];
  const before=await cut(),policiesBefore=await policies();assert(/^[a-f0-9]{64}$/.test(policiesBefore?.sha256));
  const usage=(await client.query("SELECT coalesce(sum(CASE WHEN state='retained' THEN raw_charge ELSE raw_ceiling END),0)::text raw,coalesce(sum(CASE WHEN state='retained' THEN metadata_charge ELSE metadata_ceiling END),0)::text metadata,coalesce(sum(CASE WHEN state='retained' THEN objects_charge ELSE objects_ceiling END),0)::text objects,count(*) FILTER(WHERE(opened_at AT TIME ZONE 'UTC')::date=(clock_timestamp() AT TIME ZONE 'UTC')::date)::text daily,(clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day FROM public.large_import_quota_reservations173")).rows[0];assert(usage&&['raw','metadata','objects','daily'].every(k=>integer(usage[k])));
  // Policy limits authorize an upper bound; they are NOT allocated reservations.
  // This explicit case is a read-only planning screen. Every later reservation still performs native fresh checks.
  for(const [u,b,l] of [['raw','baseline_raw','raw_limit'],['metadata','baseline_metadata','metadata_limit'],['objects','baseline_objects','objects_limit']] as const)assert(BigInt(usage[u])+BigInt(global[b])+BigInt(planned[u])<=BigInt(global[l]),'local-enrollment-planned-case-global-capacity');
  assert(BigInt(usage.daily)+(global.baseline_day===usage.day?BigInt(global.baseline_daily):0n)+BigInt(planned.daily)<=BigInt(global.daily_limit),'local-enrollment-planned-case-global-daily-capacity');
  const inventory={schema:'LOCAL_ACCEPTANCE_NEW_TENANT_ZERO_RETAINED_INVENTORY/v1',tenant_id:profile.tenant_id,rows:tables.map(table=>({table,rows:0})),roots:beforeRoots};const inventorySha=hash(JSON.stringify(inventory));
  await client.query('SET LOCAL ROLE dyna_app');await bound.ports.admit(client,bound.scope);await client.query('SET LOCAL ROLE NONE');assert.deepEqual(await rootCut(roots,profile.tenant_id),beforeRoots);
  artifacts.push(await save(join(out,'intent.private.json'),{authorization,profile,planned_case:planned,planning_usage:usage,planning_is_not_reservation:true,expected_global_sha256:hash(JSON.stringify(global)),inventory_sha256:inventorySha,before,policies:policiesBefore,scope:'ONE_MISSING_TENANT_POLICY_ONLY_NO_ALLOCATION_NO_GLOBAL_CHANGE'}));
  sent=true;
  const ack=(await client.query("INSERT INTO public.large_import_quota_policies173(scope,raw_limit,metadata_limit,objects_limit,daily_limit,baseline_raw,baseline_metadata,baseline_objects,baseline_day,baseline_daily,inventory_sha256,lease_seconds) VALUES($1,$2,$3,$4,$5,0,0,0,(clock_timestamp() AT TIME ZONE 'UTC')::date,0,$6,$7) RETURNING scope,raw_limit::text,metadata_limit::text,objects_limit::text,daily_limit::text,baseline_raw::text,baseline_metadata::text,baseline_objects::text,baseline_day::text,baseline_daily::text,inventory_sha256,lease_seconds",['tenant:'+profile.tenant_id,profile.raw_limit,profile.metadata_limit,profile.objects_limit,profile.daily_limit,inventorySha,profile.lease_seconds])).rows;assert(ack.length===1);
  assert.deepEqual(ack[0],{scope:'tenant:'+profile.tenant_id,raw_limit:String(profile.raw_limit),metadata_limit:String(profile.metadata_limit),objects_limit:String(profile.objects_limit),daily_limit:String(profile.daily_limit),baseline_raw:'0',baseline_metadata:'0',baseline_objects:'0',baseline_day:usage.day,baseline_daily:'0',inventory_sha256:inventorySha,lease_seconds:profile.lease_seconds});
  artifacts.push(await save(join(out,'insert-ack.private.json'),{status:'INSERT_ACK_UNCOMMITTED',policy:ack[0]}));
  await getGlobal();assert.deepEqual(await policies(),policiesBefore);assert.deepEqual(await cut(),before);assert.deepEqual(await rootCut(roots,profile.tenant_id),beforeRoots);
  await client.query('SET LOCAL ROLE dyna_app');await bound.ports.admit(client,bound.scope);commitAttempted=true;await client.query('COMMIT');active=false;committed=true;
  artifacts.push(await save(join(out,'commit-ack.private.json'),{status:'COMMIT_ACK',policy:ack[0]}));result={status:'LOCAL_ACCEPTANCE_TENANT_QUOTA_ENROLLED',policy:ack[0],global_unchanged:true,old_import_rows_unchanged:true,roots_unchanged:true,public_availability:false};
 }catch(e){first=e;}
 finally{
  if(active&&client)try{await client.query('ROLLBACK');active=false;}catch(e){cleanup.push(safeError(e));first??=e;}
  if(client)try{await client.end();}catch(e){cleanup.push(safeError(e));first??=e;}
 }
 const uncertain=!committed&&(commitAttempted||(sent&&active));
 let receipt:Ref|undefined;if(outputOwned)try{receipt=await save(join(out,'result.private.json'),{result:result??null,sent,commit_attempted:commitAttempted,committed,uncertain,first_error:first?safeError(first):null,cleanup,artifacts});}catch(e){first??=e;}
 if(first){const error=Object.assign(new Error('local-quota-enrollment-failed'),{cause:first,receipt,sent,committed,unknown:uncertain});throw error;}
 assert(receipt&&committed);return{receipt,result};
}

export {provisionFullAcceptanceQuota187} from './full-local-quota-genesis187';

export {reviseLocalOperationalBudget,recommendedOperationalProfile,policyHash} from './operational-budget';
export {auditPrivilegedCurrentProtocolHistory} from './complete-history';

/** Private operator capture only; no HTTP baseline setter or entitlement. */
export {captureLegacyQuarantine,openLegacyQuarantine} from './legacy-quarantine';
export type {LegacyRef,LegacyRoots,CurrentRoots,LegacyQuarantine} from './legacy-quarantine';

/** Private operator successor and genuine same-emitted continuation constructors; no HTTP setter. */
export {reattestLegacyQuarantine} from './legacy-re-attestation';
export type {LegacyReattestationInput,LegacyReviewedSourceChange} from './legacy-re-attestation';
export {createOwnedAllocationCustody} from './owned-allocation-custody';
export {createSourceOriginalJournal} from './source-original-journal';

/** Quiescent Root-only Main V1 → reviewed V2 operator; no importer publication. */
export {reattestLegacyV1ToV2} from './legacy-v2-successor';
export type {LegacyV2SuccessorInput,LegacyV2ReviewedDiff} from './legacy-v2-successor';
