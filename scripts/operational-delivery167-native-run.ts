/** Root-only native167 business acceptance on the existing quiet accepted166 clone. */
import assert from 'node:assert/strict';
import {readFile,writeFile,open,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const inputBytes=await readFile(resolve(process.argv[2]));
assert.equal(hash(inputBytes),'ba7e0852fefe56684eb6f807fe9483116d542a9dd4779beb735b0f5306f894c0');
const input=JSON.parse(inputBytes.toString());assert.equal(input.database,'dynaminds_test_1791435123420');
const u=new URL(input.environment.DATABASE_URL);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55432');assert.equal(u.pathname,'/'+input.database);
assert.equal(resolve(input.environment.DYNA_LOCAL_CONFIG_PATH),resolve(input.configuration.path));
const cfgBytes=await readFile(input.configuration.path);assert.equal(hash(cfgBytes),input.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
const directory=resolve(input.directory,'consumer167-native5');await mkdir(directory,{mode:0o700});
async function save(n:string,v:unknown){const path=resolve(directory,n),bytes=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,sha256:hash(bytes)};}
const sources:Record<string,string>={};
async function tree(d:string){for(const e of await readdir(d,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const p=d+'/'+e.name;if(p==='server/fa3-xml.ts'||p==='server/fa3-xml-routes.ts')continue;if(e.isDirectory())await tree(p);else if(e.isFile()&&/\.(ts|tsx|sql|css)$/.test(e.name))sources[p]=hash(await readFile(p));}}
await tree('server');await tree('web');
for(const p of ['tests/operational-delivery-consumers.test.ts','scripts/operational-delivery167-native-run.ts','data/source-drafts/b2b-financial-return162-root-capture189.ts','scripts/stocktake-adjustments-native164-preservation.ts','scripts/return-destinations-native162-restore-readback.ts','package.json','package-lock.json'])sources[p]=hash(await readFile(p));
assert.equal(sources['server/167_operational_delivery_consumers.sql'],'256db77a1389c248b152c628d963a42496c085488b2de548ed61d04d761cf6d6');
assert.equal(sources['server/operational-delivery-consumers.ts'],'2b40782bf679b8e9ec504346c2704206e978bc1f233d1c98e582bc3f1d0c809f');
assert.equal(sources['tests/operational-delivery-consumers.test.ts'],'45a76507b31679fc4ddb73f7755b7a10e9dae80ab0d1d0426279f46025a6548c');
const sourceCut=await save('sources.private.json',sources);
const make=(database:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database});
async function exclusive(){const c=make('postgres');try{await c.connect();assert.equal((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[input.database])).rows[0].n,0);}finally{await c.end();}}
async function capture(){const c=make(input.database);try{await c.connect();const s=await captureDatabase(c,false);s.guards.competitor_observation_guards=(await c.query('SELECT competitor_observation_guards() ok')).rows[0].ok;s.guards.buyer_address_guards=(await c.query('SELECT buyer_address_guards() ok')).rows[0].ok;return s;}finally{await c.end();}}
await exclusive();const before=await capture(),beforeRef=await save('before.private.json',before);
assert.equal(Object.keys(before.graph.rows).length,560);assert.equal(before.graph.rows.migrations.length,166);assert(Object.values(before.guards).every(v=>v===true));
const logPath=resolve(directory,'test.private.log'),log=await open(logPath,'wx',0o600);let exit:number|null=null,failure:unknown,result:unknown;
try{
 exit=await new Promise<number|null>((done,reject)=>{const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1','--test-reporter=tap','tests/operational-delivery-consumers.test.ts'],{cwd:process.cwd(),env:{...process.env,...input.environment,DYNA_TEST:'true',DYNA_OPERATIONAL_DELIVERY_NATIVE:'true',DYNA_IMAGE_DIR:input.images,DYNA_PG_TOOLS:input.pg_tools},stdio:['ignore',log.fd,log.fd]});child.on('error',reject);child.on('exit',done);});
 await log.close();const after=await capture(),afterRef=await save('after.private.json',after);
 for(const [name,rows]of Object.entries(before.graph.rows)as[string,any[]][]){const current=new Set(after.graph.rows[name].map((r:any)=>hash(JSON.stringify(r))));for(const old of rows)assert(current.has(hash(JSON.stringify(old))),'Every pre-existing row retained: '+name);}
 const old=before.graph.exact_metadata,now=after.graph.exact_metadata;
 for(const section of ['relations','tables','triggers'] as const)for(const r of old[section])assert.deepEqual(now[section].find((n:any)=>n.oid===r.oid),r,'Existing metadata retained: '+section);
 const changed=new Set(['label_print_frame','order_parcel_source','packed_label_print_guards']);
 const cert=after.graph.rows.operative_delivery_certificate?.[0]?.row;
 assert(cert&&cert.profile==='156-original-to167-operational-receiver/v1');
 assert.equal(after.graph.rows.operative_delivery_certificate.length,1);
 assert.deepEqual(cert.original156_manifest,before.graph.rows.packed_label_print_manifest[0].row);
 assert.deepEqual(cert.original166_manifest,before.graph.rows.buyer_address_manifest[0].row);
 for(const f of old.functions){const n=now.functions.find((r:any)=>r.oid===f.oid);assert(n,'Existing function OID retained');if(changed.has(f.meta.proname)){
   assert.equal(cert.predecessor_functions[f.meta.proname].definition,f.definition);assert.equal(cert.predecessor_functions[f.meta.proname].body,f.meta.prosrc);
   assert.equal(cert.successor_functions[f.meta.proname].definition,n.definition);assert.equal(cert.successor_functions[f.meta.proname].body,n.meta.prosrc);
   assert.deepEqual({...n,definition:f.definition,meta:{...n.meta,prosrc:f.meta.prosrc}},f,'Only explicitly certified function body changes');
 }else assert.deepEqual(n,f,'Unchanged function retained');}
 const fresh=now.triggers.filter((r:any)=>!old.triggers.some((o:any)=>o.oid===r.oid));
 const newTables=now.tables.filter((r:any)=>!old.tables.some((o:any)=>o.oid===r.oid));
 assert.equal(newTables.length,2);assert(newTables.every((r:any)=>r.relname.startsWith('operative_delivery_')));
 const newFKs=newTables.flatMap((t:any)=>t.constraints.filter((k:any)=>k.meta.contype==='f'));
 assert.equal(newFKs.length,5);assert.equal(fresh.filter((r:any)=>r.meta.tgisinternal).length,20);
 for(const ri of fresh.filter((r:any)=>!r.relname.startsWith('operative_delivery_')))assert(ri.meta.tgisinternal&&newFKs.some((k:any)=>k.meta.oid===ri.meta.tgconstraint),'Only owned FK internal RI on old parents');
 for(const fk of newFKs){const ri=fresh.filter((r:any)=>r.meta.tgconstraint===fk.meta.oid);assert.equal(ri.length,4);assert.deepEqual(ri.map((r:any)=>r.meta.tgrelid).sort(),[fk.meta.conrelid,fk.meta.conrelid,fk.meta.confrelid,fk.meta.confrelid].sort());}
 for(const r of now.relations.filter((r:any)=>!old.relations.some((o:any)=>o.oid===r.oid)))assert(r.relname.startsWith('operative_delivery_'));
 const addedRelations=now.relations.filter((r:any)=>!old.relations.some((o:any)=>o.oid===r.oid));assert.equal(addedRelations.length,6);assert.equal(addedRelations.filter((r:any)=>r.relkind==='i').length,4);
 for(const key of before.primary_keys)assert.deepEqual(after.primary_keys.find((r:any)=>r.relname===key.relname),key);
 assert.deepEqual(after.views,before.views);assert.equal(after.sequences.length,before.sequences.length);
 for(const sequence of before.sequences)assert.deepEqual(after.sequences.find((r:any)=>r.name===sequence.name)?.options,sequence.options);
 const functions=now.functions.filter((r:any)=>!old.functions.some((o:any)=>o.oid===r.oid));assert.equal(functions.length,15);assert(functions.every((r:any)=>r.signature.startsWith('operative_delivery_')));
 const userTriggers=fresh.filter((r:any)=>!r.meta.tgisinternal);assert.equal(userTriggers.length,3);assert(userTriggers.every((r:any)=>r.relname.startsWith('operative_delivery_')&&r.meta.tgname.startsWith('operative_delivery_')));
 assert.deepEqual(after.guards,before.guards);assert(Object.values(after.guards).every(v=>v===true));
 assert.equal(Object.keys(after.graph.rows).length,562);assert.equal(after.graph.rows.migrations.length,167);
 const c=make(input.database);let ownGuard:boolean;try{await c.connect();ownGuard=(await c.query('SELECT operative_delivery_valid() ok')).rows[0].ok;assert.equal(ownGuard,true);}finally{await c.end();}
 for(const[p,d]of Object.entries(sources))assert.equal(hash(await readFile(p)),d);assert.equal(hash(await readFile(input.configuration.path)),input.configuration.sha256);
 assert.equal(exit,0);const text=await readFile(logPath,'utf8');assert.match(text,/# pass 7\b/);assert.match(text,/# fail 0\b/);
 result={status:'ROOT_OPERATIONAL_DELIVERY167_NATIVE_PASS',tests:7,child_exit:exit,database:input.database,tables:562,migrations:167,old_guards:22,own_guard:ownGuard,every_preexisting_row_retained:true,old_metadata_retained_except_three_certified_function_bodies:true,own_parent_internal_ri:fresh.filter((r:any)=>!r.relname.startsWith('operative_delivery_')).length,provider_requests:0,excluded_unregistered_source:['server/fa3-xml.ts','server/fa3-xml-routes.ts'],sources:sourceCut,before:beforeRef,after:afterRef,test_log:{path:logPath,sha256:hash(text)}};
}catch(e){failure=e;await save('failure.private.json',{child_exit:exit,name:e instanceof Error?e.name:'Error',message:e instanceof Error?e.message:String(e)});}
finally{await log.close().catch(()=>{});try{await exclusive();await save('cleanup.private.json',{owned_clients_closed:true,child_exit:exit,status:failure?'FAILED':'PASS'});}catch(e){failure??=e;}}
if(failure){console.log(JSON.stringify({status:'ROOT_OPERATIONAL_DELIVERY167_NATIVE_FAILED',directory,child_exit:exit}));process.exitCode=1;}else{const ref=await save('result.private.json',result);console.log(JSON.stringify({status:'ROOT_OPERATIONAL_DELIVERY167_NATIVE_PASS',result:ref}));}
