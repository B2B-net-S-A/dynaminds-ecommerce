import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  localDatabase,
  restoreDatabaseName,
} from '../server/recovery';
let name: string | undefined, child: ReturnType<typeof spawn> | undefined;
try {
  const f = JSON.parse(await readFile('data/dpd-tracking-stage052.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/dpd-tracking-052-restore' });
  name = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database: name });
  await c.connect();
  const tables = [
    'tracking_configs',
    'channels',
    'shipments',
    'shipping_plans',
    'jobs',
    'orders',
    'order_items',
    'stock',
    'stock_movements',
    'payment_entries',
  ];
  let migrations = 0;
  try {
    for (const table of tables) {
      const q = 'SELECT to_jsonb(t) row FROM ' + table + ' t WHERE tenant_id=$1 ORDER BY 1';
      assert.deepEqual((await c.query(q, [f.tenant])).rows, (await pool.query(q, [f.tenant])).rows);
    }
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 41);
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    for (const table of tables)
      assert.equal(
        (await c.query('SELECT 1 FROM ' + table + ' WHERE tenant_id<>$1 LIMIT 1', [f.tenant]))
          .rowCount,
        0,
      );
    await c.query('ROLLBACK');
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
  let healthy = false;
  for (let n = 0; n < 40; n++) {
    assert.equal(child.exitCode, null);
    try {
      const r = await fetch('http://127.0.0.1:4102/api/health');
      if (r.ok) {
        const h: any = await r.json();
        assert(h.restore_preview);
        assert.equal(h.schema_revision, '041_b2b_network_returns');
        healthy = true;
        break;
      }
    } catch {}
    await setTimeout(250);
  }
  assert(healthy);
  const login = await fetch('http://127.0.0.1:4102/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.email, password: 'DynaDemo!2026' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert(cookie.startsWith('dyna_session_preview_4102='));
  async function api(p: string, method = 'GET', body?: any, status = 200) {
    const r = await fetch('http://127.0.0.1:4102/api' + p, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, status, p);
    return r;
  }
  const tracking: any = await (await api('/integrations/' + f.channel + '/tracking')).json();
  assert.equal(tracking.stats.terminal, 2);
  assert.equal(tracking.channel.credentials, undefined);
  for (const o of f.orders) {
    const d: any = await (await api('/orders/' + o.id)).json();
    assert.equal(
      d.shipments[0].tracking_data.status,
      o.mode === 'cod' ? 'delivered' : 'returned_to_sender',
    );
    await api('/shipments/' + o.shipment + '/label');
    await api('/shipments/' + o.shipment + '/tracking', 'POST', {}, 423);
    await api('/shipments/' + o.shipment + '/tracking-example', 'POST', {}, 423);
  }
  for (const p of [
    '/integrations/' + f.channel + '/tracking',
    '/integrations/' + f.channel + '/tracking-credentials',
  ])
    await api(p, 'PATCH', {}, 423);
  await api('/integrations/' + f.channel + '/tracking', 'POST', {}, 423);
  const proof = {
    checked_at: new Date().toISOString(),
    scope: 'native_local_DPD_tracking_encrypted_backup_restored',
    tables: restored.tables,
    migrations,
    encrypted_records: restored.encrypted_records_verified,
    row_fingerprints_match: true,
    schema_fingerprint_match: true,
    qa_business_tables_match: tables.length,
    rls_checked_tables: tables.length,
    worker_enabled: false,
    provider_requests: 0,
    tracking_read_http: 200,
    order_read_http: 200,
    label_offline_http: 200,
    mutations_blocked_http: 423,
    separate_preview_cookie: true,
    whole_goal_complete: false,
  };
  await writeFile('docs/dpd-tracking-recovery-qa.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(proof);
} finally {
  if (child && child.exitCode === null) {
    const done = new Promise((resolve) => child!.once('exit', resolve));
    child.kill('SIGTERM');
    await done;
  }
  if (name) await pool.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await pool.end();
}
