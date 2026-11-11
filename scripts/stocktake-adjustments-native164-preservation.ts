/** ROOT ONLY; SOURCE AUTHORED. No migration, app import, login, worker or business API.
 * Invoke absolute WT file with cwd=<workspace>/app.
 * CLI before|after. Both require:
 * DYNA_LOCAL_CONFIG_PATH=<primary>/.local.json, DYNA_WORKER_DISABLED=true,
 * APP_REVISION=QA_EXPECTED_REVISION=<40hex>, QA164_CONFIG_SHA256=<64hex>,
 * QA164_PRESERVATION_CONFIRM=READ_ONLY_GLOBAL_148_TO_149_EXACT.
 * BEFORE runtime355811efcc756a6628670f091d2b67f91698c6a7/schema148.
 * AFTER additionally QA164_BEFORE_SHA256 and QA164_SQL_SHA256; runtime39baa...
 * Artifacts fixed data/docs stocktake-adjustments-native164-preservation-{phase}.json
 * exclusively0600, no overwrite/resume. This pins config; historical data files
 * are NOT captured here and need the separate root file-custody evidence.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { captureReturnDestinationRestoreMetadata } from './return-destinations-native162-restore-readback';

type Row = Record<string, any>;
type Rows = Record<string, {row: Row}[]>;
const ROOT='<workspace>/app';
const CONFIG=resolve(ROOT,'.local.json');
const BEFORE_REVISION='355811efcc756a6628670f091d2b67f91698c6a7';
const AFTER_REVISION='39baa5a6a7ebdeba00e7ca59e7669c0982bdb8ec';
const SQL_SHA='a4ec349804e0bddddbe595669b3a87f432a72cc9f1b19af2eb80aabf6b902264';
const CONFIG_SHA='9a2c81811d1ffdb6c52aabdd77dddf3ac1975bd8cc2c2d2957882b338dd7b660';
const newTables=['series','series_commands','counters','previews','preview_rows','admissions','receipts','documents','document_rows'].map(n=>'stocktake_adjustment_'+n);
const newFunctionNames=['hash','installed','access','lock','budget','totals','source','frame','create_series','preview','prepare','core_scope','finish','immutable','complete','counter_guard','insert_guard','admission_guard','source_seal','metadata','guards','manifest'].map(n=>'stocktake_adjustment_'+n);
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const identifier=(v:string)=>{assert.match(v,/^[a-z][a-z0-9_]*$/);return '"'+v+'"';};
let step='preflight';

async function exactMetadata(c: pg.Client) {
  const functions = (await c.query("SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p) meta,pg_get_functiondef(p.oid) definition FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN('f','p') ORDER BY p.oid")).rows;
  const triggers = (await c.query("SELECT t.oid,c.relname,to_jsonb(t) meta,pg_get_triggerdef(t.oid,false) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid")).rows;
  const tables = (await c.query(`SELECT c.oid,c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.attnum),'[]') FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0) columns,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.oid),'[]') FROM pg_policy p WHERE p.polrelid=c.oid) policies,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(x),'definition',pg_get_constraintdef(x.oid,false)) ORDER BY x.oid),'[]') FROM pg_constraint x WHERE x.conrelid=c.oid) constraints,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(i),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid),'[]') FROM pg_index i WHERE i.indrelid=c.oid) indexes
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.oid`)).rows;
  return { functions, triggers, tables };
}
/** Import-safe. Caller owns UTC RR READ ONLY; no configuration/transaction/CLI side effects.
 * Includes every public table and sessions. metadata is portable162 capture; exact_metadata
 * additionally retains real OID/catalog identities for same-database migration preservation.
 */
export async function captureStocktakeAdjustmentPreservation(c:pg.Client) {
  const context=(await c.query("SELECT current_setting('transaction_read_only') readonly,current_setting('TimeZone') zone,current_setting('transaction_isolation') isolation")).rows[0];
  assert.deepEqual(context,{readonly:'on',zone:'UTC',isolation:'repeatable read'});
  const rows:Rows={};
  for(const {tablename} of (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows)
    rows[tablename]=(await c.query(`SELECT to_jsonb(q) row FROM public.${identifier(tablename)} q ORDER BY 1`)).rows;
  const metadata=await captureReturnDestinationRestoreMetadata(c);
  const exact_metadata=await exactMetadata(c);
  const relations=(await c.query("SELECT oid,relname,relkind,relowner,relacl,relrowsecurity,relforcerowsecurity,CASE WHEN relkind IN('v','m') THEN pg_get_viewdef(oid,false) ELSE NULL END view_definition,(SELECT to_jsonb(s) FROM pg_sequence s WHERE s.seqrelid=pg_class.oid) sequence_definition FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid")).rows;
  return {rows,metadata,exact_metadata:{...exact_metadata,relations}};
}
export type StocktakeAdjustmentPreservationCapture=Awaited<ReturnType<typeof captureStocktakeAdjustmentPreservation>>;

function compareMigration(basis:StocktakeAdjustmentPreservationCapture,currentCapture:StocktakeAdjustmentPreservationCapture) {
  const before=basis.rows,now=currentCapture.rows,old=basis.exact_metadata,current=currentCapture.exact_metadata;
  assert.equal(Object.keys(before).length,455);assert.equal(Object.keys(now).length,464);
  assert.equal(before.migrations.length,148);assert.equal(now.migrations.length,149);
  assert.equal(now.migrations.filter(x=>x.row.name==='149_stocktake_adjustments').length,1);
  for (const [name, basis] of Object.entries(before)) assert.deepEqual(name === 'migrations' ? now[name].filter(x => x.row.name !== '149_stocktake_adjustments') : now[name], basis, 'All old global rows, including sessions: ' + name);
  assert.deepEqual(Object.keys(now).filter(name => !Object.hasOwn(before, name)).sort(), [...newTables].sort());
  for (const table of newTables) {
    assert.deepEqual(now[table], [], 'No document/history backfill: ' + table);
    const security = current.tables.find(x => x.relname === table); assert(security);
    assert.equal(security.relrowsecurity, true); assert.equal(security.relforcerowsecurity, true);
  }
  // No legacy function replacement is admitted silently. This explicit oracle
  // must be updated only after backend/root declares a necessary149 delta.
  for (const fn of old.functions) assert.deepEqual(current.functions.find(x => x.oid === fn.oid), fn, 'Old function body/OID/owner/ACL/config: ' + fn.signature);
  for (const trigger of old.triggers) assert.deepEqual(current.triggers.find(x => x.oid === trigger.oid), trigger, 'Old trigger OID/definition: ' + trigger.relname);
  const additions = current.triggers.filter(x => !old.triggers.some(b => b.oid === x.oid));
  const expectedTriggers: { table: string; name: string; function: string; type: number; deferred: boolean }[] = [
    { table: 'stocktake_adjustment_receipts', name: 'stocktake_adjustment_complete', function: 'stocktake_adjustment_complete()', type: 5, deferred: true },
    { table: 'stocktake_adjustment_admissions', name: 'stocktake_adjustment_admission_complete', function: 'stocktake_adjustment_complete()', type: 5, deferred: true },
    { table: 'stocktake_adjustment_counters', name: 'stocktake_adjustment_counter_guard', function: 'stocktake_adjustment_counter_guard()', type: 27, deferred: false },
    { table: 'stocktake_adjustment_admissions', name: 'stocktake_adjustment_admission_guard', function: 'stocktake_adjustment_admission_guard()', type: 27, deferred: false },
    ...['series', 'series_commands', 'previews', 'preview_rows', 'receipts', 'documents', 'document_rows'].map(n => ({ table: 'stocktake_adjustment_' + n, name: 'stocktake_adjustment_immutable', function: 'stocktake_adjustment_immutable()', type: 27, deferred: false })),
    ...['receipts', 'documents', 'document_rows'].map(n => ({ table: 'stocktake_adjustment_' + n, name: 'stocktake_adjustment_insert_guard', function: 'stocktake_adjustment_insert_guard()', type: 7, deferred: false })),
    ...['stocktakes', 'stocktake_lines', 'stock_location_movements', 'stock_movements', 'wms_stocktakes', 'wms_stocktake_lines', 'wms_stocktake_postings', 'wms_operations', 'wms_layer_movements'].map(n => ({ table: n, name: 'stocktake_adjustment_source_seal', function: 'stocktake_adjustment_source_seal()', type: 31, deferred: false })),
  ];
  const userAdditions = additions.filter(x => !x.meta.tgisinternal);
  assert.equal(expectedTriggers.length, 23); assert.equal(userAdditions.length, expectedTriggers.length);
  for (const expected of expectedTriggers) {
    const trigger = userAdditions.find(x => x.relname === expected.table && x.meta.tgname === expected.name); assert(trigger);
    assert.equal(trigger.meta.tgenabled, 'O'); assert.equal(trigger.meta.tgtype, expected.type);
    assert.equal(trigger.meta.tgdeferrable, expected.deferred); assert.equal(trigger.meta.tginitdeferred, expected.deferred);
    const fn = current.functions.find(x => String(x.oid) === String(trigger.meta.tgfoid)); assert(fn);
    assert.equal(fn.signature, expected.function);
    if (expected.deferred) {
      const table = current.tables.find(x => x.relname === expected.table); assert(table);
      const constraint = table.constraints.find((x: Row) => String(x.meta.oid) === String(trigger.meta.tgconstraint)); assert(constraint);
      assert.equal(constraint.meta.contype, 't'); assert.equal(constraint.meta.conname, expected.name);
      assert.equal(constraint.meta.condeferrable, true); assert.equal(constraint.meta.condeferred, true);
    } else assert.equal(String(trigger.meta.tgconstraint), '0');
  }
  // Every extra RI trigger must belong to an actual validated FK on a new
  // sidecar, including the parent-side RI triggers on legacy journal tables.
  // No new hidden constraint on a historical business table is admitted.
  const newForeignKeys = current.tables.filter(x => newTables.includes(x.relname)).flatMap(x => x.constraints).filter((x: Row) => x.meta.contype === 'f');
  const riAdditions = additions.filter(x => x.meta.tgisinternal);
  assert.equal(riAdditions.length, newForeignKeys.length * 4);
  for (const fk of newForeignKeys) {
    assert.equal(fk.meta.convalidated, true);
    const triggers = riAdditions.filter(x => String(x.meta.tgconstraint) === String(fk.meta.oid)); assert.equal(triggers.length, 4);
    assert.deepEqual(triggers.map(x => String(x.meta.tgrelid)).sort(), [fk.meta.conrelid, fk.meta.conrelid, fk.meta.confrelid, fk.meta.confrelid].map(String).sort());
  }
  for (const table of old.tables) {
    const after = current.tables.find(x => x.oid === table.oid); assert(after);
    const identity = table.relname === 'stock_movements' ? 'stocktake_adjustment_stock_identity' : table.relname === 'stock_location_movements' ? 'stocktake_adjustment_location_identity' : null;
    if (identity === null) assert.deepEqual(after, table, 'Old table columns/RLS/ACL/indexes/constraints: ' + table.relname);
    else {
      const constraints = after.constraints.filter((x: Row) => !table.constraints.some((old: Row) => old.meta.oid === x.meta.oid));
      const indexes = after.indexes.filter((x: Row) => !table.indexes.some((old: Row) => old.meta.indexrelid === x.meta.indexrelid));
      assert.equal(constraints.length, 1); assert.equal(indexes.length, 1);
      const con = constraints[0]; assert.equal(con.meta.conname, identity); assert.equal(con.meta.contype, 'u'); assert.equal(con.meta.convalidated, true); assert.equal(con.meta.condeferrable, false);
      assert.equal(String(con.meta.conrelid), String(table.oid)); assert.equal(String(con.meta.conindid), String(indexes[0].meta.indexrelid));
      const columns = con.meta.conkey.map((n: number) => table.columns.find((x: Row) => x.attnum === n)?.attname); assert.deepEqual(columns, ['tenant_id', 'id']);
      assert.equal(indexes[0].meta.indisunique, true); assert.equal(indexes[0].meta.indisvalid, true); assert.equal(indexes[0].meta.indisready, true);
      assert.deepEqual({ ...after, constraints: after.constraints.filter((x: Row) => x.meta.oid !== con.meta.oid), indexes: after.indexes.filter((x: Row) => x.meta.indexrelid !== indexes[0].meta.indexrelid) }, table, 'Only declared tenant journal identity UNIQUE/index may be added');
    }
  }

  const newFunctions=current.functions.filter(x=>!old.functions.some(b=>b.oid===x.oid));
  assert.deepEqual(newFunctions.map(x=>x.signature.split('(')[0]).sort(),[...newFunctionNames].sort());
  const oldRelations=old.relations;for(const relation of oldRelations)assert.deepEqual(current.relations.find(x=>x.oid===relation.oid),relation);
  const addedRelations=current.relations.filter(x=>!oldRelations.some(b=>b.oid===x.oid));
  const allowedIndexes=current.tables.flatMap(t=>t.indexes).filter((i:Row)=>!old.tables.some(t=>t.indexes.some((b:Row)=>b.meta.indexrelid===i.meta.indexrelid)));
  assert.equal(addedRelations.filter(x=>x.relkind==='r').length,9);
  for(const relation of addedRelations) {
    assert(relation.relkind==='r'&&newTables.includes(relation.relname)||relation.relkind==='i'&&allowedIndexes.some((i:Row)=>String(i.meta.indexrelid)===String(relation.oid)));
  }
  // The portable capture is retained for independently created restores.
  // On this same database the stronger exact metadata above governs all old objects.
}
async function directory(path:string) {
  const s=await lstat(path);assert(s.isDirectory()&&!s.isSymbolicLink());assert.equal(await realpath(path),path);
}
async function privateRead(path:string,max:number) {
  const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.mode&0o777,0o600);assert(s.size>0&&s.size<=max);
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stable=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs'] as const)assert.equal(n[k],s[k]);};
    stable(await f.stat());const bytes=await f.readFile();stable(await f.stat());stable(await lstat(path));return bytes;
  } finally {await f.close();}
}
async function absent(path:string) {
  try{await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  throw Error('Exclusive preservation artifact exists');
}
async function wx(path:string,value:unknown) {
  await directory(dirname(path));const bytes=JSON.stringify(value,null,2)+'\n';assert(Buffer.byteLength(bytes)<=512*1024*1024);
  const f=await open(path,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
  const d=await open(dirname(path),'r');try{await d.sync();}finally{await d.close();}return hash(bytes);
}
async function health(revision:string,schema:string,phase:string) {
  const r=await fetch('http://127.0.0.1:4100/api/health',{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
  assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());assert(bytes.length<65536);
  const h=JSON.parse(bytes.toString('utf8')) as Row;
  assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.restore_preview,false);
  assert.equal(h.background_workers_enabled,false);assert.equal(h.revision,revision);assert.equal(h.schema_revision,schema);
  if(phase==='after')assert.equal(h.stocktake_adjustments_available,true);
  else assert(h.stocktake_adjustments_available===undefined||h.stocktake_adjustments_available===false);
  return {revision:h.revision,schema_revision:h.schema_revision};
}
async function snapshot(c:pg.Client) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");
  try{
    const id=(await c.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port")).rows[0];
    assert.deepEqual(id,{db:'dynaminds',role:'postgres',owner:'postgres',host:'127.0.0.1',port:55432});
    const capture=await captureStocktakeAdjustmentPreservation(c);
    await c.query('COMMIT');return capture;
  }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}
}
async function main() {
  let c:pg.Client|undefined;
  const phase=process.argv[2],revision=process.env.QA_EXPECTED_REVISION??'';
  try{
    assert(['before','after'].includes(phase));assert.equal(await realpath(process.cwd()),ROOT);
    await directory(ROOT);await directory(resolve(ROOT,'data'));await directory(resolve(ROOT,'docs'));
    assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,CONFIG);assert.equal(process.env.DYNA_WORKER_DISABLED,'true');
    assert.equal(process.env.DATABASE_URL,undefined);assert.equal(process.env.DYNA_TEST,undefined);
    assert.equal(process.env.QA164_PRESERVATION_CONFIRM,'READ_ONLY_GLOBAL_148_TO_149_EXACT');
    assert.match(revision,/^[a-f0-9]{40}$/);assert.equal(process.env.APP_REVISION,revision);
    assert.equal(revision,phase==='before'?BEFORE_REVISION:AFTER_REVISION);
    assert.equal(process.env.QA164_CONFIG_SHA256,CONFIG_SHA);
    const schema=phase==='before'?'148_return_destinations':'149_stocktake_adjustments';
    const beforePath=resolve(ROOT,'data/stocktake-adjustments-native164-preservation-before.json');
    const output=resolve(ROOT,'data/stocktake-adjustments-native164-preservation-'+phase+'.json');
    const publicOutput=resolve(ROOT,'docs/stocktake-adjustments-native164-preservation-'+phase+'.json');
    await absent(output);await absent(publicOutput);
    const configBytes=await privateRead(CONFIG,65536);assert.equal(hash(configBytes),CONFIG_SHA);
    const config=JSON.parse(configBytes.toString('utf8')) as Row;assert.equal(typeof config.dbPassword,'string');assert(config.dbPassword);
    let basis:Row|undefined,sqlHash:string|null=null,sqlBytes:Buffer|undefined;
    if(phase==='after'){
      assert.match(process.env.QA164_BEFORE_SHA256??'',/^[a-f0-9]{64}$/);
      const beforeBytes=await privateRead(beforePath,512*1024*1024);assert.equal(hash(beforeBytes),process.env.QA164_BEFORE_SHA256);
      basis=JSON.parse(beforeBytes.toString('utf8'));assert.equal(basis!.stage,164);assert.equal(basis!.phase,'before');assert.equal(basis!.status,'READ_ONLY_BASELINE_CAPTURED');
      assert.equal(basis!.revision,BEFORE_REVISION);assert.equal(basis!.schema_revision,'148_return_destinations');assert.equal(basis!.config_sha256,CONFIG_SHA);
      assert.equal(process.env.QA164_SQL_SHA256,SQL_SHA);
      sqlBytes=await privateSource(resolve(ROOT,'server/149_stocktake_adjustments.sql'));sqlHash=hash(sqlBytes);assert.equal(sqlHash,SQL_SHA);
    }
    step='health-before';await health(revision,schema,phase);
    c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:config.dbPassword,database:'dynaminds',connectionTimeoutMillis:5000,
      options:'-c default_transaction_read_only=on -c TimeZone=UTC'});
    c.on('error',()=>{ /* Never emit client/credentials/raw error. */ });await c.connect();
    step='capture';const capture=await snapshot(c);
    assert.equal(capture.rows.migrations.map(x=>x.row.name as string).sort().at(-1),schema);
    if(phase==='before'){
      assert.equal(Object.keys(capture.rows).length,455);assert.equal(capture.rows.migrations.length,148);
      assert(newTables.every(n=>!Object.hasOwn(capture.rows,n)));
      assert(!capture.exact_metadata.functions.some(f=>f.signature.startsWith('stocktake_adjustment_')));
      assert(!capture.exact_metadata.triggers.some(t=>t.meta.tgname.startsWith('stocktake_adjustment_')));
      assert(!capture.rows.migrations.some(x=>x.row.name==='149_stocktake_adjustments'));
    }else{
      step='compare';compareMigration(basis!.capture,capture);
      const g=(await c.query('SELECT public.stocktake_adjustment_installed() installed,public.stocktake_adjustment_guards() guards')).rows[0];
      assert.deepEqual(g,{installed:true,guards:true});
      assert.equal(hash(await privateRead(beforePath,512*1024*1024)),process.env.QA164_BEFORE_SHA256);
      assert.equal(hash(await privateSource(resolve(ROOT,'server/149_stocktake_adjustments.sql'))),sqlHash);
    }
    step='final-purity';await health(revision,schema,phase);assert.equal(hash(await privateRead(CONFIG,65536)),CONFIG_SHA);
    assert.deepEqual(await snapshot(c),capture);
    const artifact={stage:164,phase,status:phase==='before'?'READ_ONLY_BASELINE_CAPTURED':'EXACT_ADDITIVE_MIGRATION_VERIFIED',
      revision,schema_revision:schema,config_sha256:CONFIG_SHA,before_sha256:phase==='after'?process.env.QA164_BEFORE_SHA256:null,
      source_sql_sha256:sqlHash,capture,sessions_included:true,historical_files_verified:false};
    step='exclusive-output';const privateSha=await wx(output,artifact);
    const report={stage:164,phase,status:'PASS',claim:phase==='before'?'READ_ONLY_148_BASELINE':'EXACT_ADDITIVE_148_TO_149',
      revision,schema_revision:schema,config_sha256:CONFIG_SHA,before_sha256:artifact.before_sha256,source_sql_sha256:sqlHash,
      private_sha256:privateSha,global_tables:Object.keys(capture.rows).length,compared_old_tables:phase==='after'?455:0,
      sessions_included:true,new_empty_tables:phase==='after'?9:0,new_old_journal_unique_constraints:phase==='after'?2:0,
      new_user_triggers:phase==='after'?23:0,new_old_source_seals:phase==='after'?9:0,
      old_function_bodies_changed:0,historical_data_files:'NOT_CAPTURED_SEPARATE_ROOT_CUSTODY_REQUIRED',
      business_api_writes:0,providers:0,native_business:'NOT_PERFORMED',restore:'NOT_PERFORMED'};
    await wx(publicOutput,report);console.log(JSON.stringify(report));
  }catch(e){
    const frame=e instanceof Error?e.stack?.match(/stocktake-adjustments-native164-preservation\.ts:(\d+):(\d+)/):undefined;
    console.log(JSON.stringify({stage:164,phase:['before','after'].includes(phase??'')?phase:'invalid',status:'FAIL',step,
      code:(e as {code?:string}).code==='ERR_ASSERTION'?'ERR_ASSERTION':'PRESERVATION_FAILURE',
      source_line:frame?Number(frame[1]):null,source_column:frame?Number(frame[2]):null}));
    process.exitCode=1;
  }finally{await c?.end().catch(()=>undefined);}
}
async function privateSource(path:string) {
  const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink());assert(s.size>0&&s.size<1024*1024);
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stable=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs'] as const)assert.equal(n[k],s[k]);};
    stable(await f.stat());const b=await f.readFile();stable(await f.stat());stable(await lstat(path));return b;
  }finally{await f.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
