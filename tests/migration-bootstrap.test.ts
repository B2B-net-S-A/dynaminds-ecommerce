import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ensureMigrationRegistry,acquireMigrationLock,MigrationLockTimeoutError,MigrationFailedError,MIGRATION_LOCK_WAIT_MS} from '../server/migration-bootstrap';

function connection(rows:any[],failure?:unknown){
 const calls:string[]=[];
 return {calls,client:{async query(sql:string){calls.push(sql);if(failure)throw failure;return {rows};}} as any};
}
test('an installed migration registry issues no DDL, preserving another process generation',async()=>{
 const c=connection([{kind:'r',persistence:'p',owner:'postgres'}]);
 await ensureMigrationRegistry(c.client);await ensureMigrationRegistry(c.client);
 assert.equal(c.calls.length,2);assert(c.calls.every((sql:string)=>sql.startsWith('SELECT')));
 assert(c.calls[0].includes("n.nspname='public' AND c.relname='migrations'"));
});
test('a missing registry retains bootstrap semantics, including nullable applied_at',async()=>{
 const c=connection([]);await ensureMigrationRegistry(c.client);
 assert.equal(c.calls.length,2);
 assert.equal(c.calls[1],'CREATE TABLE IF NOT EXISTS public.migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
});
test('wrong owner, temporary or non-table registries refuse without attempting repairs',async()=>{
 for(const row of [{kind:'r',persistence:'p',owner:'other'},{kind:'v',persistence:'p',owner:'postgres'},
  {kind:'r',persistence:'t',owner:'postgres'},{kind:'r',persistence:'u',owner:'postgres'}]){
  const c=connection([row]);await assert.rejects(()=>ensureMigrationRegistry(c.client),/migration-registry-identity/);
  assert.equal(c.calls.length,1);
 }
});
test('a failed catalogue read cannot cause fallback DDL',async()=>{
 const first=new Error('catalogue read failed'),c=connection([],first);
 await assert.rejects(()=>ensureMigrationRegistry(c.client),e=>e===first);assert.equal(c.calls.length,1);
});
test('bootstrap remains inside the original exclusive migration fence',()=>{
 const source=readFileSync(new URL('../server/db.ts',import.meta.url),'utf8');
 assert.match(source,/await c\.query\('BEGIN'\);\s*await acquireMigrationLock\(c, options\.lockWaitMs\);\s*await ensureMigrationRegistry\(c\);\s*for \(const \[name, file\] of/);
});
// MIG-1: the fence is the same transaction-scoped 982376 lock; only the wait for it has its own budget.
test('the fence waits with its own budget, then restores the session limits; a timeout is a clear refusal',async()=>{
 const calls:string[]=[];
 await acquireMigrationLock({async query(sql:string){calls.push(sql);return {rows:[]};}} as any,5000);
 assert.deepEqual(calls,['SET LOCAL lock_timeout=5000','SET LOCAL statement_timeout=35000','SELECT pg_advisory_xact_lock(982376)',
  'SET LOCAL lock_timeout TO DEFAULT','SET LOCAL statement_timeout TO DEFAULT']);
 assert.equal(MIGRATION_LOCK_WAIT_MS,600000);
 const timeout=Object.assign(new Error('canceling statement due to lock timeout'),{code:'55P03'});
 await assert.rejects(()=>acquireMigrationLock({async query(sql:string){if(sql.startsWith('SELECT'))throw timeout;return {rows:[]};}} as any,2000),
  (e:any)=>e instanceof MigrationLockTimeoutError&&e.code==='MIGRATION_LOCK_TIMEOUT'&&e.cause===timeout&&/w ciągu 2 s\. Nic nie zostało zmienione/.test(e.message));
 const other=Object.assign(new Error('connection lost'),{code:'08006'});
 await assert.rejects(()=>acquireMigrationLock({async query(sql:string){if(sql.startsWith('SELECT'))throw other;return {rows:[]};}} as any),e=>e===other);
 for(const bad of [0,999,1.5,3_600_001])await assert.rejects(()=>acquireMigrationLock({async query(){return {rows:[]};}} as any,bad),/migration-lock-wait/);
});
test('a failing migration is named with the series it rolled back',()=>{
 const cause=Object.assign(new Error('relation "guard_verdicts" already exists'),{code:'42P07'});
 const e=new MigrationFailedError('248_guard_verdicts','248_guard_verdicts.sql',['244_a','245_b','248_guard_verdicts'],cause);
 assert.equal(e.code,'MIGRATION_FAILED');assert.equal(e.cause,cause);assert.equal(e.name,'MigrationFailedError');
 assert.equal(e.message,'Migracja 248_guard_verdicts (248_guard_verdicts.sql) nie powiodła się; cała seria (244_a … 248_guard_verdicts) została wycofana i baza jest w stanie sprzed startu (rejestr migrations bez zmian). Usuń przyczynę i uruchom ponownie. Przyczyna: relation "guard_verdicts" already exists');
 const source=readFileSync(new URL('../server/db.ts',import.meta.url),'utf8');
 assert.match(source,/if \(!done\.rowCount\) try \{[\s\S]*?INSERT INTO migrations\(name\) VALUES\(\$1\)'[\s\S]*?\} catch \(e\) \{[\s\S]*?throw new MigrationFailedError\(name, file\.slice\(2\), program\.map\(\(\[n\]\) => n\)\.filter\(\(n\) => !applied\.has\(n\)\), e\);/);
});
