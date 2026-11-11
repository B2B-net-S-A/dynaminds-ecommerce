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
  const f = JSON.parse(await readFile('data/amazon-fulfillment-stage080.json', 'utf8')).fixture;
  const liveHealth = await fetch('http://127.0.0.1:4100/api/health');
  assert.equal(liveHealth.status, 200);
  const health = (await liveHealth.json()) as any;
  assert.match(health.revision, /^[a-f0-9]{40}$/);
  process.env.APP_REVISION = health.revision;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/amazon-080-restore' });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  let migrations = 0;
  const tables = [
    'channels',
    'inbound_orders',
    'products',
    'stock',
    'orders',
    'order_items',
    'reservations',
    'order_pick_items',
    'shipments',
    'documents',
    'return_cases',
    'return_items',
    'payment_entries',
    'amazon_fulfillment_plans',
    'amazon_fulfillment_simulations',
    'amazon_fulfillment_scopes',
  ];
  try {
    for (const table of tables)
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
    assert.equal(migrations, 59);
    for (const table of ['amazon_api_buckets', 'amazon_fulfillment_scopes'])
      for (const action of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        assert.equal(
          (await c.query('SELECT has_table_privilege($1,$2,$3) ok', ['dyna_app', table, action]))
            .rows[0].ok,
          false,
        );
    for (const table of ['amazon_fulfillment_plans', 'amazon_fulfillment_simulations']) {
      const row = (
        await c.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      ).rows[0];
      assert(row.relrowsecurity && row.relforcerowsecurity);
    }
    const scopes = (
      await c.query('SELECT * FROM amazon_fulfillment_scopes WHERE plan_id=$1', [f.plan])
    ).rows;
    assert.equal(scopes.length, 1);
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
      if ((await fetch('http://127.0.0.1:4102/api/health')).ok) {
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
  const request = (path: string, method = 'GET', body?: any) =>
    fetch('http://127.0.0.1:4102/api' + path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const order = await request(`/orders/${f.order}`);
  assert.equal(order.status, 200);
  const o = (await order.json()) as any;
  assert.equal(o.status, 'shipped');
  const result = await request(`/orders/${f.order}/amazon-fulfillment`);
  assert.equal(result.status, 200);
  const data = (await result.json()) as any;
  const plan = data.data.find((p: any) => p.id === f.plan);
  assert.equal(plan.state, 'done');
  assert.equal(plan.result.fulfillment.packageStatus.status, 'SHIPPED');
  const ret = await request(`/returns/${f.return_id}`);
  assert.equal(ret.status, 200);
  const openapi = await request('/v1/openapi');
  assert.equal(openapi.status, 200);
  const paths = ((await openapi.json()) as any).paths;
  assert(paths['/orders/{id}/amazon-fulfillment']);
  assert.equal(paths['/orders/{id}/amazon-fulfillment/preview'], undefined);
  const writes: number[] = [];
  for (const path of [
    `/orders/${f.order}/amazon-fulfillment/preview`,
    `/amazon-fulfillment-plans/${f.plan}/queue`,
    `/amazon-fulfillment-plans/${f.plan}/cancel`,
    `/amazon-fulfillment-plans/${f.plan}/reconcile`,
  ]) {
    const r = await request(path, 'POST', {});
    assert.equal(r.status, 423);
    writes.push(r.status);
  }
  const live = await fetch('http://127.0.0.1:4100/api/orders/' + f.order, { headers: { cookie } });
  assert.equal(live.status, 401);
  const report = {
    stage: 80,
    goal_complete: false,
    verified_at: new Date().toISOString(),
    source_revision: restored.revision,
    backup_id: backup.id,
    restore_tables: restored.tables,
    migrations,
    encrypted_records_verified: restored.encrypted_records_verified,
    all_snapshot_rows_verified: true,
    schema_fingerprint_verified: true,
    qa_business_tables_exact: tables.length,
    forced_rls_verified: true,
    limiter_and_global_claims_service_only: true,
    completed_claim_retained: true,
    restored_package_status: plan.result.fulfillment.packageStatus.status,
    preview_read_statuses: [order.status, result.status, ret.status, openapi.status],
    preview_mutation_statuses: writes,
    preview_cookie_on_live_http: live.status,
    worker_enabled: false,
    authenticated_amazon_api_verified: false,
  };
  await writeFile(
    'docs/amazon-fulfillment-recovery-qa.json',
    JSON.stringify(report, null, 2) + '\n',
  );
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
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [database],
      );
      await admin.query(`DROP DATABASE ${database}`);
    } finally {
      await admin.end();
    }
  }
  await pool.end();
}
