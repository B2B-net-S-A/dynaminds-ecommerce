/** MIG-2 on a real clone (dynaminds_m244_20261027_NN, m245, m246, m247, m248, m249, m250, m251, m252, m253 or m254, migrated by the release before 244, i.e. ledger up to
 * 243_ksef_purchase and no register). migrate() applies 244, which creates the register, and the later release
 * migrations (245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263), and records in the same transaction their files as `applied` and every file applied before as
 * `baseline`; a later start with the
 * same files writes nothing; a recorded checksum that no longer matches its file refuses the start with
 * MIGRATION_CHECKSUM_MISMATCH and leaves the ledger and the register exactly as they were. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { migrate, pool } from '../server/db';
import { MigrationChecksumError } from '../server/migration-bootstrap';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:24[456789]|25[0123456789]|26[0123])_202610(?:27|28|29|30)_[0-9]{2}$/, 'clone dynaminds_m244_20261027_NN (or m245/m246/m247/m248/m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263) migrated to 243 required');
after(() => pool.end());
const state = async () => (await pool.query(
  "SELECT (SELECT count(*)::int FROM migrations) ledger,(SELECT md5(string_agg(name,',' ORDER BY name)) FROM migrations) ledger_md5,(SELECT count(*)::int FROM migration_checksums) n,(SELECT md5(string_agg(name||file||sha256||origin||recorded_at::text,',' ORDER BY name,file)) FROM migration_checksums) md5")).rows[0];

test('244 applied with the register; backfill once, then silent; a changed checksum refuses the start and changes nothing', async () => {
  const start = (await pool.query("SELECT to_regclass('public.migration_checksums') IS NULL absent,(SELECT max(name) FROM migrations) last,(SELECT count(*)::int FROM migrations) ledger")).rows[0];
  assert.deepEqual(start, { absent: true, last: '243_ksef_purchase', ledger: start.ledger }, 'clone at 243 without the register');
  await migrate();
  const first = await state();
  assert.equal(first.ledger, start.ledger + 25, '244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267 and 268 are the migrations applied');
  assert.equal(first.n, first.ledger + 4, 'one row per applied migration plus the four companion files');
  const origins = (await pool.query("SELECT origin,count(*)::int n,min(name) first,max(name) last FROM migration_checksums GROUP BY origin ORDER BY origin")).rows;
  assert.deepEqual(origins, [
    { origin: 'applied', n: 25, first: '244_custom_events_checksums', last: '268_cancelled_label_relabel' },
    { origin: 'baseline', n: first.n - 25, first: '001_foundation', last: '243_ksef_purchase' },
  ], 'the rows of 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267 and 268 are applied, those of 001-243 baseline');
  const rows = (await pool.query("SELECT name,file,sha256,origin FROM migration_checksums WHERE name IN ('001_foundation','243_ksef_purchase','244_custom_events_checksums','245_s5_comm','246_b2b_trade_credit_directory','247_sales_dimensions_repricing','248_guard_verdicts','249_catalog_ai','250_wms_evidence_settle_unlocked','251_b2b_network_lifecycle','252_mirakl_operations','253_mirakl_webhook_retention','254_carrier_returns','255_stock_verdict','256_return_receipt_verdicts','257_order_merge_snapshot_index_paths','258_wz_issuer_refresh','259_jobs_running_lease','260_automation_runs_queued_job','261_stocktake_evidence_usage','262_revoke_public_temporary','263_manual_off_verdict','264_order_status_labels','265_wms_order_line_resize','266_accountant_order_settings','267_status_categories_automation_editors','268_cancelled_label_relabel','198_original_keeper_resource_context') ORDER BY name,file")).rows;
  const sha = (f: string) => createHash('sha256').update(readFileSync(new URL('../server/' + f, import.meta.url))).digest('hex');
  assert.deepEqual(rows, [
    { name: '001_foundation', file: 'schema.sql', sha256: sha('schema.sql'), origin: 'baseline' },
    { name: '198_original_keeper_resource_context', file: '198_original_keeper_resource_context.sql', sha256: sha('198_original_keeper_resource_context.sql'), origin: 'baseline' },
    { name: '198_original_keeper_resource_context', file: '199_keeper_private_cold.sql', sha256: sha('199_keeper_private_cold.sql'), origin: 'baseline' },
    { name: '243_ksef_purchase', file: '243_ksef_purchase.sql', sha256: sha('243_ksef_purchase.sql'), origin: 'baseline' },
    { name: '244_custom_events_checksums', file: '244_custom_events_checksums.sql', sha256: sha('244_custom_events_checksums.sql'), origin: 'applied' },
    { name: '245_s5_comm', file: '245_s5_comm.sql', sha256: sha('245_s5_comm.sql'), origin: 'applied' },
    { name: '246_b2b_trade_credit_directory', file: '246_b2b_trade_credit_directory.sql', sha256: sha('246_b2b_trade_credit_directory.sql'), origin: 'applied' },
    { name: '247_sales_dimensions_repricing', file: '247_sales_dimensions_repricing.sql', sha256: sha('247_sales_dimensions_repricing.sql'), origin: 'applied' },
    { name: '248_guard_verdicts', file: '248_guard_verdicts.sql', sha256: sha('248_guard_verdicts.sql'), origin: 'applied' },
    { name: '249_catalog_ai', file: '249_catalog_ai.sql', sha256: sha('249_catalog_ai.sql'), origin: 'applied' },
    { name: '250_wms_evidence_settle_unlocked', file: '250_wms_evidence_settle_unlocked.sql', sha256: sha('250_wms_evidence_settle_unlocked.sql'), origin: 'applied' },
    { name: '251_b2b_network_lifecycle', file: '251_b2b_network_lifecycle.sql', sha256: sha('251_b2b_network_lifecycle.sql'), origin: 'applied' },
    { name: '252_mirakl_operations', file: '252_mirakl_operations.sql', sha256: sha('252_mirakl_operations.sql'), origin: 'applied' },
    { name: '253_mirakl_webhook_retention', file: '253_mirakl_webhook_retention.sql', sha256: sha('253_mirakl_webhook_retention.sql'), origin: 'applied' },
    { name: '254_carrier_returns', file: '254_carrier_returns.sql', sha256: sha('254_carrier_returns.sql'), origin: 'applied' },
    { name: '255_stock_verdict', file: '255_stock_verdict.sql', sha256: sha('255_stock_verdict.sql'), origin: 'applied' },
    { name: '256_return_receipt_verdicts', file: '256_return_receipt_verdicts.sql', sha256: sha('256_return_receipt_verdicts.sql'), origin: 'applied' },
    { name: '257_order_merge_snapshot_index_paths', file: '257_order_merge_snapshot_index_paths.sql', sha256: sha('257_order_merge_snapshot_index_paths.sql'), origin: 'applied' },
    { name: '258_wz_issuer_refresh', file: '258_wz_issuer_refresh.sql', sha256: sha('258_wz_issuer_refresh.sql'), origin: 'applied' },
    { name: '259_jobs_running_lease', file: '259_jobs_running_lease.sql', sha256: sha('259_jobs_running_lease.sql'), origin: 'applied' },
    { name: '260_automation_runs_queued_job', file: '260_automation_runs_queued_job.sql', sha256: sha('260_automation_runs_queued_job.sql'), origin: 'applied' },
    { name: '261_stocktake_evidence_usage', file: '261_stocktake_evidence_usage.sql', sha256: sha('261_stocktake_evidence_usage.sql'), origin: 'applied' },
    { name: '262_revoke_public_temporary', file: '262_revoke_public_temporary.sql', sha256: sha('262_revoke_public_temporary.sql'), origin: 'applied' },
    { name: '263_manual_off_verdict', file: '263_manual_off_verdict.sql', sha256: sha('263_manual_off_verdict.sql'), origin: 'applied' },
    { name: '264_order_status_labels', file: '264_order_status_labels.sql', sha256: sha('264_order_status_labels.sql'), origin: 'applied' },
    { name: '265_wms_order_line_resize', file: '265_wms_order_line_resize.sql', sha256: sha('265_wms_order_line_resize.sql'), origin: 'applied' },
    { name: '266_accountant_order_settings', file: '266_accountant_order_settings.sql', sha256: sha('266_accountant_order_settings.sql'), origin: 'applied' },
    { name: '267_status_categories_automation_editors', file: '267_status_categories_automation_editors.sql', sha256: sha('267_status_categories_automation_editors.sql'), origin: 'applied' },
    { name: '268_cancelled_label_relabel', file: '268_cancelled_label_relabel.sql', sha256: sha('268_cancelled_label_relabel.sql'), origin: 'applied' },
  ]);
  await migrate();
  assert.deepEqual(await state(), first, 'second start writes nothing');
  // An edit of an old migration file after it was recorded (simulated in the register: the file stays, the record moves).
  const original = rows[0].sha256;
  await pool.query("UPDATE migration_checksums SET sha256=$1 WHERE name='015_buyer_portal'", ['0'.repeat(64)]);
  const tampered = await state();
  await assert.rejects(() => migrate(), (e: any) => {
    assert(e instanceof MigrationChecksumError);
    assert.equal(e.code, 'MIGRATION_CHECKSUM_MISMATCH');
    assert.deepEqual(e.changed, [{ name: '015_buyer_portal', file: '015_buyer_portal.sql' }]);
    return true;
  });
  assert.deepEqual(await state(), tampered, 'refusal changes neither ledger nor register');
  await pool.query("UPDATE migration_checksums SET sha256=$1 WHERE name='015_buyer_portal'", [sha('015_buyer_portal.sql')]);
  await migrate();
  assert.equal(original, sha('schema.sql'));
  // dyna_app has no access to the register.
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE dyna_app');
    await assert.rejects(() => c.query('SELECT 1 FROM public.migration_checksums LIMIT 1'), /permission denied/);
  } finally { await c.query('ROLLBACK'); c.release(); }
});
