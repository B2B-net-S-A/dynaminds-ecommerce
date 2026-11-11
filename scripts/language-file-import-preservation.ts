/** Root-owned, SELECT-only before/after local adoption. Never replaces a checkpoint. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../server/db';
const phase = process.argv[2];
assert(phase === 'before' || phase === 'after');
assert.notEqual(process.env.DYNA_TEST, 'true');
const expected = process.env.QA_EXPECTED_REVISION;
assert.match(expected ?? '', /^[a-f0-9]{40}$/);
const baseline = 'docs/language-file-import-native-before.json';
const output = phase === 'before' ? baseline : 'docs/language-file-import-native-after.json';
const stateRoot = resolve(process.env.QA_STATE_ROOT ?? '.');
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const earlier = phase === 'after' ? JSON.parse(await readFile(baseline, 'utf8')) : null;
try {
  const response = await fetch('http://127.0.0.1:4100/api/health', {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const health = (await response.json()) as any;
  assert.equal(health.revision, expected);
  assert.equal(health.mode, 'local');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  assert.equal(
    health.schema_revision,
    phase === 'before' ? '116_stock_file_import_validation' : '117_language_file_imports',
  );
  if (phase === 'after') assert.equal(health.language_file_import_available, true);
  const c = await pool.connect();
  let ids: string[] = [],
    users: string[] = [],
    tables: Record<string, { count: number; sha256: string }> = {};
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    assert.equal((await c.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
    ids =
      earlier?.tenants ??
      (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    users =
      earlier?.users ?? (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const names = (
      await c.query(`SELECT t.table_name FROM information_schema.tables t JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id' AND t.table_name<>'sessions'
      UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`)
    ).rows.map((r) => r.table_name as string);
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = name === 'users' || name === 'tenants' ? 'id' : 'tenant_id';
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=ANY($1::uuid[]) ORDER BY 1`,
          [name === 'users' ? users : ids],
        )
      ).rows;
      tables[name] = { count: rows.length, sha256: hash(rows) };
      if (earlier?.tables[name])
        assert.deepEqual(tables[name], earlier.tables[name], 'Earlier data changed: ' + name);
      else if (earlier) {
        assert(name.startsWith('language_file_import_'));
        assert.equal(rows.length, 0);
      }
    }
    if (earlier) assert(Object.keys(earlier.tables).every((name) => Object.hasOwn(tables, name)));
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  const originals: Record<string, string> = {};
  const originalModes: Record<string, number> = {};
  const files: string[] = earlier
    ? Object.keys(earlier.private_sha256)
    : (await readdir(resolve(stateRoot, 'data')))
        .filter((n) => n.endsWith('.json'))
        .map((n) => 'data/' + n);
  for (const path of files) {
    const full = resolve(stateRoot, path),
      stat = await lstat(full);
    assert(stat.isFile() && !stat.isSymbolicLink());
    originalModes[path] = stat.mode & 0o777;
    if (
      path === 'data/stock-file-import-stage132.json' ||
      path === 'data/stock-file-import-lost-ack-stage132.json'
    )
      assert.equal(originalModes[path], 0o600, 'Private custody mode: ' + path);
    if (earlier)
      assert.equal(
        originalModes[path],
        earlier.original_modes[path],
        'Original mode changed: ' + path,
      );
    originals[path] = bytesHash(await readFile(full));
    if (earlier)
      assert.equal(
        originals[path],
        earlier.private_sha256[path],
        'Original state rewritten: ' + path,
      );
  }
  const report = {
    status: 'PASS',
    phase,
    revision: expected,
    schema_revision: health.schema_revision,
    tenants: ids,
    users,
    tables,
    private_sha256: originals,
    original_modes: originalModes,
    sessions_excluded: true,
    original_baseline_rebased: false,
    provider_calls: false,
    full_goal_complete: false,
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(
    JSON.stringify({
      status: 'PASS',
      phase,
      tenants: ids.length,
      tables: Object.keys(tables).length,
      private_files: files.length,
    }) + '\n',
  );
} finally {
  await pool.end();
}
