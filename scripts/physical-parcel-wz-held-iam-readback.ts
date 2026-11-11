/** Read-only custody revalidation of the actual held-IAM outcomes and current source. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const h=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
async function ref(r:{path:string;sha256:string}){const b=await readFile(r.path);assert.equal(h(b),r.sha256);return JSON.parse(b.toString());}
const self='scripts/physical-parcel-wz-held-iam-readback.ts',selfBefore=h(await readFile(self));
const base=resolve('data/qa-physical-parcel-wz-1791439394750'),priorDir=resolve(base,'held-iam1');
const prep=await ref({path:resolve(base,'preparation.private.json'),sha256:'583d54a7ef0adc6a044e956923c1c5aad09ba37c2cb589fd21042bead78f6ca3'}),input=await ref(prep.input);
assert.equal(input.database,'dynaminds_test_1791439394750');
const helperRef={path:resolve(priorDir,'result.private.json'),sha256:'50bb453f087cf7b0a6250e552a494dfbccc59a3919fc31215bb46008098b8c1e'};
const helper=await ref(helperRef);assert.equal(helper.status,'ROOT_NATIVE_PHYSICAL_WZ_HELD_IAM_RACE_A_PASS');assert.equal(helper.database,input.database);assert.equal(helper.tables,566);assert.equal(helper.migrations,168);assert.equal(helper.guards,24);
const cleanupRef={path:resolve(priorDir,'cleanup.private.json'),sha256:'f4eb2080e0724ee4579b9772bf1b439a141d72f05d4d611ec77924c3a9dd2d11'};assert.deepEqual(await ref(cleanupRef),{status:'PASS',app_closed:true,pool_and_observers_closed:true,provider_calls:0});
const sourcesRef={path:resolve(priorDir,'sources.private.json'),sha256:'6ee60f3b7f3d78ffbf10f105973bae863170e9dba30cb7feadc25239e2a20d53'};
const sources=await ref(sourcesRef);for(const[p,want]of Object.entries(sources)as[string,string][])assert.equal(h(await readFile(p)),want);
const cfgBytes=await readFile(input.configuration.path);assert.equal(h(cfgBytes),input.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
const d=resolve(base,'held-iam-custody1');await mkdir(d,{mode:0o700});
async function save(n:string,v:unknown){const p=resolve(d,n),b=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(p,b,{flag:'wx',mode:0o600});return{path:p,sha256:h(b)};}
const witnessRefs:Array<{path:string;sha256:string}>=[];
async function witness(name:string){const path=resolve(priorDir,name),b=await readFile(path);witnessRefs.push({path,sha256:h(b)});return JSON.parse(b.toString());}
assert.equal(helper.outcomes.length,2);
for(const[index,o]of helper.outcomes.entries()){
 const before=await ref(o.before),after=await ref(o.after),intent=await ref(o.apply_intent);
 const wait=await witness('actual-wait-'+index+'.private.json');
 const held=await witness('held-cleanup-'+index+'.private.json');
 const response=await witness('apply-response-'+index+'.private.json');
 assert.deepEqual(wait.apply_intent,o.apply_intent);assert.deepEqual(response.intent,o.apply_intent);assert.deepEqual(response.native_errors,held.native_errors);
 assert.equal(o.control,index===0);assert.equal(o.status,index===0?201:401);assert.equal(response.status,o.status);
 assert.equal(wait.writer_pid,o.writer_pid);assert.equal(wait.holder_pid,o.holder_pid);assert.equal(wait.barrier.datname,input.database);assert.equal(wait.barrier.query,'SELECT parcel_physical_wz_terminal_prepare()');assert(wait.barrier.blockers.includes(o.holder_pid));
 assert.equal(held.pending_settled,true);assert.equal(held.owned_clients_closed,true);assert.equal(held.query_observer_restored,true);assert.equal(held.failure,null);
 assert.equal(Object.keys(before.graph.rows).length,566);assert.equal(Object.keys(after.graph.rows).length,566);assert.equal(Object.keys(after.guards).length,24);assert(Object.values(after.guards).every(v=>v===true));
 const expected=structuredClone(before);
 if(index===0){
  const oldIds=new Set(before.graph.rows.parcel_physical_wz_mappings.map((r:any)=>r.row.id));const added=after.graph.rows.parcel_physical_wz_mappings.filter((r:any)=>!oldIds.has(r.row.id));assert.equal(added.length,1);const m=added[0].row;
  const preview=before.graph.rows.parcel_physical_wz_previews.find((r:any)=>r.row.id===o.preview_id)?.row;assert(preview);
  assert.equal(m.actor_id,o.owner_id);assert.equal(m.tenant_id,o.tenant_id);assert.equal(m.api_key_id,o.key_id);assert.equal(m.preview_id,o.preview_id);assert.deepEqual(m.frame,preview.frame);assert.deepEqual(m.request,intent.payload);assert.equal(m.client_key,intent.payload.client_key);assert.equal(m.scope_hash,intent.payload.scope_hash);
  for(const r of before.graph.rows.parcel_physical_wz_mappings)assert(after.graph.rows.parcel_physical_wz_mappings.some((a:any)=>JSON.stringify(a)===JSON.stringify(r)));
  assert.equal(after.graph.rows.parcel_physical_wz_mappings.length,before.graph.rows.parcel_physical_wz_mappings.length+1);expected.graph.rows.parcel_physical_wz_mappings=after.graph.rows.parcel_physical_wz_mappings;
 }else{
  const errors=held.native_errors.filter((e:any)=>e.pid===o.writer_pid);assert.equal(errors.length,1);assert.equal(errors[0].code,'28000');assert(String(errors[0].where).includes('parcel_physical_wz_terminal_prepare'));
  const old=before.graph.rows.api_keys.find((r:any)=>r.row.id===o.key_id),fresh=after.graph.rows.api_keys.find((r:any)=>r.row.id===o.key_id);assert(old&&fresh);assert.equal(old.row.revoked_at,null);assert.equal(typeof fresh.row.revoked_at,'string');assert(Number.isFinite(Date.parse(fresh.row.revoked_at)));assert.deepEqual({...fresh,row:{...fresh.row,revoked_at:null}},old);
  const auditOld=new Set(before.graph.rows.audit_events.map((r:any)=>r.row.id));const added=after.graph.rows.audit_events.filter((r:any)=>!auditOld.has(r.row.id));assert.equal(added.length,1);const audit=added[0].row;assert.equal(audit.action,'api_key.revoked');assert.equal(audit.entity_id,o.key_id);assert.equal(audit.tenant_id,o.tenant_id);assert.equal(audit.user_id,o.owner_id);assert.deepEqual(audit.detail,{});
  assert.equal(after.graph.rows.audit_events.length,before.graph.rows.audit_events.length+1);for(const r of before.graph.rows.audit_events)assert(after.graph.rows.audit_events.some((a:any)=>JSON.stringify(a)===JSON.stringify(r)));
  expected.graph.rows.api_keys=expected.graph.rows.api_keys.map((r:any)=>r.row.id===o.key_id?fresh:r);expected.graph.rows.audit_events=after.graph.rows.audit_events;
 }
 assert.deepEqual(after,expected,'Independent full566 held IAM oracle '+index);
}
const expectedAfterRef={path:resolve(priorDir,'after.private.json'),sha256:'1698d90266d83e56af8421c6e0227dfc75e9a75347c0ff0b75d6f902c0dc6a24'};
const c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:input.database});let after:any;
try{await c.connect();after=await captureDatabase(c,false);for(const guard of ['competitor_observation_guards','buyer_address_guards','operative_delivery_valid','parcel_physical_wz_valid'])after.guards[guard]=(await c.query('SELECT '+guard+'() ok')).rows[0].ok;assert(Object.values(after.guards).every(v=>v===true));assert.deepEqual(after,await ref(expectedAfterRef),'Current whole566 held IAM state equals preserved actual after');}finally{await c.end();}
const admin=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:'postgres'});
try{await admin.connect();assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[input.database])).rows[0].n,0);}finally{await admin.end();}
assert.equal(h(await readFile(input.configuration.path)),input.configuration.sha256);
for(const[p,want]of Object.entries(sources)as[string,string][])assert.equal(h(await readFile(p)),want);
const afterRef=await save('after.private.json',after);
const sourceClient=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:prep.source});let sourceAfter:any;
try{await sourceClient.connect();sourceAfter=await captureDatabase(sourceClient,false);for(const guard of ['competitor_observation_guards','buyer_address_guards','operative_delivery_valid'])sourceAfter.guards[guard]=(await sourceClient.query('SELECT '+guard+'() ok')).rows[0].ok;assert.deepEqual(sourceAfter,await ref({path:resolve(priorDir,'source-after.private.json'),sha256:'6c686e74460c9f2fbc97c44348adb2a19ddb28f20e3627a875d925fc48d9ffc4'}));}finally{await sourceClient.end();}
const finalAdmin=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:'postgres'});try{await finalAdmin.connect();assert.equal((await finalAdmin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND backend_type='client backend'",[[input.database,prep.source]])).rows[0].n,0);}finally{await finalAdmin.end();}
assert.equal(h(await readFile(self)),selfBefore);assert.equal(h(await readFile(input.configuration.path)),input.configuration.sha256);for(const[p,want]of Object.entries(sources)as[string,string][])assert.equal(h(await readFile(p)),want);
for(const r of witnessRefs)assert.equal(h(await readFile(r.path)),r.sha256);assert.equal(witnessRefs.length,6);
const result=await save('result.private.json',{status:'ROOT_PHYSICAL_WZ_168_HELD_IAM_ACTUAL_READBACK_CUSTODY_PASS',database:input.database,witnesses:witnessRefs,self_source:{path:self,sha256:selfBefore},helper:helperRef,cleanup:cleanupRef,sources:sourcesRef,expected_after:expectedAfterRef,after:afterRef,source_after:await save('source-after.private.json',sourceAfter),tables:566,migrations:168,guards:24,independent_positive_mapping_only_oracle:true,independent_negative_native_key_audit_only_oracle:true,actual_blocked_terminal_pid_and_original_native28000:true,owned_readers_closed:true,business_rerun:false,original_root_launcher_exit:1,original_failure:'Final report WX filename collision after all business checks and resource closure',browser:'NOT_RUN',held_dispatch_race_b:'NOT_RUN'});console.log(JSON.stringify({status:'ROOT_PHYSICAL_WZ_168_HELD_IAM_ACTUAL_READBACK_CUSTODY_PASS',result}));
