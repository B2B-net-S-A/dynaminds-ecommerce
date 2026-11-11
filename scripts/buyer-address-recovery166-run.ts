/** Root-owned native validator gate. No migration, app, seed, archive or remote writes. */
import assert from 'node:assert/strict';
import {readFile,writeFile,open,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const inputBytes=await readFile(resolve(process.argv[2]));
assert.equal(hash(inputBytes),'39d74121db59e3427e42a020cf2c82e740c4e75076b9733c05a1627bae71bc2d');
const input=JSON.parse(inputBytes.toString());
assert.equal(input.database,'dynaminds_test_1791431348741');
const cfgBytes=await readFile(input.configuration.path);assert.equal(hash(cfgBytes),input.configuration.sha256);
const cfg=JSON.parse(cfgBytes.toString());
const directory=resolve(input.directory,'recovery4');await mkdir(directory,{mode:0o700});
const pins:Record<string,string>={
 'server/166_buyer_address_sidecar.sql':'be9c25bfdfc2611422285653b7f417aa12ca289af60a3c706353f89797e9f912',
 'server/buyer-address.ts':'8ae53edcad557fc3e48622fae6dc0fd72964a2c62950b1cdb9f2e4fa0a3d6e5a',
 'tests/buyer-address-recovery166.test.ts':'42735d532f2985a187f347675a20dfef443c6b927844d38044325f73bb164cc2'};
for(const [path,sha] of Object.entries(pins))assert.equal(hash(await readFile(path)),sha);
async function save(name:string,value:unknown){const path=resolve(directory,name),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,sha256:hash(bytes)};}
const make=(database:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database});
async function exclusive(){const c=make('postgres');try{await c.connect();assert.equal((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[input.database])).rows[0].n,0,'Own native fixture has no other clients');}finally{await c.end();}}
async function capture(){const c=make(input.database);try{await c.connect();const data=await captureDatabase(c,false);data.guards.competitor_observation_guards=(await c.query('SELECT competitor_observation_guards() ok')).rows[0].ok;data.guards.buyer_address_guards=(await c.query('SELECT buyer_address_guards() ok')).rows[0].ok;return data;}finally{await c.end();}}
await exclusive();const before=await capture(),beforeRef=await save('before.private.json',before);
assert.equal(Object.keys(before.graph.rows).length,560);assert.equal(before.graph.rows.migrations.length,166);assert(Object.values(before.guards).every(x=>x===true));
const logPath=resolve(directory,'test.private.log'),log=await open(logPath,'wx',0o600);
let childExit:number|null=null,failure:unknown;
try{
 childExit=await new Promise<number|null>((done,reject)=>{const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1','--test-reporter=tap','tests/buyer-address-recovery166.test.ts'],{cwd:process.cwd(),env:{...process.env,...input.environment,DYNA_TEST:'true',DYNA_BUYER_ADDRESS_RECOVERY_NATIVE:'true'},stdio:['ignore',log.fd,log.fd]});child.on('error',reject);child.on('exit',done);});
 await log.close();const after=await capture(),afterRef=await save('after.private.json',after);
 assert.equal(hash(JSON.stringify(after)),hash(JSON.stringify(before)),'Complete 560-table rows and exact object graph unchanged');
 assert.equal(childExit,0);const text=await readFile(logPath,'utf8');assert.match(text,/# pass 4\b/);assert.match(text,/# fail 0\b/);
 for(const [path,sha] of Object.entries(pins))assert.equal(hash(await readFile(path)),sha);
 await exclusive();
 const result=await save('result.private.json',{status:'ROOT_BUYER_ADDRESS166_RECOVERY_VALIDATOR_PASS',tests:4,child_exit:childExit,database:input.database,all_560_tables_and_metadata_literal:true,guards:Object.keys(after.guards).length,before:beforeRef,after:afterRef,pins,test_log:{path:logPath,sha256:hash(text)},owned_clients_closed:true,archive_restore:'NOT_RUN'});
 console.log(JSON.stringify({status:'ROOT_BUYER_ADDRESS166_RECOVERY_VALIDATOR_PASS',tests:4,result}));
}catch(e){failure=e;await save('failure.private.json',{child_exit:childExit,name:e instanceof Error?e.name:'Error',message:e instanceof Error?e.message:String(e)});console.log(JSON.stringify({status:'ROOT_BUYER_ADDRESS166_RECOVERY_VALIDATOR_FAILED',child_exit:childExit,directory}));process.exitCode=1;}
finally{await log.close().catch(()=>{});try{await exclusive();await save('cleanup.private.json',{owned_clients_closed:true,child_exit:childExit,status:failure?'FAILED':'PASS'});}catch(e){process.exitCode=1;}}
