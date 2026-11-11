/** Independent readback after the first native gate's journal-count assertion. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const base=resolve('data/qa-physical-parcel-wz-1791439394750'),old=resolve(base,'chrome-new-operator1'),out=resolve(base,'chrome-new-operator1-custody');
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
type Ref={path:string;sha256:string};
async function read(r:Ref){const b=await readFile(r.path);assert.equal(hash(b),r.sha256);return JSON.parse(b.toString());}
async function save(name:string,v:unknown){const path=resolve(out,name),b=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,b,{flag:'wx',mode:0o600});return{path,sha256:hash(b)};}
await mkdir(out,{mode:0o700});
const prep=await read({path:resolve(base,'preparation.private.json'),sha256:'583d54a7ef0adc6a044e956923c1c5aad09ba37c2cb589fd21042bead78f6ca3'}),input=await read(prep.input),cfg=await read(input.configuration);
const db=input.database,source=prep.source;assert.equal(db,'dynaminds_test_1791439394750');
const make=(database:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database});
async function exclusive(){const c=make('postgres');try{await c.connect();assert.equal((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND backend_type='client backend'",[[db,source]])).rows[0].n,0);}finally{await c.end();}}
async function capture(database:string){const c=make(database);try{await c.connect();const s=await captureDatabase(c,false);for(const n of ['competitor_observation_guards','buyer_address_guards','operative_delivery_valid',...(database===db?['parcel_physical_wz_valid']:[])])s.guards[n]=(await c.query('SELECT public.'+n+'() ok')).rows[0].ok;assert(Object.values(s.guards).every(x=>x===true));return s;}finally{await c.end();}}
await exclusive();
const sources=JSON.parse(await readFile(resolve(old,'sources.private.json'),'utf8')) as Record<string,string>;
for(const[p,h]of Object.entries(sources))assert.equal(hash(await readFile(p)),h,'Current source equals first-run cut');
const acceptedPath=resolve(old,'gui-baseline.private.json'),acceptedBytes=await readFile(acceptedPath),accepted=JSON.parse(acceptedBytes.toString());
const current=await capture(db);assert.deepEqual(current,accepted,'Current full566 exactly equals genuine pending fixture baseline');
const sourceExpectedPath=resolve(base,'inventory-on2/source-after.private.json'),sourceExpectedBytes=await readFile(sourceExpectedPath),sourceCurrent=await capture(source);assert.deepEqual(sourceCurrent,JSON.parse(sourceExpectedBytes.toString()));
await exclusive();for(const[p,h]of Object.entries(sources))assert.equal(hash(await readFile(p)),h);assert.equal(hash(await readFile(input.configuration.path)),input.configuration.sha256);
const result={status:'ROOT_NEW_OPERATOR_FIRST_HOST_CUSTODY_PASS',database:db,expected_after:{path:acceptedPath,sha256:hash(acceptedBytes)},after:await save('after.private.json',current),source_expected:{path:sourceExpectedPath,sha256:hash(sourceExpectedBytes)},source_after:await save('source-after.private.json',sourceCurrent),current_source_cut_literal:true,all24_guards:true,tables:566,migrations:168,owned_clients_closed:true,business_rerun:false,full_gui_acceptance:false,original_host_session:72255,original_host_pid:86930,original_host_terminal_exit:0,original_receipt_missing:true};
console.log(JSON.stringify({status:result.status,result:await save('result.private.json',result)}));
