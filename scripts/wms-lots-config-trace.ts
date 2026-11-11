/**
 * Read-only, deterministic reconstruction of status-config clocks.
 * No UPDATE, baseline rewrite, parameter search, or provider calls.
 * A result is proven only by the original whole-table raw SHA, not by counts.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

type Fingerprint = { count: number; sha256: string };
type Baseline = {
  captured_at: string;
  baseline_rebased: boolean;
  before: { jobs: Fingerprint; order_status_configs: Fingerprint };
};
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const baseline = JSON.parse(
  await readFile('data/wms-lots-stage111-baseline.json', 'utf8'),
) as Baseline;
assert.equal(baseline.baseline_rebased, false, 'Baseline musi pozostać niezmieniony');
assert(Number.isFinite(Date.parse(baseline.captured_at)), 'Niepoprawny czas baseline');
for (const fingerprint of [baseline.before.jobs, baseline.before.order_status_configs]) {
  assert(Number.isSafeInteger(fingerprint.count) && fingerprint.count >= 0);
  assert(/^[a-f0-9]{64}$/.test(fingerprint.sha256));
}

try {
  const client = await pool.connect();
  let publicReport: Record<string, unknown>;
  let privateReport: Record<string, unknown>;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const priorJobs = (
      await client.query('SELECT to_jsonb(t) row FROM jobs t WHERE created_at<=$1 ORDER BY 1', [
        baseline.captured_at,
      ])
    ).rows;
    const priorJobsExact =
      priorJobs.length === baseline.before.jobs.count &&
      hash(priorJobs) === baseline.before.jobs.sha256;
    // Do not attempt clock reconstruction from a changed historical job set.
    assert(priorJobsExact, 'Pierwotne jobs nie mają dokładnego count/SHA baseline');

    const currentRows = (
      await client.query('SELECT to_jsonb(t) row FROM order_status_configs t ORDER BY 1')
    ).rows;
    // The only hypothesis: the latest completed, pre-capture job for the exact
    // tenant/channel/config version supplied both clocks in the documented TXs.
    // PostgreSQL builds JSON timestamps to retain their original microseconds.
    const reconstruction = await client.query(
      `WITH candidates AS (
         SELECT cfg.channel_id AS config_id,cfg.tenant_id,cfg.enabled,
           to_jsonb(cfg) AS original_row,j.id AS job_id,
           CASE WHEN j.id IS NOT NULL THEN jsonb_build_object(
             'last_run_at',j.run_at,
             'next_run_at',j.created_at+interval '60 seconds',
             'last_job_id',j.id,
             'error',NULL
           ) ELSE NULL END AS clock_override
         FROM order_status_configs cfg
         LEFT JOIN LATERAL (
           SELECT j.id,j.created_at,j.run_at
           FROM jobs j
           WHERE cfg.enabled AND j.tenant_id=cfg.tenant_id
             AND j.kind='order.status.scan' AND j.state='done'
             AND j.created_at<=$1::timestamptz AND j.run_at<=$1::timestamptz
             AND j.payload->>'channel_id'=cfg.channel_id::text
             AND j.payload->>'version'=cfg.version::text
           ORDER BY j.run_at DESC,j.created_at DESC,j.id DESC LIMIT 1
         ) j ON true
       )
       SELECT CASE WHEN enabled AND clock_override IS NOT NULL
         THEN original_row||clock_override ELSE original_row END AS row,
         config_id,tenant_id,enabled,clock_override
       FROM candidates ORDER BY 1`,
      [baseline.captured_at],
    );
    // Preserve the baseline query's {row:jsonb} wrappers and PostgreSQL ORDER BY 1.
    const reconstructedRows = reconstruction.rows.map(({ row }) => ({ row }));
    const enabledCount = reconstruction.rows.filter((row) => row.enabled).length;
    const overriddenCount = reconstruction.rows.filter(
      (row) => row.enabled && row.clock_override !== null,
    ).length;
    const disabledUnchanged = reconstruction.rows
      .filter((row) => !row.enabled)
      .every(({ row }) => currentRows.some((current) => hash(current.row) === hash(row)));
    const countExact = reconstructedRows.length === baseline.before.order_status_configs.count;
    const reconstructedHash = hash(reconstructedRows);
    const hashExact = reconstructedHash === baseline.before.order_status_configs.sha256;
    const allEnabledHaveCandidate = enabledCount === overriddenCount;
    const proven = priorJobsExact && countExact && hashExact && allEnabledHaveCandidate && disabledUnchanged;
    const recordedAt = new Date().toISOString();
    publicReport = {
      stage: 111,
      status: proven ? 'PROVEN_EXACT_CLOCK_RECONSTRUCTION' : 'NOT_PROVEN',
      recorded_at: recordedAt,
      baseline_capture: baseline.captured_at,
      baseline_rebased: false,
      checks: {
        retained_before_capture_jobs_raw_exact: priorJobsExact,
        config_count_exact: countExact,
        reconstructed_config_raw_sha_exact: hashExact,
        all_enabled_configs_have_exact_version_done_job: allEnabledHaveCandidate,
        disabled_configs_unchanged_in_reconstruction: disabledUnchanged,
      },
      counts: {
        retained_jobs: priorJobs.length,
        baseline_configs: baseline.before.order_status_configs.count,
        current_configs: currentRows.length,
        reconstructed_configs: reconstructedRows.length,
        enabled_configs: enabledCount,
        clock_overrides: overriddenCount,
      },
      baseline_config_sha256: baseline.before.order_status_configs.sha256,
      reconstructed_config_sha256: reconstructedHash,
      sources: [
        'server/order-status.ts: scheduleStatusesDue next_run_at=now()+60s',
        'server/order-status-signals.ts: insertStatusScan job.created_at transaction default',
        'server/order-status.ts: processStatusScan final TX job.run_at/config.last_run_at/last_job_id/error',
        'scripts/wms-lots-baseline.ts: UTC sorted to_jsonb rows SHA256',
      ],
      limitation: proven
        ? 'Exact original full-table hash reconstructed by this single clock hypothesis; no database or baseline writes.'
        : 'This single deterministic clock hypothesis does not prove the original rows. No alternative candidates or parameters were tried.',
      goal_complete: false,
    };
    // Never persist complete config JSON, payloads, connection hashes, or secrets.
    privateReport = {
      clock_overrides: reconstruction.rows
        .filter((row) => row.enabled && row.clock_override !== null)
        .map((row) => ({
          config_id: row.config_id,
          tenant_id: row.tenant_id,
          ...row.clock_override,
        })),
    };
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  await writeFile(
    'data/wms-lots-config-trace-clocks.json',
    JSON.stringify(privateReport, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(
    'docs/wms-lots-config-trace-qa.json',
    JSON.stringify(publicReport, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(publicReport);
} finally {
  await pool.end();
}
