/** Real owner PostgreSQL167 installation in a rollback-only TX. No app or registry edits. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const bytes=await readFile(resolve(process.argv[2]));assert.equal(hash(bytes),'39d74121db59e3427e42a020cf2c82e740c4e75076b9733c05a1627bae71bc2d');const input=JSON.parse(bytes.toString());assert.equal(input.database,'dynaminds_test_1791431348741');
const cfgBytes=await readFile(input.configuration.path);assert.equal(hash(cfgBytes),input.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
const sql=await readFile('server/167_operational_delivery_consumers.sql'),adapter=await readFile('server/operational-delivery-consumers.ts');assert.equal(hash(sql),'256db77a1389c248b152c628d963a42496c085488b2de548ed61d04d761cf6d6');assert.equal(hash(adapter),'2b40782bf679b8e9ec504346c2704206e978bc1f233d1c98e582bc3f1d0c809f');
const directory=resolve(input.directory,'consumer167-preflight2');await mkdir(directory,{mode:0o700});
async function save(n:string,v:unknown){const path=resolve(directory,n),bytes=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,sha256:hash(bytes)};}
const make=(database:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database});
async function exclusive(){const c=make('postgres');try{await c.connect();assert.equal((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[input.database])).rows[0].n,0);}finally{await c.end();}}
async function capture(){const c=make(input.database);try{await c.connect();const s=await captureDatabase(c,false);s.guards.competitor_observation_guards=(await c.query('SELECT competitor_observation_guards() ok')).rows[0].ok;s.guards.buyer_address_guards=(await c.query('SELECT buyer_address_guards() ok')).rows[0].ok;return s;}finally{await c.end();}}
await exclusive();const before=await capture(),beforeRef=await save('before.private.json',before);assert.equal(before.graph.rows.migrations.length,166);assert.equal(Object.keys(before.graph.rows).length,560);assert(Object.values(before.guards).every(v=>v===true));
const c=make(input.database);let failure:unknown,tentative:unknown;
try{
 await c.connect();await c.query('BEGIN');await c.query("SET LOCAL TimeZone='UTC'");await c.query(sql.toString());
 await c.query("INSERT INTO migrations(name) VALUES('167_operational_delivery_consumers')");
 const checks=(await c.query('SELECT operative_delivery_valid() consumer,packed_label_print_guards() packed156,buyer_address_guards() buyer166,order_parcel_guards() parcels')).rows[0];assert(Object.values(checks).every(v=>v===true));
 const tables=(await c.query("SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'")).rows[0].n;assert.equal(tables,562);
 const ownFunctions=(await c.query("SELECT count(*)::int n FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'operative_delivery_')")).rows[0].n;assert.equal(ownFunctions,15);
 const ownTriggers=(await c.query("SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal AND starts_with(tgname,'operative_delivery_')")).rows[0].n;assert.equal(ownTriggers,3);
 const cert=(await c.query('SELECT profile,original156_manifest,original166_manifest,predecessor_functions,successor_functions FROM operative_delivery_certificate')).rows;assert.equal(cert.length,1);const certificateRef=await save('tentative-certificate.private.json',cert);
 tentative={checks,tables,own_functions:ownFunctions,own_user_triggers:ownTriggers,tentative_ledger:167,certificate:certificateRef};
}catch(e){failure=e;await save('failure.private.json',{name:e instanceof Error?e.name:'Error',message:e instanceof Error?e.message:String(e),code:(e as any)?.code,position:(e as any)?.position,where:(e as any)?.where});}
finally{try{await c.query('ROLLBACK');}finally{await c.end();}}
const after=await capture(),afterRef=await save('after.private.json',after);assert.equal(hash(JSON.stringify(after)),hash(JSON.stringify(before)),'Rollback preserves all560 rows/exact object graph/22guards');assert.equal(hash(await readFile('server/167_operational_delivery_consumers.sql')),hash(sql));assert.equal(hash(await readFile('server/operational-delivery-consumers.ts')),hash(adapter));await exclusive();await save('cleanup.private.json',{status:failure?'FAILED':'PASS',owned_clients_closed:true,whole560_literal_after_rollback:true});
if(failure){console.log(JSON.stringify({status:'ROOT_CONSUMER167_NATIVE_PREFLIGHT_FAILED',directory}));process.exitCode=1;}else{const result=await save('result.private.json',{status:'ROOT_CONSUMER167_NATIVE_ROLLBACK_PREFLIGHT_PASS',database:input.database,sql_sha256:hash(sql),adapter_sha256:hash(adapter),before:beforeRef,after:afterRef,tentative,whole560_literal_after_rollback:true,registered_in_application:false,committed_167:false,adapter_business_flow:'NOT_RUN',owned_clients_closed:true});console.log(JSON.stringify({status:'ROOT_CONSUMER167_NATIVE_ROLLBACK_PREFLIGHT_PASS',result}));}
