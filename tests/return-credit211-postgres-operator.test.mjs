/** Synthetic transport tests of the REAL exported QA operator; no PostgreSQL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
import {captureReturnCredit211BeforeInstall,runReturnCredit211Postgres} from './return-credit211-postgres.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const A=id(1),B=id(2),db='dynaminds_test_1792350000000',marker='DYNA_OWNED_RETURN_CREDIT211_'+'a'.repeat(32);
const transport=Symbol.for('dynaminds.qa211.synthetic.transport');
const stub='data:text/javascript,'+encodeURIComponent("export default {Client:class {constructor(options){return globalThis[Symbol.for('dynaminds.qa211.synthetic.transport')](options)}}};");
const hooks=registerHooks({resolve(specifier,context,next){return specifier==='pg'?{url:stub,shortCircuit:true}:next(specifier,context);}});
const cases={schema:'dynaminds-return-credit211-genuine-cases/v1',evidence:'genuine_api_fv157_before_rma_and_credit206_before211',native148:{tenant_id:A,order_id:id(11),return_id:id(12),physical_receipt_id:id(13),original_document_id:id(14),original_receipt_id:id(15)},historical169:{tenant_id:B,order_id:id(21),return_id:id(22),physical_receipt_id:id(23),original_document_id:id(24),original_receipt_id:id(25),credit_receipt_id:id(26)}};
const metadata={id:true,profile:'209-to211-destinations148-credit/v1',own_records:[{synthetic:true}],changes:Array.from({length:6},()=>({synthetic:true})),removed:[{},{}],original206:{},original208:{},original209:{},source_compiler_sha256:'b'.repeat(64)};
const oldReceipt={tenant_id:B,id:id(26),return_receipt_id:id(23),order_id:id(21),return_id:id(22),receipt_sequence:1,snapshot:{calculation:{financial_hash:'c'.repeat(64)}}};
const oldParent={tenant_id:B,id:id(23),family:'catalog169',catalog_receipt_id:id(23),destination_receipt_id:null,order_id:id(21),return_id:id(22),receipt_sequence:1,financial:{financial_hash:'c'.repeat(64)}};
const failure=code=>Object.assign(new Error('Synthetic transport fault'),{code});

/** A strict SQL transport model, not a second implementation of transaction QA. */
function driver(mode){
 const log=[],state={series:0,preview:0,issued:false,prefix:''};let pending=null,tenant=null,role='postgres',deleted=null,savepoint=null,lost=false,cleanupFailed=false;
 const snapshot=()=>structuredClone({state:pending,tenant,role,deleted});
 const live=()=>pending??state;
 const rows=value=>({rows:[value]});
 const receipts=()=>live().issued?[oldReceipt,{tenant_id:A,id:id(38)}]:[oldReceipt];
 const tableCount=(table,t)=>{
  if(t===B)return table==='return_credit206_receipts'?1:0;
  if(table==='return_credit206_series')return live().series;
  if(table==='return_credit206_previews')return live().preview;
  if(['return_credit206_receipts','return_credit206_documents','return_credit206_admissions','return_credit206_counters'].includes(table))return live().issued?1:0;
  return 0;
 };
 const client={
  log,state,deferredValidations:0,connects:0,ended:false,
  async connect(){this.connects++;log.push({sql:'CONNECT'});},
  async end(){this.ended=true;log.push({sql:'END'});},
  async query(sql,args=[]){
   assert.equal(typeof sql,'string');log.push({sql,args:structuredClone(args)});
   if(sql==='BEGIN'||sql==='BEGIN READ ONLY'){pending=structuredClone(state);tenant=null;role='postgres';deleted=null;return{command:'BEGIN',rows:[]};}
   if(sql==='COMMIT'){
    const newIssue=pending?.issued&&!state.issued;Object.assign(state,pending);pending=null;
    if(newIssue){this.deferredValidations++;log.push({sql:'SYNTHETIC_DEFERRED_PARENT_COMPLETE_AT_COMMIT'});}
    if(mode==='lost-issue-commit-ack'&&newIssue){lost=true;throw failure('ECONNRESET');}
    return{command:'COMMIT',rows:[]};
   }
   if(sql==='ROLLBACK'){
    if(lost&&!cleanupFailed){cleanupFailed=true;throw failure('CLEANUP_FAILURE');}
    pending=null;tenant=null;role='postgres';deleted=null;return{command:'ROLLBACK',rows:[]};
   }
   if(sql==='SAVEPOINT qa211_negative'){savepoint=snapshot();return{rows:[]};}
   if(sql==='ROLLBACK TO SAVEPOINT qa211_negative'){({state:pending,tenant,role,deleted}=structuredClone(savepoint));return{rows:[]};}
   if(sql==='RELEASE SAVEPOINT qa211_negative'){savepoint=null;return{rows:[]};}
   if(sql==='SET LOCAL ROLE dyna_app'){role='dyna_app';return{rows:[]};}
   if(sql==='RESET ROLE'){role='postgres';return{rows:[]};}
   if(sql.startsWith('SET LOCAL session_replication_role='))return{rows:[]};
   if(sql.includes("set_config('app.tenant_id'")){tenant=args[0];return{rows:[]};}
   if(sql.includes("to_regclass('public.return_credit211_acceptances')"))return rows({absent:true});
   if(sql.startsWith('SELECT current_user,session_user,'))return rows({current_user:'postgres',session_user:'postgres',ro:'on',isolation:'repeatable read',replication:'origin',name:db,port:57083,address:'127.0.0.1',owner:'postgres',marker});
   if(sql.startsWith('SELECT current_database() db,'))return rows({db,current_user:'postgres',session_user:'postgres',address:'127.0.0.1',port:57083,version:180004,timezone:'UTC',jit:'off',timeout:'8s',lock_timeout:'8s',replication:'origin',owner:'postgres',marker});
   if(sql==='SELECT current_database() name')return rows({name:db});
   if(sql.startsWith('SELECT to_jsonb(m) value FROM public.return_credit211_metadata'))return rows({value:metadata});
   if(/^SELECT public.(ordinary187_valid|buyer_address_guards|order_merge_delivery209_valid|return_credit206_guards|ordinary188_structure_valid|return_credit211_metadata_valid)\(\) value$/.test(sql))return rows({value:true});
   if(sql.startsWith('SELECT count(*)::int n,coalesce(sum(pg_column_size(r))'))return rows({n:receipts().length,bytes:'512'});
   if(sql.includes('jsonb_agg(to_jsonb(r) ORDER BY tenant_id,id)'))return rows({value:structuredClone(receipts())});
   const table=sql.match(/FROM public\.([a-z0-9_]+) x WHERE tenant_id=\$1$/)?.[1];
   if(table){const n=tableCount(table,args[0]);return sql.includes('sum(pg_column_size(x))')?rows({n,bytes:'256'}):rows({n,sha:sha(JSON.stringify([args[0],table,n]))});}
   if(sql.startsWith('SELECT to_jsonb(p) value FROM public.return_credit211_acceptances'))return rows({value:oldParent});
   if(sql==='SELECT count(*)::int n FROM public.return_credit211_acceptances')return rows({n:receipts().length});
   if(sql.startsWith('SELECT r.actor_id,s.token_hash'))return rows({actor_id:args[0]===A?id(16):id(27),token_hash:'synthetic-no-live-session-token'});
   if(sql.startsWith('SELECT count(*)::int n FROM public.catalog_stock_return_'))return rows({n:0});
   if(sql.startsWith('SELECT count(*)::int n FROM public.return_destination_admissions'))return rows({n:1});
   if(sql.startsWith('SELECT public.return_credit211_history148')){
    if(role==='dyna_app')throw failure('42501');if(tenant!==A)throw failure('23514');return rows({value:{family:'destinations148',id:id(13)}});
   }
   if(sql.startsWith('SELECT public.return_credit211_acceptance')){
    if(deleted){const e=failure('23514');e.message='211 partial or foreign169 cannot fall back to148';throw e;}
    return rows({value:tenant===A?{family:'destinations148',id:id(13)}:{family:'catalog169',id:id(23)}});
   }
   if(sql.startsWith('DELETE FROM public.catalog_stock_return_')){deleted=true;return{rows:[],rowCount:1};}
   if(sql.startsWith('SELECT public.return_credit211_source')||sql.startsWith('SELECT public.return_credit206_source'))return rows({value:{issued:live().issued}});
   if(sql.startsWith('SELECT public.return_credit206_calculate'))return rows({value:{status:JSON.parse(args[0]).issued?'already_credited':'credit_required',calculation:{totals:{delta:{gross_minor:'-2700'}}}}});
   if(sql.startsWith('SELECT public.return_credit206_series_create')){const b=JSON.parse(args[0]);live().series++;live().prefix=b.prefix;return rows({value:{id:id(31),version:1,reused:false}});}
   if(sql.startsWith('SELECT version FROM public.return_cases'))return rows({version:1});
   if(sql.startsWith('SELECT public.return_credit206_preview')){live().preview++;return rows({value:{id:id(32),scope_hash:'d'.repeat(64),reused:false,snapshot:{calculation:{totals:{delta:{gross_minor:'-2700'}}}}}});}
   if(sql.startsWith('SELECT public.return_credit206_issue')){
    if(tenant!==A)throw failure('P0002');const body=JSON.parse(args[1]);if(body.scope_hash==='f'.repeat(64))throw failure('23514');
    const reused=live().issued;live().issued=true;return rows({value:{reused,document_id:id(33),year:2026,number:live().prefix+'/2026/000001'}});
   }
   if(sql.startsWith('SELECT to_jsonb(x) value FROM public.return_credit211_acceptances'))return rows({value:{family:'destinations148',destination_receipt_id:id(13),catalog_receipt_id:null,id:id(13),credit_admission_id:id(38)}});
   if(sql.startsWith('SELECT count(*)::int n FROM public.return_credit206_receipts WHERE'))return rows({n:live().issued?1:0});
   throw new Error('Unexpected SQL port in synthetic transport: '+sql.slice(0,100));
  },
 };
 return client;
}

async function fixture(mode){
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'qa211-operator-')));await fs.chmod(dir,0o700);
 const c=driver(mode),before=await captureReturnCredit211BeforeInstall(c,cases);c.log.length=0;
 async function file(name,value){const b=Buffer.from(JSON.stringify(value));const file=path.join(dir,name);await fs.writeFile(file,b,{flag:'wx',mode:0o600});return{path:file,bytes:b.length,sha256:sha(b)};}
 const runner=fileURLToPath(new URL('./return-credit211-postgres.mjs',import.meta.url)),sql=fileURLToPath(new URL('../server/211_return_credit148_acceptance.sql',import.meta.url));
 const sourceSqlSha=sha(await fs.readFile(sql)),runnerSha=sha(await fs.readFile(runner));
 const locator={schema:'dynaminds-return-credit211-qa/v1',databaseUrl:'postgres://postgres:synthetic-only@127.0.0.1:57083/'+db,ownershipMarker:marker,cases:await file('cases.json',cases),before211:await file('before.json',before),sourceExpectation:await file('expected.json',{schema:'dynaminds-return-credit211-qa-source-expectation/v1',authority:'SOURCE_COMPILED_COMPLETE_209_TO_211_NOT_OBSERVED',source_sql_sha256:sourceSqlSha,metadata}),restoreProof:null,outputDirectory:path.join(dir,'output')};
 const ref=await file('locator.json',locator);
 globalThis[transport]=options=>{assert.equal(options.query_timeout,9000);assert.equal(options.connectionTimeoutMillis,8000);assert(options.options.includes('statement_timeout=8000'));return c;};
 return{dir,c,locator,args:{locatorFile:ref.path,locatorSha:ref.sha256,sourceSqlSha,runnerSha},async cleanup(){delete globalThis[transport];await fs.rm(dir,{recursive:true,force:true});}};
}

test('SYNTHETIC_TRANSPORT: real QA issue commits without early constraint flush; same-key replay allocates no second correction',async()=>{
 const f=await fixture('success');try{
  const result=await runReturnCredit211Postgres(f.args).catch(async error=>{error.message+=' '+JSON.stringify(JSON.parse(await fs.readFile(path.join(f.locator.outputDirectory,'result.private.json'))).failure);throw error;});assert.equal(result.status,'ACTUAL_POSTGRES_BUSINESS_QA_PASS_NOT_FULL_PRODUCT_ACCEPTANCE');
  assert.equal(f.c.connects,1);assert.equal(f.c.ended,true);assert.equal(f.c.deferredValidations,1);
  assert.equal(f.c.log.some(x=>x.sql.startsWith('SET CONSTRAINTS')),false,'Operator must let deferred trigger run at COMMIT');
  const issueIndex=f.c.log.findIndex(x=>x.sql.startsWith('SELECT public.return_credit206_issue')&&x.args[2]===id(16));
  const commitIndex=f.c.log.findIndex((x,i)=>i>issueIndex&&x.sql==='COMMIT');assert(commitIndex>issueIndex);
  assert.equal(f.c.log[commitIndex+1].sql,'SYNTHETIC_DEFERRED_PARENT_COMPLETE_AT_COMMIT');
  const issueAck=JSON.parse(await fs.readFile(path.join(f.locator.outputDirectory,'issue-ack.private.json')));assert.equal(issueAck.commit_ack,true);assert.equal(issueAck.result.reused,false);
  const replayAck=JSON.parse(await fs.readFile(path.join(f.locator.outputDirectory,'same-key-replay-ack.private.json')));assert.equal(replayAck.result.reused,true);assert.equal(replayAck.result.document_id,issueAck.result.document_id);
 }finally{await f.cleanup();}
});

test('SYNTHETIC_TRANSPORT: lost committed issue ACK preserves first error and readback intent, stops replay and later mutations',async()=>{
 const f=await fixture('lost-issue-commit-ack');try{
  await assert.rejects(runReturnCredit211Postgres(f.args),/RETURN_CREDIT211_QA_FAILED_SEE_PRIVATE_RESULT/);
  const result=JSON.parse(await fs.readFile(path.join(f.locator.outputDirectory,'result.private.json')));
  assert.equal(result.status,'FAILED_NO_REPLAY');assert.equal(result.failure.stage,'actual-issue-COMMIT');assert.equal(result.failure.code,'ECONNRESET');assert.equal(result.failure.commit_outcome_unknown,true,'Cleanup fault must not replace first COMMIT error');
  assert.equal(result.failure.message,'Synthetic transport fault');assert.equal(result.failure.message_sha256,sha(result.failure.message));assert.match(result.failure.stack,/Synthetic transport fault/);
  assert.equal(f.c.state.issued,true,'Transport deliberately persisted the issue before losing its ACK');
  const intent=JSON.parse(await fs.readFile(path.join(f.locator.outputDirectory,'issue-intent.private.json')));assert.equal(intent.operation,'issue');assert.equal(intent.tenant_id,A);assert.equal(intent.body.preview_id,id(32));assert.match(intent.body.client_key,/^[a-f0-9-]{36}$/);assert.equal(intent.body.scope_hash,'d'.repeat(64));
  await assert.rejects(fs.stat(path.join(f.locator.outputDirectory,'issue-ack.private.json')),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.locator.outputDirectory,'same-key-replay-intent.private.json')),{code:'ENOENT'});
  const fault=f.c.log.findIndex(x=>x.sql==='SYNTHETIC_DEFERRED_PARENT_COMPLETE_AT_COMMIT');assert(fault>=0);
  assert(f.c.log.slice(fault+1).every(x=>x.sql==='ROLLBACK'||x.sql==='END'),'No business readback, mutations, reconnect or replay follows unknown ACK');
  assert.equal(result.rollback_ack,true);assert.equal(result.client_closed,true);assert.equal(f.c.connects,1);
  // The intent is a readback target for Root; it is NOT an automatic readback
  // result or proof of Native PostgreSQL lost-ACK recovery.
 }finally{await f.cleanup();}
});

test.after(()=>hooks.deregister());
