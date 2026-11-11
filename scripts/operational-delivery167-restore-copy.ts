/** Root restores the already accepted167 archive into one fresh copy; keeps prior failed-login copy. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const base=resolve('data/qa-operational-delivery167-1791434457369'),inputBytes=await readFile(resolve(base,'input.private.json'));assert.equal(hash(inputBytes),'c199ba86890044152bfb51b6e7443a111a3cb08c102637ff6ca1be2066682e64');const input=JSON.parse(inputBytes.toString());
const archiveBytes=await readFile(resolve(base,'consumer167-archive1/result.private.json'));assert.equal(hash(archiveBytes),'dd53ca489a9eec99f24037cc6a75f44855484a9ba31b77d7e0f4e688562429ed');const archive=JSON.parse(archiveBytes.toString());
const backupBytes=await readFile(archive.backup.path);assert.equal(hash(backupBytes),archive.backup.sha256);const backup=JSON.parse(backupBytes.toString());assert.equal(hash(await readFile(backup.file)),backup.sha256);
const cfgBytes=await readFile(input.configuration.path);assert.equal(hash(cfgBytes),input.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
Object.assign(process.env,input.environment,{DYNA_TEST:'true',DYNA_WORKER_DISABLED:'true',DYNA_IMAGE_DIR:input.images,DYNA_PG_TOOLS:input.pg_tools});
const directory=resolve(base,'consumer167-restore2');await mkdir(directory,{mode:0o700});
async function save(n:string,v:unknown){const path=resolve(directory,n),bytes=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,sha256:hash(bytes)};}
const make=(database:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database});
async function capture(database:string){const c=make(database);try{await c.connect();const s=await captureDatabase(c,false);s.guards.competitor_observation_guards=(await c.query('SELECT competitor_observation_guards() ok')).rows[0].ok;s.guards.buyer_address_guards=(await c.query('SELECT buyer_address_guards() ok')).rows[0].ok;s.guards.operative_delivery_valid=(await c.query('SELECT operative_delivery_valid() ok')).rows[0].ok;assert(Object.values(s.guards).every(v=>v===true));return s;}finally{await c.end();}}
async function cluster(){const c=make('postgres');try{await c.connect();return{names:(await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows,roles:(await c.query('SELECT to_jsonb(r) row FROM pg_roles r ORDER BY rolname')).rows,members:(await c.query('SELECT to_jsonb(m) row FROM pg_auth_members m ORDER BY roleid,member,grantor')).rows};}finally{await c.end();}}
const portable=(s:any)=>({rows:s.graph.rows,metadata:s.graph.metadata,guards:s.guards,primary_keys:s.primary_keys,sequences:s.sequences,views:s.views});
const before=await capture(input.database),beforeRef=await save('source-before.private.json',before),clusterBefore=await cluster();assert.equal(Object.keys(before.graph.rows).length,562);assert.equal(before.graph.rows.migrations.length,167);
const savedFetch=globalThis.fetch;let attempts=0;globalThis.fetch=async()=>{++attempts;throw Error('External fetch forbidden in restore-only gate');};let pool:any,copyDatabase:string|undefined,failure:unknown,result:unknown;
try{
 const recovery=await import('../server/recovery');pool=(await import('../server/db')).pool;
 const keyFile=resolve(base,'consumer167-archive1/recovery-key.private'),keyHash=hash(await readFile(keyFile));
 const restored=await recovery.restoreBackup(backup.file,{directory:resolve(directory,'restores'),keyFile});copyDatabase=restored.database;
 assert.equal(restored.status,'verified');assert.equal(restored.tables,562);assert.equal(restored.preview_only,true);assert.equal(restored.worker_enabled,false);assert.equal(restored.encrypted_records_verified,103);
 const restoreRef=await save('restore.private.json',restored),copy=await capture(copyDatabase!),copyRef=await save('copy.private.json',copy),after=await capture(input.database),afterRef=await save('source-after.private.json',after);
 assert.deepEqual(portable(copy),portable(before));assert.deepEqual(after,before);assert.equal(hash(await readFile(keyFile)),keyHash);assert.equal(hash(await readFile(backup.file)),backup.sha256);
 const next=await cluster();assert.deepEqual(next.roles,clusterBefore.roles);assert.deepEqual(next.members,clusterBefore.members);assert.deepEqual(next.names.filter(r=>r.datname!==copyDatabase),clusterBefore.names);assert.equal(next.names.length,clusterBefore.names.length+1);assert.equal(attempts,0);
 result={status:'ROOT_OPERATIONAL_DELIVERY167_FRESH_RESTORE_PASS',database:copyDatabase,source:input.database,restore:restoreRef,copy:copyRef,before:beforeRef,after:afterRef,whole562_copy_portable_and_source_exact:true,one_new_copy_and_roles_memberships_literal:true,provider_requests:0};
}catch(e){failure=e;await save('failure.private.json',{name:(e as any)?.name,message:(e as any)?.message,database:copyDatabase});}
finally{const closed=await Promise.allSettled(pool?[pool.end()]:[]);globalThis.fetch=savedFetch;if(closed.some(r=>r.status==='rejected'))failure??=Error('Runtime pool closure failed');const admin=make('postgres');try{await admin.connect();assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND backend_type='client backend'",[[input.database,...(copyDatabase?[copyDatabase]:[])]] )).rows[0].n,0);await save('cleanup.private.json',{closed:true,status:failure?'FAILED':'PASS',provider_requests:attempts});}finally{await admin.end();}}
if(failure){console.log(JSON.stringify({status:'ROOT_OPERATIONAL_DELIVERY167_FRESH_RESTORE_FAILED',directory}));process.exitCode=1;}else console.log(JSON.stringify({status:'ROOT_OPERATIONAL_DELIVERY167_FRESH_RESTORE_PASS',result:await save('result.private.json',result)}));
