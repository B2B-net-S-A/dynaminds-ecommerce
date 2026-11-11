/** Root actual issued159-on166 gate; every pre-existing own-clone row/object is preserved. */
import assert from 'node:assert/strict';
import {readFile,writeFile,open,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const inputBytes=await readFile(resolve(process.argv[2]));assert.equal(hash(inputBytes),'39d74121db59e3427e42a020cf2c82e740c4e75076b9733c05a1627bae71bc2d');const input=JSON.parse(inputBytes.toString());assert.equal(input.database,'dynaminds_test_1791431348741');
const u=new URL(input.environment.DATABASE_URL);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55432');assert.equal(u.pathname,'/'+input.database);assert.equal(resolve(input.environment.DYNA_LOCAL_CONFIG_PATH),resolve(input.configuration.path));
const cfgBytes=await readFile(input.configuration.path);assert.equal(hash(cfgBytes),input.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
const directory=resolve(input.directory,'invoice2');await mkdir(directory,{mode:0o700});
async function save(n:string,v:unknown){const path=resolve(directory,n),bytes=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,sha256:hash(bytes)};}
const sources:Record<string,string>={};async function tree(d:string){for(const e of await readdir(d,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const p=d+'/'+e.name;if(p==='server/167_operational_delivery_consumers.sql'||p==='server/operational-delivery-consumers.ts')continue;if(e.isDirectory())await tree(p);else if(e.isFile()&&/\.(ts|tsx|sql|css)$/.test(e.name))sources[p]=hash(await readFile(p));}}
await tree('server');await tree('web');for(const p of ['tests/buyer-address-local-invoice166.test.ts','scripts/buyer-address-invoice166-run.ts','data/source-drafts/b2b-fa3-native-acceptance-fixtures2.ts','data/source-drafts/b2b-fa3-invoice159-issued-reader166.ts','data/source-drafts/b2b-fa3-invoice159-native-acceptance-oracles166.ts','package.json','package-lock.json'])sources[p]=hash(await readFile(p));
assert.equal(sources['tests/buyer-address-local-invoice166.test.ts'],'a1c04afcf93f50c397b06328195a3ff9357dde83f451edf6f3916c921d4e570b');assert.equal(sources['server/166_buyer_address_sidecar.sql'],'be9c25bfdfc2611422285653b7f417aa12ca289af60a3c706353f89797e9f912');const sourceCut=await save('sources.private.json',sources);
const make=(database:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database});
async function exclusive(){const c=make('postgres');try{await c.connect();assert.equal((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[input.database])).rows[0].n,0);}finally{await c.end();}}
async function capture(){const c=make(input.database);try{await c.connect();const s=await captureDatabase(c,false);s.guards.competitor_observation_guards=(await c.query('SELECT competitor_observation_guards() ok')).rows[0].ok;s.guards.buyer_address_guards=(await c.query('SELECT buyer_address_guards() ok')).rows[0].ok;return s;}finally{await c.end();}}
await exclusive();const before=await capture(),beforeRef=await save('before.private.json',before);assert.equal(Object.keys(before.graph.rows).length,560);assert.equal(before.graph.rows.migrations.length,166);assert(Object.values(before.guards).every(v=>v===true));
const logPath=resolve(directory,'test.private.log'),log=await open(logPath,'wx',0o600);let exit:number|null=null,failure:unknown,result:unknown;
try{
 exit=await new Promise<number|null>((done,reject)=>{const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1','--test-reporter=tap','tests/buyer-address-local-invoice166.test.ts'],{cwd:process.cwd(),env:{...process.env,...input.environment,DYNA_TEST:'true',DYNA_BUYER_ADDRESS_LOCAL_INVOICE_NATIVE:'true',DYNA_IMAGE_DIR:input.images,DYNA_PG_TOOLS:input.pg_tools},stdio:['ignore',log.fd,log.fd]});child.on('error',reject);child.on('exit',done);});
 await log.close();const after=await capture(),afterRef=await save('after.private.json',after);
 for(const [name,rows]of Object.entries(before.graph.rows)as[string,any[]][]){const current=new Set(after.graph.rows[name].map((r:any)=>hash(JSON.stringify(r))));for(const old of rows)assert(current.has(hash(JSON.stringify(old))),'Every pre-existing row retained: '+name);}
 assert.equal(hash(JSON.stringify(after.graph.exact_metadata)),hash(JSON.stringify(before.graph.exact_metadata)),'Entire existing exact metadata graph retained');assert.deepEqual(after.guards,before.guards);assert(Object.values(after.guards).every(v=>v===true));
 for(const[p,d]of Object.entries(sources))assert.equal(hash(await readFile(p)),d);assert.equal(hash(await readFile(input.configuration.path)),input.configuration.sha256);assert.equal(exit,0);
 const text=await readFile(logPath,'utf8');assert.match(text,/# pass 1\b/);assert.match(text,/# fail 0\b/);
 result={status:'ROOT_BUYER_ADDRESS166_ACTUAL_ISSUED_INVOICE159_PASS',tests:1,child_exit:exit,database:input.database,tables:560,migrations:166,guards:22,every_preexisting_row_and_exact_metadata_retained:true,bill_to:'Explicitly approved ORIGINAL buyer; no automatic autofill claim',actual_flow:'Product/order → address correction → paid/pick/scan/pack/DEMO dispatch → native158 project approval → native159 issue/detail/register/HTML/replay',ksef_submitted:false,fiscalized:false,provider_requests:0,sources:sourceCut,before:beforeRef,after:afterRef,test_log:{path:logPath,sha256:hash(text)}};
}catch(e){failure=e;await save('failure.private.json',{child_exit:exit,name:e instanceof Error?e.name:'Error',message:e instanceof Error?e.message:String(e)});}
finally{await log.close().catch(()=>{});await exclusive();await save('cleanup.private.json',{owned_clients_closed:true,child_exit:exit,status:failure?'FAILED':'PASS'});}
if(failure){console.log(JSON.stringify({status:'ROOT_BUYER_ADDRESS166_ISSUED_INVOICE159_FAILED',directory,child_exit:exit}));process.exitCode=1;}else{const ref=await save('result.private.json',result);console.log(JSON.stringify({status:'ROOT_BUYER_ADDRESS166_ACTUAL_ISSUED_INVOICE159_PASS',result:ref}));}
