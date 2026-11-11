/** Root genuine native API gate. CLI: absolute input.private.json path.
 * The child receives credentials only through its environment. All detailed
 * test output/snapshots remain private; stdout contains only receipt metadata. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir,open,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
import {captureCompetitorPortability165} from '../data/source-drafts/competitor-observations165-portability-native';
const inputPath=resolve(process.argv[2]),inputBytes=await readFile(inputPath);
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const expectedInputHash=process.argv[4]??'fb0f28fae29757f7e662bec65b510f544f9a86e989b8eb77c3cff20cde8b1f8c';assert.match(expectedInputHash,/^[a-f0-9]{64}$/);assert.equal(hash(inputBytes),expectedInputHash);
const input=JSON.parse(inputBytes.toString());assert.match(input.database,/^dynaminds_test_[0-9]{13}$/);
const runName=process.argv[3]??'native2';assert.match(runName,/^native[0-9]+$/);
const directory=resolve(input.directory,runName);await mkdir(directory,{mode:0o700});
async function save(name:string,v:unknown){const path=resolve(directory,name),bytes=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,sha256:hash(bytes)};}
// Future167 drafts have no registry/import/callsite and are owned by another
// active lane. They are not part of this166 executable cut.
const excluded=new Set(['server/167_operational_delivery_consumers.sql','server/operational-delivery-consumers.ts']);
const sources:Record<string,string>={};async function tree(d:string){for(const e of await readdir(d,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const p=d+'/'+e.name;if(excluded.has(p))continue;if(e.isDirectory())await tree(p);else if(e.isFile()&&/\.(ts|tsx|sql|css)$/.test(e.name))sources[p]=hash(await readFile(p));}}
await tree('server');await tree('web');for(const p of ['tests/buyer-address.test.ts','scripts/buyer-address-native166-run.ts','package.json','package-lock.json'])sources[p]=hash(await readFile(p));
assert.equal(sources['server/166_buyer_address_sidecar.sql'],'be9c25bfdfc2611422285653b7f417aa12ca289af60a3c706353f89797e9f912');
assert.equal(sources['server/buyer-address.ts'],'8ae53edcad557fc3e48622fae6dc0fd72964a2c62950b1cdb9f2e4fa0a3d6e5a');
assert.equal(sources['tests/buyer-address.test.ts'],'7b06b80685ac5f03d81c0a2bf8fcb0ac753689e5e9bf1c3f2b3faa91eb49555e');
const sourceCut=await save('sources.private.json',sources);
const configBytes=await readFile(input.configuration.path);assert.equal(hash(configBytes),input.configuration.sha256);
const cfg=JSON.parse(configBytes.toString());
const make=(database:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database});
let childExit:number|null=null,result:unknown,failure:unknown;
const logPath=resolve(directory,'test.private.log'),log=await open(logPath,'wx',0o600);
try{
 const target=make(input.database);try{await target.connect();const ledger=(await target.query('SELECT name FROM migrations ORDER BY name')).rows;assert.equal(ledger.length,165);assert(!ledger.some(r=>r.name==='166_buyer_address_sidecar'));}finally{await target.end();}
 childExit=await new Promise<number|null>((done,reject)=>{const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1','--test-reporter=tap','tests/buyer-address.test.ts'],{cwd:process.cwd(),env:{...process.env,...input.environment,DYNA_IMAGE_DIR:input.images,DYNA_PG_TOOLS:input.pg_tools},stdio:['ignore',log.fd,log.fd]});child.on('error',reject);child.on('exit',done);});
 await log.close();
 const c=make(input.database);let after:any;try{await c.connect();after=await captureDatabase(c,false);after.guards.competitor_observation_guards=(await c.query('SELECT competitor_observation_guards() ok')).rows[0].ok;}finally{await c.end();}
 const afterRef=await save('after.private.json',after);
 const beforeBytes=await readFile(input.before.path);assert.equal(hash(beforeBytes),input.before.sha256);
 const before=JSON.parse(beforeBytes.toString());
 // New API fixtures are additive. Every pre-existing row and object is retained.
 for(const [name,rows] of Object.entries(before.graph.rows) as [string,any[]][]){const current=new Set(after.graph.rows[name].map((r:any)=>hash(JSON.stringify(r))));for(const old of rows)assert(current.has(hash(JSON.stringify(old))),'Pre-existing row retained: '+name);}
 for(const section of ['relations','functions','triggers','tables'])for(const old of before.graph.exact_metadata[section])assert.deepEqual(after.graph.exact_metadata[section].find((r:any)=>r.oid===old.oid),old,'Pre-existing metadata retained: '+section);
 assert.deepEqual(after.guards,before.guards);assert(Object.values(after.guards).every(v=>v===true));
 const fresh=after.graph.exact_metadata.triggers.filter((r:any)=>!before.graph.exact_metadata.triggers.some((o:any)=>o.oid===r.oid));
 const parentRI=fresh.filter((r:any)=>!r.relname.startsWith('buyer_address_'));
 assert(parentRI.every((r:any)=>r.meta.tgisinternal===true),'Only internal RI triggers added to existing parents');
 const newTables=after.graph.exact_metadata.tables.filter((r:any)=>!before.graph.exact_metadata.tables.some((o:any)=>o.oid===r.oid));
 const newFKs=newTables.flatMap((t:any)=>t.constraints.filter((k:any)=>k.meta.contype==='f'));
 for(const ri of parentRI)assert(newFKs.some((k:any)=>k.meta.oid===ri.meta.tgconstraint),'Added parent RI belongs to a new sidecar FK');
 for(const fk of newFKs){const ri=fresh.filter((r:any)=>r.meta.tgconstraint===fk.meta.oid);assert.equal(ri.length,4,'Complete child/parent RI tuple');assert.deepEqual(ri.map((r:any)=>r.meta.tgrelid).sort(),[fk.meta.conrelid,fk.meta.conrelid,fk.meta.confrelid,fk.meta.confrelid].sort());}
 for(const section of ['relations','tables'])for(const r of after.graph.exact_metadata[section].filter((r:any)=>!before.graph.exact_metadata[section].some((o:any)=>o.oid===r.oid)))assert(r.relname.startsWith('buyer_address_'),'Only own relations/tables are added');
 for(const f of after.graph.exact_metadata.functions.filter((r:any)=>!before.graph.exact_metadata.functions.some((o:any)=>o.oid===r.oid)))assert(f.signature.startsWith('buyer_address_'),'Only own function additions');
 for(const t of fresh.filter((r:any)=>!r.meta.tgisinternal))assert(t.relname.startsWith('buyer_address_')&&t.meta.tgname.startsWith('buyer_address_'),'Only own user triggers added');
 const originalBytes=await readFile(input.original_before.path);assert.equal(hash(originalBytes),input.original_before.sha256);
 const original=make(input.source_database);try{await original.connect();assert.deepEqual(await captureCompetitorPortability165(original,165),JSON.parse(originalBytes.toString()),'Original source remains literal');}finally{await original.end();}
 for(const [path,digest] of Object.entries(sources))assert.equal(hash(await readFile(path)),digest,'Actual code cut remains frozen: '+path);
 assert.equal(hash(await readFile(input.configuration.path)),input.configuration.sha256);
 assert.equal(childExit,0,'Actual native API tests must pass');
 assert.equal(Object.keys(after.graph.rows).length,560);assert.equal(after.graph.rows.migrations.length,166);
 const check=make(input.database);let ownGuard:boolean;try{await check.connect();ownGuard=(await check.query('SELECT buyer_address_guards() ok')).rows[0].ok;assert.equal(ownGuard,true);}finally{await check.end();}
 const text=await readFile(logPath,'utf8');assert.match(text,/# pass 10\b/);assert.match(text,/# fail 0\b/);
 result={status:'ROOT_BUYER_ADDRESS166_NATIVE_API_PASS',database:input.database,tests:10,tables:560,migrations:166,old_guards:Object.keys(after.guards).length,own_guard:ownGuard,old_rows_and_objects_retained:true,original_source_literal:true,parent_internal_ri_additions:parentRI.length,child_exit:childExit,sources:sourceCut,after:afterRef,test_log:{path:logPath,sha256:hash(text)}};
}catch(e){failure=e;await save('failure.private.json',{child_exit:childExit,name:e instanceof Error?e.name:'Error',message:e instanceof Error?e.message:String(e)}).catch(()=>{});}
finally{await log.close().catch(()=>{});const observer=make('postgres');try{await observer.connect();const clients=(await observer.query("SELECT datname,count(*)::int count FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND backend_type='client backend' GROUP BY datname",[[input.database,input.source_database]])).rows;await save('cleanup.private.json',{child_exit:childExit,clients,status:failure?'FAILED':'PASS'});assert.deepEqual(clients,[],'Owned test and source clients closed');}catch(e){failure??=e;}finally{await observer.end();}}
if(failure){console.log(JSON.stringify({status:'ROOT_BUYER_ADDRESS166_NATIVE_API_FAILED',child_exit:childExit,directory}));process.exitCode=1;}else{const ref=await save('result.private.json',result);console.log(JSON.stringify({status:'ROOT_BUYER_ADDRESS166_NATIVE_API_PASS',tests:10,result:ref}));}
