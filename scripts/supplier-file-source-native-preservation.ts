/** Read-only migration checkpoint. Pins earlier firms, columns and private files; never rebases. */
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
const root = resolve(process.env.QA_STATE_ROOT ?? '.');
const outputTag = process.env.QA_OUTPUT_TAG;
if (outputTag) {
  assert.equal(phase, 'after');
  assert.match(outputTag, /^[a-z0-9-]{1,40}$/);
}
const output =
  'docs/supplier-file-source-native-' + phase + (outputTag ? '-' + outputTag : '') + '.json';
const earlier =
  phase === 'after'
    ? JSON.parse(await readFile('docs/supplier-file-source-native-before.json', 'utf8'))
    : null;
const newTables = [
  'supplier_file_source_configs',
  'supplier_file_source_revisions',
  'supplier_file_previews',
  'supplier_file_preview_rows',
  'supplier_file_runs',
  'supplier_file_run_rows',
].sort();
const additive: Record<string, string[]> = {
  supplier_sources: ['kind', 'name'],
  supplier_catalog_items: ['file_run_id'],
};
const bytesHash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown) => bytesHash(JSON.stringify(v));
try {
  const h = await fetch('http://127.0.0.1:4100/api/health');
  assert.equal(h.status, 200);
  const health = (await h.json()) as any;
  assert.equal(health.revision, expected);
  assert.equal(health.mode, 'local');
  assert.equal(
    health.schema_revision,
    phase === 'before' ? '117_language_file_imports' : '118_supplier_file_sources',
  );
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  const c = await pool.connect();
  let tenants: string[] = [],
    users: string[] = [];
  const tables: Record<string, any> = {},
    columns: Record<string, string[]> = {},
    additiveVerified: Record<string, number> = {};
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
      await c.query(
        `SELECT t.table_name FROM information_schema.tables t JOIN information_schema.columns k USING(table_schema,table_name) WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id' AND t.table_name<>'sessions' UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`,
      )
    ).rows.map((r) => r.table_name as string);
    if (earlier) assert.deepEqual(names, [...Object.keys(earlier.tables), ...newTables].sort());
    else
      assert(
        newTables.every((n) => !names.includes(n)),
        'Before checkpoint must precede migration118',
      );
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const ids = name === 'users' ? users : tenants,
        key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      columns[name] = (
        await c.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name",
          [name],
        )
      ).rows.map((r) => r.column_name);
      const extra = earlier
        ? columns[name].filter((n) => !(earlier.columns[name] ?? []).includes(n))
        : [];
      if (earlier && !newTables.includes(name)) {
        assert.deepEqual(
          extra.sort(),
          (additive[name] ?? []).sort(),
          'Unexpected additive columns: ' + name,
        );
        assert(
          earlier.columns[name].every((n: string) => columns[name].includes(n)),
          'Earlier column removed: ' + name,
        );
      }
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) - $2::text[] row FROM "${name}" t WHERE ${key}=ANY($1::uuid[]) ORDER BY 1`,
          [ids, newTables.includes(name) ? [] : extra],
        )
      ).rows;
      tables[name] = { count: rows.length, sha256: hash(rows) };
      if (earlier && !newTables.includes(name))
        assert.deepEqual(tables[name], earlier.tables[name], 'Earlier rows changed: ' + name);
      if (earlier && newTables.includes(name))
        assert.equal(rows.length, 0, 'New module unexpectedly contains an earlier firm');
      if (earlier && name === 'supplier_sources') {
        const wrong = (
          await c.query(
            "SELECT count(*)::int n FROM supplier_sources WHERE tenant_id=ANY($1::uuid[]) AND (kind<>'bigbuy' OR name<>'')",
            [tenants],
          )
        ).rows[0].n;
        assert.equal(wrong, 0);
        additiveVerified[name] = rows.length;
      }
      if (earlier && name === 'supplier_catalog_items') {
        assert.equal(
          (
            await c.query(
              'SELECT count(*)::int n FROM supplier_catalog_items WHERE tenant_id=ANY($1::uuid[]) AND file_run_id IS NOT NULL',
              [tenants],
            )
          ).rows[0].n,
          0,
        );
        additiveVerified[name] = rows.length;
      }
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  const originals: Record<string, any> = {};
  const paths = earlier
    ? Object.keys(earlier.originals)
    : (await readdir(resolve(root, 'data')))
        .filter((p) => p.endsWith('.json'))
        .sort()
        .map((p) => 'data/' + p);
  for (const p of [
    'data/stock-file-import-stage132.json',
    'data/stock-file-import-lost-ack-stage132.json',
    'data/language-file-import-stage133.json',
    'data/catalog-mapped-xml-stage134.json',
  ])
    assert(paths.includes(p));
  for (const p of paths) {
    assert.match(p, /^data\/[a-zA-Z0-9_.-]+\.json$/);
    const stat = await lstat(resolve(root, p));
    assert(stat.isFile() && !stat.isSymbolicLink());
    originals[p] = { sha256: bytesHash(await readFile(resolve(root, p))), mode: stat.mode & 0o777 };
    if (earlier)
      assert.deepEqual(originals[p], earlier.originals[p], 'Private custody changed: ' + p);
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        status: 'PASS',
        phase,
        revision: expected,
        schema_revision: health.schema_revision,
        tenants,
        users,
        columns,
        tables,
        originals,
        sessions_excluded: true,
        original_baseline_rebased: false,
        additive_columns_verified: additiveVerified,
        new_tables: phase === 'after' ? newTables : [],
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
    earlier_tenants: tenants.length,
    tables: Object.keys(tables).length,
    private_files: paths.length,
  });
} finally {
  await pool.end();
}
