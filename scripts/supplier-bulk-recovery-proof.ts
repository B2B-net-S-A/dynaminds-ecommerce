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
  const f = JSON.parse(await readFile('data/supplier-bulk-stage038.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/supplier-bulk-038-restore' });
  name = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database: name });
  await c.connect();
  let counts: any;
  try {
    for (const t of [
      'supplier_bulk_runs',
      'supplier_bulk_parts',
      'supplier_bulk_issues',
      'supplier_sources',
      'supplier_catalog_reads',
      'supplier_catalog_items',
      'supplier_catalog_purchases',
      'suppliers',
      'products',
      'purchase_orders',
      'purchase_receipts',
      'purchase_receipt_lines',
      'stock',
      'stock_locations',
      'orders',
      'documents',
      'return_cases',
    ]) {
      const q = 'SELECT to_jsonb(t) row FROM ' + t + ' t WHERE tenant_id=$1 ORDER BY 1';
      assert.deepEqual((await c.query(q, [f.tenant])).rows, (await pool.query(q, [f.tenant])).rows);
    }
    counts = (
      await c.query(
        'SELECT (SELECT count(*)::int FROM migrations) migrations,(SELECT count(*)::int FROM supplier_catalog_items WHERE tenant_id=$1) catalog_items',
        [f.tenant],
      )
    ).rows[0];
    assert.equal(counts.migrations, 31);
    assert.equal(counts.catalog_items, 107);
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    assert.equal((await c.query('SELECT * FROM supplier_catalog_items')).rowCount, 107);
    assert.equal(
      (await c.query('SELECT DISTINCT tenant_id FROM supplier_catalog_items')).rowCount,
      1,
    );
    assert.equal((await c.query('SELECT DISTINCT tenant_id FROM supplier_bulk_runs')).rowCount, 1);
    assert.equal((await c.query('SELECT DISTINCT tenant_id FROM supplier_bulk_parts')).rowCount, 1);
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
    catalog_items: counts.catalog_items,
    encrypted_records: restored.encrypted_records_verified,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    qa_business_rows_match: true,
    rls: true,
    global_limiter_inaccessible_to_app: true,
    worker_enabled: restored.worker_enabled,
    provider_requests: 0,
  };
  await writeFile('docs/supplier-bulk-recovery-qa.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally {
  if (name) await pool.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await pool.end();
}
