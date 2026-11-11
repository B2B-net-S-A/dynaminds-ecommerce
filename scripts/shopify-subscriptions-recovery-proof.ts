// Encrypted local backup/restore proof. Removes only the restore DB created by this invocation.
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
let child: ReturnType<typeof spawn> | undefined, database: string | undefined, report: any;
const tables = [
  'channels',
  'inbound_orders',
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
  'jobs',
  'shopify_webhook_configs',
  'shopify_webhook_deliveries',
  'shopify_webhook_simulations',
  'shopify_subscription_plans',
  'shopify_subscription_observations',
  'shopify_subscription_simulations',
];
try {
  const f = JSON.parse(await readFile('data/shopify-stage089.json', 'utf8')),
    h = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(h.schema_revision, '067_shopify_subscriptions');
  assert(h.shopify_webhooks_available);
  assert.match(h.revision, /^[a-f0-9]{40}$/);
  process.env.APP_REVISION = h.revision;
  const before: any = {};
  for (const t of tables)
    before[t] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
        f.tenant,
      ])
    ).rows;
  assert.equal(before.shopify_webhook_configs.length, 1);
  assert.equal(before.shopify_webhook_deliveries.length, 2);
  assert(before.shopify_webhook_deliveries.every((d: any) => d.row.outcome === 'processed'));
  assert.equal(before.shopify_subscription_plans.length, 4);
  assert(before.shopify_subscription_plans.every((p: any) => p.row.state === 'done'));
  assert.equal(before.documents.length, 2);
  assert.equal(before.return_cases.length, 1);
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/shopify-089-restore' });
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
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 67);
    const other = (
      await c.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [f.tenant])
    ).rows[0].id;
    for (const t of [
      'shopify_webhook_configs',
      'shopify_webhook_deliveries',
      'shopify_webhook_simulations',
      'shopify_subscription_plans',
      'shopify_subscription_observations',
      'shopify_subscription_simulations',
    ]) {
      const meta = (
        await c.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [t],
        )
      ).rows[0];
      assert(meta.relrowsecurity && meta.relforcerowsecurity);
      assert.equal(
        (await c.query("SELECT has_table_privilege('dyna_app',$1,'DELETE') allowed", [t])).rows[0]
          .allowed,
        false,
      );
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [other]);
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`, [f.tenant])).rows[0]
          .n,
        0,
      );
      await c.query('ROLLBACK');
    }
    await c.query('BEGIN');
    await assert.rejects(
      c.query("UPDATE shopify_webhook_deliveries SET topic='orders/updated' WHERE id=$1", [
        f.first_delivery,
      ]),
      /immutable/,
    );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await assert.rejects(
      c.query("UPDATE shopify_subscription_plans SET spec='{}' WHERE id=$1", [
        before.shopify_subscription_plans[0].row.id,
      ]),
      /immutable/,
    );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await assert.rejects(
      c.query('UPDATE shopify_subscription_plans SET attempted_at=NULL WHERE id=$1', [
        before.shopify_subscription_plans[0].row.id,
      ]),
      /cannot be reset/,
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
    { cwd: process.cwd(), env: { ...process.env, DYNA_PREVIEW_PORT: '4102' }, stdio: 'ignore' },
  );
  const base = 'http://127.0.0.1:4102/api';
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) {
        const health = (await r.json()) as any;
        assert(health.restore_preview && health.shopify_webhooks_available);
        assert.equal(health.schema_revision, h.schema_revision);
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) throw Error('Restore preview exited');
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
  const history = await req(`/integrations/${f.channel}/shopify-webhooks`);
  assert.equal(history.status, 200);
  const data = (await history.json()) as any;
  assert.equal(data.deliveries.length, 2);
  assert(data.deliveries.every((d: any) => d.outcome === 'processed'));
  assert(!JSON.stringify(data).includes('signing_secret"'));
  const order = await req(`/orders/${f.order}`);
  assert.equal(order.status, 200);
  assert.equal(((await order.json()) as any).status, 'return_received');
  const imports = await req(`/integrations/${f.channel}/imports`);
  assert.equal(imports.status, 200);
  assert(((await imports.json()) as any).data[0].source_changed);
  const ret = await req(`/returns/${f.return_id}`);
  assert.equal(ret.status, 200);
  assert.equal(((await ret.json()) as any).state, 'refund_pending');
  const subHistory = await req(`/integrations/${f.channel}/shopify-subscriptions`);
  assert.equal(subHistory.status, 200);
  const subs = (await subHistory.json()) as any;
  assert.equal(subs.plans.length, 4);
  assert.equal(subs.observation.data.length, 2);
  const subPlan = subs.plans[0].id;
  for (const path of [
    `/integrations/${f.channel}/shopify-subscriptions/read`,
    `/integrations/${f.channel}/shopify-subscriptions/preview`,
    `/shopify-subscription-plans/${subPlan}/queue`,
    `/shopify-subscription-plans/${subPlan}/cancel`,
    `/shopify-subscription-plans/${subPlan}/reconcile`,
  ])
    assert.equal((await req(path, 'POST', {})).status, 423);
  const mutations = [
    `/webhooks/shopify/${f.channel}`,
    `/integrations/${f.channel}/shopify-webhooks`,
    `/integrations/${f.channel}/shopify-webhooks/example`,
    `/shopify-webhook-deliveries/${f.first_delivery}/retry`,
  ];
  for (const [i, path] of mutations.entries())
    assert.equal((await req(path, i === 1 ? 'PATCH' : 'POST', {})).status, 423);
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
  report = {
    stage: 89,
    verified_at: new Date().toISOString(),
    source_revision: restored.revision,
    schema: h.schema_revision,
    backup_id: backup.id,
    restore_tables: restored.tables,
    migrations,
    encrypted_records_verified: restored.encrypted_records_verified,
    all_snapshot_rows_verified: true,
    schema_fingerprint_verified: true,
    qa_business_tables_exact: tables.length,
    force_RLS_verified: true,
    foreign_firm_rows_hidden: true,
    receipt_metadata_immutable: true,
    subscription_plans_and_attempts_immutable: true,
    subscription_registry_exact: true,
    DELETE_not_granted: true,
    webhook_secret_restored_and_validated: true,
    invoice_return_and_source_change_preserved: true,
    preview_read_statuses: [200, 200, 200, 200, 200],
    preview_mutation_statuses: [423, 423, 423, 423, 423, 423, 423, 423, 423],
    preview_cookie_on_live_http: 401,
    worker_enabled: false,
    live_QA_business_tables_unchanged: true,
    provider_account_verified: false,
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
    'data/shopify-subscriptions-recovery-qa.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(report);
}
