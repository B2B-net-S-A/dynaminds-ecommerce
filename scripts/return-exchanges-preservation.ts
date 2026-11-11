/** Native adoption checkpoint: preserves existing firms and private state, never rebases. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../server/db';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const phase = process.argv[2];
assert(['before', 'after'].includes(phase));
const revision = process.env.QA_EXPECTED_REVISION;
assert.match(revision ?? '', /^[a-f0-9]{40}$/);
const stateRoot = resolve(process.env.QA_STATE_ROOT ?? '.');
const outputTag = process.env.QA_OUTPUT_TAG;
if (outputTag) {
  assert.equal(phase, 'after');
  assert.match(outputTag, /^[a-z0-9-]{1,40}$/);
}
const before =
  phase === 'after'
    ? JSON.parse(await readFile('docs/return-exchanges-preservation-before.json', 'utf8'))
    : null;
const addedTables = [
  'return_exchanges',
  'return_exchange_items',
  'return_exchange_admissions',
].sort();
const addedColumns: Record<string, string[]> = {
  orders: ['fulfillment_kind', 'replacement_return_id'],
  return_cases: ['remedy'],
};
try {
  const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(health.revision, revision);
  assert.equal(health.mode, 'local');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  assert.equal(
    health.schema_revision,
    phase === 'before'
      ? '119_supplier_remote_feeds'
      : (process.env.QA_EXPECTED_SCHEMA ?? '120_return_exchanges'),
  );
  const c = await pool.connect();
  let tenants: string[], users: string[];
  const tables: Record<string, any> = {},
    columns: Record<string, string[]> = {};
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    assert.equal((await c.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
    tenants =
      before?.tenants ??
      (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    users =
      before?.users ?? (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const names = (
      await c.query(`SELECT table_name FROM information_schema.tables t
      WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions'
      AND (table_name IN ('tenants','users') OR EXISTS(SELECT 1 FROM information_schema.columns k
       WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY table_name`)
    ).rows.map((r) => r.table_name);
    if (before) assert.deepEqual(names, [...Object.keys(before.tables), ...addedTables].sort());
    else assert(addedTables.every((t) => !names.includes(t)));
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      columns[name] = (
        await c.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name",
          [name],
        )
      ).rows.map((r) => r.column_name);
      const previous = before?.columns[name];
      const extras = previous ? columns[name].filter((k) => !previous.includes(k)) : [];
      if (previous) {
        assert(
          previous.every((k: string) => columns[name].includes(k)),
          'Earlier column removed',
        );
        assert.deepEqual(
          extras.sort(),
          (addedColumns[name] ?? []).sort(),
          'Unexpected additive columns',
        );
      }
      const key = ['tenants', 'users'].includes(name) ? 'id' : 'tenant_id';
      const ids = name === 'users' ? users : tenants;
      const rows = (
        await c.query(
          `SELECT to_jsonb(q)-$2::text[] row FROM "${name}" q WHERE ${key}=ANY($1::uuid[]) ORDER BY 1`,
          [ids, extras],
        )
      ).rows;
      tables[name] = { count: rows.length, sha256: hash(JSON.stringify(rows)) };
      if (previous)
        assert.deepEqual(tables[name], before.tables[name], 'Earlier firm data changed');
      else if (before) assert.equal(rows.length, 0, 'Exchange rows appeared in earlier firms');
    }
    if (before) {
      assert.equal(
        (
          await c.query(
            "SELECT count(*)::int n FROM orders WHERE tenant_id=ANY($1::uuid[]) AND (fulfillment_kind<>'sale' OR replacement_return_id IS NOT NULL)",
            [tenants],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await c.query(
            "SELECT count(*)::int n FROM return_cases WHERE tenant_id=ANY($1::uuid[]) AND remedy<>'refund'",
            [tenants],
          )
        ).rows[0].n,
        0,
      );
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  const privateFiles: Record<string, any> = {};
  const paths = before
    ? Object.keys(before.private_files)
    : (await readdir(resolve(stateRoot, 'data'))).filter((p) => p.endsWith('.json')).sort();
  for (const name of paths) {
    assert.match(name, /^[a-zA-Z0-9_.-]+\.json$/);
    const path = resolve(stateRoot, 'data', name),
      stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink());
    privateFiles[name] = { sha256: hash(await readFile(path)), mode: stat.mode & 0o777 };
    if (before)
      assert.deepEqual(
        privateFiles[name],
        before.private_files[name],
        'Existing private file changed',
      );
  }
  const report = {
    status: 'PRESERVATION_PASS',
    phase,
    revision,
    schema_revision: health.schema_revision,
    tenants: tenants!,
    users: users!,
    tables,
    columns,
    private_files: privateFiles,
    sessions_excluded: true,
    baseline_rebased: false,
    full_goal_complete: false,
  };
  await writeFile(
    `docs/return-exchanges-preservation-${phase}${outputTag ? '-' + outputTag : ''}.json`,
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log({
    status: report.status,
    phase,
    earlier_firms: tenants!.length,
    tables: Object.keys(tables).length,
    private_files: paths.length,
  });
} finally {
  await pool.end();
}
