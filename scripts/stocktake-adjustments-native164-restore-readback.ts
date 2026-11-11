/** ROOT ONLY / SOURCE ONLY. Existing independently restored149 copy, before login.
 * No backup/restore, migration, worker, auth or business mutations. Fixed health GET
 * and owner RR READ ONLY. Native after-post checkpoint is immutable; no rebase.
 * See docs/STOCKTAKE-ADJUSTMENT-DOCUMENTS-RESTORE164.md for exact input pins.
 */
import assert from 'node:assert/strict';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { captureStocktakeAdjustmentReadback, validateStocktakeAdjustmentReceipt } from './stocktake-adjustments-native164-readback';

type Row = Record<string, any>;
const ROOT = '<workspace>/app';
const SCHEMA = '149_stocktake_adjustments';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const shaRE = /^[a-f0-9]{64}$/;
const revisionRE = /^[a-f0-9]{40}$/;
const uuidRE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function directory(path: string) {
  const s = await lstat(path); assert(s.isDirectory() && !s.isSymbolicLink());
  assert.equal(await realpath(path), path);
}
async function bytes(path: string, max = 512 * 1024 * 1024) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink());
  assert.equal(s.mode & 0o777, 0o600); assert(s.size > 0 && s.size <= max);
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stable = (n: typeof s) => { for (const k of ['dev','ino','mode','size','mtimeMs'] as const) assert.equal(n[k], s[k]); };
    stable(await f.stat()); const b = await f.readFile(); stable(await f.stat()); stable(await lstat(path)); return b;
  } finally { await f.close(); }
}
async function fileHash(path: string) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink());
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stable = (n: typeof s) => { for (const k of ['dev','ino','mode','size','mtimeMs'] as const) assert.equal(n[k], s[k]); };
    stable(await f.stat()); const h = createHash('sha256'); let size = 0;
    for await (const b of createReadStream(path, { fd: f.fd, autoClose: false })) { h.update(b); size += b.length; }
    stable(await f.stat()); stable(await lstat(path)); assert.equal(size, s.size);
    return { sha256: h.digest('hex'), size, mode: s.mode & 0o777 };
  } finally { await f.close(); }
}
async function absent(path: string) {
  try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Exclusive proof already exists');
}
async function wx(path: string, value: unknown, mode: number) {
  await directory(dirname(path)); const b = JSON.stringify(value, null, 2) + '\n';
  assert(Buffer.byteLength(b) <= 512 * 1024 * 1024);
  const f = await open(path, 'wx', mode); try { await f.writeFile(b); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(path), 'r'); try { await d.sync(); } finally { await d.close(); } return sha(b);
}
async function main() {
  let step = 'preflight', c: pg.Client | undefined;
  const output = resolve(ROOT, 'data/stocktake-adjustments-native164-restore-readback.json');
  const publicOutput = resolve(ROOT, 'docs/stocktake-adjustments-native164-restore-readback.json');
  const pins = new Map<string, string>();
  const streamPins = new Map<string, Awaited<ReturnType<typeof fileHash>>>();
  try {
    assert.equal(await realpath(process.cwd()), ROOT);
    assert.equal(process.env.DYNA_TEST, undefined); assert.equal(process.env.DATABASE_URL, undefined);
    assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert.equal(process.env.DYNA_PREVIEW_PORT, '4198');
    assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(ROOT, '.local.json'));
    assert.equal(process.env.QA164_RESTORE_CONFIRM, 'READ_ONLY_ACCEPTED_149_COPY_BEFORE_LOGIN');
    const revision = process.env.QA_EXPECTED_REVISION ?? '', archiveRevision = process.env.QA164_ARCHIVE_REVISION ?? '';
    assert.match(revision, revisionRE); assert.match(archiveRevision, revisionRE); assert.equal(process.env.APP_REVISION, revision);
    await directory(ROOT); await directory(resolve(ROOT, 'data')); await directory(resolve(ROOT, 'docs'));
    await absent(output); await absent(publicOutput); await absent(output + '.intent.json');
    async function pin(path: string, expected: string | undefined, max?: number) {
      assert.match(expected ?? '', shaRE); const b = await bytes(path, max); assert.equal(sha(b), expected);
      pins.set(path, expected!); return JSON.parse(b.toString('utf8')) as Row;
    }
    const config = await pin(resolve(ROOT, '.local.json'), process.env.QA164_CONFIG_SHA256, 65536);
    assert.match(config.encryptionKey, shaRE);
    const setup = await pin(resolve(ROOT, 'data/stocktake-adjustments-native164-setup.json'), process.env.QA164_SETUP_SHA256);
    assert.equal(setup.stage, 164); assert.equal(setup.schema, SCHEMA); assert.equal(setup.pending, null);
    assert.equal(setup.status, 'READY_FOR_NATIVE_CHROME_NOT_POSTED'); assert.equal(setup.runtime_revision, archiveRevision);
    assert.equal(setup.actors.length, 2);
    const accepted = await pin(resolve(ROOT, 'data/stocktake-adjustments-native164-readback-after-post.json'), process.env.QA164_ACCEPTED_SHA256);
    assert.equal(accepted.stage, 164); assert.equal(accepted.mode, 'after-post'); assert.equal(accepted.schema, SCHEMA);
    assert.equal(accepted.status, 'STOCKTAKE_ADJUSTMENTS_NATIVE_READBACK_PASS'); assert.equal(accepted.runtime_revision, archiveRevision);
    assert.equal(accepted.config_sha256, process.env.QA164_CONFIG_SHA256); assert.equal(accepted.setup_sha256, process.env.QA164_SETUP_SHA256);
    const before = await pin(resolve(ROOT, 'data/stocktake-adjustments-native164-readback-capture-before-post.json'), process.env.QA164_BEFORE_SHA256);
    assert.equal(accepted.before_sha256, process.env.QA164_BEFORE_SHA256);
    assert.equal(before.stage, 164); assert.equal(before.mode, 'capture-before-post'); assert.equal(before.schema, SCHEMA);
    assert.equal(before.status, 'READ_ONLY_BASELINE_CAPTURED'); assert.equal(before.runtime_revision, archiveRevision);
    assert.equal(before.config_sha256, process.env.QA164_CONFIG_SHA256); assert.equal(before.setup_sha256, process.env.QA164_SETUP_SHA256);
    assert(accepted.capture?.rows?.sessions && accepted.capture.portable_metadata);
    assert.equal(Object.keys(accepted.capture.rows).length, 464);
    assert.deepEqual(accepted.actors, setup.actors);
    assert.deepEqual(before.actors,setup.actors); assert.deepEqual(setup.actors.map((a:Row)=>[a.label,a.on]),[['OFF',false],['ON',true]]);
    for (const key of ['off','on']) assert.match(accepted.receipt_ids[key], uuidRE);
    assert.notEqual(accepted.receipt_ids.off, accepted.receipt_ids.on);
    assert.notEqual(setup.actors[0].tenant_id, setup.actors[1].tenant_id);
    const sqlPath = resolve(ROOT, 'server/149_stocktake_adjustments.sql');
    assert.match(process.env.QA164_SQL_SHA256 ?? '', shaRE);
    const sql = await fileHash(sqlPath); assert.equal(sql.sha256, process.env.QA164_SQL_SHA256); streamPins.set(sqlPath, sql);
    const resultPath = process.env.QA164_RESTORE_RESULT_PATH ?? '';
    const match = /^\/Users\/arturtwardowski\/DYNA Ecomerce\/app\/data\/(stocktake-adjustments-backup164-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/restore\/([a-f0-9]{16})\/result\.json$/.exec(resultPath);
    assert(match); const base = resolve(ROOT, 'data', match[1]);
    for (const p of [base, resolve(base,'restore'), dirname(resultPath), resolve(base,'backup')]) await directory(p);
    const result = await pin(resultPath, process.env.QA164_RESTORE_RESULT_SHA256, 65536);
    const database = 'dynaminds_restore_' + match[2];
    assert.equal(result.id, match[2]); assert.equal(result.database, database); assert.equal(result.directory, dirname(resultPath));
    assert.equal(result.config, resolve(result.directory,'local-config.json')); assert.equal(result.images, resolve(result.directory,'images'));
    assert.equal(result.source, 'dynaminds'); assert.equal(result.status,'verified'); assert.equal(result.preview_only,true);
    assert.equal(result.worker_enabled,false); assert.equal(result.row_fingerprints_match,true); assert.equal(result.schema_fingerprint_match,true);
    assert.equal(result.tables,464); assert.equal(result.revision,archiveRevision);
    const archivePath = process.env.QA164_ARCHIVE_PATH ?? '';
    assert.equal(dirname(archivePath), resolve(base,'backup')); assert.match(archivePath.slice(archivePath.lastIndexOf('/')+1), /^[a-z0-9]+-[a-f0-9]{16}\.dyna$/);
    const archive = await fileHash(archivePath); assert.equal(archive.mode,0o600); assert.match(process.env.QA164_ARCHIVE_SHA256 ?? '',shaRE);
    assert.equal(archive.sha256,process.env.QA164_ARCHIVE_SHA256); streamPins.set(archivePath,archive);
    const restoredConfigBytes = await bytes(result.config,65536); pins.set(result.config,sha(restoredConfigBytes));
    const restoredConfig = JSON.parse(restoredConfigBytes.toString('utf8'));
    assert.deepEqual(Object.keys(restoredConfig).sort(),['dbPassword','encryptionKey']); assert.equal(restoredConfig.encryptionKey,config.encryptionKey);
    assert(typeof restoredConfig.dbPassword==='string' && restoredConfig.dbPassword);
    const manifestPath = resolve(result.directory,'manifest.json'), manifestBytes = await bytes(manifestPath,67108864);
    pins.set(manifestPath,sha(manifestBytes)); const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.database,'dynaminds'); assert.equal(manifest.revision,archiveRevision); assert.equal(manifest.schema_fingerprint_version,4);
    // Backup hashes configSchema's compact whitelist, not original .local.json bytes.
    assert.equal(manifest.config_sha256,sha(JSON.stringify({dbPassword:config.dbPassword,encryptionKey:config.encryptionKey})));
    assert.equal(Object.keys(manifest.tables).length,464);
    const dumpPath = resolve(result.directory,'database.dump'), dump = await fileHash(dumpPath);
    assert.equal(dump.sha256,manifest.dump.sha256); assert.equal(dump.size,manifest.dump.size); streamPins.set(dumpPath,dump);
    assert(Array.isArray(manifest.images)); assert.equal(result.image_count,manifest.images.length); await directory(result.images);
    assert.equal(new Set(manifest.images.map((i:Row)=>i.id)).size,manifest.images.length);
    for (const i of manifest.images) { assert.match(i.id,uuidRE); const p=resolve(result.images,i.id), f=await fileHash(p); assert.equal(f.sha256,i.sha256); assert.equal(f.size,i.size); streamPins.set(p,f); }
    async function custody() { for (const [p,h] of pins) assert.equal(sha(await bytes(p)),h); for (const [p,h] of streamPins) assert.deepEqual(await fileHash(p),h); }
    async function health() {
      const r=await fetch('http://127.0.0.1:4198/api/health',{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
      assert.equal(r.status,200); const b=Buffer.from(await r.arrayBuffer()); assert(b.length<65536); const h=JSON.parse(b.toString('utf8'));
      assert.equal(h.status,'ok'); assert.equal(h.mode,'local'); assert.equal(h.revision,revision); assert.equal(h.schema_revision,SCHEMA);
      assert.equal(h.restore_preview,true); assert.equal(h.background_workers_enabled,false); assert.equal(h.stocktake_adjustments_available,true);
    }
    await custody(); await health();
    await wx(output+'.intent.json',{stage:164,action:'READ_ONLY_RESTORE_COMPARISON',accepted_sha256:process.env.QA164_ACCEPTED_SHA256,
      restore_result_sha256:process.env.QA164_RESTORE_RESULT_SHA256,archive_sha256:archive.sha256,runtime_revision:revision,archive_revision:archiveRevision},0o600);
    step='copy-read-only'; c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:restoredConfig.dbPassword,database,
      connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c TimeZone=UTC'});
    c.on('error',()=>{}); await c.connect(); await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    let captured: Awaited<ReturnType<typeof captureStocktakeAdjustmentReadback>>, proof: Row={};
    try {
      assert.deepEqual((await c.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0],
        {db:database,role:'postgres',owner:'postgres',host:'127.0.0.1',port:55432,readonly:'on'});
      captured=await captureStocktakeAdjustmentReadback(c);
      assert.equal(Object.keys(captured.rows).length,464); assert.deepEqual(captured.rows,accepted.capture.rows,'All global rows including sessions before copy login');
      assert.deepEqual(captured.fingerprints,accepted.capture.fingerprints); assert.deepEqual(captured.proof_hashes,accepted.capture.proof_hashes);
      assert.deepEqual(captured.portable_metadata,accepted.capture.portable_metadata);
      assert.equal((await c.query('SELECT public.stocktake_adjustment_installed() AND public.stocktake_adjustment_guards() ok')).rows[0].ok,true);
      for (const a of setup.actors) { const key=a.on?'on':'off'; proof[key]=validateStocktakeAdjustmentReceipt(captured,a,accepted.receipt_ids[key]); }
      assert.deepEqual(proof,accepted.proof); await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    await health(); await custody();
    const privateSha=await wx(output,{stage:164,status:'STOCKTAKE_ADJUSTMENTS_RESTORE_READBACK_PASS',schema:SCHEMA,runtime_revision:revision,archive_revision:archiveRevision,
      config_sha256:process.env.QA164_CONFIG_SHA256,setup_sha256:process.env.QA164_SETUP_SHA256,before_sha256:process.env.QA164_BEFORE_SHA256,
      accepted_sha256:process.env.QA164_ACCEPTED_SHA256,archive_sha256:archive.sha256,restore_result_sha256:process.env.QA164_RESTORE_RESULT_SHA256,
      database,capture:captured,proof},0o600);
    const report={stage:164,status:'STOCKTAKE_ADJUSTMENTS_RESTORE_READBACK_PASS',schema:SCHEMA,runtime_revision:revision,archive_revision:archiveRevision,
      tables:464,all_rows_including_sessions_exact:true,portable_metadata_exact:true,manifest149_guard:true,receipt_graph_and_counters_exact:true,
      image_count:manifest.images.length,archive_sha256:archive.sha256,accepted_sha256:process.env.QA164_ACCEPTED_SHA256,private_sha256:privateSha,
      copy_business_writes:0,copy_logins:0,provider_calls:0,chrome_verified:false,malformed_write_guards_verified:false};
    await wx(publicOutput,report,0o644); console.log(JSON.stringify(report));
  } catch (error) { console.error(JSON.stringify({stage:164,status:'FAIL',step,error_kind:error instanceof Error?error.name:'Error',
      source_line:error instanceof Error?Number(error.stack?.match(/stocktake-adjustments-native164-restore-readback\.ts:(\d+):/)?.[1]??0):0,
      automatic_resume:false})); process.exitCode=1; }
  finally { await c?.end().catch(()=>undefined); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) void main();
