import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { restoreBackup, restoreDatabaseName } from '../server/recovery';
import { pool } from '../server/db';
let name: string | undefined;
try {
  const restored = await restoreBackup(
    process.argv[2] ?? 'data/backups/muu8fix3-b5ba3126d4d6491e.dyna',
    { directory: 'data/ebay-budget-legacy070-restore' },
  );
  name = restoreDatabaseName(restored.database);
  const manifest = JSON.parse(await readFile(restored.directory + '/manifest.json', 'utf8'));
  assert.equal(manifest.schema_fingerprint_version, 2);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  const report = {
    checked_at: new Date().toISOString(),
    legacy_fingerprint_version: 2,
    row_fingerprints_match: true,
    schema_fingerprint_match: true,
    worker_enabled: restored.worker_enabled,
    provider_requests: 0,
    restored_tables: restored.tables,
  };
  await writeFile(
    'docs/ebay-budget-legacy-recovery-qa.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(report);
} finally {
  if (name) await pool.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await pool.end();
}
