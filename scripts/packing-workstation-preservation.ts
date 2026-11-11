/** Reconstruct the original110 listings from an actual088 backup; never repair live data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { pool } from '../server/db';
import { localDatabase, restoreBackup, restoreDatabaseName } from '../server/recovery';

const baseline = JSON.parse(
  await readFile('data/packing-workstation-stage110-baseline.json', 'utf8'),
);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const query = 'SELECT to_jsonb(t) row FROM listings t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1';
let copy: string | undefined;
let report: any;
const admin = new pg.Client({ ...localDatabase(), database: 'postgres' });
await admin.connect();
const prior = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
  (r) => r.datname,
);
try {
  const restored = await restoreBackup('data/backups/muve1m9a-1d1d436cc2adec8e.dyna', {
    directory: 'data/packing-workstation-baseline-trace',
  });
  copy = restoreDatabaseName(restored.database);
  assert(!prior.includes(copy));
  assert(
    restored.row_fingerprints_match &&
      restored.schema_fingerprint_match &&
      !restored.worker_enabled,
  );
  const old = new pg.Client({ ...localDatabase(), database: copy });
  await old.connect();
  let before: any[];
  try {
    await old.query('BEGIN READ ONLY');
    await old.query("SET LOCAL TIME ZONE 'UTC'");
    before = (await old.query(query, [baseline.ids])).rows;
    assert.equal(before.length, baseline.before.listings.count);
    assert.equal(
      hash(before),
      baseline.before.listings.sha256,
      'Actual088 backup must exactly reconstruct original110 listing baseline',
    );
    await old.query('COMMIT');
  } finally {
    await old.end();
  }
  const live = await pool.connect();
  const changes: any[] = [];
  const overrides: any[] = [];
  try {
    await live.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await live.query("SET LOCAL TIME ZONE 'UTC'");
    const actual = (await live.query(query, [baseline.ids])).rows;
    assert.equal(actual.length, before.length);
    const byId = new Map(before.map((r) => [r.row.id, r.row]));
    for (const { row } of actual) {
      const original = byId.get(row.id);
      assert(original);
      if (hash(row) === hash(original)) continue;
      assert.deepEqual(
        Object.keys(row).filter((k) => hash(row[k]) !== hash(original[k])),
        ['last_result'],
      );
      const sync = row.last_result.odoo_catalog_sync;
      const oldSync = original.last_result.odoo_catalog_sync;
      assert.equal(sync.scope, 'local_simulation');
      const run = (
        await live.query(
          'SELECT simulation,state,channel_id,schedule_version FROM odoo_catalog_sync_runs WHERE id=$1 AND tenant_id=$2',
          [sync.run_id, row.tenant_id],
        )
      ).rows[0];
      assert(run?.simulation && run.state === 'success' && run.schedule_version);
      const schedule = (
        await live.query(
          'SELECT enabled,version FROM odoo_catalog_schedules WHERE tenant_id=$1 AND channel_id=$2',
          [row.tenant_id, run.channel_id],
        )
      ).rows[0];
      assert(schedule?.enabled && schedule.version === run.schedule_version);
      const normalized = structuredClone(row);
      normalized.last_result.odoo_catalog_sync.run_id = oldSync.run_id;
      normalized.last_result.odoo_catalog_sync.observed_at = oldSync.observed_at;
      assert.deepEqual(normalized, original, 'Every other listing field must remain exact');
      overrides.push({ id: row.id, run_id: oldSync.run_id, observed_at: oldSync.observed_at });
      changes.push({
        listing_id: row.id,
        tenant_id: row.tenant_id,
        old_run: oldSync.run_id,
        current_run: sync.run_id,
        old_observed_at: oldSync.observed_at,
        current_observed_at: sync.observed_at,
        schedule_channel_id: run.channel_id,
        schedule_version: run.schedule_version,
      });
    }
    assert(changes.length > 0);
    report = {
      stage: 110,
      status: 'TRACED; RAW_LISTINGS_DIFFER',
      baseline_rebased: false,
      earlier_firms: baseline.ids.length,
      earlier_users: baseline.user_ids.length,
      source_backup_id: 'muve1m9a-1d1d436cc2adec8e',
      copy_schema: '088_product_translation_bulk_edit',
      actual_backup_matches_original_listing_baseline: true,
      cause: 'Pre-existing Odoo catalog schedule; verified successful local simulation',
      changed_rows: changes,
      changed_fields_per_row: 2,
      every_other_listing_field_exact: true,
      provider_verified: false,
    };
    await writeFile(
      'data/packing-workstation-listing-trace.json',
      JSON.stringify({ overrides, report }, null, 2),
      { mode: 0o600, flag: 'wx' },
    );
    await live.query('COMMIT');
  } finally {
    await live.query('ROLLBACK').catch(() => {});
    live.release();
  }
} finally {
  if (copy) {
    assert(!prior.includes(copy));
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [
      copy,
    ]);
    await admin.query(`DROP DATABASE "${restoreDatabaseName(copy)}"`);
  }
  const after = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
    (r) => r.datname,
  );
  assert.deepEqual(after, prior);
  await admin.end();
  await pool.end();
}
report.own_copy_removed = true;
report.prior_databases_preserved = prior.length;
await writeFile(
  'docs/packing-workstation-listing-trace-qa.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log({
  status: report.status,
  changed_rows: report.changed_rows.length,
  changed_fields_per_row: 2,
  actual_backup_matches_original_listing_baseline: true,
  prior_databases_preserved: prior.length,
  baseline_rebased: false,
});
