import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  restoreDatabaseName,
  localDatabase,
} from '../server/recovery';

const tables = [
  'orders',
  'order_items',
  'order_pick_items',
  'stock',
  'reservations',
  'order_events',
  'shipments',
  'documents',
  'payment_entries',
  'return_cases',
  'order_field_definitions',
  'order_field_definition_revisions',
  'order_field_options',
  'order_field_values',
  'order_field_value_events',
  'order_field_files',
  'order_field_requests',
];
let child: ReturnType<typeof spawn> | undefined;
let database: string | undefined;
let report: any;
try {
  const state = JSON.parse(await readFile('data/order-fields-stage100.json', 'utf8'));
  assert(state.tenant && state.order);
  const health: any = await (await fetch('http://127.0.0.1:4100/api/health')).json();
  assert.equal(health.schema_revision, '078_order_fields');
  assert(health.order_fields_available);
  assert.match(health.revision, /^[a-f0-9]{40}$/);
  process.env.APP_REVISION = health.revision;
  const before: Record<string, any[]> = {};
  for (const table of tables)
    before[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        state.tenant,
      ])
    ).rows;
  assert(before.order_field_definitions.length >= 7, 'All typed native flows must precede restore');
  assert(before.order_field_files.length >= 1, 'A private native file must precede restore');
  assert(before.order_field_value_events.length >= 7, 'Persisted values must precede restore');
  const definitionId = before.order_field_definitions[0].row.id;
  const fileId = before.order_field_files[0].row.id;
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, { directory: 'data/order-fields-100-restore' });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const client = new pg.Client({ ...localDatabase(), database });
  await client.connect();
  try {
    for (const table of tables)
      assert.deepEqual(
        (
          await client.query(
            `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`,
            [state.tenant],
          )
        ).rows,
        before[table],
        table,
      );
    assert.equal((await client.query('SELECT count(*)::int n FROM migrations')).rows[0].n, 78);
    const other = (
      await client.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [state.tenant])
    ).rows[0].id;
    for (const table of tables.filter((name) => name.startsWith('order_field_'))) {
      const metadata = (
        await client.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      ).rows[0];
      assert(metadata.relrowsecurity && metadata.relforcerowsecurity);
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE dyna_app');
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [other]);
        assert.equal(
          (
            await client.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [
              state.tenant,
            ])
          ).rows[0].n,
          0,
        );
      } finally {
        await client.query('ROLLBACK');
      }
    }
    for (const table of [
      'order_field_definition_revisions',
      'order_field_value_events',
      'order_field_files',
      'order_field_requests',
    ]) {
      assert.equal(
        (await client.query("SELECT has_table_privilege('dyna_app',$1,'UPDATE') p", [table]))
          .rows[0].p,
        false,
      );
      assert.equal(
        (await client.query("SELECT has_table_privilege('dyna_app',$1,'DELETE') p", [table]))
          .rows[0].p,
        false,
      );
      await client.query('BEGIN');
      try {
        await assert.rejects(
          client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [state.tenant]),
          /append-only|immutable/,
        );
      } finally {
        await client.query('ROLLBACK');
      }
    }
  } finally {
    await client.end();
  }
  let occupied = false;
  try {
    await fetch('http://127.0.0.1:4102/api/health');
    occupied = true;
  } catch {}
  assert(!occupied, 'Preview port is occupied');
  child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/restore-preview.ts',
      '--result',
      restored.directory + '/result.json',
    ],
    { cwd: process.cwd(), env: { ...process.env, DYNA_PREVIEW_PORT: '4102' }, stdio: 'ignore' },
  );
  const base = 'http://127.0.0.1:4102/api';
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(base + '/health');
      if (response.ok) {
        const preview: any = await response.json();
        assert(preview.restore_preview && preview.order_fields_available);
        assert.equal(preview.revision, health.revision);
        assert.equal(preview.schema_revision, health.schema_revision);
        ready = true;
        break;
      }
    } catch {}
    assert(child.exitCode === null, 'Preview exited');
    await setTimeout(200);
  }
  assert(ready);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: state.email, password: state.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert(cookie.startsWith('dyna_session_preview_4102='));
  const req = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const reads = [
    '/order-fields',
    `/orders/${state.order.id}/fields`,
    `/orders/${state.order.id}/fields/history`,
  ];
  for (const path of reads) {
    const response = await req(path);
    assert.equal(response.status, 200, path);
    const result: any = await response.json();
    assert(result.available && result.read_only && result.can_write === false);
  }
  const download = await req('/order-field-files/' + fileId + '/download');
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.match(download.headers.get('content-disposition')!, /^attachment;/);
  const writes: [string, string][] = [
    ['/order-fields', 'POST'],
    [`/order-fields/${definitionId}`, 'PATCH'],
    [`/order-fields/${definitionId}`, 'DELETE'],
    [`/orders/${state.order.id}/fields`, 'PATCH'],
    ['/order-field-files', 'POST'],
  ];
  for (const [path, method] of writes)
    assert.equal((await req(path, method, {})).status, 423, path);
  assert.equal(
    (await fetch('http://127.0.0.1:4100/api/auth/me', { headers: { cookie } })).status,
    401,
  );
  for (const table of tables)
    assert.deepEqual(
      (
        await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
          state.tenant,
        ])
      ).rows,
      before[table],
      table + ' live unchanged',
    );
  report = {
    stage: '100',
    verified_at: new Date().toISOString(),
    source_revision: restored.revision,
    schema: health.schema_revision,
    backup_id: backup.id,
    restore_tables: restored.tables,
    migrations: 78,
    encrypted_records_verified: restored.encrypted_records_verified,
    all_snapshot_rows_verified: true,
    schema_fingerprint_verified: true,
    qa_business_tables_exact: tables.length,
    force_RLS_verified: true,
    foreign_firm_rows_hidden: true,
    evidence_append_only: true,
    preview_read_statuses: [...reads.map(() => 200), download.status],
    preview_mutation_statuses: writes.map(() => 423),
    preview_cookie_on_live_http: 401,
    worker_enabled: false,
    live_QA_business_tables_unchanged: true,
    external_provider_verified: false,
    goal_complete: false,
  };
} finally {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await stopped;
  }
  if (database) await pool.query(`DROP DATABASE ${restoreDatabaseName(database)} WITH (FORCE)`);
  if (report) {
    report.own_preview_database_removed = true;
    await writeFile('docs/order-fields-recovery-qa.json', JSON.stringify(report, null, 2) + '\n');
    console.log(report);
  }
  await pool.end();
}
