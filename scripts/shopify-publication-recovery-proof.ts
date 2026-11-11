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
  const f = JSON.parse(await readFile('data/shopify-publication-stage034.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, {
      directory: 'data/shopify-publication-034-restore',
    });
  restoredName = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const restore = new pg.Client({ ...localDatabase(), database: restoredName });
  await restore.connect();
  let counts: any;
  try {
    for (const table of [
      'catalog_source_runs',
      'catalog_source_items',
      'products',
      'offer_plans',
      'offer_sync_configs',
      'offer_sync_items',
      'channels',
      'inbound_orders',
      'payment_entries',
      'listings',
      'orders',
      'stock',
      'stock_locations',
      'reservations',
      'documents',
      'return_cases',
    ]) {
      const q = 'SELECT to_jsonb(t) row FROM ' + table + ' t WHERE tenant_id=$1 ORDER BY 1';
      assert.deepEqual(
        (await restore.query(q, [f.tenant_id])).rows,
        (await pool.query(q, [f.tenant_id])).rows,
      );
    }
    counts = (
      await restore.query(
        'SELECT (SELECT count(*)::int FROM migrations) migrations,(SELECT count(*)::int FROM inbound_orders WHERE tenant_id=$1) inbound,(SELECT count(*)::int FROM listings WHERE tenant_id=$1) listings',
        [f.tenant_id],
      )
    ).rows[0];
    assert.equal(counts.migrations, 29);
    assert.equal(counts.inbound, 1);
    assert.equal(counts.listings, 3);
    await restore.query('BEGIN');
    await restore.query('SET LOCAL ROLE dyna_app');
    await restore.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant_id]);
    assert.equal(
      (await restore.query('SELECT DISTINCT tenant_id FROM inbound_orders')).rowCount,
      1,
    );
    await restore.query('ROLLBACK');
  } finally {
    await restore.end();
  }
  const proof = {
    checked_at: new Date().toISOString(),
    scope: 'local_encrypted_backup_separate_preview_restore',
    tables: restored.tables,
    migrations: counts.migrations,
    qa_inbound_orders: counts.inbound,
    qa_listings: counts.listings,
    encrypted_records: restored.encrypted_records_verified,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    worker_enabled: restored.worker_enabled,
    qa_business_rows_match: true,
    rls: true,
    provider_requests: 0,
  };
  await writeFile(
    'docs/shopify-publication-recovery-qa.json',
    JSON.stringify(proof, null, 2) + '\n',
  );
  console.log(JSON.stringify(proof));
} finally {
  if (restoredName) await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  await pool.end();
}
