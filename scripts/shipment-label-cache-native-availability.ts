/** Bounded capability faults, rolled back in the same owner transaction. No data writes. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { printJobsAvailable } from '../server/print-jobs';
import { shipmentLabelCacheAvailable } from '../server/shipment-label-cache';
import { pool } from '../server/db';
import { Problem } from '../server/errors';

const root = '<workspace>/app';
assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(root, '.local.json'));
assert.notEqual(process.env.DYNA_TEST, 'true');
const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
assert.equal(health.revision, process.env.QA_EXPECTED_REVISION);
assert.equal(health.schema_revision, '131_shipment_label_cache');
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
const cases = [
  ['missing asset table', 'ALTER TABLE shipment_label_cache_assets RENAME TO qa147_missing_assets'],
  [
    'missing acquisition table',
    'ALTER TABLE shipment_label_cache_acquisitions RENAME TO qa147_missing_acquisitions',
  ],
  [
    'missing cipher column',
    'ALTER TABLE shipment_label_cache_assets RENAME COLUMN content_encrypted TO qa147_missing_cipher',
  ],
  [
    'missing capability helper',
    'ALTER FUNCTION label_cache_guards() RENAME TO qa147_missing_guards',
  ],
  [
    'disabled asset immutability',
    'ALTER TABLE shipment_label_cache_assets DISABLE TRIGGER label_cache_immutable',
  ],
] as const;
const c = await pool.connect();
const results: string[] = [];
try {
  const fingerprint = async () =>
    (
      await c.query(`SELECT oid::text,relname,relrowsecurity,relforcerowsecurity,
    (SELECT count(*) FROM pg_trigger z WHERE z.tgrelid=t.oid AND z.tgenabled='O') enabled_triggers
    FROM pg_class t WHERE relname IN('shipment_label_cache_assets','shipment_label_cache_acquisitions') ORDER BY relname`)
    ).rows;
  const before = await fingerprint();
  assert.equal(before.length, 2);
  await c.query('BEGIN READ ONLY');
  assert.equal(await printJobsAvailable(c), true);
  assert.equal(await shipmentLabelCacheAvailable(c), true);
  await c.query('ROLLBACK');
  for (const [name, sql] of cases) {
    await c.query('BEGIN');
    try {
      await c.query(sql);
      for (const probe of [printJobsAvailable, shipmentLabelCacheAvailable]) {
        await c.query('SAVEPOINT qa147_probe');
        try {
          await assert.rejects(
            () => probe(c),
            (error: unknown) => error instanceof Problem && error.status === 503,
          );
        } finally {
          await c.query('ROLLBACK TO SAVEPOINT qa147_probe');
        }
      }
      results.push(name);
    } finally {
      await c.query('ROLLBACK');
    }
    assert.deepEqual(await fingerprint(), before);
  }
  assert.equal(await printJobsAvailable(c), true);
  assert.equal(await shipmentLabelCacheAvailable(c), true);
  const custody = (
    await c.query(`SELECT
    has_column_privilege('dyna_app','shipment_label_cache_assets','content_encrypted','SELECT') cipher_read,
    has_column_privilege('dyna_app','shipment_label_cache_assets','connection_hash','SELECT') connection_read,
    has_column_privilege('dyna_app','shipment_label_cache_acquisitions','request','SELECT') request_read,
    has_table_privilege('dyna_app','shipment_label_cache_assets','INSERT,UPDATE,DELETE') direct_write`)
  ).rows[0];
  assert.deepEqual(custody, {
    cipher_read: false,
    connection_read: false,
    request_read: false,
    direct_write: false,
  });
  const report = {
    stage: 147,
    status: 'BOUNDED_CAPABILITY_PASS',
    runtime_revision: health.revision,
    fault_cases: results,
    all_faults_503: true,
    every_fault_rolled_back: true,
    read_only_probe_pass: true,
    relation_identity_rls_triggers_unchanged: true,
    denied_private_reads_and_direct_writes: true,
    provider_verified: false,
    full_goal_complete: false,
  };
  await writeFile(
    resolve(root, 'docs/shipment-label-cache-native-availability.json'),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  await c.query('ROLLBACK').catch(() => {});
  c.release();
  await pool.end();
}
