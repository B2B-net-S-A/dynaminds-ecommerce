// Only this invocation's isolated restore database is removed.
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
  'channels',
  'products',
  'stock',
  'stock_movements',
  'orders',
  'order_items',
  'reservations',
  'order_pick_items',
  'order_events',
  'shipments',
  'documents',
  'return_cases',
  'return_items',
  'payment_entries',
  'warehouses',
  'memberships',
  'workspace_usage',
  'order_status_configs',
  'order_status_plans',
  'order_status_simulations',
  'prestashop_status_claims',
];
let child: ReturnType<typeof spawn> | undefined, database: string | undefined, report: any;
try {
  const f = JSON.parse(await readFile('data/prestashop-stage091.json', 'utf8'));
  assert(f.returned_at);
  const h = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(h.schema_revision, '069_prestashop_status');
  assert.match(h.revision, /^[a-f0-9]{40}$/);
  process.env.APP_REVISION = h.revision;
  const before: any = {};
  for (const t of tables)
    before[t] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
        f.tenant,
      ])
    ).rows;
  before.tenants = (
    await pool.query('SELECT to_jsonb(t) row FROM tenants t WHERE id=$1', [f.tenant])
  ).rows;
  assert.equal(before.order_status_plans.filter((p: any) => p.row.state === 'done').length, 2);
  assert.equal(before.order_status_configs[0].row.enabled, false);
  assert.equal(before.prestashop_status_claims.length, 1);
  assert.equal(before.order_status_simulations[0].row.status, '5');
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, { directory: 'data/prestashop-091-restore' });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  let migrations = 0;
  try {
    for (const t of tables)
      assert.deepEqual(
        (
          await c.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
            f.tenant,
          ])
        ).rows,
        before[t],
        t,
      );
    assert.deepEqual(
      (await c.query('SELECT to_jsonb(t) row FROM tenants t WHERE id=$1', [f.tenant])).rows,
      before.tenants,
    );
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 69);
    const other = (
      await c.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [f.tenant])
    ).rows[0].id;
    const t = 'prestashop_status_claims';
    const meta = (
      await c.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        [t],
      )
    ).rows[0];
    assert(meta.relrowsecurity && meta.relforcerowsecurity);
    assert.equal(
      (await c.query("SELECT has_table_privilege('dyna_app',$1,'SELECT') allowed", [t])).rows[0]
        .allowed,
      true,
    );
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE'])
      assert.equal(
        (await c.query("SELECT has_table_privilege('dyna_app',$1,$2) allowed", [t, privilege]))
          .rows[0].allowed,
        false,
      );
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [other]);
    assert.equal(
      (
        await c.query('SELECT count(*)::int n FROM prestashop_status_claims WHERE tenant_id=$1', [
          f.tenant,
        ])
      ).rows[0].n,
      0,
    );
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }
  let occupied = false;
  try {
    await fetch('http://127.0.0.1:4102/api/health');
    occupied = true;
  } catch {}
  assert(!occupied, 'Preview port 4102 occupied');
  child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/restore-preview.ts',
      '--result',
      restored.directory + '/result.json',
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DYNA_PREVIEW_PORT: '4102' },
      stdio: 'ignore',
    },
  );
  const base = 'http://127.0.0.1:4102/api';
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) {
        const x = (await r.json()) as any;
        assert(x.restore_preview);
        assert.equal(x.schema_revision, h.schema_revision);
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) throw Error('Preview exited');
    await setTimeout(200);
  }
  assert(ready);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: f.email, password: f.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert(cookie.startsWith('dyna_session_preview_4102='));
  const req = (path: string, method = 'GET', body?: any) =>
    fetch(base + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const history = await req('/orders/' + f.order + '/channel-status');
  assert.equal(history.status, 200);
  const hs = (await history.json()) as any;
  assert.equal(hs.data.filter((p: any) => p.state === 'done').length, 2);
  assert.equal(hs.config.enabled, false);
  assert.equal(hs.target, null);
  assert.deepEqual(
    hs.data.map((p: any) => p.remote.ps_target_state).sort(),
    before.order_status_plans.map((p: any) => p.row.remote.ps_target_state).sort(),
  );
  const config = await req('/integrations/' + f.channel + '/order-status');
  assert.equal(config.status, 200);
  const cfg = (await config.json()) as any;
  assert.deepEqual(cfg.mappings, before.channels[0].row.settings.status_mappings);
  const order = await req('/orders/' + f.order);
  assert.equal(order.status, 200);
  assert.deepEqual(await order.json(), f.after_return);
  const ret = await req('/returns/' + f.return_id);
  assert.equal(ret.status, 200);
  assert.equal(((await ret.json()) as any).state, 'refund_pending');
  const plan = before.order_status_plans[0].row.id;
  const writes: [string, string, any][] = [
    ['/orders/' + f.order + '/channel-status/preview', 'POST', {}],
    ['/channel-status-plans/' + plan + '/queue', 'POST', {}],
    ['/channel-status-plans/' + plan + '/cancel', 'POST', {}],
    ['/channel-status-plans/' + plan + '/reconcile', 'POST', {}],
    [
      '/integrations/' + f.channel + '/order-status',
      'PATCH',
      { version: hs.config.version, enabled: true, confirm_external: true, mappings: cfg.mappings },
    ],
  ];
  for (const [path, method, body] of writes)
    assert.equal((await req(path, method, body)).status, 423, path);
  assert.equal(
    (await fetch('http://127.0.0.1:4100/api/auth/me', { headers: { cookie } })).status,
    401,
  );
  for (const t of tables)
    assert.deepEqual(
      (
        await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
          f.tenant,
        ])
      ).rows,
      before[t],
      t + ' live unchanged',
    );
  assert.deepEqual(
    (await pool.query('SELECT to_jsonb(t) row FROM tenants t WHERE id=$1', [f.tenant])).rows,
    before.tenants,
  );
  report = {
    stage: 91,
    verified_at: new Date().toISOString(),
    source_revision: restored.revision,
    schema: h.schema_revision,
    backup_id: backup.id,
    restore_tables: restored.tables,
    migrations,
    encrypted_records_verified: restored.encrypted_records_verified,
    all_snapshot_rows_verified: true,
    schema_fingerprint_verified: true,
    qa_business_tables_exact: tables.length + 1,
    status_history_mapping_and_claim_exact: true,
    FORCE_RLS_verified: true,
    foreign_firm_hidden: true,
    app_role_SELECT_only: true,
    preview_read_statuses: [200, 200, 200, 200],
    preview_mutation_statuses: [423, 423, 423, 423, 423],
    preview_cookie_on_live_http: 401,
    worker_enabled: false,
    live_QA_business_tables_unchanged: true,
    provider_account_verified: false,
    actual_external_writes: false,
    goal_complete: false,
  };
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((r) => child!.once('exit', () => r()));
    child.kill('SIGTERM');
    await exited;
  }
  if (database) {
    await pool.query('DROP DATABASE ' + database + ' WITH (FORCE)');
    assert.equal(
      (await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount,
      0,
    );
    if (report) report.owned_restore_removed = true;
  }
  await pool.end();
}
if (report) {
  await writeFile(
    'data/prestashop-status-recovery-qa.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(report);
}
