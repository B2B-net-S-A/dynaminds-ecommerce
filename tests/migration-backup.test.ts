import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,existsSync,readdirSync,chmodSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {backupBeforeMigrating,migrationBackupSettings,installedReleaseDirectory,MigrationBackupError,type MigrationBackupCreate} from '../server/migration-backup';

const settings={mode:'required' as const,directory:'/backups/pre',keyFile:'/data/.recovery-key'};
const report={id:'b1',file:'/backups/pre/b1.dyna',sha256:'a'.repeat(64),bytes:10,source:'dynaminds'},target={database:'dynaminds',port:55432};
const recorder=(result:()=>Promise<typeof report>)=>{const calls:unknown[]=[];const create:MigrationBackupCreate=async(o,t)=>{assert.deepEqual(t,target);calls.push(o);return result();};return {calls,create};};

test('settings: required by default, off under DYNA_TEST, explicit absolute values, data directory default',()=>{
 const none=undefined;
 assert.equal(migrationBackupSettings({DYNA_TEST:'true'},none).mode,'off');
 assert.equal(migrationBackupSettings({DYNA_TEST:'true',DYNA_MIGRATION_BACKUP:'required'},none).mode,'required');
 assert.deepEqual(migrationBackupSettings({DYNA_MIGRATION_BACKUP_DIR:'/x/y',DYNA_MIGRATION_BACKUP_KEY_FILE:'/k'},none),{mode:'required',directory:'/x/y',keyFile:'/k'});
 // The data directory is DYNA_DATA_DIR, else the directory of the selected local configuration (never cwd).
 assert.deepEqual(migrationBackupSettings({DYNA_LOCAL_CONFIG_PATH:'/private/inst/local-config.json'},none),{mode:'required',directory:'/private/inst/backups/pre-migration',keyFile:'/private/inst/.recovery-key'});
 assert.deepEqual(migrationBackupSettings({DYNA_DATA_DIR:'/srv/dyna',DYNA_LOCAL_CONFIG_PATH:'/private/inst/local-config.json'},none),{mode:'required',directory:'/srv/dyna/backups/pre-migration',keyFile:'/srv/dyna/.recovery-key'});
 assert.deepEqual(migrationBackupSettings({DYNA_DATA_DIR:'/srv/dyna',DYNA_MIGRATION_BACKUP_DIR:'/b'},none),{mode:'required',directory:'/b',keyFile:'/srv/dyna/.recovery-key'});
 for(const bad of ['yes','true','']) assert.throws(()=>migrationBackupSettings({DYNA_MIGRATION_BACKUP:bad},none),/required lub off/);
 assert.throws(()=>migrationBackupSettings({DYNA_MIGRATION_BACKUP_DIR:' '},none),/nie może być pusty/);
 for(const name of ['DYNA_DATA_DIR','DYNA_MIGRATION_BACKUP_DIR','DYNA_MIGRATION_BACKUP_KEY_FILE'])
  assert.throws(()=>migrationBackupSettings({[name]:'data/x'},none),new RegExp(name+' wymaga ścieżki bezwzględnej'));
});
test('no configured location, or one inside the release package, is refused before anything is written',async()=>{
 const unconfigured=migrationBackupSettings({},undefined);
 assert.equal(unconfigured.mode,'required');assert.equal(unconfigured.directory,undefined);assert.match(unconfigured.unavailable!,/DYNA_DATA_DIR/);
 const release='/rel/release-canonical';
 for(const env of [{DYNA_LOCAL_CONFIG_PATH:release+'/local-config.json'},{DYNA_DATA_DIR:release},{DYNA_DATA_DIR:'/ok',DYNA_MIGRATION_BACKUP_KEY_FILE:release+'/.recovery-key'},{DYNA_DATA_DIR:'/ok',DYNA_MIGRATION_BACKUP_DIR:release+'/data/backups'}])
  assert.match(migrationBackupSettings(env,release).unavailable!,/katalogu wydania/);
 assert.deepEqual(migrationBackupSettings({DYNA_DATA_DIR:'/rel/release-canonical-data'},release),{mode:'required',directory:'/rel/release-canonical-data/backups/pre-migration',keyFile:'/rel/release-canonical-data/.recovery-key'});
 for(const s of [unconfigured,migrationBackupSettings({DYNA_DATA_DIR:release},release)]){
  const r=recorder(async()=>report);
  await assert.rejects(()=>backupBeforeMigrating({target,applied:217,pending:['218_a'],settings:s,create:r.create}),(e:any)=>{
   assert(e instanceof MigrationBackupError);assert.match(e.message,/Przyczyna: Kopia przed migracją/);assert.match(e.message,/Nic nie zostało zapisane/);return true;});
  assert.equal(r.calls.length,0);
 }
 // Off needs no location.
 assert.equal(await backupBeforeMigrating({target,applied:217,pending:['218_a'],settings:{...unconfigured,mode:'off'},create:recorder(async()=>report).create}),undefined);
});
test('the release package directory is found from the running module (release.json + runtime/)',(t)=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mig3-rel-'))),rel=join(root,'release-canonical');t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(rel,'runtime','chunks'),{recursive:true});writeFileSync(join(rel,'release.json'),'{}');writeFileSync(join(rel,'runtime','chunks','c.mjs'),'');
 assert.equal(installedReleaseDirectory(pathToFileURL(join(rel,'runtime','chunks','c.mjs')).href),rel);
 assert.equal(installedReleaseDirectory(new URL('../server/migration-backup.ts',import.meta.url).href),undefined);
});
test('a failed backup target leaves no directory or key it created; existing ones stay',async(t)=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mig3-target-')));chmodSync(root,0o700);t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config=join(root,'cfg.json');writeFileSync(config,JSON.stringify({dbPassword:'x',encryptionKey:'a'.repeat(64)}),{mode:0o600});
 process.env.DYNA_LOCAL_CONFIG_PATH=config;
 const {prepareBackupTarget}=await import('../server/recovery');
 const data=join(root,'data'),dir=join(data,'backups','pre-migration'),key=join(data,'.recovery-key');
 const created=await prepareBackupTarget(dir,key);assert.equal(created.key.length,32);assert(existsSync(key));
 await created.discard();assert.equal(existsSync(data),false,'new data directory and key removed');
 mkdirSync(data,{mode:0o700});writeFileSync(key,'b'.repeat(64)+'\n',{mode:0o600});
 const kept=await prepareBackupTarget(dir,key);assert.equal(kept.key.toString('hex'),'b'.repeat(64));await kept.discard();
 assert.deepEqual(readdirSync(data),['.recovery-key'],'existing key stays, created backups directory goes');
 // A precondition failure inside the call (shared directory) leaves nothing behind either.
 const shared=join(root,'shared');mkdirSync(shared,{mode:0o755});
 await assert.rejects(()=>prepareBackupTarget(shared,join(root,'k2')),/prywatny/);assert.equal(existsSync(join(root,'k2')),false);
});
test('pending migrations on an existing history take one backup into the configured directory first',async()=>{
 const r=recorder(async()=>report);
 const receipt=await backupBeforeMigrating({target,applied:217,pending:['218_a','219_b'],settings,create:r.create});
 assert.deepEqual(r.calls,[{directory:'/backups/pre',keyFile:'/data/.recovery-key'}]);assert.deepEqual(receipt,{...report,pending:['218_a','219_b']});
 const k=recorder(async()=>report);await backupBeforeMigrating({target,applied:1,pending:['2_x'],settings:{...settings,keyFile:'/k'},create:k.create});assert.deepEqual(k.calls,[{directory:'/backups/pre',keyFile:'/k'}]);
});
test('no pending migration, a first install or an explicit off takes no backup',async()=>{
 for(const input of [{applied:223,pending:[] as string[],settings},{applied:0,pending:['001_foundation'],settings},{applied:5,pending:['6_x'],settings:{...settings,mode:'off' as const}}]){
  const r=recorder(async()=>report);assert.equal(await backupBeforeMigrating({...input,target,create:r.create}),undefined);assert.equal(r.calls.length,0);
 }
});
test('a failed or foreign backup refuses migration with a Polish error naming the pending migrations',async()=>{
 const cause=new Error('Brak lub nieprawidłowe zdjęcie w kopii');
 await assert.rejects(()=>backupBeforeMigrating({target,applied:3,pending:['234_x'],settings,create:recorder(async()=>{throw cause;}).create}),(e:any)=>{
  assert(e instanceof MigrationBackupError);assert.equal(e.code,'MIGRATION_BACKUP_FAILED');assert.equal(e.cause,cause);assert.deepEqual(e.pending,['234_x']);
  assert.match(e.message,/^Nie udało się wykonać kopii bazy przed migracją, więc migracje \(234_x\) nie zostały wykonane\..*Przyczyna: Brak lub nieprawidłowe zdjęcie w kopii$/);return true;});
 for(const bad of [{...report,file:'/elsewhere/b1.dyna'},{...report,file:'/backups/prefix-b1.dyna'},{...report,sha256:'x'},{...report,bytes:0},{...report,source:'other'}])
  await assert.rejects(()=>backupBeforeMigrating({target,applied:3,pending:['234_x'],settings,create:recorder(async()=>bad).create}),MigrationBackupError);
});
test('migrate() takes the backup after the ledger check and before the first pending migration, under the lock',()=>{
 const source=readFileSync(new URL('../server/db.ts',import.meta.url),'utf8');
 assert.match(source,/const backupSettings = migrationBackupSettings\(\), target = new URL\(databaseUrl\);/);
 assert.match(source,/await assertLedgerKnownToRelease\(c, program\.map\(\(\[name\]\) => name\)\);\s*(?:\/\/[^\n]*\n\s*)*await assertMigrationChecksums\(c, checksumFiles\);\s*(?:\/\/[^\n]*\n\s*)*const applied = new Set\(\(await c\.query\('SELECT name FROM migrations'\)\)\.rows\.map\(\(r\) => r\.name as string\)\);\s*lastBackup = await backupBeforeMigrating\(\{ applied: applied\.size, pending: program\.map\(\(\[name\]\) => name\)\.filter\(\(name\) => !applied\.has\(name\)\), settings: backupSettings, target: \{ database: target\.pathname\.slice\(1\), port: Number\(target\.port \|\| 5432\) \} \}\);\s*for \(const \[name, file\] of program\) \{/);
});
