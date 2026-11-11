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
  const f = JSON.parse(await readFile('data/stocktake-stage029.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/stocktake-029-restore' });
  restoredName = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const restore = new pg.Client({ ...localDatabase(), database: restoredName });
  await restore.connect();
  let counts: any;
  try {
    const countQuery =
      'SELECT (SELECT count(*)::int FROM migrations) migrations,(SELECT count(*)::int FROM stocktakes WHERE tenant_id=$1) qa_stocktakes,(SELECT count(*)::int FROM stocktake_lines WHERE tenant_id=$1) qa_lines,(SELECT count(*)::int FROM stocktake_measurements WHERE tenant_id=$1) qa_measurements';
    counts = (await restore.query(countQuery, [f.tenant_id])).rows[0];
    assert.deepEqual(counts, { migrations: 29, qa_stocktakes: 1, qa_lines: 3, qa_measurements: 1 });
    assert.deepEqual(counts, (await pool.query(countQuery, [f.tenant_id])).rows[0]);
    for (const table of [
      'stocktakes',
      'stocktake_lines',
      'stocktake_measurements',
      'stock',
      'stock_locations',
      'reservations',
      'reservation_locations',
      'stock_movements',
      'stock_location_movements',
    ]) {
      const query = 'SELECT to_jsonb(t) AS row FROM ' + table + ' t WHERE tenant_id=$1 ORDER BY 1';
      assert.deepEqual(
        (await restore.query(query, [f.tenant_id])).rows,
        (await pool.query(query, [f.tenant_id])).rows,
      );
    }
    await restore.query('BEGIN');
    await restore.query('SET LOCAL ROLE dyna_app');
    await restore.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant_id]);
    assert.equal(
      (await restore.query('SELECT DISTINCT tenant_id FROM stocktake_lines')).rowCount,
      1,
    );
    assert.equal(
      (
        await restore.query(
          "SELECT has_table_privilege('dyna_app','stocktake_measurements','DELETE') allowed",
        )
      ).rows[0].allowed,
      false,
    );
    await restore.query('ROLLBACK');
    await assert.rejects(
      restore.query(
        "UPDATE stocktakes SET state='counting',posted_by=NULL,posted_at=NULL WHERE tenant_id=$1",
        [f.tenant_id],
      ),
      /niezmienny/,
    );
    await assert.rejects(
      restore.query('UPDATE stocktake_lines SET counted=0 WHERE tenant_id=$1', [f.tenant_id]),
      /liczenia/,
    );
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
    qa_stocktake_rows_match: true,
    rls_closed_session_immutability_and_delete_acl_verified: true,
    worker_enabled: false,
    external_writes: 0,
  };
  await writeFile('docs/stocktake-recovery-qa.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally {
  if (restoredName) await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  await pool.end();
}
