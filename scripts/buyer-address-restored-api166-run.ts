/** Genuine read-only Fastify API on actual restored166 copy; no listeners or fixture writes. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {createHash,createDecipheriv} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
const root=resolve('data/qa-buyer-address166-1791431348741'),archiveBytes=await readFile(resolve(root,'archive1/result.private.json'));
assert.equal(hash(archiveBytes),'e17759eaec91096d4ccba0fd32043182505eebc4af6c82f10ade5a51b4386fb3');
const archive=JSON.parse(archiveBytes.toString()),restoreBytes=await readFile(archive.restore.path);assert.equal(hash(restoreBytes),archive.restore.sha256);const restore=JSON.parse(restoreBytes.toString());
const input=JSON.parse(await readFile(resolve(root,'input.private.json'),'utf8'));
assert.equal(restore.database,archive.copy_database);assert.match(restore.database,/^dynaminds_restore_[a-f0-9]{16}$/);
assert.equal((await lstat(restore.config)).mode&0o777,0o600);const configBytes=await readFile(restore.config),cfg=JSON.parse(configBytes.toString());
const url=new URL(input.environment.DATABASE_URL);url.pathname='/'+restore.database;
Object.assign(process.env,input.environment,{DATABASE_URL:url.href,DYNA_LOCAL_CONFIG_PATH:restore.config,DYNA_TEST:'true',DYNA_WORKER_DISABLED:'true',DYNA_IMAGE_DIR:restore.images,DYNA_PG_TOOLS:input.pg_tools});
const directory=resolve(root,'restored-api1');await mkdir(directory,{mode:0o700});
async function save(n:string,v:unknown){const path=resolve(directory,n),bytes=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,sha256:hash(bytes)};}
const make=(database:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database});
async function snapshot(){const c=make(restore.database);try{await c.connect();const s=await captureDatabase(c,false);s.guards.competitor_observation_guards=(await c.query('SELECT competitor_observation_guards() ok')).rows[0].ok;s.guards.buyer_address_guards=(await c.query('SELECT buyer_address_guards() ok')).rows[0].ok;return s;}finally{await c.end();}}
const before=await snapshot(),beforeRef=await save('before.private.json',before);
assert.equal(Object.keys(before.graph.rows).length,560);assert(Object.values(before.guards).every(v=>v===true));
const c=make(restore.database);let enabled:any,disabled:any;try{await c.connect();enabled=(await c.query(`SELECT o.portal_token,s.delivery_override_encrypted FROM orders o JOIN buyer_address_state s ON(s.tenant_id,s.order_id)=(o.tenant_id,o.id) WHERE s.enabled AND s.delivery_override_encrypted IS NOT NULL AND o.portal_token IS NOT NULL AND o.portal_expires_at>clock_timestamp() ORDER BY o.id LIMIT 1`)).rows[0];disabled=(await c.query('SELECT portal_token FROM orders WHERE id=$1',['12d0317c-95cd-41aa-a762-032945462ec9'])).rows[0];assert(enabled&&disabled);}finally{await c.end();}
const cipher=Buffer.from(enabled.delivery_override_encrypted,'base64'),decipher=createDecipheriv('aes-256-gcm',Buffer.from(cfg.encryptionKey,'hex'),cipher.subarray(0,12));decipher.setAuthTag(cipher.subarray(12,28));const actualDelivery=JSON.parse(Buffer.concat([decipher.update(cipher.subarray(28)),decipher.final()]).toString('utf8'));
let app:any,pool:any,failure:unknown;
try{
 const sources=JSON.parse(await readFile(archive.sources.path,'utf8'));for(const [p,d]of Object.entries(sources))assert.equal(hash(await readFile(p)),d,'Archive executable source cut stays exact');
 ({pool}=await import('../server/db'));const {buildApp}=await import('../server/app');app=await buildApp({logging:false,backgroundWorkersEnabled:false,readOnly:true,previewPort:4195});
 const path='/api/public/orders/'+enabled.portal_token+'/address';
 const r=await app.inject({method:'GET',url:path});assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'no-store');const v=r.json();assert.equal(v.read_only,true);assert.equal(v.enabled,true);assert.equal(v.can_edit,false);assert.equal(v.reason,'read_only');assert.equal(hash(canonical(v.delivery)),hash(canonical(actualDelivery)));
 const off=await app.inject({method:'GET',url:'/api/public/orders/'+disabled.portal_token+'/address'});assert.equal(off.statusCode,200);assert.equal(off.json().enabled,false);assert.equal(off.json().delivery,null);
 for(const suffix of ['/previews','/previews/00000000-0000-4000-8000-000000000001/apply']){const mutation=await app.inject({method:'POST',url:path+suffix,headers:{'content-type':'application/json'},payload:'{'});assert.equal(mutation.statusCode,423,'Read-only refusal precedes malformed JSON parsing');}
 await app.close();app=undefined;await pool.end();pool=undefined;
 const after=await snapshot(),afterRef=await save('after.private.json',after);assert.equal(hash(JSON.stringify(after)),hash(JSON.stringify(before)),'All560 restored tables and exact metadata remain literal after API read/refusals');assert.equal(hash(await readFile(restore.config)),hash(configBytes));
 const result=await save('result.private.json',{status:'ROOT_BUYER_ADDRESS166_ACTUAL_RESTORED_READONLY_API_PASS',database:restore.database,checks:5,enabled_current_delivery_matches_authenticated_cipher:true,optout_public_pii_hidden:true,readonly_malformed_preview_and_apply_423:true,all_560_tables_and_metadata_literal:true,config_literal:true,before:beforeRef,after:afterRef,archive:{path:resolve(root,'archive1/result.private.json'),sha256:hash(archiveBytes)},protected_operator_api:'NOT_RUN',browser_on_restored_copy:'NOT_RUN',listeners_started:false,workers_started:false,fixture_writes:false});console.log(JSON.stringify({status:'ROOT_BUYER_ADDRESS166_ACTUAL_RESTORED_READONLY_API_PASS',result}));
}catch(e){failure=e;await save('failure.private.json',{name:e instanceof Error?e.name:'Error',message:e instanceof Error?e.message:String(e)});console.log(JSON.stringify({status:'ROOT_BUYER_ADDRESS166_RESTORED_READONLY_API_FAILED',directory}));process.exitCode=1;}
finally{const closure=await Promise.allSettled([...(app?[app.close()]:[]),...(pool?[pool.end()]:[])]);const admin=make('postgres');try{await admin.connect();const count=(await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[restore.database])).rows[0].n;assert.equal(count,0);assert(closure.every(r=>r.status==='fulfilled'));await save('cleanup.private.json',{status:failure?'FAILED':'PASS',owned_clients_closed:true,closure:closure.map(r=>r.status)});}finally{await admin.end();}}
