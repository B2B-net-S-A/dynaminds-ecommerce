/** Read-only checkpoint. Captures existing firms before creating an isolated fixture. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = '<workspace>/app';
const phase = process.argv[2];
assert(phase === 'before' || phase === 'after');
const stage = Number(process.env.QA_PRESERVATION_STAGE ?? '139');
assert(Number.isSafeInteger(stage) && stage >= 139 && stage <= 9999);
const stem = stage === 139 ? 'return-exchanges-wms' : `return-exchanges-stage${stage}`;
const newTables = (process.env.QA_EXPECTED_NEW_TABLES ?? '').split(',').filter(Boolean).sort();
const addedColumns: Record<string, string[]> = JSON.parse(
  process.env.QA_EXPECTED_ADDED_COLUMNS ?? '{}',
);
assert(addedColumns && !Array.isArray(addedColumns) && typeof addedColumns === 'object');
for (const [table, columns] of Object.entries(addedColumns)) {
  assert(/^[a-z_][a-z0-9_]*$/.test(table));
  assert(Array.isArray(columns) && columns.length > 0);
  assert(columns.every((name) => /^[a-z_][a-z0-9_]*$/.test(name)));
  assert.equal(new Set(columns).size, columns.length);
}
assert(newTables.every((name) => /^[a-z_][a-z0-9_]*$/.test(name)));
assert.equal(new Set(newTables).size, newTables.length);
assert(phase === 'after' || newTables.length === 0);
assert(phase === 'after' || Object.keys(addedColumns).length === 0);
const revision = process.env.QA_EXPECTED_REVISION;
assert.match(revision ?? '', /^[a-f0-9]{40}$/);
assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(root, '.local.json'));
const configStat = await lstat(resolve(root, '.local.json'));
assert(configStat.isFile() && !configStat.isSymbolicLink());
assert.equal(configStat.mode & 0o777, 0o600);
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const baselinePath = `docs/${stem}-preservation-before.json`;
const baseline = phase === 'after' ? JSON.parse(await readFile(baselinePath, 'utf8')) : null;
if (baseline) assert.equal(baseline.stage, stage);
const tag = process.env.QA_OUTPUT_TAG;
if (tag) {
  assert.equal(phase, 'after');
  assert.match(tag, /^[a-z0-9-]{1,40}$/);
}
const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
assert.equal(health.status, 'ok');
assert.equal(health.revision, revision);
assert.equal(
  health.schema_revision,
  process.env.QA_EXPECTED_SCHEMA ?? '122_return_exchange_hashes',
);
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
const { pool } = await import('../server/db');
try {
  const c = await pool.connect();
  let tenants: string[], users: string[];
  const tables: Record<string, { count: number; rows_sha256: string; columns_sha256: string }> = {};
  const addedEmpty: string[] = [];
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const db = (
      await c.query(
        "SELECT current_database() name,current_user actor,host(inet_server_addr()) address,inet_server_port() port,current_setting('transaction_read_only') ro",
      )
    ).rows[0];
    assert.equal(db.name, 'dynaminds');
    assert.equal(db.actor, 'postgres');
    assert(['127.0.0.1', '::1'].includes(db.address));
    assert.equal(db.port, 55432);
    assert.equal(db.ro, 'on');
    tenants =
      baseline?.tenants ??
      (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    users =
      baseline?.users ?? (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const names = (
      await c.query(`SELECT table_name FROM information_schema.tables t
      WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions'
      AND(table_name IN('tenants','users') OR EXISTS(SELECT 1 FROM information_schema.columns k
        WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id'))
      ORDER BY table_name`)
    ).rows.map((r) => r.table_name);
    if (baseline) {
      assert(newTables.every((name) => !Object.hasOwn(baseline.tables, name)));
      assert(Object.keys(addedColumns).every((name) => Object.hasOwn(baseline.tables, name)));
      assert.deepEqual(names, [...Object.keys(baseline.tables), ...newTables].sort());
    }
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const columns = (
        await c.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name",
          [name],
        )
      ).rows;
      const projectedColumns = addedColumns[name] ?? [];
      assert(projectedColumns.every((column) => columns.some((row) => row.column_name === column)));
      if (projectedColumns.length) {
        const changed = await c.query(
          `SELECT 1 FROM "${name}" WHERE tenant_id=ANY($1::uuid[]) AND (${projectedColumns
            .map((column) => `"${column}" IS NOT NULL`)
            .join(' OR ')}) LIMIT 1`,
          [tenants],
        );
        assert.equal(changed.rowCount, 0, 'New columns populated data for an earlier firm');
      }
      const rows = (
        await c.query(
          `SELECT to_jsonb(q)-$2::text[] row FROM "${name}" q
        WHERE ${['tenants', 'users'].includes(name) ? 'id' : 'tenant_id'}=ANY($1::uuid[]) ORDER BY 1`,
          [name === 'users' ? users : tenants, projectedColumns],
        )
      ).rows;
      tables[name] = {
        count: rows.length,
        rows_sha256: digest(JSON.stringify(rows)),
        columns_sha256: digest(
          JSON.stringify(columns.filter((row) => !projectedColumns.includes(row.column_name))),
        ),
      };
      if (baseline && newTables.includes(name)) {
        assert.equal(rows.length, 0, 'Migration added data to an earlier firm');
        addedEmpty.push(name);
      } else if (baseline)
        assert.deepEqual(tables[name], baseline.tables[name], 'Earlier firm or schema changed');
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  const files = baseline
    ? Object.keys(baseline.private_files)
    : (await readdir(resolve(root, 'data'))).filter((p) => p.endsWith('.json')).sort();
  const privateFiles: Record<string, { sha256: string; mode: number }> = {};
  for (const name of files) {
    assert.match(name, /^[a-zA-Z0-9_.-]+\.json$/);
    const path = resolve(root, 'data', name),
      stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink());
    privateFiles[name] = { sha256: digest(await readFile(path)), mode: stat.mode & 0o777 };
  }
  const config = {
    sha256: digest(await readFile(resolve(root, '.local.json'))),
    mode: configStat.mode & 0o777,
  };
  if (baseline) {
    assert.deepEqual(privateFiles, baseline.private_files);
    assert.deepEqual(config, baseline.config);
  }
  await writeFile(
    `docs/${stem}-preservation-${phase}${tag ? '-' + tag : ''}.json`,
    JSON.stringify(
      {
        stage,
        status: 'PRESERVATION_PASS',
        phase,
        revision,
        schema_revision: health.schema_revision,
        tenants: tenants!,
        users: users!,
        tables,
        private_files: privateFiles,
        config,
        new_tables_empty_for_earlier_firms: addedEmpty,
        added_columns_null_for_earlier_firms: addedColumns,
        sessions_excluded: true,
        baseline_rebased: false,
        full_goal_complete: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: 'PRESERVATION_PASS',
      phase,
      earlier_firms: tenants!.length,
      tables: Object.keys(tables).length,
      private_files: files.length,
    }),
  );
} catch {
  process.exitCode = 1;
  console.error('QA139 preservation failed; no writes or checkpoint overwrite performed.');
} finally {
  await pool.end();
}
