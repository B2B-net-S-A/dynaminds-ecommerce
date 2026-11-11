// Restore only this invocation's encrypted backup; remove only its disposable preview DB.
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
  'shopify_account_bindings',
  'shopify_oauth_states',
  'products',
  'product_translations',
  'deepl_catalog_drafts',
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
  'shopify_translation_plans',
  'shopify_translation_observations',
  'shopify_translation_simulations',
];
const moduleTables = [
  'shopify_translation_plans',
  'shopify_translation_observations',
  'shopify_translation_simulations',
];
try {
  const f = JSON.parse(await readFile('data/shopify-stage095b.json', 'utf8'));
  assert(f.plan && f.finalOrder);
  const h = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(h.schema_revision, '073_shopify_translations');
  assert(h.shopify_translations_available);
  assert.match(h.revision, /^[a-f0-9]{40}$/);
  process.env.APP_REVISION = h.revision;
  const before: any = {};
  for (const t of tables)
    before[t] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
        f.tenant,
      ])
    ).rows;
  assert.equal(before.shopify_translation_plans.length, 3);
  assert.equal(before.shopify_translation_observations.length, 3);
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/shopify-095b-restore' });
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
    assert.equal(migrations, 73);
    const other = (
      await c.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [f.tenant])
    ).rows[0].id;
    for (const t of moduleTables) {
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
    for (const sql of [
      "UPDATE shopify_translation_plans SET spec='{}' WHERE id=$1",
      'UPDATE shopify_translation_plans SET attempted_at=NULL WHERE id=$1',
      "UPDATE shopify_translation_plans SET state='preview' WHERE id=$1",
    ]) {
      await c.query('BEGIN');
      await assert.rejects(c.query(sql, [f.plan]), /immutable/);
      await c.query('ROLLBACK');
    }
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      assert.equal(
        (
          await c.query(
            "SELECT has_table_privilege('dyna_app','shopify_translation_claims',$1) allowed",
            [privilege],
          )
        ).rows[0].allowed,
        false,
      );
    for (const privilege of ['UPDATE', 'DELETE'])
      assert.equal(
        (
          await c.query(
            "SELECT has_table_privilege('dyna_app','shopify_translation_observations',$1) allowed",
            [privilege],
          )
        ).rows[0].allowed,
        false,
      );
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
    { cwd: process.cwd(), env: { ...process.env, DYNA_PREVIEW_PORT: '4102' }, stdio: 'ignore' },
  );
  const base = 'http://127.0.0.1:4102/api';
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) {
        const p = (await r.json()) as any;
        assert(p.restore_preview && p.shopify_translations_available);
        assert.equal(p.revision, h.revision);
        assert.equal(p.schema_revision, h.schema_revision);
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
  const req = (p: string, m = 'GET', b?: any) =>
    fetch(base + p, {
      method: m,
      headers: { cookie, 'Content-Type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
  const reads = [
    `/products/${f.product.id}/shopify-translations`,
    `/shopify-translation-plans/${f.plan}`,
    `/products/${f.product.id}`,
    `/orders/${f.order}`,
    `/returns/${f.return_id}`,
  ];
  for (const path of reads) {
    const r = await req(path);
    assert.equal(r.status, 200, path);
    const d = (await r.json()) as any;
    if (path.endsWith('/shopify-translations')) {
      assert(d.read_only && d.available);
      assert.equal(d.data.length, 3);
    }
    if (path.includes('/shopify-translation-plans/')) {
      assert(d.read_only && d.result.confirmed);
      assert.equal(d.observations.length, 2);
    }
    if (path === `/orders/${f.order}`) assert.deepEqual(d, f.finalOrder);
  }
  const posts = [
    `/products/${f.product.id}/shopify-translations/preview`,
    ...['queue', 'cancel', 'reconcile', 'acknowledge'].map(
      (x) => `/shopify-translation-plans/${f.plan}/${x}`,
    ),
  ];
  for (const p of posts) assert.equal((await req(p, 'POST', {})).status, 423, p);
  assert.equal((await req(`/integrations/${f.channel}/shopify-locales`)).status, 423);
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
    stage: '095b',
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
    immutable_scope_attempts_and_terminal_evidence: true,
    observations_append_only: true,
    claims_owner_only: true,
    DELETE_not_granted: true,
    preview_read_statuses: reads.map(() => 200),
    preview_mutation_statuses: posts.map(() => 423),
    provider_locale_read_status: 423,
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
    'docs/shopify-translation-publication-recovery-qa.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(report);
}
