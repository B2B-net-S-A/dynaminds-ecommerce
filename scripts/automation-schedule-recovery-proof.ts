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
  const proof = JSON.parse(await readFile('docs/automation-schedules-qa.json', 'utf8'));
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, {
      directory: 'data/automation-schedules-026-restore',
    });
  restoredName = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database: restoredName });
  await c.connect();
  let counts: any;
  try {
    counts = (
      await c.query(
        `SELECT (SELECT count(*)::int FROM migrations) AS migrations,
    (SELECT count(*)::int FROM automation_schedule_runs WHERE tenant_id=$1) AS qa_runs,
    (SELECT count(*)::int FROM automation_schedule_items WHERE tenant_id=$1) AS qa_items,
    (SELECT count(*)::int FROM automation_schedule_receipts WHERE tenant_id=$1) AS qa_receipts`,
        [proof.fixture.tenant_id],
      )
    ).rows[0];
    assert.equal(counts.migrations, 26);
    assert.equal(counts.qa_items, 31);
    assert.equal(counts.qa_receipts, 31);
    assert(counts.qa_runs >= 2);
    for (const table of [
      'automation_schedules',
      'automation_schedule_runs',
      'automation_schedule_items',
      'automation_schedule_receipts',
    ]) {
      const q = `SELECT row_to_json(t)::text AS row FROM ${table} t WHERE tenant_id=$1 ORDER BY row_to_json(t)::text`;
      await c.query("SET TIME ZONE 'UTC'");
      const source = await pool.connect();
      try {
        await source.query("SET TIME ZONE 'UTC'");
        assert.deepEqual(
          (await c.query(q, [proof.fixture.tenant_id])).rows,
          (await source.query(q, [proof.fixture.tenant_id])).rows,
        );
      } finally {
        source.release();
      }
    }
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [proof.fixture.tenant_id]);
    assert.equal(
      (await c.query('SELECT DISTINCT tenant_id FROM automation_schedule_items')).rows.length,
      1,
    );
    assert.equal(
      (
        await c.query(
          "SELECT has_table_privilege('dyna_app','automation_schedule_items','UPDATE') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
    assert.equal(
      (
        await c.query(
          "SELECT has_table_privilege('dyna_app','automation_schedule_receipts','DELETE') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }
  await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  restoredName = undefined;
  const result = {
    backup_tables: backup.tables,
    backup_bytes: backup.bytes,
    counts,
    row_fingerprints_match: true,
    schema_fingerprint_match: true,
    encrypted_records_verified: restored.encrypted_records_verified,
    qa_schedules_history_and_receipts_match: true,
    rls_and_immutable_history_verified: true,
    worker_enabled: false,
    source_overwritten: false,
    restore_database_removed: true,
  };
  await writeFile(
    'docs/automation-schedules-recovery-qa.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
} finally {
  if (restoredName) await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  await pool.end();
}
