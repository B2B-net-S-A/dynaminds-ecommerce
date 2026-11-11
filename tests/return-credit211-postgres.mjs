/**
 * Actual PostgreSQL business QA; importing this file does not connect or seed.
 * Root must first prepare a marked numeric scratch with genuine FV-before-RMA
 * cases, capture captureReturnCredit211BeforeInstall(), then install the reviewed
 * complete 209->211 program. This runner neither migrates nor invents fixtures.
 *
 * Explicit one-shot CLI (all hashes independently reviewed by the caller):
 * node tests/return-credit211-postgres.mjs --run LOCATOR LOCATOR_SHA SQL_SHA RUNNER_SHA
 * LOCATOR: {schema:'dynaminds-return-credit211-qa/v1',databaseUrl,
 * ownershipMarker,cases:{path,bytes,sha256},before211:{path,bytes,sha256},
 * sourceExpectation:{path,bytes,sha256},restoreProof:null|{path,bytes,sha256},outputDirectory}
 * Cases schema: dynaminds-return-credit211-genuine-cases/v1, evidence:
 * genuine_api_fv157_before_rma_and_credit206_before211; native148/historical169
 * each contain tenant_id,order_id,return_id,physical_receipt_id,
 * original_document_id,original_receipt_id. historical169 also credit_receipt_id.
 * These are actual API-created cases; existing Native207 invoice helpers can
 * prepare them under Root ownership. A source-only fixture is not accepted.
 *
 * Successful issue/replay COMMIT to exercise deferred completeness. A failed
 * COMMIT is unknown, never retried. Poison probes always ROLLBACK. No provider,
 * refund, stock seed, Main/preview mutation, app startup or default test SKIP.
 * Catalog inverse/source admission remains the independent compiler's gate;
 * this runner cannot turn an observed catalog into an expected source vector.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

const HERE=fileURLToPath(import.meta.url),SQL=fileURLToPath(new URL('../server/211_return_credit148_acceptance.sql',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const ownedMarker=x=>typeof x==='string'&&/^(?:DYNA_OWNED_RETURN_CREDIT211_|owned-return-credit211-acceptance:)[a-f0-9]{32}$/.test(x);
const physicalTables=Object.freeze(['orders','order_items','return_cases','return_items','return_assistant_sessions','return_assistant_previews','return_assistant_receipts','return_assistant_admissions','return_destination_admissions','return_destination_parts','return_destination_arrivals','return_destination_fragments','stock','stock_locations','stock_movements','stock_location_movements','wms_operations','wms_return_fragments','wms_issue_fragments','wms_cost_layers','wms_layer_positions','wms_layer_movements','catalog_stock_control_effect_admissions','catalog_stock_control_effects','catalog_stock_control_effect_journals','catalog_stock_return_admissions','catalog_stock_return_receipts','catalog_stock_return_documents','catalog_stock_return_rows','catalog_stock_return_stock_maps','catalog_stock_return_item_maps','catalog_stock_return_layer_maps','documents','payment_entries']);
const financialTables=Object.freeze(['return_credit206_series','return_credit206_previews','return_credit206_documents','return_credit206_receipts','return_credit206_counters','return_credit206_namespaces','return_credit206_admissions','local_consumer_credit_previews','local_consumer_credit_documents','local_consumer_credit_receipts','local_consumer_credit_admissions','local_consumer_credit_counters','local_consumer_credit_namespaces']);
const allTables=Object.freeze([...physicalTables,...financialTables]);

function exactKeys(v,keys){assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...keys].sort());}
export function validateReturnCredit211Cases(v){
 exactKeys(v,['schema','evidence','native148','historical169']);
 assert.equal(v.schema,'dynaminds-return-credit211-genuine-cases/v1');
 assert.equal(v.evidence,'genuine_api_fv157_before_rma_and_credit206_before211');
 const keys=['tenant_id','order_id','return_id','physical_receipt_id','original_document_id','original_receipt_id'];
 for(const [kind,f]of Object.entries({native148:v.native148,historical169:v.historical169})){
  exactKeys(f,kind==='historical169'?[...keys,'credit_receipt_id']:keys);
  for(const value of Object.values(f))assert(uuid(value),'Exact genuine case UUID required');
 }
 assert.notEqual(v.native148.tenant_id,v.historical169.tenant_id,'Independent valid foreign tenant required');
 return v;
}

async function privateJson(file,expectedSha,expectedBytes){
 assert(path.isAbsolute(file));assert.equal(await fs.realpath(file),file);assert(hash(expectedSha));
 const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await h.stat();assert(s.isFile()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&511)===384&&s.size<=33554432);
  if(expectedBytes!==undefined)assert.equal(s.size,expectedBytes);
  const b=await h.readFile();assert.equal(b.length,s.size);assert.equal(sha(b),expectedSha);
  const after=await h.stat();assert.equal(after.ino,s.ino);assert.equal(after.size,s.size);assert.equal(after.mtimeMs,s.mtimeMs);
  return JSON.parse(b);
 }finally{await h.close();}
}
async function pinnedJson(ref){exactKeys(ref,['path','bytes','sha256']);assert(Number.isSafeInteger(ref.bytes)&&ref.bytes>0);return privateJson(ref.path,ref.sha256,ref.bytes);}
async function writeJson(dir,name,value){const b=Buffer.from(JSON.stringify(value,null,2)+'\n');assert(b.length<=2097152);await fs.writeFile(path.join(dir,name),b,{flag:'wx',mode:0o600});return{bytes:b.length,sha256:sha(b)};}
async function facts(c,tenant){const out={};for(const table of allTables){
 const size=(await c.query(`SELECT count(*)::int n,coalesce(sum(pg_column_size(x)),0)::text bytes FROM public.${table} x WHERE tenant_id=$1`,[tenant])).rows[0];
 assert(size.n<=10000&&BigInt(size.bytes)<=33554432n,'Complete facts budget exceeded');
 out[table]=(await c.query(`SELECT count(*)::int n,encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]')::text,'UTF8')),'hex') sha FROM public.${table} x WHERE tenant_id=$1`,[tenant])).rows[0];
 }return out;}
const physical=f=>Object.fromEntries(physicalTables.map(k=>[k,f[k]]));
async function receiptRows(c){
 const size=(await c.query('SELECT count(*)::int n,coalesce(sum(pg_column_size(r)),0)::text bytes FROM public.return_credit206_receipts r')).rows[0];
 assert(size.n<=100&&BigInt(size.bytes)<=33554432n,'Historical seed budget');
 return(await c.query("SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY tenant_id,id),'[]') value FROM public.return_credit206_receipts r")).rows[0].value;
}

/**
 * Call only BEFORE migration211, inside Root's READ ONLY REPEATABLE READ
 * transaction on its marked disposable209; persist the result after ROLLBACK.
 * Existing numeric-scratch migrator/compiler owns both fixture creation and DDL.
 */
export async function captureReturnCredit211BeforeInstall(c,input){
 const cases=validateReturnCredit211Cases(input);
 const ctx=(await c.query("SELECT current_user,session_user,current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation,current_setting('session_replication_role') replication,current_database() name,inet_server_port() port,host(inet_server_addr()) address,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) owner,(SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) marker")).rows[0];
 assert.equal(ctx.current_user,'postgres');assert.equal(ctx.session_user,'postgres');assert.equal(ctx.ro,'on');assert.equal(ctx.isolation,'repeatable read');assert.equal(ctx.replication,'origin');assert.match(ctx.name,/^(?:dynaminds_test_\d{10,20}|dynaminds_restore_[a-f0-9]{16})$/);
 assert.equal(ctx.address,'127.0.0.1');assert.equal(ctx.owner,'postgres');assert(Number.isInteger(ctx.port));assert(ownedMarker(ctx.marker));
 assert.equal((await c.query("SELECT to_regclass('public.return_credit211_acceptances') IS NULL absent")).rows[0].absent,true,'Capture must precede211');
 assert.equal((await c.query('SELECT public.order_merge_delivery209_valid() value')).rows[0].value,true,'A genuine full209 predecessor is mandatory');
 const receipts=await receiptRows(c);assert(receipts.length>0,'A genuine pre211 credit206 is mandatory');
 assert(receipts.some(r=>r.tenant_id===cases.historical169.tenant_id&&r.id===cases.historical169.credit_receipt_id));
 const tenants={};for(const tenant of [...new Set([cases.native148.tenant_id,cases.historical169.tenant_id,...receipts.map(r=>r.tenant_id)])].sort()){
  assert(uuid(tenant));tenants[tenant]=await facts(c,tenant);
 }
 return{schema:'dynaminds-return-credit211-before-install/v1',database:ctx.name,identity:{database:ctx.name,port:ctx.port,address:ctx.address,owner:ctx.owner,marker:ctx.marker},cases,tenants,receipts};
}

async function authority(c,f){
 const r=(await c.query('SELECT r.actor_id,s.token_hash FROM public.local_invoice_receipts r JOIN public.sessions s ON(s.tenant_id,s.user_id)=(r.tenant_id,r.actor_id) WHERE(r.tenant_id,r.id)=($1,$2) AND s.expires_at>clock_timestamp() ORDER BY s.expires_at DESC LIMIT 1',[f.tenant_id,f.original_receipt_id])).rows[0];
 assert(r&&uuid(r.actor_id)&&typeof r.token_hash==='string','Genuine unexpired API session required');return r;
}
async function tx(c,f,a,work){
 await c.query('BEGIN');let committing=false;try{
  await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('local_invoice.identity_hash',$2,true)",[f.tenant_id,a.token_hash]);
  const result=await work();committing=true;
  const ack=await c.query('COMMIT');assert.equal(ack.command,'COMMIT');committing=false;return result;
 }catch(e){if(committing)e.qa211_commit_outcome_unknown=true;try{await c.query('ROLLBACK');}catch{}throw e;}
}
async function asApp(c,sql,args){await c.query('SET LOCAL ROLE dyna_app');const r=await c.query(sql,args);await c.query('RESET ROLE');return r.rows[0].value;}
async function value(c,sql,args){return(await c.query(sql,args)).rows[0].value;}
async function guards(c){const out={};for(const fn of ['ordinary187_valid','buyer_address_guards','order_merge_delivery209_valid','return_credit206_guards','ordinary188_structure_valid','return_credit211_metadata_valid']){
 const start=performance.now();await c.query('BEGIN READ ONLY');try{
  const actual=(await c.query(`SELECT public.${fn}() value`)).rows[0].value;
  assert.equal(actual,true,`Full ${fn} must be literal true at8s`);out[fn]={value:actual,ms:performance.now()-start};
 }finally{await c.query('ROLLBACK');}
 }return out;}
async function assertRefusal(c,label,work,code,message){
 await c.query('SAVEPOINT qa211_negative');try{
  let caught;try{await work();}catch(e){caught=e;}
  assert(caught,`${label} must refuse`);assert.equal(caught.code,code,`${label} must not pass on a timeout/infrastructure error`);
  if(message)assert(message.test(caught.message),`${label} must reach the intended branch`);
 }finally{await c.query('ROLLBACK TO SAVEPOINT qa211_negative');await c.query('RELEASE SAVEPOINT qa211_negative');}
}
async function verifyHistoricalSeed(c,before){
 assert.deepEqual(await receiptRows(c),before.receipts,'Migration may not rewrite any historical206 receipt');
 assert.equal((await c.query('SELECT count(*)::int n FROM public.return_credit211_acceptances')).rows[0].n,before.receipts.length,'Exactly one typed parent per historical receipt');
 for(const r of before.receipts){
  const row=await value(c,'SELECT to_jsonb(p) value FROM public.return_credit211_acceptances p WHERE(tenant_id,credit_admission_id)=($1,$2)',[r.tenant_id,r.id]);
  assert(row);assert.equal(row.family,'catalog169');assert.equal(row.catalog_receipt_id,r.return_receipt_id);assert.equal(row.destination_receipt_id,null);
  assert.equal(row.id,r.return_receipt_id);assert.equal(row.order_id,r.order_id);assert.equal(row.return_id,r.return_id);assert.equal(row.receipt_sequence,r.receipt_sequence);
  assert.equal(row.financial.financial_hash,r.snapshot.calculation.financial_hash);
 }
 for(const [tenant,expected]of Object.entries(before.tenants))assert.deepEqual(await facts(c,tenant),expected,'All complete old business facts must survive install');
}

export async function runReturnCredit211Postgres({locatorFile,locatorSha,sourceSqlSha,runnerSha}){
 assert(hash(sourceSqlSha)&&hash(runnerSha));assert.equal(sha(await fs.readFile(HERE)),runnerSha);assert.equal(sha(await fs.readFile(SQL)),sourceSqlSha,'Reviewed final source required');
 const locator=await privateJson(locatorFile,locatorSha);
 exactKeys(locator,['schema','databaseUrl','ownershipMarker','cases','before211','sourceExpectation','restoreProof','outputDirectory']);
 assert.equal(locator.schema,'dynaminds-return-credit211-qa/v1');
 const u=new URL(locator.databaseUrl);assert.equal(u.protocol,'postgres:');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username,'postgres');assert.equal(u.search,'');assert.equal(u.hash,'');
 assert.match(u.pathname,/^\/(?:dynaminds_test_\d{10,20}|dynaminds_restore_[a-f0-9]{16})$/);assert(Number(u.port)>=1024&&Number(u.port)<=65535);
 assert(ownedMarker(locator.ownershipMarker));
 const cases=validateReturnCredit211Cases(await pinnedJson(locator.cases)),before=await pinnedJson(locator.before211);
 exactKeys(before,['schema','database','identity','cases','tenants','receipts']);assert.equal(before.schema,'dynaminds-return-credit211-before-install/v1');
 assert.equal(before.database,u.pathname.slice(1));assert.deepEqual(before.cases,cases);assert(Array.isArray(before.receipts)&&before.receipts.length>0&&before.receipts.length<=100);
 assert.deepEqual(before.identity,{database:u.pathname.slice(1),port:Number(u.port),address:'127.0.0.1',owner:'postgres',marker:locator.ownershipMarker},'Before proof must belong to the same owned restored database and nonce');
 for(const r of before.receipts)assert(uuid(r.tenant_id)&&uuid(r.id));
 assert.deepEqual(Object.keys(before.tenants).sort(),[...new Set([cases.native148.tenant_id,cases.historical169.tenant_id,...before.receipts.map(r=>r.tenant_id)])].sort(),'Every old206 tenant must have a complete before211 baseline');
 // This artifact must come from Root's reviewed SOURCE compiler, never from
 // pg_proc or a post-install metadata observation. Until it exists QA is blocked.
 const expected=await pinnedJson(locator.sourceExpectation);
 exactKeys(expected,['schema','authority','source_sql_sha256','metadata']);
 assert.equal(expected.schema,'dynaminds-return-credit211-qa-source-expectation/v1');
 assert.equal(expected.authority,'SOURCE_COMPILED_COMPLETE_209_TO_211_NOT_OBSERVED');assert.equal(expected.source_sql_sha256,sourceSqlSha);
 exactKeys(expected.metadata,['id','profile','own_records','changes','removed','original206','original208','original209','source_compiler_sha256']);
 assert.equal(expected.metadata.id,true);assert.equal(expected.metadata.profile,'209-to211-destinations148-credit/v1');assert(hash(expected.metadata.source_compiler_sha256));
 assert(Array.isArray(expected.metadata.own_records)&&expected.metadata.own_records.length>0);assert.equal(expected.metadata.changes.length,6);assert.equal(expected.metadata.removed.length,2);
 if(u.pathname.startsWith('/dynaminds_restore_')){
  const packet=await pinnedJson(locator.restoreProof),restored=packet.result??packet;
  assert.equal(restored.status,'verified');assert.equal(restored.database,u.pathname.slice(1));assert.equal(restored.database,'dynaminds_restore_'+restored.id);assert.match(restored.id,/^[a-f0-9]{16}$/);
  assert.equal(restored.preview_only,true);assert.equal(restored.worker_enabled,false);assert.equal(restored.row_fingerprints_match,true);assert.equal(restored.schema_fingerprint_match,true);assert.notEqual(restored.source,restored.database);
 }else assert.equal(locator.restoreProof,null);
 assert(path.isAbsolute(locator.outputDirectory));assert.equal(await fs.realpath(path.dirname(locator.outputDirectory)),path.dirname(locator.outputDirectory));
 await fs.mkdir(locator.outputDirectory,{mode:0o700});
 const receipt={schema:'dynaminds-return-credit211-postgres-result/v1',status:'RUNNING',source_sql_sha256:sourceSqlSha,runner_sha256:runnerSha,locator_sha256:locatorSha,checks:{},catalog_source_acceptance:false,provider_acceptance:false,full_product_acceptance:false};
 await writeJson(locator.outputDirectory,'attempt.private.json',{schema:receipt.schema,runner_sha256:runnerSha,source_sql_sha256:sourceSqlSha,started_at:new Date().toISOString()});
 let c,stage='connect',failure;
 const committedOperation=async(name,f,a,body,work)=>{
  await writeJson(locator.outputDirectory,name+'-intent.private.json',{operation:name,tenant_id:f.tenant_id,body,dispatch:'ONE_ATTEMPT_UNKNOWN_UNTIL_ACK'});
  const result=await tx(c,f,a,work);await writeJson(locator.outputDirectory,name+'-ack.private.json',{operation:name,commit_ack:true,result});return result;
 };
 try{
  const {default:pg}=await import('pg');c=new pg.Client({connectionString:locator.databaseUrl,options:'-c timezone=UTC -c jit=off -c statement_timeout=8000 -c lock_timeout=8000',connectionTimeoutMillis:8000,query_timeout:9000});await c.connect();
  const ctx=(await c.query("SELECT current_database() db,current_user,session_user,host(inet_server_addr()) address,inet_server_port() port,current_setting('server_version_num')::int version,current_setting('TimeZone') timezone,current_setting('jit') jit,current_setting('statement_timeout') timeout,current_setting('lock_timeout') lock_timeout,current_setting('session_replication_role') replication,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) owner,(SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) marker")).rows[0];
  assert.equal(ctx.db,u.pathname.slice(1));assert.equal(ctx.current_user,'postgres');assert.equal(ctx.session_user,'postgres');assert.equal(ctx.address,'127.0.0.1');assert.equal(ctx.port,Number(u.port));assert(ctx.version>=180000&&ctx.version<190000);
  assert.equal(ctx.timezone,'UTC');assert.equal(ctx.jit,'off');assert.equal(ctx.timeout,'8s');assert.equal(ctx.lock_timeout,'8s');assert.equal(ctx.replication,'origin');assert.equal(ctx.owner,'postgres');assert.equal(ctx.marker,locator.ownershipMarker);
  assert.deepEqual(before.identity,{database:ctx.db,port:ctx.port,address:ctx.address,owner:ctx.owner,marker:ctx.marker});
  stage='source-compiled-metadata';
  assert.deepEqual(await value(c,'SELECT to_jsonb(m) value FROM public.return_credit211_metadata m WHERE id'),expected.metadata,'Complete compiled source metadata, not observed expectations');receipt.checks.compiled_metadata_equal=true;
  stage='full-guards-before';receipt.checks.guards_before=await guards(c);
  stage='historical206-seed';await verifyHistoricalSeed(c,before);receipt.checks.historical206_seed_count=before.receipts.length;
  const a=cases.native148,b=cases.historical169,aa=await authority(c,a),ba=await authority(c,b);
  const initialA=await facts(c,a.tenant_id),initialB=await facts(c,b.tenant_id);
  stage='native148-lineage-and-source';
  await tx(c,a,aa,async()=>{
   assert.equal((await c.query('SELECT count(*)::int n FROM public.catalog_stock_return_receipts WHERE(tenant_id,return_id)=($1,$2)',[a.tenant_id,a.return_id])).rows[0].n,0);
   assert.equal((await c.query('SELECT count(*)::int n FROM public.catalog_stock_return_admissions WHERE(tenant_id,return_id)=($1,$2)',[a.tenant_id,a.return_id])).rows[0].n,0);
   const history=await value(c,'SELECT public.return_credit211_history148($1) value',[a.physical_receipt_id]);
   const accepted=await value(c,'SELECT public.return_credit211_acceptance($1,$2) value',[a.order_id,a.return_id]);
   assert.equal(history.family,'destinations148');assert.equal(accepted.family,'destinations148');assert.equal(accepted.id,a.physical_receipt_id);
   const source=await value(c,'SELECT public.return_credit211_source($1,$2) value',[a.original_document_id,a.return_id]);
   assert.deepEqual(await value(c,'SELECT public.return_credit206_source($1,$2) value',[a.original_document_id,a.return_id]),source,'Existing206 route must use exactly the new source');
   const decision=await value(c,'SELECT public.return_credit206_calculate($1::jsonb) value',[JSON.stringify(source)]);
   assert.equal(decision.status,'credit_required');assert.equal(decision.calculation.totals.delta.gross_minor,'-2700');
   await assertRefusal(c,'private history ACL',()=>c.query('SET LOCAL ROLE dyna_app').then(()=>c.query('SELECT public.return_credit211_history148($1)',[a.physical_receipt_id])),'42501');
   await assertRefusal(c,'foreign native148',async()=>{await c.query("SELECT set_config('app.tenant_id',$1,true)",[b.tenant_id]);await c.query('SELECT public.return_credit211_history148($1)',[a.physical_receipt_id]);},'23514');
  });
  assert.deepEqual(await facts(c,a.tenant_id),initialA,'Read/negative controls cannot mutate old facts');
  receipt.checks.native148_source=true;
  stage='partial169-never-falls-back';
  await tx(c,b,ba,async()=>{
   assert.equal((await c.query("SELECT count(*)::int n FROM public.return_destination_admissions WHERE(tenant_id,order_id,return_id)=($1,$2,$3) AND after_snapshot IS NOT NULL AND payload->>'action'='receive' AND payload#>>'{snapshot,protocol}'='destinations_v1'",[b.tenant_id,b.order_id,b.return_id])).rows[0].n,1,'A real148 alternative must exist so partial169 cannot silently use it');
   const accepted=await value(c,'SELECT public.return_credit211_acceptance($1,$2) value',[b.order_id,b.return_id]);assert.equal(accepted.family,'catalog169');assert.equal(accepted.id,b.physical_receipt_id);
   for(const table of ['catalog_stock_return_receipts','catalog_stock_return_admissions'])await assertRefusal(c,`partial ${table}`,async()=>{
    await c.query("SET LOCAL session_replication_role='replica'");assert.equal((await c.query(`DELETE FROM public.${table} WHERE(tenant_id,id)=($1,$2)`,[b.tenant_id,b.physical_receipt_id])).rowCount,1);await c.query("SET LOCAL session_replication_role='origin'");
    await c.query('SELECT public.return_credit211_acceptance($1,$2)',[b.order_id,b.return_id]);
   },'23514',/211 partial or foreign169 cannot fall back to148/);
  });
  assert.deepEqual(await facts(c,b.tenant_id),initialB);receipt.checks.partial169_refusal=true;
  stage='native148-series-preview';
  const prefix='QA211-'+randomUUID().slice(0,5).toUpperCase();
  const sb={client_key:randomUUID(),name:'Native211 corrections',prefix};
  const series=await committedOperation('series',a,aa,sb,()=>asApp(c,'SELECT public.return_credit206_series_create($1::jsonb,$2,NULL) value',[JSON.stringify(sb),aa.actor_id]));assert.equal(series.reused,false);
  const version=(await c.query('SELECT version FROM public.return_cases WHERE(tenant_id,id)=($1,$2)',[a.tenant_id,a.return_id])).rows[0]?.version;assert(version!==undefined);
  const pb={client_key:randomUUID(),original_document_id:a.original_document_id,return_id:a.return_id,expected_return_version:String(version),series_id:series.id,expected_series_version:String(series.version),reason:'Zwrot części pozycji',ordinary_domestic_confirmed:true,local_only:true};
  const p=await committedOperation('preview',a,aa,pb,()=>asApp(c,'SELECT public.return_credit206_preview($1::jsonb,$2,NULL) value',[JSON.stringify(pb),aa.actor_id]));assert.equal(p.reused,false);assert.equal(p.snapshot.calculation.totals.delta.gross_minor,'-2700');
  const ib={client_key:randomUUID(),scope_hash:p.scope_hash,confirmed:true,local_only:true};
  stage='wrongtenant-issue-refuses';
  await assert.rejects(tx(c,b,ba,()=>asApp(c,'SELECT public.return_credit206_issue($1,$2::jsonb,$3,NULL) value',[p.id,JSON.stringify(ib),ba.actor_id])),e=>e.code==='P0002');assert.deepEqual(await facts(c,b.tenant_id),initialB);
  stage='actual-issue-COMMIT';
  const issued=await committedOperation('issue',a,aa,{preview_id:p.id,...ib},()=>asApp(c,'SELECT public.return_credit206_issue($1,$2::jsonb,$3,NULL) value',[p.id,JSON.stringify(ib),aa.actor_id]));
  assert.equal(issued.reused,false);assert(uuid(issued.document_id));assert.equal(issued.number,`${prefix}/${issued.year}/000001`);
  const committed=await facts(c,a.tenant_id);assert.deepEqual(physical(committed),physical(initialA),'Correction cannot alter stock, order, original documents or payments');
  const parent=await value(c,'SELECT to_jsonb(x) value FROM public.return_credit211_acceptances x WHERE(tenant_id,id)=($1,$2)',[a.tenant_id,a.physical_receipt_id]);
  assert.equal(parent.family,'destinations148');assert.equal(parent.destination_receipt_id,a.physical_receipt_id);assert.equal(parent.catalog_receipt_id,null);
  assert.equal((await c.query('SELECT count(*)::int n FROM public.return_credit206_receipts WHERE(tenant_id,id,document_id,return_receipt_id)=($1,$2,$3,$4)',[a.tenant_id,parent.credit_admission_id,issued.document_id,parent.id])).rows[0].n,1);
  receipt.checks.native148_issue_committed=true;
  stage='same-key-replay-COMMIT';
  const replay=await committedOperation('same-key-replay',a,aa,{preview_id:p.id,...ib},()=>asApp(c,'SELECT public.return_credit206_issue($1,$2::jsonb,$3,NULL) value',[p.id,JSON.stringify(ib),aa.actor_id]));assert.equal(replay.reused,true);assert.equal(replay.document_id,issued.document_id);assert.equal(replay.number,issued.number);assert.deepEqual(await facts(c,a.tenant_id),committed);
  await assert.rejects(tx(c,a,aa,()=>asApp(c,'SELECT public.return_credit206_issue($1,$2::jsonb,$3,NULL) value',[p.id,JSON.stringify({...ib,scope_hash:'f'.repeat(64)}),aa.actor_id])),e=>e.code==='23514');assert.deepEqual(await facts(c,a.tenant_id),committed);
  await tx(c,a,aa,async()=>{const graph=await value(c,'SELECT public.return_credit206_source($1,$2) value',[a.original_document_id,a.return_id]);assert.equal((await value(c,'SELECT public.return_credit206_calculate($1::jsonb) value',[JSON.stringify(graph)])).status,'already_credited');});
  assert.deepEqual(await facts(c,a.tenant_id),committed);assert.deepEqual(await facts(c,b.tenant_id),initialB);
  for(const [tenant,expected]of Object.entries(before.tenants))if(tenant!==a.tenant_id&&tenant!==b.tenant_id)assert.deepEqual(await facts(c,tenant),expected,'All other historical206 tenants must remain unchanged');
  receipt.checks.replay_no_new_number_document_refund_stock=true;
  const afterReceipts=await receiptRows(c);
  assert.equal(afterReceipts.length,before.receipts.length+1,'Exactly one new206 receipt');
  for(const old of before.receipts)assert.deepEqual(afterReceipts.filter(r=>r.tenant_id===old.tenant_id&&r.id===old.id),[old],'All global old206 receipt rows remain byte-value identical after issue/replay');
  stage='full-guards-after';receipt.checks.guards_after=await guards(c);receipt.status='ACTUAL_POSTGRES_BUSINESS_QA_PASS_NOT_FULL_PRODUCT_ACCEPTANCE';
 }catch(e){failure=e;receipt.status='FAILED_NO_REPLAY';receipt.failure={stage,code:typeof e.code==='string'?e.code:'ASSERTION_OR_RUNTIME',commit_outcome_unknown:e.qa211_commit_outcome_unknown===true,name:String(e.name??'Error').slice(0,128),message_sha256:sha(String(e.message??'')),message:String(e.message??'').slice(0,2048),stack:String(e.stack??'').slice(0,8192)};}
 finally{
  if(c){try{await c.query('ROLLBACK');receipt.rollback_ack=true;}catch{receipt.rollback_ack=false;failure??=new Error('Rollback unavailable');}
   try{await c.end();receipt.client_closed=true;}catch{receipt.client_closed=false;failure??=new Error('Client closure unavailable');}}
  if(failure&&receipt.status!=='FAILED_NO_REPLAY')receipt.status='FAILED_NO_REPLAY';
  await writeJson(locator.outputDirectory,'result.private.json',receipt);
 }
 if(failure)throw new Error('RETURN_CREDIT211_QA_FAILED_SEE_PRIVATE_RESULT');
 return receipt;
}

if(process.argv[1]&&path.resolve(process.argv[1])===HERE){
 const [flag,locatorFile,locatorSha,sourceSqlSha,runnerSha,...extra]=process.argv.slice(2);
 if(flag!=='--run'||!locatorFile||!hash(locatorSha)||!hash(sourceSqlSha)||!hash(runnerSha)||extra.length){process.stderr.write('Explicit --run LOCATOR LOCATOR_SHA SQL_SHA RUNNER_SHA required; nothing executed.\n');process.exitCode=2;}
 else runReturnCredit211Postgres({locatorFile,locatorSha,sourceSqlSha,runnerSha}).then(()=>process.stdout.write('RETURN_CREDIT211_QA_PASS_SEE_PRIVATE_RESULT\n')).catch(()=>{process.stderr.write('RETURN_CREDIT211_QA_FAILED_NO_REPLAY\n');process.exitCode=1;});
}
