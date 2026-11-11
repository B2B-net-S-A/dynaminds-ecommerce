/** Actual Fastify route and network/current-IAM coordinator with a controlled
 * SQL boundary. No PostgreSQL, native RLS or provider acceptance is claimed. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build,transform} from 'esbuild';
import Fastify from 'fastify';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source=await readFile(path.join(root,'server/b2b-network.ts'),'utf8');
const compiled=(await transform(source,{loader:'ts',format:'esm'})).code;
const imports=new Map<string,Set<string>>();
for(const m of compiled.matchAll(/import\s+([^;]+?)\s+from\s+["'](\.\/[^"']+)["'];/g)){
 const names=new Set<string>();if(m[1].includes('* as')){const ns=m[1].split('* as')[1].trim();for(const use of compiled.matchAll(new RegExp(ns+'\\.([A-Za-z0-9_]+)','g')))names.add(use[1]);}
 else for(const name of m[1].replace(/[{}]/g,'').split(','))names.add(name.trim().split(/\s+as\s+/)[0]);imports.set(m[2],names);
}
const temp=await mkdtemp(path.join(root,'data/source-drafts/.b2b-invitation-read-')),target=path.join(temp,'route.mjs');
await build({stdin:{contents:source,loader:'ts',resolveDir:path.join(root,'server')},outfile:target,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',plugins:[{name:'controlled-network-dependencies',setup(b){
 b.onResolve({filter:/^\.\//},a=>a.path==='./errors'?{path:path.join(root,'server/errors.ts')}:{path:a.path,namespace:'control'});
 b.onLoad({filter:/.*/,namespace:'control'},a=>({loader:'ts',resolveDir:root,contents:a.path==='./db'?`export const localConfig={encryptionKey:'controlled-network-history-key'};export const pool={connect:async()=>globalThis.__invitationReadClient()};export const tenantTx=()=>{throw Error('unexpected tenant writer')};`:`import{z}from'zod';${[...(imports.get(a.path)??[])].map(name=>`export const ${name}=${name==='productSchema'||name==='b2bCatalogBindInput'?'z.object({})':name==='wmsTransactionActive'?'()=>false':'async()=>undefined'};`).join('\n')}`}));
}}]});
const {registerB2bNetworkRoutes}=await import(pathToFileURL(target).href);
const id=(n:number)=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000001`;
const tenant=id(1),actor=id(2),account=id(3),other=id(4),asOf='2026-10-18T12:00:00.000123Z';
type Row={id:string;created_at:string;expires_at:string;state:string;account_version:number};
function fixture(){
 const f={role:'admin',currentRole:'postgres',now:asOf,exists:true,accountVersion:2,revoked:false,revokeAfterPage:false,queries:[] as {sql:string;values:any[]}[],released:0,rows:[] as Row[]};
 f.rows=Array.from({length:53},(_,i)=>({id:id(100+i),created_at:i<17?'2026-10-18T10:00:00.000123Z':i<35?'2026-10-18T10:00:00.000122Z':'2026-10-17T10:00:00.999999Z',expires_at:i%2?'2026-10-18T12:00:00.000124Z':'2026-10-18T11:59:59.999999Z',state:i%3===0?'accepted':i%3===1?'pending':'revoked',account_version:1})).sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
 const client={release(){f.released++;},async query(sql:string,values:any[]=[]){f.queries.push({sql,values});
  assert(!/^\s*(INSERT|UPDATE|DELETE|GRANT|REVOKE|CREATE|ALTER|DROP)\b/i.test(sql),'history never issues a business writer');
  if(sql.startsWith('SET LOCAL ROLE dyna_app'))f.currentRole='dyna_app';if(sql==='RESET ROLE')f.currentRole='postgres';
  if(sql.includes('SELECT DISTINCT supplier_tenant_id'))return{rows:[]};
  if(sql.includes('SELECT current_user role'))return{rows:[{role:f.currentRole,login:'postgres',owner:'postgres'}]};
  if(sql.includes('SELECT role FROM memberships'))return{rows:[{role:f.role}]};
  if(sql.includes('SELECT user_id,scopes,revoked_at,expires_at FROM api_keys'))return{rows:[{user_id:actor,scopes:[],revoked_at:f.revoked?'2026-10-17':null,expires_at:null}]};
  if(sql==='SELECT clock_timestamp() now')return{rows:[{now:new Date(f.now)}]};
  if(sql.includes('SELECT id,version FROM b2b_accounts'))return{rows:f.exists&&values[0]===tenant&&values[1]===account?[{id:account,version:f.accountVersion}]:[]};
  if(sql.includes('observed_at'))return{rows:[{observed_at:f.now}]};
  if(sql.includes('FROM b2b_link_invitations')){
   assert(sql.includes('tenant_id=$1 AND account_id=$2'));assert(sql.includes('(created_at,id)<($3::timestamptz,$4::uuid)'));assert(sql.includes('ORDER BY created_at DESC,id DESC LIMIT $6'));assert(sql.includes('SS.US'));
   assert.equal(values[0],tenant);assert.equal(values[1],account);assert(values[5]>=2&&values[5]<=51);
   const rows=f.rows.filter(r=>r.created_at<=values[4]&&(!values[2]||r.created_at<values[2]||(r.created_at===values[2]&&r.id<values[3]))).slice(0,values[5]).map(r=>({...r,expired:r.state==='pending'&&r.expires_at<=values[4],token_hash:'PRIVATE-TOKEN',recipient_email:'PRIVATE-EMAIL',actor_id:'PRIVATE-ACTOR'}));
   if(f.revokeAfterPage)f.role='viewer';return{rows};
  }
  if(/^(BEGIN|COMMIT|ROLLBACK|RESET ROLE|SET )/.test(sql)||sql.includes('SELECT set_config'))return{rows:[]};
  throw Error('unexpected controlled SQL: '+sql);
 }};
 return{...f,client,state:f};
}
const app=Fastify();let principal:any={tenantId:tenant,userId:actor,role:'admin'};
app.decorateRequest('actor',null as any);app.addHook('onRequest',async(req,reply)=>{if(!principal)return reply.code(401).send({error:'missing session'});(req as any).actor=principal;});
registerB2bNetworkRoutes(app);app.setErrorHandler((e:any,_req,reply)=>reply.code(e.status??422).send({error:e.message}));await app.ready();
let current=fixture();(globalThis as any).__invitationReadClient=()=>current.client;
const request=(query='',accountId=account)=>app.inject('/api/b2b/accounts/'+accountId+'/network-invitations'+query);
const reset=()=>{current=fixture();principal={tenantId:tenant,userId:actor,role:'admin'};return current.state;};
try{
 await test('all53 rows traverse signed microsecond/UUID keysets without skipped ties, private fields or business writes',async()=>{
  const f=reset(),original=JSON.stringify(f.rows);let cursor:string|null=null;const found:string[]=[];
  do{const response=await request('?limit=7'+(cursor?'&after='+cursor:''));assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['cache-control'],'no-store');assert(!response.body.includes('PRIVATE'));const page=response.json();assert.deepEqual(Object.keys(page).sort(),['account','data','expiry_evaluated_at','next']);assert(page.data.length<=7);assert.equal(page.expiry_evaluated_at,asOf);for(const row of page.data){assert.deepEqual(Object.keys(row).sort(),['account_version','created_at','expired','expires_at','id','state']);assert.match(row.created_at,/\.\d{6}Z$/);}found.push(...page.data.map((r:any)=>r.id));cursor=page.next;if(cursor){const decoded=JSON.parse(Buffer.from(cursor.split('.')[0],'base64url').toString());assert.equal(decoded.at,page.data.at(-1).created_at);assert.equal(decoded.account,account);assert.equal(decoded.tenant,tenant);assert.equal(decoded.actor,actor);assert.equal(decoded.as_of,asOf);}}
  while(cursor);assert.deepEqual(found,f.rows.map(r=>r.id));assert.equal(new Set(found).size,53);assert.equal(JSON.stringify(f.rows),original);assert.equal(f.released,8);assert(f.queries.some(q=>q.sql.includes('FOR SHARE')));
 });
 await test('cursor refuses forged signature and changed tenant/actor/key/account/limit before borrowing a client',async()=>{
  const f=reset(),first=(await request('?limit=7')).json(),count=f.queries.length;
  const changed=first.next.slice(0,-1)+(first.next.endsWith('0')?'1':'0');assert.equal((await request('?limit=7&after='+changed)).statusCode,422);
  for(const key of ['tenantId','userId','apiKeyId']){const old=principal;principal={...old,[key]:other};assert.equal((await request('?limit=7&after='+first.next)).statusCode,422);principal=old;}
  assert.equal((await request('?limit=7&after='+first.next,other)).statusCode,422);assert.equal((await request('?limit=8&after='+first.next)).statusCode,422);assert.equal(f.queries.length,count);
 });
 await test('current membership and final recheck refuse stale admin without committing a disclosed page',async()=>{
  let f=reset();f.role='viewer';assert.equal((await request()).statusCode,403);assert(!f.queries.some(q=>q.sql.includes('FROM b2b_link_invitations')));assert(f.queries.some(q=>q.sql==='ROLLBACK'));
  f=reset();f.revokeAfterPage=true;const response=await request();assert.equal(response.statusCode,403);assert(!response.body.includes('PRIVATE'));assert(!f.queries.some(q=>q.sql==='COMMIT'));assert.equal(f.released,1);
  f=reset();principal.apiKeyId=id(8);f.revoked=true;assert.equal((await request()).statusCode,401);assert(!f.queries.some(q=>q.sql.includes('FROM b2b_link_invitations')));
 });
 await test('expiry uses one DB microsecond time across pages and never rewrites persisted pending state',async()=>{
  const f=reset(),first=(await request('?limit=7')).json();assert(first.data.some((r:any)=>r.expired));f.now='2026-10-18T13:00:00.000000Z';
  const page=(await request('?limit=7&after='+first.next)).json();assert.equal(page.expiry_evaluated_at,asOf);for(const row of page.data){const original=f.rows.find(r=>r.id===row.id)!;assert.equal(row.state,original.state);assert.equal(row.expired,original.state==='pending'&&original.expires_at<=asOf);}
  const refreshed=(await request('?limit=50')).json();assert.equal(refreshed.expiry_evaluated_at,f.now);assert(refreshed.data.filter((r:any)=>r.state==='pending').every((r:any)=>r.expired));
 });
 await test('strict query/identity/ownership/account-version bounds and empty history fail closed',async()=>{
  const f=reset();for(const query of ['?limit=0','?limit=51','?limit=1.2','?limit=2&include_tokens=true','?after=not-a-cursor'])assert.equal((await request(query)).statusCode,422);assert.equal(f.queries.length,0);
  principal=null;assert.equal((await request()).statusCode,401);principal={tenantId:tenant,userId:actor,role:'viewer'};assert.equal((await request()).statusCode,403);principal={tenantId:tenant,userId:actor,role:'admin'};
  assert.equal((await request('',other)).statusCode,404);assert.equal((await request('', 'invalid')).statusCode,422);
  const first=(await request('?limit=7')).json();f.accountVersion=3;assert.equal((await request('?limit=7&after='+first.next)).statusCode,409);f.rows=[];const empty=(await request()).json();assert.deepEqual(empty.data,[]);assert.equal(empty.next,null);
 });
}finally{await app.close();delete(globalThis as any).__invitationReadClient;await rm(temp,{recursive:true,force:true});}
