/** Explicit source-owned local operator action. No default route, IO at import, retry or token adoption.
 * Requires current coherent Native201/Startup, normal authenticated admin original request,
 * exact approved intent and exclusive root/schema fences. Root supplies a fresh dedicated
 * canonical owner connector with connection/query timeouts and an owned OS watchdog.
 * Source whole-cut caps remain10000rows/8MiB; this operator refuses above them. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {Client} from 'pg';
import type {FastifyRequest} from 'fastify';
import {createDedicatedMetadataTransport,admitOriginalEpochJournal} from '../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
import {createReviewedMetadataPreflight} from './base-application';
import {requireOriginalMetadataBinding} from './original-metadata';
import {createOrdinarySchemaTransactionGate,inspectCompositeStartup,recheckReviewedStartupEvidence,type ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
type EpochRow={root_key:string;epoch:string;id:string;kind:'epoch'|'original'|'member'|'io';tenant_id:string|null;actor_id:string|null;api_key_id:string|null;payload_text:string;payload_sha256:string;payload_capacity:string;metadata_charge:string;objects_charge:string};
type Expected={root:string;epoch:string;id:string;before_sha256:string;tenant_id:string;actor_id:string};
function validateEmptyCut(rows:EpochRow[],contexts:unknown[],expected:Expected){
 assert(Array.isArray(rows)&&rows.length>0&&rows.length<=10000&&Array.isArray(contexts)&&contexts.length===0);
 const seen=new Set();let target:EpochRow|undefined;let bytes=0;
 for(const r of rows){
  assert(r.root_key===expected.root&&/^[1-9][0-9]*$/.test(r.epoch));
  assert(BigInt(r.epoch)<=BigInt(expected.epoch),'later epoch');
  const identity=r.epoch+':'+r.id;assert(!seen.has(identity));seen.add(identity);
  assert(sha(r.payload_text)===r.payload_sha256&&Buffer.byteLength(r.payload_text)<=32768);
  bytes+=Buffer.byteLength(r.payload_text);assert(bytes<=8388608,'existing full-cut byte limit');
  const p=JSON.parse(r.payload_text);assert(p&&typeof p==='object'&&!Array.isArray(p));assert(BigInt(r.payload_capacity)>=BigInt(Buffer.byteLength(r.payload_text))&&BigInt(r.payload_capacity)<=32768n);
  assert(BigInt(r.metadata_charge)===2n*(BigInt(r.payload_capacity)+(r.kind==='member'?1024n:0n))&&BigInt(r.objects_charge)===(r.kind==='member'?4n:2n));
  if(r.epoch===expected.epoch){assert(!target&&r.kind==='epoch'&&r.id===expected.id&&r.payload_sha256===expected.before_sha256);assert(r.tenant_id===expected.tenant_id&&r.actor_id===expected.actor_id&&r.api_key_id===null&&p.state==='OPEN'&&p.original_count===0);target=r;}
  else assert(r.kind==='epoch'?p.state==='CLOSED':r.kind==='original'||r.kind==='io'?p.state==='DRAINED':r.kind==='member'&&['COMMITTED','ROLLED_BACK'].includes(p.state),'unresolved older row');
 }
 assert(target);return target;
}
function validateOnlyEmptyClosure(before:EpochRow[],after:EpochRow[],expected:Expected,approvalSha:string,releaseSha:string){
 assert(before.length===after.length);const old=new Map(before.map(r=>[r.epoch+':'+r.id,r]));let changed=0;
 for(const r of after){const key=r.epoch+':'+r.id,o=old.get(key);assert(o);old.delete(key);
  if(r.id!==expected.id||r.epoch!==expected.epoch){assert.deepEqual(r,o);continue;}
  changed++;const p=JSON.parse(o.payload_text),q=JSON.parse(r.payload_text),audit=q.empty_bootstrap_reconciliation;
  assert(q.state==='CLOSED'&&typeof q.closed_at==='string'&&audit?.schema==='ordinary187-empty-bootstrap-abort/v1');
  assert.deepEqual(audit,{schema:'ordinary187-empty-bootstrap-abort/v1',before_payload_sha256:expected.before_sha256,operator_approval_sha256:approvalSha,current_release_sha256:releaseSha,reason:'ABANDONED_EMPTY_BOOTSTRAP',business_ACK_proved:false});
  const preserved={...q};delete preserved.closed_at;delete preserved.empty_bootstrap_reconciliation;preserved.state='OPEN';assert.deepEqual(preserved,p);
  assert.deepEqual({...r,payload_text:o.payload_text,payload_sha256:o.payload_sha256},o);
  assert(sha(r.payload_text)===r.payload_sha256&&Buffer.byteLength(r.payload_text)<=Number(r.payload_capacity));
 }
 assert(changed===1&&old.size===0);
}

const ROWS='SELECT root_key,epoch::text,id::text,kind,tenant_id::text,actor_id::text,api_key_id::text,payload_text,payload_sha256,payload_capacity::text,metadata_charge::text,objects_charge::text FROM ordinary187_private.journal WHERE root_key=$1 AND (epoch,id)>($2::bigint,$3::uuid) ORDER BY epoch,id LIMIT 8';
async function endBounded(c:Client){
 let timer:ReturnType<typeof setTimeout>|undefined;
 const ended=Promise.resolve().then(()=>c.end());
 try{await Promise.race([ended,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('operator owner end timeout UNKNOWN')),5000);})]);}
 catch(first){try{(c.connection as unknown as {stream:{destroy():void}}).stream.destroy();}catch{}throw first;}finally{if(timer)clearTimeout(timer);}
}
async function cut(c:Client,root:string,check:()=>void){
 const rows:EpochRow[]=[];let cursor=['0','00000000-0000-0000-0000-000000000000'],bytes=0;
 while(true){check();const page=(await c.query<EpochRow>(ROWS,[root,...cursor])).rows;assert(page.length<=8);if(!page.length)break;
  for(const row of page){assert(/^[1-9][0-9]*$/.test(row.epoch)&&UUID.test(row.id));assert(BigInt(row.epoch)>BigInt(cursor[0]!)||(row.epoch===cursor[0]&&row.id>cursor[1]!),'operator keyset strictly advances');bytes+=Buffer.byteLength(row.payload_text);assert(rows.length<10000&&bytes<=8388608,'operator existing bounded whole cut');rows.push(row);cursor=[row.epoch,row.id];}
 }return rows;
}
export async function reconcileEmptyEpochFromAuthenticatedOperator(input:{
 startup:ReviewedStartup;connectOwner():Promise<Client>;request:FastifyRequest;
 database:string;databasePort:number;rawRoot:string;controlPlaneRoot:string;
 explicitLocalOperatorApproval:true;approvalSha256:string;expectedReleaseSha256:string;signal:AbortSignal;
 expected:{root:string;epoch:string;id:string;before_sha256:string;tenant_id:string;actor_id:string};
 cleanupFailure(error:unknown):void;
}){
 const {startup,connectOwner,request,signal,database,databasePort,rawRoot,controlPlaneRoot,explicitLocalOperatorApproval,approvalSha256,expectedReleaseSha256,cleanupFailure}=input;
 const expected=structuredClone(input.expected),deadline=Date.now()+120000;
 const check=()=>{signal.throwIfAborted();assert(Date.now()<=deadline,'operator total deadline');};check();
 assert(explicitLocalOperatorApproval===true&&/^[a-f0-9]{64}$/.test(approvalSha256));
 assert(/^[A-Za-z0-9_]+$/.test(database)&&Number.isInteger(databasePort)&&databasePort>0&&databasePort<=65535);
 for(const p of [rawRoot,controlPlaneRoot])assert(await realpath(p)===p);
 assert(rawRoot!==controlPlaneRoot);
 const root=sha(JSON.stringify(['dynaminds-private-large-import-root-barrier/v1',database,rawRoot,controlPlaneRoot]));
 assert(root===expected.root&&/^[1-9][0-9]*$/.test(expected.epoch)&&/^[a-f0-9]{64}$/.test(expected.before_sha256)&&[expected.id,expected.tenant_id,expected.actor_id].every(x=>UUID.test(x)));
 const transport=createDedicatedMetadataTransport({connectOwner:connectOwner,expectedOwner:'postgres',sessionName:'dyna_session',cleanupFailure:cleanupFailure,preflightOwner173:createReviewedMetadataPreflight(startup)});
 const actor=transport.capture(request),metadata=transport.bind(actor);requireOriginalMetadataBinding(metadata,actor,request);
 assert(actor.role==='admin'&&actor.apiKeyId==null&&actor.tenantId===expected.tenant_id&&actor.userId===expected.actor_id,'exact normal-admin original principal');
 const evidence=await recheckReviewedStartupEvidence(startup);assert('release_manifest_sha256' in evidence&&evidence.release_manifest_sha256===expectedReleaseSha256,'operator exact current release');
 const intent={schema:'local-operator-empty-epoch-reconciliation/v1',action:'CLOSE_ABANDONED_EMPTY_BOOTSTRAP',root_key:root,epoch:expected.epoch,epoch_id:expected.id,before_payload_sha256:expected.before_sha256,tenant_id:actor.tenantId,actor_id:actor.userId,release_manifest_sha256:evidence.release_manifest_sha256};
 assert(sha(JSON.stringify(intent))===approvalSha256,'operator exact explicit approval intent');check();
 const c=await connectOwner(),buffer=Buffer.from(root,'hex'),keys=[buffer.readInt32BE(0),buffer.readInt32BE(4)];
 let locked=false,began=false,commitAttempted=false,committed=false,first:unknown,failed=false,receipt:unknown,lease:Awaited<ReturnType<ReturnType<typeof createOrdinarySchemaTransactionGate>['reserve']>>|undefined;
 const cleanup=(e:unknown)=>{try{cleanupFailure(e);}catch{}if(!failed){failed=true;first=e;}};
 try{
  assert(c instanceof Client,'operator canonical native Client');assert((c as unknown as {readyForQuery?:unknown}).readyForQuery===true,'operator native query queue idle');check();
  let nativeStatus:unknown;const ready=(m:{status?:unknown})=>{nativeStatus=m.status;};c.connection.on('readyForQuery',ready);
  let r;try{r=(await c.query("SELECT current_user role,session_user owner,current_setting('role',true) setting,current_database() db,inet_server_port() port,host(inet_server_addr()) host FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows;}finally{c.connection.off('readyForQuery',ready);}
  assert(nativeStatus==='I','operator authentic ReadyForQuery idle before BEGIN');
  assert(r.length===1&&r[0].role==='postgres'&&r[0].owner==='postgres'&&r[0].setting==='none'&&r[0].db===database&&r[0].port===databasePort&&['127.0.0.1','::1'].includes(r[0].host));
  await inspectCompositeStartup(c,startup);lease=await createOrdinarySchemaTransactionGate(startup).reserve(c);
  assert.equal((await c.query('SELECT pg_try_advisory_lock($1::integer,$2::integer) held',keys)).rows[0]?.held,true);locked=true;
  began=true;await c.query("BEGIN ISOLATION LEVEL READ COMMITTED;SET LOCAL statement_timeout='8s';SET LOCAL lock_timeout='1s'");await lease.enter();check();
  // Acquire the exact latest epoch lock BEFORE rereading emptiness/history.
  await c.query("SELECT id FROM ordinary187_private.journal WHERE root_key=$1 AND epoch=$2::bigint AND id=$3::uuid AND kind='epoch' FOR UPDATE",[root,expected.epoch,expected.id]);
  await admitOriginalEpochJournal(c,metadata.ports,request,actor);
  const before=await cut(c,root,check),contexts=(await c.query('SELECT * FROM ordinary187_private.contexts WHERE root_key=$1',[root])).rows;
  validateEmptyCut(before,contexts,expected);check();requireOriginalMetadataBinding(metadata,actor,request);
  const result=await c.query('SELECT public.ordinary187_owner_abandon_empty($1,$2,$3,$4,$5,$6,$7,$8) value',[root,expected.epoch,expected.id,expected.before_sha256,actor.tenantId,actor.userId,evidence.release_manifest_sha256,approvalSha256]);
  assert(result.rows.length===1);receipt=result.rows[0].value;
  const value=receipt as Record<string,unknown>;assert(value&&typeof value==='object'&&!Array.isArray(value)&&value.root_key===root&&value.epoch===expected.epoch&&value.id===expected.id&&value.before_payload_sha256===expected.before_sha256&&typeof value.after_payload_sha256==='string'&&/^[a-f0-9]{64}$/.test(value.after_payload_sha256)&&value.state==='CLOSED'&&value.empty_bootstrap===true&&value.business_ACK_proved===false&&value.full_FS_census===false&&value.public_ready===false,'operator exact Native eight-argument closure receipt');
  const after=await cut(c,root,check);validateOnlyEmptyClosure(before,after,expected,approvalSha256,evidence.release_manifest_sha256);assert(after.find(x=>x.epoch===expected.epoch&&x.id===expected.id)?.payload_sha256===value.after_payload_sha256,'operator exact after readback SHA');
  assert.equal((await c.query('SELECT count(*)::text n FROM ordinary187_private.contexts WHERE root_key=$1',[root])).rows[0].n,'0');
  await admitOriginalEpochJournal(c,metadata.ports,request,actor);requireOriginalMetadataBinding(metadata,actor,request);check();commitAttempted=true;await c.query('COMMIT');committed=true;began=false;
 }catch(e){failed=true;first=e;}
 finally{
  if(began)try{await c.query('ROLLBACK');}catch(e){cleanup(e);}
  if(locked)try{assert.equal((await c.query('SELECT pg_advisory_unlock($1::integer,$2::integer) released',keys)).rows[0]?.released,true);}catch(e){cleanup(e);}
  if(lease)try{await lease.close();}catch(e){cleanup(e);}
  try{await endBounded(c);}catch(e){cleanup(e);}
 }
 // ACK_LOST may have committed one legitimate closure. Preserve first cause, never retry
 // or mint a handle/business ACK from a later readback; Root saves the unknown boundary.
 if(failed){const failure=new Error('local operator empty epoch reconciliation failed; no repeat',{cause:first});Object.assign(failure,{outcome:Object.freeze({commit_attempted:commitAttempted,committed,unknown:commitAttempted&&!committed,no_repeat:true})});throw failure;}assert(commitAttempted&&committed);return{intent,intent_sha256:approvalSha256,receipt,protocol_only:true,business_ACK_proved:false,full_FS_census:false,public_ready:false};
}
