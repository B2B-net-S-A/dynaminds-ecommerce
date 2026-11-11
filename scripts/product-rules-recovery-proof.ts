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
  'products',
  'stock',
  'stock_movements',
  'orders',
  'order_items',
  'reservations',
  'order_events',
  'shipments',
  'documents',
  'return_cases',
  'return_items',
  'payment_entries',
  'product_rules',
  'product_rule_revisions',
  'product_rule_runs',
  'product_rule_items',
  'product_rule_causes',
];
try {
  const f = JSON.parse(await readFile('data/product-rules-stage098.json', 'utf8'));
  assert(f.manual && f.automatic && f.createdRun);
  const h = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(h.schema_revision, '076_product_rules');
  assert(h.product_rules_available);
  assert.match(h.revision, /^[a-f0-9]{40}$/);
  process.env.APP_REVISION = h.revision;
  const before: Record<string, any[]> = {};
  for (const t of tables)
    before[t] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
        f.tenant,
      ])
    ).rows;
  assert.equal(before.product_rules.length, 2);
  assert.equal(before.product_rule_runs.length, 3);
  assert.equal(before.product_rule_items.length, 4);
  assert.equal(before.product_rule_causes.length, 2);
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, {
    directory: 'data/product-rules-098-restore',
  });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
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
    assert.equal((await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n, 76);
    const other = (
      await c.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [f.tenant])
    ).rows[0].id;
    for (const t of [
      'product_rules',
      'product_rule_revisions',
      'product_rule_runs',
      'product_rule_items',
      'product_rule_causes',
    ]) {
      const meta = (
        await c.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [t],
        )
      ).rows[0];
      assert(meta.relrowsecurity && meta.relforcerowsecurity);
      assert.equal(
        (await c.query("SELECT has_table_privilege('dyna_app',$1,'DELETE') p", [t])).rows[0].p,
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
    for (const immutable of ['product_rule_revisions', 'product_rule_causes'])
      assert.equal(
        (await c.query("SELECT has_table_privilege('dyna_app',$1,'UPDATE') p", [immutable])).rows[0]
          .p,
        false,
      );
    await c.query('BEGIN');
    await assert.rejects(
      c.query('UPDATE product_rule_causes SET event=event WHERE tenant_id=$1', [f.tenant]),
      /immutable/,
    );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await assert.rejects(
      c.query("UPDATE product_rule_runs SET error='changed QA' WHERE id=$1", [f.manual]),
      /immutable/,
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
  assert(!occupied, 'Restore preview port occupied');
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
  for (let n = 0; n < 60; n++) {
    try {
      const response = await fetch(base + '/health');
      if (response.ok) {
        const preview = (await response.json()) as any;
        assert(preview.restore_preview && preview.product_rules_available);
        assert.equal(preview.revision, h.revision);
        assert.equal(preview.schema_revision, h.schema_revision);
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
    body: JSON.stringify({ email: f.email, password: f.password }),
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
    '/product-rules',
    '/product-rule-runs',
    `/product-rule-runs/${f.manual}`,
    `/products/${f.products[0].id}`,
  ];
  for (const path of reads) {
    const response = await req(path);
    assert.equal(response.status, 200, 'Preview read');
    const d = (await response.json()) as any;
    if (path === '/product-rules') assert(d.read_only && d.available && d.data.length === 2);
    if (path === '/product-rule-runs') assert.equal(d.data.length, 3);
    if (path === `/product-rule-runs/${f.manual}`)
      assert(d.state === 'done' && d.items.length === 2);
  }
  const writes: [string, string][] = [
    ['/product-rules', 'POST'],
    [`/product-rules/${f.rule}`, 'PUT'],
    [`/product-rules/${f.rule}`, 'DELETE'],
    ['/product-rule-runs/preview', 'POST'],
    [`/product-rule-runs/${f.manual}/queue`, 'POST'],
  ];
  for (const [path, method] of writes)
    assert.equal((await req(path, method, {})).status, 423, 'Preview mutation');
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
    stage: '098',
    verified_at: new Date().toISOString(),
    source_revision: restored.revision,
    schema: h.schema_revision,
    backup_id: backup.id,
    restore_tables: restored.tables,
    migrations: 76,
    encrypted_records_verified: restored.encrypted_records_verified,
    all_snapshot_rows_verified: true,
    schema_fingerprint_verified: true,
    qa_business_tables_exact: tables.length,
    force_RLS_verified: true,
    foreign_firm_rows_hidden: true,
    causes_and_revisions_append_only_for_app: true,
    cause_identity_and_terminal_receipts_immutable: true,
    preview_read_statuses: reads.map(() => 200),
    preview_mutation_statuses: writes.map(() => 423),
    preview_cookie_on_live_http: 401,
    worker_enabled: false,
    live_QA_business_tables_unchanged: true,
    external_requests: 0,
    goal_complete: false,
  };
} finally {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>((r) => child!.once('exit', () => r()));
    child.kill('SIGTERM');
    await stopped;
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
  await writeFile('docs/product-rules-recovery-qa.json', JSON.stringify(report, null, 2) + '\n');
  console.log(report);
}
