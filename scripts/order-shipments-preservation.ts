/** Root-only native adoption gate. Every output is exclusive; baseline is never rewritten. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../server/db';

const root = '<workspace>/app';
const docs = '<workspace>/worktrees/stock-file-import/docs';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const added: string[] = [];
async function main() {
  const phase = process.argv[2];
  assert(['before', 'after-migration', 'after-final'].includes(phase));
  assert.equal(resolve(process.cwd()), root);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json'));
  assert.notEqual(process.env.DYNA_TEST, 'true');
  const revision = process.env.QA_EXPECTED_REVISION ?? '';
  assert.match(revision, /^[a-f0-9]{40}$/);
  const health = await (await fetch('http://127.0.0.1:4100/api/health')).json();
  assert.equal(health.revision, revision);
  assert.equal(health.mode, 'local');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  assert.equal(
    health.schema_revision,
    phase === 'before' ? '132_shipment_label_batches' : '133_order_shipments',
  );
  const beforePath = resolve(docs, 'order-shipments-preservation-before.json');
  const previous = phase === 'before' ? null : JSON.parse(await readFile(beforePath, 'utf8'));
  const c = await pool.connect();
  const tables: Record<string, { count: number; sha256: string }> = {};
  const columns: Record<string, string[]> = {};
  let tenants: string[] = [],
    users: string[] = [];
  try {
    const url = new URL(pool.options.connectionString!);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, '55432');
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    assert.equal(
      (await c.query('SELECT current_database() db,current_user role')).rows[0].role,
      'postgres',
    );
    tenants =
      previous?.tenants ??
      (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    users =
      previous?.users ?? (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const names = (
      await c.query(
        "SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN ('tenants','users') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY table_name",
      )
    ).rows.map((r) => r.table_name);
    if (previous)
      assert.equal(
        JSON.stringify(names),
        JSON.stringify([...Object.keys(previous.tables), ...added].sort()),
        'Unexpected table inventory.',
      );
    else assert(added.every((n) => !names.includes(n)));
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      columns[name] = (
        await c.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name",
          [name],
        )
      ).rows.map((r) => r.column_name);
      if (previous?.columns[name])
        assert.equal(
          JSON.stringify(columns[name]),
          JSON.stringify(previous.columns[name]),
          'Existing columns changed.',
        );
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const ids = name === 'users' ? users : tenants;
      const rows = (
        await c.query(
          `SELECT to_jsonb(q) row FROM "${name}" q WHERE ${key}=ANY($1::uuid[]) ORDER BY 1`,
          [ids],
        )
      ).rows;
      tables[name] = { count: rows.length, sha256: hash(JSON.stringify(rows)) };
      if (previous?.tables[name])
        assert.equal(
          JSON.stringify(tables[name]),
          JSON.stringify(previous.tables[name]),
          'Earlier firm rows changed.',
        );
      else if (previous) assert.equal(rows.length, 0, 'New batch rows in earlier firms.');
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  const files: Record<string, { sha256: string; mode: number }> = {};
  const paths = previous
    ? Object.keys(previous.private_files)
    : (await readdir(resolve(root, 'data'))).filter((n) => n.endsWith('.json')).sort();
  for (const name of paths) {
    assert.match(name, /^[A-Za-z0-9_.-]+\.json$/);
    const file = resolve(root, 'data', name),
      st = await lstat(file);
    assert(st.isFile() && !st.isSymbolicLink());
    files[name] = { sha256: hash(await readFile(file)), mode: st.mode & 0o777 };
    if (previous)
      assert.equal(
        JSON.stringify(files[name]),
        JSON.stringify(previous.private_files[name]),
        'Earlier private file changed.',
      );
  }
  const configPath = resolve(root, '.local.json'),
    configStat = await lstat(configPath);
  assert(configStat.isFile() && !configStat.isSymbolicLink());
  const config = { sha256: hash(await readFile(configPath)), mode: configStat.mode & 0o777 };
  if (previous)
    assert.equal(
      JSON.stringify(config),
      JSON.stringify(previous.config),
      'Original config changed.',
    );
  const report = {
    stage: 150,
    status: 'PRESERVATION_PASS',
    phase,
    revision,
    schema_revision: health.schema_revision,
    tenants,
    users,
    tables,
    columns,
    private_files: files,
    config,
    new_tables_empty_for_earlier_firms: previous ? added : [],
    sessions_excluded: true,
    baseline_rebased: false,
    full_goal_complete: false,
  };
  await writeFile(
    resolve(docs, `order-shipments-preservation-${phase}.json`),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      phase,
      earlier_firms: tenants.length,
      tables: Object.keys(tables).length,
      private_files: paths.length,
    }) + '\n',
  );
}
main()
  .catch(() => {
    process.stderr.write('QA149_PRESERVATION_FAILED_NO_PRIVATE_OUTPUT\n');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
