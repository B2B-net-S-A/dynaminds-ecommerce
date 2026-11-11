/** Root-only read-only acceptance of the 15 confirmed setup writes. Never
 * reruns setup or modifies the retained failed journal. Import-safe CLI. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { captureStocktakeAdjustmentReadback } from './stocktake-adjustments-native164-readback';
import { captureStocktakeAdjustmentPreservation } from './stocktake-adjustments-native164-preservation';
import { validateWarehouseDocumentSetupPreservation } from './warehouse-document-register-native166-setup';
const ROOT='<workspace>/app',SCHEMA='149_stocktake_adjustments';
const JOURNAL=resolve(ROOT,'data/warehouse-document-register-native166-setup.json');
const BEFORE=resolve(ROOT,'data/warehouse-document-register-native166-primary-adoption-before.json');
const FAILED=resolve(ROOT,'data/warehouse-document-register-native166-setup-failed-after.json');
const AFTER=resolve(ROOT,'data/warehouse-document-register-native166-setup-after.json');
const ACCEPTED=resolve(ROOT,'data/warehouse-document-register-native166-setup-accepted.json');
const REPORT=resolve(ROOT,'docs/warehouse-document-register-native166-setup.json');
const pins={journal:'42e57b713557cd5e1014bc3b05a741d12cfc81ce9be1606b10ccb41966c9fdef',before:'5e7828426f7c952753b6d7e693c5047774419278283c0e586d3c9b7ec65b57df',failed:'fb438197d233420cd0e66de612651038fdf2c6e2cab6b147aa6714f546daf648',config:'9a2c81811d1ffdb6c52aabdd77dddf3ac1975bd8cc2c2d2957882b338dd7b660',sql:'a4ec349804e0bddddbe595669b3a87f432a72cc9f1b19af2eb80aabf6b902264'};
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function bytes(p:string,hash:string,priv=true){const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);assert(s.size>0&&s.size<512*1024*1024);if(priv)assert.equal(s.mode&0o777,0o600);const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{const b=await f.readFile();for(const n of [await f.stat(),await lstat(p)])for(const k of ['dev','ino','mode','size','mtimeMs']as const)assert.equal(n[k],s[k]);assert.equal(sha(b),hash);return b;}finally{await f.close();}}
async function absent(p:string){try{await lstat(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Acceptance custody already exists');}
async function wx(p:string,value:unknown,mode=0o600){const d=await lstat(dirname(p));assert(d.isDirectory()&&!d.isSymbolicLink());assert.equal(await realpath(dirname(p)),dirname(p));const b=JSON.stringify(value,null,2)+'\n';const f=await open(p,'wx',mode);try{await f.writeFile(b);await f.sync();}finally{await f.close();}const parent=await open(dirname(p),'r');try{await parent.sync();}finally{await parent.close();}return sha(b);}
async function main(){
  assert.equal(process.cwd(),ROOT);assert.equal(await realpath(ROOT),ROOT);assert.equal(process.env.QA166_CONFIRM,'ACCEPT_CONFIRMED_SETUP_READ_ONLY_166');assert.equal(process.env.DYNA_WORKER_DISABLED,'true');
  for(const k of ['DATABASE_URL','DYNA_TEST','DYNA_PREVIEW_PORT'])assert.equal(process.env[k],undefined);
  const revision=process.env.QA_EXPECTED_REVISION??'';assert.match(revision,/^[a-f0-9]{40}$/);
  const attempt=process.env.QA166_ACCEPT_ATTEMPT??'1';assert(['1','2'].includes(attempt));
  const intent=ACCEPTED+(attempt==='1'?'':'.attempt2')+'.intent.json';
  if(attempt==='2'){const prior=await lstat(ACCEPTED+'.intent.json');assert(prior.isFile()&&!prior.isSymbolicLink());assert.equal(prior.mode&0o777,0o600);}
  for(const p of [AFTER,ACCEPTED,REPORT,intent])await absent(p);
  const cfg=JSON.parse((await bytes(resolve(ROOT,'.local.json'),pins.config)).toString());await bytes(resolve(ROOT,'server/149_stocktake_adjustments.sql'),pins.sql,false);
  const j=JSON.parse((await bytes(JOURNAL,pins.journal)).toString()),before=JSON.parse((await bytes(BEFORE,pins.before)).toString()),failed=JSON.parse((await bytes(FAILED,pins.failed)).toString());
  assert.equal(j.status,'FAILED_DO_NOT_RERUN');assert.equal(j.failed_step,'full-after-setup');assert.equal(j.pending,null);assert.equal(j.completed.length,15);assert.equal(j.actor.status,'OWN_FIVE_LEGACY_DOCUMENTS_READY');assert.equal(j.before_sha256,pins.before);assert.equal(j.schema_revision,SCHEMA);
  const labels=['signup','enterprise-preview','enterprise-commit','warehouse-B','product-zero','create-PZ','post-PZ','create-MM','post-MM','create-WZ','post-WZ','create-COUNT','post-COUNT','create-CANCELLED_PZ','cancel-CANCELLED_PZ'];
  assert.deepEqual(j.completed.map((x:any)=>x.label),labels);for(const x of j.completed){assert.equal(x.method,'POST');assert.equal(x.response.status,x.expected_status);assert.equal(x.response_sha256,sha(JSON.stringify(x.response.data)));}
  assert.equal(before.status,'ALL464_ADOPTION_EXACT_PASS');assert.equal(failed.status,'SETUP_AFTER_FAILURE_READ_ONLY_DIAGNOSTIC');
  async function health(){const r=await fetch('http://127.0.0.1:4100/api/health',{redirect:'error',signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);const h=await r.json();assert.equal(h.revision,revision);assert.equal(h.schema_revision,SCHEMA);assert.equal(h.mode,'local');assert.equal(h.restore_preview,false);assert.equal(h.background_workers_enabled,false);}
  await health();await wx(intent,{stage:166,attempt,action:'READ_ONLY_REVALIDATION_AFTER_15_CONFIRMED_WRITES',original_journal_sha256:pins.journal,failed_capture_sha256:pins.failed,business_mutations:0});
  const c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:'dynaminds',options:'-c default_transaction_read_only=on -c TimeZone=UTC',connectionTimeoutMillis:5000});await c.connect();
  let cap,meta;try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.deepEqual((await c.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0],{db:'dynaminds',role:'postgres',owner:'postgres',host:'127.0.0.1',port:55432,readonly:'on'});cap=await captureStocktakeAdjustmentReadback(c);meta=await captureStocktakeAdjustmentPreservation(c);assert.deepEqual(cap.rows,meta.rows);assert.deepEqual(cap.portable_metadata,meta.metadata);assert.deepEqual(cap,failed.capture);assert.deepEqual(meta.exact_metadata,before.exact_metadata);await c.query('COMMIT');}finally{await c.end();}
  const preservation=validateWarehouseDocumentSetupPreservation(before.capture,cap,j.actor);await bytes(JOURNAL,pins.journal);await bytes(BEFORE,pins.before);await bytes(FAILED,pins.failed);await bytes(resolve(ROOT,'.local.json'),pins.config);await bytes(resolve(ROOT,'server/149_stocktake_adjustments.sql'),pins.sql,false);await health();
  const afterSha=await wx(AFTER,{stage:166,phase:'after-setup',status:'OWN_LEGACY_GRAPH_AND_OLD_ROWS_VERIFIED',schema:SCHEMA,runtime_revision:revision,config_sha256:pins.config,sql_sha256:pins.sql,before_sha256:pins.before,setup_journal_sha256:pins.journal,actor:j.actor,capture:cap,exact_metadata:meta.exact_metadata,preservation,created_at:new Date().toISOString()});
  const acceptedSha=await wx(ACCEPTED,{...j,status:'OWN_LEGACY_DOCUMENTS_READY',original_journal_path:JOURNAL,original_journal_sha256:pins.journal,original_journal_status:j.status,acceptance_mode:'READ_ONLY_REVALIDATION_AFTER_15_CONFIRMED_WRITES',failed_capture_path:FAILED,failed_capture_sha256:pins.failed,after_capture:{path:AFTER,sha256:afterSha},preservation,accepted_at:new Date().toISOString()});
  const report={stage:166,status:'OWN_LEGACY_DOCUMENTS_READY',schema:SCHEMA,runtime_revision:revision,setup_runtime_revision:j.runtime_revision,private_sha256:acceptedSha,after_capture_sha256:afterSha,original_journal_sha256:pins.journal,original_journal_status:j.status,acceptance_mode:'READ_ONLY_REVALIDATION_AFTER_15_CONFIRMED_WRITES',confirmed_http_setup_writes:15,repeated_writes:0,acceptance_business_mutations:0,old_tables:464,old_rows_exact:true,old_sessions_exact:true,metadata_exact:true,graph:preservation.graph,billing_mode:'local_estimate',wms_enabled:false,provider_calls:0,worker_calls:0,register_gets:0,chrome_verified:false,backup_restore_verified:false,full_goal_complete:false};await wx(REPORT,report,0o644);console.log(JSON.stringify(report));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error(JSON.stringify({stage:166,status:'READ_ONLY_ACCEPTANCE_FAILED',writes:0,private_details_withheld:true}));process.exitCode=1;});
