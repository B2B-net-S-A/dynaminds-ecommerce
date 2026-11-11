/** ROOT ONLY. Read-only adoption checkpoints; no migrate/login/business writers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { captureStocktakeAdjustmentReadback } from './stocktake-adjustments-native164-readback';
import { captureStocktakeAdjustmentPreservation } from './stocktake-adjustments-native164-preservation';
const ROOT='<workspace>/app',SCHEMA='149_stocktake_adjustments';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const pins={config:'9a2c81811d1ffdb6c52aabdd77dddf3ac1975bd8cc2c2d2957882b338dd7b660',sql:'a4ec349804e0bddddbe595669b3a87f432a72cc9f1b19af2eb80aabf6b902264',primary:'d1f140649851575bf5a08eb8836dea2b91482ce562004688638e8f7b48314f7a',copy:'a9af0917808b9f6dd97818ca478793960476b9aa6d5111438219ba8f6594db18'};
async function bytes(p:string,priv=true){assert.equal(await realpath(p),p);const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());if(priv)assert.equal(s.mode&0o777,0o600);const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{return await f.readFile();}finally{await f.close();}}
async function wx(p:string,value:unknown,mode=0o600){const f=await open(p,'wx',mode);try{const b=Buffer.from(JSON.stringify(value,null,2)+'\n');await f.writeFile(b);await f.sync();return sha(b);}finally{await f.close();}}
async function absent(p:string){try{await lstat(p);assert.fail('Output already exists');}catch(e:any){if(e.code!=='ENOENT')throw e;}}
async function main(){
  let c:pg.Client|undefined;let step='preflight';
  try{
    assert.equal(process.cwd(),ROOT);assert.equal(await realpath(ROOT),ROOT);assert.equal(process.env.QA166_CONFIRM,'READ_ONLY_ADOPTION_166');assert.equal(process.env.DYNA_WORKER_DISABLED,'true');
    for(const name of ['DATABASE_URL','DYNA_TEST'])assert.equal(process.env[name],undefined);
    const scope=process.env.QA166_SCOPE,phase=process.env.QA166_PHASE;assert(scope==='primary'||scope==='copy');assert(phase==='before'||phase==='after');
    const revision=process.env.QA_EXPECTED_REVISION??'';assert.match(revision,/^[a-f0-9]{40}$/);if(phase==='before')assert.equal(revision,'2f7d5eb9fa9c0730724f0ba613a295d409097963');
    const configBytes=await bytes(resolve(ROOT,'.local.json'));assert.equal(sha(configBytes),pins.config);const config=JSON.parse(configBytes.toString());
    const sqlBytes=await bytes(resolve(ROOT,'server/149_stocktake_adjustments.sql'),false);assert.equal(sha(sqlBytes),pins.sql);
    const originalPath=resolve(ROOT,`data/stocktake-adjustment-register-native165-${scope}-after-attempt2.json`),originalBytes=await bytes(originalPath);assert.equal(sha(originalBytes),pins[scope]);const original=JSON.parse(originalBytes.toString());
    assert.equal(original.status,'REGISTER165_AFTER_READ_ONLY_PASS');assert.equal(original.runtime_revision,'2f7d5eb9fa9c0730724f0ba613a295d409097963');
    const beforePath=resolve(ROOT,`data/warehouse-document-register-native166-${scope}-adoption-before.json`);
    let before:any=null;
    if(phase==='after'){const expected=process.env.QA166_BEFORE_SHA256??'';assert.match(expected,/^[a-f0-9]{64}$/);const b=await bytes(beforePath);assert.equal(sha(b),expected);before=JSON.parse(b.toString());assert.equal(before.scope,scope);assert.equal(before.phase,'before');assert.deepEqual(before.capture,original.capture);}
    const out=resolve(ROOT,`data/warehouse-document-register-native166-${scope}-adoption-${phase}.json`),pub=resolve(ROOT,`docs/warehouse-document-register-native166-${scope}-adoption-${phase}.json`);await absent(out);await absent(pub);await absent(out+'.intent.json');
    const port=scope==='primary'?4100:4198;let database='dynaminds',password=config.dbPassword,resultBytes:Buffer|undefined,resultPath:string|undefined;
    if(scope==='copy'){
      resultPath=resolve(ROOT,'data/stocktake-adjustments-backup164-1a8a5ffe-dd27-4a8e-8d7b-239a93684af0/restore/7add0957b206bbc5/result.json');resultBytes=await bytes(resultPath);assert.equal(sha(resultBytes),'c03e271483a77dad4448b7325b2f6b7cb13e14e80ca6fa87fce423d1e10aeb5c');const result=JSON.parse(resultBytes.toString());assert.equal(result.status,'verified');assert.equal(result.preview_only,true);assert.equal(result.worker_enabled,false);assert.equal(result.database,'dynaminds_restore_7add0957b206bbc5');database=result.database;password=JSON.parse((await bytes(result.config)).toString()).dbPassword;
    }
    async function health(){const r=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(10000),redirect:'error',cache:'no-store'});assert.equal(r.status,200);const h=await r.json() as any;assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.revision,revision);assert.equal(h.schema_revision,SCHEMA);assert.equal(h.restore_preview,scope==='copy');assert.equal(h.background_workers_enabled,false);assert.equal(h.stocktake_adjustments_available,true);return h;}
    await health();await wx(out+'.intent.json',{stage:166,scope,phase,runtime_revision:revision,action:'READ_ONLY_ALL464_NO_REPAIR',old165_sha256:pins[scope]});
    c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password,database,options:'-c default_transaction_read_only=on -c TimeZone=UTC',connectionTimeoutMillis:5000});c.on('error',()=>{});await c.connect();step='capture';await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");
    assert.deepEqual((await c.query('SELECT current_database() db,current_user role,host(inet_server_addr()) host,inet_server_port() port')).rows[0],{db:database,role:'postgres',host:'127.0.0.1',port:55432});
    const capture=await captureStocktakeAdjustmentReadback(c),preservation=await captureStocktakeAdjustmentPreservation(c);assert.deepEqual(preservation.rows,capture.rows);await c.query('COMMIT');
    assert.deepEqual(capture,original.capture,'Every original row/session/metadata/hash remains exact');if(before)assert.deepEqual(preservation.exact_metadata,before.exact_metadata,'Same database OID/function/trigger/ACL identities');
    await health();assert.equal(sha(await bytes(resolve(ROOT,'.local.json'))),pins.config);assert.equal(sha(await bytes(resolve(ROOT,'server/149_stocktake_adjustments.sql'),false)),pins.sql);assert.equal(sha(await bytes(originalPath)),pins[scope]);if(resultPath)assert.equal(sha(await bytes(resultPath)),sha(resultBytes!));
    const status='ALL464_ADOPTION_EXACT_PASS',privateSha=await wx(out,{stage:166,scope,phase,status,runtime_revision:revision,schema:SCHEMA,old165_sha256:pins[scope],capture,exact_metadata:preservation.exact_metadata,created_at:new Date().toISOString(),login_calls:0,mutations:0});
    await wx(pub,{stage:166,scope,phase,status,runtime_revision:revision,schema:SCHEMA,private_sha256:privateSha,tables:464,all_previous_rows_and_sessions_exact:true,portable_metadata_exact:true,oid_metadata_exact:phase==='after',gets:2,mutations:0,login_calls:0,new_pg_restore:false,providers_verified:false,chrome_verified:false,full_goal_complete:false},0o644);
    console.log(JSON.stringify({stage:166,scope,phase,status,private_sha256:privateSha}));
  }catch(e:any){console.error(JSON.stringify({stage:166,status:'ADOPTION_FAILED_NO_REPAIR',step,error_type:e?.name??'Error',private_details_withheld:true}));process.exitCode=1;}finally{await c?.query('ROLLBACK').catch(()=>{});await c?.end().catch(()=>{});}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main();
