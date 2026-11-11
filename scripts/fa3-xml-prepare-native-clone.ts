/** Root creates one new native test clone from the previously accepted167 restore. No reset/drop. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const bytes=await readFile(resolve(process.argv[2]));assert.equal(hash(bytes),'ba7e0852fefe56684eb6f807fe9483116d542a9dd4779beb735b0f5306f894c0');const original=JSON.parse(bytes.toString());
const cfgBytes=await readFile(original.configuration.path);assert.equal(hash(cfgBytes),original.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
const source='dynaminds_test_1791435123420',database='dynaminds_test_'+Date.now();assert.match(database,/^dynaminds_test_[0-9]{13}$/);
const directory=resolve('data/qa-fa3-xml-'+database.slice(-13));await mkdir(directory,{mode:0o700});
async function save(n:string,v:unknown){const path=resolve(directory,n),bytes=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,sha256:hash(bytes)};}
const make=(name:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:name});
async function capture(name:string){const c=make(name);try{await c.connect();const s=await captureDatabase(c,false);s.guards.competitor_observation_guards=(await c.query('SELECT competitor_observation_guards() ok')).rows[0].ok;s.guards.buyer_address_guards=(await c.query('SELECT buyer_address_guards() ok')).rows[0].ok;s.guards.operative_delivery_valid=(await c.query('SELECT operative_delivery_valid() ok')).rows[0].ok;return s;}finally{await c.end();}}
const admin=make('postgres');await admin.connect();
const names=async()=>(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
const roles=async()=>(await admin.query('SELECT to_jsonb(r) row FROM pg_roles r ORDER BY rolname')).rows;
const members=async()=>(await admin.query('SELECT to_jsonb(m) row FROM pg_auth_members m ORDER BY roleid,member,grantor')).rows;
const beforeNames=await names(),beforeRoles=await roles(),beforeMembers=await members();
assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[source])).rows[0].n,0);
const before=await capture(source);assert.equal(Object.keys(before.graph.rows).length,562);assert.equal(before.graph.rows.migrations.length,167);assert(Object.values(before.guards).every(v=>v===true));
const beforeRef=await save('source-before.private.json',before);
try{
 await admin.query('CREATE DATABASE "'+database+'" WITH TEMPLATE "'+source+'"');
 const copy=await capture(database),after=await capture(source);
 assert.equal(hash(JSON.stringify(after)),hash(JSON.stringify(before)),'Existing167 restore retained exactly');
 for(const key of ['rows','metadata'] as const)assert.deepEqual(copy.graph[key],before.graph[key],'Complete portable clone '+key);
 assert.deepEqual(copy.guards,before.guards);assert.deepEqual(copy.primary_keys,before.primary_keys);assert.deepEqual(copy.sequences,before.sequences);assert.deepEqual(copy.views,before.views);
 assert.deepEqual(await roles(),beforeRoles);assert.deepEqual(await members(),beforeMembers);assert.deepEqual(await names(),[...beforeNames,{datname:database}].sort((a,b)=>a.datname.localeCompare(b.datname)));
 const configPath=resolve(directory,'configuration.private.json');await writeFile(configPath,cfgBytes,{flag:'wx',mode:0o600});
 const u=new URL(original.environment.DATABASE_URL);u.pathname='/'+database;
 const input={...original,database,directory,environment:{...original.environment,DATABASE_URL:u.toString(),DYNA_LOCAL_CONFIG_PATH:configPath},configuration:{...original.configuration,path:configPath}};
 const inputRef=await save('input.private.json',input),copyRef=await save('copy.private.json',copy),afterRef=await save('source-after.private.json',after);
 assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND backend_type='client backend'",[[source,database]])).rows[0].n,0);
 const result=await save('preparation.private.json',{status:'ROOT_NEW_167_FA3_XML_CLONE_PASS',source,database,input:inputRef,source_before:beforeRef,source_after:afterRef,copy:copyRef,all562_portable_rows_metadata_literal:true,source_exact_literal:true,only_one_database_added:true,roles_and_memberships_literal:true,clients_closed:true});
 console.log(JSON.stringify({status:'ROOT_NEW_167_FA3_XML_CLONE_PASS',database,input:inputRef,result}));
}finally{await admin.end();}
