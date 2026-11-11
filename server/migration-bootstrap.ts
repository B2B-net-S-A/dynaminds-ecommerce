import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Client} from 'pg';

/** Called under migrate's exclusive advisory lock, before its normal history scan.
 * Even CREATE TABLE IF NOT EXISTS fires ddl_command_start. Avoid that no-op DDL:
 * it invalidates the approved schema generation of an already-running process.
 * Every startup still performs the complete independent catalogue validation.
 */
export async function ensureMigrationRegistry(client:Pick<Client,'query'>){
 const existing=await client.query(`SELECT c.relkind AS kind,c.relpersistence AS persistence,
  pg_catalog.pg_get_userbyid(c.relowner) AS owner
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='migrations'`);
 assert(existing.rows.length<=1,'migration-registry-identity');
 if(existing.rows.length){
  assert.deepEqual(existing.rows[0],{kind:'r',persistence:'p',owner:'postgres'},'migration-registry-identity');
  return;
 }
 await client.query('CREATE TABLE IF NOT EXISTS public.migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
}

/** MIG-6: release N refuses a database already migrated by a newer release. Every ledger row must be a
 * migration this release knows; otherwise nothing is applied (the caller rolls the whole series back). */
export class NewerDatabaseError extends Error {
 readonly code='MIGRATION_LEDGER_NEWER_THAN_RELEASE';
 constructor(readonly unknown:readonly string[]){
  super('Ta wersja aplikacji nie uruchomi bazy danych zmigrowanej przez nowszą wersję. Migracje nieznane tej wersji: '+unknown.join(', ')+
   '. Uruchom wersję, która je zna, albo odtwórz kopię bazy sprzed migracji (docs/parity/MIGRATIONS-S1-20261026.md).');
  this.name='NewerDatabaseError';
 }
}
export async function assertLedgerKnownToRelease(client:Pick<Client,'query'>,known:Iterable<string>){
 const names=new Set(known);assert(names.size>0,'migration-release-list-required');
 const rows=(await client.query('SELECT name FROM public.migrations ORDER BY name')).rows as {name:unknown}[];
 const unknown=rows.map(r=>r.name).filter(n=>typeof n!=='string'||!names.has(n)).map(String);
 if(unknown.length)throw new NewerDatabaseError(unknown);
}

/** MIG-2: the extra files migrate() executes right after a main migration file (server/db.ts). */
export const MIGRATION_COMPANION_FILES:Readonly<Record<string,readonly string[]>>=Object.freeze({
 '198_original_keeper_resource_context':['199_keeper_private_cold.sql'],
 '188_local_consumer_credit':['188_consumer_credit_structure.sql'],
 '092_wms_stocktakes':['wms-stocktake-invariants.sql'],
 '108_b2b_dropshipping':['108_b2b_dropship_dispatch.sql'],
});
export type MigrationProgramFile={name:string;file:string;bytes:number;sha256:string};
type ChecksumClient=Pick<Client,'query'>;
/** Every file the program executes, in order: the main file of each migration, then its companions. */
export async function migrationProgramFiles(program:readonly (readonly [string,string])[],read:(file:string)=>Promise<Buffer>):Promise<MigrationProgramFile[]>{
 const out:MigrationProgramFile[]=[];
 for(const [name,path] of program){
  assert(path.startsWith('./'),'migration-file-path');
  for(const file of [path.slice(2),...(MIGRATION_COMPANION_FILES[name]??[])]){
   const bytes=await read(file);
   out.push({name,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
 }
 return out;
}
/** A copy older than the register (migration 244) has no checksums: nothing is read or written. */
async function checksumRegisterPresent(client:ChecksumClient):Promise<boolean>{
 return (await client.query("SELECT to_regclass('public.migration_checksums') IS NOT NULL AS present")).rows[0]?.present===true;
}
async function recordedChecksums(client:ChecksumClient):Promise<{name:string;file:string;bytes:number;sha256:string}[]>{
 return (await client.query('SELECT name,file,bytes,sha256 FROM public.migration_checksums ORDER BY name,file')).rows;
}
export class MigrationChecksumError extends Error {
 readonly code='MIGRATION_CHECKSUM_MISMATCH';
 constructor(readonly changed:readonly {name:string;file:string}[]){
  super('Pliki zastosowanych migracji różnią się od zapisanych sum kontrolnych: '+changed.map(c=>c.name+' ('+c.file+')').join(', ')+
   '. Przywróć oryginalne pliki tej wersji albo odtwórz kopię bazy sprzed zmiany (docs/parity/MIGRATIONS-S1-20261026.md).');
  this.name='MigrationChecksumError';
 }
}
const fileKey=(name:string,file:string)=>name+'\0'+file;
/** MIG-2: every recorded file of an applied migration must still be the release's file, byte for byte. */
export async function assertMigrationChecksums(client:ChecksumClient,files:()=>Promise<readonly MigrationProgramFile[]>):Promise<void>{
 if(!await checksumRegisterPresent(client))return;
 const rows=await recordedChecksums(client);if(!rows.length)return;
 const current=new Map((await files()).map(f=>[fileKey(f.name,f.file),f]));
 const changed=rows.filter(r=>{const f=current.get(fileKey(r.name,r.file));return !f||f.sha256!==r.sha256||f.bytes!==Number(r.bytes);}).map(r=>({name:r.name,file:r.file}))
  .sort((x,y)=>x.name<y.name?-1:x.name>y.name?1:x.file<y.file?-1:x.file>y.file?1:0);
 if(changed.length)throw new MigrationChecksumError(changed);
}
/** MIG-2: after the series, each executed file without a record gets one: `applied` when its migration ran in this
 * run, `baseline` when it was applied before the register existed. Nothing is written when all are recorded. */
export async function recordMigrationChecksums(client:ChecksumClient,files:()=>Promise<readonly MigrationProgramFile[]>,appliedBefore:ReadonlySet<string>):Promise<void>{
 if(!await checksumRegisterPresent(client))return;
 const have=new Set((await recordedChecksums(client)).map(r=>fileKey(r.name,r.file)));
 const missing=(await files()).filter(f=>!have.has(fileKey(f.name,f.file)));
 if(!missing.length)return;
 await client.query('INSERT INTO public.migration_checksums(name,file,bytes,sha256,origin) SELECT * FROM unnest($1::text[],$2::text[],$3::integer[],$4::text[],$5::text[]) ON CONFLICT (name,file) DO NOTHING',
  [missing.map(f=>f.name),missing.map(f=>f.file),missing.map(f=>f.bytes),missing.map(f=>f.sha256),missing.map(f=>appliedBefore.has(f.name)?'baseline':'applied')]);
}

/** MIG-1: the exclusive fence of migrate() (transaction-scoped advisory lock). */
export const MIGRATION_LOCK_KEY=982376;
/** MIG-1: how long a start waits for another instance's migrations before refusing (the session lock_timeout is 8 s). */
export const MIGRATION_LOCK_WAIT_MS=600_000;
export class MigrationLockTimeoutError extends Error {
 readonly code='MIGRATION_LOCK_TIMEOUT';
 constructor(readonly waitedMs:number,options?:ErrorOptions){
  super('Migracje tej bazy wykonuje teraz inna instancja aplikacji (blokada doradcza '+MIGRATION_LOCK_KEY+') i nie skończyła ich w ciągu '+
   Math.round(waitedMs/1000)+' s. Nic nie zostało zmienione. Poczekaj, aż tamta instancja skończy start, albo ją zatrzymaj, i uruchom ponownie.',options);
  this.name='MigrationLockTimeoutError';
 }
}
/** MIG-1: called right after BEGIN. A second instance waits for the fence for `waitMs` (the session's 8 s lock_timeout
 * and 120 s statement_timeout would otherwise end the wait with a raw 55P03/57014 while the first one still migrates),
 * then the series runs with the session's own limits again. When the wait ends the transaction is aborted, nothing
 * was read or written, and the caller rolls back. */
export async function acquireMigrationLock(client:Pick<Client,'query'>,waitMs:number=MIGRATION_LOCK_WAIT_MS):Promise<void>{
 assert(Number.isSafeInteger(waitMs)&&waitMs>=1000&&waitMs<=3_600_000,'migration-lock-wait');
 await client.query(`SET LOCAL lock_timeout=${waitMs}`);
 await client.query(`SET LOCAL statement_timeout=${waitMs+30_000}`);
 try{await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);}
 catch(e){if((e as {code?:unknown}).code==='55P03')throw new MigrationLockTimeoutError(waitMs,{cause:e});throw e;}
 await client.query('SET LOCAL lock_timeout TO DEFAULT');
 await client.query('SET LOCAL statement_timeout TO DEFAULT');
}
/** MIG-1: a migration of the pending series failed; the caller rolls the whole series back (one transaction). */
export class MigrationFailedError extends Error {
 readonly code='MIGRATION_FAILED';
 constructor(readonly migration:string,readonly file:string,readonly series:readonly string[],cause:unknown){
  super('Migracja '+migration+' ('+file+') nie powiodła się; cała seria ('+series[0]+(series.length>1?' … '+series.at(-1):'')+
   ') została wycofana i baza jest w stanie sprzed startu (rejestr migrations bez zmian). Usuń przyczynę i uruchom ponownie. Przyczyna: '+
   (cause instanceof Error?cause.message:String(cause)),{cause});
  this.name='MigrationFailedError';
 }
}
