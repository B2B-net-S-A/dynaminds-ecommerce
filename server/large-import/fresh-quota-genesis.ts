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
export type FreshQuotaProfile=Readonly<{authorization:'ROOT_EXPLICIT_LOCAL_FRESH_QUOTA_GENESIS';tenant_id:string;user_id:string;global:{raw_limit:67108864;metadata_limit:134217728;objects_limit:10000;daily_limit:100;lease_seconds:3600};tenant:{raw_limit:1048576;metadata_limit:67108864;objects_limit:2048;daily_limit:20;lease_seconds:3600}}>;
type Ref={path:string;sha256:string;bytes:number};
export type FreshQuotaInput={profile:FreshQuotaProfile;roots:Readonly<{raw:string;controlPlane:string}>;outputDirectory:string;original:FastifyRequest;startup:ReviewedStartup;connectOwner:Ports['connectOwner'];sessionName:'dyna_session';readOnly:false};
const tables=['large_import_blobs173','large_import_parts173','large_import_batches173','large_import_jobs173','large_import_events173','large_import_core_reviews173','large_import_quota_reservations173','large_import_quota_resources173','large_import_quota_terminal_witnesses173','large_import_quota_terminal_receipts173'] as const;
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const uuid=(x:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const integer=(x:unknown)=>typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x);
export function validateFreshQuotaProfile(p:FreshQuotaProfile){
 assert(p.authorization==='ROOT_EXPLICIT_LOCAL_FRESH_QUOTA_GENESIS'&&uuid(p.tenant_id)&&uuid(p.user_id));
 assert.deepEqual(p.global,{raw_limit:67108864,metadata_limit:134217728,objects_limit:10000,daily_limit:100,lease_seconds:3600});
 assert.deepEqual(p.tenant,{raw_limit:1048576,metadata_limit:67108864,objects_limit:2048,daily_limit:20,lease_seconds:3600});
 for(const k of ['raw_limit','metadata_limit','objects_limit','daily_limit']as const)assert(p.tenant[k]>0&&p.tenant[k]<=p.global[k]);
}
async function syncDirectory(path:string){const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let first:unknown;try{await fd.sync();}catch(e){first=e;}try{await fd.close();}catch(e){first??=e;}if(first)throw first;}
async function save(path:string,value:unknown):Promise<Ref>{const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let first:unknown;try{await fd.writeFile(bytes);await fd.sync();}catch(e){first=e;}try{await fd.close();}catch(e){first??=e;}if(first)throw first;await syncDirectory(dirname(path));return{path,sha256:hash(bytes),bytes:bytes.length};}
async function emptyRoots(roots:string[]){const facts=[];for(const path of roots){const st=await lstat(path);assert(st.isDirectory()&&!st.isSymbolicLink()&&(st.mode&0o777)===0o700&&await realpath(path)===path);if(process.getuid)assert.equal(st.uid,process.getuid());assert.deepEqual(await readdir(path),[],'fresh-genesis-root-not-empty');facts.push({path,dev:st.dev,ino:st.ino});}return facts;}
function safeError(e:unknown){const x=e as {name?:unknown;code?:unknown};return{name:typeof x?.name==='string'?x.name:'Error',code:typeof x?.code==='string'?x.code:null};}
/** Owner-only absent genesis, not a public policy editor. Two policies, no resources/reservations. */
export async function provisionFreshAcceptanceQuota(input:FreshQuotaInput){
 const profile=structuredClone(input.profile),roots=[input.roots.raw,input.roots.controlPlane],out=input.outputDirectory,original=input.original,startup=input.startup,connectOwner=input.connectOwner,sessionName=input.sessionName,readOnly=input.readOnly;
 validateFreshQuotaProfile(profile);assert(readOnly===false&&sessionName==='dyna_session'&&typeof connectOwner==='function');
 assert(out===resolve(out)&&roots.every(p=>p===resolve(p))&&roots[0]!==roots[1]&&!roots.some((a,i)=>roots.some((b,j)=>i!==j&&a.startsWith(b+'/')))&&!roots.some(p=>out===p||out.startsWith(p+'/')));
 let client:Awaited<ReturnType<Ports['connectOwner']>>|undefined,outputOwned=false,active=false,sent=false,commitAttempted=false,committed=false,first:unknown;const cleanup:ReturnType<typeof safeError>[]=[];const artifacts:Ref[]=[];let result:unknown;
 const transport=createDedicatedMetadataTransport({connectOwner,expectedOwner:'postgres',sessionName,cleanupFailure:e=>cleanup.push(safeError(e)),preflightOwner173:async c=>{await c.query("SET SESSION statement_timeout='8s'");await c.query("SET SESSION lock_timeout='8s'");await c.query("SET SESSION timezone='UTC'");await inspectCompositeStartup(c,startup);return'VALID';}});
 const actor=transport.capture(original);assert(actor.role==='admin'&&!actor.apiKeyId&&actor.tenantId===profile.tenant_id&&actor.userId===profile.user_id,'fresh-original-admin-session');const bound=transport.bind(actor);
 try{
  const parent=await lstat(dirname(out));assert(parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o777)===0o700&&await realpath(dirname(out))===dirname(out));if(process.getuid)assert.equal(parent.uid,process.getuid());
  await mkdir(out,{mode:0o700});outputOwned=true;await syncDirectory(dirname(out));const beforeRoots=await emptyRoots(roots);
  client=await bound.ports.connect(bound.scope);await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');active=true;await bound.ports.admit(client,bound.scope);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('large-import173:quota:global',0))");await client.query("SELECT pg_advisory_xact_lock(hashtextextended('large-import173:quota:tenant:'||$1,0))",[profile.tenant_id]);await client.query('SET LOCAL ROLE NONE');
  const context=(await client.query("SELECT current_user::text role,session_user::text session_role,current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') readonly,current_setting('statement_timeout') timeout,current_setting('jit') jit,(clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day")).rows[0];
  assert(context?.role==='postgres'&&context.session_role==='postgres'&&context.isolation==='read committed'&&context.readonly==='off'&&context.timeout==='8s'&&context.jit==='off'&&/^\d{4}-\d{2}-\d{2}$/.test(context.day));
  const zeroCut=async()=>{const cut=[];for(const table of [...tables,'large_import_quota_policies173']){const x=(await client!.query(`SELECT count(*)::text n FROM public.${table}`)).rows[0];assert(x?.n==='0','fresh-genesis-native-not-empty');cut.push({table,rows:0});}return cut;};
  const before=await zeroCut();const inventory={schema:'LOCAL_FRESH_GLOBAL_AND_TENANT_ZERO_INVENTORY/v1',tenant_id:profile.tenant_id,native:before,raw_metadata_root:beforeRoots[0],control_plane_custody_root:beforeRoots[1]};const inventorySha=hash(JSON.stringify(inventory));
  await client.query('SET LOCAL ROLE dyna_app');await bound.ports.admit(client,bound.scope);await client.query('SET LOCAL ROLE NONE');assert.deepEqual(await zeroCut(),before);assert.deepEqual(await emptyRoots(roots),beforeRoots);
  artifacts.push(await save(join(out,'intent.private.json'),{profile,inventory_sha256:inventorySha,native_zero_cut:before,roots:beforeRoots,day:context.day,scope:'TWO_ABSENT_POLICIES_ONLY_NO_ALLOCATION_NO_OLD_CUT'}));
  sent=true;const rows=[];
  for(const [scope,limits]of [['global',profile.global],['tenant:'+profile.tenant_id,profile.tenant]]as const){
   const expected:Policy={scope,...Object.fromEntries(Object.entries(limits).filter(([k])=>k!=='lease_seconds').map(([k,v])=>[k,String(v)])),baseline_raw:'0',baseline_metadata:'0',baseline_objects:'0',baseline_day:context.day,baseline_daily:'0',inventory_sha256:inventorySha,lease_seconds:limits.lease_seconds}as Policy;
   const ack:Policy[]=(await client.query("INSERT INTO public.large_import_quota_policies173(scope,raw_limit,metadata_limit,objects_limit,daily_limit,baseline_raw,baseline_metadata,baseline_objects,baseline_day,baseline_daily,inventory_sha256,lease_seconds) VALUES($1,$2,$3,$4,$5,0,0,0,$6::date,0,$7,$8) RETURNING scope,raw_limit::text,metadata_limit::text,objects_limit::text,daily_limit::text,baseline_raw::text,baseline_metadata::text,baseline_objects::text,baseline_day::text,baseline_daily::text,inventory_sha256,lease_seconds",[scope,limits.raw_limit,limits.metadata_limit,limits.objects_limit,limits.daily_limit,context.day,inventorySha,limits.lease_seconds])).rows;assert(ack.length===1);assert.deepEqual(ack[0],expected);rows.push(ack[0]);
  }
  artifacts.push(await save(join(out,'insert-ack.private.json'),{status:'TWO_INSERT_ACK_UNCOMMITTED',rows}));
  for(const table of tables)assert((await client.query(`SELECT count(*)::text n FROM public.${table}`)).rows[0]?.n==='0','fresh-genesis-allocation-appeared');
  const observed=(await client.query("SELECT scope,raw_limit::text,metadata_limit::text,objects_limit::text,daily_limit::text,baseline_raw::text,baseline_metadata::text,baseline_objects::text,baseline_day::text,baseline_daily::text,inventory_sha256,lease_seconds FROM public.large_import_quota_policies173 ORDER BY scope")).rows;assert.deepEqual(observed,rows);assert.deepEqual(await emptyRoots(roots),beforeRoots);
  await client.query('SET LOCAL ROLE dyna_app');await bound.ports.admit(client,bound.scope);commitAttempted=true;await client.query('COMMIT');active=false;committed=true;
  artifacts.push(await save(join(out,'commit-ack.private.json'),{status:'COMMIT_ACK',rows}));result={status:'FRESH_TWO_POLICY_GENESIS_OBSERVED',policy_count:2,inventory_sha256:inventorySha,public_available:false};
 }catch(e){first=e;}finally{
  if(active&&client)try{await client.query('ROLLBACK');active=false;}catch(e){cleanup.push(safeError(e));first??=e;}
  if(client)try{await client.end();}catch(e){cleanup.push(safeError(e));first??=e;}
 }
 const uncertain=!committed&&(commitAttempted||(sent&&active));let receipt:Ref|undefined;if(outputOwned)try{receipt=await save(join(out,'result.private.json'),{result:result??null,sent,committed,commit_attempted:commitAttempted,uncertain,first_error:first?safeError(first):null,cleanup,artifacts});}catch(e){first??=e;}
 if(first)throw Object.assign(new Error('fresh-quota-genesis-failed'),{cause:first,receipt,sent,committed,unknown:uncertain});assert(committed&&receipt&&cleanup.length===0);return{receipt,result};
}
