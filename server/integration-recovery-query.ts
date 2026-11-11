/** Read-only integration recovery query with native request authentication.
 * The app supplies its owner pool, private cursor key, actual cookie namespace
 * and trusted restore-preview context. This service does not retry, reconcile,
 * refresh OAuth, invoke workers or call providers. Pagination is a live queue
 * with a verified keyset anchor, not a frozen census. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {Problem} from './errors';

type Provider='shopify'|'amazon'|'ebay';
type Role='admin'|'operator'|'viewer';
type Request={actor:{tenantId:string;userId:string;role:Role;apiKeyId?:string};currentUser?:{id:string;tenant_id:string};headers:{authorization?:string;'x-workspace-id'?:string|string[]};cookies:Record<string,string|undefined>};
export type RecoveryIdentity={tenant_id:string;user_id:string;role:Role;restore_preview:boolean};
export type JobDisposition='pending'|'active'|'stale'|'exhausted'|'failed'|'done'|'missing_or_mismatched';
export type RecoveryRow={provider:Provider;plan_id:string;order_id:string;order_number:string;shipment_id:string;channel_id:string;channel_name:string;channel_status:string;channel_mode:'sandbox'|'live';simulation:boolean|null;state:'failed'|'conflict'|'queued';phase:'ready'|'write_started'|'verify'|'done';job_id:string|null;job_disposition:JobDisposition;updated_at:string;issue:'failed_before_send'|'source_conflict'|'write_outcome_unknown'|'verification_incomplete'|'result_requires_review';reconcile_availability:'in_detail'|'read_only'|'admin_required'|'credentials_missing'|'connection_changed'|'not_applicable'|'not_verified'|'queued_inspection_only'};
export type RecoveryPage={scope:RecoveryIdentity;items:RecoveryRow[];next_cursor:string|null};
export const integrationRecoveryQuery=z.strictObject({provider:z.enum(['shopify','amazon','ebay']).nullable(),execution:z.enum(['all','live','simulation']),limit:z.literal(50),after:z.string().max(2048).nullable()});
const cursor=z.strictObject({v:z.literal(1),tenant:z.uuid(),user:z.uuid(),role:z.enum(['admin','operator','viewer']),preview:z.boolean(),auth:z.string().regex(/^[a-f0-9]{64}$/),provider:z.enum(['shopify','amazon','ebay']).nullable(),execution:z.enum(['all','live','simulation']),limit:z.literal(50),at:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),kind:z.enum(['shopify','amazon','ebay']),id:z.uuid()});
type Frame={tenant:string;user:string;role:Role;key:string|null;tokenHash:string};
class QueryProblem extends Problem{constructor(status:number,message:string){super(status,message);this.name='IntegrationRecoveryQueryProblem';}}
const check:(ok:unknown,status:number,message:string)=>asserts ok=(ok,status,message)=>{if(!ok)throw new QueryProblem(status,message);};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const tables=['shopify_fulfillment_plans','amazon_fulfillment_plans','ebay_fulfillment_plans'] as const;
const plans=tables.map((table,i)=>`SELECT '${['shopify','amazon','ebay'][i]}'::text provider,p.id,p.tenant_id,p.order_id,p.shipment_id,p.channel_id,p.actor_id,p.connection_hash,p.state,p.phase,p.job_id,p.updated_at,${i===2?'NULL::jsonb':'p.account_scope'} account_scope FROM public.${table} p WHERE p.tenant_id=$1`).join(' UNION ALL ');
const queued="(p.state IN ('failed','conflict') OR(p.state='queued' AND p.phase IN ('write_started','verify')))";
const stamp="to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";

export function createIntegrationRecoveryQuery(context:{pool:Pool;cursorKey:string;sessionName:string;restorePreview:boolean}){
 const cfg=Object.freeze({...context});
 check(/^[a-f0-9]{64}$/.test(cfg.cursorKey),500,'Brak prywatnego klucza stronicowania');check(/^dyna_session(?:_preview_\d+)?$/.test(cfg.sessionName),500,'Brak natywnej przestrzeni sesji');
 const frames=new WeakMap<object,Frame>();
 function capture(req:Request){
  check(req.currentUser?.id===req.actor.userId&&req.currentUser.tenant_id===req.actor.tenantId,401,'Brak natywnej tożsamości żądania');
  const key=req.actor.apiKeyId??null,raw=key?req.headers.authorization?.replace(/^Bearer /,''):req.cookies[cfg.sessionName]??req.headers.authorization?.replace(/^Bearer /,'');
  check(raw&&(!key||/^dyna_api_[a-f0-9]{64}$/.test(raw)),401,'Brak bieżącej sesji lub klucza');check(!req.headers['x-workspace-id']||req.headers['x-workspace-id']===req.actor.tenantId,409,'Zmieniono firmę');
  const handle=Object.freeze({});frames.set(handle,{tenant:req.actor.tenantId,user:req.actor.userId,role:req.actor.role,key,tokenHash:hash(raw)});return handle;
 }
 async function identity(c:PoolClient,h:object){
  const f=frames.get(h);check(f,401,'Brak zaufanego żądania');
  // Owner-only native authentication rows, as in app's initial authentication.
  // Fresh READ COMMITTED statement and clock_timestamp at BOTH read boundaries.
  const credential=f.key?`FROM api_keys k JOIN users u ON u.id=k.user_id JOIN tenants t ON t.id=k.tenant_id LEFT JOIN memberships m ON(m.user_id,m.tenant_id)=(u.id,t.id) LEFT JOIN account_security a ON a.user_id=u.id LEFT JOIN workspace_security_policies p ON p.tenant_id=t.id WHERE(k.id,k.token_hash,k.user_id,k.tenant_id)=($4::uuid,$3,$2::uuid,$1::uuid) AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp()`:`FROM sessions s JOIN users u ON u.id=s.user_id JOIN tenants t ON t.id=s.tenant_id LEFT JOIN memberships m ON(m.user_id,m.tenant_id)=(u.id,t.id) LEFT JOIN account_security a ON a.user_id=u.id LEFT JOIN workspace_security_policies p ON p.tenant_id=t.id WHERE(s.token_hash,s.user_id,s.tenant_id)=($3,$2::uuid,$1::uuid) AND s.expires_at>clock_timestamp() AND s.account_version=coalesce(a.version,0)`;
  const r=(await c.query(`SELECT m.role,${f.key?"coalesce(k.scopes@>ARRAY['orders:read']::text[],false) scope_ok,coalesce(p.require_mfa,false) AND a.enabled_at IS NULL mfa_required,k.scopes":"true scope_ok,coalesce(p.require_mfa,false) AND NOT(coalesce(a.enabled_at IS NOT NULL AND s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at>clock_timestamp()-interval '8 hours',false)) mfa_required,NULL::text[] scopes"},coalesce(a.version,0)::text account_version,to_jsonb(p) policy ${credential}`,f.key?[f.tenant,f.user,f.tokenHash,f.key]:[f.tenant,f.user,f.tokenHash])).rows[0];
  check(r,401,'Sesja lub klucz wygasły');check(r.role&&['admin','operator','viewer'].includes(r.role)&&r.scope_ok===true&&!r.mfa_required,403,'Brak bieżącej roli, zakresu lub MFA');check(r.role===f.role,409,'Rola została zmieniona; odśwież kolejkę');
  return{scope:{tenant_id:f.tenant,user_id:f.user,role:r.role as Role,restore_preview:cfg.restorePreview},auth:hash(JSON.stringify([f.tenant,f.user,f.key,f.tokenHash,r.role,r.account_version,r.policy,r.scopes]))};
 }
 const encode=(v:z.infer<typeof cursor>)=>{const body=Buffer.from(JSON.stringify(v)).toString('base64url');return body+'.'+createHmac('sha256',cfg.cursorKey).update('integration-recovery/v1\0'+body).digest('hex');};
 function decode(raw:string){const parts=raw.split('.');check(parts.length===2&&/^[A-Za-z0-9_-]+$/.test(parts[0])&&/^[a-f0-9]{64}$/.test(parts[1]),422,'Nieprawidłowy kursor');const want=createHmac('sha256',cfg.cursorKey).update('integration-recovery/v1\0'+parts[0]).digest();check(timingSafeEqual(want,Buffer.from(parts[1],'hex')),422,'Nieprawidłowy kursor');try{return cursor.parse(JSON.parse(Buffer.from(parts[0],'base64url').toString()));}catch{throw new QueryProblem(422,'Nieprawidłowy kursor');}}
 async function read<T>(req:Request,fn:(c:PoolClient,f:Frame,initial:Awaited<ReturnType<typeof identity>>)=>Promise<T>){
  const h=capture(req),f=frames.get(h)!,c=await cfg.pool.connect();try{
   await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='8s'");const initial=await identity(c,h);
   await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]);await c.query('SET LOCAL ROLE dyna_app');
   const result=await fn(c,f,initial);await c.query('RESET ROLE');const final=await identity(c,h);check(final.auth===initial.auth,409,'Uprawnienia zmieniono podczas odczytu');await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();frames.delete(h);}
 }
 async function list(req:Request,raw:unknown):Promise<RecoveryPage>{
  const q=integrationRecoveryQuery.parse(raw);return read(req,async(c,f,initial)=>{
   for(const name of tables)check((await c.query('SELECT to_regclass($1) present',['public.'+name])).rows[0].present,503,'Brak kompletnego natywnego rejestru realizacji');
   const bound={v:1 as const,tenant:f.tenant,user:f.user,role:initial.scope.role,preview:cfg.restorePreview,auth:initial.auth,provider:q.provider,execution:q.execution,limit:q.limit},after=q.after?decode(q.after):null;
   if(after)for(const k of Object.keys(bound)as(keyof typeof bound)[])check(after[k]===bound[k],409,'Kursor dotyczy innej firmy, osoby, roli lub filtra');
   // Malformed native frozen account scope is corruption, not benign unknown.
   const invalid=(await c.query(`WITH p AS(${plans}) SELECT 1 FROM p WHERE ${queued} AND($2::text IS NULL OR p.provider=$2) AND p.provider IN('shopify','amazon') AND (jsonb_typeof(account_scope) IS DISTINCT FROM 'array' OR CASE WHEN jsonb_typeof(account_scope)='array' THEN jsonb_array_length(account_scope)<>CASE provider WHEN 'shopify' THEN 3 ELSE 5 END ELSE true END OR jsonb_typeof(account_scope->(CASE provider WHEN 'shopify' THEN 2 ELSE 4 END)) IS DISTINCT FROM 'string' OR account_scope->>(CASE provider WHEN 'shopify' THEN 2 ELSE 4 END) NOT IN('',p.tenant_id::text)) LIMIT 1`,[f.tenant,q.provider])).rowCount;check(!invalid,503,'Uszkodzone zamrożone pochodzenie realizacji');
   // eBay has no frozen simulation column. A matching native connection hash
   // proves current settings are still the original settings. Otherwise unknown.
   const ebayProofs:{id:string;connection_hash:string;simulation:boolean}[]=[];
   if(q.provider===null||q.provider==='ebay'){
    const channels=(await c.query(`SELECT c.id,c.provider,c.mode,c.settings,c.credentials FROM channels c WHERE c.tenant_id=$1 AND c.provider='ebay' AND EXISTS(SELECT 1 FROM ebay_fulfillment_plans p WHERE(p.tenant_id,p.channel_id)=(c.tenant_id,c.id) AND ${queued}) ORDER BY c.id LIMIT 1001`,[f.tenant])).rows;
    check(channels.length<=1000,413,'Za dużo połączeń eBay do jednego odczytu');const {ebayConnectionHash}=await import('./ebay');
    for(const ch of channels){try{ebayProofs.push({id:ch.id,connection_hash:ebayConnectionHash(ch),simulation:Boolean(ch.settings.simulation)});}catch{throw new QueryProblem(503,'Nie można zweryfikować natywnej tożsamości połączenia eBay');}}
   }
   const source=`WITH p AS(${plans}),proof AS(SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,connection_hash text,simulation boolean)),visible AS(SELECT p.*,o.number order_number,c.name channel_name,c.status channel_status,c.mode channel_mode,CASE WHEN p.provider='ebay' THEN CASE WHEN ep.connection_hash=p.connection_hash THEN ep.simulation ELSE NULL END ELSE(p.account_scope->>(CASE p.provider WHEN 'shopify' THEN 2 ELSE 4 END))=p.tenant_id::text END simulation,j.id actual_job,j.state job_state,j.attempts,j.max_attempts,j.lease_token IS NOT NULL lease_present,j.locked_at IS NOT NULL AND j.locked_at>=clock_timestamp()-interval '2 minutes' lease_fresh,j.run_at<=clock_timestamp() AND(j.provider_wait_until IS NULL OR j.provider_wait_until<=clock_timestamp()) job_due,coalesce(j.kind=p.provider||'.fulfillment' AND jsonb_typeof(j.payload)='object' AND j.payload->>'plan_id'=p.id::text AND j.payload->>'channel_id'=p.channel_id::text AND j.payload->>'actor_id'=p.actor_id::text,false) job_bound,${stamp} stamp FROM p JOIN orders o ON(o.tenant_id,o.id)=(p.tenant_id,p.order_id) JOIN channels c ON(c.tenant_id,c.id)=(p.tenant_id,p.channel_id) AND c.provider=p.provider LEFT JOIN jobs j ON(j.tenant_id,j.id)=(p.tenant_id,p.job_id) LEFT JOIN proof ep ON ep.id=p.channel_id WHERE ${queued} AND($2::text IS NULL OR p.provider=$2))`;
   const args=[f.tenant,q.provider,JSON.stringify(ebayProofs),q.execution,after?.at??null,after?.kind??null,after?.id??null];
   if(after)check((await c.query(`${source} SELECT 1 FROM visible WHERE($4::text='all' OR simulation=($4::text='simulation')) AND provider=$6 AND id=$7::uuid AND updated_at=$5::timestamptz`,args)).rowCount,409,'Wyniki kolejki zmieniły się; rozpocznij od początku');
   const rows=(await c.query(`${source} SELECT provider,id plan_id,order_id,order_number,shipment_id,channel_id,channel_name,channel_status,channel_mode,simulation,state,phase,job_id,stamp updated_at,actual_job,job_state,attempts,max_attempts,lease_present,lease_fresh,job_due,job_bound FROM visible WHERE($4='all' OR simulation=($4='simulation')) AND($5::timestamptz IS NULL OR updated_at<$5::timestamptz OR(updated_at=$5::timestamptz AND(provider>$6 OR(provider=$6 AND id<$7::uuid)))) ORDER BY updated_at DESC,provider ASC,id DESC LIMIT 51`,args)).rows;
   const items:RecoveryRow[]=rows.slice(0,50).map(r=>{
    const uncertain=r.phase==='write_started'||r.phase==='verify';check(['failed','conflict','queued'].includes(r.state)&&['ready','write_started','verify','done'].includes(r.phase)&&(r.state!=='queued'||uncertain),503,'Nieprawidłowy stan realizacji');
    // stale is the observed native reaper cutoff, not proof of invalidated lease.
    // A fresh running final attempt is active; only terminal/pending exhaustion
    // is labeled exhausted. No disposition grants retry or reconciliation.
    const disposition:JobDisposition=!r.actual_job||!r.job_bound?'missing_or_mismatched':r.job_state==='done'?'done':r.job_state==='failed'?(r.attempts>=r.max_attempts?'exhausted':'failed'):r.job_state==='running'?(r.lease_present&&r.lease_fresh?'active':'stale'):r.job_state==='pending'?(r.attempts>=r.max_attempts?'exhausted':'pending'):'missing_or_mismatched';
    const availability:RecoveryRow['reconcile_availability']=r.state==='queued'?'queued_inspection_only':!uncertain?'not_applicable':cfg.restorePreview?'read_only':initial.scope.role!=='admin'?'admin_required':'not_verified';
    return{provider:r.provider,plan_id:r.plan_id,order_id:r.order_id,order_number:r.order_number,shipment_id:r.shipment_id,channel_id:r.channel_id,channel_name:r.channel_name,channel_status:r.channel_status,channel_mode:r.channel_mode,simulation:r.simulation,state:r.state,phase:r.phase,job_id:r.job_id,job_disposition:disposition,updated_at:r.updated_at,issue:r.phase==='write_started'?'write_outcome_unknown':r.phase==='verify'?'verification_incomplete':r.phase==='done'?'result_requires_review':r.state==='conflict'?'source_conflict':'failed_before_send',reconcile_availability:availability};
   });
   const last=items.at(-1);return{scope:initial.scope,items,next_cursor:rows.length>50&&last?encode({...bound,at:last.updated_at,kind:last.provider,id:last.plan_id}):null};
  });
 }
 return Object.freeze({identity:(req:Request)=>read(req,async(_c,_f,current)=>current.scope),list});
}
