import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { pool, tenantTx } from '../server/db';
import { paymentBalance } from '../server/payments';
import {
  createBackup,
  restoreBackup,
  localDatabase,
  restoreDatabaseName,
} from '../server/recovery';
let restoredName: string | undefined;
try {
  const f = JSON.parse(await readFile('data/payments-stage023.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/payments-023-restore' });
  restoredName = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const restorePool = new pg.Pool({ ...localDatabase(), database: restoredName });
  const c = await restorePool.connect();
  let counts: any;
  try {
    counts = (
      await c.query(
        'SELECT (SELECT count(*)::int FROM migrations) AS migrations,(SELECT count(*)::int FROM payment_entries) AS entries,(SELECT count(*)::int FROM payment_entries WHERE tenant_id=$1) AS qa_entries',
        [f.tenant_id],
      )
    ).rows[0];
    assert.equal(counts.migrations, 23);
    assert.equal(counts.qa_entries, 6);
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant_id]);
    for (const o of [...f.orders, f.prepaid])
      assert.deepEqual(
        await paymentBalance(c, o.order_id),
        await tenantTx(f.tenant_id, (p) => paymentBalance(p, o.order_id)),
      );
    await c.query('ROLLBACK');
  } finally {
    c.release();
    await restorePool.end();
  }
  const proof = {
    backup_tables: backup.tables,
    backup_bytes: backup.bytes,
    counts,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    encrypted_records_verified: restored.encrypted_records_verified,
    worker_enabled: restored.worker_enabled,
    payment_balances_match: true,
    source_overwritten: false,
    restore_database_removed: true,
  };
  await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  restoredName = undefined;
  await writeFile('docs/payments-recovery-qa.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally {
  if (restoredName) await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  await pool.end();
}
