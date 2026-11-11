import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  localDatabase,
  restoreDatabaseName,
} from '../server/recovery';
let name: string | undefined;
try {
  const f = JSON.parse(await readFile('data/repricing-schedules-stage041.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, {
      directory: 'data/repricing-schedules-041-restore',
    });
  name = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database: name });
  await c.connect();
  let counts: any;
  try {
    for (const t of [
      'repricing_schedules',
      'repricing_runs',
      'jobs',
      'repricing_rules',
      'repricing_inputs',
      'repricing_previews',
      'price_lists',
      'price_list_items',
      'products',
      'stock',
      'orders',
      'order_items',
    ]) {
      const q = 'SELECT to_jsonb(t) row FROM ' + t + ' t WHERE tenant_id=$1 ORDER BY 1';
      assert.deepEqual((await c.query(q, [f.tenant])).rows, (await pool.query(q, [f.tenant])).rows);
    }
    counts = (
      await c.query(
        "SELECT (SELECT count(*)::int FROM migrations) migrations,(SELECT count(*)::int FROM repricing_previews WHERE tenant_id=$1 AND state='applied') applied",
        [f.tenant],
      )
    ).rows[0];
    assert.equal(counts.migrations, 34);
    assert.equal(counts.applied, 6);
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    for (const table of [
      'repricing_schedules',
      'repricing_runs',
      'repricing_rules',
      'repricing_inputs',
      'repricing_previews',
    ]) {
      assert.equal((await c.query('SELECT DISTINCT tenant_id FROM ' + table)).rowCount, 1);
      assert.equal(
        (await c.query('SELECT * FROM ' + table + ' WHERE tenant_id<>$1', [f.tenant])).rowCount,
        0,
      );
    }
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await assert.rejects(c.query('SELECT * FROM supplier_api_limits'));
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }
  const proof = {
    checked_at: new Date().toISOString(),
    scope: 'local_encrypted_backup_separate_restore',
    tables: restored.tables,
    migrations: counts.migrations,
    applied_previews: counts.applied,
    encrypted_records: restored.encrypted_records_verified,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    qa_business_rows_match: true,
    rls: true,
    global_limiter_inaccessible_to_app: true,
    worker_enabled: restored.worker_enabled,
    provider_requests: 0,
  };
  await writeFile(
    'docs/repricing-schedules-recovery-qa.json',
    JSON.stringify(proof, null, 2) + '\n',
  );
  console.log(JSON.stringify(proof));
} finally {
  if (name) await pool.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await pool.end();
}
