// AUTHORED_ONLY / NOT_EXECUTED. Root owns new numeric DB, registration and serial execution.
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildApp } from '../server/app';
import { pool,migrate } from '../server/db';
import { tick } from '../server/worker';
import { readScopes } from '../server/channel-access';
assert.equal(process.env.DYNA_TEST,'true');
const db=new URL(process.env.DATABASE_URL??''); assert(['localhost','127.0.0.1','[::1]'].includes(db.hostname));
assert.match(db.pathname,/^\/dynaminds_test_\d+$/);
let app:Awaited<ReturnType<typeof buildApp>>,calls=0,ip=0;
let response:'good'|'unknown'='good';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
let tokenGate:null|{entered:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>}=null;
const config=()=>({clientId:'durable-fixture',clientSecret:'durable-fixture-secret',redirectUri:'http://127.0.0.1:4100/api/oauth/allegro/callback'});
const transport=async(url:string,init:RequestInit)=>{
 const u=new URL(url); if(u.pathname==='/auth/oauth/token') {
  assert.equal(init.method,'POST');calls++;
  // Actual pre-HTTP durable commit is visible from an independent owner connection.
  const rows=(await pool.query("SELECT state FROM public.allegro_oauth_recovery_attempts WHERE state='may_have_been_sent'")).rows;
  assert(rows.length>0,'Durable barrier must precede transport invocation');
  if(tokenGate){tokenGate.entered.resolve();await tokenGate.release.promise;}
  if(response==='unknown') throw new Error('Controlled connection closed after possible provider acceptance');
  return new Response(JSON.stringify({access_token:'durable-access-'+randomUUID(),refresh_token:'durable-refresh-'+randomUUID(),expires_in:3600,scope:readScopes}),{status:200});
 }
 assert.equal(u.pathname,'/sale/products');return new Response(JSON.stringify({products:[],nextPage:{id:null}}),{status:200});
};
before(async()=>{await migrate();app=await buildApp({backgroundWorkersEnabled:false,oauthConfig:config,integrationTransport:transport});});
after(async()=>{await app?.close();await pool.end();});
type Account={cookie:string;remoteAddress:string;user:{id:string;tenant_id:string}};
const cookie=(r:any)=>String(r.headers['set-cookie']).split(';')[0];
const req=(a:Account,url:string,method:'GET'|'POST'='GET',payload?:Record<string,unknown>)=>app.inject({url,method,payload,headers:{cookie:a.cookie},remoteAddress:a.remoteAddress});
async function complete(a:Account,id:string){const s=await req(a,'/api/integrations/'+id+'/oauth/start','POST',{});assert.equal(s.statusCode,200);
 const state=new URL(s.json().url).searchParams.get('state')!;
 const r=await req(a,'/api/oauth/allegro/callback?state='+encodeURIComponent(state)+'&code=durable-code');assert.equal(r.statusCode,302);}
async function fixture(){response='good';const remoteAddress='127.181.0.'+ ++ip;
 const r=await app.inject({url:'/api/auth/signup',method:'POST',remoteAddress,payload:{name:'Own durable OAuth',email:randomUUID()+'@example.test',password:'DurableOAuth!2026',organization:{name:'Own durable '+randomUUID().slice(0,8)}}});assert.equal(r.statusCode,201);
 const a:Account={cookie:cookie(r),remoteAddress,user:r.json().user};
 const c=await req(a,'/api/integrations','POST',{provider:'allegro',mode:'sandbox',name:'Durable own channel',credentials:{access_token:'durable-fixture-initial-access'},settings:{}});assert.equal(c.statusCode,200);const id=c.json().id as string;
 await complete(a,id);
 const k=await req(a,'/api/developer/keys','POST',{name:'Native products read',scopes:['products:read']});assert.equal(k.statusCode,201);
 await pool.query("UPDATE channels SET token_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]); // clock-only fixture
 return {a,id,key:k.json().token as string,keyId:k.json().id as string};}
const catalog=(f:Awaited<ReturnType<typeof fixture>>)=>app.inject({url:'/api/v1/integrations/'+f.id+'/allegro/catalog?phrase=Durable',headers:{authorization:'Bearer '+f.key},remoteAddress:f.a.remoteAddress});
async function all(){const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");const x:Record<string,unknown[]>={};
 for(const {tablename} of (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows){assert.match(tablename,/^[a-z][a-z0-9_]*$/);x[tablename]=(await c.query(`SELECT to_jsonb(t) row FROM public."${tablename}" t ORDER BY 1`)).rows;}
 await c.query('COMMIT');return x;}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}}
const ledger=async(id:string)=>(await pool.query('SELECT to_jsonb(t) row FROM public.allegro_oauth_recovery_attempts t WHERE channel_id=$1 ORDER BY id',[id])).rows.map(x=>x.row);
// The first request with the fixture API key stamps its last use (migration 237, server/api-key-rotation.ts touchApiKey).
const apiKeyLastUse='auth237_api_key_state';
function sameExcept(a:Record<string,unknown[]>,b:Record<string,unknown[]>,tables:string[]){assert.deepEqual(Object.keys(a),Object.keys(b));for(const t of Object.keys(a))if(!tables.includes(t))assert.deepEqual(b[t],a[t],t);}

test('pre-send barrier survives unknown response; session and different real jobs never resubmit the unresolved connection',async()=>{
 const f=await fixture(),before=await all(),n=calls;response='unknown';
 const first=await catalog(f);assert.equal(first.statusCode,503);assert.equal(calls,n+1);
 const after=await all();sameExcept(before,after,['allegro_oauth_recovery_attempts',apiKeyLastUse]);
 const rows=await ledger(f.id);const pending=rows.filter(r=>r.state==='refused');assert.equal(pending.length,1);assert.equal(pending[0].refusal_code,'response_unknown');assert.equal(pending[0].actor_kind,'api_key');
 const session=await req(f.a,'/api/integrations/'+f.id+'/allegro/catalog?phrase=Durable');assert.equal(session.statusCode,503);assert.equal(calls,n+1);assert.deepEqual(await all(),after);
 // Separate actual sync jobs, not replacement leases or fabricated principal rows.
 for(let i=0;i<2;i++){const q=await req(f.a,'/api/integrations/'+f.id+'/sync','POST');assert.equal(q.statusCode,200);const jobId=q.json().id;
  const accepted=await all();assert.equal(await tick({transport,oauthConfig:config}),true);assert.equal(calls,n+1);
  const stopped=await all();sameExcept(accepted,stopped,['jobs']);
  const withoutOwn=(xs:unknown[])=>xs.filter((x:any)=>x.row.id!==jobId);
  assert.deepEqual(withoutOwn(stopped.jobs),withoutOwn(accepted.jobs),'Every other global job remains literal');
  const j=(await pool.query('SELECT * FROM jobs WHERE id=$1',[jobId])).rows[0];assert.equal(j.state,'failed');assert.equal(j.attempts,1);assert.equal(j.lease_token,null);assert.deepEqual(j.payload.allegro_oauth_commit_refused,{channel_id:f.id,connection_id:pending[0].connection_id});
  assert.deepEqual(await ledger(f.id),rows);
 }
});

test('known token response after genuine API-key revoke creates a connection fence also respected by a session and a different native job',{timeout:60000},async()=>{
 const f=await fixture(),n=calls;tokenGate={entered:deferred(),release:deferred()};const gate=tokenGate;
 const pending=catalog(f).then(value=>({value,error:null}),(error:unknown)=>({value:null,error}));
 try{
  await gate.entered.promise;
  const changed=await app.inject({method:'DELETE',url:'/api/developer/keys/'+f.keyId,headers:{cookie:f.a.cookie},remoteAddress:f.a.remoteAddress});assert.equal(changed.statusCode,200);
  const accepted=await all();gate.release.resolve();const result=await pending;assert.equal(result.error,null);assert(result.value);assert.equal(result.value.statusCode,401);
  const after=await all();sameExcept(accepted,after,['allegro_oauth_recovery_attempts']);assert.equal(calls,n+1);
  const rows=await ledger(f.id),blocked=rows.filter(r=>r.state==='refused');assert.equal(blocked.length,1);assert.equal(blocked[0].refusal_code,'local_commit_refused');
  const session=await req(f.a,'/api/integrations/'+f.id+'/allegro/catalog?phrase=Durable');assert.equal(session.statusCode,503);assert.equal(calls,n+1);assert.deepEqual(await all(),after);
  const q=await req(f.a,'/api/integrations/'+f.id+'/sync','POST');assert.equal(q.statusCode,200);const jobId=q.json().id;
  const queued=await all();assert.equal(await tick({transport,oauthConfig:config}),true);assert.equal(calls,n+1);
  const stopped=await all();sameExcept(queued,stopped,['jobs']);const without=(xs:unknown[])=>xs.filter((x:any)=>x.row.id!==jobId);assert.deepEqual(without(stopped.jobs),without(queued.jobs));
  const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[jobId])).rows[0];assert.equal(job.state,'failed');assert.equal(job.attempts,1);assert.equal(job.lease_token,null);
  assert.deepEqual(await ledger(f.id),rows);
 }finally{gate.release.resolve();await pending;tokenGate=null;}
});

test('genuine reconnect installs a new identity and atomically supersedes unresolved old-generation history',async()=>{
 const f=await fixture(),n=calls;response='unknown';assert.equal((await catalog(f)).statusCode,503);
 const old=await ledger(f.id),blocked=old.find(r=>r.state==='refused');assert(blocked);response='good';await complete(f.a,f.id);
 assert.equal(calls,n+2);const rows=await ledger(f.id),past=rows.find(r=>r.id===blocked.id);assert(past);assert.equal(past.state,'superseded');assert.equal(past.connection_id,blocked.connection_id);assert.notEqual(past.result_connection_id,blocked.connection_id);
 const saved=(await pool.query('SELECT settings FROM channels WHERE id=$1',[f.id])).rows[0];assert.equal(past.result_connection_id,saved.settings.oauth_connection_id);
 const committed=rows.filter(r=>!old.some(o=>o.id===r.id));assert.equal(committed.length,1);assert.equal(committed[0].state,'committed');assert.equal(committed[0].grant_type,'authorization_code');
 const baseline=await all();assert.equal((await catalog(f)).statusCode,200);assert.equal(calls,n+2);assert.deepEqual(await all(),baseline);
 for(const r of rows){assert(!('credentials' in r)&&!('access_token' in r)&&!('refresh_token' in r));}
});

test('real subprocess exit after pre-send commit leaves an unknown barrier across restart with no automatic second token submission',{timeout:60000},async()=>{
 const f=await fixture(),before=await all(),n=calls;
 const source=new URL('../server/app.ts',import.meta.url).href;
 const child=`const {buildApp}=await import(${JSON.stringify(source)});const app=await buildApp({backgroundWorkersEnabled:false,oauthConfig:()=>({clientId:'durable-fixture',clientSecret:'durable-fixture-secret',redirectUri:'http://127.0.0.1:4100/api/oauth/allegro/callback'}),integrationTransport:async(u,i)=>{if(new URL(u).pathname!=='/auth/oauth/token')throw Error('unexpected');process.exit(73);}});await app.inject({url:process.env.DYNA_OAUTH_QA_PATH,headers:{authorization:'Bearer '+process.env.DYNA_OAUTH_QA_KEY}});process.exit(74);`;
 const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
  const p=spawn(process.execPath,['--import','tsx','--input-type=module','-e',child],{env:{...process.env,DYNA_OAUTH_QA_KEY:f.key,DYNA_OAUTH_QA_PATH:'/api/v1/integrations/'+f.id+'/allegro/catalog?phrase=Durable'},stdio:'ignore'});
  const timer=setTimeout(()=>{p.kill('SIGKILL');reject(new Error('Owned child exceeded bounded startup'));},15000);
  p.once('error',e=>{clearTimeout(timer);reject(e);});p.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});assert.equal(result.code,73);assert.equal(result.signal,null);
 const after=await all();sameExcept(before,after,['allegro_oauth_recovery_attempts',apiKeyLastUse]);
 const rows=await ledger(f.id);assert.equal(rows.filter(r=>r.state==='may_have_been_sent').length,1);assert.equal(calls,n,'Child transport is isolated from parent counter');
 assert.equal((await catalog(f)).statusCode,503);assert.equal(calls,n);assert.deepEqual(await all(),after);
 response='good';await complete(f.a,f.id);assert.equal(calls,n+1);assert.equal((await catalog(f)).statusCode,200);assert.equal(calls,n+1);
});

// New authcode grant and old refresh generation remain distinct; no blanket callback lock.
test('legitimate refresh during held reconnect remains accepted and both actual ledger commits bind their grants',{timeout:60000},async()=>{
 const f=await fixture(),n=calls;
 const s=await req(f.a,'/api/integrations/'+f.id+'/oauth/start','POST',{});assert.equal(s.statusCode,200);
 const state=new URL(s.json().url).searchParams.get('state')!;
 tokenGate={entered:deferred(),release:deferred()};const gate=tokenGate;
 const pending=req(f.a,'/api/oauth/allegro/callback?state='+encodeURIComponent(state)+'&code=held-reconnect').then(value=>({value,error:null}),(error:unknown)=>({value:null,error}));
 try{
  await gate.entered.promise;tokenGate=null;
  const refreshed=await catalog(f);assert.equal(refreshed.statusCode,200);
  const old=(await pool.query('SELECT settings FROM channels WHERE id=$1',[f.id])).rows[0].settings.oauth_connection_id;
  gate.release.resolve();const accepted=await pending;assert.equal(accepted.error,null);assert(accepted.value);assert.equal(accepted.value.statusCode,302);assert.equal(calls,n+2);
  const current=(await pool.query('SELECT settings FROM channels WHERE id=$1',[f.id])).rows[0].settings.oauth_connection_id;assert.notEqual(current,old);
  const rows=await ledger(f.id);assert.equal(rows.filter(r=>r.grant_type==='refresh_token'&&r.state==='committed'&&r.result_connection_id===old).length,1);
  assert.equal(rows.filter(r=>r.grant_type==='authorization_code'&&r.state==='committed'&&r.result_connection_id===current).length,1);
 }finally{gate.release.resolve();await pending;tokenGate=null;}
});
