/** MIG-2 (docs/parity/MIGRATIONS-S1-20261026.md): migrate() keeps the sha256 of every executed migration file in
 * migration_checksums (migration 244) and refuses to start when an applied migration's file differs from
 * what was recorded. Without the register (a copy older than 244) nothing is read or written. No database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  assertMigrationChecksums,
  recordMigrationChecksums,
  migrationProgramFiles,
  MigrationChecksumError,
  MIGRATION_COMPANION_FILES,
} from '../server/migration-bootstrap';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const files: Record<string, Buffer> = {
  'schema.sql': Buffer.from('-- 001'),
  '002_imports.sql': Buffer.from('-- 002'),
  '198_original_keeper_resource_context.sql': Buffer.from('-- 198'),
  '199_keeper_private_cold.sql': Buffer.from('-- 199'),
};
const program: [string, string][] = [
  ['001_foundation', './schema.sql'],
  ['002_imports', './002_imports.sql'],
  ['198_original_keeper_resource_context', './198_original_keeper_resource_context.sql'],
];
const read = async (f: string) => { assert(Object.hasOwn(files, f), 'unexpected read ' + f); return files[f]; };
type Row = { name: string; file: string; bytes: number; sha256: string };
function fake(present: boolean, rows: Row[] = []) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  return {
    calls,
    client: {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (sql.includes('to_regclass')) return { rows: [{ present }] };
        if (sql.startsWith('SELECT name,file,bytes,sha256 FROM public.migration_checksums')) return { rows };
        if (sql.startsWith('INSERT INTO public.migration_checksums')) return { rows: [], rowCount: (params?.[0] as unknown[]).length };
        throw new Error('unexpected query ' + sql);
      },
    } as any,
  };
}
const recorded = (name: string, file: string): Row => ({ name, file, bytes: files[file].length, sha256: sha(files[file]) });

test('the program files are the executed files: main file then its companions, as db.ts runs them', async () => {
  const list = await migrationProgramFiles(program, read);
  assert.deepEqual(list.map((f) => [f.name, f.file]), [
    ['001_foundation', 'schema.sql'],
    ['002_imports', '002_imports.sql'],
    ['198_original_keeper_resource_context', '198_original_keeper_resource_context.sql'],
    ['198_original_keeper_resource_context', '199_keeper_private_cold.sql'],
  ]);
  assert.deepEqual(list[0], { name: '001_foundation', file: 'schema.sql', bytes: 6, sha256: sha(files['schema.sql']) });
  // The companion list is exactly the extra files migrate() executes after a main file.
  const db = readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8');
  const extra = [...db.matchAll(/if \(name === '([a-z0-9_]+)'\)\s*await c\.query\(\s*\(await readRuntimeResource\('sql:server\/([A-Za-z0-9_.-]+)'/g)].map((m) => [m[1], m[2]]);
  assert.equal(extra.length, 4);
  assert.deepEqual(Object.entries(MIGRATION_COMPANION_FILES).flatMap(([n, l]) => l.map((f) => [n, f])).sort(), extra.sort());
});

test('a copy without the register (older than 244) is neither read nor written', async () => {
  const f = fake(false);
  let loaded = 0;
  const lazy = async () => { loaded++; return migrationProgramFiles(program, read); };
  await assertMigrationChecksums(f.client, lazy);
  await recordMigrationChecksums(f.client, lazy, new Set());
  assert.equal(loaded, 0, 'no file is read for a copy without the register');
  assert.deepEqual(f.calls.map((c) => c.sql), Array(2).fill("SELECT to_regclass('public.migration_checksums') IS NOT NULL AS present"));
});

test('matching files pass with read-only queries; nothing is written when every file is recorded', async () => {
  const all = (await migrationProgramFiles(program, read)).map((x) => recorded(x.name, x.file));
  const f = fake(true, all), lazy = () => migrationProgramFiles(program, read);
  await assertMigrationChecksums(f.client, lazy);
  await recordMigrationChecksums(f.client, lazy, new Set(program.map(([n]) => n)));
  assert(f.calls.every((c) => !c.sql.startsWith('INSERT')), 'no write');
});

test('a changed or vanished file of an applied migration refuses with a Polish error naming each file', async () => {
  const rows = [
    { ...recorded('001_foundation', 'schema.sql'), sha256: 'a'.repeat(64) },
    recorded('002_imports', '002_imports.sql'),
    { ...recorded('198_original_keeper_resource_context', '199_keeper_private_cold.sql'), bytes: 999 },
    { name: '002_imports', file: '002_imports_old.sql', bytes: 1, sha256: 'b'.repeat(64) },
  ];
  const f = fake(true, rows);
  await assert.rejects(() => assertMigrationChecksums(f.client, () => migrationProgramFiles(program, read)), (e: any) => {
    assert(e instanceof MigrationChecksumError);
    assert.equal(e.name, 'MigrationChecksumError');
    assert.equal(e.code, 'MIGRATION_CHECKSUM_MISMATCH');
    assert.deepEqual(e.changed, [
      { name: '001_foundation', file: 'schema.sql' },
      { name: '002_imports', file: '002_imports_old.sql' },
      { name: '198_original_keeper_resource_context', file: '199_keeper_private_cold.sql' },
    ]);
    assert.match(e.message, /^Pliki zastosowanych migracji różnią się od zapisanych sum kontrolnych: 001_foundation \(schema\.sql\), 002_imports \(002_imports_old\.sql\), 198_original_keeper_resource_context \(199_keeper_private_cold\.sql\)\./);
    assert.match(e.message, /Przywróć oryginalne pliki tej wersji albo odtwórz kopię bazy/);
    return true;
  });
  assert(f.calls.every((c) => !c.sql.startsWith('INSERT')), 'a refusal writes nothing');
});

test('missing rows are recorded once: executed in this run = applied, applied before = baseline', async () => {
  const f = fake(true, [recorded('001_foundation', 'schema.sql')]);
  await recordMigrationChecksums(f.client, () => migrationProgramFiles(program, read), new Set(['001_foundation', '002_imports']));
  const inserts = f.calls.filter((c) => c.sql.startsWith('INSERT'));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].sql, /^INSERT INTO public\.migration_checksums\(name,file,bytes,sha256,origin\) SELECT \* FROM unnest\(\$1::text\[\],\$2::text\[\],\$3::integer\[\],\$4::text\[\],\$5::text\[\]\) ON CONFLICT \(name,file\) DO NOTHING$/);
  assert.deepEqual(inserts[0].params, [
    ['002_imports', '198_original_keeper_resource_context', '198_original_keeper_resource_context'],
    ['002_imports.sql', '198_original_keeper_resource_context.sql', '199_keeper_private_cold.sql'],
    [6, 6, 6],
    [sha(files['002_imports.sql']), sha(files['198_original_keeper_resource_context.sql']), sha(files['199_keeper_private_cold.sql'])],
    ['baseline', 'applied', 'applied'],
  ]);
});

test('migrate() verifies after the ledger check and before the backup, and records after the series before COMMIT', () => {
  const db = readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8');
  assert.match(db, /await assertLedgerKnownToRelease\(c, program\.map\(\(\[name\]\) => name\)\);\s*(?:\/\/[^\n]*\n\s*)*await assertMigrationChecksums\(c, checksumFiles\);\s*(?:\/\/[^\n]*\n\s*)*const applied = new Set/);
  assert.match(db, /const checksumFiles = \(\) => \(programFiles \?\?= migrationProgramFiles\(program, \(file\) => readRuntimeResource\('sql:server\/' \+ file, import\.meta\.url\)\)\);/);
  assert.match(db, /await c\.query\('INSERT INTO migrations\(name\) VALUES\(\$1\)', \[name\]\);\s*\} catch \(e\) \{[^}]*\}\s*\}\s*(?:\/\/[^\n]*\n\s*)*await recordMigrationChecksums\(c, checksumFiles, applied\);\s*await c\.query\('COMMIT'\);/);
});
