/** Read-only current retention proof of the original failed168 clone. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const h=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
async function ref(r:{path:string;sha256:string}){const b=await readFile(r.path);assert.equal(h(b),r.sha256);return JSON.parse(b.toString());}
const base=resolve('data/qa-physical-parcel-wz-1791438089610');
const priorRef={path:resolve(base,'source-diagnostic1/result.private.json'),sha256:'7276997cc60666086201c0c4fd2991b5e6bf7aa70a2140a26c8c39b4333140ed'};
const prior=await ref(priorRef),install=await ref(prior.install),baseline=await ref(install.baseline),prep=await ref(baseline.preparation),input=await ref(prep.input);
assert.equal(input.database,'dynaminds_test_1791438089610');const cfgBytes=await readFile(input.configuration.path);assert.equal(h(cfgBytes),input.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
const d=resolve(base,'retention-after-successor1');await mkdir(d,{mode:0o700});
async function save(n:string,v:unknown){const p=resolve(d,n),b=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(p,b,{flag:'wx',mode:0o600});return{path:p,sha256:h(b)};}
const c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:input.database});let after:any;
try{await c.connect();after=await captureDatabase(c,false);for(const guard of ['competitor_observation_guards','buyer_address_guards','operative_delivery_valid','parcel_physical_wz_valid'])after.guards[guard]=(await c.query('SELECT '+guard+'() ok')).rows[0].ok;assert(Object.values(after.guards).every(v=>v===true));assert.deepEqual(after,await ref(prior.after),'Whole original failed168 copy retained after fresh successor gates');}finally{await c.end();}
const admin=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:'postgres'});
try{await admin.connect();assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[input.database])).rows[0].n,0);}finally{await admin.end();}
assert.equal(h(await readFile(input.configuration.path)),input.configuration.sha256);
const afterRef=await save('after.private.json',after);console.log(JSON.stringify({status:'ROOT_ORIGINAL_FAILED_168_CLONE_WHOLE_RETAINED_PASS',result:await save('result.private.json',{status:'ROOT_ORIGINAL_FAILED_168_CLONE_WHOLE_RETAINED_PASS',database:input.database,prior:priorRef,after:afterRef,tables:566,migrations:168,guards:24,whole_rows_exact_schema_sequences_views_literal:true,owned_clients_closed:true,app_seed_migration_listener_provider:false})}));
