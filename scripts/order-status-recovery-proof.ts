// Restore only to a fresh isolated database; never overwrite the active local instance.
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
let restoredName: string | undefined;
try {
  const d = JSON.parse(await readFile('docs/order-status-qa.json', 'utf8')),
    fixture = JSON.parse(await readFile('data/order-status-stage022.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/order-status-022-restore' });
  restoredName = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database: restoredName });
  await c.connect();
  let counts: any;
  try {
    counts = (
      await c.query(
        'SELECT (SELECT count(*)::int FROM migrations) AS migrations,(SELECT count(*)::int FROM order_status_configs WHERE tenant_id=$1) AS configs,(SELECT count(*)::int FROM order_status_plans WHERE tenant_id=$1) AS plans,(SELECT count(*)::int FROM order_status_simulations WHERE tenant_id=$1) AS simulations',
        [fixture.tenant_id],
      )
    ).rows[0];
    assert.equal(counts.migrations, 22);
    assert.equal(counts.configs, 2);
    assert.equal(counts.plans, d.plans.length);
    assert.equal(counts.simulations, 2);
  } finally {
    await c.end();
  }
  const proof = {
    backup_tables: backup.tables,
    backup_bytes: backup.bytes,
    counts,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    encrypted_records_verified: restored.encrypted_records_verified,
    worker_enabled: restored.worker_enabled,
    source_overwritten: false,
    restore_database_removed: true,
  };
  await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  restoredName = undefined;
  await writeFile('docs/order-status-recovery-qa.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  if (restoredName) await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  await pool.end();
}
