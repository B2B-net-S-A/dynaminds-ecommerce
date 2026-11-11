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
  const f = JSON.parse(await readFile('data/sms-stage027.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/sms-027-restore' });
  restoredName = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const restore = new pg.Client({ ...localDatabase(), database: restoredName });
  await restore.connect();
  let counts: any;
  try {
    counts = (
      await restore.query(
        'SELECT (SELECT count(*)::int FROM migrations) AS migrations,(SELECT count(*)::int FROM sms_templates WHERE tenant_id=$1) AS qa_templates,(SELECT count(*)::int FROM sms_batches WHERE tenant_id=$1) AS qa_batches,(SELECT count(*)::int FROM sms_messages WHERE tenant_id=$1) AS qa_messages',
        [f.tenant_id],
      )
    ).rows[0];
    assert.deepEqual(counts, { migrations: 27, qa_templates: 1, qa_batches: 1, qa_messages: 3 });
    for (const table of ['sms_templates', 'sms_batches', 'sms_messages']) {
      const query = 'SELECT * FROM ' + table + ' WHERE tenant_id=$1 ORDER BY id';
      assert.deepEqual(
        (await restore.query(query, [f.tenant_id])).rows,
        (await pool.query(query, [f.tenant_id])).rows,
      );
    }
    await restore.query('BEGIN');
    await restore.query('SET LOCAL ROLE dyna_app');
    await restore.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant_id]);
    assert.equal((await restore.query('SELECT DISTINCT tenant_id FROM sms_messages')).rowCount, 1);
    assert.equal(
      (
        await restore.query(
          "SELECT has_table_privilege('dyna_app','sms_messages','DELETE') allowed",
        )
      ).rows[0].allowed,
      false,
    );
    await restore.query('ROLLBACK');
    await assert.rejects(
      restore.query(
        "UPDATE sms_messages SET payload='changed' WHERE tenant_id=$1 AND payload IS NOT NULL",
        [f.tenant_id],
      ),
      /niezmienne/,
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
    qa_sms_rows_match: true,
    rls_payload_immutability_and_delete_acl_verified: true,
    worker_enabled: false,
    real_sms_sent: 0,
  };
  await writeFile('docs/sms-recovery-qa.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally {
  if (restoredName) await pool.query('DROP DATABASE ' + restoredName + ' WITH (FORCE)');
  await pool.end();
}
