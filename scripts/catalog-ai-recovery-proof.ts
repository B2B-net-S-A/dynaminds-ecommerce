// Drops only the isolated restore database created by this invocation.
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
  'ai_catalog_drafts',
  'product_translations',
];
async function snapshot(c: pg.Client | pg.Pool, tenant: string) {
  const result: any = {};
  for (const t of tables)
    result[t] = (
      await c.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [tenant])
    ).rows;
  result.tenants = (
    await c.query('SELECT to_jsonb(t) row FROM tenants t WHERE id=$1', [tenant])
  ).rows;
  return result;
}
let child: ReturnType<typeof spawn> | undefined, database: string | undefined, report: any;
try {
  const f = JSON.parse(await readFile('data/catalog-ai-stage092.json', 'utf8'));
  assert(f.completed_at);
  const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(health.schema_revision, '070_catalog_ai');
  assert.match(health.revision, /^[a-f0-9]{40}$/);
  process.env.APP_REVISION = health.revision;
  const before = await snapshot(pool, f.tenant);
  assert.equal(before.ai_catalog_drafts.length, 4);
  assert(
    before.ai_catalog_drafts
      .filter((x: any) => x.row.state === 'applied')
      .every((x: any) => x.row.state === 'applied' && x.row.output && x.row.reviewed_text),
  );
  assert.equal(before.product_translations.length, 1);
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, { directory: 'data/catalog-ai-092-restore' });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  let migrations = 0;
  try {
    assert.deepEqual(await snapshot(c, f.tenant), before);
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 70);
    const other = (
      await c.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [f.tenant])
    ).rows[0].id;
    for (const t of ['ai_catalog_drafts', 'product_translations']) {
      const meta = (
        await c.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [t],
        )
      ).rows[0];
      assert(meta.relrowsecurity && meta.relforcerowsecurity);
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE'])
        assert.equal(
          (await c.query("SELECT has_table_privilege('dyna_app',$1,$2) allowed", [t, privilege]))
            .rows[0].allowed,
          true,
        );
      assert.equal(
        (await c.query("SELECT has_table_privilege('dyna_app',$1,'DELETE') allowed", [t])).rows[0]
          .allowed,
        false,
      );
    }
    const fn = (
      await c.query(
        "SELECT prosecdef,proconfig,has_function_privilege('dyna_app',oid,'EXECUTE') allowed FROM pg_proc WHERE oid='catalog_ai_pending_count()'::regprocedure",
      )
    ).rows[0];
    assert(fn.prosecdef && fn.allowed && fn.proconfig.includes('search_path=pg_catalog, public'));
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [other]);
    for (const t of ['ai_catalog_drafts', 'product_translations'])
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`, [f.tenant])).rows[0]
          .n,
        0,
      );
    await c.query('ROLLBACK');
    for (const change of [
      "source='{}'::jsonb",
      "output='{}'::jsonb",
      "reviewed_text='{}'::jsonb",
      "state='ready'",
    ]) {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
      await assert.rejects(
        c.query(`UPDATE ai_catalog_drafts SET ${change} WHERE id=$1`, [
          before.ai_catalog_drafts.find((d: any) => d.row.state === 'applied').row.id,
        ]),
        /immutable/,
      );
      await c.query('ROLLBACK');
    }
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
      env: { ...process.env, DYNA_PREVIEW_PORT: '4102', DYNA_AI_URL: 'http://127.0.0.1:1' },
      stdio: 'ignore',
    },
  );
  const base = 'http://127.0.0.1:4102/api';
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) {
        const h = (await r.json()) as any;
        assert(h.restore_preview);
        assert.equal(h.schema_revision, health.schema_revision);
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
  const runtime = await req('/ai/catalog/runtime');
  assert.equal(runtime.status, 200);
  const rt = (await runtime.json()) as any;
  assert.equal(rt.generation_allowed, false);
  assert.equal(rt.read_only, true);
  assert.deepEqual(rt.models, []);
  const history = await req('/products/' + f.product + '/ai');
  assert.equal(history.status, 200);
  const hist = (await history.json()) as any;
  assert.deepEqual(
    hist.data.map((d: any) => d.id).sort(),
    before.ai_catalog_drafts.map((d: any) => d.row.id).sort(),
  );
  assert.equal(hist.data.filter((d: any) => d.state === 'applied').length, 2);
  assert.equal(hist.data.filter((d: any) => d.state === 'cancelled').length, 2);
  assert.equal(hist.translations.length, 1);
  const product = await req('/products/' + f.product);
  assert.equal(product.status, 200);
  assert.deepEqual(await product.json(), f.final_product);
  const order = await req('/orders/' + f.order);
  assert.equal(order.status, 200);
  assert.deepEqual(await order.json(), f.final_order);
  const ret = await req('/returns/' + f.return_id);
  assert.equal(ret.status, 200);
  assert.equal(((await ret.json()) as any).state, 'refund_pending');
  const id = hist.data[0].id;
  for (const path of [
    '/products/' + f.product + '/ai',
    '/ai/catalog/drafts/' + id + '/apply',
    '/ai/catalog/drafts/' + id + '/cancel',
  ])
    assert.equal((await req(path, 'POST', {})).status, 423, path);
  assert.equal(
    (await fetch('http://127.0.0.1:4100/api/auth/me', { headers: { cookie } })).status,
    401,
  );
  assert.deepEqual(await snapshot(pool, f.tenant), before);
  report = {
    stage: 92,
    verified_at: new Date().toISOString(),
    source_revision: restored.revision,
    schema: health.schema_revision,
    backup_id: backup.id,
    restore_tables: restored.tables,
    migrations,
    encrypted_records_verified: restored.encrypted_records_verified,
    all_snapshot_rows_verified: true,
    schema_fingerprint_verified: true,
    qa_business_tables_exact: tables.length + 1,
    AI_source_generated_reviewed_digest_usage_translation_exact: true,
    FORCE_RLS_verified: true,
    foreign_firm_hidden: true,
    no_app_DELETE: true,
    immutable_applied_history_verified: true,
    global_counter_security_definer_restored: true,
    preview_read_statuses: [200, 200, 200, 200, 200],
    preview_mutation_statuses: [423, 423, 423],
    preview_cookie_on_live_http: 401,
    preview_AI_disabled_without_engine: true,
    worker_enabled: false,
    live_QA_business_tables_unchanged: true,
    model_weights_in_backup: false,
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
  await writeFile('data/catalog-ai-recovery-qa.json', JSON.stringify(report, null, 2) + '\n');
  console.log(report);
}
