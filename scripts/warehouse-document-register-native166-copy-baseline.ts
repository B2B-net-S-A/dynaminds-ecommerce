/** ROOT ONLY. Existing verified copy166, before login. GET health + owner UTC
 * RR READ ONLY; never restore/migrate/login/repair or perform business writes.
 * Import-safe CLI; exact full primary capture includes every old/new session.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { captureStocktakeAdjustmentReadback } from './stocktake-adjustments-native164-readback';
import { captureStocktakeAdjustmentPreservation } from './stocktake-adjustments-native164-preservation';

type Row=Record<string,any>;
const ROOT='<workspace>/app',SCHEMA='149_stocktake_adjustments';
const OUT=resolve(ROOT,'data/warehouse-document-register-native166-copy-baseline.json');
const PUBLIC=resolve(ROOT,'docs/warehouse-document-register-native166-copy-baseline.json');
const CONFIG_SHA='9a2c81811d1ffdb6c52aabdd77dddf3ac1975bd8cc2c2d2957882b338dd7b660';
const SQL_SHA='a4ec349804e0bddddbe595669b3a87f432a72cc9f1b19af2eb80aabf6b902264';
const ACCEPTED_SHA='2fc09ecc9a7593d13c811854367ba819998334567711bba6a9e71de657f9f157';
const ACCEPTED_SETUP_SHA='8b4c8cbcce87e338949313098f2cbe4629803ceecd60770ca1e04f4f37bfeaa2';
const ORIGINAL_SETUP_SHA='42e57b713557cd5e1014bc3b05a741d12cfc81ce9be1606b10ccb41966c9fdef';
const RUNTIME_REVISION='2cb91938fbc2b0d8435b793a58651acba4f9984b';
const SHA=/^[a-f0-9]{64}$/,REV=/^[a-f0-9]{40}$/;
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function directory(p:string){const s=await lstat(p);assert(s.isDirectory()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);}
async function bytes(p:string,max=512*1024*1024,privateFile=true){
  assert.equal(await realpath(p),p);const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert(s.size>0&&s.size<=max);if(privateFile)assert.equal(s.mode&0o777,0o600);
  const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stable=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs'] as const)assert.equal(n[k],s[k]);};stable(await f.stat());const b=await f.readFile();stable(await f.stat());stable(await lstat(p));assert.equal(b.length,s.size);return b;}finally{await f.close();}
}
async function absent(p:string){try{await lstat(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Exclusive166 copy baseline already exists');}
async function wx(p:string,value:unknown,mode=0o600){
  await directory(dirname(p));const b=JSON.stringify(value,null,2)+'\n';assert(Buffer.byteLength(b)<=512*1024*1024);
  const f=await open(p,'wx',mode);try{await f.writeFile(b);await f.sync();}finally{await f.close();}
  const d=await open(dirname(p),'r');try{await d.sync();}finally{await d.close();}return hash(b);
}
async function main(){
  let c:pg.Client|undefined,step='preflight';const pinned=new Map<string,{sha:string;max:number;privateFile:boolean}>();
  try{
    assert.equal(process.cwd(),ROOT);assert.equal(process.argv.length,2);await directory(ROOT);await directory(resolve(ROOT,'data'));await directory(resolve(ROOT,'docs'));
    assert.equal(process.env.QA166_COPY_BASELINE_CONFIRM,'READ_ONLY_COPY166_BEFORE_LOGIN');assert.equal(process.env.DYNA_WORKER_DISABLED,'true');assert.equal(process.env.DYNA_PREVIEW_PORT,'4199');
    assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,resolve(ROOT,'.local.json'));for(const name of ['DATABASE_URL','DYNA_TEST'])assert.equal(process.env[name],undefined);
    const revision=process.env.QA_EXPECTED_REVISION??'',archiveRevision=process.env.QA166_ARCHIVE_REVISION??'';assert.match(revision,REV);assert.match(archiveRevision,REV);assert.equal(process.env.APP_REVISION,revision);assert.equal(revision,RUNTIME_REVISION);assert.equal(archiveRevision,RUNTIME_REVISION);
    await absent(OUT);await absent(PUBLIC);await absent(OUT+'.intent.json');
    async function pin(p:string,expected:string|undefined,max=512*1024*1024,privateFile=true):Promise<Row>{assert.match(expected??'',SHA);const b=await bytes(p,max,privateFile);assert.equal(hash(b),expected);pinned.set(p,{sha:expected!,max,privateFile});return JSON.parse(b.toString('utf8')) as Row;}
    const config=await pin(resolve(ROOT,'.local.json'),CONFIG_SHA,65536);assert.match(config.encryptionKey,SHA);assert.equal(typeof config.dbPassword,'string');assert(config.dbPassword.length>0);
    const sqlPath=resolve(ROOT,'server/149_stocktake_adjustments.sql'),sqlBytes=await bytes(sqlPath,4*1024*1024,false);assert.equal(hash(sqlBytes),SQL_SHA);pinned.set(sqlPath,{sha:SQL_SHA,max:4*1024*1024,privateFile:false});
    const acceptedPath=process.env.QA166_PRIMARY_ACCEPTED_PATH??'';assert.equal(dirname(acceptedPath),resolve(ROOT,'data'));assert.match(basename(acceptedPath),/^warehouse-document-register-native166-primary-after(?:-attempt[2-9])?\.json$/);assert.equal(process.env.QA166_PRIMARY_ACCEPTED_SHA256,ACCEPTED_SHA);
    const accepted=await pin(acceptedPath,ACCEPTED_SHA);assert.equal(accepted.stage,166);assert.equal(accepted.scope,'primary');assert.equal(accepted.phase,'after');assert.equal(accepted.status,'REGISTER166_AFTER_READ_ONLY_PASS');assert.equal(accepted.schema,SCHEMA);assert.equal(accepted.runtime_revision,revision);assert.equal(accepted.config_sha256,CONFIG_SHA);assert.equal(accepted.sql_sha256,SQL_SHA);assert.equal(accepted.business_mutations,0);assert.equal(accepted.login_calls,0);
    assert.equal(Object.keys(accepted.capture.rows).length,464);assert(Array.isArray(accepted.capture.rows.sessions));
    assert.equal(process.env.QA166_SETUP_SHA256,ACCEPTED_SETUP_SHA);assert.equal(process.env.QA166_ORIGINAL_SETUP_SHA256,ORIGINAL_SETUP_SHA);
    const setup=await pin(resolve(ROOT,'data/warehouse-document-register-native166-setup-accepted.json'),ACCEPTED_SETUP_SHA,32*1024*1024);
    assert.equal(setup.stage,166);assert.equal(setup.status,'OWN_LEGACY_DOCUMENTS_READY');assert.equal(setup.schema_revision,SCHEMA);assert.equal(setup.pending,null);assert.equal(setup.completed.length,15);assert.equal(setup.config_sha256,CONFIG_SHA);assert.equal(setup.sql_sha256,SQL_SHA);assert.equal(setup.acceptance_mode,'READ_ONLY_REVALIDATION_AFTER_15_CONFIRMED_WRITES');assert.equal(accepted.setup_sha256,process.env.QA166_SETUP_SHA256);
    const originalPath=resolve(ROOT,'data/warehouse-document-register-native166-setup.json');assert.equal(setup.original_journal_path,originalPath);assert.equal(setup.original_journal_sha256,process.env.QA166_ORIGINAL_SETUP_SHA256);assert.equal(accepted.original_setup_sha256,process.env.QA166_ORIGINAL_SETUP_SHA256);assert.equal(setup.original_journal_status,'FAILED_DO_NOT_RERUN');
    const original=await pin(originalPath,process.env.QA166_ORIGINAL_SETUP_SHA256,32*1024*1024);assert.equal(original.stage,166);assert.equal(original.status,'FAILED_DO_NOT_RERUN');assert.equal(original.failed_step,'full-after-setup');assert.equal(original.pending,null);assert.deepEqual(original.completed,setup.completed);assert.deepEqual(original.actor,setup.actor);
    for(const k of ['schema_revision','runtime_revision','config_sha256','sql_sha256','before_path','before_sha256'])assert.deepEqual(original[k],setup[k]);
    const resultPath=process.env.QA166_RESTORE_RESULT_PATH??'';
    const match=/^\/Users\/arturtwardowski\/DYNA Ecomerce\/app\/data\/(warehouse-document-register-backup166-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/restore\/([a-f0-9]{16})\/result\.json$/.exec(resultPath);assert(match);
    for(const p of [resolve(ROOT,'data',match[1]),resolve(ROOT,'data',match[1],'restore'),dirname(resultPath)])await directory(p);
    const result=await pin(resultPath,process.env.QA166_RESTORE_RESULT_SHA256,65536),database='dynaminds_restore_'+match[2];
    assert.equal(result.id,match[2]);assert.equal(result.database,database);assert.equal(result.directory,dirname(resultPath));assert.equal(result.config,resolve(dirname(resultPath),'local-config.json'));assert.equal(result.images,resolve(dirname(resultPath),'images'));assert.equal(result.source,'dynaminds');assert.equal(result.status,'verified');assert.equal(result.preview_only,true);assert.equal(result.worker_enabled,false);assert.equal(result.row_fingerprints_match,true);assert.equal(result.schema_fingerprint_match,true);assert.equal(result.tables,464);assert.equal(result.revision,archiveRevision);
    const restoredConfigBytes=await bytes(result.config,65536);pinned.set(result.config,{sha:hash(restoredConfigBytes),max:65536,privateFile:true});const restoredConfig=JSON.parse(restoredConfigBytes.toString()) as Row;
    assert.deepEqual(Object.keys(restoredConfig).sort(),['dbPassword','encryptionKey']);assert.equal(restoredConfig.encryptionKey,config.encryptionKey);assert.equal(typeof restoredConfig.dbPassword,'string');assert(restoredConfig.dbPassword.length>0);
    const manifestPath=resolve(dirname(resultPath),'manifest.json'),manifestBytes=await bytes(manifestPath,64*1024*1024);pinned.set(manifestPath,{sha:hash(manifestBytes),max:64*1024*1024,privateFile:true});const manifest=JSON.parse(manifestBytes.toString()) as Row;
    assert.equal(manifest.database,'dynaminds');assert.equal(manifest.revision,archiveRevision);assert.equal(manifest.schema_fingerprint_version,4);assert.equal(Object.keys(manifest.tables).length,464);assert.equal(manifest.config_sha256,hash(JSON.stringify({dbPassword:config.dbPassword,encryptionKey:config.encryptionKey})));
    async function custody(){for(const[p,v]of pinned)assert.equal(hash(await bytes(p,v.max,v.privateFile)),v.sha);}
    let gets=0;async function health(){gets++;const r=await fetch('http://127.0.0.1:4199/api/health',{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);assert.equal(r.headers.get('set-cookie'),null);const b=Buffer.from(await r.arrayBuffer());assert(b.length<=65536);const h=JSON.parse(b.toString()) as Row;assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.revision,revision);assert.equal(h.schema_revision,SCHEMA);assert.equal(h.restore_preview,true);assert.equal(h.background_workers_enabled,false);assert.equal(h.stocktake_adjustments_available,true);}
    await custody();await health();await wx(OUT+'.intent.json',{stage:166,scope:'copy166',action:'READ_ONLY_COPY_BASELINE_BEFORE_LOGIN',runtime_revision:revision,archive_revision:archiveRevision,primary_accepted_sha256:ACCEPTED_SHA,setup_sha256:process.env.QA166_SETUP_SHA256,restore_result_sha256:process.env.QA166_RESTORE_RESULT_SHA256});
    step='copy-capture';c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:restoredConfig.dbPassword,database,connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c TimeZone=UTC'});c.on('error',()=>{});await c.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");assert.deepEqual((await c.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0],{db:database,role:'postgres',owner:'postgres',host:'127.0.0.1',port:55432,readonly:'on'});
    assert.equal((await c.query('SELECT public.stocktake_adjustment_installed() AND public.stocktake_adjustment_guards() ok')).rows[0].ok,true);
    const capture=await captureStocktakeAdjustmentReadback(c),preservation=await captureStocktakeAdjustmentPreservation(c);
    assert.equal(Object.keys(capture.rows).length,464);assert.deepEqual(preservation.rows,capture.rows);assert.deepEqual(preservation.metadata,capture.portable_metadata);assert.deepEqual(capture,accepted.capture,'Every global row/session/portable metadata/proof hash is exact before login');await c.query('COMMIT');
    await health();await custody();step='exclusive-output';const status='REGISTER166_COPY_BASELINE_VERIFIED';
    const privateSha=await wx(OUT,{stage:166,scope:'copy166',status,database,schema:SCHEMA,runtime_revision:revision,archive_revision:archiveRevision,config_sha256:CONFIG_SHA,sql_sha256:SQL_SHA,setup_sha256:process.env.QA166_SETUP_SHA256,original_setup_sha256:process.env.QA166_ORIGINAL_SETUP_SHA256,restore_result_sha256:process.env.QA166_RESTORE_RESULT_SHA256,primary_accepted_sha256:ACCEPTED_SHA,capture,exact_metadata:preservation.exact_metadata,created_at:new Date().toISOString(),gets,login_calls:0,mutations:0});
    const safe={stage:166,scope:'copy166',status,schema:SCHEMA,runtime_revision:revision,archive_revision:archiveRevision,private_sha256:privateSha,primary_accepted_sha256:ACCEPTED_SHA,setup_sha256:process.env.QA166_SETUP_SHA256,original_setup_sha256:process.env.QA166_ORIGINAL_SETUP_SHA256,restore_result_sha256:process.env.QA166_RESTORE_RESULT_SHA256,tables:464,all_rows_and_sessions_exact:true,portable_metadata_and_proof_hashes_exact:true,copy_oid_metadata_captured:true,primary_oid_comparison:false,gets,login_calls:0,mutations:0,restore_executed_here:false,chrome_verified_here:false,files_verified_here:false,providers_verified:false,full_goal_complete:false};
    await wx(PUBLIC,safe,0o644);console.log(JSON.stringify(safe));
  }catch(e){const line=e instanceof Error?e.stack?.match(/warehouse-document-register-native166-copy-baseline\.ts:(\d+):(\d+)/):null;console.error(JSON.stringify({stage:166,status:'COPY_BASELINE_FAILED_NO_REPAIR',step,error_type:e instanceof Error?e.name:'Error',source_line:line?Number(line[1]):null,source_column:line?Number(line[2]):null,private_details_withheld:true}));process.exitCode=1;}
  finally{await c?.query('ROLLBACK').catch(()=>undefined);await c?.end().catch(()=>undefined);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main();
