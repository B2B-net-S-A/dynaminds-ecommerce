/** Host-native, read-only adoption snapshots. Never replaces an earlier checkpoint. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../server/db';
const phase = process.argv[2];
assert(phase === 'before' || phase === 'after');
assert.notEqual(process.env.DYNA_TEST, 'true');
const expected = process.env.QA_EXPECTED_REVISION;
assert.match(expected ?? '', /^[a-f0-9]{40}$/);
const base = 'docs/catalog-mapped-xml-native-before.json';
const earlier = phase === 'after' ? JSON.parse(await readFile(base, 'utf8')) : null;
const stateRoot = resolve(process.env.QA_STATE_ROOT ?? '.');
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
try {
  const response = await fetch('http://127.0.0.1:4100/api/health', {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const health = (await response.json()) as any;
  assert.equal(health.revision, expected);
  assert.equal(health.mode, 'local');
  assert.equal(health.schema_revision, '117_language_file_imports');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  const c = await pool.connect();
  let tenants: string[] = [],
    users: string[] = [];
  const tables: Record<string, { count: number; sha256: string }> = {};
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    assert.equal((await c.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
    tenants =
      earlier?.tenants ??
      (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    users =
      earlier?.users ?? (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const names = (
      await c.query(`SELECT t.table_name FROM information_schema.tables t
      JOIN information_schema.columns k USING(table_schema,table_name) WHERE t.table_schema='public'
      AND t.table_type='BASE TABLE' AND k.column_name='tenant_id' AND t.table_name<>'sessions'
      UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`)
    ).rows.map((r) => r.table_name as string);
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = name === 'users' || name === 'tenants' ? 'id' : 'tenant_id';
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=ANY($1::uuid[]) ORDER BY 1`,
          [name === 'users' ? users : tenants],
        )
      ).rows;
      tables[name] = { count: rows.length, sha256: hash(rows) };
      if (earlier)
        assert.deepEqual(tables[name], earlier.tables[name], 'Earlier firm data changed: ' + name);
    }
    if (earlier) assert.deepEqual(Object.keys(tables), Object.keys(earlier.tables));
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  const originals: Record<string, { sha256: string; mode: number }> = {};
  const paths = earlier
    ? Object.keys(earlier.originals)
    : (await readdir(resolve(stateRoot, 'data')))
        .filter((p) => p.endsWith('.json'))
        .map((p) => 'data/' + p);
  assert(paths.length > 0, 'Original data directory must not be empty');
  for (const path of [
    'data/stock-file-import-stage132.json',
    'data/stock-file-import-lost-ack-stage132.json',
    'data/language-file-import-stage133.json',
  ])
    assert(paths.includes(path), 'Missing private custody fixture: ' + path);
  for (const path of paths) {
    assert.match(path, /^data\/[a-zA-Z0-9_.-]+\.json$/);
    const full = resolve(stateRoot, path);
    const stat = await lstat(full);
    assert(stat.isFile() && !stat.isSymbolicLink());
    originals[path] = { sha256: bytesHash(await readFile(full)), mode: stat.mode & 0o777 };
    if (earlier)
      assert.deepEqual(originals[path], earlier.originals[path], 'Original file changed: ' + path);
  }
  await writeFile(
    'docs/catalog-mapped-xml-native-' + phase + '.json',
    JSON.stringify(
      {
        status: 'PASS',
        phase,
        revision: expected,
        schema_revision: health.schema_revision,
        tenants,
        users,
        tables,
        originals,
        sessions_excluded: true,
        original_baseline_rebased: false,
        provider_calls: false,
        full_goal_complete: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log({
    status: 'PRESERVATION_PASS',
    phase,
    tenants: tenants.length,
    tables: Object.keys(tables).length,
    private_files: paths.length,
  });
} finally {
  await pool.end();
}
