/** Root-owned, additive local TEMPLATE clone. No app/runtime/seed imports.
 * Run: node --import tsx scripts/buyer-address-native166-prepare.ts
 * Keeps the accepted165 source and every pre-existing database intact. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureCompetitorPortability165,assertCompetitorPortability165Copy} from '../data/source-drafts/competitor-observations165-portability-native';

const prior=resolve('data/qa-competitor-observations165-portability-1791427399001');
const configPath=resolve(prior,'configuration.private.json');
const configBytes=await readFile(configPath);
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
assert.equal(hash(configBytes),'50949c4dd2b7e5117ea8f15d60f04f7cd0e681b4e5c6a52f0304a68c4ea2086e');
const config=JSON.parse(configBytes.toString());
const source='dynaminds_test_1791423513212',stamp=String(Date.now()),database='dynaminds_test_'+stamp;
assert.match(database,/^dynaminds_test_[0-9]{13}$/);
const directory=resolve('data/qa-buyer-address166-'+stamp);await mkdir(directory,{mode:0o700});
async function save(name:string,value:unknown){const path=resolve(directory,name),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,sha256:hash(bytes)};}
const make=(name:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:config.dbPassword,database:name});
const admin=make('postgres'),original=make(source);let clone:pg.Client|undefined,created=false,originalClosed=false;
let result:unknown,failure:unknown;
try{
 await admin.connect();await original.connect();
 assert.equal((await admin.query('SELECT inet_server_port() port,session_user owner')).rows[0].port,55432);
 const inventory=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r=>r.datname);
 assert(!inventory.includes(database));
 const sourcePid=(await original.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend' AND pid<>$2",[source,sourcePid])).rows[0].n,0);
 const before=await captureCompetitorPortability165(original,165);
 const expectedBytes=await readFile(resolve(prior,'original-install/after165.private.json'));
 assert.equal(hash(expectedBytes),'9e299cd67dbe27218c923afaff27767c90b445aa7202bcbf307e1ed312fbbb1c');
 assert.deepEqual(before,JSON.parse(expectedBytes.toString()),'Accepted original165 whole snapshot');
 const beforeRef=await save('original-before.private.json',before);await original.end();originalClosed=true;
 // Names are fixed or exact validated numeric identifiers, never user SQL.
 await admin.query('CREATE DATABASE "'+database+'" TEMPLATE "'+source+'"');created=true;
 clone=make(database);await clone.connect();const copy=await captureCompetitorPortability165(clone,165);
 assertCompetitorPortability165Copy(before,copy);
 const copyRef=await save('before166.private.json',copy);await clone.end();clone=undefined;
 const check=make(source);try{await check.connect();assert.deepEqual(await captureCompetitorPortability165(check,165),before,'Original remains literal after TEMPLATE');}finally{await check.end();}
 assert.deepEqual((await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r=>r.datname),[...inventory,database].sort());
 const configCopy=resolve(directory,'configuration.private.json');await writeFile(configCopy,configBytes,{flag:'wx',mode:0o600});
 const url=new URL('postgres://postgres@127.0.0.1:55432/'+database);url.password=config.dbPassword;
 const input=await save('input.private.json',{database,source_database:source,directory,configuration:{path:configCopy,sha256:hash(configBytes)},before:copyRef,original_before:beforeRef,images:resolve('data/product-images'),pg_tools:'<home>/.local/share/dynaminds/pg-tools/18/bin',environment:{DATABASE_URL:url.toString(),DYNA_LOCAL_CONFIG_PATH:configCopy,DYNA_TEST:'true',DYNA_BUYER_ADDRESS_NATIVE:'true',DYNA_WORKER_DISABLED:'true'},inventory_count:inventory.length,preexisting_database_inventory_unchanged:true,original_source_whole_snapshot_unchanged:true});
 result={status:'ROOT_BUYER_ADDRESS166_TEMPLATE_PREPARED',database,input};
}catch(e){failure=e;await save('failure.private.json',{name:e instanceof Error?e.name:'Error',message:e instanceof Error?e.message:String(e),created,database}).catch(()=>{});}
finally{const cleanup=await Promise.allSettled([admin.end(),...(originalClosed?[]:[original.end()]),...(clone?[clone.end()]:[])]);if(cleanup.some(v=>v.status==='rejected'))failure??=new Error('Template preparation cleanup failed');await save('cleanup.private.json',{created,database,closers:cleanup.map(v=>v.status),status:failure?'FAILED':'PASS'});}
if(failure){console.log(JSON.stringify({status:'ROOT_BUYER_ADDRESS166_TEMPLATE_FAILED',directory,database,created}));process.exitCode=1;}else console.log(JSON.stringify(result));
