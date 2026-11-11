import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertLedgerKnownToRelease,NewerDatabaseError} from '../server/migration-bootstrap';
import {RELEASE_MIGRATIONS} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const ledger=(names:unknown[])=>{const calls:string[]=[];return {calls,client:{async query(sql:string){calls.push(sql);return {rows:names.map(name=>({name}))};}} as any};};
// The release's whole program: the literal 001-209 pairs of db.ts plus the release list.
const db=readFileSync(new URL('../server/db.ts',import.meta.url),'utf8'),body=db.slice(db.indexOf('for (const [name, file] of ['),db.indexOf('...RELEASE_MIGRATION_PROGRAM'));
const release=[...[...body.matchAll(/\[\s*'([a-z0-9_]+)'\s*,\s*'\.\/[a-zA-Z0-9_-]+\.sql'\s*,?\s*\]/g)].map(m=>m[1]),...RELEASE_MIGRATIONS.map(m=>m.name)];
assert.equal(release.length,258);

test('a ledger written by this release or an older one is accepted with one read-only query',async()=>{
 for(const names of [[],release.slice(0,10),release]){const c=ledger(names);await assertLedgerKnownToRelease(c.client,release);assert.deepEqual(c.calls,['SELECT name FROM public.migrations ORDER BY name']);}
});
test('a database migrated by a newer release refuses with a Polish error naming the unknown migrations',async()=>{
 const c=ledger([...release,'269_future_release','270_after_that']);
 await assert.rejects(()=>assertLedgerKnownToRelease(c.client,release),(e:any)=>{
  assert(e instanceof NewerDatabaseError);assert.equal(e.code,'MIGRATION_LEDGER_NEWER_THAN_RELEASE');assert.deepEqual(e.unknown,['269_future_release','270_after_that']);
  assert.match(e.message,/^Ta wersja aplikacji nie uruchomi bazy danych zmigrowanej przez nowszą wersję\. Migracje nieznane tej wersji: 269_future_release, 270_after_that\./);return true;});
 // A renamed or foreign row is just as unknown as a newer one; a non-text name never passes.
 for(const extra of ['200_renamed_elsewhere',null,42]){const d=ledger([...release.slice(0,3),extra]);await assert.rejects(()=>assertLedgerKnownToRelease(d.client,release),NewerDatabaseError);}
});
test('an empty release list cannot accept everything',async()=>{
 await assert.rejects(()=>assertLedgerKnownToRelease(ledger([]).client,[]),/migration-release-list-required/);
});
test('migrate() checks the ledger against its whole program under the lock, before applying any migration',()=>{
 const source=readFileSync(new URL('../server/db.ts',import.meta.url),'utf8');
 assert.match(source,/await ensureMigrationRegistry\(c\);\s*for \(const \[name, file\] of \[[\s\S]*?\]\) \{ program\.push\(\[name, file\]\); \}\s*(?:\/\/[^\n]*\n\s*)*await assertLedgerKnownToRelease\(c, program\.map\(\(\[name\]\) => name\)\);[^]*?\n    for \(const \[name, file\] of program\) \{/);
});
