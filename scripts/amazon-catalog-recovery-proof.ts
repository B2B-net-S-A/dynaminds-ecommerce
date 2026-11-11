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
let child: ReturnType<typeof spawn> | undefined, database: string | undefined;
try {
  const f = JSON.parse(await readFile('data/amazon-catalog-stage074.json', 'utf8')).fixture;
  const runtime = await fetch('http://127.0.0.1:4100/api/health');
  assert.equal(runtime.status, 200);
  const health = (await runtime.json()) as any;
  assert.match(health.revision, /^[a-f0-9]{40}$/);
  process.env.APP_REVISION = health.revision;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/amazon-074-restore' });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  let migrations = 0;
  try {
    for (const table of [
      'channels',
      'inbound_orders',
      'listings',
      'products',
      'stock',
      'orders',
      'order_items',
      'reservations',
      'documents',
      'shipments',
      'return_cases',
      'return_items',
      'payment_entries',
      'catalog_source_runs',
      'catalog_source_items',
      'purchase_orders',
      'purchase_order_lines',
    ])
      assert.deepEqual(
        (
          await c.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
            f.tenant,
          ])
        ).rows,
        (
          await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
            f.tenant,
          ])
        ).rows,
      );
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 53);
    for (const action of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      assert.equal(
        (
          await c.query('SELECT has_table_privilege($1,$2,$3) allowed', [
            'dyna_app',
            'amazon_api_buckets',
            action,
          ])
        ).rows[0].allowed,
        false,
      );
  } finally {
    await c.end();
  }
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
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try {
      const r = await fetch('http://127.0.0.1:4102/api/health');
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await setTimeout(100);
  }
  assert(ready);
  const login = await fetch('http://127.0.0.1:4102/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.email, password: f.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const order = await fetch('http://127.0.0.1:4102/api/orders/' + f.order, { headers: { cookie } });
  assert.equal(order.status, 200);
  assert.equal(((await order.json()) as any).status, 'return_completed');
  const catalog = await fetch(
    'http://127.0.0.1:4102/api/catalog-source-runs/' + (f.refresh_run ?? f.run) + '?limit=100',
    { headers: { cookie } },
  );
  assert.equal(catalog.status, 200);
  const catalogBody = (await catalog.json()) as any;
  assert.equal(catalogBody.run.state, 'ready');
  assert.equal(catalogBody.data.length, 4);
  assert(catalogBody.data.every((r: any) => r.state === 'applied'));
  if (f.refresh_run) assert(catalogBody.data.every((r: any) => r.source.amazon.attributes.color));
  const blocked = await fetch(
    'http://127.0.0.1:4102/api/integrations/' + f.channel + '/stage-orders',
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{"data":[]}',
    },
  );
  assert.equal(blocked.status, 423);
  const live = await fetch('http://127.0.0.1:4100/api/orders/' + f.order, { headers: { cookie } });
  assert.equal(live.status, 401);
  const report = {
    stage: 74,
    goal_complete: false,
    verified_at: new Date().toISOString(),
    source_revision: restored.revision,
    backup_id: backup.id,
    restore_tables: restored.tables,
    migrations,
    encrypted_records_verified: restored.encrypted_records_verified,
    all_snapshot_rows_verified: true,
    schema_rls_grants_verified: true,
    qa_business_tables_exact: 17,
    amazon_limiter_service_only: true,
    preview_order_status: 'return_completed',
    preview_catalog_applied: 4,
    preview_catalog_http: 200,
    preview_read_http: 200,
    preview_mutation_http: 423,
    preview_cookie_on_live_http: 401,
    worker_enabled: false,
    authenticated_amazon_api_verified: false,
  };
  await writeFile('docs/amazon-catalog-recovery-qa.json', JSON.stringify(report, null, 2) + '\n');
  console.log(report);
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((r) => child!.once('exit', r));
  }
  if (database) {
    const admin = new pg.Client({ ...localDatabase(), database: 'postgres' });
    await admin.connect();
    try {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [
        database,
      ]);
      await admin.query(`DROP DATABASE ${restoreDatabaseName(database)}`);
    } finally {
      await admin.end();
    }
  }
  await pool.end();
}
