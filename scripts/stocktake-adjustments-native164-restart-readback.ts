/** ROOT ONLY. A new primary restart proof, never a rebase of accepted after-post.
 * GET only, no login, business mutation, worker, migration or transaction retry.
 * Requires QA164_RESTART_CONFIRM=READ_ONLY_EXACT_ACCEPTED_164_AFTER_RESTART,
 * QA164_ACCEPTED_REVISION (historical), QA_EXPECTED_REVISION=APP_REVISION
 * (current), QA164_ACCEPTED_SHA256, QA164_SETUP_SHA256, QA164_CONFIG_SHA256,
 * QA164_SQL_SHA256. Every row including sessions must remain literally equal.
 * Importing this module does not connect, read config or invoke the CLI.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { captureStocktakeAdjustmentReadback, validateStocktakeAdjustmentReceipt, type StocktakeAdjustmentCapture } from './stocktake-adjustments-native164-readback';

type Row = Record<string, any>;
type Proof = ReturnType<typeof validateStocktakeAdjustmentReceipt>;
const ROOT = '<workspace>/app';
const BASE = 'http://127.0.0.1:4100/api';
const SCHEMA = '149_stocktake_adjustments';
const SQL_SHA = 'a4ec349804e0bddddbe595669b3a87f432a72cc9f1b19af2eb80aabf6b902264';
const sha = (b: Buffer|string) => createHash('sha256').update(b).digest('hex');
const shaRE = /^[a-f0-9]{64}$/;
const revisionRE = /^[a-f0-9]{40}$/;
const uuidRE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function directory(path:string) {
  const s=await lstat(path);assert(s.isDirectory()&&!s.isSymbolicLink());assert.equal(await realpath(path),path);
}
async function readFile(path:string,max:number,privateFile:boolean) {
  const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink());assert(s.size>0&&s.size<=max);
  if(privateFile)assert.equal(s.mode&0o777,0o600);
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stable=(n:typeof s)=>{for(const key of ['dev','ino','size','mode','mtimeMs'] as const)assert.equal(n[key],s[key]);};
    stable(await f.stat());const b=await f.readFile();stable(await f.stat());stable(await lstat(path));assert.equal(b.length,s.size);return b;
  } finally {await f.close();}
}
async function absent(path:string) {
  try {await lstat(path);} catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  throw Error('Exclusive restart evidence exists');
}
async function wx(path:string,value:unknown,mode:number) {
  await directory(dirname(path));const b=JSON.stringify(value,null,2)+'\n';assert(Buffer.byteLength(b)<=512*1024*1024);
  const f=await open(path,'wx',mode);try {await f.writeFile(b);await f.sync();}finally {await f.close();}
  const d=await open(dirname(path),'r');try {await d.sync();}finally {await d.close();}return sha(b);
}
function one(rows:Row[]) {assert.equal(rows.length,1);return rows[0];}
function projectedRows(rows:Row[]) {return rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='_exponent')));}
function snapshot(g:Proof) {
  return {source:g.preview.frame.source,year:g.preview.frame.year,series:g.preview.frame.series,row_count:6,
    rows_sha256:g.preview.frame.rows_sha256,summary:g.summary};
}
function documentView(g:Proof,d:Row) {
  return {id:d.id,receipt_id:g.receipt_id,kind:d.kind,number:d.number,series_id:d.series_id,year:d.year,sequence:String(d.sequence),
    source_kind:g.source_kind,stocktake_id:g.stocktake_id,warehouse:g.preview.frame.source.warehouse,
    row_count:3,summary:d.summary,created_at:d.created_at};
}
async function main() {
  let step='preflight',gets=0,c:pg.Client|undefined;
  const paths={
    config:resolve(ROOT,'.local.json'),setup:resolve(ROOT,'data/stocktake-adjustments-native164-setup.json'),
    accepted:resolve(ROOT,'data/stocktake-adjustments-native164-readback-after-post.json'),
    sql:resolve(ROOT,'server/149_stocktake_adjustments.sql'),
    output:resolve(ROOT,'data/stocktake-adjustments-native164-restart-readback.json'),
    publicOutput:resolve(ROOT,'docs/stocktake-adjustments-native164-restart-readback.json'),
  };
  const pins=new Map<string,{sha256:string;max:number;privateFile:boolean}>();
  try {
    assert.equal(await realpath(process.cwd()),ROOT);assert.equal(process.cwd(),ROOT);
    assert.equal(process.env.QA164_RESTART_CONFIRM,'READ_ONLY_EXACT_ACCEPTED_164_AFTER_RESTART');
    assert.equal(process.env.DYNA_WORKER_DISABLED,'true');assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,paths.config);
    for(const key of ['DYNA_TEST','DATABASE_URL','DYNA_PREVIEW_PORT'])assert.equal(process.env[key],undefined);
    const revision=process.env.QA_EXPECTED_REVISION??'',acceptedRevision=process.env.QA164_ACCEPTED_REVISION??'';
    assert.match(revision,revisionRE);assert.match(acceptedRevision,revisionRE);assert.equal(process.env.APP_REVISION,revision);
    for(const p of [ROOT,resolve(ROOT,'data'),resolve(ROOT,'docs')])await directory(p);
    await absent(paths.output);await absent(paths.publicOutput);await absent(paths.output+'.intent.json');
    async function pin(path:string,expected:string|undefined,max:number,privateFile=true) {
      assert.match(expected??'',shaRE);const b=await readFile(path,max,privateFile);assert.equal(sha(b),expected);
      pins.set(path,{sha256:sha(b),max,privateFile});return b;
    }
    const config=JSON.parse((await pin(paths.config,process.env.QA164_CONFIG_SHA256,65536)).toString('utf8')) as Row;
    assert.equal(typeof config.dbPassword,'string');assert(config.dbPassword.length>0);
    const setup=JSON.parse((await pin(paths.setup,process.env.QA164_SETUP_SHA256,32*1024*1024)).toString('utf8')) as Row;
    const accepted=JSON.parse((await pin(paths.accepted,process.env.QA164_ACCEPTED_SHA256,512*1024*1024)).toString('utf8')) as Row;
    assert.equal(process.env.QA164_SQL_SHA256,SQL_SHA);await pin(paths.sql,SQL_SHA,1024*1024,false);
    assert.equal(setup.stage,164);assert.equal(setup.schema,SCHEMA);assert.equal(setup.runtime_revision,acceptedRevision);
    assert.equal(setup.status,'READY_FOR_NATIVE_CHROME_NOT_POSTED');assert.equal(setup.pending,null);assert.equal(setup.actors.length,2);
    assert.equal(accepted.stage,164);assert.equal(accepted.mode,'after-post');assert.equal(accepted.schema,SCHEMA);
    assert.equal(accepted.status,'STOCKTAKE_ADJUSTMENTS_NATIVE_READBACK_PASS');assert.equal(accepted.runtime_revision,acceptedRevision);
    assert.equal(accepted.config_sha256,process.env.QA164_CONFIG_SHA256);assert.equal(accepted.setup_sha256,process.env.QA164_SETUP_SHA256);
    assert.equal(accepted.sessions_included,true);assert.deepEqual(accepted.actors,setup.actors);
    assert.deepEqual(setup.actors.map((a:Row)=>[a.label,a.on]),[['OFF',false],['ON',true]]);
    assert.equal(new Set(setup.actors.map((a:Row)=>a.tenant_id)).size,2);assert.equal(new Set(setup.actors.map((a:Row)=>a.user_id)).size,2);
    assert.deepEqual(Object.keys(accepted.receipt_ids).sort(),['off','on']);
    for(const key of ['off','on'])assert.match(accepted.receipt_ids[key],uuidRE);assert.notEqual(accepted.receipt_ids.off,accepted.receipt_ids.on);
    assert.equal(Object.keys(accepted.capture.rows).length,464);assert(accepted.capture.rows.sessions);
    for(const a of setup.actors) {assert.match(a.tenant_id,uuidRE);assert.match(a.user_id,uuidRE);assert.match(a.cookie,/^dyna_session=[A-Za-z0-9_.-]+$/);}
    async function custody() {for(const [path,p] of pins)assert.equal(sha(await readFile(path,p.max,p.privateFile)),p.sha256);}
    async function get(actor:Row|null,path:string):Promise<Row> {
      assert(path==='/health'||path==='/auth/me'||path==='/stocktake-adjustments/options'||
        /^\/stocktake-adjustments\/(receipts\/[a-f0-9-]{36}|previews\/[a-f0-9-]{36}(\/rows\?limit=100)?|documents\/[a-f0-9-]{36}(\/rows\?limit=100)?|documents\?source_kind=(quantity|wms)&stocktake_id=[a-f0-9-]{36}&limit=50)$/.test(path));
      gets++;const r=await fetch(BASE+path,{method:'GET',headers:actor?{cookie:actor.cookie,'X-Workspace-ID':actor.tenant_id}:{},
        redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
      assert.equal(r.status,200);const b=Buffer.from(await r.arrayBuffer());assert(b.length<=8*1024*1024);return JSON.parse(b.toString('utf8')) as Row;
    }
    async function health() {
      const h=await get(null,'/health');assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.revision,revision);
      assert.equal(h.schema_revision,SCHEMA);assert.equal(h.background_workers_enabled,false);assert.equal(h.restore_preview,false);
      assert.equal(h.stocktake_adjustments_available,true);
    }
    async function capture() {
      assert(c);await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");
      try {
        assert.deepEqual((await c.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0],
          {db:'dynaminds',role:'postgres',owner:'postgres',host:'127.0.0.1',port:55432,readonly:'on'});
        const result=await captureStocktakeAdjustmentReadback(c);await c.query('COMMIT');return result;
      } catch(error) {await c.query('ROLLBACK').catch(()=>undefined);throw error;}
    }
    function exact(cap:StocktakeAdjustmentCapture) {
      assert.deepEqual(cap.rows,accepted.capture.rows,'Every global row including all sessions unchanged');
      assert.deepEqual(cap.fingerprints,accepted.capture.fingerprints);assert.deepEqual(cap.portable_metadata,accepted.capture.portable_metadata);
      assert.deepEqual(cap.proof_hashes,accepted.capture.proof_hashes);
    }
    await custody();await health();
    await wx(paths.output+'.intent.json',{stage:164,action:'READ_ONLY_EXACT_ACCEPTED_AFTER_RESTART',accepted_sha256:process.env.QA164_ACCEPTED_SHA256,
      setup_sha256:process.env.QA164_SETUP_SHA256,config_sha256:process.env.QA164_CONFIG_SHA256,sql_sha256:SQL_SHA,
      runtime_revision:revision,accepted_revision:acceptedRevision},0o600);
    step='capture';c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:config.dbPassword,database:'dynaminds',
      connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c TimeZone=UTC'});
    c.on('error',()=>{});await c.connect();const cap=await capture();exact(cap);const proof:Row={},apiProof:Row={};
    for(const a of setup.actors) {
      const key=a.on?'on':'off';step=key+':graph';const g=validateStocktakeAdjustmentReceipt(cap,a,accepted.receipt_ids[key]);
      assert.deepEqual(g,accepted.proof[key]);proof[key]=g;
      step=key+':api';const me=await get(a,'/auth/me');assert.equal(me.user.id,a.user_id);assert.equal(me.user.tenant_id,a.tenant_id);assert.equal(me.user.role,'admin');
      const options=await get(a,'/stocktake-adjustments/options');for(const flag of ['available','can_read','can_write','can_read_value'])assert.equal(options[flag],true);assert.equal(options.read_only,false);
      const r=await get(a,'/stocktake-adjustments/receipts/'+g.receipt_id),p=await get(a,'/stocktake-adjustments/previews/'+g.preview_id);
      const docs=g.documents.map(d=>documentView(g,d)).sort((x,y)=>x.kind.localeCompare(y.kind));
      assert.deepEqual(r.receipt,{id:g.receipt_id,preview_id:g.preview_id,client_key:g.receipt.client_key,scope_hash:g.preview.scope_hash,
        request:g.receipt.request,snapshot:snapshot(g),source:{source_kind:g.source_kind,stocktake_id:g.stocktake_id,posting_id:g.posting_id,
        operation_id:g.operation_id,version:g.version,state:'posted'},documents:docs,created_at:g.receipt.created_at});assert.deepEqual(r.documents,docs);
      assert.deepEqual(p.preview,{id:g.preview_id,source_kind:g.source_kind,stocktake_id:g.stocktake_id,request:g.preview.request,scope_hash:g.preview.scope_hash,
        snapshot:snapshot(g),created_at:g.preview.created_at,expires_at:g.preview.expires_at,receipt_id:g.receipt_id,can_post:false});
      const pr=await get(a,'/stocktake-adjustments/previews/'+g.preview_id+'/rows?limit=100');assert.deepEqual(pr.meta,{cursor:null,total:6});
      assert.equal(pr.preview_id,g.preview_id);assert.equal(pr.scope_hash,g.preview.scope_hash);assert.deepEqual(pr.data,projectedRows(g.preview_rows.map(x=>x.payload)));
      const history=await get(a,`/stocktake-adjustments/documents?source_kind=${g.source_kind}&stocktake_id=${g.stocktake_id}&limit=50`);
      assert.equal(history.meta.cursor,null);assert.equal(history.data.length,2);for(const d of docs)assert.deepEqual(one(history.data.filter((x:Row)=>x.id===d.id)),d);
      for(const d of docs) {
        const view=await get(a,'/stocktake-adjustments/documents/'+d.id),rows=await get(a,'/stocktake-adjustments/documents/'+d.id+'/rows?limit=100');
        assert.deepEqual(view.document,d);assert.equal(rows.document_id,d.id);assert.deepEqual(rows.meta,{cursor:null,total:3});
        assert.deepEqual(rows.data,projectedRows(g.document_rows.filter(x=>x.document_id===d.id).sort((x,y)=>x.ordinal-y.ordinal).map(x=>x.payload)));
      }
      apiProof[key]={receipt_id:g.receipt_id,preview_id:g.preview_id,document_ids:g.document_ids,source:g.source_kind,stocktake_id:g.stocktake_id,summary:g.summary,core_operation_id:g.operation_id};
      assert.deepEqual(apiProof[key],accepted.api_proof[key]);
    }
    step='final-purity';const after=await capture();exact(after);assert.deepEqual(after,cap,'No GET changes to any rows, sessions or metadata');await health();await custody();
    const status='STOCKTAKE_ADJUSTMENTS_RESTART_READBACK_PASS';
    const privateSha=await wx(paths.output,{stage:164,status,schema:SCHEMA,runtime_revision:revision,accepted_revision:acceptedRevision,
      accepted_sha256:process.env.QA164_ACCEPTED_SHA256,setup_sha256:process.env.QA164_SETUP_SHA256,config_sha256:process.env.QA164_CONFIG_SHA256,
      sql_sha256:SQL_SHA,receipt_ids:accepted.receipt_ids,capture:cap,proof,api_proof:apiProof,created_at:new Date().toISOString()},0o600);
    const report={stage:164,status,schema:SCHEMA,runtime_revision:revision,accepted_revision:acceptedRevision,
      accepted_sha256:process.env.QA164_ACCEPTED_SHA256,setup_sha256:process.env.QA164_SETUP_SHA256,config_sha256:process.env.QA164_CONFIG_SHA256,
      sql_sha256:SQL_SHA,private_sha256:privateSha,tables:464,all_rows_including_sessions_exact:true,portable_metadata_exact:true,
      receipt_graph_and_counters_exact:true,full_receipt_document_rows_api_exact:true,gets,mutations:0,login_calls:0,worker_calls:0,
      original_accepted_checkpoint_unchanged:true,historical_files_verified_here:false,restore_verified_here:false,chrome_verified_here:false,provider_verified:false,full_goal_complete:false};
    await wx(paths.publicOutput,report,0o644);console.log(JSON.stringify(report));
  } catch(error) {
    const line=error instanceof Error?error.stack?.match(/stocktake-adjustments-native164-restart-readback\.ts:(\d+):(\d+)/):undefined;
    console.error(JSON.stringify({stage:164,status:'RESTART_READBACK_FAILED_NO_REPAIR',step,source_line:line?Number(line[1]):null,
      private_details_withheld:true,automatic_resume:false}));process.exitCode=1;
  } finally {await c?.end().catch(()=>undefined);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main();
