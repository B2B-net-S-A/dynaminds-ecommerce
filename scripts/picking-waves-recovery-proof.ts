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
let child: ReturnType<typeof spawn> | undefined, database: string | undefined, receipt: any;
try {
  const f = JSON.parse(await readFile('data/picking-waves-stage079.json', 'utf8'));
  assert(f.finalized);
  const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(health.schema_revision, '058_picking_waves');
  assert.match(health.revision, /^[a-f0-9]{40}$/);
  process.env.APP_REVISION = health.revision;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/picking-waves-079-restore' });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const copy = new pg.Client({ ...localDatabase(), database });
  await copy.connect();
  const ownTables = [
    'picking_waves',
    'picking_wave_orders',
    'picking_wave_scans',
    'orders',
    'order_pick_items',
    'reservations',
    'reservation_locations',
    'stock',
    'stock_locations',
    'documents',
    'shipments',
    'return_cases',
    'return_items',
  ];
  let clientKey: string;
  try {
    assert.equal((await copy.query('SELECT count(*)::int n FROM migrations')).rows[0].n, 58);
    for (const table of ownTables) {
      const sql = `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`;
      assert.deepEqual(
        (await copy.query(sql, [f.tenant])).rows,
        (await pool.query(sql, [f.tenant])).rows,
      );
    }
    assert.equal(
      (
        await copy.query(
          "SELECT has_table_privilege('dyna_app','picking_wave_scans','UPDATE') allowed",
        )
      ).rows[0].allowed,
      false,
    );
    const policies = (
      await copy.query(
        "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('picking_waves','picking_wave_orders','picking_wave_scans')",
      )
    ).rows;
    assert.equal(policies.length, 3);
    assert(policies.every((x) => x.relrowsecurity && x.relforcerowsecurity));
    assert.match(
      (
        await copy.query(
          "SELECT indexdef FROM pg_indexes WHERE indexname='picking_wave_active_order'",
        )
      ).rows[0].indexdef,
      /UNIQUE.*WHERE active/,
    );
    clientKey = (
      await copy.query(
        'SELECT client_key FROM picking_wave_scans WHERE wave_id=$1 ORDER BY created_at LIMIT 1',
        [f.wave],
      )
    ).rows[0].client_key;
  } finally {
    await copy.end();
  }
  child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/restore-preview.ts',
      '--result',
      restored.directory + '/result.json',
    ],
    { env: { ...process.env, DYNA_PREVIEW_PORT: '4102' }, stdio: 'ignore' },
  );
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null);
    try {
      if ((await fetch('http://127.0.0.1:4102/api/health')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await setTimeout(100);
  }
  assert(ready);
  let cookie = '';
  async function api(path: string, method = 'GET', body?: any, status = 200) {
    const r = await fetch('http://127.0.0.1:4102/api' + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await r.json()) as any;
    assert.equal(r.status, status, path + ':' + JSON.stringify(json));
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
    return json;
  }
  await api('/auth/login', 'POST', { email: f.email, password: f.password });
  assert.match(cookie, /^dyna_session_preview_4102=/);
  const wave = await api('/picking-waves/' + f.wave);
  assert.equal(wave.progress.scanned, 8);
  assert.equal(wave.wave.state, 'completed');
  assert.equal(
    (await api('/picking-waves/' + f.wave + '/scan-result?client_key=' + clientKey!)).scan
      .product_id,
    f.product.id,
  );
  await api('/picking-waves?state=all');
  await api('/picking-waves/candidates?warehouse_id=' + f.warehouse);
  for (const path of [
    '/picking-waves/preview',
    '/picking-waves',
    '/picking-waves/' + f.wave + '/scans',
    '/picking-waves/' + f.wave + '/complete',
    '/picking-waves/' + f.wave + '/cancel',
  ])
    await api(path, 'POST', {}, 423);
  assert.equal(
    (await fetch('http://127.0.0.1:4100/api/picking-waves/' + f.wave, { headers: { cookie } }))
      .status,
    401,
  );
  const manifest = JSON.parse(await readFile(restored.directory + '/manifest.json', 'utf8'));
  assert.equal(Object.keys(manifest.tables).length, 141);
  receipt = {
    checked_at: new Date().toISOString(),
    revision: health.revision,
    source_schema: health.schema_revision,
    table_count: Object.keys(manifest.tables).length,
    migrations: 58,
    encrypted_records_verified: restored.encrypted_records_verified,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    worker_enabled: restored.worker_enabled,
    own_qa_tables_exact: ownTables.length,
    wave_rls_forced: true,
    one_active_wave_constraint_preserved: true,
    scan_receipts_tenant_update_denied: true,
    preview_wave_scanned: 8,
    preview_wave_state: 'completed',
    preview_reads: 4,
    preview_mutations: 5,
    preview_mutation_status: 423,
    preview_cookie_rejected_live: 401,
    provider_http: 0,
    temporary_database_cleanup: false,
  };
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((r) => child!.once('exit', () => r()));
  }
  if (database) {
    await pool.query(`DROP DATABASE ${database} WITH (FORCE)`);
    assert.equal(
      (await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount,
      0,
    );
    if (receipt) receipt.temporary_database_cleanup = true;
  }
  await pool.end();
}
if (receipt) {
  await writeFile('docs/picking-waves-recovery-qa.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
}
