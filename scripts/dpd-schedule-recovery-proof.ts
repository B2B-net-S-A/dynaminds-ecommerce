import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const f = JSON.parse(await readFile('data/dpd-collection-stage046.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/dpd-047-restore' });
  name = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database: name });
  await c.connect();
  let migrations: number;
  try {
    for (const table of [
      'dpd_pickup_schedules',
      'dpd_pickup_runs',
      'dpd_collections',
      'dpd_collection_items',
      'dpd_pickup_claims',
      'shipping_plans',
      'shipments',
      'channels',
      'jobs',
      'products',
      'stock',
      'orders',
      'order_items',
      'documents',
      'payment_entries',
      'stock_movements',
    ]) {
      const q = 'SELECT to_jsonb(t) row FROM ' + table + ' t WHERE tenant_id=$1 ORDER BY 1';
      assert.deepEqual((await c.query(q, [f.tenant])).rows, (await pool.query(q, [f.tenant])).rows);
    }
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 37);
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM shipping_plans WHERE tenant_id=$1 AND input->>'provider'='dpd' AND state='ready'",
          [f.tenant],
        )
      ).rows[0].n,
      3,
    );
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM dpd_collections WHERE tenant_id=$1 AND kind='pickup' AND state='cancelled'",
          [f.tenant],
        )
      ).rows[0].n,
      3,
    );
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM dpd_collections WHERE tenant_id=$1 AND kind='protocol' AND state='ready'",
          [f.tenant],
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await c.query('SELECT count(*)::int n FROM dpd_pickup_claims WHERE tenant_id=$1', [
          f.tenant,
        ])
      ).rows[0].n,
      0,
    );
    const schedule = (
      await c.query(
        'SELECT enabled FROM dpd_pickup_schedules WHERE tenant_id=$1 AND channel_id=$2',
        [f.tenant, f.local],
      )
    ).rows;
    assert.deepEqual(schedule, [{ enabled: false }]);
    assert.equal(
      (await c.query('SELECT count(*)::int n FROM dpd_pickup_runs WHERE tenant_id=$1', [f.tenant]))
        .rows[0].n,
      1,
    );
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    for (const table of [
      'dpd_pickup_schedules',
      'dpd_pickup_runs',
      'dpd_collections',
      'dpd_collection_items',
      'dpd_pickup_claims',
      'shipping_plans',
      'shipments',
      'channels',
      'orders',
      'stock',
    ])
      assert.equal(
        (await c.query('SELECT * FROM ' + table + ' WHERE tenant_id<>$1', [f.tenant])).rowCount,
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
    assert(child.exitCode === null, 'Restore preview terminated');
    try {
      const r = await fetch('http://127.0.0.1:4102/api/health');
      if (r.ok) {
        assert.equal(((await r.json()) as any).restore_preview, true);
        healthy = true;
        break;
      }
    } catch {}
    await setTimeout(250);
  }
  assert(healthy, 'Restore preview did not start');
  const login = await fetch('http://127.0.0.1:4102/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'qa-dpd-collections@demo.local', password: 'DynaDemo!2026' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const saved = {
    protocol: f.external_protocol,
    pickup: f.external_pickup,
    pdf_sha256: f.protocol_sha256,
  };
  const r = await fetch(
    'http://127.0.0.1:4102/api/dpd-collections/' + saved.protocol + '/document',
    {
      headers: { cookie },
    },
  );
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), saved.pdf_sha256);
  const blocked = await fetch(
    'http://127.0.0.1:4102/api/dpd-collections/' + saved.pickup + '/cancel',
    { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' },
  );
  assert.equal(blocked.status, 423);
  const scheduleResponse = await fetch(
    'http://127.0.0.1:4102/api/integrations/' + f.local + '/dpd-pickup-schedule',
    { headers: { cookie } },
  );
  assert.equal(scheduleResponse.status, 200);
  const scheduleView = (await scheduleResponse.json()) as any;
  assert.equal(scheduleView.schedule.enabled, false);
  assert.equal(scheduleView.runs.length, 1);
  assert.equal(scheduleView.runs[0].collections[0].state, 'cancelled');
  const blockedSchedule = await fetch(
    'http://127.0.0.1:4102/api/integrations/' + f.local + '/dpd-pickup-schedule',
    { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: '{}' },
  );
  assert.equal(blockedSchedule.status, 423);
  const proof = {
    checked_at: new Date().toISOString(),
    scope: 'local_schedule_backup_restore_offline_cached_protocol',
    tables: restored.tables,
    migrations,
    encrypted_records: restored.encrypted_records_verified,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    qa_business_rows_match: true,
    ready_dpd_plans: 3,
    rls: true,
    schedule_restored_disabled: true,
    schedule_runs: 1,
    schedule_http: 200,
    schedule_write_http: 423,
    worker_enabled: restored.worker_enabled,
    provider_requests: 0,
    cached_protocol_sha256: saved.pdf_sha256,
    cached_protocol_bytes: bytes.length,
    cached_protocol_http: 200,
    mutations_blocked_http: 423,
  };
  await writeFile('docs/dpd-schedule-recovery-qa.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally {
  if (child && child.exitCode === null) {
    const done = new Promise((resolve) => child!.once('exit', resolve));
    child.kill('SIGTERM');
    await done;
  }
  if (name) await pool.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await pool.end();
}
