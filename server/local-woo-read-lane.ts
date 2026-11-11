/** Source-wired native routes and ordinary factory/lifecycle; registration is source only.
 * Normal 212 Native certification and runtime activation remain pending acceptance.
 * Requires exclusive local workers (global scheduler/reaper OFF).
 * Stages reads only. Never catalogApply/importOrder/offer writes or lease reclaim.
 */
import type {createLocalWooOrderImport} from './local-woo-order-import';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {tenantTx,tenantReadTx} from './db';
import {audit,type Actor} from './domain';
import {ensure} from './errors';
import {decrypt} from './security';
import type {Transport} from './integrations';
import {enqueueSync,processIntegrationJob} from './sync';
import {startCatalog,processCatalogSource} from './catalog-source';
import {readLocalWooOrders} from './local-woo-orders-read';
import {LOCAL_WOO_ORIGINS} from '../shared/local-woo-origins';
import {localWooRegistryFixture,type LocalWooHttpRegistry} from './local-woo-http-registry';
import {readConfiguredLocalWooHttpChannel} from './local-woo-http-fixture';
const kind=z.enum(['orders.sync','catalog.fetch']),version=z.string().regex(/^(0|[1-9]\d{0,14})$/);
const selected=z.strictObject({tenantId:z.uuid(),userId:z.uuid(),channelId:z.uuid(),fixtureId:z.uuid(),origin:z.enum(LOCAL_WOO_ORIGINS)});
export type LocalWooReadSelection=z.infer<typeof selected>;
export const localWooReadCommand=z.strictObject({client_key:z.uuid(),kind,expected_version:version,enabled:z.boolean(),interval_seconds:z.number().int().min(60).max(86400),warehouse_id:z.uuid()});
type Kind=z.infer<typeof kind>;
export const localWooReadAbortCommand=z.strictObject({client_key:z.uuid(),expected_snapshot_sha256:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)});
const abortAck=z.strictObject({status:z.literal('LOCAL_WOO_READ_ATTEMPT_ABORTED'),channel_id:z.uuid(),occurrence_id:z.uuid(),kind:z.literal('orders.sync'),job_id:z.uuid(),dispatch_id:z.uuid(),client_key:z.uuid(),expected_snapshot_sha256:z.string().regex(/^[a-f0-9]{64}$/),control_version:version.refine(v=>v!=='0'),enabled:z.literal(false),job_state:z.literal('failed'),occurrence_state:z.literal('aborted'),dispatch_state:z.literal('started'),original_outcome:z.literal('UNCONFIRMED'),automatic_retry:z.literal(false)});
export type LocalWooReadAbortAck=z.infer<typeof abortAck>;

const failurePhase=z.enum(['eligibility','claim','processor','credentials','provider_read','stage','completion']);
const retainedFailure=z.strictObject({status:z.literal('RETAINED_FAILURE'),phase:failurePhase,detected_at:z.iso.datetime(),occurrence_id:z.uuid(),job_id:z.uuid().nullable(),dispatch_id:z.uuid().nullable(),error_category:z.enum(['POSTGRES','HTTP','ERROR','THROWN_VALUE']),sqlstate:z.string().regex(/^[0-9A-Z]{5}$/).nullable(),http_status:z.number().int().min(400).max(599).nullable(),error_fingerprint:z.string().regex(/^[a-f0-9]{64}$/),source:z.enum(['memory','audit']),automatic_retry:z.literal(false)}).refine(v=>v.error_category==='POSTGRES'?v.sqlstate!==null&&v.http_status===null:v.error_category==='HTTP'?v.sqlstate===null&&v.http_status!==null:v.sqlstate===null&&v.http_status===null,'Niespójna kategoria diagnostyki');
export type LocalWooReadFailureDiagnostic=z.infer<typeof retainedFailure>|{status:'NO_RETAINED_CAUSE';occurrence_id:string;automatic_retry:false};
type FailurePhase=z.infer<typeof failurePhase>;
type FailureEvidence=Omit<z.infer<typeof retainedFailure>,'source'|'occurrence_id'>&{occurrence_id:string|null};
// Read only own data properties: a thrown value may have hostile getters or contain secrets.
function errorProperty(error:unknown,key:string):unknown{try{return error!==null&&(typeof error==='object'||typeof error==='function')?Object.getOwnPropertyDescriptor(error,key)?.value:undefined;}catch{return undefined;}}
function failureCause(error:unknown){
 const rawCode=errorProperty(error,'code'),rawStatus=errorProperty(error,'status'),rawMessage=errorProperty(error,'message');
 const sqlstate=typeof rawCode==='string'&&/^[0-9A-Z]{5}$/.test(rawCode)?rawCode:null,http_status=sqlstate===null&&Number.isInteger(rawStatus)&&Number(rawStatus)>=400&&Number(rawStatus)<=599?Number(rawStatus):null;
 const message=typeof rawMessage==='string'?rawMessage:typeof error==='string'?error:typeof error;
 const error_fingerprint=createHash('sha256').update(Buffer.from(message.slice(0,8192)).subarray(0,8192)).digest('hex');
 return{error_category:sqlstate?'POSTGRES' as const:http_status!==null?'HTTP' as const:error instanceof Error?'ERROR' as const:'THROWN_VALUE' as const,sqlstate,http_status,error_fingerprint};
}

const historyQuery=z.strictObject({kind:kind.optional(),limit:z.coerce.number().int().min(1).max(25).default(25),before_at:z.string().regex(/^\d{4}-\d{2}-\d{2} [\d:.]+[+-][\d:]+$/).optional(),before_id:z.uuid().optional()}).refine(v=>!!v.before_at===!!v.before_id,'Niepełny kursor');
const dispatchQuery=z.strictObject({limit:z.coerce.number().int().min(1).max(25).default(25),before_at:z.string().regex(/^\d{4}-\d{2}-\d{2} [\d:.]+[+-][\d:]+$/).optional(),before_id:z.uuid().optional()}).refine(v=>!!v.before_at===!!v.before_id,'Niepełny kursor');
function page(rows:any[],limit:number){const data=rows.slice(0,limit),last=data.at(-1);return{data,next:rows.length>limit&&last?{before_at:last.created_at_text,before_id:last.id}:null};}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const actorFor=(s:LocalWooReadSelection):Actor=>({tenantId:s.tenantId,userId:s.userId,role:'admin'});
// Credential ciphertext is included; unlike a generic connection hash this also fences key rotation.
function channelHash(ch:any){return hash({id:ch.id,tenant_id:ch.tenant_id,provider:ch.provider,mode:ch.mode,settings:ch.settings,credentials:ch.credentials,sync_enabled:ch.sync_enabled});}
export function localWooReadOnlyTransport(base:Transport,origin:string):Transport{return(url,init)=>{
 const u=new URL(url);ensure(u.origin===origin&&!u.username&&!u.password&&(!init.method||init.method==='GET')&&!init.body,403,'Wyłącznie odczyt wybranego lokalnego sklepu');
 return base(url,init);
};}
async function admin(c:PoolClient,s:LocalWooReadSelection){ensure((await c.query('SELECT public.offer_sync_is_admin($1) ok',[s.userId])).rows[0]?.ok===true,403,'Wymagany aktualny własny administrator');}
async function readAdmin(c:PoolClient,s:LocalWooReadSelection){ensure((await c.query('SELECT public.customer_message_role($1) AS role',[s.userId])).rows[0]?.role==='admin',403,'Wymagany aktualny własny administrator');}
async function channel(c:PoolClient,s:LocalWooReadSelection){
 const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,s.channelId])).rows[0];
 ensure(ch?.provider==='woocommerce'&&ch.mode==='sandbox'&&ch.sync_enabled===false&&isDeepStrictEqual(ch.settings,{store_url:s.origin,simulation:false,local_http_fixture:{schema:'local-woo-http-fixture/v1',fixture_id:s.fixtureId,owner_id:s.userId}}),409,'Lokalny kanał zmienił się');return ch;
}
async function control(c:PoolClient,s:LocalWooReadSelection,k:Kind){return(await c.query('SELECT *,next_at::text AS due_at,next_at<=clock_timestamp() AS due FROM local_woo_read_controls WHERE tenant_id=$1 AND channel_id=$2 AND kind=$3 FOR UPDATE',[s.tenantId,s.channelId,k])).rows[0];}
async function occurrence(c:PoolClient,s:LocalWooReadSelection,k:Kind){return(await c.query("SELECT * FROM local_woo_read_occurrences WHERE tenant_id=$1 AND channel_id=$2 AND kind=$3 AND state NOT IN('done','aborted') FOR UPDATE",[s.tenantId,s.channelId,k])).rows[0];}
// Catalog processor locks run before job; use the same order in claim and completion.
async function snapshot(c:PoolClient,s:LocalWooReadSelection,o:any){
 const run=o.run_id?(await c.query('SELECT r.*,to_jsonb(r) AS lane_snapshot FROM catalog_source_runs r WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,o.run_id])).rows[0]:null;
 const job=(await c.query('SELECT j.*,to_jsonb(j) AS lane_snapshot,run_at<=clock_timestamp() AS lane_due FROM jobs j WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,o.job_id])).rows[0];
 ensure(job&&job.kind===o.kind&&job.tenant_id===s.tenantId&&job.payload?.actor_id===s.userId,409,'Zmienione zadanie odczytu');
 if(o.kind==='catalog.fetch')ensure(run&&run.job_id===job.id&&run.channel_id===s.channelId&&run.actor_id===s.userId&&run.import_stock===false&&isDeepStrictEqual(job.payload,{run_id:run.id,actor_id:s.userId}),409,'Zmieniony katalog odczytu');
 else ensure(job.payload.channel_id===s.channelId&&job.payload.phase==='bootstrap'&&Number.isInteger(job.payload.page)&&job.payload.page>=1&&job.payload.page<=201&&isDeepStrictEqual(job.payload,{channel_id:s.channelId,actor_id:s.userId,page:job.payload.page,phase:'bootstrap'}),409,'Zmieniony zakres odczytu zamówień');
 ensure((job.provider_wait_until===null||job.provider_wait_until===undefined)&&(job.provider_wait_reason===null||job.provider_wait_reason===undefined),409,'Obce oczekiwanie dostawcy');
 return{job,run,hash:hash({job:job.lane_snapshot,run:run?.lane_snapshot??null})};
}
function fresh(snap:Awaited<ReturnType<typeof snapshot>>){const j=snap.job;ensure(j.state==='pending'&&Number(j.attempts)===0&&j.lease_token===null&&j.locked_at===null&&!j.error,409,'Rozpoczęte lub niepewne zadanie wymaga uzgodnienia');ensure(!snap.run||snap.run.state==='queued'&&!snap.run.error,409,'Katalog wymaga uzgodnienia');}
/** Session authentication belongs to the native route; never accept body-supplied Actor. */
export function createLocalWooReadLane(registry:LocalWooHttpRegistry,input:readonly LocalWooReadSelection[],options:{orderImport?:ReturnType<typeof createLocalWooOrderImport>}={}){
 const scopes=z.array(selected).min(1).max(5).parse(structuredClone(input));
 ensure(new Set(scopes.map(s=>s.channelId)).size===scopes.length&&new Set(scopes.map(s=>s.fixtureId)).size===scopes.length&&new Set(scopes.map(s=>s.origin)).size===scopes.length,422,'Powtórzony lokalny sklep');
 for(const s of scopes)localWooRegistryFixture(registry,actorFor(s),s.channelId); // Genuine registry, not caller transport authority.
 let closed=false,running:Promise<unknown>|undefined;const stopped=new Set<string>(),failures=new Map<string,{cause:unknown;token:string|null;evidence:FailureEvidence;resolved?:boolean}>();
 const key=(s:LocalWooReadSelection,k:Kind)=>s.channelId+':'+k;
 const knownAborts=new Map<string,{occurrence:string;job:string;dispatch:string;token:string;version:string}>();
 function own(a:Actor,id:string){ensure(a.role==='admin'&&!a.apiKeyId,403,'Wymagana sesja administratora');const s=scopes.find(s=>s.tenantId===a.tenantId&&s.userId===a.userId&&s.channelId===id);ensure(s,404,'Brak własnego wybranego kanału');return s;}
 async function configured(s:LocalWooReadSelection){const v=await readConfiguredLocalWooHttpChannel(localWooRegistryFixture(registry,actorFor(s),s.channelId),actorFor(s));ensure(v.enrolled===true&&v.fixture_id===s.fixtureId&&v.origin===s.origin,409,'Niepotwierdzony lokalny kanał');}
 function commandAck(prior:any,a:Actor,id:string,b:z.infer<typeof localWooReadCommand>,requestHash:string){
  ensure(prior.actor_id===a.userId&&prior.channel_id===id&&prior.kind===b.kind&&prior.client_key===b.client_key&&prior.request_hash===requestHash,409,'Klucz polecenia użyty z inną tożsamością lub treścią');
  const ack=prior.response;ensure(ack&&ack.channel_id===id&&ack.kind===b.kind&&typeof ack.version==='string'&&/^[1-9]\d{0,14}$/.test(ack.version)&&typeof ack.enabled==='boolean'&&ack.automatic_retry===false,409,'Niepotwierdzony zapisany wynik polecenia');
  if(ack.status==='LOCAL_WOO_READ_COMMAND_CANCELLED'){
   ensure(Object.keys(ack).sort().join(',')==='automatic_retry,channel_id,client_key,enabled,kind,status,version'&&ack.client_key===b.client_key&&ack.version===(b.expected_version==='0'?'1':b.expected_version),409,'Niepotwierdzone anulowanie polecenia');
  }else{
   ensure(ack.status==='LOCAL_WOO_READ_CONFIGURATION_ACKNOWLEDGED'&&Object.keys(ack).sort().join(',')==='automatic_retry,channel_id,enabled,kind,next_at,reauthorized_occurrence_id,status,version'&&ack.version===String(BigInt(b.expected_version)+1n)&&ack.enabled===b.enabled&&(ack.enabled?typeof ack.next_at==='string'&&Number.isFinite(Date.parse(ack.next_at)):ack.next_at===null)&&(ack.reauthorized_occurrence_id===null||z.uuid().safeParse(ack.reauthorized_occurrence_id).success),409,'Niepotwierdzony zapisany wynik polecenia');
  }return ack;
 }
 async function configure(a:Actor,id:string,body:unknown){
  ensure(!closed,503,'Procesor zamknięty');const s=own(a,id),b=localWooReadCommand.parse(body);await configured(s);
  return tenantTx(s.tenantId,async c=>{
   const ch=await channel(c,s);await admin(c,s);
   const prior=(await c.query('SELECT * FROM local_woo_read_commands WHERE tenant_id=$1 AND client_key=$2',[s.tenantId,b.client_key])).rows[0],requestHash=hash([s,a.userId,b]);
   if(prior)return commandAck(prior,a,id,b,requestHash);
   const row=await control(c,s,b.kind);ensure(String(row?.version??0)===b.expected_version,409,'Zmieniona wersja zgody');
   if(row)ensure(row.owner_id===s.userId&&row.fixture_id===s.fixtureId,409,'Zmieniony właściciel zgody');
   ensure((await c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2',[s.tenantId,b.warehouse_id])).rows.length===1,404,'Brak własnego magazynu');
   const active=await occurrence(c,s,b.kind);let reauthorized:string|null=null;
   if(active){
    ensure(row&&row.owner_id===active.owner_id&&row.connection_hash===active.connection_hash&&channelHash(ch)===active.connection_hash&&row.warehouse_id===b.warehouse_id&&Number(row.interval_seconds)===b.interval_seconds,409,'Aktywny przebieg wymaga niezmienionej konfiguracji');
    if(b.enabled){
     ensure(active.state==='queued',409,'Rozpoczęty lub niepewny przebieg wymaga uzgodnienia');
     ensure(!(await c.query("SELECT id FROM local_woo_read_dispatches WHERE tenant_id=$1 AND occurrence_id=$2 AND state='started' LIMIT 1",[s.tenantId,active.id])).rows.length,409,'Niepewna intencja wymaga uzgodnienia');
     const prior=await snapshot(c,s,active);fresh(prior);ensure(prior.hash===active.checkpoint_hash,409,'Zmieniony punkt kontynuacji');
     reauthorized=active.id;
    }
   }
   const updated=(await c.query(`INSERT INTO local_woo_read_controls(tenant_id,channel_id,kind,owner_id,fixture_id,version,enabled,interval_seconds,warehouse_id,connection_hash,next_at)
    VALUES($1,$2,$3,$4,$5,1,$6,$7::integer,$8,$9,CASE WHEN $6 THEN clock_timestamp()+make_interval(secs=>$7::integer) ELSE NULL END)
    ON CONFLICT(tenant_id,channel_id,kind) DO UPDATE SET version=local_woo_read_controls.version+1,enabled=EXCLUDED.enabled,interval_seconds=EXCLUDED.interval_seconds,warehouse_id=EXCLUDED.warehouse_id,connection_hash=EXCLUDED.connection_hash,next_at=EXCLUDED.next_at,updated_at=clock_timestamp()
    WHERE local_woo_read_controls.version=$10::bigint RETURNING *`,[s.tenantId,id,b.kind,s.userId,s.fixtureId,b.enabled,b.interval_seconds,b.warehouse_id,channelHash(ch),b.expected_version])).rows[0];
   ensure(updated,409,'Konflikt zapisu zgody');
   if(reauthorized){const changed=await c.query("UPDATE local_woo_read_occurrences SET authorized_version=$3 WHERE tenant_id=$1 AND id=$2 AND authorized_version=$4 AND state='queued' RETURNING id",[s.tenantId,reauthorized,String(updated.version),active.authorized_version]);ensure(changed.rows.length===1,409,'Zmieniono kontynuację');}
   const response={status:'LOCAL_WOO_READ_CONFIGURATION_ACKNOWLEDGED',channel_id:id,kind:b.kind,version:String(updated.version),enabled:b.enabled,next_at:updated.next_at,reauthorized_occurrence_id:reauthorized,automatic_retry:false};
   await c.query('INSERT INTO local_woo_read_commands(tenant_id,client_key,channel_id,kind,actor_id,request_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7)',[s.tenantId,b.client_key,id,b.kind,a.userId,requestHash,JSON.stringify(response)]);
   await audit(c,a,'local_woo.read.configure',id,{kind:b.kind,version:response.version,enabled:b.enabled,client_key:b.client_key});return response;
  });
 }
 async function cancelCommand(a:Actor,id:string,body:unknown){
  ensure(!closed,503,'Procesor zamknięty');const s=own(a,id),b=localWooReadCommand.parse(body);await configured(s);
  return tenantTx(s.tenantId,async c=>{
   const ch=await channel(c,s);await admin(c,s);const requestHash=hash([s,a.userId,b]);
   const prior=(await c.query('SELECT * FROM local_woo_read_commands WHERE tenant_id=$1 AND client_key=$2',[s.tenantId,b.client_key])).rows[0];
   if(prior)return commandAck(prior,a,id,b,requestHash);
   let row=await control(c,s,b.kind);ensure(String(row?.version??0)===b.expected_version,409,'Zmieniona wersja zgody');
   ensure((await c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2',[s.tenantId,b.warehouse_id])).rows.length===1,404,'Brak własnego magazynu');
   if(row){
    ensure(row.owner_id===s.userId&&row.fixture_id===s.fixtureId&&row.connection_hash===channelHash(ch),409,'Zmieniony właściciel lub połączenie zgody');
    // Cancellation fences only the absent command. Existing settings and active
    // occurrences remain entirely unchanged, including an enabled control.
   }else{
    row=(await c.query(`INSERT INTO local_woo_read_controls(tenant_id,channel_id,kind,owner_id,fixture_id,version,enabled,interval_seconds,warehouse_id,connection_hash,next_at)
     VALUES($1,$2,$3,$4,$5,1,false,$6::integer,$7,$8,NULL) ON CONFLICT(tenant_id,channel_id,kind) DO NOTHING RETURNING *`,[s.tenantId,id,b.kind,s.userId,s.fixtureId,b.interval_seconds,b.warehouse_id,channelHash(ch)])).rows[0];
    ensure(row&&String(row.version)==='1'&&row.enabled===false&&row.next_at===null,409,'Konflikt anulowania zgody');
   }
   const response={status:'LOCAL_WOO_READ_COMMAND_CANCELLED',channel_id:id,kind:b.kind,client_key:b.client_key,version:String(row.version),enabled:row.enabled,automatic_retry:false};
   await c.query('INSERT INTO local_woo_read_commands(tenant_id,client_key,channel_id,kind,actor_id,request_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7)',[s.tenantId,b.client_key,id,b.kind,a.userId,requestHash,JSON.stringify(response)]);
   await audit(c,a,'local_woo.read.command.cancel',id,{kind:b.kind,version:response.version,enabled:response.enabled,client_key:b.client_key});return response;
  });
 }
 async function observeCommand(a:Actor,id:string,body:unknown){const s=own(a,id),b=localWooReadCommand.parse(body);return tenantReadTx(s.tenantId,async c=>{
  await readAdmin(c,s);
  const row=(await c.query('SELECT * FROM local_woo_read_commands WHERE tenant_id=$1 AND client_key=$2',[s.tenantId,b.client_key])).rows[0];
  if(!row)return{status:'COMMAND_RESULT_UNKNOWN',channel_id:id,client_key:b.client_key,kind:b.kind,command:b,ack:null,automatic_retry:false};
  const ack=commandAck(row,a,id,b,hash([s,a.userId,b]));
  return{status:ack.status==='LOCAL_WOO_READ_COMMAND_CANCELLED'?'COMMAND_RESULT_CANCELLED':'COMMAND_RESULT_ACKNOWLEDGED',channel_id:id,client_key:b.client_key,kind:b.kind,command:b,ack,automatic_retry:false};
 });}
 // Same lock order as stage/finish: channel -> control -> admin -> occurrence -> dispatch -> job.
 async function abortContext(c:PoolClient,s:LocalWooReadSelection,lock:boolean){
  const ch=lock?await channel(c,s):(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2',[s.tenantId,s.channelId])).rows[0];
  const row=(await c.query('SELECT c.*,to_jsonb(c) AS abort_snapshot FROM local_woo_read_controls c WHERE tenant_id=$1 AND channel_id=$2 AND kind=$3'+(lock?' FOR UPDATE':''),[s.tenantId,s.channelId,'orders.sync'])).rows[0];
  if(lock)await admin(c,s);else await readAdmin(c,s);return{ch,row};
 }
 async function abortRows(c:PoolClient,s:LocalWooReadSelection,oid:string,lock:boolean,ctx:Awaited<ReturnType<typeof abortContext>>){
  const{ch,row}=ctx;
  ensure(ch&&ch.tenant_id===s.tenantId&&ch.id===s.channelId&&ch.provider==='woocommerce'&&ch.mode==='sandbox'&&ch.sync_enabled===false&&isDeepStrictEqual(ch.settings,{store_url:s.origin,simulation:false,local_http_fixture:{schema:'local-woo-http-fixture/v1',fixture_id:s.fixtureId,owner_id:s.userId}}),409,'Zmienione połączenie odczytu');
  ensure(row&&row.owner_id===s.userId&&row.fixture_id===s.fixtureId&&row.enabled===false&&row.next_at===null&&row.connection_hash===channelHash(ch),409,'Najpierw wstrzymaj niezmieniony własny odczyt');
  const o=(await c.query('SELECT o.*,to_jsonb(o) AS abort_snapshot FROM local_woo_read_occurrences o WHERE tenant_id=$1 AND channel_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),[s.tenantId,s.channelId,oid])).rows[0];
  ensure(o&&o.owner_id===s.userId&&o.kind==='orders.sync'&&o.run_id===null,404,'Brak własnej próby odczytu zamówień');
  ensure(version.safeParse(String(row.version)).success&&version.safeParse(String(o.control_version)).success&&version.safeParse(String(o.authorized_version)).success&&o.state==='running'&&o.connection_hash===row.connection_hash&&BigInt(o.authorized_version)<BigInt(row.version)&&o.finished_at===null,409,'Próba zakończona lub zmieniona; odczytaj jej aktualny wynik');
  const ds=(await c.query('SELECT d.*,to_jsonb(d) AS abort_snapshot FROM local_woo_read_dispatches d WHERE tenant_id=$1 AND occurrence_id=$2 ORDER BY id LIMIT 2'+(lock?' FOR UPDATE':''),[s.tenantId,oid])).rows;
  ensure(ds.length===1,409,'Uzgodnienie wymaga dokładnie jednej pierwotnej intencji');const d=ds[0];
  ensure(d.state==='started'&&d.after_hash===null&&d.acknowledged_at===null&&d.before_hash===o.checkpoint_hash,409,'Intencja zakończona lub zmieniona');
  const j=(await c.query('SELECT j.*,to_jsonb(j) AS abort_snapshot FROM jobs j WHERE tenant_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[s.tenantId,o.job_id])).rows[0];
  ensure(j&&j.kind==='orders.sync'&&j.state==='running'&&Number(j.attempts)===1&&Number(j.max_attempts)===1&&j.lease_token===d.lease_token&&j.locked_at!==null&&!j.error&&(j.provider_wait_until===null||j.provider_wait_until===undefined)&&(j.provider_wait_reason===null||j.provider_wait_reason===undefined)&&isDeepStrictEqual(j.payload,{channel_id:s.channelId,actor_id:s.userId,page:1,phase:'bootstrap'}),409,'Zadanie zakończone lub zmienione; nie wolno przejąć innej próby');
  const expected=hash(['local-woo-read-abort-snapshot/v1',s,channelHash(ch),row.abort_snapshot,o.abort_snapshot,d.abort_snapshot,j.abort_snapshot]);
  return{row,o,d,j,expected};
 }
 function abortRequestHash(s:LocalWooReadSelection,oid:string,b:z.infer<typeof localWooReadAbortCommand>){return hash(['local-woo-read-abort-command/v1',s,s.userId,oid,b]);}
 function validatedAbortAck(prior:any,s:LocalWooReadSelection,oid:string,b:z.infer<typeof localWooReadAbortCommand>){
  ensure(prior.actor_id===s.userId&&prior.channel_id===s.channelId&&prior.kind==='orders.sync'&&prior.occurrence_id===oid&&prior.client_key===b.client_key&&prior.request_hash===abortRequestHash(s,oid,b),409,'Klucz uzgodnienia użyty z inną tożsamością lub treścią');
  const parsed=abortAck.safeParse(prior.response);ensure(parsed.success&&parsed.data.channel_id===s.channelId&&parsed.data.occurrence_id===oid&&parsed.data.client_key===b.client_key&&parsed.data.expected_snapshot_sha256===b.expected_snapshot_sha256&&parsed.data.job_id===prior.job_id&&parsed.data.dispatch_id===prior.dispatch_id,409,'Niepotwierdzony zapisany wynik uzgodnienia');return parsed.data;
 }
 async function knownAbort(c:PoolClient,s:LocalWooReadSelection,ack:LocalWooReadAbortAck){
  const o=(await c.query('SELECT *,created_at::text AS created_at_text FROM local_woo_read_occurrences WHERE tenant_id=$1 AND channel_id=$2 AND id=$3',[s.tenantId,s.channelId,ack.occurrence_id])).rows[0];
  const d=(await c.query('SELECT * FROM local_woo_read_dispatches WHERE tenant_id=$1 AND id=$2',[s.tenantId,ack.dispatch_id])).rows[0];
  ensure(o&&o.owner_id===s.userId&&o.kind==='orders.sync'&&o.state==='aborted'&&o.job_id===ack.job_id&&d&&d.occurrence_id===o.id&&d.state==='started'&&d.after_hash===null,409,'Niepotwierdzone historyczne uzgodnienie');
  return{occurrence:o.id,job:o.job_id,dispatch:d.id,token:d.lease_token,version:ack.control_version};
 }
 function acknowledgeAbort(s:LocalWooReadSelection,known:Awaited<ReturnType<typeof knownAbort>>){
  const last=knownAborts.get(key(s,'orders.sync'));if(!last||BigInt(known.version)>BigInt(last.version))knownAborts.set(key(s,'orders.sync'),known);
  const prior=failures.get(key(s,'orders.sync'));
  if(prior&&!prior.resolved&&prior.evidence.occurrence_id===known.occurrence&&prior.evidence.job_id===known.job&&prior.evidence.dispatch_id===known.dispatch&&prior.token===known.token){prior.resolved=true;stopped.delete(key(s,'orders.sync'));}
 }
 async function previewAbort(a:Actor,id:string,occurrenceId:string){
  const s=own(a,id),oid=z.uuid().parse(occurrenceId);await configured(s);return tenantReadTx(s.tenantId,async c=>{
   const snap=await abortRows(c,s,oid,false,await abortContext(c,s,false));return{status:'LOCAL_WOO_READ_ABORT_PREVIEW' as const,channel_id:id,occurrence_id:oid,kind:'orders.sync' as const,control_version:String(snap.row.version),job_id:snap.j.id,dispatch_id:snap.d.id,expected_snapshot_sha256:snap.expected,original_outcome:'UNCONFIRMED' as const,operation:'ABORT_WITHOUT_RETRY' as const,automatic_retry:false as const};
  });
 }
 async function abortAttempt(a:Actor,id:string,occurrenceId:string,body:unknown){
  ensure(!closed,503,'Procesor zamknięty');const s=own(a,id),oid=z.uuid().parse(occurrenceId),b=localWooReadAbortCommand.parse(body);await configured(s);
  const result=await tenantTx(s.tenantId,async c=>{
   const ctx=await abortContext(c,s,true),prior=(await c.query('SELECT * FROM local_woo_read_reconciliations WHERE tenant_id=$1 AND client_key=$2',[s.tenantId,b.client_key])).rows[0];
   if(prior){const ack=validatedAbortAck(prior,s,oid,b);return{ack,known:await knownAbort(c,s,ack)};}
   const snap=await abortRows(c,s,oid,true,ctx);ensure(snap.expected===b.expected_snapshot_sha256,409,'Zmieniony stan próby; ponownie odczytaj podgląd bez ponawiania operacji');
   const changed=await c.query("UPDATE jobs SET state='failed',error='Odczyt zakończono administracyjnie; pierwotny wynik niepotwierdzony',lease_token=NULL,locked_at=NULL WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_token=$3 AND attempts=1 AND max_attempts=1 RETURNING id",[s.tenantId,snap.j.id,snap.d.lease_token]);ensure(changed.rows.length===1,409,'Zmieniona dzierżawa próby');
   const occurrence=await c.query("UPDATE local_woo_read_occurrences SET state='aborted',finished_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='running' AND checkpoint_hash=$3 RETURNING id",[s.tenantId,oid,snap.o.checkpoint_hash]);ensure(occurrence.rows.length===1,409,'Zmieniony punkt próby');
   const ack:LocalWooReadAbortAck={status:'LOCAL_WOO_READ_ATTEMPT_ABORTED',channel_id:id,occurrence_id:oid,kind:'orders.sync',job_id:snap.j.id,dispatch_id:snap.d.id,client_key:b.client_key,expected_snapshot_sha256:b.expected_snapshot_sha256,control_version:String(snap.row.version),enabled:false,job_state:'failed',occurrence_state:'aborted',dispatch_state:'started',original_outcome:'UNCONFIRMED',automatic_retry:false};
   await c.query('INSERT INTO local_woo_read_reconciliations(tenant_id,client_key,channel_id,kind,actor_id,occurrence_id,job_id,dispatch_id,request_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[s.tenantId,b.client_key,id,'orders.sync',s.userId,oid,snap.j.id,snap.d.id,abortRequestHash(s,oid,b),JSON.stringify(ack)]);
   await audit(c,a,'local_woo.read.attempt.abort',oid,{client_key:b.client_key,job_id:snap.j.id,dispatch_id:snap.d.id,expected_snapshot_sha256:b.expected_snapshot_sha256,original_outcome:'UNCONFIRMED'});return{ack,known:{occurrence:oid,job:snap.j.id,dispatch:snap.d.id,token:snap.d.lease_token,version:ack.control_version}};
  });
  acknowledgeAbort(s,result.known);return result.ack;
 }
 async function observeAbort(a:Actor,id:string,occurrenceId:string,body:unknown){
  const s=own(a,id),oid=z.uuid().parse(occurrenceId),b=localWooReadAbortCommand.parse(body);
  const result=await tenantReadTx(s.tenantId,async c=>{await readAdmin(c,s);const prior=(await c.query('SELECT * FROM local_woo_read_reconciliations WHERE tenant_id=$1 AND client_key=$2',[s.tenantId,b.client_key])).rows[0];
   if(!prior)return{ack:null,known:null};const ack=validatedAbortAck(prior,s,oid,b);return{ack,known:await knownAbort(c,s,ack)};
  });
  if(result.known)acknowledgeAbort(s,result.known);
  return{status:result.ack?'ABORT_RESULT_ACKNOWLEDGED' as const:'ABORT_RESULT_UNKNOWN' as const,channel_id:id,occurrence_id:oid,client_key:b.client_key,command:b,ack:result.ack,automatic_retry:false as const};
 }
 async function read(a:Actor,id:string,query:unknown={}){const s=own(a,id),b=historyQuery.parse(query);await configured(s);return tenantReadTx(s.tenantId,async c=>{
  await readAdmin(c,s);const rows=(await c.query(`SELECT o.*,created_at::text AS created_at_text FROM local_woo_read_occurrences o WHERE tenant_id=$1 AND channel_id=$2 AND ($3::text IS NULL OR kind=$3) AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $6`,[s.tenantId,id,b.kind??null,b.before_at??null,b.before_id??null,b.limit+1])).rows;
  return{controls:(await c.query('SELECT * FROM local_woo_read_controls WHERE tenant_id=$1 AND channel_id=$2 ORDER BY kind',[s.tenantId,id])).rows,history:page(rows,b.limit),automatic_retry:false};
 });}
 async function readOccurrence(a:Actor,id:string,occurrenceId:string,query:unknown={}){const s=own(a,id),oid=z.uuid().parse(occurrenceId),b=dispatchQuery.parse(query);await configured(s);return tenantReadTx(s.tenantId,async c=>{
  await readAdmin(c,s);const occurrence=(await c.query('SELECT *,created_at::text AS created_at_text FROM local_woo_read_occurrences WHERE tenant_id=$1 AND channel_id=$2 AND id=$3',[s.tenantId,id,oid])).rows[0];ensure(occurrence,404,'Brak własnego przebiegu');
  const rows=(await c.query(`SELECT id,occurrence_id,state,before_hash,after_hash,created_at::text AS created_at_text,acknowledged_at::text AS acknowledged_at_text FROM local_woo_read_dispatches WHERE tenant_id=$1 AND occurrence_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5`,[s.tenantId,oid,b.before_at??null,b.before_id??null,b.limit+1])).rows;
  return{occurrence,dispatches:page(rows,b.limit),reconciliation_required:occurrence.state!=='aborted'&&(occurrence.state==='running'||occurrence.state==='blocked'||rows.some((r:any)=>r.state==='started')),automatic_retry:false};
 });}
 async function claim(s:LocalWooReadSelection,k:Kind){await configured(s);return tenantTx(s.tenantId,async c=>{
  const ch=await channel(c,s),row=await control(c,s,k);await admin(c,s);
  if(!row?.enabled)return null;
  ensure(row.owner_id===s.userId&&row.fixture_id===s.fixtureId&&row.connection_hash===channelHash(ch),409,'Zmieniona zgoda lub połączenie');
  let o=await occurrence(c,s,k);
  if(o){ensure(o.state==='queued'&&String(o.authorized_version)===String(row.version)&&o.owner_id===s.userId&&o.connection_hash===row.connection_hash,409,'Poprzedni przebieg wymaga uzgodnienia');}
  else{
   if(!row.due)return null;
   // Do not adopt manually queued or attempted source work.
   ensure(!(await c.query(`SELECT id FROM jobs WHERE tenant_id=$1 AND kind=$3 AND state IN('pending','running') AND ((kind='orders.sync' AND payload->>'channel_id'=$2::text) OR (kind='catalog.fetch' AND payload->>'run_id' IN(SELECT id::text FROM catalog_source_runs WHERE tenant_id=$1 AND channel_id=$2::uuid))) LIMIT 1`,[s.tenantId,s.channelId,k])).rows.length,409,'Kanał ma inne aktywne zadanie');
   const occurrenceId=randomUUID();let jobId:string,runId:string|null=null;
   if(k==='orders.sync'){const result=await enqueueSync(c,actorFor(s),s.channelId);ensure(!result.reused,409,'Nie wolno przejąć cudzego zadania');jobId=result.id;}
   else{const run=await startCatalog(c,actorFor(s),s.channelId,{client_key:occurrenceId,warehouse_id:row.warehouse_id,vat:0,import_stock:false});ensure(!run.reused,409,'Katalog był już uruchomiony');jobId=run.job_id;runId=run.id;}
   o={id:occurrenceId,tenant_id:s.tenantId,channel_id:s.channelId,kind:k,control_version:String(row.version),authorized_version:String(row.version),owner_id:s.userId,connection_hash:row.connection_hash,job_id:jobId,run_id:runId,state:'queued'};
   const initial=await snapshot(c,s,o);fresh(initial);
   await c.query(`INSERT INTO local_woo_read_occurrences(id,tenant_id,channel_id,kind,control_version,authorized_version,owner_id,scheduled_for,connection_hash,job_id,run_id,state,checkpoint_hash)
    VALUES($1,$2,$3,$4,$5,$5,$6,$7::timestamptz,$8,$9,$10,'queued',$11)`,[o.id,s.tenantId,s.channelId,k,row.version,s.userId,row.due_at,row.connection_hash,jobId,runId,initial.hash]);
   o.checkpoint_hash=initial.hash;
   await c.query('UPDATE local_woo_read_controls SET next_at=clock_timestamp()+make_interval(secs=>interval_seconds) WHERE tenant_id=$1 AND channel_id=$2 AND kind=$3 AND version=$4',[s.tenantId,s.channelId,k,row.version]);
  }
  const unresolved=await c.query("SELECT id FROM local_woo_read_dispatches WHERE tenant_id=$1 AND occurrence_id=$2 AND state='started' LIMIT 1",[s.tenantId,o.id]);ensure(!unresolved.rows.length,409,'Niepotwierdzone wykonanie; nie ponawiaj');
  const before=await snapshot(c,s,o);fresh(before);if(!before.job.lane_due)return null;ensure(before.hash===o.checkpoint_hash,409,'Zmieniony punkt kontynuacji');
  const token=randomUUID(),dispatchId=randomUUID();
  const job=(await c.query(`UPDATE jobs SET state='running',attempts=1,max_attempts=1,locked_at=clock_timestamp(),lease_token=$3
   WHERE tenant_id=$1 AND id=$2 AND kind=$4 AND state='pending' AND attempts=0 AND lease_token IS NULL AND locked_at IS NULL RETURNING *`,[s.tenantId,o.job_id,token,k])).rows[0];ensure(job,409,'Nie potwierdzono dzierżawy');
  await c.query("INSERT INTO local_woo_read_dispatches(id,tenant_id,occurrence_id,lease_token,before_hash,state) VALUES($1,$2,$3,$4,$5,'started')",[dispatchId,s.tenantId,o.id,token,before.hash]);
  await c.query("UPDATE local_woo_read_occurrences SET state='running' WHERE tenant_id=$1 AND id=$2 AND state='queued'",[s.tenantId,o.id]);
  await audit(c,actorFor(s),'local_woo.read.claim',o.id,{dispatch_id:dispatchId,lease_token:token,kind:k,job_id:job.id});
  return{o,job,dispatchId,token,beforeRun:before.run?.lane_snapshot??null};
 });}
 async function finish(s:LocalWooReadSelection,held:NonNullable<Awaited<ReturnType<typeof claim>>>){return tenantTx(s.tenantId,async c=>{
  const ch=await channel(c,s),row=await control(c,s,held.o.kind);await admin(c,s);
  // Pause may acknowledge while the exact in-flight read drains; changing its source is never allowed.
  ensure(row&&row.owner_id===s.userId&&row.connection_hash===held.o.connection_hash&&channelHash(ch)===held.o.connection_hash,409,'Połączenie zmieniło się podczas odczytu');
  const o=await occurrence(c,s,held.o.kind);ensure(o?.id===held.o.id&&o.state==='running',409,'Zmieniony przebieg');
  const d=(await c.query("SELECT * FROM local_woo_read_dispatches WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[s.tenantId,held.dispatchId])).rows[0];ensure(d?.state==='started'&&d.lease_token===held.token&&d.occurrence_id===o.id,409,'Obca intencja wykonania');
  const after=await snapshot(c,s,o),j=after.job;
  ensure(['done','pending'].includes(j.state)&&Number(j.attempts)===0&&j.lease_token===null&&j.locked_at===null&&!j.error,409,'Procesor nie potwierdził zakończenia lub strony');
  ensure(!after.run||(j.state==='done'?after.run.state==='ready':after.run.state==='queued')&&!after.run.error,409,'Niepotwierdzony katalog');
  if(j.state==='pending'){const progress=after.run?hash({cursor:after.run.cursor,fetched:after.run.fetched,context:after.run.context})!==hash({cursor:held.beforeRun?.cursor,fetched:held.beforeRun?.fetched,context:held.beforeRun?.context}):j.payload.page>held.job.payload.page;ensure(progress,409,'Brak postępu odczytu');}
  const ack=await c.query("UPDATE local_woo_read_dispatches SET state='acknowledged',after_hash=$4,acknowledged_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND state='started' RETURNING id",[s.tenantId,d.id,held.token,after.hash]);ensure(ack.rows.length===1,409,'Utracono intencję');
  await c.query("UPDATE local_woo_read_occurrences SET state=$3,checkpoint_hash=$4,finished_at=CASE WHEN $3='done' THEN clock_timestamp() ELSE NULL END WHERE tenant_id=$1 AND id=$2 AND state='running'",[s.tenantId,o.id,j.state==='done'?'done':'queued',after.hash]);
  await audit(c,actorFor(s),'local_woo.read.ack',o.id,{dispatch_id:d.id,job_id:j.id,state:j.state});
  return{occurrence_id:o.id,job_id:j.id,state:j.state,automatic_retry:false};
 });}
 async function beforeReadStage(c:PoolClient,s:LocalWooReadSelection,held:NonNullable<Awaited<ReturnType<typeof claim>>>,job:any){
  ensure(job.id===held.job.id&&job.tenant_id===s.tenantId&&job.kind===held.o.kind&&job.lease_token===held.token&&isDeepStrictEqual(job.payload,held.job.payload),409,'Obcy kontekst zatwierdzenia odczytu');
  const ch=await channel(c,s),row=await control(c,s,held.o.kind);await admin(c,s);
  ensure(row&&row.owner_id===s.userId&&row.fixture_id===s.fixtureId&&row.connection_hash===held.o.connection_hash&&channelHash(ch)===held.o.connection_hash,409,'Zmieniona zgoda lub połączenie podczas odczytu');
  const o=await occurrence(c,s,held.o.kind);ensure(o?.id===held.o.id&&o.state==='running'&&o.job_id===job.id&&o.connection_hash===held.o.connection_hash,409,'Zmieniony przebieg odczytu');
  const d=(await c.query('SELECT * FROM local_woo_read_dispatches WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,held.dispatchId])).rows[0];
  ensure(d?.state==='started'&&d.occurrence_id===o.id&&d.lease_token===held.token&&d.before_hash===held.o.checkpoint_hash,409,'Zmieniona intencja odczytu');
  const staged=await snapshot(c,s,o);if(staged.run)ensure(isDeepStrictEqual(staged.run.lane_snapshot,held.beforeRun),409,'Katalog zmienił się przed zatwierdzeniem strony');const current=staged.job;ensure(current.state==='running'&&current.lease_token===held.token&&Number(current.attempts)===1&&isDeepStrictEqual(current.payload,job.payload),409,'Utracona dzierżawa odczytu');
 }
 async function diagnosticBinding(c:PoolClient,s:LocalWooReadSelection,o:any,evidence:FailureEvidence,token?:string){
  ensure(o&&o.tenant_id===s.tenantId&&o.channel_id===s.channelId&&o.owner_id===s.userId&&o.id===evidence.occurrence_id&&o.job_id===evidence.job_id,409,'Niepotwierdzona diagnostyka przebiegu');
  ensure(evidence.dispatch_id,409,'Brak przypisanej intencji diagnostyki');
  const d=(await c.query('SELECT * FROM local_woo_read_dispatches WHERE tenant_id=$1 AND id=$2',[s.tenantId,evidence.dispatch_id])).rows[0];
  ensure(d&&d.tenant_id===s.tenantId&&d.id===evidence.dispatch_id&&d.occurrence_id===o.id&&(token===undefined||d.lease_token===token),409,'Niepotwierdzona intencja diagnostyki');
 }
 async function retainFailure(s:LocalWooReadSelection,k:Kind,phase:FailurePhase,held:Awaited<ReturnType<typeof claim>>,cause:unknown){
  if(failures.has(key(s,k))&&!failures.get(key(s,k))!.resolved)return;
  const evidence:FailureEvidence={status:'RETAINED_FAILURE',phase,detected_at:new Date().toISOString(),occurrence_id:held?.o.id??null,job_id:held?.job.id??null,dispatch_id:held?.dispatchId??null,...failureCause(cause),automatic_retry:false};
  failures.set(key(s,k),{cause,token:held?.token??null,evidence}); // Preserve the original value, including falsy throws.
  try{await tenantTx(s.tenantId,async c=>{await admin(c,s);
   if(held){const o=(await c.query('SELECT *,created_at::text AS created_at_text FROM local_woo_read_occurrences WHERE tenant_id=$1 AND channel_id=$2 AND id=$3',[s.tenantId,s.channelId,held.o.id])).rows[0];ensure(o?.kind===k,409,'Zmieniony rodzaj diagnostyki');await diagnosticBinding(c,s,o,evidence,held.token);}
   else{const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2',[s.tenantId,s.channelId])).rows[0];ensure(ch?.tenant_id===s.tenantId&&ch.id===s.channelId,409,'Brak własnego kanału diagnostyki');} // No acknowledged held IDs: never infer a lease.
   await audit(c,actorFor(s),'local_woo.read.failure',evidence.occurrence_id??s.channelId,{schema:'local-woo-read-failure/v1',channel_id:s.channelId,kind:k,evidence});});}
  catch{/* Diagnostic COMMIT may be unknown too. Never replace the first cause, retry, or touch its lease. */}
 }
 // No-effect boundary: in phase credentials/provider_read the processor has not opened its staging
 // transaction (localWooReadLaneBeforeStage moves the phase to 'stage' first), and a GET has no
 // provider effect. The exact attempt is still held only if job, dispatch and occurrence are unchanged
 // under our lease; then it is closed terminally here and the next due read starts a new snapshot.
 // Anything else (stage, completion, claim, catalogue, changed lease) keeps the reconciliation stop.
 const noEffectPhases:readonly FailurePhase[]=['credentials','provider_read'];
 async function closeNoEffect(s:LocalWooReadSelection,held:NonNullable<Awaited<ReturnType<typeof claim>>>,phase:FailurePhase){return tenantTx(s.tenantId,async c=>{
  await channel(c,s);const row=await control(c,s,'orders.sync');await admin(c,s);
  ensure(row&&row.owner_id===s.userId&&row.fixture_id===s.fixtureId,409,'Zmieniony właściciel zgody');
  const o=await occurrence(c,s,'orders.sync');ensure(o?.id===held.o.id&&o.state==='running'&&o.job_id===held.job.id&&o.owner_id===s.userId&&o.checkpoint_hash===held.o.checkpoint_hash,409,'Zmieniony przebieg odczytu');
  const d=(await c.query('SELECT * FROM local_woo_read_dispatches WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,held.dispatchId])).rows[0];
  ensure(d?.state==='started'&&d.occurrence_id===o.id&&d.lease_token===held.token&&d.before_hash===held.o.checkpoint_hash,409,'Zmieniona intencja odczytu');
  const failed=await c.query("UPDATE jobs SET state='failed',error=$4,lease_token=NULL,locked_at=NULL WHERE tenant_id=$1 AND id=$2 AND kind='orders.sync' AND state='running' AND lease_token=$3 AND attempts=1 AND max_attempts=1 RETURNING id",[s.tenantId,held.job.id,held.token,'Odczyt zamówień nieudany bez skutku; następny odczyt według harmonogramu']);
  ensure(failed.rows.length===1,409,'Utracona dzierżawa odczytu');
  const after=await snapshot(c,s,o);
  const ack=await c.query("UPDATE local_woo_read_dispatches SET state='acknowledged',after_hash=$4,acknowledged_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND state='started' RETURNING id",[s.tenantId,d.id,held.token,after.hash]);
  ensure(ack.rows.length===1,409,'Zmieniona intencja odczytu');
  const ended=await c.query("UPDATE local_woo_read_occurrences SET state='aborted',finished_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='running' AND checkpoint_hash=$3 RETURNING id",[s.tenantId,o.id,held.o.checkpoint_hash]);
  ensure(ended.rows.length===1,409,'Zmieniony przebieg odczytu');
  await audit(c,actorFor(s),'local_woo.read.no_effect',o.id,{job_id:held.job.id,dispatch_id:d.id,phase,outcome:'NO_EFFECT_READ_FAILED',automatic_retry:false});
 });}
 async function readDiagnostic(a:Actor,id:string,occurrenceId:string):Promise<LocalWooReadFailureDiagnostic>{
  const s=own(a,id),oid=z.uuid().parse(occurrenceId);
  return tenantReadTx(s.tenantId,async c=>{
   await readAdmin(c,s);const o=(await c.query('SELECT *,created_at::text AS created_at_text FROM local_woo_read_occurrences WHERE tenant_id=$1 AND channel_id=$2 AND id=$3',[s.tenantId,id,oid])).rows[0];
   ensure(o&&o.owner_id===s.userId,404,'Brak własnego przebiegu');
   const memory=failures.get(key(s,o.kind));
   if(memory?.evidence.occurrence_id===oid){await diagnosticBinding(c,s,o,memory.evidence,memory.token??undefined);return retainedFailure.parse({...memory.evidence,source:'memory'});}
   const entry=(await c.query('SELECT detail FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3 AND action=$4 ORDER BY created_at DESC,id DESC LIMIT 1',[s.tenantId,s.userId,oid,'local_woo.read.failure'])).rows[0]?.detail;
   if(!entry)return{status:'NO_RETAINED_CAUSE',occurrence_id:oid,automatic_retry:false};
   ensure(entry.schema==='local-woo-read-failure/v1'&&entry.channel_id===id&&entry.kind===o.kind,409,'Niepotwierdzona diagnostyka przebiegu');
   const parsed=retainedFailure.safeParse({...entry.evidence,source:'audit'});ensure(parsed.success&&parsed.data.occurrence_id===oid&&parsed.data.job_id===o.job_id,409,'Niepotwierdzona diagnostyka przebiegu');await diagnosticBinding(c,s,o,parsed.data);return parsed.data;
  });
 }
 async function eligible(s:LocalWooReadSelection,k:Kind){return tenantReadTx(s.tenantId,async c=>(await c.query(`SELECT EXISTS(SELECT 1 FROM local_woo_read_controls c WHERE c.tenant_id=$1 AND c.channel_id=$2 AND c.kind=$3 AND c.enabled AND (c.next_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM local_woo_read_occurrences o WHERE (o.tenant_id,o.channel_id,o.kind)=(c.tenant_id,c.channel_id,c.kind) AND o.state='queued'))) AS eligible`,[s.tenantId,s.channelId,k])).rows[0]?.eligible===true);}
 async function tick(){const outcomes=[];
  for(const s of scopes)for(const k of ['orders.sync','catalog.fetch'] as const){if(closed)return outcomes;if(stopped.has(key(s,k))){outcomes.push({channel_id:s.channelId,kind:k,state:'RECONCILIATION_REQUIRED'});continue;}
   let phase:FailurePhase='eligibility',held:Awaited<ReturnType<typeof claim>>=null;
   try{if(!await eligible(s,k))continue;phase='claim';held=await claim(s,k);if(!held)continue;const claimed=held;
    const importTicket=k==='orders.sync'&&options.orderImport?await options.orderImport.capture(s,claimed.o.id):null;
    const readTransport=localWooReadOnlyTransport(registry.transport,s.origin);
    const transport:Transport=(url,init)=>{phase='provider_read';return readTransport(url,init);};
    const context={transport,...(options.orderImport&&k==='orders.sync'?{localWooReadLaneAfterStage:(c:PoolClient,job:any,created:readonly {id:string;state:string;source_hash:string}[])=>{ensure(job.id===claimed.job.id&&job.lease_token===claimed.token,409,'Obcy staging importu');return options.orderImport!.stage(c,importTicket,{occurrence_id:claimed.o.id,dispatch_id:claimed.dispatchId,read_job_id:claimed.job.id,lease_token:claimed.token},created);}}:{}),localWooReadLaneBeforeStage:(c:PoolClient,job:any)=>{phase='stage';return beforeReadStage(c,s,claimed,job);},localWooOrdersRead:async(id:string)=>{phase='credentials';ensure(id===s.channelId,403,'Obcy kanał');const ch=await tenantReadTx(s.tenantId,async c=>{await readAdmin(c,s);return(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2',[s.tenantId,id])).rows[0];});ensure(ch&&channelHash(ch)===claimed.o.connection_hash,409,'Zmieniony kanał');const credentials=decrypt(ch.credentials);return readLocalWooOrders(transport,'Basic '+Buffer.from(credentials.consumer_key+':'+credentials.consumer_secret).toString('base64'),s.origin);}};
    phase='processor';if(k==='orders.sync')await processIntegrationJob(claimed.job,context);else await processCatalogSource(claimed.job,context);
    phase='completion';outcomes.push({channel_id:s.channelId,kind:k,...await finish(s,claimed)});
   }catch(error){const known=knownAborts.get(key(s,k));if(held&&known&&known.occurrence===held.o.id&&known.job===held.job.id&&known.dispatch===held.dispatchId&&known.token===held.token){outcomes.push({channel_id:s.channelId,kind:k,state:'ADMINISTRATIVELY_ABORTED'});continue;}stopped.add(key(s,k));await retainFailure(s,k,phase,held,error);
     if(held&&k==='orders.sync'&&noEffectPhases.includes(phase)){let closedNoEffect=false;try{await closeNoEffect(s,held,phase);closedNoEffect=true;}catch{/* Not provably the same untouched attempt: keep the stop. */}
      if(closedNoEffect){const retained=failures.get(key(s,k));if(retained&&retained.evidence.occurrence_id===held.o.id)retained.resolved=true;stopped.delete(key(s,k));outcomes.push({channel_id:s.channelId,kind:k,state:'READ_FAILED_NO_EFFECT'});continue;}}
     outcomes.push({channel_id:s.channelId,kind:k,state:'RECONCILIATION_REQUIRED'});}
  }if(!closed)await options.orderImport?.cycle();return outcomes;
 }
 return Object.freeze({configure,cancelCommand,observeCommand,previewAbort,abortAttempt,observeAbort,read,readOccurrence,readDiagnostic,
  cycle(){ensure(!closed,503,'Procesor zamknięty');ensure(!running,409,'Cykl już trwa');const work=tick();running=work;void work.finally(()=>{if(running===work)running=undefined;}).catch(()=>{});return work;},
  async close(){closed=true;await running;},
  inspect(){return{closed,running:!!running,stopped:[...stopped],scope:'SELECTED_LOCAL_READS_ONLY',automatic_retry:false,wired:false};},
 });
}
