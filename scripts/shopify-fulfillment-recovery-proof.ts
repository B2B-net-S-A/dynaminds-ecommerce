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
  'shopify_fulfillment_plans',
  'shopify_fulfillment_simulations',
  'shopify_fulfillment_scopes',
];
try {
  const f = JSON.parse(await readFile('data/shopify-stage085.json', 'utf8')),
    h = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(h.schema_revision, '064_shopify_fulfillment');
  assert(h.shopify_fulfillment_available);
  assert.match(h.revision, /^[a-f0-9]{40}$/);
  process.env.APP_REVISION = h.revision;
  const before: any = {};
  for (const t of tables)
    before[t] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
        f.tenant,
      ])
    ).rows;
  assert.equal(before.shopify_fulfillment_plans.length, 1);
  assert.equal(before.shopify_fulfillment_plans[0].row.state, 'done');
  assert.equal(before.shopify_fulfillment_scopes.length, 1);
  assert.equal(before.shopify_fulfillment_simulations.length, 1);
  assert.equal(before.documents.length, 2);
  assert.equal(before.return_cases.length, 1);
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/shopify-085-restore' });
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
    assert.equal(migrations, 64);
    for (const grant of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      assert.equal(
        (
          await c.query(
            "SELECT has_table_privilege('dyna_app','shopify_fulfillment_scopes',$1) allowed",
            [grant],
          )
        ).rows[0].allowed,
        false,
      );
    for (const t of ['shopify_fulfillment_plans', 'shopify_fulfillment_simulations']) {
      const meta = (
        await c.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [t],
        )
      ).rows[0];
      assert(meta.relrowsecurity && meta.relforcerowsecurity);
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id<>$1`, [f.tenant])).rows[0]
          .n,
        0,
      );
      await c.query('ROLLBACK');
    }
    assert.equal(
      (
        await c.query(
          "SELECT has_table_privilege('dyna_app','shopify_fulfillment_plans','DELETE') allowed",
        )
      ).rows[0].allowed,
      false,
    );
    for (const sql of [
      "UPDATE shopify_fulfillment_plans SET payload=jsonb_set(payload,'{fulfillment,notifyCustomer}','true') WHERE id=$1",
      "UPDATE shopify_fulfillment_plans SET phase='ready' WHERE id=$1",
    ]) {
      await c.query('BEGIN');
      await assert.rejects(c.query(sql, [f.plan]), /immutable|cannot be reset/);
      await c.query('ROLLBACK');
    }
    const other = (
      await c.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [f.tenant])
    ).rows[0].id;
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [other]);
    assert.equal(
      (await c.query('SELECT shopify_fulfillment_scope($1) scope', [f.plan])).rows[0].scope,
      null,
    );
    assert.equal(
      (await c.query('SELECT shopify_fulfillment_claim($1) claim', [f.plan])).rows[0].claim,
      false,
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
  assert(!occupied, 'Preview port 4102 already occupied');
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
        assert(health.restore_preview && health.shopify_fulfillment_available);
        assert.equal(health.schema_revision, h.schema_revision);
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) throw Error('Restore preview exited before health');
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
  const request = (path: string, method = 'GET', body?: any) =>
    fetch(base + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const order = await request('/orders/' + f.order);
  assert.equal(order.status, 200);
  assert.equal(((await order.json()) as any).status, 'return_received');
  const history = await request('/orders/' + f.order + '/shopify-fulfillment');
  assert.equal(history.status, 200);
  const p = ((await history.json()) as any).data[0],
    original = before.shopify_fulfillment_plans[0].row;
  assert.equal(p.id, f.plan);
  assert.equal(p.state, 'done');
  assert.deepEqual(p.payload, original.payload);
  assert.deepEqual(p.result, original.result);
  assert.equal(p.remote_id, original.remote_id);
  const ret = await request('/returns/' + f.return_id);
  assert.equal(ret.status, 200);
  assert.equal(((await ret.json()) as any).state, 'refund_pending');
  const openapi = await request('/v1/openapi');
  assert.equal(openapi.status, 200);
  const paths = ((await openapi.json()) as any).paths;
  assert(paths['/orders/{id}/shopify-fulfillment']);
  assert.equal(paths['/orders/{id}/shopify-fulfillment/preview'], undefined);
  for (const path of [
    '/orders/' + f.order + '/shopify-fulfillment/preview',
    '/shopify-fulfillment-plans/' + f.plan + '/queue',
    '/shopify-fulfillment-plans/' + f.plan + '/cancel',
    '/shopify-fulfillment-plans/' + f.plan + '/reconcile',
  ])
    assert.equal((await request(path, 'POST', {})).status, 423);
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
    stage: 85,
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
    global_claim_service_only: true,
    foreign_claim_rejected: true,
    completed_claim_retained: true,
    frozen_payload_preserved: true,
    write_restart_rejected: true,
    invoice_and_return_preserved: true,
    preview_read_statuses: [order.status, history.status, ret.status, openapi.status],
    preview_mutation_statuses: [423, 423, 423, 423],
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
    'data/shopify-fulfillment-recovery-qa.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(report);
}
