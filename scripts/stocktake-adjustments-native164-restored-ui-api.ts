/** ROOT ONLY / SOURCE AUTHORED. Existing copy4198 AFTER independent before-login
 * restore readback and root Chrome logins. This helper never logs in or creates
 * actors. All464 rows retained; only explicitly supplied <=1 own new session per
 * OFF/ON actor. Six fixed malformed POSTs must423 before parsing/authentication.
 * No provider, worker, migration, stock write, automatic retry or resume.
 * Required pins: QA164_CONFIG_SHA256, QA164_SETUP_SHA256, QA164_ACCEPTED_SHA256,
 * QA164_RESTORE_READBACK_SHA256, QA164_RESTORE_RESULT_PATH/SHA256,
 * QA164_ARCHIVE_PATH/SHA256, QA164_ARCHIVE_REVISION, QA_EXPECTED_REVISION,
 * QA164_COPY_ADDED_SESSION_SHA_JSON={off:[tokenSHA],on:[tokenSHA]}.
 * QA164_RESTORED_UI_CONFIRM=VERIFY_OWN_COPY_SESSIONS_AND_SIX_423.
 */
import assert from 'node:assert/strict';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { captureStocktakeAdjustmentReadback, validateStocktakeAdjustmentReceipt, type StocktakeAdjustmentCapture } from './stocktake-adjustments-native164-readback';

type Row = Record<string, any>;
const ROOT='<workspace>/app',SCHEMA='149_stocktake_adjustments';
const BASE='http://127.0.0.1:4198';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const SHA=/^[a-f0-9]{64}$/,REV=/^[a-f0-9]{40}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RECEIPTS={off:'3e325f7a-c4f1-4c01-819b-f6c13abfa4a3',on:'ba48c94d-f7f7-420f-ba94-733d9734c5e1'};
async function directory(p:string){const s=await lstat(p);assert(s.isDirectory()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);}
async function bytes(p:string,max=512*1024*1024){
  const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);assert.equal(s.mode&0o777,0o600);assert(s.size>0&&s.size<=max);
  const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stable=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs']as const)assert.equal(n[k],s[k]);};
    stable(await f.stat());const b=await f.readFile();stable(await f.stat());stable(await lstat(p));assert.equal(b.length,s.size);return b;
  }finally{await f.close();}
}
async function fileHash(p:string){
  const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);assert.equal(s.mode&0o777,0o600);
  const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stable=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs']as const)assert.equal(n[k],s[k]);};
    stable(await f.stat());const h=createHash('sha256');let size=0;for await(const b of createReadStream(p,{fd:f.fd,autoClose:false})){h.update(b);size+=b.length;}
    stable(await f.stat());stable(await lstat(p));assert.equal(size,s.size);return{sha256:h.digest('hex'),size};
  }finally{await f.close();}
}
async function absent(p:string){try{await lstat(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Exclusive proof exists; no resume');}
async function wx(p:string,v:unknown,mode:number){
  await directory(dirname(p));const b=JSON.stringify(v,null,2)+'\n';assert(Buffer.byteLength(b)<=512*1024*1024);
  const f=await open(p,'wx',mode);try{await f.writeFile(b);await f.sync();}finally{await f.close();}
  const d=await open(dirname(p),'r');try{await d.sync();}finally{await d.close();}return sha(b);
}
async function boundedBody(r:Response,max:number){
  assert(r.body);const reader=r.body.getReader(),chunks:Buffer[]=[];let n=0;
  try{for(;;){const v=await reader.read();if(v.done)break;n+=v.value.byteLength;assert(n<=max);chunks.push(Buffer.from(v.value));}}
  finally{await reader.cancel().catch(()=>undefined);}return Buffer.concat(chunks);
}
function sessionProof(baseline:StocktakeAdjustmentCapture,current:StocktakeAdjustmentCapture,actors:Row[],expected:Row){
  assert.deepEqual(Object.keys(expected).sort(),['off','on']);
  const old=baseline.rows.sessions.map(x=>x.row),now=current.rows.sessions.map(x=>x.row);
  assert.equal(new Set(old.map(x=>x.token_hash)).size,old.length);assert.equal(new Set(now.map(x=>x.token_hash)).size,now.length);
  for(const r of old){const found=now.filter(x=>x.token_hash===r.token_hash);assert.equal(found.length,1);assert.deepEqual(found[0],r,'Every old session exact, no removal');}
  const added=now.filter(x=>!old.some(o=>o.token_hash===x.token_hash)),proof:Row={};
  const allExpected:string[]=[];
  for(const a of actors){const key=a.on?'on':'off',tokens=expected[key];assert(Array.isArray(tokens)&&tokens.length<=1);
    tokens.forEach(t=>assert.match(t,SHA));allExpected.push(...tokens);
    const own=added.filter(x=>x.user_id===a.user_id&&x.tenant_id===a.tenant_id);
    assert.deepEqual(own.map(x=>x.token_hash).sort(),[...tokens].sort());
    for(const s of own){assert.match(s.token_hash,SHA);assert(Number.isFinite(Date.parse(s.expires_at)));assert(Date.parse(s.expires_at)>Date.now());}
    proof[key]={added:tokens,removed:[],old_rows_exact:true};
  }
  assert.equal(new Set(allExpected).size,allExpected.length);assert.deepEqual(added.map(x=>x.token_hash).sort(),allExpected.sort());
  return proof;
}
async function main(){
  let step='preflight',c:pg.Client|undefined;
  const output=resolve(ROOT,'data/stocktake-adjustments-native164-restored-ui-api.json'),publicOutput=resolve(ROOT,'docs/stocktake-adjustments-native164-restored-ui-api.json');
  const pins=new Map<string,string>();
  try{
    assert.equal(process.cwd(),ROOT);assert.equal(await realpath(process.cwd()),ROOT);assert.equal(process.argv.length,2);
    assert.equal(process.env.QA164_RESTORED_UI_CONFIRM,'VERIFY_OWN_COPY_SESSIONS_AND_SIX_423');
    assert.equal(process.env.DYNA_WORKER_DISABLED,'true');assert.equal(process.env.DYNA_PREVIEW_PORT,'4198');assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,resolve(ROOT,'.local.json'));
    for(const k of ['DYNA_TEST','DATABASE_URL'])assert.equal(process.env[k],undefined);
    const revision=process.env.QA_EXPECTED_REVISION??'',archiveRevision=process.env.QA164_ARCHIVE_REVISION??'';
    assert.match(revision,REV);assert.match(archiveRevision,REV);assert.equal(process.env.APP_REVISION,revision);
    for(const p of [ROOT,resolve(ROOT,'data'),resolve(ROOT,'docs')])await directory(p);
    await absent(output);await absent(publicOutput);await absent(output+'.intent.json');
    async function pin(p:string,h:string|undefined,max?:number){assert.match(h??'',SHA);const b=await bytes(p,max);assert.equal(sha(b),h);pins.set(p,h!);return JSON.parse(b.toString('utf8'))as Row;}
    const config=await pin(resolve(ROOT,'.local.json'),process.env.QA164_CONFIG_SHA256,65536);
    assert.match(config.encryptionKey,SHA);
    const setup=await pin(resolve(ROOT,'data/stocktake-adjustments-native164-setup.json'),process.env.QA164_SETUP_SHA256);
    const accepted=await pin(resolve(ROOT,'data/stocktake-adjustments-native164-readback-after-post.json'),process.env.QA164_ACCEPTED_SHA256);
    const restored=await pin(resolve(ROOT,'data/stocktake-adjustments-native164-restore-readback.json'),process.env.QA164_RESTORE_READBACK_SHA256);
    assert.equal(setup.stage,164);assert.equal(setup.schema,SCHEMA);assert.equal(setup.runtime_revision,archiveRevision);assert.equal(setup.pending,null);assert.equal(setup.status,'READY_FOR_NATIVE_CHROME_NOT_POSTED');
    assert.equal(accepted.stage,164);assert.equal(accepted.schema,SCHEMA);assert.equal(accepted.mode,'after-post');assert.equal(accepted.status,'STOCKTAKE_ADJUSTMENTS_NATIVE_READBACK_PASS');assert.equal(accepted.runtime_revision,archiveRevision);
    assert.equal(accepted.config_sha256,process.env.QA164_CONFIG_SHA256);assert.equal(accepted.setup_sha256,process.env.QA164_SETUP_SHA256);assert.equal(accepted.sessions_included,true);
    assert.equal(restored.stage,164);assert.equal(restored.schema,SCHEMA);assert.equal(restored.status,'STOCKTAKE_ADJUSTMENTS_RESTORE_READBACK_PASS');assert.equal(restored.archive_revision,archiveRevision);assert.equal(restored.runtime_revision,revision);
    assert.equal(restored.accepted_sha256,process.env.QA164_ACCEPTED_SHA256);assert.equal(restored.setup_sha256,process.env.QA164_SETUP_SHA256);assert.equal(restored.config_sha256,process.env.QA164_CONFIG_SHA256);
    assert.deepEqual(accepted.actors,setup.actors);assert.deepEqual(setup.actors.map((a:Row)=>[a.label,a.on]),[['OFF',false],['ON',true]]);
    assert.equal(new Set(setup.actors.map((a:Row)=>a.tenant_id)).size,2);assert.equal(new Set(setup.actors.map((a:Row)=>a.user_id)).size,2);
    for(const a of setup.actors){assert.match(a.tenant_id,UUID);assert.match(a.user_id,UUID);}
    assert.deepEqual(accepted.receipt_ids,RECEIPTS);assert.deepEqual(restored.capture,accepted.capture);assert.deepEqual(restored.proof,accepted.proof);
    const resultPath=process.env.QA164_RESTORE_RESULT_PATH??'',m=/^\/Users\/arturtwardowski\/DYNA Ecomerce\/app\/data\/(stocktake-adjustments-backup164-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/restore\/([a-f0-9]{16})\/result\.json$/.exec(resultPath);
    assert(m);const base=resolve(ROOT,'data',m[1]),database='dynaminds_restore_'+m[2];
    for(const p of [base,resolve(base,'restore'),dirname(resultPath),resolve(base,'backup')])await directory(p);
    const result=await pin(resultPath,process.env.QA164_RESTORE_RESULT_SHA256,65536);
    assert.equal(result.id,m[2]);assert.equal(result.database,database);assert.equal(restored.database,database);assert.equal(result.directory,dirname(resultPath));
    assert.equal(result.config,resolve(result.directory,'local-config.json'));assert.equal(result.images,resolve(result.directory,'images'));assert.equal(result.source,'dynaminds');
    assert.equal(result.status,'verified');assert.equal(result.preview_only,true);assert.equal(result.worker_enabled,false);assert.equal(result.row_fingerprints_match,true);assert.equal(result.schema_fingerprint_match,true);assert.equal(result.tables,464);assert.equal(result.revision,archiveRevision);
    assert.equal(restored.restore_result_sha256,process.env.QA164_RESTORE_RESULT_SHA256);
    const archivePath=process.env.QA164_ARCHIVE_PATH??'';assert.equal(dirname(archivePath),resolve(base,'backup'));assert.match(archivePath.slice(archivePath.lastIndexOf('/')+1),/^[a-z0-9]+-[a-f0-9]{16}\.dyna$/);
    assert.match(process.env.QA164_ARCHIVE_SHA256??'',SHA);const archive=await fileHash(archivePath);assert.equal(archive.sha256,process.env.QA164_ARCHIVE_SHA256);assert.equal(restored.archive_sha256,archive.sha256);
    const configBytes=await bytes(result.config,65536);pins.set(result.config,sha(configBytes));const copyConfig=JSON.parse(configBytes.toString('utf8'));
    assert.deepEqual(Object.keys(copyConfig).sort(),['dbPassword','encryptionKey']);assert.equal(copyConfig.encryptionKey,config.encryptionKey);assert(typeof copyConfig.dbPassword==='string'&&copyConfig.dbPassword);
    const expected=JSON.parse(process.env.QA164_COPY_ADDED_SESSION_SHA_JSON??'null');assert(expected);
    async function custody(){for(const [p,h]of pins)assert.equal(sha(await bytes(p)),h);assert.deepEqual(await fileHash(archivePath),archive);}
    async function health(){const r=await fetch(BASE+'/api/health',{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);
      const h=JSON.parse((await boundedBody(r,65536)).toString('utf8'));assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.revision,revision);assert.equal(h.schema_revision,SCHEMA);assert.equal(h.restore_preview,true);assert.equal(h.background_workers_enabled,false);assert.equal(h.stocktake_adjustments_available,true);}
    const previews=Object.fromEntries(setup.actors.map((a:Row)=>{const key=a.on?'on':'off',g=accepted.proof[key];assert.match(g.preview_id,UUID);assert.equal(g.receipt_id,RECEIPTS[key as keyof typeof RECEIPTS]);return[key,g.preview_id];}));
    // Fixed own accepted OFF preview suffices for both post aliases. ON graph is
    // independently compared; this is a restore onRequest guard, not a replay.
    const normal=['/api/stocktake-adjustments/series','/api/stocktake-adjustments/previews','/api/stocktake-adjustments/previews/'+previews.off+'/post'];
    const paths=[...normal,...normal.map(p=>p.replace(/^\/api\//,'/api/v1/'))];assert.equal(paths.length,6);
    for(let i=0;i<paths.length;i++){await absent(output+'.probe-'+i+'-intent.json');await absent(output+'.probe-'+i+'-response.json');}
    await health();await custody();await wx(output+'.intent.json',{stage:164,action:'COPY_UI_SESSION_AND_SIX_RESTORE_GUARDS',runtime_revision:revision,archive_revision:archiveRevision,
      accepted_sha256:process.env.QA164_ACCEPTED_SHA256,restore_readback_sha256:process.env.QA164_RESTORE_READBACK_SHA256,restore_result_sha256:process.env.QA164_RESTORE_RESULT_SHA256,expected_session_additions:expected,paths},0o600);
    c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:copyConfig.dbPassword,database,connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c TimeZone=UTC'});c.on('error',()=>{});await c.connect();
    async function capture(){assert(c);await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");
      try{assert.deepEqual((await c.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0],{db:database,role:'postgres',owner:'postgres',host:'127.0.0.1',port:55432,readonly:'on'});
        const cap=await captureStocktakeAdjustmentReadback(c);await c.query('COMMIT');return cap;
      }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}}
    step='before-probes';const before=await capture(),baseline=restored.capture as StocktakeAdjustmentCapture;
    assert.equal(Object.keys(before.rows).length,464);assert.deepEqual(Object.keys(before.rows),Object.keys(baseline.rows));
    for(const name of Object.keys(baseline.rows)){if(name==='sessions')continue;assert.deepEqual(before.rows[name],baseline.rows[name]);assert.deepEqual(before.fingerprints[name],baseline.fingerprints[name]);}
    const sessions=sessionProof(baseline,before,setup.actors,expected);assert.deepEqual(before.portable_metadata,baseline.portable_metadata);assert.deepEqual(before.proof_hashes,baseline.proof_hashes);
    const proof:Row={};for(const a of setup.actors){const key=a.on?'on':'off';proof[key]=validateStocktakeAdjustmentReceipt(before,a,RECEIPTS[key as keyof typeof RECEIPTS]);}assert.deepEqual(proof,accepted.proof);
    const responses:Row[]=[];
    for(const [i,path]of paths.entries()){
      step='malformed-'+i;await custody();await health();const request={method:'POST',path,raw_body:'{',content_type:'application/json',cookie:false,expected_status:423};
      const intentSha=await wx(output+'.probe-'+i+'-intent.json',{stage:164,...request,state:'UNKNOWN_UNTIL_RESPONSE'},0o600);
      const r=await fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
      assert.equal(r.status,423);assert.equal(r.headers.get('set-cookie'),null);await boundedBody(r,65536);
      const response={index:i,path,status:423,intent_sha256:intentSha,known_response:true};await wx(output+'.probe-'+i+'-response.json',response,0o600);responses.push(response);
    }
    step='final-purity';const after=await capture();assert.deepEqual(after,before,'Six rejected requests preserve all464 rows including sessions, metadata and proof hashes');await health();await custody();
    const privateSha=await wx(output,{stage:164,status:'STOCKTAKE_ADJUSTMENTS_RESTORED_UI_API_PASS',schema:SCHEMA,runtime_revision:revision,archive_revision:archiveRevision,
      config_sha256:process.env.QA164_CONFIG_SHA256,setup_sha256:process.env.QA164_SETUP_SHA256,accepted_sha256:process.env.QA164_ACCEPTED_SHA256,restore_readback_sha256:process.env.QA164_RESTORE_READBACK_SHA256,
      restore_result_sha256:process.env.QA164_RESTORE_RESULT_SHA256,archive_sha256:archive.sha256,database,sessions,capture:after,proof,responses},0o600);
    const report={stage:164,status:'STOCKTAKE_ADJUSTMENTS_RESTORED_UI_API_PASS',schema:SCHEMA,runtime_revision:revision,archive_revision:archiveRevision,tables:464,
      old_rows_including_sessions_exact:true,added_own_sessions:{off:expected.off.length,on:expected.on.length},removed_sessions:0,changed_old_sessions:0,
      portable_metadata_exact:true,receipt_graph_exact:true,malformed_posts_423:6,normal_posts:3,v1_posts:3,all_rows_after_rejected_posts_exact:true,
      helper_login_calls:0,business_writes:0,provider_calls:0,chrome_proven_here:false,exact_replay_proven:false,private_sha256:privateSha,restore_readback_sha256:process.env.QA164_RESTORE_READBACK_SHA256};
    await wx(publicOutput,report,0o644);console.log(JSON.stringify(report));
  }catch(e){console.error(JSON.stringify({stage:164,status:'RESTORED_UI_API_FAILED_NO_RESUME',step,source_line:e instanceof Error?Number(e.stack?.match(/stocktake-adjustments-native164-restored-ui-api\.ts:(\d+):/)?.[1]??0):0,private_details_withheld:true}));process.exitCode=1;}
  finally{await c?.end().catch(()=>undefined);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main();
