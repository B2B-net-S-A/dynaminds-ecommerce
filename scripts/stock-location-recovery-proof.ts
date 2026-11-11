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
  const f = JSON.parse(await readFile('data/stock-locations-stage025.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/stock-locations-025-restore' });
  restoredName = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const restore = new pg.Client({ ...localDatabase(), database: restoredName });
  await restore.connect();
  let counts: any;
  try {
    counts = (
      await restore.query(
        'SELECT (SELECT count(*)::int FROM migrations) AS migrations,(SELECT count(*)::int FROM stock_locations) AS locations,(SELECT count(*)::int FROM reservation_locations) AS allocations,(SELECT count(*)::int FROM stock_location_operations WHERE tenant_id=$1) AS qa_operations',
        [f.tenant_id],
      )
    ).rows[0];
    assert.equal(counts.migrations, 25);
    assert.equal(counts.qa_operations, 3);
    const query =
        'SELECT location,quantity FROM stock_locations WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 ORDER BY location',
      params = [f.tenant_id, f.warehouse_id, f.product_id];
    assert.deepEqual(
      (await restore.query(query, params)).rows,
      (await pool.query(query, params)).rows,
    );
    const allocations = (
      await restore.query(
        'SELECT location,quantity,scanned FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2 ORDER BY location',
        [f.tenant_id, f.order_id],
      )
    ).rows;
    assert.deepEqual(allocations, [
      { location: 'A-01', quantity: 12, scanned: 12 },
      { location: 'B-02', quantity: 3, scanned: 3 },
    ]);
    const sums = (
      await restore.query(
        'SELECT count(*)::int AS n FROM stock s WHERE s.on_hand<>(SELECT coalesce(sum(l.quantity),0) FROM stock_locations l WHERE (l.tenant_id,l.warehouse_id,l.product_id)=(s.tenant_id,s.warehouse_id,s.product_id))',
      )
    ).rows[0].n;
    assert.equal(sums, 0);
    await restore.query('BEGIN');
    await restore.query('SET LOCAL ROLE dyna_app');
    await restore.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant_id]);
    assert.equal(
      (await restore.query('SELECT DISTINCT tenant_id FROM stock_locations')).rows.length,
      1,
    );
    assert.equal(
      (
        await restore.query(
          "SELECT has_table_privilege('dyna_app','stock_location_movements','UPDATE') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
    await restore.query('ROLLBACK');
  } finally {
    await restore.end();
  }
  await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  restoredName = undefined;
  const proof = {
    backup_tables: backup.tables,
    backup_bytes: backup.bytes,
    counts,
    row_fingerprints_match: true,
    schema_fingerprint_match: true,
    encrypted_records_verified: restored.encrypted_records_verified,
    all_stock_totals_match: true,
    qa_allocations_and_scans_match: true,
    qa_location_quantities_match: true,
    rls_and_immutable_history_verified: true,
    worker_enabled: false,
    source_overwritten: false,
    restore_database_removed: true,
  };
  await writeFile('docs/stock-locations-recovery-qa.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally {
  if (restoredName) await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  await pool.end();
}
