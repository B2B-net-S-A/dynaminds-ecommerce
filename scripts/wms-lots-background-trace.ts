/** Read-only classification of observed background drift; no baseline normalization. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const original = JSON.parse(await readFile('data/wms-lots-stage111-baseline.json', 'utf8'));
try {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const priorJobs = (
      await c.query('SELECT to_jsonb(t) row FROM jobs t WHERE created_at<=$1 ORDER BY 1', [
        original.captured_at,
      ])
    ).rows;
    const newJobs = (
      await c.query(
        `SELECT j.kind,j.state,count(*)::int count,
      count(*) FILTER (WHERE j.kind='order.status.scan' AND EXISTS(
        SELECT 1 FROM order_status_configs cfg WHERE (cfg.tenant_id,cfg.channel_id)
          =(j.tenant_id,nullif(j.payload->>'channel_id','')::uuid)))::int linked_status_jobs
      FROM jobs j WHERE j.created_at>$1 GROUP BY j.kind,j.state ORDER BY j.kind,j.state`,
        [original.captured_at],
      )
    ).rows;
    const configs = (
      await c.query(`SELECT enabled,version,external_authorized,
      count(*)::int count,count(*) FILTER (WHERE last_job_id IS NOT NULL)::int linked_jobs
      FROM order_status_configs GROUP BY enabled,version,external_authorized
      ORDER BY enabled,version,external_authorized`)
    ).rows;
    const priorJobsExact =
      priorJobs.length === original.before.jobs.count &&
      hash(priorJobs) === original.before.jobs.sha256;
    const report = {
      stage: 111,
      recorded_at: new Date().toISOString(),
      baseline_rebased: false,
      baseline_capture: original.captured_at,
      original_jobs_count: original.before.jobs.count,
      retained_before_capture_count: priorJobs.length,
      retained_before_capture_jobs_raw_exact: priorJobsExact,
      appended_job_groups: newJobs,
      current_status_config_groups: configs,
      status_config_raw_baseline_proven: false,
      limitation:
        'Current groups and schedule source do not prove exact prior configuration fields. A matching historical snapshot is still needed.',
      source: 'server/order-status.ts: enqueueStatusScans and processStatusScan',
      goal_complete: false,
    };
    await c.query('COMMIT');
    assert(newJobs.every((r) => r.count >= r.linked_status_jobs));
    await writeFile(
      'docs/wms-lots-background-trace-qa.json',
      JSON.stringify(report, null, 2) + '\n',
      { flag: 'wx' },
    );
    console.log(report);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
} finally {
  await pool.end();
}
