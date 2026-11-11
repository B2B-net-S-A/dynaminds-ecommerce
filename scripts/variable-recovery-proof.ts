// Native recovery exercise; inspect only the fresh isolated restore, never the active source.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
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
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, { directory: 'data/variable-019-restore' });
  restoredName = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database: restoredName });
  await c.connect();
  let counts: any, version: number;
  try {
    counts = (
      await c.query(
        'SELECT (SELECT count(*)::int FROM variant_offer_batches) AS batches,(SELECT count(*)::int FROM variant_offer_batch_items) AS items,(SELECT count(*)::int FROM offer_plans) AS plans,(SELECT count(*)::int FROM migrations) AS migrations',
      )
    ).rows[0];
    assert.equal(counts.batches, 2);
    assert.equal(counts.items, 8);
    assert.equal(counts.migrations, 19);
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(restored.directory + '/manifest.json', 'utf8'));
    version = manifest.schema_fingerprint_version;
    assert.equal(version, 2);
  } finally {
    await c.end();
  }
  const proof = {
    backup_tables: backup.tables,
    backup_bytes: backup.bytes,
    counts,
    schema_fingerprint_version: version,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    encrypted_records_verified: restored.encrypted_records_verified,
    worker_enabled: restored.worker_enabled,
    source_overwritten: false,
    restore_database_removed: true,
  };
  await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  restoredName = undefined;
  await writeFile('data/variable-offers-recovery-proof.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  if (restoredName) await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  await pool.end();
}
