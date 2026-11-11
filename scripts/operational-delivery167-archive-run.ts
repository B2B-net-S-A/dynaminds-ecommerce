/** Root real AES archive/restore167 gate, no app, seed, migration or provider calls. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const inputBytes=await readFile(resolve(process.argv[2]));assert.equal(hash(inputBytes),'c199ba86890044152bfb51b6e7443a111a3cb08c102637ff6ca1be2066682e64');
const input=JSON.parse(inputBytes.toString());assert.equal(input.database,'dynaminds_test_1791434457369');
const cfgBytes=await readFile(input.configuration.path);assert.equal(hash(cfgBytes),input.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
const u=new URL(input.environment.DATABASE_URL);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55432');assert.equal(u.pathname,'/'+input.database);assert.equal(resolve(input.environment.DYNA_LOCAL_CONFIG_PATH),resolve(input.configuration.path));
Object.assign(process.env,input.environment,{DYNA_TEST:'true',DYNA_WORKER_DISABLED:'true',DYNA_IMAGE_DIR:input.images,DYNA_PG_TOOLS:input.pg_tools,APP_REVISION:'local-operational-delivery167'});
const directory=resolve(input.directory,'consumer167-archive1');await mkdir(directory,{mode:0o700});
async function save(name:string,value:unknown){const path=resolve(directory,name),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,sha256:hash(bytes)};}
const sources:Record<string,string>={};async function tree(d:string){for(const e of await readdir(d,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const p=d+'/'+e.name;if(p==='server/fa3-xml.ts')continue;if(e.isDirectory())await tree(p);else if(e.isFile()&&/\.(ts|tsx|sql|css|json|html)$/.test(e.name))sources[p]=hash(await readFile(p));}}
await tree('server');await tree('web');for(const p of ['package.json','package-lock.json','scripts/operational-delivery167-archive-run.ts','data/source-drafts/b2b-financial-return162-root-capture189.ts','scripts/stocktake-adjustments-native164-preservation.ts','scripts/return-destinations-native162-restore-readback.ts'])sources[p]=hash(await readFile(p));
assert.equal(sources['server/166_buyer_address_sidecar.sql'],'be9c25bfdfc2611422285653b7f417aa12ca289af60a3c706353f89797e9f912');
assert.equal(sources['server/buyer-address.ts'],'8ae53edcad557fc3e48622fae6dc0fd72964a2c62950b1cdb9f2e4fa0a3d6e5a');
assert.equal(sources['server/167_operational_delivery_consumers.sql'],'256db77a1389c248b152c628d963a42496c085488b2de548ed61d04d761cf6d6');
assert.equal(sources['server/operational-delivery-consumers.ts'],'2b40782bf679b8e9ec504346c2704206e978bc1f233d1c98e582bc3f1d0c809f');
const sourceCut=await save('sources.private.json',sources);
const make=(database:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database});
async function exclusive(names:string[]){const c=make('postgres');try{await c.connect();assert.equal((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND backend_type='client backend'",[names])).rows[0].n,0);}finally{await c.end();}}
async function capture(database:string){const c=make(database);try{await c.connect();const s=await captureDatabase(c,false);s.guards.competitor_observation_guards=(await c.query('SELECT competitor_observation_guards() ok')).rows[0].ok;s.guards.buyer_address_guards=(await c.query('SELECT buyer_address_guards() ok')).rows[0].ok;s.guards.operative_delivery_valid=(await c.query('SELECT operative_delivery_valid() ok')).rows[0].ok;assert(Object.values(s.guards).every(x=>x===true));return s;}finally{await c.end();}}
async function cluster(){const c=make('postgres');try{await c.connect();return{roles:(await c.query('SELECT to_jsonb(r) row FROM pg_roles r ORDER BY rolname')).rows,memberships:(await c.query('SELECT to_jsonb(r) row FROM pg_auth_members r ORDER BY 1')).rows,databases:(await c.query('SELECT to_jsonb(r) row FROM pg_database r ORDER BY datname')).rows};}finally{await c.end();}}
async function images(){const rows:unknown[]=[];async function visit(p:string,relative:string){const s=await lstat(p);assert(!s.isSymbolicLink());if(s.isDirectory()){rows.push({path:relative,directory:true,mode:s.mode&0o777});for(const n of (await readdir(p)).sort())await visit(resolve(p,n),relative?relative+'/'+n:n);}else{assert(s.isFile());rows.push({path:relative,bytes:s.size,mode:s.mode&0o777,sha256:hash(await readFile(p))});}}await visit(resolve(input.images),'');return rows;}
const portable=(s:any)=>({rows:s.graph.rows,metadata:s.graph.metadata,guards:s.guards,primary_keys:s.primary_keys,sequences:s.sequences,views:s.views});
await exclusive([input.database]);const before=await capture(input.database),beforeRef=await save('before.private.json',before),clusterBefore=await cluster(),imagesBefore=await images();
assert.equal(Object.keys(before.graph.rows).length,562);assert.equal(before.graph.rows.migrations.length,167);assert.equal(before.graph.rows.product_images.length,0);
const clusterBeforeRef=await save('cluster-before.private.json',clusterBefore),imagesBeforeRef=await save('images-before.private.json',imagesBefore);
const originalFetch=globalThis.fetch;let attempts=0;const deny:typeof fetch=async()=>{attempts++;throw new Error('Provider calls forbidden during local archive acceptance');};globalThis.fetch=deny;
let runtimePool:any,copyDatabase:string|undefined,failure:unknown,accepted:unknown;
try{
 const recovery=await import('../server/recovery');runtimePool=(await import('../server/db')).pool;
 const keyFile=resolve(directory,'recovery-key.private');await recovery.recoveryKey(keyFile,true);const keyPin=hash(await readFile(keyFile));
 const backup=await recovery.createBackup({directory:resolve(directory,'archives'),keyFile,imageDirectory:resolve(input.images)});const backupRef=await save('backup.private.json',backup);
 assert.equal(backup.status,'created');assert.equal(backup.encryption,'AES-256-GCM');assert.equal(backup.tables,562);assert.equal(backup.schema,'167');assert.equal(backup.images,0);assert.equal(backup.source,input.database);assert.equal(hash(await readFile(backup.file)),backup.sha256);
 const restored=await recovery.restoreBackup(backup.file,{directory:resolve(directory,'restores'),keyFile});copyDatabase=restored.database;const restoreRef=await save('restore.private.json',restored);
 assert.match(copyDatabase!,/^dynaminds_restore_[a-f0-9]{16}$/);assert.equal(restored.status,'verified');assert.equal(restored.preview_only,true);assert.equal(restored.worker_enabled,false);assert.equal(restored.tables,562);assert.equal(restored.image_count,0);assert.equal(restored.schema_fingerprint_match,true);assert.equal(restored.row_fingerprints_match,true);
 const copy=await capture(copyDatabase!),copyRef=await save('copy.private.json',copy);
 assert.equal(hash(JSON.stringify(portable(copy))),hash(JSON.stringify(portable(before))),'Complete portable562 rows/schema/PK/sequence/views/23guards match');
 const after=await capture(input.database),afterRef=await save('after.private.json',after);assert.equal(hash(JSON.stringify(after)),hash(JSON.stringify(before)),'Entire source rows/exact object graph stays literal');
 const clusterAfter=await cluster(),clusterAfterRef=await save('cluster-after.private.json',clusterAfter);assert.deepEqual(clusterAfter.roles,clusterBefore.roles);assert.deepEqual(clusterAfter.memberships,clusterBefore.memberships);assert.equal(clusterAfter.databases.length,clusterBefore.databases.length+1);assert.deepEqual(clusterAfter.databases.filter((r:any)=>r.row.datname!==copyDatabase),clusterBefore.databases);
 const imagesAfter=await images(),imagesAfterRef=await save('images-after.private.json',imagesAfter);assert.deepEqual(imagesAfter,imagesBefore);assert.equal(hash(await readFile(keyFile)),keyPin);assert.equal(hash(await readFile(input.configuration.path)),input.configuration.sha256);
 for(const [p,d]of Object.entries(sources))assert.equal(hash(await readFile(p)),d);assert.equal(attempts,0);
 accepted={status:'ROOT_OPERATIONAL_DELIVERY167_ACTUAL_ENCRYPTED_ARCHIVE_RESTORE_PASS',source_database:input.database,copy_database:copyDatabase,tables:562,migrations:167,guards:23,encryption:'AES-256-GCM',source_whole_literal:true,copy_whole_portable_literal:true,cluster_only_one_owned_copy:true,cluster_role_membership_literal:true,image_count:0,shared_image_inventory_literal:true,unreferenced_images_not_archived:true,provider_attempts:attempts,sources:sourceCut,excluded_unregistered_source:['server/fa3-xml.ts'],before:beforeRef,after:afterRef,copy:copyRef,backup:backupRef,restore:restoreRef,cluster_before:clusterBeforeRef,cluster_after:clusterAfterRef,images_before:imagesBeforeRef,images_after:imagesAfterRef,other_database_business_rows:'NOT_REMEASURED',new_copy_app_api:'NOT_RUN'};
}catch(e){failure=e;await save('failure.private.json',{name:e instanceof Error?e.name:'Error',message:e instanceof Error?e.message:String(e),copy_database:copyDatabase??null});}
finally{
 const closed=await Promise.allSettled(runtimePool?[runtimePool.end()]:[]);
 if(closed.some(r=>r.status==='rejected'))failure??=new Error('Owned runtime pool closure failed');
 if(globalThis.fetch!==deny)failure??=new Error('Fetch custody changed during archive gate');
 globalThis.fetch=originalFetch;
 let clientsClosed=false;try{await exclusive([input.database,...(copyDatabase?[copyDatabase]:[])]);clientsClosed=true;}catch(e){failure??=e;}
 if(attempts!==0)failure??=new Error('Provider call attempted during archive gate');
 await save('cleanup.private.json',{owned_clients_closed:clientsClosed,runtime_pool_close:closed.map(r=>r.status),provider_attempts:attempts,status:failure?'FAILED':'PASS'});
}
if(failure){console.log(JSON.stringify({status:'ROOT_OPERATIONAL_DELIVERY167_ARCHIVE_RESTORE_FAILED',directory}));process.exitCode=1;}else{const result=await save('result.private.json',{...(accepted as object),owned_clients_and_runtime_pool_closed:true});console.log(JSON.stringify({status:'ROOT_OPERATIONAL_DELIVERY167_ACTUAL_ENCRYPTED_ARCHIVE_RESTORE_PASS',result}));}
